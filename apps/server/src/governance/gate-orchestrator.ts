import type { TenantTx } from "../db/tenant-tx.js";
import type { PluginHost } from "../plugin-host/contract.js";
import type { CelSandbox } from "./cel-sandbox.js";
import { matchPoliciesForTargets } from "./policy-resolve.js";
import { resolvePolicies } from "./policy-model.js";
import { buildCelContext, evaluateFiredPolicies, resolveFiredPolicies, type PolicyEvaluationContext } from "./evaluate.js";
import { ensureControlRuns, readExistingControlOutcomes } from "./control-runner.js";
import { materializeApprovalRequest, quorumStatus } from "./approvals-repo.js";
import { activeFreezesForScopes, type FreezeRow } from "./freezes-repo.js";
import { hasPermission } from "../authz/resolve.js";
import { forbidden } from "../errors.js";
import { getObjectByIdOrUrnAnyType } from "../graph/objects-repo.js";

/**
 * The orchestrator every gate check (lifecycle-edge AND wave-boundary) funnels through — where
 * freezes, policy resolution, control outcomes, and approval quorum all come together into ONE
 * verdict. `coordination/gates.ts` (M3's seam) is the thin adapter that calls this with the
 * (fromState/toState) or (waveIndex/topologyObjectId) framing the guarded transition
 * function/reconcile loop already speak.
 *
 * **Host-optional by design** (DESIGN §16's api/worker split — a `role=api` process has no
 * `PluginHost`, per `control-runner.ts`'s module doc): pass `host: null` from a call site that
 * cannot run a control inline (the lifecycle-edge gate, called from an HTTP route handler); pass
 * a real `PluginHost` from a call site that can (the wave-boundary gate, called from
 * `coordination/reconcile.ts`, which always has one). With `host: null`, a required control with
 * no existing outcome is simply treated as unsatisfied (blocks) rather than attempted — never a
 * silent pass, and never a synchronous plugin call from the request-serving tier.
 */

export interface GateContext {
  orgId: string;
  changeObjectId: string;
  targetObjectIds: string[];
  actorObjectId: string;
  emergency: boolean;
  gateKind: "lifecycle_edge" | "wave_boundary";
  gateRef: Record<string, unknown>;
  /** Set when the caller is attempting an explicit freeze override (mandatory reason —
   *  DESIGN §10.3). Authorization (`freeze:override`) is checked HERE, before anything else, and
   *  throws 403 on failure — an unauthorized override attempt is a hard authz error, not a
   *  governance "block" verdict (BUILD_AND_TEST.md §8 M4: "unauthorized override 403"). */
  overrideFreeze?: { reason: string } | undefined;
}

export interface GateOutcome {
  verdict: "allow" | "block";
  reasonTree: Record<string, unknown>;
  inputContext: Record<string, unknown>;
  /** Set when an active freeze was overridden — the caller (coordination/transition.ts) writes
   *  the mandatory high-severity audit event for this (DESIGN §10.3: "producing a high-severity
   *  audit event + Decision"). */
  freezeOverride?: { freezeId: string; reason: string } | undefined;
}

async function containmentScopeIdsForTargets(tx: TenantTx, orgId: string, targetObjectIds: string[]): Promise<string[]> {
  // Reuses the exact same containment walk policy-resolve.ts uses internally, but we only need
  // the flat id set here (freeze scoping doesn't care about depth/labels).
  const ids = new Set<string>();
  for (const targetId of targetObjectIds) {
    let current: string | null = targetId;
    let guard = 0;
    while (current && guard < 11) {
      ids.add(current);
      const obj = await tx.query.objects.findFirst({
        where: (t, { eq: eqOp, and: andOp }) => andOp(eqOp(t.orgId, orgId), eqOp(t.id, current as string))
      });
      current = obj?.domainId ?? null;
      guard += 1;
    }
  }
  return [...ids];
}

async function checkFreeze(
  tx: TenantTx,
  ctx: GateContext,
  now: Date
): Promise<{ blocked: FreezeRow | null; override: { freezeId: string; reason: string } | null }> {
  const scopeIds = await containmentScopeIdsForTargets(tx, ctx.orgId, ctx.targetObjectIds);
  const active = await activeFreezesForScopes(tx, ctx.orgId, scopeIds, now);
  if (active.length === 0) return { blocked: null, override: null };

  const freeze = active[0]!;
  if (!ctx.overrideFreeze) return { blocked: freeze, override: null };

  if (!ctx.overrideFreeze.reason.trim()) {
    throw forbidden("freeze override requires a non-empty reason");
  }
  const authorized = await hasPermission(tx, {
    orgId: ctx.orgId,
    subjectObjectId: ctx.actorObjectId,
    permission: "freeze:override",
    scopeObjectId: freeze.scopeObjectId
  });
  if (!authorized) {
    throw forbidden(
      `subject '${ctx.actorObjectId}' lacks 'freeze:override' at scope '${freeze.scopeObjectId}' — cannot override freeze '${freeze.id}'`
    );
  }
  return { blocked: null, override: { freezeId: freeze.id, reason: ctx.overrideFreeze.reason } };
}

/** Every graph fact `governance/evaluate.ts`'s context carries beyond the target itself — MVP
 *  keeps this cheap (direct `owns`/`depends_on` edges only, not transitive closures) since the
 *  named `impact-of`/`owners-of` queries already cover the deep-traversal case for humans; policy
 *  conditions needing more can call those via a future CEL custom function without a context
 *  shape change. */
async function graphFactsFor(tx: TenantTx, orgId: string, targetObjectId: string) {
  const owners = await tx.query.relationships.findMany({
    where: (t, { eq: eqOp, and: andOp, isNull: isNullOp }) =>
      andOp(eqOp(t.orgId, orgId), eqOp(t.typeId, "owns"), eqOp(t.toId, targetObjectId), isNullOp(t.deletedAt))
  });
  const dependents = await tx.query.relationships.findMany({
    where: (t, { eq: eqOp, and: andOp, isNull: isNullOp }) =>
      andOp(eqOp(t.orgId, orgId), eqOp(t.typeId, "depends_on"), eqOp(t.toId, targetObjectId), isNullOp(t.deletedAt))
  });
  return {
    ownerIds: owners.map((o) => o.fromId),
    dependentIds: dependents.map((d) => d.fromId),
    domainIds: []
  };
}

/** Scope-KIND keyword → the `object_types.id` an ancestor of that kind carries. `organization`
 *  is special-cased to the org root object below (whose id === orgId). */
const APPROVAL_SCOPE_KEYWORDS: Record<string, "organization" | "domain" | "service" | "component"> = {
  organization: "organization",
  org: "organization",
  domain: "domain",
  service: "service",
  component: "component"
};

/**
 * Resolves a `requireApprovals.scope` value (MAJOR #5). DESIGN §10.1's own example writes a scope
 * KIND keyword (`"scope":"service"`), meaning "someone holding `fromRole` at the change target's
 * containing object of that kind"; an author may equally pass a literal object id/urn. Returns the
 * concrete object id the approval quorum's `hasRoleAtScope` check will run against, or `null` when
 * the scope can't be resolved (unknown keyword, a keyword with no ancestor of that kind on the
 * target's chain, or a literal ref that doesn't resolve) — the caller treats `null` as an
 * UNSATISFIABLE required approval (fail closed), never a raw `::uuid` cast crash and never a pass.
 */
export async function resolveApprovalScope(
  tx: TenantTx,
  orgId: string,
  primaryTargetId: string | undefined,
  scope: string
): Promise<string | null> {
  const keyword = APPROVAL_SCOPE_KEYWORDS[scope.trim().toLowerCase()];
  if (keyword) {
    if (keyword === "organization") return orgId; // org root object id === orgId (bootstrap invariant)
    // Walk the primary target's containment chain, nearest first, for an object of the given kind.
    if (!primaryTargetId) return null;
    let current: string | null = primaryTargetId;
    let guard = 0;
    while (current && guard < 11) {
      const obj: { id: string; typeId: string; domainId: string | null } | undefined =
        await tx.query.objects.findFirst({
          where: (t, { eq: eqOp, and: andOp }) => andOp(eqOp(t.orgId, orgId), eqOp(t.id, current as string))
        });
      if (!obj) return null;
      if (obj.typeId === keyword) return obj.id;
      current = obj.domainId;
      guard += 1;
    }
    return null;
  }
  // Not a keyword — must be a literal object id or urn. Validate it resolves to a real object.
  try {
    const obj = await getObjectByIdOrUrnAnyType(tx, orgId, scope);
    return obj.id;
  } catch {
    return null;
  }
}

/**
 * Runs (never blocks, never writes a Decision) every required control a change's targets'
 * effective policies reference, and materializes every requireApprovals effect's approval
 * request — so that by the time a HUMAN calls `POST /changes/{id}/promote` (the host-less
 * lifecycle-edge gate, `coordination/gates.ts`'s module doc), the outcomes it needs to READ
 * already exist. Called by `coordination/reconcile.ts` once per tick for every change sitting in
 * `validating` (the only state a required-control-bearing policy could otherwise starve forever,
 * since nothing else ever calls `evaluate()` for those controls). Deliberately does NOT insert a
 * Decision on every tick — that's reserved for an actual gate verdict a transition attempt
 * consulted (module doc's "never a silent pass" applies to CONTROL OUTCOMES, not to this
 * warm-up's own bookkeeping) — a change sitting in `validating` for hours would otherwise pollute
 * the Decision log with one redundant "still blocked" entry per ~1s tick.
 */
export async function prewarmGovernanceForChange(
  tx: TenantTx,
  sandbox: CelSandbox,
  host: PluginHost,
  input: { orgId: string; changeObjectId: string; targetObjectIds: string[]; actorObjectId: string }
): Promise<void> {
  const matches = await matchPoliciesForTargets(tx, {
    orgId: input.orgId,
    targetObjectIds: input.targetObjectIds,
    actorObjectId: input.actorObjectId
  });
  const effectivePolicies = resolvePolicies(matches);
  if (effectivePolicies.length === 0) return;

  // Determine the FIRING set (each contributor's own condition, independently — evaluate.ts's
  // `resolveFiredPolicies`), then pre-run/materialize only what firing policies actually require.
  // Uses the SAME subject + graph facts the real gate does (graphFactsFor) so prewarm and the
  // eventual host-less lifecycle gate agree on which conditions fired — otherwise a control the
  // real gate needs but prewarm never ran would starve the promote gate (which only READS).
  const primaryTarget = input.targetObjectIds[0];
  const subjectObject = primaryTarget ? await getObjectByIdOrUrnAnyType(tx, input.orgId, primaryTarget).catch(() => null) : null;
  const graphFacts = primaryTarget
    ? await graphFactsFor(tx, input.orgId, primaryTarget)
    : { ownerIds: [], dependentIds: [], domainIds: [] };
  const celContext = buildCelContext({
    change: { id: input.changeObjectId, emergency: false, targets: input.targetObjectIds, sourceKind: null, correlationKey: null },
    subject: subjectObject
      ? { id: subjectObject.id, typeId: subjectObject.typeId, name: subjectObject.name, labels: subjectObject.labels }
      : null,
    graph: graphFacts,
    controlOutcomes: {},
    approvals: {},
    time: new Date().toISOString(),
    actor: { id: input.actorObjectId }
  });
  const fired = (await resolveFiredPolicies(sandbox, effectivePolicies, celContext)).filter((fp) => fp.fired);

  const allControlIds = [...new Set(fired.flatMap((fp) => fp.requireControls))];
  if (allControlIds.length > 0) {
    await ensureControlRuns(tx, host, {
      orgId: input.orgId,
      changeObjectId: input.changeObjectId,
      controlObjectIds: allControlIds,
      gateKind: "lifecycle_edge",
      gateRef: { fromState: "validating", toState: "promoted" },
      context: { changeId: input.changeObjectId, targetObjectIds: input.targetObjectIds }
    });
  }

  for (const fp of fired) {
    for (const req of fp.requireApprovals) {
      const scopeObjectId = await resolveApprovalScope(tx, input.orgId, primaryTarget, req.scope);
      if (!scopeObjectId) continue; // unresolvable scope — the gate itself fails it closed (MAJOR #5)
      await materializeApprovalRequest(tx, {
        orgId: input.orgId,
        changeObjectId: input.changeObjectId,
        policyObjectId: req.originPolicyObjectId,
        policyVersion: req.originPolicyVersion,
        effectIndex: req.originEffectIndex,
        requiredCount: req.count,
        fromRole: req.fromRole,
        scopeObjectId
      });
    }
  }
}

export async function evaluateGovernanceGate(
  tx: TenantTx,
  sandbox: CelSandbox,
  host: PluginHost | null,
  ctx: GateContext
): Promise<GateOutcome> {
  const now = new Date();

  const freezeCheck = await checkFreeze(tx, ctx, now);
  if (freezeCheck.blocked) {
    return {
      verdict: "block",
      inputContext: { freeze: { id: freezeCheck.blocked.id, endsAt: freezeCheck.blocked.endsAt.toISOString() } },
      reasonTree: {
        summary: `blocked by active freeze '${freezeCheck.blocked.name ?? freezeCheck.blocked.id}' (${freezeCheck.blocked.reason})`,
        freeze: freezeCheck.blocked
      }
    };
  }

  const matches = await matchPoliciesForTargets(tx, {
    orgId: ctx.orgId,
    targetObjectIds: ctx.targetObjectIds,
    actorObjectId: ctx.actorObjectId
  });
  let effectivePolicies = resolvePolicies(matches);

  // Emergency changes follow a CONFIGURED emergency policy instead of the normal required set
  // (DESIGN §10.3) — never a blanket bypass. If the org has configured no `emergencyPolicy: true`
  // document, an emergency change proceeds ungated (verdict allow) but this is fully visible in
  // the reason tree/Decision either way — "everything still audited, retrospective Decision
  // trail produced" doesn't depend on something having blocked.
  let emergencyNote: string | undefined;
  if (ctx.emergency) {
    const emergencyPolicies = effectivePolicies.filter((p) => p.emergencyPolicy);
    if (emergencyPolicies.length > 0) {
      effectivePolicies = emergencyPolicies;
      emergencyNote = `emergency change: evaluating only the ${emergencyPolicies.length} configured emergency polic${emergencyPolicies.length === 1 ? "y" : "ies"} (${emergencyPolicies.map((p) => p.name).join(", ")}), normal required policies bypassed`;
    } else {
      emergencyNote = "emergency change: no emergencyPolicy configured for this org — proceeding ungated (fully audited)";
      effectivePolicies = [];
    }
  }

  const primaryTarget = ctx.targetObjectIds[0];
  const subjectObject = primaryTarget ? await getObjectByIdOrUrnAnyType(tx, ctx.orgId, primaryTarget).catch(() => null) : null;
  const graphFacts = primaryTarget
    ? await graphFactsFor(tx, ctx.orgId, primaryTarget)
    : { ownerIds: [], dependentIds: [], domainIds: [] };
  const celContext = buildCelContext({
    change: { id: ctx.changeObjectId, emergency: ctx.emergency, targets: ctx.targetObjectIds, sourceKind: null, correlationKey: null },
    subject: subjectObject
      ? { id: subjectObject.id, typeId: subjectObject.typeId, name: subjectObject.name, labels: subjectObject.labels }
      : null,
    graph: graphFacts,
    controlOutcomes: {},
    approvals: {},
    time: now.toISOString(),
    actor: { id: ctx.actorObjectId }
  });

  // Phase 1: per-contributor condition evaluation (CRITICAL #1a) — a false/erroring contributor's
  // condition can NEVER drop a firing higher-scope required contributor's effects. Fail-closed for
  // a required contributor whose condition errors (MAJOR #3) is baked into `resolveFiredPolicies`.
  const fired = await resolveFiredPolicies(sandbox, effectivePolicies, celContext);

  // Only run/materialize what the FIRING policies require (never the "if everything fired" summary).
  const allControlIds = [...new Set(fired.filter((fp) => fp.fired).flatMap((fp) => fp.requireControls))];
  const controlOutcomes = host
    ? await ensureControlRuns(tx, host, {
        orgId: ctx.orgId,
        changeObjectId: ctx.changeObjectId,
        controlObjectIds: allControlIds,
        gateKind: ctx.gateKind,
        gateRef: ctx.gateRef,
        context: { changeId: ctx.changeObjectId, targetObjectIds: ctx.targetObjectIds, gateRef: ctx.gateRef }
      })
    : await readExistingControlOutcomes(tx, ctx.orgId, ctx.changeObjectId, allControlIds);

  const approvals: PolicyEvaluationContext["approvals"] = {};
  for (const fp of fired) {
    if (!fp.fired) continue;
    for (const req of fp.requireApprovals) {
      const key = `${req.originPolicyObjectId}::${req.originPolicyVersion}::${req.originEffectIndex}`;
      // MAJOR #5: `req.scope` may be a scope-KIND keyword (DESIGN §10.1's `"scope":"service"`) or a
      // literal object id/urn. Resolve it to a concrete object; an unresolvable scope is
      // fail-CLOSED (the required approval can never be satisfied → blocks), NEVER a raw ::uuid
      // Postgres crash and NEVER a silent pass.
      const scopeObjectId = await resolveApprovalScope(tx, ctx.orgId, primaryTarget, req.scope);
      if (!scopeObjectId) {
        approvals[key] = { satisfied: false, count: 0, required: req.count };
        continue;
      }
      const request = await materializeApprovalRequest(tx, {
        orgId: ctx.orgId,
        changeObjectId: ctx.changeObjectId,
        policyObjectId: req.originPolicyObjectId,
        policyVersion: req.originPolicyVersion,
        effectIndex: req.originEffectIndex,
        requiredCount: req.count,
        fromRole: req.fromRole,
        scopeObjectId
      });
      approvals[key] = await quorumStatus(tx, ctx.orgId, request);
    }
  }

  // Phase 2: pure satisfaction check against the now-gathered outcomes/quorum, using the SAME
  // firing set (no second CEL eval — no race where a re-eval fires differently).
  const result = evaluateFiredPolicies(fired, { controlOutcomes, approvals });

  return {
    verdict: result.verdict === "block" ? "block" : "allow",
    inputContext: {
      matchedPolicyCount: matches.length,
      effectivePolicyCount: effectivePolicies.length,
      firedPolicyCount: fired.filter((fp) => fp.fired).length,
      ...(emergencyNote ? { emergency: emergencyNote } : {}),
      ...(freezeCheck.override ? { freezeOverride: freezeCheck.override } : {})
    },
    reasonTree: { ...result.reasonTree, ...(emergencyNote ? { emergencyNote } : {}) },
    freezeOverride: freezeCheck.override ?? undefined
  };
}
