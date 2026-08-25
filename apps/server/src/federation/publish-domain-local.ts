import { and, eq, isNull, or } from "drizzle-orm";
import type { GraphObject, SweptRelationship } from "@scp/schemas";
import type { TenantTx } from "../db/tenant-tx.js";
import { objects, relationships } from "../db/schema.js";
import { conflict, notFound } from "../errors.js";
import { appendAuditEvent } from "../audit/audit-repo.js";
import { appendJournalEntry } from "./journal-repo.js";
import { ensureFederationSelf } from "./self-repo.js";
import { getObjectByIdOrUrn, journalEntryKindFor, toGraphObject } from "../graph/objects-repo.js";

export interface PublishDomainLocalInput {
  orgId: string;
  typeId: string;
  idOrUrn: string;
  actorObjectId: string;
  requestId: string;
}

export interface PublishDomainLocalResult {
  object: GraphObject;
  /** Ids of the edges re-journaled alongside the object, in the order they were published. */
  publishedRelationshipIds: string[];
  /** Ids of the object's live edges deliberately LEFT unpublished because their OTHER endpoint is
   *  itself still domain-local. Reported so the caller can see the sweep was partial and why. */
  withheldRelationshipIds: string[];
  /** The same two sets, described well enough to act on — see {@link SweptRelationship}. Derived
   *  from the identical loop, so membership and order can never diverge from the id arrays. */
  publishedRelationships: SweptRelationship[];
  withheldRelationships: SweptRelationship[];
}

/**
 * M20.4 (ADR-0031 §6) — publish a domain-local object: it stops being domain-local, and its current
 * state (plus the edges that can now travel) is put on the journal from this point forward.
 *
 * ## A verb, not a property write
 *
 * `domain_local` is otherwise named by NO update statement anywhere — that structural absence is
 * what makes locality immutable rather than merely guarded (ADR-0031 §6, and the census in
 * `drizzle/0059_objects_domain_local.sql`). **This function is the single, deliberate exception**,
 * and it is a verb because it does not merely set a field: it re-journals the object and sweeps its
 * edges, and an operator must be able to see that as an action with an effect rather than as a field
 * edit that quietly emitted a stream of entries.
 *
 * ## Authorization lives at the door, and it is TWO permissions
 *
 * This function takes a `TenantTx` and an `actorObjectId` for AUTHORSHIP only — it authorizes
 * nothing, the same split `federation/domain-local.ts` documents ("authorization at the door,
 * invariant at the repo"). Its sole route, `POST /objects/{type}/{idOrUrn}/publish`, demands BOTH
 * `object:write` and `federation:write` at the object.
 *
 * BOTH, because this is both acts at once. `federation:write` matches the permission that DECLARED
 * locality (ADR-0031 §1) — undoing a boundary decision cannot be cheaper than making it.
 * `object:write` matches declaring's OTHER half, and it is here because of what the body below
 * actually does: it `UPDATE`s an estate row and BUMPS `version`. On `federation:write` alone the
 * FederationAdmin shape ("operates the link, does not edit the estate") could re-version estate
 * rows through the inverse of a verb it was never allowed to perform. A new caller that reaches
 * this function without both bars re-opens that.
 *
 * ## One-way, permanently
 *
 * There is no inverse and there will not be one. Federation has no un-send: once an object's
 * existence has reached a peer, a later claim that it is domain-local asserts a confidentiality
 * property the system cannot deliver, so an API that accepted "un-publish" would be lying. The
 * asymmetry is the design, not an unfinished half of it.
 *
 * ## Why re-journaling is enough
 *
 * Journal payloads are **full-state upserts, not deltas** — the importer applies them through
 * `upsertObjectByUrn`. So a single fresh `object_upsert` carrying the object's *current* state lands
 * it correctly on a peer that has never seen it, with no need to replay the history it missed. The
 * observable consequence, and it is a real one: the commander's first knowledge of a published object
 * is its state **at publication**, not its origin. A reader must not mistake that absence of earlier
 * revisions for a creation date. (Imported audit segments are discarded on the import path anyway, so
 * nothing else was going to reconstruct that history either.)
 *
 * ## The edge sweep, and why it is `OR` not `AND`
 *
 * Publishing the object alone would leave it on the peer with none of its relationships — an orphan
 * in the receiving graph. So every live edge touching it is reconsidered under ADR-0031 §4's
 * either-endpoint rule, which now yields a different answer for exactly those edges whose *other*
 * endpoint was already shared. Edges to a still-domain-local neighbour stay unjournaled and are
 * reported as `withheldRelationshipIds` — a partial sweep is the correct outcome, but a silent one
 * would be indistinguishable from a bug.
 */
/**
 * M20.6 (ADR-0031 §6b) — the containment parents of `objectId` that are THEMSELVES still
 * domain-local, along both routes `graph/containment.ts` walks.
 *
 * ONE HOP, deliberately, and for the same reason §6a inherits one hop: by induction an object cannot
 * be under a domain-local ancestor without its immediate parent being domain-local too, because
 * locality is inherited at create all the way down. Walking the full chain would answer the same
 * question at the cost of a recursive CTE in a write path.
 *
 * Returns the offending parents DESCRIBED, not merely counted — the operator's next action is
 * "publish that container first", and a refusal that does not name it makes them go looking.
 */
async function domainLocalContainersOf(
  tx: TenantTx,
  orgId: string,
  objectId: string,
  containmentDomainId: string | null
): Promise<{ id: string; urn: string; name: string }[]> {
  const found: { id: string; urn: string; name: string }[] = [];

  // Route 1 — the `domain_id` parent. NULL only for the org root itself, which has no container.
  if (containmentDomainId) {
    const rows = await tx
      .select({ id: objects.id, urn: objects.urn, name: objects.name })
      .from(objects)
      .where(
        and(
          eq(objects.orgId, orgId),
          eq(objects.id, containmentDomainId),
          eq(objects.domainLocal, true)
        )
      )
      .limit(1);
    found.push(...rows);
  }

  // Route 2 — live `contains` parents, the edge walked backwards (to_id = this object).
  const containers = await tx
    .select({ id: objects.id, urn: objects.urn, name: objects.name })
    .from(relationships)
    .innerJoin(objects, eq(objects.id, relationships.fromId))
    .where(
      and(
        eq(relationships.orgId, orgId),
        eq(relationships.typeId, "contains"),
        eq(relationships.toId, objectId),
        isNull(relationships.deletedAt),
        eq(objects.orgId, orgId),
        isNull(objects.deletedAt),
        eq(objects.domainLocal, true)
      )
    );
  // De-duplicated on id: an object whose `domain_id` parent ALSO contains it via an edge would
  // otherwise be named twice in the refusal, which reads like two problems.
  for (const container of containers) {
    if (!found.some((f) => f.id === container.id)) found.push(container);
  }
  return found;
}

export async function publishDomainLocalObject(
  tx: TenantTx,
  input: PublishDomainLocalInput
): Promise<PublishDomainLocalResult> {
  // Resolved through the wire-shaped reader first so id-or-URN resolution, type checking and the 404
  // stay identical to every other object route — then RE-READ as a locked raw row, because this
  // function needs `contentHash` (absent from the wire shape) and because two concurrent publishes
  // must serialize rather than both emit a journal entry for the same object.
  const resolved = await getObjectByIdOrUrn(tx, input.orgId, input.typeId, input.idOrUrn);
  const lockedRows = await tx
    .select()
    .from(objects)
    .where(and(eq(objects.orgId, input.orgId), eq(objects.id, resolved.id)))
    .for("update");
  const existing = lockedRows[0];
  if (!existing) throw notFound(`object '${resolved.id}' not found`);

  // Single-writer authority, checked BEFORE anything is written. Publishing a replica would be this
  // domain claiming authorship of another domain's row — the same violation `updateObject` refuses,
  // and it must be refused here too or the verb becomes a side door around it.
  const self = await ensureFederationSelf(tx, input.orgId);
  if (existing.originDomainId !== self.domainId) {
    throw conflict(
      `object '${existing.id}' is a read-only replica (authoritative domain ` +
        `'${existing.originDomainId}') — only its owning domain can publish it`
    );
  }

  if (!existing.domainLocal) {
    // Deliberately a 409 rather than a silent success. "Publish" is not idempotent in any meaningful
    // sense — a second call would re-journal an object that already federates, emitting a spurious
    // revision to every peer — and an operator who reaches for it twice has misunderstood the state,
    // which is worth saying rather than absorbing.
    throw conflict(
      `object '${existing.id}' is not domain-local — it already federates, and publishing it again ` +
        `would emit a redundant revision to every peer`
    );
  }

  // M20.6 (ADR-0031 §6b) — REFUSE PUBLISHING OUT OF A STILL-DOMAIN-LOCAL CONTAINER, before any write.
  //
  // Publishing a child whose container stays local lands it at the commander with NO containment edge
  // at all: the child's `object_upsert` crosses, the container's does not, and §4 withholds the edge
  // between them. Every consumer that derives authority from containment — policy resolution, RBAC
  // scope expansion, freeze scoping, approval scope, all walking `graph/containment.ts` — then reads
  // it as attached to nothing.
  //
  // That is not a hypothetical shape. ADR-0026 MEASURED it, reached by a different route: a placement
  // whose chain was `[org root, placement]` silently stopped ELEVEN `required` component-scoped
  // prod-gate policies on the live estate and made every service-scoped freeze FAIL OPEN. It was
  // called a defect there and fixed without asking; a supported API deliberately producing it would
  // be worse than the accident was.
  //
  // The required order is publish-the-container-then-the-child, and it stays one explicit decision at
  // a time because publishing a container does NOT publish its children — the edge sweep below
  // re-journals only edges whose other endpoint is already shared.
  const blockingContainers = await domainLocalContainersOf(
    tx,
    input.orgId,
    existing.id,
    existing.domainId
  );
  if (blockingContainers.length > 0) {
    const named = blockingContainers.map((c) => `'${c.name}' (${c.urn})`).join(", ");
    throw conflict(
      `object '${existing.id}' cannot be published while it is contained by domain-local ` +
        `object(s) ${named}: it would arrive at a peer with no containment edge, and every check ` +
        `that derives scope from containment — policies, freezes, approvals, RBAC — would read it ` +
        `as attached to nothing (ADR-0031 §6b). Publish the container(s) first, then this object; ` +
        `publishing a container does not publish its children.`
    );
  }

  const [row] = await tx
    .update(objects)
    // THE ONE UPDATE IN THE CODEBASE THAT NAMES THIS COLUMN. `version` is bumped because a publish is
    // a real, observable state change to the row; `revision` is NOT, because that is the federation
    // author-assigned counter the peer orders replicas by, and this object's first entry at any peer
    // must not claim to be a later revision of something they never received.
    // M20.7 (ADR-0031 §6c): the provenance is cleared alongside the flag. It answers "why is this
    // domain-local", so on an object that no longer is, keeping it would leave a field asserting a
    // reason for a state that has ended. Both columns go together, as they are written together.
    .set({
      domainLocal: false,
      domainLocalInheritedFrom: null,
      domainLocalInheritedFromUrn: null,
      version: existing.version + 1,
      updatedAt: new Date()
    })
    .where(and(eq(objects.orgId, input.orgId), eq(objects.id, existing.id)))
    .returning();
  if (!row) throw notFound(`object '${existing.id}' disappeared during publish`);

  const published = toGraphObject(row);

  await appendAuditEvent(tx, {
    orgId: input.orgId,
    domainId: row.domainId,
    actorId: input.actorObjectId,
    action: `${input.typeId}.publish`,
    subjectId: row.id,
    beforeHash: existing.contentHash,
    afterHash: row.contentHash,
    requestId: input.requestId
    // No `subjectDomainLocal` — the object is published as of this event, so its audit segment
    // travels. This is the first thing about it a peer is allowed to learn.
  });

  await appendJournalEntry(tx, {
    orgId: input.orgId,
    entryKind: journalEntryKindFor(input.typeId, false),
    contentHash: row.contentHash,
    payload: {
      id: row.id,
      orgId: input.orgId,
      domainId: row.domainId,
      typeId: input.typeId,
      name: row.name,
      urn: row.urn,
      properties: row.properties,
      labels: row.labels,
      originDomainId: row.originDomainId,
      revision: row.revision,
      version: row.version
      // No `domainLocal` stamp: that is the entire point of this entry.
    }
  });

  // Live edges touching the object, either direction.
  const edges = await tx
    .select()
    .from(relationships)
    .where(
      and(
        eq(relationships.orgId, input.orgId),
        isNull(relationships.deletedAt),
        or(eq(relationships.fromId, row.id), eq(relationships.toId, row.id))
      )
    );

  const publishedRelationships: SweptRelationship[] = [];
  const withheldRelationships: SweptRelationship[] = [];
  for (const edge of edges) {
    // Only edges THIS domain authored may be journaled by it (single-writer authority) — an edge
    // replicated from a peer is already on that peer's own chain.
    if (edge.originDomainId !== self.domainId) continue;

    const otherId = edge.fromId === row.id ? edge.toId : edge.fromId;
    // Urn and name come back alongside the locality flag — the same row read, no extra query. They
    // are what make the sweep legible: for a WITHHELD edge, the other endpoint IS the operator's
    // next action ("publish that one too"), and an id alone cannot say which object that is.
    const other = await tx
      .select({ domainLocal: objects.domainLocal, urn: objects.urn, name: objects.name })
      .from(objects)
      .where(and(eq(objects.orgId, input.orgId), eq(objects.id, otherId)))
      .limit(1);
    const swept: SweptRelationship = {
      id: edge.id,
      typeId: edge.typeId,
      otherEndpointId: otherId,
      // An endpoint row that has vanished still has to be reportable, so the descriptive fields
      // degrade to the id rather than dropping the edge from the report entirely.
      otherEndpointUrn: other[0]?.urn ?? otherId,
      otherEndpointName: other[0]?.name ?? otherId
    };
    // A missing endpoint is treated as still-withheld rather than published: it cannot be shown to
    // be shared, and this is the fail-closed direction.
    if (!other[0] || other[0].domainLocal) {
      withheldRelationships.push(swept);
      continue;
    }

    await appendJournalEntry(tx, {
      orgId: input.orgId,
      entryKind: "relationship_upsert",
      contentHash: edge.contentHash,
      payload: {
        id: edge.id,
        orgId: input.orgId,
        typeId: edge.typeId,
        fromId: edge.fromId,
        toId: edge.toId,
        properties: edge.properties,
        labels: edge.labels,
        originDomainId: edge.originDomainId,
        revision: edge.revision
      }
    });
    publishedRelationships.push(swept);
  }

  // The id arrays are DERIVED from the descriptive ones rather than accumulated in parallel, so the
  // two views cannot drift in membership or order — a `push` that landed in one loop branch and not
  // the other is a class of bug this shape simply cannot have.
  return {
    object: published,
    publishedRelationshipIds: publishedRelationships.map((r) => r.id),
    withheldRelationshipIds: withheldRelationships.map((r) => r.id),
    publishedRelationships,
    withheldRelationships
  };
}
