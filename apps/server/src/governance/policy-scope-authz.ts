import type { TenantTx } from "../db/tenant-tx.js";
import { hasPermission } from "../authz/resolve.js";
import { forbidden, badRequest } from "../errors.js";
import { getObjectByIdOrUrnAnyType } from "../graph/objects-repo.js";

/**
 * Binds a policy's DECLARABLE scope to the author's own `policy:write` authority (adversarial
 * review CRITICAL #1b). Without this, the generic typed-registry write check only proves the actor
 * may write the policy OBJECT at its own containment (its `domainId`) — which is completely
 * decoupled from the policy's DECLARED `properties.scope`. An actor holding `policy:write` at a
 * single component could therefore publish a policy whose `scope` is org-wide (unscoped, a label
 * selector, or a group) and — combined with same-named merging — bend governance across the whole
 * org (the CRITICAL #1a vector: plant an org-wide same-named policy).
 *
 * Rule (fail-closed):
 *  - `scope.objectRef` (and no selector/group): the policy is bounded to that concrete object, so
 *    the author must hold `policy:write` at-or-above THAT object.
 *  - anything broader — unscoped, a label `selector` (which can match objects org-wide), or a
 *    `group` scope (applies wherever a member acts) — has org-wide blast radius, so it requires
 *    `policy:write` at the ORG ROOT.
 *
 * A `selector`-scoped policy could in principle be bounded to the subtree its selector can match;
 * that's a strictly-safe future refinement — requiring org-root authority for any selector is the
 * conservative choice for now (you can't publish a broad-matching policy without broad authority).
 */
export async function assertPolicyScopeWithinAuthority(
  tx: TenantTx,
  args: { orgId: string; actorObjectId: string; properties: Record<string, unknown> | undefined }
): Promise<void> {
  const scope = (args.properties?.scope ?? undefined) as
    | { objectRef?: unknown; selector?: unknown; group?: unknown }
    | undefined;

  const boundedRef =
    scope && typeof scope.objectRef === "string" && !scope.selector && !scope.group
      ? scope.objectRef
      : undefined;

  if (boundedRef) {
    let refId: string;
    try {
      refId = (await getObjectByIdOrUrnAnyType(tx, args.orgId, boundedRef)).id;
    } catch {
      throw badRequest(`policy scope.objectRef '${boundedRef}' does not resolve to an object in this org`);
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
