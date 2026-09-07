import { globMatch } from "../coordination/glob-match.js";

/** Config-source registration matching. See docs/config-source.md §22. */

/** One config-source registration. See docs/config-source.md §23. */
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

/** The result of resolving ONE. See docs/config-source.md §24. */
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

/** Resolve which registration. See docs/config-source.md §25. */
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
