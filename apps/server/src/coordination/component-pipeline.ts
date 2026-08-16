import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { categoryOfType } from "@scp/schemas";
import type {
  ComponentPipelineHold,
  ComponentPipelineResponse,
  ComponentPipelineStage,
  ComponentPipelineTargetOutpost,
  ComponentPipelineUnplacedStage
} from "@scp/schemas";
import type { TenantTx } from "../db/tenant-tx.js";
import {
  changes,
  changeWaveTargets,
  changeWaves,
  changePlans,
  objects,
  relationships
} from "../db/schema.js";
import type { ExecutorBindingRow } from "./executor-bindings-repo.js";
import { resolveBindingForTarget } from "./binding-resolution.js";
import { ExecutorTypeSchema } from "@scp/schemas";
import { listSourceMappingsForComponents } from "./source-mappings-repo.js";
import { executionSystemConsoleBase, executorConsoleUrl, repoConsoleUrl } from "./console-urls.js";
import { matchPoliciesForTargets } from "../governance/policy-resolve.js";
import { resolvePolicies } from "../governance/policy-model.js";
import { readExistingControlOutcomes } from "../governance/control-runner.js";
import { resolvePipelineForTarget } from "./pipeline-resolution.js";
import { resolveStageDependencyStatus } from "./stage-dependency-status.js";
import { parseTopologyWaves } from "./topology-waves.js";
import { ensureFederationSelf } from "../federation/self-repo.js";
import { resolveOutpostObjectsByPeer } from "../federation/outposts-repo.js";
import { federationPeers } from "../db/schema.js";
import { artifactFactsForComponent } from "./artifact-facts.js";

/**
 * A COMPONENT'S PIPELINE — its stages, derived from durable graph state.
 *
 * ============================================================================================
 * WHY THIS EXISTS, AND WHAT IT REPLACES
 * ============================================================================================
 * The pipeline surface used to be keyed on a CHANGE (`/changes/{id}/pipeline`), so a component with
 * nothing in flight had no pipeline at all — the service board's link renders only when the row has a
 * `latestChangeId`. That is a RUN view wearing a pipeline's name, and it inverted the model: a
 * pipeline is a durable property of a component, and artifacts move THROUGH it.
 *
 * Everything here is read from state that exists whether or not anything is releasing:
 *   - the STAGES are the resolved release topology's ordered waves (see below);
 *   - what EXECUTES at a stage is that stage's placement's executor binding;
 *   - the pipeline DEFINITION and the rung it was inherited from come from `pipeline-resolution.ts`.
 * Only `current` reads change rows, and it is legitimately null for a stage nothing has released to.
 *
 * ============================================================================================
 * WHY STAGES COME FROM THE TOPOLOGY AND NOT FROM THE PLACEMENTS (owner, 2026-08-10)
 * ============================================================================================
 * The first version of this module built the stage list from the component's PLACEMENTS. That is
 * backwards for a pipeline. A pipeline's job is to show the JOURNEY — where a release goes next and
 * where it stops — and placements can only ever show where the component already IS. A wave the
 * component is not placed at did not render at all, so the single most operationally important fact,
 * "this component never reaches prod", rendered as NOTHING.
 *
 * Measured on the live estate the day it was reported: topology `commercial-gamma-then-prod` declares
 * waves `gamma` then `prod`; `agentkit-bootstrap` holds ONE placement (gamma); the view showed one
 * card and prod appeared nowhere.
 *
 * So the journey is the topology's waves, in order. A wave place this component IS placed at becomes
 * a `stages[]` entry, exactly as before; one it is NOT placed at becomes an `unplacedStages[]` entry,
 * which a client renders greyed and explicitly "not placed" — deliberately distinguishable from
 * "placed but nothing has released yet" (a `stages[]` entry with `current: null`), a different and
 * much less alarming fact. `order` is contiguous across the union, so the two arrays recombine into
 * one ordered pipeline. Why two arrays and not one nullable `placement`: see
 * `ComponentPipelineResponseSchema.unplacedStages` — it is an oasdiff ERR, measured.
 *
 * TWO CASES STILL COME FROM PLACEMENTS, and both are load-bearing:
 *
 *   1. NO STAGE-SHAPED TOPOLOGY (`stageSource: "placements"`). No rung supplies a topology, or the
 *      one it supplies is LEGACY-shaped — its waves name the change's own targets rather than
 *      deployment-targets (`plan-service.ts` classifies the same two shapes the same way, from what
 *      the ids ARE, because both exist in real data). There is no declared journey to show, so the
 *      stages are the placements, exactly as before. This is why a component with placements and no
 *      topology still has a pipeline, which is the acceptance criterion this view was built for.
 *   2. A PLACEMENT AT A TARGET NO WAVE NAMES. It is appended after the topology's stages, with a
 *      null `wave`. Dropping it would re-create this very bug mirror-imaged: real state — a place
 *      this component genuinely deploys to — hidden because a document does not mention it.
 *
 * A MALFORMED topology (`parseTopologyWaves` throws) falls back to case 1 rather than failing the
 * request: this is a read view, and a component page that fails outright because someone saved a bad
 * document tells an operator less than one that shows the placements and says where its stages came
 * from. The loud refusal stays where it changes behaviour — plan compilation, which is what
 * `topology-waves.ts`'s header is about.
 *
 * ============================================================================================
 * WHAT IS DELIBERATELY NOT OBSERVED
 * ============================================================================================
 * Per-stage VERSION (the design's "version staircase") needs an `observe()`-captured version/digest
 * — coordination-ui-views.md Phase 4a, unbuilt. Every stage therefore carries `version: null` AND
 * lists `"version"` in its `unknownFields`, so a client renders "not observed" rather than a blank
 * that reads as "no version". Same rule the service board and the graph health surfaces follow.
 */

/**
 * The most recent wave target for each placement, PER PIPELINE — "what last happened at this stage,
 * in each of the pipelines that run here", newest first.
 *
 * DISTINCT ON the (placement, TYPE) pair, not the placement alone. A stage's pipelines release
 * independently, so the single newest row across all of them describes exactly one pipeline and says
 * nothing about the others — rendered per-lane it would show the software pipeline's release as the
 * infra pipeline's, and a lane that has never run would inherit a release it never had.
 * `change_wave_targets.type` is the routing Type the plan snapshotted for this target, which is what
 * makes this a direct read.
 *
 * Ordered by the change's `created_at` then id (UUIDv7, time-ordered) so two changes created in the
 * same transaction still order deterministically — the same tiebreak `getLatestCampaignPlan`
 * documents. Several Types can share a Category (`image`/`rpm`/`npm` are all `build`), so the caller
 * reduces to one entry per Category; this returns them already newest-first for that reason.
 */
async function currentsByPlacement(
  tx: TenantTx,
  orgId: string,
  placementIds: string[]
): Promise<Map<string, ComponentPipelineStage["currents"]>> {
  const out = new Map<string, ComponentPipelineStage["currents"]>();
  if (placementIds.length === 0) return out;
  const rows = await tx.execute<{
    target_object_id: string;
    change_id: string;
    change_name: string | null;
    change_state: string | null;
    wave_name: string | null;
    target_status: string | null;
    type: string;
    created_at: string;
  }>(sql`
    SELECT DISTINCT ON (t.target_object_id, t.type)
      t.target_object_id,
      o.id     AS change_id,
      o.name   AS change_name,
      c.state  AS change_state,
      w.name   AS wave_name,
      t.status AS target_status,
      t.type   AS type,
      c.created_at AS created_at
    FROM ${changeWaveTargets} t
    JOIN ${changeWaves} w  ON w.id = t.wave_id AND w.org_id = t.org_id
    JOIN ${changePlans} p  ON p.id = w.plan_id AND p.org_id = w.org_id
    JOIN ${changes} c      ON c.object_id = p.change_object_id AND c.org_id = p.org_id
    JOIN ${objects} o      ON o.id = c.object_id AND o.org_id = c.org_id
    WHERE t.org_id = ${orgId}::uuid
      AND o.deleted_at IS NULL
      AND t.target_object_id IN (${sql.join(
        placementIds.map((id) => sql`${id}::uuid`),
        sql`, `
      )})
    ORDER BY t.target_object_id, t.type, c.created_at DESC, c.object_id DESC
  `);
  // The SQL orders WITHIN a (placement, type) group; it says nothing about the order BETWEEN groups,
  // so the newest-first guarantee this function documents is established here, in one place, rather
  // than assumed by each consumer.
  const byPlacement = new Map<string, typeof rows.rows>();
  for (const r of rows.rows) {
    const list = byPlacement.get(r.target_object_id) ?? [];
    list.push(r);
    byPlacement.set(r.target_object_id, list);
  }
  for (const [placementId, list] of byPlacement) {
    // One entry per CATEGORY: `image`, `rpm` and `npm` are all `build`, and a lane showing two
    // "last release" lines for one pipeline would be as confusing as showing none.
    const seen = new Set<string>();
    const currents: ComponentPipelineStage["currents"] = [];
    const newestFirst = [...list].sort(
      (a, b) => b.created_at.localeCompare(a.created_at) || b.change_id.localeCompare(a.change_id)
    );
    for (const r of newestFirst) {
      const category = categoryOfType(r.type);
      if (seen.has(category)) continue;
      seen.add(category);
      currents.push({
        changeId: r.change_id,
        changeName: r.change_name,
        changeState: r.change_state,
        waveName: r.wave_name,
        targetStatus: r.target_status,
        type: r.type,
        category
      });
    }
    out.set(placementId, currents);
  }
  return out;
}

/** The two wave-target statuses whose trigger can STILL be withheld — reconcile's own set, verbatim
 *  (`stage-dependency-status.ts` uses the same one for the same reason). A held target is left
 *  `pending` because the hold `continue`s before `triggerWaveTarget`; `triggering` is what a crash
 *  mid-claim leaves behind, and reconcile re-offers such a target to the hold on the next tick.
 *  Anything past those has already been handed to an executor, and a hold cannot un-ring that bell. */
const WITHHOLDABLE_STATUSES = new Set(["pending", "triggering"]);

/**
 * WHICH STAGES HAVE A RELEASE SITTING HERE WITH ITS TRIGGER WITHHELD (ADR-0028 increment 4).
 *
 * Keyed on the PLACEMENT, because in stage mode a wave target's `target_object_id` IS the placement
 * — so `status.targets[].targetObjectId` joins to `seed.placement.id` exactly, with no (component,
 * place) pair to reassemble and no chance of attributing one stage's hold to another.
 *
 * ============================================================================================
 * WHY THIS RE-EVALUATES INSTEAD OF READING THE DECISION IT ALREADY WROTE
 * ============================================================================================
 * `recordStageDependencyHold` persists a `hold` Decision carrying exactly the join keys this needs
 * (`componentObjectId` + `deploymentTargetObjectId` per entry), and reading it would be one query
 * for the whole page. It is still the wrong source, for the reason `reconcile.ts` spells out where
 * it chose `verdict: "hold"` over `"block"`: NOTHING anywhere writes a clearing row. The newest
 * `stage_dependency` row of a change that was briefly held, triggered, succeeded and reached
 * `accepted` is STILL a `hold`, permanently — so a badge sourced from it would paint every stage
 * that was EVER held as held forever, which is the permanent-marker bug rebuilt one surface over.
 * The kind is overloaded on top of that: `applyPromotionImport` writes `stage_dependency`/`allow`
 * against the same subject, so on an outpost the newest row of that kind is not a hold at all.
 *
 * `resolveStageDependencyStatus` is the ONE read side of the hold (`explain` and the watchdog use
 * the same function) and it re-runs reconcile's own predicate. It is read-only by contract and
 * persists nothing: stamping a `held` flag onto `change_wave_targets` so this could be a column read
 * would be one UPDATE per held target per 1 s tick, which is ADR-0024's 1.44 GB/day write
 * amplification relocated to another table.
 *
 * ============================================================================================
 * WHAT IT COSTS
 * ============================================================================================
 * Nothing for a component with nothing releasing (the candidate set is empty and this returns before
 * any query), and nothing for an uncoupled release: the resolver's declaration parse is in memory
 * and it returns `null` before touching the plan. The candidates are only those releases that could
 * still be withheld — a change with a `pending`/`triggering` target at one of THIS component's
 * placements — which is at most one per pipeline per stage. A candidate whose change is no longer
 * `executing` costs one indexed state read inside the resolver and stops there.
 */
async function holdsByPlacement(
  tx: TenantTx,
  orgId: string,
  currents: Map<string, ComponentPipelineStage["currents"]>
): Promise<Map<string, ComponentPipelineHold>> {
  const out = new Map<string, ComponentPipelineHold>();

  // NO LIVE-STATE GATE HERE ANY MORE, and its absence is the fix rather than an omission. This
  // module used to carry one — `current.changeState !== "executing" && continue` — and it was the
  // ONLY one of the resolver's three call sites that did, so `explain` and the watchdog reported a
  // cancelled release as held forever. The gate now lives inside `resolveStageDependencyStatus`
  // (`isStillTriggerable`), which is the one place every caller passes through. Re-adding a copy
  // here would restore the two-predicates-one-question shape that produced the bug.
  //
  // This filter is a DIFFERENT predicate and stays: a target past `pending`/`triggering` has been
  // handed to an executor, so no release at this stage could be withheld and there is nothing to
  // ask the resolver about.
  const candidates = new Set<string>();
  for (const list of currents.values()) {
    for (const current of list) {
      if (current.targetStatus && WITHHOLDABLE_STATUSES.has(current.targetStatus)) {
        candidates.add(current.changeId);
      }
    }
  }
  if (candidates.size === 0) return out;

  const changeRows = await tx
    .select({ id: objects.id, properties: objects.properties })
    .from(objects)
    .where(and(eq(objects.orgId, orgId), inArray(objects.id, [...candidates])));

  const heldByChange = new Map<
    string,
    { waveIndex: number | null; byPlacement: Map<string, ComponentPipelineHold["dependencies"]> }
  >();
  for (const row of changeRows) {
    const status = await resolveStageDependencyStatus(tx, orgId, {
      objectId: row.id,
      properties: row.properties as Record<string, unknown> | null
    });
    if (!status) continue;
    const byPlacement = new Map<string, ComponentPipelineHold["dependencies"]>();
    for (const target of status.targets) {
      if (!target.held) continue;
      // ONLY THE UNSATISFIED ones. A change declaring three dependencies of which one is behind is
      // held by that one, and listing the two that are met beside it would bury the answer in the
      // question.
      const unsatisfied = target.dependencies.filter((dependency) => !dependency.satisfied);
      if (unsatisfied.length > 0) byPlacement.set(target.targetObjectId, unsatisfied);
    }
    if (byPlacement.size > 0) {
      heldByChange.set(row.id, { waveIndex: status.waveIndex, byPlacement });
    }
  }
  if (heldByChange.size === 0) return out;

  for (const [placementId, list] of currents) {
    // `currents` is newest-first (established in `currentsByPlacement`), so the first of this
    // stage's releases that is actually held is the one to report. A stage carrying a held
    // `configuration` release and an older, finished `image` one is held by the former.
    for (const current of list) {
      const held = heldByChange.get(current.changeId);
      const dependencies = held?.byPlacement.get(placementId);
      if (!held || !dependencies) continue;
      out.set(placementId, {
        changeId: current.changeId,
        changeName: current.changeName,
        waveIndex: held.waveIndex,
        dependencies
      });
      break;
    }
  }
  return out;
}

/** One stage BEFORE it is hydrated — the ordering decision, separated from the I/O it drives. */
interface StageSeed {
  deploymentTargetId: string;
  /** Which topology wave declared it, or null for a placement no wave names (case 2 above). */
  wave: { index: number; name: string | null } | null;
  /** The component's placement at this target, or null when it is not placed there. */
  placement: { id: string; urn: string } | null;
}

/**
 * The topology's waves as ordered lists of DEPLOYMENT-TARGET ids, or `undefined` when this topology
 * declares no journey over places.
 *
 * `undefined` covers three genuinely different documents, all of which mean the same thing HERE —
 * "there is no declared sequence of places to show":
 *   - no `waves` key at all (`parseTopologyWaves` returns undefined);
 *   - a malformed document (`parseTopologyWaves` throws — see the module header on why a read view
 *     absorbs that instead of failing);
 *   - a LEGACY-shaped document whose waves name the change's own targets rather than places. This is
 *     classified from what the ids ARE, exactly as `plan-service.ts#resolveStagePlacements` does,
 *     because both shapes exist in real data and no flag on the document distinguishes them.
 */
async function topologyWavePlaces(
  tx: TenantTx,
  orgId: string,
  topologyDocument: unknown
): Promise<{ index: number; name: string | null; targetIds: string[] }[] | undefined> {
  let waves;
  try {
    waves = parseTopologyWaves(topologyDocument);
  } catch {
    return undefined;
  }
  if (!waves || waves.length === 0) return undefined;

  const ids = [...new Set(waves.flatMap((w) => w.targets))];
  if (ids.length === 0) return undefined;
  const rows = await tx
    .select({ id: objects.id, typeId: objects.typeId })
    .from(objects)
    .where(and(eq(objects.orgId, orgId), inArray(objects.id, ids), isNull(objects.deletedAt)));
  const places = new Set(rows.filter((r) => r.typeId === "deployment-target").map((r) => r.id));
  // A MIXED topology is refused at compile time (`resolveStagePlacements`), so the journey it
  // describes never actually runs. Showing the place-shaped half of it is still strictly more than
  // showing nothing, and the ids that name no live place are dropped rather than rendered as
  // stages that do not exist.
  if (places.size === 0) return undefined;

  const out: { index: number; name: string | null; targetIds: string[] }[] = [];
  const seen = new Set<string>();
  waves.forEach((w, index) => {
    // A target named by two waves belongs to the FIRST — that is where the release reaches it.
    const targetIds = w.targets.filter((id) => places.has(id) && !seen.has(id));
    targetIds.forEach((id) => seen.add(id));
    out.push({ index, name: w.name ?? null, targetIds });
  });
  return out;
}

/**
 * WHAT GATES ENTRY TO ONE STAGE — the same policy resolution the wave-boundary gate runs, so this
 * view cannot disagree with the engine about what is required.
 *
 * `actorObjectId` is the REQUESTING user, because `scope.group` policies match on the acting
 * subject (DESIGN §10.1): the honest reading of this field is therefore "what would gate a release
 * YOU made", not "what gates everyone". Passing a system placeholder instead would silently drop
 * every group-scoped policy and under-report the gate, which is the worse error of the two.
 */
async function gateForStage(
  tx: TenantTx,
  orgId: string,
  actorObjectId: string,
  placementObjectId: string,
  /** The release the check statuses are AS OF — the newest change at this stage, or null when
   *  nothing has ever reached it. A `control_run` belongs to a CHANGE (`control_runs.change_object_id`),
   *  so there is no such thing as a control outcome for a stage in the abstract; saying which change
   *  the answer is about is what keeps "passed" from reading as a standing property of the place. */
  asOfChangeId: string | null
): Promise<ComponentPipelineStage["gate"]> {
  const matched = await matchPoliciesForTargets(tx, {
    orgId,
    targetObjectIds: [placementObjectId],
    actorObjectId
  });
  const policies = resolvePolicies(matched).map((p) => ({
    name: p.name,
    enforcement: p.enforcement,
    requireControls: p.requireControls,
    requireApprovals: p.requireApprovals.map((a) => ({
      count: a.count,
      fromRole: a.fromRole,
      scope: a.scope
    }))
  }));

  const controlIds = [...new Set(policies.flatMap((p) => p.requireControls))];
  const outcomes = asOfChangeId
    ? await readExistingControlOutcomes(tx, orgId, asOfChangeId, controlIds)
    : {};
  const checks: ComponentPipelineStage["gate"]["checks"] = [];
  for (const controlId of controlIds) {
    const control = await tx.query.objects.findFirst({
      where: (t, { eq: eqOp, and: andOp }) => andOp(eqOp(t.id, controlId), eqOp(t.orgId, orgId))
    });
    const recorded = outcomes[controlId];
    checks.push({
      controlId,
      // A DANGLING reference is kept with a null name rather than dropped: a policy requiring a
      // control that no longer exists blocks every release, and that must be visible.
      name: control?.name ?? null,
      status: recorded ?? (asOfChangeId ? "pending" : "not_started"),
      changeId: asOfChangeId
    });
  }

  return { policies, checks };
}

export async function getComponentPipeline(
  tx: TenantTx,
  orgId: string,
  component: {
    id: string;
    urn: string;
    name: string;
    originDomainId: string;
    domainLocal: boolean;
  },
  actorObjectId: string
): Promise<ComponentPipelineResponse> {
  // The component's placements, read from `properties` — the source of truth for the pair
  // (ADR-0026 D17), and the same half `binding-resolution.ts` and `plan-service.ts` read. These are
  // no longer the stage LIST; they are what tells each stage whether it is placed.
  const placementRows = await tx
    .select({ id: objects.id, urn: objects.urn, properties: objects.properties })
    .from(objects)
    .where(
      and(
        eq(objects.orgId, orgId),
        eq(objects.typeId, "placement"),
        isNull(objects.deletedAt),
        sql`${objects.properties} ->> 'componentId' = ${component.id}`
      )
    );

  const placementByTargetId = new Map<string, { id: string; urn: string }>();
  for (const p of placementRows) {
    const props = p.properties as { deploymentTargetId?: unknown };
    if (typeof props.deploymentTargetId !== "string") continue;
    // `placement`'s unique index is on the (component, target) PAIR, so there is at most one.
    placementByTargetId.set(props.deploymentTargetId, { id: p.id, urn: p.urn });
  }

  // THE HEAD OF THE JOURNEY — which repos feed this component. Durable rules, so this answers "does
  // a push there affect this?" for a component that has never released, exactly as the stages do.
  // Sorted for a stable render: by category, then repo, then path (nulls — whole-repo rules — first,
  // since they are the broadest and the most worth noticing).
  const sourceRows = await listSourceMappingsForComponents(tx, orgId, [component.id]);
  const sources: ComponentPipelineResponse["sources"] = sourceRows
    .map((m) => ({
      id: m.id,
      sourceKind: m.sourceKind,
      repoPattern: m.repoPattern ?? null,
      pathPattern: m.pathPattern ?? null,
      refPattern: m.refPattern ?? null,
      type: m.type,
      category: categoryOfType(m.type),
      classification: m.classification ?? null,
      mirrorOfShared: m.mirrorOfShared,
      enabled: m.enabled,
      disabledUntil: m.disabledUntil,
      effectivelyEnabled: m.effectivelyEnabled,
      url: repoConsoleUrl(m.sourceKind, m.repoPattern ?? null)
    }))
    .sort(
      (a, b) =>
        a.category.localeCompare(b.category) ||
        (a.repoPattern ?? "").localeCompare(b.repoPattern ?? "") ||
        (a.pathPattern ?? "").localeCompare(b.pathPattern ?? "") ||
        // Without this, two mappings differing ONLY by ref have no tiebreak and render in whatever
        // order the query returned — an unstable list for the exact pair this feature creates.
        (a.refPattern ?? "").localeCompare(b.refPattern ?? "")
    );

  const currents = await currentsByPlacement(
    tx,
    orgId,
    placementRows.map((p) => p.id)
  );
  // ADR-0028 increment 4 — which of those releases is sitting here with its trigger WITHHELD. Read
  // live off `currents`, so it costs nothing at all for a component with nothing in flight.
  const holds = await holdsByPlacement(tx, orgId, currents);
  const self = await ensureFederationSelf(tx, orgId);
  // WHO MAINTAINS EACH PLACE. The commander gives the go-ahead; the outpost still runs its own
  // targets (ADR-0017 §2, ADR-0011). Resolved from the target's OWN `origin_domain_id` — never from
  // this instance's identity — so a replicated target reads the same at the commander and at the
  // outpost, the same rule ADR-0026 D1 applies to stage names.
  const peerRows = await tx
    .select({ id: federationPeers.id, name: federationPeers.name, role: federationPeers.role })
    .from(federationPeers)
    .where(eq(federationPeers.orgId, orgId));
  // Keyed on the PLAIN string: `federation_peers.id` is a branded `TrustDomainId` (ADR-0021), while
  // `objects.origin_domain_id` is an unbranded column, and the lookup is the one place the two meet.
  const peerById = new Map(peerRows.map((p) => [p.id as string, p]));
  const maintainerOf = (originDomainId: string | null): ComponentPipelineStage["maintainedBy"] => {
    if (originDomainId && originDomainId === self.domainId) {
      return { domainId: originDomainId, name: self.name, isSelf: true, role: self.role };
    }
    const peer = originDomainId ? peerById.get(originDomainId) : undefined;
    if (peer) {
      return { domainId: originDomainId, name: peer.name, isSelf: false, role: peer.role };
    }
    // Neither self nor a known peer. Real on a replica whose peer row has not arrived yet, and it
    // must NOT default to "ours" — claiming a place is maintained here when it is not is the exact
    // misreading this field exists to prevent.
    return { domainId: originDomainId, name: null, isSelf: false, role: null };
  };
  // WHICH OUTPOST EACH PLACE IS PART OF (§10.2, the owner's TRUST-DOMAIN RULE): the `outpost` object
  // whose `properties.peerDomainId` equals the target's OWN `origin_domain_id`. Read, never inferred
  // — not from the target's name, and not from its containment `domain_id` (GLOSSARY: containment
  // has nothing to do with deployment topology). ONE batched read of the live outpost objects (the
  // repo resolves duplicates by the same authority rule the outposts API uses — see
  // `resolveOutpostObjectsByPeer` for why that is not stated as "ambiguous"), plus the SAME
  // `federation_self` and `federation_peers` reads `maintainerOf` already made.
  const outpostByPeer = await resolveOutpostObjectsByPeer(tx, orgId);
  const outpostOf = (originDomainId: string | null): ComponentPipelineTargetOutpost => {
    if (originDomainId && originDomainId === self.domainId) {
      // Authored by THIS instance. On a commander this is every commander-authored target — the
      // honest consequence of the rule (in the model, an outpost's targets are authored by that
      // outpost); on an outpost it is its own targets.
      return { state: "self", id: null, name: self.name, trustTier: null, peerDomainId: null };
    }
    const outpost = originDomainId ? outpostByPeer.get(originDomainId) : undefined;
    if (outpost && originDomainId) {
      return {
        state: "outpost",
        id: outpost.id,
        name: outpost.name,
        trustTier: outpost.trustTier,
        peerDomainId: originDomainId
      };
    }
    const peer = originDomainId ? peerById.get(originDomainId) : undefined;
    if (peer && originDomainId) {
      // A paired peer with no `outpost` object registered — say WHO, so the operator knows which
      // peer an outpost record can be declared for (POST /federation/outposts).
      return {
        state: "peer-without-outpost",
        id: null,
        name: peer.name,
        trustTier: null,
        peerDomainId: originDomainId
      };
    }
    // Neither self nor a known peer (a replica whose peer row has not arrived; a foreign origin never
    // paired here). The raw origin id rides `peerDomainId` so it is stated, not swallowed — and it
    // must NOT read as "ours", for the same reason `maintainerOf` refuses to.
    return {
      state: "unknown-domain",
      id: null,
      name: null,
      trustTier: null,
      peerDomainId: originDomainId
    };
  };
  const resolved = await resolvePipelineForTarget(tx, orgId, component.id);

  // One binding resolution per routing Type, from the COMPONENT — the same starting rung the
  // engine's wave targets use. Mapped onto stages inside the stage loop (see the comment there
  // for the outcome semantics).
  const componentResolutions = [];
  for (const bindingType of ExecutorTypeSchema.options) {
    componentResolutions.push(await resolveBindingForTarget(tx, orgId, component.id, bindingType));
  }

  const topologyRow = resolved
    ? await tx.query.objects.findFirst({
        where: (t, { eq: eqOp, and: andOp }) =>
          andOp(eqOp(t.id, resolved.topologyObjectId), eqOp(t.orgId, orgId))
      })
    : undefined;
  const waves = await topologyWavePlaces(tx, orgId, topologyRow?.properties ?? null);
  const stageSource: ComponentPipelineResponse["stageSource"] = waves ? "topology" : "placements";

  // THE STAGE LIST, in release order: every wave the topology declares, then any place this
  // component is genuinely placed at that no wave named (module header, case 2).
  const seeds: StageSeed[] = [];
  const fromTopology = new Set<string>();
  for (const wave of waves ?? []) {
    for (const deploymentTargetId of wave.targetIds) {
      fromTopology.add(deploymentTargetId);
      seeds.push({
        deploymentTargetId,
        wave: { index: wave.index, name: wave.name },
        placement: placementByTargetId.get(deploymentTargetId) ?? null
      });
    }
  }
  const unnamed = [...placementByTargetId.entries()].filter(([id]) => !fromTopology.has(id));
  for (const [deploymentTargetId, placement] of unnamed) {
    seeds.push({ deploymentTargetId, wave: null, placement });
  }

  // One query for every place involved — wave-named and placement-named alike.
  const targetIds = [...new Set(seeds.map((s) => s.deploymentTargetId))];
  const targetRows =
    targetIds.length === 0
      ? []
      : await tx
          .select({
            id: objects.id,
            name: objects.name,
            properties: objects.properties,
            originDomainId: objects.originDomainId
          })
          .from(objects)
          .where(and(eq(objects.orgId, orgId), inArray(objects.id, targetIds)));
  const targetById = new Map(targetRows.map((t) => [t.id, t]));

  // Off-topology placements have no declared order; target name is at least stable.
  seeds.sort((a, b) => {
    if (a.wave !== null && b.wave === null) return -1;
    if (a.wave === null && b.wave !== null) return 1;
    if (a.wave !== null && b.wave !== null && a.wave.index !== b.wave.index) {
      return a.wave.index - b.wave.index;
    }
    if (a.wave !== null && b.wave !== null) return 0; // within a wave, keep the document's order
    return (targetById.get(a.deploymentTargetId)?.name ?? "").localeCompare(
      targetById.get(b.deploymentTargetId)?.name ?? ""
    );
  });

  // The journey is ONE ordered list here and splits into two arrays only at the wire (see
  // `ComponentPipelineResponseSchema.unplacedStages` for why). `order` is that list's index, so the
  // two arrays recombine into exactly this order and a client never infers an interleaving.
  const stages: ComponentPipelineStage[] = [];
  const unplacedStages: ComponentPipelineUnplacedStage[] = [];
  for (const [order, seed] of seeds.entries()) {
    const target = targetById.get(seed.deploymentTargetId);
    const tProps = (target?.properties ?? {}) as {
      environment?: unknown;
      region?: unknown;
      substrate?: unknown;
      account?: unknown;
      cluster?: unknown;
    };
    const environment = typeof tProps.environment === "string" ? tProps.environment : null;
    const region = typeof tProps.region === "string" ? tProps.region : null;
    // THE SUBSTRATE FACET (§9.1) — read verbatim off the target's own bag with the same string
    // guard as `region`. Migration 0065 types these as optional strings, but Ajv runs on WRITE only
    // and a replicated row from an older peer was never checked here, so the guard is not
    // decorative. Null = not declared. NEVER derived from `name`.
    const substrate = typeof tProps.substrate === "string" ? tProps.substrate : null;
    const account = typeof tProps.account === "string" ? tProps.account : null;
    const cluster = typeof tProps.cluster === "string" ? tProps.cluster : null;

    // ADR-0026 D1: `<origin domain>-[<region>-]<environment>`, and ONLY for a target carrying an
    // `environment`. The domain segment comes from the target's OWN `origin_domain_id`, never from
    // this instance — otherwise a replicated target derives one name at the commander and another at
    // an outpost, which D1 rules out explicitly.
    const domainLabel = target?.originDomainId === self.domainId ? self.name : null;
    const stageName =
      environment && domainLabel
        ? [domainLabel, region, environment].filter(Boolean).join("-")
        : null;

    // ONE literal, pushed unchanged into BOTH `stages` and `unplacedStages` — the two wire shapes
    // must not drift, and this is the only place either is built.
    const deploymentTarget = {
      id: target?.id ?? seed.deploymentTargetId,
      name: target?.name ?? "(unresolved)",
      environment,
      region,
      substrate,
      account,
      cluster
    };
    // ONE literal here too (§10.2), for the same reason — built once from the target's own origin,
    // pushed into whichever array this seed lands in.
    const outpost = outpostOf(target?.originDomainId ?? null);

    // AN UNPLACED STAGE CARRIES NO BINDING, NO `current` AND NO `version` — all three are keyed on a
    // placement that does not exist, and a null `binding` beside a real stage is the ADR-0006 case
    // (a) ALARM ("no executor — this would fake-succeed"). Rendering that over what is only an
    // absence of a placement would cry wolf on every component that simply does not go to prod. The
    // separate array is what keeps the two unconfusable.
    if (!seed.placement) {
      // `seed.wave` is non-null here by construction: an unplaced seed can only come from a wave,
      // since the only other source of a seed IS a placement.
      if (seed.wave)
        unplacedStages.push({
          order,
          wave: seed.wave,
          deploymentTarget,
          maintainedBy: maintainerOf(target?.originDomainId ?? null),
          outpost,
          stageName
        });
      continue;
    }

    // EVERY pipeline the ENGINE would run at this stage, from the SAME resolution reconcile uses
    // (binding-resolution.ts, ADR-0027/0029) — never a bare placement-only listing. The listing
    // version shipped first and produced a projection that CONTRADICTED the engine: a component-
    // level binding (the owner's own-infra case, 2026-08-12 — checkout-api's terraform'd bucket)
    // triggered fine but rendered as "No executor" / "no infrastructure pipeline is bound", a
    // false alarm about a working pipeline.
    //
    // RESOLVED FROM THE COMPONENT, mapped onto stages by outcome — not resolved from the placement.
    // The first attempt at this fix called `resolveBindingForTarget(placement.id)` and STILL missed
    // the component rung, because `containsAncestors` seeds AT the component and pushes only its
    // parents: a placement-rooted walk visits assembly/service/org but never the component itself.
    // The engine does not have this problem because it resolves from the component (that is what a
    // wave target carries) and lets `via_placement` name the stage-local winner. Mirror that:
    //   direct        -> the component's own binding, acts at EVERY stage ("component")
    //   via_placement -> a stage-local binding, acts ONLY at the stage whose placement it names
    //   via_service   -> an ancestor's binding, acts at every stage (labelled with the ancestor's
    //                    own object type — provenance READ, never inferred,
    //                    resolution-provenance.test.ts)
    //   ambiguous     -> nothing here: projecting the refusal is the reconcile/Decision path's job
    //                    (ADR-0027 D2), and rendering nothing is what this view always did.
    // `componentResolutions` is computed ONCE for the whole journey — it does not vary by stage.
    const resolved: { row: ExecutorBindingRow; resolvedVia: string }[] = [];
    for (const resolution of componentResolutions) {
      if (!resolution.binding) continue;
      if (resolution.outcome === "via_placement") {
        if (resolution.viaPlacementObjectId !== seed.placement.id) continue;
        resolved.push({ row: resolution.binding, resolvedVia: "placement" });
      } else if (resolution.outcome === "via_service") {
        resolved.push({ row: resolution.binding, resolvedVia: resolution.viaObjectTypeId });
      } else {
        resolved.push({ row: resolution.binding, resolvedVia: "component" });
      }
    }
    resolved.sort((a, b) => a.row.type.localeCompare(b.row.type));
    const bindings: ComponentPipelineStage["bindings"] = [];
    for (const { row, resolvedVia } of resolved) {
      let executionSystemName: string | null = null;
      let systemKind: string | null = null;
      let consoleBase: string | null = null;
      if (row.executionSystemId) {
        const sys = await tx.query.objects.findFirst({
          where: (t, { eq: eqOp, and: andOp }) =>
            andOp(eqOp(t.id, row.executionSystemId!), eqOp(t.orgId, orgId))
        });
        executionSystemName = sys?.name ?? null;
        const props = (sys?.properties ?? null) as Record<string, unknown> | null;
        // The system's OWN kind decides the URL shape — two bindings of the same routing Type can
        // live in different systems, and it is the system that knows what a link to one looks like.
        systemKind = typeof props?.["kind"] === "string" ? (props["kind"] as string) : null;
        consoleBase = executionSystemConsoleBase(props);
      }
      bindings.push({
        externalRef: row.externalRef ?? null,
        type: row.type,
        url: executorConsoleUrl({
          kind: systemKind,
          base: consoleBase,
          externalRef: row.externalRef ?? null
        }),
        category: categoryOfType(row.type),
        executionSystemId: row.executionSystemId ?? null,
        executionSystemName,
        resolvedVia
      });
    }

    const placementCurrents = currents.get(seed.placement.id) ?? [];
    const gate = await gateForStage(
      tx,
      orgId,
      actorObjectId,
      seed.placement.id,
      placementCurrents[0]?.changeId ?? null
    );

    stages.push({
      placement: seed.placement,
      order,
      wave: seed.wave,
      deploymentTarget,
      maintainedBy: maintainerOf(target?.originDomainId ?? null),
      outpost,
      stageName,
      binding: bindings[0] ?? null,
      bindings,
      current: placementCurrents[0] ?? null,
      currents: placementCurrents,
      gate,
      // Null means "no stage dependency is withholding this stage's release" — a live answer, not a
      // remembered one. NOT added to `unknownFields`: see `ComponentPipelineHoldSchema` for why the
      // one case that looks unobservable (an outpost's stripped-on-import declaration) genuinely is
      // not held here rather than unknown here.
      hold: holds.get(seed.placement.id) ?? null,
      version: null,
      // See the module header: always unknown until Phase 4a, and said so explicitly rather than
      // shipped as a confident blank.
      unknownFields: ["version"]
    });
  }

  let pipeline: ComponentPipelineResponse["pipeline"] = null;
  if (resolved) {
    const attachedTo = await tx.query.objects.findFirst({
      where: (t, { eq: eqOp, and: andOp }) =>
        andOp(eqOp(t.id, resolved.attachedToObjectId), eqOp(t.orgId, orgId))
    });
    pipeline = {
      topologyObjectId: resolved.topologyObjectId,
      topologyName: topologyRow?.name ?? null,
      topologyVersion: resolved.topologyVersion ?? null,
      rung: resolved.rung,
      attachedToObjectId: resolved.attachedToObjectId,
      attachedToName: attachedTo?.name ?? null
    };
  }

  const registry = await registryForComponent(tx, orgId, component.id);

  // §9.3 — THE ARTIFACT and its change-scoped facts. The pick prefers the releases the stages are
  // already showing (currents + holds), so the tile and the journey describe the same change when
  // there is one; `artifact-facts.ts` owns the pick and every reduction. Peer names resolve through
  // the same `federation_peers` read `maintainerOf` uses.
  const preferredChangeIds = [
    ...[...currents.values()].flatMap((list) => list.map((c) => c.changeId)),
    ...[...holds.values()].map((h) => h.changeId)
  ];
  const artifact = await artifactFactsForComponent(
    tx,
    orgId,
    component.id,
    preferredChangeIds,
    (peerDomainId) => peerById.get(peerDomainId)?.name ?? null
  );

  return {
    component: {
      id: component.id,
      urn: component.urn,
      name: component.name,
      // outpost-ui.md §9.3a — the two facts the source lane READS to know its shape: a component
      // maintained by another domain (typically the commander) has that domain UPSTREAM of this
      // domain's repos; a domain-local one has no upstream at all — its repo IS the source. Stated
      // by the server from `originDomainId`/`domainLocal` + federation self, never inferred by
      // the client from labels or names.
      maintainedBy: maintainerOf(component.originDomainId),
      domainLocal: component.domainLocal
    },
    pipeline,
    stageSource,
    sources,
    stages,
    unplacedStages,
    registry,
    artifact,
    unknownFields: []
  };
}

/**
 * THE REGISTRY THIS COMPONENT PUBLISHES TO, AT THIS SITE (§9.2) — resolved from its outgoing
 * `publishes_to` edges (component → execution-system, migration 0065), never from the `image`
 * executor binding (a binding's Type is WHICH PIPELINE it drives, ADR-0007 — the image binding
 * names what BUILDS the artifact, not where it lands).
 *
 * ONE query for the edges (joined to the live execution-system row) — lane-level, not per stage.
 * Per-site by construction: a registry is created `domainLocal:true` at each site, and an edge with
 * a domain-local endpoint never journals (relationships-repo.ts, M20.3), so this instance's
 * `relationships` table holds only the edges declared HERE.
 *
 * `state` is STATED, not chosen. >1 edge is `ambiguous` with the count and NULL identity fields —
 * there is no rule that would make picking one honest, and rendering the first would look exactly
 * like `declared`.
 */
async function registryForComponent(
  tx: TenantTx,
  orgId: string,
  componentId: string
): Promise<NonNullable<ComponentPipelineResponse["registry"]>> {
  const rows = await tx
    .select({
      edgeProperties: relationships.properties,
      systemId: objects.id,
      systemName: objects.name,
      systemProperties: objects.properties
    })
    .from(relationships)
    .innerJoin(
      objects,
      and(
        eq(objects.id, relationships.toId),
        eq(objects.orgId, orgId),
        eq(objects.typeId, "execution-system"),
        isNull(objects.deletedAt)
      )
    )
    .where(
      and(
        eq(relationships.orgId, orgId),
        eq(relationships.typeId, "publishes_to"),
        eq(relationships.fromId, componentId),
        isNull(relationships.deletedAt)
      )
    );

  const none = {
    executionSystemId: null,
    name: null,
    kind: null,
    url: null,
    repository: null
  };
  if (rows.length === 0) return { state: "none", ...none, edgeCount: 0 };
  if (rows.length > 1) return { state: "ambiguous", ...none, edgeCount: rows.length };

  const row = rows[0]!;
  const sysProps = (row.systemProperties ?? null) as Record<string, unknown> | null;
  const edgeProps = (row.edgeProperties ?? null) as Record<string, unknown> | null;
  // Every identity field READ, never inferred: name off the object, kind off `properties.kind`
  // (string guard — the registered schema for execution-system is open), url = console base only
  // (`webUrl` → `serverUrl`; no registry deep-link shape is known, so none is guessed), repository
  // off the EDGE's own property (0065's open schema types it as a string, but a row written before
  // that or replicated from elsewhere was never checked, hence the guard — a non-string is null,
  // not a crash).
  return {
    state: "declared",
    executionSystemId: row.systemId,
    name: row.systemName,
    kind: typeof sysProps?.["kind"] === "string" ? (sysProps["kind"] as string) : null,
    url: executionSystemConsoleBase(sysProps),
    repository:
      typeof edgeProps?.["repository"] === "string" ? (edgeProps["repository"] as string) : null,
    edgeCount: 1
  };
}
