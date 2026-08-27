import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import {
  partitionReadableRoots,
  readableObjectFilterSql,
  type ReadableRoot
} from "./readable-scope.js";

/**
 * ================================================================================================
 * THE READ-SURFACE FILTER'S PURE HALF — the effect classifier, and the three-outcome contract
 * ================================================================================================
 *
 * `readable-scope.integration.test.ts` drives both of these against real PostgreSQL and is where
 * the WALK's correctness is settled — no fake database appears here and none should. What this file
 * pins is the pair of properties that are decided in JavaScript before any query runs, and that an
 * integration fixture can only reach one value of at a time:
 *
 *  - `partitionReadableRoots` classifies a RAW `role_bindings.effect` string. The docblock's rule is
 *    that it must match `hasPermission`'s exact-string comparison, so a row a pre-`0096` dump can
 *    still carry grants nothing AND denies nothing. Building each malformed value through the API is
 *    impossible (the CHECK refuses it) and through the harness costs a fixture per value; here every
 *    value is one line.
 *  - `readableObjectFilterSql`'s three outcomes. `null` and "matches nothing" are OPPOSITES — the
 *    module doc says treating `null` as "matches nothing" empties every org admin's lists, and
 *    treating "matches nothing" as `null` hands the whole org to a subject with no grant. The
 *    empty-allow branch has NO production caller that can observe it (`list-door-scope.ts` returns
 *    403 first), so it is exactly the kind of fail-closed defence that only a direct call can pin.
 *
 * The SQL is rendered with drizzle's own `PgDialect` — the same serializer the driver uses, not a
 * reimplementation — so the assertions below are about the statement PostgreSQL would receive.
 */

const render = (fragment: ReturnType<typeof readableObjectFilterSql>) => {
  if (fragment === null) throw new Error("expected a filter, got null");
  return new PgDialect().sqlToQuery(fragment);
};

const root = (rootId: string, effect: string): ReadableRoot => ({ rootId, effect });

/** The org root object's id — `ensureOrgRootObject` creates that object with `id: orgId`, which is
 *  what makes the short-circuit below a comparison against this same value. */
const ORG = "00000000-0000-4000-8000-000000000001";

describe("partitionReadableRoots — the effect classifier, mirroring hasPermission exactly", () => {
  it("returns two empty lists for no roots at all", () => {
    expect(partitionReadableRoots([])).toEqual({ allowRoots: [], denyRoots: [] });
  });

  it("splits allow from deny", () => {
    expect(partitionReadableRoots([root("a", "allow"), root("d", "deny")])).toEqual({
      allowRoots: ["a"],
      denyRoots: ["d"]
    });
  });

  it("drops a malformed effect from BOTH lists — it grants nothing and denies nothing", () => {
    // `role_bindings_effect_check` constrains writes; PostgreSQL never re-checks a row on the way
    // out, so a restored pre-0096 dump presents these. Classifying one as `deny` would be safer-
    // looking and still wrong: it would make a list door disagree with get-by-id on the same row.
    for (const effect of ["ALLOW", "Allow", "allow ", " allow", "DENY", "", "permit", "0"]) {
      expect(partitionReadableRoots([root("x", effect)])).toEqual({
        allowRoots: [],
        denyRoots: []
      });
    }
  });

  it("de-duplicates each side — one scope bound twice is one root", () => {
    // Two bindings of two roles at the same object is the ordinary shape, and a duplicated seed
    // would be walked twice by `descendSql`.
    expect(
      partitionReadableRoots([
        root("a", "allow"),
        root("a", "allow"),
        root("d", "deny"),
        root("d", "deny")
      ])
    ).toEqual({ allowRoots: ["a"], denyRoots: ["d"] });
  });

  it("keeps a root that is BOTH allowed and denied on both lists — deny wins downstream", () => {
    // The subtraction is `descend(allow) EXCEPT descend(deny)`, so a scope carrying both must reach
    // both sides for the EXCEPT to cancel it. Dropping it from `allowRoots` here would happen to
    // give the same answer for that one object and the WRONG answer for its subtree.
    expect(partitionReadableRoots([root("s", "allow"), root("s", "deny")])).toEqual({
      allowRoots: ["s"],
      denyRoots: ["s"]
    });
  });

  it("preserves first-seen order, so two equal inputs render one statement", () => {
    expect(partitionReadableRoots([root("b", "allow"), root("a", "allow")]).allowRoots).toEqual([
      "b",
      "a"
    ]);
  });
});

describe("readableObjectFilterSql — three outcomes, and two of them must never be confused", () => {
  it("returns null when the subject holds an allow AT the org root — NO filter, not 'everything'", () => {
    // `orgId` IS the org root object's id. Callers must add nothing to the WHERE clause; a caller
    // that read this as an empty set would empty every org admin's lists.
    expect(readableObjectFilterSql(ORG, [ORG], [])).toBeNull();
    expect(readableObjectFilterSql(ORG, ["service-1", ORG], ["deny-1"])).toBeNull();
  });

  it("returns a matches-nothing fragment — NOT null — when there is no allow binding at all", () => {
    // The fail-closed defence. No production caller can reach it today, which is precisely why an
    // integration test cannot pin it and this one must.
    const { sql: text } = render(readableObjectFilterSql(ORG, [], ["deny-1"]));
    expect(text).toContain("WHERE false");
    expect(text).not.toContain("WITH RECURSIVE");
  });

  it("descends from the allow roots when there is no deny, with no EXCEPT term", () => {
    const { sql: text, params } = render(
      readableObjectFilterSql(ORG, ["11111111-1111-4111-8111-111111111111"], [])
    );
    expect(text).toContain("WITH RECURSIVE");
    expect(text).toContain("readable_allow");
    expect(text).not.toContain("EXCEPT");
    expect(text).not.toContain("readable_deny");
    expect(params).toContain("11111111-1111-4111-8111-111111111111");
  });

  it("adds the SECOND descend and the EXCEPT when a deny root is present", () => {
    // Deny is a SUBTRACTION, not an absence: omitting this second walk does not make deny
    // approximate, it makes deny INERT on every list door while it still works on get-by-id.
    const { sql: text } = render(readableObjectFilterSql(ORG, ["allow-root"], ["deny-root"]));
    expect(text).toContain("readable_allow");
    expect(text).toContain("readable_deny");
    expect(text).toContain("EXCEPT");
  });

  it("binds every root id as its own parameter — no id is concatenated into SQL text", () => {
    // `(VALUES (${id}::uuid), …)` rather than `unnest($1::uuid[])`, and the ids come from
    // `role_bindings.scope_object_id`, a column with no type constraint.
    const ids = ["root-a", "root-b", "root-c"];
    const { sql: text, params } = render(readableObjectFilterSql(ORG, ids, []));
    for (const id of ids) {
      expect(params).toContain(id);
      expect(text).not.toContain(id);
    }
  });

  it("scales the seed list rather than the statement shape", () => {
    const many = Array.from({ length: 50 }, (_, i) => `root-${i}`);
    const { params } = render(readableObjectFilterSql(ORG, many, []));
    // Every seed, plus the org id bound once per descend term's liveness join.
    for (const id of many) expect(params).toContain(id);
    expect(params).toContain(ORG);
  });
});
