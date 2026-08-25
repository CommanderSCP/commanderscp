import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import type PgBoss from "pg-boss";
import { startPgBoss } from "../events/pgboss.js";
import { getSharedCelSandbox } from "../governance/cel-sandbox.js";
import type { PluginHost } from "../plugin-host/contract.js";
import {
  createIsolatedDomain,
  type IsolatedDomain
} from "../federation/test-support/isolated-domain.js";
import { RECONCILE_QUEUE, startReconcileLoop, type ReconcileLoopHandle } from "./reconcile.js";

/**
 * §4-A4 / §7.1 item 4, AFTER TWO CORRECTIONS: `startReconcileLoop`'s startup kick is sent UNKEYED,
 * and the property that matters is LIVENESS — it must always insert.
 *
 * A4 shipped wanting the opposite (N replicas booting together collapse to ONE startup tick) and
 * every implementation of that goal turned out to be fatal, because pg-boss's only applicable index
 * (`job_i4`, see events/pgboss.ts) counts COMPLETED jobs as holding the singleton slot:
 *   1. sharing the chain's `"tick"` key killed the 60s loops after a single sweep, on ~58 of every
 *      60 boots, in production as well as CI;
 *   2. its own key + a 10s window then killed CRASH RESUMPTION — a worker that died mid-tick (so the
 *      chain never rescheduled) and restarted inside the window had its kick swallowed by its OWN
 *      previous boot and came back dead.
 * A dead loop has no error, no log and no failing health check, which is the same shape as the
 * starvation bug that stopped production coordination for 13 days. Redundant startup sweeps, the
 * thing A4 was avoiding, are merely wasteful — every sweep claims its rows with FOR UPDATE SKIP
 * LOCKED. `coordination/loop-startup-singleton.test.ts` is the census that keeps every loop honest.
 *
 * This never fires against `reconcileOrgTick` itself (an empty isolated domain has no changes to
 * advance, so the stub `PluginHost` below is never called) — it proves the pg-boss WIRING, which is
 * exactly the layer the bug lived at.
 */
describe("§4-A4 startReconcileLoop: the startup kick always inserts", () => {
  let domain: IsolatedDomain;
  let boss1: PgBoss;
  let boss2: PgBoss;
  let loop1: ReconcileLoopHandle | undefined;
  let loop2: ReconcileLoopHandle | undefined;

  // Every method throws — an empty isolated domain has no changes in flight, so `reconcileOrgTick`
  // never reaches a step that would call the host. If it ever did, this stub fails the test loudly
  // rather than pretending to be a real executor.
  const stubHost = {
    start: () => {
      throw new Error("not used");
    },
    stop: () => {
      throw new Error("not used");
    },
    stopInstances: () => {
      throw new Error("not used");
    },
    trigger: () => {
      throw new Error("not used");
    },
    discovery: () => {
      throw new Error("not used");
    },
    notification: () => {
      throw new Error("not used");
    },
    federationTransport: () => {
      throw new Error("not used");
    },
    dependencyIndex: () => {
      throw new Error("not used");
    },
    gitFileRead: () => {
      throw new Error("not used");
    }
  } as unknown as PluginHost;

  /** Startup kicks are UNKEYED, so they are the rows with no singleton_key at all. */
  async function unkeyedStartupJobCount(): Promise<number> {
    const client = new pg.Client({ connectionString: domain.adminUrl });
    await client.connect();
    try {
      const res = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM pgboss.job WHERE name = $1 AND singleton_key IS NULL`,
        [RECONCILE_QUEUE]
      );
      return Number(res.rows[0]?.count ?? "0");
    } finally {
      await client.end();
    }
  }

  beforeAll(async () => {
    domain = await createIsolatedDomain("reconcilestartupsingleton");
    // Two independent pg-boss connections against the SAME database — modelling two replicas
    // that each call `startReconcileLoop` on their own boot, exactly as N `scpd worker` pods do.
    boss1 = await startPgBoss(domain.adminUrl);
    boss2 = await startPgBoss(domain.adminUrl);
  }, 120_000);

  afterAll(async () => {
    await loop1?.stop();
    await loop2?.stop();
    await boss1?.stop({ graceful: false, timeout: 500 }).catch(() => undefined);
    await boss2?.stop({ graceful: false, timeout: 500 }).catch(() => undefined);
    await domain?.close();
  });

  it("two replicas starting together BOTH get a startup job — liveness beats dedupe", async () => {
    // Sequential, not `Promise.all` — the property under test is pg-boss's own singleton
    // constraint at INSERT, which fires regardless of ordering; sequential keeps the assertion
    // below race-free against pg-boss's own polling loop (default 2s), which has not had a chance
    // to run yet either way.
    loop1 = await startReconcileLoop(
      boss1,
      domain.db,
      stubHost,
      getSharedCelSandbox(),
      Buffer.alloc(32)
    );
    loop2 = await startReconcileLoop(
      boss2,
      domain.db,
      stubHost,
      getSharedCelSandbox(),
      Buffer.alloc(32)
    );

    // A4 originally collapsed these to ONE job. That dedupe is deliberately GONE: every key/window
    // that achieves it also lets a COMPLETED job swallow a later kick, and a swallowed kick is a
    // permanently dead loop (see events/pgboss.ts). Redundant startup sweeps are safe — they claim
    // rows with FOR UPDATE SKIP LOCKED, the same property that makes N competing workers correct.
    expect(await unkeyedStartupJobCount()).toBe(2);
  });

  it("a COMPLETED 'tick' job can never swallow the startup kick (the regression that shipped twice)", async () => {
    // THE PROPERTY THIS FILE EXISTS FOR. Occupy the chain's `"tick"` slot exactly as a just-completed
    // reschedule would, then start a loop: its kick must STILL be inserted. When the kick shared the
    // chain's key this was 0 and the loop was dead on arrival; when it had its own key + window, the
    // same shape killed crash-resumption instead. Unkeyed, it always inserts.
    const client = new pg.Client({ connectionString: domain.adminUrl });
    await client.connect();
    try {
      await client.query(`DELETE FROM pgboss.job WHERE name = $1`, [RECONCILE_QUEUE]);
      await client.query(
        `INSERT INTO pgboss.job (id, name, data, state, singleton_key, singleton_on, completed_on)
         VALUES (gen_random_uuid(), $1, '{}'::jsonb, 'completed', 'tick', now(), now())`,
        [RECONCILE_QUEUE]
      );
    } finally {
      await client.end();
    }
    expect(await unkeyedStartupJobCount()).toBe(0);

    const loop3 = await startReconcileLoop(
      boss1,
      domain.db,
      stubHost,
      getSharedCelSandbox(),
      Buffer.alloc(32)
    );
    try {
      expect(
        await unkeyedStartupJobCount(),
        "a completed 'tick' job swallowed the startup kick — the loop would never tick again"
      ).toBe(1);
    } finally {
      await loop3.stop();
    }
  });
});
