import { configDefaults, defineConfig } from "vitest/config";

/**
 * Standalone from vite.config.ts (see that file's doc comment for why) — Vitest picks up a
 * same-directory `vitest.config.ts` in preference to `vite.config.ts` automatically, so this is
 * the whole of apps/web's Vitest configuration.
 *
 * DELIBERATELY still no plugins and no `environment` (the default Node one). The component tests
 * that do exist under `src/` (`routes/service-board-honesty.test.tsx`) render through
 * `react-dom/server`'s `renderToStaticMarkup` — a string, no DOM — so they need neither jsdom nor
 * `@vitejs/plugin-react`: `.tsx` is transformed by Vite's own esbuild honouring tsconfig's
 * `"jsx": "react-jsx"`. That keeps them inside the existing "4. Unit tests" CI job with zero new
 * dependencies and zero new jobs. Anything needing real DOM APIs (events, layout, refs) would need
 * a DOM environment added here first — no such test exists, and adding one is a deliberate choice,
 * not an accident.
 *
 * Its one real job: exclude the PLAYWRIGHT SPECS (apps/web/e2e/*.spec.ts, run only via
 * `pnpm --filter @scp/web test:e2e` / playwright.config.ts) from Vitest's default
 * `**\/*.{test,spec}.*` include glob, which would otherwise also match them and crash trying to run
 * Playwright specs under the wrong test runner ("Playwright Test did not expect test() to be called
 * here") — a pre-existing bug (present before this step's changes, on every prior `e2e/*.spec.ts`
 * file already on this branch), not something newly introduced here.
 *
 * NARROWED FROM `e2e/**` TO `e2e/**\/*.spec.ts` (M16.2 phase B, B4). The blanket exclusion also hid
 * `e2e/*.test.ts`, so PURE test HELPERS living beside the specs — today
 * `e2e/openapi-conformance.ts`, the matcher that decides whether a captured request path is a
 * declared OpenAPI operation — had no way to be unit-tested in a job that runs on pull requests. The
 * specs themselves are main-only, so an untested matcher there is a check nobody would notice
 * silently accepting everything. `*.spec.ts` is the Playwright convention this directory already
 * follows, and it is exactly what must not run under Vitest.
 */
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, "e2e/**/*.spec.ts"]
  }
});
