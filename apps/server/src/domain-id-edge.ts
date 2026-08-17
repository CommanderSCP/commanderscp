import {
  asContainmentDomainId,
  asTrustDomainId,
  type ContainmentDomainId,
  type ObjectListQuery,
  type TrustDomainId
} from "@scp/schemas";

/**
 * THE WIRE BOUNDARY for branded domain ids — [ADR-0021](../../../docs/adr/0021-terminology.md) D4,
 * follow-on (i).
 *
 * `TrustDomainId` and `ContainmentDomainId` are branded inside the server so the two senses of
 * "domain" cannot be interchanged (see `packages/schemas/src/domain-ids.ts`). The brand deliberately
 * **stops at the wire**: `/v1` request and response schemas, the generated SDK, and the OpenAPI
 * document all keep plain `string`, so branding costs no API change and produces no codegen drift.
 *
 * That makes this module the boundary. Everything here takes an already-Zod-validated value that
 * crossed one of those plain-`string` schemas — a request body, a query parameter, an IaC manifest,
 * a stored plan diff read back — and asserts which sense it is. The assertion is a claim about the
 * SCHEMA FIELD, not about the string, and it is sound precisely because the field's declaring route
 * or document knows which sense it declared. Keeping every such assertion in one file makes the set
 * greppable and reviewable; scattering `as` casts through the handlers would not be.
 *
 * Brands erase at runtime, so all three functions are identity at the value level.
 */

/**
 * A `domainId` that names **the containment parent (any object; a domain in the common case)**.
 *
 * The parenthetical is load-bearing and is not a style choice: `objects.domain_id` is a bare `uuid`
 * with **no foreign key and no CHECK** (`apps/server/drizzle/0001_graph_core.sql:32`), and
 * `resolveContainmentParent` (`graph/objects-repo.ts`) validates only that the id names an object in
 * the same org — **no type filter**. Shipped tests deliberately pass a `service.id` and a
 * `component.id` (`governance/governance.integration.test.ts`,
 * `dependencies/subscription-authoring-guard.integration.test.ts:263`), and RBAC/policy/freeze scope
 * walks accept whatever chain results. Anything written against "this must be a `domain` object" is
 * a constraint the code does not have.
 *
 * `null`/`undefined` pass through unchanged — both are meaningful to `graph/objects-repo.ts`'s
 * `resolveDomainId` (`undefined` = default to the org root, `null` = this IS the org root).
 */
export function containmentDomainIdFromWire(
  value: string | null | undefined
): ContainmentDomainId | null | undefined {
  return value == null ? value : asContainmentDomainId(value);
}

/**
 * A `domainId` naming a **security domain** (federation identity) — the peer-pairing body, a
 * relay's onward peer, and anything else addressed at a federation partner.
 */
export function trustDomainIdFromWire(value: string): TrustDomainId;
export function trustDomainIdFromWire(value: string | undefined): TrustDomainId | undefined;
export function trustDomainIdFromWire(value: string | undefined): TrustDomainId | undefined {
  return value === undefined ? undefined : asTrustDomainId(value);
}

/**
 * The `?domainId=` list filter, re-branded in place. Written as a whole-query mapper rather than a
 * field one because every list route forwards `request.query` verbatim to `listObjects`.
 */
export function listObjectsQueryFromWire(
  query: ObjectListQuery
): Omit<ObjectListQuery, "domainId"> & { domainId?: ContainmentDomainId | undefined } {
  return { ...query, domainId: containmentDomainIdFromWire(query.domainId) ?? undefined };
}
