/**
 * The `config-source` DOCUMENT — pure shape rules for the registration object migration 0100
 * registers (ADR-0046 §1; team-pipeline-iac §4, D2/D7/D9).
 *
 * Everything here is a fact about one `properties` bag and nothing else: no DB, no authorization,
 * no I/O. The two consumers are the authoring door (`authoring-guard.ts`, which refuses a
 * malformed or over-reaching document at `graph/objects-repo.ts`'s create/update choke point) and
 * the registry read (`config-sources-repo.ts`, which turns stored rows into the
 * `ConfigSourceRegistration` values `registration-match.ts` already decides over).
 *
 * ================================================================================================
 * WHY THE STRICTNESS IS HERE AND NOT IN THE REGISTERED JSON SCHEMA
 * ================================================================================================
 * Migration 0100's header has the long form. Short version: the registered `property_schema` is
 * Ajv-validated on the RECEIVING side of federation with no try/catch, so a constraint there that a
 * peer one migration behind cannot satisfy fails that peer's WHOLE signed bundle. "Exactly one of
 * `repo`/`repoPattern`" is precisely such a constraint — it encodes a closed set of addressing
 * modes — so it lives here, at the operator's door, where the cost of a refusal is one 400 to the
 * author. Strict at the operator's door, permissive on the wire.
 */

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

/**
 * Parse and validate a `config-source` object's `properties`, or throw a 400 naming the defect.
 *
 * `subject` is the caller's own description of the row ("config-source 'payments-fleet'"), so one
 * refusal reads the same whether it came from the generic object route, an IaC apply, or a
 * hand-fill.
 */
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

/**
 * Every team a document delegates TO — the default `team` plus every value in `stackTeams`,
 * deduplicated and sorted so a refusal names them in the same order every run.
 *
 * This is the set the authoring door must hold authority over, and it is computed from the
 * document rather than passed in, so a field added to the delegation surface later cannot reach a
 * door that never learned to look at it.
 */
export function delegatedTeamRefs(document: ConfigSourceDocument): string[] {
  return [...new Set([document.team, ...Object.values(document.stackTeams)])].sort();
}
