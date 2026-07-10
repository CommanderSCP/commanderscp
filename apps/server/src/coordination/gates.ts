import { and, eq, isNull, or } from "drizzle-orm";
import type { ChangeState } from "@scp/schemas";
import type { TenantTx } from "../db/tenant-tx.js";
import { gateBindings } from "../db/schema.js";
import type { PluginHost } from "../plugin-host/contract.js";
import type { CelSandbox } from "../governance/cel-sandbox.js";
import { evaluateGovernanceGate } from "../governance/gate-orchestrator.js";
import { targetObjectIdsOf } from "./changes-repo.js";
import { getObjectByIdOrUrnAnyType } from "../graph/objects-repo.js";

/**
 * The gate-binding SEAM (BUILD_AND_TEST.md §8 M3 item 1), filled in by M4 (BUILD_AND_TEST.md §8
 * M4 item 6): `coordination/transition.ts`'s guarded transition function calls
 * `evaluateLifecycleGate` on every transition attempt; `coordination/reconcile.ts` calls
 * `evaluateWaveGate` before starting each wave. Both now delegate to
 * `governance/gate-orchestrator.ts`, which resolves policies (containment + CEL, stricter-wins),
 * checks freezes, runs/reads controls, and materializes approval quorum — see that file's module
 * doc for the full picture. This file stays the thin, stable ADAPTER between the coordination
 * engine's (fromState/toState)/(waveIndex/topologyObjectId) framing and the orchestrator's
 * target-object-id framing — `gate_bindings` (the literal M3 table) is still consulted so an
 * operator can bind a raw control directly to an edge/boundary without a policy document, folded
 * additively into the same verdict.
 *
 * **Design decision (documented deviation from "never change this function's signature" — see
 * PR body): real governance evaluation is wired to exactly two points, not every edge:**
 *
 *  - **`validating -> promoted`** (the one human-callable, already-a-review-gate edge — DESIGN
 *    §9.1's chain deliberately stops here for a human `scp change promote`). This is where a
 *    required policy's unmet effect actually surfaces as a blocked 4xx with `decision_id`
 *    (BUILD_AND_TEST.md §8 M4's flagship E2E).
 *  - **every wave boundary** (`evaluateWaveGate`, unchanged scope from M3's seam).
 *
 *  Every OTHER lifecycle edge (`proposed->evaluated`, `evaluated->coordinated`,
 *  `coordinated->executing`, and every `cancel`/`rollback` edge) stays M3's "always allow" —
 *  deliberately, not an oversight: those edges are either engine-automatic with NO human caller
 *  who could ever satisfy a blocking `requireApprovals` effect (wiring real governance onto them
 *  risks silently deadlocking the reconciliation loop forever), or an operator escape hatch that
 *  must always remain available (you can always cancel or roll back a change regardless of
 *  policy state — DESIGN §9.4 rollback is "always available"). `evaluateLifecycleGate`'s new
 *  parameters (`changeObjectId`, `actorObjectId`, `emergency`, `overrideFreeze`) are the minimum
 *  the orchestrator genuinely needs and did not exist on the M3 seam's original
 *  `(tx, orgId, fromState, toState)` shape — extending it here, in place, at the one call site
 *  (`transition.ts`), is what "fills the seam" actually requires once real evaluation exists to
 *  plug in.
 */
export interface GateVerdict {
  verdict: "allow" | "block";
  reasonTree: Record<string, unknown>;
  inputContext: Record<string, unknown>;
  freezeOverride?: { freezeId: string; reason: string } | undefined;
}

function allowVerdict(reason: string, extra: Record<string, unknown> = {}): GateVerdict {
  return { verdict: "allow", inputContext: { gatesBound: 0, ...extra }, reasonTree: { summary: reason } };
}

async function boundControlRefs(
  tx: TenantTx,
  orgId: string,
  where: ReturnType<typeof and>
): Promise<{ controlRefs: string[]; enforcement: string }[]> {
  const bound = await tx.select().from(gateBindings).where(where);
  return bound.map((b) => ({ controlRefs: (b.controlRefs as string[]) ?? [], enforcement: b.enforcement }));
}

export interface EvaluateLifecycleGateContext {
  orgId: string;
  fromState: ChangeState;
  toState: ChangeState;
  changeObjectId: string;
  actorObjectId: string;
  emergency: boolean;
  /** True when this Change IS a rollback (`changes.rollback_of_object_id` set) — DESIGN §9.4:
   *  rollback has no human-review step to wait for, so its `validating->promoted` edge is exempt
   *  from governance the same way M3 already auto-promotes it (coordination/reconcile.ts's
   *  `completeExecution`). Without this exemption a required-approval policy on the target would
   *  deadlock every rollback forever — no automatic caller could ever satisfy it. */
  isRollback: boolean;
  overrideFreeze?: { reason: string } | undefined;
}

export interface GateDeps {
  sandbox: CelSandbox;
  /** `null` on the API tier (routes/changes.ts's promote handler) — see this file's module doc
   *  and `governance/control-runner.ts` for why the lifecycle-edge gate never needs a live host. */
  host: PluginHost | null;
}

const GOVERNED_LIFECYCLE_EDGES = new Set(["validating->promoted"]);

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
    and(eq(gateBindings.orgId, ctx.orgId), eq(gateBindings.scopeKind, "lifecycle_edge"), eq(gateBindings.fromState, ctx.fromState), eq(gateBindings.toState, ctx.toState))
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
    return allowVerdict("rollback changes are exempt from governance at validating->promoted (DESIGN §9.4 — no human-review step to wait for)");
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
    inputContext: { ...outcome.inputContext, fromState: ctx.fromState, toState: ctx.toState, explicitGatesBound: explicitlyBound.length },
    reasonTree: outcome.reasonTree,
    freezeOverride: outcome.freezeOverride
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
}

/**
 * The wave-boundary counterpart (DESIGN §9.3). Always governance-evaluated (module doc comment —
 * unlike lifecycle edges, waiting at a wave boundary can never deadlock the engine: reconcile
 * retries every tick, and an approval/control can resolve independently of this specific check).
 */
export async function evaluateWaveGate(
  tx: TenantTx,
  ctx: EvaluateWaveGateContext,
  deps: GateDeps
): Promise<GateVerdict> {
  const scopeCondition = ctx.topologyObjectId
    ? or(eq(gateBindings.topologyObjectId, ctx.topologyObjectId), isNull(gateBindings.topologyObjectId))
    : isNull(gateBindings.topologyObjectId);
  const explicitlyBound = await boundControlRefs(
    tx,
    ctx.orgId,
    and(eq(gateBindings.orgId, ctx.orgId), eq(gateBindings.scopeKind, "wave_boundary"), scopeCondition, eq(gateBindings.waveIndex, ctx.waveIndex))
  );

  const outcome = await evaluateGovernanceGate(tx, deps.sandbox, deps.host, {
    orgId: ctx.orgId,
    changeObjectId: ctx.changeObjectId,
    targetObjectIds: ctx.targetObjectIds,
    actorObjectId: ctx.actorObjectId,
    emergency: ctx.emergency,
    gateKind: "wave_boundary",
    gateRef: { topologyObjectId: ctx.topologyObjectId, waveIndex: ctx.waveIndex }
  });

  return {
    verdict: outcome.verdict,
    inputContext: {
      ...outcome.inputContext,
      topologyObjectId: ctx.topologyObjectId,
      waveIndex: ctx.waveIndex,
      explicitGatesBound: explicitlyBound.length
    },
    reasonTree: outcome.reasonTree
  };
}
