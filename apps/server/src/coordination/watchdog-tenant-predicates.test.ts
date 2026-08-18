import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readStripped } from "@scp/source-census";

/**
 * EVERY TENANT-TABLE QUERY IN `watchdog.ts` CARRIES `org_id` — a source-level guard, because a
 * behavioural one cannot exist WHILE THE RLS POLICY IS IN PLACE.
 *
 * THAT QUALIFIER IS LOAD-BEARING AND USED TO BE MISSING. The header said flatly "a behavioural one
 * cannot exist", which is not what the paragraph below it argues and is not true as stated: a test
 * that ran these queries as a BYPASSRLS/owner role, or that inspected the SQL actually executed,
 * WOULD observe the missing predicate. Neither is written here — the honest reason is cost, not
 * impossibility, and "impossible" is the kind of claim that stops the next reader looking (the
 * over-claiming-census hazard this whole file is an instance of).
 *
 * The strongest available behavioural version, recorded so it is a decision rather than an
 * oversight: drive `runWatchdogSweep` through a `Db` whose Drizzle logger records every statement,
 * and assert every recorded statement touching a tenant table names `org_id`. That observes
 * EXECUTED SQL and so is form-agnostic — it would catch all three mutations below, including the
 * one this file still cannot. It needs an integration harness and is not built.
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

/**
 * THE SECOND QUERY FORM — a raw `sql` template naming a tenant table in SQL rather than in Drizzle's
 * builder. `queriesIn` above cannot see one: it looks for `.from(<identifier>)`, and
 * ``sql`select … from objects where id = ${x}` `` contains no such call.
 *
 * MEASURED 2026-08-17, and this is why the function exists rather than a note saying "consider also".
 * Three mutations were run against this file:
 *
 *   G. drop `eq(objects.orgId, orgId)` from the executing arm (Drizzle form) → RED, correctly, on
 *      the real predicate check. Nothing to fix.
 *   H. REWRITE that same query as an unscoped `sql` template → RED, but only because the
 *      anti-vacuity floor saw the count fall from 3 to 2. The predicate check itself was blind.
 *   I. ADD an unscoped `sql` template read, leaving all three Drizzle queries in place → GREEN, 1/1.
 *
 * Mutation I is a cross-tenant read of `objects` sitting in the file, and the guard whose entire
 * purpose is to forbid exactly that passed. The vacuity floor was doing the work in H and there was
 * nothing left to do it in I — a floor detects REMOVAL, and the dangerous edit is an ADDITION.
 *
 * WHAT IS MATCHED: a `sql` template (or `sql.raw`) whose body names a tenant table after
 * `from`/`join`/`update`/`into`. The whole template body is the window, and the question is the same
 * one: does it mention `org_id` at all.
 *
 * THE FALSE-POSITIVE DIRECTION IS DELIBERATE. A template that legitimately needs no `org_id` — a
 * genuinely cross-tenant maintenance query — fails here and has to be exempted in
 * {@link CROSS_TENANT_BY_DESIGN} with a reason. That is a loud conversation rather than a silent
 * hole, and it is the correct direction for a guard whose failure mode is a tenant leak.
 */
function sqlTemplatesIn(text: string): { table: string; clause: string }[] {
  const out: { table: string; clause: string }[] = [];
  // A `sql` tag followed by a backtick-delimited body. Nested `${}` may contain backticks in
  // principle; none do in this file, and the failure direction of stopping early is a SMALLER
  // window, which can only make this stricter (less text in which to find `org_id`).
  const template = /\bsql(?:\.raw)?\s*`([^`]*)`/g;
  let match: RegExpExecArray | null;
  while ((match = template.exec(text)) !== null) {
    const body = match[1]!;
    for (const table of body.matchAll(/\b(?:from|join|update|into)\s+"?(\w+)"?/gi)) {
      out.push({ table: table[1]!, clause: body });
    }
  }
  return out;
}

/** Raw templates that name a tenant table and legitimately carry no `org_id`, each with the reason.
 *  Empty today, and an entry here should be rare enough to argue about in review. */
const CROSS_TENANT_BY_DESIGN: readonly { snippet: string; why: string }[] = [];

/** The tenant-scoped tables this file reads. `orgs` is the tenant REGISTRY — it has no `org_id`
 *  and is legitimately queried across tenants by the sweep's own driver — so it is not subject. */
const TENANT_TABLES = new Set(["objects", "changes"]);

describe("watchdog: tenant predicates", () => {
  it("names `org_id` in every BUILDER query against a tenant-scoped table", () => {
    const queries = queriesIn(source);
    // The scan found queries at all — without this the case passes vacuously the moment the regex
    // stops matching (a helper extraction, a formatting change). It is NOT a defence against a
    // `sql` template rewrite, though it once appeared to be: it catches that only as a side effect
    // of the count falling, so an ADDED template slips past. The case below is the real defence.
    expect(queries.filter((q) => TENANT_TABLES.has(q.table)).length).toBeGreaterThanOrEqual(3);

    const unscoped = queries
      .filter((q) => TENANT_TABLES.has(q.table))
      .filter((q) => !q.clause.includes(`${q.table}.orgId`))
      .map((q) => `${q.table}: ${q.clause.replace(/\s+/g, " ").trim().slice(0, 120)}`);

    expect(unscoped, "a tenant-table query scoped by RLS alone").toEqual([]);
  });

  it("names `org_id` in every RAW SQL TEMPLATE against a tenant-scoped table", () => {
    // The hole measured on 2026-08-17: an ADDED `sql` template reading `objects` with no `org_id`
    // left the builder case above green at 1/1, because the builder regex cannot see a template and
    // the vacuity floor only notices a query DISAPPEARING. See `sqlTemplatesIn`'s doc for the three
    // mutations and which of them the old file caught.
    const exempt = CROSS_TENANT_BY_DESIGN.map((entry) => entry.snippet);
    const unscoped = sqlTemplatesIn(source)
      .filter((q) => TENANT_TABLES.has(q.table))
      .filter((q) => !/\borg_id\b/i.test(q.clause))
      .map((q) => `${q.table}: ${q.clause.replace(/\s+/g, " ").trim().slice(0, 120)}`)
      .filter((description) => !exempt.some((snippet) => description.includes(snippet)));

    expect(unscoped, "a raw SQL template against a tenant table, scoped by RLS alone").toEqual([]);

    // NO VACUITY FLOOR HERE, deliberately, and the asymmetry is the point. `watchdog.ts` contains
    // ZERO raw templates today, so a floor would have to assert `>= 0` — which asserts nothing — or
    // be a standing red. The floor on the builder case exists because that count is nonzero and a
    // drop to zero would be suspicious; here the honest guard is the exemption list above, which is
    // empty and must stay argued-for.
    expect(CROSS_TENANT_BY_DESIGN, "an exemption is a decision, not a default").toEqual([]);
  });
});
