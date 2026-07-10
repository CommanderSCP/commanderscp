import { and, asc, eq, gt } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import type { SourceMapping } from "@scp/schemas";
import type { TenantTx } from "../db/tenant-tx.js";
import { sourceMappings } from "../db/schema.js";
import { decodeCursor, encodeCursor } from "../pagination.js";
import { getObjectByIdOrUrnAnyType } from "../graph/objects-repo.js";

function toSourceMapping(row: typeof sourceMappings.$inferSelect): SourceMapping {
  return {
    id: row.id,
    orgId: row.orgId,
    sourceKind: row.sourceKind,
    repoPattern: row.repoPattern,
    pathPattern: row.pathPattern,
    componentObjectId: row.componentObjectId,
    createdAt: row.createdAt.toISOString()
  };
}

export interface CreateSourceMappingInput {
  orgId: string;
  sourceKind: string;
  repoPattern?: string;
  pathPattern?: string;
  componentIdOrUrn: string;
}

export async function createSourceMapping(
  tx: TenantTx,
  input: CreateSourceMappingInput
): Promise<SourceMapping> {
  const component = await getObjectByIdOrUrnAnyType(tx, input.orgId, input.componentIdOrUrn);
  const [row] = await tx
    .insert(sourceMappings)
    .values({
      id: uuidv7(),
      orgId: input.orgId,
      sourceKind: input.sourceKind,
      repoPattern: input.repoPattern ?? null,
      pathPattern: input.pathPattern ?? null,
      componentObjectId: component.id
    })
    .returning();
  if (!row) throw new Error("failed to insert source mapping");
  return toSourceMapping(row);
}

export async function listSourceMappingsForSource(
  tx: TenantTx,
  orgId: string,
  sourceKind: string
): Promise<SourceMapping[]> {
  const rows = await tx
    .select()
    .from(sourceMappings)
    .where(and(eq(sourceMappings.orgId, orgId), eq(sourceMappings.sourceKind, sourceKind)))
    .orderBy(asc(sourceMappings.createdAt));
  return rows.map(toSourceMapping);
}

export interface ListSourceMappingsQuery {
  cursor?: string | undefined;
  limit: number;
}

export async function listSourceMappings(
  tx: TenantTx,
  orgId: string,
  query: ListSourceMappingsQuery
): Promise<{ items: SourceMapping[]; nextCursor: string | null }> {
  const cursor = query.cursor ? decodeCursor(query.cursor) : null;
  const conditions = [eq(sourceMappings.orgId, orgId)];
  if (cursor) conditions.push(gt(sourceMappings.createdAt, cursor.createdAt));

  const rows = await tx
    .select()
    .from(sourceMappings)
    .where(and(...conditions))
    .orderBy(asc(sourceMappings.createdAt), asc(sourceMappings.id))
    .limit(query.limit + 1);

  const hasMore = rows.length > query.limit;
  const page = hasMore ? rows.slice(0, query.limit) : rows;
  const last = page[page.length - 1];
  return {
    items: page.map(toSourceMapping),
    nextCursor: hasMore && last ? encodeCursor({ createdAt: last.createdAt, id: last.id }) : null
  };
}
