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

/** The production caller for internal release detection. See docs/dependencies.md §243. */

export const INTERNAL_RELEASE_QUEUE = "dependency-internal-release";

/** The event type this capability reacts to, and the state that matters. Both are checked; the
 *  state is then RE-READ from the row by `detectInternalReleases`, because the event is delivered
 *  out of band and a change can move on between the transition and the handler. */
export const CHANGE_TRANSITIONED_EVENT = "scp.change.transitioned";
export const ACCEPTED_STATE = "accepted";

export type InternalReleaseRoleVerdict = CommanderOnlyVerdict;

/** MAY THIS PROCESS DERIVE INTERNAL RELEASES? See docs/dependencies.md §244. */
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

/** The fan-out point on the shared domain-event stream. See docs/dependencies.md §245. */
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

/** Register the capability's worker. See docs/dependencies.md §246. */
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
