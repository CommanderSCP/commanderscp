import { defineConfig } from "vitest/config";

/**
 * Unit layer (BUILD_AND_TEST.md §4.1): pure functions, no Docker, milliseconds. Vitest's default
 * test glob (`**\/*.test.ts`) would otherwise also pick up `*.integration.test.ts` files, which
 * need the Testcontainers Postgres from `vitest.integration.config.ts`'s `globalSetup` — exclude
 * them explicitly so `pnpm test` never depends on Docker.
 */
/**
 * COVERAGE THRESHOLDS — a RATCHET, not a target (owner decision 2026-08-01: "measure, then set the
 * floor"). BUILD_AND_TEST.md §7 claimed "≥80% unit coverage" while thresholds were configured
 * NOWHERE and `pnpm test` ran bare, so nothing had ever been enforced and the number was aspiration
 * presented as policy.
 *
 * MEASURED 2026-08-01 on this config: statements/lines 15.09%, branches 74.78%, functions 31.58%.
 * The floors below sit a point or two under each, so an ordinary refactor doesn't red CI but a real
 * regression does. RAISE THEM when coverage rises; never lower one to make a red run green.
 *
 * WHY STATEMENT COVERAGE IS LOW AND WHY THAT IS NOT ALARMING HERE: the denominator is every source
 * file in the package, but this layer is the UNIT layer only — `*.integration.test.ts` is excluded
 * above and runs under `vitest.integration.config.ts`, where the overwhelming majority of this
 * codebase's behaviour is actually exercised (real Postgres via Testcontainers, per
 * CLAUDE.md: "Integration tests run against real PostgreSQL — never a mocked DB"). A high
 * unit-statement number would mean logic had been pulled out of the database layer to be testable
 * without one, which is the opposite of this project's testing strategy. BRANCH coverage (74.78%)
 * is the meaningful figure at this layer: it measures the pure decision logic that unit tests do own.
 */
export default defineConfig({
  test: {
    exclude: ["**/node_modules/**", "**/dist/**", "**/*.integration.test.ts"],
    // RAISED FROM THE 5s DEFAULT BECAUSE COVERAGE IS NOW ON IN CI (stage 4 runs
    // `pnpm test -- --coverage`), and v8 instrumentation is not free for the handful of unit tests
    // that do real cryptography. Measured 2026-08-01: `federation/crl-reload.test.ts` and
    // `federation/crl-parse.test.ts` (real CA + leaf issuance and a live TLS handshake against
    // `setSecureContext`) run in ~500ms uninstrumented and ~5,100ms under coverage — straddling
    // the 5s default, which flaked roughly 1 run in 4.
    //
    // This is a headroom change, not a slow-test licence: a test that PASSES is unaffected by the
    // timeout, so the only cost is that a genuinely hung test takes longer to be declared dead. If
    // a unit test ever legitimately approaches this, that is a signal it belongs in the
    // integration layer, not a reason to raise the number again.
    testTimeout: 20_000,
    coverage: {
      provider: "v8",
      reporter: ["text-summary"],
      thresholds: {
        statements: 14,
        branches: 72,
        functions: 30,
        lines: 14
      }
    }
  }
});
