import { and, eq, inArray, sql } from "drizzle-orm";
import {
  DEFAULT_DEPENDENCY_SUBSCRIPTION_DELIVERY,
  DEFAULT_DEPENDENCY_SUBSCRIPTION_GRANULARITY,
  DependencyEcosystemSchema,
  DependencySubscriptionEffectSchema,
  type DependencyLineKey,
  type DependencySubscriptionContribution,
  type DependencySubscriptionDelivery,
  type DependencySubscriptionEffect,
  type DependencySubscriptionGranularity,
  type DependencySubscriptionResolution,
  type DependencySubscriptionTier
} from "@scp/schemas";
import type { TenantTx } from "../db/tenant-tx.js";
import { componentDependencies, dependencyLines } from "../db/schema.js";
import { containmentChain } from "../graph/containment.js";
import { matchPoliciesForTargets } from "../governance/policy-resolve.js";
import type { MatchedPolicy } from "../governance/policy-model.js";

/** M21.3 — DEPENDENCY-SUBSCRIPTION ENABLEMENT RESOLUTION. See docs/dependencies.md §377. */

// The pure merge — no database, no I/O, total and order-independent

/** A `dependencySubscription` effect on a policy document. See docs/dependencies.md §378. */
interface DependencySubscriptionEffectShape {
  dependencySubscription?: unknown;
}

/** One candidate contribution, as gathered from a policy. See docs/dependencies.md §379. */
export interface DependencySubscriptionCandidate {
  tier: DependencySubscriptionTier;
  source: string;
  objectTypeId?: string;
  /** The raw `dependencySubscription` payload as it appears in the policy document. */
  effect: unknown;
  /** The contributing policy carries a CEL `condition` this resolution cannot evaluate. Such a
   *  contribution may DISABLE but never ENABLE — see the module doc. */
  conditional?: boolean;
}

export interface MergeDependencySubscriptionInput {
  /** The line being resolved. Selectors are compared against these values VERBATIM. */
  line: DependencyLineKey;
  /** The FIRST conjunct — the `dependency_subscription_unlock` singleton. Unlocking permits;
   *  it never enables anything on its own. */
  instance: { unlocked: boolean; source: string };
  candidates: DependencySubscriptionCandidate[];
}

/** Restrictiveness order, most restrictive FIRST. The merge takes the MIN over EVERY enabling
 *  contribution — see `SILENCE VOTES FOR THE DEFAULT` below — so a contribution may only ever
 *  tighten what another would have allowed, never loosen it, exactly as `scan-requirements.ts` takes
 *  a per-severity MIN. */
const GRANULARITY_RESTRICTIVENESS: Record<DependencySubscriptionGranularity, number> = {
  patch: 0,
  minor_and_patch: 1
};

/** Same shape, and the reason it exists at all. See docs/dependencies.md §380. */
const DELIVERY_RESTRICTIVENESS: Record<DependencySubscriptionDelivery, number> = {
  pull_request: 0,
  auto_merge: 1
};

/** The five-tier label for a graph object type. See docs/dependencies.md §381. */
function tierForObjectType(objectTypeId: string): DependencySubscriptionTier {
  switch (objectTypeId) {
    case "organization":
      return "org";
    case "domain":
      // The intra-org containment domain — NOT a trust domain (partition). ADR-0016 terminology.
      return "containment_domain";
    case "service":
      return "service";
    default:
      return "component";
  }
}

/** Does a parsed effect's selector set match this line? See docs/dependencies.md §382. */
function effectMatchesLine(effect: DependencySubscriptionEffect, line: DependencyLineKey): boolean {
  if (effect.ecosystem !== undefined && effect.ecosystem !== line.ecosystem) return false;
  if (effect.coordinate !== undefined && effect.coordinate !== line.coordinate) return false;
  if (effect.major !== undefined && effect.major !== line.major) return false;
  return true;
}

/** The selectors, echoed so the why is answerable. See docs/dependencies.md §383. */
function selectorOf(
  effect: DependencySubscriptionEffect
): DependencySubscriptionContribution["selector"] {
  return {
    ...(effect.ecosystem !== undefined ? { ecosystem: effect.ecosystem } : {}),
    ...(effect.coordinate !== undefined ? { coordinate: effect.coordinate } : {}),
    ...(effect.major !== undefined ? { major: effect.major } : {})
  };
}

/** A canonical, total key over a contribution's whole content — so sorting the explanation is
 *  order-independent even when two contributions share a tier and a source (one policy may carry
 *  several `dependencySubscription` effects). */
function contributionSortKey(c: DependencySubscriptionContribution): string {
  const TIER_READING_ORDER: Record<DependencySubscriptionTier, number> = {
    // READING order for the explanation, top-down. NOT precedence: an AND has none.
    instance: 0,
    org: 1,
    containment_domain: 2,
    service: 3,
    component: 4
  };
  return JSON.stringify([
    TIER_READING_ORDER[c.tier],
    c.source,
    c.contributed,
    c.ignoredReason ?? null,
    c.selector ?? null,
    c.granularity ?? null,
    c.delivery ?? null,
    c.objectTypeId ?? null
  ]);
}

/** The merge: pure, total, order-independent, testable. See docs/dependencies.md §384. */
export function mergeDependencySubscription(
  input: MergeDependencySubscriptionInput
): DependencySubscriptionResolution {
  const contributions: DependencySubscriptionContribution[] = [
    {
      tier: "instance",
      source: input.instance.source,
      // `unlock` PERMITS; it never enables. `lock` is the answer to "which level turned this off"
      // when the deployment never opened the feature at all.
      contributed: input.instance.unlocked ? "unlock" : "lock"
    }
  ];

  let enabledBy = false;
  let disabledBy = false;
  let granularity: DependencySubscriptionGranularity | undefined;
  let delivery: DependencySubscriptionDelivery | undefined;

  for (const candidate of input.candidates) {
    const base = {
      tier: candidate.tier,
      source: candidate.source,
      ...(candidate.objectTypeId !== undefined ? { objectTypeId: candidate.objectTypeId } : {})
    };

    const parsed = DependencySubscriptionEffectSchema.safeParse(candidate.effect);
    if (!parsed.success) {
      // Admitted to NEITHER side, but REPORTED: a malformed opt-out fails open, so it must be
      // visible in the result rather than only in a log (charter principle 6).
      contributions.push({ ...base, contributed: "ignored", ignoredReason: "malformed" });
      continue;
    }
    const effect = parsed.data;
    // A contribution that does not match this line is not this line's business at all — it is left
    // out of the explanation entirely, or every resolution would carry every other line's policies.
    if (!effectMatchesLine(effect, input.line)) continue;

    const selector = selectorOf(effect);
    const decorated = {
      ...base,
      ...(selector !== undefined ? { selector } : {}),
      ...(effect.granularity !== undefined ? { granularity: effect.granularity } : {}),
      ...(effect.delivery !== undefined ? { delivery: effect.delivery } : {})
    };

    if (!effect.enabled) {
      // A DISABLE ALWAYS WINS — at any tier, in any quantity, and regardless of a condition this
      // resolution cannot evaluate. Subtracting is the only direction that cannot fail open.
      disabledBy = true;
      contributions.push({ ...decorated, contributed: "disable" });
      continue;
    }

    if (candidate.conditional) {
      // An unevaluable condition may never ENABLE (see the module doc).
      contributions.push({
        ...decorated,
        contributed: "ignored",
        ignoredReason: "condition_unevaluable"
      });
      continue;
    }

    enabledBy = true;
    contributions.push({ ...decorated, contributed: "enable" });

    // Most restrictive wins, over the contributions that enabled. See docs/dependencies.md §385.
    const declaredGranularity = effect.granularity ?? DEFAULT_DEPENDENCY_SUBSCRIPTION_GRANULARITY;
    if (
      granularity === undefined ||
      GRANULARITY_RESTRICTIVENESS[declaredGranularity] < GRANULARITY_RESTRICTIVENESS[granularity]
    ) {
      granularity = declaredGranularity;
    }
    const declaredDelivery = effect.delivery ?? DEFAULT_DEPENDENCY_SUBSCRIPTION_DELIVERY;
    if (
      delivery === undefined ||
      DELIVERY_RESTRICTIVENESS[declaredDelivery] < DELIVERY_RESTRICTIVENESS[delivery]
    ) {
      delivery = declaredDelivery;
    }
  }

  const enabled = input.instance.unlocked && enabledBy && !disabledBy;

  return {
    enabled,
    reason: enabled
      ? "enabled"
      : !input.instance.unlocked
        ? "instance_locked"
        : disabledBy
          ? "disabled"
          : "not_enabled",
    // The `??` here covers ONE case only. See docs/dependencies.md §386.
    granularity: granularity ?? DEFAULT_DEPENDENCY_SUBSCRIPTION_GRANULARITY,
    delivery: delivery ?? DEFAULT_DEPENDENCY_SUBSCRIPTION_DELIVERY,
    contributions: contributions.sort((a, b) =>
      contributionSortKey(a) < contributionSortKey(b) ? -1 : 1
    )
  };
}

// THE COMPONENT-LEVEL GATE — "may this component's manifests be FETCHED at all?" (M21.2 ingestion)

/** The chain's three levels do not answer the same question. See docs/dependencies.md §387. */
export interface ComponentIngestionGate {
  /** May this component's dependency manifests be read? FALSE means no provider call is made. */
  readonly enabled: boolean;
  readonly reason: "enabled" | "instance_locked" | "no_enabling_contribution";
  /** The contributions of the resolution that decided it — the same explanation
   *  `resolveDependencySubscription` returns, so "which level closed this?" is answerable
   *  (charter principle 6). */
  readonly contributions: DependencySubscriptionContribution[];
  /** When the gate is OPEN. See docs/dependencies.md §388. */
  readonly witness?: DependencyLineKey;
}

/** A value for one selector field that NO candidate names. See docs/dependencies.md §389. */
function freshSelectorValue(taken: ReadonlySet<string>): string {
  let value = "(no dependency line has this)";
  while (taken.has(value)) value += "!";
  return value;
}

/** The enum is non-empty by construction; named once so the closing explanation below reads as a
 *  deliberate choice of a REAL ecosystem rather than an index into a possibly-empty list. */
const FIRST_ECOSYSTEM: DependencyLineKey["ecosystem"] =
  DependencyEcosystemSchema.options[0] ?? "npm";

/** A deterministic order over witness lines, over the three fields that identify one. */
function witnessSortKey(line: DependencyLineKey): string {
  return `${line.ecosystem}|${line.coordinate}|${line.major}`;
}

/** The ingestion gate, computed by the merge itself. See docs/dependencies.md §390. */
export function mergeComponentIngestionGate(
  input: Omit<MergeDependencySubscriptionInput, "line">
): ComponentIngestionGate {
  const named: Record<"ecosystem" | "coordinate" | "major", Set<string>> = {
    ecosystem: new Set(),
    coordinate: new Set(),
    major: new Set()
  };
  const selectors: Partial<Record<"ecosystem" | "coordinate" | "major", string>>[] = [];
  for (const candidate of input.candidates) {
    const parsed = DependencySubscriptionEffectSchema.safeParse(candidate.effect);
    // A malformed effect contributes no witness, exactly as it contributes to neither side of the
    // merge. It is still REPORTED, because the closing explanation below runs the real merge.
    if (!parsed.success) continue;
    const effect = parsed.data;
    if (effect.ecosystem !== undefined) named.ecosystem.add(effect.ecosystem);
    if (effect.coordinate !== undefined) named.coordinate.add(effect.coordinate);
    if (effect.major !== undefined) named.major.add(effect.major);
    selectors.push({
      ...(effect.ecosystem !== undefined ? { ecosystem: effect.ecosystem } : {}),
      ...(effect.coordinate !== undefined ? { coordinate: effect.coordinate } : {}),
      ...(effect.major !== undefined ? { major: effect.major } : {})
    });
  }

  const freshCoordinate = freshSelectorValue(named.coordinate);
  const freshMajor = freshSelectorValue(named.major);

  // The three fields expand differently BECAUSE THEIR DOMAINS DIFFER: `ecosystem` over the closed
  // enum (a witness outside it is not a line that can exist), the two open strings over a value
  // nothing names.
  const witnesses: DependencyLineKey[] = [];
  for (const selector of selectors) {
    const ecosystems =
      selector.ecosystem !== undefined
        ? [selector.ecosystem as DependencyLineKey["ecosystem"]]
        : DependencyEcosystemSchema.options;
    for (const ecosystem of ecosystems) {
      witnesses.push({
        ecosystem,
        coordinate: selector.coordinate ?? freshCoordinate,
        major: selector.major ?? freshMajor
      });
    }
  }
  // CANONICAL ORDER, so "which line was this satisfied on?" is the same answer on every run over
  // the same inputs — the candidate order it used to inherit is not a total order.
  witnesses.sort((a, b) => (witnessSortKey(a) < witnessSortKey(b) ? -1 : 1));

  for (const witness of witnesses) {
    const resolution = mergeDependencySubscription({
      line: witness,
      instance: input.instance,
      candidates: input.candidates
    });
    if (resolution.enabled) {
      return {
        enabled: true,
        reason: "enabled",
        contributions: resolution.contributions,
        witness
      };
    }
  }

  // NOTHING OPENED IT. The explanation still comes from the merge. See docs/dependencies.md §391.
  const closed = mergeDependencySubscription({
    line: {
      ecosystem: FIRST_ECOSYSTEM,
      coordinate: freshCoordinate,
      major: freshMajor
    },
    instance: input.instance,
    candidates: input.candidates
  });
  return {
    enabled: false,
    reason: input.instance.unlocked ? "no_enabling_contribution" : "instance_locked",
    contributions: closed.contributions
  };
}

/** The single source label for the instance tier, so the string a Decision explains itself with is
 *  not spelled twice. */
export const INSTANCE_UNLOCK_SOURCE = "instance:dependency_subscription_unlock";

/** The instance-scoped unlock, read through the tenant path. See docs/dependencies.md §392. */
export async function readInstanceSubscriptionUnlock(
  tx: TenantTx
): Promise<{ unlocked: boolean; source: string; note: string | null }> {
  const result = await tx.execute<{ unlocked: boolean; note: string | null }>(sql`
    SELECT unlocked, note
    FROM dependency_subscription_unlock
    WHERE id = 'default'
  `);
  const row = result.rows[0];
  return {
    unlocked: row?.unlocked === true,
    source: INSTANCE_UNLOCK_SOURCE,
    note: row?.note ?? null
  };
}

export interface GatherSubscriptionCandidatesInput {
  orgId: string;
  /** The component whose containment chain is walked for matching policies. */
  componentObjectId: string;
  /** The acting subject, required for group matching. See docs/dependencies.md §393. */
  actorObjectId: string;
}

/** Gathers every subscription effect a policy carries. See docs/dependencies.md §394. */
export async function gatherSubscriptionCandidates(
  tx: TenantTx,
  input: GatherSubscriptionCandidatesInput
): Promise<DependencySubscriptionCandidate[]> {
  const matches: MatchedPolicy[] = await matchPoliciesForTargets(tx, {
    orgId: input.orgId,
    targetObjectIds: [input.componentObjectId],
    actorObjectId: input.actorObjectId
  });
  if (matches.length === 0) return [];

  const typeById = new Map<string, string>();
  for (const entry of await containmentChain(tx, input.orgId, input.componentObjectId)) {
    typeById.set(entry.id, entry.typeId);
  }

  const candidates: DependencySubscriptionCandidate[] = [];
  for (const match of matches) {
    for (const effect of match.effects as unknown[]) {
      const raw = (effect as DependencySubscriptionEffectShape | null)?.dependencySubscription;
      if (raw === undefined || raw === null) continue;
      const objectTypeId = typeById.get(match.matchedAt.objectId);
      candidates.push({
        tier: tierForObjectType(objectTypeId ?? ""),
        source: `policy:${match.name}@${match.policyObjectId}`,
        ...(objectTypeId ? { objectTypeId } : {}),
        effect: raw,
        // A CEL condition this resolution has no change context to evaluate. Carried, not dropped:
        // it still DISABLES, it just may never ENABLE (module doc).
        ...(match.condition !== undefined ? { conditional: true } : {})
      });
    }
  }
  return candidates;
}

export interface ResolveDependencySubscriptionInput extends GatherSubscriptionCandidatesInput {
  line: DependencyLineKey;
}

/** Resolves the enablement of ONE. See docs/dependencies.md §395. */
export async function resolveDependencySubscription(
  tx: TenantTx,
  input: ResolveDependencySubscriptionInput
): Promise<DependencySubscriptionResolution> {
  const [instance, candidates] = await Promise.all([
    readInstanceSubscriptionUnlock(tx),
    gatherSubscriptionCandidates(tx, input)
  ]);
  return mergeDependencySubscription({ line: input.line, instance, candidates });
}

/** MAY THIS COMPONENT'S DEPENDENCY MANIFESTS BE FETCHED? See docs/dependencies.md §396. */
export async function resolveComponentIngestionGate(
  tx: TenantTx,
  input: GatherSubscriptionCandidatesInput
): Promise<ComponentIngestionGate> {
  const [instance, candidates] = await Promise.all([
    readInstanceSubscriptionUnlock(tx),
    gatherSubscriptionCandidates(tx, input)
  ]);
  return mergeComponentIngestionGate({ instance, candidates });
}

/** One entry of the ingestion work-list: a (component, line) pair whose effective enablement is
 *  TRUE, carrying the settings and the explanation that made it so. */
export interface SubscribedComponentLine {
  componentObjectId: string;
  lineId: string;
  /** The line's natural key — what an ecosystem index plugin is actually asked about. */
  line: DependencyLineKey;
  granularity: DependencySubscriptionGranularity;
  delivery: DependencySubscriptionDelivery;
  contributions: DependencySubscriptionContribution[];
}

export interface ListSubscribedComponentLinesInput {
  /** See `GatherSubscriptionCandidatesInput.actorObjectId` — including its group-scope hazard. */
  actorObjectId: string;
  /** Narrow the scan to specific components (e.g. the ones a just-accepted change touched). Omit
   *  for the whole org, which is what the M21.4 daily tick wants. */
  componentObjectIds?: string[];
}

/** One DECLARED (component, line) pair with its FULL resolution — enabled or not. What
 *  {@link resolveDeclaredComponentLines} returns; {@link listSubscribedComponentLines} is the
 *  enabled-only projection of it. */
export interface DeclaredComponentLineResolution {
  componentObjectId: string;
  lineId: string;
  /** The line's natural key — what an ecosystem index plugin is actually asked about. */
  line: DependencyLineKey;
  resolution: DependencySubscriptionResolution;
}

export interface ResolveDeclaredComponentLinesInput extends ListSubscribedComponentLinesInput {
  /** `false` (the default). See docs/dependencies.md §397. */
  includeDisabled?: boolean;
}

export interface DeclaredComponentLinesResolved {
  pairs: DeclaredComponentLineResolution[];
  /** The instance unlock this resolution read — ONE read for the whole call. */
  instance: { unlocked: boolean; source: string };
  /** The candidates gathered per component. See docs/dependencies.md §398. */
  candidatesByComponent: Map<string, DependencySubscriptionCandidate[]>;
}

/** THE ONE RESOLUTION CORE over DECLARED pairs. See docs/dependencies.md §399. */
export async function resolveDeclaredComponentLines(
  tx: TenantTx,
  orgId: string,
  input: ResolveDeclaredComponentLinesInput
): Promise<DeclaredComponentLinesResolved> {
  const instance = await readInstanceSubscriptionUnlock(tx);
  const candidatesByComponent = new Map<string, DependencySubscriptionCandidate[]>();
  const gatherFor = async (componentObjectId: string) => {
    let candidates = candidatesByComponent.get(componentObjectId);
    if (candidates === undefined) {
      candidates = await gatherSubscriptionCandidates(tx, {
        orgId,
        componentObjectId,
        actorObjectId: input.actorObjectId
      });
      candidatesByComponent.set(componentObjectId, candidates);
    }
    return candidates;
  };

  const scope = [eq(componentDependencies.orgId, orgId)];
  if (input.componentObjectIds !== undefined) {
    if (input.componentObjectIds.length === 0) {
      return { pairs: [], instance, candidatesByComponent };
    }
    scope.push(inArray(componentDependencies.componentObjectId, input.componentObjectIds));
    // Named components are gathered even when they declare nothing — see
    // `DeclaredComponentLinesResolved.candidatesByComponent`.
    for (const componentObjectId of input.componentObjectIds) await gatherFor(componentObjectId);
  }

  // DISTINCT because `manifest_path` is part of `component_dependencies`' key: one component
  // declaring the same line from two dependency manifests is ONE work item, not two polls of the
  // same registry. Ordered so the work-list itself is deterministic.
  const rows = await tx
    .selectDistinct({
      componentObjectId: componentDependencies.componentObjectId,
      lineId: dependencyLines.id,
      ecosystem: dependencyLines.ecosystem,
      coordinate: dependencyLines.coordinate,
      major: dependencyLines.major
    })
    .from(componentDependencies)
    .innerJoin(
      dependencyLines,
      and(
        eq(componentDependencies.orgId, dependencyLines.orgId),
        eq(componentDependencies.lineId, dependencyLines.id)
      )
    )
    .where(and(...scope))
    .orderBy(componentDependencies.componentObjectId, dependencyLines.id);

  const pairs: DeclaredComponentLineResolution[] = [];
  for (const pair of rows) {
    const candidates = await gatherFor(pair.componentObjectId);
    const line: DependencyLineKey = {
      // The column is plain `text` with no CHECK (0061's header: packages/schemas is the only
      // enforcement point). Cast rather than re-validate — selector comparison is string equality,
      // and a row whose ecosystem left the enum must still be resolvable, not throw.
      ecosystem: pair.ecosystem as DependencyLineKey["ecosystem"],
      coordinate: pair.coordinate,
      major: pair.major
    };
    const resolution = mergeDependencySubscription({ line, instance, candidates });
    // THE filter — on the merge's own verdict, in the one place it is written.
    if (!resolution.enabled && !input.includeDisabled) continue;
    pairs.push({
      componentObjectId: pair.componentObjectId,
      lineId: pair.lineId,
      line,
      resolution
    });
  }
  return { pairs, instance, candidatesByComponent };
}

/** THE INGESTION WORK-LIST. See docs/dependencies.md §400. */
export async function listSubscribedComponentLines(
  tx: TenantTx,
  orgId: string,
  input: ListSubscribedComponentLinesInput
): Promise<SubscribedComponentLine[]> {
  const { pairs } = await resolveDeclaredComponentLines(tx, orgId, {
    ...input,
    includeDisabled: false
  });
  return pairs.map((p) => ({
    componentObjectId: p.componentObjectId,
    lineId: p.lineId,
    line: p.line,
    granularity: p.resolution.granularity,
    delivery: p.resolution.delivery,
    contributions: p.resolution.contributions
  }));
}
