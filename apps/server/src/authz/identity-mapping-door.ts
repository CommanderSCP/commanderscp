import { and, eq, sql } from "drizzle-orm";
import type { TenantTx } from "../db/tenant-tx.js";
import { roleBindings, roles } from "../db/schema.js";
import { forbidden } from "../errors.js";
import { externalIdentityOf } from "../auth/identity-sync.js";
import { missingPermissionsFor } from "./role-binding-door.js";
import { hasPermission } from "./resolve.js";

/** THE IdP MAPPING DOOR. See docs/authz.md §1. */
export async function assertMayWriteIdentityMapping(
  tx: TenantTx,
  check: {
    orgId: string;
    actorObjectId: string;
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

/** Is this write introducing or changing a mapping? See docs/authz.md §2. */
export function identityMappingChanged(before: unknown, after: unknown): boolean {
  const a = externalIdentityOf(before);
  const b = externalIdentityOf(after);
  if (a === null && b === null) return false;
  if (a === null || b === null) return true;
  return a.claimValue !== b.claimValue;
}
