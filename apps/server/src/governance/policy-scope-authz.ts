import type { TenantTx } from "../db/tenant-tx.js";
import { hasPermission } from "../authz/resolve.js";
import { forbidden, badRequest } from "../errors.js";
import { getObjectByIdOrUrnAnyType } from "../graph/objects-repo.js";

/**
 * Binds a policy's DECLARABLE scope to the author's own `policy:write` authority (adversarial
 * review CRITICAL #1b). This function is the ONLY thing in the tree that bounds a policy's reach to
 * its author's authority, so read the next section before reasoning about it — a security argument
 * was built here on a premise about object containment that the code does not have.
 *
 * ================================================================================================
 * A POLICY'S CONTAINMENT PLACEMENT (`domain_id`) BOUNDS NOTHING. VERIFIED, NOT ASSUMED.
 * ================================================================================================
 * A policy object has a containment parent like every other object, and it is tempting to read that
 * placement as some part of the policy's reach — a policy "inside" a component being somehow local
 * to it, so that only its DECLARED scope needed a separate control. Placement contributes NOTHING to
 * reach. Three sites, each checkable in a minute:
 *
 *  1. **Candidate selection has no `domain_id` predicate at all.** `listPolicyCandidates`
 *     (`governance/policy-resolve.ts`) selects EVERY non-deleted `policy` row in the org —
 *     `and(eq(orgId), eq(typeId, "policy"), isNull(deletedAt))` and nothing else. A policy written
 *     under one component is a candidate for every target in the org.
 *  2. **Matching reads only `properties.scope`.** `matchPoliciesForTargets`
 *     (`governance/policy-resolve.ts`) matches unscoped / `objectRef` / `selector` / `group` against
 *     the TARGET's `containmentChain`. The policy row's own `domain_id` is never consulted.
 *  3. **Merging is by `name`.** `resolvePolicies` (`governance/policy-model.ts`) groups matches by
 *     `m.name`, takes the max enforcement and unions effects. Two same-named policies merge
 *     regardless of where either one sits; `matchedAt.depth` only orders `contributors` for the
 *     reason tree and is documented there as having no bearing on the result.
 *
 * So the CRITICAL #1a vector — plant an org-wide same-named policy and bend governance across the
 * org — needs no particular placement. Placement is not a weak version of this control; it is a
 * different control over a different question, and the two must not be conflated:
 *
 *  - **CUSTODY — the containment `authorize`.** At create, the route checks `policy:write` at the
 *    resolved containment parent (`routes/typed-registries.ts:202-207`, scope =
 *    `resolveDomainId(body.domainId)`): it decides WHERE the row may be PLACED. Because PATCH
 *    (`:344-349`) and DELETE (`:401-406`) then re-check at the row's OWN id, and `scope_expand`
 *    (`authz/resolve.ts`) walks upward from there through `objects.domain_id`, that placement is
 *    what decides WHO MAY MUTATE OR DELETE THE ROW AFTERWARDS. Custody of the document, not reach
 *    of the document.
 *  - **JURISDICTION — this function.** It reads `properties.scope` and nothing else, and it is the
 *    sole guard for CRITICAL #1a/#1b. Its whole three-door census is `routes/typed-registries.ts:134`
 *    (typed `/policies`: POST, PATCH-with-properties, PUT) and `iac/plans-repo.ts:733` and `:758`
 *    (IaC apply, create and update branches); the generic `/objects/policy` door does not need it
 *    because `assertNotGovernanceManagedObjectType` (`routes/objects-generic.ts`) refuses every
 *    write verb on `policy`/`control` outright. Delete any one of those three and the vector is open
 *    again — nothing downstream re-derives it.
 *
 * That is why an actor holding `policy:write` at a single component, who legitimately passes the
 * custody check by writing the row at their own component, must still be refused an org-wide
 * (unscoped, label-selector, or group) `scope`: custody was never evidence of jurisdiction.
 *
 * Rule (fail-closed):
 *  - `scope.objectRef` (and no selector/group): the policy is bounded to that concrete object, so
 *    the author must hold `policy:write` at-or-above THAT object.
 *  - anything broader — unscoped, a label `selector` (which can match objects org-wide), or a
 *    `group` scope — has org-wide blast radius, so it requires `policy:write` at the ORG ROOT.
 *
 * The `group` case got BROADER on 2026-08-15 (ADR-0016 §2a) and this rule needed no change, which
 * is the point of writing it conservatively. It used to reach "wherever a member acts"; it now also
 * reaches "whatever the group or its members OWN, and everything contained beneath that" — DESIGN
 * §10.1's owning-subject half, which had never been built. Both readings are org-wide in the worst
 * case, so org-root authority was already the right bar and remains it.
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
