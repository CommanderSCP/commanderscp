import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { AUTHORED_APPLICATION_PARAMETER } from "./deploy-lane-trigger-parameters.js";
import { BuildDestinationRefused } from "./build-trigger-parameters.js";
import {
  RecipeReservedParameterRefused,
  SERVER_RESERVED_TRIGGER_PARAMETER_KEYS,
  recipeReservedParameterRefusal,
  reservedKeysIn
} from "./reserved-trigger-parameters.js";

/**
 * M28.4 fix round (ADR-0055 D9) — EVERY key a lane derives is CLASSIFIED: reserved (a recipe
 * naming it is refused) or a named convenience (a recipe may restate it). A new derived key that is
 * in neither set turns this red, so the next bound cannot be added without deciding whether a recipe
 * may fill it in — which is the property the `scpAuthoredApplication` smuggling had.
 */

const here = dirname(fileURLToPath(import.meta.url));
const read = (f: string) => readFileSync(resolve(here, f), "utf8");

/** Keys a recipe MAY restate — ADR-0055 D9's table, second half. */
const CONVENIENCES = new Set(["sourceRepo", "sourceRef", "sourceCommit", "dockerfile", "rpmSpec"]);

function derivedKeys(): string[] {
  const keys = new Set<string>();
  const build = read("build-trigger-parameters.ts");
  // Build lane: `params.X =` / `out.X =`, the literal it seeds with, and the per-Type definition keys.
  for (const m of build.matchAll(/\b(?:params|out)\.([A-Za-z]+)\s*=/g)) keys.add(m[1]!);
  for (const m of build.matchAll(/params:\s*Record<[^>]+>\s*=\s*\{\s*(\w+):/g)) keys.add(m[1]!);
  const defStart = build.indexOf("const BUILD_DEFINITION_PROPERTY");
  const defBlock = build.slice(defStart, build.indexOf("};", defStart));
  for (const m of defBlock.matchAll(/:\s*"(\w+)"/g)) keys.add(m[1]!);
  // Ops lane: every `opsX` key `deriveOpsRunMaterial` returns.
  for (const m of read("ops-run-material.ts").matchAll(/\b(ops[A-Z]\w*)\s*[,:]/g)) keys.add(m[1]!);
  // Deploy lane.
  keys.add(AUTHORED_APPLICATION_PARAMETER);
  return [...keys].sort();
}

describe("server-reserved trigger parameters", () => {
  it("the census is not vacuous — it finds each lane's keys", () => {
    const keys = derivedKeys();
    for (const k of [
      "changeObjectId",
      "imageDestination",
      "rpmUploadUrl",
      "sourceRepo",
      "rpmSpec",
      "opsInventory",
      "scpAuthoredApplication"
    ]) {
      expect(keys).toContain(k);
    }
  });

  it("every key a lane derives is either reserved or a named convenience", () => {
    const unclassified = derivedKeys().filter(
      (k) => !SERVER_RESERVED_TRIGGER_PARAMETER_KEYS.has(k) && !CONVENIENCES.has(k)
    );
    expect(
      unclassified,
      "a lane derives a key nobody decided about — register it in RESERVED_BY_LANE (a recipe " +
        "naming it is refused) or add it to CONVENIENCES here and ADR-0055 D9 (a recipe may restate it)"
    ).toEqual([]);
  });

  it("no key is both", () => {
    expect([...CONVENIENCES].filter((k) => SERVER_RESERVED_TRIGGER_PARAMETER_KEYS.has(k))).toEqual([]);
  });

  it("reservedKeysIn: universal keys always; build destination only where the Type derives one", () => {
    const bag = { workflowId: "x", scpAuthoredApplication: {}, opsInventory: [], registryUrl: "u" };
    expect(reservedKeysIn(bag, "configuration")).toEqual(["opsInventory", "scpAuthoredApplication"]);
    expect(reservedKeysIn(bag, "image")).toEqual([
      "opsInventory",
      "registryUrl",
      "scpAuthoredApplication"
    ]);
    // ADR-0053 §4a: a no-class Type derives no destination, so there is nothing to protect.
    expect(reservedKeysIn({ registryUrl: "u" }, "npm")).toEqual([]);
    expect(reservedKeysIn({ constructor: 1, toString: 2 }, "image")).toEqual([]);
    expect(reservedKeysIn(undefined, "image")).toEqual([]);
  });

  it("the choke point keeps ADR-0053's contract for a destination-only recipe and refuses the rest as reserved", () => {
    const dest = recipeReservedParameterRefusal({ rpmUploadUrl: "https://x.invalid" }, "rpm");
    expect(dest).toBeInstanceOf(BuildDestinationRefused);
    expect(dest!.inputContext).toMatchObject({ gate: "build_destination_recipe", recipeDestinationKeys: ["rpmUploadUrl"] });
    const smuggled = recipeReservedParameterRefusal({ scpAuthoredApplication: {} }, "configuration");
    expect(smuggled).toBeInstanceOf(RecipeReservedParameterRefused);
    expect(smuggled!.status).toBe("recipe_reserved_parameter");
    expect(smuggled!.inputContext).toEqual({
      gate: "recipe_reserved_parameter",
      reservedParameters: ["scpAuthoredApplication"]
    });
    expect(recipeReservedParameterRefusal({ workflowId: "x" }, "configuration")).toBeUndefined();
  });
});
