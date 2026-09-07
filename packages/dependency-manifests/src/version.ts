/** The one place a version string becomes comparable. See docs/dependency-manifests.md §96. */
import type { ComparableVersion } from "./types.js";

/** Numeric core + remainder. See docs/dependency-manifests.md §97. */
const VERSION_RE = /^[vV]?(\d+)(?:\.(\d+))?(?:\.(\d+))?((?:[-+_.]|[A-Za-z])\S*)?$/;

/**
 * Extract a comparable triple, never a guess. See docs/dependency-manifests.md §98.
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
 * The image-tag door, with the one rule tags need. See docs/dependency-manifests.md §99.
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
 * Order two parsed versions, or refuse. See docs/dependency-manifests.md §100.
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
