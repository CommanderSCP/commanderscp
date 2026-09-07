import { createHash } from "node:crypto";
// Named import (not `import Ajv from "ajv"`) — ajv's CJS output + `moduleResolution: NodeNext`
// otherwise resolves the default import to the module namespace rather than the class, which
// TS then (correctly) refuses to `new` (a well-known ajv8/NodeNext interop gotcha).
import { Ajv } from "ajv";
import type { ValidateFunction } from "ajv";
import { badRequest } from "../errors.js";

/** Validates properties against the type's registered schema. See docs/graph.md §150. */
const CACHE_LIMIT = 256;

let ajv = new Ajv({ allErrors: true, strict: false });
let cache = new Map<string, ValidateFunction>();

function compiledValidator(schema: unknown): ValidateFunction {
  const key = createHash("sha256").update(JSON.stringify(schema)).digest("hex");
  const cached = cache.get(key);
  if (cached) return cached;

  // BOUNDED, and the Ajv instance is replaced rather than kept. See docs/graph.md §151.
  if (cache.size >= CACHE_LIMIT) {
    ajv = new Ajv({ allErrors: true, strict: false });
    cache = new Map();
  }

  const validate = ajv.compile(schema as object);
  cache.set(key, validate);
  return validate;
}

/** Throws unless properties satisfy the schema; null allows all. See docs/graph.md §152. */
export function validateProperties(propertySchema: unknown, properties: unknown): void {
  if (propertySchema === null || propertySchema === undefined) return;
  const validate = compiledValidator(propertySchema);
  const valid = validate(properties);
  if (!valid) {
    const detail = (validate.errors ?? [])
      .map((e) => `${e.instancePath || "/"} ${e.message ?? "invalid"}`)
      .join("; ");
    throw badRequest(`properties failed JSON Schema validation: ${detail}`);
  }
}
