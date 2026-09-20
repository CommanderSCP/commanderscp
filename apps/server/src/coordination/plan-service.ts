import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import {
  categoryOfType,
  type ChangePlan,
  type ChangeWaveEntry,
  type ChangeWaveTarget,
  type ExecutorType
} from "@scp/schemas";
import type { TenantTx } from "../db/tenant-tx.js";
import {
  changePlans,
  changes,
  changeWaveTargets,
  changeWaves,
  executorBindings,
  objects,
  relationships
} from "../db/schema.js";
import { badRequest, notFound } from "../errors.js";
import { resolveBindingForTarget } from "./binding-resolution.js";
import { DEFAULT_BINDING_TYPE } from "./executor-bindings-repo.js";
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
import {
  originalChangeDispatchedTarget,
  resolveWaveTargetOriginDomains,
  type WaveTargetObservedState
} from "./wave-targets-repo.js";
import { OBSERVED_WEIGHT_FRESHNESS_MS } from "./stage-dependency-hold.js";
import { ensureFederationSelf } from "../federation/self-repo.js";
import { resolveWaveTargetChecks } from "./wave-target-checks.js";
import {
  classifyPeerObservationFreshness,
  listPeerObservationsForChanges,
  type PeerObservationRow
} from "../federation/peer-observations-repo.js";

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
  let topologyName: string | null = null;
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
    topologyName = topology.name;
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

  // A freshly compiled plan has triggered nothing yet, so every target is `bound` or `unbound` —
  // still worth resolving so the FIRST response after propose already shows a real provider,
  // exactly like a subsequent `explain` would (`resolveWaveTargetExecutors` handles both cases;
  // here every row happens to have a null `executorPluginId`).
  const executors = await resolveWaveTargetExecutors(tx, input.orgId, targetRows);
  // Same reasoning for freshness: every row is unobserved, so this is `never` (self) or, for an
  // elsewhere-driven target, `not_reported` until a peer observation arrives — from the first
  // response onward, never absent.
  const freshness = await resolveWaveTargetFreshness(
    tx,
    input.orgId,
    input.changeObjectId,
    targetRows
  );
  // Same reasoning again for the checks rail: on a freshly compiled plan every declared hook is
  // `not_run` / `bake_not_started` and every undeclared kind is an empty slot, which is a real and
  // useful first answer — "these four checks exist, none has been reached". Resolving it here keeps
  // the propose response and every later `explain` the same shape.
  const checks = await resolveWaveTargetChecks(tx, input.orgId, {
    changeObjectId: input.changeObjectId,
    waves: waveRows,
    targets: targetRows
  });
  return toChangePlanShape(
    planRow,
    waveRows,
    targetRows,
    undefined,
    undefined,
    undefined,
    topologyName,
    executors,
    freshness,
    checks
  );
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
  hold?: WaveTargetHold,
  executor?: ChangeWaveTarget["executor"],
  observedFreshness?: ChangeWaveTarget["observedFreshness"],
  checks?: ChangeWaveTarget["checks"]
): ChangeWaveTarget {
  const waveTargetType = (row.type as ExecutorType | null) ?? "configuration";
  return {
    id: row.id,
    waveId: row.waveId,
    targetObjectId: row.targetObjectId,
    type: waveTargetType,
    category: categoryOfType(waveTargetType),
    executorPluginId: row.executorPluginId,
    ...(executor ? { executor } : {}),
    executorRef: (row.executorRef as Record<string, unknown> | null) ?? null,
    // The snapshot reconcile persisted. See docs/coordination.md §697. Reuses
    // `WaveTargetObservedState` directly (rather than a second, hand-duplicated shape) so a field
    // added there — `plan` (pipeline-mockup-data.md §6) — reaches this response with no separate
    // edit here to forget.
    observed: (row.observedState as WaveTargetObservedState | null) ?? null,
    ...(hold ? { hold } : {}),
    ...(observedFreshness ? { observedFreshness } : {}),
    // ABSENT means the CALLER did not resolve it — reconcile's `withFreezeHolds: false` read, which
    // never reaches a response. It never means "no check is declared": that is `slots[].hooks: []`.
    ...(checks ? { checks } : {}),
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
  continuousHolds?: Map<string, ContinuousHoldTargetVerdict>,
  /** `objects.name` of `plan.topologyObjectId`, resolved once by the caller. `undefined` when the
   *  caller did not resolve it (never asked); `null` is a real "no name" (no topology, or dangling). */
  topologyName?: string | null,
  /** Each wave target's provider basis, keyed by ITS OWN row id (`resolveWaveTargetExecutors`). */
  executors?: Map<string, ChangeWaveTarget["executor"]>,
  /** Each wave target's `observedFreshness`, keyed by ITS OWN row id
   *  (`resolveWaveTargetFreshness`). */
  freshness?: Map<string, ChangeWaveTarget["observedFreshness"]>,
  /** Each wave target's `checks` rail, keyed by ITS OWN row id (`resolveWaveTargetChecks`).
   *  `undefined` when the caller did not resolve it — see `toChangeWaveTargetShape`. */
  checks?: Map<string, ChangeWaveTarget["checks"]>
): ChangePlan {
  return {
    id: plan.id,
    changeObjectId: plan.changeObjectId,
    topologyObjectId: plan.topologyObjectId,
    topologyVersion: plan.topologyVersion,
    status: plan.status,
    createdAt: plan.createdAt.toISOString(),
    ...(topologyName !== undefined ? { topologyName } : {}),
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
          // `ChangeWaveEntry`'s `previous_wave` half (D1, pipeline-mockup-data.md §4/§9): a wave
          // with an actual predecessor reports how much of it is DONE — the same
          // succeeded-or-skipped reading `activeWaveOf` treats as "past" a wave. The `coupled_changes`
          // half needs `waitStatus`, which this function does not have; `routes/changes.ts`'s explain
          // handler appends it to wave 0 as a second half, the same split `heldTargetCount` already
          // uses (see `docs/routes.md §73`).
          const previousWave = waves.find((x) => x.waveIndex === w.waveIndex - 1);
          const entry: ChangeWaveEntry[] | undefined = previousWave
            ? [
                {
                  kind: "previous_wave",
                  satisfiedCount: targets.filter(
                    (t) =>
                      t.waveId === previousWave.id &&
                      (t.status === "succeeded" || t.status === "skipped")
                  ).length,
                  requiredCount: targets.filter((t) => t.waveId === previousWave.id).length
                }
              ]
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
            ...(entry !== undefined ? { entry } : {}),
            targets: waveTargets.map((t) =>
              toChangeWaveTargetShape(
                t,
                composeWaveTargetHold(
                  toWaveTargetHold(freezeHolds?.get(t.targetObjectId), scopeNames ?? new Map()),
                  continuousHolds?.get(t.targetObjectId)
                ),
                executors?.get(t.id),
                freshness?.get(t.id),
                checks?.get(t.id)
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

/** `ChangePlanSchema.topologyName` — `objects.name` of `topologyObjectId`, or `null` when there is
 *  no topology to name (no id) or its object no longer resolves (dangling / deleted). See
 *  docs/proposals/pipeline-mockup-data.md §2. */
export async function topologyNameOf(
  tx: TenantTx,
  orgId: string,
  topologyObjectId: string | null
): Promise<string | null> {
  if (!topologyObjectId) return null;
  const row = await tx.query.objects.findFirst({
    where: (t, { eq: eqOp, and: andOp, isNull: isNullOp }) =>
      andOp(eqOp(t.id, topologyObjectId), eqOp(t.orgId, orgId), isNullOp(t.deletedAt))
  });
  return row?.name ?? null;
}

/** `ChangeWaveTargetSchema.executor` — the `<Type> · <provider>` subtitle's provider half, for
 *  every row in `targets`. See docs/proposals/pipeline-mockup-data.md §2.
 *
 *  Two disjoint groups, by whether the row has already been triggered:
 *  - `executorPluginId` set: the trigger already picked a plugin INSTANCE. Batch-joined to
 *    `executor_bindings.plugin_instance_id` for its `plugin_module` — one query for every distinct
 *    instance id across the whole plan.
 *  - `executorPluginId` null: not triggered yet. Resolved through the SAME ladder the reconciler
 *    and `component-pipeline.ts` use (`resolveBindingForTarget`), deduped by `(targetObjectId,
 *    type)` since several wave-target rows can share both. This is what lets a PRE-TRIGGER target
 *    still show a real provider, not a guess: the binding that would be used if triggered now. */
export async function resolveWaveTargetExecutors(
  tx: TenantTx,
  orgId: string,
  targets: (typeof changeWaveTargets.$inferSelect)[]
): Promise<Map<string, ChangeWaveTarget["executor"]>> {
  const result = new Map<string, ChangeWaveTarget["executor"]>();

  const triggered = targets.filter(
    (t): t is typeof t & { executorPluginId: string } => t.executorPluginId !== null
  );
  const instanceIds = [...new Set(triggered.map((t) => t.executorPluginId))];
  const moduleByInstanceId = new Map<string, string>();
  if (instanceIds.length > 0) {
    const rows = await tx
      .select({
        pluginInstanceId: executorBindings.pluginInstanceId,
        pluginModule: executorBindings.pluginModule
      })
      .from(executorBindings)
      .where(
        and(
          eq(executorBindings.orgId, orgId),
          inArray(executorBindings.pluginInstanceId, instanceIds)
        )
      );
    for (const row of rows) {
      if (!moduleByInstanceId.has(row.pluginInstanceId)) {
        moduleByInstanceId.set(row.pluginInstanceId, row.pluginModule);
      }
    }
  }
  for (const t of triggered) {
    const pluginModule = moduleByInstanceId.get(t.executorPluginId);
    result.set(t.id, pluginModule ? { basis: "triggered", pluginModule } : { basis: "unbound" });
  }

  const pending = targets.filter((t) => t.executorPluginId === null);
  const ladderCache = new Map<string, ChangeWaveTarget["executor"]>();
  for (const t of pending) {
    const type = (t.type as ExecutorType | null) ?? DEFAULT_BINDING_TYPE;
    const key = `${t.targetObjectId}:${type}`;
    let outcome = ladderCache.get(key);
    if (!outcome) {
      const resolution = await resolveBindingForTarget(tx, orgId, t.targetObjectId, type);
      outcome = resolution.binding
        ? { basis: "bound", pluginModule: resolution.binding.pluginModule }
        : { basis: "unbound" };
      ladderCache.set(key, outcome);
    }
    result.set(t.id, outcome);
  }

  return result;
}

/** `ChangeWaveTargetSchema.observedFreshness`, for every row in `targets`. See
 *  docs/proposals/pipeline-mockup-data.md §5.1.
 *
 *  ONE domain check, ONE staleness bound — never a second copy of either:
 *  - **Domain.** `resolveWaveTargetOriginDomains` above, mirroring `component-pipeline.ts`'s
 *    `outpostOf`. Not this instance's own domain -> the target executes at another domain instance,
 *    and this instance's reconcile loop never polls status() for it directly — but that is no
 *    longer the end of the story (increment 6, PR #374): a `wave_target_observed` (subject
 *    `target`) journal entry now really does federate the executing domain's own reading up here,
 *    exactly as `wave-target-checks.ts`'s `evidenceOrigin` (PR #386) reads for the `hook_run`
 *    subject of the SAME kind. `not_reported` is therefore no longer inferred from topology alone —
 *    it means no such entry has ARRIVED, checked below against `listPeerObservationsForChanges`,
 *    never merely "this instance does not drive it". `never` stays reserved for a locally-driven
 *    target with no reading yet, because only that case promises a reading might still arrive from
 *    OUR OWN observation loop.
 *  - **Staleness.** `OBSERVED_WEIGHT_FRESHNESS_MS` (`stage-dependency-hold.ts`), applied to the
 *    reading's OWN stamped `observed_state.observedAt` (`observedStateForRow`) for a locally-driven
 *    target — never `lastObservedAt`, the row-level column that also moves on transitions the
 *    observed-state payload itself did not touch. For an elsewhere-driven target, the identical
 *    bound is shared via `classifyPeerObservationFreshness`'s default
 *    (`PEER_OBSERVATION_FRESHNESS_MS === OBSERVED_WEIGHT_FRESHNESS_MS`), applied to the ARRIVED
 *    observation's own `observedAt` — never `receivedAt`, for the same reason. */
export async function resolveWaveTargetFreshness(
  tx: TenantTx,
  orgId: string,
  changeObjectId: string,
  targets: (typeof changeWaveTargets.$inferSelect)[],
  now: Date = new Date()
): Promise<Map<string, ChangeWaveTarget["observedFreshness"]>> {
  const result = new Map<string, ChangeWaveTarget["observedFreshness"]>();
  if (targets.length === 0) return result;

  const self = await ensureFederationSelf(tx, orgId);
  const targetObjectIds = [...new Set(targets.map((t) => t.targetObjectId))];
  const originByObjectId = await resolveWaveTargetOriginDomains(tx, orgId, targetObjectIds);
  const isDrivenElsewhere = (targetObjectId: string): boolean => {
    const origin = originByObjectId.get(targetObjectId);
    // Unresolved (a dangling/deleted target object) reads the same as "not ours" — never a claim
    // this instance will ever observe it.
    return origin === undefined || origin !== self.domainId;
  };

  // ONE peer-observation read for the whole change, skipped entirely unless at least one target
  // needs it — the same inertness gate `wave-target-checks.ts`'s `evidenceOrigin` follows for the
  // `hook_run` half of this same journal kind. No `peerDomainId` filter against the target's own
  // origin domain, deliberately: `evidenceOrigin` (PR #386) does not filter by it either (a
  // `hook_run` observation is accepted from whichever peer signed it), and the two markers reading
  // the same kind by two different rules would let the rail and the rollout badge disagree about
  // one arrived entry.
  const anyElsewhere = targets.some((t) => isDrivenElsewhere(t.targetObjectId));
  const peerTargetRows: PeerObservationRow[] = anyElsewhere
    ? (
        (await listPeerObservationsForChanges(tx, orgId, [changeObjectId])).get(changeObjectId) ??
        []
      ).filter((r) => r.subject === "target")
    : [];

  for (const t of targets) {
    if (isDrivenElsewhere(t.targetObjectId)) {
      const relevant = peerTargetRows.filter((r) => r.targetObjectId === t.targetObjectId);
      if (relevant.length === 0) {
        result.set(t.id, { state: "not_reported" });
      } else {
        const newest = relevant.reduce((a, b) => (a.observedAt > b.observedAt ? a : b));
        result.set(t.id, classifyPeerObservationFreshness(newest.observedAt, now));
      }
      continue;
    }
    const observed = t.observedState as WaveTargetObservedState | null;
    const observedAt = observed === null ? undefined : Date.parse(observed.observedAt ?? "");
    // No reading at all, OR a reading with no reliable date (a row written before `observedAt`
    // existed — deliberately not backfilled, `stage-dependency-hold.ts`'s `not_observed` cause):
    // both read as "never", because neither lets this field state an age it can stand behind.
    if (observed === null || observedAt === undefined || Number.isNaN(observedAt)) {
      result.set(t.id, { state: "never" });
      continue;
    }
    const ageSeconds = Math.max(0, Math.round((now.getTime() - observedAt) / 1000));
    if (now.getTime() - observedAt > OBSERVED_WEIGHT_FRESHNESS_MS) {
      result.set(t.id, {
        state: "stale",
        ageSeconds,
        staleAfterSeconds: Math.round(OBSERVED_WEIGHT_FRESHNESS_MS / 1000)
      });
    } else {
      result.set(t.id, { state: "fresh", ageSeconds });
    }
  }
  return result;
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

  const topologyName = await topologyNameOf(tx, orgId, planRow.topologyObjectId);
  const executors = await resolveWaveTargetExecutors(tx, orgId, targetRows);
  const freshness = await resolveWaveTargetFreshness(tx, orgId, changeObjectId, targetRows);

  if (options?.withFreezeHolds === false) {
    // NO CHECKS RAIL ON THIS PATH, deliberately, and for the same reason neither hold half is
    // resolved here: this is reconcile's per-tick internal read (`reconcile.ts`'s
    // `withFreezeHolds: false`), it never becomes a response, and the rail costs a per-(target,hook)
    // evidence read for every declared `continuous`/`bakeAlarms` hook.
    return toChangePlanShape(
      planRow,
      waveRows,
      targetRows,
      undefined,
      undefined,
      undefined,
      topologyName,
      executors,
      freshness
    );
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
  // THE SAME RE-DERIVE-ON-EVERY-READ RULE the two hold halves follow (see the comment above them):
  // the gate's Decision rows have no clearing counterpart, so a `checks` field fed from one would
  // still say "failed" after a rerun went green.
  const checks = await resolveWaveTargetChecks(tx, orgId, {
    changeObjectId,
    waves: waveRows,
    targets: targetRows
  });

  return toChangePlanShape(
    planRow,
    waveRows,
    targetRows,
    freezeHolds,
    scopeNames,
    continuousHolds,
    topologyName,
    executors,
    freshness,
    checks
  );
}
