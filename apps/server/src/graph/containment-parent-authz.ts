import type { ContainmentDomainId } from "@scp/schemas";
import type { TenantTx } from "../db/tenant-tx.js";
import { hasPermission, type Permission } from "../authz/resolve.js";
import { forbidden } from "../errors.js";
import { assertRootedContainmentParent } from "./containment.js";
import { resolveContainmentParent } from "./objects-repo.js";
import { assertGovernanceMoveAdmits } from "../governance/move-enforcement.js";

/** The one place a caller's `domainId` becomes a containment parent. See docs/graph.md §22. */
export interface DeclaredContainmentParent {
  orgId: string;
  subjectObjectId: string;
  /** The permission the door itself gates writes on — 'object:write', or 'policy:write' for the
   *  governance registries. The destination is held to the SAME bar as the object, never a weaker
   *  one. */
  permission: Permission;
  declared: ContainmentDomainId | null | undefined;
  /** The row as it stands, or `undefined` when this write CREATES it. See docs/graph.md §23. */
  current: { id: string; domainId: string | null } | undefined;
}

/**
 * Resolves a caller's `domainId`, authorizing a move when it is one. See docs/graph.md §24.
 * @throws 400 when the id names nothing in this org, or would make the row its own parent.
 * @throws 403 when the caller lacks `permission` at-or-above the DESTINATION.
 */
export async function resolveDeclaredContainmentParent(
  tx: TenantTx,
  input: DeclaredContainmentParent
): Promise<ContainmentDomainId | undefined> {
  if (input.declared === undefined) return undefined;

  // `?? undefined` is where a wire `null` becomes "the default parent". `resolveContainmentParent`
  // reads a bare `null` as "this object IS the org root", which is a bootstrap-only claim no request
  // body may make — see the module doc.
  const destination = (await resolveContainmentParent(tx, input.orgId, input.declared ?? undefined))
    .id;
  if (destination === null) {
    // Unreachable: `resolveContainmentParent` returns a null id only for a literal `null` argument,
    // which the coercion above rules out. Thrown rather than returned so a future change to that
    // contract surfaces here instead of writing a detached row.
    throw new Error("internal: a declared containment parent resolved to NULL");
  }

  const current = input.current;
  if (current === undefined) return destination;

  // Re-stating the CURRENT parent is not a move, so it demands no authority at it. Load-bearing:
  // `PUT` is defined as idempotent here and `scp apply` re-sends unchanged rows routinely, so
  // treating a restatement as a privilege demand would make an unchanged re-apply start failing for
  // every author who does not also hold authority over their own object's container.
  if (destination === current.domainId) return destination;

  // A CYCLE IS A DETACH WITH NO `null` IN IT. See docs/graph.md §25.
  await assertRootedContainmentParent(tx, {
    orgId: input.orgId,
    childId: current.id,
    parentId: destination
  });

  // The org root is not a destination that gains custody. See docs/graph.md §26.
  if (destination !== input.orgId) {
    const allowedAtDestination = await hasPermission(tx, {
      orgId: input.orgId,
      subjectObjectId: input.subjectObjectId,
      permission: input.permission,
      scopeObjectId: destination
    });
    if (!allowedAtDestination) {
      // Names the DESTINATION, not the object. An operator who reads this must be able to tell "you
      // may not edit this object" from "you may not put it there" — they have different remedies.
      throw forbidden(
        `cannot move object '${current.id}' into container '${destination}': you lack ` +
          `'${input.permission}' at-or-above that destination. A containment parent decides who else ` +
          `holds authority over the object (authz scope expands upward), so a move is authorized at ` +
          `both ends, not only at the object being moved.`
      );
    }
  }

  // THE OTHER END. See docs/graph.md §27.
  if (current.domainId !== null && current.domainId !== input.orgId) {
    const allowedAtSource = await hasPermission(tx, {
      orgId: input.orgId,
      subjectObjectId: input.subjectObjectId,
      permission: input.permission,
      scopeObjectId: current.domainId
    });
    if (!allowedAtSource) {
      // Names the SOURCE. An actor who holds the destination but not the source would otherwise be
      // sent to fix a permission they already have.
      throw forbidden(
        `cannot move object '${current.id}' out of container '${current.domainId}': you lack ` +
          `'${input.permission}' at-or-above that source. Removing an object from a container is a ` +
          `write to that container's contents — every holder at-or-above it loses custody — so a ` +
          `move is authorized at both ends, not only at the destination.`
      );
    }
  }

  // THE SECOND, OPT-IN BAR. See docs/graph.md §28.
  await assertGovernanceMoveAdmits(tx, {
    orgId: input.orgId,
    subjectObjectId: input.subjectObjectId,
    movedObjectId: current.id,
    destinationObjectId: destination,
    permissionSetForExplain: input.permission
  });

  return destination;
}
