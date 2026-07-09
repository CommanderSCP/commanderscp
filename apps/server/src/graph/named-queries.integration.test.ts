import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ScpClient } from "@scp/sdk";
import type { GraphObject } from "@scp/schemas";
import { createTestOrg, listenTestServer, type ListeningTestServer } from "../test-support/harness.js";

/**
 * BUILD_AND_TEST.md §8 M1 DoD (c): "named queries return correct transitive closures on a
 * seeded fixture graph, including cycle handling and depth limits" (DESIGN.md §5).
 */
describe("named graph queries: fixture graph", () => {
  let server: ListeningTestServer;
  let client: ScpClient;

  // Chain fixture: chain[0] depends_on chain[1] depends_on ... depends_on chain[10] (11 edges).
  let chain: GraphObject[];
  // Cycle fixture: cycleA depends_on cycleB depends_on cycleA.
  let cycleA: GraphObject;
  let cycleB: GraphObject;
  // Containment fixture: team owns domain; service lives in that domain.
  let team: GraphObject;
  let domain: GraphObject;
  let serviceInDomain: GraphObject;
  // Consumer fixture.
  let consumer: GraphObject;
  let consumed: GraphObject;
  // Paths-between fixture: pathA -[depends_on]-> pathB -[consumes]-> pathC.
  let pathA: GraphObject;
  let pathB: GraphObject;
  let pathC: GraphObject;
  let isolated: GraphObject;

  beforeAll(async () => {
    server = await listenTestServer();
    const org = await createTestOrg(server, "named-queries");
    client = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });

    const mkService = (name: string) => client.object("service").create({ name });
    const dependsOn = (fromId: string, toId: string) =>
      client.relationships.create({ typeId: "depends_on", fromId, toId });
    const consumes = (fromId: string, toId: string) =>
      client.relationships.create({ typeId: "consumes", fromId, toId });

    chain = [];
    for (let i = 0; i < 12; i++) chain.push(await mkService(`chain-${i}`));
    for (let i = 0; i < chain.length - 1; i++) {
      const from = chain[i];
      const to = chain[i + 1];
      if (from && to) await dependsOn(from.id, to.id);
    }

    cycleA = await mkService("cycle-a");
    cycleB = await mkService("cycle-b");
    await dependsOn(cycleA.id, cycleB.id);
    await dependsOn(cycleB.id, cycleA.id);

    team = await client.object("team").create({ name: "platform-team" });
    domain = await client.object("domain").create({ name: "payments-domain" });
    await client.relationships.create({ typeId: "owns", fromId: team.id, toId: domain.id });
    serviceInDomain = await client.object("service").create({ name: "in-domain-service", domainId: domain.id });

    consumer = await mkService("consumer");
    consumed = await mkService("consumed");
    await consumes(consumer.id, consumed.id);

    pathA = await mkService("path-a");
    pathB = await mkService("path-b");
    pathC = await mkService("path-c");
    await dependsOn(pathA.id, pathB.id);
    await consumes(pathB.id, pathC.id);

    isolated = await mkService("isolated");
  });

  afterAll(async () => {
    await server.close();
  });

  it("dependents-of: transitive closure across a chain, default depth limit excludes the 11th hop", async () => {
    const last = chain[chain.length - 1];
    if (!last) throw new Error("fixture chain is empty");
    const result = await client.graph.query("dependents-of", { objectId: last.id });
    const ids = new Set(result.objects.map((o) => o.id));

    // chain[11] is the target; chain[1..10] are within 10 hops (depth 1..10); chain[0] is the
    // 11th hop and must be excluded by the default maxDepth=10.
    for (let i = 1; i <= 10; i++) {
      const node = chain[i];
      if (!node) throw new Error(`missing chain[${i}]`);
      expect(ids.has(node.id), `chain[${i}] should be in the closure`).toBe(true);
    }
    const first = chain[0];
    if (!first) throw new Error("missing chain[0]");
    expect(ids.has(first.id), "chain[0] (11th hop) must be excluded by the depth-10 default").toBe(false);
    expect(ids.has(last.id), "the target itself is not included").toBe(false);
  });

  it("respects an explicit maxDepth override", async () => {
    const last = chain[chain.length - 1];
    if (!last) throw new Error("fixture chain is empty");
    const result = await client.graph.query("dependents-of", { objectId: last.id, maxDepth: 3 });
    const ids = new Set(result.objects.map((o) => o.id));
    for (let i = 9; i <= 10; i++) {
      const node = chain[i];
      if (node) expect(ids.has(node.id)).toBe(true);
    }
    const tooFar = chain[7];
    if (tooFar) expect(ids.has(tooFar.id)).toBe(false);
  });

  it("impact-of: handles a two-node cycle without infinite recursion or duplicates", async () => {
    const result = await client.graph.query("impact-of", { objectId: cycleA.id, relTypes: ["depends_on"] });
    const ids = result.objects.map((o) => o.id);
    expect(new Set(ids).size).toBe(ids.length); // no duplicates
    expect(ids).toContain(cycleB.id);
  });

  it("owners-of: direct + via containment", async () => {
    const result = await client.graph.query("owners-of", { objectId: serviceInDomain.id });
    const ids = result.objects.map((o) => o.id);
    expect(ids).toContain(team.id);
  });

  it("consumers-of: reverse consumes", async () => {
    const result = await client.graph.query("consumers-of", { objectId: consumed.id });
    const ids = result.objects.map((o) => o.id);
    expect(ids).toContain(consumer.id);
  });

  it("blast-radius: counts by type", async () => {
    const last = chain[chain.length - 1];
    if (!last) throw new Error("fixture chain is empty");
    const result = await client.graph.query("blast-radius", { objectId: last.id });
    expect(result.counts).toBeDefined();
    expect(result.counts?.["type:service"]).toBeGreaterThanOrEqual(10);
  });

  it("domains-impacted: groups the closure by containing domain", async () => {
    await client.relationships.create({ typeId: "depends_on", fromId: serviceInDomain.id, toId: consumed.id });
    const result = await client.graph.query("domains-impacted", {
      objectId: consumed.id,
      relTypes: ["depends_on", "consumes"]
    });
    expect(Object.keys(result.counts ?? {}).length).toBeGreaterThan(0);
  });

  it("paths-between: finds a multi-hop path across mixed relationship types", async () => {
    const result = await client.graph.query("paths-between", { objectId: pathA.id, targetId: pathC.id });
    expect(result.paths && result.paths.length).toBeGreaterThan(0);
    const path = result.paths?.[0];
    expect(path?.[0]).toBe(pathA.id);
    expect(path?.[path.length - 1]).toBe(pathC.id);
    expect(path).toContain(pathB.id);
  });

  it("paths-between: returns no paths between disconnected objects", async () => {
    const result = await client.graph.query("paths-between", { objectId: pathA.id, targetId: isolated.id });
    expect(result.paths ?? []).toHaveLength(0);
  });

  it("graph/traverse: bounded induced subgraph around a node", async () => {
    const result = await client.graph.traverse({ objectId: pathB.id, direction: "both", maxDepth: 1 });
    const ids = result.objects.map((o) => o.id);
    expect(ids).toContain(pathA.id);
    expect(ids).toContain(pathB.id);
    expect(ids).toContain(pathC.id);
  });
});
