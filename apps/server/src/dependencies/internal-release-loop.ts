import type PgBoss from "pg-boss";
import type { Db } from "../db/client.js";
import type { ServerConfig } from "../config.js";
import type { PluginHost } from "../plugin-host/contract.js";
import type { DomainEventJob, DomainEventRouter } from "../events/pgboss.js";
import {
  detectInternalReleases,
  type InternalReleaseOutcome
} from "./internal-release-detection.js";
import { createGitProviderManifestReader } from "./manifest-reader.js";
import {
  commanderOnlyJobVerdict,
  type CommanderOnlyConfig,
  type CommanderOnlyVerdict
} from "./commander-only.js";

/**
 * M21.4 — THE PRODUCTION CALLER FOR INTERNAL RELEASE DETECTION (ADR-0032 §7).
 *
 * ============================================================================================
 * WITHOUT THIS FILE, HALF THE FEATURE NEVER RAN
 * ============================================================================================
 * `detectInternalReleases` is the whole internal ingress: it is what puts a head on a line the org
 * PRODUCES, and it is what the third-party poll is forbidden to touch (§7b clause 1). It was built
 * with no caller. Measured filterlessly at the time: the only references to it in the tree were its
 * own definition and its own test, and `scp.change.transitioned` — the event it derives from — had
 * ZERO server-side consumers, because `DOMAIN_EVENTS_QUEUE`'s handler only logged. A subscriber to
 * an internal line would have waited forever, with `latest_version` null and no error anywhere.
 *
 * ============================================================================================
 * THE SHAPE: ROUTE ON THE SHARED STREAM, WORK ON THIS CAPABILITY'S OWN QUEUE
 * ============================================================================================
 * `boss.work()` is a competing consumer, so this cannot be a second worker on the domain-event
 * queue (see `events/pgboss.ts`'s `DomainEventRouter`). Instead:
 *
 *   outbox → domain-events → {@link acceptedChangeRouter} (one cheap predicate + one enqueue)
 *          → {@link INTERNAL_RELEASE_QUEUE} → this file's worker → detectInternalReleases
 *
 * which is exactly the one-queue-per-capability pattern reconcile/observe/watchdog/inbox/auto-relay
 * and the dependency version poll already use in `main.ts` — the difference being that those are
 * self-rescheduling TIMERS and this one is EVENT-DRIVEN, because a release is an event and a daily
 * sweep over every accepted change would be both slower and heavier.
 *
 * ============================================================================================
 * IDEMPOTENT UNDER REDELIVERY, AT EVERY HOP
 * ============================================================================================
 * The outbox→pg-boss path is AT-LEAST-ONCE, and there are now two hops that can each redeliver. It
 * does not matter, because nothing on this path appends:
 *
 *  - the head write goes through `recordDependencyLineHead`, which re-reads `FOR UPDATE` and
 *    DECIDES — a restatement of the same version is a no-op write of the same values;
 *  - the verdict goes through `insertDecisionIfChanged`, whose inputs are stable facts only (no
 *    timestamps, everything sorted), so a second derivation of the same accept compares equal and
 *    writes NO new row;
 *  - the state is re-READ rather than trusted from the event, so a change that has since moved on
 *    yields `not_applicable` instead of a stale derivation.
 *
 * A permanent test drives the same change twice and asserts the second run creates nothing.
 *
 * ============================================================================================
 * THE ROLE REASONING — COMMANDER-ONLY (ADR-0032 §7d, owner decision 2026-08-17)
 * ============================================================================================
 * The version poll is guarded on TWO axes (`dependencyVersionPollRoleGuard`): the PROCESS split
 * (`SCP_ROLE`) and the DEPLOYMENT's declared federation role (`SCP_FEDERATION_ROLE` — commander
 * only, and explicitly declared). BOTH apply here too.
 *
 * This paragraph previously argued the opposite — at length, citing ADR-0032 §3 clause 3, and
 * concluding that "restricting to a commander would break the feature". That argument is WRONG. It
 * is restated and answered here rather than deleted, because it is persuasive and the next reader
 * of this file is exactly the person who could remove the guard on the strength of it; ADR-0032 §7d
 * preserves the original clause verbatim beside the reasoning that overturned it.
 *
 *  - THE PROCESS AXIS APPLIES UNCHANGED. This is background work; an `api` process must stay a
 *    request server. Same rule, same reason, and `main.ts` additionally only reaches this inside its
 *    `runsBackgroundWork` branch — the guard is what makes that a property of the job rather than of
 *    where someone happened to call it.
 *
 *  - THE FEDERATION AXIS APPLIES TOO: commander only, fail-closed on an undeclared role. THE
 *    OWNER'S REASON is not about egress at all. The point of dependency automation is to PULL FROM
 *    PUBLIC REPOSITORIES — Python library versions, CDK versions, base-image versions — which is
 *    not needed from an outpost standpoint, because the resulting change GETS PUSHED DOWN THE
 *    GLOBAL PIPELINE THE COMMANDER MANAGES. An outpost never ORIGINATES a dependency bump; it
 *    RECEIVES the resulting change through the ordinary promotion path. So an outpost derives no
 *    inventory and detects no releases for this feature, and what it used to derive fed nothing:
 *    the only consumer is a bump, and `bumpDispatchRoleGuard` has been commander-only since M21.5.
 *
 *    THE OLD ARGUMENT'S MEASUREMENT SURVIVES AND BECOMES THE STATED COST. It is true that an
 *    outpost is where the evidence LIVES: `change_wave_targets.status`/`observed_state.images` are
 *    written where the change executed, while a commander receives only `change_status` journal
 *    entries (`{objectId, fromState, toState, trigger}` — no wave targets, no images). So an
 *    internal line whose component releases to prod only at an outpost keeps a NULL
 *    `latest_version`. ADR-0032 §7's schema note already defines NULL as "not observed" and
 *    explicitly NOT "nothing newer exists", so a subscriber sees an honest absence rather than a
 *    wrong version — which is the ordering §7a rule 1 fixes. This is a real reduction in reach and
 *    is recorded as ADR-0032 §7d clause 2, not papered over.
 *
 *    THE OTHER ACCEPTED CONSEQUENCE: dependencies declared in DOMAIN-SPECIFIC repositories —
 *    outpost-only IaC/CaC the commander never sees — are OUT OF SCOPE for dependency
 *    subscriptions. The owner accepted that explicitly; there is no workaround, and the shape that
 *    would be one is an outpost-side job.
 *
 * Scope of the reversal: the SUBSCRIPTION still federates (a `dependencySubscription` effect on an
 * ordinary `policy` object, ADR-0032 §3a) and still reaches an outpost. Only the JOBS and the
 * projection tables they write are commander-only.
 */

export const INTERNAL_RELEASE_QUEUE = "dependency-internal-release";

/** The event type this capability reacts to, and the state that matters. Both are checked; the
 *  state is then RE-READ from the row by `detectInternalReleases`, because the event is delivered
 *  out of band and a change can move on between the transition and the handler. */
export const CHANGE_TRANSITIONED_EVENT = "scp.change.transitioned";
export const ACCEPTED_STATE = "accepted";

export type InternalReleaseRoleVerdict = CommanderOnlyVerdict;

/**
 * MAY THIS PROCESS DERIVE INTERNAL RELEASES? See the module doc for why this asks the poll's two
 * questions and now keeps BOTH of them, and `commander-only.ts` for why the predicate is SHARED
 * rather than re-spelled here — the fail-closed undeclared branch has five callers and is the one
 * that regresses invisibly.
 */
export function internalReleaseDetectionRoleGuard(
  config: CommanderOnlyConfig
): InternalReleaseRoleVerdict {
  return commanderOnlyJobVerdict(config, "internal dependency release detection");
}

/** True for the one event shape this capability reacts to. Exported so a test can pin the predicate
 *  without a queue: a router that matched too widely would enqueue a job per transition. */
export function isAcceptedChangeEvent(event: DomainEventJob): boolean {
  if (event.type !== CHANGE_TRANSITIONED_EVENT) return false;
  const data = event.data;
  if (data === null || typeof data !== "object") return false;
  return (data as { toState?: unknown }).toState === ACCEPTED_STATE;
}

/** What {@link acceptedChangeRouter} puts on {@link INTERNAL_RELEASE_QUEUE}. */
export interface InternalReleaseJob {
  orgId: string;
  changeObjectId: string;
}

/**
 * The fan-out point on the shared domain-event stream: one predicate, one enqueue, no work.
 *
 * The subject of `scp.change.transitioned` IS the change object id (`coordination/transition.ts`),
 * which is the only identifier this capability needs — it re-derives everything else from the row.
 */
export function acceptedChangeRouter(): DomainEventRouter {
  return {
    name: "dependency-internal-release",
    queue: INTERNAL_RELEASE_QUEUE,
    async route(boss: PgBoss, event: DomainEventJob): Promise<void> {
      if (!isAcceptedChangeEvent(event)) return;
      const changeObjectId = event.subject;
      if (typeof changeObjectId !== "string" || changeObjectId === "") return;
      const job: InternalReleaseJob = { orgId: event.orgId, changeObjectId };
      // `singletonKey` collapses a redelivery of the SAME accept that arrives while an earlier job
      // for it is still queued. It is a cheap optimisation, never the correctness argument — the
      // derivation is idempotent, which is what actually makes at-least-once safe here.
      await boss.send(INTERNAL_RELEASE_QUEUE, job, { singletonKey: changeObjectId });
    }
  };
}

export interface InternalReleaseLoopHandle {
  stop(): Promise<void>;
}

export interface InternalReleaseLoopDeps {
  db: Db;
  host: PluginHost;
  config: CommanderOnlyConfig & Pick<ServerConfig, "secretsMasterKey">;
}

/**
 * Run ONE queued job. Exported so an integration test can drive the exact function the worker runs
 * rather than a copy of it.
 */
export async function runInternalReleaseJob(
  deps: InternalReleaseLoopDeps,
  job: InternalReleaseJob
): Promise<InternalReleaseOutcome> {
  return detectInternalReleases(deps.db, job.orgId, {
    changeObjectId: job.changeObjectId,
    // THE READER IS ALWAYS SUPPLIED NOW, and that is the point of M21.4's plugin-host wiring: with
    // it absent, every npm/python/maven line recorded nothing under `manifest_reader_unavailable`.
    // It resolves the git-provider instance from the RELEASED REPO's own binding, per call — see
    // `manifest-reader.ts`.
    readManifest: createGitProviderManifestReader({
      db: deps.db,
      host: deps.host,
      orgId: job.orgId,
      masterKey: deps.config.secretsMasterKey
    })
  });
}

/**
 * Register the capability's worker. The ROUTER half is registered separately, by
 * `events/domain-event-registry.ts` under this module's own guard, so the two halves are wired
 * without either knowing about the other's internals.
 *
 * A REFUSED ROLE RETURNS AN INERT HANDLE AND NEVER CREATES THE QUEUE — the same shape the version
 * poll, the inbox loop and the auto-relay loop use, and for the same reason: a process that merely
 * skipped the work inside the handler would still hold a pg-boss worker for a queue it will never
 * act on.
 */
export async function startInternalReleaseLoop(
  boss: PgBoss,
  deps: InternalReleaseLoopDeps
): Promise<InternalReleaseLoopHandle> {
  const guard = internalReleaseDetectionRoleGuard(deps.config);
  if (!guard.allowed) {
    console.info(`[dependency-internal-release] not started: ${guard.reason}`);
    return { async stop() {} };
  }
  console.info(`[dependency-internal-release] STARTING: ${guard.reason}`);

  let stopped = false;
  /** In-flight batches, awaited by `stop()`. A detection run holds a database transaction in its
   *  write phases, and `main.ts`'s `onClose` closes the pool right after stopping the loops — the
   *  same shutdown race `outbox-relay.ts` documents at length. Draining is what keeps a teardown
   *  from tearing the pool out from under a running phase. */
  const inFlight = new Set<Promise<unknown>>();
  await boss.createQueue(INTERNAL_RELEASE_QUEUE);
  await boss.work<InternalReleaseJob>(INTERNAL_RELEASE_QUEUE, async (jobs) => {
    for (const job of jobs) {
      if (stopped) return;
      try {
        const run = runInternalReleaseJob(deps, job.data);
        inFlight.add(run);
        const outcome = await run.finally(() => inFlight.delete(run));
        if (outcome.verdict === "evaluated") {
          console.info(
            `[dependency-internal-release] change ${job.data.changeObjectId}: ${outcome.detail}`
          );
        }
      } catch (err) {
        // Per JOB, so one org's bad change cannot stop another's. Rethrown would retry the whole
        // batch; swallowed with a loud log is right here because the derivation is re-runnable —
        // any later accept on the same line re-derives it — and a wedged queue would silently stop
        // every org's internal detection.
        console.error(
          `[dependency-internal-release] change ${job.data.changeObjectId} (org ${job.data.orgId}) failed:`,
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
