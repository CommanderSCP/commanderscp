import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ScpClient } from "@scp/sdk";
import {
  createTestOrg,
  listenTestServer,
  type ListeningTestServer
} from "./test-support/harness.js";
import { seedDemoData, loginAndSeedDemoData } from "./seed.js";
import { ensureBootstrapAdmin } from "./auth/local-auth.js";

const silentLog = { info: () => undefined, warn: () => undefined };

interface Snapshot {
  domains: string[];
  services: string[];
  components: string[];
  teams: string[];
  checkoutOwners: string[];
  checkoutDependsOn: string[];
  checkoutApiConsumes: string[];
}

async function snapshot(client: ScpClient): Promise<Snapshot> {
  const [domains, services, components, teams] = await Promise.all([
    client.domains.list({ limit: 100 }),
    client.services.list({ limit: 100 }),
    client.components.list({ limit: 100 }),
    client.teams.list({ limit: 100 })
  ]);
  const checkout = services.items.find((s) => s.name === "checkout");
  const checkoutApi = components.items.find((c) => c.name === "checkout-api");
  if (!checkout || !checkoutApi) {
    throw new Error("expected seedDemoData to have created 'checkout' and 'checkout-api'");
  }
  const [checkoutOwners, checkoutDependsOn, checkoutApiConsumes] = await Promise.all([
    client.services.listOwners(checkout.id, { limit: 100 }),
    client.services.listDependsOn(checkout.id, { limit: 100 }),
    client.components.listConsumes(checkoutApi.id, { limit: 100 })
  ]);
  return {
    domains: domains.items.map((o) => o.id).sort(),
    services: services.items.map((o) => o.id).sort(),
    components: components.items.map((o) => o.id).sort(),
    teams: teams.items.map((o) => o.id).sort(),
    checkoutOwners: checkoutOwners.items.map((r) => r.id).sort(),
    checkoutDependsOn: checkoutDependsOn.items.map((r) => r.id).sort(),
    checkoutApiConsumes: checkoutApiConsumes.items.map((r) => r.id).sort()
  };
}

/** Idempotency is non-negotiable. See docs/server.md §87. */
describe("seedDemoData: idempotent re-runs", () => {
  let server: ListeningTestServer;
  let client: ScpClient;
  let orgName: string;

  beforeAll(async () => {
    server = await listenTestServer();
    const org = await createTestOrg(server, "seed");
    orgName = org.orgName;
    client = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
  });

  afterAll(async () => {
    await server.close();
  });

  it("creates the expected demo graph once, and a second run changes nothing", async () => {
    await seedDemoData(client, orgName, silentLog);
    const afterFirstRun = await snapshot(client);

    expect(afterFirstRun.domains).toHaveLength(1);
    expect(afterFirstRun.services).toHaveLength(2);
    expect(afterFirstRun.components).toHaveLength(3);
    expect(afterFirstRun.teams).toHaveLength(1);
    expect(afterFirstRun.checkoutOwners).toHaveLength(1);
    expect(afterFirstRun.checkoutDependsOn).toHaveLength(1);
    expect(afterFirstRun.checkoutApiConsumes).toHaveLength(1);

    await seedDemoData(client, orgName, silentLog);
    const afterSecondRun = await snapshot(client);

    expect(afterSecondRun).toEqual(afterFirstRun);

    await seedDemoData(client, orgName, silentLog);
    const afterThirdRun = await snapshot(client);

    expect(afterThirdRun).toEqual(afterFirstRun);
  });
});

/**
 * #422 re-verify — CI caught what local runs missed: after `loginAndSeedDemoData` resets the
 * account and RE-ARMS `mustChangePassword` (BLOCKING 0's fix — the operator's real first login
 * must still go through a genuine forced change, the same as a non-demo install), EVERY
 * `scripts/e2e-*.sh` that ALSO logs in as the bootstrap admin afterward (to register services,
 * poll for the seed landing, etc.) hit a 403 it hadn't before, because it never expected to need a
 * second forced-change clear of its own. This test proves the exact shape of that gate directly,
 * without a real compose stack: seed, confirm the account is genuinely re-armed, confirm a login
 * with the ORIGINAL password still works but a write still 403s, then confirm clearing the flag
 * (a fresh password, `POST /auth/password` — the fix scripts/lib/clear-forced-password-change.sh
 * gives every affected script) unblocks it, exactly as scripts/e2e-m0.sh and its siblings now do.
 */
describe("loginAndSeedDemoData: leaves mustChangePassword RE-ARMED — every caller after it must clear it again", () => {
  let server: ListeningTestServer;

  beforeAll(async () => {
    server = await listenTestServer();
  });

  afterAll(async () => {
    await server.close();
  });

  it("MUTATION-CAUGHT: a script that logs in post-seed with the ORIGINAL password can read /auth/me but 403s on a write, until it clears the flag itself", async () => {
    const orgName = `seed-rearm-${Math.random().toString(36).slice(2)}`;
    const adminUsername = `admin-${Math.random().toString(36).slice(2)}`;
    const bootstrap = await ensureBootstrapAdmin(
      server.deps.db,
      { orgName, adminUsername },
      { info: () => undefined, warn: () => undefined }
    );
    const oneTimePassword = bootstrap.oneTimePassword;
    if (!oneTimePassword) throw new Error("expected a fresh one-time password");

    // Exactly what apps/server/src/main.ts hands loginAndSeedDemoData at boot — internalBaseUrl
    // overridden to the real ephemeral port this test server actually bound to.
    const config = {
      ...server.deps.config,
      internalBaseUrl: server.baseUrl,
      bootstrapAdminUsername: adminUsername,
      bootstrapOrgName: orgName
    };
    await loginAndSeedDemoData(server.deps.db, config, bootstrap, {
      info: () => undefined,
      warn: () => undefined
    });

    // The ORIGINAL printed password still works for login — seed.ts's own promise.
    const client = new ScpClient({ baseUrl: server.baseUrl });
    const login = await client.login(adminUsername, oneTimePassword);
    expect(login.token).toBeTruthy();
    const authHeader = { authorization: `Bearer ${login.token}` };

    // But it is RE-ARMED: a write 403s until this session clears it itself.
    const blocked = await server.app.inject({
      method: "POST",
      url: "/api/v1/services",
      headers: authHeader,
      payload: { name: "should-be-blocked" }
    });
    expect(blocked.statusCode, blocked.body).toBe(403);

    // The fix every scripts/e2e-*.sh now applies: clear it with a fresh password.
    const cleared = await server.app.inject({
      method: "POST",
      url: "/api/v1/auth/password",
      headers: authHeader,
      payload: {
        currentPassword: oneTimePassword,
        newPassword: `fresh-${Math.random().toString(36).slice(2)}`
      }
    });
    expect(cleared.statusCode, cleared.body).toBe(204);

    // Now unblocked, with the SAME session/token.
    const nowAllowed = await server.app.inject({
      method: "POST",
      url: "/api/v1/services",
      headers: authHeader,
      payload: { name: "now-allowed" }
    });
    expect(nowAllowed.statusCode, nowAllowed.body).toBe(201);
  });
});
