import { and, eq, isNull, or } from "drizzle-orm";
import type { ChangeState } from "@scp/schemas";
import type { TenantTx } from "../db/tenant-tx.js";
import { gateBindings } from "../db/schema.js";

/**
 * The gate-binding SEAM (BUILD_AND_TEST.md §8 M3 item 1: "gates are minimal here — M4 adds
 * policy/controls; model the binding seam now"). `coordination/transition.ts`'s guarded
 * transition function calls `evaluateLifecycleGate` on every transition attempt; this queries
 * `gate_bindings` (drizzle/0007_change_coordination.sql — always empty in M3, no API writes to it
 * yet) and, finding no bound controls, returns an `allow` verdict with a reason explaining why.
 * M4 replaces the "always allow" branch with real CEL policy evaluation + control outcomes
 * WITHOUT changing this function's signature or the guarded transition function's call site —
 * that stability is the point of modeling the seam now.
 */
export interface GateVerdict {
  verdict: "allow" | "block";
  reasonTree: Record<string, unknown>;
  inputContext: Record<string, unknown>;
}

export async function evaluateLifecycleGate(
  tx: TenantTx,
  orgId: string,
  fromState: ChangeState,
  toState: ChangeState
): Promise<GateVerdict> {
  const bound = await tx
    .select()
    .from(gateBindings)
    .where(
      and(
        eq(gateBindings.orgId, orgId),
        eq(gateBindings.scopeKind, "lifecycle_edge"),
        eq(gateBindings.fromState, fromState),
        eq(gateBindings.toState, toState)
      )
    );

  if (bound.length === 0) {
    return {
      verdict: "allow",
      inputContext: { fromState, toState, gatesBound: 0 },
      reasonTree: {
        summary: "no gates bound to this transition",
        detail: "M3 models the gate-binding seam only; M4 adds policy/control evaluation."
      }
    };
  }

  // M3 never populates gate_bindings (no write API exists yet), so this branch is unreachable
  // today — kept honest (rather than `unreachable()`-asserted) so M4 can extend it in place.
  return {
    verdict: "allow",
    inputContext: { fromState, toState, gatesBound: bound.length },
    reasonTree: {
      summary: `${bound.length} gate(s) bound but M3 has no control-evaluation engine yet`,
      detail: "M4 (Governance Engine) evaluates bound controls here."
    }
  };
}

/**
 * The wave-boundary counterpart (DESIGN §9.3: "Gates are sets of control bindings... attached to
 * wave boundaries and lifecycle edges"). Used by the reconciliation loop before starting a
 * fan-in-gated wave. Same seam, same M3 behavior.
 */
export async function evaluateWaveGate(
  tx: TenantTx,
  orgId: string,
  topologyObjectId: string | null,
  waveIndex: number
): Promise<GateVerdict> {
  // A change compiled without a release topology (pure depends_on toposort) has nothing to bind
  // a topology-scoped gate against — only "global" wave-boundary gates (topology_object_id IS
  // NULL) can ever apply to it.
  const scopeCondition = topologyObjectId
    ? or(eq(gateBindings.topologyObjectId, topologyObjectId), isNull(gateBindings.topologyObjectId))
    : isNull(gateBindings.topologyObjectId);
  const bound = await tx
    .select()
    .from(gateBindings)
    .where(
      and(
        eq(gateBindings.orgId, orgId),
        eq(gateBindings.scopeKind, "wave_boundary"),
        scopeCondition,
        eq(gateBindings.waveIndex, waveIndex)
      )
    );

  if (bound.length === 0) {
    return {
      verdict: "allow",
      inputContext: { topologyObjectId, waveIndex, gatesBound: 0 },
      reasonTree: { summary: "no gates bound to this wave boundary" }
    };
  }

  return {
    verdict: "allow",
    inputContext: { topologyObjectId, waveIndex, gatesBound: bound.length },
    reasonTree: { summary: `${bound.length} gate(s) bound but M3 has no control-evaluation engine yet` }
  };
}
