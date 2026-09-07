import { and, eq, gt, isNull, lte, type SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import { v7 as uuidv7 } from "uuid";
import type { TenantTx } from "../db/tenant-tx.js";
import { freezes, objects } from "../db/schema.js";
import { ensureFederationSelf } from "../federation/self-repo.js";
import { badRequest, conflict, notFound } from "../errors.js";

/** Freeze windows (DESIGN §10.3). See docs/governance.md §86. */

export interface FreezeRow {
  id: string;
  orgId: string;
  scopeObjectId: string;
  name: string | null;
  startsAt: Date;
  endsAt: Date;
  reason: string;
  createdByActorId: string;
  createdAt: Date;
  /** M25.2 / owner decision D5 — `true` parks the WHOLE wave. See docs/governance.md §87. */
  atomic: boolean;
  /** M25.1 — non-null means this freeze was RETRACTED by an operator and is no longer in force,
   *  whatever `endsAt` says. See `activeFreezesInWindow`, the one place it is filtered. */
  liftedAt: Date | null;
  liftedByActorId: string | null;
  liftReason: string | null;
  /** M25.7 / owner decision D6 (drizzle/0089, ADR-0043) — the id of this freeze's `freeze` GRAPH
   *  OBJECT, or `null` when this freeze does not federate (the default, and every freeze authored
   *  before M25.7). See `governance/freeze-object.ts`; the guard that makes it load-bearing on the
   *  WRITE side is in `lockFreezeRow` below. */
  objectId: string | null;
}

export interface CreateFreezeInput {
  orgId: string;
  scopeObjectId: string;
  name?: string | undefined;
  startsAt: Date;
  endsAt: Date;
  reason: string;
  createdByActorId: string;
  /** Defaults to `false` — see `freezes.atomic` (drizzle/0084). Reachable from
   *  `POST /api/v1/freezes` (`CreateFreezeRequestSchema.atomic`, optional) and `scp freeze create
   *  --atomic`, because a loosening whose escape hatch ships one increment later has a window in
   *  which the escape hatch does not exist. */
  atomic?: boolean | undefined;
}

/** THE WINDOW-ORDER INVARIANT, in one place. See docs/governance.md §88. */
export function assertWindowOrdered(startsAt: Date, endsAt: Date): void {
  if (endsAt <= startsAt) {
    throw badRequest(
      `freeze endsAt (${endsAt.toISOString()}) must be after startsAt (${startsAt.toISOString()})`
    );
  }
}

export async function createFreeze(tx: TenantTx, input: CreateFreezeInput): Promise<FreezeRow> {
  assertWindowOrdered(input.startsAt, input.endsAt);
  const [row] = await tx
    .insert(freezes)
    .values({
      id: uuidv7(),
      orgId: input.orgId,
      scopeObjectId: input.scopeObjectId,
      name: input.name ?? null,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      reason: input.reason,
      createdByActorId: input.createdByActorId,
      atomic: input.atomic ?? false
    })
    .returning();
  return row as FreezeRow;
}

export async function getFreeze(tx: TenantTx, orgId: string, id: string): Promise<FreezeRow> {
  const rows = await tx
    .select()
    .from(freezes)
    .where(and(eq(freezes.orgId, orgId), eq(freezes.id, id)))
    .limit(1);
  if (!rows[0]) throw notFound(`freeze '${id}' not found`);
  return rows[0] as FreezeRow;
}

/** `getFreeze` UNDER A ROW LOCK. See docs/governance.md §89. */
async function lockFreezeRow(tx: TenantTx, orgId: string, id: string): Promise<FreezeRow> {
  const rows = await tx
    .select()
    .from(freezes)
    .where(and(eq(freezes.orgId, orgId), eq(freezes.id, id)))
    .limit(1)
    .for("update");
  if (!rows[0]) throw notFound(`freeze '${id}' not found`);
  const row = rows[0] as FreezeRow;
  await assertFreezeLocallyOwned(tx, orgId, row);
  return row;
}

/** Refuses a local write to a freeze another domain owns. See docs/governance.md §90. */
async function assertFreezeLocallyOwned(
  tx: TenantTx,
  orgId: string,
  row: FreezeRow
): Promise<void> {
  if (!row.objectId) return;
  const found = await tx
    .select({ originDomainId: objects.originDomainId })
    .from(objects)
    .where(and(eq(objects.orgId, orgId), eq(objects.id, row.objectId)))
    .limit(1);
  const object = found[0];
  if (!object) return;
  const self = await ensureFederationSelf(tx, orgId);
  if (object.originDomainId === self.domainId) return;
  throw conflict(
    `freeze '${row.id}' is a read-only replica declared by domain '${object.originDomainId}' — ` +
      `this instance cannot lift or shorten it. Retract it at the declaring instance, or use ` +
      `'freeze:override' at this freeze's own scope to admit one change past it, with a reason.`
  );
}

export async function listFreezes(tx: TenantTx, orgId: string): Promise<FreezeRow[]> {
  const rows = await tx.select().from(freezes).where(eq(freezes.orgId, orgId));
  return rows as FreezeRow[];
}

/** EVERY freeze in the org whose window covers `at`. See docs/governance.md §91. */
export async function activeFreezesInWindow(
  tx: TenantTx,
  orgId: string,
  at: Date
): Promise<FreezeRow[]> {
  const rows = await tx
    .select()
    .from(freezes)
    .where(
      and(
        eq(freezes.orgId, orgId),
        freezeWindowCovers(freezes.startsAt, freezes.endsAt, freezes.liftedAt, at)
      )
    );
  return rows as FreezeRow[];
}

/** The window predicate itself, column-generic for reuse. See docs/governance.md §92. */
export function freezeWindowCovers(
  startsAt: PgColumn,
  endsAt: PgColumn,
  liftedAt: PgColumn,
  at: Date
): SQL | undefined {
  return and(lte(startsAt, at), gt(endsAt, at), isNull(liftedAt));
}

/** THE MEMBERSHIP RULE. See docs/governance.md §93. */
export function filterFreezesByScopes<T extends Pick<FreezeRow, "scopeObjectId">>(
  rows: T[],
  scopeObjectIds: string[]
): T[] {
  if (scopeObjectIds.length === 0) return [];
  const scopes = new Set(scopeObjectIds);
  return rows.filter((f) => scopes.has(f.scopeObjectId));
}

/** Freezes active RIGHT NOW. See docs/governance.md §94. */
export async function activeFreezesForScopes(
  tx: TenantTx,
  orgId: string,
  scopeObjectIds: string[],
  at: Date
): Promise<FreezeRow[]> {
  if (scopeObjectIds.length === 0) return [];
  return filterFreezesByScopes(await activeFreezesInWindow(tx, orgId, at), scopeObjectIds);
}

// The two write verbs that were missing. See docs/governance.md §95.

export interface LiftFreezeInput {
  orgId: string;
  id: string;
  /** MANDATORY and non-empty — checked at the route, defended here. */
  reason: string;
  actorObjectId: string;
  /** Injectable for tests; production passes nothing. Recorded verbatim as `lifted_at`. */
  now?: Date | undefined;
}

/** RETRACT a freeze. See docs/governance.md §96. */
export async function liftFreeze(tx: TenantTx, input: LiftFreezeInput): Promise<FreezeRow> {
  if (input.reason.trim().length === 0) {
    throw badRequest("lifting a freeze requires a non-empty reason");
  }
  // Loaded first, so an unknown id is a 404 not a 409. See docs/governance.md §97.
  const before = await lockFreezeRow(tx, input.orgId, input.id);
  const [row] = await tx
    .update(freezes)
    .set({
      liftedAt: input.now ?? new Date(),
      liftedByActorId: input.actorObjectId,
      liftReason: input.reason
    })
    .where(and(eq(freezes.orgId, input.orgId), eq(freezes.id, input.id), isNull(freezes.liftedAt)))
    .returning();
  if (!row) {
    throw conflict(
      `freeze '${input.id}' was already lifted at ${before.liftedAt?.toISOString()} — a lift records who retracted it and why, and is not overwritten`
    );
  }
  return row as FreezeRow;
}

/** Which way a window edit moved, for the audit record. See docs/governance.md §98. */
export type FreezeWindowDirection = "shortened" | "extended" | "unchanged";

export interface UpdateFreezeWindowInput {
  orgId: string;
  id: string;
  endsAt: Date;
  /** MANDATORY and non-empty on BOTH directions — see the route's docblock. */
  reason: string;
  actorObjectId: string;
}

export interface UpdateFreezeWindowResult {
  before: FreezeRow;
  after: FreezeRow;
  direction: FreezeWindowDirection;
}

/** Move a freeze's `ends_at`, in EITHER direction. See docs/governance.md §99. */
export async function updateFreezeWindow(
  tx: TenantTx,
  input: UpdateFreezeWindowInput
): Promise<UpdateFreezeWindowResult> {
  if (input.reason.trim().length === 0) {
    throw badRequest("changing a freeze window requires a non-empty reason");
  }
  // `FOR UPDATE` — see `lockFreezeRow`. `direction` and the Decision's `endsAt.from` are BOTH
  // derived from this row, so reading it unlocked would let a concurrent PATCH make both false.
  const before = await lockFreezeRow(tx, input.orgId, input.id);
  if (before.liftedAt) {
    throw conflict(
      `freeze '${input.id}' was lifted at ${before.liftedAt.toISOString()} — a retraction is final; declare a new freeze instead of re-opening this one`
    );
  }
  // THE SAME invariant `createFreeze` enforces, from the same function. A PATCH that admitted
  // `endsAt <= startsAt` would leave a row the POST route refuses to produce.
  assertWindowOrdered(before.startsAt, input.endsAt);
  const direction: FreezeWindowDirection =
    input.endsAt < before.endsAt
      ? "shortened"
      : input.endsAt > before.endsAt
        ? "extended"
        : "unchanged";
  const [row] = await tx
    .update(freezes)
    .set({ endsAt: input.endsAt })
    .where(and(eq(freezes.orgId, input.orgId), eq(freezes.id, input.id), isNull(freezes.liftedAt)))
    .returning();
  if (!row) throw conflict(`freeze '${input.id}' was lifted concurrently`);
  return { before, after: row as FreezeRow, direction };
}
