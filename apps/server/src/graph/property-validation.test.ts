import { describe, expect, it } from "vitest";
import { validateProperties } from "./property-validation.js";
import { ProblemError } from "../errors.js";

/**
 * Unit cover for `validateProperties`' content-addressed cache. The behaviour that matters most —
 * a `property_schema` edit reaching a LIVE process — is proved end to end in
 * `property-schema-live-edit.integration.test.ts` through the real HTTP write path, because that is
 * the only shape that can prove it (see that file's header). What is left for a unit test is the
 * part the integration test cannot reach in reasonable time: the bounded-cache reset branch.
 *
 * That branch exists for a deployment with more distinct schemas than `CACHE_LIMIT`, which no
 * normal estate hits — so without this test it would be a code path that ships unexercised, which
 * is the same defect class this whole change is about.
 */

/**
 * Asserts the write was REFUSED, and returns the refusal so a caller can inspect it.
 *
 * Deliberately keys on the 400 status rather than on the message: `badRequest` builds a
 * `ProblemError` whose `.message` is the generic title "Bad Request" and whose `.detail` carries
 * the Ajv text, so a `toThrow(/JSON Schema/)` matcher passes vacuously against `.message` — it
 * would go green for a refusal thrown by something else entirely.
 */
function expectRefused(schema: unknown, properties: unknown): ProblemError {
  let caught: unknown;
  try {
    validateProperties(schema, properties);
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(ProblemError);
  const problem = caught as ProblemError;
  expect(problem.status).toBe(400);
  return problem;
}

describe("validateProperties: content-addressed compiled-validator cache", () => {
  it("a null/undefined schema is unconstrained", () => {
    expect(() => validateProperties(null, { anything: 1 })).not.toThrow();
    expect(() => validateProperties(undefined, { anything: 1 })).not.toThrow();
  });

  it("enforces the schema it is handed, not one it saw earlier for the same data", () => {
    const loose = { type: "object", properties: { a: { type: "string" } } };
    const strict = { type: "object", properties: { a: { type: "string" } }, required: ["a"] };

    expect(() => validateProperties(loose, {})).not.toThrow();
    // Same data, stricter schema, same process, no invalidation call anywhere.
    expectRefused(strict, {});
    // ...and back again: the loose validator is still correct and still cached.
    expect(() => validateProperties(loose, {})).not.toThrow();
  });

  it("a schema passed as a NEW object each time is still cached (jsonb yields fresh objects)", () => {
    // The production callers hand over a freshly-parsed jsonb value on every call, so a cache
    // keyed on object identity would never hit. Structural equality must be what counts.
    for (let i = 0; i < 50; i++) {
      const fresh = JSON.parse('{"type":"object","required":["x"]}') as unknown;
      expect(() => validateProperties(fresh, { x: 1 })).not.toThrow();
      expectRefused(fresh, {});
    }
  });

  it("stays correct across the bounded-cache reset (more distinct schemas than CACHE_LIMIT)", () => {
    // CACHE_LIMIT is 256; 600 distinct schemas forces at least two resets, which also replace the
    // Ajv instance. Validation must be unaffected — before, during and after.
    const first = { type: "object", properties: { k0: { type: "string" } }, required: ["k0"] };
    expect(() => validateProperties(first, { k0: "v" })).not.toThrow();

    for (let i = 0; i < 600; i++) {
      const schema = {
        type: "object",
        properties: { [`k${i}`]: { type: "string" } },
        required: [`k${i}`]
      };
      expect(() => validateProperties(schema, { [`k${i}`]: "v" })).not.toThrow();
      expectRefused(schema, {});
    }

    // The very first schema was evicted by a reset long ago. It must recompile and still be right,
    // rather than throwing on valid data or silently passing everything.
    expect(() => validateProperties(first, { k0: "v" })).not.toThrow();
    expectRefused(first, {});
  });

  it("names the offending property path in the refusal detail", () => {
    const schema = { type: "object", properties: { n: { type: "number" } } };
    const problem = expectRefused(schema, { n: "not-a-number" });
    expect(problem.detail).toContain("/n");
  });
});
