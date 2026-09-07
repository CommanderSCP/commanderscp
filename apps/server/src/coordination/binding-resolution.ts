import { and, eq, isNull, sql } from "drizzle-orm";
import type { TenantTx } from "../db/tenant-tx.js";
import { objects } from "../db/schema.js";
import { getOrgRootObjectId } from "../graph/objects-repo.js";
import {
  DEFAULT_BINDING_TYPE,
  getExecutorBinding,
  listExecutorBindingsForTarget,
  type BindingType,
  type ExecutorBindingRow
} from "./executor-bindings-repo.js";

/** PLACEMENT-AWARE executor-binding resolution. See docs/coordination.md §32. */

export type BindingResolution =
  | { outcome: "direct"; binding: ExecutorBindingRow; viaPlacementObjectId: null }
  | { outcome: "via_placement"; binding: ExecutorBindingRow; viaPlacementObjectId: string }
  | {
      outcome: "ambiguous";
      binding: null;
      viaPlacementObjectId: null;
      /** Every competing placement, so the refusal can NAME them. */
      candidates: { placementObjectId: string; bindingId: string }[];
    }
  /** ADR-0027, generalised by ADR-0029 — a containment ANCESTOR carries the binding. Infrastructure
   *  that serves a whole service, assembly or org (a cluster, a shared database) is declared once at
   *  the level it serves rather than duplicated onto every component or placement under it.
   *
   *  The name is retained from ADR-0027 for wire/Decision continuity; `viaServiceObjectId` is now
   *  "the ancestor it resolved through", which may be an assembly or the org root. `hops` is how far
   *  up it was found (1 = the immediate parent, 0 = the org rung), so a Decision can say how remote
   *  the inheritance is — the further away, the more surprising it is to whoever hits it. */
  | {
      outcome: "via_service";
      binding: ExecutorBindingRow;
      viaPlacementObjectId: null;
      viaServiceObjectId: string;
      /** The `object_types.id` the ancestor ACTUALLY carries. See docs/coordination.md §33. */
      viaObjectTypeId: string;
      hops: number;
    }
  | { outcome: "none"; binding: null; viaPlacementObjectId: null };

/** The provenance of an indirect resolution, or null. See docs/coordination.md §34. */
export function resolutionProvenance(
  resolution: BindingResolution
): { via: string; viaObjectId: string; hops: number | null } | null {
  if (resolution.outcome === "via_placement") {
    return { via: "placement", viaObjectId: resolution.viaPlacementObjectId, hops: null };
  }
  if (resolution.outcome === "via_service") {
    return {
      via: resolution.viaObjectTypeId,
      viaObjectId: resolution.viaServiceObjectId,
      hops: resolution.hops
    };
  }
  return null;
}

/**
 * The live placements of one component, read from `properties` — the source of truth for the pair
 * (ADR-0026 D17) and the half migration 0051's unique index covers.
 */
async function placementsOfComponent(
  tx: TenantTx,
  orgId: string,
  componentObjectId: string
): Promise<string[]> {
  const rows = await tx
    .select({ id: objects.id })
    .from(objects)
    .where(
      and(
        eq(objects.orgId, orgId),
        eq(objects.typeId, "placement"),
        isNull(objects.deletedAt),
        sql`${objects.properties} ->> 'componentId' = ${componentObjectId}`
      )
    );
  return rows.map((r) => r.id);
}

/** The owning SERVICE of a wave target. See docs/coordination.md §35. */
/** ADR-0029 D3 — `intermediate-grouping.md` D2's cap, in hops of `contains`. Bounded so the walk's
 *  cost is provable and a mis-declared containment cycle cannot spin. */
const MAX_ANCESTOR_HOPS = 3;

/** The component a wave target is about, whichever shape. See docs/coordination.md §36. */
async function componentOfTarget(
  tx: TenantTx,
  orgId: string,
  targetObjectId: string
): Promise<string | null> {
  const target = await tx.query.objects.findFirst({
    where: (t, { eq: eqOp, and: andOp, isNull: isNullOp }) =>
      andOp(eqOp(t.id, targetObjectId), eqOp(t.orgId, orgId), isNullOp(t.deletedAt))
  });
  if (!target) return null;
  if (target.typeId !== "placement") return targetObjectId;
  const props = (target.properties ?? {}) as { componentId?: unknown };
  return typeof props.componentId === "string" ? props.componentId : null;
}

/** The `contains` parent of one object, or null. At most one by `contains`'s `one_to_many` plus
 *  migration 0022's partial unique index — the invariant `pipeline-resolution.ts` also relies on. */
async function containsParentOf(
  tx: TenantTx,
  orgId: string,
  objectId: string
): Promise<{ id: string; typeId: string } | null> {
  const edge = await tx.query.relationships.findFirst({
    where: (t, { eq: eqOp, and: andOp, isNull: isNullOp }) =>
      andOp(
        eqOp(t.orgId, orgId),
        eqOp(t.typeId, "contains"),
        eqOp(t.toId, objectId),
        isNullOp(t.deletedAt)
      )
  });
  if (!edge) return null;
  // The parent's TYPE comes back with it. The walk stays type-agnostic — it still does not branch on
  // this — but whatever it resolves through has to be nameable truthfully in a Decision, and reading
  // the type here costs nothing the walk was not already paying for this row.
  const parent = await tx.query.objects.findFirst({
    where: (t, { eq: eqOp, and: andOp, isNull: isNullOp }) =>
      andOp(eqOp(t.orgId, orgId), eqOp(t.id, edge.fromId), isNullOp(t.deletedAt))
  });
  return parent ? { id: parent.id, typeId: parent.typeId } : null;
}

/** The `contains` ancestors, nearest first and capped. See docs/coordination.md §37. */
async function containsAncestors(
  tx: TenantTx,
  orgId: string,
  targetObjectId: string
): Promise<{ id: string; typeId: string }[]> {
  const componentObjectId = await componentOfTarget(tx, orgId, targetObjectId);
  if (!componentObjectId) return [];

  const ancestors: { id: string; typeId: string }[] = [];
  const seen = new Set<string>([componentObjectId]);
  let current = componentObjectId;
  for (let hop = 0; hop < MAX_ANCESTOR_HOPS; hop += 1) {
    const parent = await containsParentOf(tx, orgId, current);
    if (!parent || seen.has(parent.id)) break;
    ancestors.push(parent);
    seen.add(parent.id);
    current = parent.id;
  }
  return ancestors;
}

/** Rung three: the owning service's binding, else none. See docs/coordination.md §38. */
async function serviceRung(
  tx: TenantTx,
  orgId: string,
  targetObjectId: string,
  type: BindingType
): Promise<BindingResolution> {
  // NEAREST FIRST (ADR-0029 D1). The first ancestor carrying a binding of this Type wins, so a
  // component's assembly beats its service, which beats the org — most specific always.
  const ancestors = await containsAncestors(tx, orgId, targetObjectId);
  for (const [index, ancestor] of ancestors.entries()) {
    const binding = await getExecutorBinding(tx, orgId, ancestor.id, type);
    if (binding) {
      return {
        outcome: "via_service",
        binding,
        viaPlacementObjectId: null,
        viaServiceObjectId: ancestor.id,
        viaObjectTypeId: ancestor.typeId,
        hops: index + 1
      };
    }
  }

  // THE ORG RUNG (ADR-0029, which ADR-0027 D4 excluded). Reached DIRECTLY rather than by walking,
  // for the same reason `pipeline-resolution.ts` reaches it directly: the org root is normally found
  // through the `domain_id` axis, which this ladder deliberately does not walk, so a hop-based walk
  // would silently never arrive. `hops: 0` marks it as the least specific rung there is.
  const orgRootId = await getOrgRootObjectId(tx, orgId);
  const viaOrg = await getExecutorBinding(tx, orgId, orgRootId, type);
  if (viaOrg) {
    return {
      outcome: "via_service",
      binding: viaOrg,
      viaPlacementObjectId: null,
      viaServiceObjectId: orgRootId,
      // Not "service": the org rung has never been one. This was the label's FIRST wrong case, live
      // before `assembly` was added, which is why the fix is to read the level rather than to add
      // one more name to a branch.
      viaObjectTypeId: "organization",
      hops: 0
    };
  }

  return { outcome: "none", binding: null, viaPlacementObjectId: null };
}

/** Resolves the binding driving one pipeline of one target. See docs/coordination.md §39. */
export async function resolveBindingForTarget(
  tx: TenantTx,
  orgId: string,
  targetObjectId: string,
  type: BindingType = DEFAULT_BINDING_TYPE
): Promise<BindingResolution> {
  const direct = await getExecutorBinding(tx, orgId, targetObjectId, type);
  if (direct) return { outcome: "direct", binding: direct, viaPlacementObjectId: null };

  const placementIds = await placementsOfComponent(tx, orgId, targetObjectId);
  // BOTH ways of having no placement binding fall through to rung 3, and they are DIFFERENT paths:
  // a PLACEMENT target has no placements of its own (`placementsOfComponent` returns nothing for
  // it), and that is the shape stage-shaped compilation actually produces. Adding the service rung
  // at only the other exit would have missed the estate's common case entirely.
  if (placementIds.length === 0) return serviceRung(tx, orgId, targetObjectId, type);

  const candidates: { placementObjectId: string; binding: ExecutorBindingRow }[] = [];
  for (const placementObjectId of placementIds) {
    const binding = await getExecutorBinding(tx, orgId, placementObjectId, type);
    if (binding) candidates.push({ placementObjectId, binding });
  }

  if (candidates.length === 0) return serviceRung(tx, orgId, targetObjectId, type);
  if (candidates.length > 1) {
    return {
      outcome: "ambiguous",
      binding: null,
      viaPlacementObjectId: null,
      // Sorted so the refusal message and its Decision are stable across ticks — an unstable list
      // would make the same block look like a different one every time it is re-read.
      candidates: candidates
        .map((c) => ({ placementObjectId: c.placementObjectId, bindingId: c.binding.id }))
        .sort((a, b) => a.placementObjectId.localeCompare(b.placementObjectId))
    };
  }

  const only = candidates[0]!;
  return {
    outcome: "via_placement",
    binding: only.binding,
    viaPlacementObjectId: only.placementObjectId
  };
}

/** Every binding VISIBLE for a target. See docs/coordination.md §40. */
export async function listVisibleBindingsForTarget(
  tx: TenantTx,
  orgId: string,
  targetObjectId: string
): Promise<{ binding: ExecutorBindingRow; viaPlacementObjectId: string | null }[]> {
  const own = await listExecutorBindingsForTarget(tx, orgId, targetObjectId);
  const visible = own.map((binding) => ({ binding, viaPlacementObjectId: null as string | null }));

  const placementIds = await placementsOfComponent(tx, orgId, targetObjectId);
  if (placementIds.length === 0) return visible;

  for (const placementObjectId of placementIds) {
    const rows = await listExecutorBindingsForTarget(tx, orgId, placementObjectId);
    for (const binding of rows) visible.push({ binding, viaPlacementObjectId: placementObjectId });
  }
  return visible;
}
