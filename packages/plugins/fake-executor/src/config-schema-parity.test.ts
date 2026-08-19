import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readStripped } from "@scp/source-census";
import { manifest } from "./index.js";

/**
 * ================================================================================================
 * THE `detailByTarget` GAP, MADE A GATE (M23.0 verification pass 8 finding #3)
 * ================================================================================================
 * `detailByTarget` was added to `FakeExecutorConfig` and to `status()` but NOT to
 * `manifest.configSchema`, which is `additionalProperties: false`. Nothing was red: the test
 * harness injects boot-time config directly and bypasses `validatePluginConfig` entirely, so the
 * gap was invisible to every test that exercises this plugin — only a real tenant `PUT
 * /executors/{id}/binding` naming the key would have 400'd, contradicting this module's own doc
 * comment, which calls the schema's keys "the tenant-facing surface".
 *
 * THE PROPERTY, CENSUSED RATHER THAN RESTATED BY HAND: every top-level `FakeExecutorConfig` field
 * EXCEPT `statePath` (server-governed — see the doc above `manifest`, "DELIBERATELY ABSENT") must
 * appear in `configSchema.properties`. Reading the INTERFACE'S OWN SOURCE (not a second hand-typed
 * list here) is what makes this a gate and not just a differently-shaped restatement of the bug: a
 * hand-typed list would have missed `detailByTarget` exactly the way the schema did.
 *
 * PROVEN BY DELETING THE WIRING: comment out `detailByTarget` in `configSchema.properties` (leaving
 * it in the interface) and this test fails, naming the field. Comment it out of the INTERFACE
 * instead and the test still passes (schema is a superset of nothing to cover) — which is correct:
 * an unused schema key is a different, lesser defect this test does not claim to catch.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const INDEX_TS = resolve(__dirname, "index.ts");

/** Top-level `FakeExecutorConfig` field names, read from the interface's own source — never a
 *  hand-typed restatement (that would have the same blind spot the bug did). A field is a line
 *  indented EXACTLY two spaces inside the interface body ending `name?:` or `name:`; a nested type
 *  literal's own fields (e.g. inside `rolloutByTarget`'s `Record<string, {...}>`) sit at four spaces
 *  or more, or share a line with the declaration, so they never match this pattern. */
function fakeExecutorConfigFields(): string[] {
  const source = readStripped(INDEX_TS);
  const start = source.indexOf("interface FakeExecutorConfig {");
  if (start === -1) {
    throw new Error("fakeExecutorConfigFields: `interface FakeExecutorConfig {` not found in index.ts");
  }
  const end = source.indexOf("\n}", start);
  if (end === -1) {
    throw new Error("fakeExecutorConfigFields: no closing `}` found for FakeExecutorConfig");
  }
  const body = source.slice(start, end);
  const fields: string[] = [];
  for (const line of body.split("\n")) {
    const m = /^ {2}(\w+)\??:/.exec(line);
    if (m) fields.push(m[1]!);
  }
  return fields;
}

/** Fields the server injects itself and a binding may never set — the one documented exemption. */
const SERVER_GOVERNED_FIELDS = new Set(["statePath"]);

describe("fake-executor: configSchema is not a step behind FakeExecutorConfig", () => {
  it("the interface parse actually found fields (not an empty, vacuously-passing list)", () => {
    const fields = fakeExecutorConfigFields();
    expect(fields.length).toBeGreaterThan(3);
    expect(fields).toContain("detailByTarget");
    expect(fields).toContain("statePath");
  });

  it("manifest.configSchema keeps additionalProperties:false (the gate this whole file assumes)", () => {
    const schema = manifest.configSchema as { additionalProperties?: unknown };
    expect(schema.additionalProperties).toBe(false);
  });

  it("EVERY tenant-facing FakeExecutorConfig field has a configSchema.properties entry", () => {
    const interfaceFields = fakeExecutorConfigFields().filter((f) => !SERVER_GOVERNED_FIELDS.has(f));
    const schema = manifest.configSchema as { properties?: Record<string, unknown> };
    const schemaKeys = new Set(Object.keys(schema.properties ?? {}));
    const missing = interfaceFields.filter((f) => !schemaKeys.has(f));
    expect(
      missing,
      "these FakeExecutorConfig fields have no configSchema.properties entry, so a tenant binding " +
        "naming them 400s despite the module doc calling the schema keys the tenant-facing surface: " +
        "add each to manifest.configSchema.properties (or to SERVER_GOVERNED_FIELDS with the same " +
        "reasoning as statePath, if it should stay server-only)"
    ).toStrictEqual([]);
  });
});
