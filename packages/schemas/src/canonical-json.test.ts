import { describe, expect, it } from "vitest";
import { canonicalJson, canonicalizeDeep } from "./canonical-json.js";

/**
 * The implementation this module replaces, copied VERBATIM from `origin/main`'s
 * `federation-journal.ts` (identical bytes in four other files). It is here as the differential
 * oracle for the compatibility guarantee: for input with no own `__proto__` key the new
 * canonicalizer must agree with it to the byte, because live estates hold `row_hash` /
 * `content_hash` values computed by it.
 */
function legacySortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(legacySortKeysDeep);
  if (value !== null && typeof value === "object") {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = legacySortKeysDeep((value as Record<string, unknown>)[key]);
        return acc;
      }, {});
  }
  return value;
}
const legacyCanonicalJson = (value: unknown): string => JSON.stringify(legacySortKeysDeep(value));

/** Inputs with no own `__proto__` key anywhere — every one must serialize byte-identically. */
const COMPATIBILITY_CORPUS: Array<[label: string, value: unknown]> = [
  ["null", null],
  ["undefined", undefined],
  ["number", 42],
  ["negative zero", -0],
  ["string", "hello"],
  ["boolean", false],
  ["empty object", {}],
  ["empty array", []],
  ["flat object, reverse key order", { z: 1, a: 2, m: 3 }],
  ["nested objects", { b: { d: 1, c: { f: 2, e: 3 } }, a: 4 }],
  ["arrays keep their order", { list: [3, 1, 2], other: ["b", "a"] }],
  [
    "array of objects",
    [
      { b: 1, a: 2 },
      { d: 3, c: 4 }
    ]
  ],
  ["undefined-valued key is dropped", { a: undefined, b: 1 }],
  ["undefined inside an array becomes null", { a: [1, undefined, 2] }],
  ["a Date has no own enumerable keys", { at: new Date("2026-08-20T00:00:00Z") }],
  ["numeric-looking string keys sort lexicographically", { "10": 1, "9": 2, "1": 3 }],
  ["unicode keys", { é: 1, a: 2, " ": 3 }],
  ["a key named constructor", { constructor: "harmless", a: 1 }],
  ["a key named prototype", { prototype: { a: 1 } }],
  ["deeply nested", { a: { a: { a: { a: { b: 1, a: 2 } } } } }],
  ["null nested value", { a: null, b: { c: null } }],
  ["empty-string key", { "": 1, a: 2 }]
];

describe("canonicalJson — compatibility with the five implementations it replaces", () => {
  it.each(COMPATIBILITY_CORPUS)(
    "is byte-identical to the legacy canonicalizer for: %s",
    (_label, value) => {
      expect(canonicalJson(value)).toBe(legacyCanonicalJson(value));
    }
  );

  it("is insensitive to key insertion order", () => {
    expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }));
  });
});

describe("canonicalJson — totality over __proto__ (the integrity bug)", () => {
  /**
   * THE assertion that had to flip. On `origin/main` these two produced the byte-identical string
   * `{"ok":1}`, so a peer could append an arbitrarily large subtree to a signed payload without
   * changing its `rowHash` or its Ed25519 signature.
   */
  it("gives two payloads differing only by a __proto__ subtree DIFFERENT canonical strings", () => {
    const clean = JSON.parse('{"ok":1}') as unknown;
    const poisoned = JSON.parse(
      '{"ok":1,"__proto__":{"polluted":"yes","big":[1,2,3,4,5]}}'
    ) as unknown;

    // The precondition the whole bug rests on: JSON.parse makes it an OWN key.
    expect(Object.keys(poisoned as object)).toEqual(["ok", "__proto__"]);

    // The legacy oracle still demonstrates the defect, so this test cannot pass vacuously.
    expect(legacyCanonicalJson(clean)).toBe(legacyCanonicalJson(poisoned));

    expect(canonicalJson(clean)).not.toBe(canonicalJson(poisoned));
    expect(canonicalJson(poisoned)).toBe(
      '{"__proto__":{"big":[1,2,3,4,5],"polluted":"yes"},"ok":1}'
    );
  });

  it("distinguishes two DIFFERENT __proto__ subtrees from each other", () => {
    const a = JSON.parse('{"__proto__":{"role":"viewer"}}') as unknown;
    const b = JSON.parse('{"__proto__":{"role":"admin"}}') as unknown;
    expect(legacyCanonicalJson(a)).toBe(legacyCanonicalJson(b));
    expect(canonicalJson(a)).not.toBe(canonicalJson(b));
  });

  it("covers a __proto__ key nested deep inside the payload", () => {
    const clean = JSON.parse('{"a":{"b":{"c":1}}}') as unknown;
    const poisoned = JSON.parse('{"a":{"b":{"c":1,"__proto__":{"x":1}}}}') as unknown;
    expect(legacyCanonicalJson(clean)).toBe(legacyCanonicalJson(poisoned));
    expect(canonicalJson(clean)).not.toBe(canonicalJson(poisoned));
  });

  it("covers a __proto__ key inside an array element", () => {
    const clean = JSON.parse('{"list":[{"a":1}]}') as unknown;
    const poisoned = JSON.parse('{"list":[{"a":1,"__proto__":{"x":1}}]}') as unknown;
    expect(legacyCanonicalJson(clean)).toBe(legacyCanonicalJson(poisoned));
    expect(canonicalJson(clean)).not.toBe(canonicalJson(poisoned));
  });

  it("covers a __proto__ key written with unicode escapes (JSON.parse resolves them first)", () => {
    const escaped = JSON.parse('{"\\u005f\\u005fproto\\u005f\\u005f":{"x":1}}') as unknown;
    expect(Object.keys(escaped as object)).toEqual(["__proto__"]);
    expect(canonicalJson(escaped)).toBe('{"__proto__":{"x":1}}');
  });

  it("does not swap the prototype of the value it returns", () => {
    const poisoned = JSON.parse('{"ok":1,"__proto__":{"isAdmin":true}}') as unknown;

    // The legacy oracle DID swap it: keys said ["ok"] while `.isAdmin` read back true.
    const legacy = legacySortKeysDeep(poisoned) as Record<string, unknown>;
    expect(Object.keys(legacy)).toEqual(["ok"]);
    expect(legacy.isAdmin).toBe(true);

    const out = canonicalizeDeep(poisoned) as Record<string, unknown>;
    expect(Object.getPrototypeOf(out)).toBeNull();
    expect(Object.keys(out).sort()).toEqual(["__proto__", "ok"]);
  });
});

/**
 * A full snapshot of `Object.prototype`'s own property names, captured at module load. Asserting
 * that three named keys are absent only proves those three are absent; this proves NOTHING was
 * added or removed. A leaked pollution would make every later assertion in the run untrustworthy,
 * so it is checked rather than assumed.
 */
const OBJECT_PROTOTYPE_KEYS_AT_LOAD = Object.getOwnPropertyNames(Object.prototype).sort().join(",");

describe("canonicalJson — global prototype hygiene", () => {
  /**
   * A leaked pollution makes every later assertion in the run untrustworthy, so this file asserts
   * its own cleanliness rather than assuming it.
   */
  it("mutates no member of Object.prototype", () => {
    for (const value of [
      JSON.parse('{"__proto__":{"polluted":"yes","isAdmin":true,"big":[1,2]}}'),
      JSON.parse('{"a":{"__proto__":{"polluted":"yes"}}}'),
      JSON.parse('[{"__proto__":{"polluted":"yes"}}]')
    ] as unknown[]) {
      canonicalJson(value);
    }
    const probe = {} as Record<string, unknown>;
    expect(probe.polluted).toBeUndefined();
    expect(probe.isAdmin).toBeUndefined();
    expect(probe.big).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(Object.prototype, "polluted")).toBe(false);
    expect(Object.getOwnPropertyNames(Object.prototype).sort().join(",")).toBe(
      OBJECT_PROTOTYPE_KEYS_AT_LOAD
    );
  });
});
