import {
  asContainmentDomainId,
  asTrustDomainId,
  type ContainmentDomainId,
  type ObjectListQuery,
  type TrustDomainId
} from "@scp/schemas";

/** THE WIRE BOUNDARY for branded domain ids. See docs/server.md §52. */

/** A `domainId` that names **the containment parent. See docs/server.md §53. */
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
