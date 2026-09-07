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
import { assertPolicyApprovalRolesExist } from "../authz/roles-repo.js";
import {
  assertMayWriteIdentityMapping,
  identityMappingChanged
} from "../authz/identity-mapping-door.js";
import { appendAuditEvent } from "../audit/audit-repo.js";
import {
  assertOrgRetainsAdministrativeFloor,
  objectTouchesRoleAuthority
} from "../authz/role-binding-door.js";
import { eventBus } from "../events/event-bus.js";
import { ensureFederationSelf } from "../federation/self-repo.js";
import { assertOutpostPeerBinding, isPeerBoundObjectType } from "../federation/outpost-binding.js";
import { appendJournalEntry } from "../federation/journal-repo.js";
import { assertConfigSourceAuthoring } from "../config-source/authoring-guard.js";
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

/** M6 single-writer authority. See docs/graph.md §74. */
export interface FederationImportContext {
  /** TRUST sense (ADR-0021 D4) — the security domain that authored the imported row. */
  originDomainId: TrustDomainId;
  revision: number;
  provenance?: "manual" | null;
  /** RESYNC ONLY (§7.2.6 — SECURITY-SENSITIVE). See docs/graph.md §75. */
  forceOverwrite?: boolean;
}

// Change objects deliberately keep the object entry kinds. See docs/graph.md §76.
export function journalEntryKindFor(typeId: string, tombstone: boolean): JournalEntryKind {
  if (tombstone) return "object_tombstone";
  if (typeId === "policy") return "policy_upsert";
  return "object_upsert";
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

// `canonicalJson` moved to `util/canonical-json.ts`. See docs/graph.md §77.
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

/** The org's root graph object. See docs/graph.md §78. */
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
  /** M20.1 (ADR-0031 §1) — declare that this object never federates. See docs/graph.md §79. */
  domainLocal?: boolean;
  /** Provenance for the `contains` route, which create cannot see. See docs/graph.md §80. */
  domainLocalInheritedFrom?: { id: string; urn: string };
}

/** Resolves the `domain_id` an object create should use. See docs/graph.md §81. */
export async function resolveDomainId(
  tx: TenantTx,
  orgId: string,
  domainId: ContainmentDomainId | null | undefined
): Promise<ContainmentDomainId | null> {
  return (await resolveContainmentParent(tx, orgId, domainId)).id;
}

/** The same resolution, plus the locality a child inherits. See docs/graph.md §82. */
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
  // A soft-deleted parent is not a parent. See docs/graph.md §83.
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

  // `fromRole` AUTHORING-TIME VALIDATION. See docs/graph.md §84.
  if (!input.federationImport && input.typeId === "policy") {
    await assertPolicyApprovalRolesExist(tx, properties);
  }

  // THE IdP MAPPING DOOR (`authz/identity-mapping-door.ts`). Same choke point, same reason: a group
  // is an ordinary graph object, so `POST /groups`, `PATCH`, `PUT` and IaC apply all pass through
  // here, and gating at one route would leave the others open. On CREATE, `before` is nothing, so
  // any mapping present is a change.
  if (
    !input.federationImport &&
    (input.typeId === "group" || input.typeId === "team") &&
    identityMappingChanged(undefined, properties)
  ) {
    await assertMayWriteIdentityMapping(tx, {
      orgId: input.orgId,
      actorObjectId: input.actorObjectId,
      // On create the object does not exist yet, so it can hold no bindings and rule 2 is vacuous.
      // The id is passed for uniformity; the door reads zero rows for it. The MAP-FIRST-BIND-SECOND
      // ordering is closed by the grant door, not here — see that module's enumeration.
      subjectObjectId: input.id ?? input.orgId
    });
  }

  const containmentParent = await resolveContainmentParent(tx, input.orgId, input.domainId);
  const domainId = containmentParent.id;

  // Inherit locality from the containment parent, at create. See docs/graph.md §85.
  if (!input.federationImport && containmentParent.domainLocal && input.domainLocal === false) {
    throw badRequest(
      `cannot create a non-domain-local object inside a domain-local container: the containing ` +
        `object '${domainId}' is domain-local, so everything created under it is too (ADR-0031 §6a). ` +
        `Omit domainLocal, or create this object under a different container.`
    );
  }

  const id = input.id ?? uuidv7();

  // The root-reachability invariant, on the create half. See docs/graph.md §86.
  if (!input.federationImport && domainId !== null && domainId !== input.orgId) {
    await assertRootedContainmentParent(tx, {
      orgId: input.orgId,
      childId: id,
      parentId: domainId,
      childIsNew: true
    });
  }

  // The authority-split rule, at the one local write choke point. See docs/graph.md §87.
  if (!input.federationImport && isPeerBoundObjectType(input.typeId)) {
    await assertOutpostPeerBinding(tx, { orgId: input.orgId, objectId: id, properties });
  }

  // A group-scoped subscription opt-out is refused. See docs/graph.md §88.
  if (!input.federationImport) {
    // Security declarations: strict locally, open on the wire. See docs/graph.md §89.
    assertValidComponentSecurityDeclarations({ typeId: input.typeId, properties });
    // The campaign recipe, guarded like its neighbours. See docs/graph.md §90.
    assertValidCampaignRecipe({ typeId: input.typeId, properties });
    assertEnforceableDependencySubscriptionScope({ typeId: input.typeId, properties });
    // The other half of the split, which the line above cannot reach. See docs/graph.md §91.
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
    // THE RESERVED GOVERNANCE LABEL NAMESPACE. See docs/graph.md §92.
    assertSelectorKeysAreGovernanceLabels({ typeId: input.typeId, properties });
    await assertMayWriteGovernanceLabels(tx, {
      orgId: input.orgId,
      actorObjectId: input.actorObjectId,
      before: {},
      after: labels,
      subject: `${input.typeId} '${input.name}'`
    });
    // The fifth authoring refusal, ending a common first experience. See docs/graph.md §93.
    await assertScanRuleRequiresScanControl(tx, {
      orgId: input.orgId,
      typeId: input.typeId,
      properties
    });
    // The fourth authoring refusal, closing the override's door. See docs/graph.md §94.
    assertScanOverrideGrantNotSelfDecided({
      typeId: input.typeId,
      properties,
      isDecisionWrite: input.scanOverrideGrantDecision
    });
    // The sixth refusal, and the first whose subject is an identity. See docs/graph.md §95.
    await assertConfigSourceAuthoring(tx, {
      orgId: input.orgId,
      actorObjectId: input.actorObjectId,
      typeId: input.typeId,
      properties,
      subject: `${input.typeId} '${input.name}'`
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
  // Forced false on import: a journalled row is not local. See docs/graph.md §96.
  const declared = input.domainLocal === true;
  const inheritedContainer =
    input.domainLocalInheritedFrom ??
    (containmentParent.domainLocal && containmentParent.id && containmentParent.urn
      ? { id: containmentParent.id, urn: containmentParent.urn }
      : undefined);
  const domainLocal = input.federationImport ? false : declared || inheritedContainer !== undefined;

  // M20.7 (ADR-0031 §6c) — record WHY, not just whether. See docs/graph.md §97.
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
  // Only journal writes THIS domain actually authored. See docs/graph.md §98.
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
        // Stamped so the scope predicate stays pure and synchronous. See docs/graph.md §99.
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

/** Same lookup as `getObjectByIdOrUrn`, but without a fixed `typeId`. See docs/graph.md §100. */
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

/** The same lookup, returning `undefined` instead of throwing. See docs/graph.md §101. */
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

/** The type-scoped object list. See docs/graph.md §102. */
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
  /** The unverified-shadow adoption hatch, and nothing wider. See docs/graph.md §103. */
  unverifiedShadowOverride?: boolean;
}

// Uses the drizzle query builder. See docs/graph.md §104.
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
    // Idempotent replay / interrupted-transfer resume. See docs/graph.md §105.
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

  // The UPDATE half of the same choke point. Without it a policy could be authored valid and then
  // edited into an unsatisfiable one — which is the exact asymmetry `resolveContainmentParent`'s
  // comment above records having already been paid for once on this file.
  if (!input.federationImport && input.typeId === "policy") {
    await assertPolicyApprovalRolesExist(tx, nextProperties);
  }

  // The UPDATE half. This is the ordering that matters — a group that ALREADY carries bindings
  // being pointed at a claim — so `before` is the stored properties and rule 2 reads real rows.
  if (
    !input.federationImport &&
    (input.typeId === "group" || input.typeId === "team") &&
    identityMappingChanged(existing.properties, nextProperties)
  ) {
    await assertMayWriteIdentityMapping(tx, {
      orgId: input.orgId,
      actorObjectId: input.actorObjectId,
      subjectObjectId: existing.id
    });
  }

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

  // ADR-0032 §6a — the UPDATE half of the same choke point. See docs/graph.md §106.
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
    // The update half of the unnarrowed declaration refusal. See docs/graph.md §107.
    assertDeclaredFactClauseIsNarrowed({ typeId: input.typeId, properties: nextProperties });
    // M21.5 — the UPDATE half, checked against `nextProperties` (the value about to be STORED) for
    // the identical reason the line above is: an ordinary PATCH that rewrites `scope`/`effects` can
    // turn an inert policy into an enabling one without ever passing through a create.
    await assertNoDelegatedDependencyUpdates(tx, {
      orgId: input.orgId,
      typeId: input.typeId,
      properties: nextProperties
    });
    // The update half, which is where the evasion actually lives. See docs/graph.md §108.
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
    // The update half of the un-declaration guard. See docs/graph.md §109.
    await assertMayUndeclareRegionMembership(tx, {
      orgId: input.orgId,
      actorObjectId: input.actorObjectId,
      typeId: input.typeId,
      objectId: existing.id,
      before: existing.properties as Record<string, unknown>,
      after: nextProperties
    });
    // The update half of the delegation refusal, and why it matters. See docs/graph.md §110.
    await assertConfigSourceAuthoring(tx, {
      orgId: input.orgId,
      actorObjectId: input.actorObjectId,
      typeId: input.typeId,
      properties: nextProperties,
      subject: `${input.typeId} '${existing.urn}'`
    });
    // OWNER RULING 2026-08-25 (D1 b-i) — WIDENING A CAMPAIGN'S DEADLINE. See docs/graph.md §111.
    await assertMayWidenCampaignDeadline(tx, {
      orgId: input.orgId,
      actorObjectId: input.actorObjectId,
      typeId: input.typeId,
      subjectObjectId: existing.id,
      before: existing.properties as Record<string, unknown>,
      after: nextProperties
    });
    // M22.8 — the UPDATE half, checked against `nextProperties`. See docs/graph.md §112.
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

  // The two subject-free invariants behind a parent write. See docs/graph.md §113.
  if (!input.federationImport && nextDomainId !== null && nextDomainId !== existing.domainId) {
    // THE VALIDATION HALF OF THIS WRITE. See docs/graph.md §114.
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

  // CONTAINMENT ROUTE 1. See docs/graph.md §115.
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
        // M20.2 (ADR-0031 §2). Read from the ROW, never from the request. See docs/graph.md §116.
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

/** Locality is immutable, so this is a precondition not a write. See docs/graph.md §117. */
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

/** `PUT /objects/{type}/{urn}` — idempotent upsert-by-URN. See docs/graph.md §118. */
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

  // M6 hand-fill reconciliation. See docs/graph.md §119.
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
    // CONTAINMENT ROUTE 1, SECOND WRITE SITE. See docs/graph.md §120.
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

  // True idempotency: replaying an unchanged body is a no-op. See docs/graph.md §121.
  const nextDomainId = input.domainId === undefined ? existing.domainId : input.domainId;
  const nextProperties = input.properties ?? {};
  const nextLabels = input.labels ?? {};
  // M6: a hand-filled row. See docs/graph.md §122.
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

  // M15.6 / ADR-0017 §3 — the DELETE half of the un-declaration guard. See docs/graph.md §123.
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

  // ROUTE-1 ORPHAN GUARD. See docs/graph.md §124.
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
    // Placements name their endpoints by JSON property. See docs/graph.md §125.
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

  // THE ADMINISTRATOR FLOOR. See docs/graph.md §126.
  const touchesRoleAuthority =
    !input.federationImport && !removedForeignShadow
      ? await objectTouchesRoleAuthority(tx, input.orgId, existing.id)
      : false;

  // CONTAINMENT ROUTE 3. See docs/graph.md §127.
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

  // CASCADE: an object's edges must not outlive the object. See docs/graph.md §128.
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

  // THE ADMINISTRATOR FLOOR. See docs/graph.md §129.
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
        // The tombstone needs it too, and is the easiest to miss. See docs/graph.md §130.
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
