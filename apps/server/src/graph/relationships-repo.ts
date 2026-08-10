import { and, eq, isNull } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import type { Relationship } from "@scp/schemas";
import type { TenantTx } from "../db/tenant-tx.js";
import { relationships } from "../db/schema.js";
import { badRequest, conflict, notFound } from "../errors.js";
import { isUniqueViolation } from "../db/pg-errors.js";
import { decodeCursor, encodeCursor, keysetAfter, keysetOrderBy } from "../pagination.js";
import { computeRelationshipContentHash } from "./content-hash.js";
import { requireRelationshipType } from "./type-registry-repo.js";
import { validateProperties } from "./property-validation.js";
import { appendAuditEvent } from "../audit/audit-repo.js";
import { eventBus } from "../events/event-bus.js";
import { ensureFederationSelf } from "../federation/self-repo.js";
import { appendJournalEntry } from "../federation/journal-repo.js";
import type { FederationImportContext } from "./objects-repo.js";

function toRelationship(row: typeof relationships.$inferSelect): Relationship {
  return {
    id: row.id,
    orgId: row.orgId,
    typeId: row.typeId,
    fromId: row.fromId,
    toId: row.toId,
    properties: row.properties as Record<string, unknown>,
    labels: row.labels as Record<string, unknown>,
    originDomainId: row.originDomainId,
    revision: row.revision,
    createdAt: row.createdAt.toISOString(),
    deletedAt: row.deletedAt?.toISOString() ?? null
  };
}

async function requireLiveObject(tx: TenantTx, orgId: string, id: string, label: "from" | "to") {
  const row = await tx.query.objects.findFirst({
    where: (t, { eq: eqOp, and: andOp, isNull: isNullOp }) =>
      andOp(eqOp(t.id, id), eqOp(t.orgId, orgId), isNullOp(t.deletedAt))
  });
  if (!row) throw badRequest(`${label} object '${id}' does not exist in this org`);
  return row;
}

/**
 * The 409 for "the `to` side already has an incoming edge of this type" — shared by BOTH the
 * app-level `assertCardinality` pre-check AND the DB-index race backstop in `createRelationship`'s
 * catch block, so a component that already has a service surfaces the SAME message whichever guard
 * fires (M12 P5b — the migration-0022 partial unique index caught a concurrent create with the
 * misleading generic "relationship id already exists" before this).
 */
function cardinalityToSideConflict(cardinality: string, typeId: string, toId: string) {
  return conflict(
    `cardinality '${cardinality}' violated: '${toId}' already has an incoming '${typeId}' relationship`
  );
}

/**
 * The mirror of `cardinalityToSideConflict` for the FROM side — shared by the app-level
 * `assertCardinality` pre-check and by the migration-0049 index race backstop, so a component that
 * already has a pipeline surfaces the SAME message whichever guard fires.
 */
function cardinalityFromSideConflict(cardinality: string, typeId: string, fromId: string) {
  return conflict(
    `cardinality '${cardinality}' violated: '${fromId}' already has an outgoing '${typeId}' relationship`
  );
}

/**
 * Which side of the edge each cardinality makes singular. Exhaustive BY CONSTRUCTION: an
 * unrecognised value is absent from this map and `assertCardinality` refuses the write rather than
 * falling through unenforced (`relationship_types.cardinality` is plain `text` with no CHECK
 * constraint, so a typo in a migration is reachable). That silent fall-through is exactly the trap
 * migration 0021 had to design around when `many_to_one` did not exist.
 */
const SINGULAR_SIDES: Record<string, { from: boolean; to: boolean }> = {
  many_to_many: { from: false, to: false },
  one_to_many: { from: false, to: true },
  many_to_one: { from: true, to: false },
  one_to_one: { from: true, to: true }
};

/**
 * Refuses a `contains` edge that would close a cycle.
 *
 * Before the `assembly` level, a cycle was IMPOSSIBLE by construction: `contains` only ran
 * `service -> component`, and a component has no children. Widening the type makes A-contains-B,
 * B-contains-A expressible for the first time, and a containment cycle is not a cosmetic problem —
 * `containmentChain` (policy scope, freeze scope, RBAC scope) and the ADR-0028 binding ladder all
 * walk parents, so a cycle is an infinite walk in the code paths that authorize releases.
 *
 * Walks UP from the proposed parent looking for the proposed child. Bounded by the same cap the
 * ladder uses, plus a `seen` set, so a cycle already in the table (written before this check existed,
 * or by privileged surgery) terminates rather than hanging the request that discovers it.
 */
async function assertNoContainmentCycle(
  tx: TenantTx,
  orgId: string,
  fromId: string,
  toId: string
): Promise<void> {
  if (fromId === toId) {
    throw badRequest("an object cannot contain itself");
  }
  const seen = new Set<string>([fromId]);
  let current: string | null = fromId;
  for (let hop = 0; hop < CONTAINMENT_CYCLE_SCAN_LIMIT && current; hop += 1) {
    const parent: { fromId: string } | undefined = await tx.query.relationships.findFirst({
      where: (t, { eq: eqOp, and: andOp, isNull: isNullOp }) =>
        andOp(
          eqOp(t.orgId, orgId),
          eqOp(t.typeId, "contains"),
          eqOp(t.toId, current!),
          isNullOp(t.deletedAt)
        )
    });
    if (!parent) return;
    if (parent.fromId === toId) {
      throw badRequest(
        `'contains' would create a containment cycle: ${toId} is already an ancestor of ${fromId}`
      );
    }
    if (seen.has(parent.fromId)) return;
    seen.add(parent.fromId);
    current = parent.fromId;
  }
}

/** Bounded so a pre-existing cycle cannot hang the request that trips over it. Generous relative to
 *  the depth cap of 3 (intermediate-grouping D2) — this is a safety stop, not the product rule. */
const CONTAINMENT_CYCLE_SCAN_LIMIT = 32;

async function assertCardinality(
  tx: TenantTx,
  orgId: string,
  typeId: string,
  cardinality: string,
  fromId: string,
  toId: string
): Promise<void> {
  const singular = SINGULAR_SIDES[cardinality];
  if (!singular) {
    // Fail closed. Permitting a write under a cardinality nothing can enforce is worse than a 500:
    // the constraint would read as enforced in the registry and be enforced nowhere.
    throw new Error(
      `relationship type '${typeId}' has unenforceable cardinality '${cardinality}' — no enforcement branch exists for it`
    );
  }
  if (!singular.from && !singular.to) return;

  if (singular.to) {
    // "to" side is singular: this `to_id` may not already have an incoming edge of this type.
    const toClash = await tx.query.relationships.findFirst({
      where: (t, { eq: eqOp, and: andOp, isNull: isNullOp }) =>
        andOp(
          eqOp(t.orgId, orgId),
          eqOp(t.typeId, typeId),
          eqOp(t.toId, toId),
          isNullOp(t.deletedAt)
        )
    });
    if (toClash) {
      throw cardinalityToSideConflict(cardinality, typeId, toId);
    }
  }
  if (singular.from) {
    // "from" side is singular: this `from_id` may not already have an outgoing edge of this type.
    const fromClash = await tx.query.relationships.findFirst({
      where: (t, { eq: eqOp, and: andOp, isNull: isNullOp }) =>
        andOp(
          eqOp(t.orgId, orgId),
          eqOp(t.typeId, typeId),
          eqOp(t.fromId, fromId),
          isNullOp(t.deletedAt)
        )
    });
    if (fromClash) {
      throw cardinalityFromSideConflict(cardinality, typeId, fromId);
    }
  }
}

export interface CreateRelationshipInput {
  orgId: string;
  actorObjectId: string;
  requestId: string;
  id?: string;
  typeId: string;
  fromId: string;
  toId: string;
  properties?: Record<string, unknown>;
  /** Mirrors `objects.labels` (schema.ts doc) — IaC applies (`iac/plans-repo.ts`) set the `scp:managed-by`/`scp:stack` markers here. */
  labels?: Record<string, unknown>;
  /** M6: see `graph/objects-repo.ts`'s `FederationImportContext` doc comment. */
  federationImport?: FederationImportContext;
}

export async function createRelationship(
  tx: TenantTx,
  input: CreateRelationshipInput
): Promise<Relationship> {
  const type = await requireRelationshipType(tx, input.typeId);
  const properties = input.properties ?? {};
  const labels = input.labels ?? {};
  validateProperties(type.propertySchema, properties, `rel:${type.id}`);

  const fromObj = await requireLiveObject(tx, input.orgId, input.fromId, "from");
  const toObj = await requireLiveObject(tx, input.orgId, input.toId, "to");

  if (type.fromTypes && !type.fromTypes.includes(fromObj.typeId)) {
    throw badRequest(
      `relationship type '${type.id}' does not allow '${fromObj.typeId}' as the 'from' endpoint`
    );
  }
  if (type.toTypes && !type.toTypes.includes(toObj.typeId)) {
    throw badRequest(
      `relationship type '${type.id}' does not allow '${toObj.typeId}' as the 'to' endpoint`
    );
  }

  // THE PAIRWISE RULES THE TYPE REGISTRY CANNOT EXPRESS (migration 0054's header).
  // `relationship_types` holds flat from/to arrays — a cross-product — so widening `contains` to
  // admit the `assembly` level necessarily also admits `assembly -> assembly`, which is not a shape
  // we want. It is refused here, with the containment cycle check, because there is nowhere in the
  // registry to say it.
  if (type.id === "contains") {
    if (fromObj.typeId === "assembly" && toObj.typeId === "assembly") {
      throw badRequest(
        "an assembly cannot contain another assembly — the levels are service -> assembly -> " +
          "component, so nest the components rather than the assemblies"
      );
    }
    await assertNoContainmentCycle(tx, input.orgId, input.fromId, input.toId);
  }

  await assertCardinality(tx, input.orgId, type.id, type.cardinality, input.fromId, input.toId);

  const id = input.id ?? uuidv7();
  const contentHash = computeRelationshipContentHash({
    id,
    orgId: input.orgId,
    typeId: input.typeId,
    fromId: input.fromId,
    toId: input.toId,
    properties,
    labels
  });

  const originDomainId =
    input.federationImport?.originDomainId ??
    (await ensureFederationSelf(tx, input.orgId)).domainId;
  const revision = input.federationImport?.revision ?? 1;

  let row: typeof relationships.$inferSelect | undefined;
  try {
    [row] = await tx
      .insert(relationships)
      .values({
        id,
        orgId: input.orgId,
        typeId: input.typeId,
        fromId: input.fromId,
        toId: input.toId,
        properties,
        labels,
        originDomainId,
        revision,
        contentHash
      })
      .returning();
  } catch (err) {
    if (isUniqueViolation(err, "relationships_org_type_from_to_key")) {
      // M6 idempotent replay: a re-imported create for an edge that already exists (created by
      // the same origin domain) is a no-op, not an error — the DoD's "double-import is a no-op"
      // applies to relationships too.
      if (input.federationImport) {
        const existing = await tx.query.relationships.findFirst({
          where: (t, { eq: eqOp, and: andOp }) =>
            andOp(
              eqOp(t.orgId, input.orgId),
              eqOp(t.typeId, input.typeId),
              eqOp(t.fromId, input.fromId),
              eqOp(t.toId, input.toId)
            )
        });
        if (existing && existing.originDomainId === input.federationImport.originDomainId) {
          return toRelationship(existing);
        }
        if (existing) {
          throw conflict(
            `single-writer authority violation: relationship '${existing.id}' is authoritatively owned by domain '${existing.originDomainId}', not '${input.federationImport.originDomainId}'`
          );
        }
      }
      throw conflict(
        `relationship '${input.typeId}' from '${input.fromId}' to '${input.toId}' already exists`
      );
    }
    if (isUniqueViolation(err, "relationships_contains_one_service_per_component")) {
      // Migration-0022 partial unique index: two concurrent `contains` creates for the same
      // component both passed `assertCardinality` under READ COMMITTED (no row lock), and this one
      // lost at the index. Surface the SAME one-service-per-component 409 the pre-check would have,
      // not the misleading generic "relationship id already exists" below (which blames the id).
      throw cardinalityToSideConflict("one_to_many", input.typeId, input.toId);
    }
    if (isUniqueViolation(err, "relationships_releases_via_one_pipeline_per_component")) {
      // Migration-0049 partial unique index — the FROM-side mirror of the 0022 case above. Two
      // concurrent `releases_via` creates for the same component both passed `assertCardinality`
      // under READ COMMITTED (no row lock) and this one lost at the index. Surface the SAME
      // one-pipeline-per-component 409 the pre-check would have.
      throw cardinalityFromSideConflict("many_to_one", input.typeId, input.fromId);
    }
    if (isUniqueViolation(err)) throw conflict(`relationship id '${id}' already exists`);
    throw err;
  }
  if (!row) throw new Error("failed to insert relationship");

  await appendAuditEvent(tx, {
    orgId: input.orgId,
    actorId: input.actorObjectId,
    action: `relationship.${input.typeId}.create`,
    subjectId: id,
    beforeHash: null,
    afterHash: contentHash,
    requestId: input.requestId
  });
  if (!input.federationImport) {
    await appendJournalEntry(tx, {
      orgId: input.orgId,
      entryKind: "relationship_upsert",
      contentHash,
      payload: {
        id,
        orgId: input.orgId,
        typeId: input.typeId,
        fromId: input.fromId,
        toId: input.toId,
        properties,
        labels,
        originDomainId,
        revision
      }
    });
  }
  await eventBus.publish(tx, {
    orgId: input.orgId,
    type: "scp.relationship.created",
    source: `/relationships`,
    subject: id,
    data: { id, typeId: input.typeId, fromId: input.fromId, toId: input.toId }
  });

  return toRelationship(row);
}

export async function getRelationship(
  tx: TenantTx,
  orgId: string,
  id: string
): Promise<Relationship> {
  const row = await tx.query.relationships.findFirst({
    where: (t, { eq: eqOp, and: andOp, isNull: isNullOp }) =>
      andOp(eqOp(t.id, id), eqOp(t.orgId, orgId), isNullOp(t.deletedAt))
  });
  if (!row) throw notFound(`relationship '${id}' not found`);
  return toRelationship(row);
}

export interface ListRelationshipsQuery {
  cursor?: string | undefined;
  limit: number;
  fromId?: string | undefined;
  toId?: string | undefined;
  typeId?: string | undefined;
}

export async function listRelationships(
  tx: TenantTx,
  orgId: string,
  query: ListRelationshipsQuery
): Promise<{ items: Relationship[]; nextCursor: string | null }> {
  const cursor = query.cursor ? decodeCursor(query.cursor) : null;
  const conditions = [eq(relationships.orgId, orgId), isNull(relationships.deletedAt)];
  if (query.fromId) conditions.push(eq(relationships.fromId, query.fromId));
  if (query.toId) conditions.push(eq(relationships.toId, query.toId));
  if (query.typeId) conditions.push(eq(relationships.typeId, query.typeId));
  if (cursor) {
    conditions.push(keysetAfter(relationships.createdAt, relationships.id, cursor));
  }

  const rows = await tx
    .select()
    .from(relationships)
    .where(and(...conditions))
    .orderBy(...keysetOrderBy(relationships.createdAt, relationships.id))
    .limit(query.limit + 1);

  const hasMore = rows.length > query.limit;
  const page = hasMore ? rows.slice(0, query.limit) : rows;
  const last = page[page.length - 1];
  return {
    items: page.map(toRelationship),
    nextCursor: hasMore && last ? encodeCursor(last) : null
  };
}

export async function deleteRelationship(
  tx: TenantTx,
  input: {
    orgId: string;
    actorObjectId: string;
    requestId: string;
    id: string;
    /** M6: see `graph/objects-repo.ts`'s `FederationImportContext` doc comment. */
    federationImport?: FederationImportContext;
  }
): Promise<void> {
  const existing = await tx.query.relationships.findFirst({
    where: (t, { eq: eqOp, and: andOp, isNull: isNullOp }) =>
      andOp(eqOp(t.id, input.id), eqOp(t.orgId, input.orgId), isNullOp(t.deletedAt))
  });
  if (!existing) throw notFound(`relationship '${input.id}' not found`);

  if (input.federationImport) {
    if (existing.originDomainId !== input.federationImport.originDomainId) {
      throw conflict(
        `single-writer authority violation: relationship '${existing.id}' is authoritatively owned by domain '${existing.originDomainId}', not '${input.federationImport.originDomainId}'`
      );
    }
    if (input.federationImport.revision <= existing.revision) return; // stale replay — no-op
  } else {
    const self = await ensureFederationSelf(tx, input.orgId);
    if (existing.originDomainId !== self.domainId) {
      throw conflict(
        `relationship '${existing.id}' is a read-only replica (authoritative domain '${existing.originDomainId}') — it cannot be mutated locally`
      );
    }
  }

  const nextRevision = input.federationImport?.revision ?? existing.revision + 1;
  await tx
    .update(relationships)
    .set({ deletedAt: new Date(), revision: nextRevision })
    .where(eq(relationships.id, existing.id));

  await appendAuditEvent(tx, {
    orgId: input.orgId,
    actorId: input.actorObjectId,
    action: `relationship.${existing.typeId}.delete`,
    subjectId: existing.id,
    beforeHash: existing.contentHash,
    afterHash: null,
    requestId: input.requestId
  });
  if (!input.federationImport) {
    await appendJournalEntry(tx, {
      orgId: input.orgId,
      entryKind: "relationship_tombstone",
      contentHash: existing.contentHash,
      payload: {
        id: existing.id,
        typeId: existing.typeId,
        fromId: existing.fromId,
        toId: existing.toId
      }
    });
  }
  await eventBus.publish(tx, {
    orgId: input.orgId,
    type: "scp.relationship.deleted",
    source: `/relationships`,
    subject: existing.id,
    data: { id: existing.id, typeId: existing.typeId, fromId: existing.fromId, toId: existing.toId }
  });
}
