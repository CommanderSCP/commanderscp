import type { PluginContext } from "@scp/plugin-api";
import type { ReadFileAtRefResult } from "./read-file.js";

/** `readFilesAtRef` — bounded multi-file / tree reads. See docs/plugins.md §121. */

export interface ReadTreeAtRefRequest {
  /** Same semantics as `ReadFileAtRefRequest.repo` — optional, defaults to the binding's own repo. */
  repo?: string;
  /** Branch, tag, or commit sha — same validation as `readFileAtRef` (`assertSafeRef`). */
  ref: string;
  /** Repo-relative globs; a path matching any of them is included. See docs/plugins.md §122. */
  globs: string[];
  /** Per-file decode bound — see {@link ReadFileAtRefRequest.maxBytes} (same resolution rules,
   *  `resolveMaxBytes`). Applied independently to each matched file. */
  maxFileBytes?: number;
  /** Cap on the number of MATCHED files this call will read. Defaults to
   *  {@link DEFAULT_MAX_TREE_FILES}, clamped to {@link HARD_MAX_TREE_FILES}. */
  maxFiles?: number;
  /** Cap on cumulative DECODED bytes across every file this call reads. Defaults to
   *  {@link DEFAULT_MAX_TREE_TOTAL_BYTES}, clamped to {@link HARD_MAX_TREE_TOTAL_BYTES}. */
  maxTotalBytes?: number;
  /** Cap on raw tree entries enumerated while listing/matching. Defaults to
   *  {@link DEFAULT_MAX_TREE_ENTRIES_SCANNED}, clamped to {@link HARD_MAX_TREE_ENTRIES_SCANNED}. */
  maxEntriesScanned?: number;
}

/** One matched file's read outcome. See docs/plugins.md §123. */
export interface ReadTreeAtRefFile {
  path: string;
  result: ReadFileAtRefResult;
}

export interface ReadTreeAtRefFound {
  outcome: "found";
  requestedRef: string;
  /** The commit `ref` resolved to — ONE resolution shared by every file in `files`, so "this
   *  batch was read at commit X" is a single true statement, the same discipline
   *  `readFileAtRef`'s own doc explains for a single file. */
  commitSha: string;
  /** One entry per glob-matched path, in the order they were matched while scanning the tree. */
  files: ReadTreeAtRefFile[];
}

export interface ReadTreeAtRefNotFound {
  outcome: "not_found";
  /** Gitea/GitHub distinguish a bad ref via a separate resolve step (`"ref"`); GitLab answers in
   *  one call and cannot (`"unknown"`) — same distinction `ReadFileAtRefNotFound.missing` draws. */
  missing: "ref" | "unknown";
  requestedRef: string;
  detail?: string;
}

export type ReadTreeAtRefResult = ReadTreeAtRefFound | ReadTreeAtRefNotFound;

export type ReadFilesAtRefHook = (
  ctx: PluginContext,
  request: ReadTreeAtRefRequest
) => Promise<ReadTreeAtRefResult>;

// Bounds — axes 2-4. Axis 1 (per-file bytes) is `read-file.ts`'s existing `resolveMaxBytes`.

/** Default cap on matched files per call. Sized for what this capability is FOR (ADR-0032-style
 *  manifest ingestion across a monorepo's components) — dozens to low hundreds of manifests, not
 *  thousands. */
export const DEFAULT_MAX_TREE_FILES = 200;

/** Absolute ceiling on `maxFiles`, for the same reason `HARD_MAX_FILE_BYTES` exists: the bound
 *  must be structural, not advisory, against a caller-supplied value. */
export const HARD_MAX_TREE_FILES = 2000;

export function resolveMaxFiles(requested?: number): number {
  if (typeof requested !== "number" || !Number.isFinite(requested) || requested <= 0) {
    return DEFAULT_MAX_TREE_FILES;
  }
  return Math.min(Math.floor(requested), HARD_MAX_TREE_FILES);
}

/** Default cap on cumulative decoded bytes across a batch — sized generously above a single
 *  file's default decode bound (1 MiB) for a batch of manifests across many components. */
export const DEFAULT_MAX_TREE_TOTAL_BYTES = 8 * 1_048_576;

export const HARD_MAX_TREE_TOTAL_BYTES = 32 * 1_048_576;

export function resolveMaxTotalBytes(requested?: number): number {
  if (typeof requested !== "number" || !Number.isFinite(requested) || requested <= 0) {
    return DEFAULT_MAX_TREE_TOTAL_BYTES;
  }
  return Math.min(Math.floor(requested), HARD_MAX_TREE_TOTAL_BYTES);
}

/** Default cap on raw tree entries enumerated while listing/matching — generous for an ordinary
 *  monorepo, finite against a pathological one. */
export const DEFAULT_MAX_TREE_ENTRIES_SCANNED = 20_000;

export const HARD_MAX_TREE_ENTRIES_SCANNED = 200_000;

export function resolveMaxEntriesScanned(requested?: number): number {
  if (typeof requested !== "number" || !Number.isFinite(requested) || requested <= 0) {
    return DEFAULT_MAX_TREE_ENTRIES_SCANNED;
  }
  return Math.min(Math.floor(requested), HARD_MAX_TREE_ENTRIES_SCANNED);
}

/** Transport ceiling for a TREE-LISTING call. See docs/plugins.md §124. */
export const DEFAULT_TREE_RESPONSE_MAX_BYTES = 32 * 1_048_576;

// Glob matching, starting from the server's own grammar. See docs/plugins.md §125.

export function globMatchesPath(pattern: string, path: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  let regexSource = escaped.replace(/\*\*|\*/g, (match) => (match === "**" ? ".*" : "[^/]*"));
  // A leading `**/` means zero or more leading segments. See docs/plugins.md §126.
  if (regexSource.startsWith(".*/")) {
    regexSource = `(?:.*/)?${regexSource.slice(3)}`;
  }
  return new RegExp(`^${regexSource}$`).test(path);
}

export function matchesAnyGlob(globs: string[], path: string): boolean {
  return globs.some((glob) => globMatchesPath(glob, path));
}

/** Refuses an empty `globs` array BEFORE any HTTP happens — the same "refuse a caller bug loudly"
 *  discipline `assertSafeRepoPath`/`assertSafeRef` apply to `readFileAtRef`'s inputs. An empty
 *  list would otherwise silently read zero files, which looks exactly like "no manifests here"
 *  (a routine, expected outcome) rather than the caller mistake it actually is. */
export function assertNonEmptyGlobs(provider: string, globs: string[]): void {
  if (globs.length === 0) {
    throw new Error(`${provider} readFilesAtRef: globs must be a non-empty array`);
  }
}

// GitProviderTreeBoundError — the typed, loud failure axes 2-4 produce.

export type TreeReadBound = "maxFiles" | "maxTotalBytes" | "maxEntriesScanned";

export interface GitProviderTreeBoundError extends Error {
  treeBoundExceeded: TreeReadBound;
  limit: number;
  provider: string;
}

export function isGitProviderTreeBoundError(err: unknown): err is GitProviderTreeBoundError {
  return (
    typeof err === "object" &&
    err !== null &&
    typeof (err as { treeBoundExceeded?: unknown }).treeBoundExceeded === "string"
  );
}

export function gitProviderTreeBoundError(
  provider: string,
  bound: TreeReadBound,
  limit: number,
  detail: string
): GitProviderTreeBoundError {
  return Object.assign(
    new Error(`${provider} readFilesAtRef: exceeded ${bound} (${limit}) — ${detail}`),
    { treeBoundExceeded: bound, limit, provider }
  );
}

// Scan accumulator — axes 2 and 4, enforced DURING listing. See docs/plugins.md §127.

/** One raw tree entry, in the shape every provider's listing reduces to. Only `type: "blob"`
 *  (a file) is ever matched against a glob; `"tree"` (directory), `"commit"` (submodule) and any
 *  other provider-specific type still count toward `maxEntriesScanned` but are never matched. */
export interface RawTreeEntry {
  path: string;
  type: "blob" | "tree" | "commit" | string;
}

export interface TreeScanAccumulator {
  /** Matched paths so far, in scan order. Mutated in place by `addPage`. */
  readonly matched: string[];
  /** Feed one page of raw entries. Throws a {@link GitProviderTreeBoundError} the instant
   *  `maxEntriesScanned` or `maxFiles` is exceeded. */
  addPage(entries: readonly RawTreeEntry[]): void;
}

export function createTreeScanAccumulator(
  provider: string,
  globs: string[],
  maxFiles: number,
  maxEntriesScanned: number
): TreeScanAccumulator {
  const matched: string[] = [];
  let scanned = 0;
  return {
    matched,
    addPage(entries) {
      for (const entry of entries) {
        scanned += 1;
        if (scanned > maxEntriesScanned) {
          throw gitProviderTreeBoundError(
            provider,
            "maxEntriesScanned",
            maxEntriesScanned,
            `scanned more than ${maxEntriesScanned} tree entries without finishing the listing — ` +
              `the tree is larger than this call is willing to enumerate`
          );
        }
        if (entry.type !== "blob") continue;
        if (!matchesAnyGlob(globs, entry.path)) continue;
        matched.push(entry.path);
        if (matched.length > maxFiles) {
          throw gitProviderTreeBoundError(
            provider,
            "maxFiles",
            maxFiles,
            `matched more than ${maxFiles} files for globs [${globs.map((g) => `'${g}'`).join(", ")}]`
          );
        }
      }
    }
  };
}

// -------------------------------------------------------------------------------------------
// Read accumulator — axis 3, enforced DURING the read loop (as each matched file finishes
// decoding), not pre-computed from declared sizes.
// -------------------------------------------------------------------------------------------

export interface TreeReadAccumulator {
  /** Records one file's decoded size (call only for a `found` result — a `refused`/`not_found`
   *  entry contributed no decoded bytes). Throws once the cumulative total exceeds the bound. */
  addFileBytes(sizeBytes: number): void;
}

export function createTreeReadAccumulator(
  provider: string,
  maxTotalBytes: number
): TreeReadAccumulator {
  let total = 0;
  return {
    addFileBytes(sizeBytes) {
      total += sizeBytes;
      if (total > maxTotalBytes) {
        throw gitProviderTreeBoundError(
          provider,
          "maxTotalBytes",
          maxTotalBytes,
          `cumulative decoded bytes across matched files reached ${total}, over the ${maxTotalBytes}-byte batch bound`
        );
      }
    }
  };
}
