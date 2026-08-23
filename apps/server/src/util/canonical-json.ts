/**
 * Deterministic JSON serialization (recursively sorted object keys) for content-equality checks
 * and signed payloads (`governance/attestation.ts`'s Ed25519 attestations).
 *
 * NO LONGER AN IMPLEMENTATION — a re-export of the single canonicalizer in
 * `@scp/schemas/canonical-json`, which is where the behaviour and the reasoning now live (read
 * that module's doc comment before changing anything here). This file survives only as a stable
 * import path: it exists in the first place to avoid a module-import cycle (M6's
 * `federation/journal-repo.ts` needs `governance/attestation.ts`'s `ensureInstanceKey` to sign
 * journal rows, and `graph/objects-repo.ts` needs `journal-repo.ts`'s `appendJournalEntry` — had
 * `attestation.ts` imported this helper FROM `objects-repo.ts`, that would close the cycle
 * objects-repo -> journal-repo -> attestation -> objects-repo), and a dozen call sites import it
 * from here.
 *
 * The four sibling copies of this helper that used to exist elsewhere in the repo all shared one
 * defect: canonicalization silently DROPPED any `__proto__` subtree, so two different payloads
 * hashed and signed identically. Collapsing them to one implementation is what makes that a
 * single fix rather than four — do not re-vendor it.
 */
export { canonicalJson } from "@scp/schemas/canonical-json";
