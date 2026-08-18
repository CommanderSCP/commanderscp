import { and, eq, isNull } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import type { Relationship } from "@scp/schemas";
import type { TenantTx } from "../db/tenant-tx.js";
import { objects, relationships } from "../db/schema.js";
import { badRequest, conflict, notFound } from "../errors.js";
import { isUniqueViolation } from "../db/pg-errors.js";
import { decodeCursor, encodeCursor, keysetAfter, keysetOrderBy } from "../pagination.js";
import { containmentChain } from "./containment.js";
import { computeRelationshipContentHash } from "./content-hash.js";
import { requireRelationshipType } from "./type-registry-repo.js";
import { validateProperties } from "./property-validation.js";
import { appendAuditEvent } from "../audit/audit-repo.js";
import { policyReachFor, recordGovernanceReachChange } from "../governance/governance-reach.js";
import { assertMayWriteGovernanceLabels } from "../governance/governance-labels.js";
import { inArray } from "drizzle-orm";

/**
 * M20.3 (ADR-0031 §4) — does either endpoint of an edge stay inside its own security domain?
 *
 * Deliberately reads endpoints **including soft-deleted ones** (no `deletedAt` predicate): the one
 * caller is `deleteRelationship`, which frequently runs while an endpoint is itself being torn down,
 * and resolving a deleted endpoint to "not domain-local" would leak precisely at teardown — the
 * moment a `relationship_tombstone` naming its id would otherwise cross.
 *
 * One query for both endpoints; a self-edge collapses to a single row, which `.some()` handles
 * without a special case.
 */
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
 * Refuses a `contains` edge that would close a containment cycle — **over BOTH containment routes,
 * because containment has two and this check used to walk one.**
 *
 * Before the `assembly` level, a cycle was IMPOSSIBLE by construction: `contains` only ran
 * `service -> component`, and a component has no children. Widening the type makes A-contains-B,
 * B-contains-A expressible for the first time.
 *
 * ## What this used to claim, and what was actually true
 *
 * The previous wording said a cycle "is an infinite walk in the code paths that authorize releases",
 * and named `containmentChain` (policy scope, freeze scope, RBAC scope) and the ADR-0029 binding
 * ladder as the victims. Both halves were wrong, and they were wrong in opposite directions:
 *
 *  - **Not infinite.** Every named consumer is bounded. `graph/containment.ts`'s `containmentChain`
 *    and `authz/resolve.ts`'s `scopeExpandCte` both stop at `CONTAINMENT_WALK_MAX_DEPTH`;
 *    `coordination/binding-resolution.ts`'s ladder stops at `MAX_ANCESTOR_HOPS` (3). A loop costs
 *    them iterations, not termination.
 *  - **Not protected.** `containmentChain` walks `domain_id` AND `contains` (and a placement's pair).
 *    This function walked `contains` alone, so the MIXED loop — one hop of each — was invisible to
 *    it and writable through this door. MEASURED before this change, on the real HTTP doors: create
 *    an assembly A, create a service S with `domainId: A`, then `POST /relationships {contains,
 *    from: S, to: A}` answered **201**, and `S -> A -> S` was in the table. The `domain_id` door
 *    refuses exactly that loop (`graph/containment-parent-authz.ts` calls
 *    `assertRootedContainmentParent`, which checks the WHOLE walk and says so in as many words);
 *    the edge door did not. One concept, two doors, one of them taught.
 *
 * ## What a mixed loop actually costs, since it is not a hang
 *
 * It cannot DETACH a row — adding an edge only adds parents, and `domain_id` parents are kept rooted
 * by their own door, so the org root stays on every chain. What it corrupts is DEPTH.
 * `containmentChain` re-reaches a looped node at every second iteration, keeps the MAXIMUM raw depth
 * per id, and then inverts, so the target of the walk can come out at inverted depth 0 — the value
 * the convention reserves for the org root — with the actual org root ranked BELOW it. Measured on
 * the loop above: the walk ran to the depth bound and `assertRootedContainmentParent`'s `hops`
 * (derived from that inverted depth) reported **1**. That matters because the truncation refusal
 * `hops` feeds exists precisely to fail CLOSED when a walk was cut short and the cycle answer is
 * therefore unproven — near a loop it silently stops firing. Refusing to write the loop is the
 * cheapest place to stop that, and it is the place the other door already stops it.
 *
 * ## Why `containmentChain` rather than a widened hand-rolled walk
 *
 * It is the definition of "what contains this object" that every consumer of this decision reads, so
 * a route added there (route 4 arrived after route 3) is inherited here instead of drifting away from
 * here — the exact failure `graph/containment.ts`'s header records paying for twice. It is also a
 * FIXED one query, where the hand-rolled walk was one round trip PER HOP (1 in the common shape, up
 * to 32), so the widened check is not paid for in latency on the deep shapes. Its
 * bound is 10 against a `contains` chain that can be at most two hops deep (`service -> assembly ->
 * component`; `assembly -> assembly` is refused above), and both `contains` ancestors sit at walk
 * depth 1 and 2 from `fromId`, so nothing that was in range before is out of range now. It also
 * skips tombstoned ancestors, matching `scopeExpandCte` — a deleted object is not a container.
 *
 * ## Deliberately ONLY the cycle question — not `assertRootedContainmentParent` wholesale
 *
 * That function bundles two further refusals onto the same walk, and both would be NEW behaviour
 * here rather than an invariant: the truncation refusal would reject a `contains` edge under any
 * container whose own chain sits AT the bound (a ten-hop chain is complete and readable — ADR-0035's
 * probe proves it — and `routes/containment-move-cycle-and-source-authz.integration.test.ts` attaches
 * a component to exactly such a container), and the root-reachability refusal would newly reject
 * edges inside an already-stranded subtree, which is the one place an operator still has to work.
 * A guard that quietly lowers a documented limit is a behaviour change, not a bug fix. (A container
 * whose chain is PAST the bound is a different matter: `containmentChain` itself refuses there,
 * loudly — ADR-0035 — and this door inherits that refusal like every other walk consumer.)
 */
async function assertNoContainmentCycle(
  tx: TenantTx,
  orgId: string,
  fromId: string,
  toId: string
): Promise<void> {
  if (fromId === toId) {
    // Kept as its own refusal for the message alone: "an object cannot contain itself" is the
    // diagnosis, where the cycle message below would report the object as its own ancestor.
    throw badRequest("an object cannot contain itself");
  }
  const chain = await containmentChain(tx, orgId, fromId);
  if (chain.some((entry) => entry.id === toId)) {
    throw badRequest(
      `'contains' would create a containment cycle: ${toId} is already an ancestor of ${fromId}`
    );
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
}

export async function createRelationship(
  tx: TenantTx,
  input: CreateRelationshipInput
): Promise<Relationship> {
  const type = await requireRelationshipType(tx, input.typeId);
  const properties = input.properties ?? {};
  const labels = input.labels ?? {};
  validateProperties(type.propertySchema, properties);

  // THE RESERVED GOVERNANCE LABEL NAMESPACE, on the edge table too — see
  // `governance/governance-labels.ts`. No governance decision reads a RELATIONSHIP's labels today
  // (`iac/plans-repo.ts`'s stack-ownership markers are the only reader), and that is exactly why it
  // is guarded here rather than later: the namespace is worth having only if the sentence "a
  // `scp.governance/` key was set by an org-root `policy:write` holder" is true of every labels bag
  // in the system. Left off, the next consumer to read an edge label inherits the same evasion, and
  // nothing about this file would flag it. Relationships have no update verb (create + soft-delete
  // only — see `deleteRelationship`), so this create is the complete census of edge-label writes.
  //
  // The `federationImport` exemption is the one this repo already applies at both choke points, for
  // the same reason: `federation/import-repo.ts`'s replay branch has no try/catch, so a throw there
  // aborts a whole signed bundle rather than one entry.
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

  // THE PAIRWISE RULES THE TYPE REGISTRY CANNOT EXPRESS (migration 0055's header).
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

  // CONTAINMENT ROUTE 2 — a `contains` edge IS a containment parent (`graph/containment.ts` route
  // 2, walked backwards), so creating one changes which policies reach the CHILD, under
  // `relationship:write`. That is weaker and differently held than the `policy:write` that authored
  // those policies — see `governance/governance-reach.ts`.
  //
  // The type guard keeps this off every other relationship write in the system: a `member_of`,
  // `owns`, `places` or `depends_on` create short-circuits on a string comparison and costs nothing.
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

  // M20.3 (ADR-0031 §4) — AN EDGE INHERITS LOCALITY FROM EITHER ENDPOINT.
  //
  // EITHER, not both, and that is the whole point: the interesting edge is the MIXED one — a
  // domain-local networking component `part_of` a service the commander knows about. Requiring both
  // endpoints to be local would let exactly the leaking case through, because a
  // `relationship_upsert` payload carries `fromId`, `toId`, `typeId`, `properties` and `labels`.
  // Shipping that and letting the receiver decline to store it is a leak with a swallow, not
  // invisibility — the edge still names the local object's id in a file written to disk and relayed.
  //
  // Both endpoints are already loaded and validated above (`requireLiveObject`), so this costs no
  // extra query — and reading them is the only correct source, since locality is a property of the
  // objects, never of the edge's own request.
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
    if (input.federationImport.revision <= existing.revision) return; // stale replay — no-op
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

  // M20.3 (ADR-0031 §4) — the tombstone inherits locality the same way the create did, and it has to
  // be RE-RESOLVED here: the edge row itself carries no locality (locality belongs to the objects),
  // so this is a real lookup rather than a field read. A tombstone payload names `fromId` and
  // `toId`, so letting it cross would disclose the local object's id and the fact that its edge was
  // removed. Endpoints are read even when soft-deleted — a deleted endpoint is still a domain-local
  // one, and resolving it to "not local" would leak precisely at teardown.
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
