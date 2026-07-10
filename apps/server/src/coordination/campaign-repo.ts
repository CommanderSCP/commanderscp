import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { Campaign, CampaignStatus } from "@scp/schemas";
import type { TenantTx } from "../db/tenant-tx.js";
import { campaignWaveTargets, changes, objects } from "../db/schema.js";
import { badRequest, notFound } from "../errors.js";
import { decodeCursor, encodeCursor } from "../pagination.js";
import { createObject, getObjectByIdOrUrnAnyType } from "../graph/objects-repo.js";
import { authorize } from "../authz/resolve.js";
import { insertDecision } from "./decisions-repo.js";
import { computeCampaignStatus, type CampaignWaveStatusInput } from "./campaign-status.js";
import { getLatestCampaignPlan } from "./campaign-plan-service.js";

export type ObjectRow = typeof objects.$inferSelect;
/** The minimal object shape `toCampaignShape` actually reads — satisfied by both a raw
 *  `ObjectRow` (joined-query callers) and a `GraphObject` (createObject's return shape in
 *  `proposeCampaign`, which has ISO-string dates and no `contentHash`) without forcing either side
 *  to convert (mirrors `changes-repo.ts`'s `ObjectLike`). */
type ObjectLike = Pick<ObjectRow, "id" | "orgId" | "urn" | "name"> & {
  properties: unknown;
  createdAt: Date | string;
  updatedAt: Date | string;
};

function isoOf(value: Date | string): string {
  return typeof value === "string" ? value : value.toISOString();
}

export function toCampaignShape(object: ObjectLike, status: CampaignStatus): Campaign {
  const properties = object.properties as Record<string, unknown>;
  const targets = Array.isArray(properties.targets)
    ? (properties.targets as unknown[]).filter((t): t is string => typeof t === "string")
    : [];
  return {
    id: object.id,
    orgId: object.orgId,
    urn: object.urn,
    name: object.name,
    description: typeof properties.description === "string" ? properties.description : null,
    targets,
    topologyObjectId: (properties.topologyObjectId as string | undefined) ?? null,
    topologyVersion: (properties.topologyVersion as number | undefined) ?? null,
    status,
    createdAt: isoOf(object.createdAt),
    updatedAt: isoOf(object.updatedAt)
  };
}

export interface ProposeCampaignInput {
  orgId: string;
  actorObjectId: string;
  requestId: string;
  id?: string;
  urn?: string;
  domainId?: string | null;
  name: string;
  description?: string;
  labels?: Record<string, unknown>;
  topologyIdOrUrn?: string;
  /** Object ids or URNs this campaign fans out to — one member Change per target, per wave. */
  targets: string[];
}

/**
 * Creates a Campaign: a graph object (type `campaign`, pre-seeded built-in — 0002 §5) plus a
 * Decision so `scp campaign status`/`:explain` always has at least one entry from the moment a
 * campaign exists, mirroring `changes-repo.ts`'s `proposeChange` exactly. NOT a state transition
 * (campaigns have no transition-guarded state machine — `campaign-status.ts`'s module doc) so this
 * does not go through `transitionChange`/an equivalent.
 *
 * SECURITY-SENSITIVE (M5 adversarial-review surface — "a campaign can't coordinate a change the
 * actor lacks authority over"): member Changes are proposed LATER, by the SYSTEM actor, during
 * campaign reconciliation (`campaign-reconcile.ts`) — that actor's own authority is not a
 * meaningful gate on WHICH targets a campaign may declare. The authorization decision has to be
 * made HERE, against the actual requesting actor, once, for every declared target — not deferred
 * to (and silently skipped by) the system-actor-driven reconciliation loop that creates the member
 * Changes. Checked per-target (not once at the campaign's own domain) because a campaign's targets
 * can span multiple domains a coarse single check would miss.
 */
export async function proposeCampaign(
  tx: TenantTx,
  input: ProposeCampaignInput
): Promise<{ campaign: Campaign; targetObjectIds: string[] }> {
  if (input.targets.length === 0) throw badRequest("a campaign must target at least one object");

  const targetObjectIds: string[] = [];
  for (const idOrUrn of input.targets) {
    const target = await getObjectByIdOrUrnAnyType(tx, input.orgId, idOrUrn);
    await authorize(tx, {
      orgId: input.orgId,
      subjectObjectId: input.actorObjectId,
      permission: "object:write",
      scopeObjectId: target.id
    });
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
    typeId: "campaign",
    actorObjectId: input.actorObjectId,
    requestId: input.requestId,
    id: input.id,
    urn: input.urn,
    name: input.name,
    domainId: input.domainId,
    properties: {
      targets: targetObjectIds,
      description: input.description ?? null,
      topologyObjectId: topologyObjectId ?? null,
      topologyVersion: topologyVersion ?? null
    },
    labels: input.labels
  });

  await insertDecision(tx, {
    orgId: input.orgId,
    kind: "transition",
    subjectId: object.id,
    verdict: "allow",
    inputContext: {
      trigger: "propose",
      actorId: input.actorObjectId,
      targets: targetObjectIds,
      topologyObjectId: topologyObjectId ?? null
    },
    reasonTree: { summary: `campaign proposed for ${targetObjectIds.length} target(s)` }
  });

  return { campaign: toCampaignShape(object, "proposed"), targetObjectIds };
}

async function fetchCampaignObject(tx: TenantTx, orgId: string, id: string): Promise<ObjectRow> {
  const row = await tx.query.objects.findFirst({
    where: (t, { eq: eqOp, and: andOp, isNull: isNullOp }) =>
      andOp(eqOp(t.orgId, orgId), eqOp(t.id, id), eqOp(t.typeId, "campaign"), isNullOp(t.deletedAt))
  });
  if (!row) throw notFound(`campaign '${id}' not found`);
  return row;
}

/**
 * The status-derivation DB helper (campaign-status.ts's module doc: campaign status is ALWAYS
 * re-derived, never stored). Loads the campaign's latest compiled plan (if any) and every wave
 * target's member Change's CURRENT state in one batched query, then hands off to the pure
 * `computeCampaignStatus`. Shared by `GET /campaigns`, `GET /campaigns/{id}`, the campaign
 * reconciler's own bookkeeping, and `graph/named-queries.ts`'s `initiative-rollup`.
 */
export async function getCampaignStatus(tx: TenantTx, orgId: string, campaignObjectId: string): Promise<CampaignStatus> {
  const plan = await getLatestCampaignPlan(tx, orgId, campaignObjectId);
  if (!plan) return computeCampaignStatus({ hasPlan: false, waves: [] });

  const memberChangeIds = plan.waves.flatMap((w) => w.targets.map((t) => t.memberChangeObjectId)).filter((id): id is string => id !== null);
  const stateByChangeId = new Map<string, string>();
  if (memberChangeIds.length > 0) {
    const rows = await tx
      .select({ objectId: changes.objectId, state: changes.state })
      .from(changes)
      .where(and(eq(changes.orgId, orgId), inArray(changes.objectId, memberChangeIds)));
    for (const row of rows) stateByChangeId.set(row.objectId, row.state);
  }

  const waves: CampaignWaveStatusInput[] = plan.waves.map((w) => ({
    waveIndex: w.waveIndex,
    waveStatus: w.status as CampaignWaveStatusInput["waveStatus"],
    targets: w.targets.map((t) => ({
      targetObjectId: t.targetObjectId,
      memberChangeState:
        t.memberChangeObjectId && stateByChangeId.has(t.memberChangeObjectId)
          ? (stateByChangeId.get(t.memberChangeObjectId) as CampaignWaveStatusInput["targets"][number]["memberChangeState"])
          : null
    }))
  }));

  return computeCampaignStatus({ hasPlan: true, waves });
}

export async function getCampaign(tx: TenantTx, orgId: string, id: string): Promise<Campaign> {
  const object = await fetchCampaignObject(tx, orgId, id);
  const status = await getCampaignStatus(tx, orgId, id);
  return toCampaignShape(object, status);
}

export interface ListCampaignsQuery {
  cursor?: string | undefined;
  limit: number;
  status?: CampaignStatus | undefined;
}

export async function listCampaigns(
  tx: TenantTx,
  orgId: string,
  query: ListCampaignsQuery
): Promise<{ items: Campaign[]; nextCursor: string | null }> {
  const cursor = query.cursor ? decodeCursor(query.cursor) : null;
  const conditions = [eq(objects.orgId, orgId), eq(objects.typeId, "campaign"), sql`${objects.deletedAt} IS NULL`];
  if (cursor) {
    conditions.push(
      sql`(${objects.createdAt}, ${objects.id}) > (${cursor.createdAt.toISOString()}::timestamptz, ${cursor.id}::uuid)`
    );
  }

  const rows = await tx
    .select()
    .from(objects)
    .where(and(...conditions))
    .orderBy(asc(objects.createdAt), asc(objects.id))
    .limit(query.limit + 1);

  const hasMore = rows.length > query.limit;
  const page = hasMore ? rows.slice(0, query.limit) : rows;
  const last = page[page.length - 1];

  const items: Campaign[] = [];
  for (const row of page) {
    const status = await getCampaignStatus(tx, orgId, row.id);
    if (query.status && query.status !== status) continue;
    items.push(toCampaignShape(row, status));
  }

  return {
    items,
    nextCursor: hasMore && last ? encodeCursor({ createdAt: last.createdAt, id: last.id }) : null
  };
}

/** Reads the target object ids `proposeCampaign` stashed under `properties.targets`. */
export function campaignTargetObjectIdsOf(properties: Record<string, unknown> | null | undefined): string[] {
  const targets = properties?.targets;
  return Array.isArray(targets) ? targets.filter((t): t is string => typeof t === "string") : [];
}

/** Every non-terminal (no plan yet, or plan not yet fully completed/aborted) campaign in the org —
 *  the reconciler's batch-fetch, mirroring `changes-repo.ts`'s `listChangeRowsInStates` shape. */
export async function listActiveCampaignObjectIds(tx: TenantTx, orgId: string, limit: number): Promise<ObjectRow[]> {
  return tx
    .select()
    .from(objects)
    .where(and(eq(objects.orgId, orgId), eq(objects.typeId, "campaign"), sql`${objects.deletedAt} IS NULL`))
    .orderBy(asc(objects.updatedAt))
    .limit(limit);
}

/** Member-change lookup for a campaign wave target, used by the reconciler to poll progress. */
export async function memberChangeIdsForCampaign(tx: TenantTx, orgId: string, waveId: string): Promise<
  (typeof campaignWaveTargets.$inferSelect)[]
> {
  return tx
    .select()
    .from(campaignWaveTargets)
    .where(and(eq(campaignWaveTargets.orgId, orgId), eq(campaignWaveTargets.waveId, waveId)))
    .orderBy(asc(campaignWaveTargets.createdAt));
}
