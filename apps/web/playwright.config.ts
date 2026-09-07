import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Playwright smoke suite. See docs/web.md §31. */
export default defineConfig({
  testDir: "./e2e",
  // Playwright's default glob also matches `*.test.ts` (e.g. openapi-conformance.test.ts, a
  // Vitest unit test living beside the specs for the M16.2 phase B no-bypass matcher — see
  // vitest.config.ts's doc comment). Restrict to the `*.spec.ts` convention this directory
  // already follows so Playwright never tries to run a Vitest file under its own runner.
  testMatch: "**/*.spec.ts",
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
