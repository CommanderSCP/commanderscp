import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Playwright smoke suite (BUILD_AND_TEST.md §4.4 "also a `pnpm --filter @scp/web test:e2e` local
 * target against the dev server", §8 M2 item 2 TESTS section). Chromium only, per
 * BUILD_AND_TEST.md §1's toolchain table — no other browsers needed.
 *
 * `globalSetup` (e2e/global-setup.ts) boots a real backend against the built `apps/web/dist`
 * (`pnpm --filter @scp/web build` must run first — not orchestrated here, kept as an explicit
 * separate step). Serial (`workers: 1`) rather than parallel: this is a small (~5 test) smoke
 * suite sharing one org/server, and serial execution removes an entire class of cross-test data
 * races for negligible extra wall-clock time — simplicity over parallelism here, same call
 * apps/server's own integration suite makes (vitest.integration.config.ts's `singleFork`).
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  globalSetup: path.resolve(__dirname, "e2e/global-setup.ts"),
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] }
    }
  ]
});
