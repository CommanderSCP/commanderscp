import { sql } from "drizzle-orm";
import type { TenantTx } from "../db/tenant-tx.js";
import {
  PartialScanThresholdSchema,
  ScanExclusionEffectSchema,
  type AdmittedScanExclusionClause,
  type EffectiveScanExclusions,
  type EffectiveScanThreshold,
  type PartialScanThreshold,
  type ScanExclusionClass,
  type ScanExclusionClause,
  type RefusedScanOverrideGrant,
  type ScanApprovedOverrides,
  type ScanDeclaredFacts,
  type ScanRequirementTier,
  type ScanThresholdContribution,
  type ScanVendorLatestFacts
} from "@scp/schemas";
import { containmentChain } from "../graph/containment.js";
import {
  intersectVendorLatestFacts,
  resolveVendorLatestFactsForTarget
} from "./scan-vendor-latest.js";
import { intersectDeclaredFacts, resolveDeclaredFactsForTarget } from "./scan-declared-facts.js";
import {
  applyOverrideAuthorityBar,
  intersectApprovedOverrides,
  resolveApprovedOverridesForTarget
} from "./scan-override-grants.js";
import { matchPoliciesForTargets } from "./policy-resolve.js";
import type { MatchedPolicy } from "./policy-model.js";
import type { FiredPolicy } from "./evaluate.js";

/** M17.5 — SCOPED SCAN-REQUIREMENT RESOLUTION. See docs/governance.md §365. */

/** A `scanThreshold` effect on a policy document. See docs/governance.md §366. */
interface ScanThresholdEffect {
  scanThreshold?: unknown;
}

const SEVERITY_KEYS = ["maxCritical", "maxHigh", "maxMedium", "maxLow"] as const;

/** The six-tier label for a graph object type. See docs/governance.md §367. */
export function tierForObjectType(objectTypeId: string): ScanRequirementTier {
  switch (objectTypeId) {
    case "organization":
      return "org";
    case "domain":
      // The intra-org containment domain — NOT the trust domain (partition). See the module doc.
      return "containment_domain";
    case "service":
      return "service";
    case "assembly":
      // The optional rung between a service and its components. See docs/governance.md §368.
      return "assembly";
    default:
      return "component";
  }
}

/** Parses a policy effect's `scanThreshold` into a partial threshold, or `undefined` when the
 *  effect isn't a scan threshold / is malformed. Malformed documents contribute nothing rather than
 *  throwing: an unparseable ceiling must never turn a gate into a 500, and it cannot LOOSEN anything
 *  either (a missing contribution only ever leaves the merge as strict as the other tiers made it). */
function parseScanThresholdEffect(effect: unknown): PartialScanThreshold | undefined {
  const raw = (effect as ScanThresholdEffect | null)?.scanThreshold;
  if (!raw || typeof raw !== "object") return undefined;
  const parsed = PartialScanThresholdSchema.safeParse(raw);
  if (!parsed.success) return undefined;
  const value = parsed.data;
  return SEVERITY_KEYS.some((k) => value[k] !== undefined) ? value : undefined;
}

/** The merge: pure, order-independent, per-severity minimum. See docs/governance.md §369. */
export function mergeScanThresholds(
  contributors: ScanThresholdContribution[]
): EffectiveScanThreshold {
  const threshold: PartialScanThreshold = {};
  for (const contribution of contributors) {
    for (const key of SEVERITY_KEYS) {
      const candidate = contribution.threshold[key];
      if (candidate === undefined) continue; // this tier sets no ceiling here — contributes nothing
      const current = threshold[key];
      threshold[key] = current === undefined ? candidate : Math.min(current, candidate);
    }
  }
  return { threshold, contributors };
}

/** The instance-scoped (above-org) floors. See docs/governance.md §370. */
export async function readInstanceScanFloors(tx: TenantTx): Promise<ScanThresholdContribution[]> {
  const result = await tx.execute<{
    tier: string;
    origin: string;
    max_critical: number | null;
    max_high: number | null;
    max_medium: number | null;
    max_low: number | null;
  }>(sql`
    SELECT tier, origin, max_critical, max_high, max_medium, max_low
    FROM scan_requirement_floors
  `);
  const contributions: ScanThresholdContribution[] = [];
  for (const row of result.rows) {
    // The literal is `trust_domain`, never bare `domain` (DB CHECK constraint enforces it too).
    if (row.tier !== "platform" && row.tier !== "trust_domain") continue;
    const threshold: PartialScanThreshold = {
      ...(row.max_critical !== null ? { maxCritical: row.max_critical } : {}),
      ...(row.max_high !== null ? { maxHigh: row.max_high } : {}),
      ...(row.max_medium !== null ? { maxMedium: row.max_medium } : {}),
      ...(row.max_low !== null ? { maxLow: row.max_low } : {})
    };
    if (SEVERITY_KEYS.every((k) => threshold[k] === undefined)) continue;
    contributions.push({
      tier: row.tier,
      source: `instance:${row.tier}:${row.origin}`,
      threshold
    });
  }
  return contributions;
}

export interface ResolveScanThresholdInput {
  orgId: string;
  targetObjectIds: string[];
  actorObjectId: string;
  /** The already-gathered policy matches, when the caller has them (both gate sites do) — avoids a
   *  second identical `matchPoliciesForTargets` round-trip. Omit and this resolves them itself. */
  matches?: MatchedPolicy[];
  /** The condition-resolved firing set (evaluate.ts `resolveFiredPolicies`) — REQUIRED, not
   *  optional, so no call site can silently fall back to "every match contributes" and reintroduce
   *  ceilings from policies whose condition was false. May include non-firing groups; they are
   *  filtered here. */
  firedPolicies: FiredPolicy[];
}

/** The policy keys admitted to set a ceiling: the union. See docs/governance.md §371. */
function ceilingContributorKeys(firedPolicies: FiredPolicy[]): Set<string> {
  const keys = new Set<string>();
  for (const fp of firedPolicies) {
    if (fp.fired) {
      for (const c of fp.contributingPolicyVersions)
        keys.add(`${c.policyObjectId}::${c.policyVersion}`);
    }
    // Fail closed on an unevaluable condition — regardless of `fired`, regardless of enforcement,
    // and ONLY for the contributors that actually errored (never a cleanly-false sibling).
    for (const c of fp.conditionErrorPolicyVersions)
      keys.add(`${c.policyObjectId}::${c.policyVersion}`);
  }
  return keys;
}

/** Resolves the effective threshold across all six tiers. See docs/governance.md §372. */
export async function resolveEffectiveScanThreshold(
  tx: TenantTx,
  input: ResolveScanThresholdInput
): Promise<EffectiveScanThreshold | undefined> {
  const contributors: ScanThresholdContribution[] = await readInstanceScanFloors(tx);

  const matches =
    input.matches ??
    (await matchPoliciesForTargets(tx, {
      orgId: input.orgId,
      targetObjectIds: input.targetObjectIds,
      actorObjectId: input.actorObjectId
    }));

  // Which graph object type each matched ancestor is — for the tier LABEL only (explainability).
  // Built from the same `containmentChain` the matcher itself walked, so the labels can never
  // describe a containment relationship the matcher didn't actually use.
  const typeById = new Map<string, string>();
  for (const targetId of new Set(input.targetObjectIds)) {
    for (const entry of await containmentChain(tx, input.orgId, targetId)) {
      typeById.set(entry.id, entry.typeId);
    }
  }

  // Only FIRED contributors — plus contributors whose condition was UNEVALUABLE, which fail closed
  // at every enforcement level — may set a ceiling (see the module doc). A matched contributor whose
  // condition cleanly evaluated FALSE is dropped here exactly as it is dropped from
  // `requireControls` at the gate.
  const ceilingKeys = ceilingContributorKeys(input.firedPolicies);

  for (const match of matches) {
    if (!ceilingKeys.has(`${match.policyObjectId}::${match.policyVersion}`)) continue;
    for (const effect of match.effects as unknown[]) {
      const threshold = parseScanThresholdEffect(effect);
      if (!threshold) continue;
      const objectTypeId = typeById.get(match.matchedAt.objectId);
      contributors.push({
        tier: tierForObjectType(objectTypeId ?? ""),
        source: `policy:${match.name}@${match.policyObjectId}`,
        ...(objectTypeId ? { objectTypeId } : {}),
        threshold
      });
    }
  }

  if (contributors.length === 0) return undefined;
  return mergeScanThresholds(contributors);
}

// The exclusion dimension, resolved beside the ceiling. See docs/governance.md §373.

/** The six-tier chain as a TOTAL ORDER, top-down. The AND walks this, NOT the containment chain's
 *  `depth` — `graph/containment.ts` documents that two ancestors of DIFFERENT kinds can be exactly
 *  equidistant and TIE, so depth cannot express "every tier above". Tier labels can. */
const TIER_ORDER: readonly ScanRequirementTier[] = [
  "platform",
  "trust_domain",
  "org",
  "containment_domain",
  "service",
  "assembly",
  "component"
];

export function tierRank(tier: ScanRequirementTier): number {
  return TIER_ORDER.indexOf(tier);
}

/** One tier's statement that a CLASS of exclusion may have effect beneath it. */
export interface ScanExclusionAdmission {
  tier: ScanRequirementTier;
  class: ScanExclusionClass;
  source: string;
}

export interface ScanExclusionClauseContribution {
  tier: ScanRequirementTier;
  source: string;
  clause: ScanExclusionClause;
}

/**
 * Everything the AND needs for ONE target. Built per target and never merged with another's, which
 * is the whole of ADR-0033 §3.
 */
export interface ScanExclusionTargetInput {
  targetObjectId: string;
  /** The tiers that are REPRESENTED for this target. See docs/governance.md §374. */
  representedTiers: ScanRequirementTier[];
  /** The tier of every object on this target's chain. See docs/governance.md §375. */
  chainTierByObjectId: Record<string, ScanRequirementTier>;
  admissions: ScanExclusionAdmission[];
  clauses: ScanExclusionClauseContribution[];
}

/** Stable identity of a clause contribution, used to intersect across targets and to sort
 *  deterministically. Content-only — no ids, no timestamps (the M22.0 write-suppression rule). */
function clauseKey(entry: {
  tier: ScanRequirementTier;
  source: string;
  clause: ScanExclusionClause;
}): string {
  return JSON.stringify([
    entry.tier,
    entry.source,
    entry.clause.class,
    entry.clause.vulnerabilityId ?? null,
    entry.clause.pkgName ?? null,
    entry.clause.purl ?? null,
    entry.clause.findingClass ?? null,
    entry.clause.reason ?? null
  ]);
}

/** The conjunction: per target, then intersected across. See docs/governance.md §376. */
export function resolveEffectiveScanExclusions(
  targets: ScanExclusionTargetInput[]
): EffectiveScanExclusions | undefined {
  // NO targets means nothing to resolve FOR. An intersection over an empty family is conventionally
  // "everything", which here would be every clause admitted for nobody — the exact inversion §3
  // exists to prevent.
  if (targets.length === 0) return undefined;

  let surviving: Map<string, AdmittedScanExclusionClause> | undefined;

  for (const target of targets) {
    // Which classes each represented tier admits, and who said so. A tier that admits the same class
    // twice keeps the alphabetically-first source, so the recorded authority is content-determined.
    const admitted = new Map<string, string>();
    for (const a of target.admissions) {
      const key = `${a.tier}::${a.class}`;
      const current = admitted.get(key);
      if (current === undefined || a.source < current) admitted.set(key, a.source);
    }
    const represented = new Set(target.representedTiers);

    const perTarget = new Map<string, AdmittedScanExclusionClause>();
    for (const contribution of target.clauses) {
      const rank = tierRank(contribution.tier);
      if (rank < 0) continue;
      const above = TIER_ORDER.filter((t) => tierRank(t) < rank && represented.has(t));
      const admittedBy: AdmittedScanExclusionClause["admittedBy"] = [];
      let blocked = false;
      for (const tier of above) {
        const source = admitted.get(`${tier}::${contribution.clause.class}`);
        if (source === undefined) {
          blocked = true;
          break;
        }
        admittedBy.push({ tier, source });
      }
      if (blocked) continue;
      perTarget.set(clauseKey(contribution), {
        clause: contribution.clause,
        tier: contribution.tier,
        source: contribution.source,
        admittedBy
      });
    }

    if (surviving === undefined) {
      surviving = perTarget;
      continue;
    }
    for (const key of [...surviving.keys()]) {
      if (!perTarget.has(key)) surviving.delete(key);
    }
  }

  if (!surviving || surviving.size === 0) return undefined;
  // Sorted by content so two identical evaluations produce an identical array. `restatesDecision`
  // canonicalises key order but PRESERVES array order, and an unsorted array here would defeat
  // `insertDecisionIfChanged` and re-open the measured 1.44 GB/day Decision write amplification.
  const clauses = [...surviving.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([, value]) => value);
  return { clauses };
}

/** The policy keys admitted to contribute an exclusion. See docs/governance.md §377. */
function exclusionContributorKeys(firedPolicies: FiredPolicy[]): Set<string> {
  const keys = new Set<string>();
  for (const fp of firedPolicies) {
    if (!fp.fired) continue;
    for (const c of fp.contributingPolicyVersions)
      keys.add(`${c.policyObjectId}::${c.policyVersion}`);
  }
  for (const fp of firedPolicies) {
    for (const c of fp.conditionErrorPolicyVersions)
      keys.delete(`${c.policyObjectId}::${c.policyVersion}`);
  }
  return keys;
}

/** Parses a policy effect's `scanExclusion` into its two halves, or `undefined` when the effect is
 *  not one / is malformed. A malformed loosening contributes NOTHING — an unparseable clause must
 *  never turn a gate into a 500, and it must never be read as "exclude something". */
function parseScanExclusionEffect(effect: unknown) {
  const raw = (effect as { scanExclusion?: unknown } | null)?.scanExclusion;
  if (!raw || typeof raw !== "object") return undefined;
  const parsed = ScanExclusionEffectSchema.safeParse(raw);
  if (!parsed.success) return undefined;
  const value = parsed.data;
  if (!value.admit?.length && !value.exclude) return undefined;
  return value;
}

/** The instance-scoped (above-org) ADMISSIONS. See docs/governance.md §378. */
export async function readInstanceScanExclusionAdmissions(
  tx: TenantTx
): Promise<ScanExclusionAdmission[]> {
  const result = await tx.execute<{ tier: string; class: string; origin: string }>(sql`
    SELECT tier, class, origin FROM scan_exclusion_admissions
  `);
  const admissions: ScanExclusionAdmission[] = [];
  for (const row of result.rows) {
    // The literal is `trust_domain`, never bare `domain` (the DB CHECK enforces it too).
    if (row.tier !== "platform" && row.tier !== "trust_domain") continue;
    admissions.push({
      tier: row.tier,
      class: row.class as ScanExclusionClass,
      source: `instance:${row.tier}:${row.origin}`
    });
  }
  return admissions;
}

export interface ResolveScanExclusionsInput {
  orgId: string;
  targetObjectIds: string[];
  actorObjectId: string;
  /** Already-gathered matches, when the caller has them (both gate sites do). */
  matches?: MatchedPolicy[];
  /** The condition-resolved firing set — REQUIRED for the same reason the ceiling's is: no call site
   *  may silently fall back to "every match contributes". */
  firedPolicies: FiredPolicy[];
  /** The instant this whole evaluation is measured against. See docs/governance.md §379. */
  now?: Date;
}

/** THE PER-TARGET GATHER. See docs/governance.md §380. */
export async function buildScanExclusionTargetInputs(
  tx: TenantTx,
  input: ResolveScanExclusionsInput
): Promise<ScanExclusionTargetInput[]> {
  const instanceAdmissions = await readInstanceScanExclusionAdmissions(tx);

  const matches =
    input.matches ??
    (await matchPoliciesForTargets(tx, {
      orgId: input.orgId,
      targetObjectIds: input.targetObjectIds,
      actorObjectId: input.actorObjectId
    }));

  const exclusionKeys = exclusionContributorKeys(input.firedPolicies);

  const targets: ScanExclusionTargetInput[] = [];
  for (const targetId of new Set(input.targetObjectIds)) {
    const chain = await containmentChain(tx, input.orgId, targetId);
    const typeById = new Map(chain.map((e) => [e.id, e.typeId]));
    // `platform` and `trust_domain` are facts about the DEPLOYMENT and are always represented; the
    // rest come from what this target's chain actually contains.
    const representedTiers = new Set<ScanRequirementTier>(["platform", "trust_domain"]);
    // M22.6 (D3) — built in the SAME loop as `representedTiers`, from the same walk, so the two can
    // never disagree about what this target's chain contains.
    const chainTierByObjectId: Record<string, ScanRequirementTier> = {};
    for (const entry of chain) {
      const tier = tierForObjectType(entry.typeId);
      representedTiers.add(tier);
      chainTierByObjectId[entry.id] = tier;
    }

    const admissions: ScanExclusionAdmission[] = [...instanceAdmissions];
    const clauses: ScanExclusionClauseContribution[] = [];

    for (const match of matches) {
      // PER TARGET: only a policy anchored somewhere on THIS target's containment chain speaks for
      // it. `matchedAt.objectId` is always a chain object (an unscoped or acting-group match parks
      // at the org root), so this membership test is the whole of the per-target restriction.
      const objectTypeId = typeById.get(match.matchedAt.objectId);
      if (objectTypeId === undefined) continue;
      if (!exclusionKeys.has(`${match.policyObjectId}::${match.policyVersion}`)) continue;
      const tier = tierForObjectType(objectTypeId);
      const source = `policy:${match.name}@${match.policyObjectId}`;
      for (const effect of match.effects as unknown[]) {
        const parsed = parseScanExclusionEffect(effect);
        if (!parsed) continue;
        for (const cls of parsed.admit ?? []) admissions.push({ tier, class: cls, source });
        if (parsed.exclude) clauses.push({ tier, source, clause: parsed.exclude });
      }
    }

    targets.push({
      targetObjectId: targetId,
      representedTiers: [...representedTiers],
      chainTierByObjectId,
      admissions,
      clauses
    });
  }
  return targets;
}

/** M22.8 — WHICH TIERS ABOVE `tier` ARE REPRESENTED, top-down. See docs/governance.md §381. */
export function representedTiersAbove(
  tier: ScanRequirementTier,
  represented: Iterable<ScanRequirementTier>
): ScanRequirementTier[] {
  const set = new Set(represented);
  const rank = tierRank(tier);
  if (rank < 0) return [];
  return TIER_ORDER.filter((t) => tierRank(t) < rank && set.has(t));
}

/** M22.8 — the tier chain itself, top-down, for a consumer that must enumerate every rung. */
export function scanRequirementTierOrder(): readonly ScanRequirementTier[] {
  return TIER_ORDER;
}

/** M22.6 (D3), THE DERIVED BAR. See docs/governance.md §382. */

/** The lowest tier that may ever approve an override. See docs/governance.md §383. */
export const OVERRIDE_APPROVAL_TIER_FLOOR: ScanRequirementTier = "org";

export function requiredOverrideApprovalTier(
  ceiling: EffectiveScanThreshold | undefined
): ScanRequirementTier {
  let best: ScanRequirementTier = OVERRIDE_APPROVAL_TIER_FLOOR;
  for (const contribution of ceiling?.contributors ?? []) {
    const rank = tierRank(contribution.tier);
    if (rank < 0) continue;
    if (rank < tierRank(best)) best = contribution.tier;
  }
  return best;
}

/** Resolves the effective exclusion set across seven rungs. See docs/governance.md §384. */
export async function resolveEffectiveScanExclusionsForTargets(
  tx: TenantTx,
  input: ResolveScanExclusionsInput
): Promise<EffectiveScanExclusions | undefined> {
  if (input.targetObjectIds.length === 0) return undefined;

  // One instant for the whole evaluation, threaded always. See docs/governance.md §385.
  const at = input.now ?? new Date();
  const targets = await buildScanExclusionTargetInputs(tx, input);
  const resolved = resolveEffectiveScanExclusions(targets);
  const withVendor = await attachVendorLatestFacts(tx, input.orgId, targets, resolved, at);
  const withDeclared = await attachDeclaredFacts(tx, input.orgId, targets, withVendor);
  return attachApprovedOverrides(tx, input, targets, withDeclared, at);
}

/** Resolve the vendor facts, but only if a rule needs them. See docs/governance.md §386. */
async function attachVendorLatestFacts(
  tx: TenantTx,
  orgId: string,
  targets: ScanExclusionTargetInput[],
  resolved: EffectiveScanExclusions | undefined,
  /** The evaluation's ONE instant — required, never conditionally forwarded. See the caller. */
  at: Date
): Promise<EffectiveScanExclusions | undefined> {
  if (!resolved) return undefined;
  if (!resolved.clauses.some((c) => c.clause.class === "vendor_latest")) return resolved;
  const perTarget: ScanVendorLatestFacts[] = [];
  for (const target of targets) {
    perTarget.push(
      await resolveVendorLatestFactsForTarget(tx, orgId, target.targetObjectId, { now: at })
    );
  }
  const vendorLatest = intersectVendorLatestFacts(perTarget);
  // `undefined` only when there were no targets, which cannot be true here (the resolver returns
  // `undefined` for an empty target set and we returned above). Carried anyway rather than asserted
  // away: an absent fact must remain "no vendor-pass", never a thrown gate.
  return vendorLatest ? { ...resolved, vendorLatest } : resolved;
}

/** Resolve what the component declared, only if needed. See docs/governance.md §387. */
async function attachDeclaredFacts(
  tx: TenantTx,
  orgId: string,
  targets: ScanExclusionTargetInput[],
  resolved: EffectiveScanExclusions | undefined
): Promise<EffectiveScanExclusions | undefined> {
  if (!resolved) return undefined;
  if (!resolved.clauses.some((c) => c.clause.class === "declared_fact")) return resolved;
  const perTarget: ScanDeclaredFacts[] = [];
  for (const target of targets) {
    perTarget.push(await resolveDeclaredFactsForTarget(tx, orgId, target.targetObjectId));
  }
  const declaredFacts = intersectDeclaredFacts(perTarget);
  return declaredFacts ? { ...resolved, declaredFacts } : resolved;
}

/** Resolve the live override grants, only if needed. See docs/governance.md §388. */
async function attachApprovedOverrides(
  tx: TenantTx,
  input: ResolveScanExclusionsInput,
  targets: ScanExclusionTargetInput[],
  resolved: EffectiveScanExclusions | undefined,
  /** The evaluation's ONE instant — required, never re-derived here. See the caller. */
  at: Date
): Promise<EffectiveScanExclusions | undefined> {
  if (!resolved) return undefined;
  if (!resolved.clauses.some((c) => c.clause.class === "approved_override")) return resolved;
  const orgId = input.orgId;
  // THE BAR IS RESOLVED HERE, NOT THREADED IN FROM THE CALLER. See docs/governance.md §389.
  const requiredTier = requiredOverrideApprovalTier(
    await resolveEffectiveScanThreshold(tx, {
      orgId,
      targetObjectIds: input.targetObjectIds,
      actorObjectId: input.actorObjectId,
      ...(input.matches ? { matches: input.matches } : {}),
      firedPolicies: input.firedPolicies
    })
  );
  const perTarget: ScanApprovedOverrides[] = [];
  const refusedById = new Map<string, RefusedScanOverrideGrant>();
  for (const target of targets) {
    const candidates = await resolveApprovedOverridesForTarget(
      tx,
      orgId,
      target.targetObjectId,
      at
    );
    const { granted, refused } = applyOverrideAuthorityBar({
      candidates,
      chainTierByObjectId: target.chainTierByObjectId,
      requiredTier,
      rankOf: tierRank
    });
    perTarget.push({ grants: granted });
    for (const entry of refused) refusedById.set(entry.grantObjectId, entry);
  }
  const approvedOverrides = intersectApprovedOverrides(perTarget);
  if (!approvedOverrides) return resolved;
  const refusedForAuthority = [...refusedById.values()].sort((a, b) =>
    a.grantObjectId < b.grantObjectId ? -1 : 1
  );
  return {
    ...resolved,
    approvedOverrides: {
      ...approvedOverrides,
      // Always present once this dimension resolved: the bar is the RULE the grants were measured
      // against, and a Decision listing the grants without it explains half the verdict.
      requiredTier,
      ...(refusedForAuthority.length > 0 ? { refusedForAuthority } : {})
    }
  };
}
