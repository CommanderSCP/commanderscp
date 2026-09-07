import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { categoryOfType } from "@scp/schemas";
import type {
  GraphObject,
  ServiceBoardResponse,
  ServiceBoardRow,
  ServiceBoardWave,
  ServiceBoardFreeze,
  ServiceBoardPipeline,
  ExecutorCategory
} from "@scp/schemas";
import type { TenantTx } from "../db/tenant-tx.js";
import {
  relationships as relationshipsTable,
  changes,
  changePlans,
  changeWaveTargets,
  changeWaves,
  objects as objectsTable
} from "../db/schema.js";
import { listExecutorBindingsForTargets } from "./executor-bindings-repo.js";
import { executionSystemConsoleBase, executorConsoleUrl } from "./console-urls.js";
import { traverse } from "../graph/traverse.js";
import { getChange } from "./changes-repo.js";
import { getLatestPlanForChange } from "./plan-service.js";
import { latestBlockDecisionForSubject } from "./decisions-repo.js";
import { listApprovalRequestsForChange } from "../governance/approvals-repo.js";
import type { EffectiveFreeze } from "../governance/freeze-scope.js";
import { freezesByTarget } from "../governance/freeze-scope.js";
import { listPlacementsForComponents } from "../graph/placements-repo.js";
import { ensureFederationSelf } from "../federation/self-repo.js";
import { listPeers } from "../federation/peers-repo.js";
import { scopeCarriesChangeObjects } from "../federation/scope-filter.js";
import { listUnattachedChangeStatusInStates } from "../federation/unattached-change-status-repo.js";
import { limitingUpstreamFreshness } from "../federation/upstream-freshness.js";
import { sqlIn } from "../graph/sql-helpers.js";
import { placementComponentParentSql } from "../graph/containment.js";
import { REFUSED_WAVE_TARGET_STATUSES } from "./wave-targets-repo.js";

/** The server projection behind the service board. See docs/coordination.md §877. */

/** Terminal statuses that count as a failure for blocked. See docs/coordination.md §878. */
const FAILED_STATUSES = new Set<string>([
  "failed",
  "aborted",
  // M25.4 — spread rather than re-listed. This was one of five places that used to restate the
  // refusal set by hand. Deliberately NOT stating the set's size: the count went stale within the
  // same milestone (`recipe_managed_executor` made it five), which is the miniature of the very
  // drift the spread exists to prevent. See `REFUSED_WAVE_TARGET_STATUSES`.
  ...REFUSED_WAVE_TARGET_STATUSES
]);

/** A component's latest change, plus WHO DRIVES IT. See docs/coordination.md §879. */
interface LatestChangeRef {
  changeId: string;
  changeName: string;
  drivenHere: boolean;
  originDomainId: string | null;
  federationState: string | null;
}

type ChangeCandidateRow = {
  change_id: string;
  change_name: string;
  properties: Record<string, unknown> | null;
  origin_domain_id: string | null;
  created_at: Date | string;
  [key: string]: unknown;
};

function toRef(row: ChangeCandidateRow, selfDomainId: string): LatestChangeRef {
  const state = row.properties?.federationState;
  return {
    changeId: row.change_id,
    changeName: row.change_name,
    drivenHere: row.origin_domain_id === null || row.origin_domain_id === selfDomainId,
    originDomainId: row.origin_domain_id === selfDomainId ? null : row.origin_domain_id,
    federationState: typeof state === "string" ? state : null
  };
}

/** The change this domain reports per component, in two arms. See docs/coordination.md §880. */
async function latestChangeByComponent(
  tx: TenantTx,
  orgId: string,
  componentIds: string[],
  selfDomainId: string
): Promise<Map<string, LatestChangeRef>> {
  if (componentIds.length === 0) return new Map();

  const latest = new Map<string, LatestChangeRef>();

  // ARM 1 — the local observation. See docs/coordination.md §881.
  const planned = await tx.execute<ChangeCandidateRow & { component_id: string }>(sql`
    SELECT DISTINCT ON (comp.component_id)
      comp.component_id   AS component_id,
      o.id                AS change_id,
      o.name              AS change_name,
      o.properties        AS properties,
      o.origin_domain_id  AS origin_domain_id,
      c.created_at        AS created_at
    FROM change_wave_targets t
    JOIN change_waves  w ON w.id = t.wave_id  AND w.org_id = t.org_id
    JOIN change_plans  p ON p.id = w.plan_id  AND p.org_id = w.org_id
    JOIN changes       c ON c.object_id = p.change_object_id AND c.org_id = p.org_id
    JOIN objects       o ON o.id = c.object_id AND o.org_id = c.org_id
    LEFT JOIN LATERAL (${placementComponentParentSql(orgId, sql`t.target_object_id`)}) pl ON TRUE
    CROSS JOIN LATERAL (
      SELECT COALESCE(pl.parent_id, t.target_object_id) AS component_id
    ) comp
    WHERE t.org_id = ${orgId}::uuid
      AND o.deleted_at IS NULL
      AND ${sqlIn("comp.component_id", componentIds)}
    ORDER BY comp.component_id, c.created_at DESC, c.object_id DESC
  `);
  for (const row of planned.rows) latest.set(row.component_id, toRef(row, selfDomainId));

  // ARM 2 — the fallback, consulted ONLY for the components arm 1 left open.
  const uncovered = componentIds.filter((id) => !latest.has(id));
  if (uncovered.length === 0) return latest;

  const componentValues = sql.join(
    uncovered.map((id) => sql`(${id}::text)`),
    sql`, `
  );
  const declared = await tx.execute<ChangeCandidateRow & { component_id: string }>(sql`
    SELECT
      comp.id             AS component_id,
      o.id                AS change_id,
      o.name              AS change_name,
      o.properties        AS properties,
      o.origin_domain_id  AS origin_domain_id,
      o.created_at        AS created_at
    FROM (VALUES ${componentValues}) AS comp(id)
    CROSS JOIN LATERAL (
      SELECT ch.id, ch.name, ch.properties, ch.origin_domain_id, ch.created_at
      FROM objects ch
      WHERE ch.org_id = ${orgId}::uuid
        AND ch.type_id = 'change'
        AND ch.deleted_at IS NULL
        AND ch.properties @> jsonb_build_object('targets', jsonb_build_array(comp.id))
      -- Driver class FIRST, createdAt only WITHIN a class. A locally-driven change carries a
      -- real propose-time createdAt and is a genuine local observation; a replica's created_at
      -- is its IMPORT time (the object_upsert payload ships none), so comparing the two is a
      -- fabricated ordering. Ranking driver-class first means an unknown replica can never
      -- outrank a change this domain actually drives, and the surviving createdAt comparison
      -- is always same-clock. Same principle as the arm-1/arm-2 fallback, one level down.
      ORDER BY (ch.origin_domain_id IS NOT DISTINCT FROM ${selfDomainId}::uuid) DESC,
               ch.created_at DESC, ch.id DESC
      LIMIT 1
    ) o
  `);
  for (const row of declared.rows) latest.set(row.component_id, toRef(row, selfDomainId));

  return latest;
}

/** The board projection of a freeze from EITHER tier. See docs/coordination.md §882. */
function toFreeze(f: EffectiveFreeze): ServiceBoardFreeze {
  return { id: f.id, reason: f.reason, endsAt: f.endsAt.toISOString() };
}

/** The states in which a change is genuinely rolling (in-flight) rather than settled. */
const IN_FLIGHT = new Set([
  "proposed",
  "evaluated",
  "coordinated",
  "waiting",
  "executing",
  "validating"
]);

/** Every ADR-0007 Category, always emitted — see `ServiceBoardPipelineSchema` on why absence must
 *  be stated rather than omitted. */
const BOARD_CATEGORIES: readonly ExecutorCategory[] = ["build", "infrastructure", "configuration"];

/** The per-pipeline summary for every component, batched. See docs/coordination.md §883. */
async function pipelinesForComponents(
  tx: TenantTx,
  orgId: string,
  serviceObjectId: string,
  componentIds: string[],
  placements: { componentObjectId: string; placementId: string }[]
): Promise<{
  byComponent: Map<string, ServiceBoardPipeline[]>;
  forService: ServiceBoardPipeline[];
}> {
  const byComponent = new Map<string, ServiceBoardPipeline[]>();

  const placementsByComponent = new Map<string, string[]>();
  const placementToComponent = new Map<string, string>();
  for (const p of placements) {
    placementsByComponent.set(p.componentObjectId, [
      ...(placementsByComponent.get(p.componentObjectId) ?? []),
      p.placementId
    ]);
    placementToComponent.set(p.placementId, p.componentObjectId);
  }
  const placementIds = [...placementToComponent.keys()];

  const bindings = await listExecutorBindingsForTargets(tx, orgId, [
    ...componentIds,
    ...placementIds,
    serviceObjectId
  ]);
  // Execution systems, resolved ONCE for the whole board — the console URL needs the system's own
  // `kind` and address, and re-reading them per binding would be a query per row.
  const systemIds = [
    ...new Set(bindings.flatMap((b) => (b.executionSystemId ? [b.executionSystemId] : [])))
  ];
  const systemRows =
    systemIds.length === 0
      ? []
      : await tx
          .select({
            id: objectsTable.id,
            name: objectsTable.name,
            properties: objectsTable.properties
          })
          .from(objectsTable)
          .where(and(eq(objectsTable.orgId, orgId), inArray(objectsTable.id, systemIds)));
  const systemById = new Map(systemRows.map((r) => [r.id, r]));

  const boundCategories = new Map<string, Set<string>>();
  const bindingsByOwnerCategory = new Map<string, ServiceBoardPipeline["bindings"]>();
  const noteBound = (ownerId: string, b: (typeof bindings)[number]) => {
    const category = categoryOfType(b.type);
    const set = boundCategories.get(ownerId) ?? new Set<string>();
    set.add(category);
    boundCategories.set(ownerId, set);

    const key = `${ownerId}:${category}`;
    const list = bindingsByOwnerCategory.get(key) ?? [];
    const system = b.executionSystemId ? systemById.get(b.executionSystemId) : undefined;
    const props = (system?.properties ?? null) as Record<string, unknown> | null;
    const entry = {
      type: b.type,
      externalRef: b.externalRef ?? null,
      executionSystemName: system?.name ?? null,
      url: executorConsoleUrl({
        kind: typeof props?.["kind"] === "string" ? (props["kind"] as string) : null,
        base: executionSystemConsoleBase(props),
        externalRef: b.externalRef ?? null
      })
    };
    // Deduped by type+ref: one binding repeated at every placement is ONE pipeline, not N.
    if (!list.some((e) => e.type === entry.type && e.externalRef === entry.externalRef)) {
      list.push(entry);
      bindingsByOwnerCategory.set(key, list);
    }
  };
  for (const b of bindings) {
    const owner = placementToComponent.get(b.targetObjectId) ?? b.targetObjectId;
    noteBound(owner, b);
  }
  // ADR-0027: a service-level binding makes that pipeline bound for EVERY component under it, which
  // is the whole point of declaring cluster infrastructure once.
  const serviceBound = boundCategories.get(serviceObjectId) ?? new Set<string>();

  // Newest wave target per (placement, type) — the same DISTINCT ON shape `component-pipeline.ts`
  // uses, over every placement of the service at once.
  const statusRows =
    placementIds.length === 0
      ? {
          rows: [] as {
            target_object_id: string;
            type: string;
            status: string;
            change_id: string;
          }[]
        }
      : await tx.execute<{
          target_object_id: string;
          type: string;
          status: string;
          change_id: string;
        }>(sql`
          SELECT DISTINCT ON (t.target_object_id, t.type)
            t.target_object_id, t.type, t.status, o.id AS change_id
          FROM ${changeWaveTargets} t
          JOIN ${changeWaves} w ON w.id = t.wave_id AND w.org_id = t.org_id
          JOIN ${changePlans} p ON p.id = w.plan_id AND p.org_id = w.org_id
          JOIN ${changes} c     ON c.object_id = p.change_object_id AND c.org_id = p.org_id
          JOIN ${objectsTable} o ON o.id = c.object_id AND o.org_id = c.org_id
          WHERE t.org_id = ${orgId}::uuid
            AND o.deleted_at IS NULL
            AND t.target_object_id IN (${sql.join(
              placementIds.map((id) => sql`${id}::uuid`),
              sql`, `
            )})
          ORDER BY t.target_object_id, t.type, c.created_at DESC, c.object_id DESC
        `);
  const statusByComponentCategory = new Map<string, { status: string; changeId: string }>();
  for (const r of statusRows.rows) {
    const componentId = placementToComponent.get(r.target_object_id);
    if (!componentId) continue;
    const key = `${componentId}:${categoryOfType(r.type)}`;
    // First row per key wins: the SQL already ordered newest-first within each (placement, type).
    if (!statusByComponentCategory.has(key)) {
      statusByComponentCategory.set(key, { status: r.status, changeId: r.change_id });
    }
  }

  for (const componentId of componentIds) {
    const own = boundCategories.get(componentId) ?? new Set<string>();
    byComponent.set(
      componentId,
      BOARD_CATEGORIES.map((category) => {
        const seen = statusByComponentCategory.get(`${componentId}:${category}`);
        return {
          category,
          bound: own.has(category) || serviceBound.has(category),
          status: seen?.status ?? null,
          changeId: seen?.changeId ?? null,
          bindings: [
            ...(bindingsByOwnerCategory.get(`${componentId}:${category}`) ?? []),
            ...(bindingsByOwnerCategory.get(`${serviceObjectId}:${category}`) ?? [])
          ]
        };
      })
    );
  }

  const forService = BOARD_CATEGORIES.map((category) => ({
    category,
    bound: serviceBound.has(category),
    // A service-level binding's runs are recorded against the COMPONENT placements it drove, not
    // against the service, so there is no per-service status to report and inventing one would be
    // a claim about a row that does not exist.
    status: null,
    changeId: null,
    bindings: bindingsByOwnerCategory.get(`${serviceObjectId}:${category}`) ?? []
  }));

  return { byComponent, forService };
}

export async function buildServiceBoard(
  tx: TenantTx,
  orgId: string,
  service: GraphObject
): Promise<ServiceBoardResponse> {
  // 1. The service's components. See docs/coordination.md §884.
  const { objects } = await traverse(
    tx,
    orgId,
    {
      objectId: service.id,
      direction: "out",
      relTypes: ["contains"],
      maxDepth: 1
    },
    null
  );
  // DIRECT children only (intermediate-grouping D3), and they may now be ASSEMBLIES as well as
  // components (migration 0055). `rows` stays strictly per-component — an assembly is reported
  // separately, in `childAssemblies` below, rather than being flattened into its descendants.
  const components = objects
    .filter((o) => o.id !== service.id && o.typeId === "component")
    .sort((a, b) => a.name.localeCompare(b.name));
  const componentIds = components.map((c) => c.id);

  // ASSEMBLY children get their own entries (D3). Until migration 0055 the filter above was the whole
  // child list, so an assembly child — and every component under it — was silently absent from its
  // parent's board. Counted with ONE query over all of them rather than a traversal per assembly.
  const assemblyObjects = objects
    .filter((o) => o.id !== service.id && o.typeId === "assembly")
    .sort((a, b) => a.name.localeCompare(b.name));
  const assemblyCounts = new Map<string, number>();
  if (assemblyObjects.length > 0) {
    const counted = await tx
      .select({ parent: relationshipsTable.fromId, child: relationshipsTable.toId })
      .from(relationshipsTable)
      .where(
        and(
          eq(relationshipsTable.orgId, orgId),
          eq(relationshipsTable.typeId, "contains"),
          isNull(relationshipsTable.deletedAt),
          inArray(
            relationshipsTable.fromId,
            assemblyObjects.map((a) => a.id)
          )
        )
      );
    for (const row of counted) {
      assemblyCounts.set(row.parent, (assemblyCounts.get(row.parent) ?? 0) + 1);
    }
  }
  const childAssemblies = assemblyObjects.map((a) => ({
    id: a.id,
    urn: a.urn,
    name: a.name,
    componentCount: assemblyCounts.get(a.id) ?? 0
  }));

  // 2. Latest change per component (the net-new join), then the active freezes to overlay read-only.
  //    `ensureFederationSelf` supplies THIS domain's federation id — the yardstick for "do I drive
  //    this change?". It is an ensure (not a get) because it is the one canonical way to name this
  //    instance; minting the identity row on first use is idempotent and race-safe (self-repo.ts).
  const self = await ensureFederationSelf(tx, orgId);
  const [latestByComponent, placements, peers, unattachedInFlight] = await Promise.all([
    latestChangeByComponent(tx, orgId, componentIds, self.domainId),
    // Every placement of every component on this board — the second half of the freeze resolution
    // below. A `deployment-target`-scoped freeze (a REGION freeze, the owner's literal ask) sits on
    // a PLACEMENT's containment chain, never on a component's, so a board that resolved only
    // component ids would report `activeFreeze: null` for every row a region freeze covers.
    listPlacementsForComponents(tx, orgId, componentIds),
    listPeers(tx, orgId),
    // ARM 2 of the change-blindness union — POSITIVE EVIDENCE that changes are moving on a peer
    // and cannot be attributed to anything local. Conditioned on IN_FLIGHT so a change that
    // settled long ago cannot keep a board claiming ignorance. One bounded, indexed read.
    listUnattachedChangeStatusInStates(tx, orgId, [...IN_FLIGHT])
  ]);
  // CHANGE-OBJECT BLINDNESS (see the file header). See docs/coordination.md §885.
  const changeBlindPeers = peers.filter((peer) => !scopeCarriesChangeObjects(peer.syncScope));
  // ARM 2, EVIDENCE-derived. Recorded at import, downstream of BOTH peers' scopes, so it fires on
  // exactly the mismatch arm 1 misses.
  const changeVisibilityUnknown = changeBlindPeers.length > 0 || unattachedInFlight.length > 0;

  // Staleness, over the peers whose scope can carry changes. See docs/coordination.md §886.
  const { label: asOf, anyStale: anyUpstreamStale } = await limitingUpstreamFreshness(
    tx,
    orgId,
    peers.filter((peer) => scopeCarriesChangeObjects(peer.syncScope))
  );
  // Named once, used for every empty row: what a row would otherwise assert by staying silent.
  // `changeName` is omitted deliberately — it is rendered from `latestChangeId`'s own cell, so
  // naming the id covers it.
  const emptyRowUnknowns = changeVisibilityUnknown
    ? [
        "latestChangeId",
        "changeState",
        "currentWave",
        "waves",
        "attention.blocked",
        "attention.decisionId",
        "attention.awaitingApproval",
        "attention.emergency"
      ]
    : [];

  // WHICH FREEZE IS ACTUALLY ON THIS ROW. See docs/coordination.md §887.
  const placementsByComponent = new Map<string, string[]>();
  for (const p of placements) {
    const list = placementsByComponent.get(p.componentObjectId) ?? [];
    list.push(p.placementId);
    placementsByComponent.set(p.componentObjectId, list);
  }
  const freezeLookupIds = [service.id, ...componentIds, ...placements.map((p) => p.placementId)];
  const freezesByObjectId = new Map<string, EffectiveFreeze[]>();
  for (const entry of await freezesByTarget(tx, orgId, freezeLookupIds, new Date())) {
    freezesByObjectId.set(entry.targetObjectId, entry.freezes);
  }
  /** The one freeze to show, chosen deterministically. See docs/coordination.md §888. */
  const activeFreezeFor = (objectId: string): EffectiveFreeze | undefined => {
    const candidates = [
      ...(freezesByObjectId.get(objectId) ?? []),
      ...(placementsByComponent.get(objectId) ?? []).flatMap(
        (placementId) => freezesByObjectId.get(placementId) ?? []
      )
    ];
    if (candidates.length === 0) return undefined;
    return candidates.reduce((best, f) =>
      f.endsAt.getTime() > best.endsAt.getTime() ||
      (f.endsAt.getTime() === best.endsAt.getTime() && f.id < best.id)
        ? f
        : best
    );
  };

  // 3. Per-component projection. Bounded by the service's component count; each iteration's reads are
  //    the same ones the Phase-1 change-pipeline view already relies on, run server-side in this tx.
  let releasing = 0;
  let blocked = 0;
  let stable = 0;
  let notDrivenHere = 0;
  // PER-PIPELINE STATE for every row, batched before the loop (three queries for the board, not
  // three per row — a service with dozens of microservices is exactly the case this view is for).
  const pipelineSummary = await pipelinesForComponents(
    tx,
    orgId,
    service.id,
    componentIds,
    placements
  );
  const pipelinesFor = (componentId: string): ServiceBoardPipeline[] =>
    pipelineSummary.byComponent.get(componentId) ?? [];

  const rows: ServiceBoardRow[] = [];
  for (const component of components) {
    const latest = latestByComponent.get(component.id) ?? null;
    const changeId = latest?.changeId ?? null;
    const componentFreeze = activeFreezeFor(component.id);

    if (!latest || !changeId) {
      // Nothing found for this component. See docs/coordination.md §889.
      stable += 1;
      rows.push({
        component: { id: component.id, urn: component.urn, name: component.name },
        pipelines: pipelinesFor(component.id),
        latestChangeId: null,
        changeState: null,
        changeName: null,
        currentWave: null,
        waves: [],
        attention: { blocked: false, decisionId: null, awaitingApproval: false, emergency: false },
        activeFreeze: componentFreeze ? toFreeze(componentFreeze) : null,
        driver: null,
        unknownFields: emptyRowUnknowns
      });
      continue;
    }

    if (!latest.drivenHere) {
      // Federation honesty about what actually replicated. See docs/coordination.md §890.
      notDrivenHere += 1;
      rows.push({
        component: { id: component.id, urn: component.urn, name: component.name },
        pipelines: pipelinesFor(component.id),
        latestChangeId: changeId,
        changeState: latest.federationState,
        changeName: latest.changeName,
        currentWave: null,
        waves: [],
        attention: { blocked: false, decisionId: null, awaitingApproval: false, emergency: false },
        activeFreeze: componentFreeze ? toFreeze(componentFreeze) : null,
        driver: { drivenHere: false, originDomainId: latest.originDomainId },
        unknownFields: [
          // Absent until a status entry arrives, which is common. See docs/coordination.md §891.
          ...(latest.federationState === null ? ["changeState"] : []),
          "currentWave",
          "waves",
          "attention.blocked",
          "attention.decisionId",
          "attention.awaitingApproval",
          "attention.emergency",
          // A peer's freeze reaches us only if it federates. See docs/coordination.md §892.
          ...(componentFreeze ? [] : ["activeFreeze"])
        ]
      });
      continue;
    }

    // Bounded: it was every Decision ever recorded before. See docs/coordination.md §893.
    const [change, plan, blockDecision, approvals] = await Promise.all([
      getChange(tx, orgId, changeId),
      getLatestPlanForChange(tx, orgId, changeId),
      latestBlockDecisionForSubject(tx, orgId, changeId),
      listApprovalRequestsForChange(tx, orgId, changeId)
    ]);

    const waves = plan?.waves ?? [];
    const boardWaves: ServiceBoardWave[] = waves.map((w) => {
      const kinds = [
        ...new Map(
          w.targets.map((t) => [`${t.category}::${t.type}`, { category: t.category, type: t.type }])
        ).values()
      ];
      return {
        waveIndex: w.waveIndex,
        name: w.name,
        status: w.status,
        kinds,
        targetCount: w.targets.length,
        failedTargets: w.targets.filter((t) => FAILED_STATUSES.has(t.status)).length
      };
    });

    // Current wave: the running wave if any, else the last non-pending wave (what's most-recently acted).
    const runningWave = waves.find((w) => w.status === "running");
    const lastActed = [...waves].reverse().find((w) => w.status !== "pending");
    const currentWave = (runningWave ?? lastActed)?.name ?? null;

    // Attention (all real). Blocked = a failed wave/target OR a persisted block Decision; the decisionId
    // is that block Decision (charter principle 6). awaitingApproval = a pending ApprovalRequest.
    const hasFailedWave = waves.some(
      (w) => w.status === "failed" || w.targets.some((t) => FAILED_STATUSES.has(t.status))
    );
    const isBlocked = hasFailedWave || blockDecision !== undefined;
    const awaitingApproval = approvals.some((a) => a.status !== "satisfied");

    rows.push({
      component: { id: component.id, urn: component.urn, name: component.name },
      pipelines: pipelinesFor(component.id),
      latestChangeId: changeId,
      changeState: change.state,
      changeName: change.name,
      currentWave,
      waves: boardWaves,
      attention: {
        blocked: isBlocked,
        decisionId: isBlocked ? (blockDecision?.id ?? null) : null,
        awaitingApproval,
        emergency: change.emergency
      },
      activeFreeze: componentFreeze ? toFreeze(componentFreeze) : null,
      driver: { drivenHere: true, originDomainId: null },
      unknownFields: []
    });

    if (isBlocked) blocked += 1;
    else if (IN_FLIGHT.has(change.state)) releasing += 1;
    else stable += 1;
  }

  // Board-level honesty: freeze visibility is partial for all. See docs/coordination.md §894.
  const freezeVisibilityUnknowns = peers.length > 0 ? ["serviceFreeze", "rows[].activeFreeze"] : [];

  // BOARD-LEVEL HONESTY, second rule. See docs/coordination.md §895.
  const changeVisibilityUnknowns = changeVisibilityUnknown
    ? ["summary.stable", "rows[].latestChangeId"]
    : [];

  // BOARD-LEVEL HONESTY, third rule: STALENESS. See docs/coordination.md §896.
  const stalenessUnknowns = anyUpstreamStale ? ["summary.stable", "rows[].latestChangeId"] : [];

  const serviceFreeze = activeFreezeFor(service.id);
  return {
    service: {
      id: service.id,
      urn: service.urn,
      name: service.name,
      // outpost-ui.md §9.3a — the service's own provenance, READ from originDomainId vs self and
      // the known peers, so the Infrastructure tab can state whether the commander is upstream of
      // this domain's shared IaC/CaC (a replica) or this domain authored it (self / domain-local).
      maintainedBy: (() => {
        if (service.originDomainId === self.domainId) {
          return { domainId: self.domainId, name: self.name, isSelf: true, role: self.role };
        }
        const peer = peers.find((p) => p.id === service.originDomainId);
        return peer
          ? { domainId: peer.id, name: peer.name, isSelf: false, role: peer.role }
          : { domainId: service.originDomainId, name: null, isSelf: false, role: null };
      })(),
      domainLocal: service.domainLocal
    },
    rows,
    summary: { releasing, blocked, stable, notDrivenHere },
    serviceFreeze: serviceFreeze ? toFreeze(serviceFreeze) : null,
    servicePipelines: pipelineSummary.forService,
    childAssemblies,
    asOf,
    unknownFields: [
      ...new Set([...freezeVisibilityUnknowns, ...changeVisibilityUnknowns, ...stalenessUnknowns])
    ]
  };
}
