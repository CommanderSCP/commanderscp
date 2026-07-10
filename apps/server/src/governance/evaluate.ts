/**
 * The policy evaluator (DESIGN.md §10.1: "Evaluation is a PURE function (context in → verdict +
 * reason tree out), so explainability is the return value").
 *
 * Split into two phases (adversarial-review CRITICAL #1a / MAJOR #3):
 *
 *  1. `resolveFiredPolicies` — evaluates EACH contributor's CEL condition INDEPENDENTLY (never an
 *     AND across a name-group's contributors) and unions the effects of ONLY the contributors
 *     whose own condition fired. A higher-scope required contributor that fires has its effects
 *     enforced no matter what any other same-named contributor's condition did. A REQUIRED
 *     contributor whose condition ERRORS or TIMES OUT fails CLOSED (the group fires and blocks with
 *     a Decision naming the eval failure) — never fail-open. Advisory/recommended contributors
 *     whose condition errors are annotated and skipped. This is the only place the CEL sandbox is
 *     called; it needs no control-outcome/approval data, so a gate can run this FIRST to learn what
 *     to actually run/materialize.
 *  2. `evaluateFiredPolicies` — a PURE function over the already-resolved firing set plus a fully
 *     pre-gathered control-outcome/approval snapshot: same snapshot in ⇒ same verdict + reason tree
 *     out, always (BUILD_AND_TEST.md §8 M4's unit DoD).
 *
 * `evaluateGovernance` composes the two for callers that want one call (the unit tests, the
 * `policy-evaluate` dry-run). The gate orchestrator (governance/gate-orchestrator.ts) drives the
 * two phases separately so the firing set determines exactly which controls run and which approval
 * requests materialize.
 */
import type { CelSandbox } from "./cel-sandbox.js";
import {
  isAtLeastAsStrict,
  maxEnforcement,
  mergeContributorEffects,
  type ControlOutcomeStatusLike,
  type EffectiveApprovalRequirement,
  type EffectivePolicy,
  type MatchedPolicy,
  type PolicyEnforcement
} from "./policy-model.js";

export type { EffectivePolicy } from "./policy-model.js";

export interface PolicyEvaluationContext {
  change: {
    id: string;
    emergency: boolean;
    targets: string[];
    sourceKind: string | null;
    correlationKey: string | null;
  };
  /** The primary object this evaluation concerns (a wave target, or the change's first target for
   *  a lifecycle-edge gate) — DESIGN §10.1's "subject object". */
  subject: { id: string; typeId: string; name: string; labels: Record<string, unknown> } | null;
  /** Graph facts (DESIGN §10.1): owners/dependents/domains of the subject — MVP carries ids only
   *  (enough for `size(graph.ownerIds) > 0`-style conditions); richer shapes are additive later. */
  graph: { ownerIds: string[]; dependentIds: string[]; domainIds: string[] };
  /** Latest known outcome per control object id, gathered before evaluation began. */
  controlOutcomes: Record<string, ControlOutcomeStatusLike>;
  /** Keyed by `${policyObjectId}::${policyVersion}::${effectIndex}` (matches
   *  `approval_requests`' own dedup key) — pre-computed quorum status per requireApprovals effect. */
  approvals: Record<string, { satisfied: boolean; count: number; required: number }>;
  time: string; // ISO 8601 snapshot — never `new Date()` called inside evaluation itself
  actor: { id: string };
}

export interface EffectSatisfaction {
  /** `conditionError` is the fail-closed synthetic effect for a REQUIRED contributor whose CEL
   *  condition could not be evaluated (parse error / timeout) — always `satisfied: false`. */
  kind: "requireControls" | "requireApprovals" | "conditionError";
  satisfied: boolean;
  detail: Record<string, unknown>;
}

export type ConditionResultKind = "no-condition" | "true" | "false" | "error";

/** One name-group after per-contributor condition evaluation — the authoritative, condition-aware
 *  effect set (NOT `EffectivePolicy`'s summary union). */
export interface FiredPolicy {
  name: string;
  /** True if any contributor fired, OR a required contributor's condition failed to evaluate
   *  (fail closed). A non-firing group contributes nothing to the verdict. */
  fired: boolean;
  /** Max enforcement across the FIRING contributors — plus at least `required` when a required
   *  contributor's condition erroring forced the group to fire closed. */
  enforcement: PolicyEnforcement;
  requireControls: string[];
  requireApprovals: EffectiveApprovalRequirement[];
  contributingPolicyVersions: Array<{ policyObjectId: string; policyVersion: number }>;
  conditionResult: ConditionResultKind;
  conditionError?: string;
  /** Set when a REQUIRED contributor's condition failed to evaluate — the group fires and blocks. */
  requiredConditionEvalError?: { policyObjectId: string; policyVersion: number; error: string };
}

export interface PolicyEvaluationEntry {
  name: string;
  enforcement: PolicyEnforcement;
  fired: boolean;
  conditionResult: ConditionResultKind;
  conditionError?: string;
  effects: EffectSatisfaction[];
  satisfied: boolean;
  contributingPolicyVersions: Array<{ policyObjectId: string; policyVersion: number }>;
}

export type GovernanceVerdict = "allow" | "warn" | "block";

export interface GovernanceEvaluationResult {
  verdict: GovernanceVerdict;
  policies: PolicyEvaluationEntry[];
  reasonTree: Record<string, unknown>;
}

/** Flat, JSON-plain — exactly what crosses into the worker thread (cel-sandbox.ts never receives
 *  anything beyond this). Exported so gate-orchestrator.ts can build it once and reuse it for the
 *  firing phase. */
export function buildCelContext(context: PolicyEvaluationContext): Record<string, unknown> {
  return {
    change: context.change,
    subject: context.subject ?? {},
    graph: context.graph,
    time: context.time,
    actor: context.actor
  };
}

function effectKey(policyObjectId: string, policyVersion: number, effectIndex: number): string {
  return `${policyObjectId}::${policyVersion}::${effectIndex}`;
}

/**
 * Phase 1 — evaluate each contributor's condition independently (see module doc). NO control /
 * approval data needed; the returned `requireControls`/`requireApprovals` are exactly what a gate
 * must run/materialize. `celContext` is `buildCelContext(context)` (built once by the caller).
 */
export async function resolveFiredPolicies(
  sandbox: CelSandbox,
  effectivePolicies: EffectivePolicy[],
  celContext: Record<string, unknown>
): Promise<FiredPolicy[]> {
  const out: FiredPolicy[] = [];
  for (const policy of effectivePolicies) {
    const firing: MatchedPolicy[] = [];
    let requiredConditionEvalError: FiredPolicy["requiredConditionEvalError"];
    let firstError: string | undefined;
    let sawFalse = false;

    for (const contributor of policy.contributors) {
      if (!contributor.condition) {
        firing.push(contributor);
        continue;
      }
      const result = await sandbox.evaluate(contributor.condition, celContext);
      if (!result.ok) {
        firstError ??= result.error;
        // MAJOR #3: a REQUIRED contributor whose condition can't be evaluated (parse error OR
        // timeout) must FAIL CLOSED — the group fires and blocks. Advisory/recommended: annotate
        // (captured in `conditionError`) and simply don't fire, per DESIGN's "advisory annotates".
        if (isAtLeastAsStrict(contributor.enforcement, "required")) {
          requiredConditionEvalError ??= {
            policyObjectId: contributor.policyObjectId,
            policyVersion: contributor.policyVersion,
            error: result.error
          };
        }
        continue;
      }
      if (result.value === true) {
        firing.push(contributor);
      } else {
        sawFalse = true;
      }
    }

    const merged = mergeContributorEffects(firing);
    const firingEnforcement = maxEnforcement(firing.map((c) => c.enforcement));
    const enforcement = requiredConditionEvalError
      ? maxEnforcement([firingEnforcement, "required"])
      : firingEnforcement;
    const fired = firing.length > 0 || requiredConditionEvalError != null;

    const counted = [...firing];
    if (
      requiredConditionEvalError &&
      !counted.some((c) => c.policyObjectId === requiredConditionEvalError!.policyObjectId)
    ) {
      const errored = policy.contributors.find(
        (c) =>
          c.policyObjectId === requiredConditionEvalError!.policyObjectId &&
          c.policyVersion === requiredConditionEvalError!.policyVersion
      );
      if (errored) counted.push(errored);
    }

    const conditionResult: ConditionResultKind = requiredConditionEvalError
      ? "error"
      : firing.some((c) => c.condition)
        ? "true"
        : firing.length > 0
          ? "no-condition"
          : firstError !== undefined
            ? "error"
            : sawFalse
              ? "false"
              : "no-condition";

    out.push({
      name: policy.name,
      fired,
      enforcement,
      requireControls: merged.requireControls,
      requireApprovals: merged.requireApprovals,
      contributingPolicyVersions: counted.map((c) => ({ policyObjectId: c.policyObjectId, policyVersion: c.policyVersion })),
      conditionResult,
      ...(firstError !== undefined ? { conditionError: firstError } : {}),
      ...(requiredConditionEvalError ? { requiredConditionEvalError } : {})
    });
  }
  return out;
}

/**
 * Phase 2 — PURE: check each fired policy's effects against the gathered control-outcome / approval
 * snapshot and produce the verdict. A required, fired, unsatisfied policy blocks; a
 * recommended/advisory unsatisfied one only warns (DESIGN §10.1/§9.3). A required contributor's
 * condition-eval error is an unsatisfiable synthetic effect (fail closed).
 */
export function evaluateFiredPolicies(
  firedPolicies: FiredPolicy[],
  context: Pick<PolicyEvaluationContext, "controlOutcomes" | "approvals">
): GovernanceEvaluationResult {
  const entries: PolicyEvaluationEntry[] = firedPolicies.map((fp) => {
    if (!fp.fired) {
      return {
        name: fp.name,
        enforcement: fp.enforcement,
        fired: false,
        conditionResult: fp.conditionResult,
        ...(fp.conditionError !== undefined ? { conditionError: fp.conditionError } : {}),
        effects: [],
        satisfied: true,
        contributingPolicyVersions: fp.contributingPolicyVersions
      };
    }

    const effects: EffectSatisfaction[] = [];
    if (fp.requiredConditionEvalError) {
      effects.push({
        kind: "conditionError",
        satisfied: false,
        detail: {
          policyObjectId: fp.requiredConditionEvalError.policyObjectId,
          policyVersion: fp.requiredConditionEvalError.policyVersion,
          error: fp.requiredConditionEvalError.error,
          reason: "required policy condition failed to evaluate — failing closed (never allow on a broken/timed-out required condition)"
        }
      });
    }
    for (const controlId of fp.requireControls) {
      const outcome = context.controlOutcomes[controlId];
      effects.push({
        kind: "requireControls",
        satisfied: outcome === "pass",
        detail: { controlObjectId: controlId, outcome: outcome ?? "not-run" }
      });
    }
    for (const approval of fp.requireApprovals) {
      const key = effectKey(approval.originPolicyObjectId, approval.originPolicyVersion, approval.originEffectIndex);
      const status = context.approvals[key];
      effects.push({
        kind: "requireApprovals",
        satisfied: status?.satisfied ?? false,
        detail: { ...approval, count: status?.count ?? 0, key }
      });
    }

    return {
      name: fp.name,
      enforcement: fp.enforcement,
      fired: true,
      conditionResult: fp.conditionResult,
      ...(fp.conditionError !== undefined ? { conditionError: fp.conditionError } : {}),
      effects,
      satisfied: effects.every((e) => e.satisfied),
      contributingPolicyVersions: fp.contributingPolicyVersions
    };
  });

  const blocking = entries.filter((e) => e.fired && !e.satisfied && isAtLeastAsStrict(e.enforcement, "required"));
  const warning = entries.filter((e) => e.fired && !e.satisfied && !isAtLeastAsStrict(e.enforcement, "required"));
  const verdict: GovernanceVerdict = blocking.length > 0 ? "block" : warning.length > 0 ? "warn" : "allow";

  return {
    verdict,
    policies: entries,
    reasonTree: {
      summary:
        verdict === "block"
          ? `blocked by ${blocking.length} required polic${blocking.length === 1 ? "y" : "ies"}: ${blocking.map((b) => b.name).join(", ")}`
          : verdict === "warn"
            ? `allowed with ${warning.length} unmet advisory/recommended polic${warning.length === 1 ? "y" : "ies"}: ${warning.map((w) => w.name).join(", ")}`
            : "allowed — every fired required policy is satisfied",
      policies: entries
    }
  };
}

/**
 * One-call composition of the two phases — the unit tests and the `policy-evaluate` dry-run use
 * this. "Pure" here means "same context snapshot ⇒ same verdict + reason tree, always, with no
 * observable side effect" (the only async work is the deterministic, side-effect-free CEL sandbox
 * call), exactly BUILD_AND_TEST.md §8 M4's unit DoD.
 */
export async function evaluateGovernance(
  sandbox: CelSandbox,
  effectivePolicies: EffectivePolicy[],
  context: PolicyEvaluationContext
): Promise<GovernanceEvaluationResult> {
  const fired = await resolveFiredPolicies(sandbox, effectivePolicies, buildCelContext(context));
  return evaluateFiredPolicies(fired, context);
}
