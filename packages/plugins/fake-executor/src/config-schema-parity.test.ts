import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readStripped } from "@scp/source-census";
import { manifest } from "./index.js";

/** THE `detailByTarget` GAP, MADE A GATE. See docs/plugins.md §57. */

const __dirname = dirname(fileURLToPath(import.meta.url));
const INDEX_TS = resolve(__dirname, "index.ts");

/** Field names read from the interface's own source. See docs/plugins.md §58. */
function fakeExecutorConfigFields(): string[] {
  const source = readStripped(INDEX_TS);
  const start = source.indexOf("interface FakeExecutorConfig {");
  if (start === -1) {
    throw new Error(
      "fakeExecutorConfigFields: `interface FakeExecutorConfig {` not found in index.ts"
    );
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
    const interfaceFields = fakeExecutorConfigFields().filter(
      (f) => !SERVER_GOVERNED_FIELDS.has(f)
    );
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
