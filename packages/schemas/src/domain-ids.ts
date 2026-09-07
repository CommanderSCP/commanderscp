/** Branded domain-id types. See docs/schemas.md §175. */

declare const trustDomainIdBrand: unique symbol;
declare const containmentDomainIdBrand: unique symbol;

/** The stable identity of a **security domain**. See docs/schemas.md §176. */
export type TrustDomainId = string & { readonly [trustDomainIdBrand]: true };

/** The id of **the containment parent. See docs/schemas.md §177. */
export type ContainmentDomainId = string & { readonly [containmentDomainIdBrand]: true };

/** Assert that an unbranded string is a **trust**. See docs/schemas.md §178. */
export function asTrustDomainId(id: string): TrustDomainId {
  return id as TrustDomainId;
}

/** Assert that an unbranded string is a **containment-sense** id. See docs/schemas.md §179. */
export function asContainmentDomainId(id: string): ContainmentDomainId {
  return id as ContainmentDomainId;
}
