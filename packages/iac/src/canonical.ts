/**
 * Deterministic JSON serialization (recursively sorted object keys). This is what makes
 * `app.synth()`/`stack.synth()` produce byte-identical JSON across independent synths even when
 * caller-supplied `properties`/`labels` objects were built with different key insertion order —
 * plain `JSON.stringify` alone is NOT enough for that (goal statement's determinism requirement).
 *
 * NO LONGER AN IMPLEMENTATION — a re-export of the single canonicalizer in
 * `@scp/schemas/canonical-json`. This file used to carry its own byte-for-byte copy, "vendored
 * here for the same `no @scp/server dependency` reason as `urn.ts`"; that reason was real but the
 * copy was not needed, because `@scp/schemas` is already a dependency of this package AND of
 * `apps/server`, so it is a legal shared home for a pure helper. The vendoring is what let one
 * defect (a dropped `__proto__` subtree, silently absent from the canonical form) live in five
 * places at once. Import path kept stable for this package's callers.
 */
export { canonicalJson } from "@scp/schemas/canonical-json";
