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
 * §4-A4 / §7.1 item 4: `startReconcileLoop`'s INITIAL `boss.send` now carries the SAME
 * `singletonKey`/`singletonSeconds` as its reschedule send. Before this fix the initial send was a
 * plain `boss.send(RECONCILE_QUEUE, {})` with no singleton constraint at all, so N replicas
 * restarting together each inserted their own unconstrained startup job — an N-way first tick.
 *
 * This never fires against `reconcileOrgTick` itself (an empty isolated domain has no changes to
 * advance, so the stub `PluginHost` below is never called) — it proves the pg-boss WIRING, at the
 * real `pgboss.job` table, which is exactly the layer the bug lived at.
 */
describe("§4-A4 startReconcileLoop: initial send is singleton-keyed", () => {
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

  it("two replicas starting together produce exactly ONE 'tick'-keyed job, not two", async () => {
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

    // Without the fix this is 2 (one per replica's unconstrained startup send); with it, pg-boss's
    // own singleton index collapses the second insert.
    expect(await singletonKeyedJobCount("tick")).toBe(1);
  });
});
