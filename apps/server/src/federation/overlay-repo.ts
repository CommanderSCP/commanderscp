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

  // M12 P5 follow-up (owner ruling 2026-07-16): overlay is a user-facing CREATE surface (free-form
  // `overlayTypeId`), NOT an import path — so it must not become a side door for minting an orphan
  // `component` that bypasses create-strict. Refuse service-member types here, exactly as the generic
  // `/objects/component` route does (shared `graph/service-member-types.ts`). A component is created
  // only via the strict `POST /components`; overlay it afterward if genuinely needed.
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

  // ADR-0026 D2/D3, same reasoning one type further: a `placement` is identified by a PAIR of
  // objects, and overlay takes free-form `overlayProperties` — so this door could mint a placement
  // with unresolved, untyped endpoint UUIDs and, decisively, with none of the derived edges that
  // make the pair traversable. Refuse it here exactly as `/objects/placement` does (shared
  // `graph/pair-bound-types.ts`); declare the placement via `/api/v1/placements` and overlay it
  // afterward if genuinely needed.
  if (isPairBoundObjectType(input.overlayTypeId)) {
    throw forbidden(
      `object type '${input.overlayTypeId}' is identified by a pair of objects and cannot be created ` +
        `via an overlay — use /api/v1/${input.overlayTypeId}s, which requires both endpoints and ` +
        `writes the derived edges atomically`
    );
  }

  // M25.7 — THE FIFTH SIBLING, AND IT HAD TO BE A REFUSAL RATHER THAN THE PERMISSION CHECK BELOW.
  //
  // A `freeze` object is the wire half of a record whose other half is a `freezes` row, and this
  // door cannot write that row. The governance-managed check further down would have admitted one
  // to any holder of org-root `policy:write` — an actor who may hold `freeze:write` and
  // `federation:write` NOWHERE — and the overlay it produced would have federated to every peer at
  // a carrying scope, rebuilt itself into their enforcement tables, and been liftable at neither
  // end (this instance has no `freezes` row for `DELETE /v1/freezes/{id}` to find; the peers refuse
  // because the origin domain is foreign).
  //
  // WHY THIS IS NOT THE `policy` ARGUMENT ONE TYPE OVER. That argument is DESIGN §13's canonical
  // overlay case — locally annotating a commander-distributed global policy, which
  // `assertPolicyOverlayOnlyAddsStrictness` exists to validate. A freeze has no strictness lattice
  // to add to and no annotation semantics at all; its content is a window, a scope and a reason. So
  // refusing the type here deletes no feature and leaves no validator dead, which is the test the
  // three refusals above applied.
  if (isProjectionBoundObjectType(input.overlayTypeId)) {
    throw forbidden(projectionBoundRefusalDetail(input.overlayTypeId, "an overlay"));
  }

  // M21.7 — THE FOURTH SIBLING, AND THE ONE THE OTHER THREE CENSUSES NEVER LOOKED FOR.
  //
  // The three refusals above were each written by censusing a guard that `routes/objects-generic.ts`
  // installs. That file installs FIVE, and the FIRST of them —
  // `assertNotGovernanceManagedObjectType` — is the one nobody carried over. Measured on the pre-fix
  // tree: an Operator (plain `object:write` at the org root, `policy:write` nowhere) POSTed
  // `{base:<a service>, typeId:"policy", properties:{enforcement:"required", effects:[{requireApprovals:
  // {count:99, fromRole:"Owner", scope:"organization"}}]}}` and got 201. `governance/policy-resolve.ts`
  // selects EVERY live `policy` row and an unscoped one matches every target, so that is an org-wide
  // `required` policy demanding an unmeetable quorum — authored by an actor the permission split
  // (`0010_governance.sql:174-175` grants `policy:write` to Administrator and Owner only) exists to
  // keep out of governance entirely. Note `assertPolicyOverlayOnlyAddsStrictness` below could not
  // have caught it: it is gated on base AND overlay both being `policy`, and the base was a service.
  //
  // WHY A PERMISSION CHECK AND NOT A TYPE REFUSAL, unlike the three siblings. Those types have a
  // stricter typed door that writes rows this one cannot, so refusing them here loses nothing.
  // `policy` is the opposite: DESIGN §13's CANONICAL overlay case is "locally annotating a
  // commander-distributed global policy", and `assertPolicyOverlayOnlyAddsStrictness` exists for
  // precisely that shape. Refusing the type would delete the feature and leave that validator dead.
  // So this door gets the treatment `iac/plans-repo.ts`'s `writePermissionFor` already gives the same
  // free-form-`typeId` problem: the governance types clear the GOVERNANCE bar instead.
  //
  // WHY THE ORG ROOT, and why the sibling `assertPolicyScopeWithinAuthority` is NOT also called here.
  // `createObject` below passes no `domainId`, so an overlay is ALWAYS created at org-root containment
  // — which makes org-root `policy:write` exactly the bar `routes/typed-registries.ts` applies to the
  // same document (`authorize(policy:write, <resolved containment>)`), not a stricter invention. And an
  // actor who clears it clears every branch of `assertPolicyScopeWithinAuthority` by construction: its
  // broadest branch (unscoped / selector / group) asks for org-root `policy:write`, and its narrow
  // `objectRef` branch asks for `policy:write` at-or-above that object, which an org-root grant
  // satisfies because `authz/resolve.ts`'s `scope_expand` walks UPWARD from the scope being checked.
  // So calling it too would be an AUTHORIZATION check that can never refuse — an inert guard reads as
  // coverage and is worse than none. (It has one non-authorization behaviour, a 400 when
  // `scope.objectRef` resolves to nothing; that is validation, not a bound on reach, and a dangling
  // ref matches no target — `governance/policy-resolve.ts` compares it against the TARGET's
  // containment chain — so it fails safe.) If overlays ever gain a containment domain, the
  // authorization argument stops holding and the scope check has to come back with it.
  //
  // WHY IT SITS HERE AND NOT IN THE ROUTE HANDLER, given `routes/typed-registries.ts:122-133` states
  // the opposite rule ("authorization at the door, invariant at the repo"). Read that rule's REASON,
  // not its shape: it warns against pushing authorization down onto a function ALSO reached by the
  // federation importer, whose `actorObjectId` is the synthetic `FEDERATION_IMPORT_ACTOR_ID` — a
  // subject with no bindings, so the check would refuse every arriving bundle. `createOverlay` is on
  // no such path: `POST /api/v1/federation/overlays` is its only non-test caller (censused filterless
  // — `grep -rn createOverlay apps packages`), and journal replay goes to `federation/import-repo.ts`,
  // never here. The hazard the rule names therefore cannot arise, and the three sibling guards
  // directly above — plus `iac/plans-repo.ts`, which runs this SAME `policy:write` check
  // (`writePermissionFor`) inside the repo — put it at the altitude that covers every caller of the
  // function rather than only today's one door. Two `federation.integration.test.ts` cases that passed
  // the org-root OBJECT as their actor went red on this and were given real `policy:write` authors:
  // that is the check being audible, which is the direction an authorization check may fail in.
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
