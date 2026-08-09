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
import { listFreezes, type FreezeRow } from "../governance/freezes-repo.js";
import { ensureFederationSelf } from "../federation/self-repo.js";
import { listPeers } from "../federation/peers-repo.js";
import { scopeCarriesChangeObjects } from "../federation/scope-filter.js";
import { listUnattachedChangeStatusInStates } from "../federation/unattached-change-status-repo.js";
import { limitingUpstreamFreshness } from "../federation/upstream-freshness.js";
import { sqlIn } from "../graph/sql-helpers.js";
import { placementComponentParentSql } from "../graph/containment.js";

/**
 * Layer-A server projection backing `GET /services/:idOrUrn/board`
 * (docs/proposals/coordination-ui-views.md § "Service release board", Phase 2).
 *
 * The single net-new capability is {@link latestChangeByComponent}: "the latest change that targeted
 * this component, and which domain drives it." No target-filtered changes list exists
 * (ChangeListQuerySchema is state + cursor only), so without this a browser board would page every
 * change and `explain()` each — an O(all-changes) fan-out. Here it's two bounded, index-backed reads,
 * and the remaining per-component reads (plan waves, block Decision, pending approval) run inside the
 * same tenant transaction — bounded by the service's component count, not the org's change count.
 *
 * FEDERATION HONESTY (the reason this file names its unknowns explicitly). Every table this projection
 * reads for a row's DETAIL — `change_plans`/`change_waves`/`change_wave_targets`, `changes`,
 * `decisions`, `approval_requests`, `freezes` — is a LOCAL projection that never rides the sync
 * journal. Only the change's graph OBJECT replicates. A domain that holds a change as a read-only
 * replica therefore has no plan, no Decision, no approval and no freeze for it, and must say so:
 * such a row is reported as `driver.drivenHere === false` with the unobservable fields named in
 * `unknownFields`, and counted in its OWN `summary.notDrivenHere` bucket. It is NEVER counted as
 * `stable` — an outpost rendering green while the commander drives a release through its components
 * is a fabricated all-clear, not an empty view.
 *
 * CHANGE-OBJECT BLINDNESS (the second honesty rule, board-level). Everything above assumes that a
 * change replicated here AT ALL — that a component with no change object really has no change. That
 * assumption holds only while every peer forwards change objects. A peer paired at `status_only`
 * scope (`federation/scope-filter.ts`) forwards `change_status` entries but NOT the `object_upsert`
 * that carries the change, `policies_only` forwards neither, and a `custom` label selector may
 * forward some and not others. Under any of those, nothing lands for arm 2 to find and the row
 * would fall through to a confident `stable` — the same fabricated all-clear, one level deeper:
 * this domain HAS positive evidence changes exist on that peer (`import-repo.ts`'s `change_status`
 * branch receives entries naming `payload.objectId` and `payload.toState`) and simply cannot
 * attribute any of it to a component, because a `change_status` payload carries no `targets`.
 *
 * So this projection does not claim what it cannot see: when any peer's scope cannot carry change
 * objects ({@link scopeCarriesChangeObjects}), every row whose lookup came up EMPTY has its
 * would-be-clean fields named in `unknownFields` instead of passed off as observations, and the
 * response declares `summary.stable` and `rows[].latestChangeId` board-level unknowns. Rows whose
 * lookup DID find a change keep their reading untouched — an unknown must never displace a real
 * observation (see `service-board-precedence.integration.test.ts`) — and the counts still add up to
 * `rows.length` for shape stability; what changes is that they are no longer presented as facts.
 *
 * WHY SCOPE ALONE IS NOT ENOUGH — THE SECOND ARM (drizzle/0040). The rule above is derived from the
 * RECEIVER's own `federation_peers.sync_scope`. That column is purely LOCAL config: it is written by
 * `pairPeer`, read by export filtering, import defense-in-depth and this file, and it NEVER rides
 * the wire — the two peers' values are set independently by two operators and are never reconciled.
 * So it is blind to the case where the SENDER is the narrow side: a commander whose peer row for the
 * outpost says `status_only` ships change STATUS and no change OBJECTS, while the outpost's own row
 * says `changes_only` and its scope predicate cheerfully answers "I can see change objects". Every
 * row then falls through to a confident `stable` with an EMPTY `unknownFields` — the same fabricated
 * all-clear, on the most likely field misconfiguration there is.
 *
 * So the condition is a UNION of two independent arms, and both are kept:
 *
 *  1. SCOPE-derived (above) — the only signal available when THIS receiver's own scope guarantees
 *     blindness, because such a receiver drops the entries and produces no evidence at all.
 *  2. EVIDENCE-derived — `federation_unattached_change_status`, written by `import-repo.ts` at the
 *     two points where a `change_status` entry is dropped (no local replica of `payload.objectId`;
 *     or this receiver's scope filter discarded it). It fires downstream of BOTH peers' scopes, so
 *     it catches the sender-narrow mismatch that arm 1 structurally cannot. It is also strictly more
 *     precise than arm 1: the row carries the change's last reported state, so the caveat is
 *     conditioned on that state being IN-FLIGHT and one long-settled change cannot make a board
 *     claim ignorance forever. And it is self-clearing — the `object_upsert` path deletes the row
 *     the moment the change object lands — so it cannot fabricate persistent ignorance either.
 *
 * THE GAP THAT REMAINS, stated accurately. (i) The caveat is board-wide, not per-component: no
 * `change_status` payload carries `targets` and the change urn encodes nothing about them, so at
 * import time the receiver holds an object id and a state and nothing that resolves a component.
 * Per-component attribution would require widening the propose-time payload with `targets` — wire-
 * safe, but it discloses target component ids to a peer scoped precisely to withhold graph content,
 * which is an owner decision and deliberately not taken here. (ii) A sender at `policies_only` (or a
 * `custom` selector excluding `change_status`) sends no evidence of ANY kind; if this receiver's own
 * scope is wide, neither arm fires. Closing that would need the sender's scope carried in the bundle
 * header, which is measurably NOT an additive wire change (an un-upgraded importer strips the unknown
 * key and then fails every checksum, fail-closed) — a `formatVersion` flag day, not this fix.
 *
 * STALENESS (the third board-level rule, DESIGN §13). Everything above answers "can I see it"; none
 * of it answers "when did what I can see arrive". §13 requires the "as of &lt;bundle/date&gt;" label
 * and bans presenting stale data as live status. `asOf` carries that label for the LIMITING upstream
 * peer, and when that peer is overdue by its OWN effective cadence the same two board-level fields
 * are named unobservable — a newer change may exist upstream that has not been sent yet. See
 * `federation/upstream-freshness.ts`.
 */

/** Terminal statuses that count as a target/wave failure for the "blocked" derivation. `no_executor`
 *  (ADR-0006) is a fail-closed terminal — the target had bindings but none for the Type this wave rolls. */
const FAILED_STATUSES = new Set(["failed", "aborted", "no_executor"]);

/** A component's latest change, plus WHO DRIVES IT. `drivenHere` is false when the change's graph
 *  object is a read-only replica of another domain's change (`originDomainId !== self.domainId`) —
 *  DESIGN §13 single-writer authority. `federationState` is the lifecycle state that origin domain
 *  last reported through the sync journal (`import-repo.ts` mirrors a `change_status` entry onto the
 *  replicated object as `properties.federationState`); it is the ONLY lifecycle fact a non-driving
 *  domain holds. */
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

/**
 * For each component id, the change this domain will report for it — from two arms in a STRICT
 * FALLBACK, never a merge:
 *
 *  1. PLANNED (authoritative). The wave-target join: changes whose plan has been compiled here,
 *     including targets a campaign or coupling expanded onto a wave that the change's own
 *     `properties.targets` never named. Everything it returns is a REAL LOCAL OBSERVATION — this
 *     domain compiled that plan, rolls those waves, and holds the Decisions behind them.
 *  2. DECLARED (fallback, consulted ONLY for components arm 1 returned nothing for). The change
 *     GRAPH OBJECT's `properties.targets`, stamped at propose time by `proposeChange`. It covers
 *     the two cases arm 1 structurally cannot: a change with no compiled plan YET, and — the
 *     reason this arm exists — a change replicated from another domain. `change_plans` /
 *     `change_waves` / `change_wave_targets` / `changes` are local projection tables that never
 *     ride the sync journal, so on a domain holding a commander-origin change as a replica the
 *     join finds NOTHING. Treating that as "no change" reports a component mid-release as
 *     `stable`: a fabricated all-clear, not an empty view.
 *
 * WHY A FALLBACK AND NOT "WHICHEVER IS NEWER" (the regression this shape exists to prevent). The
 * two arms have NO COMMON CLOCK, so no sound ordering across them exists:
 *
 *  - arm 1 orders by `changes.created_at` (the local projection row), arm 2 by `objects.created_at`
 *    (the graph row) — two different timestamps for one concept, written at different moments;
 *  - worse, for a REPLICA `objects.created_at` is `defaultNow()` at IMPORT time (the `object_upsert`
 *    payload carries no createdAt), i.e. a FABRICATED ordering key. Every freshly imported change
 *    outranks every pre-existing local one.
 *
 * Comparing them let an honest UNKNOWN displace a REAL OBSERVATION: on a single-domain org a newer
 * unplanned change hid an older planned+FAILED one (the board's `blocked` count silently dropped to
 * 0), and on an outpost any newer commander-origin replica hid the outpost's own genuinely-observed
 * failure — the one fact it actually holds. An observation always beats an unknown, in BOTH
 * directions, so arm 1 wins outright for every component it covers and the cross-clock comparison
 * is gone. (Deliberate consequence: a component whose latest LOCAL change has no plan yet keeps
 * showing its previous, planned change — exactly the pre-federation-fix behaviour, and the reading
 * with real waves behind it.)
 *
 * Both arms are index-backed and bounded by the service's component count: arm 1 by the wave-target
 * keys with `DISTINCT ON` (≤1 row per component), arm 2 by a per-component LATERAL `LIMIT 1` over
 * the `obj_props` GIN (`jsonb_path_ops`) index via `@>` containment (≤1 row per component, and only
 * for the components arm 1 left open). Neither can return more rows than the service has components.
 *
 * Both arms filter soft-deleted change objects identically (`objects.deleted_at IS NULL`): a
 * deleted change must not drive a row through one arm while being invisible to the other.
 */
async function latestChangeByComponent(
  tx: TenantTx,
  orgId: string,
  componentIds: string[],
  selfDomainId: string
): Promise<Map<string, LatestChangeRef>> {
  if (componentIds.length === 0) return new Map();

  const latest = new Map<string, LatestChangeRef>();

  // ARM 1 — the local observation. Authoritative for every component it answers for.
  //
  // THE PLACEMENT HOP (ADR-0026). A wave target is a component under legacy compilation and a
  // PLACEMENT under stage-shaped compilation, so `t.target_object_id AS component_id` is only half
  // true and the `IN (componentIds)` filter matched NOTHING for a stage-shaped plan. Arm 1 would
  // have returned zero rows for every component and this function would have silently degraded to
  // arm 2 for the whole board — which is not a smaller answer, it is a DIFFERENT KIND of answer.
  // Arm 2 is the fallback precisely because it is an unknown rather than an observation, and this
  // file's own header records what happens when the two are confused: on an outpost, a newer
  // commander-origin replica hides the outpost's genuinely-observed failure — the one fact it
  // actually holds. The board would have kept rendering, with the strict-fallback shape it was
  // built around quietly inverted.
  //
  // `placementComponentParentSql` is the SAME fragment `graph/containment.ts` and `authz/resolve.ts`
  // walk, LATERAL-joined here: one definition of "the component a placement places", including its
  // guard against a malformed `componentId` casting-error. A legacy component target matches no
  // placement row, so the LATERAL yields nothing and COALESCE falls through to the target itself —
  // both shapes read through one query, and the legacy answer is unchanged.
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

function toFreeze(f: FreezeRow): ServiceBoardFreeze {
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

/**
 * THE PER-PIPELINE SUMMARY for every component of a service, plus the service's own.
 *
 * Batched deliberately: three queries for the whole board rather than three per row. A service with
 * dozens of microservices is the case this view exists for, and a per-row resolve would make the
 * board's cost linear in components × pipelines.
 *
 * `bound` follows the SAME rungs `resolveBindingForTarget` walks (ADR-0026 + ADR-0027): the
 * component itself, its placements, then the owning service. A board that computed boundness
 * differently from the resolver would tell an operator a pipeline exists that reconcile then
 * refuses — or the reverse — which is worse than not showing it.
 */
async function pipelinesForComponents(
  tx: TenantTx,
  orgId: string,
  serviceObjectId: string,
  componentIds: string[]
): Promise<{
  byComponent: Map<string, ServiceBoardPipeline[]>;
  forService: ServiceBoardPipeline[];
}> {
  const byComponent = new Map<string, ServiceBoardPipeline[]>();

  const placementRows =
    componentIds.length === 0
      ? []
      : await tx
          .select({ id: objectsTable.id, properties: objectsTable.properties })
          .from(objectsTable)
          .where(
            and(
              eq(objectsTable.orgId, orgId),
              eq(objectsTable.typeId, "placement"),
              isNull(objectsTable.deletedAt)
            )
          );
  const componentSet = new Set(componentIds);
  const placementsByComponent = new Map<string, string[]>();
  const placementToComponent = new Map<string, string>();
  for (const row of placementRows) {
    const props = row.properties as { componentId?: unknown };
    if (typeof props.componentId !== "string" || !componentSet.has(props.componentId)) continue;
    placementsByComponent.set(props.componentId, [
      ...(placementsByComponent.get(props.componentId) ?? []),
      row.id
    ]);
    placementToComponent.set(row.id, props.componentId);
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
  // 1. The service's components: `contains` edges (service → component), one bounded hop.
  const { objects } = await traverse(tx, orgId, {
    objectId: service.id,
    direction: "out",
    relTypes: ["contains"],
    maxDepth: 1
  });
  const components = objects
    .filter((o) => o.id !== service.id && o.typeId === "component")
    .sort((a, b) => a.name.localeCompare(b.name));
  const componentIds = components.map((c) => c.id);

  // 2. Latest change per component (the net-new join), then the active freezes to overlay read-only.
  //    `ensureFederationSelf` supplies THIS domain's federation id — the yardstick for "do I drive
  //    this change?". It is an ensure (not a get) because it is the one canonical way to name this
  //    instance; minting the identity row on first use is idempotent and race-safe (self-repo.ts).
  const self = await ensureFederationSelf(tx, orgId);
  const [latestByComponent, allFreezes, peers, unattachedInFlight] = await Promise.all([
    latestChangeByComponent(tx, orgId, componentIds, self.domainId),
    listFreezes(tx, orgId),
    listPeers(tx, orgId),
    // ARM 2 of the change-blindness union — POSITIVE EVIDENCE that changes are moving on a peer
    // and cannot be attributed to anything local. Conditioned on IN_FLIGHT so a change that
    // settled long ago cannot keep a board claiming ignorance. One bounded, indexed read.
    listUnattachedChangeStatusInStates(tx, orgId, [...IN_FLIGHT])
  ]);
  // CHANGE-OBJECT BLINDNESS (see the file header) — a UNION of two independent arms, because
  // neither alone covers both directions of a scope mismatch.
  //
  // ARM 1, SCOPE-derived. A peer whose scope cannot carry change `object_upsert` entries leaves
  // this domain unable to tell "no change targets this component" from "I was never sent the
  // change that does" — while `status_only` specifically keeps sending `change_status` entries, so
  // the domain holds positive evidence that changes exist there. Derived from this RECEIVER's own
  // recorded scope, which is the predicate `import-repo.ts` re-applies on the way in. It is sound
  // (it never fabricates ignorance) but it under-claims whenever the SENDER is the narrower side,
  // since `sync_scope` never crosses the wire and the two sides are never reconciled.
  const changeBlindPeers = peers.filter((peer) => !scopeCarriesChangeObjects(peer.syncScope));
  // ARM 2, EVIDENCE-derived. Recorded at import, downstream of BOTH peers' scopes, so it fires on
  // exactly the mismatch arm 1 misses.
  const changeVisibilityUnknown = changeBlindPeers.length > 0 || unattachedInFlight.length > 0;

  // STALENESS (DESIGN §13), over the peers whose scope CAN carry change objects — the peers that
  // can be blind are already covered above, and a peer that structurally cannot send change objects
  // does not bound the freshness of change objects.
  //
  // TWO ANSWERS, deliberately: `label` is the OLDEST reading (the "as of" bound), `anyStale` is an
  // ANY-peer predicate. Reading the caveat off the label's own `stale` — as this did — silently
  // dropped it for any overdue peer that was not also the oldest, which is the common shape: an
  // air-gapped peer weeks old (`stale: null`, no cadence applies) wins the label and hides a
  // commander an hour past its 60s cadence. See `upstream-freshness.ts`.
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

  const now = Date.now();
  const activeFreezeByScope = new Map<string, FreezeRow>();
  for (const f of allFreezes) {
    if (
      f.startsAt.getTime() <= now &&
      f.endsAt.getTime() > now &&
      !activeFreezeByScope.has(f.scopeObjectId)
    ) {
      activeFreezeByScope.set(f.scopeObjectId, f);
    }
  }

  // 3. Per-component projection. Bounded by the service's component count; each iteration's reads are
  //    the same ones the Phase-1 change-pipeline view already relies on, run server-side in this tx.
  let releasing = 0;
  let blocked = 0;
  let stable = 0;
  let notDrivenHere = 0;
  // PER-PIPELINE STATE for every row, batched before the loop (three queries for the board, not
  // three per row — a service with dozens of microservices is exactly the case this view is for).
  const pipelineSummary = await pipelinesForComponents(tx, orgId, service.id, componentIds);
  const pipelinesFor = (componentId: string): ServiceBoardPipeline[] =>
    pipelineSummary.byComponent.get(componentId) ?? [];

  const rows: ServiceBoardRow[] = [];
  for (const component of components) {
    const latest = latestByComponent.get(component.id) ?? null;
    const changeId = latest?.changeId ?? null;
    const componentFreeze = activeFreezeByScope.get(component.id);

    if (!latest || !changeId) {
      // Nothing found for this component. On a domain every peer of which forwards change objects
      // that is a complete observation — genuinely nothing is rolling here. On a change-blind
      // deployment it is not an observation at all, and `emptyRowUnknowns` says so rather than
      // letting the nulls/false/[] below read as an all-clear. It still counts toward `stable` for
      // shape stability (the four buckets must keep summing to `rows.length`, as
      // `service-board-federation.integration.test.ts` pins) — which is precisely why the response
      // then declares `summary.stable` itself unknown.
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
      // FEDERATION HONESTY. The change object replicated here; its plan/waves, block Decisions,
      // approval requests and freezes did not — none of those tables ever rides the sync journal.
      // So this domain can state two real observations (the change exists; the origin domain last
      // reported `federationState`) and genuinely cannot state anything else. It therefore counts
      // as its OWN bucket, never `stable`: claiming an all-clear from data this domain never had is
      // exactly the fabrication the graph-health surfaces already refuse (absent ⇒ `unknown`).
      //
      // The zero values below are shape stability, NOT observations — `unknownFields` names every
      // one of them so no client can mistake the two.
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
          // `federationState` is absent until a `change_status` entry arrives — and the COMMON
          // ordering is that `object_upsert` lands first, so this is the normal state of a
          // freshly-replicated change, not an edge case. Emitting the resulting `changeState: null`
          // without saying so would be byte-identical on the wire to a genuine no-change row: the
          // exact confusion between "nothing to report" and "cannot see" this projection exists to
          // prevent. The lifecycle state is unknown here until the origin reports one.
          ...(latest.federationState === null ? ["changeState"] : []),
          "currentWave",
          "waves",
          "attention.blocked",
          "attention.decisionId",
          "attention.awaitingApproval",
          "attention.emergency",
          // A freeze declared in the DRIVING domain never replicates either, so only a freeze we
          // actually found locally is an observation; its absence tells us nothing about theirs.
          // (The same is true of a freeze declared in ANOTHER domain for a row this domain DOES
          // drive — freezes never ride the journal in either direction. That is a property of the
          // whole board rather than of one row, so it is stated once, board-level, in the response's
          // own `unknownFields`; see `freezeVisibilityUnknowns` below.)
          ...(componentFreeze ? [] : ["activeFreeze"])
        ]
      });
      continue;
    }

    // BOUNDED (was `listDecisionsForSubject`: every Decision ever recorded about this change, no
    // `kind` filter, no `LIMIT`, once PER BOARD ROW). The board consumes exactly one Decision — the
    // latest `block`, whose id it hands the operator below — and on the live instance each of the 29
    // changes carried ~425,000 rows, so one board render pulled hundreds of thousands of rows per row
    // of the board. Measured at 12M rows: 26,547 ms / 399,596 buffers for the old read against
    // 1.14 ms / 6 buffers for this one, same answer. See `latestBlockDecisionForSubject` for why it
    // is keyed on the verdict the board actually means rather than on a list of `kind`s that a future
    // eleventh block-writer would silently falsify — and why that only becomes an O(1) read with
    // drizzle/0046's partial index behind it (without it, a change that never blocked pays a walk
    // over its whole history to return nothing).
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

  // BOARD-LEVEL HONESTY: freeze visibility is domain-local, for EVERY row alike. `freezes` is a
  // local projection that is never passed to `appendJournalEntry` (governance/freezes-repo.ts), so a
  // freeze declared in another domain is invisible here whether or not this domain drives the row's
  // change — a null `activeFreeze` on a DRIVEN-HERE row asserts "no freeze declared HERE", never
  // "no freeze applies". Stated once at the response level rather than repeated into every row's
  // `unknownFields`, because it is a property of the freeze TABLE's federation status, not of any
  // row's driver: putting it per-row would make `row.unknownFields` mean two different things (what
  // this row's driver withheld, and what this deployment structurally cannot see) and would fire on
  // every row of every board.
  //
  // Conditioned on this org actually having a federation peer: with no peer there IS no other domain
  // whose freeze could be missing, and a null freeze is then a complete observation. Claiming
  // ignorance we don't have would be its own small dishonesty.
  const freezeVisibilityUnknowns = peers.length > 0 ? ["serviceFreeze", "rows[].activeFreeze"] : [];

  // BOARD-LEVEL HONESTY, second rule: change-object blindness (see the file header). Two statements
  // stop being observations the moment a peer's scope withholds change objects:
  //
  //  - `summary.stable` — it now mixes genuinely-settled rows with rows that merely came up empty,
  //    and nothing in the response distinguishes them, so the COUNT cannot be read as "this many
  //    components are fine". A client must not paint it as an all-clear.
  //  - `rows[].latestChangeId` — for an empty row it may be an unsent change (the row's own
  //    `unknownFields` says so); for a row that DID find one, that change may not be the newest,
  //    because a newer one from the blind peer would never have arrived. Stated once here rather
  //    than stamped onto rows whose reading is a real local observation.
  //
  // Board-level for the same reason freeze visibility is: this is a property of what this
  // DEPLOYMENT can structurally see, not of any one row's driver.
  const changeVisibilityUnknowns = changeVisibilityUnknown
    ? ["summary.stable", "rows[].latestChangeId"]
    : [];

  // BOARD-LEVEL HONESTY, third rule: STALENESS (DESIGN §13 — "never presents stale data as live
  // status"). The two statements above stop being current observations the moment the limiting
  // upstream is overdue by its OWN effective cadence: a newer change may already exist there that
  // simply has not been sent yet, so `summary.stable` may be counting rows that are no longer
  // settled and no row's `latestChangeId` is certainly the latest. Same two dotted paths as the
  // blindness rule because it is the same two claims that fail — deduped below, since a board can
  // be both blind AND stale and must not say so twice.
  //
  // Fires on ANY overdue upstream (`anyUpstreamStale`), NOT on the label peer's own `stale`. The
  // label is the oldest reading, which is routinely an air-gapped peer whose `stale` is `null` (no
  // cadence applies to it) — conditioning the caveat on that reading silently suppressed it for
  // every overdue peer that was not also the oldest, i.e. exactly the incident it exists to catch.
  //
  // Still deliberately keyed on `stale === true` per peer, never `null`. `null` means no cadence
  // exists for the data to be late against, and §13's contract there is the LABEL, which `asOf`
  // carries — asserting an unknown from the mere absence of a schedule would over-claim ignorance
  // on every air-gapped deployment forever.
  const stalenessUnknowns = anyUpstreamStale ? ["summary.stable", "rows[].latestChangeId"] : [];

  const serviceFreeze = activeFreezeByScope.get(service.id);
  return {
    service: { id: service.id, urn: service.urn, name: service.name },
    rows,
    summary: { releasing, blocked, stable, notDrivenHere },
    serviceFreeze: serviceFreeze ? toFreeze(serviceFreeze) : null,
    servicePipelines: pipelineSummary.forService,
    asOf,
    unknownFields: [
      ...new Set([...freezeVisibilityUnknowns, ...changeVisibilityUnknowns, ...stalenessUnknowns])
    ]
  };
}
