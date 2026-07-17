import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildTestServer, createTestOrg, type TestServer } from "../test-support/harness.js";
import { withTenantTx } from "../db/tenant-tx.js";
import { createObject, getOrgRootObjectId, listObjects } from "./objects-repo.js";

/**
 * Regression for the `scp object list component` hang (cursor-precision pagination bug).
 *
 * `objects.created_at` is stored at Postgres microsecond precision, but the pagination cursor
 * round-trips through a JS `Date` (millisecond precision) — so a keyset comparison of
 * `created_at > cursor.created_at` used to RE-INCLUDE the boundary row (its microseconds make it
 * strictly greater than the millisecond-truncated cursor). When more than one page of rows shares
 * a `created_at` millisecond — exactly what a bulk discovery import of components produces, all
 * created in one transaction with an identical `now()` — `nextCursor` never advanced and the
 * SDK/CLI `listAllObjects` iterator looped forever. Services stayed dormant only because there
 * were fewer of them than one page, so pagination never engaged.
 */
describe("list pagination: cursor precision", () => {
  let server: TestServer;
  let orgId: string;

  beforeAll(async () => {
    server = await buildTestServer();
    const org = await createTestOrg(server, "list-pagination");
    orgId = org.orgId;

    // Seed 25 components in ONE transaction: every row gets the SAME transaction `now()`, i.e. an
    // identical microsecond-precision `created_at` — the bulk-import topology that trips the bug.
    await withTenantTx(server.deps.db, orgId, async (tx) => {
      const actor = await getOrgRootObjectId(tx, orgId);
      for (let i = 0; i < 25; i++) {
        await createObject(tx, {
          orgId,
          typeId: "component",
          actorObjectId: actor,
          requestId: `seed-${i}`,
          name: `bulk-component-${String(i).padStart(2, "0")}`
        });
      }
    });
  }, 60_000);

  afterAll(async () => {
    await server.close();
  });

  it("paginates a >1-page set of same-millisecond rows to completion with no dup/loop", async () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;

    // A correct keyset terminates in 2 pages (20 + 5). The safety cap catches the pre-fix infinite
    // loop deterministically instead of hanging the test forever.
    do {
      const page = await withTenantTx(server.deps.db, orgId, (tx) =>
        listObjects(tx, orgId, "component", { limit: 20, cursor })
      );
      for (const item of page.items) seen.push(item.id);
      cursor = page.nextCursor ?? undefined;
      pages += 1;
      expect(
        pages,
        "pagination did not terminate — cursor never advanced (precision bug)"
      ).toBeLessThanOrEqual(10);
    } while (cursor);

    const distinct = new Set(seen);
    expect(distinct.size).toBe(25); // every component seen
    expect(seen.length).toBe(25); // and each seen exactly once (no boundary-row duplicates)
  });
});
