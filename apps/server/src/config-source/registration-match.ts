import { globMatch } from "../coordination/glob-match.js";

/**
 * Config-source registration matching (team-pipeline-iac proposal §4, D9; ADR-0046 §1).
 *
 * A config source names either ONE repo or a namespace/pattern covering a team's whole fleet
 * (`git.corp.example/payments/*` -> `team-payments`), plus a per-stack `stackName -> team`
 * ownership map — the team whose identity a matched stack's plan/apply runs as (D9, corrected
 * 2026-08-27: the acting subject is the `team` object itself, never a service account).
 *
 * Two things must be a LOUD REFUSAL rather than a silent pick, per D9's own text: "a repo that
 * appears in two patterns, or a stack name already owned elsewhere, is a loud refusal at sync,
 * never last-writer-wins." This module is the pure decision behind both — no I/O, no persistence,
 * a plain array of registrations and a plain repo/stack identity in, one typed, exhaustive result
 * out.
 *
 * PURE LOGIC ONLY (increment 4): this module never reads a config-source registration from
 * Postgres. The DB-backed registry (create/list/persist a `ConfigSourceRegistration`) is a later
 * increment's job, once the API-surface slot frees; this is the decision that registry will call.
 *
 * REPO IDENTITY: reuses the exact rule `apps/server/src/dependencies/manifest-reader.ts` already
 * established for matching a repo against a git-provider binding — trimmed, slashes stripped,
 * case-folded, and EXACT for a single-repo registration ("never a prefix, never the org's first
 * binding"). Duplicated here (not imported) because `manifest-reader.ts` also pulls in `Db`/
 * `PluginHost`/`withTenantTx` for its DB-backed half, and this module must stay free of anything
 * requiring a database — the same reasoning `read-tree.ts` gives for duplicating
 * `coordination/glob-match.ts`'s grammar rather than importing across a package boundary. The RULE
 * is reused verbatim; only the machinery around it differs.
 *
 * PATTERN IDENTITY: a `repoPattern` registration matches using `coordination/glob-match.ts`'s
 * existing grammar (`*` within a segment, `**` across `/`) — chosen deliberately over
 * `read-tree.ts`'s corrected matcher (see `manifest-path-selection.ts` for that one and why it
 * diverges): every `repoPattern` this proposal's own examples give (`git.corp.example/payments/*`)
 * is a SUFFIX wildcard, the same shape `source_mappings.repoPattern` already uses everywhere in
 * this codebase, so `glob-match.ts`'s leading-`**\/`-vs-zero-segments gap never arises here. See
 * `manifest-path-selection.ts`'s module doc for the full report on that gap and why THAT module
 * cannot inherit it.
 */

/** One config-source registration. Exactly one of `repo` / `repoPattern` identifies what it
 *  covers — the caller (the DB-backed layer, a later increment) is responsible for enforcing that
 *  shape; this module treats "neither set" defensively as "matches nothing" rather than throwing,
 *  because a registration that matches nothing is a legible (if useless) state, not a caller bug
 *  this function is positioned to catch. */
export interface ConfigSourceRegistration {
  id: string;
  repo?: string;
  repoPattern?: string;
  /** The team every matched repo's stack applies as by default (D9: "each matched repo's stack
   *  applies as that team"). */
  team: string;
  /** Explicit per-stack overrides/claims within this registration — the top-of-§4 "stackName ->
   *  team" shape. A stack name claimed here by TWO DIFFERENT registrations (this one's map and
   *  another registration's) is the D9 stack-ownership hazard `resolveConfigSourceForSync` below
   *  refuses loudly rather than picking either. */
  stackTeams?: Readonly<Record<string, string>>;
}

/** Trimmed, stripped of surrounding slashes, case-folded — the SAME comparison-only normalization
 *  `manifest-reader.ts`'s `normalizeRepoIdentity` applies, so a repo spelled `Payments/API` in one
 *  place and `payments/api` in another is one identity here exactly as it is there. */
export function normalizeConfigSourceRepoIdentity(repo: string): string {
  return repo
    .trim()
    .replace(/^\/+|\/+$/g, "")
    .toLowerCase();
}

function registrationMatchesRepo(
  registration: ConfigSourceRegistration,
  normalizedRepoIdentity: string
): boolean {
  if (registration.repo !== undefined) {
    return normalizeConfigSourceRepoIdentity(registration.repo) === normalizedRepoIdentity;
  }
  if (registration.repoPattern !== undefined) {
    return globMatch(registration.repoPattern.trim().toLowerCase(), normalizedRepoIdentity);
  }
  return false;
}

/** Deterministic order for a refusal's named list — sorted by id, the same discipline
 *  `manifest-reader.ts`'s `startInstanceForRepo` uses for its own multi-candidate case, so two
 *  runs of the same ambiguous state report identically rather than in whatever order the caller's
 *  array happened to be in. */
function sortById<T extends { id: string }>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * The result of resolving ONE (repo, stackName) sync attempt against every registration in force.
 *
 * "No match" (`no_match`) is an ordinary outcome — most repos are not registered at all. The two
 * refusal kinds are distinguishable from it AND from each other by `outcome`, never collapsed into
 * a boolean or a thrown error a caller has to inspect a message to classify.
 */
export type RegistrationSyncResult =
  | { outcome: "no_match" }
  | { outcome: "matched"; registration: ConfigSourceRegistration; team: string }
  | {
      outcome: "ambiguous_repo";
      repoIdentity: string;
      /** Every registration that matched, sorted by id — never the single one a last-writer-wins
       *  pick would have silently chosen. */
      matches: readonly ConfigSourceRegistration[];
    }
  | {
      outcome: "stack_owned_elsewhere";
      stackName: string;
      matchedRegistration: ConfigSourceRegistration;
      owner: ConfigSourceRegistration;
    };

/**
 * Resolve which registration (and therefore which team identity) governs a sync attempt for one
 * repo/stackName pair, or which of D9's two loud refusals applies.
 *
 * Ordering is deliberate: repo ambiguity is checked before stack ownership, because an ambiguous
 * repo match has no single "matched registration" to check stack ownership against in the first
 * place — reporting `ambiguous_repo` first is the only choice that is even well-defined.
 */
export function resolveConfigSourceForSync(
  registrations: readonly ConfigSourceRegistration[],
  repoIdentity: string,
  stackName: string
): RegistrationSyncResult {
  const wanted = normalizeConfigSourceRepoIdentity(repoIdentity);
  const repoMatches = registrations.filter((r) => registrationMatchesRepo(r, wanted));

  if (repoMatches.length === 0) return { outcome: "no_match" };

  if (repoMatches.length > 1) {
    return { outcome: "ambiguous_repo", repoIdentity: wanted, matches: sortById(repoMatches) };
  }

  const matchedRegistration = repoMatches[0] as ConfigSourceRegistration;

  const otherOwners = registrations.filter(
    (r) => r.id !== matchedRegistration.id && r.stackTeams?.[stackName] !== undefined
  );
  if (otherOwners.length > 0) {
    // Deterministic even when (pathologically) more than one OTHER registration also claims the
    // same stack name — that is itself a pre-existing conflict among the other registrations, but
    // it is not this function's job to adjudicate it; naming the lowest id keeps the refusal
    // reproducible rather than order-dependent on the caller's array.
    const owner = sortById(otherOwners)[0] as ConfigSourceRegistration;
    return { outcome: "stack_owned_elsewhere", stackName, matchedRegistration, owner };
  }

  const team = matchedRegistration.stackTeams?.[stackName] ?? matchedRegistration.team;
  return { outcome: "matched", registration: matchedRegistration, team };
}
