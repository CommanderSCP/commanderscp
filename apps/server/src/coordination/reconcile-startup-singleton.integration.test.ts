import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import type PgBoss from "pg-boss";
import { startPgBoss, LOOP_STARTUP_SINGLETON_KEY } from "../events/pgboss.js";
import { getSharedCelSandbox } from "../governance/cel-sandbox.js";
import type { PluginHost } from "../plugin-host/contract.js";
import {
  createIsolatedDomain,
  type IsolatedDomain
} from "../federation/test-support/isolated-domain.js";
import { RECONCILE_QUEUE, startReconcileLoop, type ReconcileLoopHandle } from "./reconcile.js";

/**
 * §4-A4 / §7.1 item 4: `startReconcileLoop`'s INITIAL `boss.send` is singleton-keyed, so N replicas
 * restarting together produce ONE startup tick rather than an N-way first tick (before A4 it was a
 * plain unconstrained `boss.send(RECONCILE_QUEUE, {})`).
 *
 * IT USES ITS OWN KEY, NOT THE CHAIN'S `"tick"` — and that distinction is the whole point, learned
 * the hard way. A4 first shipped with the startup send reusing `"tick"` + the chain's
 * `singletonSeconds`; pg-boss counts COMPLETED jobs as still holding the singleton slot and buckets
 * `singleton_on` by wall clock, so the startup kick and the chain's own reschedule silently
 * swallowed each other (`ON CONFLICT DO NOTHING`, returning null, unchecked). A self-rescheduling
 * loop has no other tick source, so the loop simply DIED — measured at ~58 of every 60 boots for the
 * 60-second loops, in production as well as in CI. `events/pgboss.ts`'s
 * `LOOP_STARTUP_SINGLETON_KEY` carries the full account; `coordination/loop-startup-singleton.test.ts`
 * is the census that keeps every loop honest. This file pins the two behaviours at the real
 * `pgboss.job` table, mirroring `federation-sync-startup-singleton.integration.test.ts`.
 *
 * This never fires against `reconcileOrgTick` itself (an empty isolated domain has no changes to
 * advance, so the stub `PluginHost` below is never called) — it proves the pg-boss WIRING, which is
 * exactly the layer the bug lived at.
 */
describe("§4-A4 startReconcileLoop: startup gets its OWN singleton key", () => {
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

  async function singletonKeyedJobCount(singletonKey: string): Promise<number> {
    const client = new pg.Client({ connectionString: domain.adminUrl });
    await client.connect();
    try {
      const res = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM pgboss.job WHERE name = $1 AND singleton_key = $2`,
        [RECONCILE_QUEUE, singletonKey]
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

  it("two replicas starting together produce exactly ONE 'startup'-keyed job, not two", async () => {
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

    // Without A4 this is 2 (one per replica's unconstrained startup send); with it, pg-boss's own
    // singleton index collapses the second insert.
    expect(await singletonKeyedJobCount(LOOP_STARTUP_SINGLETON_KEY)).toBe(1);
  });

  it("the startup key is NOT the chain's 'tick' — a completed chain tick can never swallow the startup kick", async () => {
    // THE REGRESSION THIS FILE EXISTS TO CATCH, and the one that shipped. Occupy the chain's `"tick"`
    // slot exactly as a just-completed reschedule would, then start a loop: its startup kick must
    // still be inserted. When the two shared a key this returned 0 and the loop was dead on arrival.
    const client = new pg.Client({ connectionString: domain.adminUrl });
    await client.connect();
    let before = 0;
    try {
      await client.query(`DELETE FROM pgboss.job WHERE name = $1`, [RECONCILE_QUEUE]);
      // A COMPLETED job still holds pg-boss's singleton slot — that is precisely why sharing the key
      // is fatal, so the fixture must be a completed one, not a pending one.
      await client.query(
        `INSERT INTO pgboss.job (id, name, data, state, singleton_key, singleton_on, completed_on)
         VALUES (gen_random_uuid(), $1, '{}'::jsonb, 'completed', 'tick', now(), now())`,
        [RECONCILE_QUEUE]
      );
      before = await singletonKeyedJobCount(LOOP_STARTUP_SINGLETON_KEY);
    } finally {
      await client.end();
    }
    expect(before).toBe(0);

    const loop3 = await startReconcileLoop(
      boss1,
      domain.db,
      stubHost,
      getSharedCelSandbox(),
      Buffer.alloc(32)
    );
    try {
      expect(
        await singletonKeyedJobCount(LOOP_STARTUP_SINGLETON_KEY),
        "a completed 'tick' job swallowed the startup kick — the loop would never tick again"
      ).toBe(1);
    } finally {
      await loop3.stop();
    }
  });
});
