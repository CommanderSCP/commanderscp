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

/**
 * M22.8 — THE READ SURFACE behind `GET /components/{idOrUrn}/scan-requirements`.
 *
 * ===========================================================================================
 * WHY THIS IS NOT `POST /policy-evaluate`
 * ===========================================================================================
 * `policy-evaluate` runs the real orchestrator and, like every real gate, WRITES A DECISION —
 * one row per call, through `insertDecision`, with no write suppression on that path. A UI or a
 * CLI loop polling it would reproduce, per viewer and per interval, exactly the amplification
 * ADR-0024 §D0 was raised over after 1.44 GB/day of byte-identical rows was measured in production.
 *
 * This function writes NOTHING. It performs reads only: the instance floor/admission tables, the
 * policy matcher, and the containment chain. Nothing here inserts, and nothing here is allowed to.
 *
 * ===========================================================================================
 * IT EVALUATES NO CEL, AND THAT IS A DESIGN COMMITMENT RATHER THAN A SHORTCUT
 * ===========================================================================================
 * A CEL condition is evaluated against a CHANGE: `buildCelContext` needs the change's id, its
 * emergency flag, its targets, the governance subject, that subject's graph facts and the gate's
 * own instant. This route is asked about a COMPONENT. There is no change, so there is no honest
 * context to evaluate against — a fabricated one would produce an answer that is confidently wrong
 * and, being a scan LOOSENING surface, wrong in a direction nobody would check.
 *
 * So every condition-carrying contributor is treated CONSERVATIVELY — and the conservative
 * direction is OPPOSITE in the two dimensions, exactly as ADR-0033 §4 requires:
 *
 *   - **CEILING**: an unevaluated condition STILL SETS ITS CEILING. Dropping a ceiling turns a fail
 *     into a pass, so the safe reading is to include it. This is the same sign
 *     `ceilingContributorKeys` already applies to a condition that ERRORED.
 *   - **EXCLUSION**: an unevaluated condition YIELDS NO CLAUSE. Admitting a loosening whose
 *     condition could not be evaluated IS the fail-open. Same sign as `exclusionContributorKeys`.
 *
 * Both signs are obtained WITHOUT a second copy of that logic, by handing the two existing helpers
 * one synthetic firing set (see {@link unevaluatedFiringSet}). If somebody ever merges those two
 * helpers — which ADR-0033 §4 forbids in those words — this surface changes sign along with the
 * gate, rather than quietly keeping the old one.
 *
 * The affected policies are NAMED in the response (`unevaluatedConditions`) rather than folded in
 * silently, because a reader who cannot see which statements were guessed at cannot tell a
 * conservative answer from a confident one.
 *
 * ===========================================================================================
 * THE ANSWER IS COMPUTED FOR THE CALLER, AND THAT IS VISIBLE IN IT
 * ===========================================================================================
 * `matchPoliciesForTargets` takes an `actorObjectId`, because DESIGN §10.1's `scope.group` has an
 * ACTING half: a group-scoped policy matches when the acting subject is transitively `member_of`
 * the scoped group. So two callers can legitimately get two different ceilings for one component,
 * and the real gate gets a third at a wave boundary, where the actor is `SYSTEM_ACTOR_ID` and is
 * `member_of` nothing. Passing the authenticated caller is the only choice that describes a real
 * evaluation rather than an invented one; the OWNING half (ADR-0016 §2a) is actor-independent and
 * matches for everybody, which is what makes a CONSTRAINT authored by ownership stable here.
 */

/**
 * The synthetic firing set for a CEL-free evaluation.
 *
 * IT IS NOT A FIRING SET AND MUST NOT BE USED AS ONE. `enforcement`, `requireControls` and
 * `requireApprovals` are deliberately inert: this object exists solely to feed
 * `ceilingContributorKeys` and `exclusionContributorKeys`, the two functions that read nothing but
 * `fired`, `contributingPolicyVersions` and `conditionErrorPolicyVersions`. Handing it to a gate
 * would enforce nothing at all, which is why nothing outside this module may see it.
 *
 * THE ENCODING. A contributor with NO condition genuinely fires — there is nothing to evaluate and
 * it applies unconditionally — so it lands in `contributingPolicyVersions`. A contributor WITH a
 * condition was not evaluated, which is the same epistemic state as a condition that could not be
 * evaluated, so it lands in `conditionErrorPolicyVersions`. The two existing helpers then produce
 * the two opposite signs on their own: the ceiling's key set is the UNION of both lists, and the
 * exclusion's is the first list MINUS the second.
 *
 * Grouped by `name`, mirroring `resolvePolicies`' grouping key, so the shape is comparable to a
 * real firing set. The grouping does not change either key set — both are unions over every entry.
 *
 * MEASURED REDUNDANCY, recorded rather than tidied away. A mutation that put EVERY contributor into
 * `contributingPolicyVersions` (dropping the filter below) left the whole suite green: the
 * subtraction inside `exclusionContributorKeys` removes the condition-carrying ones again, so the
 * `conditionErrorPolicyVersions` list alone already carries BOTH signs. The filter is therefore
 * belt-and-braces, and it stays — the object should not claim that a conditional contributor
 * "fired" — but nobody should read it as the thing holding the loosening closed. That is
 * `exclusionContributorKeys`' subtraction, and `scan-requirements.ts` says so at the subtraction.
 */
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

/**
 * WHICH CLASSES ARE ADMITTED FOR THIS TARGET, and at which tiers a clause of each would survive.
 *
 * EVERY class is reported, including ones nobody has admitted. The shipped default is that
 * admission is EMPTY at every tier, so the most important state this surface can show is
 * `admittedBy: [], effectiveAtTiers: []` — "nothing you author of this class will do anything".
 * Reporting only the classes somebody happened to admit would make that state invisible, which is
 * precisely the silent-no-op this increment exists to end.
 *
 * `effectiveAtTiers` NEVER lists `platform` or `trust_domain`. Those two rungs come from
 * `scan_exclusion_admissions`, a table with a `class` column and no clause: an instance rung can
 * ADMIT and can never CONTRIBUTE. Listing them would invite an operator to look for an authoring
 * surface that does not exist.
 */
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

/**
 * Resolves everything the read surface reports. Reads only; writes nothing.
 *
 * WHAT IT DELIBERATELY DOES NOT RESOLVE: the per-class FACTS — the dependency inventory's line
 * heads (M22.4), the component's declarations (M22.5) and live override grants with their expiry
 * (M22.6). Those are attached by `resolveEffectiveScanExclusionsForTargets` and each costs a join
 * or a property read PER TARGET. This surface exists to be POLLED, and its question is "which rules
 * are in force", not "what would this scan's findings do against them". Resolving facts here would
 * put the inventory join on a polled endpoint and would invite the confusion ADR-0033 §1's last
 * paragraph names: a clause being ADMITTED and a clause APPLYING to a finding are different
 * questions, and one hidden behind the other is how a loosening stops being auditable.
 */
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
