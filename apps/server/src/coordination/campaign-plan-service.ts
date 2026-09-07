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

/** Compiles and PERSISTS a campaign's plan. See docs/coordination.md §140. */

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
    // LIVE-FILTERED, identically to `plan-service.ts`'s twin. See docs/coordination.md §141.
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

  // No declared stage dependencies here, and that is a ruling. See docs/coordination.md §142.
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

/** THE ACTIVE (RUNNING) CAMPAIGN WAVE'S FREEZE HOLDS. See docs/coordination.md §143. */
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
  /** Freeze holds default off here, the opposite default. See docs/coordination.md §144. */
  options?: { withFreezeHolds?: boolean }
): Promise<CampaignPlan | null> {
  const planRow = await tx.query.campaignPlans.findFirst({
    where: (t, { eq: eqOp, and: andOp }) =>
      andOp(eqOp(t.orgId, orgId), eqOp(t.campaignObjectId, campaignObjectId)),
    // `(createdAt, id)` DESC, not `createdAt` alone. See docs/coordination.md §145.
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
