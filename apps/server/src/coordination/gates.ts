import { and, eq, isNull, or } from "drizzle-orm";
import type { ChangeState } from "@scp/schemas";
import type { TenantTx } from "../db/tenant-tx.js";
import { gateBindings } from "../db/schema.js";
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

  if (ctx.isRollback) {
    return allowVerdict(
      "rollback changes are exempt from governance at validating->accepted (DESIGN §9.4 — no human-review step to wait for)"
    );
  }

  const changeObject = await getObjectByIdOrUrnAnyType(tx, ctx.orgId, ctx.changeObjectId);
  const targetObjectIds = targetObjectIdsOf(changeObject.properties as Record<string, unknown>);

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
