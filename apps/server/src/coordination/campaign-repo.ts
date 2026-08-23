import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type {
  Campaign,
  CampaignStatus,
  ContainmentDomainId,
  ExecutorType,
  TrustDomainId
} from "@scp/schemas";
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
import { createObject, getObjectByIdOrUrnAnyType } from "../graph/objects-repo.js";
import { authorize } from "../authz/resolve.js";
import { insertDecision } from "./decisions-repo.js";
import { computeCampaignStatus, type CampaignWaveStatusInput } from "./campaign-status.js";
import { evaluateFreezeHolds } from "./freeze-hold.js";
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
  /** CONTAINMENT sense (ADR-0021 D4). */
  domainId?: ContainmentDomainId | null;
  name: string;
  description?: string;
  labels?: Record<string, unknown>;
  topologyIdOrUrn?: string;
  /** WHICH pipeline every fanned-out change rolls (M12 P4A) — the routing Type (ADR-0007).
   *  Omitted => 'configuration' (the server default). */
  type?: ExecutorType;
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
      // Read back by `campaign-reconcile.ts` via `typeOf` and stamped onto every change this campaign
      // fans out (M12 P4A / ADR-0007). Always written — a campaign object that omitted it would read
      // as 'configuration' anyway, and persisting it explicitly keeps the campaign self-describing.
      type: input.type ?? "configuration",
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

/**
 * The status-derivation DB helper (campaign-status.ts's module doc: campaign status is ALWAYS
 * re-derived, never stored). Loads the campaign's latest compiled plan (if any) and every wave
 * target's member Change's CURRENT state in one batched query, then hands off to the pure
 * `computeCampaignStatus`. Shared by `GET /campaigns`, `GET /campaigns/{id}`, the campaign
 * reconciler's own bookkeeping.
 */
export async function getCampaignStatus(
  tx: TenantTx,
  orgId: string,
  campaignObjectId: string
): Promise<CampaignStatus> {
  const plan = await getLatestCampaignPlan(tx, orgId, campaignObjectId);
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

  // M25.2 — WHICH TARGETS A FREEZE IS HOLDING RIGHT NOW, re-evaluated here rather than read off the
  // campaign's `freeze_admission` Decision. The Decision is a historical record; a status derived
  // from it would keep saying `blocked` after the window closed, which is the same stale-hold defect
  // `routes/changes.ts` documents against ADR-0028's `stage_dependency` row. Re-evaluating costs one
  // indexed window read per status render and NOTHING else when the org has no active freeze
  // (`freezesByTarget`'s inertness property).
  //
  // SCOPED TO THE RUNNING WAVE. Only the active wave fans out, so a freeze over a target of a wave
  // that has not started yet is not withholding anything and must not make the campaign read
  // `blocked` weeks early. A target that already minted its member change is likewise past this
  // seam — the freeze bites that change's own wave targets, one layer down.
  const runningWaveTargetIds = plan.waves
    .filter((w) => w.status === "running")
    .flatMap((w) => w.targets.filter((t) => t.memberChangeObjectId === null))
    .map((t) => t.targetObjectId);
  const frozenTargetIds =
    runningWaveTargetIds.length === 0
      ? new Set<string>()
      : new Set(
          (await evaluateFreezeHolds(tx, { orgId, targetObjectIds: runningWaveTargetIds })).keys()
        );

  const waves: CampaignWaveStatusInput[] = plan.waves.map((w) => ({
    waveIndex: w.waveIndex,
    waveStatus: w.status as CampaignWaveStatusInput["waveStatus"],
    frozenTargetCount: w.targets.filter((t) => frozenTargetIds.has(t.targetObjectId)).length,
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
  const conditions = [
    eq(objects.orgId, orgId),
    eq(objects.typeId, "campaign"),
    sql`${objects.deletedAt} IS NULL`
  ];
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
export function campaignTargetObjectIdsOf(
  properties: Record<string, unknown> | null | undefined
): string[] {
  const targets = properties?.targets;
  return Array.isArray(targets) ? targets.filter((t): t is string => typeof t === "string") : [];
}

/**
 * Every non-terminal campaign in the org — no plan yet, or a LATEST plan that is not
 * `completed`/`aborted` — the reconciler's batch-fetch, mirroring `changes-repo.ts`'s
 * `listChangeRowsInStates` shape (`ORDER BY updated_at ASC LIMIT n`).
 *
 * THE DOC SAID THIS FOR MONTHS AND THE QUERY DID NOT DO IT. Until 2026-08-01 the WHERE clause was
 * `org_id` + `type_id = 'campaign'` + `deleted_at IS NULL` and nothing else, so a campaign whose
 * latest plan was `completed` or `aborted` came back every tick forever and `reconcileOneCampaign`
 * early-returned on it having done nothing. The name said "Active", the doc said "non-terminal",
 * the query said "all of them" — and only the query runs.
 *
 * WHY THE PREDICATE IS SHAPED LIKE THIS. A campaign can have SEVERAL plans (a re-plan writes a new
 * row rather than mutating the old one), so the test is not "has no terminal plan" — it is "the
 * LATEST plan is not terminal". Those differ exactly where it is most dangerous: a campaign that
 * completed one plan and was then RE-PLANNED has a terminal plan AND an active one, and the naive
 * predicate would exclude it from the reconciler forever. Over-inclusion (the old behaviour) wastes
 * a batch slot; wrong exclusion silently strands a live campaign, which is far worse — so the
 * inner `DISTINCT ON` picks the latest row per campaign FIRST and only then tests its status.
 *
 * `ORDER BY created_at DESC, id DESC` MATCHES `campaign-plan-service.ts`'s `getLatestCampaignPlan`
 * EXACTLY, and both had to gain the `id` tiebreak together. `created_at` defaults to `now()`, which
 * in Postgres is TRANSACTION time, so two plans written in one transaction tie byte-for-byte and
 * "latest" was decided by planner order. If this filter and that reader disagreed under a tie, a
 * campaign could be excluded here as terminal while the reader handed the reconciler an ACTIVE plan
 * — a campaign that is never driven and reports no error anywhere. `id` is UUIDv7, so it is both
 * deterministic and time-ordered.
 *
 * `campaign_object_id` is NOT NULL, so the `NOT IN` carries no three-valued-logic hazard.
 *
 * The reconciler's own `plan.status === "completed" || "aborted"` early-return STAYS as defence in
 * depth — this filter is an efficiency and honesty fix, not the safety boundary.
 *
 * ## `selfDomainId` — the S10 single-writer filter, and why the campaign side needed it MORE
 *
 * The twin of `changes-repo.ts`'s `listChangeRowsInStates` argument of the same name (read that doc
 * comment for the shape of the remedy and why a round-robin bump is the wrong one). The two loops
 * now agree, but the hole they close was NOT equally severe, and the asymmetry is worth recording
 * because it is what made this one urgent:
 *
 *  - A synced CHANGE was never a candidate in the first place. `federation/import-repo.ts`'s
 *    `object_upsert` branch explicitly never creates a local `changes` state-machine row, and
 *    `listChangeRowsInStates` INNER JOINs that row, so the change-side guard was latent (measured in
 *    `change-origin-domain.integration.test.ts`'s header).
 *  - A synced CAMPAIGN was. `object_upsert` is TYPE-AGNOSTIC (`const typeId = String(payload.typeId)`)
 *    and `graph/objects-repo.ts`'s `journalEntryKindFor` routes every non-`policy` object onto that
 *    entry kind, so a peer's campaign object rides an ordinary `full`-scope journal and lands here
 *    through `upsertObjectByUrn(..., { federationImport: { originDomainId: exporterDomainId } })` —
 *    a real local row with a FOREIGN `origin_domain_id`, matched by every predicate above.
 *
 * `reconcileOneCampaign` would then compile a plan for ANOTHER DOMAIN'S campaign and propose member
 * Changes from it. That is a single-writer violation with real side effects — rows in
 * `campaign_plans`/`campaign_waves`/`campaign_wave_targets`, brand-new `changes`, a `coordinates`
 * edge hanging off a replica — not merely a scheduling problem. Worse, `reconcileCampaignsOrgTick`'s
 * unconditional round-robin bump then WROTE the replica's own `objects.updated_at` every tick.
 *
 * WHY THE FILTER AND NOT A MID-LOOP `continue`. This query is `ORDER BY objects.updated_at ASC LIMIT
 * n` — capped AND ordered — so a body-level skip that did not write the row would re-create the
 * batch-starvation property (`candidate-loop-registry.test.ts`) that cost 13 days of production
 * coordination. And the remedy used for every other instance of that property, a round-robin
 * `updated_at` bump, is ILLEGAL on a replica: it is itself the write S10 forbids. Filtering removes
 * the row from the candidate set entirely, which is starvation-free AND single-writer-clean, and it
 * keeps "SKIP, NOT PARK" intact — nothing is written, so the campaign rejoins the batch by itself
 * the moment authority returns.
 *
 * REQUIRED, not optional, and deliberately so: a future call site that forgets it would silently
 * re-open the hole, and this project's recurring bug is fixing SOME call sites of a concept. Pinned
 * by `foreign-origin-campaign.integration.test.ts`.
 */
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

/**
 * The AUTHORITATIVE campaign membership (M5 CRITICAL, adversarial review) — the member Changes a
 * campaign's own plan compiler actually proposed, read straight from `campaign_wave_targets`
 * (joined via `campaign_plans` on `campaign_object_id`), NOT from raw `coordinates` graph edges.
 * This is the ONLY membership `campaign-rollback.ts` trusts: a `coordinates` edge is a
 * system-managed relationship (creatable only via authority-checked internal paths — see
 * `graph/system-managed-relationships.ts`), but sourcing rollback membership from the plan tables
 * instead of the edges means even a stray/legacy/pre-existing `coordinates` edge (a migration
 * artifact, a future bug) can NEVER inject a rollback target. Each row carries the member Change's
 * object id AND the wave target's own `target_object_id`, so the caller can re-verify the acting
 * actor's authority over each reverted target's scope (belt-and-suspenders).
 */
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
