import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import { categoryOfType, type ChangePlan, type ChangeWaveTarget, type ExecutorType } from "@scp/schemas";
import type { TenantTx } from "../db/tenant-tx.js";
import { changePlans, changeWaveTargets, changeWaves, relationships } from "../db/schema.js";
import { badRequest, notFound } from "../errors.js";
import { compilePlan, type DependsOnEdge, type TopologyWaveSpec } from "./plan-compiler.js";
import { typeOf } from "./changes-repo.js";

/** Reads `depends_on` edges among `targetIds` directly from the graph (DESIGN §9.3: "wave order
 * is computed from graph `depends_on` edges"). Both endpoints must be in `targetIds` — edges
 * pointing outside the change's target set don't constrain this plan's wave order. */
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

/**
 * Compiles and PERSISTS a change's plan (DESIGN §9.3: `plan -> waves -> wave_targets` rows). Pure
 * compilation is `plan-compiler.ts`'s job; this function does the DB I/O around it: resolving
 * `depends_on` edges, snapshotting the release topology document (if any) so a later topology
 * edit never retroactively changes an in-flight plan, and writing the rows.
 */
export async function compileAndPersistPlan(
  tx: TenantTx,
  input: {
    orgId: string;
    changeObjectId: string;
    targetObjectIds: string[];
    topologyObjectId: string | null;
    topologyVersion: number | null;
  }
): Promise<ChangePlan> {
  const dependsOn = await loadDependsOnEdges(tx, input.orgId, input.targetObjectIds);

  // WHICH pipeline this change rolls (M12 P4A / ADR-0007) — the routing Type, read from the change
  // itself rather than threaded through every caller — compileAndPersistPlan is invoked from
  // reconcile, campaigns, rollback, promotion and the routes, and a plan is always FOR a change, so
  // the change is the honest source. Every wave target of this change inherits it: one release = one
  // source = one pipeline (owner, 2026-07-15), so the Type is a property of the change, not of each
  // target. Changes with no `properties.type` fall back to 'configuration' (the server default).
  const changeRow = await tx.query.objects.findFirst({
    where: (t, { eq: eqOp, and: andOp }) =>
      andOp(eqOp(t.id, input.changeObjectId), eqOp(t.orgId, input.orgId))
  });
  const changeType = typeOf(changeRow?.properties as Record<string, unknown> | undefined);

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
    throw badRequest(`plan compilation failed: ${result.error} — ${JSON.stringify(result)}`);
  }

  const [planRow] = await tx
    .insert(changePlans)
    .values({
      id: uuidv7(),
      orgId: input.orgId,
      changeObjectId: input.changeObjectId,
      topologyObjectId: input.topologyObjectId,
      topologyVersion: input.topologyVersion,
      topologyDocument,
      status: "active"
    })
    .returning();
  if (!planRow) throw new Error("failed to insert change plan");

  const waveRows: (typeof changeWaves.$inferSelect)[] = [];
  const targetRows: (typeof changeWaveTargets.$inferSelect)[] = [];
  for (const wave of result.waves) {
    const [waveRow] = await tx
      .insert(changeWaves)
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
    if (!waveRow) throw new Error("failed to insert change wave");
    waveRows.push(waveRow);

    for (const targetObjectId of wave.targets) {
      const [targetRow] = await tx
        .insert(changeWaveTargets)
        .values({
          id: uuidv7(),
          orgId: input.orgId,
          waveId: waveRow.id,
          targetObjectId,
          // Every wave target of this change rolls the change's pipeline (M12 P4A). Persisted per
          // target — not re-read from the change at trigger time — so a plan stays a SNAPSHOT, the
          // same discipline the topology document already follows here.
          type: changeType,
          status: "pending"
        })
        .returning();
      if (!targetRow) throw new Error("failed to insert change wave target");
      targetRows.push(targetRow);
    }
  }

  return toChangePlanShape(planRow, waveRows, targetRows);
}

function toChangeWaveTargetShape(row: typeof changeWaveTargets.$inferSelect): ChangeWaveTarget {
  const waveTargetType = (row.type as ExecutorType | null) ?? "configuration";
  return {
    id: row.id,
    waveId: row.waveId,
    targetObjectId: row.targetObjectId,
    type: waveTargetType,
    category: categoryOfType(waveTargetType),
    executorPluginId: row.executorPluginId,
    executorRef: (row.executorRef as Record<string, unknown> | null) ?? null,
    status: row.status,
    attempt: row.attempt,
    lastObservedAt: row.lastObservedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
  };
}

function toChangePlanShape(
  plan: typeof changePlans.$inferSelect,
  waves: (typeof changeWaves.$inferSelect)[],
  targets: (typeof changeWaveTargets.$inferSelect)[]
): ChangePlan {
  return {
    id: plan.id,
    changeObjectId: plan.changeObjectId,
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
        targets: targets.filter((t) => t.waveId === w.id).map(toChangeWaveTargetShape)
      }))
  };
}

export async function getLatestPlanForChange(
  tx: TenantTx,
  orgId: string,
  changeObjectId: string
): Promise<ChangePlan | null> {
  const planRow = await tx.query.changePlans.findFirst({
    where: (t, { eq: eqOp, and: andOp }) => andOp(eqOp(t.orgId, orgId), eqOp(t.changeObjectId, changeObjectId)),
    orderBy: (t, { desc }) => [desc(t.createdAt)]
  });
  if (!planRow) return null;

  const waveRows = await tx
    .select()
    .from(changeWaves)
    .where(and(eq(changeWaves.orgId, orgId), eq(changeWaves.planId, planRow.id)))
    .orderBy(asc(changeWaves.waveIndex));
  const waveIds = waveRows.map((w) => w.id);
  const targetRows =
    waveIds.length === 0
      ? []
      : await tx
          .select()
          .from(changeWaveTargets)
          .where(and(eq(changeWaveTargets.orgId, orgId), inArray(changeWaveTargets.waveId, waveIds)));

  return toChangePlanShape(planRow, waveRows, targetRows);
}
