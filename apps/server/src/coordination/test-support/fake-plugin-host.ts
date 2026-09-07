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

/** An in-process host for fast, deterministic executor tests. See docs/coordination.md §998. */
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

/** Makes trigger throw once per target reference. See docs/coordination.md §999. */
/** `calls` logs every trigger passing through the host. See docs/coordination.md §1000. */
/** Makes trigger throw before the wrapped call runs. See docs/coordination.md §1001. */
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

/** Records the whole trigger intent, narrowing if asked. See docs/coordination.md §1002. */
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
