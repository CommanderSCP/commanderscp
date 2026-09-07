import {
  ManifestParseError,
  parseDockerfile,
  parseGoMod,
  parseKubernetesImages,
  parsePackageJson,
  parsePomXml,
  parsePyprojectToml,
  parseRequirementsTxt,
  type DeclaredDependency
} from "@scp/dependency-manifests";
import type { DependencyEcosystem } from "@scp/schemas";
import type { ReadFileRefusalReason } from "@scp/git-provider-core";
import { sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { withTenantTx, type TenantTx } from "../db/tenant-tx.js";
import { globMatch } from "../coordination/glob-match.js";
import { insertDecisionIfChanged } from "../coordination/decisions-repo.js";
import { SYSTEM_ACTOR_ID } from "../coordination/system-actor.js";
import { listSourceMappingsForComponents } from "../coordination/source-mappings-repo.js";
import {
  listComponentDependencies,
  pruneComponentDependencies,
  upsertComponentDependency,
  upsertDependencyLine
} from "./dependency-inventory-repo.js";
import {
  recordIngestionStamp,
  type IngestionStampObservation,
  type IngestionStampOutcome,
  type IngestionStampSource
} from "./ingestion-stamp-repo.js";
import { resolveComponentIngestionGate } from "./subscription-resolution.js";
import type { ManifestReader } from "./internal-release-version.js";

/** M21.2 — DEPENDENCY-INVENTORY INGESTION. See docs/dependencies.md §294. */

/** The Decision `kind` this module writes — one row per component per distinct inventory outcome. */
export const DEPENDENCY_INVENTORY_DECISION_KIND = "dependency_inventory_ingestion";

/** The manifest filenames this reads, and their parsers. See docs/dependencies.md §295. */
export const MANIFEST_PARSERS: ReadonlyMap<
  string,
  (content: string) => readonly DeclaredDependency[]
> = new Map([
  ["go.mod", (c: string) => parseGoMod(c)],
  ["Dockerfile", (c: string) => parseDockerfile(c)],
  ["package.json", (c: string) => parsePackageJson(c)],
  ["pyproject.toml", (c: string) => parsePyprojectToml(c)],
  ["requirements.txt", (c: string) => parseRequirementsTxt(c)],
  ["pom.xml", (c: string) => parsePomXml(c)],
  ["values.yaml", (c: string) => parseKubernetesImages(c)]
]);

/** The basename of a repo-relative path, without importing `node:path` semantics (a repo path is
 *  always `/`-separated regardless of the server's platform — `path.basename` on Windows would also
 *  split on `\`, which is a legal character in a git path). */
export function manifestBasename(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut === -1 ? path : path.slice(cut + 1);
}

/** Is this body an LFS pointer rather than the manifest. See docs/dependencies.md §296. */
export function isGitLfsPointer(content: string): boolean {
  return /^version https:\/\/git-lfs\.github\.com\/spec\/v1\r?\n/.test(content);
}

/** The two `source_mappings` columns this derivation reads. Taken as a structural type so the pure
 *  functions below are testable without a database row. */
export interface ManifestSourceMapping {
  readonly repoPattern: string | null;
  readonly pathPattern: string | null;
}

/** Does this pattern contain any glob metacharacter at all? A pattern that does not is a literal
 *  address; one that does is a predicate. */
function hasGlobMeta(pattern: string): boolean {
  return /[*?[\]{}]/.test(pattern);
}

/** WHAT THIS COMPONENT OWNS **IN ONE REPOSITORY**. See docs/dependencies.md §297. */
export interface RepoManifestScope {
  readonly repo: string;
  /** Does ANY of the component's `source_mappings` name this repository? False means this pass has
   *  no declared business in this repo — nothing is probed and nothing is pruned. */
  readonly mapped: boolean;
  readonly prefixes: readonly string[];
  /** The path patterns of the mappings that name this repository. `null` is a mapping that
   *  constrains no path, i.e. the whole repository. */
  readonly patterns: readonly (string | null)[];
}

export function repoManifestScope(
  mappings: readonly ManifestSourceMapping[],
  repo: string
): RepoManifestScope {
  // Matched exactly as `correlation.ts` matches a delivery to a mapping — an empty/absent
  // `repo_pattern` constrains nothing, otherwise the glob decides. Spelling it differently here
  // would let a component be correlated into a repo it is then not ingested from.
  const mine = mappings.filter(
    (m) =>
      m.repoPattern === null || m.repoPattern.trim() === "" || globMatch(m.repoPattern, repo.trim())
  );

  const prefixes = new Set<string>();
  const patterns: (string | null)[] = [];
  for (const mapping of mine) {
    const pattern =
      mapping.pathPattern === null || mapping.pathPattern.trim() === ""
        ? null
        : mapping.pathPattern;
    patterns.push(pattern);
    if (pattern === null) {
      // The mapping constrains no path, so the whole repository is this component's — including its
      // root. This is the ONLY way the root becomes a prefix.
      prefixes.add("");
      continue;
    }
    const segments = pattern.split("/");
    const literal: string[] = [];
    for (const segment of segments) {
      if (segment === "" || hasGlobMeta(segment)) break;
      literal.push(segment);
    }
    if (literal.length < segments.length) {
      // A wildcard appeared: the literal head IS the directory, and nothing past the wildcard can
      // be enumerated. `services/*/api/**` therefore yields `services`, whose generated candidates
      // the claim predicate then rejects — honestly reading nothing rather than probing paths the
      // mapping does not cover.
      prefixes.add(literal.join("/"));
      continue;
    }
    const last = literal[literal.length - 1] ?? "";
    prefixes.add(literal.slice(0, -1).join("/"));
    if (!MANIFEST_PARSERS.has(last)) prefixes.add(literal.join("/"));
  }

  return { repo, mapped: mine.length > 0, prefixes: [...prefixes].sort(), patterns };
}

/** Is this path one the component's mappings cover. See docs/dependencies.md §298. */
export function scopeClaims(scope: RepoManifestScope, path: string): boolean {
  for (const pattern of scope.patterns) {
    if (pattern === null) return true;
    if (globMatch(pattern, path)) return true;
    if (!hasGlobMeta(pattern) && path.startsWith(`${pattern}/`)) return true;
  }
  return false;
}

/** The repository the mappings name, when exactly one. See docs/dependencies.md §299. */
export function literalRepoFor(repoPatterns: readonly (string | null)[]): string | null {
  const literals = new Set<string>();
  for (const pattern of repoPatterns) {
    if (pattern === null) continue;
    const trimmed = pattern.trim();
    if (trimmed === "" || /[*?[\]{}]/.test(trimmed)) continue;
    literals.add(trimmed);
  }
  return literals.size === 1 ? [...literals][0]! : null;
}

/** How many provider reads ONE component's ingestion may make. See docs/dependencies.md §300. */
export const MAX_MANIFEST_READS = 42;

/** The paths this run will ask for, in a stable order. See docs/dependencies.md §301. */
export function candidateManifestPaths(input: {
  knownPaths: readonly string[];
  scope: RepoManifestScope;
}): { paths: string[]; unread: string[] } {
  const ordered: string[] = [];
  const seen = new Set<string>();
  const push = (path: string): void => {
    if (path === "" || seen.has(path)) return;
    // THE MAPPING DECIDES, not the generator. A known path outside what this repository's mappings
    // cover is not probed — and therefore not pruned, which is the point: a path this pass has no
    // business reading is a path it has no evidence about.
    if (!scopeClaims(input.scope, path)) return;
    seen.add(path);
    ordered.push(path);
  };
  for (const known of [...input.knownPaths].sort()) push(known);
  for (const prefix of input.scope.prefixes) {
    for (const filename of MANIFEST_PARSERS.keys()) {
      push(prefix === "" ? filename : `${prefix}/${filename}`);
    }
  }
  return {
    paths: ordered.slice(0, MAX_MANIFEST_READS),
    // THE UNREAD PATHS BY NAME, not a count. A count says "this component is over budget" and
    // leaves an operator with no way to learn WHICH manifests are frozen, which is the only
    // actionable half — the rows for those paths keep their old contents indefinitely.
    unread: ordered.slice(MAX_MANIFEST_READS)
  };
}

/** Why one dependency manifest contributed nothing to this run. EVERY member is a distinct CAUSE
 *  with a distinct operator action — a reason named after the branch that matched goes false the
 *  moment that branch covers a second case (ADR-0032 §7b clause 6, charter principle 6). */
export type ManifestSkipReason =
  /** The reader threw: no git-provider binding names this repo, an auth failure, a 5xx, an egress
   *  refusal. The message is carried in `detail`. */
  | "read_failed"
  /** The provider resolved the repo but not the REF — a force-push, a garbage-collected commit.
   *  Evidence about the ref, NEVER about the manifest, so nothing is pruned. */
  | "ref_not_found"
  /** `not_found` that the provider could not attribute to the path or the ref (GitLab answers both
   *  in one call). Indeterminate, so nothing is pruned. */
  | "read_indeterminate"
  /** The file exists and was deliberately not decoded — `read-file.ts`'s own four refusals, carried
   *  through by name so "there is a 40 MB package.json here" stays distinguishable from "there is no
   *  package.json here". */
  | ReadFileRefusalReason
  /** The body is a Git-LFS pointer, not the manifest. */
  | "lfs_pointer"
  /** The body is not this format at all — a 404 HTML page, a truncated response, a genuinely
   *  malformed file. `ManifestParseError`, caught per manifest. */
  | "manifest_unparseable"
  /** The read budget ran out before this path was asked for. The path is named, so an operator can
   *  see WHICH manifests are frozen rather than only that some are. */
  | "read_budget_exhausted";

export interface SkippedManifest {
  readonly path: string;
  readonly reason: ManifestSkipReason;
  readonly detail: string;
}

/** A declaration read but impossible to place on a line. See docs/dependencies.md §302. */
export interface SkippedDeclaration {
  readonly path: string;
  readonly ecosystem: DependencyEcosystem;
  readonly coordinate: string;
  readonly reason: "no_comparable_version" | "unresolved_declaration";
  readonly detail: string;
}

/** One dependency manifest this run read, parsed and wrote. */
export interface IngestedManifest {
  readonly path: string;
  readonly declared: number;
  /** How many declarations could not be resolved from it. See docs/dependencies.md §303. */
  readonly unresolved: number;
  /** Rows removed because this manifest no longer declares them. A PER-RUN count, not a statement
   *  about the component — which is why it is deliberately absent from the Decision (see the
   *  Decision's own note): it depends on the previous state, so an unchanged component would write
   *  a new Decision on the one run that happened to delete something and another on the next. */
  readonly pruned: number;
  /** `true` when the manifest was found to be GONE (`not_found`, attributable to the path) and its
   *  rows were therefore pruned to nothing. */
  readonly removed: boolean;
}

export type ComponentIngestionVerdict =
  /** The enablement gate is closed. NOTHING WAS FETCHED and no Decision was written. */
  | "not_enabled"
  /** Enabled, but this run has no repository to read: none was named, or none of the component's
   *  `source_mappings` names the one that was. Nothing was fetched. */
  | "not_addressable"
  /** The manifests were read, and then a NEWER observation of the same (component, repository) was
   *  found already recorded. NOTHING WAS WRITTEN and no Decision exists — applying this pass would
   *  have pruned away declarations a later commit added. */
  | "superseded"
  /** Manifests were read. A Decision exists. */
  | "ingested";

export interface ComponentIngestionOutcome {
  readonly componentObjectId: string;
  readonly verdict: ComponentIngestionVerdict;
  readonly detail: string;
  readonly manifests: readonly IngestedManifest[];
  readonly skipped: readonly SkippedManifest[];
  readonly declarationsSkipped: readonly SkippedDeclaration[];
  /** Provider reads ACTUALLY attempted. Zero on every refused verdict — the number a test asserts
   *  against a recording fake. */
  readonly reads: number;
  readonly decision?: { readonly id: string; readonly created: boolean };
}

export interface IngestComponentManifestsInput {
  readonly componentObjectId: string;
  /** The repo to read, as the provider spells it. Empty/absent ⇒ `not_addressable`; this module
   *  never picks a repo for a component. */
  readonly repo: string | undefined;
  /** The ref to read AT — a commit sha where one is known, since a branch name is not an identity
   *  (`read-file.ts`). */
  readonly ref: string;
  readonly readManifest: ManifestReader;
  /** Whose enablement is resolved. Defaults to the system sentinel (the event-driven path); the
   *  operator backfill passes the requesting principal, which is the ONLY way a `group`-scoped
   *  enable could ever contribute (ADR-0032 §6a). */
  readonly actorObjectId?: string;
  /** Which producer is running this pass, on the stamp. See docs/dependencies.md §304. */
  readonly source: IngestionStampSource;
}

/** What one pass established, projected onto the stamp's shape (migration 0065). */
export interface IngestionStampProjection {
  readonly outcome: IngestionStampOutcome;
  /** This pass's own row count, not the stamp's. See docs/dependencies.md §305. */
  readonly rowsWritten: number;
  readonly manifests: readonly IngestionStampObservation[];
}

/** Is this a file we cannot read, or failed to read now. See docs/dependencies.md §306. */
export function manifestStampOutcome(
  path: string,
  reason: ManifestSkipReason
): "unreadable" | "unsupported" {
  switch (reason) {
    // The bytes exist and SCP will not decode them. Deterministic in this build.
    case "lfs_pointer":
    case "too_large":
    case "not_a_file":
    case "not_text":
    case "unsupported_encoding":
      return "unsupported";
    case "manifest_unparseable":
      return MANIFEST_PARSERS.has(manifestBasename(path)) ? "unreadable" : "unsupported";
    // A read or a parse that failed THIS TIME: a provider error, a ref that no longer resolves, an
    // indeterminate not-found, a cut response, a path the budget never reached. Every one of them
    // can succeed on the next pass, and each already carries its own named reason on the outcome.
    case "read_failed":
    case "ref_not_found":
    case "read_indeterminate":
    case "incomplete_body":
    case "read_budget_exhausted":
      return "unreadable";
  }
}

/** Project a completed pass onto the stamp. See docs/dependencies.md §307. */
export function projectIngestionStamp(input: {
  readonly manifests: readonly IngestedManifest[];
  readonly skipped: readonly SkippedManifest[];
}): IngestionStampProjection {
  const entries: IngestionStampObservation[] = [
    ...input.manifests.map((manifest) => {
      // READ, DECLARED SOMETHING, AND WROTE NOTHING BECAUSE NOTHING IN IT COULD BE RESOLVED.
      // Structural: it asks the counts, not the reasons' prose.
      const allUnresolved = manifest.declared === 0 && manifest.unresolved > 0;
      return {
        path: manifest.path,
        outcome: allUnresolved ? ("unsupported" as const) : ("ok" as const),
        // WHAT WAS WRITTEN, never what was pruned: this describes the observation, and a prune count
        // is a statement about the previous state. Per entry, because the row's total is the sum
        // across every repository's slice and only the write door can see all of them.
        rows: manifest.declared,
        ...(allUnresolved
          ? {
              detail:
                `this manifest was read and parsed, and all ${manifest.unresolved} of the ` +
                `declaration(s) in it name a version SCP cannot resolve from the file itself ` +
                `(an interpolated or templated value, a value behind an alias, or a version with ` +
                `no dependency named beside it) — it declares dependencies, and none of them ` +
                `could be recorded`
            }
          : manifest.removed
            ? {
                detail:
                  "the manifest is no longer in the repository at this ref, so its declarations were removed"
              }
            : {})
      };
    }),
    ...input.skipped.map((skip) => ({
      path: skip.path,
      outcome: manifestStampOutcome(skip.path, skip.reason),
      // NOT READ, so nothing was written for it. Its EXISTING rows are deliberately not counted
      // here: they are last-known-good from an earlier pass and counting them would let a failed
      // read report the inventory as freshly confirmed.
      rows: 0,
      // The ingestion's own sentence, verbatim. It is the actionable half — WHICH file and WHY —
      // and it is the reason the array is per path at all.
      detail: skip.detail
    }))
  ].sort((a, b) => (`${a.path}${a.outcome}` < `${b.path}${b.outcome}` ? -1 : 1));

  // Computed from the entries, not the manifest split. See docs/dependencies.md §308.
  const readEntries = entries.filter((entry) => entry.outcome === "ok").length;
  const outcome: IngestionStampOutcome =
    entries.length === 0
      ? "ok"
      : readEntries === entries.length
        ? "ok"
        : readEntries === 0
          ? "unreadable"
          : "partial";

  return {
    outcome,
    rowsWritten: entries.reduce((sum, entry) => sum + entry.rows, 0),
    manifests: entries
  };
}

/** Ingest ONE component's dependency manifests at ONE ref. See docs/dependencies.md §309. */
export async function ingestComponentManifests(
  db: Db,
  orgId: string,
  input: IngestComponentManifestsInput
): Promise<ComponentIngestionOutcome> {
  const repo = input.repo?.trim();
  /** WHEN THIS PASS STARTED — the stamp's `last_attempt_at` on the paths that refuse before a
   *  provider is reached, where there is no read time to use instead. The paths that DO read stamp
   *  `readAt` (phase 2), so the stamp always carries the moment this pass actually looked. */
  const attemptAt = new Date();

  // PHASE 1 — the gate FIRST, then what to ask for. See docs/dependencies.md §310.
  const prepared = await withTenantTx(db, orgId, async (tx) => {
    const gate = await resolveComponentIngestionGate(tx, {
      orgId,
      componentObjectId: input.componentObjectId,
      actorObjectId: input.actorObjectId ?? SYSTEM_ACTOR_ID
    });
    /** A refusal, its stamp written before it is returned. See docs/dependencies.md §311. */
    const refuse = async (
      verdict: "not_enabled" | "not_addressable",
      outcome: IngestionStampOutcome,
      detail: string
    ): Promise<{ proceed: false; verdict: "not_enabled" | "not_addressable"; detail: string }> => {
      await recordIngestionStamp(tx, orgId, {
        componentObjectId: input.componentObjectId,
        lastAttemptAt: attemptAt,
        source: input.source,
        repo: null,
        outcome,
        detail,
        // NOTHING WAS FETCHED on any of these paths, so this pass names no manifest. What the row
        // ends up reporting is decided by the merge: this verdict where nothing else is known,
        // and the standing per-repository evidence where there is some.
        manifests: []
      });
      return { proceed: false as const, verdict, detail };
    };

    if (!gate.enabled) {
      // NOT FETCHED, and no Decision. See docs/dependencies.md §312.
      return refuse(
        "not_enabled",
        "not_enabled",
        `dependency subscriptions are not enabled for this component (${gate.reason}) — no manifest was fetched`
      );
    }

    if (repo === undefined || repo === "") {
      // ENABLED BUT UNADDRESSABLE — the repo half of the refusal, which cannot be reached before
      // the gate because "a disabled component is never fetched" is about the gate running FIRST.
      // Stamped `unreadable`: there was no address to read a manifest at, which is a statement
      // about this pass's reach and never about what the component declares.
      return refuse(
        "not_addressable",
        "unreadable",
        "no repo was named for this component, so there is no repository to read its dependency " +
          "manifests from — nothing was fetched"
      );
    }

    // KNOWN PATHS FROM THIS REPOSITORY ONLY. See docs/dependencies.md §313.
    const known = [
      ...new Set(
        (await listComponentDependencies(tx, orgId, input.componentObjectId))
          .filter((row) => row.observedRepo === repo || row.observedRepo === null)
          .map((row) => row.manifestPath)
      )
    ];
    const mappings = await listSourceMappingsForComponents(tx, orgId, [input.componentObjectId]);
    const scope = repoManifestScope(mappings, repo);

    if (!scope.mapped) {
      // NO MAPPING NAMES THIS REPOSITORY, so this component has no declared presence in it. Reading
      // it would produce `not_found` at every candidate — which is exactly the "evidence" that used
      // to prune another repository's rows away. Refused instead, with nothing fetched.
      return refuse(
        "not_addressable",
        "unreadable",
        `none of this component's source_mappings names the repository '${repo}', so this run has ` +
          `no declared manifest location in it — nothing was fetched and nothing was pruned`
      );
    }

    // `repo` travels in the result so everything downstream has it as a `string` rather than
    // re-deriving the narrowing from `proceed`.
    return { gate, proceed: true as const, known, scope, repo };
  });

  if (!prepared.proceed) {
    return {
      componentObjectId: input.componentObjectId,
      verdict: prepared.verdict,
      detail: prepared.detail,
      manifests: [],
      skipped: [],
      declarationsSkipped: [],
      reads: 0
    };
  }

  const { paths, unread } = candidateManifestPaths({
    knownPaths: prepared.known,
    scope: prepared.scope
  });

  // PHASE 2 — NO TRANSACTION IS OPEN HERE.
  interface ReadManifest {
    readonly path: string;
    readonly declarations: readonly DeclaredDependency[];
    /** The commit `ref` resolved to, which is what a row records — a branch name is not an
     *  identity (`read-file.ts`'s `commitSha`). */
    readonly observedRef: string;
  }
  const parsed: ReadManifest[] = [];
  /** Paths the provider says are NOT THERE. The only non-parse evidence that permits a prune. */
  const absent: string[] = [];
  const skipped: SkippedManifest[] = [];
  let reads = 0;
  /** WHEN THIS PASS LOOKED. See docs/dependencies.md §314. */
  const readAt = new Date();

  for (const path of paths) {
    reads += 1;
    let result;
    try {
      result = await input.readManifest({ repo: prepared.repo, path, ref: input.ref });
    } catch (err) {
      skipped.push({
        path,
        reason: "read_failed",
        detail: `${err instanceof Error ? err.message : String(err)} — existing rows for this manifest are left untouched, because a failed read is not evidence that the manifest declares nothing`
      });
      continue;
    }

    if (result.outcome === "not_found") {
      if (result.missing === "path") {
        // POSITIVE EVIDENCE ABOUT THE MANIFEST: it is not in the repo at this ref. If it has rows,
        // phase 3 prunes them; if it never had any, this is the routine answer to a probe and is
        // recorded as neither a skip nor a manifest.
        absent.push(path);
        continue;
      }
      skipped.push({
        path,
        reason: result.missing === "ref" ? "ref_not_found" : "read_indeterminate",
        detail:
          result.missing === "ref"
            ? `the ref does not resolve in ${prepared.repo}${result.detail ? ` (${result.detail})` : ""} — that is evidence about the REF, never about this manifest, so its rows are left untouched`
            : `the provider reported not-found without attributing it to the path or the ref${result.detail ? ` (${result.detail})` : ""} — indeterminate, so this manifest's rows are left untouched`
      });
      continue;
    }

    if (result.outcome === "refused") {
      skipped.push({
        path,
        reason: result.reason,
        detail: `${result.detail} — the file IS there and was not decoded, so its rows are left untouched`
      });
      continue;
    }

    if (isGitLfsPointer(result.content)) {
      skipped.push({
        path,
        reason: "lfs_pointer",
        detail:
          "the body is a Git-LFS pointer, not the dependency manifest — SCP does not resolve LFS " +
          "objects, so this manifest's rows are left untouched rather than replaced by the " +
          "pointer's own lines"
      });
      continue;
    }

    const parser = MANIFEST_PARSERS.get(manifestBasename(path));
    if (parser === undefined) {
      // Unreachable for a probed path (the candidates come from the same map) but reachable for a
      // KNOWN path written by an earlier version with a wider map. Reported, never pruned.
      skipped.push({
        path,
        reason: "manifest_unparseable",
        detail: `no parser is registered for '${manifestBasename(path)}' in this build`
      });
      continue;
    }

    try {
      parsed.push({
        path,
        declarations: parser(result.content),
        observedRef: result.commitSha
      });
    } catch (err) {
      if (!(err instanceof ManifestParseError)) throw err;
      // THE CASE THE PARSERS THROW FOR. A 404 HTML body, a truncated response and a genuinely
      // malformed file all arrive here as strings, and every one of them must leave the existing
      // inventory ALONE — writing an empty set would unsubscribe the component silently.
      skipped.push({
        path,
        reason: "manifest_unparseable",
        detail: `${err.message} — this manifest's existing rows are left untouched; unreadable is not empty`
      });
    }
  }

  for (const path of unread) {
    // BY NAME. A component over the budget has permanently stale rows at these exact paths, and
    // "42 candidates were not read" leaves an operator with nothing to act on — they cannot tell
    // which manifests are frozen, so they cannot narrow the component's `source_mappings` to bring
    // them back inside the budget. The path IS the actionable half.
    skipped.push({
      path,
      reason: "read_budget_exhausted",
      detail: `this component has more candidate manifest paths than the per-run budget of ${MAX_MANIFEST_READS}; this path was not read and its rows are left untouched`
    });
  }

  return withTenantTx(db, orgId, async (tx) => {
    // ONE PASS AT A TIME PER COMPONENT. The guard below is a read-then-decide, so without this two
    // overlapping passes would both read "nothing newer" and both apply. The lock is transaction-
    // scoped and released at commit — the same discipline `audit-repo.ts` uses to keep a
    // hash-chained append serial.
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${orgId}), hashtext(${input.componentObjectId}))`
    );

    /** THE ORDERING GUARD. See docs/dependencies.md §315. */
    const priorRows = await listComponentDependencies(tx, orgId, input.componentObjectId);
    let newestObservedAt = 0;
    for (const row of priorRows) {
      if (row.observedRepo !== prepared.repo) continue;
      newestObservedAt = Math.max(newestObservedAt, Date.parse(row.observedAt));
    }
    if (newestObservedAt > readAt.getTime()) {
      // NOTHING IS WRITTEN. See docs/dependencies.md §316.
      return {
        componentObjectId: input.componentObjectId,
        verdict: "superseded" as const,
        detail:
          `a newer observation of this component in '${prepared.repo}' is already recorded, so this ` +
          `pass's manifests are stale evidence — nothing was written and nothing was pruned`,
        manifests: [],
        skipped: [],
        declarationsSkipped: [],
        reads
      };
    }

    const manifests: IngestedManifest[] = [];
    const declarationsSkipped: SkippedDeclaration[] = [];

    for (const manifest of parsed) {
      const keepLineIds: string[] = [];
      /** Declarations THIS manifest made that could not be resolved from it — see the stamp. */
      let unresolvedHere = 0;
      for (const declaration of manifest.declarations) {
        const placed = await placeDeclarationOnLine(tx, orgId, {
          componentObjectId: input.componentObjectId,
          manifestPath: manifest.path,
          observedRepo: prepared.repo,
          observedRef: manifest.observedRef,
          observedAt: readAt,
          declaration
        });
        if (placed === null) {
          // WHICH OF THE TWO, DECIDED STRUCTURALLY. `constraint` is set by the parser that read the
          // file — never by matching this module against the note's prose, which would be a reason
          // named after a sentence (see `SkippedDeclaration`).
          const unresolved = declaration.constraint === "unresolved";
          if (unresolved) unresolvedHere += 1;
          declarationsSkipped.push({
            path: manifest.path,
            ecosystem: declaration.ecosystem,
            coordinate: declaration.coordinate,
            reason: unresolved ? "unresolved_declaration" : "no_comparable_version",
            detail: unresolved
              ? `this manifest declares a dependency SCP cannot resolve from the file itself` +
                `${declaration.note === undefined ? "" : ` (${declaration.note})`} — it is reported ` +
                `rather than guessed at, because a wrong version here becomes a wrong bump ` +
                `(ADR-0032 §7)`
              : `'${declaration.declared ?? "(no version declared)"}' has no comparable numeric core, ` +
                `so there is no major line to record this declaration against (ADR-0032 §7: skipped ` +
                `rather than guessed)`
          });
          continue;
        }
        keepLineIds.push(placed);
      }
      // PER (REPOSITORY, MANIFEST PATH) — never org-wide, never per component, and never across
      // repositories. A `go.mod` re-read must not delete what this component's `Dockerfile`
      // declared, and a pass over repo B must not delete what repo A declared: the prune scope is
      // exactly the evidence this pass holds, which is one path in one repo.
      const pruned = await pruneComponentDependencies(tx, orgId, {
        componentObjectId: input.componentObjectId,
        observedRepo: prepared.repo,
        manifestPath: manifest.path,
        keepLineIds
      });
      manifests.push({
        path: manifest.path,
        declared: keepLineIds.length,
        unresolved: unresolvedHere,
        pruned,
        removed: false
      });
    }

    for (const path of absent) {
      const pruned = await pruneComponentDependencies(tx, orgId, {
        componentObjectId: input.componentObjectId,
        observedRepo: prepared.repo,
        manifestPath: path,
        keepLineIds: []
      });
      // A probe that found nothing where nothing was known is not an event. Only a manifest that
      // actually HAD rows and no longer exists is reported.
      // `unresolved: 0` — a manifest that is GONE declared nothing this pass could fail to read.
      if (pruned > 0) manifests.push({ path, declared: 0, unresolved: 0, pruned, removed: true });
    }

    const sortedManifests = [...manifests].sort((a, b) => (a.path < b.path ? -1 : 1));
    const sortedSkipped = [...skipped].sort((a, b) =>
      `${a.path}${a.reason}` < `${b.path}${b.reason}` ? -1 : 1
    );
    const sortedDeclarationSkips = [...declarationsSkipped].sort((a, b) =>
      `${a.path}${a.coordinate}` < `${b.path}${b.coordinate}` ? -1 : 1
    );

    const decision = await insertDecisionIfChanged(tx, {
      orgId,
      kind: DEPENDENCY_INVENTORY_DECISION_KIND,
      subjectId: input.componentObjectId,
      // This path observes; it blocks nothing. `allow` is the neutral verdict of the existing
      // vocabulary and what happened is in the reason tree.
      verdict: "allow",
      // NO REF, NO COMMIT, NO TIMESTAMP — see the module doc. These inputs describe WHAT the
      // component declares, which is what a second identical pass must compare equal on.
      inputContext: {
        componentObjectId: input.componentObjectId,
        // The repository IS an input: the same component read in two repositories genuinely
        // declares two different things, and collapsing them would make each pass restate the
        // other's verdict as changed. It is stable across commits, unlike a ref.
        repo: prepared.repo,
        manifestPathsRead: parsed.map((m) => m.path).sort(),
        manifestPathsAbsent: [...absent].sort()
      },
      reasonTree: {
        rule: "ADR-0032 §4 dependency inventory — a component's DIRECT declared dependencies, read from its own manifests at a known ref. A manifest that could not be read is skipped, never treated as declaring nothing",
        gate: {
          reason: prepared.gate.reason,
          contributions: prepared.gate.contributions
          // THE WITNESS IS DELIBERATELY NOT HERE. It is one line the gate's merge happened to be
          // satisfied on, and `mergeComponentIngestionGate` now picks it in a canonical order — but
          // it is still a value that moves when a policy is added, removed or re-worded anywhere in
          // the chain, for a component whose declared dependencies did not change. Every such move
          // would append a Decision, which is the persist-on-change shape that measured 1.44 GB/day
          // (ADR-0024). `contributions` already answers "which level decided this", stably and in a
          // sorted order, so nothing explanatory is lost.
        },
        // `declared` per manifest, but NOT `pruned`/`removed`: those are counts about the PREVIOUS
        // state, so an unchanged component would write one Decision on the run that deleted a row
        // and another on the next run that did not. `manifestPathsAbsent` above already records a
        // manifest that went away, as a property of the observation rather than of the delete.
        manifests: sortedManifests.map((m) => ({ path: m.path, declared: m.declared })),
        // PATH AND REASON, NEVER THE DETAIL. See docs/dependencies.md §317.
        skipped: sortedSkipped.map((s) => ({ path: s.path, reason: s.reason })),
        declarationsSkipped: sortedDeclarationSkips.map((d) => ({
          path: d.path,
          ecosystem: d.ecosystem,
          coordinate: d.coordinate,
          reason: d.reason
        }))
      }
    });

    // The stamp, in the same transaction as the rows. See docs/dependencies.md §318.
    const stamp = projectIngestionStamp({ manifests: sortedManifests, skipped: sortedSkipped });
    await recordIngestionStamp(tx, orgId, {
      componentObjectId: input.componentObjectId,
      lastAttemptAt: readAt,
      source: input.source,
      // THE REPOSITORY THIS PASS SPEAKS FOR. Its entries replace that repository's slice and no
      // other: a component fed by `acme/widgets` and `acme/charts` gets one slice each, so a
      // successful charts pass can no longer erase a failed widgets read — which it did, silently,
      // turning "manifests unreadable" back into "declares nothing" on the next release.
      repo: prepared.repo,
      outcome: stamp.outcome,
      manifests: stamp.manifests
      // No `detail`: on this path every explanation is per PATH and lives in `manifests`. The
      // column exists for the refusals that have no path to hang one on.
    });

    return {
      componentObjectId: input.componentObjectId,
      verdict: "ingested" as const,
      detail:
        `${sortedManifests.length} dependency manifest(s) ingested, ` +
        `${sortedSkipped.length} not read, ` +
        `${sortedDeclarationSkips.length} declaration(s) not placed on a line`,
      manifests: sortedManifests,
      skipped: sortedSkipped,
      declarationsSkipped: sortedDeclarationSkips,
      reads,
      decision: { id: decision.decision.id, created: decision.created }
    };
  });
}

/** Upsert the line and the declaration; return the line. See docs/dependencies.md §319. */
async function placeDeclarationOnLine(
  tx: TenantTx,
  orgId: string,
  input: {
    componentObjectId: string;
    manifestPath: string;
    /** The repository the manifest was read from — the half of the address that makes the row's
     *  eventual prune attributable to evidence from the same place. */
    observedRepo: string;
    observedRef: string;
    /** When the manifest was READ (phase 2), not when this row is written. */
    observedAt: Date;
    declaration: DeclaredDependency;
  }
): Promise<string | null> {
  const { declaration } = input;
  // `undefined` is a first-class, expected outcome (`DeclaredDependency.version`): `FROM alpine`,
  // a bare `requests`, an npm `workspace:*`, a Maven `${revision}`. A declaration with no
  // comparable version belongs to no major line, and inventing one would be the guess ADR-0032 §7
  // forbids. It is reported, never written.
  if (declaration.version === undefined) return null;

  const line = await upsertDependencyLine(tx, orgId, {
    ecosystem: declaration.ecosystem,
    coordinate: declaration.coordinate,
    major: String(declaration.version.major),
    ...(declaration.ecosystem === "oci" && declaration.version.suffix !== undefined
      ? { tagPattern: declaration.version.suffix }
      : {})
  });

  await upsertComponentDependency(tx, orgId, {
    componentObjectId: input.componentObjectId,
    lineId: line.id,
    manifestPath: input.manifestPath,
    // VERBATIM — this is the exact string the M21.5 actuator edits, so a normalised copy would be
    // an edit target that does not appear in the file. `unpinned` declarations carry no text at all
    // and are unreachable here (they have no comparable version), so the fallback is the parsed
    // version's own raw text rather than an invented one.
    declaredVersion: declaration.declared ?? declaration.version.raw,
    // "The manifest does not pin one" — never "we did not look". Only a `pinned` constraint names
    // exactly one version; a range's floor is not what will be installed.
    resolvedVersion: declaration.constraint === "pinned" ? declaration.version.raw : null,
    resolvedDigest: declaration.digest ?? null,
    observedRepo: input.observedRepo,
    observedRef: input.observedRef,
    observedAt: input.observedAt
  });
  return line.id;
}
