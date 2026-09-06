# main

Reference for `apps/server/src/main.ts`. The source carries a one-line headline at each site and points here.

> Partial: 6 of 13 multi-line comment blocks in this file have been
> moved here. The rest are still inline pending a hand-written one-line headline.

## §1. THE FEDERATION-IDENTITY STARTUP CHECK

THE FEDERATION-IDENTITY STARTUP CHECK (federation/self-origin-check.ts has the full rationale).

Every reconcile candidate query filters on `objects.origin_domain_id = federation_self.domain_id`. If those two ever diverge — a partial restore, an org cloned into a fresh database, a rebuild that recreated the `federation_self` row — every batch comes back empty and ALL coordination for that org stops with no error and no log line. That is the exact shape of the 13-day production outage this codebase already measured, and a green `/healthz` (four lines below) says nothing about it.

WHY HERE, three ways: - AFTER `ensureBootstrapAdmin`, because that is the one code path that creates an org and its first locally-authored objects; running before it would inspect an org that does not exist yet. - BEFORE `app.listen` and before the loops start, so the warning is in the log AHEAD of the first silent tick rather than buried under an hour of ordinary request logging. - UNCONDITIONALLY, not inside the `runsBackgroundWork` guard below. The damage lands on the worker, but the api pod is where an operator looks first, and in the chart's default split topology only one of the two would otherwise say anything. It costs two small reads per org, once per boot — it is emphatically NOT on the reconcile hot path, which was the whole reason a per-tick empty-batch probe was rejected in favour of this.

Read-only and non-fatal: it never repairs the divergence (which side is wrong depends on where the good backup is — an operator decision), and it never blocks boot, exactly like the ephemeral secrets-key and expired-CRL warnings.

## §2. THE SUBPROCESS PLUGIN HOST

THE SUBPROCESS PLUGIN HOST — constructed for EVERY role, including `api`.

It used to be built inside the `all|worker` guard below, next to the loops, so a split api/worker deployment (the Helm chart's default, and how the homelab runs) left `deps.pluginHost` undefined on the api process and `POST /discovery/run` answered 400 "discovery requires a worker-capable process" — on the ONLY process that serves HTTP. Discovery was unreachable in the topology the chart ships, and the operator-facing remediation ("SCP_ROLE=all") is wrong advice: it would ALSO start a second reconcile/watchdog/observe loop set beside the worker's.

The guard conflated two different needs. The LOOPS need pg-boss, the outbox relay and a single-writer role — that is what `all|worker` protects, and it is unchanged below. Discovery needs only the ability to dispatch a plugin for the duration of ONE request. Hosting plugins is not background work, so it does not belong behind a background-work guard.

What stays role-gated is the shared fake-executor INSTANCE: it exists for the coordination loops (coordination/executor-config.ts), so an api-only process starts the host with NO pre-registered instances and pays only for an idle supervisor. Discovery registers its own instance per request either way, so it never depended on that default.

Egress is unchanged and was verified before this landed: the chart's executor NetworkPolicies select every pod of the release rather than the worker alone, and the app-level SSRF egress guard is per-plugin-instance, not per-process. Neither boundary moves because a different process dispatches the plugin.
`runsBackgroundWork(config)` is IMPORTED, not inlined (`background-work.ts`). It used to be an inline `config.role === "all" || config.role === "worker"`, and that made it unreachable by any test: setting it `false` — killing all eleven loops below — left the entire apps/server unit suite green, because nothing can import this file. The predicate is now a pure exported function with its own coverage, and the loops it gates are a registry that is STARTED in a test.

## §3. THE SSE BRIDGE

THE SSE BRIDGE — started for EVERY role, same reasoning as the plugin host just above.

`app.listen()` below is unconditional: every role actually binds an HTTP listener and serves `GET /events/stream` (routes/events.ts is registered in `buildApp` with no role gate), even a pure `worker` process the chart's Service never routes real traffic to. Since the outbox relay no longer calls `sseHub.publish` directly (events/outbox-relay.ts's doc comment — proposal multi-region-instance-resilience.md §7.1 item 1, closing §4-A1), this bridge is the ONLY thing that can ever feed a process's local `sseHub`, in every topology — including a single `role=all` dev/compose process, where the relay and this route already share one process and it would be tempting to think the direct call was still fine there. It was not: keeping it would have meant an event reaching `sseHub` twice on `role=all` (once direct, once via this bridge's own NOTIFY loopback) and zero times on a split api/worker install. One delivery path, used everywhere, is what makes dev/compose actually exercise the production path.

Cheap either way: one more reconnecting LISTEN connection (events/listen-client.ts) per process, idle until an outbox row commits.
TWO SMALL POOLS FOR THE SSE PATH — ONE isolation decision, in two places (review finding SEC-1)

Neither is the request-serving `pool` above, and for the same reason: the SSE path's database load is driven by EVENT VOLUME and CONNECTED-CLIENT COUNT, not by how many API requests are in flight, and both of those are influenceable from outside a request. `pool` has no `max`, so it is pg's default of 10, and `createPool` sets `connectionTimeoutMillis: 5000` (db/client.ts) — so any SSE-driven checkout that competes with request handlers turns into request TIMEOUTS. Isolating them means a starved SSE pool degrades only SSE (stale frames, dropped frames — best-effort is the stream's own contract, ADR-0025 D4), never request serving or coordination.

1. `sseBridgePool` — the bridge's outbox fetches, driven by a Postgres NOTIFY channel any DB login can write to. `max: 2` caps the blast radius of a NOTIFY flood to this pool alone. 2. `sseAuthzPool` — `GET /events/stream`'s PER-FRAME `object:read` walk (routes/events.ts), one tenant transaction per (connection, distinct subject) per memo window. Its `max` is IMPORTED from that route as `SSE_AUTHZ_POOL_MAX` rather than written as a literal here, so the number and the paragraph justifying it (beside `READ_MEMO_TTL_MS`, which sets how often a check recurs) cannot drift apart.

`deps.sseAuthzDb` is assigned AFTER `buildApp`, exactly like `deps.pluginHost`/`deps.boss` (types.ts): the route reads it inside its handler, and no handler can run before `app.listen` far below.

## §4. M21.4 (ADR-0032 §7): the domain-event stream's real consumers

M21.4 (ADR-0032 §7): the domain-event stream's real consumers. `boss.work()` is a competing consumer, so a feature that reacts to an event registers a ROUTER rather than a second worker on `domain-events` — the router makes one cheap decision and enqueues onto that capability's own queue, worked by the `start…Loop` calls below.

WHICH routers, and under WHICH role guard, is `events/domain-event-registry.ts` — not a literal here. Until M21.7 it was a literal here, and that is precisely why nothing could check it: `main()` runs at module scope, so no test can import this file, so the census that guarded the list had to read this file as TEXT — and text cannot tell a live registration from an unreachable one (an inverted guard leaves the factory's name sitting right there in the source). The registry is a pure value, so `events/domain-event-routers.test.ts` now EXECUTES it for a matrix of configs and asserts what is actually registered, against the set of routers it discovers in the tree. The one thing that census still reads as text is the line below — that this composition root calls `domainEventRouters` at all.

## §5. EVERY BACKGROUND LOOP THIS PROCESS RUNS

EVERY BACKGROUND LOOP THIS PROCESS RUNS — `background-work.ts`'s `BACKGROUND_LOOPS`, not a list of eleven `const`s here, and not eleven matching `.stop()` calls in the `onClose` below.

WHY IT MOVED. This block used to hand-write both halves, and both were unverifiable: nothing can import this file (`main()` runs at module scope), so every test that claimed to check the wiring was matching SUBSTRINGS. Measured 2026-08-17 — flipping this block's own condition to `false`, killing all eleven loops, left `bump-dispatch`, `bump-gate`, `inventory-ingestion` and `domain-event-routers` green at 79/79 and the whole unit suite green. A registry is a pure importable value, so `background-work.test.ts` STARTS it against a probe boss and asserts what actually happened, and a loop that is never registered fails that test rather than shipping inert. Same move, same reason, as M21.7 moving the router list into `domain-event-registry.ts`.

The one link still checked as text is the CALL BELOW — see that test file, which says so.

## §6. GRACEFUL SHUTDOWN ON SIGINT/SIGTERM

GRACEFUL SHUTDOWN ON SIGINT/SIGTERM — newly required by `host.ts`'s process-group kill fix. Plugin subprocesses are now spawned `detached: true` (their own process group, so a hang- timeout SIGKILL can take down a `docker` child with it instead of orphaning it — see that file's `killInstanceProcess` doc comment). The side effect: they no longer sit in THIS process's foreground process group, so a terminal Ctrl-C (`pnpm dev`) no longer reaches them for free the way it used to — nothing here previously called `app.close()` on a signal either, so a plain container SIGTERM (Kubernetes pod termination, pid 1, never a process-group signal) was already not gracefully handled before this change. Both paths now go through the same `onClose` hooks above, which is where `pluginHost.stop()`/`backgroundLoops.stop()`/etc. already live — one graceful-shutdown path instead of relying on OS job-control as an accident of the process tree shape.
