import type { PluginContext } from "@scp/plugin-api";
import { createFakeExecutorPlugin } from "@scp/plugin-fake-executor";
import type {
  ControlPluginClient,
  DiscoveryPluginClient,
  ExecutorPluginClient,
  FederationTransportPluginClient,
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
export function createInMemoryFakeHost(config?: unknown): PluginHost {
  const plugin = createFakeExecutorPlugin();
  const ctx: PluginContext = {
    orgId: "test",
    domainId: "test",
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
    describeCapabilities: async () => plugin.describeCapabilities()
  };
  return {
    async start() {
      // Nothing to spawn — the "instance" is just the in-memory plugin object above.
    },
    async stop() {
      // Nothing to tear down.
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
    control: (instanceId) => inner.control(instanceId),
    discovery: (instanceId) => inner.discovery(instanceId),
    notification: (instanceId) => inner.notification(instanceId),
    federationTransport: (instanceId) => inner.federationTransport(instanceId),
    executor(instanceId) {
      const real = inner.executor(instanceId);
      return {
        ...real,
        trigger: async (intent) => {
          const result = await real.trigger(intent); // the real side effect fires for real.
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
