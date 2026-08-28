import { and, eq, sql } from "drizzle-orm";
import type { TenantTx } from "../db/tenant-tx.js";
import { roleBindings, roles } from "../db/schema.js";
import { forbidden } from "../errors.js";
import { externalIdentityOf } from "../auth/identity-sync.js";
import { missingPermissionsFor } from "./role-binding-door.js";
import { hasPermission } from "./resolve.js";

/**
 * ================================================================================================
 * THE IdP MAPPING DOOR — where the `member_of` subset rule's bar went
 * ================================================================================================
 *
 * `auth/identity-sync.ts` is exempt from the no-escalation subset rule on `member_of`, because a
 * login-time sync has no human actor to test. Owner decision (2026-08-28): move the bar here, to
 * the act that DOES have one — deciding that an IdP claim value means a particular SCP group.
 *
 * THE RULE. To set or change `externalIdentity.claimValue` on a group, the actor must:
 *
 *   1. hold `role_binding:write` AT THE ORG ROOT — mapping identity is an org-wide federation act,
 *      and there is no narrower object it belongs to; and
 *   2. for EVERY role binding the group currently holds, hold every permission that role carries
 *      AT THAT BINDING'S SCOPE — i.e. be someone who could have written that binding themselves.
 *
 * Rule 2 composes `missingPermissionsFor`, the SAME helper the grant door and the `member_of` choke
 * point use, so there is one definition of "a subset" across all three.
 *
 * ------------------------------------------------------------------------------------------------
 * WHY BOTH ENDS ARE BOUNDED, AND THE ORDER THAT MAKES IT WORK
 * ------------------------------------------------------------------------------------------------
 * There are two ways to arrive at "an IdP claim confers OrgAdmin", and both are gated:
 *
 *   MAP FIRST, BIND SECOND — the group is empty of bindings when mapped, so rule 2 is vacuous and
 *   the mapping is cheap. Binding OrgAdmin to it afterwards goes through `POST /role-bindings`,
 *   which applies the full subset rule to the BINDER. So the authority still cannot exceed a human
 *   who held it.
 *
 *   BIND FIRST, MAP SECOND — the group already carries OrgAdmin, and rule 2 refuses anyone who does
 *   not hold OrgAdmin. Without rule 2 this ordering would be the hole: a Viewer with
 *   `role_binding:write` could point a claim they control at a group somebody else made powerful.
 *
 * The reversed-ordering pair is exactly the shape `role-binding-door.ts` §2a/§2b had to be fixed for
 * twice, which is why it is enumerated here rather than assumed.
 *
 * ------------------------------------------------------------------------------------------------
 * WHAT THIS DOES *NOT* CLOSE, NAMED RATHER THAN IMPLIED
 * ------------------------------------------------------------------------------------------------
 * Whoever administers the identity provider can put anyone into a mapped group and thereby grant
 * whatever it carries, holding no SCP permission at all. No door here can change that: it is what
 * federating identity means. What this door ensures is that a HUMAN WITH THE MATCHING AUTHORITY
 * chose to delegate that decision to the directory, for that specific group.
 *
 * Nor does it re-check anything afterwards. A mapping authored today survives the author's own
 * revocation tomorrow — the same write-time-only property `role-binding-door.ts` §8 records for
 * bindings, and for the same reason: a read-time mirror would put ~20 permission probes on every
 * authorization.
 */
export async function assertMayWriteIdentityMapping(
  tx: TenantTx,
  check: {
    orgId: string;
    actorObjectId: string;
    /** The group/team being mapped. */
    subjectObjectId: string;
  }
): Promise<void> {
  if (
    !(await hasPermission(tx, {
      orgId: check.orgId,
      subjectObjectId: check.actorObjectId,
      scopeObjectId: check.orgId,
      permission: "role_binding:write"
    }))
  ) {
    throw forbidden(
      "mapping a group to an identity-provider claim requires 'role_binding:write' at the " +
        "organization root: it delegates to the provider the decision of who holds whatever this " +
        "group carries"
    );
  }

  // Every binding ON this group, with the permissions its role confers. `deleted_at` is not a
  // column on `role_bindings` — a revoke is a hard DELETE (drizzle/0097 granted it for exactly
  // that) — so every row read here is live.
  const bindings = await tx
    .select({
      scopeObjectId: roleBindings.scopeObjectId,
      roleName: roles.name,
      permissions: roles.permissions,
      effect: roleBindings.effect
    })
    .from(roleBindings)
    .innerJoin(roles, eq(roles.id, roleBindings.roleId))
    .where(
      and(
        eq(roleBindings.orgId, check.orgId),
        eq(roleBindings.subjectId, check.subjectObjectId),
        sql`${roleBindings.effect} = 'allow'`
      )
    );

  for (const binding of bindings) {
    const missing = await missingPermissionsFor(tx, {
      orgId: check.orgId,
      actorObjectId: check.actorObjectId,
      permissions: binding.permissions,
      scopeObjectId: binding.scopeObjectId
    });
    if (missing.length > 0) {
      throw forbidden(
        `this group holds '${binding.roleName}', and mapping it to an identity-provider claim ` +
          `would let the provider decide who receives that. You do not hold ` +
          `${missing.map((m) => `'${m}'`).join(", ")} at that binding's scope, so you could not ` +
          `have granted it yourself.`
      );
    }
  }
}

/**
 * Is this write introducing or changing a mapping?
 *
 * Compares the RESOLVED value on each side rather than the raw property, so that reformatting,
 * key reordering, or setting an unrelated sibling property is not treated as a mapping change and
 * does not demand authority the writer would not otherwise need. Removing a mapping IS a change —
 * it silently stops the directory managing a group, which an operator should have standing to do.
 */
export function identityMappingChanged(before: unknown, after: unknown): boolean {
  const a = externalIdentityOf(before);
  const b = externalIdentityOf(after);
  if (a === null && b === null) return false;
  if (a === null || b === null) return true;
  return a.claimValue !== b.claimValue;
}
