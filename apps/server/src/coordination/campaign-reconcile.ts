import type { Db } from "../db/client.js";
import { and, eq } from "drizzle-orm";
import { objects, orgs } from "../db/schema.js";
import { withTenantTx } from "../db/tenant-tx.js";
import type { PluginHost } from "../plugin-host/contract.js";
import type { CelSandbox } from "../governance/cel-sandbox.js";
import { badRequest, describeError } from "../errors.js";
import { getObjectByIdOrUrnAnyType, updateObject } from "../graph/objects-repo.js";
import type { GateDeps } from "./gates.js";
import { evaluateWaveGate } from "./gates.js";
import { insertDecisionIfChanged } from "./decisions-repo.js";
import { proposeChange, typeOf } from "./changes-repo.js";
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
 *    `validating->accepted` gate via the ordinary `coordination/reconcile.ts` loop once proposed.
 *  - `coordination/changes-repo.ts`'s `proposeChange` — a campaign wave target's "unit of work" IS
 *    a real M3 Change, created exactly the way `POST /changes` creates one, then left to the
 *    ordinary (unmodified) change reconciliation loop to drive to `accepted`.
 *
 * One campaign wave is "active" at a time (mirrors `reconcile.ts`'s `advanceExecutingChanges`):
 * the first wave not yet `succeeded`/`skipped`. A `blocked` wave is retried every tick — exactly
 * like a change's own blocked wave gate — so an operator satisfying the blocking policy/control (an
 * approval, a freeze override, a control re-run) unblocks it on the very next tick with no separate
 * "unblock" action needed. A `failed` wave is deliberately INCLUDED by that finder (it is not
 * terminal-and-done, it is terminal-and-stuck): it becomes the active wave and PARKS, which is what
 * stops a later wave from ever being proposed past it — see the `activeWave.status === "failed"`
 * branch below, the campaign-scoped mirror of `reconcile.ts`'s own failed-wave branch.
 */
const BATCH_LIMIT = 25;

function logCampaignError(
  orgId: string,
  campaignObjectId: string,
  step: string,
  err: unknown
): void {
  console.error(
    `[campaign-reconcile] org ${orgId} campaign ${campaignObjectId} ${step} failed (will retry next tick):`,
    err
  );
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

  let plan = await withTenantTx(db, orgId, (tx) =>
    getLatestCampaignPlan(tx, orgId, campaignObjectId)
  );

  if (!plan) {
    const properties = campaignObject.properties as Record<string, unknown>;
    const rawTargets = campaignTargetObjectIdsOf(properties);
    if (rawTargets.length === 0) return; // shouldn't happen — proposeCampaign rejects zero targets
    try {
      plan = await withTenantTx(db, orgId, async (tx) => {
        // `properties.targets`/`properties.topologyObjectId` are ALREADY resolved real object ids
        // for an API-created campaign (proposeCampaign resolves idOrUrn at creation time — same as
        // changes-repo.ts's proposeChange), but NOT necessarily for an IaC-authored one: IaC apply
        // (iac/plans-repo.ts) persists a manifest's declared `properties` verbatim, and a
        // manifest can legitimately declare a URN there (@scp/iac's Campaign/ReleaseTopology
        // constructs only ever have a deterministically-derived URN at pure/offline synth time,
        // never a real database id). Re-resolving here — idempotently a no-op for an already-real
        // id, via the same getObjectByIdOrUrnAnyType every other idOrUrn-accepting write path uses
        // — makes campaign target/topology resolution creation-path-agnostic, so an IaC-authored
        // campaign's implicit depends_on-based wave auto-sequencing (compileAndPersistCampaignPlan's
        // loadDependsOnEdges, which queries relationships by real id) works exactly like an
        // API-created campaign's does, instead of silently no-oping on URN-shaped target strings.
        const targetObjectIds: string[] = [];
        for (const idOrUrn of rawTargets) {
          const target = await getObjectByIdOrUrnAnyType(tx, orgId, idOrUrn);
          targetObjectIds.push(target.id);
        }
        const rawTopology = properties.topologyObjectId;
        let topologyObjectId: string | null = null;
        let topologyVersion: number | null = null;
        if (typeof rawTopology === "string") {
          const topology = await getObjectByIdOrUrnAnyType(tx, orgId, rawTopology);
          if (topology.typeId !== "release-topology") {
            throw badRequest(`'${rawTopology}' is not a release-topology object`);
          }
          topologyObjectId = topology.id;
          topologyVersion = topology.version;
        }

        // Normalize the campaign's OWN stored properties to the resolved real ids — a no-op write
        // for an API-created campaign (proposeCampaign already stored real ids), but load-bearing
        // for an IaC-authored one: without this, `GET /campaigns/{id}` would keep echoing back
        // whatever URNs the manifest declared forever (CampaignSchema.targets is `z.string().uuid()`
        // — a URN would fail response validation), and every OTHER reconcile tick would silently
        // repeat this same resolution work indefinitely instead of doing it once.
        const targetsChanged =
          targetObjectIds.length !== rawTargets.length ||
          targetObjectIds.some((id, i) => id !== rawTargets[i]);
        const topologyChanged = topologyObjectId !== null && topologyObjectId !== rawTopology;
        if (targetsChanged || topologyChanged) {
          await updateObject(tx, {
            orgId,
            typeId: "campaign",
            actorObjectId: SYSTEM_ACTOR_ID,
            requestId: "campaign-reconcile",
            idOrUrn: campaignObjectId,
            properties: {
              ...properties,
              targets: targetObjectIds,
              ...(topologyObjectId !== null ? { topologyObjectId, topologyVersion } : {})
            }
          });
        }

        return compileAndPersistCampaignPlan(tx, {
          orgId,
          campaignObjectId,
          targetObjectIds,
          topologyObjectId,
          topologyVersion
        });
      });
    } catch (err) {
      // A cycle, an unknown target, or a topology/dependency conflict. Unlike a Change (which
      // auto-cancels), a campaign has no 'cancelled' state to move to — record why and retry next
      // tick (self-heals if e.g. the offending depends_on edge is later removed).
      //
      // PERSIST-ON-CHANGE (`decisions-repo.ts`'s `insertDecisionIfChanged`): "retry next tick"
      // means a PERMANENT compile fault — a cycle, a deleted target — re-fails identically 43,200
      // times a day, and this wrote one row for each. The retry itself is unchanged (the
      // self-healing above depends on it); only the identical restatement is suppressed. A
      // DIFFERENT error message is a different fault and still writes, so the record always shows
      // what is currently wrong.
      //
      // ...WHICH IS EXACTLY WHY THIS USES `describeError` AND NOT `err.message`. Everything thrown
      // in the block above is a `ProblemError`: `getObjectByIdOrUrnAnyType` throws `notFound`, the
      // topology check throws `badRequest`, `compileAndPersistCampaignPlan` throws `notFound`/
      // `badRequest` via `plan-service.ts`. Their `message` is the bare HTTP TITLE — an
      // unresolvable target and a non-release-topology `topologyObjectId` record as "Not Found" and
      // "Bad Request", naming neither the object nor the reason. Worse, post-dedupe TWO DIFFERENT
      // unresolvable targets both collapse to `{ error: "Not Found" }`, so the second is suppressed
      // as a restatement and the operator keeps reading a Decision about the wrong fault. `detail`
      // is what makes different faults look different (see `errors.ts`'s `describeError`).
      const message = describeError(err);
      await withTenantTx(db, orgId, (tx) =>
        insertDecisionIfChanged(tx, {
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

  // Deliberately does NOT exclude 'failed' — byte-for-byte the same predicate as the change-side
  // finder in `reconcile.ts` (`advanceExecutingChanges`), for the same reason: a failed wave must
  // still MATCH, so it becomes the active wave and parks in the branch below instead of the search
  // sliding past it to a later wave.
  const activeWave = plan.waves.find((w) => w.status !== "succeeded" && w.status !== "skipped");
  if (!activeWave) {
    // Every wave is succeeded/skipped — the ONLY shape that completes a campaign. A 'failed' wave
    // matches the finder above and parks below, so this is unreachable past a failed wave: a
    // campaign, like a change, never silently completes past a failed wave.
    await withTenantTx(db, orgId, (tx) => markCampaignPlanCompleted(tx, orgId, plan!.id));
    return;
  }

  if (activeWave.status === "failed") {
    // PARK — the campaign-scoped equivalent of the change side's `markChangeReconcileBlocked`
    // (`reconcile.ts`'s `activeWave.status === "failed"` branch). A campaign has no
    // transition-guarded state machine and no stored status column of its own to move (schema.ts's
    // M5 section doc / campaign-status.ts's module doc), and `campaign_plans.status` supports only
    // active|completed|aborted (drizzle/0011_campaigns.sql) — 'completed' would be an outright lie,
    // and 'aborted' is read (above) but never written by any code path, so there is no abort
    // semantics to borrow. The park is therefore: leave the plan `active` and simply stop
    // advancing. That is sufficient AND is the whole safety property — the later waves' member
    // Changes are only ever proposed from the loop below, which this return never reaches, so
    // nothing ships past the failure. What an operator sees is unaffected: `getCampaignStatus`
    // already derives `failed` from this wave's own status (campaign-status.ts), and campaign
    // rollback stays available regardless of forward state (campaign-rollback.ts). Leaving the plan
    // `active` (rather than closing it out) is also what keeps a later human-driven rollback of the
    // already-accepted earlier waves reconciling normally.
    return;
  }

  if (activeWave.targets.length === 0) {
    await withTenantTx(db, orgId, (tx) =>
      markCampaignWaveTerminal(tx, orgId, activeWave.id, "succeeded")
    );
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
      // PERSIST-ON-CHANGE — the same guard the change-side wave gate uses, and needed here MORE,
      // not less: this branch deliberately RE-INCLUDES `blocked` in its guard (so an operator
      // satisfying the policy unblocks the campaign on the next tick), which means
      // `markCampaignWaveBlocked` does NOT stop re-evaluation the way `markWaveRunning` stops it on
      // the allow path. A campaign parked on an approval therefore re-evaluated — and, before this,
      // re-WROTE — its unchanged block verdict once per 1 s tick, forever. Prod carries 0 of these
      // rows only because `campaign_plans` is currently empty; the shape is identical to the
      // measured 1.44 GB/day change-side flood (`decisions-repo.ts`'s `insertDecisionIfChanged`).
      // Evaluation cadence is untouched; only the identical restatement is suppressed.
      const recorded = await insertDecisionIfChanged(tx, {
        orgId,
        kind: "gate",
        subjectId: campaignObjectId,
        verdict: gate.verdict,
        inputContext: {
          ...gate.inputContext,
          waveId: activeWave.id,
          waveIndex: activeWave.waveIndex
        },
        reasonTree: gate.reasonTree
      });
      if (gate.verdict === "block") {
        // Still marked blocked every tick (an idempotent status write, not an append) so
        // `getCampaignStatus` keeps reporting the truth, and the outcome still carries a resolvable
        // `decision_id` — the FIRST block's row when this tick merely restated it. `firstBlock`
        // carries `insertDecisionIfChanged`'s `created` flag so the log line below fires once per
        // distinct block rather than once per 1 s tick (see reconcile.ts's twin).
        await markCampaignWaveBlocked(tx, orgId, activeWave.id);
        return {
          kind: "blocked",
          decisionId: recorded.decision.id,
          firstBlock: recorded.created
        } as const;
      }
      await markCampaignWaveRunning(tx, orgId, activeWave.id);
      return { kind: "running" } as const;
    });
    if (gateOutcome.kind === "blocked") {
      // SURFACE the standing block's id — once, on the tick that persisted it. It was previously
      // returned and read by nobody but the `=== "blocked"` test on the next line.
      if (gateOutcome.firstBlock) {
        console.info(
          `[campaign-reconcile] org ${orgId} campaign ${campaignObjectId} wave ${activeWave.waveIndex} blocked by governance — decision ${gateOutcome.decisionId} (scp decision get ${gateOutcome.decisionId}); re-evaluated every tick until it clears`
        );
      }
      return;
    }
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
            where: (t, { eq: eqOp, and: andOp }) =>
              andOp(eqOp(t.orgId, orgId), eqOp(t.id, target.targetObjectId))
          });
          const { change } = await proposeChange(tx, {
            orgId,
            actorObjectId: SYSTEM_ACTOR_ID,
            requestId: "campaign-reconcile",
            name: `${campaignObject.name} / ${targetObject?.name ?? target.targetObjectId}`,
            sourceKind: "campaign",
            sourceRef: { campaignObjectId, waveIndex: activeWave.waveIndex },
            targets: [target.targetObjectId],
            // Every change a campaign fans out rolls the CAMPAIGN's pipeline (M12 P4A / ADR-0007) —
            // one intent, many targets. Without this an `infrastructure` campaign would trigger each
            // target's `configuration` binding: the wrong pipeline, an actively wrong release.
            type: typeOf(campaignObject.properties as Record<string, unknown> | undefined)
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
        logCampaignError(
          orgId,
          campaignObjectId,
          `wave ${activeWave.waveIndex} target ${target.targetObjectId} propose`,
          err
        );
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
      if (state === "accepted") {
        await withTenantTx(db, orgId, (tx) =>
          markCampaignWaveTargetTerminal(tx, orgId, target.id, "succeeded")
        );
      } else if (state === "cancelled" || state === "rolled_back") {
        anyFailed = true;
        await withTenantTx(db, orgId, (tx) =>
          markCampaignWaveTargetTerminal(tx, orgId, target.id, "failed")
        );
      } else {
        allTerminal = false; // proposed/evaluated/coordinated/waiting/executing/validating — still in flight
      }
    } catch (err) {
      allTerminal = false;
      logCampaignError(
        orgId,
        campaignObjectId,
        `wave ${activeWave.waveIndex} target ${target.targetObjectId} poll`,
        err
      );
    }
  }

  if (!allTerminal) return;
  await withTenantTx(db, orgId, (tx) =>
    markCampaignWaveTerminal(tx, orgId, activeWave.id, anyFailed ? "failed" : "succeeded")
  );
}

/** One org's campaign-reconciliation pass — called from `coordination/reconcile.ts`'s
 *  `reconcileOrgTick`, right alongside the change-advancement steps, so campaigns and their member
 *  changes progress on the SAME 1s tick rather than a separate schedule. */
export async function reconcileCampaignsOrgTick(
  db: Db,
  orgId: string,
  host: PluginHost,
  sandbox: CelSandbox
): Promise<void> {
  const rows = await withTenantTx(db, orgId, (tx) =>
    listActiveCampaignObjectIds(tx, orgId, BATCH_LIMIT)
  );
  for (const campaignObject of rows) {
    try {
      await reconcileOneCampaign(db, orgId, campaignObject, host, sandbox);
    } catch (err) {
      logCampaignError(orgId, campaignObject.id, "reconcile", err);
    }
    // ROUND-ROBIN BUMP — the FOURTH instance of the starvation class, found by censusing the
    // PROPERTY ("a batch-limited, `updated_at`-ordered candidate loop that can re-serve a row
    // without writing it") rather than by hitting the symptom. See `reconcile.ts`'s
    // `advanceExecutingChanges`, which is the instance that stopped production coordination for 13
    // days, and `advanceWaitingChanges`, where the hazard was first found and fixed.
    //
    // WHY THIS LOOP QUALIFIES: `listActiveCampaignObjectIds` is `ORDER BY objects.updated_at ASC
    // LIMIT 25`, and NOTHING in `reconcileOneCampaign` ever writes the campaign's `objects` row —
    // its writes all land on `campaign_plans` / `campaign_waves` / `campaign_wave_targets`. So a
    // campaign whose wave gate is `blocked` (a branch that deliberately keeps re-evaluating, so an
    // operator clearing the block is noticed) freezes its `updated_at` forever, and 25 of them
    // starve every campaign behind them. A campaign that is merely PROGRESSING freezes it too.
    //
    // Bumped unconditionally, for every campaign examined, because the requirement is "took its
    // turn", not "made progress". Unlike the change-side loops there is no cheap in-loop signal for
    // which of the two happened, and bumping both is correct for fairness either way.
    //
    // STILL REQUIRED AFTER THE ACTIVE-FILTER FIX, and it is worth being explicit about why, because
    // the filter looks like it makes this redundant and does not. `listActiveCampaignObjectIds` now
    // excludes campaigns whose LATEST plan is terminal, which removes the *finished* campaigns from
    // the batch — but the starvation case was never those. It is a campaign that is legitimately
    // ACTIVE and blocked (or merely progressing) while writing nothing to its `objects` row. The
    // filter shrinks the candidate set; only the bump makes the set ROTATE.
    //
    // NOT YET BITING: the homelab holds 0 campaigns. Fixed before it can, because this class has
    // now cost real production downtime once and its symptom (silence) is indistinguishable from
    // "nothing to do".
    await withTenantTx(db, orgId, (tx) =>
      tx
        .update(objects)
        .set({ updatedAt: new Date() })
        .where(and(eq(objects.orgId, orgId), eq(objects.id, campaignObject.id)))
    ).catch((err) => logCampaignError(orgId, campaignObject.id, "round-robin-bump", err));
  }
}

/** Every org, one `reconcileCampaignsOrgTick` each — the campaign-scoped sibling of
 *  `reconcile.ts`'s `runReconcileSweep`, kept separate only because it needs its own org-list
 *  query; wired into the same sweep, not a second pg-boss job. */
export async function runCampaignReconcileSweep(
  db: Db,
  host: PluginHost,
  sandbox: CelSandbox
): Promise<void> {
  const orgRows = await db.select({ id: orgs.id }).from(orgs);
  for (const org of orgRows) {
    try {
      await reconcileCampaignsOrgTick(db, org.id, host, sandbox);
    } catch (err) {
      console.error(`[campaign-reconcile] org ${org.id} tick failed:`, err);
    }
  }
}
