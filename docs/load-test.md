# load-test

Long-form reference for the **load-test** subsystem — the rationale, hazards and open items that
used to sit inline. Each source file below carries a one-line headline at the site and points here.

> Partial: 7 of 7 multi-line comment blocks in this subsystem are here. The rest are
> still inline, pending a hand-written one-line headline.

## Files

- [`apps/server/src/load-test/event-path.ts`](#apps-server-src-load-test-event-path-ts) — §1–§4
- [`apps/server/src/load-test/graph-scale.ts`](#apps-server-src-load-test-graph-scale-ts) — §5–§6
- [`apps/server/src/load-test/stats.ts`](#apps-server-src-load-test-stats-ts) — §7–§7

## `apps/server/src/load-test/event-path.ts`

### §1. M8 informational load test, Pass 2

M8 informational load test, Pass 2 (BUILD_AND_TEST.md §8 M8: "informational load tests of the outbox/pg-boss and NATS event paths at target webhook rates (no benchmark gate — review decision)"; DESIGN.md §8's "Coordination workloads are low-throughput/high-value (thousands of events per minute, not millions per second) — comfortably Postgres-queue territory" is the claim this script puts real numbers against). NOT a CI gate — informational only, printed to stdout.

SCOPING DECISION (read this before extending the script): "webhook rates" gets measured as TWO DELIBERATELY DECOUPLED halves rather than one combined webhook->Change->outbox pipeline:

1. INGESTION: `POST /change-sources/:sourceKind/webhook` at sustained concurrency — this is "persist-then-process"'s PERSIST half (routes/change-sources.ts): signature-verify + one INSERT into `change_source_events`, nothing else. Fast by design. 2. EVENT PATH: the outbox -> pg-boss / SSE / NATS fan-out (events/outbox-relay.ts), driven by real `object.create` calls through the public API — which write exactly one transactional outbox row per create (graph/objects-repo.ts's `eventBus.publish`), the SAME code path ANY domain mutation uses, webhook-triggered or not.

Why not measure the FULL chain (webhook POST -> coordination/webhook-processor.ts's next reconcile tick -> proposeChange -> outbox -> relay)? Three reasons, stated plainly: (a) that chain requires a `source_mappings` correlation row + a real target component, which is fixture setup unrelated to event-bus throughput; (b) it is gated behind `coordination/reconcile.ts`'s own ~1s self-scheduling tick (20-row batch limit per tick, coordination/webhook-processor.ts) — measuring it would mostly measure THAT tick cadence, not the outbox/pg-boss/NATS path BUILD_AND_TEST.md's M8 item actually names; (c) this task's scope explicitly excludes editing `apps/server/src/coordination/` (parallel work), and while *driving* it through its existing public API would be in-scope, its own polling cadence would just dominate and mask the number this script exists to produce. `eventBus.publish` (events/event-bus.ts) is the ONE place every domain mutation — including whatever `proposeChange` would eventually call — funnels through, so measuring it via `object.create` is a faithful, honest proxy for "the outbox/pg-boss/NATS event paths at target webhook rates," which is the literal thing BUILD_AND_TEST.md's M8 item names.

PLACEMENT: same rationale as graph-scale.ts's module doc — colocated in `apps/server/src/ load-test/` rather than a standalone workspace package, for the same direct-dependency reasons.

MODEL: this script's server bring-up (`listenTestServer`), org bootstrap (`createTestOrg`), and dual-backend delivery observation (sseHub + pg-boss job table + a real JetStream consumer) all mirror `events/event-bus.integration.test.ts` and `events/outbox-relay.integration.test.ts` directly — those are the "model" BUILD_AND_TEST.md pointed at for how both backends get exercised in this codebase.

Run: `DOCKER_HOST="unix://$HOME/.colima/default/docker.sock" TESTCONTAINERS_RYUK_DISABLED=true pnpm --filter @scp/server load-test:events`

### §2. Fixed-concurrency worker pool

Fixed-concurrency worker pool: `concurrency` workers each loop calling `task(seq)` until `count` total calls have been dispatched. Reports ACHIEVED throughput/latency rather than attempting fixed-interval pacing to a nominal target rate — on a single shared-event-loop dev process, "how much did we actually sustain at this concurrency" is the honest number; a best-effort open-loop scheduler would just silently queue and mislabel the same reality.

### §3. Fires one signed webhook POST directly via `fetch`

Fires one signed webhook POST directly via `fetch` (deliberately NOT the generated SDK — the SDK's `changeSources.webhook()` wrapper doesn't expose the custom HMAC-signature/delivery-id headers a real webhook sender needs; this is load-testing tooling driving the public HTTP API directly, not product code, so bypassing the SDK here doesn't violate DESIGN.md §6's API-first-parity rule — the SDK's OWN implementation of this exact route is exercised by named-queries.integration.test.ts and friends elsewhere).

### §4. Hoisted OUTSIDE the consume loop deliberately

Hoisted OUTSIDE the consume loop deliberately: a `for await` over `consumer.consume()` blocks on `next()` whenever no message is currently available — once every event has already been delivered, the loop is sitting inside that blocking `next()` call, NOT re-entering its body, so a flag only checked INSIDE the loop body (the first, buggier version of this script) can never be observed and the loop hangs forever. Calling `.stop()` on the iterator itself (a `QueuedIterator` method, `@nats-io/nats-core`'s `core.d.ts`) is what actually unblocks it — found the hard way: this script's first NATS-backend run hung indefinitely and had to be killed.

## `apps/server/src/load-test/graph-scale.ts`

### §5. M8 informational load test

M8 informational load test (BUILD_AND_TEST.md §8 M8: "informational load tests of the outbox/pg-boss and NATS event paths at target webhook rates (no benchmark gate — review decision)"; DESIGN.md §5's escape-hatch note: "if profiling shows deep-closure pain at the high end, a materialized closure table... slots in behind the same named-query API without any contract change" — THIS script is what would surface that pain, if any exists, at 10k/100k scale). NOT a CI gate: there is no pass/fail threshold here, only measured numbers printed to stdout for a human to read (and re-run whenever the escape-hatch question comes up again).

PLACEMENT: lives in `apps/server/src/load-test/` (a plain source directory, not a separate workspace package) because it needs `apps/server`'s own DB client, schema, tenant-tx wrapper, and `graph/named-queries.ts` DIRECTLY — a standalone package would just re-import all of that through a workspace dependency anyway, so colocating avoids a second package.json/tsconfig for no isolation benefit. It reuses `test-support/global-setup.ts` (spins the same Testcontainers `postgres:16` instance apps/server's own integration suite uses — this repo never mocks the DB, BUILD_AND_TEST.md §4.2) and `test-support/harness.ts`'s `RawScpAppClient` — both are plain, vitest-free exported functions, so importing them from a non-test `tsx` entrypoint is safe.

WHAT IT MEASURES: `runNamedQuery(tx, orgId, "impact-of", {objectId, maxDepth: 10})` called DIRECTLY (the exact function `routes/graph.ts`'s `GET /graph/query/:name` handler calls inside its own `withTenantTx`) — i.e. the recursive-CTE query engine itself, not HTTP/auth overhead (an RBAC permission check and JSON serialization sit in front of it in production; both are O(1)-ish relative to a depth-10 closure over 100k edges and are deliberately excluded so the numbers below isolate the one thing DESIGN §5's escape-hatch note is actually about: the SQL).

SYNTHETIC DATA — TWO POPULATIONS, deliberately, after TWO real findings during this script's own development (both kept below under "KNOWN PATHOLOGICAL CASES" rather than smoothed over — they are the actual headline result of this benchmark, arguably more informative than the clean numbers):

```text
- SPINE (depth-10 exercise): ~3,000 `service` objects arranged as ~250 DISJOINT LINEAR CHAINS
  of 12 nodes each (chain[0] depends_on chain[1] depends_on ... depends_on chain[11] — the
  same shape named-queries.integration.test.ts's own fixture uses, just repeated ~250x for
  scale). Fan-out/fan-in is EXACTLY 1 at every hop — no branching, no convergence, so the
  recursive CTE enumerates EXACTLY ONE path per chain per depth: this is the ONLY topology
  shape this script found that reliably completes at depth 10 (see the two pathological cases
  below for what happens with even modest branching). Each chain's tail (chain[11]) has a
  genuine 11-hop lineage back to chain[0], so `impact-of` at the schema's maximum
  `maxDepth: 10` walks the FULL depth budget (hops 1..10 included, hop 11 correctly excluded)
  — BUILD_AND_TEST.md's M8 item's own warning ("make sure your synthetic data actually
  exercises real depth-10 traversal, not an early cutoff").
- BULK (scale padding): the remaining ~7,000 objects in a SEPARATE, shallow 3-layer DAG (own
  id pool, no edges to/from the spine) with a much higher fan-out, chosen so total edges
  across both populations land near the requested ~100,000 — safe at any fan-out because its
  own max possible depth is 2 hops, regardless of branching factor.
```

Benchmark targets are sampled from the spine chains' tails (genuine depth-10 closures) and, separately, uniformly across the WHOLE graph (spine + bulk — a "typical case" mix, since most real impact-of calls hit shallow closures). Loads via raw parameterized `INSERT ... SELECT ... FROM unnest(...)` batches directly against the tables (bypassing graph/objects-repo.ts's `createObject` — audit/journal/outbox writes are irrelevant to a pure graph-read benchmark and 110k individual API calls would dominate the wall clock) — exactly the seed.ts module doc's own guidance: "you do NOT need to seed via the API for a 10k-scale synthetic graph (too slow); direct bulk INSERTs... are the right approach."

KNOWN PATHOLOGICAL CASES (found during this script's own development — real, measured data points, not reproduced by this script's default run because doing so would risk repeating resource exhaustion / very long runtimes, but reported here and in the M8 PR numbers because they are directly relevant to DESIGN.md §5's closure-table escape-hatch decision):

```text
1. A uniform 12-layer topology with EVERY node fanning out 8-14 ways at EVERY layer (avg
   fan-in ~11 at every hop — this task's own "~10 edges/node average" ask, applied uniformly
   rather than concentrated in a spine+bulk split). A SINGLE `impact-of(maxDepth: 10)` call
   against it ran 7+ minutes (confirmed still ACTIVE, not hung, via `pg_stat_activity`) before
   exhausting the Testcontainers Postgres container's disk via recursive-CTE temp-file spill
   (`could not write to file "base/pgsql_tmp/...": No space left on device`).
2. A MUCH more modest 12-layer topology, fan-out 2-4 per node (avg fan-in ~3) over 250-node
   layers, STILL exceeded a 30-SECOND `statement_timeout` safety net on at least one of the
   100 sampled queries (`canceling statement due to statement timeout`) — i.e. the cliff isn't
   only at extreme fan-out; even modest branching (~3) sustained across 10 hops, with enough
   convergence opportunity (a few hundred nodes per layer), can blow up. The reason in both
   cases: the recursive CTE's `UNION ALL` does NOT deduplicate by node id between recursion
   steps (only the FINAL `SELECT DISTINCT` does) — every intermediate step keeps every
   DISTINCT PATH separately, and path count compounds roughly as (effective branching)^depth
   whenever a layer is small enough, relative to its edge count, for many distinct upstream
   routes to reconverge on the same downstream nodes.
```

The SPINE topology actually benchmarked below (branching factor exactly 1) is the ONLY shape that sidesteps this — it is the FLOOR of what depth-10 `impact-of` costs, not a representative "average" case. A real org graph with genuine branching in its dependency chains (which most are) should expect costs somewhere between this floor and the two pathological cases above, depending on how much convergence its dependency graph actually has at the 10-hop range — which is exactly the kind of profiling signal DESIGN.md §5 says should trigger the closure-table escape hatch.

Run: `DOCKER_HOST="unix://$HOME/.colima/default/docker.sock" TESTCONTAINERS_RYUK_DISABLED=true pnpm --filter @scp/server load-test:graph`

### §6. Safety net: fail loud rather than repeat disk exhaustion

Safety net — see "KNOWN PATHOLOGICAL CASE" in the module doc above: fail loud and fast rather than risk repeating the disk-exhaustion incident if a future topology tweak accidentally reintroduces high reverse fan-in across every hop. `SET` itself doesn't accept bind parameters (unlike a regular `SELECT`), so this uses `set_config(...)` — same pattern db/tenant-tx.ts uses for `app.current_org_id`.

## `apps/server/src/load-test/stats.ts`

### §7. Dependency-free latency percentiles for the load-test scripts

Tiny latency-percentile helper shared by the M8 informational load-test scripts (graph-scale.ts, event-path.ts — BUILD_AND_TEST.md §8 M8 "informational load tests... no benchmark gate — review decision"). Deliberately dependency-free (no stats library) — this is reporting tooling, not product code, and the percentile math is a handful of lines.
