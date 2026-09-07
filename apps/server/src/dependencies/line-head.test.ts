import { describe, expect, it } from "vitest";
import type { DependencyLine } from "@scp/schemas";
import {
  asThirdPartyLine,
  eligibleSuffixFor,
  evaluateHeadMovement,
  evaluateIngressAuthority,
  lineAcceptsVersion,
  type HeadWriteIngress
} from "./line-head.js";

/** What the head fields mean, pinned without a database. See docs/dependencies.md §321. */

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

  // `tag_pattern` HAS ONE MEANING, AND BOTH WRITERS USE IT

  it("an `-alpine` line REFUSES the plain flavour — and the plain line refuses `-alpine`", () => {
    // THE DEFECT THIS PINS. See docs/dependencies.md §322.
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
    // WHY THIS CASE EXISTS. See docs/dependencies.md §323.
    expect(asThirdPartyLine.length).toBe(2);
  });
});

describe("evaluateIngressAuthority — the ingress split survives the transaction boundary", () => {
  /** Why this exists alongside the ingress splitter. See docs/dependencies.md §324. */

  const P = "aaaaaaaa-0000-0000-0000-000000000001";
  const Q = "bbbbbbbb-0000-0000-0000-000000000002";

  it("a THIRD-PARTY write onto a DECLARED coordinate is refused, and says which fact refused it", () => {
    const verdict = evaluateIngressAuthority({ kind: "third_party" }, { producerObjectId: P });
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
    const verdict = evaluateIngressAuthority(
      { kind: "internal", producerObjectId: P },
      { producerObjectId: null }
    );
    expect(verdict.authorized).toBe(false);
    if (verdict.authorized) throw new Error("unreachable");
    expect(verdict.reason).toBe("line_is_third_party");
    expect(verdict.detail).toMatch(/no producer is declared/);
  });

  it("a TRANSFER refuses the FORMER producer's in-flight write — the case a boolean could not see", () => {
    // THE BUG THIS ARM EXISTS FOR, measured. See docs/dependencies.md §325.
    const verdict = evaluateIngressAuthority(
      { kind: "internal", producerObjectId: P },
      { producerObjectId: Q }
    );
    expect(verdict.authorized).toBe(false);
    if (verdict.authorized) throw new Error("unreachable");
    expect(verdict.reason).toBe("line_transferred");
    // It is a DISTINCT reason from the two above, not `line_is_third_party` reused: the coordinate
    // IS internal, so saying it is third-party would be a false statement in an audit record.
    expect(verdict.reason).not.toBe("line_is_third_party");
    // BOTH identities are named, because "you may not write here" is unactionable without them —
    // the operator needs to know which component holds the coordinate now (principle 6).
    expect(verdict.detail).toContain(P);
    expect(verdict.detail).toContain(Q);
  });

  it("each ingress writes the lines it owns — the negative control for all three refusals above", () => {
    expect(evaluateIngressAuthority({ kind: "third_party" }, { producerObjectId: null })).toEqual({
      authorized: true
    });
    // THE SUCCESS DIRECTION OF THE TRANSFER RULE, stated explicitly: P writing to a line still
    // declared to P must still record. Without this the transfer refusal above is satisfied by a
    // rule that refuses every internal write.
    expect(
      evaluateIngressAuthority({ kind: "internal", producerObjectId: P }, { producerObjectId: P })
    ).toEqual({ authorized: true });
  });

  it("THE INGRESS IS AN ARGUMENT — neither caller can omit it and get a default", () => {
    // Same shape assertion as `asThirdPartyLine.length === 2` above, and for the same reason: a
    // default value for `ingress` would silently authorize whichever race it named, with every
    // other test in this file still green. `recordDependencyLineHead` takes it as its REQUIRED
    // fourth parameter; here the pure rule takes it as its required first.
    expect(evaluateIngressAuthority.length).toBe(2);
  });

  it("THE PRODUCER IDENTITY IS NOT OPTIONAL ON THE `internal` ARM — a type-level assertion", () => {
    // The guarantee is compile-time, so this asserts the SHAPE the compiler enforces rather than a
    // runtime behaviour: `{ kind: "internal" }` with no `producerObjectId` must not be assignable to
    // `HeadWriteIngress`. If someone widens the field to optional, THIS line stops erroring and the
    // `@ts-expect-error` directive itself becomes the failure — which is the point: the hole this
    // fix closed was "the caller did not have to say", one level down from "the caller did not have
    // to pass an ingress at all".
    // @ts-expect-error producerObjectId is required on the internal arm
    const incomplete: HeadWriteIngress = { kind: "internal" };
    expect(incomplete.kind).toBe("internal");
  });
});
