/**
 * Tiny vendored copy of `apps/server/src/graph/urn.ts`'s `slugify` — `@scp/iac` must not depend
 * on `@scp/server` (synth is pure and must work fully offline, including in CI/air-gap contexts
 * with no server checked out — goal statement), and `@scp/schemas` doesn't export a reusable
 * slugify/URN helper (checked `packages/schemas/src/index.ts`'s exports first). Duplicated
 * on purpose rather than imported; keep in sync with the server's version if its algorithm ever
 * changes (unlikely — pure string logic, no external behavior to drift from).
 */
export function slugify(input: string): string {
  const slug = input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug : "resource";
}

/**
 * Deterministic URN for a construct that doesn't specify an explicit `urn` prop, derived from
 * `(stack name, construct id)` ONLY (goal statement) — stable across repeated synths and
 * independent of construction order, which is exactly what lets two independently-built-but-
 * equivalent construct trees converge to byte-identical manifests.
 *
 * Deliberately a DIFFERENT scheme from the server's `deriveUrn` (graph/urn.ts, keyed by
 * `orgId`/name and used only when the generic API creates an object without an explicit `urn`):
 * synth is pure and offline, so it has no `orgId` to key off — it never calls the API (goal
 * statement). Using the stack name as the URN's "namespace" segment instead gives IaC-synthesized
 * URNs their own stable, collision-resistant, synth-time-computable identity; the org segment of
 * `UrnSchema`'s regex just needs to be SOME lowercase-alnum-dash token, not literally the real
 * org id — the server never re-derives or re-validates this segment's meaning, URNs are opaque
 * stable keys past that point (DESIGN.md §4.1).
 */
export function deriveConstructUrn(stackName: string, typeId: string, constructId: string): string {
  return `urn:scp:${slugify(stackName)}:${typeId}:${slugify(constructId)}`;
}
