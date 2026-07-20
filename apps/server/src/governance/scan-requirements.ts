import { sql } from "drizzle-orm";
import type { TenantTx } from "../db/tenant-tx.js";
import {
  PartialScanThresholdSchema,
  type EffectiveScanThreshold,
  type PartialScanThreshold,
  type ScanRequirementTier,
  type ScanThresholdContribution
} from "@scp/schemas";
import { containmentChain } from "../graph/containment.js";
import { matchPoliciesForTargets } from "./policy-resolve.js";
import type { MatchedPolicy } from "./policy-model.js";
import type { FiredPolicy } from "./evaluate.js";

/**
 * M17.5 — SCOPED SCAN-REQUIREMENT RESOLUTION (ADR-0016).
 *
 * Computes the EFFECTIVE scan threshold for a change's targets as the per-severity MIN across a
 * SIX-tier chain, top-down:
 *
 *   platform -> trust domain (partition) -> org -> containment domain -> service -> component
 *
 * MOST-RESTRICTIVE-WINS: a child tier may only ever TIGHTEN a ceiling, never loosen it. This
 * mirrors — and is the same shape as — the existing stricter-wins `requireControls` set-union in
 * `policy-model.ts` `resolvePolicies`, where a child scope can add a required control but can never
 * drop one.
 *
 * ORDER-INDEPENDENT BY CONSTRUCTION. The merge is a per-severity MIN over a SET; MIN is commutative
 * and associative, so the result cannot depend on the order tiers are visited in. That is not a
 * nicety — it is why this design is safe on top of `graph/containment.ts`, which DOCUMENTS
 * (containment.ts:60-73) that containment-domain-vs-service is NOT a strict ordering: two ancestors
 * of different kinds can be exactly equidistant from a component and TIE. "Most specific wins"
 * override semantics would be undefined at that tie; most-restrictive-wins has no such failure mode.
 * DO NOT add ordering/precedence logic here — it would reintroduce exactly the sensitivity this
 * design exists to avoid.
 *
 * TWO SENSES OF "DOMAIN", never conflated (ADR-0016 terminology):
 *  - `trust_domain` — the AMBIENT federation boundary (a partition) ABOVE org. Comes from the
 *    instance-scoped `scan_requirement_floors` table (no `org_id`), which applies to EVERY org on
 *    the deployment.
 *  - `containment_domain` — the intra-org `domain` OBJECT TYPE BELOW org, an ordinary graph node on
 *    the containment chain.
 * The stored/emitted literal is `trust_domain`, never bare `domain`.
 *
 * WHAT IS NEW HERE AND WHAT IS NOT. The four org-and-below tiers reuse the EXISTING machinery
 * unchanged: `matchPoliciesForTargets` (org-rooted policy matching over `containmentChain`) gathers
 * the contributing policy documents; this module only reads a `scanThreshold` effect out of them and
 * folds it into the MIN. No new resolution engine, no new matching rules, no new tables for
 * org-and-below (charter principle 2 — new concepts arrive as policy data). Only the two above-org
 * tiers are new structure, and they share ONE table.
 *
 * ABSENT NEVER MEANS ZERO. A tier that sets no ceiling for a severity contributes NOTHING for that
 * severity. Reading "no floor" as 0 would make it the TIGHTEST possible ceiling and would block
 * everything — the exact inversion of the intended semantics.
 *
 * CONDITIONS ARE HONOURED — a ceiling comes ONLY from the FIRED set. An org-and-below contributor
 * whose CEL `condition` evaluated FALSE contributes NOTHING, exactly as it contributes no
 * `requireControls`/`requireApprovals` (evaluate.ts `resolveFiredPolicies`; gate-orchestrator.ts
 * drives both off the same `fired`). Anything else would let `when env == "prod", maxCritical: 0`
 * silently apply in dev — tightening-only, so never unsafe, but SILENTLY over-restrictive and a
 * block citing a policy whose condition was false (charter principle 6: every verdict must explain
 * itself). Fail-closed semantics are INHERITED, not reinvented: `resolveFiredPolicies` already
 * fires a group closed when a REQUIRED contributor's condition ERRORS and counts that contributor
 * in `contributingPolicyVersions`, so such a contributor still supplies its ceiling.
 *
 * The instance-scoped floors (platform / trust domain) carry no condition and are unaffected.
 */

/** A `scanThreshold` effect on a policy document — the org-and-below tiers' authoring surface
 *  (`effects: [{ scanThreshold: { maxHigh: 0 } }]`, validated by the policy JSON Schema updated in
 *  drizzle/0029). Deliberately NOT added to `policy-model.ts`'s `PolicyEffect` union: that union
 *  drives the gate's require/approve enforcement, and a scan ceiling is not an "unsatisfied effect"
 *  — it is an INPUT to a control's own verdict. `mergeContributorEffects` already ignores effect
 *  shapes it doesn't recognize, so existing enforcement is untouched. */
interface ScanThresholdEffect {
  scanThreshold?: unknown;
}

const SEVERITY_KEYS = ["maxCritical", "maxHigh", "maxMedium", "maxLow"] as const;

/**
 * The six-tier label for a graph object type. Only used for EXPLAINABILITY (which tier set the
 * ceiling) — never for precedence, because there is no precedence in a MIN. An object type outside
 * the four org-and-below tiers is reported at the `component` (deepest) label with its real
 * `objectTypeId` carried alongside, so the mapping stays auditable instead of silently lying.
 */
function tierForObjectType(objectTypeId: string): ScanRequirementTier {
  switch (objectTypeId) {
    case "organization":
      return "org";
    case "domain":
      // The intra-org containment domain — NOT the trust domain (partition). See the module doc.
      return "containment_domain";
    case "service":
      return "service";
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

/**
 * THE MERGE — pure, order-independent, per-severity MIN over the contributing tiers.
 *
 * Extracted as a pure function (BUILD_AND_TEST.md §4.1: "anything testable as a pure function must
 * be written as a pure function") so the order-independence property is unit-testable without a
 * database, and integration-testable at the real gate.
 */
export function mergeScanThresholds(contributors: ScanThresholdContribution[]): EffectiveScanThreshold {
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

/** The instance-scoped (above-org) floors — `platform` + `trust_domain`, read through the ORDINARY
 *  tenant transaction under the table's tenant-read RLS policy. No privileged connection is needed
 *  to EVALUATE a gate (ADR-0016 §3's stated reason for preferring this over a privileged table). */
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
    if (SEVERITY_KEYS.every((k) => threshold[k] === undefined)) continue; // an all-NULL row is inert
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

/**
 * The `(policyObjectId, policyVersion)` keys of every contributor that actually FIRED — plus, by
 * construction, any REQUIRED contributor whose condition ERRORED, because `resolveFiredPolicies`
 * fires that group closed and counts the errored contributor in `contributingPolicyVersions`. This
 * is the same set that drives `requireControls`/`requireApprovals`, so a scan ceiling can never
 * apply under a condition that didn't hold.
 */
function firedContributorKeys(firedPolicies: FiredPolicy[]): Set<string> {
  const keys = new Set<string>();
  for (const fp of firedPolicies) {
    if (!fp.fired) continue;
    for (const c of fp.contributingPolicyVersions) keys.add(`${c.policyObjectId}::${c.policyVersion}`);
  }
  return keys;
}

/**
 * Resolves the effective scan threshold for a change's targets across all six tiers.
 *
 * Returns `undefined` when NO tier contributes any ceiling — mirroring how the gate leaves
 * `context.artifactDigest` unset rather than inventing one: the control then falls back to its own
 * per-binding `config.threshold`, the documented M17.1 behaviour, unchanged.
 */
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

  // Only the FIRED contributors may set a ceiling (see the module doc). A matched-but-not-fired
  // policy is dropped here exactly as it is dropped from `requireControls` at the gate.
  const firedKeys = firedContributorKeys(input.firedPolicies);

  for (const match of matches) {
    if (!firedKeys.has(`${match.policyObjectId}::${match.policyVersion}`)) continue;
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
