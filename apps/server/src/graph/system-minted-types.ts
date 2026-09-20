/** Object types **no API door may create** — not because an authority owns them, but because an
 *  internal code path is the only thing that legitimately mints one.
 *
 *  This is a different rule from `GOVERNANCE_MANAGED_OBJECT_TYPE_IDS`, which routes a caller to a
 *  TYPED door that enforces more than the generic one can. These types have no typed door and are
 *  not meant to: the answer is "you do not create this", not "create it elsewhere".
 *
 *  Deliberately NOT enforced in the repo layer. `federation/import-repo.ts`'s `object_upsert`
 *  branch must keep accepting a peer's copy of one of these — a refusal there would abort the
 *  peer's entire signed bundle, and a system-minted object at the ORIGIN is a perfectly ordinary
 *  federated object at a receiver. The rule belongs at the tenant-facing door only. */
export const SYSTEM_MINTED_OBJECT_TYPE_IDS: ReadonlySet<string> = new Set([
  /** The correlation GROUP. `coordination/correlation.ts`'s `linkToCoordinatedChange` finds one by
   *  `labels ->> 'correlationKey'` or mints it — so a tenant able to create one with a chosen key
   *  pre-seeds the lookup, and the next real correlation links into THEIR object. Same property as
   *  ADR-0034's: a decision keyed on something its own subject can write. The namespace fix does
   *  not apply here — `scp.governance/` demands org-root `policy:write` to write, which the server
   *  path itself would then fail, so the key stays an ordinary label and the MINTING is closed
   *  instead. Census instance 8.6 of docs/proposals/governance-label-namespace.md. */
  "coordinated-change"
]);

export function isSystemMintedObjectType(typeId: string): boolean {
  return SYSTEM_MINTED_OBJECT_TYPE_IDS.has(typeId);
}
