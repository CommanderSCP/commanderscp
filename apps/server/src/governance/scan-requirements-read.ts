import {
  ScanExclusionClassSchema,
  type ComponentScanRequirementsResponse,
  type ScanExclusionAdmittedClass,
  type ScanExclusionClass,
  type ScanRequirementTier,
  type UnevaluatedScanPolicyCondition
} from "@scp/schemas";
import type { TenantTx } from "../db/tenant-tx.js";
import { matchPoliciesForTargets } from "./policy-resolve.js";
import type { MatchedPolicy } from "./policy-model.js";
import type { FiredPolicy } from "./evaluate.js";
import {
  buildScanExclusionTargetInputs,
  representedTiersAbove,
  resolveEffectiveScanExclusions,
  resolveEffectiveScanThreshold,
  scanRequirementTierOrder,
  type ScanExclusionTargetInput
} from "./scan-requirements.js";

/** The read surface behind the scan-requirements route. See docs/governance.md §360. */

/** The synthetic firing set for a CEL-free evaluation. See docs/governance.md §361. */
export function unevaluatedFiringSet(matches: MatchedPolicy[]): FiredPolicy[] {
  const groups = new Map<string, MatchedPolicy[]>();
  for (const m of matches) {
    const group = groups.get(m.name);
    if (group) group.push(m);
    else groups.set(m.name, [m]);
  }
  const out: FiredPolicy[] = [];
  for (const [name, group] of groups) {
    out.push({
      name,
      fired: true,
      enforcement: "advisory",
      requireControls: [],
      requireApprovals: [],
      contributingPolicyVersions: group
        .filter((m) => m.condition === undefined || m.condition === "")
        .map((m) => ({ policyObjectId: m.policyObjectId, policyVersion: m.policyVersion })),
      conditionErrorPolicyVersions: group
        .filter((m) => m.condition !== undefined && m.condition !== "")
        .map((m) => ({ policyObjectId: m.policyObjectId, policyVersion: m.policyVersion })),
      // `no-condition` is the only value that is not a claim about an evaluation that happened.
      // `"true"`/`"false"`/`"error"` would each assert something this function did not do.
      conditionResult: "no-condition"
    });
  }
  return out;
}

/** The condition-carrying contributors, content-sorted so two identical reads compare equal. */
function unevaluatedConditionsOf(matches: MatchedPolicy[]): UnevaluatedScanPolicyCondition[] {
  return matches
    .filter(
      (m): m is MatchedPolicy & { condition: string } =>
        typeof m.condition === "string" && m.condition !== ""
    )
    .map((m) => ({
      policyObjectId: m.policyObjectId,
      policyVersion: m.policyVersion,
      name: m.name,
      condition: m.condition
    }))
    .map((entry) => ({ entry, key: JSON.stringify(entry) }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .map(({ entry }) => entry);
}

/** Which classes are admitted, and at which tiers. See docs/governance.md §362. */
function admittedClassesFor(target: ScanExclusionTargetInput): ScanExclusionAdmittedClass[] {
  const admittedKeys = new Set<string>();
  const byClass = new Map<
    ScanExclusionClass,
    Array<{ tier: ScanRequirementTier; source: string }>
  >();
  for (const a of target.admissions) {
    admittedKeys.add(`${a.tier}::${a.class}`);
    const list = byClass.get(a.class) ?? [];
    list.push({ tier: a.tier, source: a.source });
    byClass.set(a.class, list);
  }
  const represented = new Set(target.representedTiers);

  return ScanExclusionClassSchema.options.map((cls) => {
    const seen = new Set<string>();
    const admittedBy = (byClass.get(cls) ?? [])
      .map((entry) => ({ entry, key: JSON.stringify([entry.tier, entry.source]) }))
      .filter(({ key }) => (seen.has(key) ? false : (seen.add(key), true)))
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
      .map(({ entry }) => entry);

    const effectiveAtTiers = scanRequirementTierOrder().filter((tier) => {
      if (tier === "platform" || tier === "trust_domain") return false;
      if (!represented.has(tier)) return false;
      return representedTiersAbove(tier, represented).every((above) =>
        admittedKeys.has(`${above}::${cls}`)
      );
    });

    return { class: cls, admittedBy, effectiveAtTiers };
  });
}

export interface ReadComponentScanRequirementsInput {
  orgId: string;
  /** The already-resolved component graph object — the route resolves it (and authorizes on it)
   *  before calling, so this function never re-reads it and never decides what a caller may see. */
  component: { id: string; urn: string };
  actorObjectId: string;
}

/** Resolves everything the read surface reports. See docs/governance.md §363. */
export async function readComponentScanRequirements(
  tx: TenantTx,
  input: ReadComponentScanRequirementsInput
): Promise<ComponentScanRequirementsResponse> {
  const targetObjectIds = [input.component.id];
  const matches = await matchPoliciesForTargets(tx, {
    orgId: input.orgId,
    targetObjectIds,
    actorObjectId: input.actorObjectId
  });
  const firedPolicies = unevaluatedFiringSet(matches);

  const threshold = await resolveEffectiveScanThreshold(tx, {
    orgId: input.orgId,
    targetObjectIds,
    actorObjectId: input.actorObjectId,
    matches,
    firedPolicies
  });

  // The SAME gather the gate uses (`buildScanExclusionTargetInputs`), so the admissions this surface
  // reports and the admissions the gate applies cannot come from two different constructions.
  const targets = await buildScanExclusionTargetInputs(tx, {
    orgId: input.orgId,
    targetObjectIds,
    actorObjectId: input.actorObjectId,
    matches,
    firedPolicies
  });
  const target = targets[0];
  const resolved = resolveEffectiveScanExclusions(targets);

  return {
    componentId: input.component.id,
    componentUrn: input.component.urn,
    representedTiers: target
      ? scanRequirementTierOrder().filter((t) => target.representedTiers.includes(t))
      : [],
    threshold: threshold ?? null,
    admittedExclusionClasses: target ? admittedClassesFor(target) : [],
    exclusionClauses: resolved?.clauses ?? [],
    unevaluatedConditions: unevaluatedConditionsOf(matches)
  };
}
