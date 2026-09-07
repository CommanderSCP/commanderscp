import { badRequest, conflict } from "../errors.js";
import { DependencySubscriptionEffectSchema } from "@scp/schemas";
import type { TenantTx } from "../db/tenant-tx.js";
import { delegationRefusalMessage, readStandingDelegationVerdict } from "./delegation-detection.js";

/** A group-scoped effect is refused at authoring time. See docs/dependencies.md §365. */
export function assertEnforceableDependencySubscriptionScope(args: {
  /** The object type being written. See docs/dependencies.md §366. */
  typeId: string;
  properties: Record<string, unknown> | undefined;
}): void {
  if (args.typeId !== "policy") return;

  const scope = args.properties?.scope as
    { group?: unknown; objectRef?: unknown; selector?: unknown } | undefined;
  // Only `group` matching depends on something the author did not write down — the actor's
  // membership, or an `owns` edge somewhere on the target's chain. `objectRef` and `selector` resolve
  // against the graph and reach exactly what they name, so they carry no such hazard.
  if (!scope || typeof scope.group !== "string" || scope.group === "") return;

  // Mirrors the matcher's own truthiness tests exactly. See docs/dependencies.md §367.
  const hasObjectRef = typeof scope.objectRef === "string" && scope.objectRef !== "";
  const selectorLabels = (scope.selector as { labels?: unknown } | undefined)?.labels;
  const hasSelector = typeof selectorLabels === "object" && selectorLabels !== null;
  if (hasObjectRef || hasSelector) return;

  const effects = args.properties?.effects;
  if (!Array.isArray(effects)) return;

  for (const raw of effects) {
    const candidate = (raw as { dependencySubscription?: unknown } | null)?.dependencySubscription;
    if (candidate === undefined) continue;
    const parsed = DependencySubscriptionEffectSchema.safeParse(candidate);
    // A malformed effect is NOT this guard's business — it contributes nothing at resolution time
    // and is reported there. Rejecting it here would make this guard a second, divergent validator
    // of the effect's shape, and the two would drift.
    if (!parsed.success) continue;

    // BOTH DIRECTIONS, ONE REMEDY, ONE GROUND. See docs/dependencies.md §368.
    throw badRequest(
      parsed.data.enabled
        ? "A dependency-subscription enable (enabled: true) cannot be scoped to a group. " +
            "A group-scoped policy applies where the acting subject belongs to that group OR where " +
            "the group owns something on the target's containment chain — so which components this " +
            "enable actually reaches is decided by `owns` edges rather than by anything written " +
            "here, and it changes silently whenever ownership is edited. Scope it with `objectRef` " +
            "or `selector` instead — those reach exactly what they name, for every caller."
        : "A dependency-subscription opt-out (enabled: false) cannot be scoped to a group. " +
            "A group-scoped policy applies only where the acting subject belongs to that group or " +
            "the group owns something on the target's containment chain, so an opt-out authored " +
            "this way would silently fail to apply everywhere else and the dependency would keep " +
            "being bumped — and removing an `owns` edge later would silently re-subscribe a " +
            "component you opted out. Scope the opt-out with `objectRef` or `selector` instead — " +
            "those reach exactly what they name, for every caller."
    );
  }
}

/** Enabling for a component whose repository delegates. See docs/dependencies.md §369. */
export async function assertNoDelegatedDependencyUpdates(
  tx: TenantTx,
  args: {
    orgId: string;
    /** As with the sibling guard, taken as an argument so every installation site — including the
     *  free-form-`typeId` doors — is correct by construction rather than by remembering. */
    typeId: string;
    properties: Record<string, unknown> | undefined;
  }
): Promise<void> {
  if (args.typeId !== "policy") return;

  const effects = args.properties?.effects;
  if (!Array.isArray(effects)) return;

  // Does this document ENABLE anything at all? An opt-out-only policy is never refused — see the
  // header. Parsed with the same schema the resolver uses, so a document that would contribute
  // nothing at resolution time cannot be refused here either.
  const enables = effects.some((raw) => {
    const candidate = (raw as { dependencySubscription?: unknown } | null)?.dependencySubscription;
    if (candidate === undefined) return false;
    const parsed = DependencySubscriptionEffectSchema.safeParse(candidate);
    return parsed.success && parsed.data.enabled;
  });
  if (!enables) return;

  const scope = args.properties?.scope as { objectRef?: unknown } | undefined;
  const objectRef = typeof scope?.objectRef === "string" ? scope.objectRef.trim() : "";
  if (objectRef === "") return; // see "ONLY AN `objectRef` SCOPE CAN BE DECIDED HERE"

  // Resolved exactly as `governance/policy-resolve.ts`'s own `resolveRef` does — id or URN — because
  // the object this refusal is about must be the same object the matcher would later attach to. A
  // ref that resolves to nothing is a dangling reference, which is already broken in ways this guard
  // is not responsible for (the sibling guard's residual note says the same of the same case).
  const row = /^[0-9a-fA-F-]{36}$/.test(objectRef)
    ? await tx.query.objects.findFirst({
        where: (t, { eq: eqOp, and: andOp }) =>
          andOp(eqOp(t.orgId, args.orgId), eqOp(t.id, objectRef))
      })
    : await tx.query.objects.findFirst({
        where: (t, { eq: eqOp, and: andOp }) =>
          andOp(eqOp(t.orgId, args.orgId), eqOp(t.urn, objectRef))
      });
  if (!row) return;

  const standing = await readStandingDelegationVerdict(tx, args.orgId, row.id);
  if (!standing?.delegated) return;

  throw conflict(delegationRefusalMessage(standing.collisions), {
    decisionId: standing.decisionId
  });
}
