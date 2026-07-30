import { and, asc, eq, isNull, sql } from "drizzle-orm";
import {
  asTrustDomainId,
  type GraphObject,
  type OutpostConfig,
  type OutpostTrustTier
} from "@scp/schemas";
import type { TenantTx } from "../db/tenant-tx.js";
import { objects } from "../db/schema.js";
import { notFound } from "../errors.js";
import {
  createObject,
  getObjectByIdOrUrn,
  toGraphObject,
  updateObject
} from "../graph/objects-repo.js";
import { deriveUrn } from "../graph/urn.js";
import { findPeerByDomainId } from "./peers-repo.js";

/**
 * M16.2 phase A (E1) — the commander-side write/read surface for `outpost` GRAPH OBJECTS: the
 * commander-authored, owner-ENTERED config about one enrolled outpost, which syncs down to that
 * outpost as a read-only replica because it is an ordinary graph object.
 *
 * READ `federation/outpost-binding.ts` FIRST — it states the authority split between this object and
 * the `federation_peers` row, and it holds the enforcement of the 1:1 peer binding (applied inside
 * `graph/objects-repo.ts`, so EVERY local write door gets it, not just this module).
 *
 * This module deliberately owns no invariant of its own beyond URN derivation: it composes
 * `createObject`/`updateObject` so the object is journaled, audited, content-hashed and
 * single-writer-guarded by exactly the same machinery as every other graph object (charter principle
 * 2 — no parallel mechanism).
 */

export const OUTPOST_OBJECT_TYPE_ID = "outpost";

/** The object's URN is derived from the PEER DOMAIN ID, never from its display name — so the
 *  `(org_id, urn)` unique index is a second, database-level guarantee of the 1:1 binding, and
 *  renaming the object can never fork it. `deriveUrn`'s slugify leaves a UUID intact. */
export function outpostConfigUrn(orgId: string, peerDomainId: string): string {
  return deriveUrn(orgId, OUTPOST_OBJECT_TYPE_ID, peerDomainId);
}

function readTrustTier(properties: Record<string, unknown>): OutpostTrustTier | null {
  const value = properties.trustTier;
  // NEVER DEFAULTED. `trustTier` has no source anywhere but this property, so an absent value stays
  // absent all the way to the wire (`null`) and is declared in `unknownFields` — a blank or a
  // fabricated `commercial` would be an assertion no operator ever made.
  return value === "commercial" || value === "fedramp-high" || value === "il5" ? value : null;
}

/** Projects the underlying graph object into the API's read view, carrying the honest-unknown
 *  declaration (`unknownFields`) the rest of this codebase already uses. */
export function toOutpostConfig(object: GraphObject): OutpostConfig {
  const properties = object.properties;
  const trustTier = readTrustTier(properties);
  const peerDomainId = typeof properties.peerDomainId === "string" ? properties.peerDomainId : "";
  return {
    objectId: object.id,
    urn: object.urn,
    name: object.name,
    peerDomainId,
    trustTier,
    originDomainId: object.originDomainId,
    revision: object.revision,
    version: object.version,
    unknownFields: trustTier === null ? ["trustTier"] : [],
    createdAt: object.createdAt,
    updatedAt: object.updatedAt
  };
}

export interface CreateOutpostConfigInput {
  orgId: string;
  actorObjectId: string;
  requestId: string;
  peerDomainId: string;
  name?: string;
  trustTier?: OutpostTrustTier;
}

/**
 * Declares the config object for an already-paired outpost peer. The peer-binding guard
 * (`assertOutpostPeerBinding`, reached through `createObject`) refuses an unbound `peerDomainId`
 * (400), a peer whose role is not `outpost` (400), and a second object for the same peer (409).
 *
 * The peer lookup here is NON-throwing (`findPeerByDomainId`) and is used ONLY to default the display
 * name. Validating the binding is the guard's job at the choke point — so an unpaired peer produces
 * the guard's own precise 400 ("not a paired federation peer") rather than a 404 from a name lookup,
 * and a caller that bypasses this module gets the identical refusal.
 */
export async function createOutpostConfig(
  tx: TenantTx,
  input: CreateOutpostConfigInput
): Promise<OutpostConfig> {
  const peer = await findPeerByDomainId(tx, input.orgId, asTrustDomainId(input.peerDomainId));
  const object = await createObject(tx, {
    orgId: input.orgId,
    typeId: OUTPOST_OBJECT_TYPE_ID,
    actorObjectId: input.actorObjectId,
    requestId: input.requestId,
    urn: outpostConfigUrn(input.orgId, input.peerDomainId),
    // Falls back to the raw id when the peer does not exist — a name the guard is about to make
    // irrelevant by refusing the write. `createObject` requires a name, so this keeps the ORDER of
    // refusals in the guard's hands instead of the name default's.
    name: input.name ?? peer?.name ?? input.peerDomainId,
    properties: {
      peerDomainId: input.peerDomainId,
      // Written ONLY when the operator supplied one — an omitted tier leaves the key absent, which
      // is what makes "no tier asserted" distinguishable from "tier asserted as commercial".
      ...(input.trustTier !== undefined ? { trustTier: input.trustTier } : {})
    }
  });
  return toOutpostConfig(object);
}

/** Every `outpost` config object in this org, oldest first. Includes the read-only REPLICA an outpost
 *  holds of its own config (that instance's `originDomainId` names the commander) — the projection
 *  makes the difference legible rather than hiding it. */
export async function listOutpostConfigs(tx: TenantTx, orgId: string): Promise<OutpostConfig[]> {
  const rows = await tx
    .select()
    .from(objects)
    .where(
      and(
        eq(objects.orgId, orgId),
        eq(objects.typeId, OUTPOST_OBJECT_TYPE_ID),
        isNull(objects.deletedAt)
      )
    )
    .orderBy(asc(objects.createdAt));
  return rows.map((row) => toOutpostConfig(toGraphObject(row)));
}

/** The config object bound to `peerDomainId`, or `null` when the peer has none. Resolved through the
 *  BINDING (the JSONB property), not through the URN, so it still resolves for a replica whose URN
 *  was derived in the commander's org. */
export async function findOutpostConfigByPeer(
  tx: TenantTx,
  orgId: string,
  peerDomainId: string
): Promise<OutpostConfig | null> {
  const rows = await tx
    .select()
    .from(objects)
    .where(
      and(
        eq(objects.orgId, orgId),
        eq(objects.typeId, OUTPOST_OBJECT_TYPE_ID),
        isNull(objects.deletedAt),
        sql`${objects.properties} ->> 'peerDomainId' = ${peerDomainId}`
      )
    )
    .limit(1);
  const row = rows[0];
  return row ? toOutpostConfig(toGraphObject(row)) : null;
}

export async function getOutpostConfigByPeer(
  tx: TenantTx,
  orgId: string,
  peerDomainId: string
): Promise<OutpostConfig> {
  const found = await findOutpostConfigByPeer(tx, orgId, peerDomainId);
  if (!found) {
    throw notFound(
      `peer '${peerDomainId}' has no outpost config object — declare one with POST /v1/federation/outposts`
    );
  }
  return found;
}

export interface UpdateOutpostConfigInput {
  orgId: string;
  actorObjectId: string;
  requestId: string;
  peerDomainId: string;
  name?: string;
  trustTier?: OutpostTrustTier;
  expectedVersion?: number;
}

/**
 * Edits the commander-origin config. ABSENT MEANS PRESERVE for every field — an omitted `trustTier`
 * never clears an asserted one, and (phase A) there is no clear-to-unknown verb at all: un-asserting
 * a tier is a distinct, deliberate operation, and inventing it as a side effect of an omitted field
 * is exactly how a UI silently erases an operator's assertion.
 *
 * ON AN OUTPOST THIS CALL FAILS, and that is the point: the object there is a read-only replica, so
 * `updateObject`'s existing single-writer guard raises 409 before any of this module's logic runs
 * (proved by `outpost-config-sync.integration.test.ts`). No second mechanism was added for it.
 */
export async function updateOutpostConfig(
  tx: TenantTx,
  input: UpdateOutpostConfigInput
): Promise<OutpostConfig> {
  const current = await getOutpostConfigByPeer(tx, input.orgId, input.peerDomainId);
  const existing = await getObjectByIdOrUrn(
    tx,
    input.orgId,
    OUTPOST_OBJECT_TYPE_ID,
    current.objectId
  );
  const nextProperties: Record<string, unknown> = {
    ...existing.properties,
    // The binding is re-asserted verbatim, never taken from the request: `peerDomainId` is the
    // object's identity and is not patchable.
    peerDomainId: current.peerDomainId,
    ...(input.trustTier !== undefined ? { trustTier: input.trustTier } : {})
  };
  const updated = await updateObject(tx, {
    orgId: input.orgId,
    typeId: OUTPOST_OBJECT_TYPE_ID,
    actorObjectId: input.actorObjectId,
    requestId: input.requestId,
    idOrUrn: current.objectId,
    ...(input.name !== undefined ? { name: input.name } : {}),
    properties: nextProperties,
    ...(input.expectedVersion !== undefined ? { expectedVersion: input.expectedVersion } : {})
  });
  return toOutpostConfig(updated);
}
