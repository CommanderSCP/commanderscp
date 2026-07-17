import { and, eq, isNull, or } from "drizzle-orm";
import type {
  CreateObjectTypeRequest,
  CreateRelationshipTypeRequest,
  ObjectType,
  RelationshipType
} from "@scp/schemas";
import type { TenantTx } from "../db/tenant-tx.js";
import { objectTypes, relationshipTypes } from "../db/schema.js";
import { conflict, notFound } from "../errors.js";
import { isUniqueViolation } from "../db/pg-errors.js";
import { decodeCursor, encodeCursor, keysetAfter, keysetOrderBy } from "../pagination.js";

function toObjectType(row: typeof objectTypes.$inferSelect): ObjectType {
  return {
    id: row.id,
    orgId: row.orgId,
    displayName: row.displayName,
    propertySchema: (row.propertySchema as Record<string, unknown> | null) ?? null,
    isBuiltin: row.isBuiltin,
    createdAt: row.createdAt.toISOString()
  };
}

function toRelationshipType(row: typeof relationshipTypes.$inferSelect): RelationshipType {
  return {
    id: row.id,
    orgId: row.orgId,
    displayName: row.displayName,
    propertySchema: (row.propertySchema as Record<string, unknown> | null) ?? null,
    fromTypes: row.fromTypes,
    toTypes: row.toTypes,
    cardinality: row.cardinality as RelationshipType["cardinality"],
    isBuiltin: row.isBuiltin,
    createdAt: row.createdAt.toISOString()
  };
}

export async function createObjectType(
  tx: TenantTx,
  orgId: string,
  req: CreateObjectTypeRequest
): Promise<ObjectType> {
  try {
    const [row] = await tx
      .insert(objectTypes)
      .values({
        id: req.id,
        orgId,
        displayName: req.displayName,
        propertySchema: req.propertySchema ?? { type: "object" },
        isBuiltin: false
      })
      .returning();
    if (!row) throw new Error("failed to insert object type");
    return toObjectType(row);
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw conflict(`object type id '${req.id}' is already registered`);
    }
    throw err;
  }
}

export async function listObjectTypes(
  tx: TenantTx,
  orgId: string,
  query: { cursor?: string | undefined; limit: number }
) {
  const cursor = query.cursor ? decodeCursor(query.cursor) : null;
  const conditions = [or(eq(objectTypes.orgId, orgId), isNull(objectTypes.orgId))];
  if (cursor) {
    conditions.push(keysetAfter(objectTypes.createdAt, objectTypes.id, cursor));
  }
  const rows = await tx
    .select()
    .from(objectTypes)
    .where(and(...conditions))
    .orderBy(...keysetOrderBy(objectTypes.createdAt, objectTypes.id))
    .limit(query.limit + 1);

  const hasMore = rows.length > query.limit;
  const page = hasMore ? rows.slice(0, query.limit) : rows;
  const last = page[page.length - 1];
  return {
    items: page.map(toObjectType),
    nextCursor: hasMore && last ? encodeCursor(last) : null
  };
}

export async function getObjectType(
  tx: TenantTx,
  typeId: string
): Promise<typeof objectTypes.$inferSelect | null> {
  const row = await tx.query.objectTypes.findFirst({ where: eq(objectTypes.id, typeId) });
  return row ?? null;
}

export async function requireObjectType(
  tx: TenantTx,
  typeId: string
): Promise<typeof objectTypes.$inferSelect> {
  const row = await getObjectType(tx, typeId);
  if (!row) throw notFound(`object type '${typeId}' is not registered`);
  return row;
}

export async function createRelationshipType(
  tx: TenantTx,
  orgId: string,
  req: CreateRelationshipTypeRequest
): Promise<RelationshipType> {
  try {
    const [row] = await tx
      .insert(relationshipTypes)
      .values({
        id: req.id,
        orgId,
        displayName: req.displayName,
        propertySchema: req.propertySchema ?? { type: "object" },
        fromTypes: req.fromTypes ?? null,
        toTypes: req.toTypes ?? null,
        cardinality: req.cardinality,
        isBuiltin: false
      })
      .returning();
    if (!row) throw new Error("failed to insert relationship type");
    return toRelationshipType(row);
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw conflict(`relationship type id '${req.id}' is already registered`);
    }
    throw err;
  }
}

export async function listRelationshipTypes(
  tx: TenantTx,
  orgId: string,
  query: { cursor?: string | undefined; limit: number }
) {
  const cursor = query.cursor ? decodeCursor(query.cursor) : null;
  const conditions = [or(eq(relationshipTypes.orgId, orgId), isNull(relationshipTypes.orgId))];
  if (cursor) {
    conditions.push(keysetAfter(relationshipTypes.createdAt, relationshipTypes.id, cursor));
  }
  const rows = await tx
    .select()
    .from(relationshipTypes)
    .where(and(...conditions))
    .orderBy(...keysetOrderBy(relationshipTypes.createdAt, relationshipTypes.id))
    .limit(query.limit + 1);

  const hasMore = rows.length > query.limit;
  const page = hasMore ? rows.slice(0, query.limit) : rows;
  const last = page[page.length - 1];
  return {
    items: page.map(toRelationshipType),
    nextCursor: hasMore && last ? encodeCursor(last) : null
  };
}

export async function getRelationshipType(
  tx: TenantTx,
  typeId: string
): Promise<typeof relationshipTypes.$inferSelect | null> {
  const row = await tx.query.relationshipTypes.findFirst({
    where: eq(relationshipTypes.id, typeId)
  });
  return row ?? null;
}

export async function requireRelationshipType(
  tx: TenantTx,
  typeId: string
): Promise<typeof relationshipTypes.$inferSelect> {
  const row = await getRelationshipType(tx, typeId);
  if (!row) throw notFound(`relationship type '${typeId}' is not registered`);
  return row;
}
