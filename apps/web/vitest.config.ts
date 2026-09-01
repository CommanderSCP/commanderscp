import { configDefaults, defineConfig } from "vitest/config";

/**
 * Standalone from vite.config.ts (see that file's doc comment for why) — Vitest picks up a
 * same-directory `vitest.config.ts` in preference to `vite.config.ts` automatically, so this is
 * the whole of apps/web's Vitest configuration.
 *
 * DELIBERATELY still no plugins, and the DEFAULT `environment` is still the Node one. Most component
 * tests under `src/` (e.g. `routes/service-board-honesty.test.tsx`) render through
 * `react-dom/server`'s `renderToStaticMarkup` — a string, no DOM — so they need neither a DOM library
 * nor `@vitejs/plugin-react`: `.tsx` is transformed by Vite's own esbuild honouring tsconfig's
 * `"jsx": "react-jsx"`. That keeps them inside the existing "4. Unit tests" CI job with zero new
 * jobs.
 *
 * A DOM ENVIRONMENT IS NOW AVAILABLE, PER FILE, AND THAT WAS A DELIBERATE CHOICE (M16.2 phase B,
 * round 3). A string render CANNOT FIRE A HANDLER, so every behavioural guarantee on this branch had
 * been pinned as an ATTRIBUTE or a LABEL rendered NEXT TO the handler — a second copy of the claim,
 * free to diverge from it. It did: replacing `onReconcile(defaultKeep.objectId)` with
 * `onReconcile(undefined)` in `routes/outpost-configuration.tsx` left the entire suite green while
 * restoring exactly the bare destructive call that work existed to remove. `happy-dom` (the smaller
 * of the two DOM libraries; a devDependency of `apps/web` only) fixes the cause: a test that needs
 * real events opts in with a `// @vitest-environment happy-dom` docblock on its FIRST LINE and uses
 * `src/test-support/render-dom.tsx`. No global default changes, so no existing test pays for it.
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
 * specs cost minutes, so an untested matcher there is a check nobody would notice
 * silently accepting everything. `*.spec.ts` is the Playwright convention this directory already
 * follows, and it is exactly what must not run under Vitest.
 */
/**
 * COVERAGE THRESHOLDS — a RATCHET, not a target (owner decision 2026-08-01: "measure, then set the
 * floor"); see `apps/server/vitest.config.ts` for the full rationale and the §7 correction.
 *
 * MEASURED 2026-08-01 on this config: statements/lines 40.25%, branches 77.7%, functions 55.83%.
 * The floors sit a point or two under each. RAISE them as coverage rises; never lower one to make
 * a red run green.
 *
 * The excluded `e2e/**\/*.spec.ts` Playwright specs run in their own jobs and contribute nothing here, so
 * these numbers describe the component/unit layer alone.
 */
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, "e2e/**/*.spec.ts"],
    // THE PER-TEST BUDGET, DECLARED RATHER THAN INHERITED (M23.1f clause 6). Vitest's implicit
    // default is 5,000ms; `@scp/runner-launcher` flaked on it under `pnpm -w test`'s parallel
    // graph while never failing once in 420 isolated runs. Gated for every package by
    // `@scp/source-census`'s `test-budget-census.test.ts` — a number must be chosen, not inherited.
    testTimeout: 20_000,
    // THE HOOK BUDGET, declared for the reason `@scp/source-census`'s `test-budget-census.test.ts`
    // gives in full: vitest's `hookTimeout` is a SECOND, independent deadline whose implicit
    // default (10,000ms) nobody chose, and the only hook cost this repo has ever measured under
    // CI's load profile — `@scp/cli`'s lazy-import warm-up — was 5,400ms against it. 30,000 is 25x
    // the isolated worst case in the unit layer (1,205ms) and half the un-declarable 60,000ms
    // `onTaskUpdate` RPC deadline a synchronous hook would otherwise be free to cross.
    hookTimeout: 30_000,
    coverage: {
      // `enabled: true` in-config rather than `--coverage` on the CI command line — same reason,
      // same census as apps/server/vitest.config.ts: a turbo `--` passthrough busts every build
      // task's cache, and in-config enablement makes the thresholds bind on a bare `pnpm test` too.
      enabled: true,
      provider: "v8",
      reporter: ["text-summary"],
      thresholds: {
        statements: 38,
        branches: 75,
        functions: 53,
        lines: 38
      }
    }
  }
});
