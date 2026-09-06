/**
 * Subprocess plugin host entry point (DESIGN.md §11: "Plugin instances run under a subprocess
 * plugin host: one child process per configured plugin instance (`scpd plugin-host`, same
 * image), speaking JSON-RPC 2.0 over stdio"). `host.ts` `spawn()`s this file directly as its own
 * process — one per configured `PluginHostInstanceConfig`.
 *
 * Implemented as a small standalone script under `apps/server/src` rather than a new `scpd
 * plugin-host` CLI subcommand threaded through `main.ts`/Fastify: the isolation semantics this
 * file provides (construct one plugin instance, speak JSON-RPC over stdio) need none of the HTTP
 * server or main.ts's DB/pg-boss boot sequence, and `tsc -b` already compiles anything under
 * `src/` to `dist/`, so this needs no build-config changes — `host.ts`'s `resolveSubprocessCommand`
 * spawns `dist/plugin-host/subprocess-entry.js` right alongside `dist/main.js`.
 *
 * Config surface (documented framing choice, mirrors host.ts's `spawnChild`): the module to load
 * and the instance's identity/config arrive as env vars — `SCP_PLUGIN_MODULE`,
 * `SCP_PLUGIN_INSTANCE_ID`, `SCP_PLUGIN_ORG_ID`, `SCP_PLUGIN_SCOPE_KEY`, `SCP_PLUGIN_CONFIG_JSON`,
 * and (M7) `SCP_PLUGIN_SECRETS_JSON` (resolved, already-decrypted secret values —
 * `envSecretsAccessor()` below) and `SCP_PLUGIN_ALLOWED_HOSTS_JSON` (the egress allowlist —
 * `scopedFetchHttpClient()` below) — rather than argv, because they're simple strings the host
 * already fully controls and never touch a shell (`spawn()`'s array-argv form has no
 * quoting/escaping surface either way, but env vars keep the process's argv itself
 * uninteresting/unloggable-as-a-command-line, which matters now that `SCP_PLUGIN_SECRETS_JSON`
 * genuinely does carry secret material).
 *
 * Wire protocol: newline-delimited JSON-RPC 2.0 (rpc-protocol.ts). CRITICAL: this process's
 * stdout carries ONLY protocol messages — never `console.log`/plain text, or it corrupts the RPC
 * stream host.ts is parsing. All logging (including the plugin's own `PluginContext.logger`)
 * goes to stderr.
 */
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

/**
 * M21.4 (ADR-0032 §7a) — the file-read hook that rides ALONGSIDE an executor plugin, never ON it.
 *
 * `readFileAtRef` is a `GitProviderAdapter` hook and `createExecutorPluginFromAdapter` deliberately
 * omits it (ADR-0032 §9): the four-verb `ExecutorPlugin` set IS the structural enforcement of
 * charter principle 1, so a fifth verb would remove the enforcement mechanism rather than extend it.
 * Carrying the hook as a SEPARATE field on the loaded record is what keeps that true — the `plugin`
 * object below still exposes exactly observe/trigger/status/abort, and git-provider-core's "it does
 * NOT surface readFileAtRef as an ExecutorPlugin verb" test is untouched — while giving the host a
 * route to the adapter's read for the three modules that have one.
 *
 * Absent for every non-git-provider executor, which is why the dispatch below refuses by naming the
 * MODULE rather than the method: "this instance's plugin has no file-read hook" is the operator's
 * actual situation, where "unknown method" would send them hunting for a typo.
 */
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

/**
 * Static module map (DESIGN.md §11: "No runtime hot-loading, ever") — grows as M4/M7 ship more
 * in-repo plugins, never by loosening this to a dynamic/unchecked import. `kind` on the returned
 * union drives `dispatch()`'s method routing below (executor methods vs. `evaluate` vs. `discover`
 * vs. `send`). Every case here MUST also be a member of `PluginModule` (plugin-host/contract.ts) —
 * that union is the compile-time half of this same contract.
 */
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

/**
 * `PluginContext.http` (DESIGN.md §11: "egress-controlled, instrumented"). M3 shipped this backed
 * by a plain `fetch` with NO egress scoping/allowlist enforcement at all — acceptable for M3
 * because the only shipped plugin (fake-executor) never called it. M7 closes that TODO: every
 * plugin instance's `PluginHostInstanceConfig.allowedHosts` (resolved from `executor_bindings`/
 * `notification_bindings.allowed_hosts` — contract.ts's doc comment) arrives here via
 * `SCP_PLUGIN_ALLOWED_HOSTS_JSON` and is enforced BEFORE the request is ever dispatched — an
 * out-of-allowlist URL throws instead of reaching `fetch()` at all (SSRF mitigation: a plugin
 * can't be redirected into hitting an attacker-controlled or internal-only host it wasn't
 * explicitly configured to reach).
 *
 * Empty/unset `allowedHosts` preserves the M3-M6 unscoped behavior — required for
 * `webhook-control` (DESIGN §10.2's "generic webhook escape hatch": its entire purpose is POSTing
 * to an arbitrary operator-configured URL, which by definition isn't a fixed allowlist) and for
 * `federation-https` (peer URLs come from `federation_peers`, not a plugin-instance-level
 * allowlist). Every M7 network-calling plugin (github/argocd/webhook-notify) is expected to set
 * `allowedHosts` explicitly at binding-creation time for real SSRF protection.
 *
 * MAJOR #6 — the allowlist alone doesn't stop the cloud metadata endpoint / loopback / internal
 * services, nor an allowlisted hostname that DNS-resolves (or a 3xx redirects) to an internal IP.
 * `egress-guard.ts`'s `assertEgressAllowed` adds an internal-range deny-list enforced AFTER DNS
 * resolution (link-local/metadata ALWAYS blocked; loopback + private blocked for every plugin
 * EXCEPT the operator-plane escape hatches in `OPERATOR_PLANE_MODULES` — gated on MODULE identity,
 * never tenant config), and this client disables redirect-following entirely.
 */
/**
 * The ONLY plugin modules permitted to reach loopback/private internal hosts (MAJOR #6 follow-up):
 * the genuine operator-plane escape hatches. `webhook-control`'s control-server URL is
 * operator-configured behind `policy:write` (never an ordinary tenant), `scan-result-control`'s
 * scan-verdict source URL is the same (a control binding, same `policy:write` trust tier, and the
 * verdict store is often an in-cluster/on-prem artifact registry reachable only at a private
 * address), `federation-https` dials on-prem/single-host peers, and `github-check` (M10.4) is the
 * same `policy:write`-gated control-binding trust tier again — its `apiBaseUrl` legitimately
 * targets a self-hosted GitHub Enterprise Server at a private address, exactly the on-prem case
 * `scan-result-control`'s own justification names. EVERY tenant-configurable plugin (webhook-notify,
 * github, argocd, terraform, managed-iac) is absent here, so its `ctx.http` cannot be pointed at
 * `127.0.0.1`/`10.x`/... — this gate is on MODULE IDENTITY, not on `allowedHosts` emptiness (which
 * tenant bindings default to, and which a tenant controls).
 * Metadata/link-local stay blocked for these modules too.
 */
const OPERATOR_PLANE_MODULES = new Set([
  "webhook-control",
  "scan-result-control",
  "github-check",
  "federation-https"
]);

/**
 * M8 hardening (DESIGN.md §13, BUILD_AND_TEST.md §8 M8 item 6, "Federation mTLS transport
 * identity"): reads the HOST-level (operator-configured, never tenant-suppliable —
 * `host.ts`'s `spawnInstance` forwards these into ONLY the `federation-https` subprocess's env,
 * gated on module identity) client-certificate material `federation-https` presents to the
 * parent. All three are OPTIONAL — unset (the pre-M8 default) means no client certificate, and
 * federation-https keeps working exactly as it did in M6 (bearer+RBAC+Ed25519 journal signing,
 * no transport-level peer identity). Reads synchronously, once, at subprocess boot — this is
 * static per-deployment config, not something that changes per call or per instance.
 *
 * A configured-but-unreadable path fails LOUD (throws, taking the subprocess boot down with a
 * clear error the plugin-host surfaces to its own stderr) rather than silently degrading to "no
 * client cert" — a misconfigured mTLS setup that quietly falls back to unauthenticated transport
 * is a false sense of security worse than an obvious boot failure.
 */
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

/**
 * The OPERATOR's additional CA bundle for executor TLS (`SCP_EXECUTOR_TLS_CA_FILE`).
 *
 * WHY THIS EXISTS. A bundled or on-prem execution system commonly serves HTTPS with a certificate
 * signed by a private CA — the vendored Argo Workflows server is the case that forced this: it
 * listens on 2746 with a SELF-SIGNED certificate (its own readiness probe uses `scheme: HTTPS`), so
 * every plugin request to it failed verification and the coordinated-test path was unreachable on the
 * bundled tier even with the NetworkPolicy open.
 *
 * WHAT IT IS NOT: a verification bypass. There is deliberately no "insecure"/"skipVerify" option
 * anywhere on this path. This ADDS a trust anchor; it never disables the check, so a certificate
 * that chains to neither the system roots nor this bundle is still refused. The failure mode of the
 * alternative — a per-binding skip flag — is that TLS verification becomes TENANT-WRITABLE, and this
 * codebase's standing rule is that transport security is never decided by data a tenant can author
 * (the same provenance discipline `allowInternalPrivate` follows: module identity, never config).
 *
 * SERVER-PROVENANCE, LIKE THE MTLS MATERIAL. It arrives as an env var the HOST chooses to forward
 * (`host.ts`'s `spawnInstance`), read from a file path only the operator controls — never from the
 * executor binding, never from plugin config, never from a graph property. An executor binding is
 * tenant-writable, so a CA reference living there would let a tenant nominate the authority that
 * vouches for the endpoint it is also nominating.
 *
 * Unset (the default) returns `undefined` and every request keeps using Node's system trust store
 * exactly as before — byte-for-byte the previous behaviour for every existing deployment.
 *
 * A configured-but-unreadable path THROWS rather than degrading to system-roots-only: a CA bundle
 * that silently fails to load looks identical to one that loaded and did not match, and the operator
 * would debug the endpoint instead of the path.
 */
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

/**
 * Reads a fetch `Response` body as text, enforcing `maxResponseBytes` DURING accumulation rather
 * than after (M21.2 review MAJOR 5 — the gap this closes: `res.text()` used to buffer the WHOLE
 * body before anything downstream got a chance to refuse it, so a hostile or misconfigured host
 * serving a multi-gigabyte blob exhausted this process before `@scp/git-provider-core`'s decode
 * bound ever ran).
 *
 * Reads via `getReader()` chunk-by-chunk rather than `for await…of res.body` so the abort path is
 * explicit: the moment the running total exceeds the bound, the reader is `cancel()`ed (which
 * signals the underlying transport to stop pulling bytes off the wire, not merely "stop looking at
 * them") and the promise REJECTS with a {@link scopedHttpResponseTooLargeError} — verified
 * empirically (a throw from inside a bare `for await` loop over a fetch body does eventually
 * unwind, but does not reliably signal the server to stop; an explicit `cancel()` does, and exits
 * promptly rather than leaving a dangling response read).
 *
 * Typed as accepting only the two members this needs (`body`, `text()`) rather than the concrete
 * `Response` type, because `undiciFetch`'s and the global `fetch`'s `Response` types are two
 * separately-vendored shapes that do not structurally unify without a cast (see the comment on the
 * two fetch branches below) — this narrower shape is satisfied by both without one.
 */
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
  // A dedicated undici Agent presenting the client certificate on every TLS handshake this
  // dispatcher makes — constructed once and reused (undici pools connections per-origin
  // internally), not per-request. It is now built UNCONDITIONALLY, where it used to be `undefined`
  // without mTLS/CA material and every request fell through to Node's global `fetch()`: the
  // dispatcher is what carries `connect.lookup`, and address pinning is not optional. Node's global
  // `fetch` re-resolves the hostname itself at connect time, which is precisely the DNS-rebinding
  // window `createEgressPinRegistry` exists to close (egress-guard.ts) — there is no longer a
  // request path out of this process that resolves a name twice.
  //
  // MUST use the explicitly-imported `undici` package's OWN `fetch` (`undiciFetch`) with this
  // Agent, never Node's global `fetch` — Node's global `fetch` is powered by its OWN internal,
  // separately-bundled copy of undici, and passing a `dispatcher` constructed from a DIFFERENT
  // undici install across that boundary throws (`UND_ERR_INVALID_ARG: invalid onError method`) at
  // request time, not at construction time. Confirmed empirically while building this fix — global
  // `fetch` + an externally-constructed `undici.Agent` are simply not interoperable.
  // A dispatcher is now needed for EITHER reason: a client certificate to present (mtls), or an extra
  // trust anchor to verify the peer against (`executorTlsCa`). When both are set the CAs are passed
  // together — undici accepts an array — so adding an executor CA never silently drops the
  // federation CA that was already there.
  //
  // `ca` REPLACES the default trust store rather than extending it, which is a Node/undici behaviour
  // worth stating: when only an executor CA is supplied we pass `[...rootCertificates, ca]` so a
  // publicly-signed executor endpoint keeps verifying. Passing the bundle alone would "work" in the
  // bundled-backend test and break every BYO executor behind a public CA — a regression that would
  // look like an unrelated outage.
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

/**
 * M3's `noSecretsAccessor()` always resolved `undefined` — "there is no plugin-instance secrets
 * config API yet". M7 adds one (`executor_bindings`/`notification_bindings.secret_refs`,
 * `secrets/secrets-repo.ts`'s `resolveSecretRefs`) and threads the RESOLVED (already-decrypted)
 * values through `SCP_PLUGIN_SECRETS_JSON` (host.ts's spawn env — contract.ts's
 * `PluginHostInstanceConfig.secrets` doc comment) — this reads that map. Never logs it (this
 * function's own body is the only place these plaintext values exist in this process, until a
 * plugin's own code — e.g. `ctx.secrets.get()` callers — receives one by explicit key). Unset
 * `SCP_PLUGIN_SECRETS_JSON` (any pre-M7 caller, or a plugin instance with no secretRefs
 * configured) parses to `{}`, preserving "no secrets configured" as the honest default.
 */
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
  // Loopback/private egress permitted for (a) operator-plane escape hatches by MODULE identity, or
  // (b) an instance whose backing execution-system object an operator explicitly marked
  // `allowInternalEgress` (host.ts injects `SCP_PLUGIN_ALLOW_INTERNAL_EGRESS` from that persisted
  // object only — never from tenant config; MAJOR #6 follow-up). Either way, `linkLocal`/`unspecified`
  // (cloud metadata) stay blocked for every plugin (egress-guard.ts). A tenant binding's own
  // `config.url = http://10.x` still resolves `false` here — it is not an execution-system property.
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
