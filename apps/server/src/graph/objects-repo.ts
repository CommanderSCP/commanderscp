import { and, asc, eq, gt, isNull, or } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import type { GraphObject } from "@scp/schemas";
import type { TenantTx } from "../db/tenant-tx.js";
import { objects } from "../db/schema.js";
import { badRequest, conflict, notFound, preconditionFailed } from "../errors.js";
import { isUniqueViolation } from "../db/pg-errors.js";
import { decodeCursor, encodeCursor } from "../pagination.js";
import { computeObjectContentHash } from "./content-hash.js";
import { deriveUrn } from "./urn.js";
import { requireObjectType } from "./type-registry-repo.js";
import { validateProperties } from "./property-validation.js";
import { appendAuditEvent } from "../audit/audit-repo.js";
import { eventBus } from "../events/event-bus.js";
import { ensureFederationSelf } from "../federation/self-repo.js";
import { appendJournalEntry } from "../federation/journal-repo.js";
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
  originDomainId: string;
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
function journalEntryKindFor(typeId: string, tombstone: boolean): JournalEntryKind {
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
  /** `undefined` = default to the org root object; `null` = this IS the org root (bootstrap only). */
  domainId?: string | null;
  properties?: Record<string, unknown>;
  labels?: Record<string, unknown>;
  /** M6: set ONLY by `federation/import-repo.ts` after signature/chain verification — see
   *  `FederationImportContext`'s doc comment. Preserves the imported row's true authoritative
   *  origin instead of stamping this domain as the author. */
  federationImport?: FederationImportContext;
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
  domainId: string | null | undefined
): Promise<string | null> {
  if (domainId === undefined) return getOrgRootObjectId(tx, orgId);
  if (domainId === null) return null;
  const parent = await tx.query.objects.findFirst({
    where: (t, { eq: eqOp, and: andOp }) => andOp(eqOp(t.id, domainId), eqOp(t.orgId, orgId))
  });
  if (!parent) throw badRequest(`domainId '${domainId}' does not reference an object in this org`);
  return domainId;
}

export async function createObject(tx: TenantTx, input: CreateObjectInput): Promise<GraphObject> {
  const type = await requireObjectType(tx, input.typeId);
  const properties = input.properties ?? {};
  const labels = input.labels ?? {};
  validateProperties(type.propertySchema, properties, type.id);

  const domainId = await resolveDomainId(tx, input.orgId, input.domainId);

  const id = input.id ?? uuidv7();
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
    requestId: input.requestId
  });
  // Only journal writes THIS domain actually authored — an imported row was already journaled (and
  // signed) by ITS origin domain; re-journaling it here would falsely claim co-authorship and
  // corrupt this domain's own hash chain with content it didn't originate (DESIGN §13 single-writer
  // authority: "no merge algorithm exists because none is needed").
  if (!input.federationImport) {
    await appendJournalEntry(tx, {
      orgId: input.orgId,
      entryKind: journalEntryKindFor(input.typeId, false),
      contentHash,
      payload: { id, orgId: input.orgId, domainId, typeId: input.typeId, name: input.name, urn, properties, labels, originDomainId, revision, version }
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
  const conditions = [idOrUrnAnyTypeCondition(orgId, idOrUrn)];
  if (!opts.includeDeleted) conditions.push(isNull(objects.deletedAt));
  const row = await tx
    .select()
    .from(objects)
    .where(and(...conditions))
    .limit(1);
  if (row.length === 0 || !row[0]) throw notFound(`object '${idOrUrn}' not found`);
  return toGraphObject(row[0]);
}

export interface ListObjectsQuery {
  cursor?: string | undefined;
  limit: number;
  domainId?: string | undefined;
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
    const cursorCondition = or(
      gt(objects.createdAt, cursor.createdAt),
      and(eq(objects.createdAt, cursor.createdAt), gt(objects.id, cursor.id))
    );
    if (cursorCondition) conditions.push(cursorCondition);
  }

  const rows = await tx
    .select()
    .from(objects)
    .where(and(...conditions))
    .orderBy(asc(objects.createdAt), asc(objects.id))
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
  domainId?: string | null;
  properties?: Record<string, unknown>;
  labels?: Record<string, unknown>;
  /** Optimistic concurrency (DESIGN.md §4.1) — required when set, mismatch is a 412. */
  expectedVersion?: number;
  /** M6: see `FederationImportContext`'s doc comment above `createObject`. */
  federationImport?: FederationImportContext;
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

  if (input.expectedVersion !== undefined && input.expectedVersion !== existing.version) {
    throw preconditionFailed(
      `version mismatch: expected ${input.expectedVersion}, current is ${existing.version}`
    );
  }

  // M6 single-writer authority (DESIGN §13 — SECURITY-SENSITIVE): the two cases below are the
  // enforcement point "a domain cannot mutate a replica it doesn't own" / "a child cannot claim
  // authorship of a parent-origin object" — every ordinary write funnels through here.
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
      throw conflict(
        `object '${existing.id}' is a read-only replica (authoritative domain '${existing.originDomainId}') — it cannot be mutated locally`
      );
    }
  }

  const type = await requireObjectType(tx, input.typeId);
  const nextProperties = (input.properties ?? existing.properties) as Record<string, unknown>;
  const nextLabels = (input.labels ?? existing.labels) as Record<string, unknown>;
  validateProperties(type.propertySchema, nextProperties, type.id);

  const nextName = input.name ?? existing.name;
  const nextDomainId = input.domainId === undefined ? existing.domainId : input.domainId;
  const nextVersion = existing.version + 1;
  const nextRevision = input.federationImport?.revision ?? existing.revision + 1;
  const nextProvenance = input.federationImport ? (input.federationImport.provenance ?? null) : existing.provenance;
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
    requestId: input.requestId
  });
  // See the identical note in `createObject` — never re-journal an imported row's own history.
  if (!input.federationImport) {
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
        version: nextVersion
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
  domainId?: string | null;
  properties?: Record<string, unknown>;
  labels?: Record<string, unknown>;
  /** M6: see `FederationImportContext`'s doc comment above `createObject`. */
  federationImport?: FederationImportContext;
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
      federationImport: input.federationImport
    });
    return { object: created, created: true };
  }

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

  // True idempotency: replaying the exact same PUT body against an unchanged row is a no-op —
  // no version/revision bump, no audit event, no outbox event. Without this, a byte-identical
  // replay would still increment `version` forever, which is "safe" for federation convergence
  // (content matches either way) but not actually idempotent in the HTTP sense the endpoint
  // claims to be (fast-check-tested: graph/idempotency.integration.test.ts).
  const nextDomainId = input.domainId === undefined ? existing.domainId : input.domainId;
  const nextProperties = input.properties ?? {};
  const nextLabels = input.labels ?? {};
  if (
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
  }
): Promise<void> {
  const existing = await lockObjectRow(tx, input.orgId, input.typeId, input.idOrUrn);

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
      throw conflict(
        `object '${existing.id}' is a read-only replica (authoritative domain '${existing.originDomainId}') — it cannot be mutated locally`
      );
    }
  }

  const nextRevision = input.federationImport?.revision ?? existing.revision + 1;
  await tx
    .update(objects)
    .set({ deletedAt: new Date(), version: existing.version + 1, revision: nextRevision, updatedAt: new Date() })
    .where(eq(objects.id, existing.id));

  await appendAuditEvent(tx, {
    orgId: input.orgId,
    domainId: existing.domainId,
    actorId: input.actorObjectId,
    action: `${input.typeId}.delete`,
    subjectId: existing.id,
    beforeHash: existing.contentHash,
    afterHash: null,
    requestId: input.requestId
  });
  if (!input.federationImport) {
    await appendJournalEntry(tx, {
      orgId: input.orgId,
      entryKind: journalEntryKindFor(input.typeId, true),
      contentHash: existing.contentHash,
      payload: { id: existing.id, typeId: input.typeId, urn: existing.urn }
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
