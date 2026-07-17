import { and, asc, eq, isNull } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import type { SourceMapping } from "@scp/schemas";
import type { TenantTx } from "../db/tenant-tx.js";
import { objects, sourceMappings } from "../db/schema.js";
import { decodeCursor, encodeCursor, keysetAfter, keysetOrderBy } from "../pagination.js";
import { getObjectByIdOrUrnAnyType } from "../graph/objects-repo.js";

function toSourceMapping(row: typeof sourceMappings.$inferSelect): SourceMapping {
  return {
    id: row.id,
    orgId: row.orgId,
    sourceKind: row.sourceKind,
    repoPattern: row.repoPattern,
    pathPattern: row.pathPattern,
    componentObjectId: row.componentObjectId,
    purpose: (row.purpose as "infra" | "software" | null) ?? "software",
    createdAt: row.createdAt.toISOString()
  };
}

export interface CreateSourceMappingInput {
  orgId: string;
  sourceKind: string;
  repoPattern?: string;
  pathPattern?: string;
  componentIdOrUrn: string;
  purpose?: "infra" | "software";
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
      componentObjectId: component.id,
      purpose: input.purpose ?? "software"
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

export interface BackfillSourceMappingInput {
  objectName: string;
  sourceKind: string;
  repoPattern?: string;
  pathPattern?: string;
  purpose?: "infra" | "software";
}

export interface BackfillSourceMappingsResult {
  createdSourceMappingIds: string[];
  skipped: Array<{ objectName: string; reason: string }>;
}

/**
 * Backfills source_mappings onto ALREADY-imported components (M12 P5 follow-up) — the automated path
 * for the homelab's 50 argocd orphans that were imported BEFORE discovery emitted mappings. Feed it a
 * fresh `discovery run` proposal's `sourceMappings` (which now carry each app's repoURL); for each it
 * MATCHES an existing live component BY NAME (== `objectName`, which the argocd import used) and
 * creates the mapping. Unlike `accept`, it creates NO objects — it only wires mappings onto components
 * that already exist. Idempotent and safe to re-run: it SKIPS when there is no such component, the name
 * is ambiguous (>1 live component), or an identical mapping already exists — reporting each skip with a
 * reason so the operator can see exactly what was and wasn't backfilled (no silent drops).
 */
export async function backfillSourceMappings(
  tx: TenantTx,
  input: { orgId: string; mappings: BackfillSourceMappingInput[] }
): Promise<BackfillSourceMappingsResult> {
  const createdSourceMappingIds: string[] = [];
  const skipped: Array<{ objectName: string; reason: string }> = [];

  for (const m of input.mappings) {
    const matches = await tx
      .select({ id: objects.id })
      .from(objects)
      .where(
        and(
          eq(objects.orgId, input.orgId),
          eq(objects.typeId, "component"),
          eq(objects.name, m.objectName),
          isNull(objects.deletedAt)
        )
      )
      .limit(2);
    if (matches.length === 0) {
      skipped.push({ objectName: m.objectName, reason: `no live component named '${m.objectName}'` });
      continue;
    }
    if (matches.length > 1) {
      skipped.push({
        objectName: m.objectName,
        reason: `ambiguous — more than one live component named '${m.objectName}'`
      });
      continue;
    }
    const componentId = matches[0]!.id;

    // Idempotent: skip an identical (component, sourceKind, repo, path) mapping — re-running is a no-op.
    const existing = await listSourceMappingsForSource(tx, input.orgId, m.sourceKind);
    const dup = existing.some(
      (e) =>
        e.componentObjectId === componentId &&
        (e.repoPattern ?? null) === (m.repoPattern ?? null) &&
        (e.pathPattern ?? null) === (m.pathPattern ?? null)
    );
    if (dup) {
      skipped.push({ objectName: m.objectName, reason: "already mapped" });
      continue;
    }

    const created = await createSourceMapping(tx, {
      orgId: input.orgId,
      sourceKind: m.sourceKind,
      repoPattern: m.repoPattern,
      pathPattern: m.pathPattern,
      componentIdOrUrn: componentId,
      purpose: m.purpose
    });
    createdSourceMappingIds.push(created.id);
  }

  return { createdSourceMappingIds, skipped };
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
  if (cursor) conditions.push(keysetAfter(sourceMappings.createdAt, sourceMappings.id, cursor));

  const rows = await tx
    .select()
    .from(sourceMappings)
    .where(and(...conditions))
    .orderBy(...keysetOrderBy(sourceMappings.createdAt, sourceMappings.id))
    .limit(query.limit + 1);

  const hasMore = rows.length > query.limit;
  const page = hasMore ? rows.slice(0, query.limit) : rows;
  const last = page[page.length - 1];
  return {
    items: page.map(toSourceMapping),
    nextCursor: hasMore && last ? encodeCursor({ createdAt: last.createdAt, id: last.id }) : null
  };
}
