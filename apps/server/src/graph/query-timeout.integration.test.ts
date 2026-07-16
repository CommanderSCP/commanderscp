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

/**
 * Defensive graph guardrail (adversarial review of PR #15) — see query-timeout.ts's module doc
 * for the full "why" (the `impact-of` recursive CTE's measured fan-in^depth blowup; the CTE fix
 * itself is a separate, pending owner decision — this suite is only about the timeout bound).
 */
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
      const rows = await withTenantTx(db, orgId, (tx) => tx.execute(sql`SELECT pg_sleep(0.3), 1 AS ok`));
      expect(rows.rows[0]).toMatchObject({ ok: 1 });
    } finally {
      await pool.end();
    }
  }, 15_000);
});

/**
 * Route-level confirmation that `GraphQueryTimeoutError` (thrown by `withStatementTimeout` above)
 * actually reaches the client as the RFC 9457 HTTP 408 problem-details response `routes/graph.ts`
 * promises (catch `GraphQueryTimeoutError` → `errors.ts`'s `requestTimeout()`) — not a raw 500, not
 * a hung request. Adversarial review of PR #18 flagged that this end-to-end mapping lost its only
 * assertion when the M9.1 CTE fix (below) turned its old pathological-topology fixture into a fast
 * 200 — the `withStatementTimeout`-level tests above only assert the error TYPE (via a `pg_sleep`
 * unit call), never that a real route response carries it as a 408.
 *
 * Deliberately does NOT rebuild the old EXPONENTIAL fan-out^depth topology to force this — the
 * whole point of M9.1 is that a normal topology no longer explodes (see the suite below), so
 * reintroducing that shape here would be exactly the slow/flaky test this task was told to avoid.
 *
 * It's tempting to reach for `config.ts`'s existing `SCP_GRAPH_QUERY_TIMEOUT_MS` seam (already
 * exercised below at a looser 3000ms) turned down to the tightest non-disabling value (1ms —
 * Postgres treats `statement_timeout = 0` as "disabled", i.e. unlimited) against a trivially small
 * (2-node) graph. Empirically that is FLAKY, not just slow: `statement_timeout` cancellation is
 * delivered via a timer signal (Postgres `timeout.c`), and at ~1ms the race between "does the
 * signal get delivered and observed at the next `CHECK_FOR_INTERRUPTS`" and "does the (genuinely
 * sub-millisecond, on a 2-node graph, warm connection) query just finish first" is decided by OS
 * timer/scheduling jitter, not by the query actually being slow — repeated local runs against a
 * 2-node graph at 1ms came back a clean 200 (no cancellation at all) as often as a 408. Widening
 * the *graph* (still no depth beyond one hop, still linear — not the old exponential shape) instead
 * widens the gap between "real query cost" and "timeout bound" enough to make the outcome
 * deterministic: a single-level fan-in of WIDTH ordinary objects that all `depends_on` one target
 * (bulk INSERT, same technique the CTE-fix suite below uses).
 *
 * SIZING (corrected). An earlier version used WIDTH=1000 against the 10ms bound below and claimed a
 * "~4-5x margin, flake-free". That held in ISOLATION but occasionally returned 200 in the FULL
 * suite: after ~340 prior tests Postgres's shared buffers are warm, so the 1000-row walk finished
 * under 10ms before the timer fired — a real flake, not a phantom. The walk is CPU-bound and
 * O(WIDTH), so the fix is simply a much larger margin: WIDTH=30000 costs on the order of hundreds of
 * ms of unavoidable CPU work (~50-150x the 10ms bound), which no cache warmth or faster machine can
 * compress below 10ms, and full-suite CPU contention only makes slower (more likely to cancel).
 * 30k rows is one bulk INSERT (~1s to seed) and is still NOT the pathological shape — linear fan-in,
 * one hop, no recursion-step blowup is even possible here.
 */
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

    // A single-level fan-in: WIDTH ordinary service objects, each with its own depends_on edge
    // into one target — genuine, non-exponential work (see module doc for why this width/timeout
    // pair was chosen). Bulk INSERT bypassing the API, same technique as the CTE-fix suite below.
    //
    // WIDTH sized for a LARGE margin (~50-150x), not a tight one. The prior 1000/10ms pair was
    // flake-free in ISOLATION but occasionally returned 200 in the FULL suite: by then Postgres's
    // shared buffers are warm from ~340 prior tests, so the 1000-row walk finished under the 10ms
    // bound before the timeout fired. A ~10ms recursive walk of 1000 warm rows is CPU-bound and
    // O(WIDTH), so 30k rows costs ~30x that — hundreds of ms of unavoidable CPU work that no cache
    // warmth or faster machine can compress below the 10ms bound, while full-suite CPU contention
    // only makes it slower (more likely to cancel, never less). 30k rows is one bulk INSERT (~1s to
    // seed) and is still emphatically NOT the pathological shape — linear fan-in, one hop, no
    // recursion-step blowup.
    const WIDTH = 30_000;
    const raw = await RawScpAppClient.connect();
    const originDomainId = randomUUID();
    // Same RBAC note as the CTE-fix suite below: point every synthetic object's domain_id at the
    // real org root so the admin's org-root role binding actually covers them.
    const orgRootObjectId = await withTenantTx(db, org.orgId, (tx) => getOrgRootObjectId(tx, org.orgId));
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

/**
 * End-to-end, route-level confirmation that the M9.1 CTE fix (graph/named-queries.ts's
 * `transitiveReverseClosure` — see its doc comment for the approach) actually resolved the
 * pathological case this guardrail was originally built to merely survive: the exact
 * fan-in^depth topology that used to run unbounded (this test used to assert a 408 here) now
 * returns a normal 200, with the correct closure, comfortably inside a tight timeout — not just
 * "doesn't hang", but "computes the right answer fast". The generic guardrail mechanism itself
 * (statement_timeout translating to a clean 408 on a genuinely slow statement) is still covered
 * above by the pg_sleep-based tests, and remains in place as belt-and-braces — see
 * `query-timeout.ts`'s module doc.
 */
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

    // A small, cheap-to-insert, but (pre-M9.1) COMBINATORIALLY EXPLOSIVE fan-in DAG (bulk INSERT,
    // bypassing the API — same technique load-test/graph-scale.ts uses for scale, at a tiny
    // fraction of its size): LAYERS layers of WIDTH nodes each, EVERY node in layer i depends_on
    // EVERY node in layer i+1 (a complete bipartite join per layer). Walking `impact-of` BACKWARD
    // from a single last-layer node used to explore WIDTH^(LAYERS-1) distinct PATHS
    // (named-queries.ts's old "no intermediate node-dedup" root cause — see this suite's module
    // doc) — with WIDTH=12, LAYERS=9 that's 12^8 ≈ 4.3*10^8 paths, genuinely unbounded pre-fix,
    // while costing only ~1,260 rows to set up. Post-M9.1, node-level dedup means this same
    // topology costs only ~WIDTH*(LAYERS-1) closure rows (every node sits at exactly one distance
    // from the target in this uniform layered DAG), hence the assertions below.
    const WIDTH = 12;
    const LAYERS = 9;
    const raw = await RawScpAppClient.connect();
    const originDomainId = randomUUID();
    // RBAC (authz/resolve.ts's scope_expand) walks `domain_id` from the queried object up to the
    // scope a role binding actually covers — bulk-inserting with `domain_id: NULL` (as
    // load-test/graph-scale.ts does, since that script calls runNamedQuery directly and never
    // goes through authorize()) would make every synthetic object its OWN unreachable scope
    // island, and the admin's org-root role binding would never match. Point every synthetic
    // object's domain_id at the REAL org root object (one hop to the admin's actual scope) so
    // this test exercises normal RBAC, not a bypass of it.
    const orgRootObjectId = await withTenantTx(db, org.orgId, (tx) => getOrgRootObjectId(tx, org.orgId));
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
    expect(new Set(body.objects.map((o) => o.id)).size).toBe(WIDTH * (LAYERS - 1)); // no duplicates
    // Comfortably fast — nowhere near the old 7+ minute pathological runtime, and well inside the
    // tight 3s bound configured above (generous only for a loaded CI box, not to hide a
    // regression: a reopened blowup would take vastly longer than this).
    expect(elapsedMs).toBeLessThan(3_000);

    // A follow-up request on the SAME server still succeeds normally.
    const health = await server.app.inject({ method: "GET", url: "/healthz" });
    expect(health.statusCode).toBe(200);
  }, 30_000);
});
