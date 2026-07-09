import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ScpClient } from "@scp/sdk";
import { createTestOrg, listenTestServer, type ListeningTestServer } from "./test-support/harness.js";
import { seedDemoData } from "./seed.js";

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

/**
 * Idempotency is non-negotiable (M2 seed spec, BUILD_AND_TEST.md §5.3): running the seed logic
 * twice in a row (mirroring "boot the server twice against the same volume") must be a true
 * no-op the second time — same object/relationship ids, no duplicates, no errors. Exercises
 * `seedDemoData` directly (not `loginAndSeedDemoData`/the standalone CLI) against a real listening
 * test server, per this file's own module doc on why that split exists.
 */
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
