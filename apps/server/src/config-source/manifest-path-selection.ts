/**
 * Manifest path selection (team-pipeline-iac proposal §4, D9): given a config source's `paths`
 * globs and the paths one commit diff touched (`ExtractedHint.paths`,
 * `coordination/webhook-processor.ts`), decide which changed paths are stack manifests this sync
 * should read.
 *
 * ================================================================================================
 * MATCHER CHOICE — deliberately NOT `coordination/glob-match.ts`
 * ================================================================================================
 * `glob-match.ts` translates a leading `**\/` literally: `.*` followed by a literal `/`, which
 * requires AT LEAST ONE character before that slash. So `**\/go.mod` matches `services/go.mod` but
 * MISSES a repo-root `go.mod` — the exact case `packages/plugins/git-provider-core/src/read-tree.ts`'s
 * `globMatchesPath` documents and fixes (a leading `**\/` also matches ZERO leading segments).
 *
 * A repo-root `scp/manifest.json` is the single most common config-source case (D9: "the same repo
 * that drives a component's releases carries `scp/stack.ts` + its committed `scp/manifest.json`" —
 * for a great many components that IS the repo root). Inheriting `glob-match.ts`'s gap here would
 * make the default case — a team registers `paths: ["**\/scp/manifest.json"]` (or the scaffolder's
 * own emitted default) expecting it to also catch a root-level `scp/manifest.json` — silently miss
 * the manifest on every sync. That is precisely the "repo ahead of the graph, displayed as nothing"
 * failure §4 rules out, one layer earlier than `sync-status.ts` even gets involved: the manifest is
 * never read, so there is no attempt to report a status for.
 *
 * This module therefore uses a CORRECTED matcher, {@link manifestPathGlobMatch}, whose regex
 * translation is IDENTICAL to `read-tree.ts`'s `globMatchesPath` (same grammar: `*` within a
 * segment, `**` across `/`, PLUS a leading `**\/` also matching zero leading segments). It is
 * duplicated rather than imported from `@scp/git-provider-core` for the same reason
 * `registration-match.ts` duplicates `manifest-reader.ts`'s identity rule instead of importing it:
 * every existing `apps/server` reference to `@scp/git-provider-core` is a TYPE-ONLY import (the
 * package's runtime code executes inside the plugin subprocess, never in the host process — see
 * `plugin-host/host.ts`'s `gitFileRead()`); a fresh runtime import would be a new, unprecedented
 * dependency shape for a dozen lines of pure regex logic that this codebase's own convention says
 * to duplicate instead (`read-tree.ts`'s own header gives the identical reasoning for why IT
 * duplicates `glob-match.ts` rather than importing it, in the opposite direction).
 *
 * ================================================================================================
 * WHAT WOULD CHANGE IF `glob-match.ts` WERE FIXED CENTRALLY INSTEAD — REPORTED, NOT DECIDED HERE
 * ================================================================================================
 * `glob-match.ts` has two existing consumers: `dependencies/inventory-ingestion.ts` and
 * `coordination/correlation.ts`. Measured against what they actually store (both files' own
 * comments and the patterns their tests/docs give):
 *
 *  - Every `source_mappings.pathPattern`/`repoPattern` this codebase's own code documents as
 *    ACTUALLY AUTHORED is a SUFFIX wildcard (`${componentPath}/**`) or a plain namespace pattern
 *    (`acme/*`) — never a pattern that STARTS with `**`. `read-tree.ts`'s own header states this
 *    explicitly ("every `source_mappings.pathPattern` in this codebase is `${componentPath}/**`, a
 *    SUFFIX use"). So on TODAY's stored data, fixing `glob-match.ts` centrally would be a no-op for
 *    both consumers — no stored pattern exercises the changed branch.
 *  - It would stop being a no-op the moment an operator authored a leading-`**` pattern, and
 *    `inventory-ingestion.ts` is the more likely place that happens: its whole job is finding
 *    dependency manifests (`go.mod`, `package.json`, …) anywhere in a repo, and its own module doc
 *    already reasons carefully about wildcard-headed patterns (`hasGlobMeta`, the literal-prefix
 *    walk in `repoManifestScope`) — a `pathPattern` of `**\/go.mod` to catch a root-level `go.mod`
 *    is exactly the shape that doc anticipates an operator reaching for, and it would silently fail
 *    to match the root file today, the identical hazard this module exists to avoid for
 *    config-source manifests. `correlation.ts`'s `pathPattern`/`repoPattern` matching has the same
 *    latent gap but no equivalent "root file" framing in its own comments — it is a smaller
 *    realistic hit.
 *
 * RECOMMENDATION: fix `glob-match.ts` centrally (add the same leading-`**\/`-matches-zero-segments
 * rule `globMatchesPath` already carries) rather than leave two call sites carrying a landmine that
 * is merely unexercised today, not absent. Left to the owner per this increment's brief.
 */

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
  /**
   * A PROVISIONAL grouping key — the manifest's containing directory (everything before its final
   * path segment; `""` for a repo-root manifest). This is NOT the manifest's `stackName`: a
   * synthesized `scp/manifest.json` can declare a stack name unrelated to its directory, and the
   * only way to learn it is to read and parse the file (a later, DB/HTTP-backed increment). This
   * key exists so a sync loop can dedupe "read this manifest" work items — two changed paths
   * sharing a directory are almost certainly the same manifest touched twice in one diff — BEFORE
   * any I/O happens, and it must never be presented to a user as the stack's identity.
   */
  groupKey: string;
}

function directoryOf(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx === -1 ? "" : path.slice(0, idx);
}

/**
 * Filter `changedPaths` (a commit diff's touched files) down to the ones matching at least one of
 * `pathGlobs` (a config source's registered `paths`), deduplicated and in the order they first
 * appeared in `changedPaths`. An empty `pathGlobs` matches nothing — the caller's registration
 * schema is responsible for requiring at least one glob; this function does not assume that and
 * simply returns no matches rather than throwing, since "this registration selects nothing" is a
 * legible (if useless) state to report, not a caller bug this function is positioned to catch.
 */
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
