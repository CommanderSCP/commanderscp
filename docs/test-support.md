# test-support

Long-form reference for the **test-support** subsystem — the rationale, hazards and open items that
used to sit inline. Each source file below carries a one-line headline at the site and points here.

> Partial: 39 of 39 multi-line comment blocks in this subsystem are here. The rest are
> still inline, pending a hand-written one-line headline.

## Files

- [`apps/server/src/test-support/cli-runner.ts`](#apps-server-src-test-support-cli-runner-ts) — §1–§1
- [`apps/server/src/test-support/db-clone.ts`](#apps-server-src-test-support-db-clone-ts) — §2–§6
- [`apps/server/src/test-support/global-setup.ts`](#apps-server-src-test-support-global-setup-ts) — §7–§8
- [`apps/server/src/test-support/harness.ts`](#apps-server-src-test-support-harness-ts) — §9–§31
- [`apps/server/src/test-support/integration-sleep-census.test.ts`](#apps-server-src-test-support-integration-sleep-census-test-ts) — §32–§34
- [`apps/server/src/test-support/per-worker-db.ts`](#apps-server-src-test-support-per-worker-db-ts) — §35–§35
- [`apps/server/src/test-support/plugin-state-dir.ts`](#apps-server-src-test-support-plugin-state-dir-ts) — §36–§36
- [`apps/server/src/test-support/plugin-state-isolation.integration.test.ts`](#apps-server-src-test-support-plugin-state-isolation-integration-test-ts) — §37–§37
- [`apps/server/src/test-support/query-plan.ts`](#apps-server-src-test-support-query-plan-ts) — §38–§39

## `apps/server/src/test-support/cli-runner.ts`

### §1. Confirmed flake: the next command sees no credentials

Confirmed flake (2026-07-31, CI run 30631863957 job 91160378014): `scp login` exits 0, but the VERY NEXT `scp <cmd>` in the same session occasionally sees "Not logged in" — `credentials.json` not yet visible to the next `node <CLI_BIN>` subprocess's `readFile`, despite `login`'s own `saveCredentials` being fully awaited before that process exits. Root cause NOT found: per-session `configDir` isolation (this file), the `port: 0` server binding (harness.ts), and every awaited subprocess call were all confirmed correct by code review, and two full local `test:integration` runs (95 files / 791 tests each) produced zero repro. Whatever the underlying cause — most plausibly a CI-runner-specific filesystem visibility delay between two independently spawned processes — a fresh child process's `readFile` of a file another process just wrote is exactly the boundary this credentials round-trip crosses, so guard it directly here rather than masking the symptom with a blanket test retry: after `login`, poll for a parseable `credentials.json` (bounded, short) before handing control back to the caller.

BUDGET RAISED 2026-08-02 (CI run 30770220554 job 91556316977). The guard fired for real and still lost: 5 attempts at `50 * attempt` is 500 ms of total patience, on a shard whose tests took 916 s — i.e. a heavily loaded runner, which is exactly the condition the delay needs and the condition under which 500 ms is thinnest. The guard's PURPOSE is to outlast a visibility delay of unknown length, so a budget that short was never the right shape; this is the same fix, sized honestly.

Now ~5 s across 16 attempts with the backoff capped, so the tail is patience rather than one long final sleep. It stays a WAIT, not a retry-the-test: if `credentials.json` never becomes readable the failure is still loud, still points at this boundary, and still refuses to let a "Not logged in" error surface later as a confusing assertion failure somewhere unrelated.

## `apps/server/src/test-support/db-clone.ts`

### §2. Per-worker template-DB isolation, kept side-effect free

LEVER 3 — per-worker template-DB isolation, pure helpers + the clone routine. Kept side-effect free (no top-level `await`) so that test-support/global-setup.ts can import the constants/helpers without triggering a clone in the main process; the actual clone is driven by the thin `setupFiles` entry test-support/per-worker-db.ts, which runs inside each worker fork.

WHY per-worker databases: the integration suite ran serially (`singleFork`) because two files sharing one database collide on instance-scoped singleton tables (`scan_requirement_floors`, `scanner_assignments` — no `org_id`, tests DELETE them wholesale), the single global `pgboss` schema + reconcile queue, and the outbox relay's org-filter-less `SELECT ... FOR UPDATE SKIP LOCKED`. A private database per worker neutralizes all three, so files in different workers run truly in parallel. Files WITHIN a worker still run serially and share that worker's database — exactly the (safe) isolation the suite already relied on under `singleFork`.

### §3. Advisory-lock key that serializes

Advisory-lock key that serializes `CREATE DATABASE ... TEMPLATE scp_template` across workers. `CREATE DATABASE` from a template fails if ANY session (including another worker's concurrent clone, which briefly connects to the template to copy it) is attached to the source, so workers take this lock on the shared admin database before cloning. Arbitrary constant, unique to this use.

### §4. Clones a private database per worker, idempotently

Clones a private database for the current worker from `scp_template` and repoints the three `TEST_*_DATABASE_URL` env vars at it. Idempotent per worker: keyed off `process.env`, which persists across Vitest's per-file module-registry resets within the same fork, so re-imports of the setup file skip the (expensive) re-clone while still inheriting the overridden env URLs.

### §5. NOTE: under the current config this early return NEVER fires

NOTE: under the current config this early return NEVER fires. `isolate: true` gives every test file a fresh child process, so `process.env` does not carry between files and the clone is redone per file (measured 2026-08-03). Kept because it is correct and would take effect under `isolate: false` — but do not read it as "the expensive re-clone is skipped". Today every file pays a full DROP + CREATE DATABASE, which is both a real per-file cost and the reason cross-file data sharing cannot happen at all (see vitest.integration.config.ts).

### §6. Database-level grants are NOT copied by TEMPLATE

Database-level grants are NOT copied by TEMPLATE (only in-database objects are), so re-issue the one the template's migration 0008 granted: pg-boss re-runs `CREATE SCHEMA IF NOT EXISTS pgboss` on every boot, whose ACL check is against database-level CREATE regardless of whether the schema already exists. Without this, `withEventRelay` boots fail with "permission denied for database scp_w<id>".

## `apps/server/src/test-support/global-setup.ts`

### §7. Vitest `globalSetup` (BUILD_AND_TEST.md §4.2)

Vitest `globalSetup` (BUILD_AND_TEST.md §4.2): one real `postgres:16` Testcontainers instance for the whole integration run — migrated once here, never mocked. Mirrors main.ts's two-phase boot (PR #4 security review, CRITICAL 3; pg-boss role added for the M3 tracked security follow-up): the container's superuser runs migrations and provisions the `scp_app` and `scp_pgboss` login roles.

LEVER 3 — per-worker template-DB isolation (drops `singleFork`). Instead of migrating the container's default `scp` database and running every test serially against it, we migrate a dedicated TEMPLATE database (`scp_template`) once, here. Each Vitest worker then clones its own private database (`CREATE DATABASE scp_w<id> TEMPLATE scp_template` — a fast file copy) in test-support/per-worker-db.ts, so files in different workers never share the singleton scan tables, the single `pgboss` schema, or the org-filter-less outbox relay (the three collision classes that forced serial execution). The login roles `scp_app`/`scp_pgboss` are CLUSTER-GLOBAL, so provisioning them once here is enough for every cloned database.

`process.env` mutations in globalSetup are visible to test workers; the three URLs set here point at the container's default `scp` database and act as the ADMIN/base connection (used by per-worker-db.ts to issue `CREATE DATABASE`). Each worker then OVERRIDES all three env URLs to point at its own cloned database, keeping the same host/port and the same `scp_app`/`scp_pgboss` roles — only the database name changes. Because test-support/harness.ts's URL getters read `process.env` lazily at call time, `buildTestServer` and the raw probes pick up the per-worker database automatically, with no harness change.

### §8. Create + migrate the template database

Create + migrate the template database. Migrations create the cluster-global roles (scp_app/scp_pgboss/scp_relay — drizzle 0002/0003/0008) AND the per-database objects (table grants, RLS policies, the `pgboss` schema, `GRANT CREATE ON DATABASE ... TO scp_pgboss`). The per-database objects are copied into every `TEMPLATE`-cloned worker database; the roles persist cluster-wide. The one database-level grant that is NOT copied by TEMPLATE (`GRANT CREATE ON DATABASE`) is re-issued per worker in per-worker-db.ts.

## `apps/server/src/test-support/harness.ts`

### §9. Admin/superuser URL — set by test-support/global-setup.ts

Admin/superuser URL — set by test-support/global-setup.ts (Vitest `globalSetup` — process.env is shared with workers). Tests use this only for privileged fixture surgery (e.g. the audit tamper test); the servers under test run on `testRuntimeDatabaseUrl()`.

### §10. Schema-scoped `scp_pgboss` login-role URL

Schema-scoped `scp_pgboss` login-role URL — what pg-boss connects as under test (M3 tracked security follow-up), and what `pgboss-role.integration.test.ts` connects as directly to probe it.

### §11. Builds an app against the shared Testcontainers Postgres

Builds a Fastify app against the shared Testcontainers Postgres — migrations + runtime-role provisioning already applied by globalSetup. The pool connects as the real `scp_app` login role, exactly like production (main.ts phase 2) — never as the container's superuser.

### §12. M21.7 follow-up: the PROCESS axis

M21.7 follow-up: the PROCESS axis (`SCP_ROLE`). Unset ⇒ `all`, which is what every existing test has always got and is also the shape that HIDES a route guard carrying the process axis: an `all` process satisfies it. A test about the split topology — an api process in front of a worker, which is how the Helm chart deploys — has to be able to boot the api half. `buildApp` reads nothing from `config.role` (only `main.ts`'s `runsBackgroundWork` and the dependency guards do), so this changes what the ROUTES see and nothing else.

### §13. Same, but bound to a real loopback port for real HTTP

Same as `buildTestServer`, but actually bound to a real loopback port (`app.inject()` doesn't open a socket) — needed for anything that speaks real HTTP to the server: the SDK's `fetch`-based client and the CLI subprocess (test-support/cli-runner.ts).

`withEventRelay: true` additionally wires up the outbox relay + pg-boss (main.ts's `role === "all" || "worker"` branch, unchanged logic) AND the SSE bridge (main.ts's unconditional-per-role branch — events/sse-bridge.ts) so events written by requests against this server actually reach `sseHub`/`GET /events/stream` — `buildApp` alone never starts any of them, so SSE stays silent without this. Off by default: most callers of `listenTestServer` don't need a live event pipeline, and pg-boss provisioning its own schema on every boot isn't free.

THE BRIDGE IS NOT OPTIONAL HERE (M26.1). Since the relay stopped calling `sseHub.publish` directly (outbox-relay.ts's doc comment — proposal multi-region-instance-resilience.md §7.1 item 1), it is the ONLY thing that can feed `sseHub` in this process, in EVERY topology main.ts starts it in — which, because `app.listen()` there is itself unconditional, is every role. A test harness that mirrored the OLD, role-gated shape here would silently reproduce exactly the process-boundary bug (§4-A1) this milestone closes.

`natsUrl` mirrors main.ts's `config.eventBus.backend === "nats"` branch: when set (only the NATS-backend half of events/event-bus.integration.test.ts's shared suite passes this), the relay ALSO fans relayed outbox rows out to a real JetStream stream, exactly as it would in production with `SCP_EVENT_BUS_BACKEND=nats`. `undefined` (every other caller) leaves the relay exactly as it's always behaved — no NATS connection is ever attempted.

`withReconcileLoop: true` (requires `withEventRelay: true` — the loop needs `boss`) starts the M3 coordination engine exactly as main.ts does: a `SubprocessPluginHost` with one fake-executor instance, the self-re-scheduling reconcile tick, AND (CRITICAL #1 fix, PR #7 review) the watchdog sweep loop — main.ts starts both under the same `role === "all" || "worker"` guard, so this mirrors that exactly rather than needing a separate flag. `pluginHostOptions` lets a test tighten timeouts/backoff (the production defaults are tuned for real workloads, not fast test iteration); `watchdogIntervalSeconds` similarly overrides the production default (60s) for tests that want more than one real sweep within a reasonable test timeout — the loop's very first sweep still fires immediately on start regardless, so most tests need neither. `reconcileTickIntervalOverrideMs` isn't exposed — tests instead just poll (`waitUntil`, coordination.integration.test.ts) since `RECONCILE_TICK_INTERVAL_SECONDS` (1s) is already fast enough not to dominate test runtime.

### §14. Starts the `SubprocessPluginHost`

Starts the `SubprocessPluginHost` (and assigns `deps.pluginHost`) WITHOUT the reconcile and watchdog loops.

Use this whenever a test needs the plugin host — `POST /discovery/run` fail-closes on `deps.pluginHost` alone — but is going to drive the coordination engine ITSELF, e.g. by calling `processChangeSourceEvents` inline and then reading the result synchronously.

`withReconcileLoop: true` starts a LIVE COMPETITOR for exactly that work. The processor claims rows `FOR UPDATE SKIP LOCKED`, so when a 1s tick claims the row first, the test's own inline call silently processes NOTHING and its follow-up read sees the tick's uncommitted pre-image — `resulting_change_object_id` still NULL. That is a real, measured flake (~0.7% per event under CPU load; 0/300 with the loop off), and it is invisible on an idle machine.

### §15. Merged into the shared fake-executor instance's config

Merged into the shared fake-executor instance's config (default is just `{statePath, autoSucceedAfterMs: 50}`) — lets a test set `FakeExecutorConfig.forcePhase` to deterministically fail a specific, test-known target object id (create the target with an explicit `id:` so it's known before the server — and therefore the plugin instance — ever boots). Used by governance.integration.test.ts's M4 automatic-rollback-on-failure suite; every other caller leaves this unset and gets ordinary auto-succeeding targets.

### §16. RAW `mkdtemp`, DELIBERATELY NOT `@scp/test-tmpdir`

RAW `mkdtemp`, DELIBERATELY NOT `@scp/test-tmpdir` — and this is the one module in the repo where that package is not merely unnecessary but FATAL.

THE PROPERTY: `@scp/test-tmpdir` registers `afterEach`/`afterAll` from `vitest` at MODULE LOAD (correctly — see its doc), so importing it drags `vitest` into the import graph of whatever imports it. THIS module is not vitest-only: `apps/web/e2e/global-setup.ts` (a PLAYWRIGHT `globalSetup`, a plain Node process with no vitest runner) imports `@scp/server/dist/test-support/harness.js` for `listenTestServer`/`createTestOrg`. Merely importing `vitest` there throws "Vitest failed to access its internal state" at module init, before a single line of setup runs — measured 2026-08-23 both in CI job 9 and locally with a bare `node -e 'await import(".../harness.js")'`. It takes down BOTH of that suite's modes, including the compose-stack mode that never reaches the code below.

THE LIFETIME IS BETTER HERE ANYWAY. This directory belongs to the plugin host started three lines down, not to a test file's `afterAll` — so it is removed by `close()` below, beside every other resource this function opens. `test-support-runner-neutral.test.ts` is the gate that keeps a future import from putting `vitest` back into this directory's graph.

### §17. A fresh org and bootstrap admin, logged in through the API

Creates a fresh, uniquely-named org + bootstrap admin, and logs the admin in via the real API.

Uses a per-org-unique admin username deliberately: local-auth's `login()` resolves users by username only (DESIGN.md §6's `LoginRequestSchema` has no org discriminator — fine for a single-bootstrap-org walking skeleton), so two orgs sharing a literal username would make login ambiguous. Pre-existing M0 limitation, out of M1 scope (local-auth is superseded by OIDC/PATs in M2/M3) — noted here rather than worked around silently.

### §18. Built-in role name

Built-in role name — resolved by `findFirst(org_id IS NULL AND name = ...)`, so ANY seeded built-in works, not only the five ladder rungs: the cumulative ladder  Viewer | Operator | Approver | Administrator | Owner (drizzle/0002) the purpose roles      SecurityOfficer | FederationAdmin | OrgAdmin | ServiceAdmin | ComponentAdmin (drizzle/0099, role-model.md §3)

A purpose role's `bindable_at` is NOT checked here, and neither is D5's `Administrator` deprecation or the no-escalation subset rule. That is DELIBERATE and it is what makes this helper still useful now that `routes/role-bindings.ts` exists (role-model.md §5 step 5): those three refusals live at the WRITE DOOR, not in the database, so a row written straight through the repo layer here behaves exactly as one written by hand SQL on a live deployment does — an `Administrator` binding that pre-dates the deprecation, or a binding at a scope the role does not list.

Which means this helper is the ONLY way to build the fixtures the door's own tests need: an EXISTING Administrator binding that must keep resolving, and a binding that outranks the caller trying to revoke it. Tests that mean to exercise the door must go through the route.

### §19. Creates a NON-admin user in an existing test org

Creates a NON-admin user in an existing test org: a graph `user` object (the RBAC subject), an auth row, the given role bindings, and a live bearer token via the real login API. This is how authz tests get subjects with narrow, deliberate permissions instead of the bootstrap admin's org-root Owner binding. (No user-management API exists yet in M1 — that's an M2 typed endpoint — so setup goes through the repo layer, inside the same tenant transaction machinery real requests use.)

### §20. Writes a role binding with an effect the constraint bans

Writes a `role_bindings` row whose `effect` is NEITHER 'allow' NOR 'deny'.

drizzle/0097's `role_bindings_effect_check` makes such a row unwritable through any ordinary connection — deliberately: `hasPermission` and `readableRootsFor` classify by EXACT string equality, so an 'ALLOW' row grants nothing and denies nothing while reading, to anyone looking at the table, as authority.

WHY THE ROW IS STILL WORTH BUILDING. A CHECK constrains what can be WRITTEN from the moment it exists; it cannot un-write what is already there, and PostgreSQL never re-checks a row on the way OUT. 0097 deletes the ones it finds at upgrade time, but the shape stays reachable two ways that are not hypothetical:

```text
- a database restored from a pre-0097 `pg_dump`. That dump carries the pre-0097 SCHEMA — no
  CHECK — so the illegal rows load intact, and they stay readable by the application for as
  long as it is pointed at that database before (or without) the migrations being run;
- any superuser/table-owner path that is not `scp_app`, which is exactly what this helper is.
```

So the resolver's fail-closed classification is the INNER layer of a defence in depth, and an inner layer that stops being exercised is an inner layer that silently rots: the day this helper is deleted as "unreachable" is the day `effect !== 'deny'` can be reintroduced into `partitionReadableRoots` with every test still green.

HOW. The migration-owner connection, with the CHECK momentarily dropped inside ONE transaction and restored `NOT VALID` — still enforced on every later INSERT and UPDATE (NOT VALID skips only the initial scan of EXISTING rows), so the table stays protected for the rest of the file while holding the one row this made on purpose. A plain re-ADD would scan and reject that row.

Three self-checks, because a fixture that silently no-ops turns "a malformed effect grants NOTHING" into a test that passes because there is no binding at all: 1. a legal `effect` is REFUSED, so this cannot quietly become the general-purpose write door (every legal binding goes through `createTestUser` / the repo layer); 2. the row is READ BACK after COMMIT and its `effect` compared to what was asked for; 3. the CHECK is confirmed present again, and confirmed to still BITE, before returning.

### §21. A raw client authenticated as the app login role

A raw `pg.Client` that AUTHENTICATES as the least-privileged `scp_app` login role (no SET ROLE, no BYPASSRLS) — the exact identity the production runtime pool uses (PR #4 security review, CRITICAL 3). Used by adversarial RLS tests to probe the database directly, bypassing the application layer entirely, per BUILD_AND_TEST.md §4.2 "attempt reads/writes across org_id with a mis-set/unset app.current_org_id". Callers are responsible for calling `setOrgContext`/leaving it unset.

### §22. A raw client authenticated as the pg-boss login role

A raw `pg.Client` that AUTHENTICATES as the schema-scoped `scp_pgboss` login role — the exact identity pg-boss itself connects as (M3 tracked security follow-up, drizzle/0008_pgboss_role .sql). Used by `pgboss-role.integration.test.ts` to probe the database directly: proving the role can operate inside the `pgboss` schema, and proving it has NO grant at all on `public`'s tenant tables (objects/relationships/role_bindings/changes).

### §23. Polls until the check passes or the deadline elapses

Polls `check()` until it returns truthy or `timeoutMs` elapses (then throws, the last-seen error folded into the failure message). The M3 coordination engine (coordination/reconcile.ts) advances changes asynchronously off a ~1s self-scheduling pg-boss tick — every coordination integration test that asserts "eventually the change reaches state X" polls for it with this rather than a fixed `sleep`, so the suite is exactly as slow as the engine actually is and never flaky-fast on a loaded CI box.

### §24. The barrier every SSE test needs before it publishes

THE BARRIER EVERY SSE-BRIDGE TEST NEEDS, before it publishes anything it expects to be delivered.

`startSseBridge` returns synchronously but establishes its `LISTEN scp_sse_events` connection ASYNCHRONOUSLY, and NOTIFY has NO REPLAY (ADR-0025 D4). An event relayed into that window is lost permanently — so a test that expected it times out, and (worse) a test making a NEGATIVE assertion passes VACUOUSLY, because nothing could ever have reached the bridge to be rejected.

Idle machines win that race and hide it. CI lost it: `sse-bridge.integration.test.ts`'s wiring test failed with `waitUntil timed out after 15000ms` on a runner where a neighbouring suite's 10k-write audit test was taking 141s. Postgres retains an idle backend's last query text, so the LISTEN's own presence in `pg_stat_activity` IS the positive signal that it is established — no fixed sleep, and exactly as slow as the connection actually is (integration-sleep-census.test.ts's property).

`admin` must be a client on the ADMIN url (`testDatabaseUrl()`), scoped to this worker's database.

### §25. How long one reconcile tick may take, for sizing deadlines

How long ONE reconcile tick is allowed to take, for the purpose of sizing a test's deadline.

## `RECONCILE_TICK_INTERVAL_SECONDS` is 1, and every deadline written against that number is wrong

The tick does not run every second. It re-schedules ITSELF with `boss.send(RECONCILE_QUEUE, {}, { startAfter: 1 })` after each sweep completes, and pg-boss's `pollingInterval` defaults to 2000 ms and is not overridden anywhere in this repo — so the floor is `sweep + 1s + U(0, 2s)` before the sweep does any work at all. The sweep then walks EVERY org in the database (`runReconcileSweep`, correctly: production is one instance serving many orgs), and a test FILE accumulates one org per test, so the same deadline buys fewer ticks the later in the file it is evaluated.

MEASURED, not assumed (2026-08-17, 8-core dev box, ambient load ~25), by watching `reconcile_cursor_at` on a gate-blocked change for 30 s and timing `propose -> executing`:

| orgs in the database | arrival (`propose -> executing`) | tick gap (median) | tick gap (max) |
```text
| 1                    | 1391 ms                          | 2025 ms           | 2154 ms        |
| 21                   | **10903 ms**                     | 2821 ms           | 5972 ms        |
```

The right-hand columns are why "several ticks" was never several ticks. The ARRIVAL column is why the sleep-based `assertStaysExecuting` failed: it asserted `state === "executing"` 4000 ms after `propose()`, from the 16th test of a file that has already created 15 orgs by then (28 by the end) — so the sweep it is waiting on is a long way down the right-hand columns. Reproduced: after the full 4000 ms the change had not left `proposed`. That is not a race the test lost occasionally; it is a deadline it had already missed, hidden by the fact that seven of the eight call sites happen to wait for something else first and are therefore already in `executing`.

## This is a BUDGET, not a measurement

A deadline set to the idle-case upper bound is a deadline that fails the first time the box is busy. That is exactly how the rollback test's `waitUntil(..., 15_000)` — fifteen ticks at the fictitious 1 s rate, seven at the measured one-org rate, five once its own file's orgs are in the sweep, and fewer still under a parallel fork — timed out while passing alone. Say what a chain needs in TICKS, which is the unit the engine actually works in, and let `reconcileTicks` convert with headroom.

Deadlines elsewhere in this suite are still written in raw milliseconds against the 1 s fiction. They are a known instance of the same property and should migrate to `reconcileTicks` as they are touched — see `test-support/integration-sleep-census.test.ts` for the sibling guard on the sleep half of it.

### §26. Reads the engine-private reconcile bookkeeping

Reads the engine-private reconcile bookkeeping for one change. `reconcile_cursor_at` and `reconcile_blocked_at` are deliberately NOT on the public `Change` schema — they are scheduler queue position and park flag, not anything an API caller should see — so the progress helpers below read them straight from `changes`, exactly like the fixture surgery this file's other helpers already do.

### §27. Still parked, asserted from a positive signal not a sleep

"It is still parked", asserted from a POSITIVE signal instead of a fixed sleep.

## What this replaces, and why the thing it replaces could only ever be probabilistic

Three test files had their own copy of `sleep(3_000); expect(state).toBe(X)`, each with a comment promising the grace was "several reconcile ticks". That form makes two different claims through one assertion, and gets flaky on the one it never meant to make:

1. **Arrival** — "the change has REACHED X". A freshly-proposed change walks `proposed -> evaluated -> coordinated -> executing` under the reconcile loop before a wave gate is asked anything, so the fixed grace was silently doubling as the WAIT for arrival. A call site that ran straight after `changes.propose()` therefore failed under load with `expected 'coordinated' to be 'executing'` — a change that had not got there YET, reported with the same message as one that had escaped the gate. Same failure text, opposite bug, and it cost three sessions a day of chasing phantom regressions on 2026-08-17. 2. **Non-progression** — "and it did not get past X". Only this one was ever intended.

## "Several ticks" was not several ticks

The graces were sized against `RECONCILE_TICK_INTERVAL_SECONDS` (1s) — see `RECONCILE_TICK_BUDGET_MS` for the arithmetic and the measurements. The headline number: with 21 orgs in the database, `propose -> executing` took **10903 ms**, against a grace of 4000 ms. A 3s grace is at most one tick and often zero, so the assertion was near-vacuous when it passed and spurious when it failed.

## The positive signal

`reconcile.ts` bumps `reconcile_cursor_at` on every tick that re-examines a change and leaves it where it is — the round-robin anti-starvation write (BUMP 1 OF 5 for `waiting`, 3 OF 5 for a gate-blocked wave), load-bearing enough to have its own regression test and a 13-day production outage behind it. For a parked change that write happens if and only if the engine looked again and still refused, which makes an observed cursor advance a direct observation of exactly the event the test is asserting about.

So: poll for arrival (deadlined, and reported AS an arrival failure), then watch the cursor advance `ticks` times, failing the instant the state leaves X or the change is parked out of the candidate set. Under contention this waits precisely as long as the engine needs; on an idle box it returns as soon as the ticks land instead of always burning the full grace.

### §28. Waits for the run that authorizes the accept edge

Waits for the run of `controlObjectId` that authorizes the **accept edge** — `lifecycle_edge` / `{fromState: "validating", toState: "accepted"}` — to exist on `changeObjectId` with `status`.

## Why a wave-boundary run is not an answer to this question

`POST /changes/{id}/accept` runs the lifecycle gate with **no plugin host** (DESIGN §16's api/worker split — `coordination/gates.ts`'s `GateDeps.host` is `null` on the API tier), so it can only READ a control outcome, never produce one. Since M22.0a it reads `latestControlRunForGate`: the run made for ITS OWN crossing, because a run is evidence that a particular crossing was authorized and not a permanent property of the change (an exclusion grant carries an expiry — ADR-0033 §10).

The run every test sees FIRST belongs to a different crossing. A change reaches `validating` by clearing its **wave boundaries** (`{topologyObjectId, waveIndex}`), so by the time it is acceptable there is already a passing run for the control — for the wrong gate. The accept edge's own run is written afterwards, by `reconcile.ts`'s `advanceValidatingChanges` prewarm, in the same tick that transitioned the change but in a LATER transaction. Between those two commits the change is observably `validating` and `accept` correctly answers 409 with a Decision reading `requireControls: {outcome: "not-run"}`.

So `waitForValidating(...)` followed immediately by `accept(...)` is a RACE, and one that only ever loses on a loaded runner: the window measured ~180 ms wide on a cold plugin subprocess and ~20 ms warm, against a 100 ms poll.

CI SURFACED THREE OF NINE. Three tests failed the shard; a census by the PROPERTY ("this accept depends on a control run made for another gate") found NINE call sites across `governance.integration.test.ts` and `scoped-scan-requirements.integration.test.ts`, and holding the accept-edge prewarm back by one reconcile tick failed exactly those nine and nothing else. The other six were passing on timing, not on contract. Waiting for the accept edge's OWN run makes the precondition the thing the test actually depends on, rather than a faster machine.

NOT A RETRY LOOP AROUND `accept`. This waits for a named, observable fact — the run that will decide the crossing — and then asserts the accept exactly as before. A test whose control never produces that run still fails, here, by timeout.

Reads `gateKind`/`gateRef` off `GET /changes/{id}/control-runs`, the additive projection M22.8 shipped for exactly this question. A run missing them does not match: absent gate identity is not evidence of the right crossing, and failing closed here keeps the wait from silently degrading into the gate-agnostic one it replaced.

### §29. The companion positive signal for a failed wave

The companion positive signal for a change whose wave has FAILED: `reconcile.ts`'s failed-wave branch sets `reconcile_blocked_at`, and `listChangeRowsInStates` filters that column `IS NULL`, so a parked change is never served again. That makes parking the precise, observable moment after which "no auto-rollback was triggered" stops being a race and becomes a settled fact — where a fixed `sleep(3_000)` asserts a negative over a window in which the engine had either already stopped looking, or (on a loaded box) not yet started.

Use this before any "and it never did X" assertion about a failed wave.

### §30. M12 P5a: components can no longer be created bare

M12 P5a: components can no longer be created bare — the strict `POST /components` requires a service. This test helper creates a throwaway service (unless one is supplied) and the component in it, returning the component. Every pre-P5a `client.components.create({ name })` test call migrates to `createTestComponent(client, { name })` — the components are coordination targets that just need to EXIST; which service they belong to is irrelevant to those tests.

### §31. M12 P5a: create an ORPHAN component

M12 P5a: create an ORPHAN component — one with no owning service — for the `contains`-model tests that need to assign membership manually afterwards.

WRITES THROUGH THE REPO, NOT A ROUTE, since increment 6 removed `POST /discovery/accept` (ADR-0047). That route was the permissive import door this helper used to lean on; the strict `POST /components` requires a service and always did. `graph/objects-repo.ts`'s `createObject` is the same function every import path calls, so an orphan made here is byte-identical to one that arrived over the federation journal — which is the state these tests are actually about.

TAKES THE SERVER rather than a client, because there is no longer an HTTP door that will produce one. That is the honest signature: the permissiveness lives below the routes now, and a helper that still looked like an API call would imply a door that does not exist.

## `apps/server/src/test-support/integration-sleep-census.test.ts`

### §32. THE FIXED-SLEEP REGISTRY

THE FIXED-SLEEP REGISTRY — a CI guard for the flake class that cost three sessions a day

THE PROPERTY: *a fixed wall-clock sleep standing in for "the asynchronous engine has had its chance", followed by an assertion about what did or did not happen in that window.*

Such a test is not merely slow. It is wrong in BOTH directions at once, and which direction it lands in depends on how busy the machine is:

```text
- Under contention it FAILS SPURIOUSLY, because the thing it waited for had not happened yet.
  The worst shape is a sleep that is silently also the wait for ARRIVAL: `assertStaysExecuting`
  slept 3-4s and then asserted `state === "executing"`, so a change still walking
  `proposed -> evaluated -> coordinated` reported the same failure as one that had escaped the
  gate. Measured on 2026-08-17: four independent sessions chasing phantom regressions in
  governance.integration.test.ts, a different test failing each run and every one of them
  passing in isolation.
- On an idle machine it PASSES VACUOUSLY, because "several ticks" was never several ticks. The
  arithmetic those comments relied on is simply not true here: `RECONCILE_TICK_INTERVAL_SECONDS`
  is 1, but the tick re-schedules itself with `startAfter: 1` onto pg-boss, whose polling
  interval defaults to 2000ms and is not overridden anywhere in this repo, and each tick then
  walks EVERY org in the database (`runReconcileSweep`). Measured: a 2025ms median tick with ONE
  org, 2821ms (max 5972ms) with 21, and `propose -> executing` going from 1391ms to **10903ms**
  over the same range — against a 4000ms grace, in a file that creates 28 orgs. A 3s "several
  ticks" grace is at most one tick, and often zero. `RECONCILE_TICK_BUDGET_MS` in `harness.ts`
  carries the full table.
```

THE REMEDY IS A POSITIVE SIGNAL, not a longer sleep — `harness.ts`'s `assertStaysExecuting` and `waitForChangeParked` are the worked examples. Both watch something the engine WRITES when it does the thing the test is asserting about (`reconcile_cursor_at` for "the gate refused again", `reconcile_blocked_at` for "the failed wave has been parked and will never be served again"), so they are exactly as slow as the engine actually is and cannot be made vacuous by a fast box or flaky by a slow one.

WHAT THIS GUARD CAN AND CANNOT DO. It is a source census — `@scp/source-census`'s doc comment lists the six things one still cannot prove, all of which apply here. It cannot tell a legitimate sleep from an illegitimate one; that is what the registry below is for. What it buys is that ADDING one becomes a deliberate act that fails CI until somebody writes down which side of the property it falls on.

THE MATCH IS DELIBERATELY WIDER THAN "A BIG NUMBER". The first census written for this bug grepped `setTimeout\(\w+, [0-9_]{4,}` and reported the governance file clean — while the second copy of the very helper under repair sat in `scoped-scan-requirements.integration.test.ts` spelled `setTimeout(resolve, graceMs)`. A named constant is not a smaller hazard than a literal; it is the same hazard with the number moved. So: every `setTimeout` in an integration test counts EXCEPT one whose delay is a literal under 1000ms (a yield or a debounce nudge, not a stand-in for engine progress).

### §33. Every surviving fixed sleep, with an exact expected count

Every surviving fixed sleep in an integration test, with the count expected in that file and why it is there. Counts are EXACT in both directions: a file that grows one fails, and a file that loses its last one fails too, so a stale entry cannot sit here pretending to authorise something that no longer exists.

### §34. Every `setTimeout` delay that is not a small literal

Every `setTimeout(callback, delay)` in `source` whose delay is NOT a literal under 1000ms.

The argument list is walked with `matchingParen` rather than matched by a regex, for the same reason `exportedDeclarations` does it: `[^)]*` cannot cross a callback that has its own parentheses, so `setTimeout(() => resume(), 5_000)` is invisible to the obvious pattern. A census whose filter cannot see a form is a census that certifies that form clean.

## `apps/server/src/test-support/per-worker-db.ts`

### §35. The setup entry that runs inside each worker fork

LEVER 3 — per-worker template-DB isolation, the Vitest `setupFiles` entry (see vitest.integration.config.ts). Unlike `globalSetup`, a setup file runs INSIDE each worker fork, which is exactly where the per-worker database clone + env repointing must happen. The real work lives in test-support/db-clone.ts (kept side-effect free so globalSetup can share its helpers); this module just drives it once per worker, before any test file's `buildTestServer` call.

## `apps/server/src/test-support/plugin-state-dir.ts`

### §36. Vitest `setupFiles` entry

Vitest `setupFiles` entry: gives THIS TEST FILE its own plugin-state root, instead of letting it share one fixed machine-global directory with every other file, every other worker, and every other checkout on the machine.

WHAT IT FIXES. `coordination/executor-bindings-repo.ts`'s `pluginStateDir()` is `process.env.SCP_PLUGIN_STATE_DIR ?? join(tmpdir(), "scp-plugin-state")`, and every resolved executor instance gets `statePath: join(pluginStateDir(), `${sanitizeInstanceId(id)}.json`)`. With the variable unset — which is what every test run did until 2026-08-23 — that resolves to a FIXED `/tmp/scp-plugin-state` for the whole machine. The tmpdir-leak gate caught it as a leak (nothing ever removed it), but a leak is the mildest of its three consequences:

1. It is never cleaned, so it accumulates one file per plugin instance id, forever. 2. `vitest.integration.config.ts` runs `pool: "forks"` with `maxForks` up to 4 and `isolate` on, i.e. FOUR CONCURRENT test files. Each has its own cloned database and therefore its own orgs — but `pluginInstanceId` is chosen by the caller and is only unique PER ORG (`primaryKey([orgId, pluginInstanceId])`, db/schema.ts), so two files that both create a binding named e.g. "argocd" resolved to the SAME `/tmp/scp-plugin-state/argocd.json`. The per-worker database isolation that makes parallel execution safe does not extend to disk. 3. That file is an executor's durable idempotency/dedup cache. Two files sharing one means a `trigger()` in file B can be answered from file A's dedup entry — a test that passes for the wrong reason, and the least visible failure available.

WHY THE PRODUCT DEFAULT IS NOT THE THING BEING CHANGED. A stable path is the POINT in production: the cache has to survive a plugin subprocess restart (MAJOR #4), and randomising the default per boot would silently downgrade every deployment to in-memory-only — the exact behaviour the setting exists to prevent. The default is right for a server; it is wrong to INHERIT it in a test process, which is what this file corrects, at the same layer `per-worker-db.ts` corrects the database URL.

`mkdtempTrackedForFileSync` (FILE lifetime, swept in `afterAll`) rather than the per-test pair: plugin instances outlive individual `it()`s here, and a per-test sweep would delete a running executor's state file mid-file — measured, and the reason `@scp/test-tmpdir` now refuses the per-test pair outside a test at all.

## `apps/server/src/test-support/plugin-state-isolation.integration.test.ts`

### §37. THE INSTALLED-CHECK for `test-support/plugin-state-dir.ts`

THE INSTALLED-CHECK for `test-support/plugin-state-dir.ts` (see that file for the full finding). A setup file that is written but not listed in `vitest.integration.config.ts`'s `setupFiles` is inert while every other test stays green — so this asserts the PRODUCT function's answer, not the setup file's own variable. Remove the `setupFiles` entry and this dies; that is the only check that actually works.

Deliberately an `*.integration.test.ts`: the unit config loads no setup files, so this property is only true (and only needs to be true) where plugin subprocesses really run.

## `apps/server/src/test-support/query-plan.ts`

### §38. The index names an `EXPLAIN` of `query` mentions

The index names an `EXPLAIN` of `query` mentions.

WHY ASSERT ON A PLAN AT ALL. An index that exists but is not USED changes no return value and no row count that a small fixture can see, so nothing else in a test suite can tell the two apart — and that is not a hypothetical failure mode here. It has happened three times: `decisions_org_subject_block_created` and `decisions_org_subject_kind_created` were both built one column short of the order their reads request and were quietly passed over by the planner (drizzle/0069, and a CI failure reading `expected 804 to be less than or equal to 10`), and `bundle_transfers_org_peer_confirmed` was built in an order NO caller asks for, leaving the read it exists for seq-scanning a never-pruned ledger on every board render (drizzle/0070).

A row count, where a suite can afford one, is the honest measurement and this does not replace it: a plan can name the right index and still be slow. But when a count fails it reports a bare number with no diagnosis — it does not say WHICH index served the read instead, so the investigation restarts from nothing. This turns that into a named failure ("served by `decisions_org_created`"), and it is stable against data volume in a way a count is not.

TAKES THE BUILDER, NOT A RE-TYPED SQL STRING, so it explains the exact query production runs. A hand-copied approximation is strictly worse than no test: it keeps passing while the real query drifts off the index, which is the drift every one of the three instances above actually was.

Lives in the shared `test-support` rather than beside any one suite because the property it detects is not specific to a table — it belongs to every read whose cost is a property of its plan. The first copy lived in `coordination/test-support/decision-read-counters.ts` and the census that found the third instance is what moved it here.

### §39. The SORT NODES in the plan of `query`

The SORT NODES in the plan of `query` — the half of the assertion `indexesInPlan` cannot make, and without which it is VACUOUS for exactly the defect it was written to catch.

NAMING THE INDEX IS NOT THE SAME AS BEING SERVED BY IT. An index whose declared order does not match the query's is still perfectly usable for ACCESS — the planner reads the matching rows through it and then sorts them — so it appears in the plan by name while supplying none of the ordering the `LIMIT` needs. `indexesInPlan` alone reports that as a pass. VERIFIED, 2026-08-17, on the `bundle_transfers` read drizzle/0070 fixes: reverting the index to drizzle/0041's order left the plan as

```text
  Limit -> Sort (Sort Key: confirmed_at DESC NULLS LAST)
             -> Index Scan using bundle_transfers_org_peer_confirmed
```

and the index-name assertion PASSED against a plan that sorts. The property these reads actually need is that the index supplies the ORDER, so `LIMIT 1` can stop at the first row instead of the whole matching set being materialised and sorted — i.e. NO SORT NODE. That is what this returns, and asserting it is `[]` is what makes the pair honest.

Matches `Sort` and `Incremental Sort` alike. `Incremental Sort` is the WEAKER, more misleading form — it means the index supplied a PREFIX of the order — and it is what a prefix-keyed index like the pre-0069 `decisions_org_subject_block_created` produces, so it must not be waved through.
