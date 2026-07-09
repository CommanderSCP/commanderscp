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
describe("audit chain: 10,000 mixed writes", () => {
  it("verifies via `scp audit verify` after 10k creates/updates/relationships", async () => {
    const server: ListeningTestServer = await listenTestServer();
    try {
      const org = await createTestOrg(server, "audit-10k");

      const CREATE_COUNT = 5000;
      const REL_COUNT = 3000;
      const UPDATE_COUNT = 2000;

      const objectIds: string[] = [];
      for (let i = 0; i < CREATE_COUNT; i++) {
        const created = await withTenantTx(server.deps.db, org.orgId, (tx) =>
          createObject(tx, {
            orgId: org.orgId,
            typeId: "service",
            actorObjectId: org.orgId,
            requestId: `audit-10k-create-${i}`,
            name: `audit-10k-service-${i}`
          })
        );
        objectIds.push(created.id);
      }

      for (let i = 0; i < REL_COUNT; i++) {
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
      }

      for (let i = 0; i < UPDATE_COUNT; i++) {
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
      }

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
