import { sql } from "drizzle-orm";
import type { TenantTx } from "../db/tenant-tx.js";
import { forbidden } from "../errors.js";

/**
 * RBAC permission resolution (DESIGN.md §7). One recursive CTE does both expansions the design
 * calls for in the same query:
 *
 *  - **Subject expansion**: the acting subject (a `user`/`service-account` graph object) plus
 *    every group/team it transitively belongs to via built-in `member_of` relationships.
 *  - **Scope (containment) expansion**: the target object plus every containing ancestor,
 *    walking `objects.domain_id` up to the org root (every object's chain terminates there —
 *    graph/objects-repo.ts defaults `domainId` to the org root object at creation time, so this
 *    walk never needs NULL special-casing beyond the root itself).
 *
 * `role_bindings` rows whose `(subject, scope)` pair matches either expansion, and whose role
 * grants the requested permission, are collected; an explicit `deny` at ANY matching scope wins
 * over any `allow` (deny-override, DESIGN.md §7). No matching binding at all is a default deny.
 * Both expansions are depth-limited to 10 (DESIGN.md §5's traversal bound, reused here).
 */
export type Permission =
  | "object:read"
  | "object:write"
  | "relationship:read"
  | "relationship:write"
  | "type_registry:read"
  | "type_registry:write"
  | "role_binding:write"
  | "graph:query"
  | "audit:read"
  | "org:admin"
  | "approval:write"
  // M4 governance (DESIGN.md §7's example role bindings name these exactly):
  | "policy:write"
  | "freeze:write"
  | "freeze:override"
  | "change:emergency"
  // M6 federation (DESIGN.md §13) — pairing/export/import/hand-fill vs read-only status/self.
  | "federation:read"
  | "federation:write";

export interface PermissionCheck {
  orgId: string;
  subjectObjectId: string;
  permission: Permission;
  /** The object whose containment chain is checked — usually the object being read/written. */
  scopeObjectId: string;
}

export async function hasPermission(tx: TenantTx, check: PermissionCheck): Promise<boolean> {
  const result = await tx.execute<{ effect: string }>(sql`
    WITH RECURSIVE subject_expand AS (
      SELECT ${check.subjectObjectId}::uuid AS subject_id, 0 AS depth
      UNION
      SELECT r.to_id, se.depth + 1
      FROM relationships r
      JOIN subject_expand se ON r.from_id = se.subject_id
      WHERE r.org_id = ${check.orgId} AND r.type_id = 'member_of' AND r.deleted_at IS NULL
        AND se.depth < 10
    ),
    scope_expand AS (
      SELECT ${check.scopeObjectId}::uuid AS scope_id, 0 AS depth
      UNION ALL
      SELECT o.domain_id, se.depth + 1
      FROM objects o
      JOIN scope_expand se ON o.id = se.scope_id
      WHERE o.domain_id IS NOT NULL AND se.depth < 10
    )
    SELECT DISTINCT rb.effect
    FROM role_bindings rb
    JOIN roles rl ON rl.id = rb.role_id
    WHERE rb.org_id = ${check.orgId}
      AND rb.subject_id IN (SELECT subject_id FROM subject_expand)
      AND rb.scope_object_id IN (SELECT scope_id FROM scope_expand)
      AND ${check.permission} = ANY(rl.permissions)
  `);

  const effects = result.rows.map((r) => r.effect);
  if (effects.includes("deny")) return false;
  return effects.includes("allow");
}

/** Throws 403 Forbidden (RFC 9457) when `hasPermission` would return false. */
export async function authorize(tx: TenantTx, check: PermissionCheck): Promise<void> {
  const allowed = await hasPermission(tx, check);
  if (!allowed) {
    throw forbidden(
      `subject '${check.subjectObjectId}' lacks '${check.permission}' at scope '${check.scopeObjectId}'`
    );
  }
}

export interface RoleCheck {
  orgId: string;
  subjectObjectId: string;
  /** Built-in or org-defined role NAME (e.g. 'Approver') — DESIGN §10.2's "N-of-M quorum from a
   *  role/group". Matched by name, not id, so both a built-in role and an org's own custom role
   *  sharing that name qualify (mirrors how `createTestUser`/route handlers already resolve
   *  roles by name elsewhere). */
  roleName: string;
  scopeObjectId: string;
}

/**
 * Approval-quorum eligibility (DESIGN §10.2, BUILD_AND_TEST.md §8 M4 "N-of-M can't be forged").
 * Structurally identical to `hasPermission`'s recursive CTE (same subject/scope expansion,
 * same deny-override) but matches on the BINDING'S ROLE NAME instead of a permission string —
 * "does this subject hold role R at-or-above this scope", independent of whatever permissions R
 * happens to grant. A SEPARATE query (not a `hasPermission` wrapper) because "holds role Approver"
 * and "has permission approval:write" are different questions: an org could grant 'approval:write'
 * to a broader custom role without that role being an eligible *quorum member* for a policy that
 * specifically names 'Approver'.
 */
export async function hasRoleAtScope(tx: TenantTx, check: RoleCheck): Promise<boolean> {
  const result = await tx.execute<{ effect: string }>(sql`
    WITH RECURSIVE subject_expand AS (
      SELECT ${check.subjectObjectId}::uuid AS subject_id, 0 AS depth
      UNION
      SELECT r.to_id, se.depth + 1
      FROM relationships r
      JOIN subject_expand se ON r.from_id = se.subject_id
      WHERE r.org_id = ${check.orgId} AND r.type_id = 'member_of' AND r.deleted_at IS NULL
        AND se.depth < 10
    ),
    scope_expand AS (
      SELECT ${check.scopeObjectId}::uuid AS scope_id, 0 AS depth
      UNION ALL
      SELECT o.domain_id, se.depth + 1
      FROM objects o
      JOIN scope_expand se ON o.id = se.scope_id
      WHERE o.domain_id IS NOT NULL AND se.depth < 10
    )
    SELECT DISTINCT rb.effect
    FROM role_bindings rb
    JOIN roles rl ON rl.id = rb.role_id
    WHERE rb.org_id = ${check.orgId}
      AND rb.subject_id IN (SELECT subject_id FROM subject_expand)
      AND rb.scope_object_id IN (SELECT scope_id FROM scope_expand)
      AND rl.name = ${check.roleName}
  `);

  const effects = result.rows.map((r) => r.effect);
  if (effects.includes("deny")) return false;
  return effects.includes("allow");
}
