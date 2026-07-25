import { sql } from "drizzle-orm";
import type {
  GraphObject,
  ServiceBoardResponse,
  ServiceBoardRow,
  ServiceBoardWave,
  ServiceBoardFreeze
} from "@scp/schemas";
import type { TenantTx } from "../db/tenant-tx.js";
import { traverse } from "../graph/traverse.js";
import { getChange, targetObjectIdsOf } from "./changes-repo.js";
import { getLatestPlanForChange } from "./plan-service.js";
import { listDecisionsForSubject } from "./decisions-repo.js";
import { listApprovalRequestsForChange } from "../governance/approvals-repo.js";
import { listFreezes, type FreezeRow } from "../governance/freezes-repo.js";
import { ensureFederationSelf } from "../federation/self-repo.js";
import { sqlIn } from "../graph/sql-helpers.js";

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
  createdAt: Date;
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
    createdAt: row.created_at instanceof Date ? row.created_at : new Date(row.created_at),
    drivenHere: row.origin_domain_id === null || row.origin_domain_id === selfDomainId,
    originDomainId: row.origin_domain_id === selfDomainId ? null : row.origin_domain_id,
    federationState: typeof state === "string" ? state : null
  };
}

/**
 * For each component id, the LATEST change (by `created_at`) that targets it — from BOTH lookups,
 * because neither alone is complete:
 *
 *  - the WAVE-TARGET join finds changes whose plan has been compiled, including targets a campaign
 *    or coupling expanded onto a wave that the change's own `properties.targets` never named;
 *  - the change GRAPH OBJECT's `properties.targets` (stamped at propose time by `proposeChange`)
 *    finds a change that has no compiled plan YET, and — the reason this exists — it is the ONLY
 *    lookup that survives federation. `change_plans` / `change_waves` / `change_wave_targets` /
 *    `changes` are local projection tables that never ride the sync journal, so on a domain holding
 *    a commander-origin change as a replica the join finds NOTHING. Treating that as "no change"
 *    reports a component mid-release as `stable`: a fabricated all-clear, not an empty view.
 *
 * Both are index-backed and bounded by the service's component count: the join by the wave-target
 * keys, the object lookup by the `obj_props` GIN (`jsonb_path_ops`) index via `@>` containment.
 */
async function latestChangeByComponent(
  tx: TenantTx,
  orgId: string,
  componentIds: string[],
  selfDomainId: string
): Promise<Map<string, LatestChangeRef>> {
  if (componentIds.length === 0) return new Map();

  const containment = sql.join(
    componentIds.map(
      (id) => sql`o.properties @> jsonb_build_object('targets', jsonb_build_array(${id}::text))`
    ),
    sql` OR `
  );

  const [planned, declared] = await Promise.all([
    tx.execute<ChangeCandidateRow & { component_id: string }>(sql`
      SELECT DISTINCT ON (t.target_object_id)
        t.target_object_id  AS component_id,
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
      WHERE t.org_id = ${orgId}::uuid AND ${sqlIn("t.target_object_id", componentIds)}
      ORDER BY t.target_object_id, c.created_at DESC, c.object_id DESC
    `),
    tx.execute<ChangeCandidateRow>(sql`
      SELECT
        o.id                AS change_id,
        o.name              AS change_name,
        o.properties        AS properties,
        o.origin_domain_id  AS origin_domain_id,
        o.created_at        AS created_at
      FROM objects o
      WHERE o.org_id = ${orgId}::uuid
        AND o.type_id = 'change'
        AND o.deleted_at IS NULL
        AND (${containment})
      ORDER BY o.created_at DESC, o.id DESC
    `)
  ]);

  const latest = new Map<string, LatestChangeRef>();
  const componentSet = new Set(componentIds);
  const consider = (componentId: string, ref: LatestChangeRef): void => {
    const existing = latest.get(componentId);
    if (!existing || ref.createdAt.getTime() > existing.createdAt.getTime()) {
      latest.set(componentId, ref);
    }
  };

  for (const row of planned.rows) consider(row.component_id, toRef(row, selfDomainId));
  for (const row of declared.rows) {
    const ref = toRef(row, selfDomainId);
    for (const target of targetObjectIdsOf(row.properties)) {
      if (componentSet.has(target)) consider(target, ref);
    }
  }
  return latest;
}

function toFreeze(f: FreezeRow): ServiceBoardFreeze {
  return { id: f.id, reason: f.reason, endsAt: f.endsAt.toISOString() };
}

/** The states in which a change is genuinely rolling (in-flight) rather than settled. */
const IN_FLIGHT = new Set(["proposed", "evaluated", "coordinated", "waiting", "executing", "validating"]);

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
  const [latestByComponent, allFreezes] = await Promise.all([
    latestChangeByComponent(tx, orgId, componentIds, self.domainId),
    listFreezes(tx, orgId)
  ]);
  const now = Date.now();
  const activeFreezeByScope = new Map<string, FreezeRow>();
  for (const f of allFreezes) {
    if (f.startsAt.getTime() <= now && f.endsAt.getTime() > now && !activeFreezeByScope.has(f.scopeObjectId)) {
      activeFreezeByScope.set(f.scopeObjectId, f);
    }
  }

  // 3. Per-component projection. Bounded by the service's component count; each iteration's reads are
  //    the same ones the Phase-1 change-pipeline view already relies on, run server-side in this tx.
  let releasing = 0;
  let blocked = 0;
  let stable = 0;
  let notDrivenHere = 0;
  const rows: ServiceBoardRow[] = [];
  for (const component of components) {
    const latest = latestByComponent.get(component.id) ?? null;
    const changeId = latest?.changeId ?? null;
    const componentFreeze = activeFreezeByScope.get(component.id);

    if (!latest || !changeId) {
      stable += 1;
      rows.push({
        component: { id: component.id, urn: component.urn, name: component.name },
        latestChangeId: null,
        changeState: null,
        changeName: null,
        currentWave: null,
        waves: [],
        attention: { blocked: false, decisionId: null, awaitingApproval: false, emergency: false },
        activeFreeze: componentFreeze ? toFreeze(componentFreeze) : null,
        driver: null,
        unknownFields: []
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
        latestChangeId: changeId,
        changeState: latest.federationState,
        changeName: latest.changeName,
        currentWave: null,
        waves: [],
        attention: { blocked: false, decisionId: null, awaitingApproval: false, emergency: false },
        activeFreeze: componentFreeze ? toFreeze(componentFreeze) : null,
        driver: { drivenHere: false, originDomainId: latest.originDomainId },
        unknownFields: [
          "currentWave",
          "waves",
          "attention.blocked",
          "attention.decisionId",
          "attention.awaitingApproval",
          "attention.emergency",
          // A freeze declared in the DRIVING domain never replicates either, so only a freeze we
          // actually found locally is an observation; its absence tells us nothing about theirs.
          ...(componentFreeze ? [] : ["activeFreeze"])
        ]
      });
      continue;
    }

    const [change, plan, decisions, approvals] = await Promise.all([
      getChange(tx, orgId, changeId),
      getLatestPlanForChange(tx, orgId, changeId),
      listDecisionsForSubject(tx, orgId, changeId),
      listApprovalRequestsForChange(tx, orgId, changeId)
    ]);

    const waves = plan?.waves ?? [];
    const boardWaves: ServiceBoardWave[] = waves.map((w) => {
      const kinds = [...new Map(w.targets.map((t) => [`${t.category}::${t.type}`, { category: t.category, type: t.type }])).values()];
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
    const blockDecision = [...decisions].reverse().find((d) => d.verdict === "block") ?? null;
    const isBlocked = hasFailedWave || blockDecision !== null;
    const awaitingApproval = approvals.some((a) => a.status !== "satisfied");

    rows.push({
      component: { id: component.id, urn: component.urn, name: component.name },
      latestChangeId: changeId,
      changeState: change.state,
      changeName: change.name,
      currentWave,
      waves: boardWaves,
      attention: {
        blocked: isBlocked,
        decisionId: isBlocked ? blockDecision?.id ?? null : null,
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

  const serviceFreeze = activeFreezeByScope.get(service.id);
  return {
    service: { id: service.id, urn: service.urn, name: service.name },
    rows,
    summary: { releasing, blocked, stable, notDrivenHere },
    serviceFreeze: serviceFreeze ? toFreeze(serviceFreeze) : null
  };
}
