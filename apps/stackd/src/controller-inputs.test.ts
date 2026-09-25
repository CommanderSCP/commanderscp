import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * WHAT CAN REACH THE CONTROLLER (M29.4 security census, ADR-0058).
 *
 * The controller holds near-cluster-admin rights, so the M28 lesson applies in full: a value that
 * decides what it applies must not be writable by anyone who could not otherwise grant cluster
 * rights. Its inputs are exactly:
 *   1. the stack SPEC, read through ONE API operation (`stack.spec`), whose schema carries no free
 *      string (packages/schemas `stack-spec-census.test.ts`), written only through the operator
 *      tier (apps/server `stack.integration.test.ts`, drizzle/0126);
 *   2. its own image (chart, helm pin) and deploy-time env / image-retarget file (`release.ts`,
 *      `values.test.ts`'s census).
 * This file holds the SOURCE to (1): the controller builds one API client, uses two operations on
 * it — read the spec, write the status — and has no other network path to scpd.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const sources = readdirSync(HERE)
  .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
  .map((f) => ({ file: f, text: readFileSync(path.join(HERE, f), "utf8") }));

/** Strips // and /* *\/ comments, so a commented-out call is not counted as code. */
const code = (text: string) =>
  text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

describe("the stack controller's inputs", () => {
  it("finds the controller's sources (known-positive control)", () => {
    expect(sources.map((s) => s.file)).toEqual(
      expect.arrayContaining([
        "controller.ts",
        "reconcile.ts",
        "values.ts",
        "release.ts",
        "main.ts"
      ])
    );
  });

  it("constructs exactly one API client, in controller.ts, with no session token", () => {
    const sites = sources.filter((s) => /new ScpClient\(/.test(code(s.text)));
    expect(sites.map((s) => s.file)).toEqual(["controller.ts"]);
    const ctor = /new ScpClient\(([^)]*)\)/.exec(code(sites[0]!.text))![1]!;
    expect(ctor.replace(/\s/g, "")).toBe("{baseUrl}");
  });

  it("calls exactly two API operations: the spec read and the status write", () => {
    const calls = new Set<string>();
    for (const s of sources) {
      for (const m of code(s.text).matchAll(/client\.(\w+)\.(\w+)\(/g))
        calls.add(`${m[1]}.${m[2]}`);
      for (const m of code(s.text).matchAll(/client\.(\w+)\(/g)) calls.add(m[1]!);
    }
    expect([...calls].sort()).toEqual(["stack.putStatus", "stack.spec"]);
  });

  it("has no other way to reach scpd: no fetch, no undici, no ad-hoc HTTP client to the API", () => {
    for (const s of sources) {
      const c = code(s.text);
      expect(c, `${s.file} calls fetch`).not.toMatch(/\bfetch\(/);
      expect(c, `${s.file} imports undici`).not.toMatch(/from "undici"/);
    }
    // node:http(s) is the Kubernetes transport and the health server — and only there.
    const httpUsers = sources
      .filter((s) => /from "node:https?"/.test(code(s.text)))
      .map((s) => s.file)
      .sort();
    expect(httpUsers).toEqual(["kube.ts", "main.ts"]);
  });

  it("reads from the spec only its enumerated fields: backend, enabled, sizeTier, purgeGeneration, the settings and the integrity digests", () => {
    const fields = new Set<string>();
    for (const s of sources) {
      for (const m of code(s.text).matchAll(/\bspec\.(\w+)/g)) fields.add(m[1]!);
      for (const m of code(s.text).matchAll(/\bsettings\.(\w+)/g)) fields.add(`settings.${m[1]}`);
    }
    // `spec.settings` / `spec.backends` are the document; the rest are StackBackendSpec's fields.
    // (`spec.group` / `spec.versions` / `spec.template` read RENDERED objects' spec, not the API's.)
    const allowed = new Set([
      "settings",
      "backends",
      "backend",
      "enabled",
      "sizeTier",
      // A counter: a purge acts only when it exceeds what the controller last acted on.
      "purgeGeneration",
      // sha256 hex or null (stack-spec-census): only ever COMPARED with the controller's own
      // digests, so it can make the controller refuse its stored state, never act on other state.
      "integrity",
      "settings.updatePolicy",
      "settings.upgradeGeneration",
      "group",
      "versions",
      "replicas",
      "template"
    ]);
    expect([...fields].filter((f) => !allowed.has(f))).toEqual([]);
  });
});
