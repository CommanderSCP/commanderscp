import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { AUTHORED_APPLICATION_PARAMETER } from "./deploy-lane-trigger-parameters.js";
import { SERVER_RESERVED_TRIGGER_PARAMETERS, reservedKeysIn } from "./reserved-trigger-parameters.js";

/**
 * M28.4 fix round (ADR-0055 D9) — EVERY key a lane derives is CLASSIFIED: reserved (a recipe
 * naming it is refused) or a named convenience (a recipe may restate it). A new derived key that is
 * in neither set turns this red, so the next bound cannot be added without deciding whether a recipe
 * may fill it in — which is the property the `scpAuthoredApplication` smuggling had.
 */

const here = dirname(fileURLToPath(import.meta.url));
const read = (f: string) => readFileSync(resolve(here, f), "utf8");

/** Keys a recipe MAY restate — ADR-0055 D9's table, second half. */
const CONVENIENCES = new Set(["sourceRepo", "sourceRef", "sourceCommit", "dockerfile"]);

function derivedKeys(): string[] {
  const keys = new Set<string>();
  // Build lane: `params.X =` / `out.X =`, plus the literal it seeds with.
  for (const m of read("build-trigger-parameters.ts").matchAll(/\b(?:params|out)\.([A-Za-z]+)\s*=/g)) {
    keys.add(m[1]!);
  }
  for (const m of read("build-trigger-parameters.ts").matchAll(/params:\s*Record<[^>]+>\s*=\s*\{\s*(\w+):/g)) {
    keys.add(m[1]!);
  }
  // Ops lane: every `opsX` key `deriveOpsRunMaterial` returns.
  for (const m of read("ops-run-material.ts").matchAll(/\b(ops[A-Z]\w*)\s*[,:]/g)) keys.add(m[1]!);
  // Deploy lane.
  keys.add(AUTHORED_APPLICATION_PARAMETER);
  return [...keys].sort();
}

describe("server-reserved trigger parameters", () => {
  it("the census is not vacuous — it finds each lane's keys", () => {
    const keys = derivedKeys();
    for (const k of ["changeObjectId", "imageDestination", "sourceRepo", "opsInventory", "scpAuthoredApplication"]) {
      expect(keys).toContain(k);
    }
  });

  it("every key a lane derives is either reserved or a named convenience", () => {
    const unclassified = derivedKeys().filter(
      (k) => !(k in SERVER_RESERVED_TRIGGER_PARAMETERS) && !CONVENIENCES.has(k)
    );
    expect(
      unclassified,
      "a lane derives a key nobody decided about — add it to SERVER_RESERVED_TRIGGER_PARAMETERS " +
        "(a recipe naming it is refused) or to CONVENIENCES here and ADR-0055 D9 (a recipe may restate it)"
    ).toEqual([]);
  });

  it("no key is both", () => {
    expect([...CONVENIENCES].filter((k) => k in SERVER_RESERVED_TRIGGER_PARAMETERS)).toEqual([]);
  });

  it("reservedKeysIn finds reserved keys and ignores prototype names", () => {
    expect(reservedKeysIn({ workflowId: "x", scpAuthoredApplication: {}, opsInventory: [] })).toEqual([
      "opsInventory",
      "scpAuthoredApplication"
    ]);
    expect(reservedKeysIn({ constructor: 1, toString: 2 })).toEqual([]);
    expect(reservedKeysIn(undefined)).toEqual([]);
  });
});
