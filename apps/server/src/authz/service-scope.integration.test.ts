import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ScpClient } from "@scp/sdk";
import {
  createOrphanComponent,
  createTestOrg,
  createTestUser,
  listenTestServer,
  type ListeningTestServer,
  type TestOrg
} from "../test-support/harness.js";

/**
 * Service-scoped RBAC (model P2 — docs/proposals/service-component-model.md; the `contains` edge is
 * migration 0021). DESIGN §7 has always documented the containment chain as
 * `component -> service -> domain -> organization`, but until now `authz/resolve.ts` walked
 * `objects.domain_id` ONLY — components and services are siblings under a domain, so a service-scoped
 * role binding reached NOTHING. The claim was real; the behaviour was not.
 *
 * This is an AUTHORIZATION change, so these tests are the gate. They must prove three things, and the
 * last two matter more than the first — a too-permissive walk is a privilege-escalation bug:
 *
 *   1. a binding at a SERVICE reaches its components (the new capability);
 *   2. a binding at a COMPONENT does NOT reach the service (no upward leak);
 *   3. a binding at a COMPONENT does NOT reach a SIBLING component (no lateral leak).
 *
 * The asymmetry is structural: `contains` is registered service -> component, and the walk follows it
 * backwards (to_id -> from_id), so a service is an ancestor of its components and never the reverse.
 */
describe("RBAC: a service-scoped binding reaches its components (and nothing else)", () => {
  let server: ListeningTestServer;
  let org: TestOrg;
  let admin: ScpClient;
  let svcId: string;
  let otherSvcId: string;
  let compId: string;
  let siblingId: string;
  let loneCompId: string;

  beforeAll(async () => {
    server = await listenTestServer();
    org = await createTestOrg(server, "svc-scope");
    admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });

    const svc = await admin.object("service").create({ name: "payments" });
    const other = await admin.object("service").create({ name: "identity" });
    const comp = await createOrphanComponent(admin, "payments-api");
    const sibling = await createOrphanComponent(admin, "payments-worker");
    const lone = await createOrphanComponent(admin, "unassigned-import");
    svcId = svc.id;
    otherSvcId = other.id;
    compId = comp.id;
    siblingId = sibling.id;
    loneCompId = lone.id;

    await admin.relationships.create({ typeId: "contains", fromId: svcId, toId: compId });
    await admin.relationships.create({ typeId: "contains", fromId: svcId, toId: siblingId });
  });

  afterAll(async () => {
    await server?.close();
  });

  it("GRANTS: a role bound at the service reaches a component inside it", async () => {
    // Operator @ the SERVICE only — no binding on the component itself.
    const user = await createTestUser(server, org, [{ role: "Operator", scope: svcId }]);
    const client = new ScpClient({ baseUrl: server.baseUrl, token: user.token });

    // object:write at the component's scope, granted purely via the `contains` edge.
    const updated = await client.components.update(compId, { labels: { tier: "gold" } });
    expect(updated.labels).toMatchObject({ tier: "gold" });
  });

  it("GRANTS: the same binding reaches EVERY component the service contains", async () => {
    const user = await createTestUser(server, org, [{ role: "Operator", scope: svcId }]);
    const client = new ScpClient({ baseUrl: server.baseUrl, token: user.token });
    await expect(
      client.components.update(siblingId, { labels: { tier: "silver" } })
    ).resolves.toBeTruthy();
  });

  it("DENIES (no upward leak): a role bound at a COMPONENT does not reach its service", async () => {
    const user = await createTestUser(server, org, [{ role: "Operator", scope: compId }]);
    const client = new ScpClient({ baseUrl: server.baseUrl, token: user.token });
    // The service is not below the component — `contains` is walked to_id -> from_id, never the reverse.
    await expect(
      client.object("service").update(svcId, { labels: { hacked: "yes" } })
    ).rejects.toThrow(/forbidden/i);
  });

  it("DENIES (no lateral leak): a role bound at a COMPONENT does not reach a SIBLING component", async () => {
    const user = await createTestUser(server, org, [{ role: "Operator", scope: compId }]);
    const client = new ScpClient({ baseUrl: server.baseUrl, token: user.token });
    await expect(
      client.components.update(siblingId, { labels: { hacked: "yes" } })
    ).rejects.toThrow(/forbidden/i);
  });

  it("DENIES: a binding at ANOTHER service does not reach this service's components", async () => {
    const user = await createTestUser(server, org, [{ role: "Operator", scope: otherSvcId }]);
    const client = new ScpClient({ baseUrl: server.baseUrl, token: user.token });
    await expect(
      client.components.update(compId, { labels: { hacked: "yes" } })
    ).rejects.toThrow(/forbidden/i);
  });

  it("DENIES: a service-scoped binding does not reach an UNASSIGNED component (no contains edge)", async () => {
    // The orphan-import case: until someone assigns it, no service governs it.
    const user = await createTestUser(server, org, [{ role: "Operator", scope: svcId }]);
    const client = new ScpClient({ baseUrl: server.baseUrl, token: user.token });
    await expect(
      client.components.update(loneCompId, { labels: { tier: "gold" } })
    ).rejects.toThrow(/forbidden/i);
  });

  it("re-assigning a component moves the grant with it", async () => {
    // organize-after: move the component to `identity`, and the payments binding must stop reaching it.
    const moved = await createOrphanComponent(admin, "roaming-api");
    const edge = await admin.relationships.create({
      typeId: "contains",
      fromId: svcId,
      toId: moved.id
    });

    const payments = await createTestUser(server, org, [{ role: "Operator", scope: svcId }]);
    const paymentsClient = new ScpClient({ baseUrl: server.baseUrl, token: payments.token });
    await expect(
      paymentsClient.components.update(moved.id, { labels: { a: "1" } })
    ).resolves.toBeTruthy();

    await admin.relationships.delete(edge.id);
    await admin.relationships.create({ typeId: "contains", fromId: otherSvcId, toId: moved.id });

    // The old service must no longer reach it — a stale grant here would be the real bug.
    await expect(
      paymentsClient.components.update(moved.id, { labels: { b: "2" } })
    ).rejects.toThrow(/forbidden/i);

    const identity = await createTestUser(server, org, [{ role: "Operator", scope: otherSvcId }]);
    const identityClient = new ScpClient({ baseUrl: server.baseUrl, token: identity.token });
    await expect(
      identityClient.components.update(moved.id, { labels: { c: "3" } })
    ).resolves.toBeTruthy();
  });

  it("a soft-deleted `contains` edge stops conferring the grant", async () => {
    const comp = await createOrphanComponent(admin, "temp-api");
    const edge = await admin.relationships.create({
      typeId: "contains",
      fromId: svcId,
      toId: comp.id
    });
    const user = await createTestUser(server, org, [{ role: "Operator", scope: svcId }]);
    const client = new ScpClient({ baseUrl: server.baseUrl, token: user.token });
    await expect(client.components.update(comp.id, { labels: { x: "1" } })).resolves.toBeTruthy();

    await admin.relationships.delete(edge.id);
    // The walk filters `deleted_at IS NULL`; a deleted edge conferring authz would be a real hole.
    await expect(
      client.components.update(comp.id, { labels: { y: "2" } })
    ).rejects.toThrow(/forbidden/i);
  });
});
