import { describe, expect, it } from "vitest";

import {
  boundPersistedJson,
  PERSISTED_JSON_ELIDED_KEY,
  PERSISTED_JSON_MAX_CHARS
} from "./index.js";

/** Prototype pollution from an untrusted response. See docs/runner-launcher.md §379. */
describe("HIGH: a `__proto__` key in a plugin response cannot reach the stored object", () => {
  /** True when anything reachable in `value` has a prototype the plugin chose. */
  const deepPolluted = (value: unknown): boolean => {
    if (Array.isArray(value)) return value.some(deepPolluted);
    if (typeof value !== "object" || value === null) return false;
    if (Object.getPrototypeOf(value) !== Object.prototype) return true;
    return Object.values(value).some(deepPolluted);
  };
  /** True when anything reachable in `value` carries `__proto__` as an OWN key — which would put
   *  the gadget back on the wire even with the prototype intact. */
  const deepNamesProto = (value: unknown): boolean => {
    if (Array.isArray(value)) return value.some(deepNamesProto);
    if (typeof value !== "object" || value === null) return false;
    if (Object.getOwnPropertyNames(value).includes("__proto__")) return true;
    return Object.values(value).some(deepNamesProto);
  };

  it("THE RUNTIME CLAIM THE GUARD RESTS ON, MEASURED RATHER THAN ASSUMED", () => {
    // `isUnsafePersistedKey` refuses exactly one key. See docs/runner-launcher.md §380.
    const names = Object.getOwnPropertyNames(Object.prototype);
    expect(names.length, "Object.prototype has no own properties to enumerate").toBeGreaterThan(5);
    const accessors = names.filter((key) => {
      const d = Object.getOwnPropertyDescriptor(Object.prototype, key)!;
      return d.get !== undefined || d.set !== undefined;
    });
    const nonWritable = names.filter((key) => {
      const d = Object.getOwnPropertyDescriptor(Object.prototype, key)!;
      return d.get === undefined && d.set === undefined && d.writable === false;
    });
    expect(accessors, "a second key now makes assignment differ from definition").toEqual([
      "__proto__"
    ]);
    expect(nonWritable, "a [[Set]] to one of these would now silently fail").toEqual([]);
    expect(
      Object.getOwnPropertySymbols(Object.prototype).filter((s) => {
        const d = Object.getOwnPropertyDescriptor(Object.prototype, s)!;
        return d.get !== undefined || d.set !== undefined;
      }),
      "a symbol accessor cannot arrive from JSON, but the enumeration should say so"
    ).toEqual([]);
  });

  it("AND EXACTLY ONE KEY IS REFUSED — every other inherited name is ordinary data", () => {
    // The other side of the measurement above. See docs/runner-launcher.md §381.
    const inherited = ["constructor", "toString", "hasOwnProperty", "valueOf", "isPrototypeOf"];
    const input = JSON.parse(
      `{${inherited.map((k, i) => `"${k}":"v${i}"`).join(",")},"revision":"abc"}`
    );
    const { value, truncation } = boundPersistedJson(input);
    expect(value, "a writable inherited name was refused as if it were the accessor").toEqual({
      constructor: "v0",
      toString: "v1",
      hasOwnProperty: "v2",
      valueOf: "v3",
      isPrototypeOf: "v4",
      revision: "abc"
    });
    for (const key of inherited)
      expect(
        Object.prototype.hasOwnProperty.call(value, key),
        `${key} is not an OWN property of the stored object`
      ).toBe(true);
    expect(truncation, "nothing was cut, so nothing should be reported").toBeUndefined();
    expect(deepPolluted(value)).toBe(false);
  });

  it("THE DEFECT ITSELF: the plugin's object does not become the stored object's prototype", () => {
    // `JSON.parse` and not an object literal, deliberately — an object literal SETS the prototype
    // at construction and there would be no own key for the walk to meet. The parse is what a
    // plugin response actually goes through.
    const input = JSON.parse('{"revision":"abc","__proto__":{"polluted":true},"images":["i1"]}');
    expect(
      Object.getOwnPropertyNames(input),
      "JSON.parse stopped making `__proto__` an own key, and the fixture no longer drives the defect"
    ).toEqual(["revision", "__proto__", "images"]);

    const { value, truncation } = boundPersistedJson(input);
    expect(deepPolluted(value), "the stored object carries a plugin-chosen prototype").toBe(false);
    expect(deepNamesProto(value), "`__proto__` is an own key of the stored object").toBe(false);
    expect((value as Record<string, unknown>).polluted).toBeUndefined();
    // The siblings are untouched — refusing one key is not an excuse to lose the reading.
    expect(value).toEqual({ revision: "abc", images: ["i1"] });
    // AND IT IS REPORTED. Without this the field is indistinguishable from one the executor never
    // sent, which is the wrong-cause defect M23.1g exists to end.
    expect(truncation, "the refusal was silent").toBeDefined();
    expect(truncation![PERSISTED_JSON_ELIDED_KEY]).toEqual({ dropped: true, droppedFields: 1 });
  });

  it("BOTH OTHER SHAPES THE SETTER TREATS DIFFERENTLY: a null and a primitive", () => {
    // `__proto__: null` gives the stored object a NULL prototype — no `hasOwnProperty`, no
    // `toString` — and a primitive is accepted by the setter and then silently discarded. Three
    // different behaviours from one key, which is why the key and not the value is what is refused.
    const nulled = boundPersistedJson(JSON.parse('{"a":1,"__proto__":null}'));
    expect(Object.getPrototypeOf(nulled.value as object)).toBe(Object.prototype);
    expect(nulled.value).toEqual({ a: 1 });
    expect(nulled.truncation![PERSISTED_JSON_ELIDED_KEY]).toEqual({
      dropped: true,
      droppedFields: 1
    });

    const primitive = boundPersistedJson(JSON.parse('{"__proto__":"s","b":2}'));
    expect(Object.getPrototypeOf(primitive.value as object)).toBe(Object.prototype);
    expect(primitive.value).toEqual({ b: 2 });
    expect(primitive.truncation![PERSISTED_JSON_ELIDED_KEY]).toEqual({
      dropped: true,
      droppedFields: 1
    });
  });

  it("IT IS ALSO A BUDGET DEFECT: the refused field no longer charges its siblings", () => {
    // The walk paid for the key and stored nothing for it. See docs/runner-launcher.md §382.
    const input = JSON.parse(
      `{"__proto__":${JSON.stringify("z".repeat(3_000))},"keep":${JSON.stringify("k".repeat(3_000))}}`
    );
    const { value } = boundPersistedJson(input, 4_000);
    const kept = (value as Record<string, string>).keep;
    expect(kept, "the surviving field was still charged for the refused one").toBeDefined();
    expect(JSON.stringify(value)!.length).toBeGreaterThan(3_000);
    expect(JSON.stringify(value)!.length).toBeLessThanOrEqual(4_000);
  });

  it("NESTED, AND INSIDE AN ARRAY — the refusal is a property of the walk, not of the root", () => {
    const input = JSON.parse(
      '{"outer":{"__proto__":{"p":1},"ok":"v"},"list":[{"__proto__":{"q":2},"id":7}]}'
    );
    const { value, truncation } = boundPersistedJson(input);
    expect(deepPolluted(value)).toBe(false);
    expect(deepNamesProto(value)).toBe(false);
    expect(value).toEqual({ outer: { ok: "v" }, list: [{ id: 7 }] });
    // Below the root the names are not addressable, so the loss rolls up into the root field that
    // contains it — which is `WalkBudget.fields`' documented rule, not a special case for this key.
    expect(truncation).toEqual({
      outer: { dropped: false, droppedFields: 1 },
      list: { dropped: false, droppedFields: 1 }
    });
  });

  it("THE REPORT'S KEY SPACE IS GUARDED TOO, and that is a second write site, not a duplicate", () => {
    // `boundTruncationReport` builds the report with `out[key] = entry` — the SAME call to the same
    // setter. The report is keyed by ROOT FIELD NAME, so a refused `__proto__` would be named out
    // loud in a record we then serialise, putting the gadget back into the field that exists to
    // explain its absence. It is counted in the elision bucket instead.
    const input = JSON.parse('{"__proto__":{"p":1},"revision":"' + "r".repeat(9_000) + '"}');
    const { value, truncation } = boundPersistedJson(input);
    expect(deepPolluted(truncation)).toBe(false);
    expect(deepNamesProto(truncation)).toBe(false);
    expect(Object.getOwnPropertyNames(truncation!)).not.toContain("__proto__");
    // Both losses are reported: the refused key in the bucket, the cut revision by name.
    expect(truncation![PERSISTED_JSON_ELIDED_KEY]?.dropped).toBe(true);
    expect(truncation!.revision?.droppedCharacters).toBeGreaterThan(0);
    expect(deepPolluted(value)).toBe(false);
  });

  it("THE BACKSTOP'S REPORT TOO — the one path that maps the RAW input's keys", () => {
    // `wholesaleTruncation` reports every root field of the INPUT as dropped, so it is the one
    // producer that puts an unbounded plugin key into the report's key space without the walk
    // having seen it. Driven at a budget too small for the walk's own output.
    const input = JSON.parse('{"__proto__":{"p":1},"a":1,"b":2}');
    const { value, truncation } = boundPersistedJson(input, 8);
    expect(deepPolluted(truncation)).toBe(false);
    expect(Object.getOwnPropertyNames(truncation ?? {})).not.toContain("__proto__");
    expect(deepPolluted(value)).toBe(false);
  });

  it("THE SWEEP: no object this bound returns ever has a prototype it did not create", () => {
    // The standing invariant, over the dense budget axis rather than at three hand-picked budgets —
    // because "which budget" is what decides whether a key is seated, bounded, refused for room, or
    // refused for safety, and only one of those four is the arm the fixtures above drive.
    const shapes: [string, () => unknown][] = [
      ["bare", () => JSON.parse('{"__proto__":{"p":1}}')],
      ["with siblings", () => JSON.parse('{"a":"aaaa","__proto__":{"p":1},"b":"bbbb"}')],
      ["nested", () => JSON.parse('{"o":{"__proto__":{"p":1},"k":"v"}}')],
      ["in a list", () => JSON.parse('{"l":[{"__proto__":{"p":1}},{"id":1}]}')],
      ["null-valued", () => JSON.parse('{"a":1,"__proto__":null}')],
      ["primitive-valued", () => JSON.parse('{"__proto__":"s","b":2}')],
      ["only key, big value", () => JSON.parse(`{"__proto__":${JSON.stringify("z".repeat(500))}}`)],
      [
        "long key ending in __proto__",
        () => JSON.parse(`{"${"x".repeat(300)}__proto__":{"p":1},"keep":"v"}`)
      ],
      ["five of them", () => JSON.parse('{"__proto__":{"p":1},"a":1,"b":2,"c":3,"d":4}')]
    ];
    let pairs = 0;
    let stored = 0;
    for (const [name, make] of shapes) {
      for (let budget = 4; budget <= 1_200; budget++) {
        pairs++;
        const input = make();
        const { value, truncation } = boundPersistedJson(input, budget);
        expect(deepPolluted(value), `${name} @ ${budget}: value prototype`).toBe(false);
        expect(deepNamesProto(value), `${name} @ ${budget}: value names __proto__`).toBe(false);
        expect(deepPolluted(truncation), `${name} @ ${budget}: report prototype`).toBe(false);
        expect(deepNamesProto(truncation), `${name} @ ${budget}: report names __proto__`).toBe(
          false
        );
        expect(
          (JSON.stringify(value) ?? "null").length,
          `${name} @ ${budget}: over budget`
        ).toBeLessThanOrEqual(budget);
        if (typeof value === "object" && value !== null && Object.keys(value).length > 0) stored++;
      }
    }
    // NON-VACUITY: a sweep whose every budget was too small to store anything would be green on a
    // bound that returned `null` for everything.
    expect(pairs).toBeGreaterThan(10_000);
    expect(stored, "nothing was ever stored, so the sweep asserts nothing").toBeGreaterThan(5_000);
    // …and the fixtures really do reach the interesting states rather than only the tight ones.
    expect(
      JSON.stringify(boundPersistedJson(shapes[1]![1](), PERSISTED_JSON_MAX_CHARS).value)
    ).toBe('{"a":"aaaa","b":"bbbb"}');
  });
});
