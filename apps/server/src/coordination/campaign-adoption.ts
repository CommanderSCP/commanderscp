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

/**
 * ================================================================================================
 * M25.5 — THE ONE RESOLUTION CORE for "has component X migrated yet?"
 * ================================================================================================
 *
 * `docs/proposals/campaigns-rework.md` §3.4 is the design of record. Its first sentence is the one
 * that shapes every line below:
 *
 *   > **SCP cannot know in general whether a component has been migrated.**
 *
 * There is no per-component standing state store. `observed_state` is per-wave-target,
 * `control_runs` is per-change, and neither answers "what is true of this component right now".
 * So a recipe must NAME its own evidence source (`AdoptionEvidenceSchema`), and where it names none
 * — or where the named source is SILENT — the verdict is `unknown` and **never `adopted`**. That is
 * `boundary-segment.ts`'s honesty rule R3 ("silence is never a pass") applied unchanged.
 *
 * THAT RULE IS THE ENTIRE SAFETY PROPERTY, because of who reads this function. M25.6's deadline lock
 * calls this and nothing else — one resolution core, no second opinion — so an `adopted` conjured
 * out of an absent fact does not merely mis-render a page: it produces a Decision plus a
 * hash-chained audit event asserting that a component met a migration deadline that nobody observed
 * it meeting. An `unknown` costs a component staying in a campaign it may already have left. Those
 * two errors are not symmetric and this module never treats them as if they were.
 *
 * -----------------------------------------------------------------------------------------------
 * WHAT THIS MODULE IS NOT
 * -----------------------------------------------------------------------------------------------
 *  - **Not a stored status.** Nothing here writes an adoption column and nothing schedules a sweep.
 *    Every verdict is re-derived from the named source at read time, which is what makes a late
 *    migration, a re-ingested manifest or a re-run control clear it with NO "mark adopted" verb.
 *    Campaign status is derived, never stored, and adoption is a campaign fact.
 *  - **Not memoised.** Deliberately, and the omission is the design. M22.0a exists because a control
 *    run computed during `validating` silently authorised a wave three weeks later off a cache key
 *    that omitted gate identity. The natural call pattern here needs no cache at all: the reconciler
 *    evaluates each `(campaign, target)` exactly once per tick and the route evaluates each once per
 *    request. Should a future caller ever want one, its key must be
 *    `(campaignObjectId, targetObjectId, evidence-identity)` — anything coarser is M22.0a again.
 *  - **Not a writer.** It takes a `TenantTx` and only ever reads. The Decision, the audit event and
 *    the terminalisation all belong to the CONSUMER (`campaign-reconcile.ts`), which is what lets
 *    the read surface answer the same question with no side effects at all.
 *
 * -----------------------------------------------------------------------------------------------
 * INERTNESS IS A REQUIREMENT, NOT A NICETY
 * -----------------------------------------------------------------------------------------------
 * A recipe declaring no `adoption` — which is every campaign authored before this milestone and
 * every campaign that simply does not want the feature — must cost **zero queries**. The early
 * return below happens before `tx` is touched, and `campaign-reconcile.ts` additionally skips the
 * call entirely. Both, because "the guard at the call site" is exactly the kind of protection that
 * survives until the second call site.
 */

/** `decisions.kind` for the reconciler's adoption record. `kind` is unconstrained `text` and the
 *  read schemas are `z.string()`, so this new value costs no migration (the proposal's data-model
 *  table records it alongside `freeze_admission` and `campaign_deadline`).
 *
 *  A DEDICATED KIND, not a reuse of `gate` or `wave_target`. `insertDecisionIfChanged` dedupes
 *  against the LATEST row of a `(subject_id, kind)` pair, so sharing a kind with the campaign wave
 *  gate would make the two writers' rows alternate under one another and suppression would never
 *  fire — the exact reasoning `recordCampaignFreezeAdmissionHold` records for `freeze_admission`. */
export const CAMPAIGN_ADOPTION_DECISION_KIND = "campaign_adoption";

/** The hash-chained audit action for "this campaign target was already migrated, so no member
 *  change was proposed for it" — a real, operator-visible outcome (a target reaches `succeeded`
 *  having had nothing done to it), which is precisely the sort of thing charter principle 6 says
 *  must not happen off the record. */
export const CAMPAIGN_ADOPTION_AUDIT_ACTION = "campaign.wave_target.adopted";

/** How many observation lines reach a permanent Decision row, and how long each may be. Bounded at
 *  the PRODUCER for the reason `describeRecipeIssues` states: a cap applied at the Decision would
 *  leave the audit event and the API response unbounded, and a reviewer checking any one writer
 *  would find it guarded. A component with 400 declarations of one coordinate is not a shape any
 *  operator reads; it is a shape that writes 400 lines into every row of the permanent record. */
const OBSERVATION_LIMIT = 25;
const OBSERVATION_MAX_CHARS = 300;

export interface CampaignAdoptionResult {
  /** `adopted` is the ONLY value that lets a target out of a campaign (and, from M25.6, out of a
   *  deadline lock). `not_adopted` and `unknown` are different facts and both keep it in. */
  verdict: CampaignAdoptionVerdict;
  /** The recipe's declared evidence source, echoed back verbatim — `null` when it declared none. */
  evidence: AdoptionEvidence | null;
  /**
   * WHAT THE DECISION RECORDS. Evidence and only evidence: the declared/resolved version pair, the
   * control run id, the wave target status.
   *
   * **BANNED FROM THIS OBJECT, permanently and by name:** `now`, `evaluatedAt`, any timestamp of
   * evaluation, any attempt counter, any remaining-TTL. The reconciler calls this on every 1 s tick,
   * and `insertDecisionIfChanged` suppresses a restatement by comparing CONTENT — so a single
   * clock-shaped key makes every tick's context differ from the last, defeats the guard completely,
   * and reproduces the measured 1.44 GB/day production incident (ADR-0024) through a new door.
   *
   * `observations` is SORTED for the same reason with a subtler cause: `restatesDecision`
   * canonicalizes object KEYS but deliberately preserves array ORDER, and Postgres returns rows in
   * no guaranteed order. An unsorted array would make an unchanged situation look new on whichever
   * ticks the planner felt differently.
   */
  inputContext: Record<string, unknown>;
  /** One sentence, suitable for `reasonTree.summary` and for the API response. Derived from the same
   *  observations, so the record and the page can never disagree about what was seen. */
  summary: string;
  /** The evidence lines behind {@link summary}, sorted and bounded — the same array
   *  `inputContext.observations` carries. Exposed separately so the read surface does not have to
   *  reach into an untyped `Record`. */
  observations: string[];
}

/**
 * Where one declared version sits relative to a floor.
 *
 *  - `at_or_above` — satisfies the evidence.
 *  - `below`       — POSITIVE evidence of non-adoption. The component is observably a laggard.
 *  - `unpinned`    — `resolved_version` is NULL. See {@link positionAgainstFloor}.
 *  - `incomparable`— the pair cannot be ordered by anything this repository knows.
 *
 * Only the first satisfies. The last two are absences dressed differently, and neither may ever be
 * read as a pass.
 */
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

/**
 * WHERE ONE `component_dependencies` ROW SITS RELATIVE TO A RECIPE'S FLOOR — the only place in this
 * module that decides whether a declaration satisfies `minVersion`.
 *
 * -----------------------------------------------------------------------------------------------
 * NULL `resolved_version` IS `unpinned`, AND `unpinned` NEVER SATISFIES
 * -----------------------------------------------------------------------------------------------
 * `componentDependencies.resolvedVersion` is NULL exactly when the manifest pins no concrete
 * version — an open range like `>=3.23.8 <4` or `~=1.4`. Its own column doc is emphatic about what
 * that means: *"the manifest does not pin one", never "we did not look"*. So this is a real
 * observation, not a gap in ingestion — and it still cannot count as satisfying a floor, because a
 * range's floor is not what will be installed. It resolves to `unpinned`, which propagates to
 * `unknown` rather than to `adopted`. An author whose estate declares open ranges cannot get an
 * `adopted` out of this kind, and that refusal is correct: nothing in the manifest says which
 * version is running.
 *
 * -----------------------------------------------------------------------------------------------
 * SUFFIXES: WHY THIS IS NOT A BARE `compareVersions` CALL, AND WHY IT IS NOT A SECOND COMPARATOR
 * -----------------------------------------------------------------------------------------------
 * `@scp/dependency-manifests`'s `compareVersions` REFUSES any pair whose suffixes differ, and it is
 * right to: it answers *"is A an upgrade of B?"*, and `3.19-alpine` -> `3.19-slim` is a variant
 * change, not an upgrade path. This function asks a DIFFERENT question — *"does this declaration sit
 * at or above a floor?"* — for which `python:2.7-slim` is python 2.7 whatever the base image
 * variant is. Applying the upgrade rule to the floor question makes the motivating campaign useless:
 * a real fleet writes `FROM python:3.12-slim`, `3.11-alpine` and `3.12` in a mix, so a
 * `minVersion: "3"` would decline against nearly every row and the kind that is supposed to be *the
 * one that actually works for python2 -> python3* would answer `unknown` for the whole estate.
 *
 * BUT IGNORING SUFFIXES WHOLESALE IS A FALSE-`adopted` GENERATOR, which is the error that matters.
 * `parseComparableVersion`'s own doc names the shape: roughly six git shas in ten begin with a
 * digit, and `3f2a1b9c` parses as major 3 with suffix `f2a1b9c`. A bare numeric-core comparison
 * would rank that at or above a floor of `3.0` and report a sha-pinned base image as MIGRATED. That
 * is silence-as-a-pass wearing a version number.
 *
 * THE RULE, therefore, in the order it is applied:
 *   1. Identical suffixes (including both absent) — delegate to `compareVersions` unchanged. This is
 *      the ordinary case and it uses the repo's single comparator with no reinterpretation at all.
 *   2. Differing suffixes, both of them VARIANT-SHAPED (absent, or introduced by `-`/`+`/`_`/`.`) —
 *      compare the numeric cores, still through `compareVersions`, by handing it suffix-stripped
 *      copies. There is deliberately no second ordering implementation in this file: strip, then
 *      call the one comparator. `3.12-slim` vs `3.0` resolves here.
 *   3. Anything else — `incomparable`. A LETTER-introduced suffix (`3f2a1b9c`, PEP 440's `2rc1`)
 *      means the numeric core is not reliably a version, so the pair is declined. This is the clause
 *      that keeps a git sha out of `adopted`.
 *
 * The residual generosity of clause 2 is that `3.0.0-rc1` satisfies a floor of `3.0.0`. A release
 * candidate of 3.0.0 IS python 3, so for a migration floor that is the right answer; an author who
 * needs the stricter reading writes the floor with the same suffix and gets clause 1.
 */
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

/** This campaign's own wave target row for one component, from its LATEST plan.
 *
 *  The plan ordering is `(created_at, id)` DESC — byte-for-byte the tuple `getLatestCampaignPlan`
 *  uses, and matched deliberately rather than by coincidence: `created_at` defaults to `now()`,
 *  which in Postgres is TRANSACTION time, so two plans written in one transaction are genuinely
 *  ambiguous without the UUIDv7 `id` tiebreak. Two readers of "the latest plan" that disagree under
 *  a tie would let this function answer about a plan the reconciler is not driving. */
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
 * THE PREDICATE. Read-time, side-effect free, and the single core every consumer shares — the
 * campaign reconciler's actuator, `GET /campaigns/{id}/adoption`, and (from M25.6) the deadline
 * lock. A second implementation of this question is how two surfaces come to disagree about whether
 * a component is compliant, so there is exactly one.
 *
 * @param recipe the campaign's parsed recipe, or `null`/`undefined` when it carries none. Passed in
 *   rather than re-read here so the reconciler's once-per-campaign-per-tick parse is not repeated
 *   once per target, and so a caller that already refused a MALFORMED recipe (`resolveChangeRecipe`
 *   reports that distinctly from "none") does not silently get the absent-recipe answer for it.
 */
export async function evaluateCampaignAdoption(
  tx: TenantTx,
  orgId: string,
  campaignObjectId: string,
  targetObjectId: string,
  recipe: CampaignRecipe | null | undefined
): Promise<CampaignAdoptionResult> {
  const evidence = recipe?.adoption;

  // ===========================================================================================
  // INERTNESS — BEFORE ANY READ. `tx` is untouched on this path.
  // ===========================================================================================
  // A campaign that names no evidence source gets `unknown`, which is the honest answer and not a
  // degraded one: nothing was asked, so nothing was observed. It is emphatically NOT `adopted`, and
  // there is deliberately no default source — inferring `delivered` from a recipe that named nothing
  // would be the platform answering a question it was never given the means to answer.
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

/**
 * `delivered` — this campaign's own wave target for the component is `succeeded`.
 *
 * NO ROW IS `unknown`, NOT `not_adopted`. A component with no wave target in this campaign's latest
 * plan is one the campaign has never had an opinion about (no plan compiled yet, a re-plan that
 * dropped it, a target added to `properties` after compilation). There is no observation to report,
 * so R3 applies. A `pending` or `change_proposed` row, by contrast, IS an observation — the campaign
 * has reached this component and has not delivered — and that is `not_adopted`.
 */
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

/**
 * `dependency` — the component's own dependency inventory, joined to `dependency_lines` for
 * `(ecosystem, coordinate)`.
 *
 * ONE QUERY FOR BOTH FACTS, and that is not merely an optimisation. The verdict needs "does this
 * component have ANY inventory at all" and "what does it declare for this coordinate", and two
 * queries could observe those across a concurrent ingestion pass — reporting zero rows for the
 * coordinate against a non-zero total that arrived a millisecond later, i.e. `adopted` from a half
 * -written inventory. One read, one snapshot, one answer.
 *
 * THE VERDICT MATRIX, cheapest disqualifier first:
 *
 *   | what the inventory says                              | verdict       |
 *   |------------------------------------------------------|---------------|
 *   | the component has ZERO rows for ANY coordinate        | `unknown`     |
 *   | some row for this coordinate resolves BELOW the floor | `not_adopted` |
 *   | some row is `unpinned` or `incomparable`              | `unknown`     |
 *   | every row for this coordinate is at or above          | `adopted`     |
 *   | ingested, but NO row for this coordinate              | `adopted`     |
 *
 * THE FIRST ROW IS THE ONE THAT MATTERS AND IT IS THE PROPOSAL'S OWN WORDING: *"`unknown` iff the
 * component has zero inventory rows (never ingested != nothing declared)"*. A component whose
 * manifests have never been read declares nothing SO FAR AS SCP KNOWS, which is a statement about
 * SCP and not about the component. Reading it as "declares no python2, therefore migrated" is the
 * silence-as-a-pass failure exactly, and it would be handed out to every component in an estate that
 * has not wired inventory ingestion — i.e. it would fail open at precisely the largest scale.
 *
 * THE LAST ROW IS DELIBERATE TOO, and it is the difference the first row buys. The component HAS
 * been ingested and its manifests name this coordinate nowhere: a Dockerfile that moved from
 * `FROM python:2.7` to a base with no python declaration at all is a real migration outcome, and the
 * evidence for it is "we read the manifests and the laggard declaration is gone". That is an
 * observation, not a silence — which is exactly why the two cases must not be collapsed.
 */
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

/**
 * `control` — the latest `control_runs` row for `(this campaign's member change for the target,
 * controlObjectId)` is `pass`.
 *
 * `plugin_module` IS READ OFF THE RUN ROW AND THE BINDING IS NEVER RE-RESOLVED. That column exists
 * (drizzle/0063) for exactly this reason, stated in its own doc: a binding is mutable, so
 * re-pointing a control at a different checker would retroactively relabel every historical run of
 * it. A provenance label computed from "which binding matches now" is false the moment the binding
 * moves; this one is read from the resolved row, which is the only version of that label that stays
 * true. It is reported in the observations rather than acted on — an operator asking "which checker
 * actually passed this component" gets the answer that was true when it ran.
 *
 * NO MEMBER CHANGE AND NO RUN ARE BOTH `unknown`. `control_runs` is per-CHANGE, so with no member
 * change there is no row that could exist; with a member change and no run, the control simply has
 * not executed for it. Neither is evidence about the component, and R3 refuses both as passes. A run
 * that exists and is `fail`/`warning`/`skipped`/`timed_out`/`expired` IS an observation, and that is
 * `not_adopted`.
 *
 * GATE IDENTITY IS DELIBERATELY NOT PART OF THE KEY HERE, and that is worth stating because
 * `controls-repo.ts` carries a long warning that it must be — for a DIFFERENT question.
 * `latestControlRunForGate` exists because a run made during `validating` was answering "may this
 * crossing proceed", and one such row silently authorised every later crossing including a
 * production wave three weeks on (M22.0a / ADR-0033 §10). This function asks "did this control
 * observe this component pass", which is a property of the run and not of a crossing, and the
 * proposal's §3.4 states the key as `(member change, controlObjectId)`. **If this predicate is ever
 * wired into a gate — as an authorisation rather than as evidence — it must switch to
 * `latestControlRunForGate` in the same commit**, or M22.0a returns wearing this feature's clothes.
 */
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

/**
 * `GET /campaigns/{id}/adoption` — every target's verdict, derived live.
 *
 * WHERE THE TARGET LIST COMES FROM, and why it is not simply `campaign.properties.targets`. Once a
 * plan exists the plan IS the campaign's reality: it holds resolved object ids, it is what the
 * reconciler drives, and a re-plan can legitimately differ from the declared list. Before a plan
 * exists there is nothing else to read, so the declared list is used — and an entry of it that does
 * not resolve to a live object is NAMED in `unresolvedTargets` rather than dropped. An IaC-authored
 * campaign declares URN-shaped targets until the reconciler's first pass normalises them
 * (`campaign-reconcile.ts` does that write), and a target deleted after authoring never resolves at
 * all. Returning an empty `targets` array for either would be this feature's own failure mode in
 * miniature: an absence rendered as a clean result.
 *
 * N+1 BY CONSTRUCTION AND DELIBERATELY SO. This is an explain-shaped endpoint — one call, one
 * campaign, an operator waiting — and it runs the identical predicate the reconciler runs so the
 * page and the engine can never disagree. It is NOT reachable from `listCampaigns`'s per-campaign
 * loop, which is where an unguarded per-target read would actually hurt.
 */
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
