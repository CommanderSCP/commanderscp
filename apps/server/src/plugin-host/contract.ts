import type {
  AbortResult,
  BundleRef,
  ControlOutcome,
  ControlRequest,
  Cursor,
  DeliveryResult,
  DiscoveryProposal,
  DomainCursor,
  ExecutionStatus,
  ExecutorCapabilities,
  ExecutorEvent,
  ExportOptions,
  ExternalRunRef,
  ImportReport,
  JournalSegment,
  NotificationMessage,
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

/** M7 counterpart to `ExecutorPluginClient`/`ControlPluginClient` for `DiscoveryPlugin` (github
 *  repo/topology scan — DESIGN §11/§12). */
export interface DiscoveryPluginClient {
  discover(): Promise<DiscoveryProposal>;
}

/** M7 counterpart for `NotificationPlugin` (smtp-notify/webhook-notify — DESIGN §11). */
export interface NotificationPluginClient {
  send(msg: NotificationMessage): Promise<DeliveryResult>;
}

/** M8 counterpart for `FederationTransportPlugin` (`federation-https` — DESIGN §13). Subprocess
 *  hosting so this transport runs under the same host-enforced timeout/restart-with-backoff/
 *  egress-guard machinery as every other network-calling plugin, and so its mTLS client
 *  certificate (subprocess-entry.ts's `loadFederationMtlsMaterial`) is presented on a connection
 *  this process's own `ScopedHttpClient` controls, never a raw fetch bypassing the plugin host. */
export interface FederationTransportPluginClient {
  push(segment: JournalSegment): Promise<void>;
  pull(cursor: DomainCursor): Promise<JournalSegment[]>;
  exportBundle(opts: ExportOptions): Promise<BundleRef>;
  importBundle(bundle: BundleRef): Promise<ImportReport>;
}

/**
 * Every in-repo plugin module a subprocess can load (subprocess-entry.ts's `loadPlugin` switch is
 * the single source of truth this union must stay in sync with). M7 widens this from M3/M4's
 * closed `"fake-executor" | "webhook-control"` pair: `github`/`argocd`/`terraform`/`managed-iac`
 * are `ExecutorPlugin`s, `github-discovery` is github's separate `DiscoveryPlugin` export (a
 * distinct module name because ONE subprocess-hosted instance loads exactly one plugin `kind` —
 * an org that wants both github's executor AND its discovery scan configures two instances, same
 * package, two module names), `webhook-notify`/`smtp-notify` are `NotificationPlugin`s. M8 adds
 * `federation-https`, a `FederationTransportPlugin`.
 */
export type PluginModule =
  | "fake-executor"
  | "webhook-control"
  | "github"
  | "github-discovery"
  | "argocd"
  | "terraform"
  | "managed-iac"
  | "webhook-notify"
  | "smtp-notify"
  | "federation-https";

export interface PluginHostInstanceConfig {
  /** Stable id referenced by `change_wave_targets.executor_plugin_id` / `executor_bindings.plugin_instance_id`
   *  (executor instances), `control_bindings.plugin_instance_id` (control instances, M4), or
   *  `notification_bindings.plugin_instance_id` (M7). */
  id: string;
  module: PluginModule;
  orgId: string;
  domainId: string;
  config?: unknown;
  /** Resolved (plaintext, already-decrypted) secret values for this instance — M7's
   *  `executor_bindings`/`notification_bindings` `secretRefs` resolved via
   *  `secrets/secrets-repo.ts`'s `resolveSecretRefs` BEFORE this config ever reaches `host.start()`.
   *  Never logged; injected into the subprocess only via env (subprocess-entry.ts's
   *  `SCP_PLUGIN_SECRETS_JSON`), read into an in-memory `SecretsAccessor`, never written to disk. */
  secrets?: Record<string, string>;
  /** Egress allowlist (SSRF mitigation) for this instance's `PluginContext.http` — hostnames (not
   *  URLs) a `ScopedHttpClient.request()` call may target. Empty/omitted preserves M3/M4's
   *  unscoped behavior (needed by `webhook-control`, whose entire point is POSTing to an
   *  operator-configured arbitrary URL) — every M7 network-calling plugin (github/argocd/
   *  webhook-notify) sets this explicitly from its own binding config instead. */
  allowedHosts?: string[];
}

export interface PluginHost {
  start(instances: PluginHostInstanceConfig[]): Promise<void>;
  stop(): Promise<void>;
  executor(instanceId: string): ExecutorPluginClient;
  control(instanceId: string): ControlPluginClient;
  discovery(instanceId: string): DiscoveryPluginClient;
  notification(instanceId: string): NotificationPluginClient;
  federationTransport(instanceId: string): FederationTransportPluginClient;
}
