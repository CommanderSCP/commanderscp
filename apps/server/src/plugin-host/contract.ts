import type {
  ScheduleSpec,
  AbortResult,
  BundleRef,
  ControlOutcome,
  ControlRequest,
  Cursor,
  DeliveryResult,
  DependencyIndexCapabilities,
  DependencyIndexDigestResult,
  DependencyIndexEcosystem,
  DependencyIndexQuery,
  DependencyIndexResult,
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
import type { ReadFileAtRefRequest, ReadFileAtRefResult } from "@scp/git-provider-core";

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
  /** OPTIONAL, mirroring `ExecutorPlugin.ensureSchedule` — present on the client for every
   *  instance, but a plugin that does not implement it answers with a refusal rather than
   *  silently succeeding, so a caller must still gate on `describeCapabilities().supportsSchedules`
   *  (or on the method's own absence) before assuming a schedule was declared. */
  ensureSchedule?(spec: ScheduleSpec): Promise<void>;
  removeSchedule?(scheduleId: string): Promise<void>;
}

/** ControlPlugin's client shape. See docs/plugin-host.md §17. */
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

/** M8 counterpart for `FederationTransportPlugin`. See docs/plugin-host.md §18. */
export interface FederationTransportPluginClient {
  push(segment: JournalSegment): Promise<void>;
  pull(cursor: DomainCursor): Promise<JournalSegment[]>;
  exportBundle(opts: ExportOptions): Promise<BundleRef>;
  importBundle(bundle: BundleRef): Promise<ImportReport>;
}

/** M21.4 counterpart for a `DependencyIndexPlugin` instance. See docs/plugin-host.md §19. */
export interface DependencyIndexPluginClient {
  listVersions(query: DependencyIndexQuery): Promise<DependencyIndexResult>;
  resolveDigest(ref: {
    ecosystem: DependencyIndexEcosystem;
    coordinate: string;
    version: string;
  }): Promise<DependencyIndexDigestResult>;
  describeIndex(): Promise<DependencyIndexCapabilities>;
}

/** Reading one file out of a user repo at a ref. See docs/plugin-host.md §20. */
export interface GitFileReadPluginClient {
  readFileAtRef(request: ReadFileAtRefRequest): Promise<ReadFileAtRefResult>;
}

/** Every in-repo plugin module a subprocess can load. See docs/plugin-host.md §21. */
export type PluginModule =
  | "fake-executor"
  | "webhook-control"
  | "scan-result-control"
  | "github-check"
  | "github"
  | "github-discovery"
  | "gitea"
  | "gitea-discovery"
  | "gitlab"
  | "gitlab-discovery"
  | "argocd"
  | "argocd-discovery"
  | "argo-workflows"
  | "terraform"
  | "pipeline-generic"
  | "managed-iac"
  | "managed-scan"
  // M21.5 — the third managed executor (charter `scp-managed-dep` amendment 2026-08-13).
  | "managed-dep"
  | "webhook-notify"
  | "smtp-notify"
  | "federation-https"
  // M21.4 (ADR-0032 §7) adds the five `dependency-index` modules — one per ecosystem, because ONE
  // subprocess-hosted instance loads exactly one plugin. Four of them live in a single package
  // (`@scp/plugin-dependency-index-registries`) under distinct module names, exactly as
  // `github`/`github-discovery` do; `dependency-index-oci` is its own package because it reaches a
  // registry through the vendored-skopeo channel rather than over `ctx.http`.
  | "dependency-index-go"
  | "dependency-index-npm"
  | "dependency-index-pypi"
  | "dependency-index-maven"
  | "dependency-index-oci";

export interface PluginHostInstanceConfig {
  /** Stable id referenced by `change_wave_targets.executor_plugin_id` / `executor_bindings.plugin_instance_id`
   *  (executor instances), `control_bindings.plugin_instance_id` (control instances, M4), or
   *  `notification_bindings.plugin_instance_id` (M7). */
  id: string;
  module: PluginModule;
  orgId: string;
  /** Opaque plugin-host scope key injected as `PluginContext.scopeKey` — a partition label for
   *  logs/secrets/egress accounting, NOT a trust- or containment-domain id (ADR-0021 D4). */
  scopeKey: string;
  config?: unknown;
  /** Already-decrypted secret values for this instance. See docs/plugin-host.md §22. */
  secrets?: Record<string, string>;
  /** The egress allowlist for this instance's HTTP client. See docs/plugin-host.md §23. */
  allowedHosts?: string[];
  /** Relax the SSRF egress guard's internal-IP block. See docs/plugin-host.md §24. */
  allowInternalEgress?: boolean;
}

export interface PluginHost {
  start(instances: PluginHostInstanceConfig[]): Promise<void>;
  stop(): Promise<void>;
  /** Stop and forget just these, leaving the others running. See docs/plugin-host.md §25. */
  stopInstances(instanceIds: readonly string[]): Promise<void>;
  executor(instanceId: string): ExecutorPluginClient;
  control(instanceId: string): ControlPluginClient;
  discovery(instanceId: string): DiscoveryPluginClient;
  notification(instanceId: string): NotificationPluginClient;
  federationTransport(instanceId: string): FederationTransportPluginClient;
  dependencyIndex(instanceId: string): DependencyIndexPluginClient;
  gitFileRead(instanceId: string): GitFileReadPluginClient;
}
