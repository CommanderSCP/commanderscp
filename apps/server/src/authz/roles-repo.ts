import { and, asc, eq, isNull, or, sql, type SQL } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import type { RoleBinding } from "@scp/schemas";
import type { TenantTx } from "../db/tenant-tx.js";
import { roleBindings, roles } from "../db/schema.js";
import { conflict, notFound, unprocessable } from "../errors.js";
import { isUniqueViolation } from "../db/pg-errors.js";
import { decodeCursor, encodeCursor, keysetAfter, keysetOrderBy } from "../pagination.js";
import type { BindableRole } from "./role-binding-door.js";

/** Reads and writes for `roles` and `role_bindings`. See docs/authz.md §72. */

/** Built-ins first (the catalogue an operator recognises), then org rows; alphabetical within each,
 *  so the listing is stable across calls without a cursor. */

/** One row -> the shape every door and route consumes. Shared by the write functions below so a new
 *  field cannot be mapped by one and forgotten by another. */
function toBindableRole(r: {
  id: string;
  orgId: string | null;
  name: string;
  permissions: string[];
  bindableAt: string[] | null;
}): BindableRole {
  return {
    id: r.id,
    orgId: r.orgId,
    name: r.name,
    permissions: r.permissions,
    bindableAt: r.bindableAt
  };
}

export async function listRoles(tx: TenantTx, orgId: string): Promise<BindableRole[]> {
  const rows = await tx
    .select()
    .from(roles)
    .where(or(isNull(roles.orgId), eq(roles.orgId, orgId)))
    .orderBy(sql`${roles.orgId} IS NOT NULL`, asc(roles.name));
  return rows.map((r) => ({
    id: r.id,
    orgId: r.orgId,
    name: r.name,
    permissions: r.permissions,
    bindableAt: r.bindableAt
  }));
}

/** The set of SHARED BUILT-IN role names — `assertRoleAcceptsNewBindings`'s collision input. Read
 *  from the table rather than hard-coded: five migrations have added built-ins so far, and a list
 *  that lags one of them would silently stop refusing a colliding name. */
export async function builtInRoleNames(tx: TenantTx): Promise<Set<string>> {
  const rows = await tx.select({ name: roles.name }).from(roles).where(isNull(roles.orgId));
  return new Set(rows.map((r) => r.name));
}

export async function getRoleById(tx: TenantTx, orgId: string, id: string): Promise<BindableRole> {
  const rows = await tx
    .select()
    .from(roles)
    .where(and(eq(roles.id, id), or(isNull(roles.orgId), eq(roles.orgId, orgId))))
    .limit(1);
  const row = rows[0];
  if (!row) throw notFound(`role '${id}' not found`);
  return {
    id: row.id,
    orgId: row.orgId,
    name: row.name,
    permissions: row.permissions,
    bindableAt: row.bindableAt
  };
}

/** `effect` is narrowed on read rather than trusted. See docs/authz.md §73. */
function toRoleBinding(row: {
  id: string;
  subjectId: string;
  roleId: string;
  roleName: string;
  scopeObjectId: string;
  effect: string;
  createdAt: Date;
}): RoleBinding {
  return {
    id: row.id,
    subjectId: row.subjectId,
    roleId: row.roleId,
    roleName: row.roleName,
    scopeObjectId: row.scopeObjectId,
    effect: row.effect === "allow" ? "allow" : "deny",
    createdAt: row.createdAt.toISOString()
  };
}

const bindingColumns = {
  id: roleBindings.id,
  subjectId: roleBindings.subjectId,
  roleId: roleBindings.roleId,
  roleName: roles.name,
  scopeObjectId: roleBindings.scopeObjectId,
  effect: roleBindings.effect,
  createdAt: roleBindings.createdAt
};

export interface ListRoleBindingsQuery {
  cursor?: string | undefined;
  limit: number;
  subjectId?: string | undefined;
  scopeObjectId?: string | undefined;
}

export async function listRoleBindings(
  tx: TenantTx,
  orgId: string,
  query: ListRoleBindingsQuery
): Promise<{ items: RoleBinding[]; nextCursor: string | null }> {
  const conditions: SQL[] = [eq(roleBindings.orgId, orgId)];
  if (query.subjectId) conditions.push(eq(roleBindings.subjectId, query.subjectId));
  if (query.scopeObjectId) conditions.push(eq(roleBindings.scopeObjectId, query.scopeObjectId));

  const cursor = query.cursor ? decodeCursor(query.cursor) : null;
  if (cursor) conditions.push(keysetAfter(roleBindings.createdAt, roleBindings.id, cursor));

  const rows = await tx
    .select(bindingColumns)
    .from(roleBindings)
    .innerJoin(roles, eq(roles.id, roleBindings.roleId))
    .where(and(...conditions))
    .orderBy(...keysetOrderBy(roleBindings.createdAt, roleBindings.id))
    .limit(query.limit + 1);

  const hasMore = rows.length > query.limit;
  const page = hasMore ? rows.slice(0, query.limit) : rows;
  const last = page[page.length - 1];
  const nextCursor = hasMore && last ? encodeCursor(last) : null;
  return { items: page.map(toRoleBinding), nextCursor };
}

export async function getRoleBindingById(
  tx: TenantTx,
  orgId: string,
  id: string
): Promise<RoleBinding> {
  const rows = await tx
    .select(bindingColumns)
    .from(roleBindings)
    .innerJoin(roles, eq(roles.id, roleBindings.roleId))
    .where(and(eq(roleBindings.orgId, orgId), eq(roleBindings.id, id)))
    .limit(1);
  const row = rows[0];
  if (!row) throw notFound(`role binding '${id}' not found`);
  return toRoleBinding(row);
}

export interface InsertRoleBindingInput {
  orgId: string;
  subjectId: string;
  roleId: string;
  roleName: string;
  scopeObjectId: string;
}

/** Writes ONE grant, always `effect = 'allow'`. See docs/authz.md §74. */
export async function insertRoleBinding(
  tx: TenantTx,
  input: InsertRoleBindingInput
): Promise<RoleBinding> {
  const id = uuidv7();
  try {
    const [row] = await tx
      .insert(roleBindings)
      .values({
        id,
        orgId: input.orgId,
        subjectId: input.subjectId,
        roleId: input.roleId,
        scopeObjectId: input.scopeObjectId,
        effect: "allow"
      })
      .returning();
    if (!row) throw new Error("failed to insert role binding");
    return toRoleBinding({ ...row, roleName: input.roleName });
  } catch (err) {
    if (isUniqueViolation(err, "role_bindings_grant_key")) {
      throw conflict(
        `subject '${input.subjectId}' is already bound to role '${input.roleName}' at scope ` +
          `'${input.scopeObjectId}'`
      );
    }
    throw err;
  }
}

/** A HARD delete — `role_bindings` has no `deleted_at`, and `scp_app` gained DELETE on the table in
 *  drizzle/0097 §4 precisely so a revoke verb could revoke. The audit event and Decision the caller
 *  writes in the same transaction are what survive the row. */
export async function deleteRoleBindingById(
  tx: TenantTx,
  orgId: string,
  id: string
): Promise<void> {
  await tx.delete(roleBindings).where(and(eq(roleBindings.orgId, orgId), eq(roleBindings.id, id)));
}

/** `fromRole` AUTHORING-TIME VALIDATION. See docs/authz.md §75. */
export async function assertPolicyApprovalRolesExist(
  tx: TenantTx,
  properties: Record<string, unknown>
): Promise<void> {
  const effects = properties.effects;
  if (!Array.isArray(effects)) return;

  const named: string[] = [];
  for (const effect of effects) {
    if (!effect || typeof effect !== "object") continue;
    const req = (effect as { requireApprovals?: unknown }).requireApprovals;
    if (!req || typeof req !== "object") continue;
    const fromRole = (req as { fromRole?: unknown }).fromRole;
    // A non-string `fromRole` is the property schema's business, not this function's; validating it
    // twice would produce two different messages for one defect.
    if (typeof fromRole === "string" && fromRole.length > 0) named.push(fromRole);
  }
  if (named.length === 0) return;

  const builtIns = await builtInRoleNames(tx);
  const unknown = [...new Set(named.filter((n) => !builtIns.has(n)))].sort();
  if (unknown.length === 0) return;

  throw unprocessable(
    `policy names ${unknown.length === 1 ? "an approval role" : "approval roles"} that no built-in ` +
      `role provides: ${unknown.map((u) => `'${u}'`).join(", ")}. Approval quorums resolve ` +
      `BUILT-IN role names only (authz/resolve.ts's hasRoleAtScope), so such a requirement can ` +
      `never be satisfied by any principal and the gate would block forever while appearing ` +
      `correctly configured. Available: ${[...builtIns].sort().join(", ")}.`
  );
}

/** Storage for the custom-role authoring API (role-model.md §5 step 10). Decides nothing: every
 *  refusal lives in `docs/authz/role-binding-door.md` §9 and runs before any of these are called. */
export async function insertRole(
  tx: TenantTx,
  input: {
    orgId: string;
    name: string;
    permissions: string[];
    bindableAt: string[] | null;
  }
): Promise<BindableRole> {
  const id = uuidv7();
  try {
    const [row] = await tx
      .insert(roles)
      .values({
        id,
        orgId: input.orgId,
        name: input.name,
        permissions: input.permissions,
        bindableAt: input.bindableAt
      })
      .returning();
    return toBindableRole(row!);
  } catch (err) {
    // `roles_org_name_key` (drizzle/0103). Translated here rather than pre-checked with a SELECT,
    // because a pre-check is a TOCTOU: two concurrent authors both see the name free.
    if (isUniqueViolation(err)) {
      throw conflict(`this organization already has a role named '${input.name}'`);
    }
    throw err;
  }
}

export async function updateRole(
  tx: TenantTx,
  input: {
    orgId: string;
    id: string;
    name?: string;
    permissions?: string[];
    bindableAt?: string[] | null;
  }
): Promise<BindableRole> {
  const patch: Record<string, unknown> = {};
  if (input.name !== undefined) patch.name = input.name;
  if (input.permissions !== undefined) patch.permissions = input.permissions;
  if (input.bindableAt !== undefined) patch.bindableAt = input.bindableAt;

  try {
    const [row] = await tx
      .update(roles)
      .set(patch)
      // `org_id = :orgId` is NOT redundant with RLS here: `roles`' policy admits `org_id IS NULL`
      // for READS (that is how every org sees the built-in singletons), so a filter of
      // `id = :id` alone would match a BUILT-IN row and RLS's WITH CHECK is what would have to
      // catch it. Naming the org makes a built-in unaddressable by this function at all.
      .where(and(eq(roles.id, input.id), eq(roles.orgId, input.orgId)))
      .returning();
    if (!row) throw notFound(`role '${input.id}' not found in this organization`);
    return toBindableRole(row);
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw conflict(`this organization already has a role named '${input.name}'`);
    }
    throw err;
  }
}

/** How many bindings point at this role. The delete door refuses a non-zero count. */
export async function countBindingsOfRole(
  tx: TenantTx,
  orgId: string,
  roleId: string
): Promise<number> {
  const rows = await tx.execute<{ n: string }>(
    sql`SELECT count(*)::text AS n FROM role_bindings WHERE org_id = ${orgId} AND role_id = ${roleId}`
  );
  return Number(rows.rows[0]?.n ?? "0");
}

export async function deleteRoleById(tx: TenantTx, orgId: string, id: string): Promise<void> {
  const rows = await tx
    .delete(roles)
    // Same `org_id` reasoning as `updateRole`: a built-in must not be addressable here.
    .where(and(eq(roles.id, id), eq(roles.orgId, orgId)))
    .returning({ id: roles.id });
  if (rows.length === 0) throw notFound(`role '${id}' not found in this organization`);
}
