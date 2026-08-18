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

/**
 * THE BOUND ON THE PERSIST-ON-CHANGE DEDUPE READ — i.e. THE TEST FOR drizzle/0044.
 *
 * `insertDecisionIfChanged` is only cheap because `latestDecisionForSubjectKind` is one index
 * probe, and it is one index probe only because drizzle/0044 adds
 * `(org_id, subject_id, kind, created_at DESC)`. WITHOUT that index `kind` is a HEAP FILTER on a
 * backward walk of `decisions_org_subject`, so the read costs O(the subject's rows of OTHER kinds)
 * — measured on a 12M-row reproduction of the live homelab distribution at 22,202 ms / 424,745
 * buffers per probe, once per ~2 s tick per parked change.
 *
 * WHY THIS FILE EXISTS AT ALL. Every other test of this PR asserts on a RETURN VALUE, and the
 * index does not change any return value — so before this suite, commenting the `CREATE INDEX` out
 * of drizzle/0044 left all four new suites (4 files / 9 tests) GREEN. The migration that the whole
 * P1 round exists to add had no test, and losing it (a `schema.ts` edit, a drizzle-kit
 * regeneration, a hand-rolled migration squash) would silently restore the original pathology with
 * a green board. drizzle/0046 was already covered this way by
 * `service-board-decision-read-bound.integration.test.ts`; this is the same instrument pointed at
 * the read 0044 covers.
 *
 * WHAT IT MEASURES AND WHY THAT AND NOT LATENCY. Rows touched, from Postgres's own
 * transaction-local counters (see `test-support/decision-read-counters.ts`). A latency assertion
 * would be a flake, and an assertion on the answer would be VACUOUS — the unindexed read returns
 * the identical row.
 *
 * MUTATION-PROVEN: removing the `CREATE INDEX` from drizzle/0044 takes the ABSENT-kind probe from
 * 1 row touched to 401 and fails this suite (`expected 401 to be less than or equal to 10`).
 *
 * TWO THINGS THIS SUITE MEASURED WRONG UNTIL drizzle/0069, both of which made it green for reasons
 * unrelated to the index it names:
 *
 *   1. NO STATISTICS. It seeded and measured within a couple of seconds, so `pg_statistic` for
 *      `decisions` was empty and every equality was costed at `DEFAULT_EQ_SEL`. In that regime the
 *      planner prices the sortless rival index at its full length and picks 0044's — for a reason
 *      that evaporates the moment autoanalyze runs, which on a live instance it always has.
 *      `refreshDecisionStats` now puts the table in the production regime before each measurement.
 *   2. A ONE-SUBJECT FIXTURE. With a single change in the org, `decisions_org_kind_created` (0056,
 *      `(org_id, kind, created_at, id)`) answers "the newest `transition` in this org" in ONE entry
 *      and it happens to belong to the only subject there is — so the probe was cheap whether or
 *      not 0044's index existed or was usable. The bound could not tell the two apart. A SECOND
 *      change now carries the same kinds, so answering by walking the org's stream of a kind costs
 *      the other change's rows and the bound bites.
 *
 * MUTATION-PROVEN, 2026-08-17: reverting only drizzle/0069's `id DESC` tiebreak on
 * `decisions_org_subject_kind_created` takes the absent-kind arm from 0 rows touched to 400 and
 * flips the plan to `decisions_org_kind_created`, failing both the count and the plan arm. Under
 * the OLD one-subject fixture the same revert left this suite entirely GREEN.
 */
describe("persist-on-change: the dedupe read is one index probe, not a walk of the subject's history", () => {
  let server: TestServer;
  let org: TestOrg;
  let changeObjectId: string;
  /**
   * A SECOND subject carrying the SAME kinds, so `decisions_org_kind_created` cannot answer any
   * probe below by luck — the org's stream of `gate` and of `transition` no longer belongs to one
   * change. See (2) in this suite's header.
   */
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

    // THE PRODUCTION SHAPE: one subject carrying a long `gate` history, which is what every OTHER
    // kind's dedupe probe has to get past. `created_at` values are 2 s apart and DISTINCT, as the
    // real flood was (one row per reconcile tick, each in its OWN transaction) — `created_at`
    // defaults to `now()`, which is TRANSACTION start time, so rows written in one loop inside one
    // transaction would all share a timestamp and `ORDER BY created_at DESC, id DESC` would have to
    // read the whole tied group to break the tie on `id`, making even the indexed read touch every
    // row. Written raw (not via `insertDecision`, which cannot set `created_at`) and deliberately
    // WITHOUT the dedupe guard: this is about the READ side, and must hold for a table that
    // accumulated a flood before persist-on-change landed.
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

    // (b) THE BOUND. Measured 0 with drizzle/0069: the descent finds no entry for
    // (org, subject, 'wave_target') and returns without charging one. `<= 10` leaves headroom for
    // the constant a different plan shape would charge; WITHOUT drizzle/0044 this is 401 — every
    // row the subject holds, discarded by a heap filter, to return `undefined`. Reverting only
    // 0044's `id DESC` tiebreak takes it to 400: the plan falls back to `decisions_org_kind_created`
    // and walks every `wave_target` row in the ORG instead, which is the SAME defect the service
    // board's 804 is, one index over.
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
    // THE SAME INSTRUMENT `service-board-decision-read-bound.integration.test.ts` carries for
    // drizzle/0046, pointed at the read 0044 covers — added because the two indexes turned out to
    // share a defect, and only one of them had an arm that could have named it. A row count says
    // "804"; this says WHICH index served the read instead, which is the whole diagnosis.
    //
    // It explains the BUILDER `latestDecisionForSubjectKind` itself runs, not a re-typed copy.
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
