import type { TenantTx } from "../db/tenant-tx.js";
import { hasPermission } from "../authz/resolve.js";
import { forbidden, badRequest } from "../errors.js";
import { getObjectByIdOrUrnAnyType } from "../graph/objects-repo.js";

/** Binds a policy's declarable scope to the author's own. See docs/governance.md §280. */
export async function assertPolicyScopeWithinAuthority(
  tx: TenantTx,
  args: { orgId: string; actorObjectId: string; properties: Record<string, unknown> | undefined }
): Promise<void> {
  const scope = (args.properties?.scope ?? undefined) as
    { objectRef?: unknown; selector?: unknown; group?: unknown } | undefined;

  const boundedRef =
    scope && typeof scope.objectRef === "string" && !scope.selector && !scope.group
      ? scope.objectRef
      : undefined;

  if (boundedRef) {
    let refId: string;
    try {
      refId = (await getObjectByIdOrUrnAnyType(tx, args.orgId, boundedRef)).id;
    } catch {
      throw badRequest(
        `policy scope.objectRef '${boundedRef}' does not resolve to an object in this org`
      );
    }
    const ok = await hasPermission(tx, {
      orgId: args.orgId,
      subjectObjectId: args.actorObjectId,
      permission: "policy:write",
      scopeObjectId: refId
    });
    if (!ok) {
      throw forbidden(
        `cannot create/update a policy scoped to '${boundedRef}': you lack 'policy:write' at-or-above that scope`
      );
    }
    return;
  }

  // Unscoped / label-selector / group scope → org-wide blast radius → require org-root authority.
  const ok = await hasPermission(tx, {
    orgId: args.orgId,
    subjectObjectId: args.actorObjectId,
    permission: "policy:write",
    scopeObjectId: args.orgId // org root object id === orgId (bootstrap invariant)
  });
  if (!ok) {
    throw forbidden(
      "cannot create/update an org-wide policy (unscoped, label-selector, or group scope): you lack 'policy:write' at the organization root"
    );
  }
}
