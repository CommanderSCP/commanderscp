import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { categoryOfType, preferredObservedVersion } from "@scp/schemas";
import type {
  ComponentPipelineCorrelatedInfraChange,
  ComponentPipelineHold,
  ComponentPipelineResponse,
  ComponentPipelineStage,
  ComponentPipelineTargetOutpost,
  ComponentPipelineUnplacedStage,
  WaveTargetObserved
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
import { observedRunForComponent } from "./observed-run-facts.js";
import { requiresOf } from "./changes-repo.js";
import { namesForObjectIds } from "../dependencies/producer-declaration.js";

/** A COMPONENT'S PIPELINE. See docs/coordination.md §299. */

/** The most recent wave target per placement, per pipeline. See docs/coordination.md §300. */
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
    observed_state: unknown;
  }>(sql`
    SELECT DISTINCT ON (t.target_object_id, t.type)
      t.target_object_id,
      o.id     AS change_id,
      o.name   AS change_name,
      c.state  AS change_state,
      w.name   AS wave_name,
      t.status AS target_status,
      t.type   AS type,
      c.created_at AS created_at,
      t.observed_state AS observed_state
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
        category,
        // Same jsonb column, same cast idiom `plan-service.ts`'s `toChangeWaveTargetShape` uses
        // for `ChangeWaveTargetSchema.observed` — this is that column read a second time, per
        // pipeline, for the stage's derived `version` below.
        observed: (r.observed_state as WaveTargetObserved | null) ?? null
      });
    }
    out.set(placementId, currents);
  }
  return out;
}

/** The two statuses whose trigger can still be withheld. See docs/coordination.md §301. */
const WITHHOLDABLE_STATUSES = new Set(["pending", "triggering"]);

/** Which stages hold a release with its trigger withheld. See docs/coordination.md §302. */
async function holdsByPlacement(
  tx: TenantTx,
  orgId: string,
  currents: Map<string, ComponentPipelineStage["currents"]>
): Promise<Map<string, ComponentPipelineHold>> {
  const out = new Map<string, ComponentPipelineHold>();

  // No live-state gate here; its absence is the fix. See docs/coordination.md §303.
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

/** The topology's waves as ordered deployment-target ids. See docs/coordination.md §304. */
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

/** WHAT GATES ENTRY TO ONE STAGE. See docs/coordination.md §305. */
/** The DB-independent half of `gateForStage`. See docs/coordination.md §306. */
async function resolveGatePolicies(
  tx: TenantTx,
  orgId: string,
  actorObjectId: string,
  placementObjectId: string
): Promise<{ policies: ComponentPipelineStage["gate"]["policies"]; controlIds: string[] }> {
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
  return { policies, controlIds };
}

/** The rest of `gateForStage`. See docs/coordination.md §307. */
async function buildGateChecks(
  tx: TenantTx,
  orgId: string,
  policies: ComponentPipelineStage["gate"]["policies"],
  controlIds: string[],
  /** The release the check statuses are AS OF — the newest change at this stage, or null when
   *  nothing has ever reached it. A `control_run` belongs to a CHANGE (`control_runs.change_object_id`),
   *  so there is no such thing as a control outcome for a stage in the abstract; saying which change
   *  the answer is about is what keeps "passed" from reading as a standing property of the place. */
  asOfChangeId: string | null,
  controlNames: Map<string, string>
): Promise<ComponentPipelineStage["gate"]> {
  const outcomes = asOfChangeId
    ? await readExistingControlOutcomes(tx, orgId, asOfChangeId, controlIds)
    : {};
  const checks: ComponentPipelineStage["gate"]["checks"] = controlIds.map((controlId) => ({
    controlId,
    // A DANGLING reference is kept with a null name rather than dropped: a policy requiring a
    // control that no longer exists blocks every release, and that must be visible.
    name: controlNames.get(controlId) ?? null,
    status: outcomes[controlId] ?? (asOfChangeId ? "pending" : "not_started"),
    changeId: asOfChangeId
  }));

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
      url: repoConsoleUrl(m.sourceKind, m.repoPattern ?? null),
      // Declared reach (§10.6) — carried through as READ; null stays null (no label, no inference
      // from this site's role).
      scope: m.scope
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
  // Which outpost each place is part of, by trust domain. See docs/coordination.md §308.
  const outpostByPeer = await resolveOutpostObjectsByPeer(tx, orgId);
  const outpostOf = (originDomainId: string | null): ComponentPipelineTargetOutpost => {
    const isSelf = originDomainId !== null && originDomainId === self.domainId;
    const peer = originDomainId ? peerById.get(originDomainId) : undefined;
    const outpost = originDomainId ? outpostByPeer.get(originDomainId) : undefined;
    // PRECEDENCE — OBJECT-FIRST. See docs/coordination.md §309.
    if (outpost && originDomainId) {
      return {
        state: "outpost",
        id: outpost.id,
        name: outpost.name,
        trustTier: outpost.trustTier,
        peerDomainId: originDomainId,
        peerRole: isSelf ? self.role : (peer?.role ?? null)
      };
    }
    if (isSelf) {
      // Authored by THIS instance and NO outpost object names this instance's domain — a STATED
      // ABSENCE ("this instance's domain — no outpost registered"), not a sixth state: the fix is
      // to declare the HQ outpost under Federation › Outposts.
      return {
        state: "self",
        id: null,
        name: self.name,
        trustTier: null,
        peerDomainId: null,
        peerRole: null
      };
    }
    if (peer && originDomainId) {
      // A paired peer with no `outpost` object registered. See docs/coordination.md §310.
      return {
        state: peer.role === "outpost" ? "peer-without-outpost" : "peer-not-outpost",
        id: null,
        name: peer.name,
        trustTier: null,
        peerDomainId: originDomainId,
        peerRole: peer.role
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
      peerDomainId: originDomainId,
      peerRole: null
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
    if (a.wave !== null && b.wave !== null) return 0;
    return (targetById.get(a.deploymentTargetId)?.name ?? "").localeCompare(
      targetById.get(b.deploymentTargetId)?.name ?? ""
    );
  });

  // The journey is ONE ordered list here and splits into two arrays only at the wire (see
  // `ComponentPipelineResponseSchema.unplacedStages` for why). `order` is that list's index, so the
  // two arrays recombine into exactly this order and a client never infers an interleaving.
  const stages: ComponentPipelineStage[] = [];
  const unplacedStages: ComponentPipelineUnplacedStage[] = [];

  // FIRST PASS over placed seeds. See docs/coordination.md §311.
  type PreparedStage = {
    order: number;
    seed: StageSeed;
    deploymentTarget: ComponentPipelineStage["deploymentTarget"];
    outpost: ComponentPipelineTargetOutpost;
    stageName: string | null;
    resolved: { row: ExecutorBindingRow; resolvedVia: string }[];
    placementCurrents: ComponentPipelineStage["currents"];
    gatePolicies: ComponentPipelineStage["gate"]["policies"];
    gateControlIds: string[];
    asOfChangeId: string | null;
  };
  const prepared: PreparedStage[] = [];
  const allControlIds = new Set<string>();
  const allSystemIds = new Set<string>();

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

    // An unplaced stage carries no binding, current or version. See docs/coordination.md §312.
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

    // Every pipeline the engine would run at this stage. See docs/coordination.md §313.
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
    for (const { row } of resolved) {
      if (row.executionSystemId) allSystemIds.add(row.executionSystemId);
    }

    const placementCurrents = currents.get(seed.placement.id) ?? [];
    const { policies: gatePolicies, controlIds: gateControlIds } = await resolveGatePolicies(
      tx,
      orgId,
      actorObjectId,
      seed.placement.id
    );
    for (const controlId of gateControlIds) allControlIds.add(controlId);

    prepared.push({
      order,
      seed,
      deploymentTarget,
      outpost,
      stageName,
      resolved,
      placementCurrents,
      gatePolicies,
      gateControlIds,
      asOfChangeId: placementCurrents[0]?.changeId ?? null
    });
  }

  // SECOND PASS: the two ids sets collected above, resolved with one batched read each.
  const controlNames = await namesForObjectIds(tx, orgId, [...allControlIds]);
  const systemRows =
    allSystemIds.size === 0
      ? []
      : await tx
          .select({ id: objects.id, name: objects.name, properties: objects.properties })
          .from(objects)
          .where(and(eq(objects.orgId, orgId), inArray(objects.id, [...allSystemIds])));
  const systemById = new Map(systemRows.map((r) => [r.id, r]));

  for (const p of prepared) {
    const bindings: ComponentPipelineStage["bindings"] = [];
    for (const { row, resolvedVia } of p.resolved) {
      let executionSystemName: string | null = null;
      let systemKind: string | null = null;
      let consoleBase: string | null = null;
      if (row.executionSystemId) {
        const sys = systemById.get(row.executionSystemId);
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

    const gate = await buildGateChecks(
      tx,
      orgId,
      p.gatePolicies,
      p.gateControlIds,
      p.asOfChangeId,
      controlNames
    );

    // THE VERSION STAIRCASE. See docs/coordination.md §314.
    const derivedVersion: string | undefined = preferredObservedVersion(
      p.placementCurrents[0]?.observed
    );
    const target = targetById.get(p.seed.deploymentTargetId);

    stages.push({
      placement: p.seed.placement!,
      order: p.order,
      wave: p.seed.wave,
      deploymentTarget: p.deploymentTarget,
      maintainedBy: maintainerOf(target?.originDomainId ?? null),
      outpost: p.outpost,
      stageName: p.stageName,
      binding: bindings[0] ?? null,
      bindings,
      current: p.placementCurrents[0] ?? null,
      currents: p.placementCurrents,
      gate,
      // Null means "no stage dependency is withholding this stage's release" — a live answer, not a
      // remembered one. NOT added to `unknownFields`: see `ComponentPipelineHoldSchema` for why the
      // one case that looks unobservable (an outpost's stripped-on-import declaration) genuinely is
      // not held here rather than unknown here.
      hold: holds.get(p.seed.placement!.id) ?? null,
      version: derivedVersion ?? null,
      unknownFields: derivedVersion === undefined ? ["version"] : []
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

  // component-journey-view.md §3 Segment 2 — "upstream build" marker, the observed CI run a
  // change's `sourceRef` names. Independent of `artifact`/`preferredChangeIds`: it picks the newest
  // RUN-carrying change of the component at all, not one the stages already show (see
  // `observed-run-facts.ts`).
  const observedRun = await observedRunForComponent(tx, orgId, component.id);

  // owner decision, 2026-08-24 (correlated-infrastructure lane) — every infrastructure change this
  // component's placements/hosted-on/couplings implicate, that is not its own. Independent of the
  // stages above: it reads `change_wave_targets` for OTHER changes, not this component's own.
  const correlatedInfra = await correlatedInfraForComponent(
    tx,
    orgId,
    component.id,
    placementByTargetId
  );

  return {
    component: {
      id: component.id,
      urn: component.urn,
      name: component.name,
      // The two facts the source lane reads to know its shape. See docs/coordination.md §315.
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
    observedRun,
    correlatedInfra,
    unknownFields: []
  };
}

/** The `hosted_on` targets a component names directly. See docs/coordination.md §316. */
async function hostedOnDeploymentTargetIds(
  tx: TenantTx,
  orgId: string,
  componentId: string
): Promise<string[]> {
  const rows = await tx
    .select({ targetId: objects.id })
    .from(relationships)
    .innerJoin(
      objects,
      and(
        eq(objects.id, relationships.toId),
        eq(objects.orgId, orgId),
        eq(objects.typeId, "deployment-target"),
        isNull(objects.deletedAt)
      )
    )
    .where(
      and(
        eq(relationships.orgId, orgId),
        eq(relationships.typeId, "hosted_on"),
        eq(relationships.fromId, componentId),
        isNull(relationships.deletedAt)
      )
    );
  return rows.map((r) => r.targetId);
}

/** Which correlation arm named a deployment-target — `placement` beats `hosted_on` when a target
 *  qualifies both ways (component-pipeline.ts module doc, `ComponentPipelineCorrelatedInfraChangeSchema`). */
type CorrelationRoute = "placement" | "hosted_on";

/** THE CORRELATED-INFRASTRUCTURE LANE. See docs/coordination.md §317. */
async function correlatedInfraForComponent(
  tx: TenantTx,
  orgId: string,
  componentId: string,
  placementByTargetId: Map<string, { id: string; urn: string }>
): Promise<NonNullable<ComponentPipelineResponse["correlatedInfra"]>> {
  // THE KEY SET — target_object_id values that correlate to THIS component, and which arm each one
  // belongs to. A deployment-target id claimed by BOTH `placementByTargetId` and `hosted_on` keeps
  // its `placement` route (the more specific fact), never gets downgraded.
  const routeByTargetObjectId = new Map<string, CorrelationRoute>();
  const deploymentTargetIdOf = new Map<string, string>();
  for (const [deploymentTargetId, placement] of placementByTargetId) {
    routeByTargetObjectId.set(deploymentTargetId, "placement");
    deploymentTargetIdOf.set(deploymentTargetId, deploymentTargetId);
    routeByTargetObjectId.set(placement.id, "placement");
    deploymentTargetIdOf.set(placement.id, deploymentTargetId);
  }
  const hostedOnIds = await hostedOnDeploymentTargetIds(tx, orgId, componentId);
  for (const deploymentTargetId of hostedOnIds) {
    if (!routeByTargetObjectId.has(deploymentTargetId)) {
      routeByTargetObjectId.set(deploymentTargetId, "hosted_on");
      deploymentTargetIdOf.set(deploymentTargetId, deploymentTargetId);
    }
  }
  const keySet = [...routeByTargetObjectId.keys()];

  interface MatchedChange {
    changeObjectId: string;
    name: string | null;
    state: string;
    type: string;
    createdAt: string;
    route: CorrelationRoute;
    deploymentTargetId: string;
  }
  const byChangeId = new Map<string, MatchedChange>();

  if (keySet.length > 0) {
    // Ordered newest first, with the same tiebreak. See docs/coordination.md §318.
    const rows = await tx.execute<{
      target_object_id: string;
      change_object_id: string;
      change_name: string | null;
      change_state: string;
      type: string;
      created_at: string;
    }>(sql`
      SELECT
        t.target_object_id AS target_object_id,
        o.id                AS change_object_id,
        o.name              AS change_name,
        c.state             AS change_state,
        t.type              AS type,
        c.created_at         AS created_at
      FROM ${changeWaveTargets} t
      JOIN ${changeWaves} w  ON w.id = t.wave_id AND w.org_id = t.org_id
      JOIN ${changePlans} p  ON p.id = w.plan_id AND p.org_id = w.org_id
      JOIN ${changes} c      ON c.object_id = p.change_object_id AND c.org_id = p.org_id
      JOIN ${objects} o      ON o.id = c.object_id AND o.org_id = c.org_id
      WHERE t.org_id = ${orgId}::uuid
        AND t.type = 'infrastructure'
        AND o.deleted_at IS NULL
        AND t.target_object_id IN (${sql.join(
          keySet.map((id) => sql`${id}::uuid`),
          sql`, `
        )})
        AND NOT (o.properties @> ${JSON.stringify({ targets: [componentId] })}::jsonb)
      ORDER BY c.created_at DESC, o.id DESC
      LIMIT 25
    `);
    for (const r of rows.rows) {
      const route = routeByTargetObjectId.get(r.target_object_id);
      const deploymentTargetId = deploymentTargetIdOf.get(r.target_object_id);
      if (!route || !deploymentTargetId) continue; // unreachable — every row came from the key set
      const existing = byChangeId.get(r.change_object_id);
      // `placement` beats `hosted_on`; otherwise the first row wins (rows are already newest-first,
      // so within one route the identity fields are the same change regardless of which matching
      // target is kept).
      if (existing && (existing.route === "placement" || route === "hosted_on")) continue;
      byChangeId.set(r.change_object_id, {
        changeObjectId: r.change_object_id,
        name: r.change_name,
        state: r.change_state,
        type: r.type,
        // `new Date(...)`, since the raw driver path is untyped. See docs/coordination.md §319.
        createdAt: new Date(r.created_at).toISOString(),
        route,
        deploymentTargetId
      });
    }
  }

  // THE COUPLING ARM — this component's OWN recent `requires` keys, then every infra-Type change
  // that `provides` one of them (`coupling.ts`'s jsonb-containment probe pattern, without the
  // `targets`/`at` half: a coupling correlates by KEY alone, not by place). Skipped entirely for a
  // component with no `requires` anywhere in its recent history — the common case.
  const ownRecentRows = await tx
    .select({ properties: objects.properties })
    .from(changes)
    .innerJoin(objects, and(eq(objects.id, changes.objectId), eq(objects.orgId, changes.orgId)))
    .where(
      and(
        eq(changes.orgId, orgId),
        isNull(objects.deletedAt),
        sql`${objects.properties} @> ${JSON.stringify({ targets: [componentId] })}::jsonb`
      )
    )
    .orderBy(sql`${changes.createdAt} DESC`, sql`${changes.objectId} DESC`)
    .limit(25);
  const requiredKeys = new Set<string>();
  for (const row of ownRecentRows) {
    for (const req of requiresOf(row.properties as Record<string, unknown> | null).requirements) {
      requiredKeys.add(req.key);
    }
  }

  const coupledKeyByChangeId = new Map<string, string>();
  for (const key of requiredKeys) {
    const probe = JSON.stringify({ provides: [key], type: "infrastructure" });
    const rows = await tx.execute<{
      change_object_id: string;
      change_name: string | null;
      change_state: string;
      created_at: string;
    }>(sql`
      SELECT o.id AS change_object_id, o.name AS change_name, c.state AS change_state,
             c.created_at AS created_at
      FROM ${changes} c
      JOIN ${objects} o ON o.id = c.object_id AND o.org_id = c.org_id
      WHERE c.org_id = ${orgId}::uuid
        AND o.deleted_at IS NULL
        AND o.properties @> ${probe}::jsonb
        AND NOT (o.properties @> ${JSON.stringify({ targets: [componentId] })}::jsonb)
      ORDER BY c.created_at DESC, o.id DESC
      LIMIT 20
    `);
    for (const r of rows.rows) {
      // One coupled key surfaces per change (the wire shape carries a single `coupledKey`); the
      // first key found for a change wins, which is a stable pick since `requiredKeys` iterates in
      // the newest-first order the recent-changes scan above produced it in.
      if (!coupledKeyByChangeId.has(r.change_object_id)) {
        coupledKeyByChangeId.set(r.change_object_id, key);
      }
      if (!byChangeId.has(r.change_object_id)) {
        byChangeId.set(r.change_object_id, {
          changeObjectId: r.change_object_id,
          name: r.change_name,
          state: r.change_state,
          type: "infrastructure",
          createdAt: new Date(r.created_at).toISOString(),
          // Placeholder — overwritten below by the merge into wire shape, which reads `route:
          // "coupling"` for any change absent from the placement/hosted_on map. Kept here only so
          // this map's value type stays uniform; never read as `placement` for such a row.
          route: "hosted_on",
          deploymentTargetId: ""
        });
      }
    }
  }

  // NAMES, batched — every deployment-target this response is about to cite, resolved in one read
  // (`namesForObjectIds`, `dependencies/producer-declaration.ts`), never a bare id where a name
  // exists.
  const targetNames = await namesForObjectIds(
    tx,
    orgId,
    [...byChangeId.values()].map((m) => m.deploymentTargetId).filter((id) => id.length > 0)
  );

  const changesOut: ComponentPipelineCorrelatedInfraChange[] = [...byChangeId.entries()]
    .map(([changeObjectId, m]) => {
      const coupledKey = coupledKeyByChangeId.get(changeObjectId) ?? null;
      // A row this loop only ever inserted via the coupling arm (never matched via
      // placement/hosted_on) carries the placeholder `deploymentTargetId: ""` from above — that is
      // exactly the signal to render `route: "coupling"` with a null target, whatever placeholder
      // route string rides along with it.
      const matchedViaPlacementOrHostedOn = m.deploymentTargetId.length > 0;
      return {
        changeObjectId,
        name: m.name,
        state: m.state,
        type: m.type,
        createdAt: m.createdAt,
        correlatedVia: matchedViaPlacementOrHostedOn
          ? {
              route: m.route,
              target: {
                objectId: m.deploymentTargetId,
                name: targetNames.get(m.deploymentTargetId) ?? null
              }
            }
          : { route: "coupling" as const, target: null },
        coupledKey
      };
    })
    .sort(
      (a, b) =>
        b.createdAt.localeCompare(a.createdAt) || b.changeObjectId.localeCompare(a.changeObjectId)
    );

  return { changes: changesOut };
}

/** THE REGISTRY THIS COMPONENT PUBLISHES TO, AT THIS SITE. See docs/coordination.md §320. */
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
  // Every identity field READ, never inferred. See docs/coordination.md §321.
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
