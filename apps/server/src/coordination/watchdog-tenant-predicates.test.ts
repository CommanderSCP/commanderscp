import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readStripped } from "@scp/source-census";

/**
 * EVERY TENANT-TABLE QUERY IN `watchdog.ts` CARRIES `org_id` — a source-level guard, because a
 * behavioural one cannot exist.
 *
 * THE PROPERTY: *a query against a tenant-scoped table whose WHERE clause names only the row id.*
 * Such a query is correct today and only today, and it is correct for a reason that lives in
 * another file: RLS. `withTenantTx` sets `app.org_id` and the policy on the table restricts the
 * rows, so the missing predicate changes no result — which is exactly why nothing else can catch
 * it. There is no fixture that makes it fail while the policy is in place, and by the time one
 * exists (a `withSystemTx` refactor, a maintenance script run outside the tenant tx, a policy
 * regression, a table added without a policy) the failure is a cross-tenant read.
 *
 * DEFENCE IN DEPTH IS THE HOUSE STYLE, not an opinion this file is introducing: every other query
 * in this same file — and every sibling query in the increment that added the second instance below
 * — pairs the id with `org_id`. Two of them did not.
 *
 * CENSUS, not a spot fix. Both `objects` lookups in `watchdog.ts` were missing it: the `waiting`
 * arm's (which predates ADR-0028 and was never reported) and the `executing` arm's (which the
 * review found). Fixing only the reported one would have left the same property live in the
 * function immediately above it. This test is filterless by construction — it looks at EVERY
 * `.from(<table>)` in the file, so a third one added later fails here rather than being noticed by
 * the next reviewer to read the diff closely.
 *
 * WHAT IT CANNOT DO: prove the predicate names the right org. It checks that the query is scoped at
 * all, which is the property that was violated.
 *
 * READ WITH COMMENTS STRIPPED (2026-08-17), and of the five censuses converted that day this was
 * the one whose false green was a SECURITY hole rather than a dead loop. The check asks whether the
 * literal text `objects.orgId` appears in a window after `.from(objects)` — so
 *
 *     .where(and(/* eq(objects.orgId, orgId), *\/ eq(objects.id, change.objectId)))
 *
 * passed. Measured: that exact edit to the `waiting` arm left this file green at 1/1 while the
 * query it guards read rows scoped by RLS alone — the precise defect the block above says nothing
 * else in the codebase can catch. The same hazard applies to the vacuity floor: on raw text, three
 * commented-out queries satisfy `toBeGreaterThanOrEqual(3)`.
 *
 * That is why this guard's subject must be the CODE and never the file. See `readStripped`'s doc
 * for what a text census still cannot prove once comments are gone.
 */

const source = readStripped(fileURLToPath(new URL("./watchdog.ts", import.meta.url)));

/** Every `…from(<table>)` in the file, paired with the query text that follows it — up to the next
 *  `.from(`, or 600 characters, whichever comes first. Deliberately crude rather than a parse: the
 *  only question asked of the window is "is `<table>.orgId` mentioned in this query", and a window
 *  that is too GENEROUS can only ever make this test more forgiving, never falsely red. */
function queriesIn(text: string): { table: string; clause: string }[] {
  const out: { table: string; clause: string }[] = [];
  const from = /\.from\((\w+)\)/g;
  let match: RegExpExecArray | null;
  while ((match = from.exec(text)) !== null) {
    const rest = text.slice(match.index + match[0].length);
    const next = rest.indexOf(".from(");
    const end = next === -1 ? 600 : Math.min(next, 600);
    out.push({ table: match[1]!, clause: rest.slice(0, end) });
  }
  return out;
}

/** The tenant-scoped tables this file reads. `orgs` is the tenant REGISTRY — it has no `org_id`
 *  and is legitimately queried across tenants by the sweep's own driver — so it is not subject. */
const TENANT_TABLES = new Set(["objects", "changes"]);

describe("watchdog: tenant predicates", () => {
  it("names `org_id` in every query against a tenant-scoped table", () => {
    const queries = queriesIn(source);
    // The scan found queries at all — without this the case passes vacuously the moment the regex
    // stops matching (a `sql` template rewrite, a helper extraction, a formatting change).
    expect(queries.filter((q) => TENANT_TABLES.has(q.table)).length).toBeGreaterThanOrEqual(3);

    const unscoped = queries
      .filter((q) => TENANT_TABLES.has(q.table))
      .filter((q) => !q.clause.includes(`${q.table}.orgId`))
      .map((q) => `${q.table}: ${q.clause.replace(/\s+/g, " ").trim().slice(0, 120)}`);

    expect(unscoped, "a tenant-table query scoped by RLS alone").toEqual([]);
  });
});
