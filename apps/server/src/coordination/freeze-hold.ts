import type { TenantTx } from "../db/tenant-tx.js";
import { freezesByTarget, unionFreezes } from "../governance/freeze-scope.js";
import type { FreezeRow } from "../governance/freezes-repo.js";
import { resolvePlacementPair } from "./stage-dependency-hold.js";
import { readTargetLiveness } from "./target-liveness.js";

/**
 * M25.2 — THE FREEZE HOLD, PREDICATE HALF.
 *
 * The guarantee, stated so it can be kept: *a wave target covered by an active freeze is not
 * TRIGGERED while that freeze's window is open, and its uncovered siblings are.*
 *
 * ============================================================================================
 * WHY THIS EXISTS BESIDE THE WAVE GATE RATHER THAN INSIDE IT
 * ============================================================================================
 * `evaluateWaveGate` issues ONE verdict for the whole wave and fires EXACTLY ONCE, on
 * `pending -> running`. Two consequences, and the second is the one nobody had noticed:
 *
 *   * one frozen region parked all four, because `checkFreeze` unioned every target's containment
 *     chain into one scope set and asked one question of it; and
 *   * a freeze DECLARED MID-WAVE was never seen at all — the gate had already run.
 *
 * A read-time predicate consulted on every tick of the per-target loop fixes both, and it is the
 * same shape ADR-0028's stage-dependency hold already uses for the same reason. The gate keeps the
 * ALL-frozen case (`gate-orchestrator.ts`'s `partiallyFrozen`), because a totally-frozen wave
 * transitioning to `running` with nothing running, and losing the `gate`/`block` Decision an
 * operator resolves with `scp change explain`, is a worse trade than one `if`.
 *
 * ============================================================================================
 * PREDICATE ONLY — the same split `stage-dependency-hold.ts` states for itself
 * ============================================================================================
 * This module READS. `coordination/reconcile.ts`'s per-target loop is the seam that REFUSES, and
 * `campaign-reconcile.ts`'s `pending` branch is the second one. The split is deliberate: the
 * predicate is a pure-ish read a test can drive directly, and each seam is three lines whose
 * invariants are copied verbatim from the backoff gate beside them.
 *
 * WHAT THIS IS NOT: it is not a pause. `ExecutorPlugin` is exactly
 * `observe`/`trigger`/`status`/`abort`/`describeCapabilities` — there is no advance/pause/resume
 * verb, and ADR-0008 forbids adding one. A freeze withholds a call SCP has not made yet; it cannot
 * un-ring a trigger already handed to an executor. That is the honest boundary, and it is why
 * `reconcile.ts` places this check AFTER the backoff gate: a `triggering` target has already been
 * dispatched, so the freeze withholds its RETRY.
 *
 * ============================================================================================
 * INERT WHEN NOTHING IS FROZEN
 * ============================================================================================
 * Structurally, not by convention: `freezesByTarget` issues one indexed org-wide window read and
 * returns every target with no freezes WITHOUT walking a containment chain when that read is empty
 * (`governance/freeze-scope.ts`, and it has its own counting test). This function then returns an
 * empty map before resolving a single placement pair. An org with no active freeze pays one query
 * per change per tick, which is the regime nearly every org is in nearly all the time.
 */

/** One held wave target and what is holding it. Shaped for the Decision `reconcile.ts` writes:
 *  every field is an id, a name, or an instant read straight off `freezes.ends_at` — nothing
 *  derived from a clock, which is what lets the Decision dedup under the 1 s tick. */
export interface FreezeHoldVerdict {
  targetObjectId: string;
  /** The (component, deployment-target) pair this target resolves to, or `null` for a
   *  legacy-shaped wave target that names a component directly. Reported, never required: a freeze
   *  holds a component-shaped target exactly as well as a placement-shaped one, because the
   *  containment chain covers both. Purely for the Decision's explanation. */
  stage: { componentObjectId: string; deploymentTargetObjectId: string } | null;
  /** Every active freeze holding this target, sorted by id. SORTED IS LOAD-BEARING: this array
   *  goes verbatim into a Decision's `inputContext`, and an unsorted array would let a reordered
   *  query result make an unchanged situation look new to `insertDecisionIfChanged` — one new row
   *  per tick, which is ADR-0024's measured 1.44 GB/day rebuilt from parts.
   *
   *  HOLDING, not merely covering: under an `atomic` freeze (below) a target this array names may
   *  be one the freeze does not cover at all — it is held because a SIBLING is covered. `atomic` is
   *  carried per freeze so the Decision says which, rather than leaving an operator to work out why
   *  a scope nothing froze stopped moving. */
  freezes: {
    id: string;
    scopeObjectId: string;
    name: string | null;
    endsAt: string;
    atomic: boolean;
  }[];
}

/**
 * Every target of `targetObjectIds` that an active freeze covers, keyed by target object id.
 *
 * A target with NO covering freeze is ABSENT from the map rather than present with an empty list —
 * the caller's seam is `const frozen = holds.get(id); if (frozen) { ... continue; }`, and a
 * present-but-empty entry would make that `if` true for every target on the instance.
 *
 * `now` IS INJECTED, and that is not a testing nicety. The freeze path has no clock seam today
 * (`gate-orchestrator.ts` hardcodes `new Date()` at the top of `evaluateGovernanceGate`), so a test
 * of the window boundary — a freeze that lifts, a freeze that has not started — would otherwise
 * need a real sleep. Precedents: `watchdog.ts` and `stage-dependency-hold.ts` both take the same
 * optional parameter for the same reason. Production passes nothing.
 *
 * Reads only, on a `TenantTx` the caller owns, so a hold evaluation can never half-commit anything.
 */
export async function evaluateFreezeHolds(
  tx: TenantTx,
  input: { orgId: string; targetObjectIds: string[]; now?: Date }
): Promise<Map<string, FreezeHoldVerdict>> {
  const { orgId, targetObjectIds } = input;
  const holds = new Map<string, FreezeHoldVerdict>();
  if (targetObjectIds.length === 0) return holds;

  const byTarget = await freezesByTarget(tx, orgId, targetObjectIds, input.now ?? new Date());

  // ============================================================================================
  // `atomic` — OWNER DECISION D5, READ HERE AND NOT ONLY AT THE GATE
  // ============================================================================================
  // An `atomic` freeze restores the union: covering ANY one target of the set freezes EVERY target
  // of it (drizzle/0077, proposal §1.6). `gate-orchestrator.ts`'s `partiallyFrozen` already honours
  // that — but the wave gate fires EXACTLY ONCE, on `pending -> running`, so a gate-only reader
  // makes `atomic` silently degrade to per-target admission for every freeze that opens after the
  // wave started. That is the second of the two defects M25.2 exists to fix, applied to the
  // per-target dimension and not to this one; and the case is not exotic — a target held by
  // ADR-0028's stage-dependency hold, or backed off after a refused trigger, is still `pending`
  // when an operator declares the incident freeze, and it is exactly the target `atomic` is about.
  //
  // A target held ONLY because a sibling is covered still gets the covering freezes in its own
  // `freezes` array (deduped, and each carrying `atomic`), so the Decision names what is holding it
  // rather than reporting an empty reason for a scope nothing froze.
  const atomicFreezes = unionFreezes(byTarget).filter((f) => f.atomic);

  for (const entry of byTarget) {
    const holding =
      atomicFreezes.length === 0
        ? entry.freezes
        : unionFreezes([{ targetObjectId: entry.targetObjectId, freezes: entry.freezes }, { targetObjectId: entry.targetObjectId, freezes: atomicFreezes }]);
    if (holding.length === 0) continue;

    // ==========================================================================================
    // A DEAD TARGET IS NOT HELD — the ordering `campaign-reconcile.ts`'s seam already states, made
    // true on the change side too.
    // ==========================================================================================
    // `reconcile.ts` places its freeze `continue` BEFORE `triggerWaveTarget` (so no trigger-claim
    // lock is taken for a call it will not make), and the target-liveness gate lives INSIDE
    // `triggerWaveTarget`. Without this check a tombstoned target that a freeze happens to cover is
    // HELD instead of terminalized: the row sits `pending` for the length of the window — weeks are
    // expressible — carrying a Decision that says a freeze is holding it, while the truth is that
    // the object was deleted. `wave_target_tombstoned`'s audit event and block Decision are
    // deferred for the same length of time. The explanation is not merely absent, it is WRONG, and
    // terminalizing a dead row is PROGRESS. `containmentChain` does not filter `deleted_at` on its
    // BASE row (only on ancestors), so a soft-deleted placement resolves a full chain and would
    // otherwise look perfectly coverable.
    //
    // Costs one indexed read per COVERED target per tick and nothing at all otherwise: an org with
    // no active freeze never reaches this loop body (`freezesByTarget` returned every target with
    // no freezes without walking anything). A THROWN read is not a deletion — `readTargetLiveness`
    // has no catch, so a database blip propagates and the target is retried next tick with nothing
    // terminalized and nothing dispatched.
    const liveness = await readTargetLiveness(tx, orgId, entry.targetObjectId);
    if (!liveness.live) continue;

    // The placement pair is resolved ONLY for a target that is actually held — one extra read per
    // HELD target per tick, never one per target. A change with nothing frozen (the common case)
    // has already returned above without reaching this loop body at all.
    const stage = await resolvePlacementPair(tx, orgId, entry.targetObjectId);
    holds.set(entry.targetObjectId, {
      targetObjectId: entry.targetObjectId,
      stage,
      freezes: describeFreezes(holding)
    });
  }
  return holds;
}

/** The Decision-shaped projection of a covering freeze set: ids, the scope it was declared at, its
 *  operator-facing name, and the WINDOW BOUNDARY — never `now`.
 *
 *  `endsAt` AND NOT THE CLOCK is the whole anti-write-amplification contract, copied exactly from
 *  `gate-orchestrator.ts`'s freeze-block `inputContext`. Recording the boundary makes a hold's
 *  Decision byte-identical on every tick of a three-week freeze, so `insertDecisionIfChanged`
 *  suppresses all but the first. Recording `now` instead is what produced a measured 1.44 GB/day
 *  in production (ADR-0024). `reason` is deliberately absent for the same reason it is absent from
 *  the gate's version: it is free text that adds nothing an id does not already resolve, and it
 *  belongs in the reason tree, which the caller builds. */
function describeFreezes(freezes: FreezeRow[]): FreezeHoldVerdict["freezes"] {
  return [...freezes]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((f) => ({
      id: f.id,
      scopeObjectId: f.scopeObjectId,
      name: f.name,
      endsAt: f.endsAt.toISOString(),
      atomic: f.atomic
    }));
}

/** One line an operator can read, per held target — the reason-tree half of the Decision. */
export function describeFreezeHold(verdict: FreezeHoldVerdict): string {
  return verdict.freezes
    .map(
      (f) =>
        `freeze '${f.name ?? f.id}' at ${f.scopeObjectId} until ${f.endsAt}` +
        (f.atomic ? " (atomic — it holds EVERY target of the wave, covered or not)" : "") +
        ` — target ${verdict.targetObjectId} is not triggered while it stands`
    )
    .join("; ");
}
