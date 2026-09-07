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

/** BUILD_AND_TEST.md §8 M1 DoD (d). See docs/audit.md §1. */
/** WRITERS IN FLIGHT AT ONCE. See docs/audit.md §2. */
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
    // THE BUDGET IS A HANG DETECTOR, NOT A PERFORMANCE ASSERTION — and the 180_000 it replaces was
    // never sized by a measurement. Measured 2026-08-17, both arms in ONE vitest invocation in
    // parallel forks so they saw identical conditions (and deliberately contended for the same
    // Postgres, which is what 4-fork CI looks like):
    //
    //     concurrent (this file, 8 writers in flight)   248_023 ms
    //     sequential (the code this replaced)           322_924 ms
    //
    // The concurrency is worth having — it is a real 1.3x, and it puts the chain's advisory-lock
    // serialization under the contention it exists for — but it is nowhere near sufficient on its
    // own: the workload is 10,000 blocking transactions and no amount of client-side overlap makes
    // that insensitive to a busy box. What made the test RED was the budget, and the budget was a
    // throughput assertion nobody meant to write (125s passing / 181s timing out against 180s, on
    // unmodified main, with no code change in between). 600s is ~2.4x the worst measured run.
  }, 600_000);

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

      // Directly corrupt a row as the admin/superuser connection. See docs/audit.md §3.
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
