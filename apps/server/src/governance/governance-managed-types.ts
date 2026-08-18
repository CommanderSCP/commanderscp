/**
 * Object types the governance subsystem owns end to end (DESIGN §10.1/§10.2): `policy` documents
 * bind their DECLARED `properties.scope` to the author's own authority
 * (governance/policy-scope-authz.ts, CRITICAL #1b); `control` documents are the entries a policy's
 * `requireControls` effect can reference. Both are gated behind `policy:write` — never the generic
 * `object:write` every other typed resource uses (routes/typed-registries.ts's
 * `GOVERNANCE_TYPED_REGISTRY_RESOURCES`).
 *
 * Single source of truth for every write path that must special-case these types instead of
 * treating them like an ordinary graph object (security fast-follow after PR #9's adversarial
 * review found the generic `/objects/{type}` endpoint and the IaC plan/apply path both skipped
 * this entirely — a live governance bypass):
 *  - `routes/objects-generic.ts` refuses to create/update/delete these types at all, routing
 *    callers to the typed `/policies`/`/controls` resources instead.
 *  - `iac/plans-repo.ts` enforces the same `policy:write` permission (and, for `policy`, the same
 *    `assertPolicyScopeWithinAuthority` scope binding) a client-controlled manifest could
 *    otherwise use to plant an org-wide policy through `POST /plans` + `.../apply`.
 *
 * Adding a new governance-owned type later means updating this one set and re-checking the two
 * call sites above — not re-auditing every write path in the codebase from scratch.
 *
 * ===========================================================================================
 * THERE IS A THIRD WRITE PATH, AND THIS DOCBLOCK DID NOT ENUMERATE IT (M22.6, ADR-0033 §8)
 * ===========================================================================================
 * `federation/import-repo.ts`'s `object_upsert` branch reaches `createObject`/`updateObject` with a
 * free-form `typeId` and free-form `properties`, and it is NOT covered by either bullet above. That
 * is not a hole: it is a deliberate, narrow exemption whose reason is structural — that branch has NO
 * try/catch, so a throw there aborts the peer's ENTIRE signed bundle and wedges the channel. An
 * authoring-time refusal belongs at the AUTHORING instance; by the time a row arrives here it has
 * already been signature- and chain-verified, and `graph/objects-repo.ts` records who authored it.
 * The same reasoning is written out at length in `dependencies/subscription-guard-write-doors.
 * integration.test.ts`, and its census found `federationImport` set by exactly two modules —
 * `import-repo.ts` and `federation/handfill-repo.ts` — of which hand-fill is a LOCAL operator action
 * with no channel to wedge and therefore does NOT get the exemption.
 *
 * It is named here because the previous version of this docblock said "the two call sites above" and
 * a reader adding a fourth governance type would have gone looking for two doors and found three.
 * `governance-managed-write-doors.integration.test.ts` now enumerates every id in this set against
 * every door, so the count cannot silently go stale again.
 */
export const GOVERNANCE_MANAGED_OBJECT_TYPE_IDS: ReadonlySet<string> = new Set([
  "policy",
  "control",
  /**
   * M22.6 (ADR-0033 §6a) — a `scan_override_grant` is a standing, expiring authorization to TOLERATE
   * A KNOWN VULNERABILITY. Its `properties` carry the component it excuses, the finding, the tier
   * whose authority approved it and its expiry; a holder of plain `object:write` at that component
   * writing any of those directly would be granting themselves the waiver they are supposed to be
   * requesting. That is the identical shape `policy.properties.scope` has, so it gets the identical
   * treatment: refused on the generic `/objects/{type}` endpoint, and `policy:write` (not
   * `object:write`) through the IaC plan/apply path.
   *
   * The typed routes (`routes/scan-override-grants.ts`) are the only local authoring door, and they
   * split the permission the way D3 requires — `object:write` at the component to RAISE a request,
   * `policy:write` at the named tier object to APPROVE, deny or revoke one.
   */
  "scan_override_grant"
]);

export function isGovernanceManagedObjectType(typeId: string): boolean {
  return GOVERNANCE_MANAGED_OBJECT_TYPE_IDS.has(typeId);
}
