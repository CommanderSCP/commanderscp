import type { GraphObject } from "@scp/schemas";
import type { TenantTx } from "../db/tenant-tx.js";
import { badRequest, forbidden } from "../errors.js";
import { hasPermission } from "../authz/resolve.js";
import { getPeerByIdOrName } from "./peers-repo.js";
import { isGovernanceManagedObjectType } from "../governance/governance-managed-types.js";
import { upsertObjectByUrn } from "../graph/objects-repo.js";
import { FEDERATION_IMPORT_ACTOR_ID } from "./import-repo.js";
import { isPeerBoundObjectType } from "./outpost-binding.js";
import { ensureFederationSelf } from "./self-repo.js";
import {
  assertEnforceableDependencySubscriptionScope,
  assertNoDelegatedDependencyUpdates
} from "../dependencies/subscription-authoring-guard.js";
import {
  assertMayWriteGovernanceLabels,
  assertSelectorKeysAreGovernanceLabels
} from "../governance/governance-labels.js";
import { assertPolicyScopeWithinAuthority } from "../governance/policy-scope-authz.js";

/**
 * Hand-fill for air-gapped outposts with no bundle transport at all (DESIGN.md §13): "manually
 * entered commander-origin objects are stored as `provenance: manual` shadow copies, flagged as
 * unverified in API and UI, and reconciled (confirmed or replaced) the next time a signed bundle
 * arrives."
 *
 * Reconciliation happens FOR FREE through the exact same single-writer-authority machinery a real
 * import uses (graph/objects-repo.ts): a hand-filled row is created here with
 * `federationImport: { originDomainId: <claimed commander's id>, revision: 0, provenance: 'manual' }`
 * — revision 0 so ANY later real import (which always carries `revision >= 1`) is guaranteed to
 * be treated as newer and overwrite it, and `originDomainId` already matches the peer the operator
 * claimed it came from, so the single-writer authority check in `updateObject` passes and the
 * `provenance` column naturally clears to `null` on that overwrite (a real, cryptographically
 * verified update always passes `provenance: null`). No separate "reconcile" code path exists
 * because none is needed — this IS the reconciliation mechanism, just invoked implicitly by the
 * next ordinary import.
 */
export interface HandFillInput {
  orgId: string;
  /** The REAL requesting subject, for authorization only — never the write's author. The row is
   *  still written as `FEDERATION_IMPORT_ACTOR_ID` with `provenance: 'manual'`, which is what makes
   *  the reconciliation above work. Required rather than optional so a new caller has to decide:
   *  `assertGovernanceAuthorityForHandFill` below is an authorization check, and an authorization
   *  check with a defaultable subject is one rename away from being a no-op. */
  actorObjectId: string;
  peerIdOrName: string;
  typeId: string;
  urn: string;
  name: string;
  properties?: Record<string, unknown>;
  labels?: Record<string, unknown>;
  /**
   * The REQUESTING operator — NOT the `FEDERATION_IMPORT_ACTOR_ID` this door hands to
   * `upsertObjectByUrn` to make the row look like a replica.
   *
   * Threaded because the governance-label refusal below is an AUTHORIZATION check, and the
   * synthetic import actor is a subject with no `objects` row and therefore no role bindings.
   * Resolving it would answer "no permission" for everyone, which reads as fail-closed and is
   * really an authorization check that has stopped depending on who is asking — the exact shape
   * `federation/domain-local.ts` warns about ("inventing a synthetic subject for those callers,
   * which is how an authorization check quietly becomes a no-op", in the opposite direction).
   */
  actorObjectId: string;
}

/**
 * THE FIFTH LOCAL WRITE DOOR, AND WHY IT NEEDS ITS OWN NARROWING (M16.2 phase A, review round 4).
 *
 * `handFillObject` is a free-form-`typeId` write door reachable by any `federation:write` operator, and
 * it stamps `federationImport`. That flag is what makes `graph/objects-repo.ts`'s peer-binding choke
 * point SKIP — a skip whose whole justification is "a replica's `peerDomainId` names the RECEIVING
 * instance's own domain, which is never one of its peers". That is true of the OUTPOST-side use and
 * FALSE of the COMMANDER-side one, where the operator supplies `properties.peerDomainId` freely. With
 * the blanket skip, hand-fill bypassed all three clause-(4) refusals: it accepted an UNPAIRED
 * `peerDomainId`, a `commander`-role peer (whose tier `GET /v1/federation/status` then reported), and a
 * SECOND live `outpost` object for a peer that already had a legitimate one — which then made the
 * commander's own `PATCH /v1/federation/outposts/{peer}` 409 forever.
 *
 * THE NARROWING, and why it is a self-comparison rather than the full guard. Applying
 * `assertOutpostPeerBinding` to every `federationImport` write is NOT safe: a genuine sync bundle can
 * legitimately carry the `outpost` object of a DIFFERENT outpost (commander → outpost A, full scope,
 * carrying outpost B's config), whose `peerDomainId` is not a peer of the receiver — refusing it would
 * abort the whole bundle (the fail-closed version-skew class this same review round fixed for
 * `additionalProperties`). So the JOURNAL path keeps the skip, and the narrowing lives HERE, at the one
 * other `federationImport` caller: a hand-filled peer-bound object may name ONLY this instance's own
 * `federation_self.domainId` — exactly the shape a real replica has, and the only shape the skip's
 * justification actually covers. Anything else is a commander-side claim about one of its peers, which
 * has a real door (`POST /v1/federation/outposts`) that enforces the binding.
 *
 * CENSUS (kept filterless on purpose): `federationImport` is supplied in exactly two modules —
 * `federation/import-repo.ts` (signature/chain-verified journal replay) and this one. There is no third.
 */
async function assertHandFillableType(tx: TenantTx, input: HandFillInput): Promise<void> {
  if (!isPeerBoundObjectType(input.typeId)) return;
  const raw = input.properties?.peerDomainId;
  const self = await ensureFederationSelf(tx, input.orgId);
  if (typeof raw !== "string" || raw !== self.domainId) {
    throw badRequest(
      `hand-fill cannot create a '${input.typeId}' object about another domain: properties.peerDomainId ` +
        `must be this instance's own federation domain id ('${self.domainId}') — that is the only shape a ` +
        `real replica has. To declare config ABOUT a paired outpost, use POST /v1/federation/outposts, ` +
        `which enforces the 1:1 peer binding (paired peer, role 'outpost', no duplicate)`
    );
  }
}

/**
 * M21.7 (ADR-0032 §6a census amendment) — THE `policy:write` HALF OF THE SAME PROBLEM, CLOSED BEFORE
 * IT WAS REACHABLE RATHER THAN AFTER.
 *
 * The filterless census of free-form-`typeId` write doors (recorded in
 * `governance/governance-managed-write-doors.integration.test.ts`) found five, and this is the fifth.
 * The other four are decided: `/objects/{type}` and `/discovery/accept` refuse the governance types
 * outright, `POST /plans` + apply and `POST /federation/overlays` demand `policy:write`. This one
 * demanded only `federation:write` and would have written a `policy` row for anyone holding it.
 *
 * THIS ONE WAS NOT A LIVE ESCALATION, AND THAT IS EXACTLY WHY IT NEEDED CLOSING. Measured on the
 * built-in role set: `federation:write` is granted to Administrator and Owner
 * (`drizzle/0012_federation.sql:218-219`) and `policy:write` to Administrator and Owner
 * (`drizzle/0010_governance.sql:174-175`) — the same two roles, and the route authorizes
 * `federation:write` at the ORG ROOT, where an Administrator's `policy:write` also sits. So no actor
 * reachable through today's API could use this. The safety was a COINCIDENCE between two independent
 * grant lists in two independent migrations, held in place by nothing: `roles.org_id` exists for
 * org-defined roles and `authz/resolve.ts` resolves permissions by list membership, so one custom
 * role with `federation:write` and no `policy:write` turns the coincidence into the overlay hole
 * again. The whole lesson of this milestone is that the door which is fine today because of a fact
 * stated somewhere else is the door the next census misses.
 *
 * A PERMISSION CHECK, NOT A TYPE REFUSAL — the overlay treatment, not the discovery one. Hand-fill's
 * REASON FOR EXISTING (DESIGN §13) is an air-gapped outpost with no bundle transport keying in a
 * commander-origin object by hand, and a commander-distributed global policy is squarely that. So
 * `policy` must keep working here; what changes is who may do it. Bar is org-root `policy:write`,
 * matching `federation/overlay-repo.ts`: hand-fill passes no `domainId`, so the row lands at org-root
 * containment, and `properties` is free-form, so an unscoped policy matching every target in the org
 * is one of the documents this admits.
 *
 * `input.actorObjectId` is the REAL subject and is used for nothing else. The write below still
 * carries `FEDERATION_IMPORT_ACTOR_ID`, which is the provenance/single-writer machinery the module
 * doc describes, and is precisely the synthetic subject an authorization check must never be handed.
 */
async function assertGovernanceAuthorityForHandFill(
  tx: TenantTx,
  input: HandFillInput
): Promise<void> {
  if (!isGovernanceManagedObjectType(input.typeId)) return;
  const ok = await hasPermission(tx, {
    orgId: input.orgId,
    subjectObjectId: input.actorObjectId,
    permission: "policy:write",
    // The org root object's id IS the org id (auth/local-auth.ts `ensureOrgRootObject`).
    scopeObjectId: input.orgId
  });
  if (!ok) {
    throw forbidden(
      `object type '${input.typeId}' is governance-managed: hand-filling one requires 'policy:write' ` +
        `at the organization root (a hand-filled row lands at org-root containment, and an unscoped ` +
        `policy matches every target in the org) — 'federation:write' alone is not that authority`
    );
  }
}

/**
 * ADR-0032 §6a — THE SECOND CHECK THIS DOOR HAS TO RUN FOR ITSELF, AND IT IS THE SAME REASON AS THE
 * FIRST.
 *
 * `graph/objects-repo.ts`'s `createObject`/`updateObject` refuse a group-scoped
 * `dependencySubscription` opt-out at the one choke point every local write door funnels through —
 * and, like the peer-binding guard above it, they SKIP that refusal when `federationImport` is set.
 * That skip buys one specific thing: `federation/import-repo.ts`'s `object_upsert` branch has no
 * try/catch, so a throw on the replay path aborts a whole signed bundle rather than one entry
 * (proposal §10 Q6). It is a statement about a CHANNEL that cannot absorb a refusal, not about the
 * data being trustworthy.
 *
 * Hand-fill stamps `federationImport` and therefore inherits that skip, and here it is unearned for
 * exactly the reason `assertHandFillableType` documents one function up: this is a LOCAL OPERATOR
 * ACTION, not an arriving bundle. `POST /v1/federation/hand-fill` takes a free-form `typeId` and
 * free-form `properties` from any `federation:write` holder, there is no chain to wedge and no
 * transport to interrupt, and the operator is right there to read the 400. Left exempt, this route
 * would be a one-request bypass of the whole clause — the same shape as the H1 hole, one guard later.
 *
 * CENSUS (kept filterless on purpose, and RE-RUN for this change, not inherited): `federationImport`
 * is supplied in exactly two modules — `federation/import-repo.ts` and this one. There is no third.
 * The same census is recorded at `graph/objects-repo.ts`'s two call sites; both places state it
 * because a census written down in only one of the two modules it constrains is a census that goes
 * stale in the other.
 *
 * Runs BEFORE the peer lookup, so a refused document costs nothing and cannot depend on which peer
 * was named.
 */
export async function handFillObject(tx: TenantTx, input: HandFillInput): Promise<GraphObject> {
  await assertHandFillableType(tx, input);
  await assertGovernanceAuthorityForHandFill(tx, input);
  assertEnforceableDependencySubscriptionScope({
    typeId: input.typeId,
    properties: input.properties
  });
  // M21.5 — the same door, the same closing. `handFillObject` wears the `federationImport` flag that
  // exempts the choke point, so both dependency-subscription authoring refusals must be called here
  // explicitly or a `federation:write` holder has the bypass they exist to close.
  await assertNoDelegatedDependencyUpdates(tx, {
    orgId: input.orgId,
    typeId: input.typeId,
    properties: input.properties
  });
  // THE GOVERNANCE-LABEL NAMESPACE — the third and fourth refusals this door has to run for itself,
  // and it is the same reason as the first two. Hand-fill wears the `federationImport` flag that
  // exempts `graph/objects-repo.ts`'s choke point, and here that exemption is unearned: this is a
  // free-form-`typeId`, free-form-`labels` LOCAL operator action reachable by any `federation:write`
  // holder, with no chain to wedge and no transport to interrupt. Left exempt, one request would
  // both plant a selector-scoped policy keyed on an ordinary label AND stamp reserved governance
  // labels without `policy:write` — the whole guard, bypassed at the same door that already had to
  // close two others.
  //
  // The permission check runs against the REQUESTING operator, never the synthetic
  // `FEDERATION_IMPORT_ACTOR_ID` this function passes to `upsertObjectByUrn` — see `actorObjectId`.
  assertSelectorKeysAreGovernanceLabels({
    typeId: input.typeId,
    properties: input.properties
  });
  // ...AND THE AUTHORIZATION HALF, which had never reached this door at all.
  //
  // `assertPolicyScopeWithinAuthority` deliberately does NOT live at the repo choke point — it is
  // AUTHORIZATION, not an invariant, and pushing it down would run it for the federation importer's
  // synthetic subject, "which is precisely how an authorization check quietly becomes a no-op"
  // (`routes/typed-registries.ts`'s note). So it stays at the doors — and its census names THREE:
  // that typed route plus `iac/plans-repo.ts`'s create and update branches. Hand-fill is a fourth
  // door, reached by a `federation:write` holder with a free-form `typeId` and free-form
  // `properties`, and it was not on the list: `POST /v1/federation/hand-fill` with
  // `{typeId:"policy", properties:{scope:{selector:{...}}}}` planted an org-wide policy with no
  // `policy:write` anywhere. That is the CRITICAL #1b vector the guard exists to close, reopened at
  // a door the guard's own comment names as reaching `createObject` without passing through it.
  //
  // Called with the REQUESTING operator for the same reason the label check above is — see
  // `actorObjectId`. This is exactly the shape the "authorization at the door" split prescribes; the
  // door simply had to be added to it.
  // Narrowed to `policy` exactly as `iac/plans-repo.ts`'s two calls are, not to every
  // governance-managed type: a `control` carries no `scope`, so widening this would silently impose
  // an ORG-ROOT bar on a document the typed `/controls` route gates at its own domain — a permission
  // regression smuggled in beside a security fix.
  //
  // NOT ADDRESSED HERE, and reported separately: this door still authorizes the WRITE itself with
  // `federation:write` rather than the `policy:write` that `iac/plans-repo.ts`'s `writePermissionFor`
  // demands for the same types. Raising that bar is a new decision with its own blast radius (an
  // air-gapped operator hand-filling commander governance config), not the completion of an existing
  // one, so it belongs to the owner rather than to this change.
  if (input.typeId === "policy") {
    await assertPolicyScopeWithinAuthority(tx, {
      orgId: input.orgId,
      actorObjectId: input.actorObjectId,
      properties: input.properties
    });
  }
  await assertMayWriteGovernanceLabels(tx, {
    orgId: input.orgId,
    actorObjectId: input.actorObjectId,
    // A hand-fill is an upsert, so an EXISTING row's governance labels are also reachable here; the
    // stored value is the honest `before`, and `{}` would silently permit a removal on the update
    // branch while refusing an identical no-op create.
    before:
      ((
        await tx.query.objects.findFirst({
          where: (t, { eq: eqOp, and: andOp }) =>
            andOp(eqOp(t.orgId, input.orgId), eqOp(t.urn, input.urn))
        })
      )?.labels as Record<string, unknown> | undefined) ?? {},
    after: input.labels ?? {},
    subject: `hand-filled ${input.typeId} '${input.urn}'`
  });
  const peer = await getPeerByIdOrName(tx, input.orgId, input.peerIdOrName);
  const { object } = await upsertObjectByUrn(tx, {
    orgId: input.orgId,
    typeId: input.typeId,
    actorObjectId: FEDERATION_IMPORT_ACTOR_ID,
    requestId: `federation-handfill:${input.urn}`,
    urn: input.urn,
    name: input.name,
    properties: input.properties,
    labels: input.labels,
    federationImport: { originDomainId: peer.id, revision: 0, provenance: "manual" }
  });
  return object;
}
