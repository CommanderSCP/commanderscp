import { and, eq, inArray, isNull } from "drizzle-orm";
import type {
  ChangePlan,
  ChangeStageDependencyStatus,
  ChangeStageDependencyTarget,
  ChangeStageDependencyVerdict
} from "@scp/schemas";
import { objects } from "../db/schema.js";
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
    for (const verdict of entry.evaluation.verdicts) ids.add(verdict.dependsOn);
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
