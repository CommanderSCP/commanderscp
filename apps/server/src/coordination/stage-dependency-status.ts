import { and, eq, inArray, isNull } from "drizzle-orm";
import type {
  ChangePlan,
  ChangeStageDependencyStatus,
  ChangeStageDependencyTarget,
  ChangeStageDependencyVerdict
} from "@scp/schemas";
import { changes, objects } from "../db/schema.js";
import type { TenantTx } from "../db/tenant-tx.js";
import { stageDependenciesOf, targetObjectIdsOf } from "./changes-repo.js";
import { getLatestPlanForChange, loadDependsOnEdges } from "./plan-service.js";
import {
  describeStageDependencyHold,
  evaluateStageDependencies,
  type StageDependencyVerdict
} from "./stage-dependency-hold.js";

/**
 * ADR-0028 increment 4 — THE READ SIDE OF THE HOLD, and the ONLY one.
 *
 * THREE callers, one predicate: `explain` (routes/changes.ts), the watchdog's `executing` stall arm,
 * and the component-pipeline projection's per-stage `hold` (component-pipeline.ts). All three need
 * the same answer — *which dependency is withholding this change's trigger, at which place, and why*
 * — and they get it from this one function. Two copies would be two predicates, and the second would
 * drift the moment a branch was added: the whole point of ADR-0028 decision 4 is that the branches
 * are DISTINGUISHABLE, which is a property a second implementation cannot inherit.
 *
 * LIVE, NOT OFF THE PINNED DECISION. `recordStageDependencyHold` persists a `hold` Decision and
 * NOTHING anywhere writes a clearing row when the hold releases. So the newest `stage_dependency` row
 * of a change that was briefly held, triggered, succeeded and reached `accepted` is STILL a `hold`,
 * forever. A read surface that answered "is this held?" from that row would rebuild exactly the
 * permanent-marker bug the `hold` verdict (rather than `block`) was chosen to avoid —
 * `reconcile.ts`'s `recordStageDependencyHold` doc spells that trap out at length. Worse here than
 * there, because the surface would be the one an operator consults FIRST.
 *
 * The kind is overloaded too, which is the same trap wearing a second hat: `applyPromotionImport`
 * writes `kind: "stage_dependency", verdict: "allow"` against the same subject to record the
 * import-time strip, so on an outpost the LATEST row of that kind is an `allow` for a change that may
 * well be held. Neither row is the answer. The answer is the predicate, re-run.
 *
 * INERT WHEN NOTHING IS COUPLED, structurally: the declaration parse is in memory, the edge query is
 * skipped for the single-target change (277 of 281 measured — ADR-0026), and this returns `null`
 * before touching the plan when there is nothing to evaluate. An uncoupled change's `explain` costs
 * one property read it was already doing.
 *
 * NOTHING HERE PERSISTS ANYTHING (ADR-0024). `evaluateStageDependencies` is read-only by contract —
 * "takes a `TenantTx` and reads only; the caller decides what to persist" — and this caller persists
 * nothing at all. Stamping a `held` flag anywhere so a projection could read it back cheaply would be
 * one write per held target per 1 s tick: the 1.44 GB/day write amplification relocated to another
 * table.
 *
 * THE LIVE-STATE GATE IS IN HERE, not at the call sites, and that placement is the fix for a real
 * defect rather than tidying. The first version of this module left the gate to the caller;
 * `component-pipeline.ts` applied one and the other two callers did not, so `explain` — and
 * therefore `scp change explain` and `scp change wait-status` — reported `held: true` FOREVER for a
 * CANCELLED change. That is the permanent-marker trap the module doc above is entirely about,
 * arrived at from the other direction: not a stale row, but a live predicate run against a change
 * nothing will ever act on. A gate a caller has to remember is a gate the next caller forgets, so it
 * lives at the one place all of them pass through. See `isStillTriggerable` below for the predicate.
 */
export async function resolveStageDependencyStatus(
  tx: TenantTx,
  orgId: string,
  change: { objectId: string; properties: Record<string, unknown> | null | undefined },
  /** The change's latest plan when the caller already holds it — `explain` loads it anyway, and
   *  passing it keeps this from re-issuing the plan's three queries. `null` means "loaded, and there
   *  is none"; OMITTING it means "load it yourself", which the watchdog does so the load happens
   *  only AFTER the inert check below has decided the change is coupled at all. */
  plan?: ChangePlan | null
): Promise<ChangeStageDependencyStatus | null> {
  const declared = stageDependenciesOf(change.properties);
  const changeTargets = targetObjectIdsOf(change.properties);
  // The same set, loaded the same way, with the same `< 2` guard reconcile's `loadInTargetSetEdges`
  // uses: both endpoints must be in the target set, so one target can only produce a self-edge, which
  // orders nothing (`evaluateStageDependencies` drops `e.to === componentObjectId` anyway).
  const edgeDependencies =
    changeTargets.length < 2 ? [] : await loadDependsOnEdges(tx, orgId, changeTargets);

  if (
    declared.stageDependencies.length === 0 &&
    declared.malformed.length === 0 &&
    edgeDependencies.length === 0
  ) {
    return null;
  }

  // THE LIVE-STATE GATE. Read here rather than taken from the caller: a parameter is a thing a
  // caller can pass wrongly or a future caller can forget, and forgetting it is precisely the bug
  // this replaces. One indexed lookup, and only for a change that actually coupled something.
  const [changeRow] = await tx
    .select({ state: changes.state })
    .from(changes)
    .where(and(eq(changes.orgId, orgId), eq(changes.objectId, change.objectId)))
    .limit(1);
  if (!isStillTriggerable(changeRow?.state)) return nothingAwaitingATrigger();

  const resolvedPlan =
    plan === undefined ? await getLatestPlanForChange(tx, orgId, change.objectId) : plan;
  // The wave reconcile is working — its own selector, verbatim (`reconcile.ts`'s `activeWave`), so
  // this cannot report on a different wave than the one the hold is being applied to.
  const activeWave = resolvedPlan?.waves.find(
    (wave) => wave.status !== "succeeded" && wave.status !== "skipped"
  );

  // ONLY THE TARGETS THE HOLD CAN STILL ACT ON. Reconcile evaluates the coupling in the TRIGGER
  // branch alone — a `triggered`/`observing` target has already been handed to its executor and a
  // hold cannot un-ring that bell, so reporting a verdict for one would describe a wait that is over.
  // `triggering` is included for the same reason reconcile includes it: it is the state a crash
  // mid-claim leaves behind, and such a target is re-offered to the hold on the next tick.
  const pending = (activeWave?.targets ?? []).filter(
    (target) => target.status === "pending" || target.status === "triggering"
  );

  const evaluated: {
    targetObjectId: string;
    evaluation: Awaited<ReturnType<typeof evaluateStageDependencies>>;
  }[] = [];
  for (const target of pending) {
    evaluated.push({
      targetObjectId: target.targetObjectId,
      evaluation: await evaluateStageDependencies(tx, {
        orgId,
        waveTargetObjectId: target.targetObjectId,
        stageDependencies: declared.stageDependencies,
        malformed: declared.malformed,
        edgeDependencies
      })
    });
  }

  const nameById = await resolveNames(tx, orgId, evaluated);

  const targets: ChangeStageDependencyTarget[] = evaluated.map((entry) => ({
    targetObjectId: entry.targetObjectId,
    targetName: nameById.get(entry.targetObjectId) ?? null,
    componentObjectId: entry.evaluation.stage?.componentObjectId ?? null,
    componentName: entry.evaluation.stage
      ? (nameById.get(entry.evaluation.stage.componentObjectId) ?? null)
      : null,
    deploymentTargetObjectId: entry.evaluation.stage?.deploymentTargetObjectId ?? null,
    deploymentTargetName: entry.evaluation.stage
      ? (nameById.get(entry.evaluation.stage.deploymentTargetObjectId) ?? null)
      : null,
    held: entry.evaluation.held,
    dependencies: entry.evaluation.verdicts.map((verdict) => toWireVerdict(verdict, nameById))
  }));

  return {
    held: targets.some((target) => target.held),
    waveIndex: activeWave?.waveIndex ?? null,
    unenforced: targets.some((target) =>
      target.dependencies.some((dependency) => dependency.branch === "unscopeable")
    ),
    targets
  };
}

/**
 * A HOLD IS ONLY REAL WHILE THE ENGINE WOULD STILL TRIGGER THE TARGET, and exactly one change state
 * satisfies that: `executing`. `reconcile.ts` evaluates the coupling in ONE place —
 * `advanceExecutingChanges`, whose selector is `listChangeRowsInStates(tx, orgId, ["executing"], …)`
 * — inside the branch that decides whether to call `triggerWaveTarget`. No other state reaches it.
 *
 * So for every other state the honest answer is "no wave target is awaiting a trigger", and it is
 * NOT the same as "held: false because the dependencies are satisfied". A cancelled or failed
 * change's active wave is the dead one; its never-run `pending` targets each still evaluate to a
 * hold, because the dependency genuinely never deployed and nothing about that verdict knows the
 * release was abandoned. Reporting it would tell an operator a corpse is waiting for something.
 *
 * The two states it is tempting to include, and why they are not:
 *   - `coordinated` — the plan exists and its targets are `pending`, but the hold has not been
 *     applied to them yet and the change may still be blocked before it ever gets there. A verdict
 *     here would be a forecast, and this surface's whole claim is that it reports what IS.
 *   - `waiting` — parked on a CROSS-CHANGE `requires` prerequisite (a different mechanism entirely,
 *     `coupling.ts`). Its targets are not being withheld by a stage dependency; they are not being
 *     considered at all. `waitStatus` is the field that answers for that change.
 *
 * The value is deliberately a `state`, not "does a plan exist" or "is the wave running": those are
 * derived facts that can be true of a dead change, and the state column is the one the engine's own
 * selector reads.
 */
function isStillTriggerable(state: string | undefined): boolean {
  return state === "executing";
}

/** What a change that IS coupled but is past (or short of) the point of being triggered reports.
 *  NOT `null` — null is "this change coupled nothing at any stage", a different claim, and the CLI
 *  prints it as one. An empty `targets` renders as "no wave target is awaiting a trigger", which is
 *  the true statement about a cancelled release that declared a coupling.
 *
 *  A FUNCTION rather than a module constant, because a constant would hand every caller the SAME
 *  object (and the same `targets` array). Nothing mutates it today; a shared mutable reply on a
 *  read path is a bug waiting for the first caller that sorts its own copy in place. */
function nothingAwaitingATrigger(): ChangeStageDependencyStatus {
  return { held: false, waveIndex: null, unenforced: false, targets: [] };
}

/** The verdict as reconcile computed it, plus the two things a persisted Decision deliberately does
 *  NOT carry: display names (they would make the Decision's `inputContext` churn on a rename) and the
 *  rendered sentence (`reasonTree` carries it once, for the UNSATISFIED verdicts only). */
function toWireVerdict(
  verdict: StageDependencyVerdict,
  nameById: Map<string, string>
): ChangeStageDependencyVerdict {
  return {
    dependsOn: verdict.dependsOn,
    dependsOnName: nameById.get(verdict.dependsOn) ?? null,
    branch: verdict.branch,
    satisfied: verdict.satisfied,
    ...(verdict.source ? { source: verdict.source } : {}),
    ...(verdict.dependencyStatus === undefined
      ? {}
      : { dependencyStatus: verdict.dependencyStatus }),
    ...(verdict.minWeight === undefined ? {} : { minWeight: verdict.minWeight }),
    ...(verdict.minWeightSupersededByEdge ? { minWeightSupersededByEdge: true as const } : {}),
    ...(verdict.weightUnreadable === undefined
      ? {}
      : { weightUnreadable: verdict.weightUnreadable }),
    summary: describeStageDependencyHold(verdict)
  };
}

/** A `dependsOn` that is actually an object id. An `undeclarable` verdict's `dependsOn` is the raw
 *  stored entry rendered as JSON — `"not-a-stage-dependency-at-all"`, `{"dependsOn":42}` — because
 *  there was no parseable id to name, and the wire schema says so (`ChangeStageDependencyVerdict`'s
 *  `dependsOn` is deliberately NOT `.uuid()`). Postgres does not shrug at those: `id IN ('…')`
 *  against a `uuid` column RAISES `invalid input syntax for type uuid`, so a single malformed stored
 *  entry turned this whole read into a 500 — `GET /changes/{id}/explain`, `scp change explain` and
 *  `scp change wait-status` all of them, for exactly the change an operator is trying to diagnose.
 *  The comment below already said such ids "are simply absent"; the query it described had no way to
 *  make that true. Naming a hazard is not handling it. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Display names for every id this status mentions, in ONE query. Ids that resolve to nothing (a
 *  deleted component, an `undeclarable` entry's raw JSON) are simply absent, and the caller renders
 *  `null` — never the id dressed up as a name. */
async function resolveNames(
  tx: TenantTx,
  orgId: string,
  evaluated: {
    targetObjectId: string;
    evaluation: Awaited<ReturnType<typeof evaluateStageDependencies>>;
  }[]
): Promise<Map<string, string>> {
  const ids = new Set<string>();
  for (const entry of evaluated) {
    ids.add(entry.targetObjectId);
    if (entry.evaluation.stage) {
      ids.add(entry.evaluation.stage.componentObjectId);
      ids.add(entry.evaluation.stage.deploymentTargetObjectId);
    }
    for (const verdict of entry.evaluation.verdicts) {
      if (UUID.test(verdict.dependsOn)) ids.add(verdict.dependsOn);
    }
  }
  if (ids.size === 0) return new Map();
  const rows = await tx
    .select({ id: objects.id, name: objects.name })
    .from(objects)
    .where(and(eq(objects.orgId, orgId), inArray(objects.id, [...ids]), isNull(objects.deletedAt)));
  return new Map(rows.map((row) => [row.id, row.name]));
}

/**
 * The stage-dependency status as ONE operator sentence, for the watchdog's stall notice — `null`
 * when nothing is held, so a caller can tell "no coupling is involved" from "a coupling is, and here
 * it is" without inspecting the structure.
 *
 * Built from the SAME per-verdict `describeStageDependencyHold` the hold Decision's `reasonTree`
 * uses, with the place appended: the Decision names the deployment-target by id (it must stay
 * byte-stable), whereas a notification is read by a human who needs the name.
 */
export function describeStageDependencyStatus(status: ChangeStageDependencyStatus): string | null {
  const lines = status.targets.flatMap((target) =>
    target.dependencies
      .filter((dependency) => !dependency.satisfied)
      .map((dependency) => {
        const place =
          target.deploymentTargetName ??
          target.deploymentTargetObjectId ??
          "a target that resolves to no deployment-target";
        return `at ${place}: ${dependency.summary}`;
      })
  );
  if (lines.length === 0) return null;
  return `unsatisfied stage dependenc${lines.length === 1 ? "y" : "ies"} (ADR-0028): ${lines.join("; ")}`;
}
