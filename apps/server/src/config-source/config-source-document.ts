/** The `config-source` DOCUMENT. See docs/config-source.md §8. */

import { badRequest } from "../errors.js";

/** The parsed document. Field meanings are `registration-match.ts`'s and are not restated. */
export interface ConfigSourceDocument {
  repo?: string;
  repoPattern?: string;
  ref: string;
  paths: string[];
  team: string;
  stackTeams: Readonly<Record<string, string>>;
}

/** The one type id this module is about — exported so no consumer spells it a second time. */
export const CONFIG_SOURCE_TYPE_ID = "config-source";

function requireNonEmptyString(
  properties: Record<string, unknown>,
  key: string,
  subject: string
): string {
  const value = properties[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw badRequest(
      `${subject}: '${key}' must be a non-empty string — without it the registration names ` +
        `nothing to read and cannot be acted on`
    );
  }
  return value.trim();
}

function parsePaths(properties: Record<string, unknown>, subject: string): string[] {
  const value = properties.paths;
  if (!Array.isArray(value) || value.length === 0) {
    throw badRequest(
      `${subject}: 'paths' must be a non-empty array of path globs — a config source that selects ` +
        `no manifest is a registration that can never apply anything, and it would look identical ` +
        `to one whose repo simply has no changes`
    );
  }
  const paths = value.map((entry, i) => {
    if (typeof entry !== "string" || entry.trim() === "") {
      throw badRequest(`${subject}: 'paths[${i}]' must be a non-empty string`);
    }
    return entry.trim();
  });
  return paths;
}

function parseStackTeams(
  properties: Record<string, unknown>,
  subject: string
): Record<string, string> {
  const value = properties.stackTeams;
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw badRequest(`${subject}: 'stackTeams' must be an object mapping stack name -> team`);
  }
  const out: Record<string, string> = {};
  for (const [stackName, team] of Object.entries(value as Record<string, unknown>)) {
    if (stackName.trim() === "") {
      throw badRequest(`${subject}: 'stackTeams' has an empty stack name`);
    }
    if (typeof team !== "string" || team.trim() === "") {
      throw badRequest(
        `${subject}: 'stackTeams["${stackName}"]' must be a non-empty team id or URN`
      );
    }
    out[stackName] = team.trim();
  }
  return out;
}

/** Parse a config-source document, or 400 naming the defect. See docs/config-source.md §9. */
export function parseConfigSourceDocument(
  properties: Record<string, unknown>,
  subject: string
): ConfigSourceDocument {
  const repo = typeof properties.repo === "string" ? properties.repo.trim() : undefined;
  const repoPattern =
    typeof properties.repoPattern === "string" ? properties.repoPattern.trim() : undefined;

  // EXACTLY ONE addressing form. Neither is the useless case (the registration matches no repo and
  // silently never syncs); both is the ambiguous one (which of the two decides is a coin flip, and
  // `registration-match.ts` deliberately checks `repo` first — an order that must never become a
  // load-bearing tiebreaker between two things one author wrote).
  const declared = [repo, repoPattern].filter((v) => v !== undefined && v !== "");
  if (declared.length !== 1) {
    throw badRequest(
      `${subject}: declare exactly one of 'repo' (one repository) or 'repoPattern' (a namespace ` +
        `covering a team's fleet) — ${declared.length === 0 ? "neither is set, so this registration would match no repository and never sync" : "both are set, and which one decides would be an implementation detail rather than something you wrote"}`
    );
  }

  return {
    ...(repo !== undefined && repo !== "" ? { repo } : {}),
    ...(repoPattern !== undefined && repoPattern !== "" ? { repoPattern } : {}),
    ref: requireNonEmptyString(properties, "ref", subject),
    paths: parsePaths(properties, subject),
    team: requireNonEmptyString(properties, "team", subject),
    stackTeams: parseStackTeams(properties, subject)
  };
}

/** Every team the document delegates to, computed not passed. See docs/config-source.md §10. */
export function delegatedTeamRefs(document: ConfigSourceDocument): string[] {
  return [...new Set([document.team, ...Object.values(document.stackTeams)])].sort();
}
