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

/**
 * THE BOARD'S PER-PEER FRESHNESS READ IS AN INDEX SEEK, NOT A SCAN OF THE WHOLE HANDOFF LEDGER —
 * i.e. THE TEST FOR drizzle/0041, WHICH IT NEVER HAD, AND WHICH IS WHY 0041 SHIPPED UNUSED.
 *
 * `lastConfirmedSyncImportAt` runs ONCE PER PEER on every service-board render, and
 * `bundle_transfers` is the air-gap handoff ledger — this module exposes no pruning, by design, so
 * it only ever grows. drizzle/0041 added a partial index to make that read a single seek "no matter
 * how deep the transfer history gets". It did not: 0041 declared the index `confirmed_at DESC`,
 * which PostgreSQL reads as NULLS FIRST, while the read asks for `DESC NULLS LAST` — deliberately,
 * because a NULL `confirmed_at` sorting first made the commander report "never synced" over a real
 * sync import. Two different orderings; an index in one cannot supply the other. So the planner
 * ignored the index entirely and did the thing 0041's header says it exists to abolish. MEASURED at
 * 20,000 confirmed sync imports for one peer, PostgreSQL 16:
 *
 *     Limit -> Sort (top-N heapsort, Sort Key: confirmed_at DESC NULLS LAST)
 *                -> Seq Scan on bundle_transfers   rows=20000
 *     Buffers: shared hit=364        Execution Time: 3.675 ms
 *
 *   after drizzle/0070:
 *     Limit -> Index Scan using bundle_transfers_org_peer_confirmed
 *     Buffers: shared hit=4          Execution Time: 0.014 ms
 *
 * WHY A PLAN ASSERTION AND NOT AN OUTPUT OR LATENCY ONE. The index changes no return value — the
 * seq-scan-and-sort finds the same row — so an output assertion is VACUOUS and would pass either
 * way, which is exactly how this shipped: 0041 has integration coverage of what the read RETURNS,
 * and all of it stayed green. A latency assertion would be a flake. What changed is the PLAN, so
 * that is what this asserts, over the BUILDER the repo itself runs rather than a re-typed copy.
 *
 * MUTATION-PROVEN, 2026-08-17 — AND THE FIRST ATTEMPT AT THIS TEST FAILED THAT PROOF, which is the
 * reason the second assertion exists. Reverting drizzle/0070 to 0041's `confirmed_at DESC` and
 * asserting only the index NAME left this suite GREEN: at this fixture's size the plan becomes
 * `Limit -> Sort -> Index Scan using bundle_transfers_org_peer_confirmed`, so the index is still
 * there by name, used for ACCESS while supplying none of the ordering. The same revert against the
 * `sorts` assertion fails with `["Sort"]`, as it must.
 *
 * A row-count bound of the kind the `decisions` suites carry is deliberately NOT added here: those
 * count `pg_stat_get_xact_tuples_returned` on one table in one transaction, and this read's failure
 * mode is a sequential scan whose cost is the ledger's whole length, which needs a fixture large
 * enough to be slow to seed. The plan assertion catches the same regression at the same moment.
 */
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

    // AND THE HALF THE INDEX NAME CANNOT ASSERT, without which this test is vacuous. An index in the
    // WRONG order is still usable for ACCESS — the planner reads the matching rows through it and
    // sorts them — so it appears in the plan by name while supplying none of the ordering. That is
    // not a hypothetical: with the index back in drizzle/0041's order this fixture plans as
    // `Limit -> Sort -> Index Scan using bundle_transfers_org_peer_confirmed`, and the assertion
    // above PASSES. The property the read needs is that the index supplies the ORDER, so `LIMIT 1`
    // stops at the first row rather than the whole matching set being materialised and sorted.
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
