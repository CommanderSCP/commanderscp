import type { TenantTx } from "../db/tenant-tx.js";
import type { PluginHost } from "../plugin-host/contract.js";
import type { CelSandbox } from "./cel-sandbox.js";
import { matchPoliciesForTargets } from "./policy-resolve.js";
import { resolvePolicies, type MatchedPolicy } from "./policy-model.js";
import {
  buildCelContext,
  evaluateFiredPolicies,
  resolveFiredPolicies,
  type FiredPolicy,
  type PolicyEvaluationContext
} from "./evaluate.js";
import { ensureControlRuns, readExistingControlOutcomes } from "./control-runner.js";
import { scanExclusionSetChangedForGate } from "./scan-exclusion-actuator.js";
import { materializeApprovalRequest, quorumStatus } from "./approvals-repo.js";
import {
  freezesByTarget,
  rollbackExemptible,
  unionFreezes,
  type EffectiveFreeze,
  type TargetFreezes
} from "./freeze-scope.js";
import { hasPermission } from "../authz/resolve.js";
import { containmentChain, nearestAncestorOfKind } from "../graph/containment.js";
import { getObjectByIdOrUrnAnyType, getOrgRootObjectId } from "../graph/objects-repo.js";
import { getChangeRow } from "../coordination/changes-repo.js";
import { ociDigestsOfSourceRef } from "../coordination/artifact-facts.js";
import {
  resolveEffectiveScanExclusionsForTargets,
  resolveEffectiveScanThreshold
} from "./scan-requirements.js";
import type { EffectiveScanExclusions, EffectiveScanThreshold } from "@scp/schemas";

/** The orchestrator every gate check. See docs/governance.md §100. */

export interface GateContext {
  orgId: string;
  changeObjectId: string;
  targetObjectIds: string[];
  actorObjectId: string;
  emergency: boolean;
  gateKind: "lifecycle_edge" | "wave_boundary";
  gateRef: Record<string, unknown>;
  /** Set when the caller attempts an explicit override. See docs/governance.md §101. */
  overrideFreeze?: { reason: string } | undefined;
  /** This change is a rollback, so a freeze does not hold. See docs/governance.md §102. */
  isRollback?: boolean | undefined;
}

/** One active freeze successfully overridden — `coordination/transition.ts` writes one
 *  high-severity `freeze.override` audit event per entry (DESIGN §10.3). */
export interface FreezeOverride {
  freezeId: string;
  reason: string;
  scopeObjectId: string;
}

export interface GateOutcome {
  verdict: "allow" | "block";
  reasonTree: Record<string, unknown>;
  inputContext: Record<string, unknown>;
  /** Every active freeze that was overridden (CRITICAL #2 — possibly several) — the caller writes
   *  one mandatory high-severity audit event each (DESIGN §10.3). Empty/undefined when nothing was
   *  overridden. */
  freezeOverrides?: FreezeOverride[] | undefined;
  /** Per-target freeze coverage, populated only at the wave. See docs/governance.md §103. */
  frozenTargets?: TargetFreezes[] | undefined;
}

/** CRITICAL #2 / MAJOR #6. See docs/governance.md §104. */
async function checkFreeze(
  tx: TenantTx,
  ctx: GateContext,
  byTarget: TargetFreezes[]
): Promise<
  | { blocked: null; overrides: FreezeOverride[] }
  | { blocked: { freeze: EffectiveFreeze; reason: string }; overrides: null }
> {
  // The union of per-target freezes replaces the scope query. See docs/governance.md §105.
  const active = unionFreezes(byTarget);
  if (active.length === 0) return { blocked: null, overrides: [] };

  const overrides: FreezeOverride[] = [];
  // Resolved AT MOST ONCE, and only if an overridable platform freeze is actually reached — see
  // `overrideScopeOf`. `getOrgRootObjectId` throws for an org with no root object, which must not
  // become an error on a path that would otherwise have simply blocked.
  let orgRootObjectId: string | null = null;

  for (const freeze of active) {
    const label = freezeLabel(freeze);

    // M25.3 — THE PLATFORM TIER'S OVERRIDE RULING. See docs/governance.md §106.
    if (freeze.tier === "platform" && !freeze.overridable) {
      return {
        blocked: {
          freeze,
          reason:
            `active platform freeze '${label}' (${freeze.reason}) — declared by this deployment's ` +
            `operator and binding every organization on it; no tenant role can override it, ` +
            `however privileged. Lift or shorten it with DELETE or PUT ` +
            `/v1/instance/freezes/${freeze.key}, which requires the deployment operator token`
        },
        overrides: null
      };
    }

    if (!ctx.overrideFreeze) {
      return {
        blocked: { freeze, reason: `active freeze '${label}' (${freeze.reason})` },
        overrides: null
      };
    }
    if (!ctx.overrideFreeze.reason.trim()) {
      return {
        blocked: { freeze, reason: `freeze override of '${label}' requires a non-empty reason` },
        overrides: null
      };
    }
    // WHERE `freeze:override` IS CHECKED. Org tier. See docs/governance.md §107.
    if (freeze.tier === "platform" && orgRootObjectId === null) {
      orgRootObjectId = await getOrgRootObjectId(tx, ctx.orgId);
    }
    const scopeObjectId = freeze.tier === "platform" ? orgRootObjectId! : freeze.scopeObjectId;
    const authorized = await hasPermission(tx, {
      orgId: ctx.orgId,
      subjectObjectId: ctx.actorObjectId,
      permission: "freeze:override",
      scopeObjectId
    });
    if (!authorized) {
      return {
        blocked: {
          freeze,
          reason:
            freeze.tier === "platform"
              ? `subject '${ctx.actorObjectId}' lacks 'freeze:override' at the org root '${scopeObjectId}' — cannot override the operator-admitted platform freeze '${label}'`
              : `subject '${ctx.actorObjectId}' lacks 'freeze:override' at scope '${scopeObjectId}' — cannot override freeze '${label}'`
        },
        overrides: null
      };
    }
    overrides.push({
      freezeId: freeze.id,
      reason: ctx.overrideFreeze.reason,
      scopeObjectId
    });
  }
  return { blocked: null, overrides };
}

/** The operator-facing name of a freeze from either tier. An org freeze falls back to its uuid
 *  when unnamed; a platform freeze always has a `key` (its `PUT`/`DELETE` path segment), which is
 *  what an operator recognises and what the remedy sentence has to quote. */
function freezeLabel(freeze: EffectiveFreeze): string {
  return freeze.tier === "platform" ? (freeze.name ?? freeze.key) : (freeze.name ?? freeze.id);
}

/** The scope a freeze was DECLARED at, for the block Decision and reason tree. `null` at the
 *  platform tier and that null is the honest answer: object ids do not exist across orgs, which is
 *  precisely why that tier addresses a stage coordinate instead (`freezeMatchOf`). */
function freezeScopeOf(freeze: EffectiveFreeze): string | null {
  return freeze.tier === "platform" ? null : freeze.scopeObjectId;
}

/** WHAT a platform freeze matched, for the block Decision — the replacement for `scopeObjectId` at
 *  a tier that has none. `null` for an org freeze, whose scope IS its address. */
function freezeMatchOf(
  freeze: EffectiveFreeze
): { allEnvironments: boolean; environment: string | null; region: string | null } | null {
  if (freeze.tier !== "platform") return null;
  return {
    allEnvironments: freeze.matchAllEnvironments,
    environment: freeze.matchEnvironment,
    region: freeze.matchRegion
  };
}

/** The object a condition should see as its subject. See docs/governance.md §108. */
async function governanceSubjectOf(
  tx: TenantTx,
  orgId: string,
  targetObjectId: string
): Promise<string> {
  const row = await tx.query.objects.findFirst({
    where: (t, { eq: eqOp, and: andOp, isNull: isNullOp }) =>
      andOp(eqOp(t.orgId, orgId), eqOp(t.id, targetObjectId), isNullOp(t.deletedAt))
  });
  if (row?.typeId !== "placement") return targetObjectId;
  // Read from the PROPERTIES. See docs/governance.md §109.
  const componentId = (row.properties as { componentId?: unknown } | null)?.componentId;
  return typeof componentId === "string" && UUID_PATTERN.test(componentId)
    ? componentId
    : targetObjectId;
}

/** Mirrors `graph/containment.ts`'s `UUID_TEXT_PATTERN` — the same shape check on the same field,
 *  one in SQL and one in TypeScript because the two guards sit on either side of the DB boundary. */
const UUID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** Every graph fact the context carries beyond the target. See docs/governance.md §110. */
async function graphFactsFor(tx: TenantTx, orgId: string, targetObjectId: string) {
  const owners = await tx.query.relationships.findMany({
    where: (t, { eq: eqOp, and: andOp, isNull: isNullOp }) =>
      andOp(
        eqOp(t.orgId, orgId),
        eqOp(t.typeId, "owns"),
        eqOp(t.toId, targetObjectId),
        isNullOp(t.deletedAt)
      )
  });
  const dependents = await tx.query.relationships.findMany({
    where: (t, { eq: eqOp, and: andOp, isNull: isNullOp }) =>
      andOp(
        eqOp(t.orgId, orgId),
        eqOp(t.typeId, "depends_on"),
        eqOp(t.toId, targetObjectId),
        isNullOp(t.deletedAt)
      )
  });
  return {
    ownerIds: owners.map((o) => o.fromId),
    dependentIds: dependents.map((d) => d.fromId),
    domainIds: []
  };
}

/** Scope keyword to the object type an ancestor carries. See docs/governance.md §111. */
const APPROVAL_SCOPE_KEYWORDS: Record<
  string,
  "organization" | "domain" | "service" | "assembly" | "component"
> = {
  organization: "organization",
  org: "organization",
  domain: "domain",
  service: "service",
  assembly: "assembly",
  component: "component"
};

/** Resolves a `requireApprovals.scope` value. See docs/governance.md §112. */
export async function resolveApprovalScope(
  tx: TenantTx,
  orgId: string,
  primaryTargetId: string | undefined,
  scope: string
): Promise<string | null> {
  const keyword = APPROVAL_SCOPE_KEYWORDS[scope.trim().toLowerCase()];
  if (keyword) {
    if (keyword === "organization") return orgId; // org root object id === orgId (bootstrap invariant)
    if (!primaryTargetId) return null;
    // The target's containment chain, walked by BOTH routes. See docs/governance.md §113.
    const chain = await containmentChain(tx, orgId, primaryTargetId);
    return nearestAncestorOfKind(chain, keyword)?.id ?? null;
  }
  // Not a keyword — must be a literal object id or urn. Validate it resolves to a real object.
  try {
    const obj = await getObjectByIdOrUrnAnyType(tx, orgId, scope);
    return obj.id;
  } catch {
    return null;
  }
}

/** The digest the change is PROMOTING. See docs/governance.md §114. */
async function resolveChangeArtifactDigest(
  tx: TenantTx,
  orgId: string,
  changeObjectId: string
): Promise<string | undefined> {
  const row = await getChangeRow(tx, orgId, changeObjectId).catch(() => null);
  return artifactDigestOfSourceRef(row?.sourceRef ?? {});
}

/** The row-free half of {@link resolveChangeArtifactDigest}. See docs/governance.md §115. */
export function artifactDigestOfSourceRef(sourceRef: unknown): string | undefined {
  return ociDigestsOfSourceRef(sourceRef ?? {}).find((d) => d.length > 0);
}

/** M10.4 (`github-check` ControlPlugin). See docs/governance.md §116. */
async function resolveChangeCommitSha(
  tx: TenantTx,
  orgId: string,
  changeObjectId: string
): Promise<string | undefined> {
  const row = await getChangeRow(tx, orgId, changeObjectId).catch(() => null);
  return commitShaOfSourceRef(row?.sourceRef ?? {});
}

/** The row-free half, and the one definition of which sha. See docs/governance.md §117. */
export function commitShaOfSourceRef(sourceRefValue: unknown): string | undefined {
  const sourceRef = (sourceRefValue ?? {}) as Record<string, unknown>;
  const direct =
    sourceRef.commit_sha ??
    sourceRef.commitSha ??
    sourceRef.sha ??
    sourceRef.after ??
    sourceRef.checkout_sha;
  if (typeof direct === "string" && direct.length > 0) return direct;
  const headCommit = sourceRef.head_commit as { id?: unknown } | undefined;
  if (headCommit && typeof headCommit.id === "string" && headCommit.id.length > 0)
    return headCommit.id;
  return undefined;
}

/** The single control-run context shape both gate sites. See docs/governance.md §118. */
function buildControlContext(input: {
  changeId: string;
  targetObjectIds: string[];
  gateRef?: Record<string, unknown>;
  artifactDigest?: string | undefined;
  commitSha?: string | undefined;
  scanThreshold?: EffectiveScanThreshold | undefined;
  scanExclusions?: EffectiveScanExclusions | undefined;
}): Record<string, unknown> {
  return {
    changeId: input.changeId,
    targetObjectIds: input.targetObjectIds,
    ...(input.gateRef ? { gateRef: input.gateRef } : {}),
    ...(input.artifactDigest ? { artifactDigest: input.artifactDigest } : {}),
    ...(input.commitSha ? { commitSha: input.commitSha } : {}),
    ...(input.scanThreshold ? { scanThreshold: input.scanThreshold } : {}),
    ...(input.scanExclusions ? { scanExclusions: input.scanExclusions } : {})
  };
}

/** The resolved exclusion set, shaped for the Decision. See docs/governance.md §119. */
function scanExclusionsForDecision(
  resolved: EffectiveScanExclusions | undefined
): { scanExclusions: Record<string, unknown> } | undefined {
  if (!resolved || resolved.clauses.length === 0) return undefined;
  return {
    scanExclusions: {
      clauses: resolved.clauses.map((c) => ({
        class: c.clause.class,
        tier: c.tier,
        source: c.source,
        ...(c.clause.vulnerabilityId ? { vulnerabilityId: c.clause.vulnerabilityId } : {}),
        ...(c.clause.pkgName ? { pkgName: c.clause.pkgName } : {}),
        ...(c.clause.purl ? { purl: c.clause.purl } : {}),
        ...(c.clause.findingClass ? { findingClass: c.clause.findingClass } : {}),
        ...(c.clause.reason ? { reason: c.clause.reason } : {}),
        admittedBy: c.admittedBy.map((a) => ({ tier: a.tier, source: a.source }))
      })),
      // The facts the vendor rule was resolved against. See docs/governance.md §120.
      ...(resolved.vendorLatest
        ? {
            vendorLatest: {
              baseImageAtLatest: resolved.vendorLatest.baseImageAtLatest,
              packageKeys: resolved.vendorLatest.packageKeys
            }
          }
        : {}),
      // M22.5 (ADR-0033 §6 guard 2) — THE DECLARED VALUE, VERBATIM. See docs/governance.md §121.
      ...(resolved.declaredFacts && resolved.declaredFacts.declarations.length > 0
        ? {
            declaredFacts: resolved.declaredFacts.declarations.map((d) => ({
              key: d.key,
              value: d.value
            }))
          }
        : {}),
      // Every applied exclusion must name its clause and tier. See docs/governance.md §122.
      ...(resolved.approvedOverrides && resolved.approvedOverrides.grants.length > 0
        ? {
            approvedOverrides: resolved.approvedOverrides.grants.map((g) => ({
              grantObjectId: g.grantObjectId,
              vulnerabilityId: g.vulnerabilityId,
              ...(g.pkgName ? { pkgName: g.pkgName } : {}),
              tierObjectId: g.tierObjectId,
              // M22.6 (D3) — the DERIVED tier of that object, not the id the requester wrote down.
              // The id alone told an auditor which object was named; the tier is what the grant was
              // actually measured at, and the pair is what makes "under authority of X" checkable.
              grantTier: g.tier,
              expiresAt: g.expiresAt
            }))
          }
        : {}),
      // M22.6 (D3) — THE BAR, and every grant it refused. Recorded whether or not any grant survived,
      // because "no exclusion applied" and "a live grant was refused for authority" are different
      // facts and only the second one tells an operator why their approved waiver did nothing. Both
      // are content-only and already sorted by the resolver, so write suppression still holds.
      ...(resolved.approvedOverrides?.requiredTier
        ? { overrideRequiredTier: resolved.approvedOverrides.requiredTier }
        : {}),
      ...(resolved.approvedOverrides?.refusedForAuthority &&
      resolved.approvedOverrides.refusedForAuthority.length > 0
        ? {
            overridesRefusedForAuthority: resolved.approvedOverrides.refusedForAuthority.map(
              (r) => ({
                grantObjectId: r.grantObjectId,
                ...(r.tier ? { tier: r.tier } : {}),
                reason: r.reason
              })
            )
          }
        : {})
    }
  };
}

/** M22.0 (ADR-0033 §11; charter principle 6). See docs/governance.md §123. */
function scanThresholdForDecision(
  resolved: EffectiveScanThreshold | undefined
): { scanThreshold: Record<string, unknown> } | undefined {
  if (!resolved) return undefined;
  const contributors = resolved.contributors
    .map((c) => ({
      tier: c.tier,
      source: c.source,
      ...(c.objectTypeId ? { objectTypeId: c.objectTypeId } : {}),
      threshold: c.threshold
    }))
    .map((entry) => ({ entry, key: JSON.stringify(entry) }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .map(({ entry }) => entry);
  return { scanThreshold: { effective: resolved.threshold, contributors } };
}

/** Which policies fire for a change's targets, callable. See docs/governance.md §124. */
export async function resolveFiredPoliciesForTargets(
  tx: TenantTx,
  sandbox: Pick<CelSandbox, "evaluate">,
  input: {
    orgId: string;
    changeObjectId: string;
    targetObjectIds: string[];
    actorObjectId: string;
    emergency: boolean;
    now: Date;
  }
): Promise<{ matches: MatchedPolicy[]; fired: FiredPolicy[] }> {
  const matches = await matchPoliciesForTargets(tx, {
    orgId: input.orgId,
    targetObjectIds: input.targetObjectIds,
    actorObjectId: input.actorObjectId
  });
  let effectivePolicies = resolvePolicies(matches);
  // Same substitution the gate makes (DESIGN §10.3): an emergency change follows the CONFIGURED
  // emergency policies, and an org that configured none evaluates nothing. Omitting this here would
  // have made the managed scan the one path an emergency change could not relax — a divergence in
  // the opposite direction from the one this function exists to close.
  if (input.emergency) {
    const emergencyPolicies = effectivePolicies.filter((p) => p.emergencyPolicy);
    effectivePolicies = emergencyPolicies;
  }

  const primaryTarget = input.targetObjectIds[0];
  const primarySubject = primaryTarget
    ? await governanceSubjectOf(tx, input.orgId, primaryTarget)
    : undefined;
  const subjectObject = primarySubject
    ? await getObjectByIdOrUrnAnyType(tx, input.orgId, primarySubject).catch(() => null)
    : null;
  const graphFacts = primarySubject
    ? await graphFactsFor(tx, input.orgId, primarySubject)
    : { ownerIds: [], dependentIds: [], domainIds: [] };
  const celContext = buildCelContext({
    change: {
      id: input.changeObjectId,
      emergency: input.emergency,
      targets: input.targetObjectIds,
      sourceKind: null,
      correlationKey: null
    },
    subject: subjectObject
      ? {
          id: subjectObject.id,
          typeId: subjectObject.typeId,
          name: subjectObject.name,
          labels: subjectObject.labels
        }
      : null,
    graph: graphFacts,
    controlOutcomes: {},
    approvals: {},
    time: input.now.toISOString(),
    actor: { id: input.actorObjectId }
  });

  const fired = await resolveFiredPolicies(sandbox, effectivePolicies, celContext);
  return { matches, fired };
}

/** Runs every required control without blocking or writing. See docs/governance.md §125. */
export async function prewarmGovernanceForChange(
  tx: TenantTx,
  sandbox: CelSandbox,
  host: PluginHost,
  input: {
    orgId: string;
    changeObjectId: string;
    targetObjectIds: string[];
    actorObjectId: string;
    /** Materialize firing policies' approval requests. See docs/governance.md §126. */
    materializeApprovals?: boolean;
  }
): Promise<void> {
  const matches = await matchPoliciesForTargets(tx, {
    orgId: input.orgId,
    targetObjectIds: input.targetObjectIds,
    actorObjectId: input.actorObjectId
  });
  const effectivePolicies = resolvePolicies(matches);
  if (effectivePolicies.length === 0) return;

  // Determine the FIRING set. See docs/governance.md §127.
  const primaryTarget = input.targetObjectIds[0];
  // ADR-0026: a placement's SUBJECT is the component it places. See docs/governance.md §128.
  const primarySubject = primaryTarget
    ? await governanceSubjectOf(tx, input.orgId, primaryTarget)
    : undefined;
  const subjectObject = primarySubject
    ? await getObjectByIdOrUrnAnyType(tx, input.orgId, primarySubject).catch(() => null)
    : null;
  const graphFacts = primarySubject
    ? await graphFactsFor(tx, input.orgId, primarySubject)
    : { ownerIds: [], dependentIds: [], domainIds: [] };
  const celContext = buildCelContext({
    change: {
      id: input.changeObjectId,
      emergency: false,
      targets: input.targetObjectIds,
      sourceKind: null,
      correlationKey: null
    },
    subject: subjectObject
      ? {
          id: subjectObject.id,
          typeId: subjectObject.typeId,
          name: subjectObject.name,
          labels: subjectObject.labels
        }
      : null,
    graph: graphFacts,
    controlOutcomes: {},
    approvals: {},
    time: new Date().toISOString(),
    actor: { id: input.actorObjectId }
  });
  const fired = (await resolveFiredPolicies(sandbox, effectivePolicies, celContext)).filter(
    (fp) => fp.fired
  );

  const allControlIds = [...new Set(fired.flatMap((fp) => fp.requireControls))];
  if (allControlIds.length > 0) {
    const artifactDigest = await resolveChangeArtifactDigest(tx, input.orgId, input.changeObjectId);
    const commitSha = await resolveChangeCommitSha(tx, input.orgId, input.changeObjectId);
    // M17.5: `matches` is already gathered above — hand it to the resolver so the six-tier MIN
    // costs no extra policy round-trip.
    const scanThreshold = await resolveEffectiveScanThreshold(tx, {
      orgId: input.orgId,
      targetObjectIds: input.targetObjectIds,
      actorObjectId: input.actorObjectId,
      matches,
      // M17.5 fix: ceilings come from the FIRED set only — same `fired` that decided
      // `allControlIds`, so a conditional scan-requirement policy whose condition was false
      // cannot tighten anything here either.
      firedPolicies: fired
    });
    // The exclusion dimension, through the same mechanism. See docs/governance.md §129.
    const scanExclusions = await resolveEffectiveScanExclusionsForTargets(tx, {
      orgId: input.orgId,
      targetObjectIds: input.targetObjectIds,
      actorObjectId: input.actorObjectId,
      matches,
      // FIRED ONLY, and never the ceiling's key set: an unevaluable condition must yield NO
      // exclusion (ADR-0033 §4 — the opposite sign from `ceilingContributorKeys`).
      firedPolicies: fired
    });
    // The actuator, at the site whose run is cached and reread. See docs/governance.md §130.
    const gateRef = { fromState: "validating", toState: "accepted" };
    const force = await scanExclusionSetChangedForGate(tx, {
      orgId: input.orgId,
      changeObjectId: input.changeObjectId,
      controlObjectIds: allControlIds,
      gateKind: "lifecycle_edge",
      gateRef,
      exclusions: scanExclusions
    });
    await ensureControlRuns(tx, host, {
      orgId: input.orgId,
      changeObjectId: input.changeObjectId,
      controlObjectIds: allControlIds,
      gateKind: "lifecycle_edge",
      gateRef,
      force,
      context: buildControlContext({
        changeId: input.changeObjectId,
        targetObjectIds: input.targetObjectIds,
        artifactDigest,
        commitSha,
        scanThreshold,
        scanExclusions
      })
    });
  }

  if (input.materializeApprovals === false) return;
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

  // M25.2 — PER-TARGET FREEZE ADMISSION. See docs/governance.md §131.
  const byTarget = await freezesByTarget(tx, ctx.orgId, ctx.targetObjectIds, now);
  const frozenIds = byTarget.filter((e) => e.freezes.length > 0).map((e) => e.targetObjectId);

  // Partial admission: some targets covered, some not. See docs/governance.md §132.
  const partiallyFrozen =
    ctx.gateKind === "wave_boundary" &&
    frozenIds.length > 0 &&
    frozenIds.length < ctx.targetObjectIds.length &&
    byTarget.every((e) => e.freezes.every((f) => !f.atomic));

  // THE ROLLBACK EXEMPTION. See docs/governance.md §133.
  const freezeExemptRollback =
    ctx.gateKind === "wave_boundary" &&
    ctx.isRollback === true &&
    rollbackExemptible(byTarget.flatMap((e) => e.freezes));
  const freezeCheck = await checkFreeze(tx, ctx, byTarget);
  if (freezeCheck.blocked && !partiallyFrozen && !freezeExemptRollback) {
    // Both a plain freeze block and a REJECTED override (missing reason / unauthorized for some
    // active freeze) land here as a "block" verdict — the caller (transition.ts) writes the
    // Decision + audit with `decision_id`, never a rolled-back raw 403 (MAJOR #6).
    const { freeze, reason } = freezeCheck.blocked;
    return {
      verdict: "block",
      ...(ctx.gateKind === "wave_boundary" ? { frozenTargets: byTarget } : {}),
      inputContext: {
        // Tier and match are additive, both load-bearing. See docs/governance.md §134.
        freeze: {
          id: freeze.id,
          tier: freeze.tier,
          scopeObjectId: freezeScopeOf(freeze),
          match: freezeMatchOf(freeze),
          endsAt: freeze.endsAt.toISOString()
        },
        ...(ctx.overrideFreeze ? { overrideRejected: reason } : {})
      },
      reasonTree: {
        summary: ctx.overrideFreeze
          ? `freeze override rejected: ${reason}`
          : `blocked by ${reason}`,
        freeze: {
          id: freeze.id,
          tier: freeze.tier,
          name: freeze.name,
          scopeObjectId: freezeScopeOf(freeze),
          match: freezeMatchOf(freeze),
          reason: freeze.reason
        }
      }
    };
  }

  const matches = await matchPoliciesForTargets(tx, {
    orgId: ctx.orgId,
    targetObjectIds: ctx.targetObjectIds,
    actorObjectId: ctx.actorObjectId
  });
  let effectivePolicies = resolvePolicies(matches);

  // Emergency changes follow a configured policy instead. See docs/governance.md §135.
  const freezeNote =
    freezeExemptRollback && freezeCheck.blocked
      ? `rollback exempt from ${frozenIds.length} ORG-tier frozen target(s): ${freezeCheck.blocked.reason} (DESIGN §9.4 / owner decision D7 — holding a rollback pins a broken release in place for the whole window; a PLATFORM freeze is never stood aside this way, see rollbackExemptible)`
      : undefined;

  let emergencyNote: string | undefined;
  if (ctx.emergency) {
    const emergencyPolicies = effectivePolicies.filter((p) => p.emergencyPolicy);
    if (emergencyPolicies.length > 0) {
      effectivePolicies = emergencyPolicies;
      emergencyNote = `emergency change: evaluating only the ${emergencyPolicies.length} configured emergency polic${emergencyPolicies.length === 1 ? "y" : "ies"} (${emergencyPolicies.map((p) => p.name).join(", ")}), normal required policies bypassed`;
    } else {
      emergencyNote =
        "emergency change: no emergencyPolicy configured for this org — proceeding ungated (fully audited)";
      effectivePolicies = [];
    }
  }

  const primaryTarget = ctx.targetObjectIds[0];
  // A wave target may be a placement, whose subject differs. See docs/governance.md §136.
  const primarySubject = primaryTarget
    ? await governanceSubjectOf(tx, ctx.orgId, primaryTarget)
    : undefined;
  const subjectObject = primarySubject
    ? await getObjectByIdOrUrnAnyType(tx, ctx.orgId, primarySubject).catch(() => null)
    : null;
  const graphFacts = primarySubject
    ? await graphFactsFor(tx, ctx.orgId, primarySubject)
    : { ownerIds: [], dependentIds: [], domainIds: [] };
  const celContext = buildCelContext({
    change: {
      id: ctx.changeObjectId,
      emergency: ctx.emergency,
      targets: ctx.targetObjectIds,
      sourceKind: null,
      correlationKey: null
    },
    subject: subjectObject
      ? {
          id: subjectObject.id,
          typeId: subjectObject.typeId,
          name: subjectObject.name,
          labels: subjectObject.labels
        }
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
  const allControlIds = [
    ...new Set(fired.filter((fp) => fp.fired).flatMap((fp) => fp.requireControls))
  ];
  // The six-tier most-restrictive-wins scan ceiling. See docs/governance.md §137.
  const effectiveScanThreshold = await resolveEffectiveScanThreshold(tx, {
    orgId: ctx.orgId,
    targetObjectIds: ctx.targetObjectIds,
    actorObjectId: ctx.actorObjectId,
    matches,
    firedPolicies: fired
  });

  // M22.2 — resolved beside the ceiling, and UNCONDITIONALLY for the same reason M22.0 hoisted the
  // ceiling out of the `host` ternary: the `validating -> accepted` edge runs with `host: null`, and
  // a Decision that named the rule but not the exceptions in force would be exactly half an
  // explanation on the surface an operator resolves by `decision_id`.
  const effectiveScanExclusions = await resolveEffectiveScanExclusionsForTargets(tx, {
    orgId: ctx.orgId,
    targetObjectIds: ctx.targetObjectIds,
    actorObjectId: ctx.actorObjectId,
    matches,
    firedPolicies: fired
  });

  // M22.7 — the actuator at the EVALUATE site. See docs/governance.md §138.
  const scanExclusionsChanged = host
    ? await scanExclusionSetChangedForGate(tx, {
        orgId: ctx.orgId,
        changeObjectId: ctx.changeObjectId,
        controlObjectIds: allControlIds,
        gateKind: ctx.gateKind,
        gateRef: ctx.gateRef,
        exclusions: effectiveScanExclusions
      })
    : false;

  const controlOutcomes = host
    ? await ensureControlRuns(tx, host, {
        orgId: ctx.orgId,
        changeObjectId: ctx.changeObjectId,
        controlObjectIds: allControlIds,
        gateKind: ctx.gateKind,
        gateRef: ctx.gateRef,
        force: scanExclusionsChanged,
        context: buildControlContext({
          changeId: ctx.changeObjectId,
          targetObjectIds: ctx.targetObjectIds,
          gateRef: ctx.gateRef,
          artifactDigest: await resolveChangeArtifactDigest(tx, ctx.orgId, ctx.changeObjectId),
          // M10.4 — the change's real source commit, for `github-check` (same threading discipline
          // as `artifactDigest`).
          commitSha: await resolveChangeCommitSha(tx, ctx.orgId, ctx.changeObjectId),
          scanThreshold: effectiveScanThreshold,
          scanExclusions: effectiveScanExclusions
        })
      })
    : await readExistingControlOutcomes(tx, ctx.orgId, ctx.changeObjectId, allControlIds, {
        // M22.0a — read the run made for THIS crossing. Without the gate, the host-less accept edge
        // would happily read a wave-boundary run (or vice versa) and treat it as authorization.
        gateKind: ctx.gateKind,
        gateRef: ctx.gateRef
      });

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

  // That fallback is the partial-admission path, not defence. See docs/governance.md §139.
  const freezeOverrides = freezeCheck.overrides ?? [];
  return {
    verdict: result.verdict === "block" ? "block" : "allow",
    // Populated only at `wave_boundary` — see `GateOutcome.frozenTargets`. `reconcile.ts` does not
    // read it (it resolves holds itself, per target, every tick, which is the only thing that can
    // notice a freeze DECLARED MID-WAVE); it is here so the verdict can explain itself and so a
    // caller that already has the gate's answer never re-derives coverage a second way.
    ...(ctx.gateKind === "wave_boundary" ? { frozenTargets: byTarget } : {}),
    inputContext: {
      matchedPolicyCount: matches.length,
      effectivePolicyCount: effectivePolicies.length,
      firedPolicyCount: fired.filter((fp) => fp.fired).length,
      ...(emergencyNote ? { emergency: emergencyNote } : {}),
      ...(freezeNote ? { freezeExemptRollback: freezeNote } : {}),
      ...(freezeOverrides.length > 0 ? { freezeOverrides } : {}),
      ...(scanThresholdForDecision(effectiveScanThreshold) ?? {}),
      ...(scanExclusionsForDecision(effectiveScanExclusions) ?? {})
    },
    reasonTree: {
      ...result.reasonTree,
      ...(emergencyNote ? { emergencyNote } : {}),
      ...(freezeNote ? { freezeExemptRollback: freezeNote } : {})
    },
    freezeOverrides: freezeOverrides.length > 0 ? freezeOverrides : undefined
  };
}
