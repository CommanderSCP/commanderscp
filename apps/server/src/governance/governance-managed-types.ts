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
 */
export const GOVERNANCE_MANAGED_OBJECT_TYPE_IDS: ReadonlySet<string> = new Set(["policy", "control"]);

export function isGovernanceManagedObjectType(typeId: string): boolean {
  return GOVERNANCE_MANAGED_OBJECT_TYPE_IDS.has(typeId);
}
