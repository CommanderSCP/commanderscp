import { randomUUID } from "node:crypto";
import type PgBoss from "pg-boss";
import type { DependencySubscriptionDelivery } from "@scp/schemas";
import type { Db } from "../db/client.js";
import { withTenantTx } from "../db/tenant-tx.js";
import type { ServerConfig } from "../config.js";
import type { PluginHost } from "../plugin-host/contract.js";
import type { DomainEventJob, DomainEventRouter } from "../events/pgboss.js";
import type { CelSandbox } from "../governance/cel-sandbox.js";
import { prewarmGovernanceForChange } from "../governance/gate-orchestrator.js";
import { BUMP_OBSERVED_EVENT } from "../coordination/correlation.js";
import { SYSTEM_ACTOR_ID } from "../coordination/system-actor.js";
import { insertDecisionIfChanged } from "../coordination/decisions-repo.js";
import { listExecutorBindings } from "../coordination/executor-bindings-repo.js";
import { bumpDispatchRoleGuard } from "./bump-dispatch.js";
import {
  buildBumpMergeIntentParameters,
  bumpRefFor,
  resolveEffectiveDelivery
} from "./bump-actuator.js";
import { markBumpMerged, readBumpAuthorship } from "./bump-authorship-repo.js";
import { readStandingDelegationVerdict, delegationRefusalMessage } from "./delegation-detection.js";
import { listSubscribedComponentLines } from "./subscription-resolution.js";
import { pickComponentGitBinding, startManagedDepInstance } from "./managed-dep-instance.js";
import { checkBumpMergeFreeze } from "./bump-merge-freeze.js";

/**
 * M21.5 — THE AUTO-MERGE LINK: what asks the delivery question a SECOND time, and what actuates the
 * answer (ADR-0032 §8c, charter `scp-managed-dep` amendment).
 *
 * ============================================================================================
 * WHAT WAS MISSING, AND WHY IT WAS THREE THINGS RATHER THAN ONE
 * ============================================================================================
 * `resolveEffectiveDelivery` was built correct and unreachable. It grants `auto_merge` only on a
 * governed control run that evidences the component's OWN checks passed FOR THE BUMP'S OWN COMMIT —
 * both narrowings right, and both satisfiable only after the branch exists and CI has concluded on
 * it. Nothing in the tree produced that moment:
 *
 *   1. NO CONTROL EVER RAN ON A BUMP CHANGE. `control_runs` rows are deposited by the gate machinery
 *      on a lifecycle edge or a wave boundary; `coordination/reconcile.ts` prewarms governance only
 *      for changes sitting in `validating`, and a bump change sits at `proposed` from the moment
 *      `proposeChange` writes it. So the evidence the grant requires could not exist.
 *   2. NOTHING RE-EVALUATED THE CHANGE AFTER ITS PULL REQUEST WAS OPENED. The only trigger was a
 *      line's head advancing, an advance to a different version is a DIFFERENT change, and a
 *      restatement deliberately emits nothing.
 *   3. THERE WAS NO MERGE. The only merge in the tree was the tail of an authoring run — reachable
 *      only by a run that had just created the very commit it would merge, which is the one commit a
 *      control cannot have passed beforehand.
 *
 * This file is (1) and (2); (3) is `@scp/plugin-managed-dep`'s `action: "merge"`.
 *
 * ============================================================================================
 * (1) THE GATE IS THE EXISTING GATE. NO SECOND GATE PATH IS CREATED.
 * ============================================================================================
 * ADR-0032 §8: "Auto-merge's CI-green condition is expressed as a governed control so the EXISTING
 * gate machinery decides, not new code." So this job calls
 * `governance/gate-orchestrator.ts`'s `prewarmGovernanceForChange` — the same function
 * `coordination/reconcile.ts` calls for a validating change, unchanged — which resolves the
 * component's effective policies, evaluates each contributor's own condition, and runs the required
 * controls those FIRED policies name, threading the change's own `commit_sha` into every control
 * context. What comes out is ordinary `control_runs` rows with ordinary evidence, which
 * `resolveEffectiveDelivery` then reads exactly as it always did.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO IS ADVANCE THE CHANGE. Driving a bump down the deploy lifecycle
 * to make gates fire would coordinate a release nobody asked for: a bump is a proposed edit to a
 * manifest, not a deployment of anything. `prewarmGovernanceForChange` is the right seam precisely
 * because it RUNS controls and materialises approvals while transitioning nothing — its own doc
 * calls that out ("Runs (never blocks, never writes a Decision)"), and `reconcile.ts` relies on the
 * same property.
 *
 * A CONSEQUENCE WORTH STATING: if an org's policies name no required control for this component, no
 * control run appears, `resolveEffectiveDelivery` finds nothing, and the bump is delivered as a pull
 * request. That is the charter clause working, not a gap — "automatic merge is permitted only where
 * a governed control evidences that the component's own checks passed", and an org that has declared
 * no such control has evidenced nothing. Absence is never permission.
 *
 * ============================================================================================
 * (2) THE TRIGGER IS AN OBSERVED EVENT ABOUT THE BUMP, AND IT IS EMITTED AT ONE DOOR
 * ============================================================================================
 *   a provider webhook -> change_source_events
 *     -> processChangeSourceEvents -> matchAuthoredBumpChange (BOTH routes: the authored ref, and
 *        the bump's own recorded head commit)
 *     -> outbox `scp.dependency.bump_observed`   [in the ingress transaction]
 *     -> domain-events -> {@link observedBumpRouter} (one cheap predicate, one enqueue, no work)
 *     -> {@link DEPENDENCY_BUMP_GATE_QUEUE} -> this file's worker.
 *
 * WHICH REAL EVENT CARRIES "THE CHECKS WENT GREEN", measured rather than assumed:
 * `@scp/plugin-github`'s `mapEvent` maps `push`, `pull_request`, `workflow_run`, `deployment` and
 * `release` — `check_suite`/`check_run` are not mapped at all — and `workflow_run` carries
 * `commitSha: workflow_run.head_sha` with NO ref. That is the conclusion event, and reaching it
 * needed two additive changes stated here rather than left to be discovered: `ExtractedHint` now
 * carries `commitSha` (the adapter had always produced one and ingress dropped it), and
 * `matchAuthoredBumpChange` gained a head-commit route so a ref-less CI event attaches to the bump
 * whose commit it names instead of minting a second, unrelated change. Gitea maps no workflow event
 * and GitLab maps `Pipeline Hook`; neither matters for this path, because a bump can only be
 * authored through a GitHub App (`repo-write.ts`'s `resolveRepoWriter` refuses the other two by
 * name).
 *
 * A ROUTER, NOT A SECOND WORKER — `boss.work()` is a COMPETING consumer, so a second `work()` on
 * `domain-events` would steal roughly half of M21.4's and M21.5's events and receive roughly half of
 * its own (`events/pgboss.ts`'s `DomainEventRouter`). It is likewise its OWN queue rather than a
 * second worker on `dependency-bump`, for the identical reason.
 *
 * IDEMPOTENT AND RE-DERIVED. Nothing is trusted from the event but the change id: the claim, the
 * head commit, the delegation verdict, the subscription and the control runs are all re-read. A
 * redelivery therefore reaches the same answer, and a merge that already happened finds no OPEN pull
 * request and refuses (the plugin never re-opens one).
 *
 * ============================================================================================
 * (3) FAIL-CLOSED, IN EVERY DIRECTION THE CHARTER NAMES
 * ============================================================================================
 * "Delivery is a pull request by default, and automatic merge is permitted only where a governed
 * control evidences that the component's own checks passed." Every one of these is a REFUSAL with
 * its own named cause ({@link BumpGateRefusal}), never a fallthrough:
 *
 *   * SCP recorded no authorship for this change                         -> no merge
 *   * the recorded ref is not the ref this change's own bump would author -> no merge
 *   * no head commit observed back yet                                    -> no merge
 *   * SCP never recorded which pull request it opened                     -> no merge
 *   * the component has NO conclusive delegation verdict on record        -> no merge
 *   * the repository delegates its dependency updates to somebody else    -> no merge
 *   * the subscription no longer resolves, or resolves to `pull_request`  -> no merge
 *   * the governed gate does not grant `auto_merge` for THIS commit       -> no merge
 *
 * ============================================================================================
 * EVERY ONE OF THOSE INPUTS IS A FACT SCP ITSELF RECORDED (migration 0063)
 * ============================================================================================
 * The repository, the base branch, the component, the line, the branch's head commit and the pull
 * request number are read from `dependency_bump_authorships` — server-owned storage written only by
 * the actuator, by the ingress that observes SCP's own branch back, and by this file.
 *
 * They used to be read from `changes.source_ref.scp_authored`. `source_ref` is the raw delivery
 * payload plus a few lifted keys and is writable verbatim by ANY authenticated principal through
 * `POST /api/v1/changes`; the event that starts this job is producible through
 * `POST /change-sources/{kind}/report`. So a tenant could fabricate a "bump" naming any repository
 * and have this job merge into it with SCP's credential — a confused deputy, and one no amount of
 * validating that field could close. A change with no authorship row is not a bump change and stops
 * at the first refusal below.
 *
 * THE DELEGATION RULE IS STRICTER HERE THAN AT THE AUTHORING SEAM, and deliberately.
 * `assertComponentNotDelegated` refuses when a standing verdict SAYS delegated; absence of a verdict
 * is permissive there, because the authoring path is the thing that produces the verdict in the
 * first place (ADR-0032 §8b's stated residual). A merge produces nothing and requires more: an
 * INCONCLUSIVE probe writes no verdict at all, so "no verdict" is exactly what an unreadable
 * repository looks like, and the requirement here is a POSITIVE, conclusive "this repository does
 * not delegate". Absence of evidence is not evidence.
 *
 * ============================================================================================
 * THE ROLE GUARD IS THE DISPATCHER'S, AND IT IS IMPORTED RATHER THAN RESTATED
 * ============================================================================================
 * `bumpDispatchRoleGuard` asks "may this process write to a source repository with a credential?"
 * and answers commander-only, fail-closed on an undeclared `SCP_FEDERATION_ROLE`. That is the same
 * question this job asks — merging is a repository write, and a strictly more consequential one than
 * opening a pull request — so the guard is the same object, not a copy of its verdict. A copy is
 * where the two would drift, and the direction they would drift is toward an outpost merging into
 * somebody's default branch.
 */

export const DEPENDENCY_BUMP_GATE_QUEUE = "dependency-bump-gate";

/** The `decisions.kind` every merge verdict is filed under — also the key `insertDecisionIfChanged`
 *  compares the previous verdict on, so it must be a constant. */
export const DEPENDENCY_BUMP_MERGE_DECISION_KIND = "dependency_bump_merge";

/** What {@link observedBumpRouter} puts on {@link DEPENDENCY_BUMP_GATE_QUEUE}. */
export interface BumpGateJob {
  orgId: string;
  changeObjectId: string;
}

/** True for the one event shape this capability reacts to. Exported so a test can pin the predicate
 *  without a queue: a router that matched too widely would run the governance gate — and therefore
 *  a real control plugin against a real provider — for events that are about nothing. */
export function isBumpObservedEvent(event: DomainEventJob): boolean {
  return event.type === BUMP_OBSERVED_EVENT;
}

/** The fan-out point on the shared domain-event stream: one predicate, one enqueue, no work. */
export function observedBumpRouter(): DomainEventRouter {
  return {
    name: "dependency-bump-gate",
    queue: DEPENDENCY_BUMP_GATE_QUEUE,
    async route(boss: PgBoss, event: DomainEventJob): Promise<void> {
      if (!isBumpObservedEvent(event)) return;
      const changeObjectId = event.subject;
      if (typeof changeObjectId !== "string" || changeObjectId === "") return;
      const job: BumpGateJob = { orgId: event.orgId, changeObjectId };
      // NO DEDUP OPTION, for the reason `bump-dispatch.ts`'s router states at length: this queue is
      // created with the DEFAULT `standard` policy, for which pg-boss maintains no `singleton_key`
      // index, so the option would be recorded and ignored. The job re-derives everything from the
      // row, so collapsing was never the correctness argument.
      await boss.send(DEPENDENCY_BUMP_GATE_QUEUE, job);
    }
  };
}

export type BumpGateRefusal =
  /** SCP recorded no authorship for this change — so whatever `source_ref` claims, this instance did
   *  not author a bump for it and there is nothing here to merge. This is the refusal a FORGED bump
   *  change lands on: `POST /api/v1/changes` can write any `source_ref` it likes and cannot write a
   *  `dependency_bump_authorships` row at all. */
  | "no_authored_claim"
  /** The recorded ref is not `refs/heads/scp/dep-bump/<this change's id>`. The merge target is
   *  DERIVED from the change id, so a record naming anything else means the two disagree about which
   *  branch this change owns — and merging on the derivation would merge a branch the record never
   *  named. */
  | "claim_ref_not_this_change"
  /** No push has come back yet, so the branch's commit is unknown and there is nothing for evidence
   *  to be ABOUT. */
  | "no_head_commit_observed"
  /** SCP has no record of which pull request it opened for this bump. The merge is addressed to that
   *  number; without it the only alternative is to SEARCH for one, which is how provider list
   *  ordering — or a second pull request somebody else opened from SCP's branch — decides what gets
   *  merged. Refused instead. */
  | "no_recorded_pull_request"
  /** No conclusive delegation verdict on record for this component — see the module doc for why
   *  absence refuses here and permits at the authoring seam. */
  | "no_delegation_verdict"
  /** The repository delegates the same manifests to another dependency-update system. */
  | "delegated"
  /** The component is no longer subscribed to this line at all. */
  | "not_subscribed"
  /** The subscription's CURRENT resolution is `pull_request`. */
  | "subscription_is_pull_request"
  /** The governed gate did not grant `auto_merge` for this commit. Carries the resolver's own
   *  reason, which names which of its narrowings refused. */
  | "not_evidenced"
  /** There is no git-provider binding naming a repository, so no credential may write to one. */
  | "no_git_binding_for_component"
  /** M25.8 / owner decision D8 — an active change freeze covers this component. The gate GRANTED
   *  auto-merge and every capability is in place; what is withheld is the merge itself, and only
   *  until the window closes. Its own cause rather than a reuse of `not_evidenced`, because the two
   *  are opposite facts: `not_evidenced` says the checks have not proven the bump safe, and this says
   *  they have and the organization has declared that nothing lands right now. A reason named after a
   *  branch that covers a second case goes false the moment it does (charter principle 6). */
  | "frozen"
  /** The merge was dispatched and the provider (or the plugin) refused it. The pull request stands. */
  | "merge_refused"
  /** The dispatch itself threw — the plugin host was unreachable, the runner image is not
   *  configured, the binding could not be resolved. Nothing merged, and unlike every other refusal
   *  this one used to leave NO Decision at all (principle 6: "every blocked response carries a
   *  `decision_id`"). */
  | "merge_dispatch_failed";

export interface BumpGateOutcome {
  changeObjectId: string;
  /** True when the governed gate was actually run for this change (it is not run when the
   *  subscription could never merge — see the module doc). */
  gateEvaluated: boolean;
  merged: boolean;
  refusal?: BumpGateRefusal;
  /** The sentence an operator can act on. Recorded on the Decision. */
  detail: string;
}

export interface BumpGateLoopDeps {
  db: Db;
  host: PluginHost;
  sandbox: CelSandbox;
  config: Pick<
    ServerConfig,
    "role" | "federationRole" | "federationRoleDeclared" | "secretsMasterKey"
  >;
}

/** Run ONE queued job. See docs/dependencies/bump-gate.md §1. */
export async function runBumpGateJob(
  deps: BumpGateLoopDeps,
  job: BumpGateJob
): Promise<BumpGateOutcome> {
  const { orgId, changeObjectId } = job;
  const refuse = async (
    refusal: BumpGateRefusal,
    detail: string,
    gateEvaluated = false,
    context: Record<string, unknown> = {}
  ): Promise<BumpGateOutcome> => {
    await recordMergeVerdict(deps, orgId, changeObjectId, {
      verdict: "withheld",
      refusal,
      detail,
      context
    });
    return { changeObjectId, gateEvaluated, merged: false, refusal, detail };
  };

  // ---- PHASE 1 (read) -----------------------------------------------------------------------
  // Everything is RE-READ, and every fact that leads to a repository write is read from SCP'S OWN
  // RECORD (`dependency_bump_authorships`) rather than from `changes.source_ref`, which any
  // authenticated principal can write. The event carries a change id and nothing else is trusted
  // from it.
  const facts = await withTenantTx(deps.db, orgId, async (tx) => {
    const authorship = await readBumpAuthorship(tx, orgId, changeObjectId);
    if (!authorship) return { kind: "no_authorship" as const };
    // ALREADY MERGED — and this is checked FIRST, before any refusal can be recorded.
    //
    // A merge produces its own provider events: the merge commit's push to the base branch, and
    // whatever CI runs on it. Those correlate straight back to this bump (the head-commit route) and
    // re-run this job. That second run finds no OPEN pull request and would record
    // `withheld / merge_refused`, so the LATEST Decision for a bump that DID merge said it did not —
    // charter principle 6 inverted, on the one irreversible action in the whole feature.
    if (authorship.mergedAt) return { kind: "already_merged" as const, authorship };
    if (authorship.authoredRef !== bumpRefFor(changeObjectId)) {
      return { kind: "ref_mismatch" as const, authorship };
    }
    if (!authorship.headCommit) return { kind: "no_head_commit" as const, authorship };
    if (!authorship.pullRequestNumber) {
      return { kind: "no_pull_request" as const, authorship };
    }

    const delegation = await readStandingDelegationVerdict(tx, orgId, authorship.componentObjectId);
    const subscribed = await listSubscribedComponentLines(tx, orgId, {
      // The system actor, exactly as the dispatcher and both M21.4 ingresses resolve.
      actorObjectId: SYSTEM_ACTOR_ID,
      componentObjectIds: [authorship.componentObjectId]
    });
    const pair = subscribed.find((s) => s.lineId === authorship.lineId);
    const bindings = await listExecutorBindings(tx, orgId);
    return {
      kind: "ok" as const,
      authorship,
      delegation,
      requested: pair?.delivery,
      gitBinding: pickComponentGitBinding(bindings, authorship.componentObjectId)
    };
  });

  if (facts.kind === "no_authorship") {
    return refuse(
      "no_authored_claim",
      `change ${changeObjectId} has no server-recorded dependency-bump authorship, so this instance did not author it — whatever its 'source_ref' declares, which is a field any authenticated principal can write`
    );
  }
  if (facts.kind === "already_merged") {
    // NOT A REFUSAL, so NO Decision is written: nothing was withheld, and the merged verdict this
    // job already recorded stays the latest word on the bump.
    const detail = `this bump was already merged at ${facts.authorship.mergedAt?.toISOString()}; the merge's own provider events re-trigger this job, and re-answering them would overwrite the record of the one irreversible act with a refusal`;
    return { changeObjectId, gateEvaluated: false, merged: true, detail };
  }
  if (facts.kind === "ref_mismatch") {
    return refuse(
      "claim_ref_not_this_change",
      `SCP recorded '${facts.authorship.authoredRef}' but a bump of this change authors '${bumpRefFor(changeObjectId)}' — the branch a merge would target is DERIVED from the change id, so a disagreement here means merging a branch this change never authored`
    );
  }
  if (facts.kind === "no_head_commit") {
    return refuse(
      "no_head_commit_observed",
      "the bump's authored push has not been observed back yet, so its branch's commit is unknown and there is nothing for a control's evidence to be ABOUT"
    );
  }
  if (facts.kind === "no_pull_request") {
    return refuse(
      "no_recorded_pull_request",
      "SCP has no record of which pull request it opened for this bump, and a merge is addressed to that number — searching for one by head branch is how provider list ordering, or a second pull request somebody else opened from this branch, would decide what gets merged"
    );
  }

  const { authorship, delegation, requested, gitBinding } = facts;
  const componentObjectId = authorship.componentObjectId;
  const headCommit = authorship.headCommit as string;
  const pullRequestNumber = authorship.pullRequestNumber as number;

  if (!delegation) {
    return refuse(
      "no_delegation_verdict",
      `no conclusive dependency-update delegation probe is on record for this component. An INCONCLUSIVE probe records no verdict at all (ADR-0032 §8b), so "no verdict" is indistinguishable from "we could not read the repository" — and a merge is not permitted on the absence of evidence`
    );
  }
  if (delegation.delegated) {
    return refuse("delegated", delegationRefusalMessage(delegation.collisions), false, {
      delegationDecisionId: delegation.decisionId
    });
  }
  if (requested === undefined) {
    return refuse(
      "not_subscribed",
      "this component no longer resolves to a dependency subscription on this line, so nothing authorises merging a bump for it"
    );
  }
  if (requested === "pull_request") {
    // RE-DERIVED, NOT READ OFF THE CHANGE. The change records the DOWNGRADED delivery by
    // construction, so reading it would mean the answer could never be `auto_merge`. Re-resolving is
    // also what makes a subscription narrowed to `pull_request` AFTER the bump was authored stop the
    // merge — the more restrictive, more recent answer wins.
    return refuse(
      "subscription_is_pull_request",
      "this component's dependency subscription currently resolves to 'pull_request' delivery, so this bump is delivered as one whatever any control has evidenced"
    );
  }

  // ---- PHASE 2 (the governed gate — the EXISTING one) ----------------------------------------
  // Deliberately after the cheap refusals above: running it costs a real control plugin call against
  // a real provider, and a bump that cannot merge has no business paying for one.
  await withTenantTx(deps.db, orgId, (tx) =>
    prewarmGovernanceForChange(tx, deps.sandbox, deps.host, {
      orgId,
      changeObjectId,
      targetObjectIds: [componentObjectId],
      actorObjectId: SYSTEM_ACTOR_ID,
      // CONTROLS ONLY. `prewarmGovernanceForChange` exists to make a change's gate outcomes READABLE
      // by the time a human calls `POST /changes/{id}/accept` — which is why it also MATERIALISES
      // every firing policy's approval requests. That is right for a change on its way through the
      // lifecycle and wrong here: a bump change is deliberately never advanced (a bump is not a
      // deployment), so nothing will ever consume those approval requests and every bump would leave
      // a permanently-pending approval task in somebody's queue, once per firing policy, forever.
      //
      // The CONTROLS are what this job needs — they are the evidence the charter's clause is about —
      // and they are unaffected.
      materializeApprovals: false
    })
  );

  // ---- PHASE 3 (re-ask the delivery question, against what the gate just deposited) -----------
  const resolution = await withTenantTx(deps.db, orgId, (tx) =>
    resolveEffectiveDelivery(tx, orgId, {
      changeObjectId,
      requested: requested satisfies DependencySubscriptionDelivery,
      // BOTH from SCP's own record. The repository is what binds a control's evidence to THIS
      // component rather than to any repository that happens to contain the same commit object.
      repo: authorship.repo,
      authoredHeadCommit: headCommit
    })
  );
  if (resolution.delivery !== "auto_merge") {
    return refuse("not_evidenced", resolution.reason, true);
  }
  if (!gitBinding) {
    return refuse(
      "no_git_binding_for_component",
      "no github/gitea/gitlab executor binding on this component names a repository, so there is no credential that may merge anything",
      true
    );
  }

  // ---- PHASE 3b (M25.8 — THE FREEZE, owner decision D8) --------------------------------------
  // THE LAST QUESTION BEFORE THE ONE IRREVERSIBLE ACT, and its position is the argument.
  //
  // It is asked AFTER the governed gate rather than with the cheap refusals above, and that costs a
  // control run during a freeze window on purpose: the gate's `control_runs` rows are the evidence
  // the grant reads, and depositing them WHILE the window stands is what makes "pull requests
  // accumulate during the freeze and merge when it closes" true on the NEXT attempt instead of
  // requiring CI to conclude all over again afterwards. It also keeps the two refusals distinct — a
  // bump refused here has been proven safe and is held by the calendar, which is a different sentence
  // from `not_evidenced` and resolves by a different act.
  //
  // AND "THE NEXT ATTEMPT" IS A THING SOMETHING PRODUCES (M25.8b). This job is enqueued by
  // `observedBumpRouter` off a PROVIDER WEBHOOK about the bump's branch, and a freeze expiring,
  // being lifted or being shortened touches no repository — so for one release the refusal below
  // promised a retry nothing scheduled, and every bump refused inside a window was stranded for
  // ever. `dependencies/bump-freeze-redrive.ts` is the producer: a 60s sweep that re-asks
  // `checkBumpMergeFreeze` for exactly the bumps this refusal named and re-enqueues them here.
  //
  // It is asked AFTER the binding check for the complementary reason: a component with no git
  // binding can never merge, freeze or no freeze, and reporting `frozen` for it would promise an
  // outcome at `endsAt` that will not arrive.
  //
  // NOT A PAUSE, and the honest boundary is `freeze-hold.ts`'s: `ExecutorPlugin` has no
  // advance/pause/resume verb (ADR-0008 forbids adding one). A freeze withholds a call SCP has not
  // made yet; it cannot un-merge one already handed to a provider.
  const frozen = await withTenantTx(deps.db, orgId, (tx) =>
    checkBumpMergeFreeze(tx, orgId, componentObjectId)
  );
  if (frozen) {
    return refuse("frozen", frozen.reason, true, {
      headCommit,
      pullRequestNumber,
      controlObjectId: resolution.controlObjectId,
      // `endsAt` per freeze and NEVER `now` — see `bump-merge-freeze.ts`. This context is what
      // `insertDecisionIfChanged` compares, and this path re-runs on every provider event about the
      // bump's branch for the length of the window.
      freezes: frozen.freezes
    });
  }

  // ---- PHASE 4 (actuate — outside any transaction) -------------------------------------------
  // THIS RUN's own plugin-instance namespace. `bump-dispatch.ts` is a concurrent consumer of the
  // same component binding and also stops its instances in a `finally`; a shared id meant either
  // job could tear down the other's subprocess mid-RPC — including the `status()` call below, which
  // is issued AFTER the provider may already have merged. See `managed-dep-instance.ts`.
  const runToken = randomUUID();
  let phase: string;
  let detail: string;
  let instanceId: string | undefined;
  try {
    instanceId = await startManagedDepInstance(deps, orgId, gitBinding, runToken);
    const executor = deps.host.executor(instanceId);
    const ref = await executor.trigger({
      kind: "custom",
      // KEYED ON THE COMMIT, not on the change alone. The plugin's outcome cache is keyed on this,
      // and a merge is about a TREE: a later push to the bump's branch is a different commit, a
      // different grant and therefore a different run. Keying on the change alone would let one
      // provider refusal permanently mask every subsequent attempt for that bump.
      idempotencyKey: `${changeObjectId}:merge:${headCommit}`,
      parameters: buildBumpMergeIntentParameters({
        changeObjectId,
        // EVERY FIELD FROM SCP'S OWN RECORD (migration 0063) — never from `changes.source_ref`.
        repo: authorship.repo,
        baseBranch: authorship.baseBranch,
        expectedHeadCommit: headCommit,
        // THE PULL REQUEST SCP OPENED, by the number SCP recorded when it opened it. The plugin
        // re-reads that pull request and refuses unless its state, head AND base still match.
        pullRequestNumber
      })
    });
    // ASKED, NOT ASSUMED. See docs/dependencies/bump-gate.md §2.
    const status = await executor.status(ref);
    phase = status.phase;
    detail = status.detail ?? "";
  } catch (err) {
    // A THROW HERE USED TO LEAVE NO DECISION AT ALL. See docs/dependencies/bump-gate.md §3.
    return refuse(
      "merge_dispatch_failed",
      `the merge was authorised but the dispatch itself failed: ${err instanceof Error ? err.message : String(err)}`,
      true,
      { headCommit, pullRequestNumber, controlObjectId: resolution.controlObjectId }
    );
  } finally {
    if (instanceId) await deps.host.stopInstances([instanceId]).catch(() => undefined);
  }

  if (phase !== "succeeded") {
    return refuse(
      "merge_refused",
      `the merge was authorised and dispatched but did not complete (${phase}): ${detail}`,
      true,
      { headCommit, pullRequestNumber, controlObjectId: resolution.controlObjectId }
    );
  }
  // THE MERGE HAPPENED. See docs/dependencies/bump-gate.md §4.
  await withTenantTx(deps.db, orgId, (tx) => markBumpMerged(tx, orgId, changeObjectId)).catch(
    (err) => {
      console.error(
        `[dependency-bump-gate] could not stamp change ${changeObjectId} as merged (the merge itself succeeded):`,
        err
      );
    }
  );
  await recordMergeVerdict(deps, orgId, changeObjectId, {
    verdict: "merged",
    detail: `${resolution.reason}${detail ? ` — ${detail}` : ""}`,
    context: {
      headCommit,
      pullRequestNumber,
      controlObjectId: resolution.controlObjectId,
      controlRunId: resolution.controlRunId
    }
  });
  return {
    changeObjectId,
    gateEvaluated: true,
    merged: true,
    detail: resolution.reason
  };
}

/**
 * One Decision per verdict, through `insertDecisionIfChanged`.
 *
 * WHY `IfChanged` AND WHY THE INPUTS ARE STABLE FACTS ONLY: this path repeats per observed event on
 * the bump's branch, which is the write-amplification shape that cost 1.44 GB/day elsewhere in this
 * tree. A redelivered event, or a second CI event on the same commit, re-derives the same refusal
 * and writes no new row.
 *
 * WRITTEN AFTER THE ATTEMPT, not before it: a Decision that recorded "merge authorised" and then
 * failed to say what happened is the record charter principle 6 is least useful as. The cost is that
 * a crash between the provider's merge and this write leaves the merge unrecorded — recoverable,
 * because the next observed event re-runs the job and finds no OPEN pull request.
 */
async function recordMergeVerdict(
  deps: BumpGateLoopDeps,
  orgId: string,
  changeObjectId: string,
  input: {
    verdict: "merged" | "withheld";
    refusal?: BumpGateRefusal;
    detail: string;
    context: Record<string, unknown>;
  }
): Promise<void> {
  await withTenantTx(deps.db, orgId, (tx) =>
    insertDecisionIfChanged(tx, {
      orgId,
      kind: DEPENDENCY_BUMP_MERGE_DECISION_KIND,
      subjectId: changeObjectId,
      verdict: input.verdict,
      inputContext: {
        ...input.context,
        ...(input.refusal ? { refusal: input.refusal } : {})
      },
      reasonTree: { summary: input.detail }
    })
  ).catch((err) => {
    // A Decision that cannot be written must not turn a completed merge into a thrown job — the
    // merge already happened, and rethrowing here would make the worker retry an actuation that is
    // done. Loud, never silent.
    console.error(
      `[dependency-bump-gate] could not record the ${input.verdict} verdict for change ${changeObjectId}:`,
      err
    );
  });
}

export interface BumpGateLoopHandle {
  stop(): Promise<void>;
}

/** Register the capability's worker. See docs/dependencies/bump-gate.md §5. */
export async function startBumpGateLoop(
  boss: PgBoss,
  deps: BumpGateLoopDeps
): Promise<BumpGateLoopHandle> {
  const guard = bumpDispatchRoleGuard(deps.config);
  if (!guard.allowed) {
    console.info(`[dependency-bump-gate] not started: ${guard.reason}`);
    return { async stop() {} };
  }
  console.info(`[dependency-bump-gate] STARTING: ${guard.reason}`);

  let stopped = false;
  const inFlight = new Set<Promise<unknown>>();
  await boss.createQueue(DEPENDENCY_BUMP_GATE_QUEUE);
  await boss.work<BumpGateJob>(DEPENDENCY_BUMP_GATE_QUEUE, async (jobs) => {
    for (const job of jobs) {
      if (stopped) return;
      try {
        const run = runBumpGateJob(deps, job.data);
        inFlight.add(run);
        const result = await run.finally(() => inFlight.delete(run));
        console.info(
          `[dependency-bump-gate] change ${job.data.changeObjectId}: ${
            result.merged ? "MERGED" : `not merged (${result.refusal})`
          } — ${result.detail}`
        );
      } catch (err) {
        // Per JOB, so one org's bad bump cannot stop another's. Swallowed with a loud log rather
        // than rethrown: the derivation re-runs on the next observed event, and a wedged queue
        // would silently stop every org's merges.
        console.error(
          `[dependency-bump-gate] change ${job.data.changeObjectId} (org ${job.data.orgId}) failed:`,
          err
        );
      }
    }
  });
  return {
    async stop() {
      stopped = true;
      await Promise.allSettled([...inFlight]);
    }
  };
}
