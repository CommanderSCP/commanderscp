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
  // `typeId` is slugified too (round B addition, team-pipeline-iac.md D19/D24): every typeId round A
  // shipped ("service", "deployment-target", "release-topology", …) is already lowercase-with-
  // hyphens, so this is a no-op for all of them — `UrnSchema`'s type segment
  // (`[a-z0-9_-]+`, `@scp/schemas/graph.ts`) already matched. It stops being a no-op the moment a
  // typeId is NOT already slug-shaped, which round B's infra-product kinds are: `InfraKindSchema`
  // spells one of them `instanceGroup` (camelCase, matching the wire vocabulary's own spelling,
  // `pipeline-behaviors.ts`) — passing it through unslugified would derive an invalid URN
  // (`urn:scp:...:instanceGroup:...` fails the schema's lowercase-only type segment) despite every
  // other part of the URN being fine. The OBJECT's own `typeId` FIELD is never touched here — only
  // the URN's type segment, which has always been allowed to differ from a stored value elsewhere in
  // this scheme (the URN is an opaque stable key past construction, this file's own module doc).
  return `urn:scp:${slugify(stackName)}:${slugify(typeId)}:${slugify(constructId)}`;
}
