import type { ScheduleSpec, PluginContext, TriggerIntent } from "@scp/plugin-api";
import { createFakeExecutorPlugin } from "@scp/plugin-fake-executor";
import type {
  ControlPluginClient,
  DependencyIndexPluginClient,
  DiscoveryPluginClient,
  ExecutorPluginClient,
  FederationTransportPluginClient,
  GitFileReadPluginClient,
  NotificationPluginClient,
  PluginHost
} from "../../plugin-host/contract.js";

/**
 * An in-process `PluginHost` for coordination-engine tests that need a fast, deterministic
 * `ExecutorPlugin` to drive `coordination/reconcile.ts`'s DB orchestration logic against, WITHOUT
 * paying for real subprocess isolation — that's already exercised end to end by
 * `plugin-host/host.test.ts` and `coordination.integration.test.ts`'s "crash resumption" suite.
 * Wraps the exact same `@scp/plugin-fake-executor` the real `SubprocessPluginHost` uses, so
 * trigger/status/rollback/idempotency-dedup semantics are identical; only the process-boundary
 * transport is skipped.
 */
/** What the probe driver declared to this fixture, in order. Reset per fixture instance. */
export const declaredSchedules: ScheduleSpec[] = [];
export const removedSchedules: string[] = [];

export function createInMemoryFakeHost(config?: unknown): PluginHost {
  declaredSchedules.length = 0;
  removedSchedules.length = 0;
  const plugin = createFakeExecutorPlugin();
  const ctx: PluginContext = {
    orgId: "test",
    scopeKey: "test",
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    secrets: { get: async () => undefined },
    http: {
      request: async () => {
        throw new Error("createInMemoryFakeHost: fixture never calls ctx.http");
      }
    },
    config: config ?? {}
  };
  const client: ExecutorPluginClient = {
    observe: (since) => plugin.observe(ctx, since),
    trigger: (intent) => plugin.trigger(ctx, intent),
    status: (ref) => plugin.status(ctx, ref),
    abort: (ref) => plugin.abort(ctx, ref),
    describeCapabilities: async () => plugin.describeCapabilities(),
    // Records what the driver DECLARED, so a test can assert the schedule rather than only that
    // the call did not throw. The fixture deliberately implements both verbs: a fake that omitted
    // them would make the driver's capability gate skip silently and every assertion vacuous.
    ensureSchedule: async (spec) => {
      declaredSchedules.push(spec);
    },
    removeSchedule: async (scheduleId) => {
      removedSchedules.push(scheduleId);
    }
  };
  return {
    async start() {
      // Nothing to spawn — the "instance" is just the in-memory plugin object above.
    },
    async stop() {
      // Nothing to tear down.
    },
    async stopInstances() {
      // Nothing to tear down — there is no child process behind this fixture's "instances".
    },
    executor(_instanceId: string): ExecutorPluginClient {
      return client;
    },
    control(_instanceId: string): ControlPluginClient {
      throw new Error(
        "createInMemoryFakeHost: no ControlPlugin fixture wired — this test only drives ExecutorPlugin"
      );
    },
    discovery(_instanceId: string): DiscoveryPluginClient {
      throw new Error(
        "createInMemoryFakeHost: no DiscoveryPlugin fixture wired — this test only drives ExecutorPlugin"
      );
    },
    notification(_instanceId: string): NotificationPluginClient {
      throw new Error(
        "createInMemoryFakeHost: no NotificationPlugin fixture wired — this test only drives ExecutorPlugin"
      );
    },
    federationTransport(_instanceId: string): FederationTransportPluginClient {
      throw new Error(
        "createInMemoryFakeHost: no FederationTransportPlugin fixture wired — this test only drives ExecutorPlugin"
      );
    },
    dependencyIndex(_instanceId: string): DependencyIndexPluginClient {
      throw new Error(
        "createInMemoryFakeHost: no DependencyIndexPlugin fixture wired — this test only drives ExecutorPlugin"
      );
    },
    gitFileRead(_instanceId: string): GitFileReadPluginClient {
      throw new Error(
        "createInMemoryFakeHost: no git-provider readFileAtRef fixture wired — this test only drives ExecutorPlugin"
      );
    }
  };
}

export interface FiredTriggerCall {
  targetRef: string;
  idempotencyKey?: string | undefined;
  externalId: string;
  faulted: boolean;
}

/**
 * Wraps a real `PluginHost` and makes its `trigger()` throw once per `targetRef` matching
 * `shouldFail`, AFTER the wrapped call has already completed for real — simulating a worker that
 * crashes (or a tick whose transaction aborts) in the window between an external `trigger()` call
 * succeeding and the engine recording that fact (coordination/reconcile.ts's `triggerWaveTarget`
 * doc comment, PR #7 review CRITICAL #2 / MAJOR #7). Used to prove: (a) the SAME idempotencyKey on
 * the inevitable retry gets deduped by the executor rather than firing a second real run, and (b)
 * one target's injected failure never rolls back or blocks a sibling change's progress in the same
 * tick — `shouldFail` lets a test fault ONE change's target while leaving a sibling change's
 * target to complete normally in the very same `reconcileOrgTick` call.
 */
/** `calls` logs EVERY `trigger()` invocation that passes through the returned host — including
 *  ones for orgs/changes completely unrelated to whatever this test cares about. A real
 *  reconcile loop started against a shared test database (`runReconcileSweep` sweeps every org
 *  unconditionally) will happily also advance leftover pending work from OTHER already-finished
 *  describe blocks in the same file. Callers MUST filter `calls` by `targetRef` (the specific
 *  target object id under test) before asserting anything about call count/order — never assume
 *  `calls` only ever contains entries for the target this particular test created. */
/**
 * Wraps a real `PluginHost` and makes `trigger()` throw BEFORE the wrapped call runs, every time,
 * for any `targetRef` matching `shouldRefuse` — the executor REFUSING the request outright.
 *
 * Deliberately a different fault from {@link withFailOnceAfterRealTrigger}, which faults ONCE and
 * only AFTER the real side effect already fired (a crash in the record window). This one models the
 * measured production case: Argo CD answering `HTTP 400` because an operation is already running on
 * that Application, so nothing happened externally and the same answer comes back until the
 * contention clears. The distinction matters to `triggerWaveTarget` — a crash must be retried
 * immediately (the row's `attempt` never advanced), a refusal must be backed off.
 */
export function withRefusingTrigger(
  inner: PluginHost,
  shouldRefuse: (targetRef: string) => boolean = () => true
): { host: PluginHost; calls: FiredTriggerCall[] } {
  const calls: FiredTriggerCall[] = [];
  const host: PluginHost = {
    start: (configs) => inner.start(configs),
    stop: () => inner.stop(),
    stopInstances: (ids) => inner.stopInstances(ids),
    control: (instanceId) => inner.control(instanceId),
    discovery: (instanceId) => inner.discovery(instanceId),
    notification: (instanceId) => inner.notification(instanceId),
    federationTransport: (instanceId) => inner.federationTransport(instanceId),
    dependencyIndex: (instanceId) => inner.dependencyIndex(instanceId),
    gitFileRead: (instanceId) => inner.gitFileRead(instanceId),
    executor(instanceId) {
      const real = inner.executor(instanceId);
      return {
        ...real,
        trigger: async (intent) => {
          const targetRef = intent.targetRef ?? "";
          if (shouldRefuse(targetRef)) {
            calls.push({
              targetRef,
              idempotencyKey: intent.idempotencyKey,
              externalId: "",
              faulted: true
            });
            // Shaped like the real one: `packages/plugins/argocd` surfaces a refusal as an RPC
            // error whose message carries the HTTP status.
            throw new Error(`argocd trigger: sync returned HTTP 400 (injected, test only)`);
          }
          const result = await real.trigger(intent);
          calls.push({
            targetRef,
            idempotencyKey: intent.idempotencyKey,
            externalId: result.externalId,
            faulted: false
          });
          return result;
        }
      };
    }
  };
  return { host, calls };
}

export function withFailOnceAfterRealTrigger(
  inner: PluginHost,
  shouldFail: (targetRef: string) => boolean = () => true,
  /** Fired synchronously, right before the throw — a test that needs to react to the fault
   *  IMMEDIATELY (e.g. tearing down the "worker" before its own next tick can retry and self-heal,
   *  racing a 1s reconcile interval under unpredictable test-suite load) should hook this rather
   *  than polling DB state, which can't reliably win that race on a loaded CI box. */
  onFault?: (targetRef: string) => void
): {
  host: PluginHost;
  calls: FiredTriggerCall[];
} {
  const faultedOnce = new Set<string>();
  const calls: FiredTriggerCall[] = [];
  const host: PluginHost = {
    start: (configs) => inner.start(configs),
    stop: () => inner.stop(),
    stopInstances: (ids) => inner.stopInstances(ids),
    control: (instanceId) => inner.control(instanceId),
    discovery: (instanceId) => inner.discovery(instanceId),
    notification: (instanceId) => inner.notification(instanceId),
    federationTransport: (instanceId) => inner.federationTransport(instanceId),
    dependencyIndex: (instanceId) => inner.dependencyIndex(instanceId),
    gitFileRead: (instanceId) => inner.gitFileRead(instanceId),
    executor(instanceId) {
      const real = inner.executor(instanceId);
      return {
        ...real,
        trigger: async (intent) => {
          const result = await real.trigger(intent);
          const targetRef = intent.targetRef ?? "";
          const shouldFaultThisCall = shouldFail(targetRef) && !faultedOnce.has(targetRef);
          calls.push({
            targetRef,
            idempotencyKey: intent.idempotencyKey,
            externalId: result.externalId,
            faulted: shouldFaultThisCall
          });
          if (shouldFaultThisCall) {
            faultedOnce.add(targetRef);
            onFault?.(targetRef);
            throw new Error(
              `injected fault (test only): simulating a crash between trigger() succeeding for '${targetRef}' and its result being committed`
            );
          }
          return result;
        }
      };
    }
  };
  return { host, calls };
}

/**
 * M25.4 — records the WHOLE `TriggerIntent`, and optionally narrows what the executor says it can
 * do.
 *
 * TWO THINGS THE EXISTING WRAPPERS CANNOT DO, both needed to test a recipe honestly:
 *
 *   * `FiredTriggerCall` keeps `targetRef` and `idempotencyKey` only, so a recipe's `parameters`
 *     and its `kind` — the two fields M25.4 exists to put on the wire — are invisible to every
 *     assertion built on it. A test that asserted only "trigger was called" would pass with the
 *     channel still unwired, which is exactly the vacuous green this repo has paid for repeatedly.
 *   * `@scp/plugin-fake-executor` declares ALL FOUR trigger kinds, so no capability refusal is
 *     reachable through it. `triggerKinds` narrows that to a REAL adapter's set (`argocd` is
 *     `["sync","rollback"]`, `github` is `["workflow_dispatch","custom"]` — measured at HEAD) so the
 *     refusal is exercised against a shape production actually produces.
 *
 * `intents` logs EVERY call through this host — see `FiredTriggerCall`'s warning; filter by
 * `targetRef` before asserting counts.
 */
export function withRecordedIntents(
  inner: PluginHost,
  /** Called on EVERY `describeCapabilities()`, never read once at wrap time — one host is shared by
   *  a whole suite, so a case that needs a narrowed executor sets a mutable variable this closure
   *  reads. Returning `undefined` leaves the real fake's declaration alone. */
  triggerKinds?: () => TriggerIntent["kind"][] | undefined
): { host: PluginHost; intents: TriggerIntent[] } {
  const intents: TriggerIntent[] = [];
  const host: PluginHost = {
    start: (configs) => inner.start(configs),
    stop: () => inner.stop(),
    stopInstances: (ids) => inner.stopInstances(ids),
    control: (instanceId) => inner.control(instanceId),
    discovery: (instanceId) => inner.discovery(instanceId),
    notification: (instanceId) => inner.notification(instanceId),
    federationTransport: (instanceId) => inner.federationTransport(instanceId),
    dependencyIndex: (instanceId) => inner.dependencyIndex(instanceId),
    gitFileRead: (instanceId) => inner.gitFileRead(instanceId),
    executor(instanceId) {
      const real = inner.executor(instanceId);
      return {
        ...real,
        describeCapabilities: async () => {
          const declared = await real.describeCapabilities();
          const override = triggerKinds?.();
          return override ? { ...declared, triggerKinds: override } : declared;
        },
        trigger: async (intent) => {
          // Recorded BEFORE the call, so a trigger that throws is still visible to the "zero
          // trigger() calls" assertion the capability refusal is judged on.
          intents.push(intent);
          return real.trigger(intent);
        }
      };
    }
  };
  return { host, intents };
}
