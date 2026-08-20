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
    exclude: ["**/node_modules/**", "**/dist/**", "**/*.integration.test.ts", "**/*.kind.test.ts"]
  }
});
