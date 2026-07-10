import type {
  AbortResult,
  ControlOutcome,
  ControlRequest,
  Cursor,
  ExecutionStatus,
  ExecutorCapabilities,
  ExecutorEvent,
  ExternalRunRef,
  TriggerIntent
} from "@scp/plugin-api";

/**
 * The coordination engine's view of the subprocess plugin host (DESIGN.md §11,
 * BUILD_AND_TEST.md §8 M3 item 7). Declared here, ahead of `host.ts`'s implementation, so
 * `coordination/reconcile.ts` and its unit tests can depend on a stable, narrow interface rather
 * than the host's process-management internals — the real `PluginHost` (plugin-host/host.ts)
 * implements this exactly; tests substitute a fake.
 *
 * `executor(instanceId)` returns a client bound to one already-started plugin instance: every
 * call is a JSON-RPC 2.0 round trip to that instance's child process, with host-enforced
 * timeouts and transparent restart-with-backoff on crash — callers never see a dead subprocess,
 * only a slower/retried call (or an error if retries are exhausted within the call timeout).
 */
export interface ExecutorPluginClient {
  observe(since?: Cursor): Promise<ExecutorEvent[]>;
  trigger(intent: TriggerIntent): Promise<ExternalRunRef>;
  status(ref: ExternalRunRef): Promise<ExecutionStatus>;
  abort(ref: ExternalRunRef): Promise<AbortResult>;
  describeCapabilities(): Promise<ExecutorCapabilities>;
}

/**
 * ControlPlugin's client shape (DESIGN.md §11 `ControlPlugin`), M4's counterpart to
 * `ExecutorPluginClient` above — same subprocess host, same timeout/restart-with-backoff
 * guarantees, one method.
 */
export interface ControlPluginClient {
  evaluate(req: ControlRequest): Promise<ControlOutcome>;
}

export interface PluginHostInstanceConfig {
  /** Stable id referenced by `change_wave_targets.executor_plugin_id` (executor instances) or
   *  `control_bindings.plugin_instance_id` (control instances, M4). */
  id: string;
  /** Which in-repo plugin module the spawned subprocess loads. `webhook-control` is M4's
   *  escape-hatch ControlPlugin (DESIGN §10.2); every other value is an ExecutorPlugin module. */
  module: "fake-executor" | "webhook-control";
  orgId: string;
  domainId: string;
  config?: unknown;
}

export interface PluginHost {
  start(instances: PluginHostInstanceConfig[]): Promise<void>;
  stop(): Promise<void>;
  executor(instanceId: string): ExecutorPluginClient;
  control(instanceId: string): ControlPluginClient;
}
