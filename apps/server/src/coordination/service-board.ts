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
import { getChange } from "./changes-repo.js";
import { getLatestPlanForChange } from "./plan-service.js";
import { listDecisionsForSubject } from "./decisions-repo.js";
import { listApprovalRequestsForChange } from "../governance/approvals-repo.js";
import { listFreezes, type FreezeRow } from "../governance/freezes-repo.js";
import { ensureFederationSelf } from "../federation/self-repo.js";
import { listPeers } from "../federation/peers-repo.js";
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
 *
 * THE ONE GAP THIS PROJECTION STILL CANNOT CLOSE, stated accurately. A peer paired at `status_only`
 * scope (`federation/scope-filter.ts`) receives `change_status` entries but NOT the `object_upsert`
 * that carries the change object, so nothing lands here for arm 2 to find and the component reads
 * as an honest `stable`. That is NOT "genuinely indistinguishable from no change ever": the domain
 * DID receive positive evidence — a `change_status` entry naming `payload.objectId` and
 * `payload.toState`. `import-repo.ts`'s enrichment resolves that id, finds no replicated object,
 * throws, and the surrounding catch discards the evidence (see that file's `change_status` branch,
 * where the two failure modes are now distinguished rather than swallowed as one). The board cannot
 * attribute that evidence to a component — a `change_status` payload carries no `targets` — so
 * closing this gap means carrying the evidence at the FEDERATION layer, not here. Tracked as a
 * follow-up; described honestly rather than papered over as an equivalence.
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
  const planned = await tx.execute<ChangeCandidateRow & { component_id: string }>(sql`
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
    WHERE t.org_id = ${orgId}::uuid
      AND o.deleted_at IS NULL
      AND ${sqlIn("t.target_object_id", componentIds)}
    ORDER BY t.target_object_id, c.created_at DESC, c.object_id DESC
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
      ORDER BY ch.created_at DESC, ch.id DESC
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
  const [latestByComponent, allFreezes, peers] = await Promise.all([
    latestChangeByComponent(tx, orgId, componentIds, self.domainId),
    listFreezes(tx, orgId),
    listPeers(tx, orgId)
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

  const serviceFreeze = activeFreezeByScope.get(service.id);
  return {
    service: { id: service.id, urn: service.urn, name: service.name },
    rows,
    summary: { releasing, blocked, stable, notDrivenHere },
    serviceFreeze: serviceFreeze ? toFreeze(serviceFreeze) : null,
    unknownFields: freezeVisibilityUnknowns
  };
}
