import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ScpClient } from "@scp/sdk";
import {
  createTestComponent,
  createTestOrg,
  listenTestServer,
  type ListeningTestServer,
  type TestOrg
} from "../test-support/harness.js";

/** `originDomainId` is a new additive wire field. See docs/coordination.md §261. */
describe("Change.originDomainId (M16.3 P2): the SDK-reachable single-writer-authority field", () => {
  let server: ListeningTestServer;
  let org: TestOrg;
  let admin: ScpClient;

  beforeAll(async () => {
    server = await listenTestServer();
    org = await createTestOrg(server, "change-origin-domain");
    admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
  });

  afterAll(async () => {
    await server?.close();
  });

  it("a locally-proposed change's originDomainId is this instance's own federation domain id", async () => {
    const component = await createTestComponent(admin, {
      name: `origin-domain-${randomUUID().slice(0, 8)}`
    });
    const change = await admin.changes.propose({
      name: "origin-domain v1",
      targets: [component.id]
    });

    const self = await admin.federation.self();
    expect(change.originDomainId).toBe(self.domainId);

    // Round-trips identically on a fresh GET, not just the propose response.
    const fetched = await admin.changes.get(change.id);
    expect(fetched.originDomainId).toBe(self.domainId);
  });
});
