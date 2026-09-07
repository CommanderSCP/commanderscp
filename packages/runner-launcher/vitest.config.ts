import { defineConfig } from "vitest/config";

/** Unit layer (BUILD_AND_TEST.md §4.1). See docs/runner-launcher.md §429. */
export default defineConfig({
  test: {
    // `*.kind.test.ts` IS EXCLUDED FOR A STRONGER REASON THAN `*.integration.test.ts`. The Docker
    // integration suite would merely fail without a daemon; the kind suite fails without a cluster
    // BY DESIGN (it has no skip path — see its header), so leaving it in the default include would
    // make `pnpm test` red on every machine that has not run `scripts/kind-runner-harness.sh up`.
    exclude: ["**/node_modules/**", "**/dist/**", "**/*.integration.test.ts", "**/*.kind.test.ts"],
    // ONE MACROTASK TICK BEFORE EACH TEST. See docs/runner-launcher.md §430.
    setupFiles: ["src/test-support/yield-between-tests.ts"],
    // The per-test budget is declared here because it was not. See docs/runner-launcher.md §431.
    testTimeout: 30_000,
    // The hook budget: a second deadline nobody chose. See docs/runner-launcher.md §432.
    hookTimeout: 30_000
  }
});
