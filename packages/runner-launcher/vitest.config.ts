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
    testTimeout: 30_000
  }
});
