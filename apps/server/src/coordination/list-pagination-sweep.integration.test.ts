import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { v7 as uuidv7 } from "uuid";
import { buildTestServer, createTestOrg, type TestServer } from "../test-support/harness.js";
import { withTenantTx } from "../db/tenant-tx.js";
import { createObjectType, listObjectTypes } from "../graph/type-registry-repo.js";
import { insertDecision, listDecisions } from "./decisions-repo.js";

/**
 * Systemic regression for the cursor-precision keyset pagination bug (companion to
 * `graph/list-pagination.integration.test.ts`, which covers `objects-repo`).
 *
 * `created_at` is stored at Postgres MICROSECOND precision, but the pagination cursor round-trips
 * through a JS `Date` (MILLISECOND, via `encodeCursor` → `toISOString`). Every repo that paged with
 * a RAW `created_at` keyset had one of two failure modes when more than one page of rows shares a
 * `created_at` millisecond — exactly what a bulk write committed in ONE transaction produces, since
 * `defaultNow()` stamps every row with the SAME transaction `now()`:
 *
 *  - TWO-COLUMN raw keyset (`(created_at, id) > (cursor_ms, cursor_id)`): the row's sub-millisecond
 *    tail makes `created_at` strictly greater than the truncated cursor for EVERY row, so the whole
 *    page re-qualifies, `nextCursor` never advances, and the `listAll*` iterator LOOPS FOREVER.
 *  - SINGLE-COLUMN raw keyset with NO id tiebreak (`created_at > cursor`): once the cursor lands on
 *    the shared millisecond, no row is strictly greater, so the next page is empty — pagination
 *    terminates but SILENTLY DROPS every same-millisecond row past the first page.
 *
 * The fix (shared `keysetAfter`/`keysetOrderBy` in `pagination.ts`) truncates the column to
 * `date_trunc('milliseconds', created_at)` in BOTH the WHERE and the ORDER BY and always carries an
 * `id` tiebreak, making `(created_at_ms, id)` a stable, terminating, lossless keyset.
 *
 * This file exercises a representative TWO-COLUMN repo (`type-registry` object types) and a
 * representative SINGLE-COLUMN-plus-new-tiebreak repo (`decisions`) — the latter proving the added
 * tiebreak both TERMINATES and does not DROP same-millisecond rows.
 */
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
    expect(new Set(seededSeen).size).toBe(SEED); // all seeded types seen
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

    // The decisive assertion for the added tiebreak: pre-fix the single-column `gt(created_at)`
    // keyset terminated but DROPPED the same-millisecond rows past page one (would see 20, not 25).
    expect(new Set(seen).size).toBe(SEED); // every decision seen — none dropped
    expect(seen.length).toBe(SEED); // and each exactly once — no boundary-row duplicates
  });
});
