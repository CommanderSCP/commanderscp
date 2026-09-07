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

/** THE BOUND ON THE BOARD'S DECISION READ. See docs/coordination.md §849. */
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

    // A long `gate`/`block` history for ONE change. See docs/coordination.md §850.
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

    // (b) THE BOUND. Measured. See docs/coordination.md §851.
    expect(touched).toBeGreaterThan(0);
    expect(touched).toBeLessThanOrEqual(10);
    expect(touched).toBeLessThan(SEEDED_DECISIONS);
  });

  it("the never-blocked probe is SERVED BY drizzle/0046's partial index — named, so a plan flip says which index it flipped to", async () => {
    // ADDED after this suite went red in CI. See docs/coordination.md §852.
    await refreshDecisionStats();
    const { plan, sorts } = await withTenantTx(server.deps.db, org.orgId, async (tx) => {
      await preferIndexPlans(tx);
      const query = latestBlockDecisionQuery(tx, org.orgId, healthyChangeObjectId);
      return { plan: await indexesInPlan(tx, query), sorts: await sortNodesInPlan(tx, query) };
    });

    expect(plan).toContain("decisions_org_subject_block_created");
    // THE HALF THE NAME CANNOT ASSERT. See docs/coordination.md §853.
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
    // The arm that went red in CI twice, with the same number. See docs/coordination.md §854.
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

    // (b) THE BOUND, which here is the WHOLE POINT. See docs/coordination.md §855.
    expect(touched).toBeLessThanOrEqual(10);
    expect(touched).toBeLessThan(SEEDED_DECISIONS);
  });
});
