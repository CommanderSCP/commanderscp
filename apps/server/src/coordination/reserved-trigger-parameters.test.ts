import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { stripComments } from "@scp/source-census";
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

/** EVERY LANE, discovered — not a hard-coded list (review round 2): any `*-trigger-parameters.ts`
 *  under coordination/ is a lane, so M28.2's lane and every later one are censused the day they land.
 *  The table module itself is not a lane. */
function laneFiles(): string[] {
  return readdirSync(here)
    .filter((f) => /-trigger-parameters\.ts$/.test(f) && !f.includes(".test."))
    .filter((f) => f !== "reserved-trigger-parameters.ts")
    .sort();
}

/** The keys one lane file derives, read with comments stripped. Shapes recognised:
 *  `params.X =` / `out.X =`; the seed literal `params: Record<…> = { X: … }`; a per-Type definition
 *  table `…_PROPERTY: … = { type: "X" }`; a computed key `[CONST]:` whose CONST is a string literal
 *  in the same file; and the final `return { … }` of any local `*-material` module the lane imports. */
function laneKeys(file: string): Set<string> {
  const keys = new Set<string>();
  const src = stripComments(read(file));
  for (const m of src.matchAll(/\b(?:params|out)\.([A-Za-z]\w*)\s*=/g)) keys.add(m[1]!);
  for (const m of src.matchAll(/params:\s*Record<[^>]+>\s*=\s*\{\s*(\w+):/g)) keys.add(m[1]!);
  for (const block of src.matchAll(/_PROPERTY:[^=]*=\s*\{([^}]*)\}/g)) {
    for (const m of block[1]!.matchAll(/:\s*"(\w+)"/g)) keys.add(m[1]!);
  }
  for (const m of src.matchAll(/\[([A-Z][A-Z0-9_]+)\]:/g)) {
    const literal = new RegExp(`export const ${m[1]} = "(\\w+)"`).exec(src);
    if (literal) keys.add(literal[1]!);
  }
  for (const m of src.matchAll(/from "\.\/([\w-]+-material)\.js"/g)) {
    const material = stripComments(read(`${m[1]}.ts`));
    const returns = [...material.matchAll(/return \{([^}]*)\};?\s*\}\s*$/gm)];
    const last = returns.at(-1)?.[1] ?? "";
    for (const k of last.matchAll(/^\s*(\w+)\s*(?:[:,]|$)/gm)) keys.add(k[1]!);
  }
  return keys;
}

function derivedKeys(): string[] {
  return [...new Set(laneFiles().flatMap((f) => [...laneKeys(f)]))].sort();
}

describe("server-reserved trigger parameters", () => {
  it("every lane is discovered, and every lane yields keys (a lane the census cannot read is red)", () => {
    // KNOWN-POSITIVE CONTROL: the three lanes that exist today are found by the pattern…
    expect(laneFiles()).toEqual(
      expect.arrayContaining([
        "build-trigger-parameters.ts",
        "deploy-lane-trigger-parameters.ts",
        "ops-lane-trigger-parameters.ts"
      ])
    );
    // …and no lane is silently empty: a new lane whose shape this census cannot read must TEACH it,
    // not pass as "derives nothing".
    for (const f of laneFiles()) {
      expect([...laneKeys(f)], `the census reads no keys out of ${f}`).not.toEqual([]);
    }
  });

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
    expect([...CONVENIENCES].filter((k) => SERVER_RESERVED_TRIGGER_PARAMETER_KEYS.has(k))).toEqual(
      []
    );
  });

  it("reservedKeysIn: universal keys always; build destination only where the Type derives one", () => {
    const bag = { workflowId: "x", scpAuthoredApplication: {}, opsInventory: [], registryUrl: "u" };
    expect(reservedKeysIn(bag, "configuration")).toEqual([
      "opsInventory",
      "scpAuthoredApplication"
    ]);
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
    expect(dest!.inputContext).toMatchObject({
      gate: "build_destination_recipe",
      recipeDestinationKeys: ["rpmUploadUrl"]
    });
    const smuggled = recipeReservedParameterRefusal(
      { scpAuthoredApplication: {} },
      "configuration"
    );
    expect(smuggled).toBeInstanceOf(RecipeReservedParameterRefused);
    expect(smuggled!.status).toBe("recipe_reserved_parameter");
    expect(smuggled!.inputContext).toEqual({
      gate: "recipe_reserved_parameter",
      reservedParameters: ["scpAuthoredApplication"]
    });
    expect(recipeReservedParameterRefusal({ workflowId: "x" }, "configuration")).toBeUndefined();
  });
});
