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
 *  - **`validating -> accepted`** (the one human-callable, already-a-review-gate edge — DESIGN
 *    §9.1's chain deliberately stops here for a human `scp change accept`). This is where a
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
  /** Hook tuples the pipeline-hook gate found `awaiting` — carried OUT of the caller's transaction
   *  so they can be dispatched after it commits (`HookTriggerRequest`). Absent on the
   *  `lifecycle_edge` path, which evaluates no pipeline hooks.
   *
   *  A VERDICT FIELD RATHER THAN A SIDE CHANNEL because the trigger set and the block reason are
   *  the same evaluation's output: a caller that acts on one and drops the other is exactly the
   *  drift this shape exists to prevent — the gate would block on a tuple nothing dispatches. */
  pendingHookTriggers?: HookTriggerRequest[] | undefined;
  /** Every active freeze this transition overrode (CRITICAL #2 — possibly several) —
   *  transition.ts writes one high-severity `freeze.override` audit event per entry. */
  freezeOverrides?: { freezeId: string; reason: string; scopeObjectId: string }[] | undefined;
  /** M25.2 — per-target freeze coverage as the gate resolved it, populated only by
   *  `evaluateWaveGate` (the `lifecycle_edge` path keeps any-target-frozen => block and has no
   *  per-target dimension to report). Carried through from `GateOutcome.frozenTargets`.
   *
   *  DELIBERATELY NOT THE ENFORCEMENT CHANNEL. The wave gate fires ONCE, on `pending -> running`,
   *  so a freeze declared mid-wave never appears here at all — `coordination/reconcile.ts` and
   *  `coordination/campaign-reconcile.ts` each resolve holds themselves, every tick, through
   *  `coordination/freeze-hold.ts`. This field explains a verdict; it does not withhold anything.
   *  Internal TS, never a wire schema. */
  frozenTargets?: TargetFreezes[] | undefined;
  /** Increment 8 — the DECLARED-HOOK contributor's per-(hook x target) verdicts, populated only by
   *  `evaluateWaveGate` and only when the caller supplied `pipelineHooks` context.
   *
   *  INTERNAL TS, NEVER A WIRE SCHEMA — the same posture as `frozenTargets` above. `GateVerdict`
   *  itself lives only in this file and no response schema carries a gate reason, so the reason a
   *  declared hook blocked a wave reaches an operator through the `gate` DECISION's `inputContext`
   *  (which `reconcile.ts` writes from this field) and through `scp change explain` / `scp decision
   *  get`. That satisfies charter principle 6 — a blocked outcome always carries a resolvable
   *  `decision_id` naming its inputs — and an API projection of the hook verdicts is a DELIBERATE
   *  FOLLOW-UP rather than an oversight: adding one is an `openapi.v1.json` + generated-SDK change
   *  that this increment does not make. */
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
  /** True when this Change IS a rollback (`changes.rollback_of_object_id` set) — DESIGN §9.4:
   *  rollback has no human-review step to wait for, so its `validating->accepted` edge is exempt
   *  from governance the same way M3 already auto-accepts it (coordination/reconcile.ts's
   *  `completeExecution`). Without this exemption a required-approval policy on the target would
   *  deadlock every rollback forever — no automatic caller could ever satisfy it. */
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
  /** True when this Change IS a rollback (`changes.rollback_of_object_id` set) — M25.2 / owner
   *  decision D7, and NARROWER than the lifecycle edge's exemption: it lifts the FREEZE block only,
   *  not the gate. Policies, controls and approvals are still evaluated for a rollback's wave.
   *
   *  This field did not exist before M25.2 and its absence was an oversight rather than a decision:
   *  `evaluateLifecycleGate` has exempted rollbacks at `validating->accepted` since M4 (DESIGN
   *  §9.4), but the wave boundary never learned the same fact, so an ALL-frozen wave refused the one
   *  change a freeze most wants to let through — a rollback of a broken release, pinned in place for
   *  the length of the window with `scp change rollback` as the only exit and that exit closed.
   *
   *  Defaults to `false` at every caller that does not set it; campaigns pass `false` explicitly,
   *  because a campaign is not a rollback (campaign rollback mints its own per-member rollback
   *  Changes, and each of those carries this flag on its own wave). */
  isRollback?: boolean | undefined;
  /**
   * Increment 8 — THE THIRD CONTRIBUTOR (team-pipeline-iac D21), beside the `gate_bindings` rows
   * this file already reads and the policy engine's `requireControls`. Declared `postDeploy` /
   * `bakeAlarms` hooks on the components of the PREVIOUS wave, because gating promotion OUT of wave
   * N IS gating entry INTO wave N+1; `postMerge` when there is no previous wave.
   *
   * OPTIONAL, AND ITS ABSENCE MEANS "DO NOT EVALUATE", not "evaluate over nothing". Only
   * `reconcile.ts` supplies it. `campaign-reconcile.ts` calls this same function over CAMPAIGN wave
   * targets — which are member changes, not placements — and there is no component to resolve a
   * hook on there; a fabricated empty context would read as "no hooks declared" and be
   * indistinguishable from a genuine one. Each member change carries its own waves and gets its own
   * hook gate on its own reconcile pass, which is where the hooks actually apply.
   *
   * Everything except `orgId` (taken from `ctx.orgId`) is supplied here, because this adapter has
   * the boundary framing and the caller has the plan.
   */
  pipelineHooks?: Omit<PipelineHookGateContext, "orgId"> | undefined;
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

  // ============================================================================================
  // THE THIRD CONTRIBUTOR — declared pipeline hooks (increment 8)
  // ============================================================================================
  // ADDED BESIDE the other two, never replacing either: the verdict below is the AND of the
  // orchestrator's answer (policies, controls, approvals, freezes) and this one. A component that
  // declares no hooks contributes `allowed: true` with an empty entry list and changes nothing.
  //
  // EVALUATED EVEN WHEN THE ORCHESTRATOR ALREADY BLOCKED, deliberately. The Decision must explain
  // EVERY reason the wave is not moving, or an operator clears the policy block and discovers a
  // second one they were never told about — one round trip per contributor. The cost is bounded by
  // `evaluatePipelineHookGate`'s inertness gate (two indexed existence reads for an org that
  // declares nothing).
  //
  // `awaiting` / `no_source` / `window_not_covered` BLOCK AND KEEP BLOCKING, and that is safe here
  // rather than a deadlock: this gate is re-evaluated on EVERY tick while the wave stays `pending`
  // (only the transition fires once — `gate-orchestrator.ts`: "waiting at a wave boundary can never
  // deadlock the engine"), so an in-flight suite that finishes, or a first alarm report that
  // arrives, is noticed within a tick with no scheduler and no status flip.
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
      // NOTHING HERE IS DERIVED FROM A CLOCK — every entry field is an id, a declared number, or an
      // instant read straight off a stored row (see `PipelineHookGateEntry`). That is what keeps a
      // re-evaluated block byte-identical on every tick so `insertDecisionIfChanged` suppresses it,
      // which is ADR-0024's 1.44 GB/day contract. Omitted entirely when no hook context was
      // supplied, so an unchanged campaign-side Decision keeps exactly the bytes it had.
      ...(hookGate ? { pipelineHooks: hookGate.entries } : {})
    },
    // The hook contributor's sentence is ADDED under its own key, always. `summary` is additionally
    // REPLACED only when the hook gate is the SOLE blocker — an operator reading a Decision whose
    // summary says "no policy blocked this" while the verdict is `block` has been told the opposite
    // of the truth. When the orchestrator blocked too, its summary stands and this rides beside it,
    // so neither reason hides the other.
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
