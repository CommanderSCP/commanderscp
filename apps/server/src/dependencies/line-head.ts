import {
  compareVersions,
  parseComparableVersion,
  parseImageTagVersion,
  type ComparableVersion
} from "@scp/dependency-manifests";
import type { DependencyLine } from "@scp/schemas";

/**
 * M21.4 — WHAT `dependency_lines.latest_version` / `latest_digest` MEAN, IN ONE PLACE (ADR-0032 §7).
 *
 * ============================================================================================
 * WHY THIS FILE EXISTS: TWO WRITERS THAT DISAGREED
 * ============================================================================================
 * Two ingresses write that column pair, and before this module they meant different things by it:
 *
 *   - INTERNAL detection (`internal-release-detection.ts`) — DERIVED from an accepted change that
 *     reached a `prod` deployment-target, for a line the org DECLARES it produces.
 *   - THE THIRD-PARTY POLL (`version-poll.ts`) — POLLED from an ecosystem index, for a line nobody
 *     in the org produces.
 *
 * Left to themselves they disagreed on three questions, and each disagreement is a wrong claim in an
 * audit record rather than a crash:
 *
 *  1. WHAT `tag_pattern` IS. The poll read it as the line's literal variant suffix (`-alpine`);
 *     internal detection ignored it, so an `-alpine` line took a plain glibc tag as its head.
 *  2. WHETHER THE COLUMN IS A HEAD. The poll wrote the max of what an index offered; internal
 *     detection wrote whatever the last accepted change published — so a hotfix on an older minor
 *     of the same line moved `latest_version` BACKWARDS, and every subscriber already on the newer
 *     release looked ahead of its own line's head.
 *  3. WHETHER `latest_digest` BELONGS TO `latest_version`. The poll could write a new tag while
 *     RETAINING the previously stored digest, so the row asserted a (tag, digest) pair that never
 *     existed in any registry — and ADR-0032 §7's "a mutable tag is not an identity" makes that
 *     pair the whole claim.
 *
 * So the meaning is stated here, once, and both writers reach it through
 * {@link recordDependencyLineHead} — which is the only function in the tree that writes the
 * `latest_*` trio and which applies every rule below itself. A rule applied by each caller is a rule
 * with one place per caller to regress; applied at the write door it has one.
 *
 * ============================================================================================
 * THE MEANING
 * ============================================================================================
 *   `latest_version` is the HEAD of the line: the greatest version ON this line that this domain
 *   has observed. It never moves backwards, it is never a version from another line or another
 *   image variant, and NULL means "not yet observed" — never "no newer version exists"
 *   (migration 0061, and `scan_requirement_floors`' "absent never means zero").
 *
 *   `latest_digest` is the digest OF THAT version, observed in the same act. It is written together
 *   with the version or not at all; a digest never survives a version change, so the row cannot
 *   assert a pair nobody ever saw. NULL means "this version's digest was not resolved", which is a
 *   true statement — unlike the previous version's bytes sitting beside a new tag.
 *
 * A digest that could not be resolved does NOT block the observation, and that is a deliberate
 * choice with a measured reason rather than a softening: the operator-loaded air-gap feed carries
 * versions and NO digests at all (`version-index-feed.ts`), so requiring one would make an
 * air-gapped estate unable to ever record an image head — the exact "an air-gapped estate is
 * indistinguishable from a fully up-to-date one" failure §7 is arranged to avoid.
 *
 * ============================================================================================
 * AND WHO MAY WRITE IT — THE INGRESS SPLIT (ADR-0032 §7)
 * ============================================================================================
 * The two ingresses are not two ways of doing one job; they own DIFFERENT LINES. An internal line's
 * head is derived from the org's own production release and must never be polled, because a public
 * index that happens to carry the same coordinate would overwrite the org's own `2.1.0` with a
 * stranger's `9.9.9` and every subscriber would be bumped onto it. That is dependency confusion,
 * arriving through a background job nobody watches.
 *
 * {@link asThirdPartyLine} is how the split is enforced: `queryLineHead` accepts ONLY a
 * {@link ThirdPartyLine}, and the only way to obtain one is to hand that function a line TOGETHER
 * WITH the joined fact that no producer declaration exists for its coordinate (drizzle/0068 moved
 * the declaration off the line row and onto `dependency_line_producers`). A caller that "forgets
 * the filter" does not compile — and, since the fact is now an argument rather than a column that
 * may simply never have been written, a caller that never looked cannot supply it either.
 */

// -------------------------------------------------------------------------------------------
// The ingress split
// -------------------------------------------------------------------------------------------

/** The identity fields any head question is asked about. */
export type LineHeadIdentity = Pick<DependencyLine, "ecosystem" | "major" | "tagPattern">;

/** What an index is asked about — the identity plus the coordinate — and the row id the answer is
 *  recorded against. */
export type PollableLineKey = Pick<
  DependencyLine,
  "id" | "ecosystem" | "coordinate" | "major" | "tagPattern"
>;

declare const THIRD_PARTY_LINE: unique symbol;

/**
 * A line whose head the THIRD-PARTY POLL is allowed to move: NO producer declaration exists for its
 * COORDINATE.
 *
 * The brand is not decoration. It is the difference between "the poll happens to filter internal
 * lines out today" and "the poll cannot be handed one" — and this repo has already shipped the first
 * shape twice (the incomplete call-site census). `queryLineHead` takes this type, so a new caller,
 * a new work-list, or a test that assembles a line by hand must go through {@link asThirdPartyLine}
 * and get a `null` for an internal line rather than a silent registry fetch.
 */
export type ThirdPartyLine = PollableLineKey & { readonly [THIRD_PARTY_LINE]: "third-party" };

/**
 * The ONE constructor of a {@link ThirdPartyLine} — `null` for an internal line.
 *
 * THE INTERNAL-NESS FACT IS AN ARGUMENT, NOT A FIELD ON THE LINE (drizzle/0068, ADR-0032 §7e). It
 * used to read `line.producedByObjectId`, back when the declaration was a per-major column. It is
 * now per COORDINATE, so the caller must have JOINED `dependency_line_producers` and passes what
 * that join found.
 *
 * The lost convenience is the point. A caller who has not looked cannot supply the argument and so
 * cannot obtain a `ThirdPartyLine` by forgetting to check — whereas under the old signature the
 * forgetful path was a row whose column was NULL because NOBODY HAD EVER WRITTEN IT, and that path
 * polled the org's own package against a public index. The barrier could not protect a column
 * nobody filled in; it can refuse an argument nobody supplied.
 *
 * "Declared, never inferred" is why the declaration is the test: nothing here looks at the
 * coordinate for the org's name, or at a registry host.
 */
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

// -------------------------------------------------------------------------------------------
// Reading a version the way THIS line spells versions
// -------------------------------------------------------------------------------------------

/**
 * Which suffix class this line lives in — THE single meaning of `tag_pattern`.
 *
 * `tag_pattern` is the line's LITERAL VARIANT SUFFIX (`-alpine`, `-slim`), or absent for the plain
 * flavour. It is NOT a glob, and it is not a "shape" some other reader may interpret differently:
 * migration 0061 stores it verbatim and this is the only function that reads it.
 *
 * Why a suffix at all: `compareVersions` REFUSES to order two versions whose suffixes differ,
 * because `3.19-alpine` and `3.19-slim` are two flavours of one release rather than an upgrade
 * path, and `1.2.3-rc.1` vs `1.2.3` is a semver precedence rule that does not hold for OCI tags. A
 * head must therefore be picked WITHIN one suffix class, and a release outside the line's class is
 * not a candidate for its head at all.
 *
 *  - the four language ecosystems: the empty suffix, i.e. STABLE RELEASES ONLY. A prerelease
 *    (`2.0.0-rc.1`, PEP 440's `2.0rc1`, `v2.0.0-beta`) never becomes a line's head. That is a
 *    deliberate functional limit — a subscription that bumped a component onto a release candidate
 *    would be doing something nobody asked for — and it is why `tag_pattern` is normalised to NULL
 *    for them at the write door (`tagPatternFor`).
 *  - `oci`: the line's own `tagPattern`, or the empty suffix when it has none. An operator who
 *    writes something that is not a literal suffix gets NO eligible tags and a legible refusal
 *    naming the line, rather than a glob quietly matching the wrong flavour.
 */
export function eligibleSuffixFor(
  line: Pick<LineHeadIdentity, "ecosystem" | "tagPattern">
): string {
  if (line.ecosystem !== "oci") return "";
  return line.tagPattern ?? "";
}

/**
 * Parse a version string AS THIS LINE'S ECOSYSTEM SPELLS ONE — the single door both writers use.
 *
 * `oci` goes through `parseImageTagVersion`, which refuses a single-component tag: `20240115` and
 * `7` are indistinguishable as strings (a date stamp and a major line) and a registry offers no way
 * to tell them apart, so treating either as a version is exactly the guess ADR-0032 §7 forbids. The
 * four language ecosystems go through the plain parser.
 *
 * Both writers use this door, which is the point: before it, the poll refused a bare `7` while
 * internal detection accepted it, so the same tag meant two different things depending on which
 * ingress saw it first.
 */
export function parseLineVersion(
  line: Pick<LineHeadIdentity, "ecosystem">,
  version: string
): ComparableVersion | undefined {
  return line.ecosystem === "oci" ? parseImageTagVersion(version) : parseComparableVersion(version);
}

/**
 * Is `candidate` a member of the line `major` names?
 *
 * The test is STRUCTURAL, not textual: both sides are parsed, and the candidate must agree with the
 * line on every numeric component the line actually SPELLS (`ComparableVersion.precision` is the
 * receipt for how many that is). So `3` matches 3.x.y, `1.2` matches 1.2.z, and Go's `v2` matches
 * 2.x.y. Comparing the strings instead would fail on `v2` vs `2.1.0` and would accept `3` against
 * `30.1.0` by prefix.
 */
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

/**
 * Does `version` belong to THIS line — same major line, same variant?
 *
 * BOTH halves, in one function, because that is the fix for the disagreement this module opens
 * with: internal detection tested only the major and the poll tested only within its own selection
 * loop. There is no second reading of `tag_pattern` left in the tree.
 */
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

// -------------------------------------------------------------------------------------------
// Moving the head
// -------------------------------------------------------------------------------------------

/** Why an observation does not move the head. The four acceptance reasons plus the one that only
 *  exists once a head is already standing. */
export type HeadRefusalReason = LineAcceptanceReason | "behind_head";

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

/**
 * THE head rule, shared by both writers: A HEAD NEVER MOVES BACKWARDS.
 *
 * The case that made this necessary is ordinary, not exotic: a `1` line publishes `1.10.0`, then a
 * hotfix ships `1.9.10` on the maintenance branch. Both are genuine production releases of the same
 * line. Internal detection applied no ordering check at all, so the second one moved the column back
 * and every subscriber already on 1.10.0 looked ahead of its own line's head — a subscription that
 * would then never fire again for them, silently.
 *
 * A release that is genuinely older is NOT lost: it is refused HERE with `behind_head` and recorded
 * in the caller's Decision, which is where "this release happened, at this version, and the head did
 * not move" belongs. The column holds the head; the Decision holds the history.
 *
 * A STORED VALUE THAT IS NOT ON THE LINE AS DEFINED NOW IS NOT A HEAD. If an operator repoints a
 * line's `tag_pattern` (or its stored head predates a definition it no longer satisfies), the stored
 * text is incomparable to every new candidate — and refusing on that would wedge the line forever
 * with no remedy, since nothing in the API can reset `latest_version`. So such a value is discarded
 * and the candidate becomes the head, with the discarded value named in the detail. Regression is
 * only ever *demonstrable* between two versions that are both on the line, which is exactly where
 * the hotfix case lives.
 */
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
