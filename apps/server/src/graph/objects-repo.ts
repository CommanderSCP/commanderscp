import { and, eq, isNull, or, sql, type SQL } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import {
  asContainmentDomainId,
  type ContainmentDomainId,
  type GraphObject,
  type TrustDomainId
} from "@scp/schemas";
import type { TenantTx } from "../db/tenant-tx.js";
import { objects, relationships } from "../db/schema.js";
import { badRequest, conflict, notFound, preconditionFailed } from "../errors.js";
import { isUniqueViolation } from "../db/pg-errors.js";
import { decodeCursor, encodeCursor, keysetAfter, keysetOrderBy } from "../pagination.js";
// Value import back into relationships-repo. Not a runtime cycle: relationships-repo imports only a
// TYPE from here (`FederationImportContext`), which erases at compile time.
import { deleteRelationship } from "./relationships-repo.js";
// No runtime cycle: containment.ts imports only drizzle, the tenant tx type and errors.
import { assertRootedContainmentParent, placementNamesObjectSql } from "./containment.js";
import { computeObjectContentHash } from "./content-hash.js";
import { deriveUrn } from "./urn.js";
import { requireObjectType } from "./type-registry-repo.js";
import { validateProperties } from "./property-validation.js";
import { appendAuditEvent } from "../audit/audit-repo.js";
import {
  assertOrgRetainsAdministrativeFloor,
  objectTouchesRoleAuthority
} from "../authz/role-binding-door.js";
import { eventBus } from "../events/event-bus.js";
import { ensureFederationSelf } from "../federation/self-repo.js";
import { assertOutpostPeerBinding, isPeerBoundObjectType } from "../federation/outpost-binding.js";
import { appendJournalEntry } from "../federation/journal-repo.js";
import {
  assertEnforceableDependencySubscriptionScope,
  assertNoDelegatedDependencyUpdates
} from "../dependencies/subscription-authoring-guard.js";
import { assertMayUndeclareRegionMembership } from "../coordination/region-membership-guard.js";
import {
  assertMayWriteGovernanceLabels,
  assertSelectorKeysAreGovernanceLabels
} from "../governance/governance-labels.js";
import { assertValidComponentSecurityDeclarations } from "../governance/component-declaration-guard.js";
import { assertValidCampaignRecipe } from "../governance/campaign-recipe-guard.js";
import { assertMayWidenCampaignDeadline } from "../governance/campaign-deadline-widening-guard.js";
import {
  assertDeclaredFactClauseIsNarrowed,
  assertScanRuleRequiresScanControl
} from "../governance/scan-rule-authoring-guard.js";
import {
  assertScanOverrideGrantNotSelfDecided,
  type ScanOverrideGrantDecisionWrite
} from "../governance/scan-override-grant-authoring-guard.js";
import type { JournalEntryKind } from "@scp/schemas";
import { canonicalJson } from "../util/canonical-json.js";
import {
  countContainmentDependents,
  policyReachFor,
  recordContainerDeletionReachChange,
  recordGovernanceReachChange
} from "../governance/governance-reach.js";

/**
 * M6 single-writer authority (DESIGN.md §13 — SECURITY-SENSITIVE, M6 PR body flag): "every object
 * has exactly one authoritative origin domain; non-authoritative copies are read-only replicas...
 * conflict resolution is 'authority wins' — no merge." `FederationImportContext` is the ONLY way
 * `createObject`/`updateObject`/`deleteObject` will accept/preserve a foreign `originDomainId` —
 * every ordinary route handler omits it, so every ordinary write stamps THIS domain's own
 * identity and can only ever touch rows this domain already owns (checked below). Only
 * `federation/import-repo.ts`'s bundle-apply path constructs one of these, and only after
 * `verifyJournalChain`/`verifyBundleSignature` have already passed — so a row's `originDomainId`
 * can never be forged into pointing at a domain that didn't cryptographically sign for it.
 */
export interface FederationImportContext {
  /** TRUST sense (ADR-0021 D4) — the security domain that authored the imported row. */
  originDomainId: TrustDomainId;
  revision: number;
  provenance?: "manual" | null;
  /**
   * RESYNC ONLY (§7.2.6 — SECURITY-SENSITIVE). When true, the revision-STALENESS guard is bypassed:
   * an incoming revision at or below what is already stored still OVERWRITES, instead of no-op'ing as
   * a stale replay. This is the ONLY way a lost-tail resync re-converges the graph on the exporter's
   * restored reality — the re-minted entries carry their ORIGINAL (now-stale) revisions, so without
   * this every one of them would silently no-op against the staleness guard ("converged nothing").
   *
   * It bypasses ONLY the staleness guard — NEVER the single-writer authority check (a resync still
   * cannot forge authorship of a row another domain owns). Set exclusively by the resync import path
   * under a mutually-authorized permit; no ordinary import or route ever sets it.
   */
  forceOverwrite?: boolean;
}

// NOTE: `change` objects deliberately stay `object_upsert`/`object_tombstone` here, even though
// `entryKind: "change_status"` also exists as a journal entry kind — that one is produced
// EXCLUSIVELY by `coordination/changes-repo.ts`/`coordination/transition.ts` with a distinct,
// richer state-machine-shaped payload (objectId/fromState/toState/...). Having two producers emit
// the SAME entryKind with two different payload shapes would make the importer's dispatch
// ambiguous — so the graph-object snapshot for a `change` and its lifecycle-state snapshot are
// kept as clearly separate entry kinds/payload shapes instead.
export function journalEntryKindFor(typeId: string, tombstone: boolean): JournalEntryKind {
  if (tombstone) return "object_tombstone";
  if (typeId === "policy") return "policy_upsert";
  return "object_upsert";
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

// `canonicalJson` moved to `util/canonical-json.ts` (M6 — see that module's doc comment for why:
// breaking an objects-repo -> journal-repo -> attestation -> objects-repo import cycle), imported
// above and re-exported here so every EXISTING import of `canonicalJson` FROM THIS module (several
// other files still do `import { canonicalJson } from "../graph/objects-repo.js"`) keeps compiling
// unchanged.
export { canonicalJson };

export function toGraphObject(row: typeof objects.$inferSelect): GraphObject {
  return {
    id: row.id,
    orgId: row.orgId,
    domainId: row.domainId,
    typeId: row.typeId,
    name: row.name,
    urn: row.urn,
    properties: row.properties as Record<string, unknown>,
    labels: row.labels as Record<string, unknown>,
    originDomainId: row.originDomainId,
    revision: row.revision,
    provenance: row.provenance as GraphObject["provenance"],
    domainLocal: row.domainLocal,
    // M20.7 (ADR-0031 §6c) — present only when locality was INHERITED. The two columns are written
    // and cleared together, so `id` present without `urn` is unreachable; the `?? ""` is a type
    // narrowing, not a fallback with meaning.
    domainLocalInheritedFrom: row.domainLocalInheritedFrom
      ? { id: row.domainLocalInheritedFrom, urn: row.domainLocalInheritedFromUrn ?? "" }
      : null,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    deletedAt: row.deletedAt?.toISOString() ?? null
  };
}

/**
 * The org's root graph object (type `organization`, `domain_id IS NULL`) — every other object's
 * containment chain terminates here, which is what lets the RBAC recursive CTE (authz/resolve.ts)
 * walk `domain_id` all the way to an org-level scope with one query and no NULL special-casing.
 * Created once at org bootstrap (auth/local-auth.ts).
 */
export async function getOrgRootObjectId(tx: TenantTx, orgId: string): Promise<string> {
  const row = await tx.query.objects.findFirst({
    where: (t, { eq: eqOp, and: andOp, isNull: isNullOp }) =>
      andOp(eqOp(t.orgId, orgId), eqOp(t.typeId, "organization"), isNullOp(t.domainId))
  });
  if (!row)
    throw new Error(`org ${orgId} has no root 'organization' object — bootstrap incomplete`);
  return row.id;
}

export interface CreateObjectInput extends ScanOverrideGrantDecisionWrite {
  orgId: string;
  typeId: string;
  actorObjectId: string;
  requestId: string;
  id?: string;
  urn?: string;
  name: string;
  /** CONTAINMENT sense (ADR-0021 D4). `undefined` = default to the org root object; `null` = this
   *  IS the org root (bootstrap only). */
  domainId?: ContainmentDomainId | null;
  properties?: Record<string, unknown>;
  labels?: Record<string, unknown>;
  /** M6: set ONLY by `federation/import-repo.ts` after signature/chain verification — see
   *  `FederationImportContext`'s doc comment. Preserves the imported row's true authoritative
   *  origin instead of stamping this domain as the author. */
  federationImport?: FederationImportContext;
  /**
   * M20.1 (ADR-0031 §1) — declare that this object never federates. Defaults to `false`.
   *
   * THIS IS THE ONLY PLACE IN THE CODEBASE THAT SETS `objects.domain_local`. `updateObject`,
   * `upsertObjectByUrn`'s update branch, `deleteObject`'s soft-delete and the campaign fairness
   * update all omit the column entirely, which is what makes locality immutable *by construction*
   * rather than by a guard someone can forget to add at a sixth write site.
   *
   * Deliberately NOT settable on the `federationImport` path: an imported row is by definition
   * something that crossed a boundary, so it is never domain-local. A journal entry carrying the
   * flag is dropped by `scope-filter.ts` before it can reach this function at all — this is the
   * defense-in-depth half, not the primary guard.
   */
  domainLocal?: boolean;
  /**
   * M20.7 (ADR-0031 §6c) — provenance for the `contains` containment route, which `createObject`
   * cannot see for itself: the edge to the container does not exist yet when this runs.
   * `graph/components-repo.ts::createComponentInService` supplies it.
   *
   * Passed SEPARATELY from `domainLocal` on purpose. Folding it into the boolean (as M20.5 did)
   * still makes the object local, but destroys the distinction between "the operator declared this"
   * and "it followed its container" — which is the entire question this field exists to answer.
   */
  domainLocalInheritedFrom?: { id: string; urn: string };
}

/**
 * Resolves the `domain_id` an object create should use: `undefined` defaults to the org root
 * object (see `getOrgRootObjectId`); `null` means "this object IS the org root" (bootstrap
 * only); an explicit id is validated to belong to the same org. Exported so route handlers can
 * resolve the same value for the pre-write RBAC scope check (authz/resolve.ts) without a second
 * round trip drifting from what `createObject` itself will use.
 */
export async function resolveDomainId(
  tx: TenantTx,
  orgId: string,
  domainId: ContainmentDomainId | null | undefined
): Promise<ContainmentDomainId | null> {
  return (await resolveContainmentParent(tx, orgId, domainId)).id;
}

/**
 * M20.5 (ADR-0031 §6a) — the same resolution as {@link resolveDomainId}, plus the parent's
 * **locality**, which a child inherits at its own create.
 *
 * ## Why this exists rather than a second lookup
 *
 * Both branches were ALREADY reading the parent row — `getOrgRootObjectId` selects the org root and
 * returns only its id, and the explicit branch selects the named parent purely to validate it exists.
 * Returning `domainLocal` from reads that already happen makes subtree inheritance cost **zero extra
 * queries**. That is not micro-optimisation: `createObject` is the hottest write path in the system
 * (the M1 DoD alone drives 5,000 sequential creates against a 180s budget that already runs at ~60%
 * of it on CI hardware), and a per-create SELECT added for a feature most creates never use is the
 * kind of thing that turns a green suite amber a month later.
 *
 * ## Why one hop is enough
 *
 * ADR-0031 §6a: every intermediate container is itself stamped at ITS create, so the immediate
 * parent's flag already equals what a full ancestor walk would return, by induction. That is what
 * keeps `containmentChain` — a recursive CTE — out of the write path, which §1 requires.
 *
 * The induction is load-bearing, and its precondition is that EVERY create door funnels through here
 * or through `graph/components-repo.ts::createComponentInService`. A future door that resolves a
 * containment parent by itself would silently produce a shared object inside a domain-local subtree;
 * `domain-local-inheritance.integration.test.ts` is the census that keeps that honest.
 */
export async function resolveContainmentParent(
  tx: TenantTx,
  orgId: string,
  domainId: ContainmentDomainId | null | undefined
): Promise<{ id: ContainmentDomainId | null; urn: string | null; domainLocal: boolean }> {
  // BOUNDARY (ADR-0021 D4): the org root is an ordinary object id being promoted into the
  // containment-parent role — this is the one place that answer becomes a containment domain id.
  if (domainId === undefined) {
    const root = await tx.query.objects.findFirst({
      where: (t, { eq: eqOp, and: andOp, isNull: isNullOp }) =>
        andOp(eqOp(t.orgId, orgId), eqOp(t.typeId, "organization"), isNullOp(t.domainId))
    });
    if (!root)
      throw new Error(`org ${orgId} has no root 'organization' object — bootstrap incomplete`);
    return { id: asContainmentDomainId(root.id), urn: root.urn, domainLocal: root.domainLocal };
  }
  // The org root itself (bootstrap): no parent, so nothing to inherit.
  if (domainId === null) return { id: null, urn: null, domainLocal: false };
  // A SOFT-DELETED PARENT IS NOT A PARENT, and this filter is the difference between a contained
  // row and an unreachable one. `authz/resolve.ts`'s `scopeExpandCte` joins
  // `parent_o.deleted_at IS NULL` on every hop, so an object parented under a tombstone has its
  // scope expansion terminate at itself — exactly the state `domain_id IS NULL` produced, reached
  // through a different value. Measured before this filter existed: `DELETE /domains/{d}` then
  // `PATCH /services/{s} {domainId: d}` returned 200, and the org-root admin's own next GET of that
  // service 403'd with "lacks 'object:read'", permanently. Policy still governs the row either way
  // (matching reads `properties.scope`, never placement), so the outcome is a governed object
  // nobody can read, edit, move back or delete.
  //
  // Applied here rather than at the doors on purpose: it needs no subject and gives the same answer
  // for every caller, which is this codebase's test for an INVARIANT (see
  // `federation/domain-local.ts`'s "authorization at the door, invariant at the repo"). The
  // federation import path is unaffected — `resolveImportDomainId` already filters `deleted_at` and
  // falls back to `undefined`, so a replica whose parent is locally tombstoned lands at the org root
  // rather than being refused.
  const parent = await tx.query.objects.findFirst({
    where: (t, { eq: eqOp, and: andOp, isNull: isNullOp }) =>
      andOp(eqOp(t.id, domainId), eqOp(t.orgId, orgId), isNullOp(t.deletedAt))
  });
  if (!parent)
    throw badRequest(`domainId '${domainId}' does not reference a live object in this org`);
  return { id: domainId, urn: parent.urn, domainLocal: parent.domainLocal };
}

export async function createObject(tx: TenantTx, input: CreateObjectInput): Promise<GraphObject> {
  const type = await requireObjectType(tx, input.typeId);
  const properties = input.properties ?? {};
  const labels = input.labels ?? {};
  validateProperties(type.propertySchema, properties);

  const containmentParent = await resolveContainmentParent(tx, input.orgId, input.domainId);
  const domainId = containmentParent.id;

  // M20.5 (ADR-0031 §6a) — INHERIT LOCALITY FROM THE CONTAINMENT PARENT, at create.
  //
  // An explicit `false` under a domain-local parent is REFUSED, not silently overridden. Both of the
  // silent options are worse: honouring it creates a federating object inside a subtree whose whole
  // point is that it stays home — its name alone can disclose what the subtree is about — while
  // quietly upgrading it to `true` would mean an operator who asked for a shared object got a local
  // one and was never told. A 400 at authoring time is the only outcome that leaves nobody with a
  // false belief.
  //
  // The `federationImport` path is exempt: an imported row crossed a boundary by definition, its
  // parent is a replica, and the coercion below already forces `false` for it regardless.
  if (!input.federationImport && containmentParent.domainLocal && input.domainLocal === false) {
    throw badRequest(
      `cannot create a non-domain-local object inside a domain-local container: the containing ` +
        `object '${domainId}' is domain-local, so everything created under it is too (ADR-0031 §6a). ` +
        `Omit domainLocal, or create this object under a different container.`
    );
  }

  const id = input.id ?? uuidv7();

  // THE ROOT-REACHABILITY INVARIANT, on the CREATE half of the same choke point `updateObject`
  // carries it on (see the long comment there, and `graph/containment.ts` for the three refusals).
  //
  // It was installed on the MOVE path only, and the reasoning that left creates out was "a fresh id
  // cannot already be an ancestor of the parent". That is true, and it covers exactly the ONE
  // refusal that ASKS about the child's id — the CYCLE. It says nothing about the other two, which
  // are properties of the PARENT's chain and of the row about to be written: the parent does not
  // itself reach the org root (an ancestor was soft-deleted), and — since the owner ruling of
  // 2026-08-18 — the new row would sit PAST `CONTAINMENT_WALK_MAX_DEPTH` (a parent at exactly the
  // bound has a complete chain, and a child under it is the ungovernable hop-eleven row every walk
  // refuses). Hence `childIsNew` — refusal 1 skipped, refusals 2 and 3 run, refusal 2 with height 0
  // and therefore without a downward walk; `containment.ts` carries the arithmetic and the retired
  // "running 2 on a create lowers a documented limit" reasoning, which was written against the
  // pre-ADR-0037 truncating walk.
  //
  // MEASURED on the real doors before this call existed, not reasoned about: soft-delete a domain,
  // then `POST /services {domainId: <a service still inside it>}` answered **201**, and the ORG-ROOT
  // ADMIN's own GET, PATCH and DELETE of the new row all answered **403 — permanently**, while the
  // principal bound inside the stranded subtree could see it and had nowhere to move it to. That is
  // byte-for-byte the unreachable row the move path refuses, produced through a different verb.
  //
  // AT THE REPO, for the same reason the update half is: `iac/plans-repo.ts`'s `executePlanDiff`
  // calls `createObject` DIRECTLY through its own drained check list and never touches
  // `graph/containment-parent-authz.ts`, so a fix at the door helper alone ships INERT for IaC apply
  // — which is a second, independent create door and was measured writing the unreachable row
  // happily. It needs no subject, and gives every caller the same answer, which is this codebase's
  // test for an invariant (`federation/domain-local.ts`: authorization at the door, invariant at the
  // repo).
  //
  // `domainId === null` is the org root's OWN create (bootstrap) — it has no parent whose chain
  // could be broken.
  //
  // `domainId === input.orgId` — the ORG ROOT as the parent — is skipped because the call is a
  // PROVABLE no-op there, not because it is cheap enough to be worth risking. All three refusals are
  // decided before the query returns:
  //
  //   - refusal 1 (cycle) does not run at all on a create: `childIsNew` is true, which is the whole
  //     point of that flag (see `containment.ts`).
  //   - refusal 2 (the depth bound) is decided in advance: the org root sits at hops 0, the new row
  //     has no subtree, so `0 + 1 + 0` is under any bound worth having — no walk can change it.
  //   - refusal 3 asks `ids.has(orgId)` over `containmentChain(orgId, orgId)`, and that walk seeds
  //     itself with the target row at depth 0. The org root IS the target, so it is in the set no
  //     matter what the recursive term finds — the answer cannot be anything but "rooted", however
  //     the graph above it is shaped.
  //
  // That is why the guard is `!== orgId` and not a broader "shallow parents are fine": for any OTHER
  // parent the walk is load-bearing (it is what caught the soft-deleted-ancestor create measured
  // below), and the moment the org root is not seeded at depth 0 this reasoning stops holding.
  //
  // It is not a micro-optimisation on a cold path either. `createObject` defaults an unnamed
  // `domainId` to the org root, so this is the MAJORITY create shape, and the M1 DoD drives 5,000
  // sequential creates against a 180s budget. MEASURED on this machine (500 iterations, warmed,
  // inside one transaction against the Testcontainers PostgreSQL):
  //
  //   isolated `assertRootedContainmentParent(parent = org root)`   0.93-1.04 ms/call
  //   end-to-end default `createObject`, before                          11.35 ms/create
  //   end-to-end default `createObject`, after (3 runs)          8.04 / 9.10 / 9.30 ms/create
  //
  // — a ~1 ms round trip removed from an ~11 ms create, for an answer that was fixed in advance.
  // The isolated figure is the honest one: it is the query that stops being issued. The end-to-end
  // spread is wider than 1 ms in both directions, so read it as corroboration, not as the measurement.
  //
  // Every other create still pays one bounded recursive-CTE round trip; unlike the update
  // half there is no "unchanged re-apply" to guard against, because a create always writes a parent.
  //
  // `federationImport` is exempt, exactly as it is on the update half and for the same reason: an
  // imported row's parent comes from `resolveImportDomainId`, which already filters tombstones and
  // falls back to the org root, and `federation/import-repo.ts`'s `object_upsert` branch has no
  // try/catch — one refusal here would abort a whole signed bundle and wedge that channel over a row
  // this domain does not own. The receiving domain also has no standing to referee the containment
  // its authoring domain chose.
  if (!input.federationImport && domainId !== null && domainId !== input.orgId) {
    await assertRootedContainmentParent(tx, {
      orgId: input.orgId,
      childId: id,
      parentId: domainId,
      childIsNew: true
    });
  }

  // M16.2 phase A (E1) — clause (4) of the authority-split rule, at the ONE choke point every LOCAL
  // write door funnels through (see `federation/outpost-binding.ts` for the rule and for why it is
  // here and not per-route). Skipped for `federationImport`, and that skip is NARROWER than it looks:
  // a JOURNAL replica's `peerDomainId` may name any domain the exporter knew about (a commander with
  // full sync scope carries outpost B's config down to outpost A), so applying the guard on the import
  // path would abort whole bundles. The skip is therefore kept for the verified journal path and
  // CLOSED AT THE OTHER `federationImport` CALLER — `federation/handfill-repo.ts`, whose
  // `assertHandFillableType` restricts a hand-filled peer-bound object to this instance's OWN domain
  // id. Those two modules are the complete census of `federationImport` suppliers.
  if (!input.federationImport && isPeerBoundObjectType(input.typeId)) {
    await assertOutpostPeerBinding(tx, { orgId: input.orgId, objectId: id, properties });
  }

  // ADR-0032 §6a (M21.3, review round) — A GROUP-SCOPED DEPENDENCY-SUBSCRIPTION OPT-OUT IS REFUSED,
  // installed HERE for exactly the reason the block above is: this is the one choke point every local
  // write door funnels through.
  //
  // It shipped in one place — the typed `/policies` routes' composed `validateWrite` — next to
  // `assertPolicyScopeWithinAuthority`, which was itself installed in THREE (that config plus
  // `iac/plans-repo.ts`'s create and update branches). Censusing the SIBLING is what exposed the hole:
  // `POST /plans` + `/plans/{id}/apply`, `POST /federation/hand-fill` and `POST /federation/overlays`
  // all reach `createObject` with a free-form `typeId` and free-form `properties`, and all three
  // planted the exact document the typed route answers 400 to. Adding three more calls would have
  // rebuilt the same rake for the next door; one call here covers every door that exists and every
  // door that will.
  //
  // ------------------------------------------------------------------------------------------------
  // THE EXEMPTION, AND WHY IT IS EXACTLY THIS WIDE
  // ------------------------------------------------------------------------------------------------
  // `federationImport` is skipped, and the reason is NOT "imported data is trusted" — it is that a
  // throw here is not survivable on that path. `federation/import-repo.ts`'s `object_upsert` branch
  // has NO try/catch, so one refusal aborts the WHOLE signed bundle and wedges that channel until an
  // operator intervenes (proposal §10 Q6; the same fail-closed version-skew class the `additionalProperties`
  // relaxation fixed for `outpost`). A receiving domain also has no standing to referee a document its
  // AUTHORING instance already accepted or refused: the guard is an authoring-time refusal by
  // construction, and the authoring instance is where it runs.
  //
  // BUT `federationImport` DOES NOT MEAN "ARRIVED OVER THE JOURNAL". CENSUS (filterless, re-run for
  // this change — `grep -rn federationImport apps packages tools`): it is SUPPLIED in exactly two
  // modules, `federation/import-repo.ts` (signature/chain-verified bundle replay) and
  // `federation/handfill-repo.ts`. Every other hit is a comment or a type declaration. That census
  // matches the one `federation/outpost-binding.ts` and `handfill-repo.ts` already assert, and it is
  // still true.
  //
  // Hand-fill is a LOCAL OPERATOR ACTION wearing the import flag: a `federation:write` holder typing a
  // free-form `typeId` + `properties` into `POST /api/v1/federation/hand-fill`. Nothing about it is a
  // channel that can wedge — there is no bundle, no chain, and the operator is standing right there to
  // read a 400. Exempting it would hand every operator the bypass this guard exists to close. So the
  // skip is kept for the verified journal path ONLY and CLOSED AT THE OTHER CALLER: `handfill-repo.ts`
  // calls the guard itself, before its upsert. That is the identical shape M16.2 clause (4) uses two
  // blocks above, for the identical reason, against the identical two-module census.
  if (!input.federationImport) {
    // M22.5 (ADR-0033 §6 guard 3) — the component's security DECLARATIONS, strict at the local
    // author's door and open on the wire. Installed HERE rather than at the component routes for
    // exactly the reason the two guards below are: a filterless census of doors reaching this
    // function with free-form `properties` found four, and a per-route install would have missed
    // three of them (`governance/component-declaration-guard.ts` names them).
    assertValidComponentSecurityDeclarations({ typeId: input.typeId, properties });
    // M25.4 (ADR-0041) — the CAMPAIGN RECIPE, here for the identical reason its neighbours are and
    // against the identical `federationImport` census. `POST /campaigns` is only ONE of the three
    // doors that reach `campaign.properties`; IaC apply (`iac/plans-repo.ts`) calls this function
    // DIRECTLY with a free-form `typeId` and free-form `properties`, so a guard at the campaign
    // route would never see it. See `governance/campaign-recipe-guard.ts`, including why `change`
    // is deliberately NOT guarded here.
    assertValidCampaignRecipe({ typeId: input.typeId, properties });
    assertEnforceableDependencySubscriptionScope({ typeId: input.typeId, properties });
    // M22.5 — the OTHER half of ADR-0033 §6's split, and the half the line above cannot reach. That
    // one bounds what a COMPONENT may declare; this one bounds what a POLICY may do with a
    // declaration. A `declared_fact` clause carrying no narrowing matcher excludes every finding at
    // every severity, and admission is per CLASS — so no tier above can see the clause's reach and
    // consent to it. See `scan-rule-authoring-guard.ts`.
    //
    // Ordered here, among the SYNCHRONOUS refusals and ahead of every awaited one, for the reason
    // stated on the M22.8 guard below: it reads only the document, so a bad write is rejected before
    // anything pays for a round trip.
    assertDeclaredFactClauseIsNarrowed({ typeId: input.typeId, properties });
    // M21.5 — the SECOND dependency-subscription authoring refusal, installed at this same choke
    // point for the same reasons and under the same `federationImport` exemption (see above and
    // `subscription-authoring-guard.ts`'s M21.5 section). It is `await`ed because it reads a stored
    // probe verdict; it performs no provider I/O and holds nothing open across a network call.
    await assertNoDelegatedDependencyUpdates(tx, {
      orgId: input.orgId,
      typeId: input.typeId,
      properties
    });
    // THE RESERVED GOVERNANCE LABEL NAMESPACE — the THIRD and FOURTH refusals at this choke point,
    // here for the identical reason the two above are, against the identical `federationImport`
    // census, and closed at the identical other caller (`federation/handfill-repo.ts`).
    //
    // A selector-scoped policy's match key must be out of its own subject's write reach, in both
    // directions: the DOCUMENT may only key on a reserved label, and the reserved LABEL may only be
    // written by org-root `policy:write`. Installing either half alone leaves the evasion — a
    // namespace nobody is required to use, or a required namespace anyone may edit. See
    // `governance/governance-labels.ts`.
    assertSelectorKeysAreGovernanceLabels({ typeId: input.typeId, properties });
    await assertMayWriteGovernanceLabels(tx, {
      orgId: input.orgId,
      actorObjectId: input.actorObjectId,
      before: {},
      after: labels,
      subject: `${input.typeId} '${input.name}'`
    });
    // M22.8 — the FIFTH authoring refusal at this choke point, and the one that ends M22's most
    // common first-time experience: a `scanThreshold`/`scanExclusion` rule that requires no scan
    // control constrains nothing, silently (the reconcile prewarm never even resolves the two
    // dimensions, and no scan verdict is ever produced for them to act on). Installed here rather
    // than at the `/policies` route for the reason the four above are — `POST /plans` +
    // `/plans/{id}/apply`, `POST /federation/hand-fill` and `POST /federation/overlays` all reach
    // this function with a free-form `typeId` and free-form `properties`, and a per-route install
    // would miss all three.
    //
    // Ordered LAST of the five deliberately: it is the only one that issues a query of its own (it
    // reads the org's controls to ask whether any scan control is required), so every cheaper
    // refusal above — two of them purely synchronous — gets to reject a bad write before this one
    // spends a round trip.
    await assertScanRuleRequiresScanControl(tx, {
      orgId: input.orgId,
      typeId: input.typeId,
      properties
    });
    // M22.6 (ADR-0033 §6a) — the FOURTH authoring refusal at this choke point, and the one that ends
    // the override design's second door. `scan_override_grant` being governance-managed maps the IaC
    // path to `policy:write`, which a routine domain-scoped policy author holds — so the manifest
    // `{status: "approved", expiresAt: "2999-…"}` was accepted with no tier check on the rule being
    // waived, no Decision and no audit event. Installed here for the reason the three above are: a
    // per-route install would miss `POST /plans` + `/plans/{id}/apply`, `POST /federation/hand-fill`,
    // `POST /federation/overlays` and the typed registries.
    assertScanOverrideGrantNotSelfDecided({
      typeId: input.typeId,
      properties,
      isDecisionWrite: input.scanOverrideGrantDecision
    });
  }

  const urn = input.urn ?? deriveUrn(input.orgId, input.typeId, input.name);
  const version = 1;
  const contentHash = computeObjectContentHash({
    id,
    orgId: input.orgId,
    domainId,
    typeId: input.typeId,
    name: input.name,
    urn,
    properties,
    labels,
    version
  });

  // M6 single-writer authority: an ordinary (non-import) create always stamps THIS domain's own
  // identity as the author. Only `federation/import-repo.ts` supplies `federationImport`, and only
  // after the incoming entry's signature/chain has already verified — a normal route handler has
  // no way to make an object claim a foreign `originDomainId`.
  const self = input.federationImport ? null : await ensureFederationSelf(tx, input.orgId);
  const originDomainId = input.federationImport?.originDomainId ?? self!.domainId;
  const revision = input.federationImport?.revision ?? 1;
  const provenance = input.federationImport?.provenance ?? null;
  // M20.1 (ADR-0031 §1). Forced `false` on the import path regardless of what the caller passed: a
  // row that arrived over the journal is, by definition, one that crossed a boundary, so it cannot
  // be domain-local. Coercing here rather than trusting `import-repo.ts` not to pass it keeps the
  // invariant at the choke point every write door funnels through.
  // M20.5 (ADR-0031 §6a): declared OR inherited. The `||` is the either-route rule — a container's
  // locality reaches its children without the child restating it, which is the whole ergonomic point
  // of the subtree layer. `containmentParent.domainLocal` is `false` on the import path by
  // construction (a replica's parent is a replica), and the ternary forces `false` there anyway.
  const declared = input.domainLocal === true;
  const inheritedContainer =
    input.domainLocalInheritedFrom ??
    (containmentParent.domainLocal && containmentParent.id && containmentParent.urn
      ? { id: containmentParent.id, urn: containmentParent.urn }
      : undefined);
  const domainLocal = input.federationImport ? false : declared || inheritedContainer !== undefined;

  // M20.7 (ADR-0031 §6c) — record WHY, not just whether.
  //
  // DECLARED WINS. A caller can pass `domainLocal: true` while creating under an already-local
  // container; the row records DECLARED (null provenance) because that is what the operator actually
  // did, even though the object would have been local anyway. Recording it as inherited would erase
  // an act that happened.
  //
  // `inheritedFrom` is therefore set ONLY when inheritance is what made it local — the caller did not
  // declare, and a container did. The two columns are written together and cleared together, so the
  // "id without urn" state is unreachable.
  const inheritedFrom =
    !input.federationImport && domainLocal && !declared ? (inheritedContainer ?? null) : null;

  let row: typeof objects.$inferSelect | undefined;
  try {
    [row] = await tx
      .insert(objects)
      .values({
        id,
        orgId: input.orgId,
        domainId,
        typeId: input.typeId,
        name: input.name,
        urn,
        properties,
        labels,
        originDomainId,
        revision,
        contentHash,
        provenance,
        domainLocal,
        domainLocalInheritedFrom: inheritedFrom?.id ?? null,
        domainLocalInheritedFromUrn: inheritedFrom?.urn ?? null,
        version
      })
      .returning();
  } catch (err) {
    if (isUniqueViolation(err, "objects_org_id_urn_key")) {
      throw conflict(`urn '${urn}' is already in use in this org`);
    }
    if (isUniqueViolation(err)) throw conflict(`object id '${id}' already exists`);
    throw err;
  }
  if (!row) throw new Error("failed to insert object");

  await appendAuditEvent(tx, {
    orgId: input.orgId,
    domainId,
    actorId: input.actorObjectId,
    action: `${input.typeId}.create`,
    subjectId: id,
    beforeHash: null,
    afterHash: contentHash,
    requestId: input.requestId,
    // M20.2 (ADR-0031 §2) — the audit segment carries `subjectId`, so without this the object's id
    // crosses on every mutation even though its `object_upsert` is withheld. The LOCAL audit row is
    // written unchanged; only the journal entry is withheld.
    subjectDomainLocal: domainLocal
  });
  // Only journal writes THIS domain actually authored — an imported row was already journaled (and
  // signed) by ITS origin domain; re-journaling it here would falsely claim co-authorship and
  // corrupt this domain's own hash chain with content it didn't originate (DESIGN §13 single-writer
  // authority: "no merge algorithm exists because none is needed").
  //
  // ...AND NEVER JOURNAL A DOMAIN-LOCAL OBJECT AT ALL (M20.2, ADR-0031 §2 as corrected). The first
  // cut journaled it and filtered it at export. That is wrong, and `domain-local-invisibility`
  // caught it: a filtered bundle is SPARSE, and `import-repo.ts` only accepts a sparse chain when
  // the RECEIVER's own `sync_scope` is narrow (`receiverExpectsContiguity = mode === 'full'`). A
  // `full`-scope peer — the default, and the widest — would refuse every bundle with a
  // contiguity-break 409 the moment any object in the org was declared domain-local. The feature
  // would have broken federation for exactly the most common peer.
  //
  // Not journaling is also STRICTLY MORE PRIVATE than filtering, which is what makes this a
  // correction rather than a workaround. A withheld-but-numbered entry leaks its own existence: the
  // gap in the sequence tells a peer how many local objects there are and when they changed — the
  // aggregate signal the owner explicitly declined (ADR-0031 "Alternatives", Q6). An entry that was
  // never allocated a sequence leaves nothing to count.
  //
  // The export-side filter in `federation/scope-filter.ts` therefore no longer has anything of ours
  // to catch, and is kept deliberately: it is the IMPORT-side defense against a peer that ships a
  // domain-local-stamped entry anyway. The stamps below remain for the same reason — so that if such
  // an entry is ever produced, both ends still recognise and drop it.
  if (!input.federationImport && !domainLocal) {
    await appendJournalEntry(tx, {
      orgId: input.orgId,
      entryKind: journalEntryKindFor(input.typeId, false),
      contentHash,
      payload: {
        id,
        orgId: input.orgId,
        domainId,
        typeId: input.typeId,
        name: input.name,
        urn,
        properties,
        labels,
        originDomainId,
        revision,
        version,
        // M20.1 (ADR-0031 §2) — stamped so `entryMatchesScope` stays a PURE, synchronous predicate
        // over one entry. That purity is not a style preference: the exporter filters with that
        // function and the importer re-applies it as defense in depth, and the importer cannot
        // query the sender's object state. Resolving locality by a lookup at export time would be a
        // design in which the two sides can silently disagree.
        //
        // Present ONLY when true, so a non-local object's payload stays BYTE-IDENTICAL to what
        // ships today — this is a pure addition for the declared minority, not a wire change for
        // every entry. (The entries that do carry it never cross, by construction.)
        ...(domainLocal ? { domainLocal: true } : {})
      }
    });
  }
  await eventBus.publish(tx, {
    orgId: input.orgId,
    type: `scp.object.created`,
    source: `/objects/${input.typeId}`,
    subject: id,
    data: { id, typeId: input.typeId, urn, name: input.name }
  });

  return toGraphObject(row);
}

function idOrUrnCondition(orgId: string, typeId: string, idOrUrn: string) {
  const base = and(eq(objects.orgId, orgId), eq(objects.typeId, typeId));
  return isUuid(idOrUrn) ? and(base, eq(objects.id, idOrUrn)) : and(base, eq(objects.urn, idOrUrn));
}

export async function getObjectByIdOrUrn(
  tx: TenantTx,
  orgId: string,
  typeId: string,
  idOrUrn: string,
  opts: { includeDeleted?: boolean } = {}
): Promise<GraphObject> {
  const conditions = [idOrUrnCondition(orgId, typeId, idOrUrn)];
  if (!opts.includeDeleted) conditions.push(isNull(objects.deletedAt));
  const row = await tx
    .select()
    .from(objects)
    .where(and(...conditions))
    .limit(1);
  if (row.length === 0 || !row[0]) throw notFound(`${typeId} '${idOrUrn}' not found`);
  return toGraphObject(row[0]);
}

function idOrUrnAnyTypeCondition(orgId: string, idOrUrn: string) {
  const base = eq(objects.orgId, orgId);
  return isUuid(idOrUrn) ? and(base, eq(objects.id, idOrUrn)) : and(base, eq(objects.urn, idOrUrn));
}

/**
 * Same lookup as `getObjectByIdOrUrn`, but without a fixed `typeId` — for M2 ownership ergonomics
 * (routes/ownership.ts) where the owner side of an `owns` edge can be a team/group/user/
 * service-account and the caller doesn't know which ahead of time. Endpoint-type constraints are
 * still enforced (by `createRelationship`, against the relationship type registry) — this helper
 * only resolves the id-or-urn to a live object, it does not validate the object's type.
 */
export async function getObjectByIdOrUrnAnyType(
  tx: TenantTx,
  orgId: string,
  idOrUrn: string,
  opts: { includeDeleted?: boolean } = {}
): Promise<GraphObject> {
  const found = await findObjectByIdOrUrnAnyType(tx, orgId, idOrUrn, opts);
  if (!found) throw notFound(`object '${idOrUrn}' not found`);
  return found;
}

/**
 * The same lookup, returning `undefined` instead of throwing — for the callers whose answer to "no
 * such object" is NOT a 404 on this request. Today that is the stage-dependency authority check
 * (`coordination/campaign-scope-authz.ts`), which must not turn an unresolvable reference on the
 * persist-then-process ingress path into a 4xx: that path's contract is that a caller-shaped defect
 * surfaces as a recorded refusal at process time, not as an error on the webhook/report POST.
 *
 * Shares the id-or-urn condition with `getObjectByIdOrUrnAnyType` rather than restating it, so the
 * "is it a UUID or a URN" rule can never mean one thing for a check and another for the write it
 * guards.
 */
export async function findObjectByIdOrUrnAnyType(
  tx: TenantTx,
  orgId: string,
  idOrUrn: string,
  opts: { includeDeleted?: boolean } = {}
): Promise<GraphObject | undefined> {
  const conditions = [idOrUrnAnyTypeCondition(orgId, idOrUrn)];
  if (!opts.includeDeleted) conditions.push(isNull(objects.deletedAt));
  const row = await tx
    .select()
    .from(objects)
    .where(and(...conditions))
    .limit(1);
  if (row.length === 0 || !row[0]) return undefined;
  return toGraphObject(row[0]);
}

export interface ListObjectsQuery {
  cursor?: string | undefined;
  limit: number;
  /** CONTAINMENT sense (ADR-0021 D4). */
  domainId?: ContainmentDomainId | undefined;
  includeDeleted?: boolean;
}

/**
 * The type-scoped object list — `/objects/{type}`, `/components`, `/objects/service` and every typed
 * registry, which are its FOUR callers and therefore ~23 wire routes.
 *
 * ------------------------------------------------------------------------------------------------
 * `readableFilter` — THE ROW-LEVEL READ SCOPE (role-model.md §8.2 step 4), AND WHY IT IS A PARAMETER
 * ------------------------------------------------------------------------------------------------
 * `authz/list-scope.ts`'s `authorizeListAndScope` produces it: `null` for a principal whose
 * authority covers the whole org, otherwise a subquery of the object ids their role bindings reach
 * downward. It arrives here as an already-decided value rather than being computed inside, because
 * the permission it must be computed with is the door's own (`object:read` for most, whatever
 * `readPermission` a typed registry declares for the rest) and it has to be the SAME permission the
 * door authorized with. Deciding both in one place at the door is what keeps those two from
 * drifting.
 *
 * It is a REQUIRED parameter, not an optional one, and that is deliberate: `undefined` would be
 * indistinguishable from "forgot", and forgetting is how a list door silently keeps returning the
 * whole org. A caller with no subject to scope to passes `null` explicitly and says why.
 *
 * IT GOES IN `conditions`, WHICH IS THE ENTIRE POINT. This query is keyset-paginated with
 * `.limit(query.limit + 1)` and derives `nextCursor` from the last row it actually selected, so a
 * filter applied anywhere but inside the statement is applied AFTER the LIMIT — shrinking pages,
 * and eventually producing whole empty pages that still carry a non-null `nextCursor`. §8.2
 * measured that on a 20,910-object estate: an assembly-bound principal's 5 readable components at
 * cursor ranks 97/140/254/339/440 of 18,500 yield ONE row on page 1 and zero on pages 6–185, while
 * 27 of 30 `apps/web` list call sites fetch exactly one page. Composed here, the page is full, the
 * cursor is honest, and there is no empty-page-with-cursor state.
 *
 * NOTE on `includeDeleted`: the descend behind the filter walks LIVE rows only (a tombstoned
 * ancestor stops the chain upward, so it must stop it downward too — `authz/readable-scope.ts`),
 * so a SCOPED principal asking for `includeDeleted` still sees no tombstones. That is not a
 * narrowing of anything: before this parameter existed those principals were refused the door
 * outright. An org-root principal gets `null` and is unaffected.
 */
export async function listObjects(
  tx: TenantTx,
  orgId: string,
  typeId: string,
  query: ListObjectsQuery,
  readableFilter: SQL | null
): Promise<{ items: GraphObject[]; nextCursor: string | null }> {
  const cursor = query.cursor ? decodeCursor(query.cursor) : null;
  const conditions = [eq(objects.orgId, orgId), eq(objects.typeId, typeId)];
  if (!query.includeDeleted) conditions.push(isNull(objects.deletedAt));
  if (query.domainId) conditions.push(eq(objects.domainId, query.domainId));
  // `null` adds NOTHING — not a match-everything condition, nothing at all — so the org-root
  // principal's statement is the one that shipped before this parameter existed, parameter list
  // included. An empty allow set is NOT spelled `null`; it arrives as a subquery that matches
  // nothing (`authz/readable-scope.ts`), so `if (readableFilter)` cannot confuse the two.
  if (readableFilter) conditions.push(sql`${objects.id} IN ${readableFilter}`);
  if (cursor) {
    // Millisecond-precision keyset via the shared helper: `created_at` is stored at microsecond
    // precision but the cursor round-trips through a millisecond JS `Date`, so a raw comparison
    // re-includes the boundary row and loops forever on a bulk same-transaction import. `keysetAfter`
    // truncates identically to the `keysetOrderBy` below — the two MUST agree. See pagination.ts.
    conditions.push(keysetAfter(objects.createdAt, objects.id, cursor));
  }

  const rows = await tx
    .select()
    .from(objects)
    .where(and(...conditions))
    .orderBy(...keysetOrderBy(objects.createdAt, objects.id))
    .limit(query.limit + 1);

  const hasMore = rows.length > query.limit;
  const page = hasMore ? rows.slice(0, query.limit) : rows;
  const last = page[page.length - 1];
  return {
    items: page.map(toGraphObject),
    nextCursor: hasMore && last ? encodeCursor(last) : null
  };
}

export interface UpdateObjectInput extends ScanOverrideGrantDecisionWrite {
  orgId: string;
  typeId: string;
  actorObjectId: string;
  requestId: string;
  idOrUrn: string;
  name?: string;
  /** CONTAINMENT sense (ADR-0021 D4). */
  domainId?: ContainmentDomainId | null;
  properties?: Record<string, unknown>;
  labels?: Record<string, unknown>;
  /** Optimistic concurrency (DESIGN.md §4.1) — required when set, mismatch is a 412. */
  expectedVersion?: number;
  /** M6: see `FederationImportContext`'s doc comment above `createObject`. */
  federationImport?: FederationImportContext;
  /** M16.2 phase A (review round 4) — THE UNVERIFIED-SHADOW ADOPTION ESCAPE HATCH, and nothing wider.
   *  Honored ONLY when the locked row carries `provenance = 'manual'` — a hand-filled, never-verified
   *  shadow copy that DESIGN §13 already declares "reconciled (confirmed or REPLACED)". When honored,
   *  this local write is permitted against a foreign-origin row and RE-STAMPS it as locally authored
   *  (`origin_domain_id` = this domain, `provenance` = NULL), so it journals and syncs onward like any
   *  other local object. A row with `provenance = NULL` — a signature-verified replica — is NEVER
   *  adoptable: the ordinary single-writer refusal still fires, because adopting one would make the
   *  next real import a single-writer violation and wedge that peer's sync. Set by exactly one caller
   *  (`federation/outposts-repo.ts`'s `reconcileOutpostConfig`), which is the API-level recovery path
   *  for a peer wedged by a duplicate hand-filled object. */
  unverifiedShadowOverride?: boolean;
}

// Uses the drizzle query builder (not raw `tx.execute(sql...)`) specifically so the result is
// auto-mapped from the DB's snake_case columns to `objects.$inferSelect`'s camelCase shape —
// `tx.execute()` returns raw pg driver rows (literal column names, bigint columns as strings),
// which is exactly right for the recursive-CTE named queries (graph/named-queries.ts,
// graph/traverse.ts — genuinely need raw SQL) but wrong here, where a normal `SELECT ... FOR
// UPDATE` maps 1:1 onto a query-builder call.
async function lockObjectRow(
  tx: TenantTx,
  orgId: string,
  typeId: string,
  idOrUrn: string
): Promise<typeof objects.$inferSelect> {
  const rows = await tx
    .select()
    .from(objects)
    .where(
      and(
        eq(objects.orgId, orgId),
        eq(objects.typeId, typeId),
        isUuid(idOrUrn) ? eq(objects.id, idOrUrn) : eq(objects.urn, idOrUrn),
        isNull(objects.deletedAt)
      )
    )
    .for("update");
  const row = rows[0];
  if (!row) throw notFound(`${typeId} '${idOrUrn}' not found`);
  return row;
}

export async function updateObject(tx: TenantTx, input: UpdateObjectInput): Promise<GraphObject> {
  const existing = await lockObjectRow(tx, input.orgId, input.typeId, input.idOrUrn);
  /** Non-null ONLY on the narrow unverified-shadow adoption below — the domain id this write re-stamps
   *  the row's authority to. `null` keeps `origin_domain_id` exactly as found (every other path). */
  let adoptedByLocalDomain: TrustDomainId | null = null;

  if (input.expectedVersion !== undefined && input.expectedVersion !== existing.version) {
    throw preconditionFailed(
      `version mismatch: expected ${input.expectedVersion}, current is ${existing.version}`
    );
  }

  // M6 single-writer authority (DESIGN §13 — SECURITY-SENSITIVE): the two cases below are the
  // enforcement point "a domain cannot mutate a replica it doesn't own" / "an outpost cannot claim
  // authorship of a commander-origin object" — every ordinary write funnels through here.
  if (input.federationImport) {
    // Importing a peer's update: the incoming entry's claimed authority MUST match who already
    // owns this row. If a bundle claims domain C authored an update to an object domain A
    // actually originated, that is a forged-authorship attempt — reject outright rather than
    // silently overwriting A's row with C's content.
    if (existing.originDomainId !== input.federationImport.originDomainId) {
      throw conflict(
        `single-writer authority violation: object '${existing.id}' is authoritatively owned by domain '${existing.originDomainId}', not '${input.federationImport.originDomainId}'`
      );
    }
    // Idempotent replay / interrupted-transfer resume (DESIGN §13, DoD "double-import is a
    // no-op"): a revision at-or-behind what's already stored is stale — return the row unchanged,
    // no audit event, no journal entry, no version bump. RESYNC (§7.2.6) bypasses this: under a
    // mutually-authorized permit a stale revision still OVERWRITES, so a lost-tail restore
    // re-converges instead of silently no-op'ing. The single-writer check above is NEVER bypassed.
    if (
      input.federationImport.revision <= existing.revision &&
      !input.federationImport.forceOverwrite
    ) {
      return toGraphObject(existing);
    }
  } else {
    // Ordinary local write attempting to touch a row this domain did not author.
    const self = await ensureFederationSelf(tx, input.orgId);
    if (existing.originDomainId !== self.domainId) {
      // The ONE exception, and it is gated on the row's own `provenance`, never on the caller's word
      // alone: an UNVERIFIED hand-filled shadow may be adopted as locally authored (see
      // `unverifiedShadowOverride`). A verified replica (`provenance` NULL) falls through and is refused.
      if (!(input.unverifiedShadowOverride && existing.provenance === "manual")) {
        throw conflict(
          `object '${existing.id}' is a read-only replica (authoritative domain '${existing.originDomainId}') — it cannot be mutated locally`
        );
      }
      adoptedByLocalDomain = self.domainId;
    }
  }

  const type = await requireObjectType(tx, input.typeId);
  const nextProperties = (input.properties ?? existing.properties) as Record<string, unknown>;
  const nextLabels = (input.labels ?? existing.labels) as Record<string, unknown>;
  validateProperties(type.propertySchema, nextProperties);

  // M16.2 phase A (E1) — the UPDATE half of the same choke point (see `createObject` above). An
  // update that rewrites `properties` must not be able to re-point the binding at an unpaired peer,
  // at a non-outpost peer, or at a peer another object already claims.
  if (!input.federationImport && isPeerBoundObjectType(input.typeId)) {
    await assertOutpostPeerBinding(tx, {
      orgId: input.orgId,
      objectId: existing.id,
      properties: nextProperties,
      // See the clash scan in `outpost-binding.ts`: an unverified hand-filled shadow must not be able
      // to veto an edit to the row that actually holds authority (that veto was the H1 wedge).
      ignoreUnverifiedClash: true
    });
  }

  // ADR-0032 §6a — the UPDATE half of the same choke point (see `createObject` above for the full
  // reasoning and for the `federationImport` census). Not optional: `updateObject` replaces
  // `properties` wholesale, so an ordinary PATCH/PUT that rewrites `scope`/`effects` can turn an
  // enforceable policy into an unenforceable one without ever passing through a create.
  //
  // `nextProperties` — the value about to be STORED — is what is checked, deliberately, rather than
  // `input.properties`. That makes the invariant a property of the ROW rather than of the request, so
  // a PATCH touching only `name` cannot leave a refused document in place. The cost is that a
  // grandfathered row (one planted through a door before this guard reached the choke point) becomes
  // un-editable until its scope is fixed — which is the remedy the error already names, and is the
  // fail-closed direction.
  if (!input.federationImport) {
    // M22.5 — the UPDATE half, checked against `nextProperties` (the value about to be STORED) for
    // the identical reason the two below are.
    assertValidComponentSecurityDeclarations({
      typeId: input.typeId,
      properties: nextProperties
    });
    // M25.4 — the UPDATE half, checked against `nextProperties` (the value about to be STORED) for
    // the identical reason its neighbours are: `updateObject` replaces `properties` wholesale, so an
    // ordinary PATCH/PUT — or an IaC apply's diff — can rewrite a valid recipe into an unreadable
    // one, or into a `rollback` kind, without ever passing through a create.
    assertValidCampaignRecipe({ typeId: input.typeId, properties: nextProperties });
    assertEnforceableDependencySubscriptionScope({
      typeId: input.typeId,
      properties: nextProperties
    });
    // M22.5 — the UPDATE half of the unnarrowed-`declared_fact` refusal, checked against
    // `nextProperties` for the identical reason its neighbours are, and it is the half that matters:
    // the attack is an EDIT. A policy authored with `pkgName: "openssl"` clears the create guard, and
    // a later PATCH that merely DROPS that key widens the clause from one package to every finding —
    // the same bytes-on-the-wire ambiguity the label delta below describes, where only the stored row
    // can tell a narrowing from a removal. Synchronous, so it sits ahead of the awaited refusals.
    assertDeclaredFactClauseIsNarrowed({ typeId: input.typeId, properties: nextProperties });
    // M21.5 — the UPDATE half, checked against `nextProperties` (the value about to be STORED) for
    // the identical reason the line above is: an ordinary PATCH that rewrites `scope`/`effects` can
    // turn an inert policy into an enabling one without ever passing through a create.
    await assertNoDelegatedDependencyUpdates(tx, {
      orgId: input.orgId,
      typeId: input.typeId,
      properties: nextProperties
    });
    // THE UPDATE HALF of the governance-label namespace, and the half that actually closes the
    // reported evasion — the attack is an EDIT, not a create. `nextLabels` vs `existing.labels` is a
    // DELTA over the stored row, deliberately, and it is a delta rather than a check on the request
    // field for two reasons at once: a PATCH that never mentions `labels` must stay free (the delta
    // is empty, so no permission is even resolved), and a full-replacement PUT that OMITS a
    // governance label is a REMOVAL and must be refused (the delta is not empty). Those two are the
    // same bytes on the wire and only the stored row can tell them apart.
    //
    // Ordered FIRST of the three because it is the cheapest: the selector check is pure and
    // synchronous, and the label check resolves a permission only when the delta is non-empty — so
    // a refused write never pays for the region walk below it.
    assertSelectorKeysAreGovernanceLabels({
      typeId: input.typeId,
      properties: nextProperties
    });
    await assertMayWriteGovernanceLabels(tx, {
      orgId: input.orgId,
      actorObjectId: input.actorObjectId,
      before: existing.labels as Record<string, unknown>,
      after: nextLabels,
      subject: `${input.typeId} '${existing.urn}'`
    });
    // M15.6 / ADR-0017 §3 — the UPDATE half of the un-declaration guard, checked against
    // `nextProperties` (the value about to be STORED) beside the two above and for the same reason:
    // `updateObject` replaces `properties` wholesale, so a full-replacement PUT that merely OMITS
    // `region` deletes it, and omission is the whole attack. See `region-membership-guard.ts` for
    // the measured evasion this closes and why the bar is org-root `object:write`.
    //
    // INDEPENDENT of the governance-label guards above: that pair keys on `labels`, this one on
    // `properties.region`/`properties.environment`. Same property (a match key writable by its own
    // subject), different key, different bar — neither subsumes the other.
    await assertMayUndeclareRegionMembership(tx, {
      orgId: input.orgId,
      actorObjectId: input.actorObjectId,
      typeId: input.typeId,
      objectId: existing.id,
      before: existing.properties as Record<string, unknown>,
      after: nextProperties
    });
    // OWNER RULING 2026-08-25 (D1 b-i) — WIDENING A CAMPAIGN'S DEADLINE. The UPDATE half and the
    // ONLY half: a create is always a first set, which the ruling leaves at `object:write`.
    //
    // Here rather than only at `POST /campaigns/{id}/deadline` for the reason
    // `assertValidCampaignRecipe` two guards up is here — `campaign-recipe-guard.ts`'s census of the
    // SAME property found three write doors, and a route-level guard is invisible to two of them.
    // The ruling shipped at the route alone, and IaC apply reaches this function directly with a
    // free-form `typeId` and free-form `properties`: a manifest that simply omitted `deadline`
    // produced exactly the effect the route refuses, at exactly the permission it was raised above.
    //
    // A DELTA OVER THE STORED ROW (`existing.properties` vs `nextProperties`), exactly like the two
    // guards above it and for the same two reasons at once: a PATCH that never mentions `deadline`
    // must stay free, and a full-replacement write that OMITS it is a REMOVAL and must be priced as
    // one. Those are the same bytes on the wire and only the stored row tells them apart.
    //
    // Cheap by construction on every write that is not about a campaign deadline: it returns before
    // resolving anything unless a READABLE deadline is stored and the incoming document releases it.
    // See `governance/campaign-deadline-widening-guard.ts` — including why it asks a strictly
    // NARROWER question than the route's check, so it can never refuse what the route admits, and
    // why `federationImport` (this block's exemption) leaves no local-actor bypass at hand-fill.
    await assertMayWidenCampaignDeadline(tx, {
      orgId: input.orgId,
      actorObjectId: input.actorObjectId,
      typeId: input.typeId,
      subjectObjectId: existing.id,
      before: existing.properties as Record<string, unknown>,
      after: nextProperties
    });
    // M22.8 — the UPDATE half, checked against `nextProperties` (the value about to be STORED) for
    // the identical reason the three above are: a PATCH that adds a `scanThreshold` effect, or one
    // that strips the `requireControls` effect out from under an existing ceiling, turns an
    // enforceable rule into an inert one without ever passing through a create.
    //
    // Ordered LAST of the four for the same reason as on the create half: it is the only one here
    // that issues its own query, so the synchronous selector check and the delta-gated label check
    // both get to refuse before this one pays for a round trip.
    await assertScanRuleRequiresScanControl(tx, {
      orgId: input.orgId,
      typeId: input.typeId,
      properties: nextProperties
    });
    // M22.6 — the UPDATE half, checked against `nextProperties` (the value about to be STORED) for
    // the identical reason the four above are. It is the half that matters MOST here: the same IaC
    // door that could mint an approved grant could also flip an already-DENIED one to `approved`,
    // which the `decide` route explicitly refuses.
    assertScanOverrideGrantNotSelfDecided({
      typeId: input.typeId,
      properties: nextProperties,
      isDecisionWrite: input.scanOverrideGrantDecision
    });
  }

  const nextName = input.name ?? existing.name;
  const nextDomainId = input.domainId === undefined ? existing.domainId : input.domainId;

  // THE TWO SUBJECT-FREE INVARIANTS BEHIND AN EXISTING ROW'S CONTAINMENT-PARENT WRITE, at the one
  // place it happens: the parent must still EXIST AND BE LIVE IN THIS ORG (the first call in the
  // block), and the row must still REACH THE ORG ROOT afterwards (the second). They are separate
  // questions with separate refusals — see the first call's comment for why the walk does not
  // subsume the liveness check, which is precisely the assumption that left the liveness half
  // uninstalled here for four rounds of work on this code.
  //
  // `upsertObjectByUrn`'s update branch delegates here; its only other `domain_id` write is
  // the federation hand-fill id replacement, which is `federationImport`-only and exempt below.
  //
  // At the REPO rather than at the doors on purpose — the doctrine `containment-parent-authz.ts`
  // states and `federation/domain-local.ts` argues: authorization at the door, invariant at the
  // repo. It needs no subject and gives every caller the same answer, and — decisively —
  // `iac/plans-repo.ts` reaches this function through its own drained check list without ever
  // calling that helper. A door-only cycle refusal ships INERT for IaC apply, which is the second
  // copy of this decision and was measured writing the cycle happily
  // (`routes/containment-move-cycle-and-source-authz.integration.test.ts` pins both doors).
  //
  // Guarded on an actual CHANGE, so an unchanged re-apply pays no recursive-CTE round trip, and
  // exempt for `federationImport`: an imported row's parent comes from `resolveImportDomainId`,
  // which already falls back to the org root, and a refusal here would abort a whole peer bundle
  // over a row this domain does not own.
  if (!input.federationImport && nextDomainId !== null && nextDomainId !== existing.domainId) {
    // THE VALIDATION HALF OF THIS WRITE — "does this id still name a LIVE object in this org?" —
    // and it belongs FIRST, ahead of the walk below, for two independent reasons.
    //
    // `createObject` has always resolved its parent through this function; `updateObject` never
    // did. It took `input.domainId` and put it on the column. `containment-parent-authz.ts`'s
    // module doc has named this split from the day it was written — "what the repo owns is the
    // invariant half: `resolveContainmentParent` (called from here) is what rejects a `domainId`
    // naming an object outside the org, and `createObject` still resolves the default parent for
    // itself" — and the update half of that sentence was never installed.
    //
    // WHY THE WALK BELOW IS NOT THIS CHECK, which is what made it survive four rounds of work on
    // this exact code. `assertRootedContainmentParent` walks `containmentChain(parentId)`, and that
    // walk deliberately does NOT filter `deleted_at` on its SEED row — "the TARGET itself is not
    // filtered — governance may legitimately be evaluated over a deleted object", which is correct
    // for its own purpose. The consequence here is that a TOMBSTONED parent seeds the walk, climbs
    // to the org root through its own still-live ancestors, and is pronounced rooted. The two
    // functions ask genuinely different questions and only one of them asks this one.
    //
    // MEASURED on the real doors before this call existed, not reasoned about. `POST /plans`
    // resolves a manifest's `domainId` ONCE, at plan-compute time, and PERSISTS the resolved id in
    // the plan's diff; `POST /plans/{id}/apply` is a separate request that replays that stored
    // pointer through this function without ever calling the door helper. Soft-delete the parent in
    // the window between them and apply answered **200**, the row landed under the tombstone, and
    // the ORG-ROOT ADMIN's own next GET, PATCH and DELETE of it all answered **403 — permanently**
    // (`authz/resolve.ts`'s `scopeExpandCte` joins `parent_o.deleted_at IS NULL` on every hop, so
    // the row's scope expansion terminates at itself). That is byte-for-byte the unrecoverable state
    // this column's guards exist to prevent, and `resolveContainmentParent`'s own comment records
    // being paid for once already through `PATCH /services/{s}`.
    //
    // The same TOCTOU on the CREATE branch of apply is already refused — because `createObject`
    // re-validates at APPLY time by calling this function. The asymmetry WAS the bug.
    //
    // FIRST, AND CHEAP. This is one PK-indexed SELECT; the walk below is a bounded recursive CTE
    // (~1 ms measured on this machine). Ordering the narrow refusal ahead of the broad walk is how
    // the guards on this path have been sequenced since they were installed, and it also produces
    // the RIGHT diagnostic: a dead parent reported as "does not reference a live object" rather than
    // as the walk's "does not itself reach the org root", which would send an operator to repair an
    // ancestor that is fine.
    //
    // GATED ON A CHANGE, WHICH IS ALSO THE FAIL DIRECTION — worth separating from the cost argument
    // the outer guard makes, because they happen to agree here and do not always. A row that is
    // ALREADY parented under a tombstone (grandfathered, or planted before this call existed) can
    // still be written, including by a full-replacement PUT that restates the parent it has: that
    // resolves to `nextDomainId === existing.domainId` and never reaches this check. That is
    // deliberate and is the opposite choice from ADR-0032 §6a's guard a few lines above, which
    // checks the value about to be STORED precisely so a grandfathered row becomes un-editable until
    // it is fixed. The difference is what "fixed" costs: an unenforceable policy document can be
    // rewritten by its author, whereas a detached row's only remaining principal is one bound
    // directly at it, and refusing its writes would take away the last handle anyone has on it.
    // Refuse NEW detachments; never brick an existing one further.
    //
    // The return value is discarded on purpose: the refusal is the whole point. The resolved id is
    // `nextDomainId` by construction for any non-null argument, and the `domainLocal` half is a
    // CREATE-only concern (ADR-0031 §2 — locality is immutable on an update, and `updateObject`
    // reads it from the ROW, never from the request).
    //
    // FEDERATION IMPORT IS EXEMPT, and here the exemption is PROVABLY INERT rather than a hole —
    // worth stating, because an exemption whose safety is only asserted is where the next one hides.
    // `import-repo.ts`'s `object_upsert` branch obtains its `domainId` from `resolveImportDomainId`,
    // which runs the identical `deleted_at IS NULL` filter and falls back to `undefined` (the org
    // root) for anything else, so an import can only ever arrive here with `undefined` or an id
    // already shown to be live and in-org — this guard could never fire for it. The exemption is
    // therefore kept for consistency with every sibling guard in this function, and because that
    // branch has NO try/catch: a refusal raised mid-bundle aborts a peer's whole signed journal and
    // wedges that channel over a row this domain does not own and has no standing to referee. If
    // `resolveImportDomainId` ever stops filtering tombstones, IT is the place to fix that — not
    // here, where the blast radius is a peer's entire sync rather than one entry.
    //
    // "PROVABLY INERT" is true of the LIVENESS half only. It is NOT true of the DEPTH half of the walk
    // below: `resolveImportDomainId` checks that the parent is a live in-org row and nothing about
    // how deep that row sits, so an imported row CAN land past `CONTAINMENT_WALK_MAX_DEPTH` (a
    // peer-authored nesting this org's tree cannot hold). Accepted, per the owner ruling of
    // 2026-08-18, for the reason above — the receiver does not referee a peer-authored containment,
    // and this branch's failure mode is per-CHANNEL, not per-entry — and stated here so "provably
    // inert" is never read as covering it. `containmentParentChainForDoor`'s conversion branch is
    // what answers a local write UNDER such a row.
    await resolveContainmentParent(tx, input.orgId, nextDomainId);

    // The MOVE half of the door invariant (owner ruling 2026-08-18): the row's whole live subtree
    // moves with it, so `assertRootedContainmentParent`'s refusal 2 counts
    // `hops(parent) + 1 + height(row)` here — `childIsNew` false is what makes it walk downward.
    await assertRootedContainmentParent(tx, {
      orgId: input.orgId,
      childId: existing.id,
      parentId: nextDomainId
    });
  }

  // CONTAINMENT ROUTE 1 — a `domain_id` MOVE changes which policies reach this object, under
  // `object:write`, which is weaker and differently held than the `policy:write` that authored them.
  // See `governance/governance-reach.ts` for the property and why the recording lives at this choke
  // point rather than at the ~18 route handlers that admit `domainId`.
  //
  // The `!==` guard is what keeps this off the ordinary write path: a PATCH that never mentions
  // `domainId`, and a full-replacement PUT restating the parent the row already has, both resolve to
  // `nextDomainId === existing.domainId` and cost NOTHING — no query, no walk. Only a genuine move
  // pays. Creates are not instrumented at all: a new object has no prior reach to have changed.
  const containmentMove =
    nextDomainId !== existing.domainId
      ? {
          from: existing.domainId,
          to: nextDomainId,
          before: await policyReachFor(tx, input.orgId, existing.id, input.actorObjectId)
        }
      : null;

  const nextVersion = existing.version + 1;
  const nextRevision = input.federationImport?.revision ?? existing.revision + 1;
  const nextProvenance = input.federationImport
    ? (input.federationImport.provenance ?? null)
    : // Adoption clears the `manual` flag: the row stops being an unverified shadow the moment this
      // domain takes authorship of it. Every other local write preserves `provenance` untouched.
      adoptedByLocalDomain !== null
      ? null
      : existing.provenance;
  const beforeHash = existing.contentHash;
  const afterHash = computeObjectContentHash({
    id: existing.id,
    orgId: input.orgId,
    domainId: nextDomainId,
    typeId: input.typeId,
    name: nextName,
    urn: existing.urn,
    properties: nextProperties,
    labels: nextLabels,
    version: nextVersion
  });

  const [row] = await tx
    .update(objects)
    .set({
      name: nextName,
      domainId: nextDomainId,
      properties: nextProperties,
      labels: nextLabels,
      version: nextVersion,
      revision: nextRevision,
      provenance: nextProvenance,
      ...(adoptedByLocalDomain !== null ? { originDomainId: adoptedByLocalDomain } : {}),
      contentHash: afterHash,
      updatedAt: new Date()
    })
    .where(eq(objects.id, existing.id))
    .returning();
  if (!row) throw new Error("failed to update object");

  await appendAuditEvent(tx, {
    orgId: input.orgId,
    domainId: nextDomainId,
    actorId: input.actorObjectId,
    action: `${input.typeId}.update`,
    subjectId: existing.id,
    beforeHash,
    afterHash,
    requestId: input.requestId,
    // M20.2 (ADR-0031 §2) — from the ROW, not the request: locality is immutable and unexpressible
    // on an update body, so `row` is the only truth.
    subjectDomainLocal: row.domainLocal
  });

  // AFTER the row is written and after its own `${typeId}.update` event, so the reach is computed
  // against the moved row (this transaction sees its own uncommitted write) and the audit chain
  // reads in causal order: the field changed, then this is what the change cost.
  if (containmentMove) {
    await recordGovernanceReachChange(tx, {
      orgId: input.orgId,
      actorObjectId: input.actorObjectId,
      requestId: input.requestId,
      subjectObjectId: existing.id,
      route: "domain_id",
      detail: { fromDomainId: containmentMove.from, toDomainId: containmentMove.to },
      before: containmentMove.before,
      subjectDomainLocal: row.domainLocal
    });
  }
  // See the identical note in `createObject` — never re-journal an imported row's own history, and
  // never allocate a journal sequence to a domain-local object (M20.2, ADR-0031 §2 as corrected).
  if (!input.federationImport && !row.domainLocal) {
    await appendJournalEntry(tx, {
      orgId: input.orgId,
      entryKind: journalEntryKindFor(input.typeId, false),
      contentHash: afterHash,
      payload: {
        id: existing.id,
        orgId: input.orgId,
        domainId: nextDomainId,
        typeId: input.typeId,
        name: nextName,
        urn: existing.urn,
        properties: nextProperties,
        labels: nextLabels,
        originDomainId: row.originDomainId,
        revision: nextRevision,
        version: nextVersion,
        // M20.2 (ADR-0031 §2). Read from the ROW, never from the request: locality is immutable and
        // `UpdateObjectRequestSchema` cannot express it, so the row is the only truth here.
        //
        // This stamp is not optional convenience — without it a domain-local object leaks on its
        // SECOND write. Its create entry would be filtered and every later `object_upsert` would
        // sail through carrying its id, urn, name, properties and labels, which is the whole object
        // arriving one revision late. The create-path stamp alone protects nothing.
        ...(row.domainLocal ? { domainLocal: true } : {})
      }
    });
  }
  await eventBus.publish(tx, {
    orgId: input.orgId,
    type: `scp.object.updated`,
    source: `/objects/${input.typeId}`,
    subject: existing.id,
    data: { id: existing.id, typeId: input.typeId, urn: existing.urn }
  });

  return toGraphObject(row);
}

export interface UpsertObjectByUrnInput {
  orgId: string;
  typeId: string;
  actorObjectId: string;
  requestId: string;
  urn: string;
  id?: string;
  name: string;
  /** CONTAINMENT sense (ADR-0021 D4). */
  domainId?: ContainmentDomainId | null;
  properties?: Record<string, unknown>;
  labels?: Record<string, unknown>;
  /** M6: see `FederationImportContext`'s doc comment above `createObject`. */
  federationImport?: FederationImportContext;
  /**
   * M20.1 (ADR-0031 §1/§6) — asymmetric by design: a **declaration** on the create branch, a
   * **precondition** on the update branch. See {@link assertDomainLocalUnchanged}.
   */
  domainLocal?: boolean;
}

/**
 * M20.1 (ADR-0031 §6) — locality is immutable, so on an EXISTING row `domainLocal` is a
 * precondition rather than a write.
 *
 * `undefined` (the overwhelmingly common case, and every caller that predates M20) asserts nothing.
 * A value EQUAL to the stored one is an idempotent no-op — load-bearing, because `PUT` is defined
 * as idempotent here and `scp apply` re-sends an unchanged stack routinely; if a matching
 * declaration 409'd, declaring locality in IaC would make the stack un-reappliable. A value that
 * DIFFERS is refused, in both directions and with the direction named:
 *
 *  - **shared → domain-local** is refused *permanently*, and no verb will ever grant it. Federation
 *    has no un-send: once a row's existence has crossed, a later claim that it is local asserts a
 *    confidentiality property the system cannot deliver, and answering 200 would be a lie.
 *  - **domain-local → shared** is a real, supported transition — but it is the deliberate one-way
 *    publication verb (M20.4), which re-journals the object's full current state and sweeps its
 *    edges. It is emphatically not a side effect of a `PUT` body, so the refusal here names that
 *    verb instead of silently doing half of it.
 */
function assertDomainLocalUnchanged(
  existing: { id: string; urn: string; domainLocal: boolean },
  requested: boolean | undefined
): void {
  if (requested === undefined || requested === existing.domainLocal) return;
  throw conflict(
    requested
      ? `object '${existing.id}' (urn '${existing.urn}') is not domain-local and cannot become ` +
          `domain-local: federation has no un-send, so an object whose existence may already have ` +
          `reached a peer can never be un-published (ADR-0031 §6). Use a DIFFERENT urn — this one ` +
          `is taken by the existing shared object, including if it has been soft-deleted.`
      : `object '${existing.id}' is domain-local; publishing it is an explicit one-way action, not ` +
          `a field edit — use the publication verb so the object and its edges are re-journaled ` +
          `together (ADR-0031 §6).`
  );
}

/**
 * `PUT /objects/{type}/{urn}` — idempotent upsert-by-URN (DESIGN.md §6). Creates the object if
 * no row exists for `(org_id, urn)`, otherwise fully replaces the mutable fields. Applying the
 * exact same request any number of times converges to the same graph state (fast-check-tested).
 */
export async function upsertObjectByUrn(
  tx: TenantTx,
  input: UpsertObjectByUrnInput
): Promise<{ object: GraphObject; created: boolean }> {
  const existingRows = await tx
    .select()
    .from(objects)
    .where(and(eq(objects.orgId, input.orgId), eq(objects.urn, input.urn)))
    .for("update");
  const existing = existingRows[0];

  if (!existing) {
    const created = await createObject(tx, {
      orgId: input.orgId,
      typeId: input.typeId,
      actorObjectId: input.actorObjectId,
      requestId: input.requestId,
      id: input.id,
      urn: input.urn,
      name: input.name,
      domainId: input.domainId,
      properties: input.properties,
      labels: input.labels,
      federationImport: input.federationImport,
      domainLocal: input.domainLocal
    });
    return { object: created, created: true };
  }

  // M20.1 (ADR-0031 §6) — the row exists, so this is a precondition, never a write. Checked BEFORE
  // the type/soft-delete checks would matter and before ANY mutation, for the same reason the
  // single-writer check below sits ahead of the idempotent-no-op shortcut: a refusal that can be
  // reached only after a partial write is not a refusal.
  assertDomainLocalUnchanged(existing, input.domainLocal);

  if (existing.typeId !== input.typeId) {
    throw conflict(`urn '${input.urn}' is already registered under type '${existing.typeId}'`);
  }
  if (existing.deletedAt) {
    throw conflict(`urn '${input.urn}' refers to a soft-deleted object`);
  }

  // M6 single-writer authority — checked BEFORE the idempotent-no-op shortcut below, so a
  // byte-identical replay against a replica this caller doesn't own still gets rejected rather
  // than silently "succeeding" via the content-equality fast path (an authority check reached only
  // through `updateObject` would never fire for that case).
  if (input.federationImport) {
    if (existing.originDomainId !== input.federationImport.originDomainId) {
      throw conflict(
        `single-writer authority violation: object '${existing.id}' is authoritatively owned by domain '${existing.originDomainId}', not '${input.federationImport.originDomainId}'`
      );
    }
  } else {
    const self = await ensureFederationSelf(tx, input.orgId);
    if (existing.originDomainId !== self.domainId) {
      throw conflict(
        `object '${existing.id}' is a read-only replica (authoritative domain '${existing.originDomainId}') — it cannot be mutated locally`
      );
    }
  }

  // M6 hand-fill reconciliation (DESIGN §13: "reconciled — CONFIRMED OR REPLACED — when a signed
  // bundle later arrives"): a hand-filled row (`provenance: 'manual'`) was created by an operator
  // who could not have known the real object's id (a human can't hand-type a UUID they've never
  // seen) — `handfill-repo.ts` generates a local placeholder id for it. When the REAL, signature-
  // verified import for the SAME urn later arrives carrying the object's true id, an ordinary
  // UPDATE would silently keep the WRONG (locally-generated) id forever — every future entry that
  // references the object by its real id (a relationship endpoint, a `domainId` parent, ...) would
  // then fail to resolve locally, since this org's row would still be filed under the placeholder
  // id. So this case REPLACES the id in place via `UPDATE ... SET id = ...` — never a hard DELETE
  // (`scp_app` is deliberately never granted DELETE on `objects`, DESIGN.md §4.1's append/soft-
  // delete-only discipline). If some OTHER row already references the placeholder id via a foreign
  // key (a relationship endpoint created against the unverified hand-filled row), this UPDATE
  // fails closed with a foreign-key violation rather than silently orphaning it — an acceptable
  // v1 scope boundary (hand-filled rows are expected to accumulate local references rarely, if
  // ever, before reconciliation). Never fires for an ordinary (non-hand-filled) reconciliation,
  // where the id is already correct and stable.
  if (
    input.federationImport &&
    existing.provenance === "manual" &&
    input.id &&
    input.id !== existing.id
  ) {
    const nextDomainId = input.domainId === undefined ? existing.domainId : input.domainId;
    const nextProperties = input.properties ?? {};
    const nextLabels = input.labels ?? {};
    const nextVersion = existing.version + 1;
    // CONTAINMENT ROUTE 1, SECOND WRITE SITE. This branch deliberately does NOT delegate to
    // `updateObject` (see the `subjectDomainLocal` note below), so it needs its own capture for
    // exactly the reason it needs its own audit stamp — and a recorder installed at one of two
    // write sites for one concept is this repo's most-repeated defect (CLAUDE.md's census rule).
    //
    // Reached only by signed-journal replay reconciling a hand-filled shadow onto its authoritative
    // id, so the actor is the federation import subject rather than a tenant — which is precisely
    // why it is worth recording: a peer's reconciliation can re-parent a local row, and that must be
    // as visible as a local operator doing it.
    //
    // This `domain_id` write carries NO containment door — neither the root-reachability walk nor
    // the depth bound (`assertRootedContainmentParent`). It is `federationImport`-only by the guard
    // above, so it wears the same carve-out `updateObject` states at its own call: the receiver does
    // not referee a peer-authored containment, and this branch's failure mode is per-CHANNEL (no
    // try/catch around `object_upsert`). Named here so the census of `domain_id` write sites reads
    // "two sites, one door, one deliberate carve-out" and not "one site forgotten".
    const reachBefore =
      nextDomainId !== existing.domainId
        ? await policyReachFor(tx, input.orgId, existing.id, input.actorObjectId)
        : null;
    const afterHash = computeObjectContentHash({
      id: input.id,
      orgId: input.orgId,
      domainId: nextDomainId,
      typeId: input.typeId,
      name: input.name,
      urn: input.urn,
      properties: nextProperties,
      labels: nextLabels,
      version: nextVersion
    });
    const [row] = await tx
      .update(objects)
      .set({
        id: input.id,
        name: input.name,
        domainId: nextDomainId,
        properties: nextProperties,
        labels: nextLabels,
        version: nextVersion,
        revision: input.federationImport.revision,
        originDomainId: input.federationImport.originDomainId,
        provenance: input.federationImport.provenance ?? null,
        contentHash: afterHash,
        updatedAt: new Date()
      })
      .where(eq(objects.id, existing.id))
      .returning();
    if (!row) throw new Error("failed to reconcile hand-filled object onto its authoritative id");

    await appendAuditEvent(tx, {
      orgId: input.orgId,
      domainId: nextDomainId,
      actorId: input.actorObjectId,
      action: `${input.typeId}.update`,
      subjectId: row.id,
      beforeHash: existing.contentHash,
      afterHash,
      requestId: input.requestId,
      // M20.2 (ADR-0031 §2) — `upsertObjectByUrn`'s own update branch; it does NOT delegate to
      // `updateObject`, so it needs its own stamp. Exactly the kind of second write site the
      // objects-table census exists to catch.
      subjectDomainLocal: row.domainLocal
    });
    if (reachBefore) {
      // `row.id` — the AUTHORITATIVE id this branch just moved the row onto, not the placeholder the
      // reach was captured under. The record must name the id every later reference will use.
      await recordGovernanceReachChange(tx, {
        orgId: input.orgId,
        actorObjectId: input.actorObjectId,
        requestId: input.requestId,
        subjectObjectId: row.id,
        route: "domain_id",
        detail: {
          fromDomainId: existing.domainId,
          toDomainId: nextDomainId,
          handFillReconciliation: true,
          previousObjectId: existing.id
        },
        before: reachBefore,
        subjectDomainLocal: row.domainLocal
      });
    }
    return { object: toGraphObject(row), created: false };
  }

  // True idempotency: replaying the exact same PUT body against an unchanged row is a no-op —
  // no version/revision bump, no audit event, no outbox event. Without this, a byte-identical
  // replay would still increment `version` forever, which is "safe" for federation convergence
  // (content matches either way) but not actually idempotent in the HTTP sense the endpoint
  // claims to be (fast-check-tested: graph/idempotency.integration.test.ts).
  const nextDomainId = input.domainId === undefined ? existing.domainId : input.domainId;
  const nextProperties = input.properties ?? {};
  const nextLabels = input.labels ?? {};
  // M6: a hand-filled row (`provenance: 'manual'`) whose content happens to already match an
  // arriving REAL import must still fall through to `updateObject` — never take the no-op fast
  // path — so `provenance` actually clears and `revision` actually advances. Otherwise a
  // byte-identical signed bundle would leave the object permanently stuck flagged "unverified"
  // even though it was JUST verified (DESIGN §13 hand-fill reconciliation).
  const provenanceWouldChange =
    input.federationImport !== undefined &&
    (input.federationImport.provenance ?? null) !== existing.provenance;
  if (
    !provenanceWouldChange &&
    existing.name === input.name &&
    existing.domainId === nextDomainId &&
    canonicalJson(existing.properties) === canonicalJson(nextProperties) &&
    canonicalJson(existing.labels) === canonicalJson(nextLabels)
  ) {
    return { object: toGraphObject(existing), created: false };
  }

  const updated = await updateObject(tx, {
    orgId: input.orgId,
    typeId: input.typeId,
    actorObjectId: input.actorObjectId,
    requestId: input.requestId,
    idOrUrn: existing.id,
    name: input.name,
    domainId: input.domainId,
    properties: input.properties ?? {},
    labels: input.labels ?? {},
    federationImport: input.federationImport
  });
  return { object: updated, created: false };
}

export async function deleteObject(
  tx: TenantTx,
  input: {
    orgId: string;
    typeId: string;
    actorObjectId: string;
    requestId: string;
    idOrUrn: string;
    /** M6: see `FederationImportContext`'s doc comment above `createObject`. */
    federationImport?: FederationImportContext;
    /** M16.2 phase A (review round 4) — see `UpdateObjectInput.unverifiedShadowOverride`. Honored ONLY
     *  for a `provenance = 'manual'` row, and a removal taken under it is deliberately NOT journaled:
     *  this domain never authored the shadow, so claiming authorship of its deletion would push a
     *  delete for a row the real authority still owns. Purely local cleanup, audited as usual. */
    unverifiedShadowOverride?: boolean;
  }
): Promise<void> {
  const existing = await lockObjectRow(tx, input.orgId, input.typeId, input.idOrUrn);
  /** True only on the narrow unverified-shadow removal — suppresses the journal append below. */
  let removedForeignShadow = false;

  if (input.federationImport) {
    if (existing.originDomainId !== input.federationImport.originDomainId) {
      throw conflict(
        `single-writer authority violation: object '${existing.id}' is authoritatively owned by domain '${existing.originDomainId}', not '${input.federationImport.originDomainId}'`
      );
    }
    // Stale replay → no-op, EXCEPT under a resync force-overwrite permit (§7.2.6), which must
    // re-apply the tombstone even at a stale revision so a lost-tail restore re-converges deletions.
    if (
      input.federationImport.revision <= existing.revision &&
      !input.federationImport.forceOverwrite
    )
      return;
  } else {
    const self = await ensureFederationSelf(tx, input.orgId);
    if (existing.originDomainId !== self.domainId) {
      if (!(input.unverifiedShadowOverride && existing.provenance === "manual")) {
        throw conflict(
          `object '${existing.id}' is a read-only replica (authoritative domain '${existing.originDomainId}') — it cannot be mutated locally`
        );
      }
      removedForeignShadow = true;
    }
  }

  // M15.6 / ADR-0017 §3 — the DELETE half of the un-declaration guard. Removing the ROW withdraws
  // the target from its multi-region environment just as surely as blanking `properties.region`
  // does, and it was the third measured evasion vector: `readDeclaredRegionMembership` filters
  // `deleted_at IS NULL`, so soft-deleting a region target that a proposed change already names
  // makes the gate stop firing and the wave target dispatch against the shared default executor.
  //
  // FIRST, ahead of the route-1 orphan guard and the containment-reach capture below, for the reason that capture itself was
  // placed after `assertRootedContainmentParent` in `updateObject`: a REFUSAL should not pay for
  // work whose only consumer is the write it refuses. This check is read-only and short-circuits on
  // `typeId !== 'deployment-target'`, so it costs nothing on the ordinary path, while the reach
  // capture below runs two recursive containment walks. Ordering them the other way would make
  // every refused un-declaration pay for a reach diff that is then thrown away with the
  // transaction. Neither guard reads the other's state — one authorizes, one observes — so the
  // order is purely a cost decision, and both still run strictly BEFORE the tombstone.
  if (!input.federationImport) {
    await assertMayUndeclareRegionMembership(tx, {
      orgId: input.orgId,
      actorObjectId: input.actorObjectId,
      typeId: input.typeId,
      objectId: existing.id,
      before: existing.properties as Record<string, unknown>,
      after: null
    });
  }

  // ---------------------------------------------------------------------------------------------
  // ROUTE-1 ORPHAN GUARD: a tombstoned domain parent makes its `domain_id` children permanently
  // unadministrable, so a delete that would do that is refused — not cascaded, not tolerated.
  //
  // Measured 2026-08-13 (two API calls, depth 1): delete a domain whose live children name it via
  // `objects.domain_id` → 200; every such child then 403s on UPDATE and DELETE forever, for the
  // org-root admin included, because the authz scope expansion joins parents on
  // `deleted_at IS NULL` and the child's one upward chain dead-ends at the tombstone.
  //
  // WIDENED TO ALL THREE DEPENDENT ROUTES (owner ruling 2026-08-18, proposal §9.3 / §9.6 Q3-A).
  // It used to guard route 1 alone, on the reasoning that route 2 (`contains` edges) has deliberate
  // CASCADE semantics and the reader-side filter backstops what the cascade cannot reach. THE OWNER
  // RETIRED THAT ASYMMETRY, and the measurement behind it is `countContainmentDependents`' own
  // (`governance/governance-reach.ts`): the cascade tombstones the EDGES, so a deleted service's
  // components stay LIVE and detached — and placements are worse still, because a placement names
  // its component and target by JSON PROPERTY, not by an edge the cascade can see, so deleting a
  // component today leaves its placements live and dangling. One rule now covers all three:
  //
  //   route 1  `objects.domain_id` children   — the measured incident above
  //   route 2  `contains` children            — a service's components, left live and detached
  //   routes 3+4  placements naming this row  — invisible to the cascade entirely
  //
  // The counts are the same three `countContainmentDependents` computes (kept as counts THERE, for
  // the reach Decision, because that record only needs the blast radius' size); here the rows are
  // ENUMERATED, because a refusal an operator cannot act on is a wall, not a guard.
  //
  // CONSEQUENCE WORTH STATING: deleting a component with placements is now REFUSED. That closes the
  // dangling-placement gap by refusal rather than by cascade — §9.6 Q3 offered the cascade and the
  // owner chose refusal, so a placement is removed by `DELETE /placements/{id}` and never implicitly.
  //
  // NOT applied on the federation-import path, and not when removing a foreign SHADOW row — the same
  // two carve-outs the edge cascade below has, for the same reason. The authoritative domain already
  // deleted this object, and refusing the import would silently diverge this replica from its
  // authority (a worse failure than the orphaning, which the reader-side deleted-ancestor filter at
  // least bounds); a shadow removal is purely local cleanup of a row this domain never authored. A
  // local child naming a foreign replica as its parent therefore CAN still be orphaned by that
  // authority's delete; recorded as a cost, same class as the replica edges the cascade cannot reach.
  if (!input.federationImport && !removedForeignShadow) {
    const domainChildren = await tx
      .select({ id: objects.id, urn: objects.urn, typeId: objects.typeId })
      .from(objects)
      .where(
        and(
          eq(objects.orgId, input.orgId),
          // asContainmentDomainId: the column is branded; "is anyone's containment parent this
          // row?" is precisely the containment-domain sense of the id (GLOSSARY, branded types).
          eq(objects.domainId, asContainmentDomainId(existing.id)),
          isNull(objects.deletedAt)
        )
      )
      .limit(6);
    const containsChildren = await tx
      .select({ id: objects.id, urn: objects.urn, typeId: objects.typeId })
      .from(relationships)
      .innerJoin(objects, eq(objects.id, relationships.toId))
      .where(
        and(
          eq(relationships.orgId, input.orgId),
          eq(relationships.typeId, "contains"),
          eq(relationships.fromId, existing.id),
          isNull(relationships.deletedAt),
          isNull(objects.deletedAt)
        )
      )
      .limit(6);
    // Placements name their endpoints by JSON property (`componentId` / `deploymentTargetId`), so
    // this arm COMPOSES `graph/containment.ts`'s `placementNamesObjectSql` — the one definition of
    // routes 3+4 read downward, which `containmentChildrenSql`'s arm 3 also composes. The guard, the
    // reach record (`countContainmentDependents`) and both containment walks therefore cannot
    // disagree about what depends on this row.
    //
    // ⚠️ IT WAS A HAND-TYPED COPY AND IT HAD DRIFTED, 2026-08-26. The predicate here was a RAW TEXT
    // comparison with no `UUID_TEXT_PATTERN` guard and no `::uuid` cast. `uuid` equality is
    // case-insensitive and `text` equality is not (measured, PostgreSQL 16), and every id compared
    // here comes out of a `uuid` column lower-case — so a placement whose `componentId` was written
    // as UPPER-CASE HEX was on this object's containment chain going UP, and INVISIBLE to this guard
    // coming down. BEHAVIOUR CHANGE, stated rather than folded in: deleting such a component or
    // deployment-target is now REFUSED instead of silently leaving the placement live and dangling,
    // which is this guard's whole purpose. It is not reachable through `createPlacement` (that
    // resolves both endpoints and writes their own ids), only through `createObject` directly —
    // federation import, or legacy rows — which is the same population `placementEndpointParentSql`'s
    // `CASE` guard exists for.
    const placementBlockers = await tx
      .select({ id: objects.id, urn: objects.urn, typeId: objects.typeId })
      .from(objects)
      .where(
        and(
          eq(objects.orgId, input.orgId),
          eq(objects.typeId, "placement"),
          isNull(objects.deletedAt),
          placementNamesObjectSql(sql`${objects.properties}`, sql`${existing.id}::uuid`)
        )
      )
      .limit(6);

    const label = (rows: { urn: string; typeId: string }[]): string => {
      const shown = rows.slice(0, 5).map((r) => `${r.typeId} '${r.urn}'`);
      return `${shown.join(", ")}${rows.length > 5 ? ", …" : ""}`;
    };
    const count = (rows: unknown[]): string =>
      rows.length > 5 ? "at least 5" : String(rows.length);

    const clauses: string[] = [];
    // VERBATIM the pre-widening sentence — the incident this guard was built for, and the copy the
    // existing suite reads. Widening the guard must not rewrite the diagnosis of the case it already
    // covered.
    if (domainChildren.length > 0) {
      clauses.push(
        `${count(domainChildren)} live object(s) still name it as their domain (objects.domain_id) — ` +
          `deleting it would orphan them permanently, because permission resolution stops at deleted parents and no admin could ever update or delete them again. ` +
          `Move them to another domain or delete them first: ${label(domainChildren)}`
      );
    }
    if (containsChildren.length > 0) {
      clauses.push(
        `${count(containsChildren)} live object(s) are still contained by it (a 'contains' edge, containment route 2) — ` +
          `the delete cascade tombstones the EDGES, not the children, so they would stay live and detached from every authority, governance and audit chain. ` +
          `Move them (PUT /components/{idOrUrn}/service) or delete them first: ${label(containsChildren)}`
      );
    }
    if (placementBlockers.length > 0) {
      clauses.push(
        `${count(placementBlockers)} live placement(s) still name it (placement route) — ` +
          `a placement references its component and target by property rather than by an edge, so nothing would tombstone them and they would be left live and dangling. ` +
          `Delete them first (DELETE /placements/{idOrUrn}): ${label(placementBlockers)}`
      );
    }
    if (clauses.length > 0) {
      throw conflict(`cannot delete '${existing.urn}': ${clauses.join(" ")}`);
    }
  }

  // THE ADMINISTRATOR FLOOR (`authz/role-binding-door.ts` §7) — DOOR C, HALF ONE: the RELEVANCE
  // PROBE, which has to be read HERE because the tombstone below and the edge cascade further down
  // both destroy the evidence it reads. The check itself runs at the END of this function.
  //
  // Tombstoning the USER who holds the org's only administrative binding removes no edge at all, so
  // the cascade's per-edge check cannot see it; tombstoning the TEAM that holds it cascades its
  // `member_of` edges, which the cascade's check does see. Both are covered by asking the invariant
  // once, after everything this function does.
  //
  // The probe is sound rather than convenient: the floor reads `role_bindings` rows at the org root,
  // `roles.permissions`, live `member_of` edges and `objects.deleted_at`/`type_id`. An object that
  // is no binding's subject and has no live `member_of` edge is in no candidate closure, and this
  // function's cascade will tombstone no `member_of` edge either — so its tombstone cannot change
  // the floor's answer. It reads exactly the two tables the floor reads, which is what keeps the
  // short-circuit honest as those inputs change.
  //
  // The same two carve-outs the cascade and the orphan guard take, for the same reasons: a peer's
  // `object_tombstone` must not be refused (it would abort the whole signed bundle and diverge this
  // replica from its authority), and a foreign-shadow removal is local cleanup of a row this domain
  // never authored.
  const touchesRoleAuthority =
    !input.federationImport && !removedForeignShadow
      ? await objectTouchesRoleAuthority(tx, input.orgId, existing.id)
      : false;

  // CONTAINMENT ROUTE 3 — TOMBSTONING A CONTAINER, which writes no containment field and yet
  // detaches everything beneath it (every route in `graph/containment.ts` skips a deleted ANCESTOR).
  //
  // Captured BEFORE the tombstone, and that ordering is the whole of it. The edge cascade further
  // down re-uses `deleteRelationship`, whose own route-2 recorder runs AFTER this row is already
  // tombstoned — so its before-reach has lost this container too and its diff is empty. The cascade
  // therefore records NOTHING on this path, which is why the container case is instrumented here
  // rather than assumed covered by the edges it deletes.
  const dependentCount = await countContainmentDependents(tx, input.orgId, existing.id);
  const containerReach =
    dependentCount > 0
      ? await policyReachFor(tx, input.orgId, existing.id, input.actorObjectId)
      : null;

  const nextRevision = input.federationImport?.revision ?? existing.revision + 1;
  await tx
    .update(objects)
    .set({
      deletedAt: new Date(),
      version: existing.version + 1,
      revision: nextRevision,
      updatedAt: new Date()
    })
    .where(eq(objects.id, existing.id));

  // ---------------------------------------------------------------------------------------------
  // CASCADE: an object's edges must not outlive the object.
  //
  // Deleting an object used to tombstone the object ROW alone, leaving every `relationships` row
  // touching it with `deleted_at IS NULL` — a live edge to a dead node. Measured on the live homelab
  // (2026-08-02): soft-deleting one component during the post-import-configuration.md §6 pair merge
  // took the estate from
  // 0 such edges to 1, and it had to be cleaned up by hand.
  //
  // It is not cosmetic, because the containment walk is built out of those edges.
  // `graph/containment.ts` route 2 walks `contains` from `r.to_id` to `r.from_id` filtering on the
  // EDGE's `deleted_at` only, so a dangling edge keeps a deleted service on a live component's chain
  // — and that chain is what `matchPoliciesForTargets`, `containmentScopeIds` and
  // `authz/resolve.ts`'s `scopeExpandCte` all read. A policy or role binding scoped at a DELETED
  // service would go on governing. (The walk now also skips deleted ancestors, which covers the rows
  // this cascade cannot reach — see below.)
  //
  // WHAT THIS DELIBERATELY DOES NOT DO:
  //
  //  - it does not run on the FEDERATION IMPORT path. The authoritative domain journals its own
  //    `relationship_tombstone` entries beside the `object_tombstone`; cascading here would tombstone
  //    at a revision that authority never issued, and the import would then reject its real entry as
  //    a stale replay.
  //  - it does not touch REPLICA edges (`originDomainId !== self`). `deleteRelationship` refuses
  //    those by design — single-writer authority — so they are skipped rather than attempted. Such an
  //    edge genuinely can outlive this object until its own authority removes it, which is precisely
  //    why the reader-side filter in `containment.ts` exists as well: this cascade cannot be
  //    complete on its own, and a fix that only prevented NEW dangling edges would leave both the
  //    foreign ones and every row already in the database.
  //  - it does not run for `removedForeignShadow`, which is local cleanup of a row this domain never
  //    authored and deliberately does not journal.
  if (!input.federationImport && !removedForeignShadow) {
    const self = await ensureFederationSelf(tx, input.orgId);
    const touching = await tx
      .select({ id: relationships.id })
      .from(relationships)
      .where(
        and(
          eq(relationships.orgId, input.orgId),
          isNull(relationships.deletedAt),
          eq(relationships.originDomainId, self.domainId),
          or(eq(relationships.fromId, existing.id), eq(relationships.toId, existing.id))
        )
      );
    for (const edge of touching) {
      // Reused rather than a bulk UPDATE on purpose: each tombstone gets its own audit event,
      // journal entry and event-bus publish, exactly as an operator-issued delete would. A bulk
      // update would silently drop all three, and the federation journal would then describe an
      // estate whose edges never went away.
      await deleteRelationship(tx, {
        orgId: input.orgId,
        actorObjectId: input.actorObjectId,
        requestId: input.requestId,
        id: edge.id
      });
    }
  }

  // THE ADMINISTRATOR FLOOR — DOOR C, HALF TWO. AFTER the tombstone AND after the edge cascade, so
  // it judges the state this whole operation actually leaves behind rather than modelling any part
  // of it. MEASURED before this guard, four plain sequential requests: `DELETE /objects/user/{id}`
  // on the org's only administrator returned 200 and left the estate holding a `role_bindings` row
  // naming a tombstone — unadministrable, hand-written SQL the only recovery.
  //
  // The cascade's own per-edge check (`graph/relationships-repo.ts`) already covers the case where
  // this row is a GROUP with members; that redundancy is deliberate and cheap. What only this call
  // catches is the row that IS the principal: tombstoning it removes no edge, so nothing in the
  // cascade fires.
  //
  // The predicate takes §0's org lock itself, which this transaction is already holding by now
  // (every `appendAuditEvent` in the cascade took the same key). See `role-binding-door.ts` §7.
  if (touchesRoleAuthority) {
    await assertOrgRetainsAdministrativeFloor(tx, {
      orgId: input.orgId,
      act: `deleting ${input.typeId} '${existing.urn}'`
    });
  }

  await appendAuditEvent(tx, {
    orgId: input.orgId,
    domainId: existing.domainId,
    actorId: input.actorObjectId,
    action: `${input.typeId}.delete`,
    subjectId: existing.id,
    beforeHash: existing.contentHash,
    afterHash: null,
    requestId: input.requestId,
    // M20.2 (ADR-0031 §2) — the delete's audit segment, paired with the tombstone stamp below.
    subjectDomainLocal: existing.domainLocal
  });
  if (containerReach) {
    await recordContainerDeletionReachChange(tx, {
      orgId: input.orgId,
      actorObjectId: input.actorObjectId,
      requestId: input.requestId,
      containerObjectId: existing.id,
      containerTypeId: input.typeId,
      dependentCount,
      reach: containerReach,
      subjectDomainLocal: existing.domainLocal
    });
  }
  // `!existing.domainLocal` — M20.2 (ADR-0031 §2 as corrected): the tombstone is allocated no
  // sequence either, so a domain-local object's DELETION is as invisible as its existence. This is
  // the easiest of the three to overlook, because a tombstone "carries no data" — but its payload
  // holds the id and the urn, and a urn is `urn:scp:<org>:<type>:<name>`.
  if (!input.federationImport && !removedForeignShadow && !existing.domainLocal) {
    await appendJournalEntry(tx, {
      orgId: input.orgId,
      entryKind: journalEntryKindFor(input.typeId, true),
      contentHash: existing.contentHash,
      payload: {
        id: existing.id,
        typeId: input.typeId,
        urn: existing.urn,
        // M20.2 (ADR-0031 §2) — the TOMBSTONE needs it too, and this is the easiest one to miss
        // because a tombstone "carries no data". It carries the id and the URN, and a URN is
        // `urn:scp:<org>:<type>:<name>` — the object's NAME in plain text. Letting a domain-local
        // object's deletion cross would leak both its existence and its name, and would additionally
        // tell a peer that something it was never shown has now been removed.
        ...(existing.domainLocal ? { domainLocal: true } : {})
      }
    });
  }
  await eventBus.publish(tx, {
    orgId: input.orgId,
    type: `scp.object.deleted`,
    source: `/objects/${input.typeId}`,
    subject: existing.id,
    data: { id: existing.id, typeId: input.typeId, urn: existing.urn }
  });
}
