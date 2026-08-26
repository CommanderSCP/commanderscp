import type { GraphObject } from "@scp/schemas";
import type { TenantTx } from "../db/tenant-tx.js";
import { badRequest, forbidden } from "../errors.js";
import { hasPermission } from "../authz/resolve.js";
import { getPeerByIdOrName } from "./peers-repo.js";
import {
  isGovernanceManagedObjectType,
  isProjectionBoundObjectType,
  projectionBoundRefusalDetail
} from "../governance/governance-managed-types.js";
import { upsertObjectByUrn } from "../graph/objects-repo.js";
import { isPairBoundObjectType } from "../graph/pair-bound-types.js";
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
import { assertValidComponentSecurityDeclarations } from "../governance/component-declaration-guard.js";
import { assertValidCampaignRecipe } from "../governance/campaign-recipe-guard.js";
import { assertScanOverrideGrantNotSelfDecided } from "../governance/scan-override-grant-authoring-guard.js";

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
  /**
   * The REAL requesting subject, for authorization only — NEVER the write's author. The row is
   * still written as `FEDERATION_IMPORT_ACTOR_ID` with `provenance: 'manual'`, which is what makes
   * the reconciliation above work, and what makes the row look like a replica.
   *
   * Required rather than optional so a new caller has to decide. THREE authorization checks below
   * resolve this subject, and all three are broken by a defaultable or synthetic value:
   * `assertObjectWriteAuthorityForHandFill` (the estate-authoring bar every hand-fill clears),
   * `assertGovernanceAuthorityForHandFill` (M21.7) and `assertMayWriteGovernanceLabels`. The
   * synthetic import actor has no `objects` row and therefore
   * no role bindings, so resolving IT would answer "no permission" for everyone — which reads as
   * fail-closed and is really an authorization check that has stopped depending on who is asking,
   * the exact shape `federation/domain-local.ts` warns about ("inventing a synthetic subject for
   * those callers, which is how an authorization check quietly becomes a no-op", in the opposite
   * direction). An authorization check with a defaultable subject is one rename away from a no-op.
   */
  actorObjectId: string;
  peerIdOrName: string;
  typeId: string;
  urn: string;
  name: string;
  properties?: Record<string, unknown>;
  labels?: Record<string, unknown>;
}

/**
 * THE FIFTH LOCAL WRITE DOOR, AND WHY IT NEEDS ITS OWN NARROWING (M16.2 phase A, review round 4).
 *
 * `handFillObject` is a free-form-`typeId` write door reachable by any operator holding
 * `federation:write` AND org-root `object:write` (`assertObjectWriteAuthorityForHandFill` below — it
 * was `federation:write` alone until that guard landed), and
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
  // PAIR-BOUND TYPES — THE FIFTH DOOR OF `graph/pair-bound-types.ts`'s CENSUS (2026-08-18).
  //
  // A `placement` is identified by a PAIR of objects, and every free-form-`typeId` door refuses it
  // for the reason that file records: this door takes free-form `properties`, so it would store two
  // unresolved, untyped UUIDs and — decisively — write NEITHER derived edge (`places`, `placed_at`),
  // leaving an island no traversal can reach. Hand-fill was the one free-form-`typeId` door the
  // census had not listed, and it had a SECOND hole the other four do not: a placement is CONTAINED
  // by both endpoints it names (containment routes 3 and 4, `graph/containment.ts`
  // `placementParentsSql`), and the depth door for that pair lives ONLY in
  // `graph/placements-repo.ts`'s `createPlacement`, which this path never reaches. MEASURED on the
  // pre-fix tree through the HTTP API: `POST /federation/hand-fill {typeId: "placement",
  // properties: {componentId: <a component at hop ten>, deploymentTargetId: <root target>}}` answered
  // 201 where `POST /placements` of the same pair answered the door's 400, and `containmentChain` of
  // the hand-filled row then threw ADR-0037's 409 — a live placement no policy, freeze or gate could
  // scope, readable through its one-hop `domain_id` route (hand-fill passes no `domainId`, so
  // `createObject`'s org-root shortcut skips D1 too).
  //
  // WHY REFUSE THE TYPE rather than run the pair arithmetic here: the arithmetic alone would leave
  // the edgeless island the four sibling doors already refuse, and a hand-filled placement has no
  // reconciliation story that needs it — a real bundle carries a placement as its own `object_upsert`
  // PLUS `relationship_upsert` entries, so nothing an operator could key in here is a shape the next
  // signed bundle would confirm. The `federationImport` carve-out this door wears is a statement
  // about a CHANNEL that cannot absorb a refusal (see `handFillObject` below); this is a local
  // operator's per-request POST, and its failure mode is one 403 to that operator.
  if (isPairBoundObjectType(input.typeId)) {
    throw forbidden(
      `object type '${input.typeId}' is identified by a pair of objects and cannot be hand-filled — ` +
        `use /api/v1/${input.typeId}s, which requires both endpoints, writes the derived edges ` +
        `atomically and enforces the containment depth bound for both (ADR-0037)`
    );
  }
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
  // M25.7 — AHEAD OF THE PERMISSION CHECK, BECAUSE FOR THIS TYPE THE PERMISSION IS THE WRONG
  // REMEDY. A `freeze` object is the wire half of a record whose enforcement half is a `freezes`
  // row that only `POST /api/v1/freezes` writes. Hand-filling one would federate a freeze that does
  // not exist at THIS instance and cannot be lifted at either end — here `DELETE /v1/freezes/{id}`
  // finds no row, and at the peer, which does rebuild the row, `lockFreezeRow` refuses because the
  // origin domain is foreign. The `policy:write` bar below would have admitted exactly that to any
  // holder of org-root `policy:write` + `federation:write`, neither of which is `freeze:write`.
  //
  // AND HAND-FILL'S OWN REASON FOR EXISTING DOES NOT REACH THIS TYPE. DESIGN §13's case is an
  // air-gapped outpost keying in a commander-ORIGIN object by hand so a later signed bundle
  // reconciles over it. A freeze hand-filled that way would be `provenance: 'manual'` with no
  // projection row until the real bundle arrives — i.e. an inert object where an operator believes
  // they installed a block — and the reconciling bundle would build the row itself anyway. The same
  // "nothing an operator keys in here is a shape the next bundle would confirm" argument the
  // pair-bound refusal above records.
  if (isProjectionBoundObjectType(input.typeId)) {
    throw forbidden(projectionBoundRefusalDetail(input.typeId, "a hand-fill"));
  }
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
 * `federation:write` STOPS BEING A GRAPH-WRITE PERMISSION AT THIS DOOR (owner decision, option (a):
 * "added, never substituted").
 *
 * THE HOLE. `POST /v1/federation/hand-fill` authorizes exactly one thing —
 * `{permission: 'federation:write', scopeObjectId: auth.orgId}` (`routes/federation.ts`) — and then
 * hands this function a free-form `typeId`, `urn`, `name`, `properties` and `labels`. The four
 * type-level refusals that precede this one are narrow by construction:
 * `assertHandFillableType` refuses pair-bound types (`placement`) and peer-bound types naming a
 * foreign domain, and `assertGovernanceAuthorityForHandFill` refuses projection-bound types
 * (`freeze`) and demands `policy:write` for governance-managed ones. Everything OUTSIDE those sets —
 * `service`, `component`, `assembly`, `deployment-target`, `change`, `campaign`, `execution-system`,
 * and every type an operator registers tomorrow — was admitted on `federation:write` alone, with
 * `object:write` demanded NOWHERE in the request's path. The module doc above conceded exactly this
 * in as many words ("takes a free-form typeId and free-form properties from any `federation:write`
 * holder"), and a conceded hazard is a signal to sweep, not evidence it was handled.
 *
 * WHY IT MATTERS NOW, and why the coincidence argument that saved the `policy` half does not save
 * this one. A `FederationAdmin` role holds `federation:read` + `federation:write` and DELIBERATELY
 * withholds `object:write`, on the stated invariant that "a federation administrator operates the
 * link, it does not edit the estate". That invariant was FALSE at runtime and this door was ONE of
 * the reasons — not the only one: one POST here authored an arbitrary `service`/`component`/`change`
 * row in the estate. Unlike M21.7's `policy:write` case — where the hole was latent because
 * `federation:write` and `policy:write` happen to land on the same two built-in roles — this role is
 * being written to hold one permission and not the other on purpose, so the hole is reachable by
 * design rather than by accident.
 *
 * THIS CHANGE ALONE DID NOT RESTORE THE INVARIANT — a SECOND increment did, and both halves are
 * needed. `federation:write` used to buy a two-step chain to estate write authority that never
 * touches this door:
 *
 *   1. `POST /api/v1/federation/peers` authorized exactly `{permission: 'federation:write',
 *      scopeObjectId: auth.orgId}` (`routes/federation.ts`) and takes the peer's Ed25519 `publicKey`
 *      VERBATIM FROM THE REQUEST BODY — so the holder could pair a peer against a keypair they
 *      generated themselves, i.e. install their own trust anchor.
 *   2. `POST /api/v1/federation/imports` authorizes the same single permission, and `applyEntry`'s
 *      `object_upsert` branch then resolves ANY registered `typeId` through `upsertObjectByUrn`
 *      (`federation/import-repo.ts`) — so a bundle signed with that keypair verifies and lands
 *      arbitrary rows.
 *
 * Pair-then-import was therefore estate write authority without `object:write` and without hand-fill.
 * The import half legitimately carries carve-outs rather than bars — a throw there aborts a peer's
 * WHOLE signed bundle and `inbox-loop.ts` re-fetches it forever, which is the wedge the
 * unregistered-type skip above exists to prevent — so the second bar belonged at PAIRING, and that
 * was escalated as a separate OWNER DECISION.
 *
 * RULED AND BUILT (owner ruling D4, 2026-08-25): step 1 now ALSO demands `federation:pair`
 * (`authz/resolve.ts`, drizzle/0094, `federation/federation-pair-authz.integration.test.ts`), which
 * FederationAdmin is written to withhold. Import, export, status, outposts, resync and poke stay on
 * `federation:write` so an established link keeps working. With this door's `object:write` bar and
 * that one, "a federation administrator operates the link, it does not edit the estate" is a property
 * the system has — but it is held up by TWO guards in two files, and removing either restores the
 * hole by a different route.
 *
 * ADDED, NEVER SUBSTITUTED. `federation:write` is still required at the route and is not weakened:
 * hand-fill remains a federation act, and this is a SECOND, INDEPENDENT bar in exactly the shape
 * `assertGovernanceAuthorityForHandFill` uses one function up, and the shape `routes/governance.ts`
 * uses when it demands `federation:write` ON TOP of `freeze:write` for a federating freeze.
 *
 * THE SCOPE IS THE ORG ROOT, AND THAT IS THE ROW'S REAL CONTAINMENT SCOPE — not a convenience.
 * `handFillObject` passes NO `domainId` to `upsertObjectByUrn`, so on the create branch
 * `graph/objects-repo.ts`'s `resolveContainmentParent(tx, orgId, undefined)` returns the org root
 * object and the row is filed there. That is the same org-root shortcut `assertHandFillableType`
 * records above (it is why a hand-filled row skipped the domain-local D1 check), and the org root
 * object's id IS the org id (`auth/local-auth.ts` `ensureOrgRootObject`). So `scopeObjectId:
 * input.orgId` names the object the row is genuinely contained by.
 *
 * ON THE UPDATE BRANCH the bar is deliberately still the org root, and it is the STRICTER choice
 * rather than the convenient one. A hand-fill of an EXISTING urn passes no `domainId` either, so
 * `upsertObjectByUrn` keeps `existing.domainId`, which a prior signed import may have placed deep in
 * a subtree. Checking THAT scope instead would be a strict WIDENING, not a refinement:
 * `authz/resolve.ts`'s `scope_expand` walks UPWARD ONLY, so an org-root grant already satisfies a
 * check at every descendant, while a subtree grant satisfies nothing at the root. Narrowing to the
 * row's own scope would therefore hand a subtree-scoped `object:write` holder a write onto a
 * signature-verified replica sitting inside their subtree — a row every other local door refuses
 * outright (`upsertObjectByUrn`'s read-only-replica 409, which hand-fill bypasses precisely because
 * it stamps `federationImport`). One bar, at the root, fails closed in both branches.
 *
 * AUTHORIZATION ONLY — AUTHORSHIP IS UNTOUCHED. `input.actorObjectId` is the REAL requesting
 * subject and is what this resolves; the ROW is still written as `FEDERATION_IMPORT_ACTOR_ID` with
 * `provenance: 'manual'`, which is the whole reconciliation mechanism the module doc describes. If a
 * later change "tidies" that by passing `actorObjectId` to the upsert, the next signed bundle stops
 * reconciling over the shadow. And resolving the synthetic import actor HERE would be worse than no
 * check at all: it has no `objects` row, so it has no bindings, so this would answer "no" for
 * everyone and read as fail-closed while having stopped depending on who is asking.
 *
 * ON THE SIBLING COMMENTS IN THIS FILE that describe the door as reachable by "any `federation:write`
 * holder": read "and org-root `object:write`" into each of them from here on. None of those guards
 * becomes unnecessary — every one of them is about whether the DOCUMENT is admissible (an
 * unvalidated `security` bag, a self-decided scan-override grant, a delegated dependency update, a
 * reserved governance label), and an `object:write` holder is precisely someone entitled to author
 * estate documents, so a document-validity refusal is exactly as load-bearing against them.
 */
async function assertObjectWriteAuthorityForHandFill(
  tx: TenantTx,
  input: HandFillInput
): Promise<void> {
  const ok = await hasPermission(tx, {
    orgId: input.orgId,
    subjectObjectId: input.actorObjectId,
    permission: "object:write",
    // The org root object's id IS the org id (auth/local-auth.ts `ensureOrgRootObject`), and it is
    // where a hand-filled row lands — see the docblock.
    scopeObjectId: input.orgId
  });
  if (!ok) {
    throw forbidden(
      `hand-filling a '${input.typeId}' writes a graph object into this organization's estate and ` +
        `requires 'object:write' at the organization root (a hand-filled row lands at org-root ` +
        `containment) — 'federation:write' operates the federation link and is not authority to ` +
        `author estate objects. Both are required; neither substitutes for the other`
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
 * free-form `properties` from any holder of `federation:write` plus org-root `object:write`
 * (`assertObjectWriteAuthorityForHandFill`), there is no chain to wedge and no
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
  // M22.5 (ADR-0033 §6) — the component-declaration guard is in the SAME position as the two below:
  // hand-fill wears the `federationImport` flag that exempts the choke point, but it is a LOCAL
  // operator action with no bundle to wedge, so the exemption does not apply to it and the guard is
  // called here explicitly. Skipping it would hand every `federation:write` holder a door that writes
  // an unvalidated `security` bag onto any component.
  //
  // ORDERED AHEAD of `assertGovernanceAuthorityForHandFill` on purpose (the #249/#251 pattern): this
  // refusal is synchronous and reads only the request, while the authority check walks containment in
  // the database. A malformed declaration is rejected without paying for the walk.
  assertValidComponentSecurityDeclarations({
    typeId: input.typeId,
    properties: input.properties ?? {}
  });
  // M25.4 (ADR-0041) — the same door, the same closing. Hand-fill is the second half of the
  // `federationImport` two-module census, and it is a LOCAL operator keying a document in by hand:
  // there is no bundle a 400 could wedge, and exempting it would hand every `federation:write`
  // holder an unvalidated write to `campaign.properties.recipe`.
  assertValidCampaignRecipe({
    typeId: input.typeId,
    properties: input.properties ?? {}
  });
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
  // M22.6 (ADR-0033 §6a) — the same door, the same closing, another guard. Hand-fill wears the
  // `federationImport` flag that exempts the choke point, and the exemption's reason (a throw aborts
  // a peer's whole signed bundle) is a statement about a CHANNEL that does not exist here. Left
  // exempt, `POST /v1/federation/hand-fill` would let any `federation:write` holder write
  // `{status: "approved", expiresAt: "2099-…"}` onto a grant with no tier check, no Decision and no
  // audit event — the exact bypass the guard exists to close, one door later.
  //
  // Ordered ahead of the awaited label check below (the #249/#251 pattern): this refusal is
  // synchronous and reads only the request, while `assertMayWriteGovernanceLabels` issues a lookup
  // for the stored row and resolves a permission.
  assertScanOverrideGrantNotSelfDecided({
    typeId: input.typeId,
    properties: input.properties ?? {}
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
  // WHY `assertPolicyScopeWithinAuthority` IS NOT ALSO CALLED HERE — measured, not assumed, and the
  // same argument `federation/overlay-repo.ts` records for the sibling door.
  //
  // An earlier draft of this change added it, on the reading that hand-fill was a door the check's
  // three-site census had missed. That was true of the tree it was written against and is no longer
  // true of this one: `assertGovernanceAuthorityForHandFill` above (M21.7) now refuses every
  // governance-managed `typeId` unless the REQUESTING operator holds `policy:write` AT THE ORG ROOT.
  // That is the same bar `assertPolicyScopeWithinAuthority`'s broadest branch (unscoped / selector /
  // group) asks for, and its narrow `objectRef` branch asks for `policy:write` at-or-above one
  // object, which an org-root grant satisfies because `authz/resolve.ts`'s `scope_expand` walks
  // UPWARD. So by the time control reaches here the check can no longer refuse anything — and an
  // inert authorization guard reads as coverage while providing none, which is strictly worse than
  // its absence.
  //
  // MEASURED: with the call added, deleting it again left the door's refusal test green (it was
  // `assertGovernanceAuthorityForHandFill` throwing all along), which is the definition of a guard
  // proved by nothing. The door's real coverage is
  // `governance/governance-managed-write-doors.integration.test.ts` DOOR 5.
  //
  // IF THAT PREMISE CHANGES, THIS COMES BACK: the argument rests entirely on the org-root bar above
  // being org-root and covering `policy`. Narrow `assertGovernanceAuthorityForHandFill`'s scope or
  // its type set and the scope check is load-bearing again.
  //
  // NOT ADDRESSED HERE, and reported separately: this door still authorizes the WRITE itself with
  // `federation:write` rather than the `policy:write` that `iac/plans-repo.ts`'s `writePermissionFor`
  // demands for the same types. Raising that bar is a new decision with its own blast radius (an
  // air-gapped operator hand-filling commander governance config), not the completion of an existing
  // one, so it belongs to the owner rather than to this change.
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
  // THE ESTATE-AUTHORING BAR — the last thing between this request and a row, and the ONLY refusal
  // here that does not read `typeId` at all. See `assertObjectWriteAuthorityForHandFill`.
  //
  // ORDERED LAST AMONG THE REFUSALS, which is the reverse of the #249/#251 cost argument and is
  // deliberate. Every check above names the SPECIFIC thing wrong with the document — a pair-bound
  // type, a foreign `peerDomainId`, a projection-backed `freeze`, a governance type needing
  // `policy:write`, a self-decided grant, a reserved label — and those are the actionable 403s. This
  // one is the broad "you may not author estate objects at all", and in FRONT it would MASK them:
  // `governance-managed-write-doors.integration.test.ts` DOOR 5 drives a `federation:write`-only
  // actor and asserts the refusal detail names `policy:write`, which is the claim that the
  // governance bar is installed here. Answering that request with an `object:write` 403 instead
  // would leave that case green while saying nothing about the guard it exists to prove — a test
  // passing for a reason unrelated to its claim, which is this codebase's most-repeated defect.
  //
  // Still ahead of the peer lookup and the write, so a refused request costs nothing, cannot depend
  // on which peer was named, and stores nothing.
  await assertObjectWriteAuthorityForHandFill(tx, input);
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
