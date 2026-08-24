import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import type PgBoss from "pg-boss";
import { startPgBoss } from "../events/pgboss.js";
import { createIsolatedDomain, type IsolatedDomain } from "./test-support/isolated-domain.js";
import {
  FEDERATION_SYNC_QUEUE,
  FEDERATION_SYNC_STARTUP_REASON,
  FEDERATION_SYNC_STARTUP_SINGLETON_SECONDS,
  startFederationSyncLoop,
  type FederationSyncLoopHandle
} from "./federation-sync.js";

/**
 * §4-A4 / §7.1 item 4: federation-sync is the DELIBERATE EXCEPTION among the six self-rescheduling
 * loops. Its startup send is a forced pull-on-(re)connect (M14.4) that must survive even when a
 * still-pending interval tick already occupies the shared `"tick"` singleton slot — giving it that
 * SAME key (the uniform fix every other loop gets) would let the pending tick silently swallow it,
 * reintroducing the exact bug `wakeFederationSyncNow`'s own doc warns about. Its fix is therefore a
 * DISTINCT `"startup"` key with a short window, asserted here at the real `pgboss.job` table:
 *
 *   1. N replicas restarting together dedupe among THEMSELVES on `"startup"` (same shape as the
 *      other five loops' fix, just under its own key).
 *   2. A `"startup"` send is never absorbed by an already-pending `"tick"` job — two distinct
 *      singleton keys coexist on the same queue.
 */
describe("§4-A4 startFederationSyncLoop: startup gets its own singleton key", () => {
  let previousLoopFlag: string | undefined;

  async function jobRows(
    adminUrl: string,
    queue: string
  ): Promise<{ singleton_key: string | null }[]> {
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    try {
      const res = await client.query<{ singleton_key: string | null }>(
        `SELECT singleton_key FROM pgboss.job WHERE name = $1`,
        [queue]
      );
      return res.rows;
    } finally {
      await client.end();
    }
  }

  beforeAll(() => {
    previousLoopFlag = process.env.SCP_FEDERATION_SYNC_LOOP;
    process.env.SCP_FEDERATION_SYNC_LOOP = "1"; // the loop is DEFAULT-OFF without this.
  });

  afterAll(() => {
    if (previousLoopFlag === undefined) delete process.env.SCP_FEDERATION_SYNC_LOOP;
    else process.env.SCP_FEDERATION_SYNC_LOOP = previousLoopFlag;
  });

  it("two replicas starting together produce exactly ONE 'startup'-keyed job, not two", async () => {
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

      const rows = await jobRows(domain.adminUrl, FEDERATION_SYNC_QUEUE);
      const startupRows = rows.filter((r) => r.singleton_key === FEDERATION_SYNC_STARTUP_REASON);
      // Without the fix, each replica's startup send carried NO singleton constraint at all, so
      // both would have landed as two unconstrained rows.
      expect(startupRows).toHaveLength(1);
    } finally {
      await loop1?.stop();
      await loop2?.stop();
      await boss1?.stop({ graceful: false, timeout: 500 }).catch(() => undefined);
      await boss2?.stop({ graceful: false, timeout: 500 }).catch(() => undefined);
      await domain.close();
    }
  }, 60_000);

  it("a pending 'tick' job does NOT absorb the 'startup' send — two distinct singleton keys coexist", async () => {
    const domain = await createIsolatedDomain("fedsyncstartupcoexist");
    let boss: PgBoss | undefined;
    let loop: FederationSyncLoopHandle | undefined;
    try {
      boss = await startPgBoss(domain.adminUrl);
      await boss.createQueue(FEDERATION_SYNC_QUEUE);
      // Simulate the restart scenario the bug lived in: a self-rescheduled interval tick from
      // BEFORE the restart is still sitting in the queue, far from due, occupying the shared
      // "tick" singleton slot.
      await boss.send(
        FEDERATION_SYNC_QUEUE,
        {},
        { startAfter: 3_600, singletonKey: "tick", singletonSeconds: 3_600 }
      );

      loop = await startFederationSyncLoop(boss, domain.db);

      const rows = await jobRows(domain.adminUrl, FEDERATION_SYNC_QUEUE);
      const keys = new Set(rows.map((r) => r.singleton_key));
      expect(keys.has("tick")).toBe(true); // the pre-existing pending tick survived, untouched.
      expect(keys.has(FEDERATION_SYNC_STARTUP_REASON)).toBe(true); // the startup send got through.
      expect(FEDERATION_SYNC_STARTUP_SINGLETON_SECONDS).toBeGreaterThan(0);
    } finally {
      await loop?.stop();
      await boss?.stop({ graceful: false, timeout: 500 }).catch(() => undefined);
      await domain.close();
    }
  }, 60_000);
});
