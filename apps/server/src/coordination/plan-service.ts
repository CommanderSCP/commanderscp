import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import {
  categoryOfType,
  type ChangePlan,
  type ChangeWaveTarget,
  type ExecutorType
} from "@scp/schemas";
import type { TenantTx } from "../db/tenant-tx.js";
import {
  changePlans,
  changeWaveTargets,
  changeWaves,
  objects,
  relationships
} from "../db/schema.js";
import { badRequest, notFound } from "../errors.js";
import {
  compilePlan,
  type DependsOnEdge,
  type StagePlacement,
  type TopologyWaveSpec
} from "./plan-compiler.js";
import { stageDependenciesOf, typeOf } from "./changes-repo.js";
import { parseTopologyWaves } from "./topology-waves.js";

/** Reads `depends_on` edges among `targetIds` directly from the graph (DESIGN §9.3: "wave order
 * is computed from graph `depends_on` edges"). Both endpoints must be in `targetIds` — edges
 * pointing outside the change's target set don't constrain this plan's wave order.
 *
 * EXPORTED FOR `reconcile.ts`, which feeds the identical set to the stage-dependency hold (ADR-0028
 * decision 6): the compile-time same-wave refusal this set used to drive was replaced by a runtime
 * hold, and "the same set" is the whole content of calling it a replacement. Call this rather than
 * writing the query again — a second copy is where the two definitions would drift apart. */
export async function loadDependsOnEdges(
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

/**
 * Decides whether a topology is STAGE-shaped (waves name deployment-targets — ADR-0026 §5) or
 * LEGACY-shaped (waves name the change's own targets), and resolves the placements stage mode
 * needs. Returns `undefined` for legacy, which leaves `compilePlan` on its original path.
 *
 * The classification is made from what the ids ARE, not from a flag on the document, because both
 * shapes exist in real data: the estate carries one topology naming deployment-targets and one
 * naming components. A MIXED topology is refused rather than guessed at — that is not a shape
 * anything can mean.
 */
async function resolveStagePlacements(
  tx: TenantTx,
  orgId: string,
  waves: TopologyWaveSpec[],
  targetObjectIds: string[]
): Promise<StagePlacement[] | undefined> {
  const waveTargetIds = [...new Set(waves.flatMap((w) => w.targets))];
  if (waveTargetIds.length === 0) return undefined;

  const rows = await tx
    .select({ id: objects.id, typeId: objects.typeId })
    .from(objects)
    .where(
      and(eq(objects.orgId, orgId), inArray(objects.id, waveTargetIds), isNull(objects.deletedAt))
    );
  const typeById = new Map(rows.map((r) => [r.id, r.typeId]));
  const places = waveTargetIds.filter((id) => typeById.get(id) === "deployment-target");

  if (places.length === 0) return undefined; // legacy shape — nothing here names a place
  if (places.length !== waveTargetIds.length) {
    const others = waveTargetIds.filter((id) => !places.includes(id));
    throw badRequest(
      `release topology mixes deployment-targets with non-places (${others.join(", ")}) — a wave names either the places a change rolls through or the change's own targets, never both`
    );
  }

  // Every placement of this change's components. Read from the PROPERTIES, which are the source of
  // truth for a placement's pair (ADR-0026 D17) and the half the unique index covers.
  const placementRows = await tx
    .select({ id: objects.id, properties: objects.properties })
    .from(objects)
    .where(
      and(eq(objects.orgId, orgId), eq(objects.typeId, "placement"), isNull(objects.deletedAt))
    );
  const componentSet = new Set(targetObjectIds);
  const placements: StagePlacement[] = [];
  for (const row of placementRows) {
    const props = row.properties as { componentId?: unknown; deploymentTargetId?: unknown };
    const componentObjectId = props.componentId;
    const deploymentTargetObjectId = props.deploymentTargetId;
    if (typeof componentObjectId !== "string" || typeof deploymentTargetObjectId !== "string") {
      continue;
    }
    if (!componentSet.has(componentObjectId)) continue;
    placements.push({ componentObjectId, deploymentTargetObjectId, placementObjectId: row.id });
  }
  return placements;
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

  // THE CHANGE'S OWN DECLARED COUPLINGS (ADR-0028), off the row already in hand — no second query.
  // They exist here for ONE reason: `compileStages`'s co-placed cycle refusal has to see what the
  // RUNTIME HOLD enforces, and the hold enforces declarations independently of whether any
  // `depends_on` edge survives. `loadDependsOnEdges` above cannot supply that half — it filters
  // `deleted_at IS NULL`, and `materialiseStageDependencyEdges` never re-mints an edge whose
  // tombstone still occupies the unique key — so a mutual declaration with one deleted edge compiled
  // clean and then wedged in `executing` forever. See `coPlacedCycle`.
  //
  // `malformed` is deliberately NOT passed. A malformed entry is unsatisfiable and holds every target
  // (`stage-dependency-hold.ts`'s `undeclarable` branch), which is its own failure mode with its own
  // remedy; it is not a CYCLE and this check must not start reporting it as one. Propose-time Zod
  // validation makes such a row unreachable through the API in the first place.
  const { stageDependencies: declaredStageDependencies } = stageDependenciesOf(
    changeRow?.properties as Record<string, unknown> | undefined
  );

  let topologyDocument: Record<string, unknown> | null = null;
  if (input.topologyObjectId) {
    const topology = await tx.query.objects.findFirst({
      where: (t, { eq: eqOp, and: andOp }) =>
        andOp(eqOp(t.id, input.topologyObjectId!), eqOp(t.orgId, input.orgId))
    });
    if (!topology) throw notFound(`release-topology '${input.topologyObjectId}' not found`);
    topologyDocument = topology.properties as Record<string, unknown>;
  }

  const topologyWaves = parseTopologyWaves(topologyDocument);
  const placements = topologyWaves
    ? await resolveStagePlacements(tx, input.orgId, topologyWaves, input.targetObjectIds)
    : undefined;

  const result = compilePlan({
    targets: input.targetObjectIds,
    dependsOn,
    ...(topologyWaves ? { topologyWaves } : {}),
    ...(placements ? { placements } : {}),
    ...(declaredStageDependencies.length > 0 ? { declaredStageDependencies } : {})
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
        // A stage wave whose place holds none of this change's components is born `skipped`, not
        // `pending`: both reconcilers already treat `skipped` as "nothing to wait for" when picking
        // the active wave, so this needs no engine change — it just finally PRODUCES a status the
        // engine has always been able to read. Left visible in the plan so an operator can see that
        // gamma was declared and had no participants, rather than wondering where it went.
        status: wave.skipped ? "skipped" : "pending"
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
    // The snapshot reconcile persisted — the per-wave version (revision + deployed images) plus the
    // OBSERVE-ONLY rollout snapshot (P4D). The raw jsonb already carries all three once merged (P4B
    // revision + P4C images + P4D rollout); no query change.
    observed:
      (row.observedState as {
        revision?: string;
        images?: string[];
        rollout?: { phase?: string; step?: number; weight?: number; message?: string };
      } | null) ?? null,
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
    where: (t, { eq: eqOp, and: andOp }) =>
      andOp(eqOp(t.orgId, orgId), eqOp(t.changeObjectId, changeObjectId)),
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
          .where(
            and(eq(changeWaveTargets.orgId, orgId), inArray(changeWaveTargets.waveId, waveIds))
          );

  return toChangePlanShape(planRow, waveRows, targetRows);
}
