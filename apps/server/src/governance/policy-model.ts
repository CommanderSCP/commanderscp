/** Policy shapes, plus the pure stricter-wins resolution. See docs/governance.md §267. */

export type PolicyEnforcement = "advisory" | "recommended" | "required";

/** Mirrors `@scp/plugin-api`'s `ControlOutcomeStatus` (DESIGN §10.2) — re-declared here (rather
 *  than imported) so this module stays a zero-dependency pure-function module, matching its own
 *  module doc's "everything testable as a pure function" discipline. */
export type ControlOutcomeStatusLike =
  "pass" | "fail" | "warning" | "skipped" | "timed_out" | "expired";

const ENFORCEMENT_SEVERITY: Record<PolicyEnforcement, number> = {
  advisory: 0,
  recommended: 1,
  required: 2
};

/** Total order over enforcement levels — exported so callers (governance/evaluate.ts) can compare
 *  without re-deriving the severity table. */
export function isAtLeastAsStrict(a: PolicyEnforcement, b: PolicyEnforcement): boolean {
  return ENFORCEMENT_SEVERITY[a] >= ENFORCEMENT_SEVERITY[b];
}

function stricterEnforcement(a: PolicyEnforcement, b: PolicyEnforcement): PolicyEnforcement {
  return ENFORCEMENT_SEVERITY[a] >= ENFORCEMENT_SEVERITY[b] ? a : b;
}

export interface RequireApprovalsEffect {
  requireApprovals: { count: number; fromRole: string; scope: string };
}
export interface RequireControlsEffect {
  requireControls: string[];
}
export type PolicyEffect = RequireApprovalsEffect | RequireControlsEffect;

export function isRequireControlsEffect(e: PolicyEffect): e is RequireControlsEffect {
  return "requireControls" in e;
}
export function isRequireApprovalsEffect(e: PolicyEffect): e is RequireApprovalsEffect {
  return "requireApprovals" in e;
}

/** One policy object matched against a target's containment chain (policy-resolve.ts's output —
 *  the impure "gather" step's result, and this file's pure "merge" step's input). */
export interface MatchedPolicy {
  policyObjectId: string;
  /** `objects.version` at match time — pinned into the Decision so the exact document consulted
   *  stays reconstructible after later edits (DESIGN §10.4). */
  policyVersion: number;
  name: string;
  enforcement: PolicyEnforcement;
  /** CEL condition string, or undefined (= always applies, no condition to evaluate). */
  condition: string | undefined;
  effects: PolicyEffect[];
  /** How this policy matched. See docs/governance.md §268. */
  matchedAt: {
    objectId: string;
    depth: number;
    via: "objectRef" | "selector" | "group" | "ownerGroup" | "unscoped";
  };
  emergencyPolicy: boolean;
  /** DESIGN §9.4: "Triggers: automatic (gate/control failure policy...) or manual" — when true,
   *  a wave-target failure under this policy's scope triggers an automatic rollback
   *  (coordination/reconcile.ts) instead of parking for a manual `scp change rollback`. */
  autoRollbackOnFailure: boolean;
}

/** A merged requirement, carrying its winning contributor. See docs/governance.md §269. */
export interface EffectiveApprovalRequirement {
  count: number;
  fromRole: string;
  scope: string;
  originPolicyObjectId: string;
  originPolicyVersion: number;
  originEffectIndex: number;
}

/** The union of a set of contributors' effects. See docs/governance.md §270. */
export function mergeContributorEffects(contributors: MatchedPolicy[]): {
  requireControls: string[];
  requireApprovals: EffectiveApprovalRequirement[];
} {
  const requireControls = new Set<string>();
  const approvalsByKey = new Map<string, EffectiveApprovalRequirement>();
  for (const m of contributors) {
    m.effects.forEach((effect, effectIndex) => {
      if (isRequireControlsEffect(effect)) {
        for (const c of effect.requireControls) requireControls.add(c);
      } else if (isRequireApprovalsEffect(effect)) {
        const key = `${effect.requireApprovals.fromRole}::${effect.requireApprovals.scope}`;
        const existing = approvalsByKey.get(key);
        if (!existing || effect.requireApprovals.count > existing.count) {
          approvalsByKey.set(key, {
            ...effect.requireApprovals,
            originPolicyObjectId: m.policyObjectId,
            originPolicyVersion: m.policyVersion,
            originEffectIndex: effectIndex
          });
        }
      }
    });
  }
  return {
    requireControls: [...requireControls].sort(),
    requireApprovals: [...approvalsByKey.values()]
  };
}

/** Strictest enforcement across a set of levels (max severity), `advisory` for an empty set. */
export function maxEnforcement(levels: PolicyEnforcement[]): PolicyEnforcement {
  let e: PolicyEnforcement = "advisory";
  for (const l of levels) e = stricterEnforcement(e, l);
  return e;
}

/** One name-group's merged, effective requirement. See docs/governance.md §271. */
export interface EffectivePolicy {
  name: string;
  enforcement: PolicyEnforcement;
  requireControls: string[];
  requireApprovals: EffectiveApprovalRequirement[];
  /** Every instance that contributed to this effective policy, deepest-scope-first — the reason
   *  tree renders this so "why is this required" always shows every contributing level. */
  contributors: MatchedPolicy[];
  emergencyPolicy: boolean;
  autoRollbackOnFailure: boolean;
}

/** The pure stricter-wins merge. See docs/governance.md §272. */
export function resolvePolicies(matches: MatchedPolicy[]): EffectivePolicy[] {
  const groups = new Map<string, MatchedPolicy[]>();
  for (const m of matches) {
    const group = groups.get(m.name);
    if (group) group.push(m);
    else groups.set(m.name, [m]);
  }

  const effective: EffectivePolicy[] = [];
  for (const [name, group] of groups) {
    // Deepest (most local) scope first — purely for stable, human-legible `contributors` ordering
    // in the reason tree; has no bearing on the merge result itself (order-independent by design).
    const sorted = [...group].sort((a, b) => b.matchedAt.depth - a.matchedAt.depth);
    const merged = mergeContributorEffects(sorted);

    effective.push({
      name,
      enforcement: maxEnforcement(sorted.map((m) => m.enforcement)),
      requireControls: merged.requireControls,
      requireApprovals: merged.requireApprovals,
      contributors: sorted,
      emergencyPolicy: sorted.some((m) => m.emergencyPolicy),
      autoRollbackOnFailure: sorted.some((m) => m.autoRollbackOnFailure)
    });
  }

  // Stable output order (by name) so callers/tests never depend on Map iteration order.
  return effective.sort((a, b) => a.name.localeCompare(b.name));
}
