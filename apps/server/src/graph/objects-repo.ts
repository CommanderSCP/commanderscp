import { and, eq, isNull, or } from "drizzle-orm";
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
import { computeObjectContentHash } from "./content-hash.js";
import { deriveUrn } from "./urn.js";
import { requireObjectType } from "./type-registry-repo.js";
import { validateProperties } from "./property-validation.js";
import { appendAuditEvent } from "../audit/audit-repo.js";
import { eventBus } from "../events/event-bus.js";
import { ensureFederationSelf } from "../federation/self-repo.js";
import { assertOutpostPeerBinding, isPeerBoundObjectType } from "../federation/outpost-binding.js";
import { appendJournalEntry } from "../federation/journal-repo.js";
import {
  assertEnforceableDependencySubscriptionScope,
  assertNoDelegatedDependencyUpdates
} from "../dependencies/subscription-authoring-guard.js";
import type { JournalEntryKind } from "@scp/schemas";
import { canonicalJson } from "../util/canonical-json.js";

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

export interface CreateObjectInput {
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
  const parent = await tx.query.objects.findFirst({
    where: (t, { eq: eqOp, and: andOp }) => andOp(eqOp(t.id, domainId), eqOp(t.orgId, orgId))
  });
  if (!parent) throw badRequest(`domainId '${domainId}' does not reference an object in this org`);
  return { id: domainId, urn: parent.urn, domainLocal: parent.domainLocal };
}

export async function createObject(tx: TenantTx, input: CreateObjectInput): Promise<GraphObject> {
  const type = await requireObjectType(tx, input.typeId);
  const properties = input.properties ?? {};
  const labels = input.labels ?? {};
  validateProperties(type.propertySchema, properties, type.id);

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
    assertEnforceableDependencySubscriptionScope({ typeId: input.typeId, properties });
    // M21.5 — the SECOND dependency-subscription authoring refusal, installed at this same choke
    // point for the same reasons and under the same `federationImport` exemption (see above and
    // `subscription-authoring-guard.ts`'s M21.5 section). It is `await`ed because it reads a stored
    // probe verdict; it performs no provider I/O and holds nothing open across a network call.
    await assertNoDelegatedDependencyUpdates(tx, {
      orgId: input.orgId,
      typeId: input.typeId,
      properties
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

export async function listObjects(
  tx: TenantTx,
  orgId: string,
  typeId: string,
  query: ListObjectsQuery
): Promise<{ items: GraphObject[]; nextCursor: string | null }> {
  const cursor = query.cursor ? decodeCursor(query.cursor) : null;
  const conditions = [eq(objects.orgId, orgId), eq(objects.typeId, typeId)];
  if (!query.includeDeleted) conditions.push(isNull(objects.deletedAt));
  if (query.domainId) conditions.push(eq(objects.domainId, query.domainId));
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

export interface UpdateObjectInput {
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
    // no audit event, no journal entry, no version bump.
    if (input.federationImport.revision <= existing.revision) {
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
  validateProperties(type.propertySchema, nextProperties, type.id);

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
    assertEnforceableDependencySubscriptionScope({
      typeId: input.typeId,
      properties: nextProperties
    });
    // M21.5 — the UPDATE half, checked against `nextProperties` (the value about to be STORED) for
    // the identical reason the line above is: an ordinary PATCH that rewrites `scope`/`effects` can
    // turn an inert policy into an enabling one without ever passing through a create.
    await assertNoDelegatedDependencyUpdates(tx, {
      orgId: input.orgId,
      typeId: input.typeId,
      properties: nextProperties
    });
  }

  const nextName = input.name ?? existing.name;
  const nextDomainId = input.domainId === undefined ? existing.domainId : input.domainId;
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
    if (input.federationImport.revision <= existing.revision) return; // stale replay — no-op
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

  // ---------------------------------------------------------------------------------------------
  // ROUTE-1 ORPHAN GUARD: a tombstoned domain parent makes its `domain_id` children permanently
  // unadministrable, so a delete that would do that is refused — not cascaded, not tolerated.
  //
  // Measured 2026-08-13 (two API calls, depth 1): delete a domain whose live children name it via
  // `objects.domain_id` → 200; every such child then 403s on UPDATE and DELETE forever, for the
  // org-root admin included, because the authz scope expansion joins parents on
  // `deleted_at IS NULL` and the child's one upward chain dead-ends at the tombstone.
  //
  // Why refusal, and only for THIS route: containment has two routes, and their delete semantics
  // are deliberately different. Route 2 (`contains` edges) is CASCADED below — an edge can be
  // tombstoned alongside its object, and the reader-side filter backstops what the cascade can't
  // reach. Route 1 is a COLUMN: it cannot be tombstoned per-child without rewriting the children
  // (a silent re-parent nobody asked for), and leaving it dangling is the measured orphaning. The
  // only honest option left is the same one `deleteObject` already uses for a merge loser: refuse
  // with the blockers named, and let the operator move or delete the children first.
  //
  // NOT applied on the federation-import path: the authoritative domain already deleted this
  // object, and refusing the import would silently diverge this replica from its authority — a
  // worse failure than the orphaning, which the reader-side deleted-ancestor filter at least
  // bounds. A local child naming a foreign domain replica as its parent therefore CAN still be
  // orphaned by that authority's delete; recorded as a cost, same class as the replica edges the
  // cascade below cannot reach.
  if (!input.federationImport) {
    const domainChildren = await tx
      .select({ id: objects.id, urn: objects.urn })
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
    if (domainChildren.length > 0) {
      const shown = domainChildren.slice(0, 5).map((c) => c.urn);
      const suffix = domainChildren.length > 5 ? ", …" : "";
      throw conflict(
        `cannot delete '${existing.urn}': ${domainChildren.length > 5 ? "at least 5" : String(domainChildren.length)} live object(s) still name it as their domain (objects.domain_id) — ` +
          `deleting it would orphan them permanently, because permission resolution stops at deleted parents and no admin could ever update or delete them again. ` +
          `Move them to another domain or delete them first: ${shown.join(", ")}${suffix}`
      );
    }
  }

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
  // (2026-08-02): soft-deleting one component during the ADR-0026 §6 pair merge took the estate from
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
