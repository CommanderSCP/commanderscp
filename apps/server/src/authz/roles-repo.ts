import { and, asc, eq, isNull, or, sql, type SQL } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import type { RoleBinding } from "@scp/schemas";
import type { TenantTx } from "../db/tenant-tx.js";
import { roleBindings, roles } from "../db/schema.js";
import { conflict, notFound } from "../errors.js";
import { isUniqueViolation } from "../db/pg-errors.js";
import { decodeCursor, encodeCursor, keysetAfter, keysetOrderBy } from "../pagination.js";
import type { BindableRole } from "./role-binding-door.js";

/**
 * Reads and writes for `roles` and `role_bindings` — the storage half of role-model.md §5 step 5.
 * Deliberately dumb: every refusal lives in `authz/role-binding-door.ts` and every check runs before
 * anything here is called. This module decides nothing.
 *
 * RLS DOES THE TENANCY, NOT THIS FILE'S WHERE CLAUSES — and the two tables differ, which is the one
 * thing worth knowing here. `roles`' policy is
 * `USING (org_id = current_org OR org_id IS NULL)`, so a read sees this org's rows PLUS the shared
 * built-in singletons; `role_bindings`' policy has no NULL arm, so a read sees this org's rows and
 * nothing else (drizzle/0002 §2). The explicit `org_id` predicates below are belt-and-braces on top
 * of that, in the same style as every other repo in this codebase.
 */

/** Built-ins first (the catalogue an operator recognises), then org rows; alphabetical within each,
 *  so the listing is stable across calls without a cursor. */
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

/**
 * `effect` is NARROWED here rather than trusted, and the direction of the narrowing is the point.
 *
 * `role_bindings_effect_check` (drizzle/0097) constrains WRITES; PostgreSQL never re-checks a row on
 * the way out, so a database restored from a pre-0097 `pg_dump` carries the pre-0097 schema and its
 * illegal rows load intact (role-model.md §8.3). The response enum is closed at two values, so a
 * third string has to become one of them.
 *
 * `x === "allow" ? "allow" : "deny"` — not `x === "deny" ? "deny" : "allow"`. `hasPermission`
 * classifies by exact string equality and treats a malformed row as NEITHER: it grants nothing and
 * denies nothing. Of the two available lies, reporting it as the BLOCKING effect is the one that
 * cannot make an operator believe authority exists where it does not, and it is the one that makes
 * such a row look wrong in a listing instead of looking like a working grant.
 */
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

/**
 * Writes ONE grant, always `effect = 'allow'` (deny is not exposed on the write API — see
 * `packages/schemas/src/rbac.ts`'s module doc).
 *
 * A duplicate is a 409, not a silent success and not a second row. `role_bindings_grant_key`
 * (drizzle/0097) is the natural key `(org_id, subject_id, role_id, scope_object_id, effect)` and it
 * landed BEFORE this API deliberately: without it a write door creates duplicate grants that are
 * individually revocable and COLLECTIVELY still granting — revoke one, the other still grants, and
 * the revoke reports success. `onConflictDoNothing` would reproduce that failure from the other end
 * (a revoke against a binding the caller believes they created), so the conflict is surfaced.
 */
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
