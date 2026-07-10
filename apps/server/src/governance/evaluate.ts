/**
 * The policy evaluator (DESIGN.md §10.1: "Evaluation is a PURE function (context in → verdict +
 * reason tree out), so explainability is the return value"). Takes an already-resolved,
 * already-merged set of `EffectivePolicy` (policy-model.ts's stricter-wins output) plus a fully
 * pre-gathered `PolicyEvaluationContext` snapshot — NO database access, NO plugin calls happen in
 * this file — and produces a verdict deterministically. The only asynchronous work is the CEL
 * sandbox call itself (governance/cel-sandbox.ts), which is itself side-effect-free and
 * deterministic for a given (expression, context) pair — so "pure" here means "same context
 * snapshot in ⇒ same verdict + reason tree out, always, with no observable side effect", exactly
 * BUILD_AND_TEST.md §8 M4's unit DoD ("same context snapshot ⇒ same verdict + reason tree,
 * property-tested"), not "synchronous".
 */
import type { CelSandbox } from "./cel-sandbox.js";
import { isAtLeastAsStrict, type ControlOutcomeStatusLike, type EffectivePolicy } from "./policy-model.js";

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
  kind: "requireControls" | "requireApprovals";
  satisfied: boolean;
  detail: Record<string, unknown>;
}

export interface PolicyEvaluationEntry {
  name: string;
  enforcement: EffectivePolicy["enforcement"];
  fired: boolean;
  conditionResult: "no-condition" | "true" | "false" | "error";
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

function celContextOf(context: PolicyEvaluationContext): Record<string, unknown> {
  // Flat, JSON-plain — exactly what crosses into the worker thread (cel-sandbox.ts never receives
  // anything beyond this). Deliberately excludes nothing sensitive since policy context itself
  // carries no secrets (DESIGN §10.1's documented context shape).
  return {
    change: context.change,
    subject: context.subject ?? {},
    graph: context.graph,
    time: context.time,
    actor: context.actor
  };
}

function controlKey(controlRef: string): string {
  return controlRef;
}

function effectKey(policyObjectId: string, policyVersion: number, effectIndex: number): string {
  return `${policyObjectId}::${policyVersion}::${effectIndex}`;
}

/**
 * Evaluates every `EffectivePolicy` against `context` using `sandbox` for CEL conditions.
 * Contributing policy-object-ids/versions from each `EffectivePolicy`'s `contributors` are
 * threaded through into the per-entry result so a Decision built from this can cite the EXACT
 * document versions consulted (DESIGN §10.4).
 */
export async function evaluateGovernance(
  sandbox: CelSandbox,
  effectivePolicies: EffectivePolicy[],
  context: PolicyEvaluationContext
): Promise<GovernanceEvaluationResult> {
  const celCtx = celContextOf(context);
  const entries: PolicyEvaluationEntry[] = [];

  for (const policy of effectivePolicies) {
    let fired = true;
    let conditionResult: PolicyEvaluationEntry["conditionResult"] = "no-condition";
    let conditionError: string | undefined;

    // Every contributor's own condition must ALSO be considered — a merged policy's CEL condition
    // is the AND of every level's condition (a domain instance narrowing WHEN the org-level
    // requirement applies is "adding strictness" too: it can only make the merged policy fire in
    // a NARROWER set of circumstances, never a broader one, since it's ANDed in).
    for (const contributor of policy.contributors) {
      if (!contributor.condition) continue;
      const result = await sandbox.evaluate(contributor.condition, celCtx);
      if (!result.ok) {
        fired = false;
        conditionResult = "error";
        conditionError = result.error;
        break;
      }
      if (result.value !== true) {
        fired = false;
        conditionResult = "false";
        break;
      }
      conditionResult = "true";
    }

    const effects: EffectSatisfaction[] = [];
    if (fired) {
      for (const controlId of policy.requireControls) {
        const outcome = context.controlOutcomes[controlKey(controlId)];
        effects.push({
          kind: "requireControls",
          satisfied: outcome === "pass",
          detail: { controlObjectId: controlId, outcome: outcome ?? "not-run" }
        });
      }
      for (const approval of policy.requireApprovals) {
        // Keyed by the WINNING contributor's own document coordinates (policy-model.ts's
        // `EffectiveApprovalRequirement`) — exactly what `governance/approvals-repo.ts`
        // materializes `approval_requests` rows under, so this lookup and that materialization
        // always agree on the same key for the same requirement.
        const key = effectKey(approval.originPolicyObjectId, approval.originPolicyVersion, approval.originEffectIndex);
        const status = context.approvals[key];
        effects.push({
          kind: "requireApprovals",
          satisfied: status?.satisfied ?? false,
          detail: { ...approval, count: status?.count ?? 0, key }
        });
      }
    }

    const satisfied = !fired || effects.every((e) => e.satisfied);
    entries.push({
      name: policy.name,
      enforcement: policy.enforcement,
      fired,
      conditionResult,
      conditionError,
      effects,
      satisfied,
      contributingPolicyVersions: policy.contributors.map((c) => ({
        policyObjectId: c.policyObjectId,
        policyVersion: c.policyVersion
      }))
    });
  }

  // A required, fired, unsatisfied policy blocks; a recommended/advisory unsatisfied one only
  // warns (DESIGN §10.1/§9.3: "advisory/recommended controls annotate but never block").
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
