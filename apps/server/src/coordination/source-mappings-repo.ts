import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import {
  categoryOfType,
  parsePipelineClassification,
  parseSourceMappingScope,
  type SourceMapping,
  type SourceMappingScope,
  type ExecutorType,
  type PipelineClassification
} from "@scp/schemas";
import type { TenantTx } from "../db/tenant-tx.js";
import { sourceMappings } from "../db/schema.js";
import { decodeCursor, encodeCursor, keysetAfter, keysetOrderBy } from "../pagination.js";
import { getObjectByIdOrUrnAnyType } from "../graph/objects-repo.js";
import { notFound } from "../errors.js";

function toSourceMapping(row: typeof sourceMappings.$inferSelect): SourceMapping {
  const type = (row.type as ExecutorType | null) ?? "configuration";
  return {
    id: row.id,
    orgId: row.orgId,
    sourceKind: row.sourceKind,
    repoPattern: row.repoPattern,
    pathPattern: row.pathPattern,
    refPattern: row.refPattern,
    componentObjectId: row.componentObjectId,
    type,
    category: categoryOfType(type),
    classification: parsePipelineClassification(row.classification),
    mirrorOfShared: row.mirrorOfShared,
    enabled: row.enabled,
    disabledUntil: row.disabledUntil ? row.disabledUntil.toISOString() : null,
    // What the matcher will actually DO right now — the read-time truth. Differs from `enabled`
    // only in the one honest case: a timed close whose bound has passed (enabled=false but the
    // rule routes again). The UI paints the arrow from THIS, never from `enabled` alone.
    effectivelyEnabled:
      row.enabled || (row.disabledUntil !== null && row.disabledUntil.getTime() <= Date.now()),
    // Declared reach (migration 0066, §10.6). READ off the row, total over anything the column can
    // hold — never inferred from the site's role or the repo. NULL = not declared.
    scope: parseSourceMappingScope(row.scope),
    createdAt: row.createdAt.toISOString()
  };
}

export interface CreateSourceMappingInput {
  orgId: string;
  sourceKind: string;
  repoPattern?: string;
  pathPattern?: string;
  refPattern?: string;
  componentIdOrUrn: string;
  type?: ExecutorType;
  classification?: PipelineClassification;
  /** Declared mirror-of-shared provenance (outpost-ui.md §9.3a); omitted = domain-specific. */
  mirrorOfShared?: boolean;
  /** The pause switch (migration 0063); omitted = enabled (the pre-0063 behaviour). */
  enabled?: boolean;
  /** Declared reach (migration 0066, §10.6); omitted = NOT declared (stored NULL, no label). */
  scope?: SourceMappingScope | null;
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
      refPattern: input.refPattern ?? null,
      componentObjectId: component.id,
      type: input.type ?? "configuration",
      classification: input.classification ?? null,
      mirrorOfShared: input.mirrorOfShared ?? false,
      enabled: input.enabled ?? true,
      scope: input.scope ?? null
    })
    .returning();
  if (!row) throw new Error("failed to insert source mapping");
  return toSourceMapping(row);
}

/** Flips the ONE mutable field on this table. See docs/coordination.md §907. */
export async function setSourceMappingEnabled(
  tx: TenantTx,
  orgId: string,
  sourceKind: string,
  id: string,
  enabled: boolean,
  /** A timed close: closed until this instant, then open again automatically (read-time, like a
   *  freeze). Ignored — and cleared — when `enabled` is true. Null = closed until re-opened by hand. */
  disabledUntil: Date | null = null
): Promise<SourceMapping> {
  const [row] = await tx
    .update(sourceMappings)
    .set({ enabled, disabledUntil: enabled ? null : disabledUntil })
    .where(
      and(
        eq(sourceMappings.orgId, orgId),
        eq(sourceMappings.sourceKind, sourceKind),
        eq(sourceMappings.id, id)
      )
    )
    .returning();
  if (!row) throw notFound(`no source mapping '${id}' for source kind '${sourceKind}'`);
  return toSourceMapping(row);
}

/** Sets or clears the DECLARED scope of one mapping. See docs/coordination.md §908. */
export async function setSourceMappingScope(
  tx: TenantTx,
  orgId: string,
  sourceKind: string,
  id: string,
  scope: SourceMappingScope | null
): Promise<SourceMapping> {
  const [row] = await tx
    .update(sourceMappings)
    .set({ scope })
    .where(
      and(
        eq(sourceMappings.orgId, orgId),
        eq(sourceMappings.sourceKind, sourceKind),
        eq(sourceMappings.id, id)
      )
    )
    .returning();
  if (!row) throw notFound(`no source mapping '${id}' for source kind '${sourceKind}'`);
  return toSourceMapping(row);
}

/** Reads one mapping by the same addressing the setters use. See docs/coordination.md §909. */
export async function getSourceMapping(
  tx: TenantTx,
  orgId: string,
  sourceKind: string,
  id: string
): Promise<SourceMapping> {
  const [row] = await tx
    .select()
    .from(sourceMappings)
    .where(
      and(
        eq(sourceMappings.orgId, orgId),
        eq(sourceMappings.sourceKind, sourceKind),
        eq(sourceMappings.id, id)
      )
    )
    .limit(1);
  if (!row) throw notFound(`no source mapping '${id}' for source kind '${sourceKind}'`);
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

/* `backfillSourceMappings` was removed with `POST /discovery/backfill-source-mappings` (see
 * `packages/schemas/src/executors.ts` for why the population it served is closed). */
export interface DeleteSourceMappingsMatchingInput {
  orgId: string;
  componentObjectId: string;
  sourceKind: string;
  repoPattern: string | null;
  pathPattern: string | null;
  /** Part of the identity tuple (ADR-0030 §1) — see the over-deletion note on the function below.
   *  Required (not optional) here because every in-repo caller is a prune path that MUST discriminate
   *  on it; the HTTP surface is where absent-means-null back-compat lives. */
  refPattern: string | null;
  type: ExecutorType;
}

/** Deletes every row matching the identity tuple, for prune. See docs/coordination.md §910. */
export async function deleteSourceMappingsMatching(
  tx: TenantTx,
  input: DeleteSourceMappingsMatchingInput
): Promise<number> {
  const rows = await tx
    .delete(sourceMappings)
    .where(
      and(
        eq(sourceMappings.orgId, input.orgId),
        eq(sourceMappings.componentObjectId, input.componentObjectId),
        eq(sourceMappings.sourceKind, input.sourceKind),
        input.repoPattern === null
          ? isNull(sourceMappings.repoPattern)
          : eq(sourceMappings.repoPattern, input.repoPattern),
        input.pathPattern === null
          ? isNull(sourceMappings.pathPattern)
          : eq(sourceMappings.pathPattern, input.pathPattern),
        input.refPattern === null
          ? isNull(sourceMappings.refPattern)
          : eq(sourceMappings.refPattern, input.refPattern),
        eq(sourceMappings.type, input.type)
      )
    )
    .returning({ id: sourceMappings.id });
  return rows.length;
}

/** Sets the declared scope on every matching row. See docs/coordination.md §911. */
export async function setSourceMappingScopeMatching(
  tx: TenantTx,
  input: DeleteSourceMappingsMatchingInput,
  scope: SourceMappingScope | null
): Promise<number> {
  const rows = await tx
    .update(sourceMappings)
    .set({ scope })
    .where(
      and(
        eq(sourceMappings.orgId, input.orgId),
        eq(sourceMappings.componentObjectId, input.componentObjectId),
        eq(sourceMappings.sourceKind, input.sourceKind),
        input.repoPattern === null
          ? isNull(sourceMappings.repoPattern)
          : eq(sourceMappings.repoPattern, input.repoPattern),
        input.pathPattern === null
          ? isNull(sourceMappings.pathPattern)
          : eq(sourceMappings.pathPattern, input.pathPattern),
        input.refPattern === null
          ? isNull(sourceMappings.refPattern)
          : eq(sourceMappings.refPattern, input.refPattern),
        eq(sourceMappings.type, input.type)
      )
    )
    .returning({ id: sourceMappings.id });
  return rows.length;
}

/** Every `source_mappings` row whose component is one of `componentObjectIds` — the IaC
 *  ownership-scoped pool (C1: a mapping belongs to the stack that owns its component). Returns
 *  nothing for an empty id list rather than scanning the org. */
export async function listSourceMappingsForComponents(
  tx: TenantTx,
  orgId: string,
  componentObjectIds: string[]
): Promise<SourceMapping[]> {
  if (componentObjectIds.length === 0) return [];
  const rows = await tx
    .select()
    .from(sourceMappings)
    .where(
      and(
        eq(sourceMappings.orgId, orgId),
        inArray(sourceMappings.componentObjectId, componentObjectIds)
      )
    );
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
