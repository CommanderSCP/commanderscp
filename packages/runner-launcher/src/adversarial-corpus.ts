/**
 * ==================================================================================================
 * THE ADVERSARIAL CORPUS — ONE TABLE, TWO LAYERS
 * ==================================================================================================
 *
 * WHY IT IS A MODULE AND NOT A CONST IN A TEST FILE (M23.1f clause 4). Every one of these shapes was
 * asserted only against PROXIES — `isWellFormed()`, "no NUL", "under 8,000 characters" — in a pure
 * unit test with no database anywhere near it. The clause the corpus exists to satisfy is "zero rows
 * refused by a REAL Postgres", and the non-vacuity control for it is "the PRE-BOUND shape IS
 * refused", which only a real server can answer. Two tests in two packages need the same table, and
 * a second copy of it is a copy that goes stale in the direction that matters: the layer that gets
 * the new hostile shape is the one whose author was thinking about it.
 *
 * `persisted-json-bound.test.ts` reads it for the proxies, cheaply, on every PR;
 * `apps/server`'s `persisted-json-postgres-corpus.integration.test.ts` reads it for the real answer.
 *
 * EVERY ONE OF THESE IS SOMETHING AN `ExecutionStatus` OFF THE JSON-RPC BOUNDARY CAN ACTUALLY BE:
 * the plugin host types that response with a BARE CAST — `call<ExecutionStatus>("status", …)` — with
 * no runtime validation anywhere on the path, so "the plugin promised a `string[]`" is not a fact.
 */

/** An escape, not a literal: a NUL byte in a tracked source file is dropped by every
 *  recursive search this repository runs (CLAUDE.md). */
const NUL = "\u0000";

/** A chain of `depth` nested single-key objects. Exported: `persisted-json-bound.test.ts` uses it
 *  to assert where the depth marker lands, which is a different question from what the corpus asks. */
export function deepChain(depth: number): unknown {
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

/** An object that contains itself — `JSON.stringify` throws on it, which is the point. */
export function selfReferential(): unknown {
  const o: Record<string, unknown> = { a: 1 };
  o.self = o;
  return o;
}

/** Every one of these is something an `ExecutionStatus` off the JSON-RPC boundary can actually be:
 *  the host types that response with a BARE CAST — `call<ExecutionStatus>("status", …)` — with no
 *  runtime validation anywhere on the path, so "the plugin promised a `string[]`" is not a fact. */
export const ADVERSARIAL_PERSISTED_JSON: ReadonlyArray<{ name: string; value: unknown }> = [
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
  { name: "undefined", value: undefined },
  // M23.0 verification pass 11. Every array above holds STRINGS or INTEGERS, and both of those are
  // charged exactly, so no arm of this corpus could reach the three leaf branches that return
  // something rendering as `null`. Two of the three charged nothing for it.
  { name: "a list of 2 000 nulls", value: { images: Array(2_000).fill(null) } },
  { name: "a list of 2 000 undefineds", value: { images: Array(2_000).fill(undefined) } },
  {
    name: "a list of 2 000 functions",
    value: { images: Array.from({ length: 2_000 }, () => () => 1) }
  },
  // …and every array above is cut at most ONCE per value, so no arm could reach the case where
  // several tail markers are charged against a budget that has nothing left for them.
  {
    name: "four lists the budget cannot finish",
    value: {
      a: ["x".repeat(9_000), "x".repeat(9_000)],
      b: ["x".repeat(9_000), "x".repeat(9_000)],
      c: ["x".repeat(9_000), "x".repeat(9_000)],
      d: ["x".repeat(9_000), "x".repeat(9_000)]
    }
  }
];
/**
 * ==================================================================================================
 * LAYER 2 — THE ALPHABETS THE PROXIES CANNOT SEPARATE (M23.1f clause 4)
 * ==================================================================================================
 * The table above was built against the proxies: `isWellFormed`, no-NUL, under budget. These were
 * built against the QUESTION — "is there a byte sequence a bounded value can still carry that
 * PostgreSQL's `jsonb` input refuses?" — and each names the specific refusal it is probing for.
 * Measured against real PostgreSQL 16: 0 of the whole corpus refused after the bound; 9 of it
 * refused BEFORE, split `unsupported Unicode escape sequence` and
 * `invalid input syntax for type json`.
 */
export const ADVERSARIAL_ALPHABETS: ReadonlyArray<{ name: string; value: unknown }> = [
  // U+2028/U+2029 are valid JSON string content and invalid JavaScript source — a driver that
  // interpolated rather than parameterised would break here and nowhere else.
  { name: "line and paragraph separators", value: { revision: "a\u2028b\u2029c" } },
  // Every C0 control, including the NUL `jsonb` refuses and the seven with short escapes.
  {
    name: "the whole C0 range",
    value: { revision: Array.from({ length: 32 }, (_, i) => String.fromCharCode(i)).join("") }
  },
  { name: "BOM and bidi overrides", value: { revision: "\uFEFFa\u202Eb\u202Dc\u2066d\u2069" } },
  // Adjacent lone surrogates that are NOT a pair: the sanitiser must not join them into one.
  { name: "adjacent unpaired surrogates", value: { revision: "\uD83D\uD83D\uDE00\uDE00" } },
  { name: "NUL as an OBJECT KEY", value: { [`k${NUL}ey`]: "v", ok: "v" } },
  { name: "NUL inside an astral pair", value: { revision: `\u{1F600}${NUL}\u{1F600}` } },
  {
    name: "every BMP code unit",
    value: { revision: Array.from({ length: 65_536 }, (_, i) => String.fromCharCode(i)).join("") }
  },
  { name: "U+FFFD beside a raw high surrogate", value: { revision: "\uFFFD\uD83D\uFFFD" } },
  { name: "ZWJ emoji sequences", value: { revision: "\u{1F469}\u200D\u{1F4BB}".repeat(64) } },
  // A key and a value that are the bound's OWN markers: a round trip must not read them as a cut.
  // THE LITERAL, NOT THE CONSTANT, AND DELIBERATELY. Importing `PERSISTED_JSON_ELIDED_KEY` from
  // `./index.js` makes a module cycle — `index.ts` re-exports this file — and a cycle here resolves
  // to `undefined` at module-evaluation time, which turns the whole corpus into an empty array in
  // any consumer that imports it through the package entry. That is a vacuous sweep with no symptom.
  // `persisted-json-bound.test.ts` asserts this literal still equals the constant.
  { name: "the bound's own markers as data", value: { __scpElided: "not ours", revision: "\u2026 12 more" } },
  { name: "a NUL-only string", value: { revision: NUL.repeat(64) } }
];

/** Both layers, which is what a test asking "does a real Postgres refuse any of this" must drive. */
export const ADVERSARIAL_ALL: ReadonlyArray<{ name: string; value: unknown }> = [
  ...ADVERSARIAL_PERSISTED_JSON,
  ...ADVERSARIAL_ALPHABETS
];
