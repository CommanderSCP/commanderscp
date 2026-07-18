import { sql } from "drizzle-orm";
import type {
  GraphObject,
  ServiceBoardResponse,
  ServiceBoardRow,
  ServiceBoardStage,
  ServiceBoardFreeze
} from "@scp/schemas";
import type { TenantTx } from "../db/tenant-tx.js";
import { traverse } from "../graph/traverse.js";
import { getChange } from "./changes-repo.js";
import { getLatestPlanForChange } from "./plan-service.js";
import { listDecisionsForSubject } from "./decisions-repo.js";
import { listApprovalRequestsForChange } from "../governance/approvals-repo.js";
import { listFreezes, type FreezeRow } from "../governance/freezes-repo.js";
import { sqlIn } from "../graph/sql-helpers.js";

/**
 * Layer-A server projection backing `GET /services/:idOrUrn/board`
 * (docs/proposals/coordination-ui-views.md § "Service release board", Phase 2).
 *
 * The single net-new capability is {@link latestChangeIdByComponent}: "the latest change that targeted
 * this component." No target-filtered changes list exists (ChangeListQuerySchema is state + cursor only),
 * so without this a browser board would page every change and `explain()` each — an O(all-changes)
 * fan-out. Here it's one keyset `DISTINCT ON` join, and the remaining per-component reads (plan waves,
 * block Decision, pending approval) run inside the same tenant transaction — bounded by the service's
 * component count, not the org's change count.
 */

/** Terminal statuses that count as a target/wave failure for the "blocked" derivation. `no_executor`
 *  (ADR-0006) is a fail-closed terminal — the target had bindings but none for the Type this wave rolls. */
const FAILED_STATUSES = new Set(["failed", "aborted", "no_executor"]);

/** For each component id, the object id of the LATEST change (by change `created_at`) that included the
 *  component as a wave target. One round-trip; components with no change simply don't appear in the map. */
async function latestChangeIdByComponent(
  tx: TenantTx,
  orgId: string,
  componentIds: string[]
): Promise<Map<string, string>> {
  if (componentIds.length === 0) return new Map();
  const rows = await tx.execute<{ component_id: string; change_id: string }>(sql`
    SELECT DISTINCT ON (t.target_object_id)
      t.target_object_id AS component_id,
      c.object_id        AS change_id
    FROM change_wave_targets t
    JOIN change_waves  w ON w.id = t.wave_id  AND w.org_id = t.org_id
    JOIN change_plans  p ON p.id = w.plan_id  AND p.org_id = w.org_id
    JOIN changes       c ON c.object_id = p.change_object_id AND c.org_id = p.org_id
    WHERE t.org_id = ${orgId}::uuid AND ${sqlIn("t.target_object_id", componentIds)}
    ORDER BY t.target_object_id, c.created_at DESC, c.object_id DESC
  `);
  return new Map(rows.rows.map((r) => [r.component_id, r.change_id]));
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
  const [latestByComponent, allFreezes] = await Promise.all([
    latestChangeIdByComponent(tx, orgId, componentIds),
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
  const rows: ServiceBoardRow[] = [];
  for (const component of components) {
    const changeId = latestByComponent.get(component.id) ?? null;
    const componentFreeze = activeFreezeByScope.get(component.id);

    if (!changeId) {
      stable += 1;
      rows.push({
        component: { id: component.id, urn: component.urn, name: component.name },
        latestChangeId: null,
        changeState: null,
        changeName: null,
        currentStage: null,
        stages: [],
        attention: { blocked: false, decisionId: null, awaitingApproval: false, emergency: false },
        activeFreeze: componentFreeze ? toFreeze(componentFreeze) : null
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
    const stages: ServiceBoardStage[] = waves.map((w) => {
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

    // Current stage: the running wave if any, else the last non-pending wave (what's most-recently acted).
    const runningWave = waves.find((w) => w.status === "running");
    const lastActed = [...waves].reverse().find((w) => w.status !== "pending");
    const currentStage = (runningWave ?? lastActed)?.name ?? null;

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
      currentStage,
      stages,
      attention: {
        blocked: isBlocked,
        decisionId: isBlocked ? blockDecision?.id ?? null : null,
        awaitingApproval,
        emergency: change.emergency
      },
      activeFreeze: componentFreeze ? toFreeze(componentFreeze) : null
    });

    if (isBlocked) blocked += 1;
    else if (IN_FLIGHT.has(change.state)) releasing += 1;
    else stable += 1;
  }

  const serviceFreeze = activeFreezeByScope.get(service.id);
  return {
    service: { id: service.id, urn: service.urn, name: service.name },
    rows,
    summary: { releasing, blocked, stable },
    serviceFreeze: serviceFreeze ? toFreeze(serviceFreeze) : null
  };
}
