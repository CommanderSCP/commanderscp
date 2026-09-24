import { and, asc, eq, isNull, or, sql } from "drizzle-orm";
import { INFRASTRUCTURE_DECLARATION_PROPERTY, type ChangeState } from "@scp/schemas";
import type { TenantTx } from "../db/tenant-tx.js";
import { decisions, gateBindings } from "../db/schema.js";
import { INFRA_PLAN_TRIGGER_GATE } from "./infra-lane-trigger-parameters.js";
import type { PluginHost } from "../plugin-host/contract.js";
import type { CelSandbox } from "../governance/cel-sandbox.js";
import { evaluateGovernanceGate } from "../governance/gate-orchestrator.js";
import type { TargetFreezes } from "../governance/freeze-scope.js";
import { targetObjectIdsOf } from "./changes-repo.js";
import { getObjectByIdOrUrnAnyType } from "../graph/objects-repo.js";
import {
  describePipelineHookGate,
  evaluatePipelineHookGate,
  type HookTriggerRequest,
  type PipelineHookGateContext,
  type PipelineHookGateEntry
} from "./pipeline-hook-gate.js";
import {
  deadTargetInputContext,
  describeDeadTarget,
  DEAD_TARGET_REMEDIATION,
  readTargetLiveness
} from "./target-liveness.js";

/** The gate-binding SEAM. See docs/coordination.md §532. */
export interface GateVerdict {
  verdict: "allow" | "block";
  reasonTree: Record<string, unknown>;
  inputContext: Record<string, unknown>;
  /** Hook tuples the pipeline-hook gate found `awaiting`. See docs/coordination.md §533. */
  pendingHookTriggers?: HookTriggerRequest[] | undefined;
  /** Every active freeze this transition overrode (CRITICAL #2 — possibly several) —
   *  transition.ts writes one high-severity `freeze.override` audit event per entry. */
  freezeOverrides?: { freezeId: string; reason: string; scopeObjectId: string }[] | undefined;
  /** Per-target freeze coverage, as the gate resolved it. See docs/coordination.md §534. */
  frozenTargets?: TargetFreezes[] | undefined;
  /** The declared-hook contributor's per-target verdicts. See docs/coordination.md §535. */
  pipelineHooks?: PipelineHookGateEntry[] | undefined;
}

function allowVerdict(reason: string, extra: Record<string, unknown> = {}): GateVerdict {
  return {
    verdict: "allow",
    inputContext: { gatesBound: 0, ...extra },
    reasonTree: { summary: reason }
  };
}

async function boundControlRefs(
  tx: TenantTx,
  orgId: string,
  where: ReturnType<typeof and>
): Promise<{ controlRefs: string[]; enforcement: string }[]> {
  const bound = await tx.select().from(gateBindings).where(where);
  return bound.map((b) => ({
    controlRefs: (b.controlRefs as string[]) ?? [],
    enforcement: b.enforcement
  }));
}

export interface EvaluateLifecycleGateContext {
  orgId: string;
  fromState: ChangeState;
  toState: ChangeState;
  changeObjectId: string;
  actorObjectId: string;
  emergency: boolean;
  /** True when this Change IS a rollback. See docs/coordination.md §536. */
  isRollback: boolean;
  overrideFreeze?: { reason: string } | undefined;
}

export interface GateDeps {
  sandbox: CelSandbox;
  /** `null` on the API tier (routes/changes.ts's accept handler) — see this file's module doc
   *  and `governance/control-runner.ts` for why the lifecycle-edge gate never needs a live host. */
  host: PluginHost | null;
}

const GOVERNED_LIFECYCLE_EDGES = new Set(["validating->accepted"]);

export async function evaluateLifecycleGate(
  tx: TenantTx,
  ctx: EvaluateLifecycleGateContext,
  deps: GateDeps
): Promise<GateVerdict> {
  const edgeKey = `${ctx.fromState}->${ctx.toState}`;

  // Explicit gate_bindings rows (raw control refs, no policy needed) — still consulted for every
  // edge, same as M3, so an operator retains the direct-binding escape hatch even on edges the
  // policy engine itself doesn't touch.
  const explicitlyBound = await boundControlRefs(
    tx,
    ctx.orgId,
    and(
      eq(gateBindings.orgId, ctx.orgId),
      eq(gateBindings.scopeKind, "lifecycle_edge"),
      eq(gateBindings.fromState, ctx.fromState),
      eq(gateBindings.toState, ctx.toState)
    )
  );

  if (!GOVERNED_LIFECYCLE_EDGES.has(edgeKey)) {
    return allowVerdict(
      explicitlyBound.length === 0
        ? "no gates bound to this transition"
        : `${explicitlyBound.length} gate(s) bound but this edge is not governance-evaluated (M4 scope — see gates.ts)`,
      { gatesBound: explicitlyBound.length }
    );
  }

  const changeObject = await getObjectByIdOrUrnAnyType(tx, ctx.orgId, ctx.changeObjectId);
  const targetObjectIds = targetObjectIdsOf(changeObject.properties as Record<string, unknown>);

  // IS EVERY TARGET THIS CHANGE NAMES STILL THERE? `validating->accepted` is the ONE edge this
  // function governs, and it is reached two ways: a human's `POST /changes/:id/accept`
  // (routes/changes.ts), and reconcile.ts's own auto-accept of a rollback change once its waves
  // succeed. `advanceValidatingChanges` (reconcile.ts) already surfaces a target tombstoned while
  // a change merely SITS in `validating` awaiting that human call — this is the other half: the
  // call itself. Checked BEFORE the rollback exemption below on purpose — this is a factual
  // precondition (is the thing still in the graph?), not a governance policy, so a rollback gets
  // no pass on it either; rolling back to a dead target is exactly as incoherent as accepting a
  // change onto one. Reuses target-liveness.ts's vocabulary verbatim (same helper functions, same
  // remediation text as reconcile.ts's dead-target Decisions) rather than inventing a second way
  // to say "this target is dead". See docs/coordination.md §982-984 (target-liveness.ts) and
  // §1006-1007 (this function's caller, transition.ts).
  for (const targetObjectId of targetObjectIds) {
    const liveness = await readTargetLiveness(tx, ctx.orgId, targetObjectId);
    if (!liveness.live) {
      return {
        verdict: "block",
        inputContext: {
          fromState: ctx.fromState,
          toState: ctx.toState,
          explicitGatesBound: explicitlyBound.length,
          ...deadTargetInputContext(targetObjectId, liveness)
        },
        reasonTree: {
          summary: describeDeadTarget(targetObjectId, liveness),
          remediation: DEAD_TARGET_REMEDIATION
        }
      };
    }
  }

  if (ctx.isRollback) {
    return allowVerdict(
      "rollback changes are exempt from governance at validating->accepted (DESIGN §9.4 — no human-review step to wait for)"
    );
  }

  // SEPARATION OF DUTIES FOR AN INFRASTRUCTURE PLAN (M28.3, ADR-0056 §1a). Accepting an
  // infrastructure PLAN change is approving that plan for apply, and the person who asked for a plan
  // must not be the one who approves it — otherwise "an approved plan" means only "a plan somebody
  // wanted". Ahead of governance, and not a policy an org opts into: it is a property of what this
  // acceptance MEANS, the default every install gets.
  const separation = await infraPlanSeparationOfDuties(tx, ctx, changeObject.properties);
  if (separation) return separation;

  const outcome = await evaluateGovernanceGate(tx, deps.sandbox, deps.host, {
    orgId: ctx.orgId,
    changeObjectId: ctx.changeObjectId,
    targetObjectIds: targetObjectIds.length > 0 ? targetObjectIds : [ctx.changeObjectId],
    actorObjectId: ctx.actorObjectId,
    emergency: ctx.emergency,
    gateKind: "lifecycle_edge",
    gateRef: { fromState: ctx.fromState, toState: ctx.toState },
    overrideFreeze: ctx.overrideFreeze
  });

  return {
    verdict: outcome.verdict,
    inputContext: {
      ...outcome.inputContext,
      fromState: ctx.fromState,
      toState: ctx.toState,
      explicitGatesBound: explicitlyBound.length
    },
    reasonTree: outcome.reasonTree,
    freezeOverrides: outcome.freezeOverrides
  };
}

export interface EvaluateWaveGateContext {
  orgId: string;
  changeObjectId: string;
  actorObjectId: string;
  emergency: boolean;
  topologyObjectId: string | null;
  waveIndex: number;
  targetObjectIds: string[];
  /** True when this Change IS a rollback. See docs/coordination.md §537. */
  isRollback?: boolean | undefined;
  /** Increment 8 — THE THIRD CONTRIBUTOR. See docs/coordination.md §538. */
  pipelineHooks?: Omit<PipelineHookGateContext, "orgId"> | undefined;
}

/** The wave-boundary counterpart. See docs/coordination.md §539. */
export async function evaluateWaveGate(
  tx: TenantTx,
  ctx: EvaluateWaveGateContext,
  deps: GateDeps
): Promise<GateVerdict> {
  const scopeCondition = ctx.topologyObjectId
    ? or(
        eq(gateBindings.topologyObjectId, ctx.topologyObjectId),
        isNull(gateBindings.topologyObjectId)
      )
    : isNull(gateBindings.topologyObjectId);
  const explicitlyBound = await boundControlRefs(
    tx,
    ctx.orgId,
    and(
      eq(gateBindings.orgId, ctx.orgId),
      eq(gateBindings.scopeKind, "wave_boundary"),
      scopeCondition,
      eq(gateBindings.waveIndex, ctx.waveIndex)
    )
  );

  const outcome = await evaluateGovernanceGate(tx, deps.sandbox, deps.host, {
    orgId: ctx.orgId,
    changeObjectId: ctx.changeObjectId,
    targetObjectIds: ctx.targetObjectIds,
    actorObjectId: ctx.actorObjectId,
    emergency: ctx.emergency,
    gateKind: "wave_boundary",
    gateRef: { topologyObjectId: ctx.topologyObjectId, waveIndex: ctx.waveIndex },
    isRollback: ctx.isRollback ?? false
  });

  // THE THIRD CONTRIBUTOR. See docs/coordination.md §540.
  const hookGate = ctx.pipelineHooks
    ? await evaluatePipelineHookGate(tx, { orgId: ctx.orgId, ...ctx.pipelineHooks })
    : undefined;

  const hookBlock = hookGate !== undefined && !hookGate.allowed ? hookGate : undefined;

  return {
    ...(hookGate && hookGate.pendingTriggers.length > 0
      ? { pendingHookTriggers: hookGate.pendingTriggers }
      : {}),
    verdict: outcome.verdict === "block" || hookBlock !== undefined ? "block" : "allow",
    inputContext: {
      ...outcome.inputContext,
      topologyObjectId: ctx.topologyObjectId,
      waveIndex: ctx.waveIndex,
      explicitGatesBound: explicitlyBound.length,
      // NOTHING HERE IS DERIVED FROM A CLOCK. See docs/coordination.md §541.
      ...(hookGate ? { pipelineHooks: hookGate.entries } : {})
    },
    // The hook sentence is always added under its own key. See docs/coordination.md §542.
    reasonTree:
      hookBlock === undefined
        ? outcome.reasonTree
        : {
            ...outcome.reasonTree,
            pipelineHooks: describePipelineHookGate(hookBlock),
            ...(outcome.verdict === "block"
              ? {}
              : {
                  summary: `blocked by declared pipeline hooks: ${describePipelineHookGate(hookBlock)}`
                })
          },
    frozenTargets: outcome.frozenTargets,
    ...(hookGate ? { pipelineHooks: hookGate.entries } : {})
  };
}

/** Who proposed a change — its `propose` transition Decision's actor AND, when a system path
 *  proposed on a subject's behalf, the subject who declared it (`declarationActorId`, a change-source
 *  report's reporter). `undefined` when no such record exists (an imported change, a pruned Decision). */
async function proposersOf(
  tx: TenantTx,
  orgId: string,
  changeObjectId: string
): Promise<string[] | undefined> {
  const [row] = await tx
    .select({ inputContext: decisions.inputContext })
    .from(decisions)
    .where(
      and(
        eq(decisions.orgId, orgId),
        eq(decisions.subjectId, changeObjectId),
        eq(decisions.kind, "transition"),
        sql`${decisions.inputContext} ->> 'trigger' = 'propose'`
      )
    )
    .orderBy(asc(decisions.id))
    .limit(1);
  const ctx = row?.inputContext as Record<string, unknown> | undefined;
  const ids = [ctx?.["actorId"], ctx?.["declarationActorId"]].filter(
    (v): v is string => typeof v === "string"
  );
  return ids.length > 0 ? ids : undefined;
}

/** THE SEPARATION-OF-DUTIES CHECK (ADR-0056 §1a). An infrastructure change that declares no apply is
 *  a PLAN; its acceptor must not be its proposer. An unknown proposer is refused rather than assumed
 *  different — "we could not tell" is not "someone else approved it". */
async function infraPlanSeparationOfDuties(
  tx: TenantTx,
  ctx: EvaluateLifecycleGateContext,
  properties: unknown
): Promise<GateVerdict | undefined> {
  const props = (properties ?? {}) as Record<string, unknown>;
  if (props["type"] !== "infrastructure") return undefined;
  if ((props[INFRASTRUCTURE_DECLARATION_PROPERTY] ?? null) !== null) return undefined;
  // ONLY A PLAN THE LANE ACTUALLY PLANNED — one with a recorded `infra_plan_trigger`. Its acceptance
  // is what an apply is later gated on; an infrastructure change driven by any other executor
  // (a machine-image publication, managed-iac today) is not approving a plan for apply, and its
  // acceptance keeps meaning what it always meant. The managed-iac follow-on records the same
  // trigger and so inherits this check.
  const [planned] = await tx
    .select({ id: decisions.id })
    .from(decisions)
    .where(
      and(
        eq(decisions.orgId, ctx.orgId),
        eq(decisions.subjectId, ctx.changeObjectId),
        eq(decisions.kind, "wave_target"),
        sql`${decisions.inputContext} ->> 'gate' = ${INFRA_PLAN_TRIGGER_GATE}`
      )
    )
    .limit(1);
  if (!planned) return undefined;
  const proposers = await proposersOf(tx, ctx.orgId, ctx.changeObjectId);
  if (proposers !== undefined && !proposers.includes(ctx.actorObjectId)) return undefined;
  const proposer = proposers?.[0];
  return {
    verdict: "block",
    inputContext: {
      fromState: ctx.fromState,
      toState: ctx.toState,
      gate: "infra_plan_separation_of_duties",
      proposerObjectId: proposer ?? null,
      proposerObjectIds: proposers ?? [],
      acceptorObjectId: ctx.actorObjectId
    },
    reasonTree: {
      summary:
        proposer === undefined
          ? "this infrastructure plan has no record of who proposed it, so its acceptance cannot be shown to be someone else's — refusing to treat it as approved"
          : "the proposer of an infrastructure plan cannot also accept it: accepting the plan approves it for apply, and that approval must be someone else's",
      remediation:
        "have a different subject with change:accept at every target accept this plan change"
    }
  };
}
