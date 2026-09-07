import { WaveGateSchema, type WaveGate } from "@scp/schemas";
import { badRequest } from "../errors.js";
import type { TopologyWaveSpec } from "./plan-compiler.js";

/** THE release-topology wave parser. See docs/coordination.md §1004. */

/** Wave keys the compiler understands. Anything else is a typo or a key from a newer authority. */
const KNOWN_WAVE_KEYS = new Set(["name", "mode", "targets", "requiresFanIn", "gates"]);

/** Parses a snapshotted topology, failing loudly. See docs/coordination.md §1005. */
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
    // ABSENT vs `[]` is a real distinction (see the module doc above) — `gates` is only assigned
    // below when the key was present at all, so an absent key stays absent rather than becoming
    // `undefined` masquerading as "empty" or vice versa.
    let gates: WaveGate[] | undefined;
    if (w.gates !== undefined) {
      if (!Array.isArray(w.gates)) {
        throw badRequest(`${where} has a non-array gates`);
      }
      gates = w.gates.map((entry, gi) => {
        const parsed = WaveGateSchema.safeParse(entry);
        if (!parsed.success) {
          throw badRequest(
            `${where} gate ${gi} is invalid: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`
          );
        }
        return parsed.data;
      });
    }
    return {
      ...(typeof w.name === "string" ? { name: w.name } : {}),
      mode: w.mode,
      targets: w.targets as string[],
      ...(typeof w.requiresFanIn === "boolean" ? { requiresFanIn: w.requiresFanIn } : {}),
      ...(gates !== undefined ? { gates } : {})
    };
  });
}
