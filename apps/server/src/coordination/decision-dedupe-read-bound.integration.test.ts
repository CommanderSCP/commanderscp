import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import {
  buildTestServer,
  createTestOrg,
  type TestOrg,
  type TestServer
} from "../test-support/harness.js";
import { withTenantTx } from "../db/tenant-tx.js";
import { proposeChange } from "./changes-repo.js";
import {
  latestDecisionForSubjectKind,
  latestDecisionForSubjectKindQuery
} from "./decisions-repo.js";
import {
  decisionRowsTouched,
  indexesInPlan,
  preferIndexPlans,
  refreshDecisionStats,
  sortNodesInPlan
} from "./test-support/decision-read-counters.js";

/** THE BOUND ON THE PERSIST-ON-CHANGE DEDUPE READ. See docs/coordination.md §403. */
describe("persist-on-change: the dedupe read is one index probe, not a walk of the subject's history", () => {
  let server: TestServer;
  let org: TestOrg;
  let changeObjectId: string;
  /** A second subject carrying the same kinds. See docs/coordination.md §404. */
  let otherChangeObjectId: string;

  /** Enough that an unbounded read is unmistakable, small enough to seed quickly. */
  const SEEDED_DECISIONS = 400;

  beforeAll(async () => {
    server = await buildTestServer();
    org = await createTestOrg(server, "decision-dedupe-bound");

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

    const service = await post("/api/v1/services", { name: "svc-dedupe-bound" });
    const component = await post("/api/v1/components", {
      name: "comp-dedupe-bound",
      service: service.id
    });

    changeObjectId = await withTenantTx(server.deps.db, org.orgId, async (tx) => {
      const { change } = await proposeChange(tx, {
        orgId: org.orgId,
        actorObjectId: org.orgId,
        requestId: "decision-dedupe-bound",
        name: "change-dedupe-bound",
        targets: [component.id as string]
      });
      return change.id;
    });

    // THE PRODUCTION SHAPE. See docs/coordination.md §405.
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

    // THE SECOND SUBJECT (header note 2). Its rows are NEWER than the first change's, so a plan
    // that answers a probe by walking the org's newest-first stream of a kind has to get past all
    // of them before it reaches anything belonging to `changeObjectId` — which is exactly the walk
    // drizzle/0044's index exists to replace, and exactly what a one-subject fixture hid.
    const otherComponent = await post("/api/v1/components", {
      name: "comp-dedupe-bound-other",
      service: service.id
    });
    otherChangeObjectId = await withTenantTx(server.deps.db, org.orgId, async (tx) => {
      const { change } = await proposeChange(tx, {
        orgId: org.orgId,
        actorObjectId: org.orgId,
        requestId: "decision-dedupe-bound-other",
        name: "change-dedupe-bound-other",
        targets: [otherComponent.id as string]
      });
      return change.id;
    });

    await withTenantTx(server.deps.db, org.orgId, async (tx) => {
      await tx.execute(sql`
        INSERT INTO decisions (id, org_id, kind, subject_id, verdict, input_context, reason_tree, created_at)
        SELECT gen_random_uuid(), ${org.orgId}::uuid, 'gate', ${otherChangeObjectId}::uuid, 'block',
               jsonb_build_object('waveIndex', 0, 'tick', i),
               jsonb_build_object('summary', 'blocked by 1 required policy (tick ' || i || ')'),
               now() + ((${SEEDED_DECISIONS} + i) * interval '2 seconds')
        FROM generate_series(1, ${SEEDED_DECISIONS}) i
      `);
      // `wave_target` for the OTHER change only: the kind the first arm probes for and must not
      // find. Without this the kind is absent from the whole org and the rival index answers in a
      // single descent, so the arm could not distinguish a working 0044 from a missing one.
      await tx.execute(sql`
        INSERT INTO decisions (id, org_id, kind, subject_id, verdict, input_context, reason_tree, created_at)
        SELECT gen_random_uuid(), ${org.orgId}::uuid, 'wave_target', ${otherChangeObjectId}::uuid, 'allow',
               jsonb_build_object('waveIndex', 0, 'tick', i),
               jsonb_build_object('summary', 'target driven (tick ' || i || ')'),
               now() + ((${SEEDED_DECISIONS} + i) * interval '2 seconds')
        FROM generate_series(1, ${SEEDED_DECISIONS}) i
      `);
    });
  });

  afterAll(async () => {
    await server.close();
  });

  it("probes O(1) rows for a kind this subject has NEVER recorded — every kind's FIRST dedupe call", async () => {
    await refreshDecisionStats();
    const { found, touched } = await withTenantTx(server.deps.db, org.orgId, async (tx) => {
      await preferIndexPlans(tx);
      const before = await decisionRowsTouched(tx);
      // `wave_target` is a real kind `reconcile.ts` writes, and the case measured at 22,793 ms /
      // 402,430 buffers pre-0044: absent for this subject, so the read has nothing to stop at and
      // (unindexed) walks every `gate` row the change holds before concluding "none".
      const hit = await latestDecisionForSubjectKind(tx, org.orgId, changeObjectId, "wave_target");
      const after = await decisionRowsTouched(tx);
      return { found: hit, touched: after - before };
    });

    // (a) CORRECTNESS FIRST — the bound must not change the answer.
    expect(found).toBeUndefined();

    // (b) THE BOUND. Measured 0 with drizzle/0069. See docs/coordination.md §406.
    expect(touched).toBeLessThanOrEqual(10);
    expect(touched).toBeLessThan(SEEDED_DECISIONS);
  });

  it("probes O(1) rows for a kind whose newest row is OLD, buried under the whole gate flood", async () => {
    await refreshDecisionStats();
    const { found, touched } = await withTenantTx(server.deps.db, org.orgId, async (tx) => {
      await preferIndexPlans(tx);
      const before = await decisionRowsTouched(tx);
      // `transition` is written when the change is PROPOSED, so its single row sits below all 400
      // seeded `gate` rows in `created_at` order — the migration's case (B), measured at 23,922 ms /
      // 402,429 buffers pre-0044. This is the shape `boundary-segment.ts` and `pre-deploy-gate.ts`
      // probe on every tick.
      const hit = await latestDecisionForSubjectKind(tx, org.orgId, changeObjectId, "transition");
      const after = await decisionRowsTouched(tx);
      return { found: hit, touched: after - before };
    });

    // (a) CORRECTNESS FIRST — it must still find the buried row, and find the right one.
    expect(found?.kind).toBe("transition");
    expect(found?.subjectId).toBe(changeObjectId);

    // (b) THE BOUND — one descent to the matching entry, not a walk down through 400 `gate` rows.
    expect(touched).toBeGreaterThan(0);
    expect(touched).toBeLessThanOrEqual(10);
    expect(touched).toBeLessThan(SEEDED_DECISIONS);
  });

  it("the dedupe probe is SERVED BY drizzle/0044's index — named, so a plan flip says which index it flipped to", async () => {
    // The same instrument the sibling read-bound test carries. See docs/coordination.md §407.
    await refreshDecisionStats();
    const { plan, sorts } = await withTenantTx(server.deps.db, org.orgId, async (tx) => {
      await preferIndexPlans(tx);
      const query = latestDecisionForSubjectKindQuery(tx, org.orgId, changeObjectId, "wave_target");
      return { plan: await indexesInPlan(tx, query), sorts: await sortNodesInPlan(tx, query) };
    });

    expect(plan).toContain("decisions_org_subject_kind_created");
    // THE HALF THE NAME CANNOT ASSERT — a prefix-keyed index still appears in the plan by name
    // under an `Incremental Sort` while supplying only part of the order, and `LIMIT 1` cannot
    // amortise a sort node's startup cost. See `sortNodesInPlan`.
    expect(sorts).toEqual([]);
    // The two indexes a flipped plan falls back to — both supply `ORDER BY created_at DESC, id DESC`
    // sortlessly and then filter the columns they do not carry off the heap, across the whole ORG.
    // `toContain` on an ARRAY is exact element equality, not substring, so this does not reject the
    // longer name asserted above. Do not "fix" it into a substring check.
    expect(plan).not.toContain("decisions_org_kind_created");
    expect(plan).not.toContain("decisions_org_created");
    expect(plan).not.toContain("decisions_org_subject");
  });
});
