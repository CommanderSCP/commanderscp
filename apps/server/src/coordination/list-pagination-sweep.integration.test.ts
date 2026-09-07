import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { v7 as uuidv7 } from "uuid";
import { buildTestServer, createTestOrg, type TestServer } from "../test-support/harness.js";
import { withTenantTx } from "../db/tenant-tx.js";
import { createObjectType, listObjectTypes } from "../graph/type-registry-repo.js";
import { insertDecision, listDecisions } from "./decisions-repo.js";

/** Systemic regression for the cursor-precision bug. See docs/coordination.md §551. */
const SEED = 25;
const PAGE = 20;
// A correct keyset terminates in 2 pages (20 + 5); the cap turns the pre-fix infinite loop into a
// deterministic failure instead of hanging the test runner forever.
const PAGE_CAP = 10;

describe("list pagination sweep: cursor precision across repos", () => {
  let server: TestServer;
  let orgId: string;

  beforeAll(async () => {
    server = await buildTestServer();
    const org = await createTestOrg(server, "list-pagination-sweep");
    orgId = org.orgId;

    // Seed > 1 page of rows in ONE transaction each: every row gets the SAME transaction `now()`,
    // i.e. an identical microsecond-precision `created_at` — the bulk-import topology that trips the
    // bug. Zero-padded ids/subjects keep a stable, human-readable seed order.
    await withTenantTx(server.deps.db, orgId, async (tx) => {
      for (let i = 0; i < SEED; i++) {
        await createObjectType(tx, orgId, {
          id: `bulk-type-${String(i).padStart(2, "0")}`,
          displayName: `Bulk Type ${i}`
        });
      }
    });

    await withTenantTx(server.deps.db, orgId, async (tx) => {
      for (let i = 0; i < SEED; i++) {
        await insertDecision(tx, {
          orgId,
          kind: "gate",
          subjectId: uuidv7(),
          verdict: "allow",
          inputContext: { i },
          reasonTree: {}
        });
      }
    });
  }, 60_000);

  afterAll(async () => {
    await server.close();
  });

  it("two-column keyset (object types) paginates same-millisecond rows to completion, once each", async () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;

    do {
      const page = await withTenantTx(server.deps.db, orgId, (tx) =>
        listObjectTypes(tx, orgId, { limit: PAGE, cursor })
      );
      for (const item of page.items) seen.push(item.id);
      cursor = page.nextCursor ?? undefined;
      pages += 1;
      expect(
        pages,
        "pagination did not terminate — cursor never advanced (two-column precision bug)"
      ).toBeLessThanOrEqual(PAGE_CAP);
    } while (cursor);

    // `listObjectTypes` also returns org-agnostic builtin types (orgId IS NULL), so assert on our
    // seeded subset rather than a hard total: every seeded type appears EXACTLY once (no loop dupes)
    // and none are dropped.
    const seededSeen = seen.filter((id) => id.startsWith("bulk-type-"));
    expect(new Set(seededSeen).size).toBe(SEED);
    expect(seededSeen.length).toBe(SEED); // and each exactly once
  });

  it("single-column keyset + added tiebreak (decisions) sees every same-millisecond row exactly once", async () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;

    do {
      const page = await withTenantTx(server.deps.db, orgId, (tx) =>
        listDecisions(tx, orgId, { limit: PAGE, cursor })
      );
      for (const item of page.items) seen.push(item.id);
      cursor = page.nextCursor ?? undefined;
      pages += 1;
      expect(
        pages,
        "pagination did not terminate — cursor never advanced (decisions precision bug)"
      ).toBeLessThanOrEqual(PAGE_CAP);
    } while (cursor);

    // The decisive assertion for the added tiebreak. See docs/coordination.md §552.
    expect(new Set(seen).size).toBe(SEED);
    expect(seen.length).toBe(SEED); // and each exactly once — no boundary-row duplicates
  });
});
