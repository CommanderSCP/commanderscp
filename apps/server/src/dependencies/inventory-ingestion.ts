import {
  ManifestParseError,
  parseDockerfile,
  parseGoMod,
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
  type IngestionStampManifest,
  type IngestionStampOutcome,
  type IngestionStampSource
} from "./ingestion-stamp-repo.js";
import { resolveComponentIngestionGate } from "./subscription-resolution.js";
import type { ManifestReader } from "./internal-release-version.js";

/**
 * M21.2 — DEPENDENCY-INVENTORY INGESTION: the thing that JOINS the parsers to the tables
 * (ADR-0032 §3, §4, §6).
 *
 * ============================================================================================
 * WHAT WAS MISSING, MEASURED
 * ============================================================================================
 * M21.2 built five manifest parsers, a `readFileAtRef` hook and two projection tables, and M21.3–5
 * built an enablement chain, a detection pass and a dispatcher on top of them. Nothing read a
 * component's manifests and wrote `component_dependencies`: `upsertComponentDependency` and
 * `pruneComponentDependencies` had NO non-test caller anywhere in the tree. On a real deployment
 * the table was therefore empty forever, and everything above it was inert —
 * `listSubscribedComponentLines` derives its work-list FROM that table, so it returned nothing
 * unconditionally, before any policy was consulted; the third-party poll had an empty work-list;
 * and M21.4's internal detection could not find a producing component's manifest path, so
 * `npm`/`python`/`maven` internal releases recorded `no_manifest_path_known` too.
 *
 * This is the FIFTH component in M21 built and never installed. So the property that matters here
 * is not that the function exists but that something CALLS it: the production caller is
 * `inventory-ingestion-loop.ts` (a router on the domain-event stream plus this capability's own
 * queue), the operator caller is `POST /api/v1/dependencies/inventory/backfill`, and both are
 * pinned by tests that drive the real path rather than this function directly.
 *
 * ============================================================================================
 * THE GATE IS THE FIRST ACT, AND IT IS THE MERGE — NOT A FILTER
 * ============================================================================================
 * ADR-0032 §6: "a disabled component is never fetched". That is a property of THIS function, not of
 * its callers: {@link ingestComponentManifests} resolves
 * `resolveComponentIngestionGate` before it looks at a repo, a ref or a reader, and returns without
 * having called the reader once when the gate is closed. A caller cannot opt out of it, and there
 * is no flag that skips it. `dependency-inventory-ingestion.integration.test.ts` proves it with a
 * RECORDING fake reader — zero recorded reads — rather than with a mock assertion.
 *
 * The gate is the chain's first TWO conjuncts (`instance_unlocked AND component_enabled`); the
 * third (`NOT dependency_opted_out`) subtracts individual lines downstream, where the poll and the
 * bump read them. See `subscription-resolution.ts`'s {@link ComponentIngestionGate} for why an
 * opt-out must not remove a row from the INVENTORY: this function prunes each manifest down to the
 * lines it just read, so an opt-out that suppressed the write would DELETE the record that the
 * component declares that dependency at all.
 *
 * ============================================================================================
 * UNREADABLE IS NOT EMPTY. THIS IS THE WHOLE REASON THE PARSERS THROW.
 * ============================================================================================
 * `@scp/dependency-manifests`' contract is explicit: "'this component declares zero dependencies'
 * and 'I could not read this file' produce identical inventory rows and mean opposite things, and
 * letting the second collapse into the first DELETES the component's whole inventory on the next
 * ingestion pass". A deleted inventory is not a cosmetic loss — `listSubscribedComponentLines`
 * derives subscription from those rows, so a component whose inventory is emptied is silently
 * UNSUBSCRIBED from everything.
 *
 * So this module has exactly one rule about pruning, and it is stated as a rule rather than left to
 * fall out of the control flow:
 *
 *   **A manifest path is pruned ONLY when this run has POSITIVE evidence about its content, IN THE
 *   REPOSITORY THAT EVIDENCE CAME FROM** — either it was read and parsed (prune to what it
 *   declares), or the provider said the PATH is not there (prune to nothing; the file was deleted).
 *   Every other outcome — a throw from the reader, a missing REF, an indeterminate not-found, a
 *   size/type/encoding refusal, a Git-LFS pointer, an incomplete body, an unparseable body — leaves
 *   that path's existing rows exactly as they are and is reported as its own named reason.
 *
 * THE SECOND CLAUSE IS NOT DECORATION, and it is the one that was missing. A pass reads ONE
 * repository. A component fed by two (`source_mappings` is many-per-component, and the webhook
 * correlator matches on `repo_pattern`) used to have every one of its known manifest paths probed
 * in whichever repo the release came from; the `not_found: "path"` that came back for the OTHER
 * repo's paths is the branch that prunes, so a release from repo B emptied repo A's inventory —
 * every time, silently. Both halves of the fix are structural rather than a call-site check:
 * `component_dependencies.observed_repo` records where each row was observed and
 * `pruneComponentDependencies` cannot delete outside it (drizzle/0063), and
 * {@link repoManifestScope} derives the candidate paths from the mappings that name THIS repo, so
 * the other repo's paths are not probed in the first place.
 *
 * `not_found` is split deliberately (`missing: "path" | "ref" | "unknown"`). Only `path` is
 * evidence about the manifest. A missing `ref` is evidence about the REF — a force-pushed branch, a
 * commit garbage-collected out of the repo — and treating it as "the file is gone" would empty the
 * inventory of every component in a repo whose ref moved. `unknown` is GitLab, which answers both
 * questions in one call and distinguishes them only in prose (`read-file.ts` refuses to infer a
 * label from that prose, and so does this).
 *
 * ============================================================================================
 * IDEMPOTENT: RE-INGESTING AN UNCHANGED MANIFEST CHANGES NOTHING
 * ============================================================================================
 * The two hops that deliver this job are at-least-once, and a component is re-ingested on every
 * accepted change, so a pass over unchanged manifests must write nothing new:
 *
 *  - `upsertDependencyLine` and `upsertComponentDependency` are upserts on natural keys; the second
 *    deliberately keeps `created_at` out of its update set, so a re-observation preserves when the
 *    declaration was first seen;
 *  - the prune keeps exactly the lines just read, so an unchanged manifest deletes zero rows;
 *  - the Decision goes through `insertDecisionIfChanged`, and NOTHING IT CARRIES MOVES WHEN ONLY
 *    THE COMMIT DOES. That is deliberate and slightly counter-intuitive: including the commit would
 *    make every push write a new Decision saying the same thing about the same dependencies, which
 *    is precisely the shape that measured 1.44 GB/day in production (ADR-0024). WHEN each
 *    declaration was observed, and AT WHICH REF, is on the row itself
 *    (`component_dependencies.observed_ref` / `observed_at`) — the Decision answers "what does this
 *    component declare, and what could not be read", which does not change when only the commit
 *    does.
 *
 *    That claim is a PROPERTY OF EVERY FIELD, not of the two obvious ones, and it was false in
 *    three places until each was removed: a skip `detail` interpolated the ref (so a component
 *    whose commit never resolved wrote a fresh Decision per accepted change), a manifest's `pruned`
 *    count describes the PREVIOUS state rather than this observation, and the gate `witness` is one
 *    line the merge happened to be satisfied on. Each is named at its own removal site below; the
 *    rule is that a Decision field must be a function of what the component DECLARES.
 *
 * ============================================================================================
 * AND THE PASS LEAVES A STAMP — BECAUSE AN EMPTY INVENTORY HAS THREE MEANINGS (M21.7, 0065)
 * ============================================================================================
 * Everything above describes what a pass WRITES when it finds something. What it finds is often
 * nothing, and `component_dependencies.observed_at` is per ROW — so a component with no rows
 * carries no timestamp anywhere and "never ingested", "ingested fine and genuinely declares
 * nothing" and "ran, and every manifest was unreadable" are the same absence. This function already
 * computed which one; it now also PERSISTS it, one upserted row per component in
 * `dependency_ingestion_stamps` ({@link projectIngestionStamp} does the mapping).
 *
 * THIS FUNCTION IS WHERE THE STAMP IS WRITTEN, AND THAT IS THE DESIGN, not a convenience. It is the
 * choke point both producers already go through — the event-driven loop and the operator backfill —
 * so "did this producer remember to stamp?" is not a question that can be asked of either. A third
 * producer inherits it, and must name itself through the required `source` input.
 *
 * IT IS WRITTEN ON THE REFUSED PATHS TOO, where no Decision is written, because those are precisely
 * the components whose empty inventory needs explaining. The one path that does NOT stamp is
 * `superseded`, for a reason stated at that branch.
 */

/** The Decision `kind` this module writes — one row per component per distinct inventory outcome. */
export const DEPENDENCY_INVENTORY_DECISION_KIND = "dependency_inventory_ingestion";

/**
 * The dependency-manifest filenames this ingestion knows how to read, and the parser for each.
 *
 * The map is keyed on the file's BASENAME because that is what the ecosystems standardise: a
 * `go.mod` is a `go.mod` wherever it sits. The ECOSYSTEM is deliberately NOT read from this map —
 * every parser stamps `DeclaredDependency.ecosystem` itself, and `pyproject.toml` legitimately
 * emits `python` entries from three different blocks. Reading the ecosystem off the filename would
 * be a label named after which branch matched (charter principle 6).
 *
 * `Cargo.toml` is absent even though `discovery`'s component-marker list carries it: Rust is not
 * one of ADR-0032 §10's five ecosystems and there is no parser for it. A sixth ecosystem adds a
 * parser and one line here.
 */
export const MANIFEST_PARSERS: ReadonlyMap<
  string,
  (content: string) => readonly DeclaredDependency[]
> = new Map([
  ["go.mod", (c: string) => parseGoMod(c)],
  ["Dockerfile", (c: string) => parseDockerfile(c)],
  ["package.json", (c: string) => parsePackageJson(c)],
  ["pyproject.toml", (c: string) => parsePyprojectToml(c)],
  ["requirements.txt", (c: string) => parseRequirementsTxt(c)],
  ["pom.xml", (c: string) => parsePomXml(c)]
]);

/** The basename of a repo-relative path, without importing `node:path` semantics (a repo path is
 *  always `/`-separated regardless of the server's platform — `path.basename` on Windows would also
 *  split on `\`, which is a legal character in a git path). */
export function manifestBasename(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut === -1 ? path : path.slice(cut + 1);
}

/**
 * Is this body a Git-LFS pointer rather than the manifest itself?
 *
 * Necessary because a pointer is VALID TEXT and reads back as a successful file read, so nothing
 * upstream can catch it — and one of the five parsers, `parseRequirementsTxt`, never throws. Handed
 * a pointer it would return the pointer's own lines as "declared dependencies" and this run would
 * then PRUNE the manifest's real declarations away in favour of them. The other four throw
 * `ManifestParseError`, which is already handled, but a rule that holds for four of five parsers is
 * not a rule.
 *
 * The test is the pointer format's own required first line (`git-lfs/lfs-pointer-file-spec`): the
 * `version` key is mandatory and must come first, and the URL is part of the specification rather
 * than of any one server's implementation.
 */
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

/**
 * WHAT THIS COMPONENT OWNS **IN ONE REPOSITORY** — the scope of an ingestion pass, and therefore the
 * scope of everything it may prune.
 *
 * ============================================================================================
 * WHY THIS IS PER-REPOSITORY, AND WHY THAT IS THE WHOLE POINT
 * ============================================================================================
 * A pass reads exactly ONE repository. Two defects followed from deriving its candidate paths
 * without that fact:
 *
 *  - THE REPO ROOT WAS EVERY ENABLED COMPONENT'S OWN. The prefix set was seeded with `""`
 *    unconditionally, so two components sharing a monorepo each ingested the root `package.json` as
 *    their own declarations — even when `source_mappings.path_pattern` scoped them to different
 *    subdirectories. The root is now a prefix only when a mapping FOR THIS REPO actually yields it.
 *  - A PASS PRUNED ANOTHER REPOSITORY'S PATHS. Prefixes were derived from every mapping the
 *    component has, in every repository, so a release from repo B probed repo A's manifest paths in
 *    repo B, got `not_found`, and deleted repo A's inventory (see `pruneComponentDependencies` and
 *    drizzle/0063 for the other half of that fix).
 *
 * ============================================================================================
 * WHY THIS IS A PROBE AND NOT A LOOKUP — measured, not assumed
 * ============================================================================================
 * Nothing in the tree records where a component's manifests are. `source_mappings.path_pattern` is
 * NULLABLE and, where discovery writes one, it is a directory GLOB (`services/api/**`,
 * `packages/plugins/github/src/index.ts`). A glob is a CONTAINMENT PREDICATE: it can answer "is
 * `services/api/go.mod` mine?" and cannot enumerate it — `glob-match.ts` is used as a boolean and
 * nothing in the tree expands one. The plugin host exposes no directory listing either: the only
 * file verb is `readFileAtRef`, which takes ONE path and refuses a directory with `not_a_file`.
 * (Discovery's walk DOES see the marker filenames and throws them away at the `hasMarker` boolean;
 * widening it to report them is the honest long-term fix and is a change to three adapters plus the
 * `DiscoveryProposal` shape, so it is not made here.)
 *
 * So the candidate set is GENERATED from prefixes and then FILTERED back through the mapping's own
 * predicate ({@link scopeClaims}) — generation guesses, the predicate decides. `read-file.ts`
 * explicitly sanctions the probing half: "'this component has no `go.mod`' is the expected response
 * for four of the five ecosystems on any given component, so it must not throw".
 *
 * ============================================================================================
 * A WILDCARD-FREE PATTERN IS AMBIGUOUS, AND THE AMBIGUITY IS RESOLVED BY THE CLOSED SET
 * ============================================================================================
 * `services/api/go.mod` and `services/api` are both legal wildcard-free `path_pattern`s and mean
 * different things — one names a file, one names a directory. Treating every wildcard-free pattern
 * as a FILE (stripping its last segment) meant a directory-shaped pattern never probed the
 * component's own directory at all. Nothing in the data distinguishes them in general, so the one
 * closed set that IS knowable decides: a pattern whose last segment is one of the six dependency
 * manifest filenames names that manifest; anything else is read BOTH ways — as a file (its parent
 * directory is the prefix) and as a directory (the pattern itself is the prefix). The claim
 * predicate then discards whichever reading generated paths the mapping does not cover.
 */
export interface RepoManifestScope {
  /** The repository this scope was derived FOR. */
  readonly repo: string;
  /** Does ANY of the component's `source_mappings` name this repository? False means this pass has
   *  no declared business in this repo — nothing is probed and nothing is pruned. */
  readonly mapped: boolean;
  /** Directory prefixes to generate candidates under, sorted. */
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

/**
 * Is this path one the component's mappings FOR THIS REPOSITORY actually cover?
 *
 * The generator above is allowed to over-produce; this is what makes over-production harmless. Each
 * pattern is applied in the two readings a `path_pattern` genuinely has — as a glob over file paths
 * (what `correlation.ts` does with it) and, when it is wildcard-free, as a directory prefix.
 */
export function scopeClaims(scope: RepoManifestScope, path: string): boolean {
  for (const pattern of scope.patterns) {
    if (pattern === null) return true;
    if (globMatch(pattern, path)) return true;
    if (!hasGlobMeta(pattern) && path.startsWith(`${pattern}/`)) return true;
  }
  return false;
}

/**
 * The repository a component's `source_mappings` name, when they name exactly one LITERALLY.
 *
 * The event-driven path never needs this — `changes.source_ref.repo` says which repo the release
 * came from — but the BACKFILL has no change to read, so it must derive the repo from declared
 * config or refuse. Both refusals are returned as `null` and reported by the caller, never guessed:
 *
 *  - a pattern containing a GLOB metacharacter is a matching rule, not an address. `acme/*` names
 *    no single repo and picking one would be reading a predicate as a value.
 *  - two different literal repos on one component is a real shape (a component fed by two sources),
 *    and there is no basis for choosing between them, so the backfill reports it instead.
 */
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

/**
 * How many provider reads ONE component's ingestion may make. A bound is required because the
 * candidate set is a cross product (prefixes x six filenames) and `source_mappings` is
 * operator-authored — a component with twenty mappings would otherwise dial a user's git provider
 * 126 times per accepted change.
 *
 * Truncation is REPORTED (`read_budget_exhausted`) rather than silent: a component whose manifests
 * were not all looked at must not be indistinguishable from one that declares nothing.
 */
export const MAX_MANIFEST_READS = 40;

/**
 * The paths this run will ask for, in a stable order.
 *
 * KNOWN PATHS COME FIRST, and that ordering is load-bearing rather than tidy. A path already in
 * `component_dependencies` is one this component demonstrably had a manifest at — including at a
 * non-standard location a probe would never guess, and including one that has since been DELETED,
 * which is only prunable if it is asked for. Spending the read budget on probes before re-reading
 * what is known would let a large probe set silently freeze the real inventory.
 */
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

/** One declaration inside a manifest that WAS read, which cannot be placed on a line. */
export interface SkippedDeclaration {
  readonly path: string;
  readonly ecosystem: DependencyEcosystem;
  readonly coordinate: string;
  readonly reason: "no_comparable_version";
  readonly detail: string;
}

/** One dependency manifest this run read, parsed and wrote. */
export interface IngestedManifest {
  readonly path: string;
  /** How many declarations became `component_dependencies` rows. */
  readonly declared: number;
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
  /**
   * WHICH PRODUCER IS RUNNING THIS PASS, recorded on the per-component ingestion stamp.
   *
   * REQUIRED, and deliberately not derived. The two producers differ in exactly one other input
   * (the backfill passes `actorObjectId`, the loop does not), so `source` could be inferred from
   * that — which is precisely the provenance-label mistake this repo has already shipped: a label
   * named after which branch matched goes false the moment the branch covers a second case
   * (ADR-0030 §2, charter principle 6). A third producer must name itself, and until it does it
   * does not compile.
   */
  readonly source: IngestionStampSource;
}

/** What one pass established, projected onto the stamp's columns (migration 0065). */
export interface IngestionStampProjection {
  readonly outcome: IngestionStampOutcome;
  readonly rowsWritten: number;
  readonly manifests: readonly IngestionStampManifest[];
}

/**
 * IS THIS SKIP A FILE SCP CANNOT READ AT ALL, OR ONE IT FAILED TO READ THIS TIME?
 *
 * The split is by OPERATOR ACTION, which is the only test that keeps a reason honest (ADR-0032 §7b
 * clause 6). `unsupported` means re-running changes nothing — the bytes are there and SCP
 * structurally does not decode them; `unreadable` means this attempt failed and the next may not.
 *
 * `manifest_unparseable` is the one reason covering BOTH causes, because it is pushed by two
 * branches: a genuinely malformed body (fix the file) and "no parser is registered for this
 * filename in this build" (nothing to fix). They are told apart STRUCTURALLY — by asking
 * {@link MANIFEST_PARSERS} the same question the skipping branch asked — never by matching on the
 * skip's prose, which would be a label named after a sentence.
 */
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

/**
 * Project a completed pass onto the stamp — pure, so the mapping is testable without a database and
 * the write door below has nothing to decide.
 *
 * `ok` / `partial` / `unreadable` is decided by COUNTING EVIDENCE, not by the verdict:
 *
 *  - a manifest in `manifests` is one this pass has POSITIVE evidence about — read and parsed, or
 *    found gone and pruned to nothing. Both are answers.
 *  - a manifest in `skipped` is one it does not.
 *
 * So no skips at all is `ok`; some of each is `partial` (the mixed case the per-path array exists
 * for); and only skips is `unreadable`. NEITHER, which is a component whose every probe came back
 * "not there" with nothing previously known, is `ok` WITH `rowsWritten: 0` — "we looked, and it
 * genuinely declares nothing". That is the state the whole stamp exists to make expressible, and it
 * is why the empty case falls to `ok` rather than to `unreadable`.
 */
export function projectIngestionStamp(input: {
  readonly manifests: readonly IngestedManifest[];
  readonly skipped: readonly SkippedManifest[];
}): IngestionStampProjection {
  const entries: IngestionStampManifest[] = [
    ...input.manifests.map((manifest) => ({
      path: manifest.path,
      outcome: "ok" as const,
      ...(manifest.removed
        ? {
            detail:
              "the manifest is no longer in the repository at this ref, so its declarations were removed"
          }
        : {})
    })),
    ...input.skipped.map((skip) => ({
      path: skip.path,
      outcome: manifestStampOutcome(skip.path, skip.reason),
      // The ingestion's own sentence, verbatim. It is the actionable half — WHICH file and WHY —
      // and it is the reason the array is per path at all.
      detail: skip.detail
    }))
  ].sort((a, b) => (`${a.path}${a.outcome}` < `${b.path}${b.outcome}` ? -1 : 1));

  const outcome: IngestionStampOutcome =
    input.skipped.length === 0 ? "ok" : input.manifests.length > 0 ? "partial" : "unreadable";

  return {
    outcome,
    // What was WRITTEN, never what was pruned: this describes the observation, and a prune count is
    // a statement about the previous state.
    rowsWritten: input.manifests.reduce((sum, manifest) => sum + manifest.declared, 0),
    manifests: entries
  };
}

/**
 * Ingest ONE component's dependency manifests at ONE ref.
 *
 * THREE PHASES, AND THE MIDDLE ONE HOLDS NO DATABASE CONNECTION — the same arrangement
 * `internal-release-detection.ts` uses and for the same measured reason: phase 2 reaches a user's
 * git provider through the plugin host, and holding an RLS-scoped pooled connection across that
 * round trip pins a connection per in-flight component against a 5s production `statement_timeout`
 * and a bounded pool (ADR-0032 §7c clause 2, which is normative about exactly this).
 *
 *   phase 1 (tx)    — the enablement gate, the known manifest paths, the probe prefixes.
 *   phase 2 (NO tx) — read and parse each candidate. No writes, no database.
 *   phase 3 (tx)    — upsert lines and declarations, prune per manifest path, persist ONE Decision.
 *
 * The phases are separate transactions, so a crash between them leaves a partial pass — which costs
 * nothing, because every write is an idempotent restatement of an observation and the next accepted
 * change (or a backfill) re-derives the same answer.
 */
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

  // -----------------------------------------------------------------------------------------
  // PHASE 1 — the gate FIRST, then what to ask for.
  //
  // EVERY REFUSAL IS STAMPED IN THIS SAME TRANSACTION, beside the gate resolution that decided it.
  // Not in a transaction of its own afterwards: a refusal is the common case on any real estate (an
  // org-wide backfill refuses for every unsubscribed component), so a second round trip per refused
  // component would double the transaction count of the whole pass to say "nothing happened".
  // -----------------------------------------------------------------------------------------
  const prepared = await withTenantTx(db, orgId, async (tx) => {
    const gate = await resolveComponentIngestionGate(tx, {
      orgId,
      componentObjectId: input.componentObjectId,
      actorObjectId: input.actorObjectId ?? SYSTEM_ACTOR_ID
    });
    /** A refusal, its stamp written before it is returned. The stamp is the ONLY record of these
     *  paths: no Decision is written for them (see below), so without it a refused component is
     *  indistinguishable from one nothing has ever looked at. */
    const refuse = async (
      verdict: "not_enabled" | "not_addressable",
      outcome: IngestionStampOutcome,
      detail: string
    ): Promise<{ proceed: false; verdict: "not_enabled" | "not_addressable"; detail: string }> => {
      await recordIngestionStamp(tx, orgId, {
        componentObjectId: input.componentObjectId,
        lastAttemptAt: attemptAt,
        source: input.source,
        outcome,
        detail,
        // NOTHING WAS FETCHED on any of these paths, so nothing was written. `0` here is a fact
        // about this pass, and the `outcome` beside it is what stops it reading as "declares
        // nothing" — which is the whole distinction this table exists to carry.
        rowsWritten: 0,
        manifests: []
      });
      return { proceed: false as const, verdict, detail };
    };

    if (!gate.enabled) {
      // NOT FETCHED, and no Decision: a component that is simply not subscribed is the
      // overwhelmingly common case on any estate, and a Decision per accepted change per component
      // saying "still not enabled" is write amplification with nothing to learn from row 2 onward
      // (the same reasoning `internal-release-detection.ts` applies to `no_declared_producer`).
      // The STAMP is the exception to that argument rather than a contradiction of it: it is ONE
      // UPSERTED ROW per component, so restating it costs a dead tuple instead of an appended row,
      // and it is the only thing that can tell an operator this component's empty inventory is
      // explained by enablement rather than by a manifest nobody could read.
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

    // KNOWN PATHS FROM THIS REPOSITORY ONLY. A row observed in another repo is not evidence about
    // where this repo's manifests are, and probing it here is how a pass acquired `not_found`
    // "evidence" it then pruned the other repository's inventory with. A row with NO recorded
    // repository (written before drizzle/0063) is included so a re-observation stamps it and it
    // heals; until then it is unprunable by construction.
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

  // -----------------------------------------------------------------------------------------
  // PHASE 2 — NO TRANSACTION IS OPEN HERE.
  // -----------------------------------------------------------------------------------------
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
  /**
   * WHEN THIS PASS LOOKED — captured before the first read, and the ONLY thing that orders two
   * overlapping passes over the same component.
   *
   * `observed_ref` cannot do it, and that is worth stating rather than leaving as an omission: it
   * holds a COMMIT SHA, two shas carry no order between them, and deciding which is the descendant
   * needs a git-history walk this system does not do (the plugin seam has exactly one file verb,
   * `readFileAtRef`, and ADR-0032 §9 keeps it that way). What the ref DOES do is name what was
   * read; what the read TIME does is say which of two readings is the later evidence. So the row
   * carries both, this compares the second, and the honest residue is named on the guard in phase 3.
   */
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

  // -----------------------------------------------------------------------------------------
  // PHASE 3 — the writes.
  // -----------------------------------------------------------------------------------------
  return withTenantTx(db, orgId, async (tx) => {
    // ONE PASS AT A TIME PER COMPONENT. The guard below is a read-then-decide, so without this two
    // overlapping passes would both read "nothing newer" and both apply. The lock is transaction-
    // scoped and released at commit — the same discipline `audit-repo.ts` uses to keep a
    // hash-chained append serial.
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${orgId}), hashtext(${input.componentObjectId}))`
    );

    /**
     * THE ORDERING GUARD — an OLDER pass must not land after a newer one.
     *
     * Nothing orders two ingestion passes for the same component: both hops are at-least-once, the
     * queue is a competing consumer, and a retry of an earlier accept can be delivered after a
     * later one. Applied out of order, the older pass prunes each manifest down to what the OLDER
     * commit declared and deletes the declarations the newer commit added — the same silent
     * unsubscription this whole module exists to prevent, arriving by a race instead of a bug.
     *
     * WHAT IS COMPARED, AND WHY IT IS NOT THE REF. `observed_ref` holds a commit sha; two shas have
     * no order between them, and deciding which is the descendant needs a history walk that does
     * not exist behind this seam (`readFileAtRef` is the only file verb, ADR-0032 §9). What IS
     * orderable is WHEN each pass read the manifests, so that is what the row records
     * (`observed_at` is stamped from phase 2, not from this write) and what this compares.
     *
     * THE RESIDUE, STATED: this orders passes by when they LOOKED, not by commit ancestry. Two
     * passes whose reads and whose commits are ordered oppositely — a job for a newer commit that
     * read first — still land in the wrong order. Closing that needs ancestry, which this system
     * deliberately cannot ask for; the next accepted change or a backfill re-derives the truth.
     */
    const priorRows = await listComponentDependencies(tx, orgId, input.componentObjectId);
    let newestObservedAt = 0;
    for (const row of priorRows) {
      if (row.observedRepo !== prepared.repo) continue;
      newestObservedAt = Math.max(newestObservedAt, Date.parse(row.observedAt));
    }
    if (newestObservedAt > readAt.getTime()) {
      // NOTHING IS WRITTEN — not the rows, not the prune, not a Decision AND NOT A STAMP.
      //
      // The stamp is deliberately in that list. It describes WHAT THE INVENTORY IS, and this pass
      // established nothing about that: its manifests are stale evidence that was not applied. A
      // stamp here would restate `rowsWritten` from a pass whose rows are not in the table, over
      // the winning pass's own stamp. (`recordIngestionStamp`'s `setWhere` would refuse it anyway,
      // because the winner read later — but relying on that would make the honest answer an
      // accident of two guards agreeing rather than a decision made here.)
      //
      // "Never attempted is the absence of a row" survives this: being superseded REQUIRES a newer
      // pass to have written rows for the same component, and that pass stamped.
      // A Decision here would
      // alternate with the ordinary one for the same component and re-open the persist-on-change
      // guard (`insertDecisionIfChanged` compares against the LATEST row, so alternating verdicts
      // append forever); and there is nothing to explain that the winning pass's Decision does not
      // already say.
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
          declarationsSkipped.push({
            path: manifest.path,
            ecosystem: declaration.ecosystem,
            coordinate: declaration.coordinate,
            reason: "no_comparable_version",
            detail:
              `'${declaration.declared ?? "(no version declared)"}' has no comparable numeric core, ` +
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
      if (pruned > 0) manifests.push({ path, declared: 0, pruned, removed: true });
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
        // PATH AND REASON, NEVER THE DETAIL. A detail carries provider prose, an error message and
        // (before this) the ref itself — all of which vary per commit, so a component whose ref
        // never resolves wrote a fresh Decision per accepted change while its own doc claimed the
        // inputs carry no commit. The REASON is the stable, explanatory half; the detail stays on
        // the returned outcome, where the operator and the log read it.
        skipped: sortedSkipped.map((s) => ({ path: s.path, reason: s.reason })),
        declarationsSkipped: sortedDeclarationSkips.map((d) => ({
          path: d.path,
          ecosystem: d.ecosystem,
          coordinate: d.coordinate,
          reason: d.reason
        }))
      }
    });

    // ============================================================================================
    // THE STAMP, IN THE SAME TRANSACTION AS THE ROWS IT DESCRIBES
    // ============================================================================================
    // Atomicity is the point of writing it here rather than after the transaction commits: a stamp
    // saying `ok / 0 rows` that survived while the declarations it counted rolled back would be a
    // receipt for writes that never landed — a lie with a timestamp on it, which is worse than the
    // silence this table replaces.
    //
    // `readAt`, not `now()`: the stamp records WHEN THIS PASS LOOKED, on the same clock the rows'
    // `observed_at` carries, so the stamp and the inventory cannot disagree about which pass is the
    // later evidence.
    const stamp = projectIngestionStamp({ manifests: sortedManifests, skipped: sortedSkipped });
    await recordIngestionStamp(tx, orgId, {
      componentObjectId: input.componentObjectId,
      lastAttemptAt: readAt,
      source: input.source,
      outcome: stamp.outcome,
      rowsWritten: stamp.rowsWritten,
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

/**
 * Upsert the LINE a declaration belongs to and the declaration itself; return the line id, or
 * `null` when the declaration names no comparable version.
 *
 * THE LINE IS THE MAJOR, and that is a decision worth stating. `dependency_lines` is keyed on
 * `(ecosystem, coordinate, major)` and the subscription's `granularity` (`patch` vs
 * `minor_and_patch`) is what decides how far a subscriber MOVES within its line — so putting the
 * minor in the line identity would make `alpine:3.18` and `alpine:3.19` two unrelated lines and
 * leave `minor_and_patch` with nothing to express. `major` is therefore
 * `String(version.major)`; `line-head.ts`'s `isOnLine` reads the line's own precision, so a
 * finer-grained major written by an operator still behaves exactly as ADR-0032 §7a describes.
 *
 * `tagPattern` is the LITERAL VARIANT SUFFIX and `oci` only (ADR-0032 §7b clause 2) — `-alpine` off
 * a `3.18-alpine` tag. It is taken from the parsed version's `suffix`, which `version.ts` extracts
 * verbatim and WITHOUT interpretation, and the write door normalises it to NULL for the four
 * language ecosystems, so a language line can never acquire one from here.
 *
 * NOTHING HERE CAN DECLARE A PRODUCER. `upsertDependencyLine` cannot reach `produced_by_object_id`
 * at all (that is a separate verb, `declareDependencyLineProducer`), which is what makes
 * "declared, never inferred" a property of the API rather than of this call site remembering to
 * leave a field unset (ADR-0032 §7, ADR-0030 §2).
 */
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
