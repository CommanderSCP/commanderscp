import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import type PgBoss from "pg-boss";
import { startPgBoss } from "../events/pgboss.js";
import { createIsolatedDomain } from "./test-support/isolated-domain.js";
import {
  FEDERATION_SYNC_QUEUE,
  FEDERATION_SYNC_STARTUP_REASON,
  startFederationSyncLoop,
  type FederationSyncLoopHandle
} from "./federation-sync.js";

/**
 * §4-A4, AFTER THE SECOND CORRECTION — federation-sync's startup send is UNKEYED, and the property
 * this file pins is LIVENESS: the forced pull-on-(re)connect must ALWAYS be enqueued.
 *
 * THIS FILE PREVIOUSLY ASSERTED THE OPPOSITE, and that is the whole lesson. It required two replicas
 * starting together to collapse to exactly ONE `"startup"`-keyed job, treating cross-replica dedupe as
 * the goal and a distinct key as the safe way to get it. The distinct key did fix the collision it was
 * aimed at (a pending `"tick"` job absorbing the startup send — still pinned below), but `job_i4` is
 * `WHERE state <> 'cancelled'`, so the slot is also held by COMPLETED jobs. The job a restarting worker
 * most reliably collides with is therefore ITS OWN PREVIOUS BOOT, and a swallowed startup send means no
 * forced pull: the loop still ticks on its interval, so nothing errors, nothing logs, and no health
 * check fails — the outpost is simply stale for a whole window. That is the reliability floor M14.4
 * added this send to hold up.
 *
 * It surfaced as a wall-clock-dependent CI flake (whether a restart shared a 10s bucket with the boot
 * before it), which is why a green run on a developer's machine meant nothing. The current gate for the
 * behaviour is `federation-sync-loop.integration.test.ts`'s RESTART case, which seeds the colliding
 * completed row so it fails 100% of the time against a keyed send rather than by luck.
 *
 * A test asserting a defect is worse than no test: it makes the fix look like the regression.
 */
describe("§4-A4 startFederationSyncLoop: the startup pull is always enqueued", () => {
  let previousLoopFlag: string | undefined;

  async function jobRows(
    adminUrl: string,
    queue: string
  ): Promise<{ singleton_key: string | null; data: { reason?: string } | null }[]> {
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    try {
      const res = await client.query<{
        singleton_key: string | null;
        data: { reason?: string } | null;
      }>(`SELECT singleton_key, data FROM pgboss.job WHERE name = $1`, [queue]);
      return res.rows;
    } finally {
      await client.end();
    }
  }

  /** The startup sends: unkeyed rows carrying `reason: "startup"`. */
  function startupRows(rows: { singleton_key: string | null; data: { reason?: string } | null }[]) {
    return rows.filter(
      (r) => r.singleton_key === null && r.data?.reason === FEDERATION_SYNC_STARTUP_REASON
    );
  }

  beforeAll(() => {
    previousLoopFlag = process.env.SCP_FEDERATION_SYNC_LOOP;
    process.env.SCP_FEDERATION_SYNC_LOOP = "1"; // the loop is DEFAULT-OFF without this.
  });

  afterAll(() => {
    if (previousLoopFlag === undefined) delete process.env.SCP_FEDERATION_SYNC_LOOP;
    else process.env.SCP_FEDERATION_SYNC_LOOP = previousLoopFlag;
  });

  it("two replicas starting together BOTH enqueue their startup pull — liveness beats dedupe", async () => {
    const domain = await createIsolatedDomain("fedsyncstartupdedupe");
    let boss1: PgBoss | undefined;
    let boss2: PgBoss | undefined;
    let loop1: FederationSyncLoopHandle | undefined;
    let loop2: FederationSyncLoopHandle | undefined;
    try {
      boss1 = await startPgBoss(domain.adminUrl);
      boss2 = await startPgBoss(domain.adminUrl);

      loop1 = await startFederationSyncLoop(boss1, domain.db);
      loop2 = await startFederationSyncLoop(boss2, domain.db);

      // THE DELIBERATE INVERSION of this test's original assertion (which demanded exactly 1).
      // Every constraint that collapses these two also lets a completed job swallow a restart's
      // send, and there is no window size that separates the two cases. The redundant pull is
      // cheap and self-correcting — a tick claims work per peer and imports advance a forward-only
      // cursor — whereas the swallowed one is silent and lasts a full interval.
      expect(startupRows(await jobRows(domain.adminUrl, FEDERATION_SYNC_QUEUE))).toHaveLength(2);
    } finally {
      await loop1?.stop();
      await loop2?.stop();
      await boss1?.stop({ graceful: false, timeout: 500 }).catch(() => undefined);
      await boss2?.stop({ graceful: false, timeout: 500 }).catch(() => undefined);
      await domain.close();
    }
  }, 60_000);

  it("neither a pending 'tick' NOR a completed 'startup' job can absorb the startup send", async () => {
    const domain = await createIsolatedDomain("fedsyncstartupcoexist");
    let boss: PgBoss | undefined;
    let loop: FederationSyncLoopHandle | undefined;
    try {
      boss = await startPgBoss(domain.adminUrl);
      await boss.createQueue(FEDERATION_SYNC_QUEUE);

      // OBSTACLE 1 (the original bug this file was written for): a self-rescheduled interval tick
      // from before the restart, still pending and far from due, occupying the shared "tick" slot.
      await boss.send(
        FEDERATION_SYNC_QUEUE,
        {},
        { startAfter: 3_600, singletonKey: "tick", singletonSeconds: 3_600 }
      );

      // OBSTACLE 2 (the bug the FIRST fix introduced): this worker's OWN previous boot, already
      // completed, sitting in the bucket a `singletonKey: "startup"` + `singletonSeconds: 10` send
      // would target. `singleton_on` is a truncated bucket, not `now()` — the expression is copied
      // from pg-boss 10.4.2 `src/plans.js`. Both the current and next bucket are seeded so a
      // rollover between this insert and the send below cannot quietly un-reproduce the collision.
      const client = new pg.Client({ connectionString: domain.adminUrl });
      await client.connect();
      try {
        for (const offset of [0, 1]) {
          await client.query(
            `INSERT INTO pgboss.job (id, name, data, state, singleton_key, singleton_on, completed_on)
             VALUES (gen_random_uuid(), $1, '{"reason":"startup"}'::jsonb, 'completed', 'startup',
                     'epoch'::timestamp + '1 second'::interval * (10 * (floor(date_part('epoch', now()) / 10) + ${offset})),
                     now())`,
            [FEDERATION_SYNC_QUEUE]
          );
        }
      } finally {
        await client.end();
      }

      loop = await startFederationSyncLoop(boss, domain.db);

      const rows = await jobRows(domain.adminUrl, FEDERATION_SYNC_QUEUE);
      // The pre-existing pending tick survived, untouched — the startup send did not consume it.
      expect(rows.some((r) => r.singleton_key === "tick")).toBe(true);
      // …and the startup pull got through BOTH obstacles. Being unkeyed, it leaves `singleton_on`
      // NULL, which `job_i4`'s own `WHERE singleton_on IS NOT NULL` excludes from the index
      // entirely — so there is no slot for anything to have taken.
      expect(
        startupRows(rows),
        "the startup pull was swallowed — the loop came back with no pull-on-(re)connect, silently"
      ).toHaveLength(1);
    } finally {
      await loop?.stop();
      await boss?.stop({ graceful: false, timeout: 500 }).catch(() => undefined);
      await domain.close();
    }
  }, 60_000);
});
