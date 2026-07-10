/**
 * Policy document shapes + the PURE stricter-wins resolution algorithm (DESIGN.md §10.1,
 * BUILD_AND_TEST.md §8 M4: "Resolution: walk containment org→domain→service→component, inherit
 * downward, STRICTER-WINS on conflict; a local domain may add strictness, never weaken a
 * higher-level requirement unless explicitly permitted").
 *
 * Deliberately split from `policy-resolve.ts` (which does the impure DB work of finding which
 * policy objects match a given target's containment chain): everything in THIS file is a pure
 * function over already-gathered data, per BUILD_AND_TEST.md §4.1's rule ("anything testable as a
 * pure function must be written as a pure function") — the unit-test DoD bullet ("stricter-wins
 * merge logic table-driven") targets exactly this file.
 *
 * --- The stricter-wins model, concretely ---
 *
 * A policy MATCHES a target's containment chain at some ancestor (org/domain/service/component —
 * `MatchedPolicy.scopeDepth`, 0 = org root, increasing toward the target). Two matched policies
 * are considered "the same policy, refined at different scope levels" when they share the same
 * `name` — e.g. an org-wide "prod-security" policy and a domain's own "prod-security" policy both
 * governing the same target. `resolvePolicies` groups matches by name and, within each group,
 * computes ONE effective policy:
 *
 *   - **effective enforcement = the MAX severity across the group** (required > recommended >
 *     advisory) — a domain-level instance can never reduce what an org-level instance already
 *     requires, because there is no "weaken" effect in this schema (MVP deliberately ships no
 *     such effect — DESIGN's "unless explicitly permitted" escape hatch is not implemented; every
 *     instance in a name-group can only ever raise the bar).
 *   - **effective effects = the UNION across the group** (`requireControls` arrays merged as a
 *     set union; `requireApprovals` entries merged by `(fromRole, scope)` pair, count taking the
 *     MAX) — a local instance can ADD a stricter requirement (another required control, a higher
 *     approval count) but adding is the only thing possible; nothing in the merge can remove an
 *     entry another instance in the group already contributed.
 *
 * Policies with DIFFERENT names never merge with each other — each is evaluated (condition +
 * effects) independently, and a transition blocks if ANY required-enforcement policy (after this
 * merge) has an unmet effect. This is what makes "local adds strictness, never weakens" a
 * structural property of the merge rather than a convention someone could violate by mis-scoping
 * a policy: there is no code path that can produce an effective enforcement below the strictest
 * contributor, or an effective effect set missing something a contributor required.
 */

export type PolicyEnforcement = "advisory" | "recommended" | "required";

/** Mirrors `@scp/plugin-api`'s `ControlOutcomeStatus` (DESIGN §10.2) — re-declared here (rather
 *  than imported) so this module stays a zero-dependency pure-function module, matching its own
 *  module doc's "everything testable as a pure function" discipline. */
export type ControlOutcomeStatusLike = "pass" | "fail" | "warning" | "skipped" | "timed_out" | "expired";

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
  /** How this policy matched (for the reason tree — DESIGN §10.1 "explainability is the return
   *  value"): which ancestor object's scope declaration matched, and how. */
  matchedAt: { objectId: string; depth: number; via: "objectRef" | "selector" | "group" | "unscoped" };
  emergencyPolicy: boolean;
  /** DESIGN §9.4: "Triggers: automatic (gate/control failure policy...) or manual" — when true,
   *  a wave-target failure under this policy's scope triggers an automatic rollback
   *  (coordination/reconcile.ts) instead of parking for a manual `scp change rollback`. */
  autoRollbackOnFailure: boolean;
}

/**
 * A merged requireApprovals requirement, carrying its WINNING contributor's own document
 * coordinates (`originPolicyObjectId`/`originPolicyVersion`/`originEffectIndex` — the position of
 * this exact effect within THAT contributor's own `properties.effects` array). This is what lets
 * `governance/approvals-repo.ts` materialize one `approval_requests` row per distinct requirement
 * keyed by (policy, policy version, effect index) — the same dedup key whether this requirement
 * came from a single policy or was raised by a stricter local override (the winning contributor's
 * coordinates are stable across repeated resolution as long as nothing edits the documents).
 */
export interface EffectiveApprovalRequirement {
  count: number;
  fromRole: string;
  scope: string;
  originPolicyObjectId: string;
  originPolicyVersion: number;
  originEffectIndex: number;
}

/** One name-group's merged, effective requirement — what actually gets enforced. */
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

/**
 * The pure stricter-wins merge (module doc comment). Grouping key is `name`; within a group,
 * enforcement takes the max severity and effects union. Order of `matches` does not affect the
 * result (verified by the property test) — the whole point of a declarative merge.
 */
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

    let enforcement: PolicyEnforcement = "advisory";
    const requireControls = new Set<string>();
    const approvalsByKey = new Map<string, EffectiveApprovalRequirement>();
    let emergencyPolicy = false;
    let autoRollbackOnFailure = false;

    for (const m of sorted) {
      enforcement = stricterEnforcement(enforcement, m.enforcement);
      emergencyPolicy = emergencyPolicy || m.emergencyPolicy;
      autoRollbackOnFailure = autoRollbackOnFailure || m.autoRollbackOnFailure;
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

    effective.push({
      name,
      enforcement,
      requireControls: [...requireControls].sort(),
      requireApprovals: [...approvalsByKey.values()],
      contributors: sorted,
      emergencyPolicy,
      autoRollbackOnFailure
    });
  }

  // Stable output order (by name) so callers/tests never depend on Map iteration order.
  return effective.sort((a, b) => a.name.localeCompare(b.name));
}
