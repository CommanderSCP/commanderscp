/** HTTP request body-size ceilings. See docs/server.md §62. */
export const GLOBAL_BODY_LIMIT_BYTES = 4 * 1024 * 1024;
export const LARGE_BODY_LIMIT_BYTES = 64 * 1024 * 1024;

/**
 * Fastify/find-my-way's `maxParamLength` (default 100) is a router-level ceiling on ONE path
 * parameter SEGMENT's raw length, enforced BEFORE route matching — a Zod `params` schema never
 * gets a chance to run against an over-long segment. Every route whose param schema is
 * `RegistryIdOrUrnParamSchema` / `ObjectIdOrUrnParamSchema` / `RegistryUrnParamSchema` /
 * `ObjectUrnParamSchema` / `RegistryOwnerParamSchema` / `RegistryTargetParamSchema` /
 * `RungParamSchema` / `ObjectEnforcementParamSchema` / federation's inline overlay `idOrUrn` (42
 * route registrations, censused 2026-09-19 by grepping `params: <SchemaName>` with no filter
 * across apps/server/src/routes) can carry a percent-encoded object URN in that segment, so the
 * ceiling has to fit the LONGEST URN the schemas allow — derived below, not guessed.
 *
 * WORST CASE: a `placement` URN (graph/placements-repo.ts `derivePlacementUrn`) is the only URN
 * shape built from TWO independent object names rather than one:
 *
 *   urn:scp:{orgId}:placement:{slugify(componentName)}/{slugify(targetName)}
 *
 * Bounds, all from packages/schemas/src/graph.ts:
 *   - `orgId` is a UUID literal (deriveUrn/derivePlacementUrn are called with the org id, not a
 *     human slug — see graph/objects-repo.ts's `deriveUrn(input.orgId, ...)`): 36 chars.
 *   - `CreateObjectRequestSchema.name` / `UpsertObjectRequestSchema.name` (shared by every object
 *     type, including `component` and `deployment-target`): `z.string().min(1).max(500)`.
 *   - `slugify()` (graph/urn.ts) only ever SHRINKS its input — it lowercases and collapses every
 *     run of non `[a-z0-9]` characters to a single `-` — so 500 is also the ceiling on each slug.
 *
 * Unencoded worst case:
 *   "urn" + 4×":" + "scp" + orgId(36) + "placement"(9) + slug(<=500) + "/" + slug(<=500)
 *   = 3 + 4 + 3 + 36 + 9 + 500 + 1 + 500 = 1056 chars
 *
 * The generated SDK client (packages/sdk/src/generated/core/utils.gen.ts) builds path params with
 * `encodeURIComponent`, which escapes each of the URN's 4 colons and its one placement `/` as a
 * 3-char sequence (`%3A`, `%2F`) instead of 1 — +2 chars each, 5 occurrences. `slugify()`'s output
 * is pure `[a-z0-9-]`, which `encodeURIComponent` never escapes, so nothing else in the URN grows.
 *
 *   Encoded worst case = 1056 + 5*2 = 1066 chars
 *   Verified: node -e "console.log(encodeURIComponent(
 *     'urn:scp:' + '0'.repeat(36) + ':placement:' + 'a'.repeat(500) + '/' + 'b'.repeat(500)
 *   ).length)"  ->  1066
 *
 * Recompute this constant if `name`'s max length, `slugify()`'s character class, or the placement
 * URN shape ever change.
 */
export const URN_MAX_PARAM_LENGTH = 1066;
