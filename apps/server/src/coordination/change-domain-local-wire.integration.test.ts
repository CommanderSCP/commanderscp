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

/** M20-A3 (ADR-0031 §5, docs/proposals/outpost-ui.md). See docs/coordination.md §260. */
describe("Change.domainLocal (M20-A3): the SDK-reachable wire field", () => {
  let server: ListeningTestServer;
  let org: TestOrg;
  let admin: ScpClient;

  const uniq = (p: string) => `${p}-${randomUUID().slice(0, 8)}`;

  beforeAll(async () => {
    server = await listenTestServer();
    org = await createTestOrg(server, "change-domain-local-wire");
    admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
  });

  afterAll(async () => {
    await server?.close();
  });

  it("a change proposed against a domain-local component reports domainLocal: true, on propose AND on a fresh GET", async () => {
    const component = await createTestComponent(admin, {
      name: uniq("local-component"),
      domainLocal: true
    });
    expect(component.domainLocal).toBe(true);

    const change = await admin.changes.propose({
      name: "domain-local wire v1",
      targets: [component.id]
    });
    expect(change.domainLocal).toBe(true);

    const fetched = await admin.changes.get(change.id);
    expect(fetched.domainLocal).toBe(true);
  });

  it("CONTROL: a change proposed against an ORDINARY (shared) component reports domainLocal: false", async () => {
    const component = await createTestComponent(admin, { name: uniq("shared-component") });
    expect(component.domainLocal).toBe(false);

    const change = await admin.changes.propose({
      name: "shared wire v1",
      targets: [component.id]
    });
    expect(change.domainLocal).toBe(false);

    const fetched = await admin.changes.get(change.id);
    expect(fetched.domainLocal).toBe(false);
  });
});
