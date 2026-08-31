import { randomUUID } from "node:crypto";
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
 * ================================================================================================
 * GRAPH READS HONOUR object:read (role-model.md §8.6a — the enumeration bypass)
 * ================================================================================================
 * `graph:query` authorizes whether a traversal may RUN from a root; it does NOT constrain the RESULT
 * SET, which the org-only queries returned in full. So a component-scoped principal could read its
 * PARENT SERVICE and SIBLINGS via `/graph/traverse` / `/graph/subgraph` / a named query — the exact
 * horizontal read `GET /objects/{type}/{id}` refuses for that same principal. routes/graph.ts now
 * resolves the caller's `object:read` set (the SAME production door every list uses) and intersects
 * every returned object/edge/path with it.
 *
 * Fixture: service --contains--> compA, service --contains--> compB (two siblings under one service).
 *
 * ------------------------------------------------------------------------------------------------
 * MUTATION LOG (each applied ALONE against a passing suite, then reverted)
 * ------------------------------------------------------------------------------------------------
 * | Mutation | Result |
 * |---|---|
 * | routes/graph.ts: pass `null` instead of the resolved set to `traverse` | the component-scoped traverse case FAILS — the parent service + sibling reappear in `objects` |
 * | traverse.ts: return `{objects, edges}` before the `readableIds` intersection | same case FAILS — sibling/parent leak back |
 * | traverse.ts subgraph: drop the both-endpoints-readable filter | the subgraph case FAILS — the service-touching `contains` edges come back |
 */
describe("graph read-scoping (role-model.md §8.6a)", () => {
  let server: ListeningTestServer;
  let org: TestOrg;
  let admin: ScpClient;
  let serviceId: string;
  let compA: string;
  let compB: string;

  const uniq = (p: string) => `${p}-${randomUUID().slice(0, 8)}`;

  beforeAll(async () => {
    server = await listenTestServer();
    org = await createTestOrg(server, "graph-read-scope");
    admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });

    const domain = (await admin.object("domain").create({ name: uniq("domain") })).id;
    serviceId = (await admin.object("service").create({ name: uniq("service"), domainId: domain }))
      .id;
    compA = (await createOrphanComponent(server, org, uniq("comp-a"))).id;
    compB = (await createOrphanComponent(server, org, uniq("comp-b"))).id;
    await admin.relationships.create({ typeId: "contains", fromId: serviceId, toId: compA });
    await admin.relationships.create({ typeId: "contains", fromId: serviceId, toId: compB });
  }, 120_000);

  afterAll(async () => {
    await server?.close();
  });

  /** A Viewer (graph:query + object:read) bound at exactly `scope`, as its own SDK client. */
  const clientBoundAt = async (scope: string): Promise<ScpClient> => {
    const user = await createTestUser(server, org, [{ role: "Viewer", scope }]);
    return new ScpClient({ baseUrl: server.baseUrl, token: user.token });
  };

  it("CONTROL: an org-root Viewer traversing from a component still sees the parent service + sibling", async () => {
    const orgViewer = await clientBoundAt(org.orgId);
    const res = await orgViewer.graph.traverse({
      objectId: compA,
      direction: "both",
      maxDepth: 10
    });
    const seen = new Set(res.objects.map((o) => o.id));
    expect(seen.has(compA)).toBe(true);
    expect(seen.has(serviceId)).toBe(true); // org-root reader is unfiltered (readable set is null)
    expect(seen.has(compB)).toBe(true);
  });

  it("a component-scoped Viewer's traverse never returns the parent service or a sibling", async () => {
    const compViewer = await clientBoundAt(compA);
    const res = await compViewer.graph.traverse({
      objectId: compA,
      direction: "both",
      maxDepth: 10
    });
    const seen = new Set(res.objects.map((o) => o.id));
    expect(seen.has(compA)).toBe(true); // its own component is readable
    expect(seen.has(serviceId)).toBe(false); // parent service — the bypass this closes
    expect(seen.has(compB)).toBe(false); // sibling under the same service
    // and no returned edge names a non-readable endpoint
    expect(res.edges.every((e) => seen.has(e.fromId) && seen.has(e.toId))).toBe(true);
  });

  it("a component-scoped Viewer's subgraph drops edges whose endpoints it cannot read", async () => {
    const compViewer = await clientBoundAt(compA);
    // Both `contains` edges touch the (non-readable) service, so neither may come back — a caller
    // cannot use a supplied id set to enumerate edges among objects it lacks object:read on.
    const res = await compViewer.graph.subgraph({
      objectId: compA,
      ids: [compA, serviceId, compB]
    });
    expect(res.edges).toEqual([]);
  });
});
