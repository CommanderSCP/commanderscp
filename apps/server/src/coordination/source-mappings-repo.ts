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
import { objects, sourceMappings } from "../db/schema.js";
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

/**
 * Flips the ONE mutable field on this table (migration 0063, PATCH .../mappings/:id) — the
 * operator's pause switch. Scoped by `(orgId, sourceKind, id)`, matching the route's addressing;
 * a miss on any of the three throws 404 rather than silently patching nothing.
 */
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

/**
 * Sets or clears the DECLARED scope of one mapping (migration 0066, §10.6; PATCH
 * .../mappings/:id/scope). Same `(orgId, sourceKind, id)` addressing and 404 rule as the pause
 * switch above, and for the same reason: a label change on one row must never reach a
 * byte-identical sibling. `null` clears the declaration. A label only — nothing here re-routes.
 */
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
  refPattern?: string;
  type?: ExecutorType;
  classification?: PipelineClassification;
  /** Declared mirror-of-shared provenance (outpost-ui.md §9.3a); omitted = domain-specific. */
  mirrorOfShared?: boolean;
  /** The pause switch (migration 0063); omitted = enabled. */
  enabled?: boolean;
  /** Declared reach (migration 0066, §10.6); omitted = not declared. */
  scope?: SourceMappingScope | null;
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
      skipped.push({
        objectName: m.objectName,
        reason: `no live component named '${m.objectName}'`
      });
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

    // Idempotent: skip an identical (component, sourceKind, repo, path, ref) mapping — re-running is
    // a no-op. `refPattern` is part of the comparison because it is a ROUTING discriminator: without
    // it, a backfill declaring the `dev`-branch mapping would be swallowed as a duplicate of the
    // ref-agnostic one already on the row, and the dev pipeline would silently never be created.
    const existing = await listSourceMappingsForSource(tx, input.orgId, m.sourceKind);
    const dup = existing.some(
      (e) =>
        e.componentObjectId === componentId &&
        (e.repoPattern ?? null) === (m.repoPattern ?? null) &&
        (e.pathPattern ?? null) === (m.pathPattern ?? null) &&
        (e.refPattern ?? null) === (m.refPattern ?? null)
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
      refPattern: m.refPattern,
      componentIdOrUrn: componentId,
      type: m.type,
      classification: m.classification,
      mirrorOfShared: m.mirrorOfShared,
      enabled: m.enabled,
      scope: m.scope
    });
    createdSourceMappingIds.push(created.id);
  }

  return { createdSourceMappingIds, skipped };
}

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

/**
 * Deletes EVERY `source_mappings` row matching the full identity tuple — the prune primitive IaC
 * apply needs (docs/proposals/post-import-configuration.md §8 C1), and the first delete path this
 * table has had (hence migration 0049's DELETE grant). A HARD delete: like `executor_bindings`, a
 * source mapping is correlation config, not an audited graph object, and the table carries no
 * `deleted_at`.
 *
 * "EVERY matching row", not "one", is deliberate. The table has no unique constraint, and
 * `POST /discovery/accept` inserts unconditionally, so an estate can hold several byte-identical
 * mappings (the homelab does). Deleting one would leave a plan that reports `deletes=1` while the
 * survivor still correlates — and it would come back as a prune candidate on the next plan forever,
 * so the manifest would never converge. Returns the number of rows removed so the caller can tell a
 * real prune from a no-op.
 *
 * `refPattern` is part of the tuple and MUST stay part of it (ADR-0030 §1). It is a routing
 * discriminator, so two mappings can differ ONLY by it — `refs/heads/dev` → the dev pipeline,
 * `refs/heads/main` → the production one, same component, same repo, same path, same Type. A tuple
 * that ignored the ref would match BOTH, so pruning the dev mapping would silently take the
 * production route with it and report a `deleted` count the caller reads as success. The `is null`
 * branch below is what keeps a ref-agnostic prune from reaching a ref-scoped row.
 */
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

/**
 * Sets the declared scope on EVERY `source_mappings` row matching the identity tuple — the IaC
 * apply primitive for a `source-mapping` `update` verdict (§10.6). Same tuple, same `is null`
 * branches and same "every matching row" reasoning as `deleteSourceMappingsMatching` above: the
 * table has no unique constraint, so a manifest's declaration must converge all of the byte-identical
 * rows that share the tuple, or the next plan proposes the same update forever. Returns the number of
 * rows converged so the caller can tell a real update from a tuple that vanished underneath it.
 */
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
