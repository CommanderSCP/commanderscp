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

/** M8 informational load test. See docs/load-test.md §5. */

const SPINE_CHAIN_LENGTH = 12;
const SPINE_CHAIN_COUNT = 250; // 250 * 12 = 3,000 spine nodes, ~250 independent depth-11 lineages
const BULK_LAYERS = 3;
const TOTAL_NODES = 10_000;
const TARGET_TOTAL_EDGES = 100_000;
const SAMPLE_RUNS_DEEP = 80; // targets sampled from spine chain tails — genuine depth-10 exercise
const SAMPLE_RUNS_RANDOM = 20; // targets sampled uniformly across the whole graph (spine + bulk) — "typical case"
const MAX_DEPTH = 10;
const QUERY_STATEMENT_TIMEOUT_MS = 30_000;
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
  const bulkSourceNodeCount = bulkLayerIds
    .slice(0, BULK_LAYERS - 1)
    .reduce((n, l) => n + l.length, 0);
  const bulkFanout = Math.max(
    1,
    Math.round(remainingEdgeBudget / Math.max(bulkSourceNodeCount, 1))
  );
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
          // Safety net: fail loud rather than repeat disk exhaustion. See docs/load-test.md §6.
          await tx.execute(
            sql`SELECT set_config('statement_timeout', ${String(QUERY_STATEMENT_TIMEOUT_MS)}, true)`
          );
          return runNamedQuery(tx, orgId, "impact-of", { objectId, maxDepth: MAX_DEPTH }, null);
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

    console.log(
      "\n=== RESULTS (single dev laptop, Testcontainers postgres:16 — informational only) ==="
    );
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
