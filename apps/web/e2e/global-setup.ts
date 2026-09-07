import setupPostgres from "@scp/server/dist/test-support/global-setup.js";
import {
  listenTestServer,
  createTestOrg,
  type ListeningTestServer
} from "@scp/server/dist/test-support/harness.js";
import { startFakeArgoCd } from "./fake-argocd.js";

/** Playwright `globalSetup` for the apps/web e2e smoke suite. See docs/web.md §10. */
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

  // The fake is started before the server, so the allowlist. See docs/web.md §11.
  const fakeArgoCd = await startFakeArgoCd();
  process.env.E2E_FAKE_ARGOCD_URL = fakeArgoCd.url;
  process.env.SCP_INTERNAL_EGRESS_HOSTS = "127.0.0.1";

  // A plugin host, not a reconcile loop, since nothing drives. See docs/web.md §12.
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
