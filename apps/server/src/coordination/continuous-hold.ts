import type { HookFreshnessContext } from "@scp/schemas";
import type { TenantTx } from "../db/tenant-tx.js";
import {
  latestTestRunEvidence,
  listHooksForComponents,
  orgDeclaresHookKind,
  resolveHookSubjects
} from "./pipeline-hooks-repo.js";
import {
  buildHookFreshnessContext,
  evaluateContinuousHold,
  type ContinuousHoldVerdict
} from "./pipeline-hook-verdicts.js";

/**
 * THE CONTINUOUS-TEST HOLD, PREDICATE HALF (team-pipeline-iac increment 8, D21).
 *
 * The guarantee, stated so it can be kept: *a wave target whose declared `continuous` probe has not
 * reported a fresh pass is not TRIGGERED, and its siblings are.*
 *
 * ============================================================================================
 * WHY THIS IS A PER-TARGET HOLD AND NOT A WAVE GATE
 * ============================================================================================
 * `packages/schemas/src/pipeline-behaviors.ts`'s mechanism table settles it, and the reason is not
 * an analogy to the freeze hold beside it: "a stale canary probe on target A says nothing about
 * target B, so blocking B would be a lie about what is known". The other three hooks are wave
 * gates precisely because a failing integration suite or a firing alarm IS a statement about the
 * whole widening; probe freshness is not. `WaveGateKindSchema` refuses to let a wave document ask
 * for `continuous` at a boundary, and `pipeline-hook-gate.ts` asserts the same thing in code.
 *
 * SIBLINGS MUST PROCEED. That is the entire reason this is a hold, and it has its own integration
 * test rather than being left as a property of the seam's placement.
 *
 * ============================================================================================
 * PREDICATE ONLY — the same split `freeze-hold.ts` and `stage-dependency-hold.ts` state
 * ============================================================================================
 * This module READS. `coordination/reconcile.ts`'s per-target loop is the seam that REFUSES. The
 * split is deliberate: the predicate is a pure-ish read a test can drive directly, and the seam is
 * three lines whose invariants are copied verbatim from the two holds already beside it.
 *
 * It reimplements NONE of `./pipeline-hook-verdicts.ts`'s rules. `evaluateContinuousHold` decides
 * what evidence means and `buildHookFreshnessContext` shapes the record; both were mutation-proven,
 * and a second copy of "stale-green is ABSENT, not pass and not fail" is a second place to regress
 * the one distinction the hook exists for.
 *
 * ============================================================================================
 * INERT WHEN NOTHING IS DECLARED
 * ============================================================================================
 * Structurally, not by convention: `orgDeclaresHookKind` is one indexed existence read, and this
 * function returns an empty map before resolving a single placement when it comes back false. An
 * org with no `continuous` hook — nearly every org, nearly all the time — pays one query per change
 * per tick, which is the same regime `freeze-hold.ts` keeps for freezes.
 *
 * ============================================================================================
 * NO CLOCK REACHES THE RECORD
 * ============================================================================================
 * `now` is INJECTED, passed to `evaluateContinuousHold`, and never returned. Every field below is
 * an id, a declared number, or an instant read off a stored evidence row; `staleAfter` is
 * `completedAt + maxAgeSeconds`, which is arithmetic on data. The COMPARISON against the clock is
 * redone every tick (ADR-0033); the RECORD stays byte-identical while the evidence is unchanged, so
 * `insertDecisionIfChanged` suppresses all but the first write. Recording `now` instead is what
 * produced the measured 1.44 GB/day incident (ADR-0024).
 */

/** One holding `continuous` hook. Shaped to `ContinuousTestHoldSchema` plus the freshness context
 *  the Decision carries — see the note on the wire projection at the bottom of this file. */
export interface ContinuousHookHold {
  hookId: string;
  /** THREE REASONS, NEVER COLLAPSED. `failed` means the probe ran and the target is sick — check
   *  the target. `stale`/`no_evidence` mean nobody is looking — check the prober. They demand
   *  different operator actions, so they must not share a word. */
  reason: NonNullable<ContinuousHoldVerdict["reason"]>;
  /** Server-composed, rendered verbatim (charter principle 6 — the UI composes no copy from raw
   *  fields). Names ids and instants only, never a display name that can drift. */
  summary: string;
  staleAfter: string | null;
  lastReportedAt: string | null;
  /** `HookFreshnessContextSchema`-shaped, straight from `buildHookFreshnessContext`. This is what
   *  Part 3 requires the Decision's `inputContext` to carry, and it is deliberately built by that
   *  function rather than assembled here so the "no `now`" property has ONE owner. */
  freshness: HookFreshnessContext;
}

/** One held wave target and what is holding it. */
export interface ContinuousHoldTargetVerdict {
  targetObjectId: string;
  /** The (component, deployment-target) pair this target resolves to, or `null` for a
   *  legacy-shaped wave target that names a component directly. Reported, never required. */
  stage: { componentObjectId: string; deploymentTargetObjectId: string | null } | null;
  /** Every holding hook, SORTED BY `hookId`. SORTED IS LOAD-BEARING: this array goes verbatim into
   *  a Decision's `inputContext`, and `restatesDecision` canonicalizes object KEYS only — array
   *  element ORDER is significant, so an unsorted array would let a reordered query result make an
   *  unchanged situation look new. One new row per tick is ADR-0024 rebuilt from parts. */
  holds: ContinuousHookHold[];
}

/**
 * Every target of `targetObjectIds` that a declared `continuous` hook is holding, keyed by target
 * object id.
 *
 * A target with NO holding hook is ABSENT from the map rather than present with an empty list —
 * the caller's seam is `const held = holds.get(id); if (held) { ... continue; }`, and a
 * present-but-empty entry would make that `if` true for every target on the instance. Identical to
 * `evaluateFreezeHolds`, deliberately: the two seams sit three lines apart in `reconcile.ts` and a
 * reader must not have to check which convention each one uses.
 *
 * `now` IS INJECTED for the same reason `freeze-hold.ts` injects it: the freshness boundary is the
 * whole feature, and a test of it would otherwise need a real sleep. Production passes nothing.
 *
 * Reads only, on a `TenantTx` the caller owns, so a hold evaluation can never half-commit anything.
 */
export async function evaluateContinuousHolds(
  tx: TenantTx,
  input: { orgId: string; targetObjectIds: string[]; now?: Date }
): Promise<Map<string, ContinuousHoldTargetVerdict>> {
  const { orgId, targetObjectIds } = input;
  const holds = new Map<string, ContinuousHoldTargetVerdict>();
  if (targetObjectIds.length === 0) return holds;

  // THE INERTNESS GATE. One indexed existence read; everything below it is skipped entirely for an
  // org that declares nothing. See the module doc.
  if (!(await orgDeclaresHookKind(tx, orgId, "continuous"))) return holds;

  const now = input.now ?? new Date();
  const subjects = await resolveHookSubjects(tx, orgId, targetObjectIds);
  const componentObjectIds = [...new Set([...subjects.values()].map((s) => s.componentObjectId))];
  const hooks = (await listHooksForComponents(tx, orgId, componentObjectIds)).filter(
    // `maxAgeSeconds` is nullable because the four kinds share one table, and it is REQUIRED on
    // this kind (`ManifestContinuousHookSchema`: "REQUIRED. Evidence older than this is ABSENT").
    // A row without one is not a freshness rule and is skipped rather than defaulted to a window
    // nobody declared — defaulting would invent an enforcement the author never wrote.
    (h) => h.kind === "continuous" && h.maxAgeSeconds !== null
  );
  if (hooks.length === 0) return holds;

  const byComponent = new Map<string, typeof hooks>();
  for (const hook of hooks) {
    const list = byComponent.get(hook.componentObjectId) ?? [];
    list.push(hook);
    byComponent.set(hook.componentObjectId, list);
  }

  for (const targetObjectId of targetObjectIds) {
    const subject = subjects.get(targetObjectId);
    // Absent means the target object is soft-deleted, or a placement is missing half its identity
    // (`resolveHookSubjects`). A DEAD TARGET IS NOT HELD — the same ordering `freeze-hold.ts` makes
    // explicit: holding one parks a row that reconcile should be terminalizing, carrying an
    // explanation that is not merely absent but WRONG.
    if (!subject) continue;

    const applicable = byComponent.get(subject.componentObjectId);
    if (!applicable) continue;

    const held: ContinuousHookHold[] = [];
    for (const hook of applicable) {
      const maxAgeSeconds = hook.maxAgeSeconds!;
      // NO BINDING FILTER, and that is the contract rather than an omission:
      // `latestTestRunEvidence`'s doc states the asymmetry — `evaluateContinuousHold` asks "what is
      // the latest word on this target", while `evaluatePostDeployGate` asks about the digest a
      // specific wave is promoting. A probe on a cron reports about the target as it stands, not
      // about the bytes some change happens to be shipping.
      const row = await latestTestRunEvidence(tx, orgId, {
        componentObjectId: subject.componentObjectId,
        targetObjectId: subject.targetObjectId,
        hookId: hook.hookId
      });
      const payload =
        row === null
          ? null
          : (row.payload as { outcome: "passed" | "failed"; completedAt: string });

      const verdict = evaluateContinuousHold(
        { maxAgeSeconds },
        payload === null ? null : { outcome: payload.outcome, completedAt: payload.completedAt },
        now
      );
      if (!verdict.held || verdict.reason === undefined) continue;

      const freshness = buildHookFreshnessContext(
        { kind: "continuous", hookId: hook.hookId, maxAgeSeconds },
        row === null || payload === null
          ? null
          : {
              evidenceId: row.id,
              outcome: payload.outcome,
              completedAt: payload.completedAt,
              artifactDigest: row.artifactDigest,
              commitSha: row.commitSha
            }
      );

      held.push({
        hookId: hook.hookId,
        reason: verdict.reason,
        summary: summarize(hook.hookId, verdict),
        staleAfter: verdict.staleAfter,
        lastReportedAt: verdict.lastReportedAt,
        freshness
      });
    }

    if (held.length === 0) continue;
    held.sort((a, b) => a.hookId.localeCompare(b.hookId));
    holds.set(targetObjectId, {
      targetObjectId,
      stage: {
        componentObjectId: subject.componentObjectId,
        deploymentTargetObjectId: subject.deploymentTargetObjectId
      },
      holds: held
    });
  }
  return holds;
}

/** The server-composed sentence. NAMES THE BOUNDARY, NEVER THE CLOCK: `staleAfter` is data the
 *  reader's own clock contextualizes, exactly as a freeze hold's `endsAt` is. A sentence containing
 *  "3 minutes ago" would be a new string every tick and a new Decision row with it.
 *
 *  EXPORTED so the three reasons' wording can be tested directly: `evaluateContinuousHolds`, the
 *  only production caller, needs a `TenantTx` to reach it. */
export function summarize(hookId: string, verdict: ContinuousHoldVerdict): string {
  switch (verdict.reason) {
    case "failed":
      return `continuous probe '${hookId}' last reported FAILED at ${String(verdict.lastReportedAt)} — the target is sick; check the target`;
    case "stale":
      return `continuous probe '${hookId}' last reported at ${String(verdict.lastReportedAt)} and its evidence went stale at ${String(verdict.staleAfter)} — nobody is looking; check the prober`;
    default:
      return `continuous probe '${hookId}' has never reported — nobody is looking; check the prober`;
  }
}

/** One entry of a `continuous_test` Decision's `inputContext.held`. */
export interface ContinuousHeldTargetRecord {
  targetObjectId: string;
  componentObjectId: string | null;
  deploymentTargetObjectId: string | null;
  holds: ContinuousHookHold[];
}

/**
 * THE `held` ARRAY OF THE `continuous_test` DECISION — one projection, so a second recorder cannot
 * write a differently-shaped version of the same fact.
 *
 * SORTED BY `targetObjectId`, AND THE SORT IS THE POINT, for exactly the reason
 * `describeHeldTargets` states beside it: the input order is `loadWavesWithTargets`'s
 * `ORDER BY created_at` with NO TIEBREAK over rows that all carry the same transaction timestamp,
 * on a table those rows are UPDATEd in every tick. An unstable `held` array is one new Decision row
 * per second for the length of the hold.
 *
 * A separate exported function because the integration fixture cannot perturb that input order on
 * demand (a wave's placements are created monotonically, so loop order and id order coincide), and
 * a sort tested only against input that is already sorted is not tested.
 */
export function describeContinuousHeldTargets(
  heldTargets: ContinuousHoldTargetVerdict[]
): ContinuousHeldTargetRecord[] {
  return [...heldTargets]
    .sort((a, b) => a.targetObjectId.localeCompare(b.targetObjectId))
    .map((entry) => ({
      targetObjectId: entry.targetObjectId,
      componentObjectId: entry.stage?.componentObjectId ?? null,
      deploymentTargetObjectId: entry.stage?.deploymentTargetObjectId ?? null,
      holds: entry.holds
    }));
}

/**
 * One line an operator can read, per held target — the reason-tree half of the Decision.
 *
 * ============================================================================================
 * WHERE THE USER-VISIBLE EXPLANATION LIVES — BOTH PLACES, AND WHY BOTH
 * ============================================================================================
 * This sentence is the REASON-TREE half of the `continuous_test` Decision, resolvable by
 * `scp change explain` / `scp decision get`: charter principle 6, every held outcome carrying a
 * resolvable `decision_id` naming its inputs.
 *
 * The WIRE half is now built too (the follow-up this comment used to carry as deferred):
 * `ChangeWaveTargetSchema.hold.continuousTests` on `GET /changes/{id}/explain`, projected by
 * `plan-service.ts`'s `resolveWaveTargetContinuousHolds` from `ContinuousHookHold` above — which is
 * structurally `ContinuousTestHoldSchema` already, so it is a mapping and not a redesign.
 *
 * THE TWO ARE NOT REDUNDANT AND MUST NOT BE COLLAPSED. The Decision is a HISTORICAL record of what
 * a tick decided, and it keeps saying `hold` until a later tick writes its `allow` counterpart. The
 * wire field is RE-DERIVED on the read, so it disappears the instant fresh green lands, with no
 * tick in between. Feeding the wire field from the Decision row is precisely the permanent-marker
 * trap `ChangeWaveTargetSchema.hold`'s own doc names; feeding the Decision from the read would lose
 * the audit trail. Same facts, two different questions.
 */
export function describeContinuousHold(verdict: ContinuousHoldTargetVerdict): string {
  return verdict.holds
    .map((h) => `${h.summary} — target ${verdict.targetObjectId} is not triggered while it stands`)
    .join("; ");
}
