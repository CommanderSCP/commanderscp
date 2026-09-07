import { randomUUID, generateKeyPairSync } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import pg from "pg";
import type PgBoss from "pg-boss";
import { withTenantTx } from "../db/tenant-tx.js";
import { federationPeers } from "../db/schema.js";
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
import { TrustDomainId } from "@scp/schemas";
import { asTrustDomainId } from "@scp/schemas";

/** M14.4 (test g) — THE WAKE AT THE REAL pg-boss LEVEL. See docs/federation.md §149. */
describe("M14.4 federation-sync loop — the poke wake at the pg-boss level", () => {
  let boss: PgBoss;
  let domain: IsolatedDomain;
  let loop: FederationSyncLoopHandle;
  let peerId: TrustDomainId;
  let previousLoopFlag: string | undefined;

  async function lastAttemptMs(): Promise<number | null> {
    const peers = await withTenantTx(domain.db, domain.orgId, (tx) => listPeers(tx, domain.orgId));
    const attempt = peers.find((p) => p.id === peerId)?.lastPullAttemptAt;
    return attempt ? Date.parse(attempt) : null;
  }

  async function waitFor<T>(probe: () => Promise<T | null>, timeoutMs = 20_000): Promise<T> {
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

  /** Inserts a completed job into the singleton slot. See docs/federation.md §150. */
  async function seedCompletedStartupJob(): Promise<void> {
    // `singleton_on` is NOT `now()`. See docs/federation.md §151.
    const bucket = (offsetBuckets: number) =>
      `'epoch'::timestamp + '1 second'::interval * (10 * (floor(date_part('epoch', now()) / 10) + ${offsetBuckets}))`;
    const client = new pg.Client({ connectionString: testPgBossDatabaseUrl() });
    await client.connect();
    try {
      for (const offset of [0, 1]) {
        await client.query(
          `INSERT INTO pgboss.job (id, name, data, state, singleton_key, singleton_on, completed_on)
           VALUES (gen_random_uuid(), $1, '{"reason":"startup"}'::jsonb, 'completed', 'startup', ${bucket(offset)}, now())`,
          [FEDERATION_SYNC_QUEUE]
        );
      }
    } finally {
      await client.end();
    }
  }

  /** Clears the queue so a restart scenario starts from a known, empty pending set. */
  async function clearPendingJobs(): Promise<void> {
    const client = new pg.Client({ connectionString: testPgBossDatabaseUrl() });
    await client.connect();
    try {
      await client.query(`DELETE FROM pgboss.job WHERE name = $1 AND state = 'created'`, [
        FEDERATION_SYNC_QUEUE
      ]);
    } finally {
      await client.end();
    }
  }

  beforeAll(async () => {
    previousLoopFlag = process.env.SCP_FEDERATION_SYNC_LOOP;
    process.env.SCP_FEDERATION_SYNC_LOOP = "1"; // the loop is DEFAULT-OFF without this.
    boss = await startPgBoss(testPgBossDatabaseUrl());
    domain = await createIsolatedDomain("syncloop");

    peerId = asTrustDomainId(randomUUID());
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

  /** The restart case the original startup tick silently lost. See docs/federation.md §152. */
  it("RESTART: the startup tick FORCES past the due-gate for an already-attempted peer AND leaves exactly one pending interval job", async () => {
    // Tear the first loop down COMPLETELY (offWork unsubscribes the worker, not just the flag) so
    // only the restarted loop can service the queue.
    await loop.stop();
    await boss.offWork(FEDERATION_SYNC_QUEUE);
    await clearPendingJobs();

    // The restart scenario: a proven poke-mode peer whose last pull SUCCEEDED seconds ago. It is
    // not due under EITHER cadence (2s elapsed < the 60s frequent floor, let alone the 900s sparse
    // one), so only a forced tick can pull it.
    const justNow = new Date(Date.now() - 2_000);
    await withTenantTx(domain.db, domain.orgId, (tx) =>
      tx
        .update(federationPeers)
        .set({
          pokeMode: true,
          lastPokeReceivedAt: justNow,
          lastPullAttemptAt: justNow,
          lastPullSuccessAt: justNow
        })
        .where(and(eq(federationPeers.orgId, domain.orgId), eq(federationPeers.id, peerId)))
    );
    expect(await pendingJobs()).toBe(0);

    // Occupies the slot a keyed startup send would land in. See docs/federation.md §153.
    await seedCompletedStartupJob();

    loop = await startFederationSyncLoop(boss, domain.db);

    const restartAttempt = await waitFor(async () => {
      const value = await lastAttemptMs();
      return value !== null && value > justNow.getTime() ? value : null;
    }, 20_000);
    expect(restartAttempt).toBeGreaterThan(justNow.getTime());

    // …AND the interval chain was bootstrapped: exactly one pending tick, never zero (a dead loop)
    // and never two (a duplicated one).
    await waitFor(async () => ((await pendingJobs()) >= 1 ? true : null));
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(await pendingJobs()).toBe(1);
  }, 60_000);
});
