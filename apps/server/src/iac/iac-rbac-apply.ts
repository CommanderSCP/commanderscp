import { and, eq } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import type { TenantTx } from "../db/tenant-tx.js";
import { roleBindings, roles } from "../db/schema.js";
import { badRequest, conflict } from "../errors.js";
import {
  assertBindableSubject,
  assertMayAuthorRole,
  assertMayWriteRoleBinding,
  assertOrgRetainsAdministrativeFloor,
  assertRoleAcceptsNewBindings,
  assertRoleBindableAtScope,
  lockOrgRoleAuthority
} from "../authz/role-binding-door.js";
import { appendAuditEvent } from "../audit/audit-repo.js";
import { findObjectByIdOrUrnAnyType } from "../graph/objects-repo.js";

/**
 * ================================================================================================
 * IaC-APPLIED ROLE BINDINGS AND ORG ROLES (drizzle/0108)
 * ================================================================================================
 *
 * THROUGH THE REAL DOORS, NEVER AROUND THEM. Every function here composes the same
 * `authz/role-binding-door.ts` guards `routes/role-bindings.ts` uses. An IaC path that inserted
 * rows itself would be a SECOND door with its own drift, and this milestone's whole guard census
 * would be wrong the day the two disagreed.
 *
 * WHAT IS DIFFERENT FROM THE TYPED ROUTE, and each is deliberate:
 *
 *  - **`managed_by_stack` is stamped**, which is what makes the row prunable by a later apply. A
 *    binding created through the route carries NULL and no manifest can ever touch it.
 *  - **No D7 acknowledgement**, because group and team subjects are not declarable at all
 *    (`packages/iac/src/rbac.ts` refuses them at synth). `assertBindableSubject` re-checks that
 *    here rather than trusting the client: the construct is one authoring path, and a hand-written
 *    manifest is another.
 *  - **No `Idempotency-Key`** — an apply is already idempotent by diff: a binding that exists is a
 *    `noop` line and never reaches this code.
 */

interface StackBindingInput {
  orgId: string;
  actorObjectId: string;
  requestId: string;
  stackName: string;
  subjectObjectId: string;
  roleName: string;
  scopeObjectId: string;
}

/** Resolves an org role by NAME, preferring the org's own row over a built-in of the same name. */
async function roleByName(tx: TenantTx, orgId: string, name: string) {
  const rows = await tx.select().from(roles).where(eq(roles.name, name));
  const orgRow = rows.find((r) => r.orgId === orgId);
  const builtIn = rows.find((r) => r.orgId === null);
  const found = orgRow ?? builtIn;
  if (!found) {
    throw badRequest(
      `manifest declares a role binding for role '${name}', which is neither a built-in nor a ` +
        `role this organization defines. Declare it with an OrgRole construct, or fix the name.`
    );
  }
  return found;
}

export async function createStackManagedRoleBinding(
  tx: TenantTx,
  input: StackBindingInput
): Promise<void> {
  // FIRST STATEMENT, as on the typed door: two concurrent applies reading before either writes is
  // the shape `role-binding-door.ts` §0 takes this lock for.
  await lockOrgRoleAuthority(tx, input.orgId);

  const role = await roleByName(tx, input.orgId, input.roleName);
  // `find`, NOT `get`: the `get` twin throws its own generic 404 on a miss, which would make the
  // two refusals below unreachable and answer a manifest that names a nonexistent urn with
  // "object not found" instead of naming which HALF of the binding it could not resolve.
  const subject = await findObjectByIdOrUrnAnyType(tx, input.orgId, input.subjectObjectId);
  const scope = await findObjectByIdOrUrnAnyType(tx, input.orgId, input.scopeObjectId);
  if (!subject) throw badRequest(`role binding subject '${input.subjectObjectId}' does not exist`);
  if (!scope) throw badRequest(`role binding scope '${input.scopeObjectId}' does not exist`);

  // Re-checked here rather than trusted from the construct: a hand-written manifest is a second
  // authoring path, and D7's acknowledgement — which a manifest cannot carry honestly — is
  // required for exactly the subject types this refuses.
  assertBindableSubject(subject);
  if (subject.typeId === "group" || subject.typeId === "team") {
    throw badRequest(
      `manifest declares a role binding whose subject '${subject.urn}' is a ${subject.typeId}. ` +
        `Group and team bindings require acknowledging every principal they empower (D7), which ` +
        `a manifest can only carry as a snapshot that goes stale. Grant it with ` +
        `\`scp role-binding grant-preview\` + \`create\`.`
    );
  }

  assertRoleAcceptsNewBindings(role, new Set());
  assertRoleBindableAtScope(role, { id: scope.id, typeId: scope.typeId });
  await assertMayWriteRoleBinding(tx, {
    orgId: input.orgId,
    actorObjectId: input.actorObjectId,
    role,
    scopeObjectId: scope.id,
    verb: "grant"
  });

  const id = uuidv7();
  await tx.insert(roleBindings).values({
    id,
    orgId: input.orgId,
    subjectId: subject.id,
    roleId: role.id,
    scopeObjectId: scope.id,
    effect: "allow",
    managedByStack: input.stackName
  });

  await appendAuditEvent(tx, {
    orgId: input.orgId,
    actorId: input.actorObjectId,
    action: "role_binding.grant",
    subjectId: id,
    reason: `IaC apply: stack '${input.stackName}' declared this binding`,
    requestId: input.requestId
  });
}

export async function deleteStackManagedRoleBinding(
  tx: TenantTx,
  input: StackBindingInput
): Promise<void> {
  await lockOrgRoleAuthority(tx, input.orgId);

  const role = await roleByName(tx, input.orgId, input.roleName);
  const [existing] = await tx
    .select({ id: roleBindings.id })
    .from(roleBindings)
    .where(
      and(
        eq(roleBindings.orgId, input.orgId),
        eq(roleBindings.subjectId, input.subjectObjectId),
        eq(roleBindings.roleId, role.id),
        eq(roleBindings.scopeObjectId, input.scopeObjectId),
        // ONLY this stack's own row. Without this predicate an apply could revoke a binding
        // granted by hand, which is the property drizzle/0108's column exists to guarantee.
        eq(roleBindings.managedByStack, input.stackName)
      )
    );
  // Already gone is not an error: a concurrent revoke through the typed door is a legitimate race,
  // and failing the whole apply over a row that is already in its desired state would be wrong.
  if (!existing) return;

  await tx.delete(roleBindings).where(eq(roleBindings.id, existing.id));

  // AFTER the delete, matching the typed door's act-then-check ordering: a before-check must MODEL
  // the write, which is what produced three disagreeing rules the first time this was attempted.
  await assertOrgRetainsAdministrativeFloor(tx, {
    orgId: input.orgId,
    act: `IaC apply: stack '${input.stackName}' revoking a role binding it no longer declares`
  });

  await appendAuditEvent(tx, {
    orgId: input.orgId,
    actorId: input.actorObjectId,
    action: "role_binding.revoke",
    subjectId: existing.id,
    reason: `IaC apply: stack '${input.stackName}' no longer declares this binding`,
    requestId: input.requestId
  });
}

export async function upsertStackManagedRole(
  tx: TenantTx,
  input: {
    orgId: string;
    actorObjectId: string;
    requestId: string;
    stackName: string;
    name: string;
    permissions: string[];
  }
): Promise<void> {
  await lockOrgRoleAuthority(tx, input.orgId);
  await assertMayAuthorRole(tx, {
    orgId: input.orgId,
    actorObjectId: input.actorObjectId,
    permissions: input.permissions
  });

  const [existing] = await tx
    .select()
    .from(roles)
    .where(and(eq(roles.orgId, input.orgId), eq(roles.name, input.name)));

  let roleId: string;
  if (existing) {
    if (existing.managedByStack !== input.stackName) {
      // The same refusal `computePlanDiff` makes for objects: adopting another stack's row, or a
      // hand-authored one, silently is how two owners end up disagreeing about desired state.
      throw conflict(
        `org role '${input.name}' is not managed by stack '${input.stackName}'` +
          (existing.managedByStack
            ? ` (it belongs to '${existing.managedByStack}')`
            : " (it was authored through the API)")
      );
    }
    roleId = existing.id;
    await tx.update(roles).set({ permissions: input.permissions }).where(eq(roles.id, existing.id));
  } else {
    roleId = uuidv7();
    await tx.insert(roles).values({
      id: roleId,
      orgId: input.orgId,
      name: input.name,
      permissions: input.permissions,
      managedByStack: input.stackName
    });
  }

  await appendAuditEvent(tx, {
    orgId: input.orgId,
    actorId: input.actorObjectId,
    action: existing ? "role.update" : "role.create",
    // The ROLE'S ID, never its name: `audit_events.subject_id` is a uuid column, and passing a
    // name there fails at the database as a 500 on an otherwise-correct apply.
    subjectId: roleId,
    reason: `IaC apply: stack '${input.stackName}'`,
    requestId: input.requestId
  });
}

export async function deleteStackManagedRole(
  tx: TenantTx,
  input: {
    orgId: string;
    actorObjectId: string;
    requestId: string;
    stackName: string;
    name: string;
  }
): Promise<void> {
  await lockOrgRoleAuthority(tx, input.orgId);
  const [existing] = await tx
    .select()
    .from(roles)
    .where(
      and(
        eq(roles.orgId, input.orgId),
        eq(roles.name, input.name),
        eq(roles.managedByStack, input.stackName)
      )
    );
  if (!existing) return;

  const [stillBound] = await tx
    .select({ id: roleBindings.id })
    .from(roleBindings)
    .where(and(eq(roleBindings.orgId, input.orgId), eq(roleBindings.roleId, existing.id)));
  if (stillBound) {
    // The same refusal the typed delete door makes, and for the same reason: a cascade would
    // revoke authority from every holder under one line naming the ROLE rather than the people.
    throw conflict(
      `org role '${input.name}' still has bindings. Applying this plan would delete a role that ` +
        `principals currently hold; revoke those bindings first.`
    );
  }

  await tx.delete(roles).where(eq(roles.id, existing.id));
  await appendAuditEvent(tx, {
    orgId: input.orgId,
    actorId: input.actorObjectId,
    action: "role.delete",
    subjectId: existing.id,
    reason: `IaC apply: stack '${input.stackName}' no longer declares this role`,
    requestId: input.requestId
  });
}
