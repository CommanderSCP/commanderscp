import type { Db } from "./db/client.js";
import type { ServerConfig } from "./config.js";
import type { CelSandbox } from "./governance/cel-sandbox.js";
import type { PluginHost } from "./plugin-host/contract.js";

export interface AppDeps {
  db: Db;
  config: ServerConfig;
  /** The sandboxed CEL evaluator (governance/cel-sandbox.ts) — every request-serving process
   *  needs one for gate evaluation (routes/changes.ts's promote handler), regardless of whether
   *  it also runs the `PluginHost`-requiring reconciliation loop (DESIGN §16's api/worker split;
   *  see coordination/gates.ts's module doc). Lazily defaulted to the process-wide shared
   *  instance (`getSharedCelSandbox()`) by `buildApp` when the caller doesn't supply one, so
   *  every existing `buildApp({db, config})` call site (openapi:emit, tests) keeps compiling
   *  unchanged. */
  celSandbox?: CelSandbox;
  /**
   * M7: an in-process `PluginHost`, present only on `role === "all" || "worker"` (main.ts) — a
   * pure `role === "api"` process has none, same api/worker split `celSandbox`'s doc comment
   * describes for control evaluation. `routes/executors.ts`'s `POST /discovery/run` is the one API
   * route that genuinely needs to make a live, on-demand plugin call (a `DiscoveryPlugin.discover()`
   * scan) rather than deferring to the reconcile loop; it 400s with a clear message when this is
   * undefined rather than crashing. Every other M7 plugin call (executor trigger/status, control
   * evaluate, notification send) already runs from worker-side code that has its own `host`
   * parameter threaded in directly — this is deliberately the ONLY route-layer use.
   */
  pluginHost?: PluginHost;
}
