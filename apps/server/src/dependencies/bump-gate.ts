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

/** M21.5 — THE AUTO-MERGE LINK. See docs/dependencies.md §108. */

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

/** Run ONE queued job. See docs/dependencies.md §109. */
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

  // Phase one: the read. See docs/dependencies.md §110.
  const facts = await withTenantTx(deps.db, orgId, async (tx) => {
    const authorship = await readBumpAuthorship(tx, orgId, changeObjectId);
    if (!authorship) return { kind: "no_authorship" as const };
    // Already merged, and this is checked first of all. See docs/dependencies.md §111.
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
      // Controls only, and why the prewarm is narrowed. See docs/dependencies.md §112.
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

  // Phase three-b: the freeze. See docs/dependencies.md §113.
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

  // Phase four: actuate, outside any transaction. See docs/dependencies.md §114.
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
    // ASKED, NOT ASSUMED. See docs/dependencies.md §115.
    const status = await executor.status(ref);
    phase = status.phase;
    detail = status.detail ?? "";
  } catch (err) {
    // A THROW HERE USED TO LEAVE NO DECISION AT ALL. See docs/dependencies.md §116.
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
  // THE MERGE HAPPENED. See docs/dependencies.md §117.
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

/** One Decision per verdict, and why it is if-changed. See docs/dependencies.md §118. */
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

/** Register the capability's worker. See docs/dependencies.md §119. */
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
