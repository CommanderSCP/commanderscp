import { and, asc, eq, sql } from "drizzle-orm";
import type { CampaignStatus, Initiative, InitiativeMemberCampaign } from "@scp/schemas";
import type { TenantTx } from "../db/tenant-tx.js";
import { objects, relationships } from "../db/schema.js";
import { badRequest, notFound } from "../errors.js";
import { decodeCursor, encodeCursor } from "../pagination.js";
import { createObject, getObjectByIdOrUrnAnyType } from "../graph/objects-repo.js";
import { createRelationship } from "../graph/relationships-repo.js";
import { authorize } from "../authz/resolve.js";
import { insertDecision } from "./decisions-repo.js";
import { getCampaignStatus, toCampaignShape, type ObjectRow } from "./campaign-repo.js";
import { computeInitiativeRollup } from "./campaign-status.js";

/** Mirrors `campaign-repo.ts`'s `ObjectLike` — satisfies both a raw `ObjectRow` and
 *  `createObject`'s `GraphObject` return shape (ISO-string dates, no `contentHash`). */
type ObjectLike = Pick<ObjectRow, "id" | "orgId" | "urn" | "name"> & {
  properties: unknown;
  createdAt: Date | string;
  updatedAt: Date | string;
};

function isoOf(value: Date | string): string {
  return typeof value === "string" ? value : value.toISOString();
}

function toInitiativeShape(object: ObjectLike): Initiative {
  const properties = object.properties as Record<string, unknown>;
  return {
    id: object.id,
    orgId: object.orgId,
    urn: object.urn,
    name: object.name,
    description: typeof properties.description === "string" ? properties.description : null,
    createdAt: isoOf(object.createdAt),
    updatedAt: isoOf(object.updatedAt)
  };
}

/**
 * `coordinates` relationships from an initiative to each of its member campaigns — the traversal
 * DESIGN §9.5 calls for ("roll-up status DERIVED BY TRAVERSAL... a named graph query over the
 * existing engine, per §5"). Direct one-hop only (an initiative groups campaigns, not sub-
 * campaigns transitively — DESIGN's own framing: "Initiative... grouping campaigns"), org-scoped
 * by construction (every query here runs inside the caller's `withTenantTx`, same RLS/org_id
 * filtering as every other read in the system — closes the "roll-up must be org-scoped" surface).
 */
export async function campaignsCoordinatedByInitiative(
  tx: TenantTx,
  orgId: string,
  initiativeObjectId: string
): Promise<ObjectRow[]> {
  const rows = await tx
    .select({ campaign: objects })
    .from(relationships)
    .innerJoin(objects, eq(relationships.toId, objects.id))
    .where(
      and(
        eq(relationships.orgId, orgId),
        eq(relationships.typeId, "coordinates"),
        eq(relationships.fromId, initiativeObjectId),
        eq(objects.typeId, "campaign"),
        sql`${objects.deletedAt} IS NULL`
      )
    )
    .orderBy(asc(objects.createdAt));
  return rows.map((r) => r.campaign);
}

/** The full roll-up: every member campaign plus its own derived status, and the aggregate
 *  `rollupStatus` (`campaign-status.ts`'s pure `computeInitiativeRollup`). Shared by `GET
 *  /initiatives/{id}` and `graph/named-queries.ts`'s `initiative-rollup`. */
export async function computeInitiativeRollupFor(
  tx: TenantTx,
  orgId: string,
  initiativeObjectId: string
): Promise<{ campaigns: InitiativeMemberCampaign[]; rollupStatus: CampaignStatus }> {
  const campaignObjects = await campaignsCoordinatedByInitiative(tx, orgId, initiativeObjectId);
  const campaigns: InitiativeMemberCampaign[] = [];
  for (const object of campaignObjects) {
    const status = await getCampaignStatus(tx, orgId, object.id);
    campaigns.push({ campaign: toCampaignShape(object, status), status });
  }
  const rollupStatus = computeInitiativeRollup(campaigns.map((c) => c.status));
  return { campaigns, rollupStatus };
}

export interface ProposeInitiativeInput {
  orgId: string;
  actorObjectId: string;
  requestId: string;
  id?: string;
  urn?: string;
  domainId?: string | null;
  name: string;
  description?: string;
  labels?: Record<string, unknown>;
  /** Object ids or URNs of campaigns this initiative groups — each becomes a `coordinates`
   *  relationship (initiative -> campaign), created atomically with the initiative itself. */
  campaigns: string[];
}

/**
 * Creates an Initiative: a graph object (type `initiative`, pre-seeded built-in — 0002 §5) plus
 * one `coordinates` relationship per named campaign.
 *
 * SECURITY-SENSITIVE (M5 adversarial-review surface — both-endpoint relationship authz for
 * `coordinates`): mirrors `routes/relationships.ts`'s own both-endpoint check exactly
 * (`relationship:write` at BOTH the initiative and each campaign's scope) rather than relying on
 * `createRelationship` alone (which validates endpoint TYPES/cardinality, never authority) — an
 * actor who can create an initiative must ALSO be authorized against every campaign they attempt
 * to group into it, closing the same class of bypass `graph/relationship-authz.integration.test.ts`
 * already probes for plain `POST /relationships` calls.
 */
export async function proposeInitiative(
  tx: TenantTx,
  input: ProposeInitiativeInput
): Promise<Initiative> {
  const object = await createObject(tx, {
    orgId: input.orgId,
    typeId: "initiative",
    actorObjectId: input.actorObjectId,
    requestId: input.requestId,
    id: input.id,
    urn: input.urn,
    name: input.name,
    domainId: input.domainId,
    properties: { description: input.description ?? null },
    labels: input.labels
  });

  await authorize(tx, {
    orgId: input.orgId,
    subjectObjectId: input.actorObjectId,
    permission: "relationship:write",
    scopeObjectId: object.id
  });

  for (const idOrUrn of input.campaigns) {
    const campaign = await getObjectByIdOrUrnAnyType(tx, input.orgId, idOrUrn);
    if (campaign.typeId !== "campaign") {
      throw badRequest(`'${idOrUrn}' is not a campaign`);
    }
    await authorize(tx, {
      orgId: input.orgId,
      subjectObjectId: input.actorObjectId,
      permission: "relationship:write",
      scopeObjectId: campaign.id
    });
    await createRelationship(tx, {
      orgId: input.orgId,
      actorObjectId: input.actorObjectId,
      requestId: input.requestId,
      typeId: "coordinates",
      fromId: object.id,
      toId: campaign.id
    });
  }

  await insertDecision(tx, {
    orgId: input.orgId,
    kind: "transition",
    subjectId: object.id,
    verdict: "allow",
    inputContext: { trigger: "propose", actorId: input.actorObjectId, campaigns: input.campaigns },
    reasonTree: { summary: `initiative proposed grouping ${input.campaigns.length} campaign(s)` }
  });

  return toInitiativeShape(object);
}

/** `POST /initiatives/{id}/campaigns` — adds one more member campaign after creation. Same
 *  both-endpoint authz as `proposeInitiative`'s loop. */
export async function addCampaignToInitiative(
  tx: TenantTx,
  input: { orgId: string; actorObjectId: string; requestId: string; initiativeObjectId: string; campaignIdOrUrn: string }
): Promise<void> {
  const initiative = await getObjectByIdOrUrnAnyType(tx, input.orgId, input.initiativeObjectId);
  if (initiative.typeId !== "initiative") throw badRequest(`'${input.initiativeObjectId}' is not an initiative`);
  const campaign = await getObjectByIdOrUrnAnyType(tx, input.orgId, input.campaignIdOrUrn);
  if (campaign.typeId !== "campaign") throw badRequest(`'${input.campaignIdOrUrn}' is not a campaign`);

  await authorize(tx, {
    orgId: input.orgId,
    subjectObjectId: input.actorObjectId,
    permission: "relationship:write",
    scopeObjectId: initiative.id
  });
  await authorize(tx, {
    orgId: input.orgId,
    subjectObjectId: input.actorObjectId,
    permission: "relationship:write",
    scopeObjectId: campaign.id
  });

  await createRelationship(tx, {
    orgId: input.orgId,
    actorObjectId: input.actorObjectId,
    requestId: input.requestId,
    typeId: "coordinates",
    fromId: initiative.id,
    toId: campaign.id
  });
}

async function fetchInitiativeObject(tx: TenantTx, orgId: string, id: string): Promise<ObjectRow> {
  const row = await tx.query.objects.findFirst({
    where: (t, { eq: eqOp, and: andOp, isNull: isNullOp }) =>
      andOp(eqOp(t.orgId, orgId), eqOp(t.id, id), eqOp(t.typeId, "initiative"), isNullOp(t.deletedAt))
  });
  if (!row) throw notFound(`initiative '${id}' not found`);
  return row;
}

export async function getInitiative(tx: TenantTx, orgId: string, id: string): Promise<Initiative> {
  return toInitiativeShape(await fetchInitiativeObject(tx, orgId, id));
}

export interface ListInitiativesQuery {
  cursor?: string | undefined;
  limit: number;
}

export async function listInitiatives(
  tx: TenantTx,
  orgId: string,
  query: ListInitiativesQuery
): Promise<{ items: Initiative[]; nextCursor: string | null }> {
  const cursor = query.cursor ? decodeCursor(query.cursor) : null;
  const conditions = [eq(objects.orgId, orgId), eq(objects.typeId, "initiative"), sql`${objects.deletedAt} IS NULL`];
  if (cursor) {
    conditions.push(
      sql`(${objects.createdAt}, ${objects.id}) > (${cursor.createdAt.toISOString()}::timestamptz, ${cursor.id}::uuid)`
    );
  }

  const rows = await tx
    .select()
    .from(objects)
    .where(and(...conditions))
    .orderBy(asc(objects.createdAt), asc(objects.id))
    .limit(query.limit + 1);

  const hasMore = rows.length > query.limit;
  const page = hasMore ? rows.slice(0, query.limit) : rows;
  const last = page[page.length - 1];
  return {
    items: page.map(toInitiativeShape),
    nextCursor: hasMore && last ? encodeCursor({ createdAt: last.createdAt, id: last.id }) : null
  };
}
