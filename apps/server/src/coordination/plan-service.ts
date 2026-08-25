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
import { rollbackExemptible } from "../governance/freeze-scope.js";
import { originalChangeDispatchedTarget } from "./wave-targets-repo.js";

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
    // LIVE-FILTERED, the same call `pipeline-resolution.ts`'s `attachedTopology` already makes on the
    // INHERITED path, whose comment states the rule outright: "a change must not be born pointing at
    // a tombstone." This is the EXPLICIT path — a `topologyObjectId` passed in by the caller — and it
    // was the half that skipped the check, so a soft-deleted release-topology was still loaded,
    // snapshotted into `change_plans.topology_document`, and left to determine the entire wave shape
    // of the release. Two doors into one decision, one of them unguarded.
    //
    // Refusing is safe here in a way it is not at trigger time: this runs on the
    // `evaluated -> coordinated` edge, so nothing has been dispatched yet and the 404 lands on the
    // transition rather than mid-flight.
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

/** Wire shape of `ChangeWaveTargetSchema.hold` — see that schema's doc for the four properties it
 *  satisfies. Built by `toWaveTargetHold` below from a live `FreezeHoldVerdict`, never persisted.
 *  EXPORTED: `CampaignWaveTargetSchema.hold` mirrors this shape exactly (freeze-only, since a
 *  campaign wave target has no stage-dependency half), and `campaign-plan-service.ts` builds it
 *  with the SAME `toWaveTargetHold` function below rather than a parallel reimplementation. */
export type WaveTargetHold = NonNullable<ChangeWaveTarget["hold"]>;

/** `FreezeHoldVerdict` -> the wire `hold` shape (or `undefined` for an unheld target) — the ONE
 *  place a `FreezeHoldVerdict` becomes API surface, so the freeze-projection idiom
 *  (`describeFreezeForWaveTarget`) is applied exactly once. `scopeNames` is the caller's one-query
 *  resolution of every covering freeze's `scopeObjectId` (`resolveFreezeScopeNames` below) —
 *  passed in rather than re-queried per target. EXPORTED for `campaign-plan-service.ts`, which
 *  reuses this exact function for `CampaignWaveTargetSchema.hold` rather than re-deriving the wire
 *  shape from a `FreezeHoldVerdict` a second time. */
export function toWaveTargetHold(
  verdict: FreezeHoldVerdict | undefined,
  scopeNames: Map<string, string>
): WaveTargetHold | undefined {
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
    // The snapshot reconcile persisted — the per-wave version (revision + deployed images) plus the
    // OBSERVE-ONLY rollout snapshot (P4D). The raw jsonb already carries all three once merged (P4B
    // revision + P4C images + P4D rollout); no query change.
    // `truncation` (M23.1g) rides the same jsonb: `updateWaveTargetObserved` stamps it beside the
    // bounded value, so it arrives here with no query change, exactly as `images` and `rollout`
    // did. It is NAMED in this cast for the same reason the others are — the response serializer
    // key-strips whatever `ChangeWaveTargetSchema.observed` does not declare, which is how
    // `observedAt` stays internal, and a field left out of the cast would be a field the API
    // silently drops.
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

/**
 * `freezeHolds` is OPTIONAL: `compileAndPersistPlan` (below) never passes it, because a plan is
 * only ever compiled on the `evaluated -> coordinated` edge — the change cannot be `executing`
 * yet, so `resolveWaveTargetFreezeHolds`'s own gate would return an empty map regardless, and
 * skipping the call there skips a query that could only ever come back empty. `getLatestPlanForChange`
 * (the GET read path) always computes and passes it. `heldTargetCount` is then emitted ONLY for
 * the wave admission currently governs (`activeWaveOf` — the same selector the evaluation itself
 * uses, so "which wave was evaluated" and "which wave carries the count" cannot drift): the
 * evaluation never looks at any other wave, and emitting `0` for an unevaluated future wave would
 * claim "evaluated, nothing held" about targets a standing freeze may well cover when their turn
 * comes (`ChangeWaveSchema.heldTargetCount`'s absent-vs-zero rule; M25.UI review minor finding 4).
 */
/** THE ONE WAVE ADMISSION CURRENTLY GOVERNS — first wave not yet terminal. Shared by
 *  `resolveWaveTargetFreezeHolds` (which only ever evaluates THIS wave's targets) and
 *  `toChangePlanShape`'s `heldTargetCount` emission, so the two cannot disagree about which wave
 *  that is. EXPORTED: `campaign-plan-service.ts`'s `resolveActiveCampaignWaveFreezeHolds` uses the
 *  SAME selector over campaign waves (structurally compatible — both a raw `campaign_waves` row
 *  and the wire `CampaignWave` shape carry a bare `status` string), so "which wave admission
 *  governs" cannot drift between the change and campaign sides. */
export function activeWaveOf<W extends { status: string }>(waves: W[]): W | undefined {
  return waves.find((w) => w.status !== "succeeded" && w.status !== "skipped");
}
function toChangePlanShape(
  plan: typeof changePlans.$inferSelect,
  waves: (typeof changeWaves.$inferSelect)[],
  targets: (typeof changeWaveTargets.$inferSelect)[],
  freezeHolds?: Map<string, FreezeHoldVerdict>,
  scopeNames?: Map<string, string>
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
          // Freeze-held count only, here — the stage-dependency half of `heldTargetCount` is added
          // by `routes/changes.ts`'s explain handler, which is the one caller that also computes
          // `stageDependencyStatus` (see that field's doc for why the two halves live apart).
          // ACTIVE WAVE ONLY: the evaluation never looks at any other wave, so any other wave's
          // count would be a fabricated zero (absent = not evaluated; see the schema doc).
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
                toWaveTargetHold(freezeHolds?.get(t.targetObjectId), scopeNames ?? new Map())
              )
            )
          };
        });
    })()
  };
}

/**
 * THE READ-TIME HALF OF THE WAVE-TARGET FREEZE-HOLD PROJECTION — reuses `evaluateFreezeHolds`
 * (`freeze-hold.ts`), the SAME predicate `reconcile.ts`'s engine loop consults, rather than a
 * second implementation that could drift from admission (campaigns-rework.md's instruction on
 * this exact field).
 *
 * ONLY THE TARGETS THE HOLD CAN STILL ACT ON ARE *RETURNED*, mirroring `stage-dependency-status.ts`'s
 * own gate exactly (`isStillTriggerable` there, restated here): the active (non-terminal) wave's
 * `pending`/`triggering` targets, and only while the change itself is `executing` — a `triggered`
 * target has already been handed to its executor (a freeze cannot un-ring that bell — ADR-0008
 * has no pause verb), and a hold reported against a dead change's never-run target would describe
 * a wait that is already over. Two changes reading the identical gate independently is exactly
 * the drift class `stage-dependency-status.ts`'s own doc warns about, restated for a second field.
 *
 * BUT `evaluateFreezeHolds` IS ASKED ABOUT EVERY ACTIVE-WAVE TARGET, not just the pending ones
 * (M25.UI review finding 2 — "atomic drift"). `reconcile.ts`'s admission loop asks the identical
 * question with `activeWave.targets.map((t) => t.targetObjectId)` (reconcile.ts, `loadFreezeHolds`)
 * — every target of the active wave, succeeded siblings included. That matters because an `atomic`
 * freeze's union (`freeze-hold.ts`'s `unionFreezes(byTarget)`) only ever sees the ids it was asked
 * about: if this function asked only about the pending subset, a target held SOLELY because an
 * `atomic` freeze covers an already-succeeded sibling would never surface here — the sibling that
 * proves the union was never even queried. Asking about the full set and filtering the RESULT to
 * the pending subset keeps the answer identical to what admission would do, while still never
 * reporting a hold against a target a hold can no longer act on.
 */
async function resolveWaveTargetFreezeHolds(
  tx: TenantTx,
  orgId: string,
  changeObjectId: string,
  waves: (typeof changeWaves.$inferSelect)[],
  targets: (typeof changeWaveTargets.$inferSelect)[]
): Promise<Map<string, FreezeHoldVerdict>> {
  const [changeRow] = await tx
    .select({ state: changes.state, rollbackOfObjectId: changes.rollbackOfObjectId })
    .from(changes)
    .where(and(eq(changes.orgId, orgId), eq(changes.objectId, changeObjectId)))
    .limit(1);
  if (changeRow?.state !== "executing") return new Map();

  const activeWave = activeWaveOf(waves);
  if (!activeWave) return new Map();

  const activeWaveTargets = targets.filter((t) => t.waveId === activeWave.id);
  const pendingTargetIds = new Set(
    activeWaveTargets
      .filter((t) => t.status === "pending" || t.status === "triggering")
      .map((t) => t.targetObjectId)
  );
  if (pendingTargetIds.size === 0) return new Map();

  const allHolds = await evaluateFreezeHolds(tx, {
    orgId,
    targetObjectIds: activeWaveTargets.map((t) => t.targetObjectId)
  });

  // D7'S ROLLBACK EXEMPTION, MIRRORED (M25.UI review finding 3). `reconcile.ts`'s actuator
  // (`!( rollbackExemptible(frozen.freezes) && rollbackHasSomethingToUndoAt(...) )`) lets a
  // rollback's trigger through an org-tier freeze for a target the original change actually
  // dispatched. Without the same check here, `explain` reports that target `held` by the very
  // freeze reconcile has already stepped around — a target sitting in `triggering` backoff after
  // a real dispatch, described as still waiting on a freeze it was exempted from.
  const isRollback = changeRow.rollbackOfObjectId !== null;
  const rollbackOfObjectId = changeRow.rollbackOfObjectId;

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

/** Display names for every covering freeze's `scopeObjectId`, in ONE query — the same
 *  "resolve every id this response mentions, in one indexed IN()" idiom
 *  `stage-dependency-status.ts`'s `resolveNames` uses. Ids that resolve to nothing (a deleted
 *  scope object) are simply absent, and `toWaveTargetHold` renders `name: null` — never the id
 *  dressed up as a name. */
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
  /**
   * `withFreezeHolds: false` (M25.UI review finding 4) skips `resolveWaveTargetFreezeHolds` and
   * `resolveFreezeScopeNames` entirely, for a caller that only needs wave/target *status* data and
   * never reads `.hold`/`heldTargetCount` off the result. `reconcile.ts`'s per-tick trigger branch
   * is the one that matters: `advanceExecutingChanges` calls this UNCONDITIONALLY, once per
   * `executing` change per 1 s tick, to find the active wave — and its OWN trigger branch already
   * does a second, real freeze evaluation a few lines later (`loadFreezeHolds`, lazily, only when a
   * target is actually pending). Leaving the default true here meant every such tick paid for a
   * FULL freeze evaluation whose `ChangePlan.hold`/`heldTargetCount` shape reconcile then threw
   * away unread, immediately followed by `loadFreezeHolds` redoing the identical work for the
   * decision that actually acts on it — silently falsifying the "resolved lazily, inside the
   * trigger branch" invariant documented beside `loadFreezeHolds` itself. Default stays `true`
   * because every OTHER caller (`routes/changes.ts`'s explain handler) is a wire consumer that
   * needs the projection.
   */
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

  const freezeHolds = await resolveWaveTargetFreezeHolds(
    tx,
    orgId,
    changeObjectId,
    waveRows,
    targetRows
  );
  const scopeNames = await resolveFreezeScopeNames(tx, orgId, freezeHolds);

  return toChangePlanShape(planRow, waveRows, targetRows, freezeHolds, scopeNames);
}
