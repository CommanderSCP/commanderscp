/**
 * Deterministic JSON serialization (recursively sorted object keys) — the same discipline
 * `apps/server/src/graph/objects-repo.ts`'s `canonicalJson` uses for content-equality checks,
 * vendored here for the same "no `@scp/server` dependency" reason as `urn.ts`. This is what makes
 * `app.synth()`/`stack.synth()` produce byte-identical JSON across independent synths even when
 * caller-supplied `properties`/`labels` objects were built with different key insertion order —
 * plain `JSON.stringify` alone is NOT enough for that (goal statement's determinism requirement).
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === "object") {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
        return acc;
      }, {});
  }
  return value;
}
