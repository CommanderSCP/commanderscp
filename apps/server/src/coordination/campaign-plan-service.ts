import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import type { CampaignPlan, CampaignWaveTarget } from "@scp/schemas";
import type { TenantTx } from "../db/tenant-tx.js";
import { campaignPlans, campaignWaveTargets, campaignWaves, relationships } from "../db/schema.js";
import { badRequest, notFound } from "../errors.js";
import { compilePlan, type DependsOnEdge, type TopologyWaveSpec } from "./plan-compiler.js";

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

function parseTopologyWaves(document: unknown): TopologyWaveSpec[] | undefined {
  if (!document || typeof document !== "object") return undefined;
  const waves = (document as { waves?: unknown }).waves;
  if (!Array.isArray(waves)) return undefined;
  return waves as TopologyWaveSpec[];
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
    const topology = await tx.query.objects.findFirst({
      where: (t, { eq: eqOp, and: andOp }) =>
        andOp(eqOp(t.id, input.topologyObjectId!), eqOp(t.orgId, input.orgId))
    });
    if (!topology) throw notFound(`release-topology '${input.topologyObjectId}' not found`);
    topologyDocument = topology.properties as Record<string, unknown>;
  }

  const result = compilePlan({
    targets: input.targetObjectIds,
    dependsOn,
    topologyWaves: parseTopologyWaves(topologyDocument)
  });

  if (!result.ok) {
    throw badRequest(`campaign plan compilation failed: ${result.error} — ${JSON.stringify(result)}`);
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

function toCampaignWaveTargetShape(row: typeof campaignWaveTargets.$inferSelect): CampaignWaveTarget {
  return {
    id: row.id,
    waveId: row.waveId,
    targetObjectId: row.targetObjectId,
    memberChangeObjectId: row.memberChangeObjectId,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
  };
}

function toCampaignPlanShape(
  plan: typeof campaignPlans.$inferSelect,
  waves: (typeof campaignWaves.$inferSelect)[],
  targets: (typeof campaignWaveTargets.$inferSelect)[]
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
      .map((w) => ({
        id: w.id,
        planId: w.planId,
        waveIndex: w.waveIndex,
        name: w.name,
        requiresFanIn: w.requiresFanIn,
        status: w.status,
        createdAt: w.createdAt.toISOString(),
        startedAt: w.startedAt?.toISOString() ?? null,
        completedAt: w.completedAt?.toISOString() ?? null,
        targets: targets.filter((t) => t.waveId === w.id).map(toCampaignWaveTargetShape)
      }))
  };
}

export async function getLatestCampaignPlan(
  tx: TenantTx,
  orgId: string,
  campaignObjectId: string
): Promise<CampaignPlan | null> {
  const planRow = await tx.query.campaignPlans.findFirst({
    where: (t, { eq: eqOp, and: andOp }) => andOp(eqOp(t.orgId, orgId), eqOp(t.campaignObjectId, campaignObjectId)),
    orderBy: (t, { desc }) => [desc(t.createdAt)]
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
          .where(and(eq(campaignWaveTargets.orgId, orgId), inArray(campaignWaveTargets.waveId, waveIds)));

  return toCampaignPlanShape(planRow, waveRows, targetRows);
}

export async function markCampaignPlanCompleted(tx: TenantTx, orgId: string, planId: string): Promise<void> {
  await tx
    .update(campaignPlans)
    .set({ status: "completed" })
    .where(and(eq(campaignPlans.orgId, orgId), eq(campaignPlans.id, planId)));
}
