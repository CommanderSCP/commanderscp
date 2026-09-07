# events

Long-form reference for the **events** subsystem — the rationale, hazards and open items that
used to sit inline. Each source file below carries a one-line headline at the site and points here.

> Partial: 64 of 64 multi-line comment blocks in this subsystem are here. The rest are
> still inline, pending a hand-written one-line headline.

## Files

- [`apps/server/src/events/domain-event-registry.ts`](#apps-server-src-events-domain-event-registry-ts) — §1–§5
- [`apps/server/src/events/domain-event-routers.test.ts`](#apps-server-src-events-domain-event-routers-test-ts) — §6–§10
- [`apps/server/src/events/event-bus.integration.test.ts`](#apps-server-src-events-event-bus-integration-test-ts) — §11–§15
- [`apps/server/src/events/event-bus.ts`](#apps-server-src-events-event-bus-ts) — §16–§17
- [`apps/server/src/events/event-stream-route.integration.test.ts`](#apps-server-src-events-event-stream-route-integration-test-ts) — §18–§19
- [`apps/server/src/events/failover-drill.integration.test.ts`](#apps-server-src-events-failover-drill-integration-test-ts) — §20–§23
- [`apps/server/src/events/listen-client.test.ts`](#apps-server-src-events-listen-client-test-ts) — §24–§24
- [`apps/server/src/events/listen-client.ts`](#apps-server-src-events-listen-client-ts) — §25–§27
- [`apps/server/src/events/nats-fanout.ts`](#apps-server-src-events-nats-fanout-ts) — §28–§29
- [`apps/server/src/events/outbox-relay.integration.test.ts`](#apps-server-src-events-outbox-relay-integration-test-ts) — §30–§31
- [`apps/server/src/events/outbox-relay.ts`](#apps-server-src-events-outbox-relay-ts) — §32–§39
- [`apps/server/src/events/outbox-repo.ts`](#apps-server-src-events-outbox-repo-ts) — §40–§40
- [`apps/server/src/events/pgboss.ts`](#apps-server-src-events-pgboss-ts) — §41–§46
- [`apps/server/src/events/sse-bridge-hardening.integration.test.ts`](#apps-server-src-events-sse-bridge-hardening-integration-test-ts) — §47–§48
- [`apps/server/src/events/sse-bridge-notify-authenticity.integration.test.ts`](#apps-server-src-events-sse-bridge-notify-authenticity-integration-test-ts) — §49–§51
- [`apps/server/src/events/sse-bridge-pointer.test.ts`](#apps-server-src-events-sse-bridge-pointer-test-ts) — §52–§52
- [`apps/server/src/events/sse-bridge.integration.test.ts`](#apps-server-src-events-sse-bridge-integration-test-ts) — §53–§56
- [`apps/server/src/events/sse-bridge.ts`](#apps-server-src-events-sse-bridge-ts) — §57–§63
- [`apps/server/src/events/sse-hub.ts`](#apps-server-src-events-sse-hub-ts) — §64–§64

## `apps/server/src/events/domain-event-registry.ts`

### §1. The one registration site for domain-event routers

THE ONE REGISTRATION SITE FOR DOMAIN-EVENT ROUTERS
`boss.work()` is a COMPETING consumer, so a capability that reacts to a domain event registers a `DomainEventRouter` here rather than a second worker on `domain-events` (see that type's doc for the whole argument). This table is what `main.ts` hands to `startPgBoss`.

WHY THIS IS A MODULE AND NOT AN ARRAY LITERAL IN `main.ts`, which is where it lived until M21.7: `main.ts` calls `main()` at module scope, so nothing can import it, so nothing could ever assert what it actually registers. The census that guarded this list therefore read main.ts as TEXT — and a text census passes on a registration that is present but UNREACHABLE. An inverted guard (`allowed ? [] : [router()]`) is invisible to it: the factory name is still right there in the source. Moving the list into an importable, side-effect-free value makes the registration a VALUE a test can execute, which is what `domain-event-routers.test.ts` now does.

WHY EACH ENTRY PAIRS THE FACTORY WITH ITS GUARD instead of the old per-router conditional: with one conditional per router there were four places to invert and four places to mis-bind (wire router A's line to router B's guard). Here there is ONE filter, applied uniformly, and the guard a router runs under sits in the same object literal as the router — so a mis-binding is visible in one line rather than spread across a `?:` chain, and the single filter is covered by a config-independent invariant the test asserts directly (an `api` process registers nothing).

A REFUSED GUARD CONTRIBUTES NO ROUTER, deliberately: an event must not be enqueued onto a queue that this process will never drain, because the worker half is refused by the same guard.

### §2. Every domain-event router in the tree, exactly once

Every domain-event router in the tree, exactly once. `domain-event-routers.test.ts` proves that sentence rather than asserting it: the set of routers is discovered from the filesystem and compared against this table by function identity, so a router built and never added here fails, and one added twice fails.

### §3. M21.4 (ADR-0032 §7) internal release detection

M21.4 (ADR-0032 §7) internal release detection — the FIRST consumer of the domain-event stream. COMMANDER-ONLY (ADR-0032 §7d, owner decision 2026-08-17); this comment previously said it ran on every federation role, deliberately. A FIELD outpost never ORIGINATES a dependency bump — it receives the resulting change down the global pipeline the commander manages — so it derives nothing here. ("Field" is load-bearing: an HQ outpost is the commander's own trust domain and is this process; `dependencies/commander-only.ts` reads that distinction out of the code.)

### §4. M21.5 (ADR-0032 §8) the bump dispatcher

M21.5 (ADR-0032 §8) the bump dispatcher — a line's head advancing is what makes a bump due. Commander-only, and derived rather than copied (see `bumpDispatchRoleGuard`): this job writes to a source repository with a credential, which an air-gapped or high-side outpost must never do. It USED to be the strictest guard in the table, because internal detection ran on every role and so heads advanced at outposts; since ADR-0032 §7d (2026-08-17) every dependency job reaches the same verdict, and this one's reason is still its own rather than inherited.

### §5. The routers THIS process registers. Pure: no I/O, no side effects

The routers THIS process registers. Pure: no I/O, no side effects — which is what lets a unit test call it for a matrix of configs and assert what is actually registered, rather than reading the composition root's source and hoping the text means what it looks like.

## `apps/server/src/events/domain-event-routers.test.ts`

### §6. The router registration census, and its two failure modes

M21.7 item 4 — THE ROUTER REGISTRATION CENSUS
The composition root hands `startPgBoss` a list of `DomainEventRouter`s. That list has TWO failure modes, and until this file the protection against both was a code comment ("Every entry below appears exactly once"), which is a claim rather than a check:

```text
1. REGISTERED TWICE (the rebase hazard). During M21's build a rebase put `acceptedChangeRouter()`
   on both sides of a conflict in that list; concatenating the sides — the naive resolution —
   registers it twice. The domain-events worker calls every router for every event, so the
   capability's queue gets two jobs per event, and `boss.work()` on that queue is a COMPETING
   consumer: it does not deduplicate, it runs the work twice. pg-boss reports nothing.
```

```text
2. NEVER REGISTERED (the "built but never installed" hazard). Every router in this tree has an
   integration test that registers the router ITSELF, because that is the only way to drive it
   deterministically. Those suites stay green when the composition root never wires the router
   at all — which is this codebase's most-shipped defect class (six instances in M21 alone).
```

WHAT THIS FILE ASSERTS AGAINST, AND WHY IT CHANGED. The first version of this census read `main.ts` as TEXT, because `main.ts` calls `main()` at module scope and cannot be imported. Text cannot distinguish a registration that is LIVE from one that is UNREACHABLE: invert the role guard on a registration line (`allowed ? [] : [router()]`) and the factory's name is still right there in the source, so every source census stays green while production registers nothing. So the list itself moved out of `main.ts` into `events/domain-event-registry.ts`, a pure importable value, and the assertions below EXECUTE it — `DOMAIN_EVENT_ROUTERS` compared by function IDENTITY against the routers discovered in the tree, and `domainEventRouters(config)` called for a matrix of deployment configs.

THE GAP THAT REMAINS, STATED PLAINLY RATHER THAN PAPERED OVER: the last link — that `main.ts` passes `domainEventRouters(config)` to `startPgBoss` — is still checked as source text, because importing `main.ts` starts a server. "The composition root wires the registry" is therefore the one property here proven by a substring and not by behaviour. It is a much smaller surface than the old census (one call, not four conditional registrations, with nothing config-dependent left in it), and two of the three ways that substring could lie while present are closed below: a LOCAL SHADOW of `domainEventRouters` (checked for), and the call sitting in a DEAD BRANCH of the argument list (no conditional operator is permitted in it). The third is not closed and cannot be by reading text: whether the enclosing `if (runsBackgroundWork)` block executes at all. A mutation that makes that branch unreachable passes this file, and — checked, not assumed — no other test in this package covers it either, because nothing imports `main.ts`. That is a known, uncovered edge, recorded here rather than implied away.

WHY IT DOES NOT ROT: nothing here names a router. The set of routers is DISCOVERED from the filesystem (every exported factory whose return type is `DomainEventRouter`) and compared against the registry. Add a fifth router module and this census demands it be registered exactly once.

The comparisons are mutual anti-vacuity guards: break discovery and the registry's entries have nothing to match (they land in `registeredButNotDeclared`); empty the registry and every discovered router lands in `declaredButNotRegistered`. Neither half can pass by finding nothing.

### §7. Discovery: what routers EXIST? The scanner itself

Discovery: what routers EXIST?

The scanner itself — the production-source walk, the declaration-start regex and the balanced-paren parameter skip — lives in `@scp/source-census`, shared with the dependency-loop census in `dependencies/commander-only.test.ts`. It was written here first and moved out the moment there were two consumers: a scanner in two copies is exactly the property CLAUDE.md's census rule names, and the next fix to it would have landed in one of them. Read that module for the declaration forms it has to survive and why.

### §8. This read was missed when the sibling census was converted

`readStripped`, and this read was MISSED when the sibling loop census in `dependencies/commander-only.test.ts` was converted — the same file's OTHER read (`mainCode`, below) was converted at the time and this one, three functions up, was not. Fixing one call site of a concept is this codebase's named recurring bug; a census that only half strips is an instance of it.

Measured 2026-08-17, on raw text: an `export function bumpRetryRouter(): DomainEventRouter { … }` written inside a `/* … *\/` block in `dependencies/bump-gate.ts` — a shape reference in a module doc, which is ordinary style in this tree — was DISCOVERED as a real router, imported, found absent from the module, and reported as `declaredButNotRegistered: ["bumpRetryRouter (dependencies/bump-gate.ts)"]`. A false RED, and an unfixable-looking one: it names a router that does not exist and no registry entry can satisfy it. Stripping is what makes this a census of the CODE.

### §9. Balanced-paren scan, because the argument list nests calls

The text between `startPgBoss(` and its matching `)`, by balanced-paren scan rather than a non-greedy regex — the argument list contains nested calls, and a `[\s\S]*?\)` would stop at the first of them the moment anyone reformats the call.

Throws rather than returning empty if the call site cannot be found: "the composition root moved" must be a loud failure, never a census that silently examines nothing.

### §10. No conditional here: a substring cannot see a dead branch

No conditional operator anywhere in the argument list, because a substring cannot tell a live call from one parked in a dead branch (`cond ? domainEventRouters(config) : []`). The routers argument is not a decision this file gets to make — the guards decide, inside the registry, where the decision is observable. A legitimate need for a ternary here fails loudly, which is the right way for that conversation to start.

## `apps/server/src/events/event-bus.integration.test.ts`

### §11. BUILD_AND_TEST.md §8 M3 item 8 DoD

BUILD_AND_TEST.md §8 M3 item 8 DoD: "the event-bus integration suite passes against BOTH Postgres and NATS backends." events/event-bus.ts's own doc comment explains why there's only ONE `EventBus` implementation (`publish()` always just writes the transactional outbox row — the backend can't change that, no broker can join a Postgres COMMIT) and where the two configured backends actually diverge: events/outbox-relay.ts's fan-out step, additionally republishing to a real JetStream stream (events/nats-fanout.ts) when `natsFanout` is passed. So this suite's job is to prove the thing that differs — the relay, driven by a REAL `nats:2.10 -js` Testcontainers instance for the "nats" half — delivers with PARITY across both configured backends (every event reaches the pg-boss `domain-events` queue and every connected SSE subscriber, and the outbox row is only ever marked processed once every configured sink has accepted it — the transactional at-least-once guarantee, DESIGN.md §8, that lets a partially-failed relay batch retry safely instead of silently dropping an event: see outbox-relay.ts's `relayOnce`, which COMMITs only after every sink in the loop iteration succeeded), PLUS the one behavior that genuinely differs per backend: NATS JetStream's broker-side idempotent de-dup keyed by the outbox row id (`msgID`), which Postgres has no equivalent of. Actually killing the relay mid-batch to prove crash/resume is already exercised end to end at the coordination layer (coordination.integration.test.ts "worker-crash resume"); re-driving that same proof here would just duplicate it, so it isn't repeated in this file.

### §12. Hermetic starting point (shared-Postgres singleFork suite)

Hermetic starting point (shared-Postgres singleFork suite): most integration test files create objects — hence outbox rows — but run no relay, so a large backlog of permanently-unprocessed rows accumulates ahead of what this test publishes. This relay drains OLDEST-first, 100 rows per ~1s poll, so a big enough backlog can push delivery of THESE three fresh (newest) rows past even a generous timeout (observed as a flake once the M3 coordination test suites, which land ahead of this file and generate many transition/outbox rows, inflated the backlog). Marking the pre-existing backlog processed makes the relay reach these three rows promptly and deterministically. Uses a throwaway admin/superuser connection — test-only diagnostics, never how the app itself queries.

### §13. Generous timeout: this suite shares one forked process

Generous timeout: this suite runs alongside every other `withEventRelay: true` integration test in the same singleFork Vitest process (test-support/global-setup.ts), each with its own 1s-poll relay/reconcile-loop timers competing for the event loop and the shared Testcontainers Postgres — under that full-suite load the default 15s waitUntil budget has been observed to be too tight even though delivery itself is healthy (coordination.integration.test.ts's own waits already budget up to 20s for the same reason).

### §14. Ack means every sink accepted it, not just the first

"Ack": the relay's per-row loop only reaches the trailing UPDATE (and the batch only COMMITs) after pg-boss's send, the SSE publish, and (nats backend) the JetStream publish all succeeded — so seeing `processed_at` set here, read from a connection that bypasses RLS entirely (admin/superuser, test-only diagnostics — never how the app itself queries), is proof the WHOLE batch committed, not merely that the in-process SSE EventEmitter (which can't itself fail) happened to fire.

POLLED, NOT READ ONCE — this fixes a real race, observed failing CI on PR #172 as "expected null not to be null". The SSE wait above returns as soon as the in-process EventEmitter has fired for all three events, and the relay publishes to SSE INSIDE the batch, BEFORE the trailing UPDATE and the COMMIT. So `received.length >= 3` is genuinely satisfiable while `processed_at` is still NULL, and a bare SELECT here is a coin flip decided by how fast the commit lands after the last publish. Under full-suite load (49 files, competing 1s-poll timers, one shared Postgres — see the SSE wait's own comment) it loses that flip. The pg-boss assertion immediately below ALREADY wraps itself in `waitUntil` for exactly this reason and says so; this one was simply missed.

This does NOT weaken the assertion. The claim is "the whole batch commits", not "the batch has already committed by the instant SSE fired" — nothing in the design promises the latter. A relay that never commits still fails here, on the timeout.

### §15. The same commit also reached the job queue, a distinct sink

pg-boss delivery: the SAME relay commit also reached the `domain-events` queue — a job-queue subscriber, a distinct fan-out target from SSE's broadcast — for BOTH backends, since outbox-relay.ts always sends to pg-boss regardless of `config.eventBus.backend`. `job` is a live queue table, `archive` is where pg-boss moves completed jobs on its own maintenance schedule — union both so this isn't racing that internal timing.

## `apps/server/src/events/event-bus.ts`

### §16. Internal event-bus abstraction (DESIGN.md §8)

Internal event-bus abstraction (DESIGN.md §8): "the internal `EventBus` interface is broker-agnostic".

M3 design decision (BUILD_AND_TEST.md M3 item 8, DESIGN.md §8 "Scaling insurance"): adding the NATS JetStream backend did NOT require a second `EventBus` implementation or any change to this interface. `publish()` runs *inside* the caller's Postgres transaction — there is no way to atomically "publish to NATS" as part of a Postgres COMMIT (two different systems, no distributed transaction), so write-then-publish atomicity can only ever be bought by writing the outbox row, exactly as `PostgresEventBus` already does. That holds identically whether the configured backend is `postgres` or `nats`.

What actually differs per backend is where the outbox RELAY (events/outbox-relay.ts) fans relayed rows out to: pg-boss + SSE always; additionally NATS JetStream (events/nats-fanout.ts) when `config.eventBus.backend === "nats"`. That selection is wired up once at boot (main.ts) / per-test (test-support/harness.ts) by conditionally passing a `NatsFanoutHandle` into `startOutboxRelay` — `eventBus` itself stays this same `PostgresEventBus` singleton for every caller (graph/objects-repo.ts, graph/relationships-repo.ts, ...) regardless of backend, so none of those call sites needed to change.

### §17. The one and only `EventBus`

The one and only `EventBus` — every mutation publishes through this instance regardless of `config.eventBus.backend`. See the interface doc comment above for why the NATS backend never needed a second implementation here.

## `apps/server/src/events/event-stream-route.integration.test.ts`

### §18. The event stream end to end, over real HTTP via the SDK

`GET /events/stream` end to end, over real HTTP, through the generated SDK (ADR-0025).

The unit layer proves the CONTRACT (openapi/build-document.test.ts: the 200 is declared `text/event-stream`) and the SDK layer proves RECONNECTION (packages/sdk/src/event-stream.test.ts, against a loopback server). Neither proves that the real Fastify route still streams: declaring the operation added a `schema` block to a handler that writes to `reply.raw` and never calls `reply.send`, and that is exactly the kind of change that can turn a working stream into a route Fastify tries to serialize. So this drives the shipped path — relay → `sseHub` → the real route → the real generated `streamEvents` operation → `client.events.stream()`.

### §19. THE SUBJECT MUST BE AN OBJECT THIS CALLER CAN READ

THE SUBJECT MUST BE AN OBJECT THIS CALLER CAN READ. The route admits each frame with an `object:read` check at `event.subject` (routes/events.ts), so the free-form probe string this used to publish is now refused before the pool — correctly: it names no object. The org root IS an object (`objects.id = orgId`) and this caller is the bootstrap admin, bound Owner there, so the frame is delivered on the strength of a real binding rather than on the absence of a check. `scp.object.updated` keeps the probe distinguishable from the org-root creation event `createTestOrg` itself wrote.

## `apps/server/src/events/failover-drill.integration.test.ts`

### §20. §7.5 FAILOVER DRILL

§7.5 FAILOVER DRILL — the outbox→NOTIFY→bridge→sseHub delivery path must SURVIVE losing its Postgres connections mid-flight and keep delivering, exactly once. A promoted primary evicts the long-lived LISTEN connections this path depends on; the drill reproduces that by `pg_terminate_backend`-ing BOTH of them by pid (deterministic, unlike a container restart — and scoped rather than a blanket kill, for the flakiness reason documented at the kill site), then asserts a post-failover event still flows end to end and is delivered ONCE — proving the M26.1 reconnecting relay wake-listener (§4-A5) + sse-bridge reconnect (§7.1.1) + the pool error handler and fast-fail timeouts (§4-A6, db/client.ts) actually recover as designed. The kill itself is asserted (≥2 backends terminated), so the drill cannot pass vacuously by finding nothing to kill. (Fork/duplicate under concurrency is separately gated by divergence-rails, reconcile-startup-singleton and watchdog-race.)

### §21. THE FAILOVER: terminate BOTH long-lived LISTEN backends

THE FAILOVER: terminate BOTH long-lived LISTEN backends — the relay's wake listener (`scp_outbox_insert`) and the SSE bridge's (`scp_sse_events`). These are precisely the connections a promoted primary evicts and precisely what the M26.1 reconnecting LISTEN client (§4-A5, §7.1.1) exists to survive; killing them is what makes this a failover drill rather than a delivery test.

DELIBERATELY NOT a blanket kill of every backend (or of every `scp_app` backend). Both wider forms also evict pg-boss and the harness's own runtime pool, which then reconnect-storm against a database the NEXT run is trying to re-create — measured as `Hook timed out in 60000ms` in `beforeAll` on 1-of-2 and then 1-of-5 consecutive runs. A test that reds CI a fifth of the time teaches people to ignore CI, so the blast radius is scoped to the connections whose recovery is the actual claim.

### §22. WAIT FOR THE BRIDGE TO BE LISTENING AGAIN BEFORE PUBLISHING

WAIT FOR THE BRIDGE TO BE LISTENING AGAIN BEFORE PUBLISHING. This is not tidiness, it is the difference between testing the product and testing a coin flip: **LISTEN/NOTIFY has no replay**. Both the relay and the bridge were just evicted, and they race to recover independently. If the relay wins, it emits `pg_notify('scp_sse_events', …)` for the probe below while the bridge is still disconnected — and that notification is gone permanently, so the probe is never delivered live no matter how long the test waits.

That is CORRECT PRODUCT BEHAVIOUR, not a bug: an event published during a bridge outage is not recoverable from the live stream, which is exactly why reconnecting publishes a resync (ADR-0025) so clients refetch what they missed. Asserting live delivery of an event published mid-outage would assert a guarantee the design deliberately does not make.

MEASURED: without this barrier the drill failed in CI with the relay having demonstrably processed the probe (`[worker] domain-events: scp.failover_drill.probe` in the log) while the bridge never saw it. The sibling reconnect test in `sse-bridge.integration.test.ts` passed in the same run precisely because it waits first.

The wait EXCLUDES the pids just terminated, so a backend still winding down cannot satisfy it and let the publish through early.

### §23. POSITIVE SIGNAL rather than a settle sleep

POSITIVE SIGNAL rather than a settle sleep (integration-sleep-census.test.ts's property): a THIRD probe, published after the first two and awaited. The relay walks the outbox in commit order and NOTIFY is ordered per channel, so once probe three has been delivered, any duplicate of the earlier two would already have arrived — making "exactly one of each" a claim about work that provably finished, not about a wall-clock guess.

## `apps/server/src/events/listen-client.test.ts`

### §24. Backoff must not reset on connect, only after it stays up

SEC-5: the reconnect backoff must NOT reset to its floor on connect — only after the connection has stayed up `stabilityWindowMs`. Otherwise a connection killed immediately after every connect reconnects at the floor forever, and each reconnect fires `onReconnect` (on the SSE bridge, a full unscoped cache-invalidation broadcast). This test flaps the connection inside the stability window and asserts the inter-reconnect delay GROWS instead of pinning at the floor.

## `apps/server/src/events/listen-client.ts`

### §25. Fired after every successful

Fired after every successful (re)connection has re-issued every `LISTEN`, INCLUDING the very first connection. A caller with nothing to catch up on (the outbox relay's wake listener — its 1s poll fallback already covers a missed NOTIFY) can leave this unset; the SSE bridge (proposal §7.1 item 1) uses it to broadcast a resync to locally-connected clients, since a gap in this LISTEN connection is exactly a gap in what `sseHub` could have received.

### §26. How long a connection must stay up before backoff resets

How long a connection must STAY up before the backoff is reset to its floor. Default 5000ms. Without this, a connection that dies immediately after every connect (an on-path attacker RST-ing the socket, review finding SEC-5) reset the backoff to the floor on each connect and reconnected every `minBackoffMs` — each reconnect firing `onReconnect`, which on the SSE bridge is a full unscoped cache-invalidation broadcast. Resetting only after the connection has proven stable makes a flapping connection back off toward `maxBackoffMs` instead.

### §27. A reusable reconnecting `LISTEN` client

A reusable reconnecting `LISTEN` client (proposal multi-region-instance-resilience.md §7.1 item 1, fixing §4-A5): wraps one dedicated `pg.Client`. On a connection error OR an unexpected clean end (`pg_terminate_backend` closes without necessarily emitting `error` first — both paths must reconnect, which is why this listens for both events, not just `error`), it reconnects with capped exponential backoff, re-issues every `LISTEN`, and calls `onReconnect`.

BUG A5, restated: the old outbox relay held a raw `pg.Client` whose `on('error')` only logged (events/outbox-relay.ts, pre-M26.1). Any Postgres blip — a restart, a failover, a load balancer idle-timeout — silently and permanently demoted that process to its 1s poll fallback, with nothing in the logs saying so was now the *only* thing driving it. This client is the fix, shared by the relay's own wake listener and the new SSE bridge (events/sse-bridge.ts) rather than fixed in one place and left broken in the other.

## `apps/server/src/events/nats-fanout.ts`

### §28. NATS JetStream fan-out for the outbox relay

NATS JetStream fan-out for the outbox relay (DESIGN.md §8 "Scaling insurance" — NATS JetStream `EventBus` implementation built early in MVP, M3). Design decision (see events/event-bus.ts's doc comment for the full rationale): `EventBus.publish()` is UNCHANGED and identical for both backends — it always writes the transactional outbox row, because write-then-publish atomicity is a Postgres-transaction property no broker can join. What "NATS backend" actually means is that `outbox-relay.ts`'s relay loop, after claiming an outbox row, ALSO republishes it to a JetStream stream (in addition to its existing pg-boss + SSE fan-out) — this module is that additional sink.

Subject convention: `scp.events.<orgId>.<type>` on stream `SCP_EVENTS` (subjects `scp.events.>`). Consumers can bind to `scp.events.>` for everything, `scp.events.<orgId>.>` for one org, or a literal type suffix to filter further.

Idempotency: the outbox row's `id` (a uuidv7, globally unique and monotonic) is passed as `JetStreamPublishOptions.msgID`, which JetStream uses for its own broker-side de-duplication within the stream's `duplicate_window` — belt-and-braces with the same id also traveling in the message body and an `Scp-Event-Id` header, so subscribers can dedupe themselves even outside that window (DESIGN.md §8: "at-least-once delivery; handlers are idempotent, keyed by event id").

### §29. Connects to NATS and ensures the JetStream stream exists

Connects to NATS and ensures the JetStream stream exists. Called once at boot (main.ts) when `config.eventBus.backend === "nats"`, or per-test in the NATS-backend integration suite. Deliberately fails loudly (throws) on an unreachable/misconfigured server rather than swallowing the error — NATS is fully optional (unset backend never calls this), but once opted into, a broken connection must not silently degrade to "events go nowhere" (task brief / DESIGN §8).

## `apps/server/src/events/outbox-relay.integration.test.ts`

### §30. Never mark a row processed until every sink accepted it

CRITICAL #5 (PR #7 review — "relay can permanently drop a NATS-bound event"): the relay must never mark an outbox row `processed_at` until EVERY sink configured for `eventBusBackend` has actually accepted it. Uses a controllable fake `NatsFanoutHandle` (not a real NATS Testcontainer — events/event-bus.integration.test.ts already proves real JetStream parity; this suite is about OUR relay code's mark-after-all-sinks guarantee specifically, independent of real broker behavior) whose `publish()` can be toggled to fail on demand.

### §31. Hermetic starting point

Hermetic starting point (this is a SHARED-Postgres, singleFork suite): every test file that creates objects writes outbox rows, and most of them run NO relay, so a large backlog of permanently-unprocessed rows accumulates ahead of anything this test publishes. The relay drains that backlog OLDEST-first, 100 rows per ~1s poll — so without this pre-clean, once the NATS sink "recovers" below the relay would have to grind through hundreds of stale backlog rows before it ever reaches our probe, blowing the recovery timeout (the exact flake this fixes). Marking the pre-existing backlog processed makes our probe the ONLY pending row, so the relay's behaviour is deterministic and every `publishCalls` entry is genuinely about our probe. It does NOT weaken the assertions: the "stays unprocessed while failing" half still catches a mutation that marked rows processed on failure.

## `apps/server/src/events/outbox-relay.ts`

### §32. Worker-side half of the transactional outbox (DESIGN.md §8)

Worker-side half of the transactional outbox (DESIGN.md §8): claims unprocessed rows with `FOR UPDATE SKIP LOCKED` (safe under multiple worker replicas), relays each to the pg-boss `domain-events` queue and issues a `scp_sse_events` NOTIFY for it, then marks it processed — all in one transaction per batch. Wakes immediately on the `scp_outbox_insert` NOTIFY (drizzle/0002_rls_rbac_seed.sql's trigger fires post-commit) with a 1s poll as the fallback.

SINCE M26.1 (proposal multi-region-instance-resilience.md §7.1 item 1, closing §4-A1): this no longer calls `sseHub.publish` directly. The relay and the SSE-serving process are two disjoint process sets under the default chart topology (api×N + worker×N) — an in-process `EventEmitter` cannot cross that boundary. `pg_notify` can: it is issued from INSIDE the same transaction as the batch, so delivery is atomic with the COMMIT, and events/sse-bridge.ts (started in every process that serves `GET /events/stream`) is what actually feeds each process's local `sseHub`. This is now the ONLY delivery path in every topology, including a single `role=all` process where the relay and the SSE route already share one process — no separate direct-publish shortcut, so there is exactly one way an event reaches `sseHub` rather than two that could double-deliver it.

The relay legitimately needs cross-org visibility (it fans out every org's events), but gets it through the narrowest possible mechanism (PR #4 security review, CRITICAL 3): it runs on the least-privileged runtime pool (`scp_app` login) and assumes the `scp_relay` role with `SET LOCAL ROLE` inside each transaction. `scp_relay` (drizzle/0003_runtime_roles.sql) is NOBYPASSRLS and is granted ONLY on `outbox` (SELECT + UPDATE, with a permissive policy on that one table) — it cannot read or write objects/relationships/role_bindings/audit_events.

`eventBusBackend` (DESIGN.md §8 "Scaling insurance", BUILD_AND_TEST.md M3 item 8) is the NATS JetStream backend toggle: `"postgres"` (the default) means this relay behaves exactly as it always has (pg-boss + SSE only, zero new dependency). `"nats"` means every row is ALSO republished to JetStream, in the same per-row step as the pg-boss send and the SSE publish — if it throws, the whole batch transaction rolls back and the row is retried on the next NOTIFY/poll, exactly like a pg-boss `send` failure already does today. `EventBus.publish()` itself (events/event-bus.ts) is unchanged for both backends: it only ever writes the outbox row, because write-then-publish atomicity is a Postgres-transaction property no broker can join — the backend distinction lives entirely here, in what the relay fans out to.

CRITICAL #5 fix (PR #7 review — "relay can permanently drop a NATS-bound event"): the OLD signature took an optional `natsFanout` handle and gated the JetStream publish on whether that PARTICULAR handle happened to be truthy (`if (natsFanout)`), with nothing tying that to the deployment's actually-configured backend. A relay instance constructed without a `natsFanout` handle — a misconfiguration, a partial rollout, a caller that simply forgot — could win an outbox row via `FOR UPDATE SKIP LOCKED`, silently skip the NATS publish, mark the row `processed_at`, and commit: the event is gone from JetStream forever, with no error anywhere. `eventBusBackend` makes the intended backend an explicit, required argument instead of an inferred side-effect of whether a handle happens to be present — and the constructor below throws immediately if they're inconsistent (`"nats"` with no handle), turning that misconfiguration into a loud boot-time failure instead of a silent per-row data loss. Within one relay instance this is now airtight: `processed_at` is set only after every one of ITS configured sinks (pg-boss, SSE, and — when `eventBusBackend === "nats"` — JetStream) has accepted the row; any sink throwing rolls back the whole batch and the row is retried.

Tracked follow-up (same idiom as the pg-boss-role / OIDC-allowlist items in BUILD_AND_TEST.md §8 M3 item 9): this does NOT yet detect two DIFFERENT relay processes sharing one outbox table with genuinely inconsistent `SCP_EVENT_BUS_BACKEND` config across replicas — that needs a small persisted "this deployment's backend is X" marker checked at every relay's boot, which is real scope (a migration + a cross-replica agreement check) beyond this fix. Single -process behavior (main.ts boots exactly one relay per `role=worker/all` process, from exactly one `config.eventBus.backend`) is airtight today; multi-replica config drift is an operator misconfiguration this doesn't yet turn into a startup error.

### §33. A post-commit hook handed the org ids a batch touched

M14.3 (ADR-0009) — post-commit hook handed the DISTINCT org ids a just-committed batch produced events for. Fire-and-forget: invoked AFTER COMMIT, OUTSIDE the `scp_relay` tx (that role can read only `outbox`), synchronous up to its own internal scheduling, and wrapped so a throw can never roll back or wedge the relay. The commander poke sender (federation/ poke-sender.ts) uses it to nudge poke-mode peers to pull — the "outbox-derived" federation feed of DESIGN §5, reusing this exact machinery rather than inventing a new event source.

### §34. Tracks every relayOnce() call currently in flight

Tracks every relayOnce() call currently in flight (there can be more than one: the 1s poll timer, the LISTEN/NOTIFY handler, and the initial kick-off below all fire independently — see `trigger()`). `stop()` awaits this set before returning, which is the actual fix for a real shutdown-race bug: without it, a caller that calls `stop()` then immediately closes `runtimePool` (main.ts's onClose hook, test-support/harness.ts's close()) could tear down the pool out from under a relayOnce() that was still mid-query, producing "TypeError: Cannot destructure property 'rows' of ... as it is undefined" — `client.query()` resolving to `undefined` instead of rejecting, a rare-but-real pg behavior when the connection is destroyed mid-flight. See the defensive `result?.rows` guard below too — belt and braces, since ordering discipline alone can't prove every possible teardown interleaving.

### §35. Defensive guard (see `inFlight` doc comment above)

Defensive guard (see `inFlight` doc comment above): a client torn down mid-query by pool shutdown has been observed to resolve `query()` with `undefined` rather than rejecting. Treat that as "no rows this pass" instead of crashing — nothing is lost, since the row(s) are simply left unprocessed and picked up by the next relayOnce() (or, if the process really is shutting down, by the relay after restart).

### §36. SSE fan-out (M26.1 §7.1 item 1, revised by review finding F1)

SSE fan-out (M26.1 §7.1 item 1, revised by review finding F1): NOTIFY from INSIDE this transaction, so delivery is atomic with the batch COMMIT. The payload is a POINTER, never the event itself: NOTIFY is not channel-access-controlled, so any DB login can inject a frame on this channel — the bridge therefore re-derives every event from the authoritative `outbox` row by id and treats nothing in the payload as authority. `orgId` rides along strictly as a non-authoritative observability hint. This also makes payload size independent of event size (no ~8000-byte NOTIFY-cap path to split on).

### §37. Tracks each run so `stop()` can await work in flight

Fires relayOnce() and tracks it in `inFlight` so `stop()` can await it — every trigger source (NOTIFY, the poll timer, the initial kick-off) goes through this instead of calling relayOnce() directly. Synchronous up to its `stopped` check, so once `stop()` sets `stopped` no new relayOnce() can start afterward (JS's single-threaded run-to-completion semantics: no interleaving is possible between `stop()`'s synchronous prefix and any event-loop callback that calls `trigger()`).

### §38. The wake LISTEN (§4-A5 fix)

The wake LISTEN (§4-A5 fix): now the shared reconnecting client (events/listen-client.ts) instead of a raw `pg.Client` whose `on('error')` only logged — a Postgres blip used to silently and permanently demote this relay to the 1s poll fallback with no reconnection ever attempted. `onReconnect: trigger` is a belt-and-braces catch-up (the poll fallback already covers a missed NOTIFY, but there is no reason to wait up to 1s for it after a connection that just came back).

### §39. Stops the relay deterministically

Stops the relay deterministically: no new relayOnce() can start after this is called, AND every already-in-flight relayOnce() has settled by the time this resolves. Callers (main.ts's onClose hook, test-support/harness.ts's close()) rely on that ordering to close `runtimePool` immediately afterward without racing a query against a torn-down client — this is what actually fixes the shutdown-race bug described on `inFlight` above; the `result?.rows` guard in relayOnce() is the belt-and-braces backstop for any interleaving this ordering doesn't cover.

## `apps/server/src/events/outbox-repo.ts`

### §40. Writes one CloudEvents-shaped row in the caller's transaction

Writes one CloudEvents-shaped row in the caller's transaction (DESIGN.md §8: "every domain mutation writes a CloudEvents-1.0-shaped row to an outbox table in the same transaction"). The `outbox_notify_trigger` (drizzle/0002_rls_rbac_seed.sql) fires `pg_notify` after commit; the worker's outbox relay (events/outbox-relay.ts) picks rows up from there.

## `apps/server/src/events/pgboss.ts`

### §41. A SELF-RESCHEDULING LOOP'S STARTUP KICK IS SENT **UNKEYED**

A SELF-RESCHEDULING LOOP'S STARTUP KICK IS SENT **UNKEYED**. It must ALWAYS insert.

This is the second correction to §4-A4, and the reason is that pg-boss gives standard-policy queues exactly one singleton index and it is the wrong shape for a startup kick (pg-boss 10.4.2, `src/plans.js`):

```text
job_i4 ON (name, singleton_on, COALESCE(singleton_key,'')) WHERE state <> 'cancelled'
                                                             AND singleton_on IS NOT NULL
```

Three consequences, all measured: - it applies ONLY when `singletonSeconds` is supplied (`singleton_on IS NOT NULL`), so a `singletonKey` alone constrains nothing on these queues — "keyed but no window" is just an unkeyed send wearing a key; - it counts COMPLETED jobs as still holding the slot, and `singleton_on` is a wall-clock BUCKET, so ANY window can swallow a later send — the window size only changes the odds; - a losing insert is `ON CONFLICT DO NOTHING RETURNING id`: it returns NULL **silently**.

A self-rescheduling loop's only other tick source is the reschedule inside its own handler, so one swallowed kick means no job -> no handler -> no reschedule -> **the loop is dead forever**, with no error, no log, and no failing health check. A4 first shipped the kick sharing the chain's `"tick"` key, which killed the 60s loops after a single sweep on ~58 of every 60 boots. Moving it to its own key + a 10s window fixed that and then broke CRASH RESUMPTION instead: a worker that dies mid-tick (so the chain never rescheduled) and restarts inside the window had its kick swallowed by its OWN previous boot, and came back dead. Measured as `coordination.integration.test.ts`'s crash-resumption test timing out waiting for a change to reach `validating` after a worker restart.

SO: no key, no window — the kick always inserts, and the loop always lives. What this gives up is A4's stated goal, N replicas booting together collapsing to ONE startup sweep; that was always an EFFICIENCY optimisation, and the redundant sweeps are safe (every sweep claims its rows with `FOR UPDATE SKIP LOCKED` / per-row advisory locks, which is what makes N competing workers correct in the first place). Trading a liveness guarantee for it was the wrong bargain in both directions. `dependencies/bump-freeze-redrive.ts` has always sent unkeyed; it is now the shape for all of them.

THE SECOND OCCURRENCE OUTLIVED THE FIRST FIX BY A WHOLE COMMIT, in `federation/federation-sync.ts`, because two things that both looked like safeguards were not: - an earlier version of THIS COMMENT recommended the private-key-plus-window shape, citing that file as the exemplar to copy; - `coordination/loop-startup-singleton.test.ts` matched the literal key `"tick"`, so a startup kick keyed `"startup"` passed it. It now matches on `singletonSeconds` instead — the ingredient that actually creates a slot — and carries a positive control, because until then the rule was green purely by absence and could have been deleted without failing. Measured there: two sends ~3-6s apart (pg-boss's 2s `pollingInterval` dominates the gap) against a 10s bucket, i.e. a ~0.4-0.7 coin flip on EVERY machine. It presented as "only fails in CI", and the direction is the opposite of the intuition — a slower runner lengthens the gap and makes the collision LESS likely. "Flaky on CI, green locally" was never evidence about the runner.

### §42. One relayed outbox row, typed as the relay writes it

One relayed outbox row, as the outbox relay sends it onto `DOMAIN_EVENTS_QUEUE` (`events/outbox-relay.ts`). Fields are typed as what the relay writes; `data` stays `unknown` because every event type carries its own payload and a router must narrow its own.

### §43. A SUBSCRIBER TO THE DOMAIN-EVENT STREAM

A SUBSCRIBER TO THE DOMAIN-EVENT STREAM — and the reason this seam exists at all.

`boss.work()` is a COMPETING consumer: a second `work()` call on `DOMAIN_EVENTS_QUEUE` does not add a second listener, it splits the jobs between the two handlers at random. So a feature that needs to react to a domain event cannot simply register its own worker on this queue — it would steal roughly half the events from whoever else is on it and receive roughly half of its own. That is why, until M21.4, this queue's handler only logged and NOTHING in the tree consumed a domain event: there was no way to add one without that hazard.

A router is the fan-out point instead. It is deliberately NOT where the work happens: it makes one cheap decision ("is this event mine?") and, if so, enqueues onto the CAPABILITY'S OWN QUEUE — the one-queue-per-capability shape every background loop in `main.ts` already uses. Doing the work inline here would put a feature's latency and its retry budget on the shared event stream: one slow git fetch would hold up every other event in the instance, and one poison event would burn the domain-event queue's retries rather than its own.

`queue` is declared so `startPgBoss` can create it BEFORE the domain-events worker starts — otherwise the very first event could be routed to a queue that does not exist yet.

### §44. Thrown when a routers list registers the same one twice

Thrown when a routers list registers the same subscriber twice, or hands two different subscribers the same destination queue. Carries the offending identifiers as DATA rather than only in the message, so a caller (and a test) can assert WHICH registration is duplicated instead of matching prose.

### §45. Refuse a double registration at boot, since it is silent

REFUSE A DOUBLE REGISTRATION AT BOOT, because it is otherwise SILENT.

The domain-events worker calls every router for every event, so a router listed twice enqueues TWICE per event onto its capability's queue — and `boss.work()` on that queue is a COMPETING consumer, so the second copy is not deduplicated, it is picked up and the capability's work runs again. None of pg-boss's machinery complains: no error, no warning, just a queue with double the traffic and jobs that fire twice.

This is not a hypothetical. During M21's build a rebase put `acceptedChangeRouter()` on BOTH sides of a conflict in the registration array (then a literal in `main.ts`, now `events/domain-event-registry.ts`); concatenating the two sides — the naive resolution — would have shipped exactly that. The protection at the time was a code comment saying "every entry below appears exactly once", which is a claim, not a check. This is the check. It runs BEFORE any connection is opened so that a misregistration fails the process immediately and cheaply, rather than after the first event has already been double-routed.

Two different routers sharing one `queue` is the same defect wearing a different hat: that queue has ONE worker, owned by one capability, expecting one job shape — so the other router's jobs are either mis-shaped or a second enqueue of the first's work.

### §46. pg-boss worker skeleton

pg-boss worker skeleton (DESIGN.md §8, BUILD_AND_TEST.md §8 M1 item 7): durable job queue over Postgres, proving the outbox → job pipeline flows end to end.

`databaseUrl` is the schema-scoped `scp_pgboss` login role's connection string (config.pgBossDatabaseUrl — M3 tracked security follow-up, drizzle/0008_pgboss_role.sql), not the admin/superuser URL. `schema: "pgboss"` is passed explicitly rather than relying on pg-boss's own default (verified to also be `"pgboss"` in the installed version's src/plans.js#DEFAULT_SCHEMA) — the migration's schema name and pg-boss's own must always agree, and an explicit option here can't silently drift from a future pg-boss upgrade's default.

`routers` (M21.4) are the real subscribers — see `DomainEventRouter` for why they are routers rather than additional `work()` registrations. A router throwing does NOT stop the batch: every router is isolated per event, because one capability's enqueue failing must not make the shared event stream redeliver events to every OTHER capability. The failure is logged loudly with the event id, and the capability's own recovery is that its work is a DERIVATION — re-running it for a later event of the same subject reaches the same answer.

## `apps/server/src/events/sse-bridge-hardening.integration.test.ts`

### §47. M26.1 review hardening gates for the SSE bridge

M26.1 review hardening gates for the SSE bridge (findings SEC-1 work-gate, SEC-2 replay, SSE-2 teardown drain). Each pins a property whose absence let the finding ship, and each is written to go RED under the exact mutation that reintroduces the defect. The NOTIFY payload is the relay's pointer `{id, orgId}`; here we insert the authoritative outbox row directly and drive the pointer ourselves, so the tests exercise the bridge in isolation from the relay (buildTestServer starts no background relay/bridge).

### §48. FRAME 2 IS THE POSITIVE SIGNAL

FRAME 2 IS THE POSITIVE SIGNAL (integration-sleep-census.test.ts's property — a fixed sleep would be flaky on a loaded box and vacuous on an idle one). It targets an org subscribed BEFORE frame 1 was sent, which is load-bearing: subscribing to the QUIET org here instead would race the bridge, since frame 1 is often still unprocessed at that moment and would then legitimately fetch (measured: connectCount 2). NOTIFY is ordered per channel and the bridge consumes one LISTEN connection in order, so frame 2's delivery proves frame 1 was already handled.

## `apps/server/src/events/sse-bridge-notify-authenticity.integration.test.ts`

### §49. The security contract, and this test is its standing guard

SECURITY CONTRACT (M26.1 review finding F1 — fixed; this test is the standing gate).

Postgres NOTIFY is not channel-access-controlled: any role that can merely CONNECT can `pg_notify('scp_sse_events', …)` — including `scp_pgboss`, which is deliberately granted NOTHING on `outbox` precisely so a pg-boss compromise cannot read tenant data. The bridge's original full-envelope fast path validated the payload's SHAPE, not its AUTHENTICITY, and keyed delivery on the payload's OWN `orgId` — letting any DB login fabricate an event for any tenant's live SSE stream (a cross-tenant integrity regression the M26.1 cross-process bridge introduced).

The contract pinned here: the NOTIFY payload is a POINTER, never authority. The relay NOTIFYs an id (+ orgId as a non-authoritative hint), and the bridge ALWAYS re-derives the event from the authoritative `outbox` row under `SET LOCAL ROLE scp_relay` — one fetch path for every event, so a frame no outbox row backs delivers nothing, to anyone.

### §50. The listen is established asynchronously and has no replay

The bridge's LISTEN is established asynchronously and NOTIFY has no replay. That matters DOUBLY here: a forged frame sent before the LISTEN is up would never reach the bridge at all, so "nothing was delivered" would be true for the wrong reason and this security test would pass VACUOUSLY. Wait for the LISTEN first, so the forgery is genuinely seen and genuinely dropped. (Shared helper — see sse-bridge.integration.test.ts.)

### §51. POSITIVE SIGNAL for a negative assertion

POSITIVE SIGNAL for a negative assertion (integration-sleep-census.test.ts's property — a fixed sleep here would be both flaky on a loaded box and vacuous on an idle one). Instead: send a GENUINE frame, backed by a real outbox row, immediately after the forgery. NOTIFY is ordered per channel and the bridge consumes one LISTEN connection in order, so the moment the genuine event arrives, the forged frame has DEFINITIVELY already been processed — and dropped.

## `apps/server/src/events/sse-bridge-pointer.test.ts`

### §52. The NOTIFY-payload gate

The NOTIFY-payload gate (review findings SEC-1 cheap-fetch leg + SEC-3 log injection). Every legitimate pointer id is an `outbox.id` (`uuid`), so anything not UUID-shaped cannot back a row and must be rejected BEFORE it reaches the pool or a log line. This pins that the payload gate is a UUID gate, not just a `typeof === "string"` gate.

## `apps/server/src/events/sse-bridge.integration.test.ts`

### §53. THE CROSS-PROCESS PROOF

THE CROSS-PROCESS PROOF (proposal multi-region-instance-resilience.md §7.1 item 1, closing §4-A1). The relay and the bridge here run against SEPARATE `pg.Pool`s / separate dedicated LISTEN connections — deliberately mirroring outbox-relay.integration.test.ts's own convention for simulating "two processes sharing one Postgres" — so the only channel between them is the `scp_sse_events` NOTIFY this suite exists to prove. Both still run in one Node process (as every integration test here does; there is no real OS process boundary to cross in a test), but that is exactly the same honest simplification `outbox-relay.integration.test.ts` already makes: the thing under test is the POSTGRES boundary, not an OS one.

### §54. The dedicated listen connection is identifiable by its query

The bridge's dedicated LISTEN connection is identifiable by the literal query it issued and never issues again (startReconnectingListenClient's connect() runs exactly one `LISTEN scp_sse_events` per connection and nothing else on that client) — Postgres retains the last query text for an idle backend in `pg_stat_activity.query`. Scoped to this worker's own database (vitest.integration.config.ts: one private database per test FILE).

### §55. THE WIRING PROOF

THE WIRING PROOF. `main.ts` starts `startSseBridge` for EVERY role because `app.listen()` there is itself unconditional — an api-role process genuinely serves `GET /events/stream` and has nothing else that can ever feed its `sseHub` now that the relay's direct `sseHub.publish` call is gone (outbox-relay.ts's doc comment). This test calls that SAME production function (`startSseBridge`) directly against a `role=api` server — the idiom `plugin-host/host-bootstrap.integration.test.ts` established for exactly this shape of proof ("these tests therefore call the PRODUCTION wiring directly rather than relying on the harness") — and, unlike that precedent, demonstrates the NEGATIVE case in the same run: an api-role process with a real relay running elsewhere but NO bridge started against it receives nothing, and the identical event published afterward IS received the moment `startSseBridge` is called. Removing the `startSseBridge(...)` call from this test (as opposed to from `main.ts`, which is the one link every loop-wiring test in this tree still accepts checking only as text — background-work.ts's own doc comment says so) turns the SECOND assertion into a timeout.

### §56. POSITIVE SIGNAL for a negative assertion

POSITIVE SIGNAL for a negative assertion (integration-sleep-census.test.ts's property): the relay stamps `processed_at` when it has relayed the row, and the removed direct-publish path ran BEFORE that stamp inside the same relayOnce() — so once the stamp is visible, a still-empty `received` proves the old path is gone, with no fixed budget to go vacuous under contention or spuriously red on a slow box.

## `apps/server/src/events/sse-bridge.ts`

### §57. RFC 4122 shape

RFC 4122 shape. Every legitimate pointer id is an `outbox.id` (a `uuid` column), so anything that is not UUID-shaped cannot back a row and is rejected BEFORE it touches the pool — this both denies a compromised DB login the cheapest amplification (a malformed id that would still cost a full connect+BEGIN+SET ROLE+SELECT before failing on `22P02`, review finding SEC-1) and removes the only untrusted string that ever reached a log line (CRLF log injection, SEC-3).

### §58. Ceiling on concurrently-in-flight outbox fetches

Ceiling on concurrently-in-flight outbox fetches (review finding SEC-1). NOTIFY is not channel-access-controlled, so a compromised DB login can spam this channel; each frame would otherwise start an unbounded `pool.connect()` fetch. Past this many in flight, further frames are dropped — best-effort by ADR-0025's own contract, and a genuine miss is recovered by the resync/cache-invalidation path, never by unbounded queueing. Comfortably above any legitimate burst (only frames for a locally-subscribed org get this far).

### §59. A bounded set of ids this process already delivered

Bounded set of ids already delivered by THIS process's bridge, newest-last (insertion order). Blunts replay (review finding SEC-2): a compromised `scp_pgboss` login can read real event ids out of `pgboss.job` and re-`NOTIFY` them to re-inject historical events into a live stream. The relay emits each outbox row's id exactly once (it selects `WHERE processed_at IS NULL` and stamps it in the same tx), so a legitimate event is never already in this set when it first arrives — only a replay is. Coverage is bounded to the most recent `RECENT_DELIVERED_CAP` ids; a replay of an id older than that window is not caught here (it is still bounded by the activeOrgIds pre-filter, the UUID gate, and the isolated pool).

### §60. Fetches one outbox row by id

Fetches one outbox row by id — the ONLY way an event ever enters this bridge (F1: the row is the authority). Outbox rows are retained (ADR-0024: nothing deleted) and committed before the NOTIFY is delivered, so a legitimate pointer always resolves; an id that resolves to no row is a forgery and is dropped. Runs under the SAME narrowly-scoped `SET LOCAL ROLE scp_relay` escalation the outbox relay itself uses (events/outbox-relay.ts's module doc — PR #4 security review, CRITICAL 3). Extending that reviewed escalation to every SSE-serving process is deliberate, not incidental (proposal §7.1 item 1): `scp_relay` is NOBYPASSRLS and granted ONLY SELECT+UPDATE on `outbox` (drizzle/0003_runtime_roles.sql), so a process running this gains nothing beyond reading rows the relay already fans out to it — the escalation's blast radius does not widen.

### §61. Bridges the relay's notify channel into this process

Bridges the outbox relay's `scp_sse_events` NOTIFY channel into THIS process's local `sseHub` (proposal multi-region-instance-resilience.md §7.1 item 1, closing §4-A1). Start one of these in every process that serves `GET /events/stream` — main.ts does, unconditionally, because `app.listen()` is itself unconditional (every role serves the route; see main.ts's comment).

`pool` should be a SMALL pool dedicated to this bridge, not the request-serving pool (review finding SEC-1): NOTIFY is attacker-reachable, so the fetch load it drives must not be able to starve request handlers or the relay. main.ts wires a `max: 2` pool for exactly this.

Postgres NOTIFY is transactional (delivered on COMMIT, atomic with the relay's batch), so a subscriber here sees exactly the events the relay actually committed, in commit order per channel — but it is still best-effort with no replay (ADR-0025 D4): a NOTIFY delivered while this process's LISTEN connection is down is simply gone. That is why every (re)connection, INCLUDING the first, broadcasts a resync event to every org this process currently has a connected SSE client for (`sseHub.activeOrgIds()`) — the query-cache invalidation it triggers (apps/web/src/lib/use-event-stream.ts) is the actual catch-up mechanism, not this bridge.

### §62. Work gate (SEC-1)

Work gate (SEC-1): if the frame names an org with no locally-connected SSE client, there is nothing to deliver to on this process, so skip the fetch entirely. Safe against the no-replay contract: a client that connects to that org later resyncs via its own stream `onOpen`. The hint is untrusted, but using it ONLY to skip work cannot cause a wrong delivery — routing is still the fetched row's own org. A frame with no usable hint falls through to the fetch.

### §63. Fires on the FIRST successful connection too

Fires on the FIRST successful connection too. At boot `activeOrgIds()` is normally empty (no client has connected yet), so this is a genuine no-op then; it starts doing real work only once a reconnection follows a gap that may have dropped a NOTIFY. The reconnect RATE is itself throttled by listen-client.ts's stability window (review finding SEC-5), so a flapping LISTEN connection cannot turn this into a high-frequency cache-invalidation storm.

## `apps/server/src/events/sse-hub.ts`

### §64. In-process fan-out to this process's connected clients

In-process fan-out to this process's connected `/events/stream` SSE clients (DESIGN.md §8 "SSE — grafted: live UI/CLI updates"). One event listener per connected org (`EventEmitter` channel keyed by `orgId`), so a client only ever receives its own org's events.

THAT IS THE TENANCY BOUNDARY AND ONLY THE TENANCY BOUNDARY. This hub knows nothing about RBAC: an `orgId` channel does not distinguish an org-root Owner from a principal with zero role bindings, and it never did. The RBAC boundary immediately below it — `object:read` at each event's `subject`, so a Viewer bound at one service sees that subtree and not the org — is enforced per frame, per connection, at fan-out in routes/events.ts. Read that file's module doc before changing anything here: the sentence above used to be the only statement of what this channel key buys, and it was read as evidence that the stream was authorized when it was merely tenant-scoped.

A publisher into this hub must therefore assume its event reaches every connected client of the org and rely on the route's gate to withhold it — `publish` is not a delivery decision.

SINCE M26.1 (proposal multi-region-instance-resilience.md §7.1 item 1, closing §4-A1): the only publisher into this is events/sse-bridge.ts, in THIS process, fed by a Postgres NOTIFY the outbox relay issues from wherever IT happens to be running. The relay itself no longer calls `publish` directly — under the default chart topology (api and worker are separate pods) that direct call could never have reached the SSE-serving process's hub anyway; NOTIFY is what crosses the process boundary.
