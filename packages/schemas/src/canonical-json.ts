/** THE canonical JSON serializer for this repo. See docs/schemas.md §52. */

/** Recursively key-sorted structural copy. See docs/schemas.md §53. */
export function canonicalizeDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeDeep);
  if (value !== null && typeof value === "object") {
    const src = value as Record<string, unknown>;
    // `Object.create(null)`, NOT `{}` — see this module's doc comment. On a `{}` accumulator the
    // write below would hit `Object.prototype`'s `__proto__` setter for that one key and store
    // nothing, silently dropping the subtree from the canonical form.
    const out = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(src).sort()) out[key] = canonicalizeDeep(src[key]);
    return out;
  }
  return value;
}

/** Deterministic JSON serialization. See docs/schemas.md §54. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalizeDeep(value));
}
