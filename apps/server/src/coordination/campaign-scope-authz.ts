import type { TenantTx } from "../db/tenant-tx.js";
import { authorize } from "../authz/resolve.js";
import { findObjectByIdOrUrnAnyType, getObjectByIdOrUrnAnyType } from "../graph/objects-repo.js";

/**
 * Object types whose authority is bound to a DECLARED, checkable field on `properties` rather
 * than the generic `object:write`-at-domain check every ordinary typed resource gets — the same
 * class of risk `governance/policy-scope-authz.ts` closes for `policy.properties.scope`, applied
 * here to `campaign.properties.targets` and `change.properties.targets` (M5 adversarial-review
 * surface: "a campaign can't coordinate a change the actor lacks authority over"; extended to
 * `change` in M12 P4B Phase 2, since a change carrying `requires`/`provides` against an object the
 * actor doesn't control is the same escalation, and its `targets` were already an unchecked surface
 * pre-P4B). Both are refused outright on the generic object route (`routes/objects-generic.ts`) so
 * they can be created and mutated ONLY through their typed, target-authority-checked paths.
 */
export const COORDINATION_TARGET_SCOPED_OBJECT_TYPE_IDS: ReadonlySet<string> = new Set([
  "campaign",
  "change"
]);

export function isCoordinationTargetScopedObjectType(typeId: string): boolean {
  return COORDINATION_TARGET_SCOPED_OBJECT_TYPE_IDS.has(typeId);
}

/**
 * Binds a coordination object's DECLARED targets to the actor's own authority: the actor must hold
 * `object:write` over EVERY target, not merely `object:write` at its own domain. This is THE one
 * implementation of the check; `campaign` and `change` both use it (via the wrappers below), so
 * the two can never drift.
 *
 * Fails closed: an unresolvable target (bad id/urn) throws via `getObjectByIdOrUrnAnyType` (404),
 * and a target the actor lacks `object:write` over throws via `authorize` (403) — never a silent
 * skip. A non-array / non-string `targets` is a no-op (there is nothing to authorize).
 */
export async function assertCoordinationTargetsWithinAuthority(
  tx: TenantTx,
  input: { orgId: string; actorObjectId: string; targets: unknown }
): Promise<void> {
  if (!Array.isArray(input.targets)) return;
  for (const idOrUrn of input.targets) {
    if (typeof idOrUrn !== "string") continue;
    const target = await getObjectByIdOrUrnAnyType(tx, input.orgId, idOrUrn);
    await authorize(tx, {
      orgId: input.orgId,
      subjectObjectId: input.actorObjectId,
      permission: "object:write",
      scopeObjectId: target.id
    });
  }
}

/**
 * ADR-0028 — binds a change's DECLARED `stageDependencies` to the actor's own authority. The
 * `targets` check above is NOT enough: a declared dependency is MATERIALISED as a `depends_on` edge
 * (`changes-repo.ts`'s `materialiseStageDependencyEdges`) and `graph/relationships-repo.ts`'s
 * `createRelationship` performs no authz of its own — so without this, the propose paths mint the
 * exact edge `POST /relationships` refuses with 403 (`routes/relationships.ts`'s both-endpoint
 * "member_of privilege-escalation guard"). The edge is not cosmetic: `graph.dependentIds` is a live
 * CEL policy input (`governance/evaluate.ts`), so it can flip governance verdicts for the victim
 * component; it feeds `plan-service.ts`'s `loadDependsOnEdges`, so a crafted mutual pair 400s a
 * third party's multi-target plans; and nothing prunes it — `materialiseStageDependencyEdges`
 * deliberately treats a soft-delete tombstone as "already materialised", so an operator who deletes
 * it can never re-create it.
 *
 * THE BAR FOR AN ENDPOINT IS THE GRAPH ROUTE'S, verbatim: `relationship:write` at BOTH endpoints of
 * every edge the declaration would mint — each of the change's targets (the `from`) and each
 * `dependsOn` (the `to`). Not `object:write`: what is bypassed here is the RELATIONSHIP route, so
 * the relationship route's permission is the one that has to hold. Every built-in role granting
 * `object:write` also grants `relationship:write` (`drizzle/0002_rls_rbac_seed.sql`), so this
 * refuses nothing a legitimate proposer can do today.
 *
 * `atTargets` IS CHECKED AT A DIFFERENT BAR ON PURPOSE — `object:read`, not `relationship:write`.
 * It mints nothing and confers nothing: it only NARROWS the hold on the actor's OWN change
 * (`stage-dependency-hold.ts` filters the declared dependencies down to the places it names, and an
 * absent `atTargets` means every place). Demanding write authority over a deployment-target to say
 * "my coupling applies at prod" would make the qualifier unusable by exactly the component teams it
 * exists for. `object:read` is the honest floor: a coupling may not be scoped by a place its author
 * cannot see.
 *
 * 403, NEVER A SILENT SKIP of the offending entry. Dropping it would make a DECLARED coupling
 * vanish — the release would then deploy ahead of the component its author named, which is the
 * precise failure this whole feature exists to prevent.
 *
 * AN UNRESOLVABLE REFERENCE IS NOT THIS CHECK'S BUSINESS. It resolves without throwing and skips
 * what it cannot find, because the two propose paths already answer that question, differently and
 * deliberately: `POST /changes` gets a 404 from `proposeChange`'s own resolution a few lines later,
 * while the persist-then-process ingress must NOT 4xx the reporter — it records the refusal as a
 * Decision at process time (`webhook-processor.ts`). Throwing here would break the second contract
 * to duplicate the first. Nothing escapes: an entry naming an object that does not exist cannot
 * become an edge either.
 */
export async function assertStageDependenciesWithinAuthority(
  tx: TenantTx,
  input: {
    orgId: string;
    actorObjectId: string;
    /** The edge `from` endpoints — the change's declared targets. Omitted on the ingress paths,
     *  where the component is chosen at correlation time by an operator-configured `source_mappings`
     *  row rather than by the caller, and is not known until the reconcile tick processes the
     *  event. */
    targets?: unknown;
    stageDependencies: unknown;
  }
): Promise<void> {
  if (!Array.isArray(input.stageDependencies) || input.stageDependencies.length === 0) return;

  const check = async (idOrUrn: unknown, permission: "relationship:write" | "object:read") => {
    if (typeof idOrUrn !== "string") return;
    const object = await findObjectByIdOrUrnAnyType(tx, input.orgId, idOrUrn);
    if (!object) return;
    await authorize(tx, {
      orgId: input.orgId,
      subjectObjectId: input.actorObjectId,
      permission,
      scopeObjectId: object.id
    });
  };

  if (Array.isArray(input.targets)) {
    for (const idOrUrn of input.targets) await check(idOrUrn, "relationship:write");
  }
  for (const entry of input.stageDependencies as readonly unknown[]) {
    if (!entry || typeof entry !== "object") continue;
    const dep = entry as { dependsOn?: unknown; atTargets?: unknown };
    await check(dep.dependsOn, "relationship:write");
    if (!Array.isArray(dep.atTargets)) continue;
    for (const at of dep.atTargets as readonly unknown[]) await check(at, "object:read");
  }
}

/**
 * Campaign wrapper reading `properties.targets` — every write path that can create/update a
 * `campaign` graph object must call this (mirroring `assertPolicyScopeWithinAuthority`'s call
 * sites): `coordination/campaign-repo.ts`'s `proposeCampaign` does the equivalent per-target loop
 * inline (it needs the resolved ids back for the plan compiler); this entry point is for the paths
 * that DON'T go through `proposeCampaign` — `routes/objects-generic.ts` blocks `campaign` outright,
 * so the one remaining path is `iac/plans-repo.ts`'s `POST /plans/{id}/apply`.
 */
export async function assertCampaignTargetsWithinAuthority(
  tx: TenantTx,
  input: { orgId: string; actorObjectId: string; properties: Record<string, unknown> | undefined }
): Promise<void> {
  return assertCoordinationTargetsWithinAuthority(tx, {
    orgId: input.orgId,
    actorObjectId: input.actorObjectId,
    targets: input.properties?.targets
  });
}
