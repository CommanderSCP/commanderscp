import {
  compareVersions,
  parseComparableVersion,
  parseImageTagVersion,
  type ComparableVersion
} from "@scp/dependency-manifests";
import type { DependencyLine } from "@scp/schemas";

/** What the head fields mean, in one place. See docs/dependencies.md §326. */

/** The identity fields any head question is asked about. */
export type LineHeadIdentity = Pick<DependencyLine, "ecosystem" | "major" | "tagPattern">;

/** What an index is asked about — the identity plus the coordinate — and the row id the answer is
 *  recorded against. */
export type PollableLineKey = Pick<
  DependencyLine,
  "id" | "ecosystem" | "coordinate" | "major" | "tagPattern"
>;

declare const THIRD_PARTY_LINE: unique symbol;

/** A line whose head the THIRD-PARTY POLL is allowed to move. See docs/dependencies.md §327. */
export type ThirdPartyLine = PollableLineKey & { readonly [THIRD_PARTY_LINE]: "third-party" };

/** The ONE constructor of a {@link ThirdPartyLine}. See docs/dependencies.md §328. */
export function asThirdPartyLine(
  line: PollableLineKey,
  producer: {
    /** True iff `dependency_line_producers` holds a row for this line's `(org, ecosystem,
     *  coordinate)`. The CALLER reads it; this function never derives it. */
    hasDeclaredProducer: boolean;
  }
): ThirdPartyLine | null {
  if (producer.hasDeclaredProducer) return null;
  return {
    id: line.id,
    ecosystem: line.ecosystem,
    coordinate: line.coordinate,
    major: line.major,
    tagPattern: line.tagPattern
  } as ThirdPartyLine;
}

/** Which ingress a head write is coming from. See docs/dependencies.md §329. */
export type HeadWriteIngress =
  /** `version-poll.ts` — an answer from a public ecosystem index. Legitimate ONLY while the
   *  coordinate has NO declared producer at all. It carries no identity and needs none: the poll
   *  speaks for no component, so ANY declaration makes the line somebody else's. */
  | { readonly kind: "third_party" }
  /**
   * `internal-release-detection.ts` — derived from the org's own accepted prod release, BY A NAMED
   * COMPONENT. Legitimate only while the declaration standing at write time names THAT component.
   *
   * `producerObjectId` is the component whose prod placement this derivation read — the identity
   * phase 1 already established via `listProducedLines` and which used to be thrown away between
   * `internal-release-detection.ts:526`'s call site and this rule.
   */
  | { readonly kind: "internal"; readonly producerObjectId: string };

/** Why an ingress may not write this line's head at all — a statement about WHO owns the line,
 *  decided before any statement about the version. */
export type IngressRefusalReason =
  /** A THIRD-PARTY answer for a coordinate that is now DECLARED INTERNAL. The dependency-confusion
   *  direction: a public index's `9.9.9` landing on the org's own package. */
  | "line_is_internal"
  /** An INTERNAL-release answer for a coordinate whose declaration has been RETRACTED. The
   *  symmetric direction: the org's own `2.7.0` landing on a line that is third-party again, where
   *  it wedges the poll and — since `latest_version` is an M22 vendor-rule input — can grant a scan
   *  pass against a version no registry ever published. */
  | "line_is_third_party"
  /**
   * An INTERNAL-release answer from a component that is NO LONGER this coordinate's declared
   * producer — the declaration stands, and it names SOMEBODY ELSE.
   *
   * The two reasons above are about whether the coordinate is internal; this one is about WHOSE it
   * is, and it is the only one of the three a boolean view of the declaration cannot see. The act it
   * guards is a supported one (a declare over an existing declaration TRANSFERS the coordinate —
   * `routes/dependency-producers.ts`'s `displacedProducerObjectId`), so the losing component's
   * in-flight derivation is an ordinary event rather than an exotic interleaving: it would otherwise
   * put the OLD producer's version on the line, fan bump PRs out from it, and wedge the NEW
   * producer's genuine release behind `behind_head` permanently.
   */
  | "line_transferred";

export type IngressAuthority =
  | { readonly authorized: true }
  | { readonly authorized: false; readonly reason: IngressRefusalReason; readonly detail: string };

/** MAY THIS INGRESS MOVE THIS LINE'S HEAD? See docs/dependencies.md §330. */
export function evaluateIngressAuthority(
  ingress: HeadWriteIngress,
  declaration: {
    /** The component named as this line's producer. See docs/dependencies.md §331. */
    readonly producerObjectId: string | null;
  }
): IngressAuthority {
  if (ingress.kind === "third_party") {
    if (declaration.producerObjectId === null) return { authorized: true };
    return {
      authorized: false,
      reason: "line_is_internal",
      detail:
        "a producer is declared for this coordinate, so its head is derived from the org's own " +
        "production releases — a public index's answer is refused here even though the line was " +
        "third-party when this poll started (ADR-0032 §7: dependency confusion)"
    };
  }
  if (declaration.producerObjectId === null) {
    return {
      authorized: false,
      reason: "line_is_third_party",
      detail:
        "no producer is declared for this coordinate any more, so its head is polled from a public " +
        "index — an internal release's version is refused here even though the declaration stood " +
        "when this derivation started (a stale internal head is an M22 vendor-rule input)"
    };
  }
  if (declaration.producerObjectId !== ingress.producerObjectId) {
    return {
      authorized: false,
      reason: "line_transferred",
      detail:
        `this coordinate's declared producer is ${declaration.producerObjectId}, and this release ` +
        `was derived from ${ingress.producerObjectId} — the coordinate was TRANSFERRED after this ` +
        `derivation started, so the former producer's version is refused here (recording it would ` +
        `fan bumps out from a component that no longer publishes this coordinate, and wedge the ` +
        `new producer's own release behind it)`
    };
  }
  return { authorized: true };
}

// Reading a version the way THIS line spells versions

/** Which suffix class this line lives in: one meaning. See docs/dependencies.md §332. */
export function eligibleSuffixFor(
  line: Pick<LineHeadIdentity, "ecosystem" | "tagPattern">
): string {
  if (line.ecosystem !== "oci") return "";
  return line.tagPattern ?? "";
}

/** Parse a version string AS THIS LINE'S ECOSYSTEM SPELLS ONE. See docs/dependencies.md §333. */
export function parseLineVersion(
  line: Pick<LineHeadIdentity, "ecosystem">,
  version: string
): ComparableVersion | undefined {
  return line.ecosystem === "oci" ? parseImageTagVersion(version) : parseComparableVersion(version);
}

/** Is `candidate` a member of the line `major` names? See docs/dependencies.md §334. */
export function isOnLine(candidate: ComparableVersion, lineMajor: ComparableVersion): boolean {
  if (candidate.major !== lineMajor.major) return false;
  if (lineMajor.precision >= 2 && candidate.minor !== lineMajor.minor) return false;
  if (lineMajor.precision >= 3 && candidate.patch !== lineMajor.patch) return false;
  return true;
}

/** Why a version is not a candidate for this line's head at all. */
export type LineAcceptanceReason =
  /** The LINE's own `major` text does not parse. Nothing can be tested for membership of a line
   *  whose identity cannot be read, so it is refused rather than assumed to match. */
  | "major_line_not_comparable"
  /** The candidate text is not a version this ecosystem's grammar can read (`latest`, a branch
   *  name, a bare `7` on an image line). Skipped rather than guessed. */
  | "version_not_comparable"
  /** Parseable, but on a different major line — a released `1.9.9` recorded against the `2` line is
   *  not a wrong version, it is a version on the wrong line. */
  | "different_major_line"
  /** Parseable and on the line's major, but a DIFFERENT VARIANT: the line follows `-alpine` and
   *  this is the plain (or `-slim`) flavour, or vice versa. Two flavours of one release are not an
   *  upgrade path. */
  | "different_tag_variant";

export type LineAcceptance =
  | { readonly accepted: true; readonly parsed: ComparableVersion }
  | { readonly accepted: false; readonly reason: LineAcceptanceReason; readonly detail: string };

/** Does `version` belong to THIS line. See docs/dependencies.md §335. */
export function lineAcceptsVersion(line: LineHeadIdentity, version: string): LineAcceptance {
  const lineMajor = parseComparableVersion(line.major);
  if (!lineMajor) {
    return {
      accepted: false,
      reason: "major_line_not_comparable",
      detail: `the line's major '${line.major}' has no comparable numeric core, so no version can be proven to belong to it`
    };
  }
  const parsed = parseLineVersion(line, version);
  if (!parsed) {
    return {
      accepted: false,
      reason: "version_not_comparable",
      detail: `'${version}' has no comparable numeric core for a ${line.ecosystem} line (ADR-0032 §7: skipped rather than guessed)`
    };
  }
  const wantSuffix = eligibleSuffixFor(line);
  if ((parsed.suffix ?? "") !== wantSuffix) {
    return {
      accepted: false,
      reason: "different_tag_variant",
      detail:
        `'${version}' is the '${parsed.suffix ?? "(plain)"}' variant and this line follows ` +
        `'${wantSuffix === "" ? "(plain)" : wantSuffix}' — two flavours of one release are not an upgrade path`
    };
  }
  if (!isOnLine(parsed, lineMajor)) {
    return {
      accepted: false,
      reason: "different_major_line",
      detail: `'${version}' is not on line '${line.major}' — recording it there would move a line's head onto a release from a different line`
    };
  }
  return { accepted: true, parsed };
}

/** Why an observation does not move the head. The four acceptance reasons, the one that only exists
 *  once a head is already standing, and the two that are about WHO may write rather than about the
 *  version — see {@link IngressRefusalReason}. */
export type HeadRefusalReason = LineAcceptanceReason | "behind_head" | IngressRefusalReason;

export type HeadMovement =
  | {
      readonly moves: true;
      /** `advanced` — this observation is ahead of the stored head (or there was none, or the
       *  stored value is not a version on the line as it is defined NOW). `restated` — the same
       *  point on the line, re-observed. */
      readonly movement: "advanced" | "restated";
      readonly detail: string;
    }
  | { readonly moves: false; readonly reason: HeadRefusalReason; readonly detail: string };

/** THE head rule, shared by both writers. See docs/dependencies.md §336. */
export function evaluateHeadMovement(
  line: LineHeadIdentity & { readonly latestVersion: string | null },
  candidateVersion: string
): HeadMovement {
  const acceptance = lineAcceptsVersion(line, candidateVersion);
  if (!acceptance.accepted) {
    return { moves: false, reason: acceptance.reason, detail: acceptance.detail };
  }
  if (line.latestVersion === null) {
    return {
      moves: true,
      movement: "advanced",
      detail: `'${candidateVersion}' is the first head observed on this line`
    };
  }
  const stored = lineAcceptsVersion(line, line.latestVersion);
  if (!stored.accepted) {
    return {
      moves: true,
      movement: "advanced",
      detail:
        `the stored head '${line.latestVersion}' is not a version on this line as it is defined ` +
        `now (${stored.reason}), so it is not a head to regress from — '${candidateVersion}' takes its place`
    };
  }
  const order = compareVersions(acceptance.parsed, stored.parsed);
  if (order === undefined) {
    // Unreachable: `lineAcceptsVersion` pins both sides to the same suffix, which is the only
    // condition under which `compareVersions` declines. Handled rather than asserted away — if the
    // suffix rule is ever loosened, an incomparable pair must REFUSE, never fall through to a move.
    return {
      moves: false,
      reason: "different_tag_variant",
      detail: `'${candidateVersion}' cannot be ordered against the stored head '${line.latestVersion}'`
    };
  }
  if (order === -1) {
    return {
      moves: false,
      reason: "behind_head",
      detail:
        `'${candidateVersion}' is BEHIND this line's head '${line.latestVersion}' — a head never ` +
        `moves backwards, so the release is recorded in this verdict and the column is left alone`
    };
  }
  if (order === 0) {
    return {
      moves: true,
      movement: "restated",
      detail: `'${candidateVersion}' is the head already standing on this line, re-observed`
    };
  }
  return {
    moves: true,
    movement: "advanced",
    detail: `'${candidateVersion}' is ahead of the previous head '${line.latestVersion}'`
  };
}
