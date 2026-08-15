import { and, eq, inArray, sql } from "drizzle-orm";
import {
  DEFAULT_DEPENDENCY_SUBSCRIPTION_DELIVERY,
  DEFAULT_DEPENDENCY_SUBSCRIPTION_GRANULARITY,
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

/**
 * M21.3 — DEPENDENCY-SUBSCRIPTION ENABLEMENT RESOLUTION (ADR-0032 §3a, §6).
 *
 * Computes whether ONE (component, dependency line) pair is subscribed, as a MONOTONE AND across
 * three levels, top-down:
 *
 *     effective_enabled(component, line) =
 *         instance_unlocked  AND  component_enabled  AND  NOT line_opted_out
 *
 * A DEPENDENCY SUBSCRIPTION IS NOT AN OBJECT TYPE. It is a `dependencySubscription` EFFECT on an
 * ordinary `policy` object (ADR-0032 §3a), so the entire org-and-below half of this module reuses
 * the EXISTING machinery unchanged: `matchPoliciesForTargets` (org-rooted policy matching over
 * `containmentChain`) gathers the contributing documents and this file only reads an effect out of
 * them and folds it into the AND. No new resolution engine, no new matching rules, no new tables
 * below the instance level. That is the same division of labour `governance/scan-requirements.ts`
 * has, and this module is deliberately its structural twin.
 *
 * ATTACHMENT IS THE POLICY'S `scope`, NOT A `governed_by` EDGE. ADR-0032 §3a describes the
 * subscription as attached by `governed_by`, and `governed_by` is indeed the registered
 * (organization|domain|service|component|team) -> policy relationship — but NOTHING in policy
 * resolution reads it today: `policy-resolve.ts:22` records it as the natural later optimization
 * behind the same function signature, and the shipped matcher works off `scope.objectRef` /
 * `scope.selector` / `scope.group`. Mirroring `scanThreshold` "in every structural respect" means
 * mirroring THAT, so a subscription is authored at a scope exactly as a scan ceiling is. If
 * `governed_by` is ever materialised into the matcher, this module inherits it for free.
 *
 * ABSENT NEVER MEANS ENABLED. The AND's default is OFF at every level: no unlock row means locked,
 * no matching contribution means not enabled, and an effect with no `enabled` key does not parse at
 * all (0062's JSON Schema requires it, so it is refused at authoring time too). This is §6's
 * reading of the "absent never means zero" rule `scan_requirement_floors` established — with the
 * inversion that matters, because there "absent = 0" would have been the TIGHTEST reading and here
 * "absent = enabled" would be the LOOSEST.
 *
 * ABSENT IS NEVER THE LOOSER OPTION FOR THE SETTINGS EITHER, AND THAT IS A SEPARATE RULE. `enabled`
 * is required; `granularity` and `delivery` are optional, and an omitted one is NOT an abstention —
 * it is a vote for the most restrictive value (`patch`, `pull_request`). The MIN is therefore taken
 * over EVERY enabling contribution, silent ones included, so auto-merge is reached only when every
 * contribution that enabled this pair asked for it. A BROADER SCOPE MAY NOT GRANT AUTO-MERGE (OR A
 * LOOSER GRANULARITY) TO A NARROWER ONE THAT STAYED SILENT — see the comment at the MIN itself for
 * the failure this rules out and the ergonomic cost it accepts.
 *
 * A MISTYPED SELECTOR KEY IS REFUSED, NOT STRIPPED. `DependencySubscriptionEffectSchema` is a
 * `strictObject`, so `{enabled: true, coordinat: "@acme/lib"}` does not parse. A plain `z.object`
 * would have STRIPPED the unknown key and handed `effectMatchesLine` an effect with no selectors —
 * a WILDCARD — so one transposed character would subscribe every line in the scope, and the same
 * typo on an opt-out would wildcard the DISABLE. That is the property 0062 already argues for a bad
 * ecosystem VALUE ("a voided selector fails OPEN"), and a key is the other half of it. 0062's
 * `additionalProperties: false` refuses it at authoring time; this refuses it wherever else a
 * document comes from.
 *
 * THE INSTANCE LEVEL UNLOCKS AND NEVER ACTIVATES. `instanceUnlocked` is a conjunct, never a
 * disjunct and never a source of enablement: with the deployment unlocked and no enabling policy
 * anywhere, every pair resolves NOT enabled. An instance flag that silently activated authoring on
 * every component would violate ADR-0006's "managed execution is never a default", and the AND
 * makes that structurally impossible rather than a rule someone has to remember (ADR-0032 §6).
 *
 * A DISABLE ALWAYS WINS, AT ANY TIER. The deepest level may only SUBTRACT (§6), and so may every
 * other level: one matching `enabled: false` defeats any number of enables from any tier. That
 * asymmetry is why this is an AND of "some enable" with "no disable" rather than a
 * nearest-scope-wins override — see the ORDER-INDEPENDENCE note below for why an override could not
 * be well-defined here at all.
 *
 * ORDER-INDEPENDENT BY CONSTRUCTION. The merge is an existential over a SET (`some enabling`,
 * `no disabling`) plus a MIN over a total order for `granularity`/`delivery`; both are commutative
 * and associative, so the result cannot depend on the order contributions are visited in — and the
 * returned `contributions` array is sorted on a canonical key so even the EXPLANATION is
 * order-independent. That is not a nicety: `graph/containment.ts:60-73` DOCUMENTS that
 * containment-domain-vs-service is NOT a strict ordering, so two ancestors of different kinds can be
 * exactly equidistant from a component and TIE. "Most specific wins" would be undefined at that tie;
 * a monotone AND has no such failure mode. DO NOT add precedence logic here.
 *
 * TIER LABELS ARE DERIVED FROM `typeId`, NEVER FROM POSITION. `containmentChain` bounds its
 * recursion at `WHERE c.depth < 10` and does NOT error at the bound — it stops expanding, then
 * computes `maxDepth` over the rows it actually returned and inverts, so THE ORG CAN ARRIVE AT A
 * NONZERO DEPTH WHILE A TOP-LEVEL DOMAIN OCCUPIES INDEX 0 (BUILD_AND_TEST.md M21.3, "a ceiling whose
 * ROOT LABELS CAN LIE"; measured and escalated by the outpost-UI session, pinned upstream in
 * `nested-domains.integration.test.ts`'s "AT THE BOUND"). M21 inherits that rather than adding a
 * seventh copy of the bound, so nothing here reads `chain[0]` and nothing here reads `depth`.
 * `tierForObjectType` below is the only mapping, and it is fed each entry's own `typeId`.
 *
 * A CEL `condition` MAY NEVER ENABLE, AND STILL DISABLES. A policy may carry a CEL `condition`, and
 * enablement resolution has NO change context to evaluate one against — there is no proposed change
 * here, only a component and a line. The two directions are therefore treated differently, in the
 * only way that cannot fail open:
 *   - a conditional ENABLE is admitted to neither side and recorded as `ignored`
 *     (`condition_unevaluable`), because an unevaluable condition that enabled would let
 *     `when env == "prod"` subscribe a component in dev;
 *   - a conditional DISABLE is admitted in full, because subtracting can only ever leave FEWER
 *     pairs subscribed, and dropping it would leave a line subscribed that its opt-out named.
 * This is the same fail-in-the-safe-direction reasoning `scan-requirements.ts` applies to an
 * ERRORING condition, resolved for the case ADR-0032 §6 does not mention.
 *
 * MALFORMED CONTRIBUTES NOTHING, BUT IS REPORTED. An effect that does not parse is admitted to
 * neither side rather than throwing — an unparseable subscription must never turn a background tick
 * into a 500. Unlike a malformed scan ceiling, though, it is NOT harmless in one direction only: a
 * malformed OPT-OUT fails open. So it is recorded in `contributions` as `ignored` (`malformed`)
 * instead of being dropped silently, and the operator's real defence is 0062's JSON Schema, which
 * refuses it at authoring time.
 *
 * THE INGESTION WORK-LIST IS DERIVED FROM THIS RESOLUTION. `listSubscribedComponentLines` filters on
 * the SAME `mergeDependencySubscription` result rather than re-expressing the AND, which is what
 * makes "ingestion only happens for enabled components" true BY CONSTRUCTION rather than by a filter
 * a caller can forget (ADR-0032 §6, BUILD_AND_TEST.md M21.3). The AND appears exactly once in this
 * file — in `mergeDependencySubscription` — and every other function calls it.
 *
 * WHAT THIS MODULE DOES NOT DO. It writes nothing, it mints no relationship, and it exposes no
 * transitive traversal: the pairs it reads are `component_dependencies` rows, which are DIRECT
 * declarations only (ADR-0032 §3/§4). Adding a walk here would invalidate the reason the inventory
 * is tabular at all.
 */

// -------------------------------------------------------------------------------------------
// The pure merge — no database, no I/O, total and order-independent
// -------------------------------------------------------------------------------------------

/**
 * A `dependencySubscription` effect on a policy document — the authoring surface (`effects: [{
 * dependencySubscription: { enabled: true } }]`, validated by the policy JSON Schema updated in
 * drizzle/0062). Deliberately NOT added to `policy-model.ts`'s `PolicyEffect` union, exactly as
 * `scanThreshold` is not: that union drives the GATE's require/approve enforcement, and an
 * enablement bit is not an "unsatisfied effect" a change can fail on. `mergeContributorEffects`
 * already ignores effect shapes it does not recognize, so existing enforcement is untouched — pinned
 * by "an unrecognised effect shape leaves gate enforcement untouched" in
 * `subscription-resolution.test.ts` rather than asserted here.
 */
interface DependencySubscriptionEffectShape {
  dependencySubscription?: unknown;
}

/**
 * ONE candidate contribution, as gathered from a matched policy (or the instance row) and BEFORE
 * any of it is admitted to the AND. `effect` is deliberately `unknown`: parsing happens inside the
 * pure merge so the malformed path is unit-testable with no database.
 */
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

/** Same shape, and the reason it exists at all: AUTO-MERGE IS THE PRIVILEGED OPTION (ADR-0032 §8).
 *  Taking the MIN over every enabling contribution — silent ones included, at `pull_request` — means
 *  auto-merge is reached ONLY when every contribution that enabled this pair declared it. Two
 *  policies that each asked for `pull_request` cannot combine into an auto-merge, and a policy that
 *  never asked for auto-merge cannot be handed it by a sibling OR BY A BROADER SCOPE. */
const DELIVERY_RESTRICTIVENESS: Record<DependencySubscriptionDelivery, number> = {
  pull_request: 0,
  auto_merge: 1
};

/** The five-tier label for a graph object type. EXPLAINABILITY ONLY — there is no precedence in an
 *  AND. Fed each chain entry's own `typeId`, NEVER its position (see the module doc: index 0 is not
 *  reliably the org). An object type outside the four org-and-below tiers is reported at the
 *  `component` (deepest) label with its real `objectTypeId` carried alongside, so the mapping stays
 *  auditable instead of silently lying — the same convention `scan-requirements.ts` uses. */
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

/**
 * Does a parsed effect's selector set match this line? EVERY PRESENT selector must EQUAL the line's
 * value; an ABSENT selector is a WILDCARD (ADR-0032 §6 authoring surface).
 *
 * COMPARISON IS VERBATIM — no case folding, no normalisation, and above all no `slugify`.
 * `graph/urn.ts` collapses `@acme/lib`, `acme/lib` and `acme-lib` into one slug, so a normalising
 * comparison would let ONE opt-out silently un-subscribe three different packages, and one enable
 * silently subscribe two nobody named. That the coordinate is stored verbatim (0061's "THE
 * COORDINATE IS NOT A URN") is only half the property; comparing it verbatim is the other half.
 */
function effectMatchesLine(effect: DependencySubscriptionEffect, line: DependencyLineKey): boolean {
  if (effect.ecosystem !== undefined && effect.ecosystem !== line.ecosystem) return false;
  if (effect.coordinate !== undefined && effect.coordinate !== line.coordinate) return false;
  if (effect.major !== undefined && effect.major !== line.major) return false;
  return true;
}

/**
 * The selectors, echoed into the contribution so "why did this apply to THIS line?" is answerable
 * from the result alone. Keys are emitted in a fixed order — the contribution sort key below is
 * built by `JSON.stringify`, and a varying key order would make it unstable.
 *
 * ALWAYS RETURNS AN OBJECT, `{}` INCLUDED. An effect with no selectors matched this line because it
 * matches EVERY line, and the explanation must say which of the two wildcards it was: deliberate, or
 * the residue of a selector that failed to bind. Omitting the key for a wildcard made those two
 * indistinguishable in a Decision. They are no longer even both reachable —
 * `DependencySubscriptionEffectSchema` is a `strictObject` and 0062 sets
 * `additionalProperties: false`, so a mistyped selector key is refused rather than stripped — but an
 * explanation that has to be read alongside a schema to be unambiguous is not an explanation
 * (charter principle 6). `{}` says "every selector deliberately absent". The key's ABSENCE is
 * reserved for the two contributions that have no selectors to report at all: the instance
 * `unlock`/`lock`, which is not a policy effect, and a `malformed` one, which never parsed.
 */
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

/**
 * THE MERGE — pure, total, order-independent, and unit-testable WITHOUT a database.
 *
 *     enabledBy  = any matching contribution with enabled === true   (and no unevaluable condition)
 *     disabledBy = any matching contribution with enabled === false
 *     effective  = instanceUnlocked AND enabledBy AND NOT disabledBy
 *
 * Extracted as a pure function per BUILD_AND_TEST.md §4.1 ("anything testable as a pure function
 * must be written as a pure function"), which is what lets the four load-bearing properties —
 * absent-never-enables, instance-unlocks-but-never-activates, a-disable-always-wins, and
 * order-independence — be pinned without Postgres.
 *
 * THIS IS THE ONLY PLACE THE AND IS WRITTEN. `resolveDependencySubscription` and
 * `listSubscribedComponentLines` both route through it; neither re-expresses it, and the work-list
 * filters on `.enabled` from this result. Writing the AND a second time anywhere is the specific
 * mistake that would let the work-list and a UI verdict disagree.
 */
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

    // MOST RESTRICTIVE WINS, over the contributions that actually ENABLED — a `granularity` or
    // `delivery` sitting on an OPT-OUT is inert, because the `continue` above means it never reaches
    // this line — and SILENCE VOTES FOR THE DEFAULT rather than abstaining. `?? DEFAULT_*` is the
    // whole of that second half, and the whole of the fix it encodes: an
    // enabling contribution that declared no `delivery` did not express "no opinion", it declined to
    // ask for the privileged option, so it votes `pull_request` and the MIN carries that vote.
    //
    // Taking the MIN over DECLARED values only (and applying the default once at the end) reads
    // absence as an abstention, and that is a genuinely different — and looser — resolver: a
    // component team's `{"enabled": true}` composed with an org-wide `{"enabled": true, "delivery":
    // "auto_merge"}` would resolve to `auto_merge`, i.e. SCP merging commits into that team's repo
    // with no pull request, on the strength of a policy the team does not own and never read. The
    // owner's requirement is that TEAMS choose PR-or-auto-merge (ADR-0032 §8), and auto-merge is the
    // privileged option; a resolver in which the privileged option arrives from above by default
    // does not implement that requirement. So, plainly: A BROADER SCOPE MAY NOT GRANT AUTO-MERGE (OR
    // A LOOSER GRANULARITY) TO A NARROWER SCOPE THAT STAYED SILENT. It may only ever RESTRICT what
    // the narrower scope asked for.
    //
    // The cost, stated rather than discovered: a team that DOES want auto-merge cannot reach it
    // while ANY other enabling contribution is silent — every enabler must declare it. That is
    // unanimity, it is the direction that fails safe, and it is why `enabled` is required while
    // these two are optional: the settings have a safe default and the switch does not.
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

  // THE AND, in one expression and one place.
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
    // The `??` here covers ONE case only — NO enabling contribution at all, where the accumulator
    // was never written and the pair is not subscribed anyway. It is NOT where an individual
    // contribution's silence is handled: that happens per-contribution inside the loop, because
    // handling it only here would let a declared `auto_merge` win over another contribution's
    // silence. Absent is never the looser option, at either level.
    granularity: granularity ?? DEFAULT_DEPENDENCY_SUBSCRIPTION_GRANULARITY,
    delivery: delivery ?? DEFAULT_DEPENDENCY_SUBSCRIPTION_DELIVERY,
    contributions: contributions.sort((a, b) =>
      contributionSortKey(a) < contributionSortKey(b) ? -1 : 1
    )
  };
}

// -------------------------------------------------------------------------------------------
// The database-backed half
// -------------------------------------------------------------------------------------------

/** The single source label for the instance tier, so the string a Decision explains itself with is
 *  not spelled twice. */
export const INSTANCE_UNLOCK_SOURCE = "instance:dependency_subscription_unlock";

/**
 * The instance-scoped unlock singleton, read through the ORDINARY tenant transaction under the
 * table's tenant-read RLS policy — no privileged connection is needed to RESOLVE an enablement,
 * exactly as `readInstanceScanFloors` needs none to evaluate a gate (ADR-0016 §3's stated reason for
 * preferring this shape). Writes are operator-only over the admin connection; see drizzle/0062.
 *
 * NO ROW MEANS LOCKED. The table ships empty and is never seeded, because absent never means
 * enabled (ADR-0032 §6): defaulting a missing row to unlocked would invert the whole chain.
 */
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
  /** The acting subject, for `scope.group` matching (DESIGN §10.1) — REQUIRED and threaded exactly
   *  as `resolveEffectiveScanThreshold` threads it.
   *
   *  INHERITED HAZARD, stated rather than discovered: a `group`-scoped policy matches only when THIS
   *  actor is a transitive `member_of` the group. A group-scoped OPT-OUT therefore does not
   *  subtract for an actor outside the group — which is the fail-open direction. It is inherited
   *  from `matchPoliciesForTargets` rather than introduced here (`scanThreshold` has the identical
   *  exposure: a group-scoped ceiling that fails to match leaves the ceiling looser), and the fix
   *  belongs in the matcher, for both consumers at once. Author opt-outs at an `objectRef` scope. */
  actorObjectId: string;
}

/**
 * Gathers every `dependencySubscription` effect that a policy matching this component's containment
 * chain carries — the impure "gather" half, mirroring `resolveEffectiveScanThreshold`'s.
 *
 * Exported and taken per-COMPONENT rather than per-(component, line) so the work-list can gather
 * once and merge many times: the candidate set depends on the component's chain, never on the line.
 *
 * The tier label for each match is looked up from the SAME `containmentChain` the matcher itself
 * walked, so a label can never describe a containment relationship the matcher did not use — and it
 * is keyed by each entry's own `typeId`, never by its index (module doc: index 0 is not reliably the
 * org).
 */
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

/**
 * Resolves the enablement of ONE (component, line) pair, with its full explanation.
 *
 * This is the single-pair convenience over the same three inputs the work-list uses — it gathers,
 * reads the unlock, and hands both to `mergeDependencySubscription`. It re-expresses none of the
 * AND.
 */
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

/**
 * THE INGESTION WORK-LIST — every (component, line) pair whose effective enablement is TRUE.
 *
 * THIS IS WHAT MAKES "INGESTION ONLY FOR ENABLED COMPONENTS" TRUE BY CONSTRUCTION (ADR-0032 §6,
 * BUILD_AND_TEST.md M21.3). It is derived from `mergeDependencySubscription` — the same merge a UI
 * or a Decision reads — rather than from a re-implementation of the AND or a filter at the call
 * site, so a disabled component cannot be fetched and an opted-out line cannot be polled by a caller
 * that simply forgot. A future caller that wants "everything, enabled or not" must call
 * `resolveDependencySubscription` per pair and decide for itself; it cannot get it by passing a flag
 * here.
 *
 * NO SHORT-CIRCUIT ON THE UNLOCK. It is tempting to return `[]` early when the deployment is locked,
 * and it would even be correct today — but it would be the AND's first conjunct written a SECOND
 * time, in a place no test of the merge can reach. The locked case falls out of the merge instead,
 * at the cost of one policy walk per component on a deployment that has nothing to do.
 *
 * COST, STATED: one `matchPoliciesForTargets` + one `containmentChain` per COMPONENT (not per pair),
 * over a full scan of the org's `policy` objects. That is the same "honest, simple MVP choice"
 * `policy-resolve.ts:20-24` records for the gate path, on the same expectation of dozens of policies
 * per org, and it sits behind this signature if profiling ever demands better.
 *
 * DIRECT DECLARATIONS ONLY, AND NO TRAVERSAL. The pairs come from `component_dependencies` joined to
 * `dependency_lines` on `(org_id, id)` — one join, no recursion, no reachability walk. The moment a
 * traversal appears here, the reason the inventory is a table at all stops holding (ADR-0032 §3).
 */
export async function listSubscribedComponentLines(
  tx: TenantTx,
  orgId: string,
  input: ListSubscribedComponentLinesInput
): Promise<SubscribedComponentLine[]> {
  const scope = [eq(componentDependencies.orgId, orgId)];
  if (input.componentObjectIds !== undefined) {
    if (input.componentObjectIds.length === 0) return [];
    scope.push(inArray(componentDependencies.componentObjectId, input.componentObjectIds));
  }

  // DISTINCT because `manifest_path` is part of `component_dependencies`' key: one component
  // declaring the same line from two dependency manifests is ONE work item, not two polls of the
  // same registry. Ordered so the work-list itself is deterministic.
  const pairs = await tx
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

  const instance = await readInstanceSubscriptionUnlock(tx);
  const candidatesByComponent = new Map<string, DependencySubscriptionCandidate[]>();
  const subscribed: SubscribedComponentLine[] = [];

  for (const pair of pairs) {
    let candidates = candidatesByComponent.get(pair.componentObjectId);
    if (candidates === undefined) {
      candidates = await gatherSubscriptionCandidates(tx, {
        orgId,
        componentObjectId: pair.componentObjectId,
        actorObjectId: input.actorObjectId
      });
      candidatesByComponent.set(pair.componentObjectId, candidates);
    }
    const line: DependencyLineKey = {
      // The column is plain `text` with no CHECK (0061's header: packages/schemas is the only
      // enforcement point). Cast rather than re-validate — selector comparison is string equality,
      // and a row whose ecosystem left the enum must still be resolvable, not throw.
      ecosystem: pair.ecosystem as DependencyLineKey["ecosystem"],
      coordinate: pair.coordinate,
      major: pair.major
    };
    const resolution = mergeDependencySubscription({ line, instance, candidates });
    if (!resolution.enabled) continue;
    subscribed.push({
      componentObjectId: pair.componentObjectId,
      lineId: pair.lineId,
      line,
      granularity: resolution.granularity,
      delivery: resolution.delivery,
      contributions: resolution.contributions
    });
  }
  return subscribed;
}
