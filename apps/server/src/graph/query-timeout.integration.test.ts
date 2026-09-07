import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { createDb, createPool } from "../db/client.js";
import { withTenantTx } from "../db/tenant-tx.js";
import {
  createTestOrg,
  RawScpAppClient,
  testDatabaseUrl,
  testPgBossDatabaseUrl,
  testRuntimeDatabaseUrl,
  type TestServer
} from "../test-support/harness.js";
import { getOrgRootObjectId } from "./objects-repo.js";
import { GraphQueryTimeoutError, withStatementTimeout } from "./query-timeout.js";

/** Defensive graph guardrail (adversarial review of PR #15). See docs/graph.md §153. */
describe("graph query statement_timeout guardrail", () => {
  it("withStatementTimeout: a genuinely slow statement is cancelled near the configured bound, not left to run to completion — and the error is GraphQueryTimeoutError, not a raw driver error", async () => {
    const config = loadConfig({
      DATABASE_URL: testDatabaseUrl(),
      SCP_RUNTIME_DATABASE_URL: testRuntimeDatabaseUrl(),
      SCP_PGBOSS_DATABASE_URL: testPgBossDatabaseUrl(),
      SCP_COOKIE_SECRET: "test-cookie-secret-value"
    });
    const pool = createPool(config.runtimeDatabaseUrl);
    const db = createDb(pool);
    try {
      const orgId = randomUUID();
      const start = performance.now();
      await expect(
        withTenantTx(db, orgId, (tx) =>
          withStatementTimeout(tx, 200, () => tx.execute(sql`SELECT pg_sleep(5)`))
        )
      ).rejects.toBeInstanceOf(GraphQueryTimeoutError);
      const elapsedMs = performance.now() - start;
      // Cancelled close to the 200ms bound — nowhere near the full 5s pg_sleep — proves this
      // actually BOUNDS runtime, not merely translates the error after the query already ran.
      expect(elapsedMs).toBeLessThan(3_000);
    } finally {
      await pool.end();
    }
  }, 15_000);

  it("does not leak statement_timeout past the transaction it was set in (SET LOCAL, not SET)", async () => {
    const config = loadConfig({
      DATABASE_URL: testDatabaseUrl(),
      SCP_RUNTIME_DATABASE_URL: testRuntimeDatabaseUrl(),
      SCP_PGBOSS_DATABASE_URL: testPgBossDatabaseUrl(),
      SCP_COOKIE_SECRET: "test-cookie-secret-value"
    });
    const pool = createPool(config.runtimeDatabaseUrl);
    const db = createDb(pool);
    try {
      const orgId = randomUUID();
      // First transaction sets a tiny timeout and lets the (cancelled) transaction roll back.
      await withTenantTx(db, orgId, async (tx) => {
        try {
          await withStatementTimeout(tx, 50, () => tx.execute(sql`SELECT pg_sleep(2)`));
        } catch {
          // expected — this transaction rolls back on the thrown error, same as production.
        }
      }).catch(() => undefined);

      // A FRESH transaction on the same pool must see Postgres's own default statement_timeout
      // (effectively unbounded for this test's purposes) — a 300ms sleep must complete cleanly,
      // proving the earlier 50ms bound never leaked onto a reused pooled connection.
      const rows = await withTenantTx(db, orgId, (tx) =>
        tx.execute(sql`SELECT pg_sleep(0.3), 1 AS ok`)
      );
      expect(rows.rows[0]).toMatchObject({ ok: 1 });
    } finally {
      await pool.end();
    }
  }, 15_000);
});

/** Route-level confirmation that `GraphQueryTimeoutError`. See docs/graph.md §154. */
describe("GET /api/v1/graph/query/:name — GraphQueryTimeoutError maps to HTTP 408 (route level)", () => {
  let server: TestServer;
  let pool: ReturnType<typeof createPool>;

  afterAll(async () => {
    await server?.close();
  });

  it("a normal (non-pathological) graph query is cancelled under a tight statement_timeout, and the route returns 408 with an RFC 9457 problem-details body", async () => {
    const config = loadConfig({
      DATABASE_URL: testDatabaseUrl(),
      SCP_RUNTIME_DATABASE_URL: testRuntimeDatabaseUrl(),
      SCP_PGBOSS_DATABASE_URL: testPgBossDatabaseUrl(),
      SCP_COOKIE_SECRET: "test-cookie-secret-value",
      // Comfortably below the ~55-60ms real cost of the WIDTH=1000 fan-in query below (see module
      // doc) — tight enough to prove a genuine cancellation, not a widened window hiding a
      // regression, while leaving enough margin (~4-5x) not to race Postgres's timer-signal
      // delivery the way a ~1ms bound against a trivially small graph would.
      SCP_GRAPH_QUERY_TIMEOUT_MS: "10"
    });
    pool = createPool(config.runtimeDatabaseUrl);
    const db = createDb(pool);
    const app = await buildApp({ db, config }, { logger: false });
    await app.ready();
    server = {
      app,
      deps: { db, config },
      close: async () => {
        await app.close();
        await pool.end();
      }
    };

    const org = await createTestOrg(server, "graph-timeout-408");

    // A single-level fan-in. See docs/graph.md §155.
    const WIDTH = 30_000;
    const raw = await RawScpAppClient.connect();
    const originDomainId = randomUUID();
    // Same RBAC note as the CTE-fix suite below: point every synthetic object's domain_id at the
    // real org root so the admin's org-root role binding actually covers them.
    const orgRootObjectId = await withTenantTx(db, org.orgId, (tx) =>
      getOrgRootObjectId(tx, org.orgId)
    );
    const targetId = randomUUID();
    const predecessorIds = Array.from({ length: WIDTH }, () => randomUUID());
    const allIds = [targetId, ...predecessorIds];
    try {
      await raw.setOrgContext(org.orgId);
      const names = allIds.map((id) => `timeout-408-fanin-${id}`);
      const urns = allIds.map((id) => `urn:timeout-408-fanin:${id}`);
      await raw.query(
        `INSERT INTO objects
           (id, org_id, domain_id, type_id, name, urn, properties, labels, origin_domain_id,
            revision, content_hash, version)
         SELECT t.id, $4::uuid, $6::uuid, 'service', t.name, t.urn, '{}'::jsonb, '{}'::jsonb,
                $5::uuid, 1, md5(t.id::text), 1
         FROM unnest($1::uuid[], $2::text[], $3::text[]) AS t(id, name, urn)`,
        [allIds, names, urns, org.orgId, originDomainId, orgRootObjectId]
      );
      const toIds = predecessorIds.map(() => targetId);
      const edgeIds = predecessorIds.map(() => randomUUID());
      await raw.query(
        `INSERT INTO relationships
           (id, org_id, type_id, from_id, to_id, properties, labels, origin_domain_id, revision, content_hash)
         SELECT t.id, $4::uuid, 'depends_on', t.from_id, t.to_id, '{}'::jsonb, '{}'::jsonb,
                $5::uuid, 1, md5(t.id::text)
         FROM unnest($1::uuid[], $2::uuid[], $3::uuid[]) AS t(id, from_id, to_id)`,
        [edgeIds, predecessorIds, toIds, org.orgId, originDomainId]
      );
    } finally {
      await raw.close();
    }

    const url = `/api/v1/graph/query/dependents-of?objectId=${targetId}&maxDepth=1`;
    const res = await server.app.inject({
      method: "GET",
      url,
      headers: { authorization: `Bearer ${org.adminToken}` }
    });

    expect(res.statusCode).toBe(408);
    expect(res.headers["content-type"]).toContain("application/problem+json");
    const body = res.json() as {
      type: string;
      title: string;
      status: number;
      detail?: string;
      instance: string;
    };
    expect(body.status).toBe(408);
    expect(body.title).toBe("Request Timeout");
    expect(body.type).toBe("about:blank");
    expect(body.instance).toBe(url);
    expect(body.detail).toMatch(/statement_timeout/);

    // A follow-up request on the SAME server still succeeds normally — the cancelled transaction
    // didn't wedge the pool/connection (query-timeout.integration.test.ts's own leak test above
    // already covers this at the `withStatementTimeout` level; this is the route-level echo of it).
    const health = await server.app.inject({ method: "GET", url: "/healthz" });
    expect(health.statusCode).toBe(200);
  }, 15_000);
});

/** End-to-end, route-level confirmation that the M9.1 CTE fix. See docs/graph.md §156. */
describe("GET /api/v1/graph/query/impact-of — high fan-in no longer blows up (M9.1 CTE fix)", () => {
  let server: TestServer;
  let pool: ReturnType<typeof createPool>;

  afterAll(async () => {
    await server?.close();
  });

  it("a fan-in^depth topology that used to run unbounded now completes fast with the correct closure", async () => {
    const config = loadConfig({
      DATABASE_URL: testDatabaseUrl(),
      SCP_RUNTIME_DATABASE_URL: testRuntimeDatabaseUrl(),
      SCP_PGBOSS_DATABASE_URL: testPgBossDatabaseUrl(),
      SCP_COOKIE_SECRET: "test-cookie-secret-value",
      // Still tight (production default is 5000ms, config.ts) — proves the fix rather than just
      // widening the window enough to hide a regression.
      SCP_GRAPH_QUERY_TIMEOUT_MS: "3000"
    });
    pool = createPool(config.runtimeDatabaseUrl);
    const db = createDb(pool);
    const app = await buildApp({ db, config }, { logger: false });
    await app.ready();
    server = {
      app,
      deps: { db, config },
      close: async () => {
        await app.close();
        await pool.end();
      }
    };

    const org = await createTestOrg(server, "graph-timeout-guardrail");

    // A small but combinatorially explosive fan-in graph. See docs/graph.md §157.
    const WIDTH = 12;
    const LAYERS = 9;
    const raw = await RawScpAppClient.connect();
    const originDomainId = randomUUID();
    // The permission walk climbs `domain_id` to the bound scope. See docs/graph.md §158.
    const orgRootObjectId = await withTenantTx(db, org.orgId, (tx) =>
      getOrgRootObjectId(tx, org.orgId)
    );
    let lastLayerNodeId = "";
    try {
      await raw.setOrgContext(org.orgId);
      const layerIds: string[][] = [];
      for (let layer = 0; layer < LAYERS; layer++) {
        const ids = Array.from({ length: WIDTH }, () => randomUUID());
        const names = ids.map((id) => `fanout-${layer}-${id}`);
        const urns = ids.map((id) => `urn:fanout:${id}`);
        await raw.query(
          `INSERT INTO objects
             (id, org_id, domain_id, type_id, name, urn, properties, labels, origin_domain_id,
              revision, content_hash, version)
           SELECT t.id, $4::uuid, $6::uuid, 'service', t.name, t.urn, '{}'::jsonb, '{}'::jsonb,
                  $5::uuid, 1, md5(t.id::text), 1
           FROM unnest($1::uuid[], $2::text[], $3::text[]) AS t(id, name, urn)`,
          [ids, names, urns, org.orgId, originDomainId, orgRootObjectId]
        );
        layerIds.push(ids);
      }
      lastLayerNodeId = layerIds[LAYERS - 1]![0]!;

      for (let layer = 0; layer < LAYERS - 1; layer++) {
        const fromIds: string[] = [];
        const toIds: string[] = [];
        for (const from of layerIds[layer]!) {
          for (const to of layerIds[layer + 1]!) {
            fromIds.push(from);
            toIds.push(to);
          }
        }
        const edgeIds = fromIds.map(() => randomUUID());
        await raw.query(
          `INSERT INTO relationships
             (id, org_id, type_id, from_id, to_id, properties, labels, origin_domain_id, revision, content_hash)
           SELECT t.id, $4::uuid, 'depends_on', t.from_id, t.to_id, '{}'::jsonb, '{}'::jsonb,
                  $5::uuid, 1, md5(t.id::text)
           FROM unnest($1::uuid[], $2::uuid[], $3::uuid[]) AS t(id, from_id, to_id)`,
          [edgeIds, fromIds, toIds, org.orgId, originDomainId]
        );
      }
    } finally {
      await raw.close();
    }

    const start = performance.now();
    const res = await server.app.inject({
      method: "GET",
      url: `/api/v1/graph/query/impact-of?objectId=${lastLayerNodeId}&maxDepth=${LAYERS - 1}`,
      headers: { authorization: `Bearer ${org.adminToken}` }
    });
    const elapsedMs = performance.now() - start;

    expect(res.statusCode).toBe(200);
    const body = res.json() as { objects: { id: string }[] };
    // Every node in every earlier layer (0..LAYERS-2) is a genuine transitive dependent — complete
    // bipartite between consecutive layers, and maxDepth=LAYERS-1 covers exactly that many hops.
    expect(body.objects).toHaveLength(WIDTH * (LAYERS - 1));
    expect(new Set(body.objects.map((o) => o.id)).size).toBe(WIDTH * (LAYERS - 1));
    // Comfortably fast — nowhere near the old 7+ minute pathological runtime, and well inside the
    // tight 3s bound configured above (generous only for a loaded CI box, not to hide a
    // regression: a reopened blowup would take vastly longer than this).
    expect(elapsedMs).toBeLessThan(3_000);

    // A follow-up request on the SAME server still succeeds normally.
    const health = await server.app.inject({ method: "GET", url: "/healthz" });
    expect(health.statusCode).toBe(200);
  }, 30_000);
});
