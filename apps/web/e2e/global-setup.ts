import setupPostgres from "@scp/server/dist/test-support/global-setup.js";
import {
  listenTestServer,
  createTestOrg,
  type ListeningTestServer
} from "@scp/server/dist/test-support/harness.js";

/**
 * Playwright `globalSetup` for the apps/web e2e smoke suite (BUILD_AND_TEST.md §8 M2 item 2's
 * TESTS section, §4.4). This directory is TEST TOOLING, not shipped app source — unlike
 * apps/web/src/**, it may (and does) depend on `@scp/server` directly (a `workspace:*`
 * devDependency of apps/web, for this purpose only).
 *
 * Reuses @scp/server's own Vitest `globalSetup` (test-support/global-setup.ts) for the
 * Testcontainers Postgres bootstrap — same migrated container, same `scp_app` runtime-role
 * provisioning every other integration test uses — by importing its compiled output directly.
 * `@scp/server`'s package.json has no `exports` map restricting subpaths, so
 * `test-support/global-setup.js` and `test-support/harness.js` (`listenTestServer`/
 * `createTestOrg`) are both directly importable as-is; the one server-side change this suite
 * needed was harness.ts's new `withEventRelay` option (see that file) — `listenTestServer`
 * doesn't start the outbox relay by default, and without it the SSE live-update test would hang
 * waiting for an event that never arrives.
 *
 * Boots a REAL scpd instance serving the REAL built `apps/web/dist` (Part D's static mount +
 * SPA fallback in apps/server/src/app.ts) — `pnpm --filter @scp/web build` must run before this
 * suite (not done here; kept as an explicit separate step, matching the task's documented local
 * workflow). Exposes the server's origin + a fresh test org's admin credentials via `process.env`
 * — inherited by Playwright's worker processes, which fork after this function returns, same
 * mechanism @scp/server's own Vitest globalSetup uses for its test workers.
 *
 * Playwright's convention (matching Jest's): when `globalSetup`'s default export returns a
 * function, that function becomes the teardown automatically — no separate `globalTeardown` file
 * needed here.
 */
export default async function globalSetup(): Promise<() => Promise<void>> {
  const stopPostgres = await setupPostgres();

  const server: ListeningTestServer = await listenTestServer({ withEventRelay: true });
  const org = await createTestOrg(server, "e2e");

  process.env.E2E_BASE_URL = server.baseUrl.replace(/\/api\/v1\/?$/, "");
  process.env.E2E_API_BASE_URL = server.baseUrl;
  process.env.E2E_ORG_NAME = org.orgName;
  process.env.E2E_ADMIN_USERNAME = org.adminUsername;
  process.env.E2E_ADMIN_PASSWORD = org.adminPassword;

  return async () => {
    await server.close();
    await stopPostgres();
  };
}
