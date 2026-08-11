import setupPostgres from "@scp/server/dist/test-support/global-setup.js";
import {
  listenTestServer,
  createTestOrg,
  type ListeningTestServer
} from "@scp/server/dist/test-support/harness.js";
import { startFakeArgoCd } from "./fake-argocd.js";

/**
 * Playwright `globalSetup` for the apps/web e2e smoke suite (BUILD_AND_TEST.md §8 M2 item 2's
 * TESTS section, §4.4). This directory is TEST TOOLING, not shipped app source — unlike
 * apps/web/src/**, it may (and does) depend on `@scp/server` directly (a `workspace:*`
 * devDependency of apps/web, for this purpose only).
 *
 * Two modes, chosen by whether `PLAYWRIGHT_BASE_URL` is set:
 *
 * - LOCAL (default, `PLAYWRIGHT_BASE_URL` unset): reuses @scp/server's own Vitest `globalSetup`
 *   (test-support/global-setup.ts) for the Testcontainers Postgres bootstrap — same migrated
 *   container, same `scp_app` runtime-role provisioning every other integration test uses — by
 *   importing its compiled output directly. `@scp/server`'s package.json has no `exports` map
 *   restricting subpaths, so `test-support/global-setup.js` and `test-support/harness.js`
 *   (`listenTestServer`/`createTestOrg`) are both directly importable as-is; the one server-side
 *   change this suite needed was harness.ts's new `withEventRelay` option (see that file) —
 *   `listenTestServer` doesn't start the outbox relay by default, and without it the SSE
 *   live-update test would hang waiting for an event that never arrives. Boots a REAL scpd
 *   instance serving the REAL built `apps/web/dist` (Part D's static mount + SPA fallback in
 *   apps/server/src/app.ts) — `pnpm --filter @scp/web build` must run before this suite (not
 *   done here; kept as an explicit separate step, matching the task's documented local
 *   workflow).
 *
 * - COMPOSE-STACK (`PLAYWRIGHT_BASE_URL` set, e.g. `http://localhost:8080` — scripts/e2e-web.sh):
 *   points at an already-running server (the two-container eval compose stack, with
 *   `SCP_SEED_DEMO=true`) instead of bootstrapping a Testcontainers Postgres + in-process server
 *   here. This process doesn't own that stack's lifecycle (the calling script does — same
 *   teardown-with-log-dump-on-failure pattern as scripts/e2e-m0.sh), so there's no teardown
 *   function to return. The bootstrap admin's org/username/one-time password aren't ours to
 *   generate here (they come from the compose stack's own boot-time `ensureBootstrapAdmin`), so
 *   the caller must supply them via `E2E_ORG_NAME`/`E2E_ADMIN_USERNAME`/`E2E_ADMIN_PASSWORD` —
 *   scripts/e2e-web.sh extracts the password from compose logs exactly like scripts/e2e-m0.sh
 *   does for the CLI-driven M0 suite.
 *
 * Either way, exposes the server's origin + admin credentials via `process.env` — inherited by
 * Playwright's worker processes, which fork after this function returns, same mechanism
 * @scp/server's own Vitest globalSetup uses for its test workers.
 *
 * Playwright's convention (matching Jest's): when `globalSetup`'s default export returns a
 * function, that function becomes the teardown automatically — no separate `globalTeardown` file
 * needed here; returning `undefined` (COMPOSE-STACK mode) means "no teardown".
 */
export default async function globalSetup(): Promise<(() => Promise<void>) | undefined> {
  const composeBaseUrl = process.env.PLAYWRIGHT_BASE_URL;
  if (composeBaseUrl) {
    process.env.E2E_BASE_URL = composeBaseUrl.replace(/\/$/, "");
    process.env.E2E_API_BASE_URL = `${process.env.E2E_BASE_URL}/api/v1`;
    for (const key of [
      "E2E_ORG_NAME",
      "E2E_ADMIN_USERNAME",
      "E2E_ADMIN_PASSWORD",
      // M19.1 — set by scripts/e2e-web.sh to the compose-network name of the `fake-argocd` service
      // (docker-compose.e2e.yml). Required rather than optional: a missing value would SKIP the
      // wizard spec in the one job that runs it, which is indistinguishable from passing.
      "E2E_FAKE_ARGOCD_URL"
    ] as const) {
      if (!process.env[key]) {
        throw new Error(
          `PLAYWRIGHT_BASE_URL is set (compose-stack mode) but ${key} is unset — see scripts/e2e-web.sh`
        );
      }
    }
    return undefined;
  }

  const stopPostgres = await setupPostgres();

  // M19.1 — the LOCAL-target fake Argo CD, started BEFORE the server so the allowlist below is in
  // place by the time anything reads it. 127.0.0.1 is a loopback address, so SCP's SSRF guard
  // refuses it unless both ADR-0003 layers permit; this is layer 1 (the operator's host allowlist),
  // exactly as `routes/gitea-discovery.integration.test.ts` sets it, and the wizard's checkbox
  // supplies layer 2. Compose-stack mode gets the same pair from docker-compose.e2e.yml.
  const fakeArgoCd = await startFakeArgoCd();
  process.env.E2E_FAKE_ARGOCD_URL = fakeArgoCd.url;
  process.env.SCP_INTERNAL_EGRESS_HOSTS = "127.0.0.1";

  // `withPluginHost` (NOT `withReconcileLoop` — this suite drives nothing and a competing consumer
  // would only add races): `POST /discovery/run` fail-closes on `deps.pluginHost` alone, and
  // `buildApp` in the test harness does not construct one by default. The compose stack's real
  // `main.ts` builds a host for every role, so this is the local target catching up to it, not a
  // difference in what is being tested.
  const server: ListeningTestServer = await listenTestServer({
    withEventRelay: true,
    withPluginHost: true
  });
  const org = await createTestOrg(server, "e2e");

  process.env.E2E_BASE_URL = server.baseUrl.replace(/\/api\/v1\/?$/, "");
  process.env.E2E_API_BASE_URL = server.baseUrl;
  process.env.E2E_ORG_NAME = org.orgName;
  process.env.E2E_ADMIN_USERNAME = org.adminUsername;
  process.env.E2E_ADMIN_PASSWORD = org.adminPassword;

  return async () => {
    await server.close();
    await fakeArgoCd.close();
    await stopPostgres();
  };
}
