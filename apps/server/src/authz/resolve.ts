import { sql } from "drizzle-orm";
import type { TenantTx } from "../db/tenant-tx.js";
import { forbidden } from "../errors.js";
import {
  CONTAINMENT_WALK_MAX_DEPTH,
  WALK_TRUNCATION_PROBE_DEPTH,
  placementParentsSql,
  walkDepthExceeded
} from "../graph/containment.js";

/** RBAC permission resolution. See docs/authz.md §50. */
/** THE PERMISSION CATALOGUE. See docs/authz.md §51. */
export const PERMISSIONS = [
  "object:read",
  "object:write",
  "relationship:read",
  "relationship:write",
  "type_registry:read",
  "type_registry:write",
  "role_binding:write",
  "graph:query",
  "audit:read",
  // `org:admin` lived here: granted, never demanded, removed. See docs/authz.md §52.
  "approval:write",
  // M4 governance (DESIGN.md §7's example role bindings name these exactly):
  "policy:write",
  "freeze:write",
  "freeze:override",
  "change:emergency",
  // M6 federation (DESIGN.md §13) — OPERATING the link (export/import/hand-fill/outposts/resync/
  // poke) vs read-only status/self. Pairing still requires `federation:write` and ALSO requires
  // `federation:pair` below, so `federation:write` alone no longer admits a peer.
  "federation:read",
  "federation:write",
  // THE SECOND BAR ON PAIRING. See docs/authz.md §53.
  "federation:pair",
  // The OPT-IN second bar on a containment MOVE. See docs/authz.md §54.
  "governance:move",
  // M25.6b (campaigns-rework §4.5, ADR-0042 §9). See docs/authz.md §55.
  "campaign:deadline-override",
  // THE THREE PERMISSION SPLITS. See docs/authz.md §56.

  // SUBSTITUTES `object:write` at the three CREDENTIAL doors. See docs/authz.md §57.
  "secret:write",
  // Added to, never substituted for, the existing `policy:write`. See docs/authz.md §58.
  "scan:override",
  // Added to, never substituted for, the existing `object:write`. See docs/authz.md §59.
  "change:accept"
] as const;

/**
 * One permission string. DERIVED from {@link PERMISSIONS} rather than declared beside it —
 * see that array's doc for why the runtime value has to exist at all.
 */
export type Permission = (typeof PERMISSIONS)[number];

export interface PermissionCheck {
  orgId: string;
  subjectObjectId: string;
  permission: Permission;
  /** The object whose containment chain is checked — usually the object being read/written. */
  scopeObjectId: string;
}

/** THE `member_of` CLOSURE. See docs/authz.md §60. */
type MemberOfWalkDirection = "member-to-groups" | "group-to-members";

function memberOfClosureCte(opts: {
  orgId: string;
  seedObjectId: string;
  cteName: string;
  columnName: string;
  direction: MemberOfWalkDirection;
  maxDepth: number;
}) {
  const cte = sql.raw(opts.cteName);
  const column = sql.raw(opts.columnName);
  const step =
    opts.direction === "member-to-groups"
      ? sql`SELECT r.to_id, w.depth + 1 FROM relationships r JOIN ${cte} w ON r.from_id = w.${column}`
      : sql`SELECT r.from_id, w.depth + 1 FROM relationships r JOIN ${cte} w ON r.to_id = w.${column}`;
  return sql`
    ${cte} AS (
      SELECT ${opts.seedObjectId}::uuid AS ${column}, 0 AS depth
      UNION
      ${step}
      WHERE r.org_id = ${opts.orgId} AND r.type_id = 'member_of' AND r.deleted_at IS NULL
        AND w.depth < ${opts.maxDepth}
    )
  `;
}

/** THE `member_of` SUBJECT EXPANSION. See docs/authz.md §61. */
export function subjectExpandCte(
  orgId: string,
  subjectObjectId: string,
  // ADR-0037: the shared bound by default; the truncation PROBE passes one-past-the-bound so a deny
  // can be told apart from a walk that was cut. Callers other than the probe never override.
  maxDepth: number = CONTAINMENT_WALK_MAX_DEPTH
) {
  return memberOfClosureCte({
    orgId,
    seedObjectId: subjectObjectId,
    cteName: "subject_expand",
    columnName: "subject_id",
    direction: "member-to-groups",
    maxDepth
  });
}

/** THE INVERSE WALK. See docs/authz.md §62. */
export function memberExpandCte(
  orgId: string,
  groupObjectId: string,
  maxDepth: number = CONTAINMENT_WALK_MAX_DEPTH
) {
  return memberOfClosureCte({
    orgId,
    seedObjectId: groupObjectId,
    cteName: "member_expand",
    columnName: "member_id",
    direction: "group-to-members",
    maxDepth
  });
}

/** The scope expansion both resolvers share, so they cannot drift. See docs/authz.md §63. */
function scopeExpandCte(
  orgId: string,
  scopeObjectId: string,
  // ADR-0037: the shared bound by default; the truncation PROBE passes one-past-the-bound so a
  // deny can be told apart from a walk that was cut. Callers other than the probe never override.
  maxDepth: number = CONTAINMENT_WALK_MAX_DEPTH
) {
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
        UNION ALL
        ${placementParentsSql(orgId, sql`se.scope_id`)}
      ) p
      -- A DELETED ancestor grants nothing. Kept in step with graph/containment.ts's identical
      -- filter: a role bound at a service that was later deleted must stop reaching that service's
      -- live components. deleteObject's edge cascade cannot cover replica edges or rows already in
      -- the database, so this is the backstop for both.
      JOIN objects parent_o
        ON parent_o.id = p.parent_id
       AND parent_o.org_id = ${orgId}
       AND parent_o.deleted_at IS NULL
      -- The SAME bound graph/containment.ts's walk uses, imported rather than re-typed: these two
      -- walks are hand-synced on their routes (see the header), and a bound that drifted would let
      -- a scope be governed at a depth authority cannot reach. The member_of SUBJECT walks below
      -- are a different concept and keep their own literal. ADR-0037: the truncation PROBE passes
      -- one-past-the-bound through maxDepth; nothing else overrides it.
      -- (No backticks in this comment: it lives inside a JS template literal.)
      -- sql.raw, not a bound parameter: an untyped $n compared against a recursive CTE's derived
      -- depth column is where PostgreSQL cannot infer a type. maxDepth is a module constant either
      -- way, never caller input.
      WHERE p.parent_id IS NOT NULL AND se.depth < ${sql.raw(String(maxDepth))}
    )
  `;
}

/** The truncation probe runs only on deny, and why. See docs/authz.md §64. */
async function assertDenyNotTruncated(
  tx: TenantTx,
  orgId: string,
  subjectObjectId: string,
  scopeObjectId: string,
  denialOf: string
): Promise<void> {
  const result = await tx.execute<{ kind: string }>(sql`
    WITH RECURSIVE ${subjectExpandCte(orgId, subjectObjectId, WALK_TRUNCATION_PROBE_DEPTH)},
    ${scopeExpandCte(orgId, scopeObjectId, WALK_TRUNCATION_PROBE_DEPTH)}
    (SELECT 'subject' AS kind FROM subject_expand WHERE depth >= ${WALK_TRUNCATION_PROBE_DEPTH} LIMIT 1)
    UNION ALL
    (SELECT 'scope' AS kind FROM scope_expand WHERE depth >= ${WALK_TRUNCATION_PROBE_DEPTH} LIMIT 1)
  `);
  const truncated = result.rows.map((r) => r.kind);
  if (truncated.length > 0) {
    throw walkDepthExceeded(
      truncated.includes("scope")
        ? `the containment chain above scope '${scopeObjectId}'`
        : `the member_of chain above subject '${subjectObjectId}'`,
      `${denialOf} was refused, but the refusal cannot be trusted: a grant may exist beyond the ` +
        `bound. Flatten the nesting, or bind the role nearer the scope.`
    );
  }
}

export async function hasPermission(tx: TenantTx, check: PermissionCheck): Promise<boolean> {
  const result = await tx.execute<{ effect: string }>(sql`
    WITH RECURSIVE ${subjectExpandCte(check.orgId, check.subjectObjectId)},
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
  if (effects.includes("allow")) return true;
  // ADR-0037: no binding reached at all — the one outcome a truncated walk can fabricate.
  // (An explicit deny above is a REAL binding that was reached; only the nothing-found case is
  // converted. Every caller inherits this, which is the point: false-by-depth must not exist.)
  await assertDenyNotTruncated(
    tx,
    check.orgId,
    check.subjectObjectId,
    check.scopeObjectId,
    `'${check.permission}'`
  );
  return false;
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

/** Approval-quorum eligibility, resolved by role name. See docs/authz.md §65. */
export async function hasRoleAtScope(tx: TenantTx, check: RoleCheck): Promise<boolean> {
  const result = await tx.execute<{ effect: string }>(sql`
    WITH RECURSIVE ${subjectExpandCte(check.orgId, check.subjectObjectId)},
    ${scopeExpandCte(check.orgId, check.scopeObjectId)}
    SELECT DISTINCT rb.effect
    FROM role_bindings rb
    JOIN roles rl ON rl.id = rb.role_id
    WHERE rb.org_id = ${check.orgId}
      AND rb.subject_id IN (SELECT subject_id FROM subject_expand)
      AND rb.scope_object_id IN (SELECT scope_id FROM scope_expand)
      AND rl.name = ${check.roleName}
      -- ===========================================================================================
      -- THE QUORUM BYPASS THIS CLOSES (role-model.md §5 step 10's gate; owner decision 2026-08-27)
      -- ===========================================================================================
      -- WITHOUT THIS PREDICATE, a role NAME resolved to any row RLS would show, and roles' policy
      -- is USING (org_id = current_org OR org_id IS NULL) — so the join matched the shared
      -- built-in Approver OR an org's own row of the same name, while the role_bindings half
      -- was org-filtered all along. An org able to author a ZERO-PERMISSION role named 'Approver'
      -- would therefore make its holders eligible quorum voters everywhere a policy names Approver:
      -- a self-service quorum bypass, granting nothing and deciding everything.
      --
      -- It was LATENT rather than live, and only because there is no custom-role authoring API —
      -- which is exactly why role-model.md gates step 10 behind closing this first. Shipping
      -- authoring without this predicate would have converted a documented hazard into a live one
      -- in the same release.
      --
      -- THE RULE, OWNER-DECIDED: a policy's fromRole always means the BUILT-IN. Custom roles may
      -- carry permissions and may be bound, and can never satisfy an approval quorum. The rejected
      -- alternative was "the org's own row shadows the built-in", which is the intuitive reading
      -- and narrows the bypass rather than closing it — an org would still decide what its own
      -- quorum means, which is the property that made this exploitable. routes/governance.ts
      -- validates fromRole against the built-in catalogue at AUTHORING time so a policy naming a
      -- custom role is refused where it is written, rather than silently never being satisfiable.
      AND rl.org_id IS NULL
  `);

  const effects = result.rows.map((r) => r.effect);
  if (effects.includes("deny")) return false;
  if (effects.includes("allow")) return true;
  // ADR-0037, same conversion as hasPermission: a quorum member silently vanishing because the
  // walk was cut is a quorum that fails mysteriously; erroring here fails the gate closed AND
  // says why.
  await assertDenyNotTruncated(
    tx,
    check.orgId,
    check.subjectObjectId,
    check.scopeObjectId,
    `role '${check.roleName}' at scope`
  );
  return false;
}

/** Effective permissions at one object, in one round trip. See docs/authz.md §66. */
export async function effectivePermissions(
  tx: TenantTx,
  check: { orgId: string; subjectObjectId: string; scopeObjectId: string }
): Promise<string[]> {
  const result = await tx.execute<{ permission: string; denied: boolean; allowed: boolean }>(sql`
    WITH RECURSIVE ${subjectExpandCte(check.orgId, check.subjectObjectId)},
    ${scopeExpandCte(check.orgId, check.scopeObjectId)}
    SELECT p AS permission,
           bool_or(rb.effect = 'deny') AS denied,
           bool_or(rb.effect = 'allow') AS allowed
    FROM role_bindings rb
    JOIN roles rl ON rl.id = rb.role_id
    CROSS JOIN LATERAL unnest(rl.permissions) AS p
    WHERE rb.org_id = ${check.orgId}
      AND rb.subject_id IN (SELECT subject_id FROM subject_expand)
      AND rb.scope_object_id IN (SELECT scope_id FROM scope_expand)
    GROUP BY p
  `);

  const held = result.rows
    .filter((r) => r.allowed && !r.denied)
    .map((r) => r.permission)
    .sort();

  // ADR-0037, INHERITED DELIBERATELY. See docs/authz.md §67.
  if (held.length < PERMISSIONS.length) {
    await assertDenyNotTruncated(
      tx,
      check.orgId,
      check.subjectObjectId,
      check.scopeObjectId,
      "the effective-permission set"
    );
  }

  return held;
}

/** One binding that reached the evaluated scope, with the subject it was written on. */
export interface ContributingBindingRow {
  roleId: string;
  roleName: string;
  scopeObjectId: string;
  viaSubjectId: string;
  effect: "allow" | "deny";
}

/** The EXPLANATION half of {@link effectivePermissions}. See docs/authz.md §68. */
export async function contributingBindingsAt(
  tx: TenantTx,
  check: { orgId: string; subjectObjectId: string; scopeObjectId: string }
): Promise<ContributingBindingRow[]> {
  const result = await tx.execute<{
    role_id: string;
    role_name: string;
    scope_object_id: string;
    via_subject_id: string;
    effect: string;
  }>(sql`
    WITH RECURSIVE ${subjectExpandCte(check.orgId, check.subjectObjectId)},
    ${scopeExpandCte(check.orgId, check.scopeObjectId)}
    SELECT DISTINCT rb.role_id, rl.name AS role_name, rb.scope_object_id,
           rb.subject_id AS via_subject_id, rb.effect
    FROM role_bindings rb
    JOIN roles rl ON rl.id = rb.role_id
    WHERE rb.org_id = ${check.orgId}
      AND rb.subject_id IN (SELECT subject_id FROM subject_expand)
      AND rb.scope_object_id IN (SELECT scope_id FROM scope_expand)
    ORDER BY rl.name, rb.scope_object_id
  `);

  return result.rows.map((r) => ({
    roleId: r.role_id,
    roleName: r.role_name,
    scopeObjectId: r.scope_object_id,
    viaSubjectId: r.via_subject_id,
    effect: r.effect === "deny" ? "deny" : "allow"
  }));
}

/** Every binding the subject holds ANYWHERE in the org. See docs/authz.md §69. */
export async function bindingsAnywhereFor(
  tx: TenantTx,
  check: { orgId: string; subjectObjectId: string }
): Promise<Array<ContributingBindingRow & { permissions: string[] }>> {
  const result = await tx.execute<{
    role_id: string;
    role_name: string;
    scope_object_id: string;
    via_subject_id: string;
    effect: string;
    permissions: string[];
  }>(sql`
    WITH RECURSIVE ${subjectExpandCte(check.orgId, check.subjectObjectId)}
    SELECT DISTINCT rb.role_id, rl.name AS role_name, rb.scope_object_id,
           rb.subject_id AS via_subject_id, rb.effect, rl.permissions
    FROM role_bindings rb
    JOIN roles rl ON rl.id = rb.role_id
    WHERE rb.org_id = ${check.orgId}
      AND rb.subject_id IN (SELECT subject_id FROM subject_expand)
    ORDER BY rl.name, rb.scope_object_id
  `);

  return result.rows.map((r) => ({
    roleId: r.role_id,
    roleName: r.role_name,
    scopeObjectId: r.scope_object_id,
    viaSubjectId: r.via_subject_id,
    effect: r.effect === "deny" ? "deny" : "allow",
    permissions: r.permissions ?? []
  }));
}
