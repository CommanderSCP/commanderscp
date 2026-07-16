import { performance } from "node:perf_hooks";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fc from "fast-check";
import { v7 as uuidv7 } from "uuid";
import { ScpClient } from "@scp/sdk";
import type { GraphObject, GraphQueryRequest, NamedGraphQuery } from "@scp/schemas";
import { loadConfig } from "../config.js";
import { createDb, createPool } from "../db/client.js";
import { withTenantTx } from "../db/tenant-tx.js";
import {
  createTestOrg,
  listenTestServer,
  RawScpAppClient,
  testDatabaseUrl,
  testPgBossDatabaseUrl,
  testRuntimeDatabaseUrl,
  type ListeningTestServer
} from "../test-support/harness.js";
import { runNamedQuery } from "./named-queries.js";

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
    serviceInDomain = await client
      .object("service")
      .create({ name: "in-domain-service", domainId: domain.id });

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
    expect(ids.has(first.id), "chain[0] (11th hop) must be excluded by the depth-10 default").toBe(
      false
    );
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
    const result = await client.graph.query("impact-of", {
      objectId: cycleA.id,
      relTypes: ["depends_on"]
    });
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
    await client.relationships.create({
      typeId: "depends_on",
      fromId: serviceInDomain.id,
      toId: consumed.id
    });
    const result = await client.graph.query("domains-impacted", {
      objectId: consumed.id,
      relTypes: ["depends_on", "consumes"]
    });
    expect(Object.keys(result.counts ?? {}).length).toBeGreaterThan(0);
  });

  it("blast-radius: domain grouping matches domains-impacted (nearest-domain ancestor, keyed by URN — not the immediate parent)", async () => {
    // A closure MIXING an object whose immediate parent IS a domain (`serviceInDomain`, domainId =
    // payments-domain) with objects whose immediate parent is the org root ORGANIZATION (a default
    // service). The old single-hop blast-radius keyed the latter by `domain:${orgRootUuid}` —
    // labeling the organization a "domain" and keying by a raw uuid — while domains-impacted rolled
    // it to the org's URN. The two "count by domain" queries disagreed; they must now agree.
    const seed = await client.object("service").create({ name: "br-seed" });
    const orgSvc = await client.object("service").create({ name: "br-org-svc" }); // domainId → org root
    // orgSvc and serviceInDomain are both impacted if seed changes (they depend_on it)
    await client.relationships.create({ typeId: "depends_on", fromId: orgSvc.id, toId: seed.id });
    await client.relationships.create({
      typeId: "depends_on",
      fromId: serviceInDomain.id,
      toId: seed.id
    });

    const relTypes = ["depends_on", "consumes"];
    const blast = await client.graph.query("blast-radius", { objectId: seed.id, relTypes });
    const impacted = await client.graph.query("domains-impacted", { objectId: seed.id, relTypes });

    // The domain sub-map of blast-radius (its `domain:`-prefixed keys) must equal domains-impacted's
    // grouping exactly — same buckets, same counts. Under the old single-hop code the keys were raw
    // uuids, so this deep-equal fails.
    const blastDomains = Object.fromEntries(
      Object.entries(blast.counts ?? {})
        .filter(([k]) => k.startsWith("domain:"))
        .map(([k, v]) => [k.slice("domain:".length), v])
    );
    expect(Object.keys(blastDomains).length).toBeGreaterThan(0);
    expect(blastDomains).toEqual(impacted.counts);

    // And specifically NOT keyed by the raw immediate-parent uuid: `seed`'s own domainId is the org
    // root uuid, which the fixed code rolls to the org URN — so `domain:${seed.domainId}` (a uuid)
    // must be absent. This is the precise anti-single-hop assertion.
    expect(blast.counts?.[`domain:${seed.domainId}`]).toBeUndefined();
  });

  it("paths-between: finds a multi-hop path across mixed relationship types", async () => {
    const result = await client.graph.query("paths-between", {
      objectId: pathA.id,
      targetId: pathC.id
    });
    expect(result.paths && result.paths.length).toBeGreaterThan(0);
    const path = result.paths?.[0];
    expect(path?.[0]).toBe(pathA.id);
    expect(path?.[path.length - 1]).toBe(pathC.id);
    expect(path).toContain(pathB.id);
  });

  it("paths-between: returns no paths between disconnected objects", async () => {
    const result = await client.graph.query("paths-between", {
      objectId: pathA.id,
      targetId: isolated.id
    });
    expect(result.paths ?? []).toHaveLength(0);
  });

  it("graph/traverse: bounded induced subgraph around a node", async () => {
    const result = await client.graph.traverse({
      objectId: pathB.id,
      direction: "both",
      maxDepth: 1
    });
    const ids = result.objects.map((o) => o.id);
    expect(ids).toContain(pathA.id);
    expect(ids).toContain(pathB.id);
    expect(ids).toContain(pathC.id);
  });
});

/** The five reachability named queries — all backed by named-queries.ts's shared
 *  `transitiveReverseClosure` — plus a per-org test helper shared by the property test and the
 *  perf-regression test below. */
const REACHABILITY_QUERIES: NamedGraphQuery[] = [
  "dependents-of",
  "consumers-of",
  "impact-of",
  "blast-radius",
  "domains-impacted"
];

/**
 * Builds a `{db, raw}` pair against the shared Testcontainers Postgres, bypassing the HTTP/auth
 * layer entirely (same technique as `load-test/graph-scale.ts` and
 * `query-timeout.integration.test.ts`'s bulk-insert test) — this suite calls `runNamedQuery`
 * directly, so it needs neither a listening server nor an admin token, only a tenant `db` handle
 * (`withTenantTx`) and a raw `scp_app`-authenticated connection for bulk `INSERT ... unnest(...)`
 * (drizzle's own `sql` tag can't bind a real array parameter — see graph/sql-helpers.ts's doc
 * comment — so bulk loads always go through `RawScpAppClient` instead, exactly as production's own
 * load-test script does).
 */
function directDbHandle() {
  const config = loadConfig({
    DATABASE_URL: testDatabaseUrl(),
    SCP_RUNTIME_DATABASE_URL: testRuntimeDatabaseUrl(),
    SCP_PGBOSS_DATABASE_URL: testPgBossDatabaseUrl(),
    SCP_COOKIE_SECRET: "test-cookie-secret-value"
  });
  const pool = createPool(config.runtimeDatabaseUrl);
  const db = createDb(pool);
  return { db, pool };
}

/**
 * Bulk-inserts `nodeIds.length` `service` objects and one `depends_on` relationship per
 * `edges` pair (deduped — `relationships_org_type_from_to_key` is a unique constraint) directly
 * against the tables, bypassing `graph/objects-repo.ts`/`graph/relationships-repo.ts` (audit/
 * journal/outbox writes are irrelevant here — same rationale as `load-test/graph-scale.ts`'s
 * module doc). `domain_id` is left `NULL` (no FK on that column) since these tests call
 * `runNamedQuery` directly and never go through `authorize()`/RBAC scope resolution.
 */
async function bulkLoadGraph(
  raw: RawScpAppClient,
  orgId: string,
  nodeIds: string[],
  edges: { from: number; to: number }[]
): Promise<void> {
  await raw.setOrgContext(orgId);
  const originDomainId = uuidv7();
  const names = nodeIds.map((id, i) => `node-${i}-${id}`);
  const urns = nodeIds.map((id) => `urn:scp:test:service:${id}`);
  await raw.query(
    `INSERT INTO objects
       (id, org_id, domain_id, type_id, name, urn, properties, labels, origin_domain_id,
        revision, content_hash, version)
     SELECT t.id, $4::uuid, NULL, 'service', t.name, t.urn, '{}'::jsonb, '{}'::jsonb,
            $5::uuid, 1, md5(t.id::text), 1
     FROM unnest($1::uuid[], $2::text[], $3::text[]) AS t(id, name, urn)`,
    [nodeIds, names, urns, orgId, originDomainId]
  );

  // Dedupe (from, to) pairs — the unique constraint would otherwise reject a repeated edge.
  const seen = new Set<string>();
  const uniqueEdges = edges.filter(({ from, to }) => {
    const key = `${from}:${to}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (uniqueEdges.length === 0) return;

  const edgeIds = uniqueEdges.map(() => uuidv7());
  const fromIds = uniqueEdges.map((e) => nodeIds[e.from]!);
  const toIds = uniqueEdges.map((e) => nodeIds[e.to]!);
  await raw.query(
    `INSERT INTO relationships
       (id, org_id, type_id, from_id, to_id, properties, labels, origin_domain_id, revision, content_hash)
     SELECT t.id, $4::uuid, 'depends_on', t.from_id, t.to_id, '{}'::jsonb, '{}'::jsonb,
            $5::uuid, 1, md5(t.id::text)
     FROM unnest($1::uuid[], $2::uuid[], $3::uuid[]) AS t(id, from_id, to_id)`,
    [edgeIds, fromIds, toIds, orgId, originDomainId]
  );
}

/**
 * Plain-TypeScript reference oracle: "which node indices are within `maxDepth` hops of `startIdx`
 * walking `edges` BACKWARD" (i.e. node `p` counts if `p depends_on frontier-member` — the exact
 * relation `transitiveReverseClosure` walks). A textbook visited-set BFS — deliberately NOT
 * mirroring named-queries.ts's SQL mechanics (no `(id, depth)` re-expansion) — except for one
 * genuine semantic rule the SQL enforces on purpose and this oracle must match: `startIdx` itself
 * can only appear via a DIRECT edge into itself (self-loop, depth 1); it can never re-enter via a
 * longer cycle (depth ≥ 2) — see `transitiveReverseClosure`'s doc comment for why. Everything else
 * about *how* the SQL internally re-visits nodes is irrelevant to the final node SET this oracle
 * checks against (proved in that same doc comment).
 */
function naiveReachableSet(
  edges: { from: number; to: number }[],
  startIdx: number,
  maxDepth: number
): Set<number> {
  const preds = new Map<number, number[]>();
  for (const { from, to } of edges) {
    const list = preds.get(to);
    if (list) list.push(from);
    else preds.set(to, [from]);
  }

  const visited = new Set<number>();
  let frontier = new Set<number>([startIdx]);
  for (let depth = 1; depth <= maxDepth && frontier.size > 0; depth++) {
    const next = new Set<number>();
    for (const node of frontier) {
      for (const p of preds.get(node) ?? []) {
        if (depth > 1 && p === startIdx) continue; // never re-enter start except at depth 1
        if (!visited.has(p)) next.add(p);
      }
    }
    for (const p of next) visited.add(p);
    frontier = next;
  }
  return visited;
}

/**
 * BUILD_AND_TEST.md §8 M9 item: property-based proof that the M9.1 node-dedup rewrite of
 * `transitiveReverseClosure` (named-queries.ts) preserves exact output semantics — the returned
 * node SET, for every one of the five reachability named queries, must equal a naive BFS computed
 * independently in plain TypeScript, across randomly generated directed graphs that deliberately
 * include cycles (a node pointing back into its own ancestry) and shared-component fan-in
 * (several nodes converging on one common node) — precisely the topology shape that used to blow
 * up (see this file's sibling `query-timeout.integration.test.ts` and named-queries.ts's own doc
 * comment).
 */
describe("named graph queries: property test — reachability-CTE dedup preserves semantics", () => {
  it("all five reachability queries agree with a naive BFS oracle on random graphs (cycles + fan-in included)", async () => {
    const { db, pool } = directDbHandle();
    const raw = await RawScpAppClient.connect();
    try {
      const graphArb = fc
        .integer({ min: 3, max: 12 })
        .chain((numNodes) =>
          fc.record({
            numNodes: fc.constant(numNodes),
            // Deliberately dense relative to numNodes (up to 4x) to make convergence/fan-in and
            // cycles likely, not just occasional — a sparse random graph rarely exercises the
            // pathological shape this fix targets.
            edges: fc.array(
              fc.record({
                from: fc.nat({ max: numNodes - 1 }),
                to: fc.nat({ max: numNodes - 1 })
              }),
              { minLength: 0, maxLength: numNodes * 4 }
            ),
            startIdx: fc.nat({ max: numNodes - 1 }),
            maxDepth: fc.integer({ min: 1, max: 10 })
          })
        );

      await fc.assert(
        fc.asyncProperty(graphArb, async ({ numNodes, edges, startIdx, maxDepth }) => {
          const orgId = uuidv7();
          const nodeIds = Array.from({ length: numNodes }, () => uuidv7());
          await bulkLoadGraph(raw, orgId, nodeIds, edges);

          const expectedIdx = naiveReachableSet(edges, startIdx, maxDepth);
          const expectedIds = new Set([...expectedIdx].map((i) => nodeIds[i]!));

          const startId = nodeIds[startIdx]!;
          const params: GraphQueryRequest = {
            objectId: startId,
            relTypes: ["depends_on"],
            maxDepth
          };

          for (const queryName of REACHABILITY_QUERIES) {
            const result = await withTenantTx(db, orgId, (tx) =>
              runNamedQuery(tx, orgId, queryName, params)
            );
            const actualIds = new Set(result.objects.map((o) => o.id));
            expect(actualIds, `${queryName} (maxDepth=${maxDepth}) mismatched the naive BFS oracle`).toEqual(
              expectedIds
            );
          }
        }),
        { numRuns: 75 }
      );
    } finally {
      await raw.close();
      await pool.end();
    }
  }, 120_000);
});

/**
 * BUILD_AND_TEST.md §8 M9 item: performance-regression proof that the M9.1 fix actually removed
 * the blowup, not merely relocated it. Builds the exact pathological SHAPE that used to run 7+
 * minutes before exhausting disk (this suite's sibling `query-timeout.integration.test.ts` module
 * doc, and named-queries.ts's own doc comment): wide fan-in AND, on top of that, genuine
 * multi-depth convergence on the very same shared nodes (via extra "skip" edges spanning two
 * layers at once) — the specific case named-queries.ts's doc comment calls out as the one residual
 * (but bounded, not exponential) source of duplicate rows post-fix. Every one of the five
 * reachability queries must complete in a small fraction of the configured `statement_timeout`
 * (the M8 guardrail — deliberately left untouched, see query-timeout.ts) with the correct closure.
 */
describe("named graph queries: performance regression — high fan-in no longer blows up (M9.1)", () => {
  it("wide fan-in with multi-depth reconvergence on shared components completes fast for all five reachability queries", async () => {
    const { db, pool } = directDbHandle();
    const raw = await RawScpAppClient.connect();
    try {
      const orgId = uuidv7();
      // 14 nodes/layer x 10 layers: complete bipartite between CONSECUTIVE layers (the shape that
      // alone used to blow up), PLUS complete bipartite "skip" edges from layer i to layer i+2 —
      // every node in layers 0..7 is now reachable from the last layer via (at least) two
      // different-length routes, forcing genuine same-node-different-depth reconvergence, not
      // just same-depth fan-in.
      const WIDTH = 14;
      const LAYERS = 10;
      const layerIds: string[][] = [];
      for (let layer = 0; layer < LAYERS; layer++) {
        layerIds.push(Array.from({ length: WIDTH }, () => uuidv7()));
      }
      const allNodeIds = layerIds.flat();
      const edges: { from: number; to: number }[] = [];
      const idxOf = new Map(allNodeIds.map((id, i) => [id, i]));
      const idx = (id: string) => idxOf.get(id)!;
      for (let layer = 0; layer < LAYERS - 1; layer++) {
        for (const from of layerIds[layer]!) {
          for (const to of layerIds[layer + 1]!) edges.push({ from: idx(from), to: idx(to) });
        }
      }
      for (let layer = 0; layer < LAYERS - 2; layer++) {
        for (const from of layerIds[layer]!) {
          for (const to of layerIds[layer + 2]!) edges.push({ from: idx(from), to: idx(to) });
        }
      }
      await bulkLoadGraph(raw, orgId, allNodeIds, edges);

      const targetId = layerIds[LAYERS - 1]![0]!;
      const maxDepth = LAYERS - 1; // schema-capped at 10 (packages/schemas/src/graph.ts)
      const expectedCount = WIDTH * (LAYERS - 1); // every node in layers 0..LAYERS-2

      for (const queryName of REACHABILITY_QUERIES) {
        const params: GraphQueryRequest = {
          objectId: targetId,
          relTypes: ["depends_on"],
          maxDepth
        };
        const start = performance.now();
        const result = await withTenantTx(db, orgId, (tx) => runNamedQuery(tx, orgId, queryName, params));
        const elapsedMs = performance.now() - start;

        expect(result.objects, `${queryName} returned the wrong node set`).toHaveLength(expectedCount);
        expect(new Set(result.objects.map((o) => o.id)).size).toBe(expectedCount); // no duplicates
        // Comfortably fast — the old path-array implementation running this exact shape measured
        // 7+ minutes / disk exhaustion (M8 PR body); well under the 5s production
        // statement_timeout default (config.ts) proves the fix, not just a wider safety margin.
        expect(elapsedMs, `${queryName} took too long (${elapsedMs}ms)`).toBeLessThan(2_000);
      }
    } finally {
      await raw.close();
      await pool.end();
    }
  }, 30_000);
});
