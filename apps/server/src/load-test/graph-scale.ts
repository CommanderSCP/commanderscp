import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { sql } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import { createDb, createPool } from "../db/client.js";
import { withTenantTx } from "../db/tenant-tx.js";
import { runNamedQuery } from "../graph/named-queries.js";
import { RawScpAppClient, testRuntimeDatabaseUrl } from "../test-support/harness.js";
import setupTestDatabase from "../test-support/global-setup.js";
import { formatSummary, sampleDistinct, seededRandom, summarize } from "./stats.js";

/**
 * M8 informational load test (BUILD_AND_TEST.md §8 M8: "informational load tests of the
 * outbox/pg-boss and NATS event paths at target webhook rates (no benchmark gate — review
 * decision)"; DESIGN.md §5's escape-hatch note: "if profiling shows deep-closure pain at the high
 * end, a materialized closure table... slots in behind the same named-query API without any
 * contract change" — THIS script is what would surface that pain, if any exists, at 10k/100k
 * scale). NOT a CI gate: there is no pass/fail threshold here, only measured numbers printed to
 * stdout for a human to read (and re-run whenever the escape-hatch question comes up again).
 *
 * PLACEMENT: lives in `apps/server/src/load-test/` (a plain source directory, not a separate
 * workspace package) because it needs `apps/server`'s own DB client, schema, tenant-tx wrapper,
 * and `graph/named-queries.ts` DIRECTLY — a standalone package would just re-import all of that
 * through a workspace dependency anyway, so colocating avoids a second package.json/tsconfig for
 * no isolation benefit. It reuses `test-support/global-setup.ts` (spins the same Testcontainers
 * `postgres:16` instance apps/server's own integration suite uses — this repo never mocks the DB,
 * BUILD_AND_TEST.md §4.2) and `test-support/harness.ts`'s `RawScpAppClient` — both are plain,
 * vitest-free exported functions, so importing them from a non-test `tsx` entrypoint is safe.
 *
 * WHAT IT MEASURES: `runNamedQuery(tx, orgId, "impact-of", {objectId, maxDepth: 10})` called
 * DIRECTLY (the exact function `routes/graph.ts`'s `GET /graph/query/:name` handler calls inside
 * its own `withTenantTx`) — i.e. the recursive-CTE query engine itself, not HTTP/auth overhead
 * (an RBAC permission check and JSON serialization sit in front of it in production; both are
 * O(1)-ish relative to a depth-10 closure over 100k edges and are deliberately excluded so the
 * numbers below isolate the one thing DESIGN §5's escape-hatch note is actually about: the SQL).
 *
 * SYNTHETIC DATA — TWO POPULATIONS, deliberately, after TWO real findings during this script's
 * own development (both kept below under "KNOWN PATHOLOGICAL CASES" rather than smoothed over —
 * they are the actual headline result of this benchmark, arguably more informative than the clean
 * numbers):
 *
 *   - SPINE (depth-10 exercise): ~3,000 `service` objects arranged as ~250 DISJOINT LINEAR CHAINS
 *     of 12 nodes each (chain[0] depends_on chain[1] depends_on ... depends_on chain[11] — the
 *     same shape named-queries.integration.test.ts's own fixture uses, just repeated ~250x for
 *     scale). Fan-out/fan-in is EXACTLY 1 at every hop — no branching, no convergence, so the
 *     recursive CTE enumerates EXACTLY ONE path per chain per depth: this is the ONLY topology
 *     shape this script found that reliably completes at depth 10 (see the two pathological cases
 *     below for what happens with even modest branching). Each chain's tail (chain[11]) has a
 *     genuine 11-hop lineage back to chain[0], so `impact-of` at the schema's maximum
 *     `maxDepth: 10` walks the FULL depth budget (hops 1..10 included, hop 11 correctly excluded)
 *     — BUILD_AND_TEST.md's M8 item's own warning ("make sure your synthetic data actually
 *     exercises real depth-10 traversal, not an early cutoff").
 *   - BULK (scale padding): the remaining ~7,000 objects in a SEPARATE, shallow 3-layer DAG (own
 *     id pool, no edges to/from the spine) with a much higher fan-out, chosen so total edges
 *     across both populations land near the requested ~100,000 — safe at any fan-out because its
 *     own max possible depth is 2 hops, regardless of branching factor.
 *
 * Benchmark targets are sampled from the spine chains' tails (genuine depth-10 closures) and,
 * separately, uniformly across the WHOLE graph (spine + bulk — a "typical case" mix, since most
 * real impact-of calls hit shallow closures). Loads via raw parameterized
 * `INSERT ... SELECT ... FROM unnest(...)` batches directly against the tables (bypassing
 * graph/objects-repo.ts's `createObject` — audit/journal/outbox writes are irrelevant to a pure
 * graph-read benchmark and 110k individual API calls would dominate the wall clock) — exactly the
 * seed.ts module doc's own guidance: "you do NOT need to seed via the API for a 10k-scale
 * synthetic graph (too slow); direct bulk INSERTs... are the right approach."
 *
 * KNOWN PATHOLOGICAL CASES (found during this script's own development — real, measured data
 * points, not reproduced by this script's default run because doing so would risk repeating
 * resource exhaustion / very long runtimes, but reported here and in the M8 PR numbers because
 * they are directly relevant to DESIGN.md §5's closure-table escape-hatch decision):
 *
 *   1. A uniform 12-layer topology with EVERY node fanning out 8-14 ways at EVERY layer (avg
 *      fan-in ~11 at every hop — this task's own "~10 edges/node average" ask, applied uniformly
 *      rather than concentrated in a spine+bulk split). A SINGLE `impact-of(maxDepth: 10)` call
 *      against it ran 7+ minutes (confirmed still ACTIVE, not hung, via `pg_stat_activity`) before
 *      exhausting the Testcontainers Postgres container's disk via recursive-CTE temp-file spill
 *      (`could not write to file "base/pgsql_tmp/...": No space left on device`).
 *   2. A MUCH more modest 12-layer topology, fan-out 2-4 per node (avg fan-in ~3) over 250-node
 *      layers, STILL exceeded a 30-SECOND `statement_timeout` safety net on at least one of the
 *      100 sampled queries (`canceling statement due to statement timeout`) — i.e. the cliff isn't
 *      only at extreme fan-out; even modest branching (~3) sustained across 10 hops, with enough
 *      convergence opportunity (a few hundred nodes per layer), can blow up. The reason in both
 *      cases: the recursive CTE's `UNION ALL` does NOT deduplicate by node id between recursion
 *      steps (only the FINAL `SELECT DISTINCT` does) — every intermediate step keeps every
 *      DISTINCT PATH separately, and path count compounds roughly as (effective branching)^depth
 *      whenever a layer is small enough, relative to its edge count, for many distinct upstream
 *      routes to reconverge on the same downstream nodes.
 *
 * The SPINE topology actually benchmarked below (branching factor exactly 1) is the ONLY shape
 * that sidesteps this — it is the FLOOR of what depth-10 `impact-of` costs, not a representative
 * "average" case. A real org graph with genuine branching in its dependency chains (which most
 * are) should expect costs somewhere between this floor and the two pathological cases above,
 * depending on how much convergence its dependency graph actually has at the 10-hop range — which
 * is exactly the kind of profiling signal DESIGN.md §5 says should trigger the closure-table
 * escape hatch.
 *
 * Run: `DOCKER_HOST="unix://$HOME/.colima/default/docker.sock" TESTCONTAINERS_RYUK_DISABLED=true
 *   pnpm --filter @scp/server load-test:graph`
 */

const SPINE_CHAIN_LENGTH = 12; // matches named-queries.integration.test.ts's own chain fixture shape
const SPINE_CHAIN_COUNT = 250; // 250 * 12 = 3,000 spine nodes, ~250 independent depth-11 lineages
const BULK_LAYERS = 3;
const TOTAL_NODES = 10_000;
const TARGET_TOTAL_EDGES = 100_000;
const SAMPLE_RUNS_DEEP = 80; // targets sampled from spine chain tails — genuine depth-10 exercise
const SAMPLE_RUNS_RANDOM = 20; // targets sampled uniformly across the whole graph (spine + bulk) — "typical case"
const MAX_DEPTH = 10;
const QUERY_STATEMENT_TIMEOUT_MS = 30_000; // safety net — see "KNOWN PATHOLOGICAL CASE" above
const RNG_SEED = 42;

interface Topology {
  spineTailIds: string[]; // last node of each spine chain — genuine depth-10 targets
  objectRows: { id: string; name: string; urn: string }[];
  edgeRows: { id: string; fromId: string; toId: string }[];
}

function buildTopology(rand: () => number): Topology {
  // --- Spine: ~250 disjoint linear chains (fan-out/fan-in exactly 1) — see the module doc's
  // "KNOWN PATHOLOGICAL CASES" for why anything branchier reliably fails to complete at depth 10
  // in this benchmark. ---
  const objectRows: { id: string; name: string; urn: string }[] = [];
  const edgeRows: { id: string; fromId: string; toId: string }[] = [];
  const spineTailIds: string[] = [];
  let globalIndex = 0;
  for (let c = 0; c < SPINE_CHAIN_COUNT; c++) {
    const chainIds: string[] = [];
    for (let i = 0; i < SPINE_CHAIN_LENGTH; i++) {
      const id = uuidv7();
      chainIds.push(id);
      objectRows.push({
        id,
        name: `loadtest-spine-${globalIndex}`,
        urn: `urn:scp:loadtest:service:spine-chain${c}-${i}`
      });
      globalIndex++;
    }
    for (let i = 0; i < chainIds.length - 1; i++) {
      edgeRows.push({ id: uuidv7(), fromId: chainIds[i]!, toId: chainIds[i + 1]! });
    }
    spineTailIds.push(chainIds[chainIds.length - 1]!);
  }
  const spineEdgeCount = edgeRows.length;

  // --- Bulk: pure scale padding, own shallow (3-layer, so max depth 2 hops) DAG, no links to the
  // spine — absorbs whatever fan-out is needed to hit the requested ~100k total edges, safely,
  // since its own depth is capped regardless of branching factor. ---
  const bulkTotalNodes = TOTAL_NODES - SPINE_CHAIN_COUNT * SPINE_CHAIN_LENGTH;
  const bulkBase = Math.floor(bulkTotalNodes / BULK_LAYERS);
  const bulkRemainder = bulkTotalNodes - bulkBase * BULK_LAYERS;
  const bulkLayerIds: string[][] = [];
  for (let l = 0; l < BULK_LAYERS; l++) {
    const size = bulkBase + (l < bulkRemainder ? 1 : 0);
    const ids: string[] = [];
    for (let i = 0; i < size; i++) {
      const id = uuidv7();
      ids.push(id);
      objectRows.push({
        id,
        name: `loadtest-bulk-${globalIndex}`,
        urn: `urn:scp:loadtest:service:bulk-layer${l}-${i}`
      });
      globalIndex++;
    }
    bulkLayerIds.push(ids);
  }

  const remainingEdgeBudget = Math.max(TARGET_TOTAL_EDGES - spineEdgeCount, 0);
  const bulkSourceNodeCount = bulkLayerIds.slice(0, BULK_LAYERS - 1).reduce((n, l) => n + l.length, 0);
  const bulkFanout = Math.max(1, Math.round(remainingEdgeBudget / Math.max(bulkSourceNodeCount, 1)));
  for (let l = 0; l < BULK_LAYERS - 1; l++) {
    const fromLayer = bulkLayerIds[l]!;
    const toLayer = bulkLayerIds[l + 1]!;
    for (const fromId of fromLayer) {
      const targets = sampleDistinct(toLayer, bulkFanout, rand);
      for (const toId of targets) {
        edgeRows.push({ id: uuidv7(), fromId, toId });
      }
    }
  }

  return { spineTailIds, objectRows, edgeRows };
}

async function bulkInsertObjects(
  raw: RawScpAppClient,
  orgId: string,
  originDomainId: string,
  rows: { id: string; name: string; urn: string }[],
  chunkSize = 2000
): Promise<void> {
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    await raw.query(
      `INSERT INTO objects
         (id, org_id, domain_id, type_id, name, urn, properties, labels, origin_domain_id,
          revision, content_hash, version)
       SELECT t.id, $4::uuid, NULL, 'service', t.name, t.urn, '{}'::jsonb, '{}'::jsonb,
              $5::uuid, 1, md5(t.id::text), 1
       FROM unnest($1::uuid[], $2::text[], $3::text[]) AS t(id, name, urn)`,
      [
        chunk.map((r) => r.id),
        chunk.map((r) => r.name),
        chunk.map((r) => r.urn),
        orgId,
        originDomainId
      ]
    );
    console.log(`  objects: ${Math.min(i + chunkSize, rows.length)}/${rows.length}`);
  }
}

async function bulkInsertRelationships(
  raw: RawScpAppClient,
  orgId: string,
  originDomainId: string,
  rows: { id: string; fromId: string; toId: string }[],
  chunkSize = 5000
): Promise<void> {
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    await raw.query(
      `INSERT INTO relationships
         (id, org_id, type_id, from_id, to_id, properties, labels, origin_domain_id, revision, content_hash)
       SELECT t.id, $4::uuid, 'depends_on', t.from_id, t.to_id, '{}'::jsonb, '{}'::jsonb,
              $5::uuid, 1, md5(t.id::text)
       FROM unnest($1::uuid[], $2::uuid[], $3::uuid[]) AS t(id, from_id, to_id)`,
      [
        chunk.map((r) => r.id),
        chunk.map((r) => r.fromId),
        chunk.map((r) => r.toId),
        orgId,
        originDomainId
      ]
    );
    console.log(`  relationships: ${Math.min(i + chunkSize, rows.length)}/${rows.length}`);
  }
}

async function main(): Promise<void> {
  console.log("=== M8 load test — Pass 1: graph scale (impact-of @ depth 10) ===");
  console.log(
    "CAVEAT: single dev laptop via Testcontainers postgres:16, NOT a production benchmark rig — " +
      "informational only (BUILD_AND_TEST.md §8 M8: no benchmark gate, review decision).\n"
  );

  console.log("Starting Testcontainers postgres:16 (mirrors test-support/global-setup.ts)...");
  const teardown = await setupTestDatabase();

  const pool = createPool(testRuntimeDatabaseUrl());
  const db = createDb(pool);
  const raw = await RawScpAppClient.connect();

  try {
    const orgId = uuidv7();
    const originDomainId = uuidv7();
    await raw.setOrgContext(orgId);

    console.log(
      `\nGenerating synthetic topology: ${TOTAL_NODES} nodes target (spine=${SPINE_CHAIN_COUNT} x ` +
        `${SPINE_CHAIN_LENGTH}-node linear chains + bulk shallow/wide)...`
    );
    const rand = seededRandom(RNG_SEED);
    const topology = buildTopology(rand);
    console.log(
      `  ${topology.objectRows.length} objects, ${topology.edgeRows.length} depends_on edges ` +
        `(target was ~${TOTAL_NODES.toLocaleString()} / ~${TARGET_TOTAL_EDGES.toLocaleString()})`
    );

    console.log("\nBulk-loading objects...");
    const loadStart = performance.now();
    await bulkInsertObjects(raw, orgId, originDomainId, topology.objectRows);
    console.log("Bulk-loading relationships...");
    await bulkInsertRelationships(raw, orgId, originDomainId, topology.edgeRows);
    const loadMs = performance.now() - loadStart;
    console.log(`Load complete in ${(loadMs / 1000).toFixed(1)}s.\n`);

    // Spine chain tails genuinely exercise the full depth-10 traversal budget — see module doc
    // above. A uniform-random sample across the WHOLE graph (spine + bulk) is measured separately
    // as a rough "typical case" (most impact-of calls in a real graph hit shallow closures).
    const deepTargets = sampleDistinct(topology.spineTailIds, SAMPLE_RUNS_DEEP, rand);
    const allIds = topology.objectRows.map((r) => r.id);
    const randomTargets = sampleDistinct(allIds, SAMPLE_RUNS_RANDOM, rand);

    async function timedRuns(targets: string[]): Promise<number[]> {
      const latencies: number[] = [];
      for (const objectId of targets) {
        const start = performance.now();
        await withTenantTx(db, orgId, async (tx) => {
          // Safety net — see "KNOWN PATHOLOGICAL CASE" in the module doc above: fail loud and
          // fast rather than risk repeating the disk-exhaustion incident if a future topology
          // tweak accidentally reintroduces high reverse fan-in across every hop. `SET` itself
          // doesn't accept bind parameters (unlike a regular `SELECT`), so this uses
          // `set_config(...)` — same pattern db/tenant-tx.ts uses for `app.current_org_id`.
          await tx.execute(
            sql`SELECT set_config('statement_timeout', ${String(QUERY_STATEMENT_TIMEOUT_MS)}, true)`
          );
          return runNamedQuery(tx, orgId, "impact-of", { objectId, maxDepth: MAX_DEPTH });
        });
        latencies.push(performance.now() - start);
      }
      return latencies;
    }

    console.log(
      `Running impact-of(maxDepth=${MAX_DEPTH}) against ${deepTargets.length} spine chain-tail ` +
        `targets (genuine depth-10 closures, branching factor exactly 1)...`
    );
    const deepLatencies = await timedRuns(deepTargets);

    console.log(
      `Running impact-of(maxDepth=${MAX_DEPTH}) against ${randomTargets.length} uniform-random ` +
        `targets across the whole graph (typical-case mix of shallow/deep closures)...`
    );
    const randomLatencies = await timedRuns(randomTargets);

    const deepSummary = summarize(deepLatencies);
    const randomSummary = summarize(randomLatencies);

    console.log("\n=== RESULTS (single dev laptop, Testcontainers postgres:16 — informational only) ===");
    console.log(
      `Graph: ${topology.objectRows.length} objects, ${topology.edgeRows.length} edges ` +
        `(spine: ${SPINE_CHAIN_COUNT} linear chains x ${SPINE_CHAIN_LENGTH} nodes, branching=1; ` +
        `bulk: ${BULK_LAYERS} shallow layers, high fan-out but depth-capped at 2 hops)`
    );
    console.log(formatSummary("impact-of @ depth 10, spine chain-tail targets", deepSummary));
    console.log(formatSummary("impact-of @ depth 10, uniform-random targets  ", randomSummary));
    console.log(
      "\nKNOWN PATHOLOGICAL CASES (NOT reproduced by this run — see module doc for the full write-" +
        "up, both are real measured data points from this script's own development):\n" +
        "  1. Uniform fan-out ~11 at every one of 12 layers: a SINGLE impact-of(depth=10) call ran " +
        "7+ minutes before exhausting the Testcontainers Postgres container's disk via recursive-" +
        "CTE temp-file spill.\n" +
        "  2. Modest fan-out ~3 at every one of 12 layers (250 nodes/layer): still exceeded a 30s " +
        "statement_timeout safety net on at least one of 100 sampled queries.\n" +
        "Both are real evidence for DESIGN.md §5's closure-table escape hatch — the branching-1 " +
        "spine benchmarked above is the FLOOR of depth-10 impact-of cost, not a representative " +
        "average; real graphs with any sustained branching in a 10-hop dependency chain should " +
        "expect costs somewhere between this floor and the two pathological cases."
    );
    console.log(`\nRepro: pnpm --filter @scp/server load-test:graph`);
  } finally {
    await raw.close();
    await pool.end();
    console.log("\nTearing down Testcontainers postgres...");
    await teardown();
  }
}

const isMainModule =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainModule) {
  main().catch((err: unknown) => {
    console.error("load-test/graph-scale failed:", err);
    process.exitCode = 1;
  });
}
