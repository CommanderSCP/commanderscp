import { configDefaults, defineConfig } from "vitest/config";

/**
 * Standalone from vite.config.ts (see that file's doc comment for why) — Vitest picks up a
 * same-directory `vitest.config.ts` in preference to `vite.config.ts` automatically, so this is
 * the whole of apps/web's Vitest configuration. No unit tests exist under apps/web/src yet
 * (`pnpm test` runs with `--passWithNoTests`), so there's no plugin (react/tailwind) transform
 * need to replicate from vite.config.ts here — when real component tests are added, revisit.
 *
 * Its one real job: exclude `e2e/**` (apps/web/e2e, Playwright specs run only via
 * `pnpm --filter @scp/web test:e2e` / playwright.config.ts) from Vitest's default
 * `**\/*.{test,spec}.*` include glob, which would otherwise also match `e2e/*.spec.ts` and crash
 * trying to run Playwright specs under the wrong test runner ("Playwright Test did not expect
 * test() to be called here") — a pre-existing bug (present before this stage's changes, on every
 * prior `e2e/*.spec.ts` file already on this branch), not something newly introduced here.
 */
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, "e2e/**"]
  }
});
