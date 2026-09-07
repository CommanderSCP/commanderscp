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

/** The read side of the hold, and the only one. See docs/coordination.md §962. */
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

  // ONLY THE TARGETS THE HOLD CAN STILL ACT ON. See docs/coordination.md §963.
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

/** A hold is only real while the engine would still trigger. See docs/coordination.md §964. */
function isStillTriggerable(state: string | undefined): boolean {
  return state === "executing";
}

/** What a change that IS coupled but is past. See docs/coordination.md §965. */
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

/** A `dependsOn` that is actually an object id. See docs/coordination.md §966. */
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

/** The stage-dependency status as one operator sentence. See docs/coordination.md §967. */
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
