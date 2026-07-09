import { and, asc, eq, gt, or } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import type { ServiceObject, ServiceObjectListResponse } from "@scp/schemas";
import type { AppDeps } from "../types.js";
import { objects } from "../db/schema.js";

export function encodeCursor(row: { createdAt: Date; id: string }): string {
  return Buffer.from(
    JSON.stringify({ createdAt: row.createdAt.toISOString(), id: row.id })
  ).toString("base64url");
}

export function decodeCursor(cursor: string): { createdAt: Date; id: string } | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "createdAt" in parsed &&
      "id" in parsed &&
      typeof (parsed as Record<string, unknown>).createdAt === "string" &&
      typeof (parsed as Record<string, unknown>).id === "string"
    ) {
      const p = parsed as { createdAt: string; id: string };
      return { createdAt: new Date(p.createdAt), id: p.id };
    }
    return null;
  } catch {
    return null;
  }
}

function toServiceObject(row: typeof objects.$inferSelect): ServiceObject {
  return {
    id: row.id,
    orgId: row.orgId,
    type: "service",
    name: row.name,
    createdAt: row.createdAt.toISOString()
  };
}

export async function createServiceObject(
  deps: AppDeps,
  orgId: string,
  name: string
): Promise<ServiceObject> {
  const [row] = await deps.db
    .insert(objects)
    .values({ id: uuidv7(), orgId, type: "service", name })
    .returning();
  if (!row) throw new Error("failed to insert service object");
  return toServiceObject(row);
}

export async function listServiceObjects(
  deps: AppDeps,
  orgId: string,
  query: { cursor?: string | undefined; limit: number }
): Promise<ServiceObjectListResponse> {
  const cursor = query.cursor ? decodeCursor(query.cursor) : null;
  const conditions = [eq(objects.orgId, orgId), eq(objects.type, "service")];
  if (cursor) {
    const cursorCondition = or(
      gt(objects.createdAt, cursor.createdAt),
      and(eq(objects.createdAt, cursor.createdAt), gt(objects.id, cursor.id))
    );
    if (cursorCondition) conditions.push(cursorCondition);
  }

  const rows = await deps.db
    .select()
    .from(objects)
    .where(and(...conditions))
    .orderBy(asc(objects.createdAt), asc(objects.id))
    .limit(query.limit + 1);

  const hasMore = rows.length > query.limit;
  const page = hasMore ? rows.slice(0, query.limit) : rows;
  const last = page[page.length - 1];
  const nextCursor = hasMore && last ? encodeCursor(last) : null;

  return { items: page.map(toServiceObject), nextCursor };
}
