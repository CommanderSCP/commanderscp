/**
 * Deterministic JSON serialization (recursively sorted object keys) for content-equality checks
 * and signed payloads (`governance/attestation.ts`'s Ed25519 attestations). Extracted to its own
 * module (rather than living in `graph/objects-repo.ts`, its original home) specifically to avoid
 * a module-import cycle: M6's `federation/journal-repo.ts` needs `governance/attestation.ts`
 * (`ensureInstanceKey`) to sign journal rows, and `graph/objects-repo.ts` needs
 * `federation/journal-repo.ts` (`appendJournalEntry`) — if `attestation.ts` still imported this
 * helper FROM `objects-repo.ts`, that would close a cycle:
 * objects-repo -> journal-repo -> attestation -> objects-repo.
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
