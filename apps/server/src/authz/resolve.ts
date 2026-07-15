import { sql } from "drizzle-orm";
import type { TenantTx } from "../db/tenant-tx.js";
import { forbidden } from "../errors.js";

/**
 * RBAC permission resolution (DESIGN.md §7). One recursive CTE does both expansions the design
 * calls for in the same query:
 *
 *  - **Subject expansion**: the acting subject (a `user`/`service-account` graph object) plus
 *    every group/team it transitively belongs to via built-in `member_of` relationships.
 *  - **Scope (containment) expansion**: the target object plus every containing ancestor, by two
 *    routes — `objects.domain_id` up to the org root (every object's chain terminates there —
 *    graph/objects-repo.ts defaults `domainId` to the org root object at creation time, so this
 *    walk never needs NULL special-casing beyond the root itself), AND the `contains` edge from a
 *    component to its service (migration 0021), which is what finally makes DESIGN §7's documented
 *    `component -> service -> domain -> organization` chain real. See `scopeExpandCte`.
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

/**
 * The scope (containment) expansion, shared by `hasPermission` and `hasRoleAtScope` so the two can
 * never drift — they answer different questions ("has permission P" vs "holds role R") but MUST agree
 * on what "at-or-above this scope" means, or an Approver bound at a service would be eligible for one
 * check and not the other.
 *
 * Walks the target object plus every containing ancestor, by TWO routes:
 *
 *  1. `objects.domain_id` — up to the org root (objects-repo.ts defaults `domainId` to the org root at
 *     creation, so every chain terminates there).
 *  2. `contains` — a component's SERVICE is a containing scope (migration 0021,
 *     docs/proposals/service-component-model.md). DESIGN §7 has always described the chain as
 *     `component -> service -> domain -> organization`; until 0021 there was no service edge to walk,
 *     so the documented behaviour did not exist. This is what makes a service-scoped role binding
 *     reach that service's components.
 *
 * The `contains` edge is registered service -> component, so it is walked BACKWARDS here
 * (`r.to_id` = the object being checked, `r.from_id` = its service). That asymmetry is the security
 * property: a binding at a SERVICE reaches its components, but a binding at a COMPONENT never reaches
 * the service (a service has no incoming `contains` edge), nor its sibling components.
 *
 * Both routes live in ONE recursive term via LATERAL: PostgreSQL permits the CTE self-reference
 * exactly once, so two recursive branches would error ("recursive reference ... more than once").
 * `UNION` (not `UNION ALL`) dedupes — with two routes the chain is a DAG, not a line (a component's
 * domain is reachable directly AND via its service), and dedupe is what keeps that from re-walking.
 */
function scopeExpandCte(orgId: string, scopeObjectId: string) {
  return sql`
    scope_expand AS (
      SELECT ${scopeObjectId}::uuid AS scope_id, 0 AS depth
      UNION
      SELECT p.parent_id, se.depth + 1
      FROM scope_expand se
      CROSS JOIN LATERAL (
        SELECT o.domain_id AS parent_id
        FROM objects o
        WHERE o.id = se.scope_id AND o.domain_id IS NOT NULL
        UNION ALL
        SELECT r.from_id
        FROM relationships r
        WHERE r.to_id = se.scope_id
          AND r.org_id = ${orgId}
          AND r.type_id = 'contains'
          AND r.deleted_at IS NULL
      ) p
      WHERE p.parent_id IS NOT NULL AND se.depth < 10
    )
  `;
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
    ${scopeExpandCte(check.orgId, check.scopeObjectId)}
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
    ${scopeExpandCte(check.orgId, check.scopeObjectId)}
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
