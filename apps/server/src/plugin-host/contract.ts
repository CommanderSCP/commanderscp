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
 * `federation-https`, a `FederationTransportPlugin`. M15.1b adds `gitea`, a second git-provider
 * `ExecutorPlugin` built (like `github`) on `@scp/git-provider-core`; M15.3a adds `gitea-discovery`,
 * gitea's separate `DiscoveryPlugin` export (same package, distinct module — like github/github-discovery).
 * M17.1 adds `scan-result-control`, a second `ControlPlugin` (sibling of `webhook-control`) that
 * turns a coordinated Trivy scan verdict into gate evidence (ADR-0013).
 */
export type PluginModule =
  | "fake-executor"
  | "webhook-control"
  | "scan-result-control"
  | "github"
  | "github-discovery"
  | "gitea"
  | "gitea-discovery"
  | "argocd"
  | "argocd-discovery"
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
  /** Relax the SSRF egress guard's internal-IP block (loopback/private ranges) for THIS instance's
   *  `ctx.http` — so a self-hosted SCP can coordinate an execution system reachable only at a private
   *  address (an in-cluster Argo CD ClusterIP, an on-prem executor by RFC1918 IP; charter principle 5
   *  "self-hosting & air-gap first-class"). `linkLocal`/`unspecified` (cloud metadata) stay blocked
   *  for every plugin regardless.
   *
   *  NEVER set this from anything a tenant can write. It is computed ONLY by
   *  `executor-bindings-repo.ts`'s `resolveInternalEgress`, which requires BOTH layers to agree
   *  (ADR-0003): (1) the operator's host-level `SCP_INTERNAL_EGRESS_HOSTS` allowlist — the hard
   *  boundary, same trust tier as `SCP_MANAGED_IAC_RUNNER_IMAGE`/`SCP_FEDERATION_MTLS_*`, unset by
   *  default ⇒ nothing is ever reachable; and (2) the execution-system's `allowInternalEgress`
   *  property — a per-system DECLARATION of intent, not a grant. Deliberately layered so that graph
   *  state or an RBAC misconfiguration can never, on its own, produce an SSRF: a tenant who declares
   *  the property on a system pointing at an un-allowlisted host gets nothing (egress-guard.ts,
   *  MAJOR #6). Threaded to the subprocess via its own env var (host.ts) so tenant `config`/`secrets`
   *  can neither reach nor override it. Omitted/false is the fail-closed default. */
  allowInternalEgress?: boolean;
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
