import { badRequest } from "../errors.js";
import type { TopologyWaveSpec } from "./plan-compiler.js";

/**
 * THE release-topology wave parser — in ONE place, for BOTH plan compilers.
 *
 * ============================================================================================
 * WHY THIS IS ITS OWN MODULE
 * ============================================================================================
 * The validation below arrived in `plan-service.ts` alone. `campaign-plan-service.ts` — the
 * campaign-scoped sibling that DESIGN §9.5 requires to reuse "the same plan/wave machinery as a
 * single change" — held its own untouched copy, the exact pre-fix shape, so all three instances the
 * fix names below stayed live on the campaign path: a junk topology ran as one undifferentiated
 * wave, silently, exactly as before.
 *
 * That is the census-by-property convention's own failure mode: the fix found the property, named it
 * precisely, and was applied to ONE of its two call sites. Extracting the parser is the only form of
 * the fix that cannot regress that way — a third compiler gets the behaviour by importing it, and
 * there is no second copy to forget.
 */

/** Wave keys the compiler understands. Anything else is a typo or a key from a newer authority. */
const KNOWN_WAVE_KEYS = new Set(["name", "mode", "targets", "requiresFanIn"]);

/**
 * Parses a snapshotted topology document into wave specs, FAILING LOUDLY on anything malformed.
 *
 * ============================================================================================
 * WHAT THIS USED TO DO, AND WHY IT WAS A HAZARD (§1.5, §11 — one property, three instances)
 * ============================================================================================
 * This function returned `undefined` whenever `document.waves` was not an array. `compilePlan`
 * treats `undefined` as "no topology" and falls back to a bare toposort — so a MALFORMED topology
 * compiled successfully to one anonymous wave, and attaching it had no visible effect whatsoever.
 * A silently-ignored configuration is worse than a rejected one: the operator sees a topology
 * attached, a plan compiled, and a release run, with nothing anywhere saying the document was junk.
 *
 * The same property had three instances, and fixing only the named one would have left two:
 *
 *   1. `waves` not an array          -> returned `undefined`   (the instance §1.5 named)
 *   2. `waves: []`                   -> `compilePlan`'s `length === 0` branch ALSO falls back to
 *                                       toposort, so an explicitly empty topology is equally silent
 *   3. `waves as TopologyWaveSpec[]` -> an unchecked cast: no wave was ever validated, so
 *                                       `{mode: "paralel"}` or a missing `targets` reached the
 *                                       compiler as garbage
 *
 * All three now throw. `additionalProperties` on the wave is enforced HERE rather than in the
 * registered JSON Schema — see the note below.
 *
 * ============================================================================================
 * WHY UNKNOWN-KEY REJECTION IS HERE AND NOT IN THE REGISTERED SCHEMA (D16 vs migration 0043)
 * ============================================================================================
 * D16 asks for `additionalProperties: false` on the wave object in `release-topology`'s registered
 * property schema. That would work, and it would also re-create the exact hazard migration 0043
 * documented at length: `release-topology` is a GRAPH OBJECT, so it rides `object_upsert` and is
 * re-validated with Ajv on the RECEIVING side, whose branch has no try/catch — one unknown key from
 * a newer commander aborts the WHOLE SYNC BUNDLE for that outpost, not just the entry. 0043's rule
 * is "strict at the operator's door, open on the wire", and it exists because this was paid for
 * once already.
 *
 * Enforcing it here delivers D16's intent without that: an unknown wave key is refused LOUDLY, at
 * the moment it would otherwise be silently ignored, and it is refused for federated documents too
 * — at the point of USE rather than the point of receipt, so a bad document fails one change
 * instead of wedging a peer's entire sync. It also covers what the registered schema structurally
 * cannot: `topology_document` is a SNAPSHOT taken at compile time, and Ajv never re-validates it.
 *
 * This is a deliberate deviation from D16's letter, in favour of D16's purpose plus 0043's rule.
 */
export function parseTopologyWaves(document: unknown): TopologyWaveSpec[] | undefined {
  if (document === null || document === undefined) return undefined;
  if (typeof document !== "object") {
    throw badRequest(`release topology document is not an object (got ${typeof document})`);
  }
  const waves = (document as { waves?: unknown }).waves;
  // A topology with NO `waves` key at all is not malformed — it simply declares no ordering, which
  // is the pre-topology behaviour and what the registered schema permits. An EMPTY one is different:
  // someone wrote `waves: []`, which can only mean a mistake, and it would silently compile to the
  // same single anonymous wave as having no topology at all.
  if (waves === undefined) return undefined;
  if (!Array.isArray(waves)) {
    throw badRequest(
      `release topology 'waves' must be an array (got ${waves === null ? "null" : typeof waves}) — a malformed topology is refused rather than silently ignored`
    );
  }
  if (waves.length === 0) {
    throw badRequest(
      "release topology declares an empty 'waves' array — that would compile to a single anonymous wave, exactly as if no topology were attached at all"
    );
  }

  return waves.map((wave, i) => {
    const where = `release topology wave ${i}`;
    if (!wave || typeof wave !== "object" || Array.isArray(wave)) {
      throw badRequest(`${where} is not an object`);
    }
    const w = wave as Record<string, unknown>;
    for (const key of Object.keys(w)) {
      if (!KNOWN_WAVE_KEYS.has(key)) {
        throw badRequest(
          `${where} carries unknown key '${key}' — a key the compiler does not read would silently do nothing`
        );
      }
    }
    if (w.mode !== "parallel" && w.mode !== "sequential") {
      throw badRequest(
        `${where} has mode '${String(w.mode)}' — expected 'parallel' or 'sequential'`
      );
    }
    if (!Array.isArray(w.targets) || w.targets.length === 0) {
      throw badRequest(`${where} must name at least one target`);
    }
    if (!w.targets.every((t) => typeof t === "string" && t.length > 0)) {
      throw badRequest(`${where} has a non-string target`);
    }
    if (w.name !== undefined && typeof w.name !== "string") {
      throw badRequest(`${where} has a non-string name`);
    }
    if (w.requiresFanIn !== undefined && typeof w.requiresFanIn !== "boolean") {
      throw badRequest(`${where} has a non-boolean requiresFanIn`);
    }
    return {
      ...(typeof w.name === "string" ? { name: w.name } : {}),
      mode: w.mode,
      targets: w.targets as string[],
      ...(typeof w.requiresFanIn === "boolean" ? { requiresFanIn: w.requiresFanIn } : {})
    };
  });
}
