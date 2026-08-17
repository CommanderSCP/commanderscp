/**
 * THE single place that turns a version STRING into something comparable — and the single place
 * allowed to answer "I cannot".
 *
 * Why one shared helper rather than one per ecosystem: ADR-0032 §7 makes an absolute rule out of a
 * behaviour that is easy to breach accidentally — *"Image tags are not semver, so a line carries a
 * tag pattern plus a parsed-version extractor, unparseable tags are **skipped rather than
 * guessed**"* — and the milestone DoD test-pins it ("Mutation: making the extractor fall back to
 * string ordering fails it"). A rule enforced in five parsers is a rule with five places to
 * regress; enforced in one function it has one. Every parser in this package obtains
 * {@link DeclaredDependency.version} from here and nowhere else.
 *
 * The failure this guards against is concrete. String-ordering tags gives `"9" > "10"` and
 * `"1.2.3-alpine" < "1.2.3"`, so a subscription would happily "bump" a component from 10 to 9, or
 * from a musl variant to a glibc one. Returning `undefined` costs a missed bump; guessing costs a
 * wrong commit in someone's repo.
 */
import type { ComparableVersion } from "./types.js";

/**
 * Numeric core + remainder.
 *
 * - optional leading `v`/`V` — go.mod versions are `v1.2.3` and image tags are frequently `v1.2.3`;
 * - one to three dot-separated numeric components (`3`, `1.2`, `1.2.3`);
 * - a remainder that must begin with a separator (`-`, `+`, `_`, `.`) or an ASCII letter and then
 *   contain NO WHITESPACE, so `1.2.3-alpine`, `1.2.3+build.5`, `1.2.3.4` (Maven's fourth component)
 *   and PEP 440's `2.0rc1` are all accepted, while `1!2.0` (a PEP 440 epoch we do not model) and
 *   `1 2` are refused rather than silently truncated to `1`.
 *
 * The no-whitespace rule on the remainder is not cosmetic, and it was added because a test caught
 * the alternative getting it wrong: with a permissive `.*` remainder, npm's compound range
 * `>=3.23.8 <4` parses as major 3, minor 23 with the whole of `.8 <4` swallowed as a suffix — a
 * silently WRONG version rather than an honest `undefined`. A version token has no spaces in any of
 * the five ecosystems; a string with one is a range or an expression, and ranges are not versions.
 *
 * Anything that does not match this whole shape yields `undefined`. In particular `latest`,
 * `stable`, `edge`, `alpine` and `main` have no numeric core and are refused.
 *
 * A bare git sha is NOT refused here, and saying it was is the mistake this comment used to make.
 * Roughly six shas in ten begin with a digit, and `1a2b3c4d` matches the shape above exactly:
 * major 1, precision 1, suffix `a2b3c4d`. Two other mechanisms — not this one — are what keep it
 * harmless, and a caller must not assume a parse means "this is a version":
 * - {@link compareVersions} refuses any pair whose suffixes differ, so `1a2b3c4d` can never be
 *   ordered against a real tagged release; and
 * - {@link parseImageTagVersion} refuses precision-1 tags by default, so it never enters a
 *   registry-side ranking.
 * Refusing it HERE is not available: the same shape is a legitimate PEP 440 version (`2rc1`) and a
 * legitimate image tag, and this function is the single door all five ecosystems use.
 */
const VERSION_RE = /^[vV]?(\d+)(?:\.(\d+))?(?:\.(\d+))?((?:[-+_.]|[A-Za-z])\S*)?$/;

/**
 * Extract a comparable `(major, minor, patch)` from a version string, or `undefined` when the
 * string cannot be understood. NEVER returns a guess.
 *
 * Zero-filling: `1.2` yields `{major:1, minor:2, patch:0, precision:2}`. The zero-fill is what makes
 * the triple comparable at all, and `precision` is the receipt that says it happened — see
 * {@link ComparableVersion.precision} for why that receipt matters for moving image tags.
 *
 * @param raw the version text exactly as the manifest wrote it (leading/trailing space tolerated).
 */
export function parseComparableVersion(raw: string): ComparableVersion | undefined {
  const trimmed = raw.trim();
  if (trimmed === "") return undefined;

  const m = VERSION_RE.exec(trimmed);
  if (!m) return undefined;

  // Group 1 is non-optional in the pattern, so a match guarantees it. `noUncheckedIndexedAccess` is
  // on, hence the explicit guard rather than a non-null assertion (the codebase bans `any` and
  // assertions of convenience alike).
  const majorText = m[1];
  if (majorText === undefined) return undefined;

  const minorText = m[2];
  const patchText = m[3];
  const suffix = m[4];

  // A component long enough to overflow safe-integer range is not a version we can compare; refuse
  // rather than silently producing an imprecise float. (Real tags do reach 8 digits — date stamps
  // like `20240115` — so this bound is not theoretical, it is just far above them.)
  const major = Number(majorText);
  const minor = minorText === undefined ? 0 : Number(minorText);
  const patch = patchText === undefined ? 0 : Number(patchText);
  if (
    !Number.isSafeInteger(major) ||
    !Number.isSafeInteger(minor) ||
    !Number.isSafeInteger(patch)
  ) {
    return undefined;
  }

  const precision: 1 | 2 | 3 = patchText !== undefined ? 3 : minorText !== undefined ? 2 : 1;

  return {
    major,
    minor,
    patch,
    precision,
    ...(suffix !== undefined && suffix !== "" ? { suffix } : {}),
    raw: trimmed
  };
}

/**
 * The image-tag door onto {@link parseComparableVersion}, with the one extra rule that OCI tags
 * need and semver strings do not.
 *
 * **A single numeric component is refused by default.** `20240115`, `20240116`, `7` and `12` are
 * indistinguishable as strings: the first two are date stamps, the last two are major lines, and a
 * registry offers no way to tell them apart (proposal §6.3: *"`1.2.3`, `1.2.3-alpine`, `1.2`,
 * `latest` and date stamps all coexist, and a registry has no notion of a major line"*). Comparing
 * a date stamp against a major line, or "bumping" a `7` line onto a `20240115` tag, is exactly the
 * guess ADR-0032 §7 forbids — so tags carrying only one numeric component are SKIPPED.
 *
 * A subscription that genuinely tracks a date-stamped line can lower `minPrecision` to 1 for that
 * line explicitly. That is a declaration by the subscriber, which is allowed; the default inferring
 * it is not.
 *
 * @param tag the tag portion of an image reference (`3.19`, `1.2.3-alpine`, `latest`).
 * @param minPrecision how many numeric components the tag must actually carry. Default 2.
 */
export function parseImageTagVersion(
  tag: string,
  options?: { readonly minPrecision?: 1 | 2 | 3 }
): ComparableVersion | undefined {
  const minPrecision = options?.minPrecision ?? 2;
  const parsed = parseComparableVersion(tag);
  if (!parsed) return undefined;
  if (parsed.precision < minPrecision) return undefined;
  return parsed;
}

/**
 * Order two parsed versions, or refuse.
 *
 * Returns `undefined` when the two carry DIFFERENT suffixes, because such a pair is not ordered by
 * anything this package knows. `3.19-alpine` and `3.19-slim` are two variants of one release, not
 * an upgrade path; `1.2.3-rc.1` and `1.2.3` differ by semver precedence rules that do not hold for
 * OCI tags. Rather than apply semver precedence to strings that are frequently not semver, the
 * comparison is declined and the caller must compare within a suffix (i.e. within a variant line).
 *
 * Two versions with the SAME suffix — including both having none — are ordered numerically on
 * (major, minor, patch). Differing `precision` does not block the comparison, but see
 * {@link ComparableVersion.precision}: `1.2` is a moving tag, and a caller bumping onto it should
 * know it is bumping onto a label rather than a point.
 *
 * @returns -1 if `a < b`, 0 if equal, 1 if `a > b`, `undefined` if not comparable.
 */
export function compareVersions(
  a: ComparableVersion,
  b: ComparableVersion
): -1 | 0 | 1 | undefined {
  if ((a.suffix ?? "") !== (b.suffix ?? "")) return undefined;
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;
  return 0;
}
