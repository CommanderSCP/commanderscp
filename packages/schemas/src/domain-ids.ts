/**
 * Branded domain-id types — [ADR-0021](../../../docs/adr/0021-terminology.md) D4, follow-on (i).
 *
 * `domainId` in this codebase carries **two structurally identical but semantically incompatible**
 * senses, both stored as plain `uuid`, historically with zero type-level separation:
 *
 * 1. **The trust / security-domain sense** — the federation identity of a whole SCP deployment:
 *    `federation_self.domainId`, `federation_peers.id`, every `peerDomainId`, every
 *    `originDomainId` (federation provenance), and `changes.importedFromDomain`. Per ADR-0021 D4
 *    the preferred prose term for this tier is **security domain** (CNSSI-4009); `TrustDomainId`
 *    keeps the established `trust domain (partition)` spelling of ADR-0016, which remains valid.
 * 2. **The containment sense** — `objects.domainId`, the ordinary intra-org `domain` **graph object
 *    type** sitting below org in the containment chain (org → containment domain → service →
 *    component). Nothing to do with trust.
 *
 * The two sat nine lines apart on the same `objects` table (`domainId` vs `originDomainId`), both
 * plain `uuid`, so passing one where the other was expected compiled cleanly. Branding makes that
 * collision **uncompilable** rather than a naming convention someone has to remember.
 *
 * ## A third thing wore the name — it was renamed, not branded
 *
 * `PluginContext` (`packages/plugin-api/src/index.ts`) used to carry a `domainId` that was neither
 * of the above: an opaque **plugin-host scope key**, populated in-tree with non-UUID literals
 * (`"default"`, `"commander"`, `"shared"`, `"domain-1"`). Branding it was impossible — it is not
 * an id — so on **2026-07-24** the owner decided to rename it instead: `PluginContext.domainId` is
 * now **`PluginContext.scopeKey`** (ADR-0021 D4), a deliberately unbranded plain `string`. Only
 * two senses of `domainId` remain in the tree, and both are branded here.
 *
 * ## Where the brand stops
 *
 * At the **API edge**. Zod request/response schemas and the generated SDK stay plain `string`, so
 * branding costs no `/v1` change and produces no codegen drift. Brands are erased at runtime — a
 * `TrustDomainId` *is* its string at every wire, SQL, and JSON boundary. The constructors below are
 * therefore pure identity functions; their only job is to mark the exact line where an unbranded
 * string was asserted to be one sense or the other, so those boundaries are greppable.
 *
 * ## The idiom
 *
 * `string & { readonly [brand]: true }` with a module-private `declare const … : unique symbol`.
 * `unique symbol` is only legal on a `const` declaration, so it cannot be written inline in the
 * type; the `declare const` is type-only and erases completely. Because the brand symbols are not
 * exported, no code outside this module can construct a branded value except through the
 * constructors — the nominal typing is genuine, not a convention.
 */

declare const trustDomainIdBrand: unique symbol;
declare const containmentDomainIdBrand: unique symbol;

/**
 * The stable identity of a **security domain** (trust tier / partition) in federation — the value
 * in `federation_self.domainId`, `federation_peers.id`, `peerDomainId`, `originDomainId`, and
 * `changes.importedFromDomain`. A UUIDv7, generated once per domain and never reused.
 */
export type TrustDomainId = string & { readonly [trustDomainIdBrand]: true };

/**
 * The id of a **containment domain** — a `domain` graph object, the ordinary intra-org grouping
 * below org in the containment chain. The value in `objects.domainId`. Never a federation identity.
 */
export type ContainmentDomainId = string & { readonly [containmentDomainIdBrand]: true };

/**
 * Assert that an unbranded string is a **trust** (security-domain) id. Use ONLY at a boundary where
 * the string demonstrably came from a trust-sense source: a wire/DB/JSON value, a validated request
 * field, a certificate SAN, or a freshly minted domain identity. Never use it to convert a
 * `ContainmentDomainId` — that is a real bug, not a typing inconvenience.
 */
export function asTrustDomainId(id: string): TrustDomainId {
  return id as TrustDomainId;
}

/**
 * Assert that an unbranded string is a **containment** domain-object id. Use ONLY at a boundary
 * where the string demonstrably came from a containment-sense source: a graph row, a validated
 * request field naming a `domain` object, or a resolved containment parent. Never use it to convert
 * a `TrustDomainId`.
 */
export function asContainmentDomainId(id: string): ContainmentDomainId {
  return id as ContainmentDomainId;
}
