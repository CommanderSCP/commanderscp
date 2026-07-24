import type PgBoss from "pg-boss";
import type { Db } from "./db/client.js";
import type { ServerConfig } from "./config.js";
import type { CelSandbox } from "./governance/cel-sandbox.js";
import type { PluginHost } from "./plugin-host/contract.js";

export interface AppDeps {
  db: Db;
  config: ServerConfig;
  /**
   * M14.2 (ADR-0009): the process's pg-boss handle, present only on `role === "all" || "worker"`
   * (set by `main.ts` alongside `pluginHost`, once `startPgBoss` has run). The inbound federation
   * poke endpoint (`routes/federation.ts` `POST /federation/poke`) uses it to enqueue an IMMEDIATE
   * federation-sync tick — waking the M14.0 pull loop now rather than at the next interval — WITHOUT
   * doing the pull inline. A pure `role === "api"` process has none, in which case an accepted poke
   * is a no-op-but-accepted (the sparse safety-net + a worker process are the reliability floor). */
  boss?: PgBoss;
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
