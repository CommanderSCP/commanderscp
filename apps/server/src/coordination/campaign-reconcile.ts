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

/** ONE CAMPAIGN'S UNIT OF WORK. See docs/coordination/campaign-reconcile.md §1. */
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
          targetObjectIds: activeWave.targets.map((t) => t.targetObjectId),
          // EXPLICIT, not defaulted (M25.2 / D7): a campaign is never itself a rollback. Campaign
          // rollback (`campaign-rollback.ts`) mints a per-member rollback CHANGE, and each of those
          // carries the flag on its own wave, where the exemption belongs.
          isRollback: false
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

  /** THE FREEZE HOLD, CAMPAIGN SIDE. See docs/coordination/campaign-reconcile.md §2. */
  let campaignFreezeHolds: Map<string, FreezeHoldVerdict> | undefined;
  const loadCampaignFreezeHolds = async (): Promise<Map<string, FreezeHoldVerdict>> =>
    (campaignFreezeHolds ??= await withTenantTx(db, orgId, (tx) =>
      evaluateFreezeHolds(tx, {
        orgId,
        targetObjectIds: activeWave.targets.map((t) => t.targetObjectId)
      })
    ));
  /**
   * M25.4 — the campaign's own recipe, resolved ONCE per campaign per tick and copied verbatim onto
   * every member change this wave fans out (see the `proposeChange` call below for why by value).
   *
   * `{}` — not `{ recipe: undefined }` — when the campaign declares none, so `proposeChange`'s
   * property spread is byte-identical to a pre-M25.4 fan-out.
   *
   * A MALFORMED RECIPE IS NOT COPIED AND NOT SILENTLY DROPPED. It cannot normally exist — the
   * authoring guard at `graph/objects-repo.ts` refuses it on all three write doors — but a row
   * planted before that guard, or by a peer speaking a newer vocabulary, can. `resolveChangeRecipe`
   * reports `malformed` distinctly from `none`, and copying the raw bytes through would push the
   * refusal down to N member changes instead of raising it once here. The member changes are still
   * proposed (the campaign's targets are real work), and each one's own trigger path then finds no
   * recipe — which is why the warning is loud: it is the one place an operator can see that the
   * campaign fanned out WITHOUT the lever it was authored to carry.
   */
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
  /**
   * M25.5 — the SAME parsed recipe, hoisted here so the adoption seam in the per-target loop below
   * reads one document rather than re-deciding per target what `resolveChangeRecipe` already
   * decided once for the campaign.
   *
   * `undefined` covers BOTH "no recipe" and "malformed", and that second half is deliberate: a
   * document the schema refuses is not evidence of anything, so the adoption predicate is not asked
   * about it and every target of such a campaign fans out normally. The refusal is already loud —
   * the warning above is logged once per campaign per tick — and turning an unparseable document
   * into a silent `adopted` would be exactly the failure this milestone exists to refuse.
   */
  const adoptionRecipe = campaignRecipe.outcome === "recipe" ? campaignRecipe.recipe : undefined;

  /**
   * M25.6a — THE DEADLINE, resolved ONCE per campaign per tick beside the recipe, for the same
   * reason: the seam below asks about it once per target, and a document parsed per target is a
   * document that can be read two ways in one pass.
   *
   * FAIL OPEN, LOUDLY (§4.2), and the departure from `stage-dependency-hold.ts`'s fail-CLOSED
   * `undeclarable` branch is deliberate. That one guards a SAFETY coupling — dropping the hold
   * deploys a component ahead of a dependency it was declared to stand behind. A deadline is a
   * COERCION mechanism, and failing closed on an unreadable one parks an ENTIRE campaign on a typo,
   * behind a document that by definition cannot explain itself. So a malformed bag locks nothing,
   * and the `warn` Decision below is the "loudly" half: without it the operator's only signal that
   * their deadline is inert would be its silence, which is indistinguishable from never having set
   * one.
   */
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
      // IS THE TARGET OBJECT STILL THERE? See docs/coordination/campaign-reconcile.md §3.
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

      // THE FREEZE HOLD. See docs/coordination/campaign-reconcile.md §4.
      const frozen = (await loadCampaignFreezeHolds()).get(target.targetObjectId);
      if (frozen) {
        frozenTargets.push(frozen);
        continue;
      }

      // THE ADOPTION SEAM. See docs/coordination/campaign-reconcile.md §5.
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

          // `insertDecisionIfChanged` as well as the guard, belt AND braces. The guard is what
          // bounds this today; the persist-on-change wrapper is what keeps it bounded if a future
          // edit ever moves this write out from behind it. `inputContext` carries the EVIDENCE and
          // nothing clock-shaped — see `CampaignAdoptionResult.inputContext` for the named ban list
          // and the 1.44 GB/day measurement behind it.
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

      // THE DEADLINE LOCK. See docs/coordination/campaign-reconcile.md §6.
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
            // ===================================================================================
            // M25.4 — THE RECIPE, COPIED ONTO THE MEMBER CHANGE. This is the "1-click": the author
            // configured one trigger intent on the campaign, and every one of N targets now carries
            // it into its own governed change.
            // ===================================================================================
            // COPIED BY VALUE, NOT RESOLVED BY REFERENCE AT TRIGGER TIME, and the difference is
            // load-bearing three times over:
            //
            //   * IMMUTABILITY. Editing the campaign later cannot retroactively re-narrate what an
            //     already-fanned-out change did — the `control_runs.plugin_module` rule applied to
            //     the same class of question ("what did this actually run with?").
            //   * FEDERATION REACH. `promotion-repo.ts` re-proposes a promoted change LOCALLY with
            //     `properties` carried through, stripping exactly `requires` and `stageDependencies`
            //     — so a recipe on the CHANGE arrives at an outpost intact and that outpost's own
            //     reconcile resolves the OUTPOST's binding and triggers through its own local gates.
            //     A recipe left only on the campaign object would reach the outpost as an inert
            //     replica (`listActiveCampaignObjectIds` filters foreign-origin campaigns out, and
            //     that filter is correct — see `foreign-origin-campaign.integration.test.ts`).
            //   * ONE READER. `reconcile.ts`'s trigger path then needs no campaign lookup, no
            //     `coordinates`-edge walk and no second code path for "is this a member change" —
            //     it reads `change.properties` exactly as it already does for `stageDependencies`.
            //
            // ONLY WRITTEN WHEN THE CAMPAIGN DECLARES ONE, so a recipe-less campaign fans out a
            // byte-identical change to a pre-M25.4 one.
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
    // HOLD -> RELEASE (proposal §1.5), the campaign-side twin of `reconcile.ts`'s
    // `clearFreezeAdmissionHold`. Without it the newest `freeze_admission` row for a campaign that
    // was held for a fortnight still reads `hold` after the window closed and every member change
    // was minted — a historical record with no clearing counterpart, which is the exact defect
    // `routes/changes.ts` documents against ADR-0028's identical omission.
    await clearCampaignFreezeAdmissionHold(db, orgId, campaignObjectId, activeWave);
  }

  if (!allTerminal) return;
  await withTenantTx(db, orgId, (tx) =>
    markCampaignWaveTerminal(tx, orgId, activeWave.id, anyFailed ? "failed" : "succeeded")
  );
}

/**
 * THE EXPLAINABILITY HALF OF THE CAMPAIGN-SIDE FREEZE HOLD (M25.2) — the same Decision shape
 * `reconcile.ts`'s `recordFreezeAdmissionHold` writes, with the CAMPAIGN as the subject.
 *
 * Every property that file's docblock argues at length applies here unchanged and for the same
 * reasons: `kind: "freeze_admission"` distinct from `"gate"` (sharing it would make these rows and
 * the campaign wave gate's own rows alternate under `insertDecisionIfChanged`'s
 * latest-row-per-`(subject_id, kind)` comparison, and suppression would never fire);
 * `verdict: "hold"` and never `"block"` (`latestBlockDecisionForSubject` filters on the verdict
 * ALONE and nothing writes a clearing row); ONE row per campaign rather than per target; and
 * `endsAt` in the context with the clock deliberately absent, which is what makes a fortnight-long
 * hold one row instead of 1.2 million.
 *
 * NO CURSOR BUMP, unlike the change side, and the asymmetry is checked rather than assumed:
 * `reconcileCampaignsOrgTick` bumps `objects.updated_at` unconditionally for every locally-owned
 * campaign it examines, below its S10 guard. `candidate-loop-registry.test.ts` records that as this
 * loop's one bump.
 */
/**
 * The campaign-side HOLD -> RELEASE row (proposal §1.5). Three guards, identical to
 * `reconcile.ts`'s `clearFreezeAdmissionHold`: reached only on a tick with nothing held and
 * something fanned out; returns unless the newest `(campaign, freeze_admission)` row is a `hold`;
 * and written through `insertDecisionIfChanged` regardless. Best-effort — failing to record that a
 * hold released must not fail the tick that released it.
 */
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

/**
 * M25.6a — THE DEADLINE LOCK'S DECISION, the explainability half.
 *
 * Every property `recordCampaignFreezeAdmissionHold` argues at length applies here for the same
 * reasons, with ONE deliberate difference (the verdict) that has to be justified rather than
 * inherited.
 *
 * `kind: "campaign_deadline"`, DISTINCT FROM `gate`, `freeze_admission` AND `campaign_adoption`.
 * `insertDecisionIfChanged` compares against the LATEST row of the same `(subject_id, kind)`, and
 * all four of those writers write about the SAME subject — this campaign. Any two of them sharing a
 * kind would make their rows alternate under one another and suppression would never fire once.
 *
 * `verdict: "block"`, AND HERE THAT IS SAFE — which is exactly the opposite of the ruling on the
 * change side, so it is re-verified rather than assumed. `latestBlockDecisionForSubject` selects the
 * newest `verdict = 'block'` row for a subject, on the VERDICT ALONE, and `service-board.ts:805`
 * feeds it straight into a component row's sticky `attention.blocked`, which nothing ever clears.
 * That is why the freeze hold on a CHANGE must never be a `block`. But that call is
 * `latestBlockDecisionForSubject(tx, orgId, changeId)` — keyed on the CHANGE object id, taken from a
 * list of changes — and this Decision's subject is the CAMPAIGN object. A campaign object id is
 * never a change object id (they are distinct rows of `objects`), so this row is unreachable from
 * that query and cannot pollute the board. Verified at HEAD, not inherited.
 *
 * ONE ROW PER CAMPAIGN, NOT PER TARGET. Per-target rows would alternate under the same
 * `(subject_id, kind)` comparison and suppression would never fire.
 *
 * `deadline.at` AND NOTHING ELSE CLOCK-SHAPED. Banned from this object, permanently and by name:
 * `now`, `evaluatedAt`, `overdueMs`, `daysLate`, `lockedSince`, any remaining-TTL. `at` is a stored
 * BOUNDARY, byte-identical on every tick; the clock is not. Both arrays are sorted. So tick N+1
 * produces a byte-identical candidate, `restatesDecision` is true, and nothing is written: a
 * six-month lock is ONE row, not 15.7 million. This is the measured 1.44 GB/day incident (ADR-0024)
 * being defended, not a style preference.
 *
 * THE AUDIT EVENT IS APPENDED ONLY WHEN `created` IS TRUE. The chain asserts that something
 * HAPPENED; appending on a tick that wrote nothing would make it assert an occurrence that did not
 * occur, once a second, forever. Same pairing as `campaign-adoption`'s.
 *
 * NO CURSOR BUMP — see the seam above: this loop bumps `objects.updated_at` unconditionally for
 * every locally-owned campaign it examines, and `candidate-loop-registry.test.ts` records that as
 * this loop's one bump.
 */
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

/**
 * THE "LOUDLY" HALF OF FAIL-OPEN — one `warn` Decision naming what did not parse.
 *
 * `verdict: "warn"`, deliberately, and it is the honest one: nothing is being blocked (a malformed
 * deadline locks NOTHING) and nothing is being allowed that would otherwise be refused. What has
 * happened is that a governance control an author configured is inert, and the only other signal of
 * that would be silence — indistinguishable from never having set one.
 *
 * SAME KIND as the lock itself, which is safe here and worth stating: a campaign's deadline document
 * is either readable or it is not, so the `warn` and `block` rows describe MUTUALLY EXCLUSIVE
 * states of the same document and can never alternate tick by tick. Fixing the document writes one
 * transition row and then dedupes forever, which is precisely what the record should show.
 *
 * NO AUDIT EVENT. Nothing occurred — a document was found unreadable, again, on a timer. The
 * Decision is the durable record; a hash-chained event per tick for a standing condition is the
 * shape this whole family exists to refuse.
 */
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
  /** M25.6a — THE TICK'S CLOCK SEAM. See docs/coordination/campaign-reconcile.md §7. */
  opts: { now?: Date } = {}
): Promise<void> {
  const now = opts.now ?? new Date();
  // S10 SINGLE-WRITER, filtered IN THE SQL rather than skipped in the loop below — see
  // `campaign-repo.ts`'s doc comment for why, and `reconcile.ts`'s six `advance*` loops for the
  // change-side twin this deliberately matches in shape. A peer's campaign object DOES land here as
  // an ordinary local row (`import-repo.ts`'s `object_upsert` is type-agnostic), so without this the
  // loop compiled a plan for another domain's campaign and proposed member changes from it.
  const rows = await withTenantTx(db, orgId, (tx) =>
    listActiveCampaignObjectIds(tx, orgId, BATCH_LIMIT, selfDomainId)
  );
  for (const campaignObject of rows) {
    // S10 single-writer guard, DEFENCE IN DEPTH AND NOW UNREACHABLE. The query above filters
    // foreign-origin campaigns out of the candidate set, so this `continue` can no longer fire. It
    // stays because it states this loop's S10 INVARIANT — "this loop only ever drives, and only ever
    // writes, campaigns this domain is authoritative for" — which is a property of the LOOP, not of
    // one query; a future candidate fetch that forgot the filter would find this still standing.
    //
    // WHAT THIS MUST NEVER BECOME is a round-robin `updated_at` bump. Note where this `continue`
    // sits: BEFORE the bump at the bottom of this loop, deliberately. Un-filtered, that would make
    // this a re-serve-without-writing path — the batch-starvation property (instance 4 in
    // `candidate-loop-registry.test.ts`, and `listActiveCampaignObjectIds` really is `ORDER BY
    // updated_at ASC LIMIT 25`) — but the bump that closes that property everywhere else is ILLEGAL
    // on a replica: it writes a row this domain does not own, which is the very violation the guard
    // exists to prevent. Filtering the candidate set is the only remedy that is both starvation-free
    // and single-writer-clean. Pinned by `foreign-origin-campaign.integration.test.ts`, whose
    // "SKIP, NOT DRIVE and SKIP, NOT PARK" case asserts the replica's `updated_at` never moves.
    if (campaignObject.originDomainId !== selfDomainId) continue;

    // MULTI-REPLICA SINGLE-FLIGHT (`campaign-coordination-lock.ts` — read its docblock for the
    // confirmed failure). This whole file had ZERO advisory-lock coverage of the read ->
    // `compileAndPersistCampaignPlan` -> `updateObject` sequence inside `reconcileOneCampaign`,
    // while the byte-for-byte identical property on the change side has been locked since M8
    // (`change-coordination-lock.ts` + `reconcile.ts`'s call sites). The chart default is `worker
    // replicaCount=2`, so two overlapping ticks reaching the same campaign is the ordinary case,
    // not an exotic one — and unlike the change side there is no unique constraint and no
    // `FOR UPDATE`-guarded transition anywhere in the sequence to catch the loser, so BOTH
    // committed a full duplicate plan silently.
    //
    // ACQUIRED HERE, BEFORE `reconcileOneCampaign` IS ENTERED, so a loser never compiles a plan,
    // never evaluates the wave gate, and never fans out a member Change. It backs off immediately
    // and retries on a later tick, exactly like `triggerWaveTarget` backing off on a failed
    // trigger claim. The fresh re-reads that make "the winner already did it" a clean no-op rather
    // than a failure live at the top of `reconcileOneCampaign`, still under this lock.
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
    // "UNCONDITIONALLY" ALSO SURVIVES THE ADVISORY LOCK ADDED ABOVE, and that placement is
    // deliberate rather than incidental. A tick that FAILS to acquire the lock has examined this
    // campaign and written nothing — which is this exact property, in a loop that really is
    // `ORDER BY objects.updated_at ASC LIMIT 25`. Gating the bump on holding the lock would make
    // the lock-miss path a fresh re-serve-without-writing path: instance 4 of the starvation class,
    // reopened by the fix for a different bug. The bump is legal on this path for the reason the
    // S10 skip's is not — the row is locally originated (filtered by the candidate query AND the
    // guard above), so this is a fairness write on our own row, not a write to a replica.
    //
    // "UNCONDITIONALLY" NOW MEANS "for every campaign THIS DOMAIN OWNS". The candidate query filters
    // foreign-origin campaigns out and the S10 guard above `continue`s before reaching here, so this
    // write can only ever land on a locally-originated row. That ordering is load-bearing: this bump
    // used to fire on a replica too, which made a fairness write into a single-writer violation.
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
