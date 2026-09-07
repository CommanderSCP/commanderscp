import type { TenantTx } from "../db/tenant-tx.js";
import { hasPermission, type Permission } from "./resolve.js";

/** THE ORG-ROOT ARM. See docs/authz.md §25. */

/** ANY ONE of the scopes suffices (read doors), or EVERY one must (write doors). */
export type ScopedArmQuantifier = "any" | "every";

export interface OrgRootOrScopedCheck {
  orgId: string;
  subjectObjectId: string;
  /** The permission demanded on the WIDE arm, at the org root. Usually the same as
   *  {@link scopedPermission}; `assertDecisionReadable` deliberately differs (`audit:read` wide,
   *  `object:read` scoped) because its two arms answer different questions. */
  orgRootPermission: Permission;
  /** The permission demanded on the NARROW arm, at each of {@link scopeObjectIds}. */
  scopedPermission: Permission;
  quantifier: ScopedArmQuantifier;
  /** The objects the door governs. MAY be empty — an empty set never satisfies the narrow arm in
   *  either quantifier, so a caller with nothing to scope at falls back to the org-root arm alone
   *  rather than passing vacuously. */
  scopeObjectIds: readonly string[];
}

export type OrgRootOrScopedVerdict =
  | { ok: true }
  /** `refusedScopeObjectId` is the single scope that failed an `"every"` arm — so the caller's 403
   *  can name it, the way a bare `authorize()` at that scope would have. `null` when no one scope
   *  is to blame: an `"any"` arm where none matched, or an empty scope set. */
  | { ok: false; refusedScopeObjectId: string | null };

export async function checkAtOrgRootOrScopes(
  tx: TenantTx,
  check: OrgRootOrScopedCheck
): Promise<OrgRootOrScopedVerdict> {
  const atOrgRoot = await hasPermission(tx, {
    orgId: check.orgId,
    subjectObjectId: check.subjectObjectId,
    permission: check.orgRootPermission,
    scopeObjectId: check.orgId
  });
  if (atOrgRoot) return { ok: true };

  // Guarded explicitly rather than left to the loop: `every` over an empty array is vacuously TRUE
  // in JavaScript, and that shape here would be a total authorization bypass on a write door whose
  // target set turned out to be empty.
  if (check.scopeObjectIds.length === 0) return { ok: false, refusedScopeObjectId: null };

  for (const scopeObjectId of check.scopeObjectIds) {
    const allowed = await hasPermission(tx, {
      orgId: check.orgId,
      subjectObjectId: check.subjectObjectId,
      permission: check.scopedPermission,
      scopeObjectId
    });
    if (check.quantifier === "any") {
      if (allowed) return { ok: true };
    } else if (!allowed) {
      return { ok: false, refusedScopeObjectId: scopeObjectId };
    }
  }
  return check.quantifier === "every" ? { ok: true } : { ok: false, refusedScopeObjectId: null };
}
