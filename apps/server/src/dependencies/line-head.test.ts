import { describe, expect, it } from "vitest";
import type { DependencyLine } from "@scp/schemas";
import {
  asThirdPartyLine,
  eligibleSuffixFor,
  evaluateHeadMovement,
  evaluateIngressAuthority,
  lineAcceptsVersion
} from "./line-head.js";

/**
 * M21.4 — WHAT `latest_version`/`latest_digest` MEAN, pinned without a database
 * (BUILD_AND_TEST.md §4.1).
 *
 * Every assertion here is about a disagreement that ACTUALLY EXISTED between the two writers of
 * those columns — internal detection and the third-party poll — and that no type could catch,
 * because both wrote a `string` into a `text` column:
 *
 *   - `tag_pattern` meant "the literal variant suffix" to one and NOTHING to the other, so an
 *     `-alpine` line took a plain glibc tag as its head.
 *   - the column was "the head" to one and "the last thing I saw" to the other, so a hotfix on an
 *     older minor moved it backwards.
 *   - `produced_by_object_id` split the two ingresses in the ADR and in NEITHER writer.
 *
 * MUTATION LOG — each applied, watched fail, reverted, watched pass:
 * | Mutation | Result |
 * |---|---|
 * | drop the variant check from `lineAcceptsVersion` (compare only the numeric core, the pre-fix internal reading) | "an `-alpine` line REFUSES the plain flavour" FAILS |
 * | make `evaluateHeadMovement` always return `advanced` | "a hotfix behind the head does not move it" FAILS |
 * | `asThirdPartyLine` returns the line regardless of `produced_by_object_id` | "an internal line is not a pollable line" FAILS |
 */

const line = (
  over: Partial<Pick<DependencyLine, "ecosystem" | "major" | "tagPattern">> = {}
): Pick<DependencyLine, "ecosystem" | "major" | "tagPattern"> => ({
  ecosystem: "npm",
  major: "1",
  tagPattern: null,
  ...over
});

describe("lineAcceptsVersion — a release must be proven to be ON THIS LINE", () => {
  it("accepts a version on the line and REFUSES one from a neighbouring major", () => {
    expect(lineAcceptsVersion(line({ major: "1" }), "1.2.3")).toMatchObject({ accepted: true });
    // The failure this prevents: one component legitimately produces a `1.x` maintenance line and a
    // `2.x` line. Recording a 1.9.9 hotfix as the head of the `2` line would make every 2.x
    // subscriber look AHEAD of a head that is behind them.
    expect(lineAcceptsVersion(line({ major: "2" }), "1.9.9")).toMatchObject({
      accepted: false,
      reason: "different_major_line"
    });
  });

  it("compares at the LINE'S OWN precision — `3.18` is a (major, minor) line", () => {
    expect(lineAcceptsVersion(line({ major: "3.18" }), "3.18.4")).toMatchObject({
      accepted: true
    });
    expect(lineAcceptsVersion(line({ major: "3.18" }), "3.19.0")).toMatchObject({
      accepted: false,
      reason: "different_major_line"
    });
    // …and a major-only line still accepts the same release, so the precision is read from the
    // line rather than fixed at two components.
    expect(lineAcceptsVersion(line({ major: "3" }), "3.19.0")).toMatchObject({ accepted: true });
  });

  it("accepts the ecosystem's own spelling of a major (`v2`)", () => {
    expect(lineAcceptsVersion(line({ ecosystem: "go", major: "v2" }), "v2.1.0")).toMatchObject({
      accepted: true
    });
    expect(lineAcceptsVersion(line({ ecosystem: "go", major: "v2" }), "2.1.0")).toMatchObject({
      accepted: true
    });
  });

  it("REFUSES rather than assumes when either side has no comparable core", () => {
    expect(lineAcceptsVersion(line({ major: "stable" }), "1.2.3")).toMatchObject({
      accepted: false,
      reason: "major_line_not_comparable"
    });
    expect(lineAcceptsVersion(line({ major: "1" }), "latest")).toMatchObject({
      accepted: false,
      reason: "version_not_comparable"
    });
  });

  // -----------------------------------------------------------------------------------------
  // `tag_pattern` HAS ONE MEANING, AND BOTH WRITERS USE IT
  // -----------------------------------------------------------------------------------------

  it("an `-alpine` line REFUSES the plain flavour — and the plain line refuses `-alpine`", () => {
    // THE DEFECT THIS PINS: internal detection ignored `tag_pattern` entirely, so an image line
    // declared as the alpine variant happily took `3.18.4` — a glibc image — as its head, and every
    // subscriber tracking the alpine variant would have been bumped across flavours. The poll, using
    // the same column as a literal suffix, would never have offered that tag. One column, two
    // meanings; now one.
    const alpine = line({ ecosystem: "oci", major: "3.18", tagPattern: "-alpine" });
    expect(lineAcceptsVersion(alpine, "3.18.4-alpine")).toMatchObject({ accepted: true });
    expect(lineAcceptsVersion(alpine, "3.18.4")).toMatchObject({
      accepted: false,
      reason: "different_tag_variant"
    });
    expect(lineAcceptsVersion(alpine, "3.18.4-slim")).toMatchObject({
      accepted: false,
      reason: "different_tag_variant"
    });

    // NEGATIVE CONTROL, the other direction: a line with no pattern is the PLAIN flavour and must
    // not drift onto a variant either. Without this, "refuses everything with a suffix" would pass
    // the assertions above.
    const plain = line({ ecosystem: "oci", major: "3.18", tagPattern: null });
    expect(lineAcceptsVersion(plain, "3.18.4")).toMatchObject({ accepted: true });
    expect(lineAcceptsVersion(plain, "3.18.4-alpine")).toMatchObject({
      accepted: false,
      reason: "different_tag_variant"
    });
  });

  it("the pattern is read for `oci` ONLY — a language line can never be steered by a stray one", () => {
    // 0061 normalises `tag_pattern` to NULL for the four language ecosystems on write; this is the
    // reader's half of the same rule, so a row that predates it cannot change a language line's
    // meaning.
    expect(eligibleSuffixFor({ ecosystem: "oci", tagPattern: "-alpine" })).toBe("-alpine");
    expect(eligibleSuffixFor({ ecosystem: "npm", tagPattern: "-alpine" })).toBe("");
    expect(
      lineAcceptsVersion(line({ ecosystem: "npm", tagPattern: "-alpine" }), "1.2.3")
    ).toMatchObject({ accepted: true });
  });

  it("a prerelease is never on a language line", () => {
    // Same rule, different consequence: the empty suffix means STABLE RELEASES ONLY, so a
    // subscription cannot bump a component onto a release candidate.
    expect(lineAcceptsVersion(line({ major: "2" }), "2.0.0-rc.1")).toMatchObject({
      accepted: false,
      reason: "different_tag_variant"
    });
  });

  it("an image tag with a single numeric component is not a version — for BOTH writers", () => {
    // `20240115` and `7` are indistinguishable as strings (a date stamp and a major line). The poll
    // refused them and internal detection did not; the shared parse door means one answer.
    expect(lineAcceptsVersion(line({ ecosystem: "oci", major: "7" }), "7")).toMatchObject({
      accepted: false,
      reason: "version_not_comparable"
    });
    expect(lineAcceptsVersion(line({ ecosystem: "oci", major: "7" }), "7.1")).toMatchObject({
      accepted: true
    });
  });
});

describe("evaluateHeadMovement — a head never moves backwards", () => {
  it("a hotfix BEHIND the head does not move it, and says so", () => {
    // THE DEFECT THIS PINS: `1.10.0` ships, then a hotfix `1.9.10` ships on the maintenance branch
    // of the SAME line. Both are genuine production releases. Internal detection applied no ordering
    // check at all, so the second one walked the column back and every subscriber already on 1.10.0
    // looked ahead of its own line's head — a subscription that then never fires again, silently.
    const movement = evaluateHeadMovement(
      { ...line({ major: "1" }), latestVersion: "1.10.0" },
      "1.9.10"
    );
    expect(movement).toMatchObject({ moves: false, reason: "behind_head" });
    if (movement.moves) throw new Error("unreachable");
    expect(movement.detail).toMatch(/1\.10\.0/);

    // POSITIVE CONTROL: the same line DOES advance for a genuinely newer release, so the refusal
    // above is about the ordering and not about a function that refuses everything.
    expect(
      evaluateHeadMovement({ ...line({ major: "1" }), latestVersion: "1.10.0" }, "1.10.1")
    ).toMatchObject({ moves: true, movement: "advanced" });
  });

  it("numeric ordering, never string ordering — `1.9.0` does not beat `1.10.0`", () => {
    // String order gives "1.9.0" > "1.10.0" and would make the regression above look like progress.
    expect(
      evaluateHeadMovement({ ...line({ major: "1" }), latestVersion: "1.9.0" }, "1.10.0")
    ).toMatchObject({ moves: true, movement: "advanced" });
  });

  it("the first observation is an advance, and a re-observation is a restatement", () => {
    expect(
      evaluateHeadMovement({ ...line({ major: "1" }), latestVersion: null }, "1.2.3")
    ).toMatchObject({ moves: true, movement: "advanced" });
    expect(
      evaluateHeadMovement({ ...line({ major: "1" }), latestVersion: "1.2.3" }, "1.2.3")
    ).toMatchObject({ moves: true, movement: "restated" });
  });

  it("a stored value that is not on the line as defined NOW is replaced, not treated as a head", () => {
    // An operator repoints `tag_pattern` to `-alpine`; the stored plain head is now incomparable to
    // every candidate. Refusing on that would wedge the line forever — nothing in the API can reset
    // `latest_version` — so the value that is not a head of this line is discarded, and the detail
    // says which.
    const movement = evaluateHeadMovement(
      {
        ...line({ ecosystem: "oci", major: "3.18", tagPattern: "-alpine" }),
        latestVersion: "3.18.4"
      },
      "3.18.2-alpine"
    );
    expect(movement).toMatchObject({ moves: true, movement: "advanced" });
    if (!movement.moves) throw new Error("unreachable");
    expect(movement.detail).toMatch(/3\.18\.4/);
  });

  it("a version on ANOTHER line never moves this line's head, whatever the ordering says", () => {
    expect(
      evaluateHeadMovement({ ...line({ major: "2" }), latestVersion: "2.0.0" }, "9.9.9")
    ).toMatchObject({ moves: false, reason: "different_major_line" });
  });
});

describe("asThirdPartyLine — the ingress split is structural", () => {
  const row = {
    id: "11111111-1111-1111-1111-111111111111",
    ecosystem: "npm" as const,
    coordinate: "@acme/lib",
    major: "2",
    tagPattern: null
  };

  it("an INTERNAL line is not a pollable line", () => {
    // The failure this prevents is dependency-confusion shaped: the org's own `@acme/lib` 2.1.0,
    // derived from its own production release, overwritten by a stranger's 9.9.9 from the public
    // index that happens to carry the same coordinate — and every subscriber bumped onto it.
    expect(asThirdPartyLine(row, { hasDeclaredProducer: true })).toBeNull();
  });

  it("a THIRD-PARTY line is — the negative control that makes the refusal about the declaration", () => {
    const pollable = asThirdPartyLine(row, { hasDeclaredProducer: false });
    expect(pollable).not.toBeNull();
    expect(pollable?.coordinate).toBe("@acme/lib");
  });

  it("THE FACT IS AN ARGUMENT, so a caller who never looked cannot get a pollable line by default", () => {
    // WHY THIS CASE EXISTS (drizzle/0068). Under the old signature the internal-ness fact was a
    // COLUMN on the line row, and the dangerous path was a row whose column was NULL because nobody
    // had ever written it — a brand-new major of a coordinate the org publishes. `asThirdPartyLine`
    // dutifully returned a pollable line, and the org's own package went to a public index.
    //
    // The fact is now a required second parameter, so "I did not look" is not expressible: the two
    // call sites below are the only two answers, and there is no third that means "unknown". This
    // asserts the SHAPE — `asThirdPartyLine.length === 2` — because the whole guarantee is that the
    // argument cannot be omitted, and a one-argument overload would restore the old hole with every
    // other test still green.
    expect(asThirdPartyLine.length).toBe(2);
  });
});

describe("evaluateIngressAuthority — the ingress split survives the transaction boundary", () => {
  /**
   * WHY THIS EXISTS ALONGSIDE `asThirdPartyLine`, WHICH ALREADY SPLITS THE INGRESSES.
   *
   * `asThirdPartyLine` mints a COMPILE-TIME brand, and it is minted in an EARLIER TRANSACTION than
   * the head write — both ingresses deliberately do their network work with no transaction open
   * ("a registry that takes 15s must never hold a tenant transaction"). So the brand asserts "no
   * declaration existed when the work-list was built", which a declare landing in that window makes
   * false. Measured: a public `2.99.0` landed on a just-declared internal line, fanned a bump out,
   * and was then unfixable — the poll no longer visits an internal line, and the org's real `2.1.0`
   * is refused as `behind_head`.
   *
   * This is the runtime half, re-checked at the write door inside the writing transaction. The
   * end-to-end replay of the race is `version-poll.integration.test.ts` (6); this pins the rule
   * itself, both directions, without a database.
   *
   * MUTATION LOG — applied, watched fail, reverted, watched pass:
   * | Mutation | Result |
   * |---|---|
   * | `return { authorized: true }` unconditionally | three of the four cases below FAIL |
   * | keep only the `third_party` branch (guard the confusion direction alone) | "an INTERNAL write onto a RETRACTED coordinate is refused" FAILS |
   * | keep only the `internal` branch | "a THIRD-PARTY write onto a DECLARED coordinate is refused" FAILS |
   */

  it("a THIRD-PARTY write onto a DECLARED coordinate is refused, and says which fact refused it", () => {
    const verdict = evaluateIngressAuthority("third_party", { hasDeclaredProducer: true });
    expect(verdict.authorized).toBe(false);
    if (verdict.authorized) throw new Error("unreachable");
    expect(verdict.reason).toBe("line_is_internal");
    // The detail names the DECLARATION, because that is the fact an operator acts on — a refusal
    // has to be legible without reading this function (charter principle 6).
    expect(verdict.detail).toMatch(/producer is declared/);
  });

  it("an INTERNAL write onto a RETRACTED coordinate is refused — the symmetric race, not an afterthought", () => {
    // The direction `resetLineHead`'s header calls a SECURITY fix rather than a wedge fix: a stale
    // internal head on a coordinate that is third-party again is an M22 vendor-rule input, so it
    // can grant a scan pass against a version no registry ever published.
    const verdict = evaluateIngressAuthority("internal", { hasDeclaredProducer: false });
    expect(verdict.authorized).toBe(false);
    if (verdict.authorized) throw new Error("unreachable");
    expect(verdict.reason).toBe("line_is_third_party");
    expect(verdict.detail).toMatch(/no producer is declared/);
  });

  it("each ingress writes the lines it owns — the negative control for both refusals above", () => {
    expect(evaluateIngressAuthority("third_party", { hasDeclaredProducer: false })).toEqual({
      authorized: true
    });
    expect(evaluateIngressAuthority("internal", { hasDeclaredProducer: true })).toEqual({
      authorized: true
    });
  });

  it("THE INGRESS IS AN ARGUMENT — neither caller can omit it and get a default", () => {
    // Same shape assertion as `asThirdPartyLine.length === 2` above, and for the same reason: a
    // default value for `ingress` would silently authorize whichever race it named, with every
    // other test in this file still green. `recordDependencyLineHead` takes it as its REQUIRED
    // fourth parameter; here the pure rule takes it as its required first.
    expect(evaluateIngressAuthority.length).toBe(2);
  });
});
