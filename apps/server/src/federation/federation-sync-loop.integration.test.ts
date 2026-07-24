import { randomUUID, generateKeyPairSync } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import type PgBoss from "pg-boss";
import { withTenantTx } from "../db/tenant-tx.js";
import { startPgBoss } from "../events/pgboss.js";
import { testPgBossDatabaseUrl } from "../test-support/harness.js";
import { createIsolatedDomain, type IsolatedDomain } from "./test-support/isolated-domain.js";
import { listPeers, pairPeer } from "./peers-repo.js";
import {
  FEDERATION_SYNC_QUEUE,
  startFederationSyncLoop,
  wakeFederationSyncNow,
  type FederationSyncLoopHandle
} from "./federation-sync.js";

/**
 * M14.4 (test g) — THE WAKE AT THE REAL pg-boss LEVEL. Everything else in this milestone drives
 * `federationSyncOrgTick` directly; this file proves the queue wiring the poke actually depends on:
 *
 *   1. with a FUTURE-DATED interval job already pending (the loop's own self-reschedule), a
 *      `wakeFederationSyncNow` runs the handler within a couple of seconds — the wake is NOT
 *      swallowed by the pending singleton tick; and
 *   2. that wake is a FORCED tick: it pulls a peer whose due-window has NOT elapsed. Without the
 *      `{reason:"poke"}` payload → `force` plumbing, the M14.4 due-gate would answer "not due for
 *      another 59 seconds" and the poke would silently do nothing; and
 *   3. it leaves NO MORE THAN ONE pending interval job — a forced tick must not re-schedule, or
 *      poke traffic would insert extra pending ticks (pg-boss computes a singleton slot from now()
 *      AT INSERT) and make the "sparse" loop non-deterministically denser.
 *
 * The observable side effect is `federation_peers.last_pull_attempt_at`, stamped by the scheduler's
 * atomic claim. The peer's baseUrl points at a closed port, so the pull itself fails fast — this
 * file tests the SCHEDULING, not the transport (that is `federation-sync.integration.test.ts`).
 */
describe("M14.4 federation-sync loop — the poke wake at the pg-boss level", () => {
  let boss: PgBoss;
  let domain: IsolatedDomain;
  let loop: FederationSyncLoopHandle;
  let peerId: string;
  let previousLoopFlag: string | undefined;

  async function lastAttemptMs(): Promise<number | null> {
    const peers = await withTenantTx(domain.db, domain.orgId, (tx) => listPeers(tx, domain.orgId));
    const attempt = peers.find((p) => p.id === peerId)?.lastPullAttemptAt;
    return attempt ? Date.parse(attempt) : null;
  }

  async function waitFor<T>(
    probe: () => Promise<T | null>,
    timeoutMs = 20_000
  ): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const value = await probe();
      if (value !== null && value !== undefined) return value;
      if (Date.now() > deadline) throw new Error("timed out waiting for the scheduler");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  /** Jobs still waiting to run on the sync queue (pg-boss `created` state). */
  async function pendingJobs(): Promise<number> {
    const client = new pg.Client({ connectionString: testPgBossDatabaseUrl() });
    await client.connect();
    try {
      const res = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM pgboss.job WHERE name = $1 AND state = 'created'`,
        [FEDERATION_SYNC_QUEUE]
      );
      return Number(res.rows[0]?.count ?? "0");
    } finally {
      await client.end();
    }
  }

  beforeAll(async () => {
    previousLoopFlag = process.env.SCP_FEDERATION_SYNC_LOOP;
    process.env.SCP_FEDERATION_SYNC_LOOP = "1"; // the loop is DEFAULT-OFF without this.
    boss = await startPgBoss(testPgBossDatabaseUrl());
    domain = await createIsolatedDomain("syncloop");

    peerId = randomUUID();
    const { publicKey } = generateKeyPairSync("ed25519");
    await withTenantTx(domain.db, domain.orgId, (tx) =>
      pairPeer(tx, {
        orgId: domain.orgId,
        domainId: peerId,
        name: "unreachable-commander",
        role: "commander",
        publicKey: publicKey.export({ format: "der", type: "spki" }).toString("base64"),
        // A closed port: the dial fails fast. plain http => no mTLS material is required, so the
        // failure is a transient error rather than a fail-closed refusal. Either way the CLAIM ran.
        baseUrl: "http://127.0.0.1:9"
      })
    );
  }, 120_000);

  afterAll(async () => {
    await loop?.stop();
    await boss?.stop({ graceful: false });
    await domain?.close();
    if (previousLoopFlag === undefined) delete process.env.SCP_FEDERATION_SYNC_LOOP;
    else process.env.SCP_FEDERATION_SYNC_LOOP = previousLoopFlag;
  });

  it("pull-on-startup fires, then a poke wake runs a FORCED tick within seconds and adds no extra pending tick", async () => {
    loop = await startFederationSyncLoop(boss, domain.db);

    // 1. PULL-ON-STARTUP — the loop's first immediate tick claims the peer.
    const firstAttempt = await waitFor(lastAttemptMs);
    expect(firstAttempt).toBeGreaterThan(0);

    // Exactly one pending job now: the interval tick the handler re-scheduled ~60s out.
    await waitFor(async () => ((await pendingJobs()) >= 1 ? true : null));
    expect(await pendingJobs()).toBe(1);

    // 2. THE POKE. The peer was attempted moments ago, so it is NOT due — only the forced tick can
    //    make this pull happen at all.
    await wakeFederationSyncNow(boss, domain.orgId);
    const secondAttempt = await waitFor(async () => {
      const value = await lastAttemptMs();
      return value !== null && value > firstAttempt ? value : null;
    }, 20_000);
    expect(secondAttempt).toBeGreaterThan(firstAttempt);

    // 3. NO POKE-INDUCED DUPLICATE TICKS — the forced tick did not re-schedule.
    expect(await pendingJobs()).toBeLessThanOrEqual(1);
  }, 60_000);
});
