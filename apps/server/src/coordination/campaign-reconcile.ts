import type { Db } from "../db/client.js";
import { orgs } from "../db/schema.js";
import { withTenantTx } from "../db/tenant-tx.js";
import type { PluginHost } from "../plugin-host/contract.js";
import type { CelSandbox } from "../governance/cel-sandbox.js";
import type { GateDeps } from "./gates.js";
import { evaluateWaveGate } from "./gates.js";
import { insertDecision } from "./decisions-repo.js";
import { proposeChange } from "./changes-repo.js";
import { createRelationship } from "../graph/relationships-repo.js";
import { SYSTEM_ACTOR_ID } from "./system-actor.js";
import {
  campaignTargetObjectIdsOf,
  listActiveCampaignObjectIds,
  type ObjectRow
} from "./campaign-repo.js";
import {
  compileAndPersistCampaignPlan,
  getLatestCampaignPlan,
  markCampaignPlanCompleted
} from "./campaign-plan-service.js";
import {
  markCampaignWaveBlocked,
  markCampaignWaveRunning,
  markCampaignWaveTargetProposed,
  markCampaignWaveTargetTerminal,
  markCampaignWaveTerminal
} from "./campaign-wave-targets-repo.js";

/**
 * The campaign reconciler (DESIGN.md §9.5, BUILD_AND_TEST.md §8 M5) — a THIN extension of M3's
 * existing resumable reconciliation loop (`coordination/reconcile.ts`), not a second engine.
 * Wired into the SAME 1s tick (`reconcile.ts`'s `reconcileOrgTick` calls `reconcileCampaignsOrgTick`
 * right alongside `advanceExecutingChanges` — see that file). Reuses, unmodified:
 *
 *  - `coordination/plan-compiler.ts`'s pure `compilePlan` (via `campaign-plan-service.ts`) —
 *    identical toposort/topology-validation logic a Change's own plan uses.
 *  - `coordination/gates.ts`'s `evaluateWaveGate` — the EXACT SAME wave-boundary governance path
 *    (policies, controls, freezes, the `gate_bindings` raw-control escape hatch) a Change's own
 *    wave boundary uses, just called with the campaign's object id instead of a change's. This is
 *    the "campaign wave gate is ADDITIONAL, never a substitute" requirement made concrete: a
 *    member Change proposed here still runs through its OWN, completely separate
 *    `validating->promoted` gate via the ordinary `coordination/reconcile.ts` loop once proposed.
 *  - `coordination/changes-repo.ts`'s `proposeChange` — a campaign wave target's "unit of work" IS
 *    a real M3 Change, created exactly the way `POST /changes` creates one, then left to the
 *    ordinary (unmodified) change reconciliation loop to drive to `promoted`.
 *
 * One campaign wave is "active" at a time (mirrors `reconcile.ts`'s `advanceExecutingChanges`):
 * the first wave not yet `succeeded`/`skipped`/`failed`. A `blocked` wave is retried every tick —
 * exactly like a change's own blocked wave gate — so an operator satisfying the blocking policy/
 * control (an approval, a freeze override, a control re-run) unblocks it on the very next tick with
 * no separate "unblock" action needed.
 */
const BATCH_LIMIT = 25;

function logCampaignError(orgId: string, campaignObjectId: string, step: string, err: unknown): void {
  console.error(`[campaign-reconcile] org ${orgId} campaign ${campaignObjectId} ${step} failed (will retry next tick):`, err);
}

async function reconcileOneCampaign(
  db: Db,
  orgId: string,
  campaignObject: ObjectRow,
  host: PluginHost,
  sandbox: CelSandbox
): Promise<void> {
  const gateDeps: GateDeps = { sandbox, host };
  const campaignObjectId = campaignObject.id;

  let plan = await withTenantTx(db, orgId, (tx) => getLatestCampaignPlan(tx, orgId, campaignObjectId));

  if (!plan) {
    const properties = campaignObject.properties as Record<string, unknown>;
    const targetObjectIds = campaignTargetObjectIdsOf(properties);
    if (targetObjectIds.length === 0) return; // shouldn't happen — proposeCampaign rejects zero targets
    try {
      plan = await withTenantTx(db, orgId, (tx) =>
        compileAndPersistCampaignPlan(tx, {
          orgId,
          campaignObjectId,
          targetObjectIds,
          topologyObjectId: (properties.topologyObjectId as string | undefined) ?? null,
          topologyVersion: (properties.topologyVersion as number | undefined) ?? null
        })
      );
    } catch (err) {
      // A cycle, an unknown target, or a topology/dependency conflict. Unlike a Change (which
      // auto-cancels), a campaign has no 'cancelled' state to move to — record why and retry next
      // tick (self-heals if e.g. the offending depends_on edge is later removed).
      const message = err instanceof Error ? err.message : String(err);
      await withTenantTx(db, orgId, (tx) =>
        insertDecision(tx, {
          orgId,
          kind: "plan_diff",
          subjectId: campaignObjectId,
          verdict: "block",
          inputContext: { error: message },
          reasonTree: { summary: `campaign plan compilation failed: ${message}` }
        })
      );
      return;
    }
  }

  if (plan.status === "completed" || plan.status === "aborted") return;
  if (plan.waves.length === 0) {
    await withTenantTx(db, orgId, (tx) => markCampaignPlanCompleted(tx, orgId, plan!.id));
    return;
  }

  const activeWave = plan.waves.find((w) => w.status !== "succeeded" && w.status !== "skipped" && w.status !== "failed");
  if (!activeWave) {
    // Every wave is succeeded/skipped (a 'failed' wave would have matched above and parked here
    // instead — a campaign, like a change, never silently completes past a failed wave).
    await withTenantTx(db, orgId, (tx) => markCampaignPlanCompleted(tx, orgId, plan!.id));
    return;
  }

  if (activeWave.targets.length === 0) {
    await withTenantTx(db, orgId, (tx) => markCampaignWaveTerminal(tx, orgId, activeWave.id, "succeeded"));
    return;
  }

  if (activeWave.status === "pending" || activeWave.status === "blocked") {
    const gateOutcome = await withTenantTx(db, orgId, async (tx) => {
      const gate = await evaluateWaveGate(
        tx,
        {
          orgId,
          changeObjectId: campaignObjectId,
          actorObjectId: SYSTEM_ACTOR_ID,
          emergency: false,
          topologyObjectId: plan!.topologyObjectId,
          waveIndex: activeWave.waveIndex,
          targetObjectIds: activeWave.targets.map((t) => t.targetObjectId)
        },
        gateDeps
      );
      await insertDecision(tx, {
        orgId,
        kind: "gate",
        subjectId: campaignObjectId,
        verdict: gate.verdict,
        inputContext: { ...gate.inputContext, waveId: activeWave.id, waveIndex: activeWave.waveIndex },
        reasonTree: gate.reasonTree
      });
      if (gate.verdict === "block") {
        await markCampaignWaveBlocked(tx, orgId, activeWave.id);
        return "blocked" as const;
      }
      await markCampaignWaveRunning(tx, orgId, activeWave.id);
      return "running" as const;
    });
    if (gateOutcome === "blocked") return;
  }

  let allTerminal = true;
  let anyFailed = false;

  for (const target of activeWave.targets) {
    if (target.status === "succeeded") continue;
    if (target.status === "failed") {
      anyFailed = true;
      continue;
    }

    if (target.status === "pending") {
      allTerminal = false;
      try {
        await withTenantTx(db, orgId, async (tx) => {
          const targetObject = await tx.query.objects.findFirst({
            where: (t, { eq: eqOp, and: andOp }) => andOp(eqOp(t.orgId, orgId), eqOp(t.id, target.targetObjectId))
          });
          const { change } = await proposeChange(tx, {
            orgId,
            actorObjectId: SYSTEM_ACTOR_ID,
            requestId: "campaign-reconcile",
            name: `${campaignObject.name} / ${targetObject?.name ?? target.targetObjectId}`,
            sourceKind: "campaign",
            sourceRef: { campaignObjectId, waveIndex: activeWave.waveIndex },
            targets: [target.targetObjectId]
          });
          await createRelationship(tx, {
            orgId,
            actorObjectId: SYSTEM_ACTOR_ID,
            requestId: "campaign-reconcile",
            typeId: "coordinates",
            fromId: campaignObjectId,
            toId: change.id
          });
          await markCampaignWaveTargetProposed(tx, orgId, target.id, change.id);
        });
      } catch (err) {
        logCampaignError(orgId, campaignObjectId, `wave ${activeWave.waveIndex} target ${target.targetObjectId} propose`, err);
      }
      continue;
    }

    // 'change_proposed': poll the member Change's own (completely independent) lifecycle state.
    try {
      const state = await withTenantTx(db, orgId, async (tx) => {
        const row = await tx.query.changes.findFirst({
          where: (t, { eq: eqOp, and: andOp }) =>
            andOp(eqOp(t.orgId, orgId), eqOp(t.objectId, target.memberChangeObjectId as string))
        });
        return row?.state ?? null;
      });
      if (state === "promoted") {
        await withTenantTx(db, orgId, (tx) => markCampaignWaveTargetTerminal(tx, orgId, target.id, "succeeded"));
      } else if (state === "cancelled" || state === "rolled_back") {
        anyFailed = true;
        await withTenantTx(db, orgId, (tx) => markCampaignWaveTargetTerminal(tx, orgId, target.id, "failed"));
      } else {
        allTerminal = false; // proposed/evaluated/coordinated/executing/validating — still in flight
      }
    } catch (err) {
      allTerminal = false;
      logCampaignError(orgId, campaignObjectId, `wave ${activeWave.waveIndex} target ${target.targetObjectId} poll`, err);
    }
  }

  if (!allTerminal) return;
  await withTenantTx(db, orgId, (tx) => markCampaignWaveTerminal(tx, orgId, activeWave.id, anyFailed ? "failed" : "succeeded"));
}

/** One org's campaign-reconciliation pass — called from `coordination/reconcile.ts`'s
 *  `reconcileOrgTick`, right alongside the change-advancement steps, so campaigns and their member
 *  changes progress on the SAME 1s tick rather than a separate schedule. */
export async function reconcileCampaignsOrgTick(db: Db, orgId: string, host: PluginHost, sandbox: CelSandbox): Promise<void> {
  const rows = await withTenantTx(db, orgId, (tx) => listActiveCampaignObjectIds(tx, orgId, BATCH_LIMIT));
  for (const campaignObject of rows) {
    try {
      await reconcileOneCampaign(db, orgId, campaignObject, host, sandbox);
    } catch (err) {
      logCampaignError(orgId, campaignObject.id, "reconcile", err);
    }
  }
}

/** Every org, one `reconcileCampaignsOrgTick` each — the campaign-scoped sibling of
 *  `reconcile.ts`'s `runReconcileSweep`, kept separate only because it needs its own org-list
 *  query; wired into the same sweep, not a second pg-boss job. */
export async function runCampaignReconcileSweep(db: Db, host: PluginHost, sandbox: CelSandbox): Promise<void> {
  const orgRows = await db.select({ id: orgs.id }).from(orgs);
  for (const org of orgRows) {
    try {
      await reconcileCampaignsOrgTick(db, org.id, host, sandbox);
    } catch (err) {
      console.error(`[campaign-reconcile] org ${org.id} tick failed:`, err);
    }
  }
}
