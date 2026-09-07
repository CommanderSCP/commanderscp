import { and, asc, eq, inArray, sql, type SQL } from "drizzle-orm";
import type {
  Campaign,
  CampaignDeadline,
  CampaignDeadlineInput,
  CampaignDeadlineOverride,
  CampaignRecipe,
  CampaignStatus,
  ContainmentDomainId,
  ExecutorType,
  TrustDomainId
} from "@scp/schemas";
import { CAMPAIGN_DEADLINE_PROPERTY_KEY, CAMPAIGN_RECIPE_PROPERTY_KEY } from "@scp/schemas";
import type { TenantTx } from "../db/tenant-tx.js";
import {
  campaignPlans,
  campaignWaves,
  campaignWaveTargets,
  changes,
  objects
} from "../db/schema.js";
import { badRequest, notFound } from "../errors.js";
import { decodeCursor, encodeCursor, keysetAfter, keysetOrderBy } from "../pagination.js";
import { createObject, getObjectByIdOrUrnAnyType, updateObject } from "../graph/objects-repo.js";
import { authorize } from "../authz/resolve.js";
import { insertDecision } from "./decisions-repo.js";
import { computeCampaignStatus, type CampaignWaveStatusInput } from "./campaign-status.js";
import { getLatestCampaignPlan } from "./campaign-plan-service.js";
import { resolveChangeRecipe } from "./campaign-recipe.js";
import { evaluateCampaignDeadlineLock, resolveCampaignDeadline } from "./campaign-deadline-lock.js";

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

/** M25.4 — the campaign's recipe as the READ surface sees it. See docs/coordination.md §193. */
function recipeOf(properties: Record<string, unknown>): CampaignRecipe | undefined {
  const resolved = resolveChangeRecipe(properties);
  return resolved.outcome === "recipe" ? resolved.recipe : undefined;
}

/** The deadline as the read surface sees it, one parse. See docs/coordination.md §194. */
function deadlineOf(properties: Record<string, unknown>): CampaignDeadline | null {
  const resolved = resolveCampaignDeadline(properties);
  return resolved.outcome === "deadline" ? resolved.deadline : null;
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
    // Re-parsed through the write door's schema, never cast. See docs/coordination.md §195.
    ...(recipeOf(properties) !== undefined ? { recipe: recipeOf(properties) } : {}),
    // M25.6a — ALWAYS PRESENT, `null` when this campaign declares no deadline. A required nullable
    // response property, not an optional one: "is anything being withheld from this campaign's
    // laggards?" must not be answered by an absence a reader has to interpret.
    deadline: deadlineOf(properties),
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
  /** CONTAINMENT sense (ADR-0021 D4). */
  domainId?: ContainmentDomainId | null;
  name: string;
  description?: string;
  labels?: Record<string, unknown>;
  topologyIdOrUrn?: string;
  /** WHICH pipeline every fanned-out change rolls (M12 P4A) — the routing Type (ADR-0007).
   *  Omitted => 'configuration' (the server default). */
  type?: ExecutorType;
  /** M25.4 (D3) — the coordination lever: ONE trigger intent fanned across every target. Written
   *  verbatim to `properties.recipe`; the shape refusal lives at the `objects-repo` choke point
   *  (`governance/campaign-recipe-guard.ts`), not here, because two other doors reach that property
   *  without passing through this function. */
  recipe?: CampaignRecipe;
  /** The date past which this campaign stops fanning out. See docs/coordination.md §196. */
  deadline?: CampaignDeadlineInput;
  /** Object ids or URNs this campaign fans out to — one member Change per target, per wave. */
  targets: string[];
}

/** Creates a Campaign: a graph object. See docs/coordination.md §197. */
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
      // Read back by `campaign-reconcile.ts` via `typeOf` and stamped onto every change this campaign
      // fans out (M12 P4A / ADR-0007). Always written — a campaign object that omitted it would read
      // as 'configuration' anyway, and persisting it explicitly keeps the campaign self-describing.
      type: input.type ?? "configuration",
      // M25.4 — ONLY written when the author declared one, so a campaign without a recipe is
      // byte-identical to a pre-M25.4 campaign and every reader's fast path stays a pure absence
      // check (`resolveChangeRecipe` returns before parsing anything).
      ...(input.recipe !== undefined ? { [CAMPAIGN_RECIPE_PROPERTY_KEY]: input.recipe } : {}),
      // M25.6a — ONLY written when the author declared one, so a campaign without a deadline is
      // byte-identical to a pre-M25.6a campaign and `resolveCampaignDeadline` returns on a pure
      // key-absence check without parsing anything.
      ...(input.deadline !== undefined ? { [CAMPAIGN_DEADLINE_PROPERTY_KEY]: input.deadline } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(topologyObjectId !== undefined ? { topologyObjectId, topologyVersion } : {})
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

/** The object ids a campaign declares as its targets. See docs/coordination.md §198. */
export async function listCampaignTargetObjectIds(
  tx: TenantTx,
  orgId: string,
  campaignObjectId: string
): Promise<string[]> {
  const row = await fetchCampaignObject(tx, orgId, campaignObjectId);
  const properties = (row.properties ?? {}) as Record<string, unknown>;
  return Array.isArray(properties.targets)
    ? (properties.targets as unknown[]).filter((t): t is string => typeof t === "string")
    : [];
}

/** M25.6a — SET, MOVE OR CLEAR a campaign's deadline. See docs/coordination.md §199. */
export interface SetCampaignDeadlineResult {
  /** What the campaign's deadline was, immediately before this write — `null` when it had none, and
   *  ALSO `null` when what it had did not parse. The two are distinguished by `beforeUnreadable`
   *  rather than collapsed, because "you replaced a broken document" and "you set the first one" are
   *  different facts and the audit trail should not have to guess. */
  before: CampaignDeadline | null;
  /** True when the value being replaced was present but unreadable. */
  beforeUnreadable: boolean;
  after: CampaignDeadline | null;
  campaign: Campaign;
}

/** THE CAMPAIGN ROW, LOCKED `FOR UPDATE`. See docs/coordination.md §200. */
async function lockCampaignRowForUpdate(
  tx: TenantTx,
  orgId: string,
  campaignObjectId: string
): Promise<ObjectRow> {
  const locked = await tx
    .select()
    .from(objects)
    .where(
      and(
        eq(objects.orgId, orgId),
        eq(objects.id, campaignObjectId),
        eq(objects.typeId, "campaign"),
        sql`${objects.deletedAt} IS NULL`
      )
    )
    .for("update")
    .limit(1);
  const row = locked[0];
  if (!row) throw notFound(`campaign '${campaignObjectId}' not found`);
  return row;
}

export async function setCampaignDeadline(
  tx: TenantTx,
  input: {
    orgId: string;
    campaignObjectId: string;
    actorObjectId: string;
    requestId: string;
    /** `null` CLEARS it — the exit. Carries NO `overrides`. See docs/coordination.md §201. */
    deadline: CampaignDeadlineInput | null;
  }
): Promise<SetCampaignDeadlineResult> {
  const row = await lockCampaignRowForUpdate(tx, input.orgId, input.campaignObjectId);

  const properties = (row.properties ?? {}) as Record<string, unknown>;
  const existing = resolveCampaignDeadline(properties);

  // ==============================================================================================
  // M25.6b — THE WAIVERS ALREADY IN FORCE SURVIVE A SET OR A MOVE.
  // ==============================================================================================
  // This verb's request body CANNOT express `overrides` (that is the whole point of
  // `CampaignDeadlineInputSchema`), so an author moving the date has said NOTHING about the waivers.
  // Dropping them would be an unexpressed act — a silent TIGHTENING, re-locking targets an Owner
  // deliberately excused, performed by someone holding only `object:write`. Carrying them forward is
  // the reading that matches what a waiver MEANS: "this target is excused from this campaign's
  // deadline", not "excused from the particular instant it happened to carry that day".
  //
  // A CLEAR takes them with it, and that is not an inconsistency: clearing removes the deadline
  // itself, so there is nothing left to be excused from. Re-setting one afterwards starts clean,
  // which is the honest default — the old waivers were granted against a deadline that no longer
  // exists.
  //
  // An UNREADABLE previous document loses them, necessarily: `resolveCampaignDeadline` could not
  // parse it, so there is nothing to carry. The route records that as `beforeUnreadable`.
  const carriedOverrides =
    existing.outcome === "deadline" ? existing.deadline.overrides : undefined;
  const after: CampaignDeadline | null =
    input.deadline === null
      ? null
      : {
          ...input.deadline,
          ...(carriedOverrides !== undefined && carriedOverrides.length > 0
            ? { overrides: carriedOverrides }
            : {})
        };

  // `updateObject` replaces wholesale, so the spread preserves. See docs/coordination.md §202.
  const { [CAMPAIGN_DEADLINE_PROPERTY_KEY]: _dropped, ...withoutDeadline } = properties;
  const nextProperties =
    after === null
      ? withoutDeadline
      : { ...withoutDeadline, [CAMPAIGN_DEADLINE_PROPERTY_KEY]: after };

  const updated = await updateObject(tx, {
    orgId: input.orgId,
    typeId: "campaign",
    actorObjectId: input.actorObjectId,
    requestId: input.requestId,
    idOrUrn: input.campaignObjectId,
    properties: nextProperties
  });

  const status = await getCampaignStatus(
    tx,
    input.orgId,
    input.campaignObjectId,
    nextProperties as Record<string, unknown>
  );

  return {
    before: existing.outcome === "deadline" ? existing.deadline : null,
    beforeUnreadable: existing.outcome === "malformed",
    // WHAT WAS STORED, not what was asked for — the two differ by exactly the carried waivers, and
    // the Decision this feeds must record the document that now exists rather than the request that
    // produced it.
    after,
    campaign: toCampaignShape(updated, status)
  };
}

export interface OverrideCampaignDeadlineResult {
  /** The waivers as stored after this write — at most one per target, sorted by `targetObjectId`. */
  overrides: CampaignDeadlineOverride[];
  /** The targets this call excused, resolved to object ids and SORTED. Feeds the Decision's
   *  `inputContext` verbatim and drives one audit event each. */
  targetObjectIds: string[];
  campaign: Campaign;
}

/** Mint a per-target waiver of this campaign's deadline. See docs/coordination.md §203. */
export async function overrideCampaignDeadline(
  tx: TenantTx,
  input: {
    orgId: string;
    campaignObjectId: string;
    actorObjectId: string;
    requestId: string;
    /** Already resolved to object ids and verified to be targets of this campaign — the ROUTE does
     *  both, because both need the same `getObjectByIdOrUrnAnyType` lookup the per-target
     *  `object:write` check is made against. */
    targetObjectIds: string[];
    reason: string;
    until?: string | undefined;
    /** The write's own clock, stamped into every entry's `at`. Injected for the same reason
     *  `evaluateCampaignDeadlineLock`'s `now` is: a test must be able to mint a waiver whose `until`
     *  is in the past without waiting for it to become so. */
    now: Date;
  }
): Promise<OverrideCampaignDeadlineResult> {
  const row = await lockCampaignRowForUpdate(tx, input.orgId, input.campaignObjectId);

  const properties = (row.properties ?? {}) as Record<string, unknown>;
  const existing = resolveCampaignDeadline(properties);
  if (existing.outcome !== "deadline") {
    throw badRequest(
      existing.outcome === "malformed"
        ? `campaign '${input.campaignObjectId}' has an unreadable deadline (${existing.detail}) — ` +
            `it is withholding nothing from anybody, so there is nothing to waive. Fix or clear it ` +
            `with POST /campaigns/{id}/deadline first`
        : `campaign '${input.campaignObjectId}' declares no deadline — there is nothing to waive`
    );
  }

  const at = input.now.toISOString();
  const minted = new Map<string, CampaignDeadlineOverride>();
  for (const override of existing.deadline.overrides ?? []) {
    minted.set(override.targetObjectId, override);
  }
  for (const targetObjectId of input.targetObjectIds) {
    minted.set(targetObjectId, {
      targetObjectId,
      reason: input.reason,
      actorId: input.actorObjectId,
      at,
      ...(input.until !== undefined ? { until: input.until } : {})
    });
  }
  const overrides = [...minted.values()].sort((a, b) =>
    a.targetObjectId.localeCompare(b.targetObjectId)
  );

  const nextProperties = {
    ...properties,
    [CAMPAIGN_DEADLINE_PROPERTY_KEY]: { ...existing.deadline, overrides }
  };

  // THROUGH `updateObject`, so this is a versioned, content-hashed, ordinarily-audited graph write
  // underneath the governance record the route writes on top of it. No side door into
  // `objects.properties` — the same rule `setCampaignDeadline` follows.
  const updated = await updateObject(tx, {
    orgId: input.orgId,
    typeId: "campaign",
    actorObjectId: input.actorObjectId,
    requestId: input.requestId,
    idOrUrn: input.campaignObjectId,
    properties: nextProperties
  });

  const status = await getCampaignStatus(
    tx,
    input.orgId,
    input.campaignObjectId,
    nextProperties as Record<string, unknown>
  );

  return {
    overrides,
    targetObjectIds: [...input.targetObjectIds].sort((a, b) => a.localeCompare(b)),
    campaign: toCampaignShape(updated, status)
  };
}

/** The status-derivation DB helper. See docs/coordination.md §204. */
export async function getCampaignStatus(
  tx: TenantTx,
  orgId: string,
  campaignObjectId: string,
  /** The campaign object's OWN `properties`. See docs/coordination.md §205. */
  properties: Record<string, unknown> | null
): Promise<CampaignStatus> {
  // THE COST GUARD. See docs/coordination.md §206.
  const deadline = resolveCampaignDeadline(properties);

  // This read now is the freeze evaluation, not a second one. See docs/coordination.md §207.
  const plan = await getLatestCampaignPlan(tx, orgId, campaignObjectId, { withFreezeHolds: true });
  if (!plan) return computeCampaignStatus({ hasPlan: false, waves: [] });

  const memberChangeIds = plan.waves
    .flatMap((w) => w.targets.map((t) => t.memberChangeObjectId))
    .filter((id): id is string => id !== null);
  const stateByChangeId = new Map<string, string>();
  if (memberChangeIds.length > 0) {
    const rows = await tx
      .select({ objectId: changes.objectId, state: changes.state })
      .from(changes)
      .where(and(eq(changes.orgId, orgId), inArray(changes.objectId, memberChangeIds)));
    for (const row of rows) stateByChangeId.set(row.objectId, row.state);
  }

  // M25.2 — WHICH TARGETS A FREEZE IS HOLDING RIGHT NOW. See docs/coordination.md §208.
  const frozenTargetIds = new Set(
    plan.waves
      .flatMap((w) => w.targets.filter((t) => t.hold !== undefined))
      .map((t) => t.targetObjectId)
  );

  // Still needed below, PURE (no query): the same candidate set the freeze evaluation used, re-derived
  // here from `plan.waves` for the deadline-lock check, which is a SEPARATE mechanism (M25.6a) with
  // its own read.
  const runningWaveTargetIds = plan.waves
    .filter((w) => w.status === "running")
    .flatMap((w) => w.targets.filter((t) => t.memberChangeObjectId === null))
    .map((t) => t.targetObjectId);

  // Which targets this campaign's deadline locks out right now. See docs/coordination.md §209.
  const deadlineLockedTargetIds =
    deadline.outcome !== "deadline" || runningWaveTargetIds.length === 0
      ? new Set<string>()
      : new Set(
          (
            await evaluateCampaignDeadlineLock(tx, {
              orgId,
              campaignObjectId,
              targetObjectIds: runningWaveTargetIds,
              deadline: deadline.deadline,
              at: deadline.at,
              recipe: recipeOf((properties ?? {}) as Record<string, unknown>),
              // A READ, so the clock is read HERE: there is no batch to keep internally consistent
              // (one request, one campaign) and nothing durable is written from this path.
              now: new Date()
            })
          ).locked.map((entry) => entry.targetObjectId)
        );

  const waves: CampaignWaveStatusInput[] = plan.waves.map((w) => ({
    waveIndex: w.waveIndex,
    waveStatus: w.status as CampaignWaveStatusInput["waveStatus"],
    frozenTargetCount: w.targets.filter((t) => frozenTargetIds.has(t.targetObjectId)).length,
    deadlineLockedTargetCount: w.targets.filter((t) =>
      deadlineLockedTargetIds.has(t.targetObjectId)
    ).length,
    targets: w.targets.map((t) => ({
      targetObjectId: t.targetObjectId,
      memberChangeState:
        t.memberChangeObjectId && stateByChangeId.has(t.memberChangeObjectId)
          ? (stateByChangeId.get(
              t.memberChangeObjectId
            ) as CampaignWaveStatusInput["targets"][number]["memberChangeState"])
          : null
    }))
  }));

  return computeCampaignStatus({ hasPlan: true, waves });
}

export async function getCampaign(tx: TenantTx, orgId: string, id: string): Promise<Campaign> {
  const object = await fetchCampaignObject(tx, orgId, id);
  const status = await getCampaignStatus(
    tx,
    orgId,
    id,
    object.properties as Record<string, unknown> | null
  );
  return toCampaignShape(object, status);
}

export interface ListCampaignsQuery {
  cursor?: string | undefined;
  limit: number;
  status?: CampaignStatus | undefined;
  /** The rows this caller's authority reaches, as a subquery. See docs/coordination.md §210. */
  readableFilter?: SQL | null | undefined;
}

/** The readable filter applies before the limit, not after. See docs/coordination.md §211. */
export async function listCampaigns(
  tx: TenantTx,
  orgId: string,
  query: ListCampaignsQuery
): Promise<{ items: Campaign[]; nextCursor: string | null }> {
  const cursor = query.cursor ? decodeCursor(query.cursor) : null;
  const conditions = [
    eq(objects.orgId, orgId),
    eq(objects.typeId, "campaign"),
    sql`${objects.deletedAt} IS NULL`
  ];
  if (query.readableFilter) conditions.push(sql`${objects.id} IN ${query.readableFilter}`);
  if (cursor) {
    conditions.push(keysetAfter(objects.createdAt, objects.id, cursor));
  }

  const rows = await tx
    .select()
    .from(objects)
    .where(and(...conditions))
    .orderBy(...keysetOrderBy(objects.createdAt, objects.id))
    .limit(query.limit + 1);

  const hasMore = rows.length > query.limit;
  const page = hasMore ? rows.slice(0, query.limit) : rows;
  const last = page[page.length - 1];

  const items: Campaign[] = [];
  for (const row of page) {
    const status = await getCampaignStatus(
      tx,
      orgId,
      row.id,
      row.properties as Record<string, unknown> | null
    );
    if (query.status && query.status !== status) continue;
    items.push(toCampaignShape(row, status));
  }

  return {
    items,
    nextCursor: hasMore && last ? encodeCursor({ createdAt: last.createdAt, id: last.id }) : null
  };
}

/** Reads the target object ids `proposeCampaign` stashed under `properties.targets`. */
export function campaignTargetObjectIdsOf(
  properties: Record<string, unknown> | null | undefined
): string[] {
  const targets = properties?.targets;
  return Array.isArray(targets) ? targets.filter((t): t is string => typeof t === "string") : [];
}

/** Every non-terminal campaign in the org. See docs/coordination.md §212. */
export async function listActiveCampaignObjectIds(
  tx: TenantTx,
  orgId: string,
  limit: number,
  selfDomainId: TrustDomainId
): Promise<ObjectRow[]> {
  return tx
    .select()
    .from(objects)
    .where(
      and(
        eq(objects.orgId, orgId),
        eq(objects.typeId, "campaign"),
        sql`${objects.deletedAt} IS NULL`,
        eq(objects.originDomainId, selfDomainId),
        sql`${objects.id} NOT IN (
          SELECT latest.campaign_object_id FROM (
            SELECT DISTINCT ON (p.campaign_object_id) p.campaign_object_id, p.status
            FROM campaign_plans p
            WHERE p.org_id = ${orgId}
            ORDER BY p.campaign_object_id, p.created_at DESC, p.id DESC
          ) latest
          WHERE latest.status IN ('completed', 'aborted')
        )`
      )
    )
    .orderBy(asc(objects.updatedAt))
    .limit(limit);
}

/** The AUTHORITATIVE campaign membership. See docs/coordination.md §213. */
export async function authoritativeCampaignMembers(
  tx: TenantTx,
  orgId: string,
  campaignObjectId: string
): Promise<{ memberChangeObjectId: string; targetObjectId: string }[]> {
  const rows = await tx
    .select({
      memberChangeObjectId: campaignWaveTargets.memberChangeObjectId,
      targetObjectId: campaignWaveTargets.targetObjectId
    })
    .from(campaignWaveTargets)
    .innerJoin(campaignWaves, eq(campaignWaveTargets.waveId, campaignWaves.id))
    .innerJoin(campaignPlans, eq(campaignWaves.planId, campaignPlans.id))
    .where(
      and(
        eq(campaignWaveTargets.orgId, orgId),
        eq(campaignPlans.campaignObjectId, campaignObjectId)
      )
    );
  return rows
    .filter(
      (r): r is { memberChangeObjectId: string; targetObjectId: string } =>
        r.memberChangeObjectId !== null
    )
    .map((r) => ({
      memberChangeObjectId: r.memberChangeObjectId,
      targetObjectId: r.targetObjectId
    }));
}
