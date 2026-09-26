import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * THERE IS NO READ ROUTE FOR A CREDENTIAL (M29.5 DoD, ADR-0063) — a census over the WHOLE emitted
 * contract (`tools/openapi/openapi.v1.json`, what the SDK, CLI and UI are generated from), not over
 * the routes this increment wrote: a read path added anywhere later is a red build here.
 *
 *   1. the only request body anywhere that carries a credential `value` is `setStackCredential`;
 *   2. no RESPONSE schema of any operation carries a property that could hold a value — `value`,
 *      `plaintext`, `secretValue` — within the stack surface, and nowhere in the API does a response
 *      carry the sealed envelope except the controller's delivery list;
 *   3. the credential paths are exactly: list (metadata), set, delete — no GET of a key.
 *
 * The integration suite adds the runtime half: every stack read an operator can make, fetched after
 * a value is entered, does not contain it.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SPEC = JSON.parse(
  readFileSync(path.resolve(HERE, "../../../../tools/openapi/openapi.v1.json"), "utf8")
) as {
  paths: Record<string, Record<string, Operation>>;
  components?: { schemas?: Record<string, unknown> };
};

interface Operation {
  operationId?: string;
  requestBody?: { content?: Record<string, { schema?: unknown }> };
  responses?: Record<string, { content?: Record<string, { schema?: unknown }> }>;
}

const METHODS = ["get", "put", "post", "patch", "delete"] as const;

/** Every property name reachable in a schema, following local $refs, cycle-safe. */
function propertyNames(schema: unknown, seen = new Set<unknown>()): Set<string> {
  const out = new Set<string>();
  const walk = (s: unknown): void => {
    if (!s || typeof s !== "object" || seen.has(s)) return;
    seen.add(s);
    const o = s as Record<string, unknown>;
    if (typeof o["$ref"] === "string") {
      const name = (o["$ref"] as string).replace("#/components/schemas/", "");
      walk(SPEC.components?.schemas?.[name]);
    }
    if (o["properties"] && typeof o["properties"] === "object") {
      for (const [k, v] of Object.entries(o["properties"] as Record<string, unknown>)) {
        out.add(k);
        walk(v);
      }
    }
    for (const key of ["items", "additionalProperties", "not"]) walk(o[key]);
    for (const key of ["anyOf", "oneOf", "allOf", "prefixItems"]) {
      if (Array.isArray(o[key])) for (const x of o[key] as unknown[]) walk(x);
    }
  };
  walk(schema);
  return out;
}

const operations = Object.entries(SPEC.paths).flatMap(([p, ops]) =>
  METHODS.filter((m) => ops[m]).map((m) => ({ path: p, method: m, op: ops[m]! }))
);
const responseProps = (op: Operation) =>
  Object.values(op.responses ?? {}).flatMap((r) =>
    Object.values(r.content ?? {}).flatMap((c) => [...propertyNames(c.schema)])
  );
const requestProps = (op: Operation) =>
  Object.values(op.requestBody?.content ?? {}).flatMap((c) => [...propertyNames(c.schema)]);

const VALUE_HOLDERS = ["value", "plaintext", "secretValue"];

describe("M29.5: no route reads a credential back — a census over the whole contract", () => {
  it("finds the contract's operations (known-positive control)", () => {
    expect(operations.length).toBeGreaterThan(200);
    expect(operations.map((o) => o.op.operationId)).toContain("setStackCredential");
  });

  it("the census fires on a response that could carry a value (known-positive control)", () => {
    const fake: Operation = {
      responses: {
        "200": {
          content: {
            "application/json": {
              schema: { type: "object", properties: { key: {}, value: { type: "string" } } }
            }
          }
        }
      }
    };
    expect(responseProps(fake).filter((p) => VALUE_HOLDERS.includes(p))).toEqual(["value"]);
  });

  it("the only request body under the stack surface that carries a `value` is setStackCredential's", () => {
    const carriers = operations
      .filter((o) => o.path.startsWith("/instance/stack") && requestProps(o.op).includes("value"))
      .map((o) => o.op.operationId);
    expect(carriers).toEqual(["setStackCredential"]);
  });

  it("no response of any stack operation has a property that could hold a value", () => {
    const leaks = operations
      .filter((o) => o.path.startsWith("/instance/stack"))
      .flatMap((o) =>
        responseProps(o.op)
          .filter((p) => VALUE_HOLDERS.includes(p))
          .map((p) => `${o.method.toUpperCase()} ${o.path}: ${p}`)
      );
    expect(leaks).toEqual([]);
  });

  it("across the whole API, the sealed envelope is returned only by the controller's delivery list", () => {
    const carriers = operations
      .filter((o) => {
        const props = responseProps(o.op);
        return props.includes("envelope") && props.includes("epk") && props.includes("ciphertext");
      })
      .map((o) => o.op.operationId);
    expect(carriers).toEqual(["listStackCredentialDeliveries"]);
  });

  it("the credential paths are exactly list, set and delete — there is no GET of a key", () => {
    const routes = operations
      .filter((o) => /\/instance\/stack\/credentials/.test(o.path))
      .map((o) => `${o.method.toUpperCase()} ${o.path}`)
      .sort();
    expect(routes).toEqual([
      "DELETE /instance/stack/credentials/{backend}/{secretName}/{key}",
      "GET /instance/stack/credentials",
      "PUT /instance/stack/credentials/{backend}/{secretName}/{key}"
    ]);
  });
});
