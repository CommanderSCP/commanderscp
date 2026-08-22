import { defineConfig } from "vitest/config";

/**
 * Unit layer (BUILD_AND_TEST.md §4.1) — mirrors `@scp/plugin-managed-iac`'s exact pattern: excludes
 * `*.integration.test.ts` (the real-Docker reaper test, `reaper.integration.test.ts` — M23.1 phase
 * 4) so `pnpm test` never depends on a Docker daemon being available.
 */
export default defineConfig({
  test: {
    // `*.kind.test.ts` IS EXCLUDED FOR A STRONGER REASON THAN `*.integration.test.ts`. The Docker
    // integration suite would merely fail without a daemon; the kind suite fails without a cluster
    // BY DESIGN (it has no skip path — see its header), so leaving it in the default include would
    // make `pnpm test` red on every machine that has not run `scripts/kind-runner-harness.sh up`.
    exclude: ["**/node_modules/**", "**/dist/**", "**/*.integration.test.ts", "**/*.kind.test.ts"],
    // ONE MACROTASK TICK BEFORE EACH TEST — WITHOUT IT THIS SUITE FAILS THE RUN WITH 429 PASSES.
    // CI job 4 failed `@scp/runner-launcher#test` on `[vitest-worker]: Timeout calling
    // "onTaskUpdate"` while reporting `17 passed / 429 passed / 1 error`. vitest's worker->main
    // task-result RPC carries a birpc deadline of 60,000ms that is compiled into vitest's bundle
    // and reachable from no config, and `persisted-json-bound.test.ts` is 79 PURELY SYNCHRONOUS
    // sweeps: a run of synchronous tests never lets the worker's loop reach its poll phase, so the
    // reply — sent within milliseconds — cannot be READ for the file's whole duration. That file
    // measured 62,948ms on the CI runner against the 60,000ms deadline (4,301ms isolated here;
    // ~14x inflation from turbo's 71-task graph on a 4-vCPU runner).
    //
    // The setup file's own module doc carries the measurements and the two controls that pin the
    // mechanism: 63s of synchronous blocking fails with NO load and NO coverage, and the SAME 63s
    // with one yield per test is clean — as is 126s. Nothing is suppressed and no budget moves;
    // the tick bounds the stall by ONE TEST rather than by the whole file, and a test is what
    // `testTimeout` below already governs.
    setupFiles: ["src/test-support/yield-between-tests.ts"],
    // THE PER-TEST BUDGET IS DECLARED HERE BECAUSE IT WAS NOT, AND THAT IS WHAT FLAKED
    // (M23.1f clause 6). This package ran on vitest's IMPLICIT 5,000ms default while holding the
    // repo's heaviest unit sweeps. Measured on this machine: isolated, 420 consecutive runs of this
    // suite were clean (396 tests each); under `pnpm -w test`'s 109-task parallel graph, 5 runs in
    // 23 failed, every one `Error: Test timed out in 5000ms.` and every one in this package. The
    // slowest test with no budget of its own is `persisted-json-bound.test.ts`'s
    // "EVERY BUDGET 100…900 …" at 3,548ms isolated — 1.4x headroom against the default — and it was
    // observed at 5,259/5,582/5,651/5,745ms under the graph; `docker-adapter.test.ts`'s env-file
    // 0600 case runs in 409ms isolated and was observed at 7,485ms.
    //
    // THE PROPERTY, NOT THE INSTANCE: `persisted-json-budget-sweep.test.ts` — the sibling sweep, in
    // the next file — ALREADY declared `}, 60_000)` per test. The same hazard was seen and bounded
    // in one of the two places that had it, which is §4.4a's shape exactly. The class fix is
    // `@scp/source-census`'s `test-budget-census.test.ts`: no package may run its unit suite on an
    // implicit default.
    //
    // 30,000 is 8.5x the isolated worst case and 4x the worst load-inflated observation. It is
    // headroom, not a slow-test licence: a passing test is unaffected by the budget, so the only
    // cost is that a genuinely wedged test takes longer to be declared dead.
    //
    // AND ONE CONSEQUENCE THE `onTaskUpdate` ROUND MADE VISIBLE. With the yield above, the longest
    // a worker's loop can stall is the longest single TEST — which this number bounds at 30,000ms,
    // half the RPC deadline. The one exception is the very per-test override praised above:
    // `persisted-json-budget-sweep.test.ts`'s `}, 60_000)` is EXACTLY the deadline, so that one
    // test could in principle stall right up to it. That is what the setup file's
    // `MAX_WORKER_STALL_MS` tripwire (45,000ms) exists to catch — it fires first, and with the
    // cause on it. The override is left at its measured value rather than tightened by guesswork:
    // it was observed at 27,829ms on the loaded CI runner and 11,969ms under the local graph.
    testTimeout: 30_000
  }
});
