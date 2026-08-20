import { describe, expect, it } from "vitest";
import {
  assertNoPrototypePoisoning,
  parseJsonRejectingPrototypePoisoning,
  PrototypePoisoningError
} from "./safe-json.js";

describe("assertNoPrototypePoisoning — refuses", () => {
  it.each([
    ["a top-level __proto__ key", '{"ok":1,"__proto__":{"polluted":"yes"}}'],
    ["a nested __proto__ key", '{"a":{"b":{"__proto__":{"x":1}}}}'],
    ["a __proto__ key inside an array element", '{"list":[{"__proto__":{"x":1}}]}'],
    ["a __proto__ key at the root of an array body", '[{"__proto__":{"x":1}}]'],
    ["a __proto__ key whose value is a scalar", '{"__proto__":"just a string"}'],
    ["a __proto__ key written with unicode escapes", '{"\\u005f\\u005fproto\\u005f\\u005f":{}}'],
    ["a __proto__ key alongside a legitimate one", '{"name":"svc","__proto__":{"isAdmin":true}}']
  ])("%s", (_label, json) => {
    const parsed: unknown = JSON.parse(json);
    expect(() => {
      assertNoPrototypePoisoning(parsed);
    }).toThrow(PrototypePoisoningError);
  });

  it("a constructor key carrying its own prototype (the gadget shape)", () => {
    const parsed: unknown = JSON.parse('{"constructor":{"prototype":{"isAdmin":true}}}');
    expect(() => {
      assertNoPrototypePoisoning(parsed);
    }).toThrow(PrototypePoisoningError);
  });

  it("names which rule fired", () => {
    const proto = JSON.parse('{"__proto__":{}}') as unknown;
    const ctor = JSON.parse('{"constructor":{"prototype":{}}}') as unknown;
    expect(() => {
      assertNoPrototypePoisoning(proto);
    }).toThrow(/__proto__/);
    expect(() => {
      assertNoPrototypePoisoning(ctor);
    }).toThrow(/constructor/);
  });

  it("is a SyntaxError subclass, so existing parse-failure catch arms already handle it", () => {
    const err = new PrototypePoisoningError("__proto__");
    expect(err).toBeInstanceOf(SyntaxError);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("PrototypePoisoningError");
    expect(err.forbiddenKey).toBe("__proto__");
  });
});

describe("assertNoPrototypePoisoning — accepts", () => {
  it.each([
    ["an ordinary object", '{"name":"svc","properties":{"a":1}}'],
    ["a bare constructor STRING (harmless, must not be refused)", '{"constructor":"harmless"}'],
    ["a constructor object with no prototype key", '{"constructor":{"name":"x"}}'],
    ["a key merely named prototype", '{"prototype":{"a":1}}'],
    ["a key CONTAINING the substring __proto__", '{"my__proto__key":1}'],
    ["a STRING VALUE that reads __proto__", '{"note":"__proto__ is a key name"}'],
    ["an array of scalars", "[1,2,3]"],
    ["null", "null"],
    ["a bare scalar", "42"],
    ["an empty object", "{}"]
  ])("%s", (_label, json) => {
    const parsed: unknown = JSON.parse(json);
    expect(() => {
      assertNoPrototypePoisoning(parsed);
    }).not.toThrow();
  });

  it("does not blow the stack on a deeply nested document (it walks iteratively)", () => {
    // Deep enough that a recursive guard would RangeError before reaching a verdict. The guard on
    // the .scpbundle door accepts bodies up to 64 MiB, so this shape is reachable in production.
    const depth = 60_000;
    const deep = JSON.parse("[".repeat(depth) + "1" + "]".repeat(depth)) as unknown;
    expect(() => {
      assertNoPrototypePoisoning(deep);
    }).not.toThrow();
  });
});

describe("parseJsonRejectingPrototypePoisoning", () => {
  it("distinguishes malformed JSON from hostile JSON", () => {
    expect(() => parseJsonRejectingPrototypePoisoning("{not json")).toThrow(SyntaxError);
    expect(() => parseJsonRejectingPrototypePoisoning("{not json")).not.toThrow(
      PrototypePoisoningError
    );
    expect(() => parseJsonRejectingPrototypePoisoning('{"__proto__":{}}')).toThrow(
      PrototypePoisoningError
    );
  });

  it("returns the parsed value unchanged for acceptable input", () => {
    expect(parseJsonRejectingPrototypePoisoning('{"a":[1,{"b":2}]}')).toEqual({
      a: [1, { b: 2 }]
    });
  });
});

/**
 * TOTALITY OVER GRAPHS `JSON.parse` CANNOT PRODUCE.
 *
 * `assertNoPrototypePoisoning` is EXPORTED, so its callers are not limited to the two doors that
 * hand it fresh `JSON.parse` output. Before the visited set, a single cyclic argument made it spin
 * forever — measured: still running at 20 s, hard-killed — which is the guard becoming the denial
 * of service it exists to prevent, inside the process that serves every route.
 *
 * A NON-TERMINATING WALK CANNOT BE CAUGHT BY A TEST TIMEOUT: it is synchronous, so it blocks the
 * event loop and vitest never gets to fire one. (Measured: with the visited set deleted, this file
 * ran past 300 s and had to be killed — it does not fail, it hangs, and a hang that wedges CI is a
 * bad gate even though it is a loud one.) So the cases below count node VISITS through an
 * enumerable getter and trip a budget instead. With the visited set each node is examined once;
 * delete it and the budget throws in milliseconds and the named test fails cleanly.
 */
describe("assertNoPrototypePoisoning — terminates on graphs JSON.parse cannot produce", () => {
  /** An enumerable accessor property that counts how often the walk reads it, and refuses to be a
   *  hang: past `budget` reads it throws, turning non-termination into a fast, named failure. */
  const countingProperty = (
    target: Record<string, unknown>,
    key: string,
    value: unknown,
    budget = 10_000
  ): { reads: () => number } => {
    let reads = 0;
    Object.defineProperty(target, key, {
      enumerable: true,
      configurable: true,
      get() {
        reads += 1;
        if (reads > budget) throw new Error(`assertNoPrototypePoisoning did not terminate`);
        return value;
      }
    });
    return { reads: () => reads };
  };

  it("a self-referential object", () => {
    const a: Record<string, unknown> = { ok: 1 };
    const probe = countingProperty(a, "self", a);
    expect(() => {
      assertNoPrototypePoisoning(a);
    }).not.toThrow();
    expect(probe.reads()).toBe(1);
  });

  it("a two-node cycle through an array", () => {
    const a: Record<string, unknown> = {};
    const b: Record<string, unknown> = {};
    const probe = countingProperty(b, "back", [a]);
    a.fwd = b;
    expect(() => {
      assertNoPrototypePoisoning(a);
    }).not.toThrow();
    expect(probe.reads()).toBe(1);
  });

  it("STILL REFUSES a poisoned node reachable only past the cycle", () => {
    const poisoned = JSON.parse('{"__proto__":{"isAdmin":true}}') as unknown;
    const a: Record<string, unknown> = { later: poisoned };
    countingProperty(a, "self", a);
    expect(() => {
      assertNoPrototypePoisoning(a);
    }).toThrow(PrototypePoisoningError);
  });

  it("a shared subtree is not re-walked once per inbound edge", () => {
    // A diamond chain: without identity-based skipping the leaf is read 2**depth times.
    const leaf: Record<string, unknown> = {};
    const probe = countingProperty(leaf, "value", true);
    let node: Record<string, unknown> = { l: leaf, r: leaf };
    for (let i = 0; i < 40; i += 1) node = { l: node, r: node };
    expect(() => {
      assertNoPrototypePoisoning(node);
    }).not.toThrow();
    expect(probe.reads()).toBe(1);
  });

  it("examines every structurally-equal SIBLING — the skip is identity, not structure", () => {
    const poisoned = JSON.parse('{"__proto__":{"x":1}}') as unknown;
    // Two distinct objects that a structural cache would collapse; the third must still be reached.
    expect(() => {
      assertNoPrototypePoisoning({ one: { a: 1 }, two: { a: 1 }, three: poisoned });
    }).toThrow(PrototypePoisoningError);
  });
});

/**
 * A full snapshot of `Object.prototype`'s own property names, captured at module load. Asserting
 * that three named keys are absent only proves those three are absent; this proves NOTHING was
 * added or removed. A leaked pollution would make every later assertion in the run untrustworthy,
 * so it is checked rather than assumed.
 */
const OBJECT_PROTOTYPE_KEYS_AT_LOAD = Object.getOwnPropertyNames(Object.prototype).sort().join(",");

describe("safe-json — global prototype hygiene", () => {
  it("mutates no member of Object.prototype", () => {
    for (const json of [
      '{"__proto__":{"polluted":"yes","isAdmin":true}}',
      '{"constructor":{"prototype":{"polluted":"yes"}}}',
      '{"a":{"__proto__":{"polluted":"yes"}}}'
    ]) {
      try {
        parseJsonRejectingPrototypePoisoning(json);
      } catch {
        /* expected */
      }
    }
    const probe = {} as Record<string, unknown>;
    expect(probe.polluted).toBeUndefined();
    expect(probe.isAdmin).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(Object.prototype, "polluted")).toBe(false);
    expect(Object.getOwnPropertyNames(Object.prototype).sort().join(",")).toBe(
      OBJECT_PROTOTYPE_KEYS_AT_LOAD
    );
  });
});
