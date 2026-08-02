import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import {
  buildTestServer,
  createTestOrg,
  type TestOrg,
  type TestServer
} from "../test-support/harness.js";
import { withTenantTx } from "../db/tenant-tx.js";
import { getObjectByIdOrUrnAnyType } from "../graph/objects-repo.js";
import { proposeChange } from "./changes-repo.js";
import { latestBlockDecisionQuery } from "./decisions-repo.js";
import { buildServiceBoard } from "./service-board.js";
import {
  decisionRowsTouched,
  indexesInPlan,
  preferIndexPlans,
  refreshDecisionStats
} from "./test-support/decision-read-counters.js";

/**
 * THE BOUND ON THE BOARD'S DECISION READ (adversarial review of PR #153, P3).
 *
 * `GET /services/{id}/board` used to call `listDecisionsForSubject` for the latest change of EVERY
 * component on the board: every Decision ever recorded about that change, no `kind` filter, no
 * `LIMIT`, sorted, and materialized as JS objects — to use exactly ONE of them, the latest `block`,
 * whose id it reports as `attention.decisionId`. On the live homelab instance the 29 changes carried
 * ~425,000 Decisions EACH, so a single board render pulled hundreds of thousands of rows PER ROW of
 * the board. Measured on a 12M-row reproduction: 26,547 ms and 399,596 buffers for that read, against
 * 1.14 ms and 6 buffers for the bounded one, returning the same row.
 *
 * WHY THIS TEST MEASURES ROWS AND NOT LATENCY. A latency assertion would be a flake; an assertion on
 * the board's OUTPUT would be VACUOUS — the unbounded read returns the same `decisionId`, so an
 * output-only test passes either way and pins nothing. What actually changed is HOW MANY ROWS the
 * read touches, so that is what this asserts, from Postgres's own per-transaction counters:
 * `pg_stat_get_xact_tuples_returned` over every index on `decisions` (index entries returned to the
 * executor) plus the same function on the table itself (rows read by sequential scans). Those are
 * transaction-local, so they see the board's reads and nothing else — no stats-collector flush delay,
 * no interference from another test file (each Vitest worker owns its own cloned database).
 *
 * MUTATION-PROVEN: restoring `listDecisionsForSubject` + the JS `.reverse().find(...)` in
 * `service-board.ts` takes the measured count from 2 rows to 401 (every Decision this change holds)
 * and fails this test.
 *
 * AND THE CASE THAT BOUNDING ON `verdict` ALONE DOES NOT COVER — the second test below. A change
 * that has NEVER blocked is the COMMON case on a healthy board, and it is the one that cost the
 * most: with `verdict` as a heap filter the backward walk runs over the change's ENTIRE history to
 * return nothing (measured on the 12M-row reproduction: 45.8 ms / 20,526 buffers fully cached for a
 * 200k-row history, and 25,162 ms / 417,398 buffers cold for a 414k-row one — WORSE than the
 * unbounded read it replaced). drizzle/0046's PARTIAL index (`… WHERE verdict = 'block'`) is what
 * makes it O(1): the descent finds no entry for that (org, subject) at all. MUTATION-PROVEN:
 * `DROP INDEX decisions_org_subject_block_created` takes that test from 1 row touched to 401.
 */
describe("service board: the per-row Decision read is bounded, not the change's whole history", () => {
  let server: TestServer;
  let org: TestOrg;
  let serviceId: string;
  let componentId: string;
  let changeObjectId: string;
  /** A SECOND service/component/change whose long history contains no `block` at all. */
  let healthyServiceId: string;
  let healthyComponentId: string;
  let healthyChangeObjectId: string;

  /** Enough that an unbounded read is unmistakable, small enough to seed quickly. */
  const SEEDED_DECISIONS = 400;

  beforeAll(async () => {
    server = await buildTestServer();
    org = await createTestOrg(server, "board-decision-bound");

    const post = async (url: string, payload: Record<string, unknown>) => {
      const res = await server.app.inject({
        method: "POST",
        url,
        headers: { authorization: `Bearer ${org.adminToken}` },
        payload
      });
      if (res.statusCode >= 300) throw new Error(`POST ${url} -> ${res.statusCode} ${res.body}`);
      return res.json() as Record<string, unknown>;
    };

    const service = await post("/api/v1/services", { name: "svc-board-bound" });
    const component = await post("/api/v1/components", {
      name: "comp-board-bound",
      service: service.id
    });
    serviceId = service.id as string;
    componentId = component.id as string;

    changeObjectId = await withTenantTx(server.deps.db, org.orgId, async (tx) => {
      const { change } = await proposeChange(tx, {
        orgId: org.orgId,
        actorObjectId: org.orgId,
        requestId: "board-decision-bound",
        name: "change-board-bound",
        targets: [componentId]
      });
      return change.id;
    });

    // A long `gate`/`block` history for ONE change — the exact history the old read dragged into
    // memory in full. Seeded with the DB's own `gen_random_uuid()` + DISTINCT, 2-seconds-apart
    // `created_at` values, which is what the production flood looked like (one row per ~2 s
    // reconcile tick, each in its OWN transaction). Getting that detail right matters to what this
    // test measures: `created_at` defaults to `now()`, which is TRANSACTION start time, so rows
    // written in one loop inside one transaction all share a timestamp — and `ORDER BY created_at
    // DESC, id DESC` must then read the whole tied group to break the tie on `id`, which would make
    // even the bounded read touch every row. Written raw (not via `insertDecision`, which cannot set
    // `created_at`) and deliberately WITHOUT the dedupe guard: this test is about the READ side, and
    // must hold for a table that accumulated a flood before persist-on-change landed.
    await withTenantTx(server.deps.db, org.orgId, async (tx) => {
      await tx.execute(sql`
        INSERT INTO decisions (id, org_id, kind, subject_id, verdict, input_context, reason_tree, created_at)
        SELECT gen_random_uuid(), ${org.orgId}::uuid, 'gate', ${changeObjectId}::uuid, 'block',
               jsonb_build_object('waveIndex', 0, 'tick', i),
               jsonb_build_object('summary', 'blocked by 1 required policy (tick ' || i || ')'),
               now() + (i * interval '2 seconds')
        FROM generate_series(1, ${SEEDED_DECISIONS}) i
      `);
    });

    // THE HEALTHY CHANGE: an equally long history with NO `block` in it. Same seeding discipline,
    // different verdict — this is the shape a board asks about most often, and the one a
    // verdict-filtered read answers by walking everything unless drizzle/0046 is there.
    const healthyService = await post("/api/v1/services", { name: "svc-board-bound-healthy" });
    const healthyComponent = await post("/api/v1/components", {
      name: "comp-board-bound-healthy",
      service: healthyService.id
    });
    healthyServiceId = healthyService.id as string;
    healthyComponentId = healthyComponent.id as string;

    healthyChangeObjectId = await withTenantTx(server.deps.db, org.orgId, async (tx) => {
      const { change } = await proposeChange(tx, {
        orgId: org.orgId,
        actorObjectId: org.orgId,
        requestId: "board-decision-bound-healthy",
        name: "change-board-bound-healthy",
        targets: [healthyComponentId]
      });
      return change.id;
    });

    await withTenantTx(server.deps.db, org.orgId, async (tx) => {
      await tx.execute(sql`
        INSERT INTO decisions (id, org_id, kind, subject_id, verdict, input_context, reason_tree, created_at)
        SELECT gen_random_uuid(), ${org.orgId}::uuid, 'pre-deploy-artifact-verify',
               ${healthyChangeObjectId}::uuid, 'allow',
               jsonb_build_object('waveIndex', 0, 'tick', i),
               jsonb_build_object('summary', 'artifact verified (tick ' || i || ')'),
               now() + (i * interval '2 seconds')
        FROM generate_series(1, ${SEEDED_DECISIONS}) i
      `);
    });
  });

  afterAll(async () => {
    await server.close();
  });

  it("reads O(1) rows out of `decisions` per board row, whatever the change's history holds — and still reports the LATEST block", async () => {
    const { board, touched, seeded } = await withTenantTx(server.deps.db, org.orgId, async (tx) => {
      // The row the board must report: the newest `block` for this change.
      const latest = await tx.execute(sql`
          SELECT id FROM decisions
           WHERE org_id = ${org.orgId}::uuid AND subject_id = ${changeObjectId}::uuid
             AND verdict = 'block'
           ORDER BY created_at DESC, id DESC LIMIT 1
        `);
      const seededId = (latest as unknown as { rows: Array<{ id: string }> }).rows[0]!.id;

      const service = await getObjectByIdOrUrnAnyType(tx, org.orgId, serviceId);
      await preferIndexPlans(tx);
      const before = await decisionRowsTouched(tx);
      const built = await buildServiceBoard(tx, org.orgId, service);
      const after = await decisionRowsTouched(tx);
      return { board: built, touched: after - before, seeded: seededId };
    });

    // (a) CORRECTNESS FIRST — bounding the read must not change the answer.
    const row = board.rows.find((r) => r.component.id === componentId);
    expect(row?.latestChangeId).toBe(changeObjectId);
    expect(row?.attention.blocked).toBe(true);
    expect(row?.attention.decisionId).toBe(seeded);

    // (b) THE BOUND. Measured: 2. One probe returns the matching row, and the counter also charges
    // the next index entry the backward scan steps onto before the LIMIT stops it — so a small
    // constant, not zero, is the floor. `<= 10` leaves headroom for that and for a board with a few
    // components, while the unbounded read charges every Decision the change holds (measured 401 for
    // SEEDED_DECISIONS=400 plus the change's `transition` row — once PER BOARD ROW).
    expect(touched).toBeGreaterThan(0);
    expect(touched).toBeLessThanOrEqual(10);
    expect(touched).toBeLessThan(SEEDED_DECISIONS);
  });

  it("the never-blocked probe is SERVED BY drizzle/0046's partial index — named, so a plan flip says which index it flipped to", async () => {
    // ADDED after this suite went red once in CI ("expected 804 to be less than or equal to 10")
    // and passed on a plain re-run of the SAME commit. The row count below is the honest
    // measurement, but when it fails it reports a bare number: it does not say which index served
    // the read instead, so the investigation restarts from nothing. This arm names it.
    //
    // It explains the BUILDER `latestBlockDecisionForSubject` itself runs — not a re-typed copy,
    // which would keep passing while the real query drifted off the index.
    const plan = await withTenantTx(server.deps.db, org.orgId, async (tx) => {
      await preferIndexPlans(tx);
      await refreshDecisionStats(tx);
      return indexesInPlan(tx, latestBlockDecisionQuery(tx, org.orgId, healthyChangeObjectId));
    });

    expect(plan).toContain("decisions_org_subject_block_created");
    // The general index is what a flipped plan falls back to. `toContain` on an ARRAY is exact
    // element equality, not substring — so this does NOT reject the partial index above, whose name
    // happens to start with the same characters. Do not "fix" it into a substring check.
    expect(plan).not.toContain("decisions_org_subject");

    // MEASURED, and the reason this arm exists rather than leaning on the row count alone
    // (mutation-proved 2026-08-01 by removing the `verdict` predicate from the query, so the
    // partial index no longer applies while still existing):
    //
    //   with the partial index  -> plan ["decisions_org_subject_block_created"], 0 rows touched
    //   query drifted off it    -> plan ["decisions_org_subject"],               2 rows touched
    //
    // TWO rows. `LIMIT 1` over the general index with no predicate to discard anything stops at the
    // first entry, so the drift is CHEAP — the row-count bound below sails through it. A query that
    // silently stopped matching drizzle/0046 would therefore have gone completely undetected by the
    // measurement this suite was built around. That is the regression this arm catches and the
    // count cannot.
  });

  it("reads O(1) rows for a change that NEVER blocked, whose whole history it would otherwise have to walk to say so", async () => {
    const { board, touched } = await withTenantTx(server.deps.db, org.orgId, async (tx) => {
      const service = await getObjectByIdOrUrnAnyType(tx, org.orgId, healthyServiceId);
      await preferIndexPlans(tx);
      // Seeded rows are written and measured in the same run, which races autovacuum's
      // asynchronous analyze — so the planner can cost this read from stale or default estimates,
      // and its index choice can differ run to run on IDENTICAL data. That is the only mechanism
      // that plausibly explains the one observed CI failure passing on re-run. Removing the
      // variance is cheap; see `refreshDecisionStats` for the honest caveat that the flip was never
      // reproduced locally, so this is variance reduction rather than a diagnosed fix.
      await refreshDecisionStats(tx);
      const before = await decisionRowsTouched(tx);
      const built = await buildServiceBoard(tx, org.orgId, service);
      const after = await decisionRowsTouched(tx);
      return { board: built, touched: after - before };
    });

    // (a) CORRECTNESS FIRST — "no block" must still be reported as no block.
    const row = board.rows.find((r) => r.component.id === healthyComponentId);
    expect(row?.latestChangeId).toBe(healthyChangeObjectId);
    expect(row?.attention.blocked).toBe(false);
    expect(row?.attention.decisionId).toBeNull();

    // (b) THE BOUND, which here is the WHOLE POINT: answering "nothing blocked this" must not cost
    // the change's history. Measured 1 (the partial index holds no entry for this subject, so the
    // descent stops at the first non-matching one). Dropping
    // `decisions_org_subject_block_created` takes this to 401 — every row, discarded by a heap
    // filter, to return `undefined`.
    expect(touched).toBeLessThanOrEqual(10);
    expect(touched).toBeLessThan(SEEDED_DECISIONS);
  });
});
