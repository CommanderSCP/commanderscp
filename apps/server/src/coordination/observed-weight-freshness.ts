/**
 * THE SHARED FRESHNESS BOUND — its own leaf module, deliberately, with NO imports.
 *
 * `stage-dependency-hold.ts` (ADR-0028 increment 3, docs/coordination.md §950) ages an observed
 * canary weight against this bound before it will let a release proceed on it.
 * `federation/peer-observations-repo.ts` ages a peer's federated reading (`wave_target_observed`,
 * `classifyPeerObservationFreshness`) against the SAME bound, so a commander can never call a
 * federated reading fresh that the hold calls stale, about the same row.
 *
 * ONE definition, imported directly from here by BOTH — never one importing it from the other.
 * `stage-dependency-hold.ts` sits in a real import cycle (it reaches back to itself through
 * `graph/placements-repo.ts` -> ... -> `coordination/plan-service.ts` ->
 * `coordination/wave-target-checks.ts` -> `federation/peer-observations-repo.ts`), so a module in
 * that cycle re-exporting the constant makes its value depend on which side of the cycle evaluates
 * first — this bundler/runtime resolves that case to `undefined`, not a live binding, which is
 * exactly the bug this module exists to make structurally impossible: nothing here can be "mid-
 * cycle" because this module imports nothing at all.
 */
export const OBSERVED_WEIGHT_FRESHNESS_MS = 10 * 60_000;
