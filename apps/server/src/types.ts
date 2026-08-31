import type PgBoss from "pg-boss";
import type { Db } from "./db/client.js";
import type { ServerConfig } from "./config.js";
import type { CelSandbox } from "./governance/cel-sandbox.js";
import type { PluginHost } from "./plugin-host/contract.js";

export interface AppDeps {
  db: Db;
  config: ServerConfig;
  /**
   * A SMALL pool dedicated to `GET /events/stream`'s PER-FRAME `object:read` check
   * (routes/events.ts), assigned by `main.ts` right beside the SSE bridge's own `max: 2` pool.
   *
   * WHY IT EXISTS. That check is a recursive-CTE permission walk inside a tenant transaction, run
   * once per (connection, distinct subject) per memo window — so it is long-lived, streaming,
   * fan-out-shaped load whose volume is set by how many events the org produces and how many
   * clients are connected, NOT by how many API requests are in flight. Putting it on `db` (the
   * request-serving pool, `max` = pg's default 10) means a bulk import or a reconcile sweep — a
   * stream of DISTINCT subjects, which the memo cannot collapse — competes for connections with
   * ordinary request handlers, and `createPool`'s `connectionTimeoutMillis: 5000` (db/client.ts)
   * turns that contention into REQUEST TIMEOUTS. This is the same property, one layer down, that
   * `main.ts`'s `sseBridgePool` comment already names (review finding SEC-1); the two pools are ONE
   * isolation decision about the SSE path, not two unrelated ones.
   *
   * OPTIONAL ON PURPOSE. `buildApp` is also called by `openapi:emit` and by every test harness,
   * which construct deps by hand (`{ db, config }`). routes/events.ts falls back to `deps.db`
   * explicitly when this is absent — the fallback is the pre-existing behaviour, so a hand-built
   * deps still serves the stream correctly, just without the isolation.
   */
  sseAuthzDb?: Db;
  /**
   * A SMALL pool dedicated to the recursive-CTE graph read routes (`GET /graph/traverse`,
   * `/graph/query/:name`, `POST /graph/subgraph`, and the org-wide integrity report — routes/graph.ts),
   * assigned by `main.ts` beside the SSE pools and sized by `GRAPH_QUERY_POOL_MAX`.
   *
   * WHY IT EXISTS. Those handlers run depth-bounded recursive CTEs whose cost is driven by GRAPH
   * SHAPE and the caller's parameters, not by request volume — an authenticated caller can fire
   * several expensive traversals and, on the request-serving `db` pool (pg default max 10,
   * `connectionTimeoutMillis: 5000`), turn every OTHER tenant's ordinary request into a checkout
   * TIMEOUT. Isolating them means a starved graph pool degrades only graph reads, never request
   * serving or coordination — the same isolation decision as `sseAuthzDb`, one route family over.
   *
   * OPTIONAL ON PURPOSE, exactly like `sseAuthzDb`: hand-built deps (`openapi:emit`, test harnesses)
   * omit it and routes/graph.ts falls back to `deps.db` (correct, just unisolated).
   */
  graphDb?: Db;
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
