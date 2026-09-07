import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildTestServer, createTestOrg, type TestServer } from "../test-support/harness.js";
import { withTenantTx } from "../db/tenant-tx.js";
import { createObject, getOrgRootObjectId, listObjects } from "./objects-repo.js";

/** Regression for the `scp object list component` hang. See docs/graph.md §56. */
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
        // `null` = NO row filter, which is what an org-root principal resolves to. This test is
        // about cursor precision, so it deliberately measures the unfiltered statement — the one
        // `authz/list-scope.ts` hands back for every org-root Owner/Viewer.
        listObjects(tx, orgId, "component", { limit: 20, cursor }, null)
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
    expect(distinct.size).toBe(25);
    expect(seen.length).toBe(25); // and each seen exactly once (no boundary-row duplicates)
  });
});
