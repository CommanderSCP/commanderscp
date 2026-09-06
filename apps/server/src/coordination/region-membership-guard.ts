import { hasPermission } from "../authz/resolve.js";
import type { TenantTx } from "../db/tenant-tx.js";
import { forbidden } from "../errors.js";

/**
 * ================================================================================================
 * UN-DECLARING A REGION IS AN AUTHORITY ACT, NOT A FIELD EDIT (M15.6 / ADR-0017 §3)
 * ================================================================================================
 *
 * ## The property this closes
 *
 * A governance decision whose MATCH KEY is writable by its own SUBJECT, at a strictly weaker
 * permission than the one that governs the constraint. (The same property
 * `governance/policy-resolve.ts`'s selector labels carry; this is the M15.6 instance of it.)
 *
 * The live instance: `coordination/regional-executors.ts`'s `readDeclaredRegionMembership` decides
 * whether the M15.6 no-silent-deploy gate APPLIES to a wave target by reading two free-form
 * properties off the target itself — `properties.environment` and `properties.region`. Either one
 * blank or absent returns `null`, which `evaluateRegionalDeployGate` documents as its "SCOPE GUARD"
 * and `reconcile.ts` reads as "not a region target". The wave target then falls through to case (a)
 * — "nothing bound anywhere, this is an intended rehearsal" — and is dispatched against the SHARED
 * DEFAULT FAKE EXECUTOR, reporting success without deploying anything.
 *
 * Two permissions met at that read, and they were not the same size:
 *
 * | Act                                                | Permission required, before this change            |
 * |----------------------------------------------------|----------------------------------------------------|
 * | READ the multi-region set the gate governs          | `object:read` **at the ORG ROOT** — `routes/executors.ts`'s `getRegionalExecutors` takes the widest bar deliberately, "the view spans every region deployment-target in the environment" |
 * | REMOVE a target from that set                       | `object:write` **at the target** — i.e. the target's own owner, via `PUT`/`PATCH /objects/deployment-target/:id`, `PUT /deployment-targets/:urn`, or an IaC apply |
 *
 * So the SUBJECT of the gate could leave its reach by deleting one property. MEASURED, not
 * suspected — `regional-gate-undeclare.integration.test.ts` drives all three doors with a user
 * holding the built-in Operator role bound AT THE TARGET ONLY (no org-root binding), against a
 * declared, unbound region target that the gate refuses as a control:
 *
 *   control: declared `{environment, region}`, unbound  -> `no_executor`, change parked, 1 block Decision
 *   V1: `PUT` with `properties: {environment}`          -> `triggered` on `fake-executor`, 0 block Decisions
 *   V2: `PUT` with `properties: {}`                     -> `triggered` on `fake-executor`, 0 block Decisions
 *   V3: `DELETE` the target after the change is proposed-> `triggered` on `fake-executor`, 0 block Decisions
 *
 * No error, no audit event, no Decision. A constraint that fails to match is a constraint that does
 * not apply, and this one failed to match silently — the exact silent regional deploy the gate was
 * built to prevent, reintroduced by editing the gate's INPUT rather than the gate.
 *
 * The exploit needs no "remove property" verb: `updateObject` replaces `properties` wholesale, so an
 * ordinary full-replacement `PUT` that simply OMITS the key is the whole attack.
 *
 * ## The shape of the fix: a description the owner writes vs an assertion an authority makes
 *
 * DECLARING region membership stays exactly as free as it is today, and that asymmetry is the point,
 * not an oversight. A declaration only ever ADDS constraint — a newly-declared region target becomes
 * SUBJECT to the gate — so leaving it at the owner's own `object:write` grants nothing. This is
 * ADR-0003's "a declaration is not a grant" shape: the declaration buys the declarer nothing, so it
 * needs no bar. WITHDRAWING the declaration is the act that REMOVES constraint, and that is the one
 * that takes an authority's permission.
 *
 * The bar is `object:write` AT THE ORG ROOT — deliberately the mirror of the read the M15.6 surface
 * already takes for the same set, and strictly stronger than `object:write` at the target (authz
 * walks containment UPWARD, so a role bound at the target, its service or its domain does not reach
 * the org root, while an org-root binding reaches everything). No new permission is invented; a
 * team that owns a region target keeps every other write on it.
 *
 * RENAMING is not withdrawing. Moving `region: amer -> amer-2`, or `environment: prod -> prod-eu`,
 * leaves the target a declared region target, so the gate still applies and this guard stays out of
 * the way. Only the transition from "declares both" to "declares fewer than both" — including
 * deletion of the row — is refused.
 *
 * ## Where it is installed, and why not at a route
 *
 * At `graph/objects-repo.ts`'s `updateObject` and `deleteObject` — the choke points every LOCAL
 * write door funnels through — never per route. `PUT /objects/:type/:idOrUrn`,
 * `PATCH /objects/:type/:idOrUrn`, `DELETE /objects/:type/:idOrUrn`, the typed
 * `PUT /deployment-targets/:urn` (via `upsertObjectByUrn`, whose ordinary update branch delegates to
 * `updateObject`), an IaC apply and its prune, and `POST /federation/hand-fill` all reach those two
 * functions; only some of them pass through `typed-registries.ts`. A per-route guard would be a
 * census that has to be re-run every time a route is added, which is how the instance being fixed
 * here came to exist.
 *
 * `federationImport` is exempt, following `graph/objects-repo.ts`'s existing precedent verbatim and
 * for its stated reason rather than because imported data is trusted: `federation/import-repo.ts`'s
 * `object_upsert` branch has no `try/catch`, so a refusal there does not protect anything — it
 * WEDGES the peer channel. An imported row is authored by another domain under that domain's own
 * authority, and this org's RBAC has no jurisdiction over it.
 */

/** The two properties the M15.6 gate reads to decide whether it applies. Kept as one exported list
 *  so this guard and `regional-executors.ts` can never key on different names — a key that is
 *  reserved for the WRITE check and a different key for the MATCH would be the evasion, rebuilt
 *  inside the guard. */
export const REGION_MEMBERSHIP_KEYS = ["environment", "region"] as const;

/**
 * Read one property the way PostgreSQL's `->>` reads it, because that is the operator
 * `regional-executors.ts` matches with. A `jsonb` number, boolean or object comes back from `->>`
 * as its JSON text, never as SQL NULL, so a target carrying `region: 0` is a DECLARED region there
 * and must be a declared region here too. Mirroring the operator rather than type-narrowing to
 * `string` is what keeps the write check and the match check reading the same rows.
 */
function jsonTextValue(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return typeof value === "string" ? value : JSON.stringify(value);
}

/**
 * Does this properties bag DECLARE multi-region membership — the exact predicate
 * `readDeclaredRegionMembership` applies (both keys present and non-blank after trimming)?
 */
export function declaresRegionMembership(properties: Record<string, unknown> | null): boolean {
  if (!properties) return false;
  return REGION_MEMBERSHIP_KEYS.every(
    (key) => (jsonTextValue(properties[key]) ?? "").trim().length > 0
  );
}

/** Which of the two keys this write blanks or removes, sorted — the operator-facing half of the
 *  refusal, so the message names the property that was actually withdrawn rather than the pair. */
function withdrawnKeys(
  before: Record<string, unknown>,
  after: Record<string, unknown> | null
): string[] {
  if (after === null) return [...REGION_MEMBERSHIP_KEYS];
  return REGION_MEMBERSHIP_KEYS.filter((key) => {
    const had = (jsonTextValue(before[key]) ?? "").trim().length > 0;
    const has = (jsonTextValue(after[key]) ?? "").trim().length > 0;
    return had && !has;
  });
}

export interface UndeclareRegionCheck {
  orgId: string;
  actorObjectId: string;
  typeId: string;
  objectId: string;
  before: Record<string, unknown> | null;
  /** The properties about to be stored, or `null` when the row is being (soft-)deleted. */
  after: Record<string, unknown> | null;
}

/**
 * Refuse a write that takes a `deployment-target` OUT of the M15.6 multi-region set, unless the
 * actor holds `object:write` at the ORG ROOT.
 *
 * Checked against the value about to be STORED (and against the row as locked), not against the
 * request body, for the same reason `assertEnforceableDependencySubscriptionScope` is: that makes
 * the invariant a property of the ROW rather than of the request, so a `PATCH` that mentions no
 * properties at all cannot withdraw anything, and a full-replacement `PUT` that merely omits the key
 * is caught — omission and deletion are the same bytes on the wire, and omission is the attack.
 *
 * A no-op for every object that is not a live declared region `deployment-target`: a plain target, a
 * component, a service and a target that never declared both keys all pass straight through, so the
 * scope guard `evaluateRegionalDeployGate` relies on is untouched in the direction that matters
 * (case (a), the intended-fake rehearsal target, still behaves exactly as it always has).
 */
export async function assertMayUndeclareRegionMembership(
  tx: TenantTx,
  check: UndeclareRegionCheck
): Promise<void> {
  if (check.typeId !== "deployment-target") return;
  // Nothing to withdraw: the row is not currently a declared region target. Note the direction —
  // this reads BEFORE, so ADDING a declaration is free, and only losing one is gated.
  if (!declaresRegionMembership(check.before)) return;
  // Still a declared region target afterwards (a rename, a property added beside them, a `PATCH`
  // that touched only `name`) — the gate still applies to it, so there is nothing to authorize.
  if (check.after !== null && declaresRegionMembership(check.after)) return;

  const allowed = await hasPermission(tx, {
    orgId: check.orgId,
    subjectObjectId: check.actorObjectId,
    permission: "object:write",
    // The ORG ROOT object's id IS the org id (`auth/local-auth.ts`'s `ensureOrgRootObject` creates it
    // with `id: orgId`), which is the same scope `getRegionalExecutors` reads the set at.
    scopeObjectId: check.orgId
  });
  if (allowed) return;

  const withdrawn = withdrawnKeys(check.before ?? {}, check.after);
  const act =
    check.after === null
      ? `deleting deployment-target '${check.objectId}'`
      : `removing ${withdrawn.map((k) => `'properties.${k}'`).join(" and ")} from deployment-target '${check.objectId}'`;
  throw forbidden(
    `${act} would withdraw it from its multi-region environment, which turns OFF the M15.6 ` +
      `no-silent-deploy gate for it (ADR-0017 §3): an unbound region target that stops declaring ` +
      `its region is dispatched against the shared default executor instead of being refused. ` +
      `Un-declaring a region requires 'object:write' at the org root — the same org-root bar ` +
      `GET /environments/{environment}/regional-executors takes to read the set. Declaring a ` +
      `region, and every other write on this target, is unchanged.`
  );
}
