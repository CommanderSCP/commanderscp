import type {
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
 * M21.4 counterpart for a `DependencyIndexPlugin` instance (ADR-0032 §7) — the per-ecosystem
 * third-party version index the daily poll asks. Subprocess-hosted for the reason that makes it a
 * plugin at all: the registry URL is operator-CONFIGURABLE (a mirror, an in-cluster Athens/Nexus),
 * and this host is the one seam that applies `egress-guard.ts` and the per-instance `allowedHosts`
 * allowlist to such a URL.
 */
export interface DependencyIndexPluginClient {
  listVersions(query: DependencyIndexQuery): Promise<DependencyIndexResult>;
  resolveDigest(ref: {
    ecosystem: DependencyIndexEcosystem;
    coordinate: string;
    version: string;
  }): Promise<DependencyIndexDigestResult>;
  describeIndex(): Promise<DependencyIndexCapabilities>;
}

/**
 * M21.4 (ADR-0032 §7a) — READING ONE FILE OUT OF A USER REPO AT A REF, from the server.
 *
 * ===========================================================================================
 * THIS IS THE MISSING HALF OF M21.2, AND WITHOUT IT THAT MILESTONE WAS DEAD CODE
 * ===========================================================================================
 * M21.2 built `readFileAtRef` on `GitProviderAdapter` and three adapters implement it — but nothing
 * under `apps/server` could reach it, because NO client shape in this file carried a file-read
 * method and the subprocess dispatched no such RPC. ADR-0032 §7a's language strategies (npm, python,
 * maven) read the producing component's own manifest at the released commit, so with no route they
 * every one recorded nothing under `manifest_reader_unavailable`: the entire "formulated from the
 * users' code" ingress did not exist. This is that route.
 *
 * ===========================================================================================
 * IT IS A SEPARATE CLIENT BECAUSE IT IS A SEPARATE CAPABILITY (ADR-0032 §9)
 * ===========================================================================================
 * It is deliberately NOT a fifth method on {@link ExecutorPluginClient}. The four-verb executor set
 * IS the structural enforcement of charter principle 1 ("coordination, not execution"), and
 * `createExecutorPluginFromAdapter` still refuses to surface this hook — a permanent test in
 * `@scp/git-provider-core` pins that. So the hook is dispatched from the loaded ADAPTER that sits
 * beside the executor plugin in the subprocess (`subprocess-entry.ts`'s `ReadFileHook`), and a
 * caller asks for it through its own accessor. The same instance id addresses both: one git binding
 * is one subprocess, and this read runs under exactly the timeouts, restart-with-backoff, egress
 * allowlist and SSRF guard every other call on that instance does.
 *
 * READ ONLY. There is no write counterpart and ADR-0032 §9 says there will not be one through this
 * seam: the bump actuator (§8) is a managed executor class contingent on a charter amendment, not a
 * verb added here.
 *
 * An instance whose module carries no adapter hook (every non-git-provider executor) REJECTS the
 * call with a message naming that fact — it never answers `not_found`, which would be a claim about
 * the repo rather than about the binding.
 */
export interface GitFileReadPluginClient {
  readFileAtRef(request: ReadFileAtRefRequest): Promise<ReadFileAtRefResult>;
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
 * M15.3b adds `gitlab`, a third git-provider `ExecutorPlugin` (same core) plus `gitlab-discovery`,
 * its separate `DiscoveryPlugin` export (same executor/discovery split).
 * M17.1 adds `scan-result-control`, a second `ControlPlugin` (sibling of `webhook-control`) that
 * turns a coordinated Trivy scan verdict into gate evidence (ADR-0013).
 * M13.3a adds `managed-scan`, a second managed-execution `ExecutorPlugin` (sibling of `managed-iac`,
 * same charter-enumerated pattern): the thin orchestrator behind the commander's promotion scan
 * step, launching ephemeral `scp-runner-scan` containers (ADR-0020 §1). Like `managed-iac` it is a
 * `KNOWN_EXECUTOR_MODULE` and gets server-injected runner settings (executor-bindings-repo.ts).
 * M10.4 adds `github-check`, a third `ControlPlugin` (sibling of `webhook-control`/
 * `scan-result-control`): turns a GitHub Check Run/status verdict for the change's own commit
 * into gate evidence (BUILD_AND_TEST.md §8 M10.4). M10.6 adds `pipeline-generic`, the generic
 * URL-templated `ExecutorPlugin` extracted from `terraform`'s Mode-1 shape (`terraform` becomes a
 * preset of it — same `KNOWN_EXECUTOR_MODULE` allowlist, own module name so an operator can bind
 * the generic executor directly for a pipeline with no dedicated plugin).
 */
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
  /**
   * Stop and forget JUST these instances, leaving every other one running (M21.4).
   *
   * WHY A PARTIAL STOP EXISTS AT ALL. Every pre-M21.4 caller starts a bounded, long-lived set: the
   * reconcile/observe/watchdog loops start an instance per executor BINDING, which is operator
   * configuration that persists, so leaving them up between ticks is the correct behaviour and a
   * partial stop would just re-spawn a child per tick. The dependency version poll is the first
   * caller whose instances are DERIVED FROM ITS OWN WORK-LIST rather than from configuration: it
   * starts a per-(ecosystem, org) index subprocess on demand, and on a multi-tenant commander that
   * accumulated up to five idle children PER ORG for the lifetime of the worker — for a job that
   * runs once a DAY. Nothing was leaked per tick (`start()` skips an id it already holds), so the
   * symptom is a standing process count that grows with tenancy and never falls, which is exactly
   * the kind of cost nobody attributes to a daily poll.
   *
   * Unknown ids are ignored rather than refused: a sweep that failed before starting an instance
   * must still be able to hand its whole intended set to this in a `finally`.
   */
  stopInstances(instanceIds: readonly string[]): Promise<void>;
  executor(instanceId: string): ExecutorPluginClient;
  control(instanceId: string): ControlPluginClient;
  discovery(instanceId: string): DiscoveryPluginClient;
  notification(instanceId: string): NotificationPluginClient;
  federationTransport(instanceId: string): FederationTransportPluginClient;
  dependencyIndex(instanceId: string): DependencyIndexPluginClient;
  gitFileRead(instanceId: string): GitFileReadPluginClient;
}
