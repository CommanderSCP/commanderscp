import type { TenantTx } from "../db/tenant-tx.js";
import { freezesByTarget, unionFreezes, type EffectiveFreeze } from "../governance/freeze-scope.js";
import { resolvePlacementPair } from "./stage-dependency-hold.js";
import { readTargetLiveness } from "./target-liveness.js";

/** M25.2 — THE FREEZE HOLD, PREDICATE HALF. See docs/coordination.md §518. */

/** One held wave target and what is holding it. Shaped for the Decision `reconcile.ts` writes:
 *  every field is an id, a name, or an instant read straight off `freezes.ends_at` — nothing
 *  derived from a clock, which is what lets the Decision dedup under the 1 s tick. */
export interface FreezeHoldVerdict {
  targetObjectId: string;
  /** The (component, deployment-target) pair this target resolves to, or `null` for a
   *  legacy-shaped wave target that names a component directly. Reported, never required: a freeze
   *  holds a component-shaped target exactly as well as a placement-shaped one, because the
   *  containment chain covers both. Purely for the Decision's explanation. */
  stage: { componentObjectId: string; deploymentTargetObjectId: string } | null;
  /** Every active freeze holding this target, sorted by id. See docs/coordination.md §519. */
  freezes: {
    id: string;
    /** Which tier declared it, and which surface resolves it. See docs/coordination.md §520. */
    tier: "org" | "platform";
    /** NULL for a platform freeze — that tier has no object id in any org's containment chain,
     *  which is exactly why it addresses a stage coordinate (`match`) instead. */
    scopeObjectId: string | null;
    /** What a platform freeze matched; null for an org freeze, whose scope IS its address. */
    match: { allEnvironments: boolean; environment: string | null; region: string | null } | null;
    name: string | null;
    endsAt: string;
    atomic: boolean;
  }[];
}

/** Every target an active freeze covers, keyed by target. See docs/coordination.md §521. */
export async function evaluateFreezeHolds(
  tx: TenantTx,
  input: { orgId: string; targetObjectIds: string[]; now?: Date }
): Promise<Map<string, FreezeHoldVerdict>> {
  const { orgId, targetObjectIds } = input;
  const holds = new Map<string, FreezeHoldVerdict>();
  if (targetObjectIds.length === 0) return holds;

  const byTarget = await freezesByTarget(tx, orgId, targetObjectIds, input.now ?? new Date());

  // `atomic` is read here, not only at the gate. See docs/coordination.md §522.
  const atomicFreezes = unionFreezes(byTarget).filter((f) => f.atomic);

  for (const entry of byTarget) {
    const holding =
      atomicFreezes.length === 0
        ? entry.freezes
        : unionFreezes([
            { targetObjectId: entry.targetObjectId, freezes: entry.freezes },
            { targetObjectId: entry.targetObjectId, freezes: atomicFreezes }
          ]);
    if (holding.length === 0) continue;

    // A DEAD TARGET IS NOT HELD. See docs/coordination.md §523.
    const liveness = await readTargetLiveness(tx, orgId, entry.targetObjectId);
    if (!liveness.live) continue;

    // The placement pair is resolved ONLY for a target that is actually held — one extra read per
    // HELD target per tick, never one per target. A change with nothing frozen (the common case)
    // has already returned above without reaching this loop body at all.
    const stage = await resolvePlacementPair(tx, orgId, entry.targetObjectId);
    holds.set(entry.targetObjectId, {
      targetObjectId: entry.targetObjectId,
      stage,
      freezes: describeFreezes(holding)
    });
  }
  return holds;
}

export interface HeldTargetRecord {
  targetObjectId: string;
  componentObjectId: string | null;
  deploymentTargetObjectId: string | null;
  freezes: FreezeHoldVerdict["freezes"];
}

/** THE `held` ARRAY OF THE `freeze_admission` DECISION. See docs/coordination.md §524. */
export function describeHeldTargets(frozenTargets: FreezeHoldVerdict[]): HeldTargetRecord[] {
  return [...frozenTargets]
    .sort((a, b) => a.targetObjectId.localeCompare(b.targetObjectId))
    .map((entry) => ({
      targetObjectId: entry.targetObjectId,
      componentObjectId: entry.stage?.componentObjectId ?? null,
      deploymentTargetObjectId: entry.stage?.deploymentTargetObjectId ?? null,
      freezes: entry.freezes
    }));
}

/** The Decision-shaped projection of a covering freeze set. See docs/coordination.md §525. */
function describeFreezes(freezes: EffectiveFreeze[]): FreezeHoldVerdict["freezes"] {
  return [...freezes]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((f) => ({
      id: f.id,
      tier: f.tier,
      scopeObjectId: f.tier === "platform" ? null : f.scopeObjectId,
      match:
        f.tier === "platform"
          ? {
              allEnvironments: f.matchAllEnvironments,
              environment: f.matchEnvironment,
              region: f.matchRegion
            }
          : null,
      name: f.name,
      endsAt: f.endsAt.toISOString(),
      atomic: f.atomic
    }));
}

/** One line an operator can read, per held target — the reason-tree half of the Decision. */
export function describeFreezeHold(verdict: FreezeHoldVerdict): string {
  return verdict.freezes
    .map(
      (f) =>
        `freeze '${f.name ?? f.id}' at ${freezeAddress(f)} until ${f.endsAt}` +
        (f.atomic ? " (atomic — it holds EVERY target of the wave, covered or not)" : "") +
        ` — target ${verdict.targetObjectId} is not triggered while it stands`
    )
    .join("; ");
}

/** Where a freeze was declared, in one readable phrase. See docs/coordination.md §526. */
function freezeAddress(f: FreezeHoldVerdict["freezes"][number], scopeName?: string | null): string {
  if (f.tier !== "platform") return scopeName ? `'${scopeName}'` : String(f.scopeObjectId);
  if (!f.match || f.match.allEnvironments) return "the whole deployment (platform tier)";
  return f.match.region === null
    ? `every region of '${f.match.environment}' (platform tier)`
    : `'${f.match.environment}'/'${f.match.region}' (platform tier)`;
}

/** One sentence per covering freeze, for the wire field. See docs/coordination.md §527. */
export function describeFreezeForWaveTarget(
  f: FreezeHoldVerdict["freezes"][number],
  scopeName: string | null
): string {
  return (
    `freeze '${f.name ?? f.id}' at ${freezeAddress(f, scopeName)} until ${f.endsAt}` +
    (f.atomic ? " (atomic — it holds EVERY target of the wave, covered or not)" : "")
  );
}
