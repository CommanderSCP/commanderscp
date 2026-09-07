import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import {
  buildTestServer,
  createTestOrg,
  type TestOrg,
  type TestServer
} from "../test-support/harness.js";
import { indexesInPlan, sortNodesInPlan } from "../test-support/query-plan.js";
import { withTenantTx } from "../db/tenant-tx.js";
import type { TrustDomainId } from "@scp/schemas";
import {
  lastConfirmedSyncImportAt,
  lastConfirmedSyncImportQuery
} from "./bundle-transfers-repo.js";

/** The per-peer freshness read is an index seek, not a scan. See docs/federation.md §53. */
describe("federation: the per-peer board freshness read is served by drizzle/0041's index", () => {
  let server: TestServer;
  let org: TestOrg;
  const peerDomainId = "11111111-1111-1111-1111-111111111111" as TrustDomainId;

  beforeAll(async () => {
    server = await buildTestServer();
    org = await createTestOrg(server, "bundle-transfer-read-plan");

    // A ledger with depth, and — the point of the ordering — one row that is a confirmed sync
    // IMPORT with a NULL `confirmed_at`. That row is what `NULLS LAST` exists to keep out of first
    // place, so seeding it makes the correctness arm below real rather than decorative.
    await withTenantTx(server.deps.db, org.orgId, async (tx) => {
      await tx.execute(sql`
        INSERT INTO bundle_transfers (id, org_id, peer_domain_id, direction, kind, status, checksum, created_at, confirmed_at, transport)
        SELECT gen_random_uuid(), ${org.orgId}::uuid, ${peerDomainId}::uuid,
               'import', 'sync', 'confirmed', 'sha256:seeded-' || i,
               now() + (i * interval '1 second'), now() + (i * interval '1 second'), 'bundle'
        FROM generate_series(1, 200) i
      `);
      await tx.execute(sql`
        INSERT INTO bundle_transfers (id, org_id, peer_domain_id, direction, kind, status, checksum, created_at, confirmed_at, transport)
        VALUES (gen_random_uuid(), ${org.orgId}::uuid, ${peerDomainId}::uuid,
                'import', 'sync', 'confirmed', 'sha256:unstamped', now(), NULL, NULL)
      `);
      // `ANALYZE` cannot run here — `withTenantTx` drops to `scp_app`, which does not own the table,
      // and PostgreSQL would WARN and skip (see `coordination/test-support/decision-read-counters.ts`
      // for where that silently defeated a whole suite). It is not needed: unlike a cost comparison,
      // eligibility is not a statistics question — an index in the wrong order is ineligible at every
      // statistics state, which is why this assertion is stable where a row count would not be.
    });
  });

  afterAll(async () => {
    await server.close();
  });

  it("EXPLAINs to `bundle_transfers_org_peer_confirmed` WITH NO SORT NODE — an index in the wrong order is no index at all", async () => {
    const { plan, sorts } = await withTenantTx(server.deps.db, org.orgId, async (tx) => {
      const query = lastConfirmedSyncImportQuery(tx, org.orgId, peerDomainId);
      return {
        plan: await indexesInPlan(tx, query),
        sorts: await sortNodesInPlan(tx, query)
      };
    });

    expect(plan).toContain("bundle_transfers_org_peer_confirmed");
    // The general index from 0012, which carries `created_at` and cannot serve this order either —
    // named so a flip says which. `toContain` on an ARRAY is exact element equality, not substring.
    expect(plan).not.toContain("bundle_transfers_org_peer");

    // The half the index name cannot assert. See docs/federation.md §54.
    expect(sorts).toEqual([]);
  });

  it("still answers with the NEWEST STAMPED row, not the unstamped one — the order the index now matches is the CORRECT order", async () => {
    const latest = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      lastConfirmedSyncImportAt(tx, org.orgId, peerDomainId)
    );

    // Correctness first: bringing the index into line with the read must not change the answer, and
    // the answer must not be "never synced" just because one row has no timestamp.
    expect(latest).not.toBeNull();
    expect(latest?.checksum).toBe("sha256:seeded-200");
    expect(latest?.transport).toBe("bundle");
  });
});
