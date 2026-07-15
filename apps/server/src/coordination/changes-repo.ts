import { createHash } from "node:crypto";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Change, ChangeState } from "@scp/schemas";
import type { TenantTx } from "../db/tenant-tx.js";
import { changes, objects } from "../db/schema.js";
import { badRequest, notFound } from "../errors.js";
import { decodeCursor, encodeCursor } from "../pagination.js";
import { createObject, getObjectByIdOrUrnAnyType } from "../graph/objects-repo.js";
import { insertDecision } from "./decisions-repo.js";
import { appendJournalEntry } from "../federation/journal-repo.js";

/** `change_status` journal entries aren't tied to a graph object's own `content_hash` (that one
 *  covers the change's static metadata; this covers the lifecycle-state snapshot) — hashed
 *  independently so a state-only change (e.g. a transition) still produces a distinct, verifiable
 *  content_hash on its journal entry. */
export function changeStatusContentHash(payload: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

export type ChangeRow = typeof changes.$inferSelect;
type ObjectRow = typeof objects.$inferSelect;
/** The minimal object shape `toChangeShape` actually reads — satisfied by both a raw `ObjectRow`
 *  (joined-query callers below) and a `GraphObject` (createObject's return shape in `proposeChange`,
 *  which has ISO-string dates and no `contentHash`) without forcing either side to convert. */
type ObjectLike = Pick<ObjectRow, "id" | "urn" | "name"> & { properties: unknown };

export function toChangeShape(change: ChangeRow, object: ObjectLike): Change {
  return {
    id: object.id,
    orgId: change.orgId,
    urn: object.urn,
    name: object.name,
    state: change.state as ChangeState,
    sourceKind: change.sourceKind,
    sourceRef: (change.sourceRef as Record<string, unknown> | null) ?? null,
    correlationKey: change.correlationKey,
    emergency: change.emergency,
    importedFromDomain: change.importedFromDomain,
    topologyObjectId: change.topologyObjectId,
    topologyVersion: change.topologyVersion,
    rollbackOfObjectId: change.rollbackOfObjectId,
    rollbackTriggerReason: change.rollbackTriggerReason,
    stateEnteredAt: change.stateEnteredAt.toISOString(),
    lastHeartbeatAt: change.lastHeartbeatAt.toISOString(),
    watchdogFlaggedAt: change.watchdogFlaggedAt?.toISOString() ?? null,
    properties: object.properties as Record<string, unknown>,
    createdAt: change.createdAt.toISOString(),
    updatedAt: change.updatedAt.toISOString()
  };
}

export interface ProposeChangeInput {
  orgId: string;
  actorObjectId: string;
  requestId: string;
  id?: string;
  urn?: string;
  domainId?: string | null;
  name: string;
  properties?: Record<string, unknown>;
  labels?: Record<string, unknown>;
  sourceKind?: string;
  sourceRef?: Record<string, unknown>;
  correlationKey?: string;
  emergency?: boolean;
  /** Resolved release-topology idOrUrn -> pinned (objectId, version) at compile time (evaluate step), not here. */
  topologyIdOrUrn?: string;
  /** Object ids or URNs this change targets — resolved to ids and stashed in properties for the plan compiler. */
  targets: string[];
  /** Set only when this Change IS a rollback of another change (coordination/rollback.ts). */
  rollbackOfObjectId?: string;
  /** M6 (DESIGN §13): set when this Change was instantiated from a Promotion Bundle —
   *  `federation/promotion-repo.ts`'s `importPromotionBundle` is the only caller that sets this.
   *  The resulting Change is a genuinely LOCAL, locally-authoritative Change (its own graph object
   *  originates at THIS domain) that must still pass every local policy/control/approval gate —
   *  approvals carried in the bundle are evidence attached separately (imported_approval_evidence),
   *  never a bypass of local governance. */
  importedFromDomain?: string;
}

/**
 * Creates a Change: a graph object (type `change`) via the existing `createObject` (which itself
 * writes the `change.create` audit event + outbox publish, DESIGN §4.1/§8) plus the `changes`
 * projection row in state `proposed`, plus one Decision record so `scp change explain` always has
 * at least one entry from the moment a change exists (DESIGN §10.4). This is NOT a state
 * transition (there is no "from" state) so it does not go through `transitionChange` — but it
 * follows the identical "write the thing + write a Decision" discipline.
 */
export async function proposeChange(
  tx: TenantTx,
  input: ProposeChangeInput
): Promise<{ change: Change; targetObjectIds: string[] }> {
  if (input.targets.length === 0) throw badRequest("a change must target at least one object");

  const targetObjectIds: string[] = [];
  for (const idOrUrn of input.targets) {
    const target = await getObjectByIdOrUrnAnyType(tx, input.orgId, idOrUrn);
    targetObjectIds.push(target.id);
  }

  let topologyObjectId: string | undefined;
  let topologyVersion: number | undefined;
  if (input.topologyIdOrUrn) {
    const topology = await getObjectByIdOrUrnAnyType(tx, input.orgId, input.topologyIdOrUrn);
    if (topology.typeId !== "release-topology") {
      throw badRequest(`'${input.topologyIdOrUrn}' is not a release-topology object`);
    }
    topologyObjectId = topology.id;
    topologyVersion = topology.version;
  }

  const object = await createObject(tx, {
    orgId: input.orgId,
    typeId: "change",
    actorObjectId: input.actorObjectId,
    requestId: input.requestId,
    id: input.id,
    urn: input.urn,
    name: input.name,
    domainId: input.domainId,
    properties: { ...input.properties, targets: targetObjectIds },
    labels: input.labels
  });

  const now = new Date();
  const [row] = await tx
    .insert(changes)
    .values({
      objectId: object.id,
      orgId: input.orgId,
      state: "proposed",
      sourceKind: input.sourceKind ?? null,
      sourceRef: input.sourceRef ?? null,
      correlationKey: input.correlationKey ?? null,
      emergency: input.emergency ?? false,
      topologyObjectId: topologyObjectId ?? null,
      topologyVersion: topologyVersion ?? null,
      rollbackOfObjectId: input.rollbackOfObjectId ?? null,
      importedFromDomain: input.importedFromDomain ?? null,
      stateEnteredAt: now,
      lastHeartbeatAt: now,
      createdAt: now,
      updatedAt: now
    })
    .returning();
  if (!row) throw new Error("failed to insert changes projection row");

  // M6 (DESIGN §13 journal entry kinds — richer than the generic `object_upsert` `createObject`
  // above already wrote for this change's underlying graph object): a `change_status` snapshot
  // carrying the full projection-row state, for peers syncing with a `changes_only` scope and for
  // the commander cross-domain status view. Written even for an IMPORTED change (importedFromDomain
  // set) — its LOCAL lifecycle from here on is this domain's own to report, distinct from the
  // origin domain's own journal entry for the promotion itself.
  {
    const payload = {
      objectId: object.id,
      urn: object.urn,
      name: object.name,
      state: "proposed",
      sourceKind: input.sourceKind ?? null,
      sourceRef: input.sourceRef ?? null,
      emergency: input.emergency ?? false,
      importedFromDomain: input.importedFromDomain ?? null,
      rollbackOfObjectId: input.rollbackOfObjectId ?? null
    };
    await appendJournalEntry(tx, {
      orgId: input.orgId,
      entryKind: "change_status",
      contentHash: changeStatusContentHash(payload),
      payload
    });
  }

  await insertDecision(tx, {
    orgId: input.orgId,
    kind: "transition",
    subjectId: object.id,
    verdict: "allow",
    inputContext: {
      trigger: "propose",
      actorId: input.actorObjectId,
      targets: targetObjectIds,
      topologyObjectId: topologyObjectId ?? null,
      rollbackOfObjectId: input.rollbackOfObjectId ?? null
    },
    reasonTree: {
      summary: input.rollbackOfObjectId
        ? `rollback change proposed for ${targetObjectIds.length} target(s)`
        : `change proposed for ${targetObjectIds.length} target(s)`
    }
  });

  return { change: toChangeShape(row, object), targetObjectIds };
}

async function fetchChangeWithObject(
  tx: TenantTx,
  orgId: string,
  changeObjectId: string
): Promise<{ change: ChangeRow; object: ObjectRow } | undefined> {
  const rows = await tx
    .select({ change: changes, object: objects })
    .from(changes)
    .innerJoin(objects, eq(changes.objectId, objects.id))
    .where(and(eq(changes.orgId, orgId), eq(changes.objectId, changeObjectId)))
    .limit(1);
  return rows[0];
}

export async function getChange(tx: TenantTx, orgId: string, id: string): Promise<Change> {
  const found = await fetchChangeWithObject(tx, orgId, id);
  if (!found) throw notFound(`change '${id}' not found`);
  return toChangeShape(found.change, found.object);
}

export async function getChangeRow(tx: TenantTx, orgId: string, id: string): Promise<ChangeRow> {
  const found = await fetchChangeWithObject(tx, orgId, id);
  if (!found) throw notFound(`change '${id}' not found`);
  return found.change;
}

/**
 * Batch fetch for the reconciliation loop (coordination/reconcile.ts) and the watchdog: every
 * change currently sitting in one of `states`, oldest-updated first (so a sweep drains the
 * longest-waiting changes first rather than starving them behind a churny newer one), capped at
 * `limit` per tick so one org with a huge backlog can't starve every other org's sweep turn.
 *
 * MAJOR #6 fix (PR #7 review — "batch starvation"): excludes changes `markChangeReconcileBlocked`
 * has parked (an `executing` change whose active wave failed and is awaiting an operator's manual
 * cancel/rollback — see reconcile.ts's `failed` branch). `reconcile_blocked_at` is only ever set
 * while a change is `executing`, so this filter is a no-op for every other state and safe to apply
 * unconditionally rather than needing a state-specific variant of this query.
 */
export async function listChangeRowsInStates(
  tx: TenantTx,
  orgId: string,
  states: ChangeState[],
  limit: number
): Promise<{ change: ChangeRow; object: ObjectRow }[]> {
  if (states.length === 0) return [];
  return tx
    .select({ change: changes, object: objects })
    .from(changes)
    .innerJoin(objects, eq(changes.objectId, objects.id))
    .where(
      and(
        eq(changes.orgId, orgId),
        inArray(changes.state, states),
        isNull(changes.reconcileBlockedAt)
      )
    )
    .orderBy(asc(changes.updatedAt))
    .limit(limit);
}

/** Marks an `executing` change as parked awaiting operator action (MAJOR #6 fix — see
 *  `listChangeRowsInStates`'s doc comment). Idempotent: a no-op if already parked, so calling it
 *  every tick a change's active wave is still `failed` never generates redundant writes. */
export async function markChangeReconcileBlocked(
  tx: TenantTx,
  orgId: string,
  changeObjectId: string
): Promise<void> {
  await tx
    .update(changes)
    .set({ reconcileBlockedAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(changes.orgId, orgId),
        eq(changes.objectId, changeObjectId),
        isNull(changes.reconcileBlockedAt)
      )
    );
}

/** Reads the target object ids `proposeChange` stashed under `properties.targets` at creation time. */
export function targetObjectIdsOf(
  properties: Record<string, unknown> | null | undefined
): string[] {
  const targets = properties?.targets;
  return Array.isArray(targets) ? targets.filter((t): t is string => typeof t === "string") : [];
}

export interface ListChangesQuery {
  cursor?: string | undefined;
  limit: number;
  state?: ChangeState | undefined;
}

export async function listChanges(
  tx: TenantTx,
  orgId: string,
  query: ListChangesQuery
): Promise<{ items: Change[]; nextCursor: string | null }> {
  const cursor = query.cursor ? decodeCursor(query.cursor) : null;
  const conditions = [eq(changes.orgId, orgId)];
  if (query.state) conditions.push(eq(changes.state, query.state));
  if (cursor) {
    conditions.push(
      sql`(${changes.createdAt}, ${changes.objectId}) > (${cursor.createdAt.toISOString()}::timestamptz, ${cursor.id}::uuid)`
    );
  }

  const rows = await tx
    .select({ change: changes, object: objects })
    .from(changes)
    .innerJoin(objects, eq(changes.objectId, objects.id))
    .where(and(...conditions))
    .orderBy(asc(changes.createdAt), asc(changes.objectId))
    .limit(query.limit + 1);

  const hasMore = rows.length > query.limit;
  const page = hasMore ? rows.slice(0, query.limit) : rows;
  const last = page[page.length - 1];
  return {
    items: page.map((r) => toChangeShape(r.change, r.object)),
    nextCursor:
      hasMore && last
        ? encodeCursor({ createdAt: last.change.createdAt, id: last.change.objectId })
        : null
  };
}
