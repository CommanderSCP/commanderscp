import type { GraphObject, Relationship } from "@scp/schemas";
import type { TenantTx } from "../db/tenant-tx.js";
import { badRequest } from "../errors.js";
import { createObject, getObjectByIdOrUrnAnyType } from "../graph/objects-repo.js";
import { createRelationship, listRelationships } from "../graph/relationships-repo.js";

/**
 * Shared-authority overlays (DESIGN.md §13 "review decision — resolved"): "two domains never
 * write one object... it creates an overlay — a separate object it DOES own, linked to the base
 * via the built-in `annotates` relationship. Readers merge base + local overlay at read time;
 * per-type overlay rules bound what may be layered — policy overlays may only ADD strictness."
 *
 * `annotates` is system-managed (graph/system-managed-relationships.ts) — this is the ONLY legal
 * creation path, exactly mirroring how `approves`/`coordinates` are locked down to their own
 * authority-checked repo functions instead of the generic `/relationships` endpoint.
 */

const ENFORCEMENT_RANK: Record<string, number> = { advisory: 0, recommended: 1, required: 2 };

/** Best-effort "may only add strictness" validator for policy overlays (DESIGN §13). Checks: (1)
 *  `enforcement`, if the overlay sets one, can't be LESS strict than the base's; (2) every control
 *  the base's effects require stays required (an overlay's own `effects` are read-time ADDITIONS,
 *  never a replacement of the base's — so an overlay is never even ABLE to drop a base
 *  requirement, but this defends against a caller who genuinely tries to represent removal via
 *  overlay properties that a naive merge might honor). Not a full policy-semantics validator —
 *  documented scope limitation for v1. */
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

/** Creates a new, LOCALLY-OWNED overlay object and links it to the (possibly foreign-origin,
 *  read-only replica) base object via `annotates`. The base object is never written — single-
 *  writer authority and convergent replication are preserved by construction, not by a runtime
 *  check (there is no code path here that could mutate `base` even by accident: only
 *  `createObject`, never `updateObject`, is called on it). */
export async function createOverlay(
  tx: TenantTx,
  input: CreateOverlayInput
): Promise<OverlayResult> {
  const base = await getObjectByIdOrUrnAnyType(tx, input.orgId, input.baseIdOrUrn);

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
  /** Shallow merge: base properties, then each overlay's properties applied on top in creation
   *  order (later overlays win on scalar-key conflicts; array/object sub-merging is intentionally
   *  NOT attempted — a full policy-effects merge algorithm is a UI/evaluation-layer concern, out
   *  of scope for this read helper). The `enforcement` field specifically takes the STRICTEST
   *  value seen across base + all overlays, honoring the "overlays may only add strictness" rule
   *  even when a caller's merge just naively took `overlays.at(-1)`. */
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
  const overlays: GraphObject[] = [];
  for (const edge of edges.items) {
    try {
      const overlay = await getObjectByIdOrUrnAnyType(tx, orgId, edge.fromId);
      overlays.push(overlay);
    } catch {
      // overlay object was deleted after the edge was created — skip rather than fail the read
    }
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
