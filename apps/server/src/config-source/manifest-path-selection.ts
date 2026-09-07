/** Manifest path selection. See docs/config-source.md §19. */

/** Corrected regex translation — see the module doc above for the one deliberate divergence from
 *  `coordination/glob-match.ts` (a leading `**\/` also matches zero leading path segments). */
export function manifestPathGlobMatch(pattern: string, path: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  let regexSource = escaped.replace(/\*\*|\*/g, (match) => (match === "**" ? ".*" : "[^/]*"));
  if (regexSource.startsWith(".*/")) {
    regexSource = `(?:.*/)?${regexSource.slice(3)}`;
  }
  return new RegExp(`^${regexSource}$`).test(path);
}

function matchesAnyManifestGlob(globs: readonly string[], path: string): boolean {
  return globs.some((glob) => manifestPathGlobMatch(glob, path));
}

/** One changed path this sync should read as a candidate stack manifest. */
export interface ManifestPathMatch {
  /** The changed path, verbatim from `ExtractedHint.paths` — what gets handed to `readFileAtRef`. */
  path: string;
  /** A PROVISIONAL grouping key. See docs/config-source.md §20. */
  groupKey: string;
}

function directoryOf(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx === -1 ? "" : path.slice(0, idx);
}

/** Filter a commit's changed paths by the registered globs. See docs/config-source.md §21. */
export function selectChangedManifestPaths(
  pathGlobs: readonly string[],
  changedPaths: readonly string[]
): ManifestPathMatch[] {
  const seen = new Set<string>();
  const matches: ManifestPathMatch[] = [];
  for (const path of changedPaths) {
    if (seen.has(path)) continue;
    if (!matchesAnyManifestGlob(pathGlobs, path)) continue;
    seen.add(path);
    matches.push({ path, groupKey: directoryOf(path) });
  }
  return matches;
}
