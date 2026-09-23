import { describe, expect, it } from "vitest";
import {
  RecipeOverrideRefused,
  SERVER_DERIVED_OPS_KEYS,
  assertNoRecipeOverride,
  readServerDerivedMaterial
} from "./run-material.js";

const complete = {
  opsRole: "os_package",
  opsInventory: "[all]\ni-001 ansible_host=10.0.0.1\n",
  opsEgressAllowlist: ["10.0.0.1"],
  opsPrincipals: ["scp-ops"]
};

describe("ADR-0052: a recipe may not author the bound", () => {
  it.each(SERVER_DERIVED_OPS_KEYS)("refuses a recipe that sets %s", (key) => {
    // REFUSED, not silently overridden: an operator whose recipe names one of these has a mistaken
    // belief about how the class works, and a run that quietly ignored them would leave that belief
    // intact — next time against a fleet where the difference matters.
    expect(() => assertNoRecipeOverride({ [key]: "anything" })).toThrow(RecipeOverrideRefused);
  });

  it("names every offending key at once, not just the first", () => {
    // An operator fixing them one error at a time is an operator running this several more times
    // than necessary, each run against a live fleet.
    try {
      assertNoRecipeOverride({ opsInventory: "x", opsEgressAllowlist: ["y"] });
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).toContain("opsInventory");
      expect((err as Error).message).toContain("opsEgressAllowlist");
    }
  });

  it("NEGATIVE CONTROL: leaves everything outside the closed set alone", () => {
    // Without this, a blanket refusal would satisfy every case above — and authoring a role's own
    // arguments is the whole point of a recipe.
    expect(() =>
      assertNoRecipeOverride({ package_name: "nginx", package_state: "present" })
    ).not.toThrow();
  });

  it("the closed set is exactly the four keys that constitute the bound", () => {
    // Pinned as a LITERAL so adding a derived key without deciding whether it belongs to the bound
    // is a failing test rather than an accident.
    expect([...SERVER_DERIVED_OPS_KEYS].sort()).toEqual([
      "opsEgressAllowlist",
      "opsInventory",
      "opsPrincipals",
      "opsRole"
    ]);
  });
});

describe("readServerDerivedMaterial", () => {
  it("reads a complete bag", () => {
    expect(readServerDerivedMaterial(complete)).toEqual(complete);
  });

  it.each(SERVER_DERIVED_OPS_KEYS)("REFUSES when %s is missing", (key) => {
    // A host-reaching run missing its inventory could otherwise start against an empty host list
    // and report success having done nothing — "unbound placement fake-succeeds", with a host
    // credential in it.
    const partial = { ...complete } as Record<string, unknown>;
    delete partial[key];
    expect(() => readServerDerivedMaterial(partial)).toThrow(/missing server-derived material/);
  });

  it("refuses undefined parameters outright", () => {
    expect(() => readServerDerivedMaterial(undefined)).toThrow(/missing server-derived material/);
  });

  it("refuses an EMPTY inventory string, which is not the same as an empty fleet", () => {
    // An empty fleet is `[all]\n` — a compiled inventory with no hosts. An empty STRING means the
    // compile never happened, and the two must not be confused.
    expect(() => readServerDerivedMaterial({ ...complete, opsInventory: "" })).toThrow();
  });

  it("accepts an empty ALLOWLIST, which is a real state", () => {
    // A fleet scaled to zero has nothing to reach. The run should start and do nothing rather than
    // be refused — refusing would make "no hosts" indistinguishable from "could not resolve".
    expect(() =>
      readServerDerivedMaterial({ ...complete, opsEgressAllowlist: [], opsInventory: "[all]\n" })
    ).not.toThrow();
  });

  it("refuses principals that are empty — a certificate must authorize someone", () => {
    expect(() => readServerDerivedMaterial({ ...complete, opsPrincipals: [] })).toThrow();
  });
});
