import type { Db } from "../db/client.js";
import type { CampaignDeadline, TrustDomainId } from "@scp/schemas";
import { CAMPAIGN_RECIPE_PROPERTY_KEY } from "@scp/schemas";
import { and, eq } from "drizzle-orm";
import { objects } from "../db/schema.js";
import { withTenantTx } from "../db/tenant-tx.js";
import type { PluginHost } from "../plugin-host/contract.js";
import type { CelSandbox } from "../governance/cel-sandbox.js";
import { badRequest, describeError } from "../errors.js";
import { getObjectByIdOrUrnAnyType, updateObject } from "../graph/objects-repo.js";
import type { GateDeps } from "./gates.js";
import { evaluateWaveGate } from "./gates.js";
import {
  insertDecision,
  insertDecisionIfChanged,
  latestDecisionForSubjectKind
} from "./decisions-repo.js";
import {
  describeFreezeHold,
  describeHeldTargets,
  evaluateFreezeHolds,
  type FreezeHoldVerdict
} from "./freeze-hold.js";
import { proposeChange, typeOf } from "./changes-repo.js";
import { createRelationship } from "../graph/relationships-repo.js";
import { SYSTEM_ACTOR_ID } from "./system-actor.js";
import { appendAuditEvent } from "../audit/audit-repo.js";
import {
  DEAD_TARGET_REMEDIATION,
  deadTargetInputContext,
  describeDeadTarget,
  readTargetLiveness,
  WAVE_TARGET_TOMBSTONED_AUDIT_ACTION
} from "./target-liveness.js";
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
import { tryAcquireCampaignCoordinationLock } from "./campaign-coordination-lock.js";
import { resolveChangeRecipe } from "./campaign-recipe.js";
import {
  markCampaignWaveBlocked,
  markCampaignWaveRunning,
  markCampaignWaveTargetProposed,
  markCampaignWaveTargetTerminal,
  markCampaignWaveTerminal,
  terminalizeAdoptedCampaignWaveTarget,
  terminalizeRefusedCampaignWaveTarget
} from "./campaign-wave-targets-repo.js";
import {
  CAMPAIGN_ADOPTION_AUDIT_ACTION,
  CAMPAIGN_ADOPTION_DECISION_KIND,
  evaluateCampaignAdoption
} from "./campaign-adoption.js";
import {
  CAMPAIGN_DEADLINE_DECISION_KIND,
  CAMPAIGN_DEADLINE_LOCK_AUDIT_ACTION,
  describeCampaignDeadlineLock,
  describeLockedTargets,
  evaluateCampaignDeadlineLock,
  resolveCampaignDeadline,
  type CampaignDeadlineLockVerdict
} from "./campaign-deadline-lock.js";

/** The campaign reconciler. See docs/coordination.md §165. */
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

/** ONE CAMPAIGN'S UNIT OF WORK. See docs/coordination.md §166. */
async function reconcileOneCampaign(
  db: Db,
  orgId: string,
  staleCampaignObject: ObjectRow,
  host: PluginHost,
  sandbox: CelSandbox,
  selfDomainId: TrustDomainId,
  /** THE TICK'S CLOCK, resolved ONCE by `reconcileCampaignsOrgTick` for the WHOLE batch and threaded
   *  down — see that function. Never re-read here: two campaigns straddling the same deadline
   *  instant, evaluated 40 ms apart inside one tick, must not disagree about whether it has passed. */
  now: Date
): Promise<void> {
  const gateDeps: GateDeps = { sandbox, host };
  const campaignObjectId = staleCampaignObject.id;

  const campaignObject = await withTenantTx(db, orgId, (tx) =>
    tx.query.objects.findFirst({
      where: (t, { eq: eqOp, and: andOp, isNull: isNullOp }) =>
        andOp(
          eqOp(t.orgId, orgId),
          eqOp(t.id, campaignObjectId),
          eqOp(t.typeId, "campaign"),
          eqOp(t.originDomainId, selfDomainId),
          isNullOp(t.deletedAt)
        )
    })
  );
  if (!campaignObject) return;

  let plan = await withTenantTx(db, orgId, (tx) =>
    getLatestCampaignPlan(tx, orgId, campaignObjectId)
  );

  if (!plan) {
    const properties = campaignObject.properties as Record<string, unknown>;
    const rawTargets = campaignTargetObjectIdsOf(properties);
    if (rawTargets.length === 0) return;
    try {
      plan = await withTenantTx(db, orgId, async (tx) => {
        // Already resolved object ids for an API campaign. See docs/coordination.md §167.
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

        // Normalize stored properties to resolved real ids. See docs/coordination.md §168.
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
      // A campaign parks on a compile fault; it does not cancel. See docs/coordination.md §169.
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
    // Park: the campaign-scoped equivalent of blocking a change. See docs/coordination.md §170.
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
          targetObjectIds: activeWave.targets.map((t) => t.targetObjectId),
          // EXPLICIT, not defaulted (M25.2 / D7): a campaign is never itself a rollback. Campaign
          // rollback (`campaign-rollback.ts`) mints a per-member rollback CHANGE, and each of those
          // carries the flag on its own wave, where the exemption belongs.
          isRollback: false
        },
        gateDeps
      );
      // Persist-on-change, needed here more, not less. See docs/coordination.md §171.
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
        // Still marked blocked every tick. See docs/coordination.md §172.
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

  /** THE FREEZE HOLD, CAMPAIGN SIDE. See docs/coordination.md §173. */
  let campaignFreezeHolds: Map<string, FreezeHoldVerdict> | undefined;
  const loadCampaignFreezeHolds = async (): Promise<Map<string, FreezeHoldVerdict>> =>
    (campaignFreezeHolds ??= await withTenantTx(db, orgId, (tx) =>
      evaluateFreezeHolds(tx, {
        orgId,
        targetObjectIds: activeWave.targets.map((t) => t.targetObjectId)
      })
    ));
  /** The campaign's recipe, resolved once per tick. See docs/coordination.md §174. */
  const campaignRecipe = resolveChangeRecipe(
    campaignObject.properties as Record<string, unknown> | null
  );
  if (campaignRecipe.outcome === "malformed") {
    logCampaignError(
      orgId,
      campaignObjectId,
      "recipe",
      new Error(
        `campaign properties.recipe is unreadable (${campaignRecipe.detail}) — every member change ` +
          `this campaign fans out will roll its target's DEFAULT pipeline with no recipe parameters`
      )
    );
  }
  const recipeProperties: Record<string, unknown> =
    campaignRecipe.outcome === "recipe"
      ? { [CAMPAIGN_RECIPE_PROPERTY_KEY]: campaignRecipe.recipe }
      : {};
  /** The same parsed recipe, hoisted for the adoption seam. See docs/coordination.md §175. */
  const adoptionRecipe = campaignRecipe.outcome === "recipe" ? campaignRecipe.recipe : undefined;

  /** The deadline, resolved once per tick beside the recipe. See docs/coordination.md §176. */
  const campaignDeadline = resolveCampaignDeadline(
    campaignObject.properties as Record<string, unknown> | null
  );
  if (campaignDeadline.outcome === "malformed") {
    await recordUnreadableCampaignDeadline(db, orgId, campaignObjectId, campaignDeadline.detail);
  }

  /** Every target this tick an active freeze covered — one Decision for the campaign, never one per
   *  target (`insertDecisionIfChanged` dedupes on the LATEST row of a `(subject_id, kind)`, so
   *  per-target rows would alternate and suppression would never fire). */
  const frozenTargets: FreezeHoldVerdict[] = [];
  /** Every target this tick the campaign's own deadline withheld fan-out from. One Decision per
   *  CAMPAIGN, never one per target, for the identical dedup reason as `frozenTargets`. */
  const deadlineLockedTargets: CampaignDeadlineLockVerdict[] = [];
  /** Did any target of this wave get past the freeze seam on this tick? The release condition for
   *  the hold Decision below. */
  let anyTargetFannedOut = false;

  for (const target of activeWave.targets) {
    if (target.status === "succeeded") continue;
    if (target.status === "failed") {
      anyFailed = true;
      continue;
    }

    if (target.status === "pending") {
      allTerminal = false;
      // IS THE TARGET OBJECT STILL THERE? See docs/coordination.md §177.
      const liveness = await withTenantTx(db, orgId, (tx) =>
        readTargetLiveness(tx, orgId, target.targetObjectId)
      ).catch((err) => {
        logCampaignError(
          orgId,
          campaignObjectId,
          `wave ${activeWave.waveIndex} target ${target.targetObjectId} liveness`,
          err
        );
        return undefined; // unreadable — NOT "deleted". Retried next tick, nothing terminalized.
      });
      if (liveness && !liveness.live) {
        try {
          await withTenantTx(db, orgId, async (tx) => {
            // Guarded + RETURNING, so the Decision and the audit event are appended exactly once
            // even though this branch is reached on every tick until the wave terminalizes.
            const terminalized = await terminalizeRefusedCampaignWaveTarget(tx, orgId, target.id);
            if (!terminalized) return;
            const summary = describeDeadTarget(target.targetObjectId, liveness);
            const decision = await insertDecision(tx, {
              orgId,
              kind: "wave_target",
              subjectId: campaignObjectId,
              verdict: "block",
              inputContext: {
                waveId: activeWave.id,
                waveIndex: activeWave.waveIndex,
                ...deadTargetInputContext(target.targetObjectId, liveness)
              },
              reasonTree: { summary, remediation: DEAD_TARGET_REMEDIATION }
            });
            await appendAuditEvent(tx, {
              orgId,
              actorId: SYSTEM_ACTOR_ID,
              action: WAVE_TARGET_TOMBSTONED_AUDIT_ACTION,
              subjectId: campaignObjectId,
              reason: summary,
              decisionId: decision.id,
              requestId: "campaign-reconcile"
            });
          });
        } catch (err) {
          logCampaignError(
            orgId,
            campaignObjectId,
            `wave ${activeWave.waveIndex} target ${target.targetObjectId} refuse`,
            err
          );
        }
        anyFailed = true;
        continue;
      }

      // THE FREEZE HOLD. See docs/coordination.md §178.
      const frozen = (await loadCampaignFreezeHolds()).get(target.targetObjectId);
      if (frozen) {
        frozenTargets.push(frozen);
        continue;
      }

      // THE ADOPTION SEAM. See docs/coordination.md §179.
      if (adoptionRecipe?.adoption !== undefined) {
        const adopted = await withTenantTx(db, orgId, async (tx) => {
          const adoption = await evaluateCampaignAdoption(
            tx,
            orgId,
            campaignObjectId,
            target.targetObjectId,
            adoptionRecipe
          );
          // ONLY `adopted` acts. `not_adopted` and `unknown` both fan out — an unknown verdict is an
          // absence of evidence and must never be treated as adoption (R3). This asymmetry is the
          // feature's safety property in one line.
          if (adoption.verdict !== "adopted") return false;

          // The guard makes the Decision + audit pair fire exactly once per target, ever, however
          // many ticks arrive — the same shape as the liveness gate's refusal directly above.
          const terminalized = await terminalizeAdoptedCampaignWaveTarget(tx, orgId, target.id);
          if (!terminalized) return true;

          // Belt and braces: guard bounds it, dedupe backs it. See docs/coordination.md §180.
          const recorded = await insertDecisionIfChanged(tx, {
            orgId,
            kind: CAMPAIGN_ADOPTION_DECISION_KIND,
            subjectId: campaignObjectId,
            // `allow` rather than `block`/`hold`: nothing is being withheld from anyone. The campaign
            // is recording that this target needed no work. `latestBlockDecisionForSubject` filters
            // on the verdict alone, so a `block` here would leave a campaign looking permanently
            // blocked by its own good news.
            verdict: "allow",
            inputContext: {
              ...adoption.inputContext,
              waveId: activeWave.id,
              waveIndex: activeWave.waveIndex
            },
            reasonTree: {
              summary: `no member change proposed for this campaign target: ${adoption.summary}`,
              // Echoed under its own key as well as inside `inputContext` so `scp campaign explain`
              // shows the evidence beside the sentence it justifies. Already sorted and bounded by
              // the predicate; re-sorting here would be a second ordering rule to keep in step.
              observations: adoption.observations
            }
          });
          if (recorded.created) {
            await appendAuditEvent(tx, {
              orgId,
              actorId: SYSTEM_ACTOR_ID,
              action: CAMPAIGN_ADOPTION_AUDIT_ACTION,
              subjectId: campaignObjectId,
              reason: `campaign target ${target.targetObjectId} was already migrated: ${adoption.summary}`,
              decisionId: recorded.decision.id,
              requestId: "campaign-reconcile"
            });
          }
          return true;
        }).catch((err) => {
          logCampaignError(
            orgId,
            campaignObjectId,
            `wave ${activeWave.waveIndex} target ${target.targetObjectId} adoption`,
            err
          );
          return false; // unreadable — NOT "adopted". Fanned out normally, retried next tick.
        });
        if (adopted) continue;
      }

      // THE DEADLINE LOCK. See docs/coordination.md §181.
      if (campaignDeadline.outcome === "deadline") {
        const lock = await withTenantTx(db, orgId, (tx) =>
          evaluateCampaignDeadlineLock(tx, {
            orgId,
            campaignObjectId,
            targetObjectIds: [target.targetObjectId],
            deadline: campaignDeadline.deadline,
            at: campaignDeadline.at,
            recipe: adoptionRecipe,
            // THE TICK'S CLOCK, threaded from `reconcileCampaignsOrgTick` — never `new Date()`.
            now
          })
        ).catch((err) => {
          logCampaignError(
            orgId,
            campaignObjectId,
            `wave ${activeWave.waveIndex} target ${target.targetObjectId} deadline`,
            err
          );
          // UNREADABLE IS NOT LOCKED. A database blip must never withhold a campaign's fan-out: the
          // fail-open direction this whole mechanism is built on, applied to the transient case as
          // well as to the malformed one.
          return undefined;
        });
        const locked = lock?.locked[0];
        if (locked) {
          deadlineLockedTargets.push(locked);
          continue; // <- THE REFUSAL
        }
      }

      // Set BEFORE `proposeChange` for the same reason the change side sets its flag before
      // `triggerWaveTarget`: this target was NOT held on this tick, which is the observation the
      // release row records. A `proposeChange` that then throws is retried next tick and the
      // release is idempotent.
      anyTargetFannedOut = true;

      try {
        await withTenantTx(db, orgId, async (tx) => {
          const targetObject = await tx.query.objects.findFirst({
            where: (t, { eq: eqOp, and: andOp, isNull: isNullOp }) =>
              andOp(
                eqOp(t.orgId, orgId),
                eqOp(t.id, target.targetObjectId),
                // Live-filtered like every other read of this object. It only supplies a display
                // name, but a name read off a tombstone is still a tombstone being read as present.
                isNullOp(t.deletedAt)
              )
          });
          const { change } = await proposeChange(tx, {
            orgId,
            actorObjectId: SYSTEM_ACTOR_ID,
            requestId: "campaign-reconcile",
            name: `${campaignObject.name} / ${targetObject?.name ?? target.targetObjectId}`,
            sourceKind: "campaign",
            sourceRef: { campaignObjectId, waveIndex: activeWave.waveIndex },
            targets: [target.targetObjectId],
            // M25.4 — THE RECIPE, COPIED ONTO THE MEMBER CHANGE. See docs/coordination.md §182.
            properties: recipeProperties,
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

  if (deadlineLockedTargets.length > 0 && campaignDeadline.outcome === "deadline") {
    await recordCampaignDeadlineLock(
      db,
      orgId,
      campaignObjectId,
      activeWave,
      campaignDeadline.deadline,
      deadlineLockedTargets
    );
  }

  if (frozenTargets.length > 0) {
    await recordCampaignFreezeAdmissionHold(db, orgId, campaignObjectId, activeWave, frozenTargets);
  } else if (anyTargetFannedOut) {
    // HOLD -> RELEASE. See docs/coordination.md §183.
    await clearCampaignFreezeAdmissionHold(db, orgId, campaignObjectId, activeWave);
  }

  if (!allTerminal) return;
  await withTenantTx(db, orgId, (tx) =>
    markCampaignWaveTerminal(tx, orgId, activeWave.id, anyFailed ? "failed" : "succeeded")
  );
}

/** THE EXPLAINABILITY HALF OF THE CAMPAIGN-SIDE FREEZE HOLD. See docs/coordination.md §184. */
/** The campaign-side HOLD -> RELEASE row. See docs/coordination.md §185. */
async function clearCampaignFreezeAdmissionHold(
  db: Db,
  orgId: string,
  campaignObjectId: string,
  activeWave: { id: string; waveIndex: number }
): Promise<void> {
  await withTenantTx(db, orgId, async (tx) => {
    const latest = await latestDecisionForSubjectKind(
      tx,
      orgId,
      campaignObjectId,
      "freeze_admission"
    );
    if (!latest || latest.verdict !== "hold") return;
    await insertDecisionIfChanged(tx, {
      orgId,
      kind: "freeze_admission",
      subjectId: campaignObjectId,
      verdict: "allow",
      inputContext: { waveId: activeWave.id, waveIndex: activeWave.waveIndex, held: [] },
      reasonTree: {
        summary:
          "no campaign wave target is held by a freeze any more — the window closed (or the " +
          "freeze was lifted) and fan-out has resumed",
        releases: latest.id
      }
    });
  }).catch((err) => {
    logCampaignError(orgId, campaignObjectId, `wave ${activeWave.waveIndex} freeze release`, err);
  });
}

async function recordCampaignFreezeAdmissionHold(
  db: Db,
  orgId: string,
  campaignObjectId: string,
  activeWave: { id: string; waveIndex: number },
  frozenTargets: FreezeHoldVerdict[]
): Promise<void> {
  const held = describeHeldTargets(frozenTargets);

  const recorded = await withTenantTx(db, orgId, (tx) =>
    insertDecisionIfChanged(tx, {
      orgId,
      kind: "freeze_admission",
      subjectId: campaignObjectId,
      verdict: "hold",
      inputContext: { waveId: activeWave.id, waveIndex: activeWave.waveIndex, held },
      reasonTree: {
        summary: `${held.length} campaign wave target(s) held: an active freeze covers that scope — no member change is fanned out while it stands`,
        held: frozenTargets
          .map((verdict) => describeFreezeHold(verdict))
          .sort((a, b) => a.localeCompare(b))
      }
    })
  ).catch((err) => {
    logCampaignError(orgId, campaignObjectId, `wave ${activeWave.waveIndex} freeze hold`, err);
    return undefined;
  });

  if (recorded?.created) {
    console.info(
      `[campaign-reconcile] org ${orgId} campaign ${campaignObjectId} wave ${activeWave.waveIndex}: ${held.length} target(s) held by an active freeze — decision ${recorded.decision.id} (scp decision get ${recorded.decision.id}); re-evaluated every tick until the window closes`
    );
  }
}

/** The deadline lock's Decision, the explainability half. See docs/coordination.md §186. */
async function recordCampaignDeadlineLock(
  db: Db,
  orgId: string,
  campaignObjectId: string,
  activeWave: { id: string; waveIndex: number },
  deadline: CampaignDeadline,
  lockedTargets: CampaignDeadlineLockVerdict[]
): Promise<void> {
  const locked = describeLockedTargets(lockedTargets);

  const recorded = await withTenantTx(db, orgId, async (tx) => {
    const result = await insertDecisionIfChanged(tx, {
      orgId,
      kind: CAMPAIGN_DEADLINE_DECISION_KIND,
      subjectId: campaignObjectId,
      verdict: "block",
      inputContext: {
        waveId: activeWave.id,
        waveIndex: activeWave.waveIndex,
        // THE ONLY CLOCK-SHAPED VALUE IN THIS OBJECT, and it is a stored boundary, not a reading.
        deadlineAt: deadline.at,
        locked
      },
      reasonTree: {
        summary:
          `${locked.length} campaign wave target(s) locked out by this campaign's deadline of ` +
          `${deadline.at}: no member change is proposed for a target this campaign cannot observe ` +
          `as migrated. THIS CAMPAIGN'S changes only — unrelated releases, including security ` +
          `fixes, keep flowing to these components`,
        locked: lockedTargets
          .map((verdict) => describeCampaignDeadlineLock(deadline, verdict))
          .sort((a, b) => a.localeCompare(b))
      }
    });
    if (result.created) {
      await appendAuditEvent(tx, {
        orgId,
        actorId: SYSTEM_ACTOR_ID,
        action: CAMPAIGN_DEADLINE_LOCK_AUDIT_ACTION,
        subjectId: campaignObjectId,
        reason:
          `${locked.length} target(s) missed this campaign's deadline of ${deadline.at} and are ` +
          `no longer receiving its changes: ${locked.map((l) => l.targetObjectId).join(", ")}`,
        decisionId: result.decision.id,
        requestId: "campaign-reconcile"
      });
    }
    return result;
  }).catch((err) => {
    logCampaignError(orgId, campaignObjectId, `wave ${activeWave.waveIndex} deadline lock`, err);
    return undefined;
  });

  if (recorded?.created) {
    console.info(
      `[campaign-reconcile] org ${orgId} campaign ${campaignObjectId} wave ${activeWave.waveIndex}: ${locked.length} target(s) locked out by the campaign deadline ${deadline.at} — decision ${recorded.decision.id} (scp decision get ${recorded.decision.id}); re-derived every tick, so a late adoption or a moved deadline clears it with no unlock verb`
    );
  }
}

/** THE "LOUDLY" HALF OF FAIL-OPEN. See docs/coordination.md §187. */
async function recordUnreadableCampaignDeadline(
  db: Db,
  orgId: string,
  campaignObjectId: string,
  detail: string
): Promise<void> {
  const recorded = await withTenantTx(db, orgId, (tx) =>
    insertDecisionIfChanged(tx, {
      orgId,
      kind: CAMPAIGN_DEADLINE_DECISION_KIND,
      subjectId: campaignObjectId,
      verdict: "warn",
      inputContext: { error: detail },
      reasonTree: {
        summary:
          `this campaign's properties.deadline is unreadable (${detail}) — it is withholding ` +
          `NOTHING from anybody, and every target fans out exactly as it would with no deadline ` +
          `set. A deadline is a coercion mechanism, so an unreadable one fails OPEN: failing closed ` +
          `would park the entire campaign on a typo`
      }
    })
  ).catch((err) => {
    logCampaignError(orgId, campaignObjectId, "deadline", err);
    return undefined;
  });

  if (recorded?.created) {
    console.warn(
      `[campaign-reconcile] org ${orgId} campaign ${campaignObjectId}: properties.deadline is unreadable (${detail}) — the deadline is INERT and every target fans out normally; decision ${recorded.decision.id}`
    );
  }
}

/** One org's campaign-reconciliation pass — called from `coordination/reconcile.ts`'s
 *  `reconcileOrgTick`, right alongside the change-advancement steps, so campaigns and their member
 *  changes progress on the SAME 1s tick rather than a separate schedule. */
export async function reconcileCampaignsOrgTick(
  db: Db,
  orgId: string,
  host: PluginHost,
  sandbox: CelSandbox,
  selfDomainId: TrustDomainId,
  /** M25.6a — THE TICK'S CLOCK SEAM. See docs/coordination.md §188. */
  opts: { now?: Date } = {}
): Promise<void> {
  const now = opts.now ?? new Date();
  // Single-writer, filtered in the SQL rather than in the loop. See docs/coordination.md §189.
  const rows = await withTenantTx(db, orgId, (tx) =>
    listActiveCampaignObjectIds(tx, orgId, BATCH_LIMIT, selfDomainId)
  );
  for (const campaignObject of rows) {
    // Defence in depth, and now unreachable after the SQL filter. See docs/coordination.md §190.
    if (campaignObject.originDomainId !== selfDomainId) continue;

    // Multi-replica single-flight over one campaign. See docs/coordination.md §191.
    const lock = await tryAcquireCampaignCoordinationLock(db, campaignObject.id);
    if (lock) {
      try {
        await reconcileOneCampaign(db, orgId, campaignObject, host, sandbox, selfDomainId, now);
      } catch (err) {
        logCampaignError(orgId, campaignObject.id, "reconcile", err);
      } finally {
        await lock.release();
      }
    }
    // Round-robin bump, the fourth starvation instance. See docs/coordination.md §192.
    await withTenantTx(db, orgId, (tx) =>
      tx
        .update(objects)
        .set({ updatedAt: new Date() })
        .where(and(eq(objects.orgId, orgId), eq(objects.id, campaignObject.id)))
    ).catch((err) => logCampaignError(orgId, campaignObject.id, "round-robin-bump", err));
  }
}
