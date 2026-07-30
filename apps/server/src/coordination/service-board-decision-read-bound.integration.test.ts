import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import {
  buildTestServer,
  createTestOrg,
  type TestOrg,
  type TestServer
} from "../test-support/harness.js";
import { withTenantTx, type TenantTx } from "../db/tenant-tx.js";
import { getObjectByIdOrUrnAnyType } from "../graph/objects-repo.js";
import { proposeChange } from "./changes-repo.js";
import { buildServiceBoard } from "./service-board.js";

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
 */
describe("service board: the per-row Decision read is bounded, not the change's whole history", () => {
  let server: TestServer;
  let org: TestOrg;
  let serviceId: string;
  let componentId: string;
  let changeObjectId: string;

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
  });

  afterAll(async () => {
    await server.close();
  });

  /**
   * MAKE A 400-ROW TABLE CHOOSE THE PLAN A 12,000,000-ROW ONE WOULD. On a table this small a
   * sequential scan is genuinely the cheapest plan for either read, so both would report "all rows
   * touched" and the counter could not tell a `LIMIT 1` probe from a full history fetch. Disabling
   * seq scans FOR THIS TRANSACTION ONLY makes the plan shape match production, where the index is
   * chosen because the table is large — which is the regime the bound exists for.
   *
   * This is a MEASUREMENT INSTRUMENT in a test, never a production knob: no `SET`/hint of any kind
   * exists in `service-board.ts` or `decisions-repo.ts`, and the reason the production read is fast
   * is drizzle/0044's index plus the `LIMIT`, not a session setting. `SET LOCAL` dies with the
   * transaction.
   */
  async function preferIndexPlans(tx: TenantTx): Promise<void> {
    await tx.execute(sql`SET LOCAL enable_seqscan = off`);
  }

  /** Index entries returned + sequential-scan rows read for `decisions` IN THIS TRANSACTION. */
  async function decisionRowsTouched(tx: TenantTx): Promise<number> {
    const rows = await tx.execute(sql`
      SELECT
        COALESCE(
          (SELECT sum(pg_stat_get_xact_tuples_returned(indexrelid))
             FROM pg_index WHERE indrelid = 'decisions'::regclass), 0)
        + pg_stat_get_xact_tuples_returned('decisions'::regclass) AS touched
    `);
    const first = (rows as unknown as { rows: Array<{ touched: string | number }> }).rows[0];
    return Number(first?.touched ?? 0);
  }

  it("reads O(1) rows out of `decisions` per board row, whatever the change's history holds — and still reports the LATEST block", async () => {
    const { board, touched, seeded } = await withTenantTx(
      server.deps.db,
      org.orgId,
      async (tx) => {
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
      }
    );

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
});
