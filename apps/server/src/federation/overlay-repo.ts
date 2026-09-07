import { and, eq, inArray, isNull } from "drizzle-orm";
import type { GraphObject, Relationship } from "@scp/schemas";
import type { TenantTx } from "../db/tenant-tx.js";
import { badRequest, forbidden } from "../errors.js";
import { hasPermission } from "../authz/resolve.js";
import { createObject, getObjectByIdOrUrnAnyType, toGraphObject } from "../graph/objects-repo.js";
import { createRelationship, listRelationships } from "../graph/relationships-repo.js";
import { objects } from "../db/schema.js";
import {
  isGovernanceManagedObjectType,
  isProjectionBoundObjectType,
  projectionBoundRefusalDetail
} from "../governance/governance-managed-types.js";
import { isServiceMemberObjectType } from "../graph/service-member-types.js";
import { isPeerBoundObjectType } from "./outpost-binding.js";
import { isPairBoundObjectType } from "../graph/pair-bound-types.js";

/** Shared-authority overlays: two domains never both write. See docs/federation.md §342. */

const ENFORCEMENT_RANK: Record<string, number> = { advisory: 0, recommended: 1, required: 2 };

/** A best-effort may-only-add-strictness validator. See docs/federation.md §343. */
function assertPolicyOverlayOnlyAddsStrictness(
  base: Record<string, unknown>,
  overlay: Record<string, unknown>
): void {
  const baseEnforcement = typeof base.enforcement === "string" ? base.enforcement : "advisory";
  const overlayEnforcement =
    typeof overlay.enforcement === "string" ? overlay.enforcement : undefined;
  if (overlayEnforcement !== undefined) {
    const baseRank = ENFORCEMENT_RANK[baseEnforcement] ?? 0;
    const overlayRank = ENFORCEMENT_RANK[overlayEnforcement] ?? 0;
    if (overlayRank < baseRank) {
      throw badRequest(
        `policy overlay may only ADD strictness: base enforcement is '${baseEnforcement}', overlay tried to set '${overlayEnforcement}'`
      );
    }
  }
}

export interface CreateOverlayInput {
  orgId: string;
  actorObjectId: string;
  requestId: string;
  baseIdOrUrn: string;
  overlayTypeId: string;
  overlayName: string;
  overlayUrn?: string;
  overlayProperties?: Record<string, unknown>;
  overlayLabels?: Record<string, unknown>;
}

export interface OverlayResult {
  overlay: GraphObject;
  base: GraphObject;
  annotates: Relationship;
}

/** Creates a locally-owned overlay and links it to the base. See docs/federation.md §344. */
export async function createOverlay(
  tx: TenantTx,
  input: CreateOverlayInput
): Promise<OverlayResult> {
  const base = await getObjectByIdOrUrnAnyType(tx, input.orgId, input.baseIdOrUrn);

  // Overlay is a user-facing create surface. See docs/federation.md §345.
  if (isServiceMemberObjectType(input.overlayTypeId)) {
    throw forbidden(
      `object type '${input.overlayTypeId}' must belong to a service and cannot be created via an ` +
        `overlay — use the strict typed route (/api/v1/${input.overlayTypeId}s), which requires a ` +
        `service and writes the containment edge atomically`
    );
  }

  // M16.2 phase A (E1), same reasoning one type further: an `outpost` object is commander-authored
  // federation config gated on `federation:write`, while this route checks `object:write`. The peer
  // BINDING would still be enforced (the choke point lives in `graph/objects-repo.ts`), but the
  // PERMISSION would be the weaker one — the exact mismatch the governance block above exists for.
  if (isPeerBoundObjectType(input.overlayTypeId)) {
    throw forbidden(
      `object type '${input.overlayTypeId}' is commander-authored federation config and cannot be ` +
        `created via an overlay — use /api/v1/federation/outposts, which enforces 'federation:write'`
    );
  }

  // ADR-0026 D2/D3, same reasoning one type further. See docs/federation.md §346.
  if (isPairBoundObjectType(input.overlayTypeId)) {
    throw forbidden(
      `object type '${input.overlayTypeId}' is identified by a pair of objects and cannot be created ` +
        `via an overlay — use /api/v1/${input.overlayTypeId}s, which requires both endpoints and ` +
        `writes the derived edges atomically`
    );
  }

  // The fifth sibling, and it had to be a refusal. See docs/federation.md §347.
  if (isProjectionBoundObjectType(input.overlayTypeId)) {
    throw forbidden(projectionBoundRefusalDetail(input.overlayTypeId, "an overlay"));
  }

  // The fourth sibling, which the other censuses never sought. See docs/federation.md §348.
  if (isGovernanceManagedObjectType(input.overlayTypeId)) {
    const ok = await hasPermission(tx, {
      orgId: input.orgId,
      subjectObjectId: input.actorObjectId,
      permission: "policy:write",
      // The org root object's id IS the org id (auth/local-auth.ts `ensureOrgRootObject`).
      scopeObjectId: input.orgId
    });
    if (!ok) {
      throw forbidden(
        `object type '${input.overlayTypeId}' is governance-managed: creating one as an overlay ` +
          `requires 'policy:write' at the organization root (an overlay is always created at ` +
          `org-root containment), which is the same bar /api/v1/policies and /api/v1/controls apply`
      );
    }
  }

  if (base.typeId === "policy" && input.overlayTypeId === "policy") {
    assertPolicyOverlayOnlyAddsStrictness(base.properties, input.overlayProperties ?? {});
  }

  const overlay = await createObject(tx, {
    orgId: input.orgId,
    typeId: input.overlayTypeId,
    actorObjectId: input.actorObjectId,
    requestId: input.requestId,
    urn: input.overlayUrn,
    name: input.overlayName,
    properties: input.overlayProperties,
    labels: input.overlayLabels
  });

  const annotates = await createRelationship(tx, {
    orgId: input.orgId,
    actorObjectId: input.actorObjectId,
    requestId: input.requestId,
    typeId: "annotates",
    fromId: overlay.id,
    toId: base.id
  });

  return { overlay, base, annotates };
}

export interface MergedOverlayView {
  base: GraphObject;
  overlays: GraphObject[];
  /** Shallow merge: base, then each overlay in creation order. See docs/federation.md §349. */
  merged: Record<string, unknown>;
}

/** Read-time merge (DESIGN §13: "readers merge base + local overlay at read time"). Never
 *  mutates `base` — returns a computed view only. */
export async function getMergedOverlayView(
  tx: TenantTx,
  orgId: string,
  baseIdOrUrn: string
): Promise<MergedOverlayView> {
  const base = await getObjectByIdOrUrnAnyType(tx, orgId, baseIdOrUrn);
  const edges = await listRelationships(tx, orgId, {
    toId: base.id,
    typeId: "annotates",
    limit: 100
  });
  // One batched read for every overlay object instead of one `getObjectByIdOrUrnAnyType` per edge.
  // `edge.fromId` is always an object id (never a URN — edges never store one), so a plain
  // `inArray` id lookup is equivalent to the per-edge id-or-urn lookup it replaces.
  const overlayIds = edges.items.map((edge) => edge.fromId);
  const overlayRows =
    overlayIds.length === 0
      ? []
      : await tx
          .select()
          .from(objects)
          .where(
            and(
              eq(objects.orgId, orgId),
              inArray(objects.id, overlayIds),
              isNull(objects.deletedAt)
            )
          );
  const overlayById = new Map(overlayRows.map((row) => [row.id, toGraphObject(row)]));
  // Rebuilt in EDGE (creation) order, not query order — `inArray` makes no ordering guarantee, and
  // the merge below is order-sensitive. An overlay missing from the map (deleted after the edge was
  // created) is tolerated exactly as the per-edge try/catch it replaces did: skipped, not failed.
  const overlays: GraphObject[] = [];
  for (const edge of edges.items) {
    const overlay = overlayById.get(edge.fromId);
    if (overlay) overlays.push(overlay);
  }

  let merged: Record<string, unknown> = { ...base.properties };
  let strictestEnforcement =
    typeof base.properties.enforcement === "string" ? base.properties.enforcement : undefined;
  for (const overlay of overlays) {
    merged = { ...merged, ...overlay.properties };
    const overlayEnforcement =
      typeof overlay.properties.enforcement === "string"
        ? overlay.properties.enforcement
        : undefined;
    if (overlayEnforcement !== undefined) {
      const currentRank = ENFORCEMENT_RANK[strictestEnforcement ?? "advisory"] ?? 0;
      const overlayRank = ENFORCEMENT_RANK[overlayEnforcement] ?? 0;
      if (overlayRank > currentRank) strictestEnforcement = overlayEnforcement;
    }
  }
  if (strictestEnforcement !== undefined) merged.enforcement = strictestEnforcement;

  return { base, overlays, merged };
}
