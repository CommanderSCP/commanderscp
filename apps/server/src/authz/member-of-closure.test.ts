import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { CONTAINMENT_WALK_MAX_DEPTH, WALK_TRUNCATION_PROBE_DEPTH } from "../graph/containment.js";
import { memberExpandCte, subjectExpandCte } from "./resolve.js";

/** THE TWO `member_of` CLOSURES. See docs/authz.md §24. */

const ORG = "00000000-0000-4000-8000-000000000001";
const SEED = "11111111-1111-4111-8111-111111111111";
const render = (fragment: ReturnType<typeof subjectExpandCte>) =>
  new PgDialect().sqlToQuery(fragment);

/** Whitespace in the emitted text is an artefact of the template literal, not a contract. */
const flat = (text: string): string => text.replace(/\s+/g, " ");

describe("the member_of closures walk only live member_of edges", () => {
  for (const [name, build] of [
    ["subjectExpandCte", subjectExpandCte],
    ["memberExpandCte", memberExpandCte]
  ] as const) {
    it(`${name} restricts to type_id 'member_of' and to undeleted edges`, () => {
      const { sql: text } = render(build(ORG, SEED));
      expect(flat(text)).toContain("r.type_id = 'member_of'");
      expect(flat(text)).toContain("r.deleted_at IS NULL");
    });

    it(`${name} binds the org id and the seed rather than inlining either`, () => {
      const { sql: text, params } = render(build(ORG, SEED));
      expect(params).toContain(ORG);
      expect(params).toContain(SEED);
      expect(text).not.toContain(ORG);
      expect(text).not.toContain(SEED);
      // The seed is cast, because `role_bindings.subject_id` reaches this as a `text` parameter.
      expect(flat(text)).toContain("::uuid AS");
    });

    it(`${name} includes the seed row at depth 0`, () => {
      // A caller that wants "the subject itself" gets it with no special case; §2b filters
      // `depth > 0` precisely because the seed IS in here.
      expect(flat(render(build(ORG, SEED)).sql)).toContain("0 AS depth");
    });
  }
});

describe("the two directions are opposites, and seeding the wrong one is silent", () => {
  it("subject_expand walks a principal UP to the groups it belongs to", () => {
    // `from_id -> to_id`: the member is the FROM end of a `member_of` edge, so the row joined on is
    // the one whose `from_id` is already in the closure, and what is added is its `to_id`.
    const { sql: text } = render(subjectExpandCte(ORG, SEED));
    expect(flat(text)).toContain("subject_expand AS (");
    expect(flat(text)).toContain("AS subject_id");
    expect(flat(text)).toContain("SELECT r.to_id, w.depth + 1");
    expect(flat(text)).toContain("ON r.from_id = w.subject_id");
  });

  it("member_expand walks a group DOWN to the principals that reach it", () => {
    const { sql: text } = render(memberExpandCte(ORG, SEED));
    expect(flat(text)).toContain("member_expand AS (");
    expect(flat(text)).toContain("AS member_id");
    expect(flat(text)).toContain("SELECT r.from_id, w.depth + 1");
    expect(flat(text)).toContain("ON r.to_id = w.member_id");
  });

  it("emits two DIFFERENT CTE names, so both may appear in one statement", () => {
    // `role-binding-door.ts` composes the membership walk into queries that also resolve the
    // ACTOR's own permissions. One shared name would be a duplicate-CTE syntax error at best and a
    // silently reused closure at worst.
    const subject = flat(render(subjectExpandCte(ORG, SEED)).sql);
    const member = flat(render(memberExpandCte(ORG, SEED)).sql);
    expect(subject).not.toContain("member_expand");
    expect(member).not.toContain("subject_expand");
  });
});

describe("the depth bound is ADR-0037's, and the probe is the only caller that overrides it", () => {
  it("defaults both walks to CONTAINMENT_WALK_MAX_DEPTH", () => {
    for (const build of [subjectExpandCte, memberExpandCte]) {
      const { sql: text, params } = render(build(ORG, SEED));
      expect(flat(text)).toContain("w.depth <");
      expect(params).toContain(CONTAINMENT_WALK_MAX_DEPTH);
    }
  });

  it("accepts the truncation probe's one-past-the-bound, which is what tells a deny from a cut", () => {
    const { params } = render(subjectExpandCte(ORG, SEED, WALK_TRUNCATION_PROBE_DEPTH));
    expect(params).toContain(WALK_TRUNCATION_PROBE_DEPTH);
    expect(params).not.toContain(CONTAINMENT_WALK_MAX_DEPTH);
    expect(WALK_TRUNCATION_PROBE_DEPTH).toBe(CONTAINMENT_WALK_MAX_DEPTH + 1);
  });

  it("uses a STRICT less-than, so the bound counts hops rather than rows", () => {
    // The same `depth <` shape `readable-scope.ts`'s downward walk uses. `<=` would make the two
    // directions reach different sets and stop being exact inverses — which is the whole basis on
    // which the list filter is allowed to reproduce `hasPermission`'s verdict.
    expect(flat(render(subjectExpandCte(ORG, SEED)).sql)).toContain("w.depth < $");
  });

  it("de-duplicates with UNION, not UNION ALL — a diamond membership must terminate", () => {
    // Two groups both containing one user, both inside one team, is an ordinary shape. Under
    // UNION ALL the recursive term never stops producing rows for it.
    for (const build of [subjectExpandCte, memberExpandCte]) {
      const text = flat(render(build(ORG, SEED)).sql);
      expect(text).toContain("UNION");
      expect(text).not.toContain("UNION ALL");
    }
  });
});
