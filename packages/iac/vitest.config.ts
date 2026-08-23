import { defineConfig } from "vitest/config";

/**
 * THE PER-TEST BUDGET, DECLARED RATHER THAN INHERITED (M23.1f clause 6).
 *
 * Vitest's implicit default is 5,000ms. `@scp/runner-launcher` ran its unit suite on it while
 * holding the repo's heaviest sweeps and flaked 5 runs in 23 of `pnpm -w test` — never once in
 * 420 isolated runs, because isolation is the wrong load profile: what consumes the headroom is
 * the 109-task parallel graph, not the test. `apps/server` had already raised its own budget for
 * exactly this reason in 2026-08 and the sibling packages were left on the default, which is the
 * incomplete-call-site-census property CLAUDE.md names.
 *
 * The rule is now machine-checked by `@scp/source-census`'s `test-budget-census.test.ts`: every
 * package whose `test` script is vitest must DECLARE a number, and that number must be one the
 * census table names. This is headroom, not a slow-test licence — a passing test is unaffected by
 * the budget, so the only cost is that a genuinely wedged test takes longer to be declared dead.
 */
export default defineConfig({
  test: {
    testTimeout: 20_000,
    // THE HOOK BUDGET, declared for the reason `@scp/source-census`'s `test-budget-census.test.ts`
    // gives in full: vitest's `hookTimeout` is a SECOND, independent deadline whose implicit
    // default (10,000ms) nobody chose, and the only hook cost this repo has ever measured under
    // CI's load profile — `@scp/cli`'s lazy-import warm-up — was 5,400ms against it. 30,000 is 25x
    // the isolated worst case in the unit layer (1,205ms) and half the un-declarable 60,000ms
    // `onTaskUpdate` RPC deadline a synchronous hook would otherwise be free to cross.
    hookTimeout: 30_000
  }
});
