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
   *  needs one for gate evaluation (routes/changes.ts's accept handler), regardless of whether
   *  it also runs the `PluginHost`-requiring reconciliation loop (DESIGN §16's api/worker split;
   *  see coordination/gates.ts's module doc). Lazily defaulted to the process-wide shared
   *  instance (`getSharedCelSandbox()`) by `buildApp` when the caller doesn't supply one, so
   *  every existing `buildApp({db, config})` call site (openapi:emit, tests) keeps compiling
   *  unchanged. */
  celSandbox?: CelSandbox;
  /**
   * M7: an in-process `PluginHost`. `main.ts` now constructs one for EVERY role, including a pure
   * `role === "api"` process — hosting a plugin for the duration of one request is not background
   * work, so it does not belong behind the background-work guard.
   *
   * It used to be built inside that guard, which meant a split api/worker deployment (the Helm
   * chart's default) left this undefined on the only process serving HTTP, and `POST /discovery/run`
   * 400'd unconditionally. What remains role-gated is the shared fake-executor INSTANCE, which
   * exists for the coordination loops; an api-only host starts with none, and discovery registers
   * its own per request regardless.
   *
   * `routes/executors.ts`'s `POST /discovery/run` is the one API route that genuinely needs a live,
   * on-demand plugin call (a `DiscoveryPlugin.discover()` scan) rather than deferring to the
   * reconcile loop. It still 400s rather than crashing if this is somehow absent — `buildApp` is
   * also called directly by tests and `openapi:emit`, which construct deps without a host.
   *
   * Every other M7 plugin call (executor trigger/status, control evaluate, notification send) runs
   * from worker-side code with its own `host` parameter threaded in — this is deliberately the ONLY
   * route-layer use.
   */
  pluginHost?: PluginHost;
}
