import type { TenantTx } from "../db/tenant-tx.js";
import { hasPermission, type Permission } from "./resolve.js";

/**
 * ================================================================================================
 * THE ORG-ROOT ARM — the one definition of "at the org root **OR** at the object this door governs"
 * ================================================================================================
 *
 * Increment 2.5a (docs/proposals/role-model.md §8.7) re-scopes get-by-id doors off
 * `scopeObjectId: auth.orgId` and onto the object each one actually governs, because
 * `authz/resolve.ts`'s `scopeExpandCte` expands UPWARD only: a check pinned at the org root is
 * satisfiable by an ORG-ROOT binding and by nothing else, so a ServiceAdmin or ComponentAdmin could
 * hold `object:read` and still be refused the thing they administer.
 *
 * THAT RE-SCOPE MUST BE A PURE WIDENING — every request that succeeded against the org-root pin
 * must still succeed, identically. Checking at the governed object ALONE is not that, and this
 * helper exists because working out why takes a paragraph that must not be re-derived per door.
 *
 * ------------------------------------------------------------------------------------------------
 * WHY THE SCOPED ARM IS NOT ENOUGH: `scopeExpandCte` IS LIVENESS-BLIND ONLY ON ITS SEED
 * ------------------------------------------------------------------------------------------------
 *   - the seed row is raw — `SELECT ${scopeObjectId}::uuid AS scope_id, 0 AS depth`, no lookup and
 *     no filter — so a SOFT-DELETED object does still seed the walk;
 *   - but every ANCESTOR is joined `JOIN objects parent_o ON … AND parent_o.deleted_at IS NULL`
 *     (`resolve.ts`), so the chain is CUT at the first tombstoned ancestor. `scope_expand` then
 *     collapses to the seed alone, which matches NO binding at all — the org-root Owner's included.
 *
 * That state is reachable through ordinary API calls, not hypothetical. `deleteObject`'s orphan
 * guard counts children with `isNull(objects.deletedAt)` (`graph/objects-repo.ts`), so a service
 * whose components are already soft-deleted has no LIVE children and is itself deletable, and then
 * so is its domain. Three ordinary DELETEs later, any door that scopes at one of those tombstoned
 * ids refuses everybody. Two in-tree paths reach exactly that:
 *
 *   - a change's `properties.targets` are read back VERBATIM and deliberately never re-resolved
 *     (re-resolving would 404 "cancel the release against the component we just removed"), so a
 *     target may be a tombstone whose parents have since gone too;
 *   - a component merge (M12 P5d, `docs/proposals/organize-after.md` §2.4/§4) soft-deletes the
 *     loser and deliberately does NOT re-point its `source_mappings`, stranding rows whose
 *     component the `DELETE /change-sources/{kind}/mappings` door exists to clean up.
 *
 * ------------------------------------------------------------------------------------------------
 * WHY THE ORG-ROOT ARM IS TRIED FIRST
 * ------------------------------------------------------------------------------------------------
 * The org-root arm IS the pre-2.5a behaviour, so evaluating it first makes "everything that worked
 * before still works" independent of anything the scoped object's chain does — including a `deny`
 * bound below the org root, which the org-root pin never consulted and which this increment
 * therefore must not start honouring (a narrowing nobody decided).
 *
 * It matters beyond tidiness, because `hasPermission` does not always return: ADR-0037's truncation
 * probe THROWS `walkDepthExceeded` on a refusal it cannot trust, and an arm that throws cannot be
 * fallen through from. The SCOPE side of that probe can never fire on the org-root arm — expanding
 * from the org root produces a single depth-0 row.
 *
 * THE SUBJECT SIDE IS A DIFFERENT STORY, AND ORDER IS NOT NEUTRAL THERE. `assertDenyNotTruncated`
 * re-walks the subject's `member_of` chain too, so a subject nested more than
 * `WALK_TRUNCATION_PROBE_DEPTH` groups deep makes WHICHEVER ARM RUNS FIRST throw — pre-empting the
 * other arm, which might have granted. The disjunction is therefore not order-independent; what
 * ordering the org-root arm first buys is that the throw happens on exactly the check the door
 * already ran before 2.5a, so the outcome for a deep subject is byte-identical to today's rather
 * than merely similar.
 *
 * ------------------------------------------------------------------------------------------------
 * WHY IT RETURNS A VERDICT INSTEAD OF THROWING
 * ------------------------------------------------------------------------------------------------
 * `hasPermission` rather than `authorize` on every arm, for the fall-through reason above, and the
 * 403 is the CALLER'S to throw: each door names its own object ("at the org root and at
 * source-mapping component X", "at any target of change Y") and a message assembled here would have
 * to be generic on exactly the noun an operator needs. {@link OrgRootOrScopedVerdict} carries back
 * the one fact a caller cannot recompute — which scope failed an `"every"` arm — so a write door's
 * refusal can still name the single target the actor lacks standing on.
 *
 * ------------------------------------------------------------------------------------------------
 * WHAT THIS IS NOT FOR
 * ------------------------------------------------------------------------------------------------
 * A bar that was ADDED beside an org-root check rather than replacing one (the two
 * `routes/federation.ts` overlay doors) is a CONJUNCTION, not a disjunction: giving it an org-root
 * arm would make it inert, because everything reaching it has already cleared an org-root check.
 * Composing this helper there would silently delete a bar. See the block above those two doors.
 *
 * AND THE PURE-WIDENING INVARIANT ABOVE DOES NOT REACH THOSE DOORS EITHER, which is the reason the
 * paragraph above is a refusal rather than a TODO. This helper's invariant is written for a
 * RE-SCOPE — a check that moved off the org root and must still admit everyone it used to. Adding a
 * second bar is the opposite act, a deliberate narrowing, and by construction it refuses some of
 * the principals the single bar admitted; that is what a bar is. Measuring a tightening against a
 * widening invariant is a category error, and it produced one on this branch before it was named.
 * The consequence the overlay doors accept in exchange (a base with tombstoned ancestors is
 * unreachable to everyone until its chain is repaired) is stated at those doors and pinned by
 * `routes/federation-overlay-base-authority.integration.test.ts`.
 */

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
