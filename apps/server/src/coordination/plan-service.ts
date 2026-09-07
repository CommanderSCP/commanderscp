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
  changes,
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
import {
  describeFreezeForWaveTarget,
  evaluateFreezeHolds,
  type FreezeHoldVerdict
} from "./freeze-hold.js";
import { evaluateContinuousHolds, type ContinuousHoldTargetVerdict } from "./continuous-hold.js";
import { rollbackExemptible } from "../governance/freeze-scope.js";
import { originalChangeDispatchedTarget } from "./wave-targets-repo.js";

/** Reads the dependency edges among targets from the graph. See docs/coordination.md §687. */
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

/** Decides whether a topology is STAGE-shaped. See docs/coordination.md §688. */
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

/** Compiles and PERSISTS a change's plan. See docs/coordination.md §689. */
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

  // WHICH pipeline this change rolls (M12 P4A / ADR-0007). See docs/coordination.md §690.
  const changeRow = await tx.query.objects.findFirst({
    where: (t, { eq: eqOp, and: andOp }) =>
      andOp(eqOp(t.id, input.changeObjectId), eqOp(t.orgId, input.orgId))
  });
  const changeType = typeOf(changeRow?.properties as Record<string, unknown> | undefined);

  // THE CHANGE'S OWN DECLARED COUPLINGS. See docs/coordination.md §691.
  const { stageDependencies: declaredStageDependencies } = stageDependenciesOf(
    changeRow?.properties as Record<string, unknown> | undefined
  );

  let topologyDocument: Record<string, unknown> | null = null;
  if (input.topologyObjectId) {
    // Live-filtered, the same call the resolver already makes. See docs/coordination.md §692.
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
        // A wave holding none of this change is born skipped. See docs/coordination.md §693.
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

/** Wire shape of `ChangeWaveTargetSchema.hold`. See docs/coordination.md §694. */
export type WaveTargetHold = NonNullable<ChangeWaveTarget["hold"]>;

/** The FREEZE HALF alone — what `toWaveTargetHold` builds and what the campaign wave target's own
 *  `hold` is in its entirety (`CampaignWaveTargetSchema.hold` has no continuous-test half; a
 *  campaign wave target is a fan-out candidate, not a deployment). Named separately so that adding
 *  `continuousTests` to the CHANGE side could not silently widen the campaign side's contract. */
export type WaveTargetFreezeHold = Pick<WaveTargetHold, "freezes">;

/** `FreezeHoldVerdict` -> the wire `hold` shape. See docs/coordination.md §695. */
export function toWaveTargetHold(
  verdict: FreezeHoldVerdict | undefined,
  scopeNames: Map<string, string>
): WaveTargetFreezeHold | undefined {
  if (!verdict || verdict.freezes.length === 0) return undefined;
  return {
    freezes: verdict.freezes.map((f) => {
      const scopeName = f.scopeObjectId ? (scopeNames.get(f.scopeObjectId) ?? null) : null;
      return {
        freezeId: f.id,
        scope: f.scopeObjectId ? { objectId: f.scopeObjectId, name: scopeName } : null,
        summary: describeFreezeForWaveTarget(f, scopeName),
        endsAt: f.endsAt
      };
    })
  };
}

/** The two halves of the hold, merged into one wire object. See docs/coordination.md §696. */
export function composeWaveTargetHold(
  freeze: WaveTargetFreezeHold | undefined,
  continuous: ContinuousHoldTargetVerdict | undefined
): WaveTargetHold | undefined {
  const continuousTests = continuous?.holds.map((h) => ({
    hookId: h.hookId,
    reason: h.reason,
    summary: h.summary,
    staleAfter: h.staleAfter,
    lastReportedAt: h.lastReportedAt
  }));
  if (!freeze && (continuousTests === undefined || continuousTests.length === 0)) return undefined;
  return {
    freezes: freeze?.freezes ?? [],
    ...(continuousTests !== undefined && continuousTests.length > 0 ? { continuousTests } : {})
  };
}

function toChangeWaveTargetShape(
  row: typeof changeWaveTargets.$inferSelect,
  hold?: WaveTargetHold
): ChangeWaveTarget {
  const waveTargetType = (row.type as ExecutorType | null) ?? "configuration";
  return {
    id: row.id,
    waveId: row.waveId,
    targetObjectId: row.targetObjectId,
    type: waveTargetType,
    category: categoryOfType(waveTargetType),
    executorPluginId: row.executorPluginId,
    executorRef: (row.executorRef as Record<string, unknown> | null) ?? null,
    // The snapshot reconcile persisted. See docs/coordination.md §697.
    observed:
      (row.observedState as {
        revision?: string;
        images?: string[];
        rollout?: { phase?: string; step?: number; weight?: number; message?: string };
        truncation?: Record<
          string,
          {
            dropped: boolean;
            droppedCharacters?: number;
            droppedEntries?: number;
            droppedFields?: number;
          }
        >;
      } | null) ?? null,
    ...(hold ? { hold } : {}),
    status: row.status,
    attempt: row.attempt,
    lastObservedAt: row.lastObservedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
  };
}

/** `freezeHolds` is OPTIONAL. See docs/coordination.md §698. */
/** THE ONE WAVE ADMISSION CURRENTLY GOVERNS. See docs/coordination.md §699. */
export function activeWaveOf<W extends { status: string }>(waves: W[]): W | undefined {
  return waves.find((w) => w.status !== "succeeded" && w.status !== "skipped");
}
function toChangePlanShape(
  plan: typeof changePlans.$inferSelect,
  waves: (typeof changeWaves.$inferSelect)[],
  targets: (typeof changeWaveTargets.$inferSelect)[],
  freezeHolds?: Map<string, FreezeHoldVerdict>,
  scopeNames?: Map<string, string>,
  /** The continuous-probe half of `hold`, re-derived on this same read. Passed SEPARATELY from
   *  `freezeHolds` rather than pre-merged because the two are produced by two independent
   *  predicates over the same candidate set and a target can be held by either, both, or neither. */
  continuousHolds?: Map<string, ContinuousHoldTargetVerdict>
): ChangePlan {
  return {
    id: plan.id,
    changeObjectId: plan.changeObjectId,
    topologyObjectId: plan.topologyObjectId,
    topologyVersion: plan.topologyVersion,
    status: plan.status,
    createdAt: plan.createdAt.toISOString(),
    waves: (() => {
      const activeWaveId = freezeHolds !== undefined ? activeWaveOf(waves)?.id : undefined;
      return waves
        .sort((a, b) => a.waveIndex - b.waveIndex)
        .map((w) => {
          const waveTargets = targets.filter((t) => t.waveId === w.id);
          // Freeze-held count only, here. See docs/coordination.md §700.
          const heldTargetCount =
            freezeHolds !== undefined && w.id === activeWaveId
              ? waveTargets.filter((t) => freezeHolds.has(t.targetObjectId)).length
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
              toChangeWaveTargetShape(
                t,
                composeWaveTargetHold(
                  toWaveTargetHold(freezeHolds?.get(t.targetObjectId), scopeNames ?? new Map()),
                  continuousHolds?.get(t.targetObjectId)
                )
              )
            )
          };
        });
    })()
  };
}

/** Which targets a hold can still act on, resolved once. See docs/coordination.md §701. */
interface WaveTargetHoldCandidates {
  /** EVERY target of the active wave, pending or not. The freeze half must ask about all of them:
   *  an `atomic` freeze's union (`freeze-hold.ts`'s `unionFreezes(byTarget)`) only ever sees the
   *  ids it was asked about, so a target held SOLELY because an atomic freeze covers an
   *  already-succeeded sibling would never surface if the pending subset were the question. */
  activeWaveTargetIds: string[];
  /** The subset a hold can still act on — `pending`/`triggering`. A `triggered` target has already
   *  been handed to its executor and no hold can un-ring that bell (ADR-0008 has no pause verb). */
  pendingTargetIds: Set<string>;
  /** D7's rollback exemption inputs, read off the same change row. */
  rollbackOfObjectId: string | null;
}

async function resolveWaveTargetHoldCandidates(
  tx: TenantTx,
  orgId: string,
  changeObjectId: string,
  waves: (typeof changeWaves.$inferSelect)[],
  targets: (typeof changeWaveTargets.$inferSelect)[]
): Promise<WaveTargetHoldCandidates | null> {
  const [changeRow] = await tx
    .select({ state: changes.state, rollbackOfObjectId: changes.rollbackOfObjectId })
    .from(changes)
    .where(and(eq(changes.orgId, orgId), eq(changes.objectId, changeObjectId)))
    .limit(1);
  if (changeRow?.state !== "executing") return null;

  const activeWave = activeWaveOf(waves);
  if (!activeWave) return null;

  const activeWaveTargets = targets.filter((t) => t.waveId === activeWave.id);
  const pendingTargetIds = new Set(
    activeWaveTargets
      .filter((t) => t.status === "pending" || t.status === "triggering")
      .map((t) => t.targetObjectId)
  );
  if (pendingTargetIds.size === 0) return null;

  return {
    activeWaveTargetIds: activeWaveTargets.map((t) => t.targetObjectId),
    pendingTargetIds,
    rollbackOfObjectId: changeRow.rollbackOfObjectId
  };
}

/** THE READ-TIME HALF OF THE PER-TARGET CONTINUOUS-TEST HOLD. See docs/coordination.md §702. */
async function resolveWaveTargetContinuousHolds(
  tx: TenantTx,
  orgId: string,
  candidates: WaveTargetHoldCandidates | null
): Promise<Map<string, ContinuousHoldTargetVerdict>> {
  if (!candidates) return new Map();
  // `evaluateContinuousHolds` opens with ONE indexed existence read and returns empty before
  // resolving a single placement for an org that declares no `continuous` hook — which is nearly
  // every org, nearly all the time. No extra gate is needed here, and adding one would be a second
  // place for the inertness property to be true.
  return await evaluateContinuousHolds(tx, {
    orgId,
    targetObjectIds: [...candidates.pendingTargetIds]
  });
}

/** The read-time half of the freeze-hold projection. See docs/coordination.md §703. */
async function resolveWaveTargetFreezeHolds(
  tx: TenantTx,
  orgId: string,
  candidates: WaveTargetHoldCandidates | null
): Promise<Map<string, FreezeHoldVerdict>> {
  if (!candidates) return new Map();
  const { activeWaveTargetIds, pendingTargetIds } = candidates;

  const allHolds = await evaluateFreezeHolds(tx, {
    orgId,
    targetObjectIds: activeWaveTargetIds
  });

  // D7'S ROLLBACK EXEMPTION, MIRRORED. See docs/coordination.md §704.
  const rollbackOfObjectId = candidates.rollbackOfObjectId;
  const isRollback = rollbackOfObjectId !== null;

  const holds = new Map<string, FreezeHoldVerdict>();
  for (const [targetObjectId, verdict] of allHolds) {
    if (!pendingTargetIds.has(targetObjectId)) continue;
    if (
      isRollback &&
      rollbackOfObjectId &&
      rollbackExemptible(verdict.freezes) &&
      (await originalChangeDispatchedTarget(tx, orgId, rollbackOfObjectId, targetObjectId))
    ) {
      continue;
    }
    holds.set(targetObjectId, verdict);
  }
  return holds;
}

/** Display names for every covering freeze, in one query. See docs/coordination.md §705. */
/** EXPORTED for `campaign-plan-service.ts`, which resolves the SAME `scopeObjectId -> name` map
 *  for its own `FreezeHoldVerdict`s through this function rather than a second copy of the query. */
export async function resolveFreezeScopeNames(
  tx: TenantTx,
  orgId: string,
  holds: Map<string, FreezeHoldVerdict>
): Promise<Map<string, string>> {
  const ids = new Set<string>();
  for (const verdict of holds.values()) {
    for (const f of verdict.freezes) {
      if (f.scopeObjectId) ids.add(f.scopeObjectId);
    }
  }
  if (ids.size === 0) return new Map();
  const rows = await tx
    .select({ id: objects.id, name: objects.name })
    .from(objects)
    .where(and(eq(objects.orgId, orgId), inArray(objects.id, [...ids]), isNull(objects.deletedAt)));
  return new Map(rows.map((row) => [row.id, row.name]));
}

export async function getLatestPlanForChange(
  tx: TenantTx,
  orgId: string,
  changeObjectId: string,
  /** This flag skips both read-time hold projections. See docs/coordination.md §706. */
  options?: { withFreezeHolds?: boolean }
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

  if (options?.withFreezeHolds === false) {
    return toChangePlanShape(planRow, waveRows, targetRows);
  }

  // ONE gate, TWO predicates over it — see `resolveWaveTargetHoldCandidates`. Both halves of
  // `ChangeWaveTargetSchema.hold` are re-derived here on every read and NEITHER is ever persisted:
  // the holding Decision rows have no clearing counterpart that `explain` can see between ticks,
  // so a field fed from one would say "held" after the condition cleared.
  const candidates = await resolveWaveTargetHoldCandidates(
    tx,
    orgId,
    changeObjectId,
    waveRows,
    targetRows
  );
  const freezeHolds = await resolveWaveTargetFreezeHolds(tx, orgId, candidates);
  const continuousHolds = await resolveWaveTargetContinuousHolds(tx, orgId, candidates);
  const scopeNames = await resolveFreezeScopeNames(tx, orgId, freezeHolds);

  return toChangePlanShape(planRow, waveRows, targetRows, freezeHolds, scopeNames, continuousHolds);
}
