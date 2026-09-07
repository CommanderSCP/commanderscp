import { defineConfig } from "vitest/config";

/** Docker-requiring integration layer. See docs/runner-launcher.md §433. */
export default defineConfig({
  test: {
    include: ["src/**/*.integration.test.ts"],
    // Belt: the include above already cannot match `*.kind.test.ts`, and it is restated because CI
    // job 5 runs this config and has no Kubernetes cluster — a pattern loosened later must not
    // silently pull a suite that fails-by-design into the required integration gate.
    exclude: ["**/node_modules/**", "**/dist/**", "**/*.kind.test.ts"],
    testTimeout: 120_000,
    hookTimeout: 60_000,
    pool: "forks",
    poolOptions: { forks: { singleFork: true } }
  }
});
