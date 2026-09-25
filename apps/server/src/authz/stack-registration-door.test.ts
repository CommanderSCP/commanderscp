import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * M29.2 (ADR-0061) — WHO MAY WRITE A STANDARD STACK REGISTRATION.
 *
 * `stackManagedWrite` is the one flag that lets a write through `assertStackRegistrationWrite` to an
 * `execution-system` that is a bundled backend's registration. It must be set by the stack's own
 * reconciler and by nothing a request can reach — no route, no request body, no IaC apply, no
 * federation import. This census reads every non-test server source (comments stripped, read with
 * `readFileSync`, never a grep tool — BUILD_AND_TEST.md §4.4b) and holds the flag to exactly the
 * files that define and pass it.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, "..");

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sources(p));
    else if (p.endsWith(".ts") && !p.includes(".test.") && !p.includes("/test-support/"))
      out.push(p);
  }
  return out;
}

const strip = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const files = sources(SRC).map((p) => ({
  rel: path.relative(SRC, p),
  code: strip(readFileSync(p, "utf8"))
}));

describe("the stack-registration write flag is the stack's alone", () => {
  it("finds the server's sources (known-positive control)", () => {
    expect(files.length).toBeGreaterThan(200);
    expect(files.map((f) => f.rel)).toEqual(
      expect.arrayContaining(["graph/objects-repo.ts", "stack/wiring.ts", "routes/stack.ts"])
    );
  });

  it("is SET (to true) only by stack/wiring.ts, the registration reconciler", () => {
    const setters = files.filter((f) => /stackManagedWrite:\s*true/.test(f.code)).map((f) => f.rel);
    expect(setters).toEqual(["stack/wiring.ts"]);
  });

  it("is named only where it is defined, checked and set — never in a route or a request schema", () => {
    const named = files
      .filter((f) => /\bstackManagedWrite\b/.test(f.code))
      .map((f) => f.rel)
      .sort();
    expect(named).toEqual([
      "authz/execution-system-routing-door.ts",
      "graph/objects-repo.ts",
      "stack/wiring.ts"
    ]);
    // And no request schema carries it (the flag must not be settable from JSON).
    const schemas = readFileSync(
      path.resolve(SRC, "../../../packages/schemas/src/graph.ts"),
      "utf8"
    );
    expect(schemas).not.toMatch(/stackManagedWrite/);
  });

  it("objects-repo installs the door on create, update AND delete", () => {
    const repo = files.find((f) => f.rel === "graph/objects-repo.ts")!.code;
    for (const act of ["create", "update", "delete"]) {
      expect(repo, act).toMatch(
        new RegExp(`assertStackRegistrationWrite\\([^)]*act: "${act}"`, "s")
      );
    }
  });
});
