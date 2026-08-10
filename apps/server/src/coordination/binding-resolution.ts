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

/**
 * PLACEMENT-AWARE executor-binding resolution (ADR-0026, amending ADR-0006's resolution path).
 *
 * ============================================================================================
 * WHY THIS EXISTS — THE MIGRATION ORDERING HAZARD IT REMOVES
 * ============================================================================================
 * `getExecutorBinding` is a flat lookup on `(org_id, target_object_id, type)`. Wave targets are
 * COMPONENTS under legacy compilation and PLACEMENTS under stage-shaped compilation, and the estate
 * migration has to move bindings from the former to the latter. Doing that while compilation is
 * still legacy leaves each component with ZERO bindings — and `reconcile.ts`'s ADR-0006 case (a)
 * reads zero bindings as INTENDED-FAKE, so every wave target would fake-succeed. Green reports,
 * nothing deployed: exactly the masking failure #66 closed.
 *
 * The dependency is circular as the migration was written: bindings cannot move until compilation is
 * stage-shaped, compilation cannot go stage-shaped until a topology is attached, and attaching one
 * fails loudly for anything unplaced. This resolver breaks the cycle by making each step
 * independently safe — a component whose binding has already moved to its placement still resolves.
 *
 * ============================================================================================
 * THE THREE OUTCOMES, AND WHY THE AMBIGUOUS ONE IS THE POINT
 * ============================================================================================
 *   `direct`        — the target itself carries a binding of this type. Unchanged behaviour, and the
 *                     first thing checked, so nothing about today's resolution slows down or moves.
 *   `via_placement` — the target is a component with no binding of its own, and EXACTLY ONE of its
 *                     placements has one. Safe by construction: one placement means the pair is not
 *                     actually ambiguous, which is true of all 61 placements on the estate today.
 *   `ambiguous`     — TWO OR MORE placements carry a binding of this type. **Fail closed. Do not
 *                     pick.** This is the entire reason the placement type exists: "which Argo CD"
 *                     is a function of WHERE, and a component alone cannot answer it. Choosing
 *                     arbitrarily would reintroduce the cross-product bug ADR-0026 was written to
 *                     kill, in a new place and with no error to find it by.
 *
 * That state is REACHABLE, not theoretical: merging an env-suffixed pair gives the survivor two
 * placements, which is precisely the moment stage-shaped compilation must take over so wave targets
 * become placements and resolution is direct again. Failing closed is what makes that ordering
 * enforced rather than merely documented.
 *
 * ============================================================================================
 * WHAT THIS DELIBERATELY DOES NOT DO
 * ============================================================================================
 * It does not touch `getExecutorBinding`. That function is also the existence check for
 * `putExecutorBinding` and both halves of `setExecutorBindingType`'s relabel — WRITE paths, where a
 * fallback would be actively wrong: an upsert that "found" a placement's binding would update the
 * wrong row, and a relabel would report a clash against a binding on a different object. Those three
 * call sites keep the literal lookup, and say so at each site. Only READ/RESOLVE sites use this.
 */

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
  /** ADR-0027, generalised by ADR-0028 — a containment ANCESTOR carries the binding. Infrastructure
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
      hops: number;
    }
  | { outcome: "none"; binding: null; viaPlacementObjectId: null };

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

/**
 * The owning SERVICE of a wave target (ADR-0027 D3/D4), or null.
 *
 * Accepts either shape a wave target takes: a COMPONENT under legacy compilation, or a PLACEMENT
 * under stage-shaped compilation — the case the estate actually runs, which a component-only rung
 * would have missed entirely.
 *
 * The service is the inbound `contains` edge, at most one by `contains`'s `one_to_many` plus
 * migration 0022's partial unique index — the same invariant `pipeline-resolution.ts` relies on, so
 * a binding and a pipeline can never disagree about which service owns a component.
 */
/** ADR-0028 D3 — `intermediate-grouping.md` D2's cap, in hops of `contains`. Bounded so the walk's
 *  cost is provable and a mis-declared containment cycle cannot spin. */
const MAX_ANCESTOR_HOPS = 3;

/**
 * The component a wave target is about, whichever shape the target takes: a COMPONENT under legacy
 * compilation, or a PLACEMENT under stage-shaped compilation — the shape the estate actually runs.
 */
async function componentOfTarget(
  tx: TenantTx,
  orgId: string,
  targetObjectId: string
): Promise<string | null> {
  const target = await tx.query.objects.findFirst({
    where: (t, { eq: eqOp, and: andOp }) => andOp(eqOp(t.id, targetObjectId), eqOp(t.orgId, orgId))
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
): Promise<string | null> {
  const edge = await tx.query.relationships.findFirst({
    where: (t, { eq: eqOp, and: andOp, isNull: isNullOp }) =>
      andOp(
        eqOp(t.orgId, orgId),
        eqOp(t.typeId, "contains"),
        eqOp(t.toId, objectId),
        isNullOp(t.deletedAt)
      )
  });
  return edge?.fromId ?? null;
}

/**
 * The `contains` ancestors of a wave target, NEAREST FIRST, capped at {@link MAX_ANCESTOR_HOPS}.
 *
 * ============================================================================================
 * WHY THIS WALKS `contains` ONLY, AND NOT `containmentChain` — READ BEFORE "SIMPLIFYING" IT
 * ============================================================================================
 * `containmentChain` walks TWO axes per hop (the `contains` edge AND `domain_id`), and its own
 * docblock records that when a component's `domain_id` differs from its service's, the domain and the
 * service are each exactly ONE hop away and **TIE** — "no ordering of these two routes is obviously
 * correct". It then says explicitly that this "WOULD become a real precedence bug the moment any code
 * compares depth across differently-named [ancestors] to pick a single most-specific winner — if you
 * are about to write that, fix this first."
 *
 * A nearest-wins binding ladder IS that code. Walking the single `contains` axis is what makes
 * "nearest" unambiguous, and it leaves `containmentChain` untouched — the same reasoning
 * `pipeline-resolution.ts` gives for walking named rungs rather than reusing it. The consequence is
 * deliberate and worth stating: **a binding on a containment `domain` does not resolve** (ADR-0028 D2).
 *
 * The walk is TYPE-AGNOSTIC (ADR-0028 D4): it does not care whether a parent is a `service`, an
 * `assembly`, or something that does not exist yet — only whether it carries a binding of this Type.
 * A `seen` set makes a mis-declared cycle terminate even inside the cap.
 */
async function containsAncestors(
  tx: TenantTx,
  orgId: string,
  targetObjectId: string
): Promise<string[]> {
  const componentObjectId = await componentOfTarget(tx, orgId, targetObjectId);
  if (!componentObjectId) return [];

  const ancestors: string[] = [];
  const seen = new Set<string>([componentObjectId]);
  let current = componentObjectId;
  for (let hop = 0; hop < MAX_ANCESTOR_HOPS; hop += 1) {
    const parent = await containsParentOf(tx, orgId, current);
    if (!parent || seen.has(parent)) break;
    ancestors.push(parent);
    seen.add(parent);
    current = parent;
  }
  return ancestors;
}

/**
 * RUNG 3 (ADR-0027) — the owning service's binding, else `none`.
 *
 * In its own function because it is reached from TWO places: a target with no placements at all (a
 * placement, under stage-shaped compilation) and a component whose placements carry nothing of this
 * type. Those are separate exits from the walk, and a rung written inline at one of them would
 * silently not apply at the other — the failure mode being that the case the estate actually runs
 * is the one left out.
 */
async function serviceRung(
  tx: TenantTx,
  orgId: string,
  targetObjectId: string,
  type: BindingType
): Promise<BindingResolution> {
  // NEAREST FIRST (ADR-0028 D1). The first ancestor carrying a binding of this Type wins, so a
  // component's assembly beats its service, which beats the org — most specific always.
  const ancestors = await containsAncestors(tx, orgId, targetObjectId);
  for (const [index, ancestorObjectId] of ancestors.entries()) {
    const binding = await getExecutorBinding(tx, orgId, ancestorObjectId, type);
    if (binding) {
      return {
        outcome: "via_service",
        binding,
        viaPlacementObjectId: null,
        viaServiceObjectId: ancestorObjectId,
        hops: index + 1
      };
    }
  }

  // THE ORG RUNG (ADR-0028, which ADR-0027 D4 excluded). Reached DIRECTLY rather than by walking,
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
      hops: 0
    };
  }

  return { outcome: "none", binding: null, viaPlacementObjectId: null };
}

/**
 * Resolves the binding driving one pipeline of one wave target, falling back through the target's
 * placements and then its owning SERVICE when the target itself has none of that type.
 *
 * Order is deliberate and MOST-SPECIFIC-WINS (ADR-0027 D1): direct, then placement, then service. A
 * target that carries its own binding never consults the others, so each rung is a pure extension —
 * no resolution that succeeds today can change answer, and the only behaviour that moves is
 * `none` → `via_service`, i.e. a target that was BLOCKED may now resolve.
 *
 * `ambiguous` is terminal and does NOT fall through to the service (ADR-0027 D2): two placements
 * bound for one Type is a refusal, not an absence, and answering it from the service would suppress
 * exactly the refusal ADR-0026 exists to make.
 */
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

/**
 * Every binding VISIBLE for a target — its own plus those of its placements.
 *
 * This is what keeps ADR-0006's case (a)/(b) split meaning what it always meant. Case (a) is
 * "intended-fake: nothing anywhere", and once a binding can live on a placement, "anywhere" has to
 * include placements — otherwise a component whose `configuration` binding had moved to its
 * placement, receiving an `image` release, would read as zero-bindings and FAKE-SUCCEED. That is
 * case (b) wearing case (a)'s clothes, and it is the masking gap #66 closed.
 *
 * Soft-delete filtering is inherited from `listExecutorBindingsForTarget`, which applies the
 * live-target EXISTS check; `placementsOfComponent` filters tombstoned placements itself.
 */
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
