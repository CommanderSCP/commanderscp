import { describe, expect, it } from "vitest";
import {
  PERSISTED_JSON_ELIDED_KEY,
  PERSISTED_JSON_MAX_CHARS,
  PERSISTED_JSON_MAX_DEPTH,
  boundPersistedJson
} from "./index.js";

/**
 * MEDIUM (M23.0 verification pass 7, findings M2 and M3) — BOUND THE STRUCTURE, NOT A LIST OF ITS
 * FIELDS.
 *
 * WHY THIS FUNCTION EXISTS RATHER THAN FOUR MORE `boundDetail` CALLS. The previous round bounded
 * `ExecutionStatus.detail` and missed `stateRef` and `observed.images` — the same untrusted object,
 * three lines away, on a write that runs EVERY tick rather than only on failure. Measured through
 * an unmodified test seam: 500 093 bytes of plugin-chosen text, verbatim, in
 * `change_wave_targets.observed_state`. `ExecutionStatus.observed` is documented as "optional and
 * additive", so a per-field patch list is a list that goes stale on the next signal an executor
 * contributes. The guarantee here is therefore about the WHOLE VALUE and is stated in the unit the
 * column is measured in:
 *
 *   JSON.stringify(boundPersistedJson(v)).length <= PERSISTED_JSON_MAX_CHARS,  for every v
 *
 * The sweep below is the evidence for "every v" that a hand-picked object cannot be. Note the last
 * two arms in particular: a REALISTIC reading has to come back byte-identical, and the internal
 * overflow fallback must never fire — either would make the guarantee true for a useless reason.
 */

/** An escape, not a literal: a NUL byte in a tracked source file is dropped by every
 *  recursive search this repository runs (CLAUDE.md). */
const NUL = "\u0000";
const MAX = PERSISTED_JSON_MAX_CHARS;

function isWellFormed(s: string): boolean {
  return (s as unknown as { isWellFormed(): boolean }).isWellFormed();
}

function deepChain(depth: number): unknown {
  const root: Record<string, unknown> = {};
  let cursor = root;
  for (let i = 0; i < depth; i++) {
    const next: Record<string, unknown> = {};
    cursor.next = next;
    cursor = next;
  }
  cursor.leaf = "the bottom";
  return root;
}

function selfReferential(): unknown {
  const o: Record<string, unknown> = { a: 1 };
  o.self = o;
  return o;
}

/** Every one of these is something an `ExecutionStatus` off the JSON-RPC boundary can actually be:
 *  the host types that response with a BARE CAST — `call<ExecutionStatus>("status", …)` — with no
 *  runtime validation anywhere on the path, so "the plugin promised a `string[]`" is not a fact. */
const ADVERSARIAL: ReadonlyArray<{ name: string; value: unknown }> = [
  { name: "a few enormous strings", value: { images: [`ghcr.io/x/y:${"a".repeat(100_000)}`] } },
  {
    name: "very many small strings",
    value: { images: Array.from({ length: 5_000 }, (_, i) => `ghcr.io/x/y:${i}`) }
  },
  { name: "one 2 MB revision", value: { revision: "r".repeat(2_000_000) } },
  {
    name: "astral characters at every cut",
    value: { revision: "\u{1F600}".repeat(100_000), images: ["\u{1F600}".repeat(50_000)] }
  },
  { name: "lone surrogates", value: { revision: `a\uD83Db`, images: [`x\uDE00`] } },
  { name: "NUL bytes", value: { revision: `a${NUL}b`, images: [`x${NUL}`] } },
  { name: "worst-case escapes (backslashes)", value: { s: "\\".repeat(200_000) } },
  { name: "worst-case escapes (C0 controls)", value: { s: "\u0001".repeat(200_000) } },
  { name: "worst-case escapes (quotes)", value: { s: '"'.repeat(200_000) } },
  {
    name: "5 000 keys",
    value: Object.fromEntries(Array.from({ length: 5_000 }, (_, i) => [`k${i}`, "v".repeat(50)]))
  },
  {
    name: "50 enormous KEYS",
    value: Object.fromEntries(
      Array.from({ length: 50 }, (_, i) => [`${"k".repeat(5_000)}${i}`, "v"])
    )
  },
  { name: "a 100 000-element array", value: Array.from({ length: 100_000 }, (_, i) => i) },
  { name: "200 levels of nesting", value: deepChain(200) },
  { name: "a self-referential object", value: selfReferential() },
  { name: "non-finite numbers", value: { a: NaN, b: Infinity, c: -Infinity, d: 1.5 } },
  { name: "a bigint", value: { n: 10n ** 40n } },
  { name: "a bare enormous string", value: "s".repeat(1_000_000) },
  { name: "null", value: null },
  { name: "undefined", value: undefined }
];

describe("MEDIUM: boundPersistedJson bounds a whole plugin-supplied value, not a list of its fields", () => {
  it.each(ADVERSARIAL.map((c) => [c.name, c.value] as const))(
    "%s: renders within the budget and is something Postgres will store",
    (name, value) => {
      const bounded = boundPersistedJson(value);
      const rendered = JSON.stringify(bounded);
      if (rendered === undefined) {
        // Only `undefined` reaches here, and it is the one input with nothing to bound.
        expect(value).toBeUndefined();
        return;
      }
      expect(rendered.length, `${name}: over the whole-value budget`).toBeLessThanOrEqual(MAX);
      // Stated against the literal as well, for the reason the magnitude tests exist: an assertion
      // against the constant that defines the bound cannot notice the constant moving.
      expect(rendered.length).toBeLessThanOrEqual(8_000);
      expect(isWellFormed(rendered), `${name}: a lone surrogate reached the row`).toBe(true);
      expect(rendered.includes(NUL), `${name}: U+0000 reached the row`).toBe(false);
    }
  );

  it("NON-VACUITY: the inputs really are over budget before bounding", () => {
    // Without this the sweep above is satisfiable by a fixture that never applied. Three of the
    // arms are deliberately SMALL (null, undefined, non-finite numbers), so this counts rather than
    // requiring all of them.
    const over = ADVERSARIAL.filter(({ value }) => {
      let raw: string | undefined;
      try {
        raw = JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? String(v) : v));
      } catch {
        return true; // a cycle — `JSON.stringify` throws, which is as over-budget as it gets
      }
      return raw !== undefined && raw.length > MAX;
    });
    expect(over.length, "the adversarial sweep is not adversarial").toBeGreaterThanOrEqual(12);
  });

  it("A REALISTIC READING IS RETURNED BYTE-IDENTICAL — the bound is a ceiling, not a filter", () => {
    // The counter-arm. A function that returned `{}` would satisfy every assertion above, and this
    // payload is what an actual Argo CD poll produces; ADR-0028's freshness gate reads these fields.
    const reading = {
      revision: "9f2c1ab4e77d0c31a5b8e6f2c9d4a1b3e5f70982",
      images: ["ghcr.io/org/app:1.2.3", "ghcr.io/org/sidecar@sha256:" + "a".repeat(64)],
      rollout: { phase: "Progressing", step: 2, weight: 25, message: "canary at 25%" }
    };
    expect(JSON.stringify(boundPersistedJson(reading))).toBe(JSON.stringify(reading));
  });

  it("THE INTERNAL OVERFLOW FALLBACK NEVER FIRES for any of the adversarial inputs", () => {
    // `boundPersistedJson` measures its own output and, if the walk's accounting were ever wrong,
    // replaces the payload with a small diagnostic. That backstop is deliberate — a lost payload
    // beats a stalled loop — but if it were firing routinely the sweep above would be green while
    // the function did nothing useful. So it is asserted NOT to fire.
    for (const { name, value } of ADVERSARIAL) {
      const bounded = boundPersistedJson(value);
      const fellBack =
        bounded !== null &&
        typeof bounded === "object" &&
        typeof (bounded as Record<string, unknown>)[PERSISTED_JSON_ELIDED_KEY] === "string" &&
        String((bounded as Record<string, unknown>)[PERSISTED_JSON_ELIDED_KEY]).startsWith(
          "a plugin-supplied value rendered"
        );
      expect(fellBack, `${name}: the walk's accounting was wrong and the backstop caught it`).toBe(
        false
      );
    }
  });

  it("A CYCLE IS SURVIVED, not thrown on — the values here come from a subprocess we do not control", () => {
    // `JSON.stringify` throws on a cycle, and a throw on this path is the stall the whole family of
    // fixes exists to prevent: it happens inside the write transaction.
    const bounded = boundPersistedJson(selfReferential());
    expect(() => JSON.stringify(bounded)).not.toThrow();
    expect(JSON.stringify(bounded)).toContain("nesting deeper than");
  });

  it("depth is capped at PERSISTED_JSON_MAX_DEPTH, and the cap is where the marker appears", () => {
    const bounded = boundPersistedJson(deepChain(200)) as Record<string, unknown>;
    let cursor: unknown = bounded;
    let depth = 0;
    while (cursor !== null && typeof cursor === "object" && "next" in cursor) {
      cursor = (cursor as { next: unknown }).next;
      depth++;
    }
    expect(depth).toBe(PERSISTED_JSON_MAX_DEPTH);
    expect(typeof cursor).toBe("string");
  });

  it("a smaller explicit budget is honoured too", () => {
    // The parameter is not decoration: `observed_state` and a future caller with a tighter column
    // are the same function at different widths.
    for (const max of [64, 200, 1_000]) {
      const rendered = JSON.stringify(
        boundPersistedJson({ images: Array.from({ length: 100 }, () => "x".repeat(5_000)) }, max)
      );
      expect(rendered!.length, `budget ${max}`).toBeLessThanOrEqual(max);
      expect(isWellFormed(rendered!)).toBe(true);
    }
  });
});
