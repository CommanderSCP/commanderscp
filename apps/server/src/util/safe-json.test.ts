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
  });
});
