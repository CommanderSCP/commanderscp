/** Subprocess plugin host entry point. See docs/plugin-host.md §94. */
import { createInterface } from "node:readline";
import { readFileSync } from "node:fs";
import { rootCertificates } from "node:tls";
import { Agent as UndiciAgent, fetch as undiciFetch } from "undici";
import type {
  ScheduleSpec,
  BundleRef,
  ControlPlugin,
  ControlRequest,
  Cursor,
  DependencyIndexEcosystem,
  DependencyIndexPlugin,
  DependencyIndexQuery,
  DiscoveryPlugin,
  DomainCursor,
  ExecutorPlugin,
  ExportOptions,
  ExternalRunRef,
  FederationTransportPlugin,
  JournalSegment,
  Logger,
  NotificationMessage,
  NotificationPlugin,
  PluginContext,
  ScopedHttpClient,
  ScopedHttpResponse,
  SecretsAccessor,
  TriggerIntent
} from "@scp/plugin-api";
import { scopedHttpResponseTooLargeError } from "@scp/plugin-api";
import type { ReadFileAtRefRequest, ReadFileAtRefResult } from "@scp/git-provider-core";
import { encodeMessage, parseMessage, type RpcRequest } from "./rpc-protocol.js";
import { assertEgressAllowed, createEgressPinRegistry } from "./egress-guard.js";

/** The file-read hook that rides alongside an executor. See docs/plugin-host.md §95. */
type ReadFileHook = (
  ctx: PluginContext,
  request: ReadFileAtRefRequest
) => Promise<ReadFileAtRefResult>;

type LoadedPlugin =
  | { kind: "executor"; plugin: ExecutorPlugin; readFile?: ReadFileHook }
  | { kind: "control"; plugin: ControlPlugin }
  | { kind: "discovery"; plugin: DiscoveryPlugin }
  | { kind: "notification"; plugin: NotificationPlugin }
  | { kind: "federation-transport"; plugin: FederationTransportPlugin }
  | { kind: "dependency-index"; plugin: DependencyIndexPlugin };

/** Static module map. See docs/plugin-host.md §96. */
async function loadPlugin(moduleName: string): Promise<LoadedPlugin> {
  switch (moduleName) {
    case "fake-executor": {
      const mod = await import("@scp/plugin-fake-executor");
      return { kind: "executor", plugin: mod.createFakeExecutorPlugin() };
    }
    case "webhook-control": {
      const mod = await import("@scp/plugin-webhook-control");
      return { kind: "control", plugin: mod.createWebhookControlPlugin() };
    }
    case "scan-result-control": {
      const mod = await import("@scp/plugin-scan-result-control");
      return { kind: "control", plugin: mod.createScanResultControlPlugin() };
    }
    case "github-check": {
      const mod = await import("@scp/plugin-github-check");
      return { kind: "control", plugin: mod.createGithubCheckControlPlugin() };
    }
    // The three git providers are the only modules that carry a `readFileAtRef` hook (M21.2). It is
    // taken from the ADAPTER, not from the executor plugin — see {@link ReadFileHook} — and wrapped
    // in an arrow rather than passed as a bare method reference so it can never depend on `this`.
    case "github": {
      const mod = await import("@scp/plugin-github");
      return {
        kind: "executor",
        plugin: mod.createGithubExecutorPlugin(),
        readFile: (ctx, request) => mod.githubAdapter.readFileAtRef(ctx, request)
      };
    }
    case "github-discovery": {
      const mod = await import("@scp/plugin-github");
      return { kind: "discovery", plugin: mod.createGithubDiscoveryPlugin() };
    }
    case "gitea": {
      const mod = await import("@scp/plugin-gitea");
      return {
        kind: "executor",
        plugin: mod.createGiteaExecutorPlugin(),
        readFile: (ctx, request) => mod.giteaAdapter.readFileAtRef(ctx, request)
      };
    }
    case "gitea-discovery": {
      const mod = await import("@scp/plugin-gitea");
      return { kind: "discovery", plugin: mod.createGiteaDiscoveryPlugin() };
    }
    case "gitlab": {
      const mod = await import("@scp/plugin-gitlab");
      return {
        kind: "executor",
        plugin: mod.createGitlabExecutorPlugin(),
        readFile: (ctx, request) => mod.gitlabAdapter.readFileAtRef(ctx, request)
      };
    }
    case "gitlab-discovery": {
      const mod = await import("@scp/plugin-gitlab");
      return { kind: "discovery", plugin: mod.createGitlabDiscoveryPlugin() };
    }
    case "argocd": {
      const mod = await import("@scp/plugin-argocd");
      return { kind: "executor", plugin: mod.createArgoCdExecutorPlugin() };
    }
    case "argocd-discovery": {
      const mod = await import("@scp/plugin-argocd");
      return { kind: "discovery", plugin: mod.createArgoCdDiscoveryPlugin() };
    }
    case "argo-workflows": {
      const mod = await import("@scp/plugin-argo-workflows");
      return { kind: "executor", plugin: mod.createArgoWorkflowsExecutorPlugin() };
    }
    case "terraform": {
      const mod = await import("@scp/plugin-terraform");
      return { kind: "executor", plugin: mod.createTerraformExecutorPlugin() };
    }
    case "pipeline-generic": {
      const mod = await import("@scp/plugin-pipeline-generic");
      return { kind: "executor", plugin: mod.createPipelineGenericExecutorPlugin() };
    }
    case "managed-iac": {
      const mod = await import("@scp/plugin-managed-iac");
      return { kind: "executor", plugin: mod.createManagedIacExecutorPlugin() };
    }
    case "managed-scan": {
      const mod = await import("@scp/plugin-managed-scan");
      return { kind: "executor", plugin: mod.createManagedScanExecutorPlugin() };
    }
    case "managed-dep": {
      const mod = await import("@scp/plugin-managed-dep");
      return { kind: "executor", plugin: mod.createManagedDepExecutorPlugin() };
    }
    case "webhook-notify": {
      const mod = await import("@scp/plugin-webhook-notify");
      return { kind: "notification", plugin: mod.createWebhookNotifyPlugin() };
    }
    case "smtp-notify": {
      const mod = await import("@scp/plugin-smtp-notify");
      return { kind: "notification", plugin: mod.createSmtpNotifyPlugin() };
    }
    case "federation-https": {
      const mod = await import("@scp/plugin-federation-https");
      return { kind: "federation-transport", plugin: mod.default };
    }
    // M21.4 (ADR-0032 §7) — the five per-ecosystem version indexes. Four share one package under
    // four module names (the `github`/`github-discovery` split), because one hosted instance loads
    // exactly one plugin and each ecosystem gets its own operator-configured base URL.
    case "dependency-index-go": {
      const mod = await import("@scp/plugin-dependency-index-registries");
      return { kind: "dependency-index", plugin: mod.createGoIndexPlugin() };
    }
    case "dependency-index-npm": {
      const mod = await import("@scp/plugin-dependency-index-registries");
      return { kind: "dependency-index", plugin: mod.createNpmIndexPlugin() };
    }
    case "dependency-index-pypi": {
      const mod = await import("@scp/plugin-dependency-index-registries");
      return { kind: "dependency-index", plugin: mod.createPypiIndexPlugin() };
    }
    case "dependency-index-maven": {
      const mod = await import("@scp/plugin-dependency-index-registries");
      return { kind: "dependency-index", plugin: mod.createMavenIndexPlugin() };
    }
    case "dependency-index-oci": {
      const mod = await import("@scp/plugin-dependency-index-oci");
      return { kind: "dependency-index", plugin: mod.createOciIndexPlugin() };
    }
    default:
      throw new Error(`subprocess-entry: unknown SCP_PLUGIN_MODULE "${moduleName}"`);
  }
}

/** stderr-only, line-delimited JSON — for humans/host-side log aggregation, never parsed as
 *  protocol (see module doc: stdout is reserved exclusively for JSON-RPC). */
function stderrLogger(instanceId: string): Logger {
  const write = (level: string, msg: string, meta?: Record<string, unknown>) => {
    process.stderr.write(
      `${JSON.stringify({ level, instanceId, msg, ...(meta ? { meta } : {}) })}\n`
    );
  };
  return {
    debug: (msg, meta) => write("debug", msg, meta),
    info: (msg, meta) => write("info", msg, meta),
    warn: (msg, meta) => write("warn", msg, meta),
    error: (msg, meta) => write("error", msg, meta)
  };
}

/** The plugin HTTP client: egress-controlled and instrumented. See docs/plugin-host.md §97. */
/** The only modules permitted to reach internal hosts. See docs/plugin-host.md §98. */
const OPERATOR_PLANE_MODULES = new Set([
  "webhook-control",
  "scan-result-control",
  "github-check",
  "federation-https"
]);

/** The federation mutual-TLS material, in the subprocess. See docs/plugin-host.md §99. */
function loadFederationMtlsMaterial(): { cert: string; key: string; ca?: string } | undefined {
  const certFile = process.env.SCP_FEDERATION_MTLS_CERT_FILE;
  const keyFile = process.env.SCP_FEDERATION_MTLS_KEY_FILE;
  const caFile = process.env.SCP_FEDERATION_MTLS_CA_FILE;
  if (!certFile && !keyFile) return undefined;
  if (!certFile || !keyFile) {
    throw new Error(
      "federation-https mTLS: both SCP_FEDERATION_MTLS_CERT_FILE and SCP_FEDERATION_MTLS_KEY_FILE " +
        "must be set together (only one was provided) — refusing to boot with a half-configured client certificate"
    );
  }
  return {
    cert: readFileSync(certFile, "utf8"),
    key: readFileSync(keyFile, "utf8"),
    ca: caFile ? readFileSync(caFile, "utf8") : undefined
  };
}

/** The OPERATOR's additional CA bundle for executor TLS. See docs/plugin-host.md §100. */
function loadExecutorTlsCa(): string | undefined {
  const caFile = process.env.SCP_EXECUTOR_TLS_CA_FILE;
  if (!caFile) return undefined;
  try {
    return readFileSync(caFile, "utf8");
  } catch (err) {
    throw new Error(
      `SCP_EXECUTOR_TLS_CA_FILE is set to '${caFile}' but the file could not be read ` +
        `(${err instanceof Error ? err.message : String(err)}) — refusing to boot with a CA bundle ` +
        `that would silently degrade to system roots only`
    );
  }
}

/** Reads a response body, enforcing the cap while reading. See docs/plugin-host.md §101. */
async function readBoundedResponseText(
  res: { body: ReadableStream<Uint8Array> | null; text(): Promise<string> },
  url: string,
  maxResponseBytes: number
): Promise<string> {
  if (!res.body) return res.text();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value || value.byteLength === 0) continue;
    total += value.byteLength;
    if (total > maxResponseBytes) {
      await reader.cancel("maxResponseBytes exceeded").catch(() => {
        // The provider may already have closed the connection; cancel()'s own failure is not the
        // error we report — the size ceiling is.
      });
      throw scopedHttpResponseTooLargeError(url, maxResponseBytes);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
}

function scopedFetchHttpClient(
  allowedHosts: string[],
  allowInternalPrivate: boolean,
  mtls?: { cert: string; key: string; ca?: string },
  executorTlsCa?: string
): ScopedHttpClient {
  // A dedicated agent presenting the client certificate. See docs/plugin-host.md §102.
  const cas = [mtls?.ca, executorTlsCa].filter((c): c is string => c !== undefined);
  // The pin registry and the dispatcher are ONE unit: the registry answers this Agent's connect-time
  // resolution, and only this Agent's. Both live for the life of the subprocess.
  const pins = createEgressPinRegistry();
  const dispatcher = new UndiciAgent({
    connect: {
      lookup: pins.lookup,
      ...(mtls ? { cert: mtls.cert, key: mtls.key } : {}),
      ...(cas.length > 0 ? { ca: [...rootCertificates, ...cas] } : {})
    }
  });
  return {
    async request(req): Promise<ScopedHttpResponse> {
      // MAJOR #6 — allowlist AND internal-IP deny-list (post-DNS-resolution). See egress-guard.ts.
      // `allowInternalPrivate` comes from module identity (OPERATOR_PLANE_MODULES), never config.
      const target = await assertEgressAllowed(req.url, allowedHosts, allowInternalPrivate);
      // …and the socket may only be opened to an address that check actually classified. Released
      // after the body is read, which is long after the connection was established.
      const release = pins.pin(target);
      try {
        const requestBody = req.body === undefined ? undefined : JSON.stringify(req.body);
        const res = await undiciFetch(req.url, {
          method: req.method,
          headers: req.headers,
          body: requestBody,
          // MAJOR #6 — never follow redirects: a 3xx could re-point the request at an internal
          // host AFTER the pre-flight egress check. A redirect surfaces as an error the plugin
          // handles; plugins must target final URLs. (No M7 plugin's fixtures rely on redirects.)
          redirect: "error",
          dispatcher
        });
        const text =
          req.maxResponseBytes !== undefined
            ? await readBoundedResponseText(res, req.url, req.maxResponseBytes)
            : await res.text();
        let body: unknown = text;
        try {
          body = text ? JSON.parse(text) : undefined;
        } catch {
          // Not JSON — return the raw text; ScopedHttpResponse.body is deliberately `unknown`.
        }
        const headers: Record<string, string> = {};
        res.headers.forEach((value, key) => {
          headers[key] = value;
        });
        return { status: res.status, headers, body };
      } finally {
        release();
      }
    }
  };
}

/** M3's `noSecretsAccessor()` always resolved `undefined`. See docs/plugin-host.md §103. */
function envSecretsAccessor(): SecretsAccessor {
  let resolved: Record<string, string> | undefined;
  return {
    async get(key: string): Promise<string | undefined> {
      resolved ??= JSON.parse(process.env.SCP_PLUGIN_SECRETS_JSON ?? "{}") as Record<
        string,
        string
      >;
      return resolved[key];
    }
  };
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`subprocess-entry: required env var ${name} is not set`);
  }
  return value;
}

async function dispatch(
  loaded: LoadedPlugin,
  ctx: PluginContext,
  method: string,
  params: unknown
): Promise<unknown> {
  if (loaded.kind === "control") {
    if (method !== "evaluate")
      throw new Error(`unknown method "${method}" for a ControlPlugin instance`);
    const p = params as { req: ControlRequest };
    return loaded.plugin.evaluate(ctx, p.req);
  }

  if (loaded.kind === "discovery") {
    if (method !== "discover")
      throw new Error(`unknown method "${method}" for a DiscoveryPlugin instance`);
    return loaded.plugin.discover(ctx);
  }

  if (loaded.kind === "notification") {
    if (method !== "send")
      throw new Error(`unknown method "${method}" for a NotificationPlugin instance`);
    const p = params as { msg: NotificationMessage };
    return loaded.plugin.send(ctx, p.msg);
  }

  if (loaded.kind === "federation-transport") {
    switch (method) {
      case "push": {
        const p = params as { segment: JournalSegment };
        return loaded.plugin.push(ctx, p.segment);
      }
      case "pull": {
        const p = params as { cursor: DomainCursor };
        return loaded.plugin.pull(ctx, p.cursor);
      }
      case "exportBundle": {
        const p = params as { opts: ExportOptions };
        return loaded.plugin.exportBundle(ctx, p.opts);
      }
      case "importBundle": {
        const p = params as { bundle: BundleRef };
        return loaded.plugin.importBundle(ctx, p.bundle);
      }
      default:
        throw new Error(`unknown method "${method}" for a FederationTransportPlugin instance`);
    }
  }

  if (loaded.kind === "dependency-index") {
    switch (method) {
      case "listVersions": {
        const p = params as { query: DependencyIndexQuery };
        return loaded.plugin.listVersions(ctx, p.query);
      }
      case "resolveDigest": {
        const p = params as {
          ref: { ecosystem: DependencyIndexEcosystem; coordinate: string; version: string };
        };
        return loaded.plugin.resolveDigest(ctx, p.ref);
      }
      case "describeIndex":
        return loaded.plugin.describeIndex();
      default:
        throw new Error(`unknown method "${method}" for a DependencyIndexPlugin instance`);
    }
  }

  // M21.4 (ADR-0032 §7a) — the git-provider file read. Handled BEFORE the four-verb switch below
  // and against `loaded.readFile`, never against `loaded.plugin`, because that is what keeps
  // ADR-0032 §9 true: the plugin object still has exactly four verbs and this is not one of them.
  if (method === "readFileAtRef") {
    if (!loaded.readFile) {
      throw new Error(
        `this instance's plugin has no readFileAtRef hook — only the git-provider adapters ` +
          `(github/gitea/gitlab) carry one (ADR-0032 §9: it is a GitProviderAdapter hook, never a ` +
          `fifth ExecutorPlugin verb)`
      );
    }
    const p = params as { request: ReadFileAtRefRequest };
    return loaded.readFile(ctx, p.request);
  }

  const plugin = loaded.plugin;
  switch (method) {
    case "observe": {
      const p = (params ?? {}) as { since?: Cursor };
      return plugin.observe(ctx, p.since);
    }
    case "trigger": {
      const p = params as { intent: TriggerIntent };
      return plugin.trigger(ctx, p.intent);
    }
    case "status": {
      const p = params as { ref: ExternalRunRef };
      return plugin.status(ctx, p.ref);
    }
    case "abort": {
      const p = params as { ref: ExternalRunRef };
      return plugin.abort(ctx, p.ref);
    }
    case "describeCapabilities":
      return plugin.describeCapabilities();
    case "ensureSchedule": {
      // REFUSES rather than no-ops when the plugin does not implement it. A silent success here
      // would tell the driver a probe is scheduled in an executor that has no idea it exists —
      // the failure shape this whole increment has been closing, one layer lower.
      if (!plugin.ensureSchedule) {
        throw new Error("this ExecutorPlugin does not implement ensureSchedule");
      }
      const p = params as { spec: ScheduleSpec };
      return plugin.ensureSchedule(ctx, p.spec);
    }
    case "removeSchedule": {
      if (!plugin.removeSchedule) {
        throw new Error("this ExecutorPlugin does not implement removeSchedule");
      }
      const p = params as { scheduleId: string };
      return plugin.removeSchedule(ctx, p.scheduleId);
    }
    default:
      throw new Error(`unknown method "${method}" for an ExecutorPlugin instance`);
  }
}

async function main(): Promise<void> {
  const moduleName = requireEnv("SCP_PLUGIN_MODULE");
  const instanceId = requireEnv("SCP_PLUGIN_INSTANCE_ID");
  const orgId = requireEnv("SCP_PLUGIN_ORG_ID");
  const scopeKey = requireEnv("SCP_PLUGIN_SCOPE_KEY");
  const config: unknown = JSON.parse(process.env.SCP_PLUGIN_CONFIG_JSON ?? "{}");
  const allowedHosts = JSON.parse(process.env.SCP_PLUGIN_ALLOWED_HOSTS_JSON ?? "[]") as string[];
  // Loopback egress is permitted for two named reasons. See docs/plugin-host.md §104.
  const allowInternalPrivate =
    OPERATOR_PLANE_MODULES.has(moduleName) ||
    process.env.SCP_PLUGIN_ALLOW_INTERNAL_EGRESS === "true";
  // M8: client-certificate material, gated on module identity (only federation-https ever sees
  // the SCP_FEDERATION_MTLS_* env vars in the first place — host.ts's `spawnInstance` — but this
  // module-identity check is defence in depth against the vars ever leaking to another module).
  const mtls = moduleName === "federation-https" ? loadFederationMtlsMaterial() : undefined;
  // NOT gated on module identity, unlike `mtls` above, and the difference is the point: a client
  // CERTIFICATE is an identity only federation-https may present, whereas a trust anchor is about
  // whom we are willing to VERIFY. Any executor plugin can face a privately-signed endpoint, so the
  // host forwards this to every plugin subprocess. It grants no identity and weakens no check.
  const executorTlsCa = loadExecutorTlsCa();

  const plugin = await loadPlugin(moduleName);
  const ctx: PluginContext = {
    orgId,
    scopeKey,
    logger: stderrLogger(instanceId),
    secrets: envSecretsAccessor(),
    http: scopedFetchHttpClient(allowedHosts, allowInternalPrivate, mtls, executorTlsCa),
    config
  };

  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

  // Signals the host this instance is constructed and ready to take RPC calls (host.ts's
  // `waitForReady`) — sent AFTER the plugin+ctx are built, never before, so the host never races
  // a call against a not-yet-constructed plugin.
  process.stdout.write(encodeMessage({ jsonrpc: "2.0", method: "ready" }));

  for await (const line of rl) {
    if (!line.trim()) continue;

    let req: RpcRequest;
    try {
      req = parseMessage(line) as RpcRequest;
    } catch {
      ctx.logger.warn("subprocess-entry: received unparsable line, ignoring", { line });
      continue;
    }

    try {
      const result = await dispatch(plugin, ctx, req.method, req.params);
      process.stdout.write(encodeMessage({ jsonrpc: "2.0", id: req.id, result }));
    } catch (err) {
      process.stdout.write(
        encodeMessage({
          jsonrpc: "2.0",
          id: req.id,
          error: { code: -32000, message: err instanceof Error ? err.message : String(err) }
        })
      );
    }
  }
}

main().catch((err: unknown) => {
  process.stderr.write(
    `subprocess-entry: fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`
  );
  process.exitCode = 1;
});
