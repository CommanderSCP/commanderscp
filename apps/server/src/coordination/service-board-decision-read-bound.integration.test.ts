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
  refreshDecisionStats,
  sortNodesInPlan
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
 *
 * WHAT THIS SUITE WAS NOT MEASURING, UNTIL drizzle/0069 (2026-08-17). It went red in CI on two
 * unrelated branches ten hours apart with the IDENTICAL number — `expected 804 to be less than or
 * equal to 10` — and passed on a plain re-run both times. 804 is every row this fixture's
 * `decisions` table holds, so it was never a marginal drift: the read was walking the whole ORG's
 * decision stream, which is exactly the pathology drizzle/0046 exists to prevent. The cause is a
 * PLAN FLIP, and what decides it is whether `decisions` has COLUMN STATISTICS:
 *
 *   - The suite seeds and measures within ~1.7 s, so `pg_statistic` is normally still EMPTY. Every
 *     equality is costed at `DEFAULT_EQ_SEL`, ~1 row is estimated to match, the sortless rival
 *     index is priced at its full length, and the partial index wins. Green — for a reason that
 *     has nothing to do with the index being right for the read.
 *   - When autoanalyze happens to fire inside that window, the estimate becomes ~200 matching rows,
 *     the rival is repriced at 1/200th, and the plan flips to `decisions_org_created` with
 *     `subject_id`/`verdict` as a heap filter. 802 rows removed by filter. Red.
 *
 * Two things follow, and both are fixed here rather than papered over. FIRST, the bound is right
 * and the plan was wrong: 0046's index stops at `created_at DESC` while the read orders by
 * `created_at DESC, id DESC`, so it can only ever be used underneath a sort node whose startup cost
 * `LIMIT 1` cannot amortise — see drizzle/0069 for the plans. SECOND, this suite could not have
 * caught that, because `refreshDecisionStats` ran its `ANALYZE` on the tenant transaction, whose
 * `scp_app` role cannot analyze a table it does not own; PostgreSQL warned and skipped, and the
 * helper written to remove exactly this variance had never done anything. It now analyzes over the
 * owner connection and throws if `pg_statistic` is still empty afterwards, so every arm below
 * measures the regime a live instance is permanently in.
 *
 * MUTATION-PROVEN, 2026-08-17, both directions:
 *   - drizzle/0069 reverted to the pre-0069 index keys -> `expected 804 to be less than or equal
 *     to 10` on EVERY run, plus `expected [ 'decisions_org_created' ] to include
 *     'decisions_org_subject_block_created'`. The CI failure, on demand.
 *   - that revert PLUS `refreshDecisionStats` returned to its old no-op -> all three arms GREEN.
 *     That is the suite as it stood, and it is why an 80x overshoot looked like a flake.
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
    // MEASURE THE REGIME PRODUCTION IS IN, not the one a freshly-seeded table happens to start in.
    // See `refreshDecisionStats`: with `pg_statistic` empty the planner picks the right index for
    // the wrong reason, so a bound measured there proves nothing about a live instance.
    await refreshDecisionStats();
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

    // (b) THE BOUND. Measured: 1 with statistics present and drizzle/0069 applied — one index
    // descent to the newest block entry, and `LIMIT 1` stops there. (It was 2 in the
    // no-statistics regime this suite used to measure, where the same index was reached through an
    // `Incremental Sort` that pulls an extra entry.) `<= 10` leaves headroom for that and for a
    // board with a few components, while the unbounded read charges every Decision the change holds
    // (measured 401 for SEEDED_DECISIONS=400 plus the change's `transition` row — once PER BOARD
    // ROW).
    expect(touched).toBeGreaterThan(0);
    expect(touched).toBeLessThanOrEqual(10);
    expect(touched).toBeLessThan(SEEDED_DECISIONS);
  });

  it("the never-blocked probe is SERVED BY drizzle/0046's partial index — named, so a plan flip says which index it flipped to", async () => {
    // ADDED after this suite went red in CI ("expected 804 to be less than or equal to 10") and
    // passed on a plain re-run of the SAME commit. The row count below is the honest measurement,
    // but when it fails it reports a bare number: it does not say which index served the read
    // instead, so the investigation restarts from nothing. This arm names it.
    //
    // It explains the BUILDER `latestBlockDecisionForSubject` itself runs — not a re-typed copy,
    // which would keep passing while the real query drifted off the index.
    //
    // WHY THIS ARM PASSED WHILE THE ROW COUNT FAILED, in the CI run that diagnosed all this: both
    // arms called `refreshDecisionStats` and NEITHER analyzed anything (it ran on the tenant
    // transaction, whose `scp_app` role cannot analyze a table it does not own — PostgreSQL warns
    // and skips). So the statistics state was not controlled by the suite at all; it was whatever
    // autoanalyze had done by then, and it changed BETWEEN the two arms. With the helper now
    // analyzing for real, both arms measure the same, permanent, production regime.
    await refreshDecisionStats();
    const { plan, sorts } = await withTenantTx(server.deps.db, org.orgId, async (tx) => {
      await preferIndexPlans(tx);
      const query = latestBlockDecisionQuery(tx, org.orgId, healthyChangeObjectId);
      return { plan: await indexesInPlan(tx, query), sorts: await sortNodesInPlan(tx, query) };
    });

    expect(plan).toContain("decisions_org_subject_block_created");
    // THE HALF THE NAME CANNOT ASSERT. A prefix-keyed index is still usable for ACCESS under an
    // `Incremental Sort`, so it appears in the plan by name while supplying only part of the order —
    // which is exactly what the pre-0069 index did, and exactly the state this suite used to call
    // green. `LIMIT 1` cannot amortise a sort node's startup cost, so "no sort node" is the property
    // that makes this a single seek. See `sortNodesInPlan`.
    expect(sorts).toEqual([]);
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
    // THE ARM THAT WENT RED IN CI, TWICE, ON UNRELATED BRANCHES, WITH THE IDENTICAL NUMBER:
    // `expected 804 to be less than or equal to 10` — 804 being every row this fixture's
    // `decisions` table holds, i.e. the org-wide walk drizzle/0046 exists to prevent, not a
    // marginal drift. It is not a timing flake and it is not noise: it is a PLAN FLIP that fires
    // whenever the planner has real statistics, which every live instance permanently does and a
    // freshly-seeded test table normally does not. `refreshDecisionStats` puts this suite in that
    // regime deliberately (and, since it now actually works, on every run) so the bound is a
    // detector rather than a coin toss. drizzle/0069 is what makes it hold there — closing both
    // ordering indexes with the `id DESC` tiebreak their `ORDER BY` asks for, so the partial index
    // needs no sort node above it and is cheaper than the sortless rival at every statistics state.
    await refreshDecisionStats();
    const { board, touched } = await withTenantTx(server.deps.db, org.orgId, async (tx) => {
      const service = await getObjectByIdOrUrnAnyType(tx, org.orgId, healthyServiceId);
      await preferIndexPlans(tx);
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
    // the change's history — and, when the plan flips, does not cost the change's history but the
    // ORG's. Measured 0 with drizzle/0069: the partial index holds no entry for this (org, subject)
    // at all, so the descent returns without charging one. Dropping
    // `decisions_org_subject_block_created` takes this to 401 — every row the change holds,
    // discarded by a heap filter, to return `undefined`. Reverting only its `id DESC` tiebreak
    // takes it to 804 — every row the ORG holds, which is the CI failure this suite is named for.
    expect(touched).toBeLessThanOrEqual(10);
    expect(touched).toBeLessThan(SEEDED_DECISIONS);
  });
});
