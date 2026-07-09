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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

/** Deterministic JSON serialization (recursively sorted object keys) for content-equality checks. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === "object") {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
        return acc;
      }, {});
  }
  return value;
}

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
  if (!row) throw new Error(`org ${orgId} has no root 'organization' object — bootstrap incomplete`);
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
        originDomainId: input.orgId, // placeholder local-domain identity pending M6 federation
        revision: 1,
        contentHash,
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
  return { items: page.map(toGraphObject), nextCursor: hasMore && last ? encodeCursor(last) : null };
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

  const type = await requireObjectType(tx, input.typeId);
  const nextProperties = (input.properties ?? existing.properties) as Record<string, unknown>;
  const nextLabels = (input.labels ?? existing.labels) as Record<string, unknown>;
  validateProperties(type.propertySchema, nextProperties, type.id);

  const nextName = input.name ?? existing.name;
  const nextDomainId = input.domainId === undefined ? existing.domainId : input.domainId;
  const nextVersion = existing.version + 1;
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
      revision: existing.revision + 1,
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
      labels: input.labels
    });
    return { object: created, created: true };
  }

  if (existing.typeId !== input.typeId) {
    throw conflict(`urn '${input.urn}' is already registered under type '${existing.typeId}'`);
  }
  if (existing.deletedAt) {
    throw conflict(`urn '${input.urn}' refers to a soft-deleted object`);
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
    labels: input.labels ?? {}
  });
  return { object: updated, created: false };
}

export async function deleteObject(
  tx: TenantTx,
  input: { orgId: string; typeId: string; actorObjectId: string; requestId: string; idOrUrn: string }
): Promise<void> {
  const existing = await lockObjectRow(tx, input.orgId, input.typeId, input.idOrUrn);

  await tx
    .update(objects)
    .set({ deletedAt: new Date(), version: existing.version + 1, updatedAt: new Date() })
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
  await eventBus.publish(tx, {
    orgId: input.orgId,
    type: `scp.object.deleted`,
    source: `/objects/${input.typeId}`,
    subject: existing.id,
    data: { id: existing.id, typeId: input.typeId, urn: existing.urn }
  });
}
