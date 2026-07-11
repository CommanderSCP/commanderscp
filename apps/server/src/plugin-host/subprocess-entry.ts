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
 * `SCP_PLUGIN_INSTANCE_ID`, `SCP_PLUGIN_ORG_ID`, `SCP_PLUGIN_DOMAIN_ID`, `SCP_PLUGIN_CONFIG_JSON`
 * — rather than argv, because they're simple strings the host already fully controls and never
 * touch a shell (`spawn()`'s array-argv form has no quoting/escaping surface either way, but env
 * vars keep the process's argv itself uninteresting/unloggable-as-a-command-line, which matters
 * once `config` can carry secrets-adjacent values in a later milestone).
 *
 * Wire protocol: newline-delimited JSON-RPC 2.0 (rpc-protocol.ts). CRITICAL: this process's
 * stdout carries ONLY protocol messages — never `console.log`/plain text, or it corrupts the RPC
 * stream host.ts is parsing. All logging (including the plugin's own `PluginContext.logger`)
 * goes to stderr.
 */
import { createInterface } from "node:readline";
import type {
  ControlPlugin,
  ControlRequest,
  Cursor,
  DiscoveryPlugin,
  ExecutorPlugin,
  ExternalRunRef,
  Logger,
  NotificationMessage,
  NotificationPlugin,
  PluginContext,
  ScopedHttpClient,
  ScopedHttpResponse,
  SecretsAccessor,
  TriggerIntent
} from "@scp/plugin-api";
import { encodeMessage, parseMessage, type RpcRequest } from "./rpc-protocol.js";

type LoadedPlugin =
  | { kind: "executor"; plugin: ExecutorPlugin }
  | { kind: "control"; plugin: ControlPlugin }
  | { kind: "discovery"; plugin: DiscoveryPlugin }
  | { kind: "notification"; plugin: NotificationPlugin };

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
    case "github": {
      const mod = await import("@scp/plugin-github");
      return { kind: "executor", plugin: mod.createGithubExecutorPlugin() };
    }
    case "github-discovery": {
      const mod = await import("@scp/plugin-github");
      return { kind: "discovery", plugin: mod.createGithubDiscoveryPlugin() };
    }
    case "argocd": {
      const mod = await import("@scp/plugin-argocd");
      return { kind: "executor", plugin: mod.createArgoCdExecutorPlugin() };
    }
    case "terraform": {
      const mod = await import("@scp/plugin-terraform");
      return { kind: "executor", plugin: mod.createTerraformExecutorPlugin() };
    }
    case "managed-iac": {
      const mod = await import("@scp/plugin-managed-iac");
      return { kind: "executor", plugin: mod.createManagedIacExecutorPlugin() };
    }
    case "webhook-notify": {
      const mod = await import("@scp/plugin-webhook-notify");
      return { kind: "notification", plugin: mod.createWebhookNotifyPlugin() };
    }
    case "smtp-notify": {
      const mod = await import("@scp/plugin-smtp-notify");
      return { kind: "notification", plugin: mod.createSmtpNotifyPlugin() };
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
 * `PluginContext.http` (DESIGN.md §11: "egress-controlled, instrumented"). M3 backs it with a
 * plain `fetch` and NO egress scoping/allowlist enforcement — acceptable for M3 because the only
 * shipped plugin (fake-executor) never calls it, and no real network-calling executor plugin
 * lands before M7. TODO(M7 / security review): enforce an egress allowlist (per plugin instance
 * config) here, or front this with a real scoping proxy, before any plugin that actually reaches
 * the network ships.
 */
function unscopedFetchHttpClient(): ScopedHttpClient {
  return {
    async request(req): Promise<ScopedHttpResponse> {
      const res = await fetch(req.url, {
        method: req.method,
        headers: req.headers,
        body: req.body === undefined ? undefined : JSON.stringify(req.body)
      });
      const text = await res.text();
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
    }
  };
}

/** No secrets are wired in M3 — there is no plugin-instance secrets config API yet — so this
 *  always resolves `undefined`, same as "not configured"; never throws. */
function noSecretsAccessor(): SecretsAccessor {
  return { get: async () => undefined };
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
    default:
      throw new Error(`unknown method "${method}" for an ExecutorPlugin instance`);
  }
}

async function main(): Promise<void> {
  const moduleName = requireEnv("SCP_PLUGIN_MODULE");
  const instanceId = requireEnv("SCP_PLUGIN_INSTANCE_ID");
  const orgId = requireEnv("SCP_PLUGIN_ORG_ID");
  const domainId = requireEnv("SCP_PLUGIN_DOMAIN_ID");
  const config: unknown = JSON.parse(process.env.SCP_PLUGIN_CONFIG_JSON ?? "{}");

  const plugin = await loadPlugin(moduleName);
  const ctx: PluginContext = {
    orgId,
    domainId,
    logger: stderrLogger(instanceId),
    secrets: noSecretsAccessor(),
    http: unscopedFetchHttpClient(),
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
