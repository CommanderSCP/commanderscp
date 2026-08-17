import { describe, expect, it } from "vitest";
import pg from "pg";
import { withTenantTx } from "../db/tenant-tx.js";
import { createObject, updateObject } from "../graph/objects-repo.js";
import { createRelationship } from "../graph/relationships-repo.js";
import {
  createTestOrg,
  listenTestServer,
  testDatabaseUrl,
  type ListeningTestServer
} from "../test-support/harness.js";
import { startCliSession } from "../test-support/cli-runner.js";

/**
 * BUILD_AND_TEST.md §8 M1 DoD (d): "audit chain verifies (via the `scp audit verify` path)
 * after 10,000 mixed writes". Writes go straight through the repo layer (graph/objects-repo.ts,
 * graph/relationships-repo.ts) — each call is its own `withTenantTx` transaction, exactly like a
 * real API request, just without 10,000 real HTTP round trips — so this is still exercising the
 * production write path (and its per-org advisory-lock chain serialization) end to end.
 * Verification itself goes through the real `scp` CLI binary against the real API, per the DoD
 * wording ("via the scp audit verify path").
 */
/**
 * WRITERS IN FLIGHT AT ONCE. Each write is still its own `withTenantTx` transaction through the
 * production repo layer — what changes is only that the TEST stops idling on a round trip between
 * every one of them, and that is why this is a flakiness fix rather than a speed-up.
 *
 * 10,000 strictly sequential writes make this test's runtime a measure of per-round-trip LATENCY:
 * ~8 round trips each (BEGIN, `SET LOCAL ROLE`, `set_config`, the chain's `pg_advisory_xact_lock`,
 * the tail SELECT, the row INSERT, the audit INSERT, COMMIT), all of them blocking, none of them
 * overlapping. Latency is exactly what degrades when the suite runs 4 forks wide on a busy box, so
 * a fixed wall-clock budget over that shape is a throughput assertion nobody meant to write —
 * measured on 2026-08-17 as 125s passing and 181s timing out against a 180s budget, on unmodified
 * main, with no code change in between.
 *
 * With writers in flight the serialized floor is the part `appendAuditEvent` holds the per-org
 * advisory lock for (lock -> tail read -> audit insert -> COMMIT) and everything else overlaps, so
 * the run is bounded by work the SERVER does rather than by how promptly this process is scheduled
 * to issue its next statement. 8 sits under `pg.Pool`'s default max of 10.
 *
 * IT ALSO STRENGTHENS THE TEST, which is the reason to prefer it over simply enlarging the budget:
 * `appendAuditEvent`'s advisory lock exists precisely so that CONCURRENT writers cannot observe a
 * stale tail and fork the chain, and until now every one of these 10,000 appends was sequential —
 * the serialization was never actually put under contention by the test that verifies the chain.
 */
const WRITER_CONCURRENCY = 8;

/** Runs `worker(0..count-1)` with at most {@link WRITER_CONCURRENCY} in flight. Index-addressed
 *  (never push-ordered) so a caller's output array is deterministic regardless of completion order. */
async function forEachConcurrently(
  count: number,
  worker: (index: number) => Promise<void>
): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: WRITER_CONCURRENCY }, async () => {
      for (;;) {
        const index = next++;
        if (index >= count) return;
        await worker(index);
      }
    })
  );
}

describe("audit chain: 10,000 mixed writes", () => {
  it("verifies via `scp audit verify` after 10k creates/updates/relationships", async () => {
    const server: ListeningTestServer = await listenTestServer();
    try {
      const org = await createTestOrg(server, "audit-10k");

      const CREATE_COUNT = 5000;
      const REL_COUNT = 3000;
      const UPDATE_COUNT = 2000;

      const objectIds: string[] = new Array<string>(CREATE_COUNT);
      await forEachConcurrently(CREATE_COUNT, async (i) => {
        const created = await withTenantTx(server.deps.db, org.orgId, (tx) =>
          createObject(tx, {
            orgId: org.orgId,
            typeId: "service",
            actorObjectId: org.orgId,
            requestId: `audit-10k-create-${i}`,
            name: `audit-10k-service-${i}`
          })
        );
        objectIds[i] = created.id;
      });

      await forEachConcurrently(REL_COUNT, async (i) => {
        const fromId = objectIds[i];
        const toId = objectIds[i + 1];
        if (!fromId || !toId) throw new Error("fixture index out of range");
        await withTenantTx(server.deps.db, org.orgId, (tx) =>
          createRelationship(tx, {
            orgId: org.orgId,
            actorObjectId: org.orgId,
            requestId: `audit-10k-rel-${i}`,
            typeId: "depends_on",
            fromId,
            toId
          })
        );
      });

      await forEachConcurrently(UPDATE_COUNT, async (i) => {
        const idOrUrn = objectIds[i];
        if (!idOrUrn) throw new Error("fixture index out of range");
        await withTenantTx(server.deps.db, org.orgId, (tx) =>
          updateObject(tx, {
            orgId: org.orgId,
            typeId: "service",
            actorObjectId: org.orgId,
            requestId: `audit-10k-update-${i}`,
            idOrUrn,
            name: `audit-10k-service-${i}-updated`
          })
        );
      });

      const totalMutations = CREATE_COUNT + REL_COUNT + UPDATE_COUNT;

      // Sanity: the chain actually has (at least) that many events for this org (bootstrap
      // itself writes a couple more — org root object + admin user — so ">=" not "===").
      const countClient = new pg.Client({ connectionString: testDatabaseUrl() });
      await countClient.connect();
      const { rows } = await countClient.query<{ count: string }>(
        "SELECT count(*) FROM audit_events WHERE org_id = $1",
        [org.orgId]
      );
      await countClient.end();
      expect(Number(rows[0]?.count ?? 0)).toBeGreaterThanOrEqual(totalMutations);

      // Verification via the real `scp` CLI against the real public API (DoD (d) wording).
      const cli = await startCliSession(server.baseUrl);
      try {
        await cli.run(["login", "--username", org.adminUsername, "--password", org.adminPassword]);
        const { stdout } = await cli.run(["audit", "verify"]);
        expect(stdout).toMatch(/OK: audit chain verified/);
        const verifiedCount = Number(/\((\d+) events\)/.exec(stdout)?.[1]);
        expect(verifiedCount).toBeGreaterThanOrEqual(totalMutations);
      } finally {
        await cli.cleanup();
      }
    } finally {
      await server.close();
    }
  }, 180_000);

  it("scp audit verify detects a tampered chain (belt-and-braces on top of the unit-tested pure verifier)", async () => {
    const server = await listenTestServer();
    try {
      const org = await createTestOrg(server, "audit-tamper");
      await withTenantTx(server.deps.db, org.orgId, (tx) =>
        createObject(tx, {
          orgId: org.orgId,
          typeId: "service",
          actorObjectId: org.orgId,
          requestId: "tamper-fixture",
          name: "tamper-target"
        })
      );

      // Directly corrupt a row as the admin/superuser connection — the append-only guard trigger
      // (drizzle/0002_rls_rbac_seed.sql) blocks UPDATE unconditionally, so the trigger has to be
      // disabled first; this simulates an attacker with raw filesystem/superuser access to the
      // database, which is exactly the threat model the hash chain (not the trigger alone)
      // defends against.
      const admin = new pg.Client({ connectionString: testDatabaseUrl() });
      await admin.connect();
      await admin.query("ALTER TABLE audit_events DISABLE TRIGGER audit_events_no_update_delete");
      await admin.query(
        "UPDATE audit_events SET action = 'tampered.action' WHERE id = (SELECT id FROM audit_events WHERE org_id = $1 ORDER BY seq ASC LIMIT 1)",
        [org.orgId]
      );
      await admin.query("ALTER TABLE audit_events ENABLE TRIGGER audit_events_no_update_delete");
      await admin.end();

      const cli = await startCliSession(server.baseUrl);
      try {
        await cli.run(["login", "--username", org.adminUsername, "--password", org.adminPassword]);
        await expect(cli.run(["audit", "verify"])).rejects.toThrow();
      } finally {
        await cli.cleanup();
      }
    } finally {
      await server.close();
    }
  });
});
