import { and, eq, isNull, or } from "drizzle-orm";
import type { GraphObject } from "@scp/schemas";
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

  const [row] = await tx
    .update(objects)
    // THE ONE UPDATE IN THE CODEBASE THAT NAMES THIS COLUMN. `version` is bumped because a publish is
    // a real, observable state change to the row; `revision` is NOT, because that is the federation
    // author-assigned counter the peer orders replicas by, and this object's first entry at any peer
    // must not claim to be a later revision of something they never received.
    .set({ domainLocal: false, version: existing.version + 1, updatedAt: new Date() })
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

  const publishedRelationshipIds: string[] = [];
  const withheldRelationshipIds: string[] = [];
  for (const edge of edges) {
    // Only edges THIS domain authored may be journaled by it (single-writer authority) — an edge
    // replicated from a peer is already on that peer's own chain.
    if (edge.originDomainId !== self.domainId) continue;

    const otherId = edge.fromId === row.id ? edge.toId : edge.fromId;
    const other = await tx
      .select({ domainLocal: objects.domainLocal })
      .from(objects)
      .where(and(eq(objects.orgId, input.orgId), eq(objects.id, otherId)))
      .limit(1);
    // A missing endpoint is treated as still-withheld rather than published: it cannot be shown to
    // be shared, and this is the fail-closed direction.
    if (!other[0] || other[0].domainLocal) {
      withheldRelationshipIds.push(edge.id);
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
    publishedRelationshipIds.push(edge.id);
  }

  return { object: published, publishedRelationshipIds, withheldRelationshipIds };
}
