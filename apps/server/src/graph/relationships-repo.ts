import { and, eq, isNull } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import type { Relationship } from "@scp/schemas";
import type { TenantTx } from "../db/tenant-tx.js";
import { objects, relationships } from "../db/schema.js";
import { badRequest, conflict, notFound } from "../errors.js";
import { isUniqueViolation } from "../db/pg-errors.js";
import { decodeCursor, encodeCursor, keysetAfter, keysetOrderBy } from "../pagination.js";
import {
  assertContainmentDepthAdmits,
  containmentChain,
  containmentParentChainForDoor,
  type ChainEntry
} from "./containment.js";
import { computeRelationshipContentHash } from "./content-hash.js";
import { requireRelationshipType } from "./type-registry-repo.js";
import { validateProperties } from "./property-validation.js";
import { appendAuditEvent } from "../audit/audit-repo.js";
import { policyReachFor, recordGovernanceReachChange } from "../governance/governance-reach.js";
import { assertMayWriteGovernanceLabels } from "../governance/governance-labels.js";
import {
  assertMayJoinRoleBearingSubject,
  assertOrgRetainsAdministrativeFloor
} from "../authz/role-binding-door.js";
import { inArray } from "drizzle-orm";
import { eventBus } from "../events/event-bus.js";
import { ensureFederationSelf } from "../federation/self-repo.js";
import { appendJournalEntry } from "../federation/journal-repo.js";
import type { FederationImportContext } from "./objects-repo.js";

/** Does either endpoint stay inside its own security domain. See docs/graph.md §166. */
async function eitherEndpointIsDomainLocal(
  tx: TenantTx,
  orgId: string,
  fromId: string,
  toId: string
): Promise<boolean> {
  const rows = await tx
    .select({ domainLocal: objects.domainLocal })
    .from(objects)
    .where(and(eq(objects.orgId, orgId), inArray(objects.id, [fromId, toId])));
  return rows.some((row) => row.domainLocal);
}

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

/** The shared 409 when the `to` side already has such an edge. See docs/graph.md §167. */
function cardinalityToSideConflict(cardinality: string, typeId: string, toId: string) {
  return conflict(
    `cardinality '${cardinality}' violated: '${toId}' already has an incoming '${typeId}' relationship`
  );
}

/** The mirror of `cardinalityToSideConflict` for the FROM side. See docs/graph.md §168. */
function cardinalityFromSideConflict(cardinality: string, typeId: string, fromId: string) {
  return conflict(
    `cardinality '${cardinality}' violated: '${fromId}' already has an outgoing '${typeId}' relationship`
  );
}

/** Which side of the edge each cardinality makes singular. See docs/graph.md §169. */
const SINGULAR_SIDES: Record<string, { from: boolean; to: boolean }> = {
  many_to_many: { from: false, to: false },
  one_to_many: { from: false, to: true },
  many_to_one: { from: true, to: false },
  one_to_one: { from: true, to: true }
};

/** Refuses a `contains` edge that would close a containment cycle. See docs/graph.md §170. */
async function assertContainsEdgeAdmissible(
  tx: TenantTx,
  orgId: string,
  fromId: string,
  toId: string,
  federationImport: FederationImportContext | undefined
): Promise<void> {
  if (fromId === toId) {
    // Kept as its own refusal for the message alone: "an object cannot contain itself" is the
    // diagnosis, where the cycle message below would report the object as its own ancestor.
    throw badRequest("an object cannot contain itself");
  }
  // Local writes take the DOOR's reading of the walk (the walk's 409 for a container already past
  // the bound becomes this door's 400 — `containmentParentChainForDoor`); the import path keeps the
  // raw walk, unchanged from before this door existed (see the module doc above for what that costs).
  let chain: ChainEntry[];
  let hops = 0;
  if (federationImport) {
    chain = await containmentChain(tx, orgId, fromId);
  } else {
    ({ chain, hops } = await containmentParentChainForDoor(tx, orgId, toId, fromId));
  }
  if (chain.some((entry) => entry.id === toId)) {
    throw badRequest(
      `'contains' would create a containment cycle: ${toId} is already an ancestor of ${fromId}`
    );
  }
  if (!federationImport) {
    // The `to` row EXISTS (loaded live by the caller), so its subtree — components under an
    // assembly, placements under a component — moves with it: childIsNew is false.
    await assertContainmentDepthAdmits(tx, {
      orgId,
      childId: toId,
      parentId: fromId,
      hops,
      childIsNew: false
    });
  }
}

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
  /** Mirrors `objects.labels` (schema.ts doc). IaC applies (`iac/plans-repo.ts`) set the
   *  `scp:managed-by`/`scp:stack` markers here, but since drizzle/0068 those are a DESCRIPTIVE
   *  MIRROR: what an apply prunes on is the server-written `relationships.managed_by_stack` column,
   *  which this input deliberately cannot set. */
  labels?: Record<string, unknown>;
  /** M6: see `graph/objects-repo.ts`'s `FederationImportContext` doc comment. */
  federationImport?: FederationImportContext;
  /** IdP GROUP SYNC (`auth/identity-sync.ts`). See docs/graph.md §171. */
  identitySync?: true;
}

export async function createRelationship(
  tx: TenantTx,
  input: CreateRelationshipInput
): Promise<Relationship> {
  const type = await requireRelationshipType(tx, input.typeId);
  const properties = input.properties ?? {};
  const labels = input.labels ?? {};
  validateProperties(type.propertySchema, properties);

  // THE RESERVED GOVERNANCE LABEL NAMESPACE, on the edge table too. See docs/graph.md §172.
  if (!input.federationImport) {
    await assertMayWriteGovernanceLabels(tx, {
      orgId: input.orgId,
      actorObjectId: input.actorObjectId,
      before: {},
      after: labels,
      subject: `relationship '${type.id}'`
    });
  }

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

  // THE PAIRWISE RULES THE TYPE REGISTRY CANNOT EXPRESS. See docs/graph.md §173.
  if (type.id === "contains") {
    if (fromObj.typeId === "assembly" && toObj.typeId === "assembly") {
      throw badRequest(
        "an assembly cannot contain another assembly — the levels are service -> assembly -> " +
          "component, so nest the components rather than the assemblies"
      );
    }
    await assertContainsEdgeAdmissible(
      tx,
      input.orgId,
      input.fromId,
      input.toId,
      input.federationImport
    );
  }

  // A `member_of` EDGE IS A ROLE GRANT. See docs/graph.md §174.
  if (type.id === "member_of" && !input.federationImport && !input.identitySync) {
    await assertMayJoinRoleBearingSubject(tx, {
      orgId: input.orgId,
      actorObjectId: input.actorObjectId,
      joinerObjectId: input.fromId,
      groupObjectId: input.toId
    });
  }

  await assertCardinality(tx, input.orgId, type.id, type.cardinality, input.fromId, input.toId);

  // CONTAINMENT ROUTE 2. See docs/graph.md §175.
  const reachBefore =
    input.typeId === "contains"
      ? await policyReachFor(tx, input.orgId, input.toId, input.actorObjectId)
      : null;

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

  // Resurrection: re-creating an edge that was removed. See docs/graph.md §176.
  const tombstone = await tx.query.relationships.findFirst({
    where: (t, { eq: eqOp, and: andOp, isNotNull: isNotNullOp }) =>
      andOp(
        eqOp(t.orgId, input.orgId),
        eqOp(t.typeId, input.typeId),
        eqOp(t.fromId, input.fromId),
        eqOp(t.toId, input.toId),
        isNotNullOp(t.deletedAt)
      )
  });
  if (tombstone) {
    const revivedContentHash = computeRelationshipContentHash({
      id: tombstone.id,
      orgId: input.orgId,
      typeId: input.typeId,
      fromId: input.fromId,
      toId: input.toId,
      properties,
      labels
    });
    const [revived] = await tx
      .update(relationships)
      .set({
        deletedAt: null,
        properties,
        labels,
        revision: tombstone.revision + 1,
        contentHash: revivedContentHash
      })
      .where(eq(relationships.id, tombstone.id))
      .returning();
    if (!revived) throw new Error("failed to revive relationship");

    // A RESURRECTION IS A CREATE, AND IT OWES EVERYTHING A CREATE OWES. See docs/graph.md §177.
    const revivedIsDomainLocal = fromObj.domainLocal || toObj.domainLocal;
    await appendAuditEvent(tx, {
      orgId: input.orgId,
      actorId: input.actorObjectId,
      action: `relationship.${input.typeId}.create`,
      subjectId: revived.id,
      // `null`, not the tombstone's hash: the state this write starts from is "no edge", because a
      // tombstone confers nothing. Same value the insert branch records.
      beforeHash: null,
      afterHash: revivedContentHash,
      requestId: input.requestId,
      subjectDomainLocal: revivedIsDomainLocal
    });
    if (reachBefore) {
      // Subject is the CHILD — see the matching note in the insert branch.
      await recordGovernanceReachChange(tx, {
        orgId: input.orgId,
        actorObjectId: input.actorObjectId,
        requestId: input.requestId,
        subjectObjectId: input.toId,
        route: "contains",
        detail: {
          edgeAction: "create",
          relationshipId: revived.id,
          containerObjectId: input.fromId
        },
        before: reachBefore,
        subjectDomainLocal: revivedIsDomainLocal
      });
    }
    if (!input.federationImport && !revivedIsDomainLocal) {
      await appendJournalEntry(tx, {
        orgId: input.orgId,
        entryKind: "relationship_upsert",
        contentHash: revivedContentHash,
        payload: {
          id: revived.id,
          orgId: input.orgId,
          typeId: input.typeId,
          fromId: input.fromId,
          toId: input.toId,
          properties,
          labels,
          // THE REVIVED ROW'S OWN provenance and revision, not the `originDomainId`/`revision`
          // computed above for a fresh insert: a resurrection keeps the authoring domain the row
          // was created under, and its revision advances from the tombstone's rather than from 1.
          originDomainId: revived.originDomainId,
          revision: revived.revision
        }
      });
    }
    await eventBus.publish(tx, {
      orgId: input.orgId,
      type: "scp.relationship.created",
      source: `/relationships`,
      subject: revived.id,
      data: {
        id: revived.id,
        typeId: input.typeId,
        fromId: input.fromId,
        toId: input.toId
      }
    });

    return toRelationship(revived);
  }

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

  // M20.3 (ADR-0031 §4) — AN EDGE INHERITS LOCALITY FROM EITHER ENDPOINT. See docs/graph.md §178.
  const edgeIsDomainLocal = fromObj.domainLocal || toObj.domainLocal;

  await appendAuditEvent(tx, {
    orgId: input.orgId,
    actorId: input.actorObjectId,
    action: `relationship.${input.typeId}.create`,
    subjectId: id,
    beforeHash: null,
    afterHash: contentHash,
    requestId: input.requestId,
    // The audit segment carries `subjectId` (the edge id) and the action names the type — enough to
    // tell a peer that a domain-local object gained an edge. Same reasoning as M20.2's object case.
    subjectDomainLocal: edgeIsDomainLocal
  });
  if (reachBefore) {
    // Subject is the CHILD — see the matching note in `deleteRelationship`.
    await recordGovernanceReachChange(tx, {
      orgId: input.orgId,
      actorObjectId: input.actorObjectId,
      requestId: input.requestId,
      subjectObjectId: input.toId,
      route: "contains",
      detail: { edgeAction: "create", relationshipId: id, containerObjectId: input.fromId },
      before: reachBefore,
      subjectDomainLocal: edgeIsDomainLocal
    });
  }
  // Never journaled when either endpoint is local — see M20.2's note in `graph/objects-repo.ts` for
  // why this is a SKIP rather than a stamp-and-filter (a filtered bundle is sparse, and a full-scope
  // receiver refuses a sparse chain).
  if (!input.federationImport && !edgeIsDomainLocal) {
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
    // Stale replay → no-op, EXCEPT under a resync force-overwrite permit (§7.2.6), which re-applies
    // even a stale-revision edge so a lost-tail restore re-converges relationships too.
    if (
      input.federationImport.revision <= existing.revision &&
      !input.federationImport.forceOverwrite
    )
      return;
  } else {
    const self = await ensureFederationSelf(tx, input.orgId);
    if (existing.originDomainId !== self.domainId) {
      throw conflict(
        `relationship '${existing.id}' is a read-only replica (authoritative domain '${existing.originDomainId}') — it cannot be mutated locally`
      );
    }
  }

  // CONTAINMENT ROUTE 2 — see `createRelationship` for the property. DETACHING is the dangerous
  // direction of the two: it is what takes an object out from under a `required` gate.
  const reachBefore =
    existing.typeId === "contains"
      ? await policyReachFor(tx, input.orgId, existing.toId, input.actorObjectId)
      : null;

  const nextRevision = input.federationImport?.revision ?? existing.revision + 1;
  await tx
    .update(relationships)
    .set({ deletedAt: new Date(), revision: nextRevision })
    .where(eq(relationships.id, existing.id));

  // THE ADMINISTRATOR FLOOR. See docs/graph.md §179.
  if (existing.typeId === "member_of" && !input.federationImport) {
    await assertOrgRetainsAdministrativeFloor(tx, {
      orgId: input.orgId,
      act:
        `removing the 'member_of' edge '${existing.id}' ('${existing.fromId}' -> ` +
        `'${existing.toId}')`
    });
  }

  // The tombstone re-resolves locality, as the create did. See docs/graph.md §180.
  const edgeIsDomainLocal = await eitherEndpointIsDomainLocal(
    tx,
    input.orgId,
    existing.fromId,
    existing.toId
  );

  await appendAuditEvent(tx, {
    orgId: input.orgId,
    actorId: input.actorObjectId,
    action: `relationship.${existing.typeId}.delete`,
    subjectId: existing.id,
    beforeHash: existing.contentHash,
    afterHash: null,
    requestId: input.requestId,
    subjectDomainLocal: edgeIsDomainLocal
  });
  if (reachBefore) {
    // Subject is the CHILD (`to_id`) — the object whose governance changed. The edge is the
    // instrument, not the victim, and an operator searching the audit log for "what happened to this
    // component" must find this event under the component's id.
    await recordGovernanceReachChange(tx, {
      orgId: input.orgId,
      actorObjectId: input.actorObjectId,
      requestId: input.requestId,
      subjectObjectId: existing.toId,
      route: "contains",
      detail: {
        edgeAction: "delete",
        relationshipId: existing.id,
        containerObjectId: existing.fromId
      },
      before: reachBefore,
      subjectDomainLocal: edgeIsDomainLocal
    });
  }
  if (!input.federationImport && !edgeIsDomainLocal) {
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
