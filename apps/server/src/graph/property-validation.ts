// Named import (not `import Ajv from "ajv"`) — ajv's CJS output + `moduleResolution: NodeNext`
// otherwise resolves the default import to the module namespace rather than the class, which
// TS then (correctly) refuses to `new` (a well-known ajv8/NodeNext interop gotcha).
import { Ajv } from "ajv";
import type { ValidateFunction } from "ajv";
import { badRequest } from "../errors.js";

/**
 * Validates instance `properties` against a registered type's `property_schema` (JSON Schema)
 * at write time (DESIGN.md §4.1 "instance properties validated against the registered JSON
 * Schema (Ajv) at write time"). One Ajv instance, per-schema compiled-validator cache — schemas
 * rarely change and compiling is the expensive part.
 */
const ajv = new Ajv({ allErrors: true, strict: false });
const cache = new Map<string, ValidateFunction>();

function compiledValidator(schema: unknown, cacheKey: string): ValidateFunction {
  const cached = cache.get(cacheKey);
  if (cached) return cached;
  const validate = ajv.compile(schema as object);
  cache.set(cacheKey, validate);
  return validate;
}

/** `cacheKey` should uniquely identify the schema (e.g. `${typeId}`) so edits invalidate it. */
export function validateProperties(
  propertySchema: unknown,
  properties: unknown,
  cacheKey: string
): void {
  if (propertySchema === null || propertySchema === undefined) return;
  const validate = compiledValidator(propertySchema, cacheKey);
  const valid = validate(properties);
  if (!valid) {
    const detail = (validate.errors ?? [])
      .map((e) => `${e.instancePath || "/"} ${e.message ?? "invalid"}`)
      .join("; ");
    throw badRequest(`properties failed JSON Schema validation: ${detail}`);
  }
}

/** Invalidate the compiled-validator cache for a type (e.g. after `property_schema` changes). */
export function invalidatePropertyValidatorCache(cacheKey: string): void {
  cache.delete(cacheKey);
}
