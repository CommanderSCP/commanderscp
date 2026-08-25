import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import type { CampaignPlan, CampaignWaveTarget } from "@scp/schemas";
import type { TenantTx } from "../db/tenant-tx.js";
import { campaignPlans, campaignWaveTargets, campaignWaves, relationships } from "../db/schema.js";
import { badRequest, notFound } from "../errors.js";
import { compilePlan, type DependsOnEdge } from "./plan-compiler.js";
import { parseTopologyWaves } from "./topology-waves.js";
import { evaluateFreezeHolds, type FreezeHoldVerdict } from "./freeze-hold.js";
import {
  activeWaveOf,
  resolveFreezeScopeNames,
  toWaveTargetHold,
  type WaveTargetHold
} from "./plan-service.js";

/**
 * Compiles and PERSISTS a campaign's plan — the campaign-scoped sibling of
 * `coordination/plan-service.ts`'s `compileAndPersistPlan`, reusing the EXACT SAME pure
 * `compilePlan` function (DESIGN §9.5: "own plan -> waves -> gates compiled over the same
 * plan/wave machinery as a single change... reuse the M3 plan compiler"). Only the persistence
 * target differs (`campaign_plans`/`campaign_waves`/`campaign_wave_targets` instead of
 * `change_plans`/`change_waves`/`change_wave_targets` — db/schema.ts's M5 doc comment explains why
 * these are separate tables rather than one shared table: a campaign wave target's unit of work is
 * an entire member Change, not a direct executor trigger).
 */

async function loadDependsOnEdges(
  tx: TenantTx,
  orgId: string,
  targetIds: string[]
): Promise<DependsOnEdge[]> {
  if (targetIds.length === 0) return [];
  const rows = await tx
    .select({ fromId: relationships.fromId, toId: relationships.toId })
    .from(relationships)
    .where(
      and(
        eq(relationships.orgId, orgId),
        eq(relationships.typeId, "depends_on"),
        inArray(relationships.fromId, targetIds),
        inArray(relationships.toId, targetIds),
        isNull(relationships.deletedAt)
      )
    );
  return rows.map((r) => ({ from: r.fromId, to: r.toId }));
}

export async function compileAndPersistCampaignPlan(
  tx: TenantTx,
  input: {
    orgId: string;
    campaignObjectId: string;
    targetObjectIds: string[];
    topologyObjectId: string | null;
    topologyVersion: number | null;
  }
): Promise<CampaignPlan> {
  const dependsOn = await loadDependsOnEdges(tx, input.orgId, input.targetObjectIds);

  let topologyDocument: Record<string, unknown> | null = null;
  if (input.topologyObjectId) {
    // LIVE-FILTERED, identically to `plan-service.ts`'s twin — this file is the campaign-side COPY of
    // that lookup and carried the same missing predicate. Fixing one and not the other is exactly the
    // half-census this project keeps paying for; a soft-deleted release-topology must not shape a
    // campaign's waves either. The refusal is recorded as a `plan_diff` block Decision by
    // `campaign-reconcile.ts`'s compile catch, so it is explainable rather than a bare throw.
    const topology = await tx.query.objects.findFirst({
      where: (t, { eq: eqOp, and: andOp, isNull: isNullOp }) =>
        andOp(
          eqOp(t.id, input.topologyObjectId!),
          eqOp(t.orgId, input.orgId),
          isNullOp(t.deletedAt)
        )
    });
    if (!topology) throw notFound(`release-topology '${input.topologyObjectId}' not found`);
    topologyDocument = topology.properties as Record<string, unknown>;
  }

  // The SAME parser `plan-service.ts` uses, so a malformed topology is refused on the campaign path
  // exactly as loudly as on the change path — see `topology-waves.ts` for why it is a shared module
  // and not a second copy.
  const topologyWaves = parseTopologyWaves(topologyDocument);

  // NO `declaredStageDependencies` HERE, and that is a ruling rather than an omission (ADR-0028).
  // The field feeds ONE thing: `compileStages`'s co-placed cycle refusal, which lives on the STAGE
  // path — the one entered only when `placements` is supplied. This function never supplies them, so
  // a campaign plan cannot reach that code at all. There is also nothing to supply: a declaration is
  // a property of a CHANGE (`stageDependenciesOf`), a `campaign` object carries none, and each member
  // change gets its own plan through `plan-service.ts`'s `compileAndPersistPlan`, which does pass its
  // own. Threading an always-empty array through here would suggest a coupling that does not exist.
  const result = compilePlan({
    targets: input.targetObjectIds,
    dependsOn,
    ...(topologyWaves ? { topologyWaves } : {})
  });

  if (!result.ok) {
    throw badRequest(
      `campaign plan compilation failed: ${result.error} — ${JSON.stringify(result)}`
    );
  }

  const [planRow] = await tx
    .insert(campaignPlans)
    .values({
      id: uuidv7(),
      orgId: input.orgId,
      campaignObjectId: input.campaignObjectId,
      topologyObjectId: input.topologyObjectId,
      topologyVersion: input.topologyVersion,
      topologyDocument,
      status: "active"
    })
    .returning();
  if (!planRow) throw new Error("failed to insert campaign plan");

  const waveRows: (typeof campaignWaves.$inferSelect)[] = [];
  const targetRows: (typeof campaignWaveTargets.$inferSelect)[] = [];
  for (const wave of result.waves) {
    const [waveRow] = await tx
      .insert(campaignWaves)
      .values({
        id: uuidv7(),
        orgId: input.orgId,
        planId: planRow.id,
        waveIndex: wave.waveIndex,
        name: wave.name,
        requiresFanIn: wave.requiresFanIn,
        status: "pending"
      })
      .returning();
    if (!waveRow) throw new Error("failed to insert campaign wave");
    waveRows.push(waveRow);

    for (const targetObjectId of wave.targets) {
      const [targetRow] = await tx
        .insert(campaignWaveTargets)
        .values({
          id: uuidv7(),
          orgId: input.orgId,
          waveId: waveRow.id,
          targetObjectId,
          status: "pending"
        })
        .returning();
      if (!targetRow) throw new Error("failed to insert campaign wave target");
      targetRows.push(targetRow);
    }
  }

  return toCampaignPlanShape(planRow, waveRows, targetRows);
}

function toCampaignWaveTargetShape(
  row: typeof campaignWaveTargets.$inferSelect,
  hold?: WaveTargetHold
): CampaignWaveTarget {
  return {
    id: row.id,
    waveId: row.waveId,
    targetObjectId: row.targetObjectId,
    memberChangeObjectId: row.memberChangeObjectId,
    ...(hold ? { hold } : {}),
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
  };
}

/**
 * THE ACTIVE (RUNNING) CAMPAIGN WAVE'S FREEZE HOLDS — the campaign-scoped sibling of
 * `plan-service.ts`'s `resolveWaveTargetFreezeHolds`, evaluated through the SAME `evaluateFreezeHolds`
 * (`freeze-hold.ts`) rather than a second implementation, and gated by the SAME `activeWaveOf`
 * selector the change side uses — so "which wave admission governs" cannot drift between the two
 * schemas.
 *
 * CANDIDATE SET, restated from `campaign-repo.ts`'s M25.2 comment (this function now IS that
 * evaluation — `getCampaignStatus` calls `getLatestCampaignPlan({ withFreezeHolds: true })` and
 * derives its `frozenTargetCount` input from the SAME composed `hold` field this produces, rather
 * than re-evaluating): the active wave must be `running` (a wave that has not started yet is
 * withholding nothing, and a terminal wave is past admission entirely), and only its targets whose
 * `memberChangeObjectId` is still `null` are candidates — once a member Change is minted, admission
 * has already acted on that target and a freeze bites the member Change's own wave targets one
 * layer down, not this row.
 *
 * `waves` is accepted STRUCTURALLY (bare `status`/`targetObjectId`/`memberChangeObjectId`) so a
 * caller can pass either raw `campaign_waves`/`campaign_wave_targets` rows (this file, building the
 * response) or the already-composed wire `CampaignPlan.waves` (`campaign-repo.ts`, deriving status)
 * — both shapes satisfy it, and there is no second evaluation to keep in sync with this one.
 */
export async function resolveActiveCampaignWaveFreezeHolds(
  tx: TenantTx,
  orgId: string,
  waves: {
    id: string;
    status: string;
    targets: { targetObjectId: string; memberChangeObjectId: string | null }[];
  }[]
): Promise<{ activeWaveId: string | undefined; holds: Map<string, FreezeHoldVerdict> }> {
  const activeWave = activeWaveOf(waves);
  if (!activeWave || activeWave.status !== "running") {
    return { activeWaveId: undefined, holds: new Map() };
  }

  const candidateTargetIds = activeWave.targets
    .filter((t) => t.memberChangeObjectId === null)
    .map((t) => t.targetObjectId);
  if (candidateTargetIds.length === 0) {
    return { activeWaveId: activeWave.id, holds: new Map() };
  }

  const holds = await evaluateFreezeHolds(tx, { orgId, targetObjectIds: candidateTargetIds });
  return { activeWaveId: activeWave.id, holds };
}

function toCampaignPlanShape(
  plan: typeof campaignPlans.$inferSelect,
  waves: (typeof campaignWaves.$inferSelect)[],
  targets: (typeof campaignWaveTargets.$inferSelect)[],
  freezeHolds?: { activeWaveId: string | undefined; holds: Map<string, FreezeHoldVerdict> },
  scopeNames?: Map<string, string>
): CampaignPlan {
  return {
    id: plan.id,
    campaignObjectId: plan.campaignObjectId,
    topologyObjectId: plan.topologyObjectId,
    topologyVersion: plan.topologyVersion,
    status: plan.status,
    createdAt: plan.createdAt.toISOString(),
    waves: waves
      .sort((a, b) => a.waveIndex - b.waveIndex)
      .map((w) => {
        const waveTargets = targets.filter((t) => t.waveId === w.id);
        // ACTIVE WAVE ONLY, exactly as `plan-service.ts`'s `toChangePlanShape` restricts
        // `heldTargetCount` — the evaluation never looks at any other wave, so any other wave's
        // count would be a fabricated zero (absent = not evaluated; see the schema doc).
        const heldTargetCount =
          freezeHolds !== undefined && w.id === freezeHolds.activeWaveId
            ? waveTargets.filter((t) => freezeHolds.holds.has(t.targetObjectId)).length
            : undefined;
        return {
          id: w.id,
          planId: w.planId,
          waveIndex: w.waveIndex,
          name: w.name,
          requiresFanIn: w.requiresFanIn,
          status: w.status,
          createdAt: w.createdAt.toISOString(),
          startedAt: w.startedAt?.toISOString() ?? null,
          completedAt: w.completedAt?.toISOString() ?? null,
          ...(heldTargetCount !== undefined ? { heldTargetCount } : {}),
          targets: waveTargets.map((t) =>
            toCampaignWaveTargetShape(
              t,
              toWaveTargetHold(freezeHolds?.holds.get(t.targetObjectId), scopeNames ?? new Map())
            )
          )
        };
      })
  };
}

export async function getLatestCampaignPlan(
  tx: TenantTx,
  orgId: string,
  campaignObjectId: string,
  /**
   * `withFreezeHolds` defaults `false`, the OPPOSITE default from `plan-service.ts`'s
   * `getLatestPlanForChange` — deliberately, not an oversight. `campaign-reconcile.ts`'s per-tick
   * loop and every other existing caller here (adoption, deadline evaluation, a dozen integration
   * tests) call this UNCONDITIONALLY, often once per campaign per tick, and none of them read
   * `.hold`/`heldTargetCount` off the result — flipping the default would pay for a freeze
   * evaluation on every one of those paths for a projection nobody there consumes, exactly the cost
   * the change side's own `withFreezeHolds: false` escape hatch exists to avoid (see that param's
   * doc). Only the wire consumers that actually serve the projection — the `:explain` route and
   * `campaign-repo.ts`'s `getCampaignStatus` (which now derives `frozenTargetCount` from this SAME
   * evaluation instead of running its own) — opt in.
   */
  options?: { withFreezeHolds?: boolean }
): Promise<CampaignPlan | null> {
  const planRow = await tx.query.campaignPlans.findFirst({
    where: (t, { eq: eqOp, and: andOp }) =>
      andOp(eqOp(t.orgId, orgId), eqOp(t.campaignObjectId, campaignObjectId)),
    // `(createdAt, id)` DESC, not `createdAt` alone. `created_at` defaults to `now()`, which in
    // Postgres is TRANSACTION time — so two plans written in the same transaction carry a
    // BYTE-IDENTICAL timestamp and "latest" was genuinely ambiguous, resolved by whatever order the
    // planner happened to return. `id` is UUIDv7 (time-ordered), so it is both a deterministic
    // tiebreak and the right one.
    //
    // This is not cosmetic: `campaign-repo.ts`'s `listActiveCampaignObjectIds` now filters on "the
    // LATEST plan is not terminal", and that filter and this reader MUST agree on which plan is
    // latest. If they disagreed under a tie, a campaign could be filtered out of the reconciler's
    // batch as terminal while this function handed the reconciler an ACTIVE plan — a campaign that
    // is never driven and shows no error. Both now order by the same tuple.
    orderBy: (t, { desc }) => [desc(t.createdAt), desc(t.id)]
  });
  if (!planRow) return null;

  const waveRows = await tx
    .select()
    .from(campaignWaves)
    .where(and(eq(campaignWaves.orgId, orgId), eq(campaignWaves.planId, planRow.id)))
    .orderBy(asc(campaignWaves.waveIndex));
  const waveIds = waveRows.map((w) => w.id);
  const targetRows =
    waveIds.length === 0
      ? []
      : await tx
          .select()
          .from(campaignWaveTargets)
          .where(
            and(eq(campaignWaveTargets.orgId, orgId), inArray(campaignWaveTargets.waveId, waveIds))
          );

  if (!options?.withFreezeHolds) {
    return toCampaignPlanShape(planRow, waveRows, targetRows);
  }

  const waveTargetsByWaveId = new Map<string, (typeof targetRows)[number][]>();
  for (const t of targetRows) {
    const bucket = waveTargetsByWaveId.get(t.waveId);
    if (bucket) bucket.push(t);
    else waveTargetsByWaveId.set(t.waveId, [t]);
  }
  const wavesForFreezeEval = waveRows.map((w) => ({
    id: w.id,
    status: w.status,
    targets: (waveTargetsByWaveId.get(w.id) ?? []).map((t) => ({
      targetObjectId: t.targetObjectId,
      memberChangeObjectId: t.memberChangeObjectId
    }))
  }));
  const freezeHolds = await resolveActiveCampaignWaveFreezeHolds(tx, orgId, wavesForFreezeEval);
  const scopeNames = await resolveFreezeScopeNames(tx, orgId, freezeHolds.holds);

  return toCampaignPlanShape(planRow, waveRows, targetRows, freezeHolds, scopeNames);
}

export async function markCampaignPlanCompleted(
  tx: TenantTx,
  orgId: string,
  planId: string
): Promise<void> {
  await tx
    .update(campaignPlans)
    .set({ status: "completed" })
    .where(and(eq(campaignPlans.orgId, orgId), eq(campaignPlans.id, planId)));
}
