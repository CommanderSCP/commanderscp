import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import {
  compareVersions,
  parseComparableVersion,
  type ComparableVersion
} from "@scp/dependency-manifests";
import { boundText } from "@scp/runner-launcher";
import type {
  AdoptionEvidence,
  CampaignAdoptionResponse,
  CampaignAdoptionTarget,
  CampaignAdoptionVerdict,
  CampaignRecipe
} from "@scp/schemas";
import type { TenantTx } from "../db/tenant-tx.js";
import {
  campaignPlans,
  campaignWaveTargets,
  campaignWaves,
  componentDependencies,
  controlRuns,
  dependencyLines,
  objects
} from "../db/schema.js";
import { getCampaign } from "./campaign-repo.js";
import { getLatestCampaignPlan } from "./campaign-plan-service.js";

/** The one resolution core for has this component migrated. See docs/coordination.md §65. */

/** `decisions.kind` for the reconciler's adoption record. See docs/coordination.md §66. */
export const CAMPAIGN_ADOPTION_DECISION_KIND = "campaign_adoption";

/** The hash-chained audit action for "this campaign target was already migrated, so no member
 *  change was proposed for it" — a real, operator-visible outcome (a target reaches `succeeded`
 *  having had nothing done to it), which is precisely the sort of thing charter principle 6 says
 *  must not happen off the record. */
export const CAMPAIGN_ADOPTION_AUDIT_ACTION = "campaign.wave_target.adopted";

/** How many observation lines reach a Decision, and how long. See docs/coordination.md §67. */
const OBSERVATION_LIMIT = 25;
const OBSERVATION_MAX_CHARS = 300;

export interface CampaignAdoptionResult {
  /** `adopted` is the ONLY value that lets a target out of a campaign (and, from M25.6, out of a
   *  deadline lock). `not_adopted` and `unknown` are different facts and both keep it in. */
  verdict: CampaignAdoptionVerdict;
  /** The recipe's declared evidence source, echoed back verbatim — `null` when it declared none. */
  evidence: AdoptionEvidence | null;
  /** WHAT THE DECISION RECORDS. See docs/coordination.md §68. */
  inputContext: Record<string, unknown>;
  /** One sentence, suitable for `reasonTree.summary` and for the API response. Derived from the same
   *  observations, so the record and the page can never disagree about what was seen. */
  summary: string;
  /** The evidence lines behind {@link summary}, sorted and bounded — the same array
   *  `inputContext.observations` carries. Exposed separately so the read surface does not have to
   *  reach into an untyped `Record`. */
  observations: string[];
}

/** Where one declared version sits relative to a floor. See docs/coordination.md §69. */
export type AdoptionFloorPosition = "at_or_above" | "below" | "unpinned" | "incomparable";

/** The same version with its suffix removed, so the shared comparator orders the numeric cores. */
function withoutSuffix(version: ComparableVersion): ComparableVersion {
  return {
    major: version.major,
    minor: version.minor,
    patch: version.patch,
    precision: version.precision,
    raw: version.raw
  };
}

/** Is this suffix a VARIANT LABEL (`-slim`, `-alpine`, `+build.5`, `.4`) rather than the tail of
 *  something that merely happens to start with digits? See {@link positionAgainstFloor}. */
function isVariantSuffix(suffix: string | undefined): boolean {
  return suffix === undefined || suffix === "" || /^[-+_.]/.test(suffix);
}

/** Where a dependency row sits against the recipe floor. See docs/coordination.md §70. */
export function positionAgainstFloor(
  resolvedVersion: string | null,
  minVersion: string
): AdoptionFloorPosition {
  if (resolvedVersion === null) return "unpinned";

  const resolved = parseComparableVersion(resolvedVersion);
  const floor = parseComparableVersion(minVersion);
  if (!resolved || !floor) return "incomparable";

  const sameSuffix = (resolved.suffix ?? "") === (floor.suffix ?? "");
  if (!sameSuffix && !(isVariantSuffix(resolved.suffix) && isVariantSuffix(floor.suffix))) {
    return "incomparable";
  }

  const order = sameSuffix
    ? compareVersions(resolved, floor)
    : compareVersions(withoutSuffix(resolved), withoutSuffix(floor));
  // `compareVersions` can still decline (it is the only thing allowed to say "I cannot"), and a
  // decline is handled rather than asserted away — the same treatment `line-head.ts` and
  // `version-index.ts` give the identical return.
  if (order === undefined) return "incomparable";
  return order < 0 ? "below" : "at_or_above";
}

/** Sort, bound the count, bound each line, and name what was dropped. In that order: the truncation
 *  must happen AFTER the sort or the surviving subset would depend on row order, which is exactly
 *  the instability `observations` is sorted to avoid. */
function finalizeObservations(lines: string[]): string[] {
  const sorted = [...lines].sort((a, b) => a.localeCompare(b));
  const kept = sorted
    .slice(0, OBSERVATION_LIMIT)
    .map((line) => boundText(line, OBSERVATION_MAX_CHARS, 0));
  if (sorted.length > kept.length) {
    kept.push(`(and ${sorted.length - kept.length} further observation(s))`);
  }
  return kept;
}

/** This campaign's own wave target, from its latest plan. See docs/coordination.md §71. */
async function readCampaignWaveTarget(
  tx: TenantTx,
  orgId: string,
  campaignObjectId: string,
  targetObjectId: string
): Promise<{ status: string; memberChangeObjectId: string | null } | null> {
  const rows = await tx
    .select({
      status: campaignWaveTargets.status,
      memberChangeObjectId: campaignWaveTargets.memberChangeObjectId
    })
    .from(campaignWaveTargets)
    .innerJoin(
      campaignWaves,
      and(
        eq(campaignWaves.orgId, campaignWaveTargets.orgId),
        eq(campaignWaves.id, campaignWaveTargets.waveId)
      )
    )
    .innerJoin(
      campaignPlans,
      and(eq(campaignPlans.orgId, campaignWaves.orgId), eq(campaignPlans.id, campaignWaves.planId))
    )
    .where(
      and(
        eq(campaignWaveTargets.orgId, orgId),
        eq(campaignPlans.campaignObjectId, campaignObjectId),
        eq(campaignWaveTargets.targetObjectId, targetObjectId)
      )
    )
    .orderBy(desc(campaignPlans.createdAt), desc(campaignPlans.id), desc(campaignWaves.waveIndex))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * The predicate: read-time, side-effect free, one core. See docs/coordination.md §72.
 * @param recipe the campaign's parsed recipe, or `null`/`undefined` when it carries none. Passed in
 * rather than re-read here so the reconciler's once-per-campaign-per-tick parse is not repeated
 * once per target, and so a caller that already refused a MALFORMED recipe (`resolveChangeRecipe`
 * reports that distinctly from "none") does not silently get the absent-recipe answer for it.
 */
export async function evaluateCampaignAdoption(
  tx: TenantTx,
  orgId: string,
  campaignObjectId: string,
  targetObjectId: string,
  recipe: CampaignRecipe | null | undefined
): Promise<CampaignAdoptionResult> {
  const evidence = recipe?.adoption;

  // INERTNESS — BEFORE ANY READ. See docs/coordination.md §73.
  if (!evidence) {
    return {
      verdict: "unknown",
      evidence: null,
      inputContext: { evidenceKind: "none", targetObjectId, observations: [] },
      summary:
        "this campaign's recipe names no adoption evidence source, so whether this component has " +
        "migrated is unknown — absent evidence is never a pass",
      observations: []
    };
  }

  switch (evidence.kind) {
    case "delivered":
      return evaluateDelivered(tx, orgId, campaignObjectId, targetObjectId, evidence);
    case "dependency":
      return evaluateDependency(tx, orgId, targetObjectId, evidence);
    case "control":
      return evaluateControl(tx, orgId, campaignObjectId, targetObjectId, evidence);
  }
}

/** `delivered` means this campaign's own target succeeded. See docs/coordination.md §74. */
async function evaluateDelivered(
  tx: TenantTx,
  orgId: string,
  campaignObjectId: string,
  targetObjectId: string,
  evidence: Extract<AdoptionEvidence, { kind: "delivered" }>
): Promise<CampaignAdoptionResult> {
  const row = await readCampaignWaveTarget(tx, orgId, campaignObjectId, targetObjectId);
  const observations = finalizeObservations(
    row ? [`campaign wave target status: ${row.status}`] : []
  );

  const verdict: CampaignAdoptionVerdict =
    row === null ? "unknown" : row.status === "succeeded" ? "adopted" : "not_adopted";
  const summary =
    row === null
      ? "this campaign has no wave target for this component, so there is nothing to have been " +
        "delivered — unknown, never adopted"
      : row.status === "succeeded"
        ? "this campaign's member change for this component was accepted (delivered — SCP triggered " +
          "the tenant's own pipeline; it does not follow that the code changed)"
        : `this campaign's wave target for this component is '${row.status}', not 'succeeded'`;

  return {
    verdict,
    evidence,
    inputContext: { evidenceKind: "delivered", targetObjectId, observations },
    summary,
    observations
  };
}

/** `dependency` reads the component's own inventory. See docs/coordination.md §75. */
async function evaluateDependency(
  tx: TenantTx,
  orgId: string,
  targetObjectId: string,
  evidence: Extract<AdoptionEvidence, { kind: "dependency" }>
): Promise<CampaignAdoptionResult> {
  const rows = await tx
    .select({
      ecosystem: dependencyLines.ecosystem,
      coordinate: dependencyLines.coordinate,
      manifestPath: componentDependencies.manifestPath,
      declaredVersion: componentDependencies.declaredVersion,
      resolvedVersion: componentDependencies.resolvedVersion
    })
    .from(componentDependencies)
    .innerJoin(
      dependencyLines,
      and(
        eq(dependencyLines.orgId, componentDependencies.orgId),
        eq(dependencyLines.id, componentDependencies.lineId)
      )
    )
    .where(
      and(
        eq(componentDependencies.orgId, orgId),
        eq(componentDependencies.componentObjectId, targetObjectId)
      )
    );

  const header = {
    evidenceKind: "dependency" as const,
    targetObjectId,
    ecosystem: evidence.ecosystem,
    coordinate: evidence.coordinate,
    minVersion: evidence.minVersion
  };

  // NEVER INGESTED. Checked before anything else and answered `unknown` — see the matrix above.
  if (rows.length === 0) {
    const observations = finalizeObservations([]);
    return {
      verdict: "unknown",
      evidence,
      inputContext: { ...header, observations },
      summary:
        "this component has NO dependency inventory rows at all — its manifests have never been " +
        "ingested, which is a fact about CommanderSCP and not about the component. Unknown, never " +
        "adopted",
      observations
    };
  }

  // The coordinate join is byte equality on both columns, exactly as `dependency_lines` documents:
  // the coordinate is stored verbatim and case-preserved precisely because normalising it merges
  // packages that are not the same package.
  const matching = rows.filter(
    (row) => row.ecosystem === evidence.ecosystem && row.coordinate === evidence.coordinate
  );

  const positions = matching.map((row) => ({
    row,
    position: positionAgainstFloor(row.resolvedVersion, evidence.minVersion)
  }));

  const observations = finalizeObservations(
    positions.map(
      ({ row, position }) =>
        `${row.manifestPath}: declared '${row.declaredVersion}' resolved ` +
        `${row.resolvedVersion === null ? "(none — the manifest pins no concrete version)" : `'${row.resolvedVersion}'`}` +
        ` -> ${position} ${evidence.minVersion}`
    )
  );

  const below = positions.filter((p) => p.position === "below");
  const indeterminate = positions.filter(
    (p) => p.position === "unpinned" || p.position === "incomparable"
  );

  // POSITIVE EVIDENCE OF NON-ADOPTION WINS over an indeterminate sibling. A component with one
  // manifest pinning 2.7 and another pinning an open range is observably a laggard: the range tells
  // us nothing, the pin tells us it is below the floor, and "we cannot tell" must not dilute a fact
  // we can tell. The verdicts are ordered by what they are evidence OF, not by how many rows voted.
  if (below.length > 0) {
    return {
      verdict: "not_adopted",
      evidence,
      inputContext: { ...header, observations },
      summary:
        `${below.length} declaration(s) of '${evidence.coordinate}' resolve below ` +
        `${evidence.minVersion}`,
      observations
    };
  }
  if (indeterminate.length > 0) {
    return {
      verdict: "unknown",
      evidence,
      inputContext: { ...header, observations },
      summary:
        `${indeterminate.length} declaration(s) of '${evidence.coordinate}' cannot be placed ` +
        `against ${evidence.minVersion} (an open range pins no concrete version; a version pair the ` +
        `repository's single comparator declines to order is not ordered by anything it knows) — ` +
        `unknown, never adopted`,
      observations
    };
  }

  return {
    verdict: "adopted",
    evidence,
    inputContext: { ...header, observations },
    summary:
      matching.length === 0
        ? `this component's manifests have been ingested and none of them declares ` +
          `'${evidence.coordinate}' at all`
        : `every declaration of '${evidence.coordinate}' this component's manifests carry ` +
          `(${matching.length}) resolves at or above ${evidence.minVersion}`,
    observations
  };
}

/** `control` reads the latest control run for the target. See docs/coordination.md §76. */
async function evaluateControl(
  tx: TenantTx,
  orgId: string,
  campaignObjectId: string,
  targetObjectId: string,
  evidence: Extract<AdoptionEvidence, { kind: "control" }>
): Promise<CampaignAdoptionResult> {
  const header = {
    evidenceKind: "control" as const,
    targetObjectId,
    controlObjectId: evidence.controlObjectId
  };

  const waveTarget = await readCampaignWaveTarget(tx, orgId, campaignObjectId, targetObjectId);
  const memberChangeObjectId = waveTarget?.memberChangeObjectId ?? null;
  if (memberChangeObjectId === null) {
    const observations = finalizeObservations([]);
    return {
      verdict: "unknown",
      evidence,
      inputContext: { ...header, observations },
      summary:
        "this campaign has no member change for this component yet, and a control run is recorded " +
        "against a change — so there is no run that could exist. Unknown, never adopted",
      observations
    };
  }

  const rows = await tx
    .select({
      id: controlRuns.id,
      status: controlRuns.status,
      pluginModule: controlRuns.pluginModule
    })
    .from(controlRuns)
    .where(
      and(
        eq(controlRuns.orgId, orgId),
        eq(controlRuns.changeObjectId, memberChangeObjectId),
        eq(controlRuns.controlObjectId, evidence.controlObjectId)
      )
    )
    // `(created_at, id)` DESC — `id` is UUIDv7, so it is a deterministic tiebreak for two runs
    // recorded in one transaction rather than leaving "latest" to the planner.
    .orderBy(desc(controlRuns.createdAt), desc(controlRuns.id))
    .limit(1);

  const run = rows[0];
  if (!run) {
    const observations = finalizeObservations([
      `member change ${memberChangeObjectId}: no run of control ${evidence.controlObjectId}`
    ]);
    return {
      verdict: "unknown",
      evidence,
      inputContext: { ...header, observations },
      summary: `control ${evidence.controlObjectId} has never run for this component's member change — unknown, never adopted`,
      observations
    };
  }

  const observations = finalizeObservations([
    `control run ${run.id}: status '${run.status}', plugin module ` +
      `${run.pluginModule === null ? "(not stamped)" : `'${run.pluginModule}'`}`
  ]);
  return {
    verdict: run.status === "pass" ? "adopted" : "not_adopted",
    evidence,
    inputContext: { ...header, observations },
    summary:
      run.status === "pass"
        ? `the latest run of control ${evidence.controlObjectId} for this component's member change passed`
        : `the latest run of control ${evidence.controlObjectId} for this component's member change is '${run.status}', not 'pass'`,
    observations
  };
}

// CONSUMER 2 — the read surface, over the SAME predicate

/** `objects.id` is `uuid`, so a non-UUID string handed to `inArray` is a Postgres cast error rather
 *  than an empty result — which would take out the whole request for one un-normalised target. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Every target's verdict, derived live at read time. See docs/coordination.md §77. */
export async function buildCampaignAdoptionReport(
  tx: TenantTx,
  orgId: string,
  campaignObjectId: string
): Promise<CampaignAdoptionResponse> {
  // 404s on a missing/tombstoned campaign, exactly like `GET /campaigns/{id}:explain`.
  const campaign = await getCampaign(tx, orgId, campaignObjectId);
  const plan = await getLatestCampaignPlan(tx, orgId, campaignObjectId);

  const declared =
    plan !== null
      ? plan.waves.flatMap((wave) => wave.targets.map((t) => t.targetObjectId))
      : campaign.targets;
  // Deduped (a target can in principle appear in more than one plan's waves) and SORTED, so two
  // reads of an unchanged campaign return byte-identical bodies.
  const candidates = [...new Set(declared)].sort((a, b) => a.localeCompare(b));

  const resolvable = candidates.filter((id) => UUID_RE.test(id));
  const rows =
    resolvable.length === 0
      ? []
      : await tx
          .select({ id: objects.id, urn: objects.urn, name: objects.name })
          .from(objects)
          .where(
            and(
              eq(objects.orgId, orgId),
              inArray(objects.id, resolvable),
              // Live-filtered: a name read off a tombstone is still a tombstone being read as
              // present, and a deleted target is one this report must not pretend to have an
              // adoption verdict about.
              isNull(objects.deletedAt)
            )
          );
  const live = new Map(rows.map((row) => [row.id, row]));

  const targets: CampaignAdoptionTarget[] = [];
  const unresolvedTargets: string[] = [];
  for (const candidate of candidates) {
    const object = live.get(candidate);
    if (!object) {
      unresolvedTargets.push(candidate);
      continue;
    }
    const adoption = await evaluateCampaignAdoption(
      tx,
      orgId,
      campaignObjectId,
      candidate,
      campaign.recipe
    );
    targets.push({
      targetObjectId: candidate,
      targetUrn: object.urn,
      targetName: object.name,
      verdict: adoption.verdict,
      summary: adoption.summary,
      observations: adoption.observations
    });
  }

  return {
    campaignObjectId,
    evidence: campaign.recipe?.adoption ?? null,
    targets,
    unresolvedTargets
  };
}
