# M26 build status & handoff

**Temporary working document** — delete when M26 lands. This exists to carry cross-session context across a machine move (session scratchpad and `~/.claude` memory do NOT travel via git; this file does). Branch: `multi-region-ha`. Proposal: [multi-region-instance-resilience.md](multi-region-instance-resilience.md) (v0.3, all 7 owner decisions settled in §11).

## ▶ Resume here (new session / new machine)

You are continuing multi-region/HA work on CommanderSCP. A prior session's memory and scratchpad did **not** travel here — everything you need is committed in the repo. Read this whole doc plus the proposal and `CLAUDE.md` before acting.

**Do, in order:**
1. **Verify the environment fresh** — Docker/Testcontainers up, Node matches the repo's `engines`. Do NOT trust the old machine's colima/node-path quirks in "Environment quirks" below; re-establish what works here.
2. **Fix F1** (the open blocker, see "Open findings"): the relay NOTIFYs an id only (orgId as a hint at most), and the SSE bridge ALWAYS re-derives the event from the authoritative `outbox` row under `SET LOCAL ROLE scp_relay` — collapse the small-event and oversized paths into one fetch so the payload is never the authority. Make `apps/server/src/events/sse-bridge-notify-authenticity.integration.test.ts` go green.
3. **Rerun the M26.1 adversarial review** across four lenses (SSE correctness, watchdog/provision correctness, security, mutation/vacuous sweep) and clear anything it surfaces.
4. **Then proceed M26.2 → M26.3 → M26.4** per proposal §7.2–§7.5 and the milestone sketch §12.

**Standing constraints** (fuller detail in the sections below):
- Migrations: M26 owns **0090+** (`when` ≥ 1788150000000); 0084–0089 are M25's. Watch the drizzle equal-`when` silent-skip trap on renumber.
- **A2** (campaign-reconcile lock) is done in M25, not here — M26.1 owes only a **verify-only gate**, and only after that fix merges to `main`. No live link to the M25 session on this machine: **watch `main` for the merge**, don't wait on a peer ping. If it never lands, A2 reverts to an M26.1 fix.
- Docs-first for M26.2+; assign the ADR number at acceptance (campaigns peers hold 0039+, so pick above that).
- **Push after every round** (WIP commits fine) — the branch is the only durable carrier.
- Integration tests need real Postgres via Testcontainers **and** the integration vitest config (plain vitest silently excludes them → vacuous green). Use `grep -rna`/`rg --text` for any census (NUL-byte source files exist).

Keep this doc current as you work; delete it when M26 lands.

## Where M26 stands

- **M26.1 (single-region hardening, §7.1) — CODE COMPLETE and REVIEW-CLEAN (2026-08-24).** All five items built; F1 fixed; the four-lens adversarial review reran and all nine findings it surfaced are cleared, each with a mutation-proven permanent gate (see "Four-lens adversarial review" below). `pnpm -w typecheck` + eslint clean; events/provision/watchdog integration + new unit gates green. Remaining M26.1 obligation: A2's **verify-only gate**, blocked on the M25 advisory-lock fix merging to `main` (see cross-session section — not merged as of 2026-08-24; watch `main`).
- **ADR reservation:** M26's ADR is **0042** (M25 holds 0039–0041). Assign at M26.2 acceptance.
- **M26.2, M26.3, M26.4 — NOT STARTED.** A full implementation map for M26.2 (§7.2 rails 1–5, resync, audit witness, §7.3 boot/doctor) was produced this session — key facts: migrations own 0090–0092 (`when ≥ 1788150000000`, re-verify above M25's real final `when` at integration); rail 3 may already be covered by the existing `verifySegment` anchor-state machine (verify, don't rebuild); "mutually authorized" resync and the instance-scoped doctor route are open design questions to settle at acceptance. Details in this session's plan output (not committed — re-derive from proposal §7.2–§7.3).

## M26.1 items (all uncommitted on the branch at handoff, then committed as WIP)

1. **SSE bridge** (§4-A1, §7.1.1): relay publishes via transactional `pg_notify('scp_sse_events', …)` (7000-byte envelope, else an oversized marker + fetch under `SET LOCAL ROLE scp_relay`); new `sse-bridge.ts` fans it into the local `sseHub`; new reusable reconnecting `listen-client.ts` (also fixes A5, the relay's non-reconnecting LISTEN); resync-on-reconnect → web cache invalidation (`use-event-stream.ts` + SDK `onOpen`). ADR-0025 amended.
2. **Watchdog restructure** (§4-A3, §7.1.3): per-row short-tx claim (`UPDATE … WHERE watchdog_flagged_at IS NULL RETURNING id`) replacing the single sweep-wide tx; notification dispatch after commit. New `watchdog-race.integration.test.ts`. (Also took watchdog's own A4 initial-send singletonKey.)
3. **singletonKey on initial sends** (§4-A4, §7.1.4): five loops uniform; **federation-sync excepted** with a distinct `"startup"` key (10s) so its forced pull-on-reconnect isn't swallowed by a pending `tick`.
4. **Pool factory census** (§4-A6, §7.1.6): `createPool` sets `connectionTimeoutMillis: 5000` + `keepAlive: true`; the three inline `new pg.Pool` route sites routed through it; `pool-factory-census.test.ts` is the standing source-lint gate.
5. **B9 provisioning guard** (§4-B9, §7.4): `provision.ts` probes the live password before `ALTER ROLE`; refuses on mismatch naming `postgres.existingSecret` / `SCP_PROVISION_ALLOW_PASSWORD_RESET=1`; NOLOGIN roles treated as unprovisioned. Helm `migrations.allowPasswordReset` added.

## Open findings (must clear before M26.1 is accepted)

- **F1 — FIXED (2026-08-24).** The bridge trusted the NOTIFY payload's `orgId`/body as authority, letting any DB login inject fabricated cross-tenant frames. Fix as specified: `outbox-relay.ts` NOTIFYs `{id, orgId}` only (`orgId` a non-authoritative hint), `sse-bridge.ts` ALWAYS re-derives the event from the authoritative `outbox` row under `SET LOCAL ROLE scp_relay` — one fetch path, payload never authority. Gate `sse-bridge-notify-authenticity.integration.test.ts` is GREEN (and stays as the standing contract test; re-proven RED under a payload-trusting mutation after the round-2 rewrite); the temporary `zz-secprobe-sse-bridge-spoof` probe (which pinned the vulnerable behavior) is deleted. ADR-0025 "Multi-process delivery" bullet and proposal §7.1 item 1 "(privilege)" clause amended to the pointer design.

### Four-lens adversarial review — RUN and CLEARED (2026-08-24)

Reran across SSE correctness, watchdog/provision correctness, security, and a mutation/vacuous sweep (the sweep agent died on a session limit; its mutation-proofs were done by hand — every new gate below was verified RED under the exact mutation that reintroduces its defect, then reverted). Nine findings surfaced; all cleared, each with a permanent gate:

- **SSE-1 / SEC-4 (critical) — a leaked mutation marker shipped in the WIP commit.** `use-event-stream.ts:116` carried `onOpen: () => undefined // MUTATION: dropped onOpen: resync` from the prior machine's killed round — the branch was RED (2 web tests). This is the commit-racing-mutation hazard made real. Restored `onOpen: resync`. (`use-event-stream.test.tsx` green.)
- **SEC-1 (major) — unbounded per-NOTIFY fetch on the request-serving pool.** The always-fetch F1 design made every NOTIFY a pool checkout + 5 round-trips on the shared pool, before checking any local subscriber — a DoS any DB login can drive, and an efficiency regression (every pod fetched every event). Fixed with: a **dedicated `max:2` bridge pool** (main.ts, isolates blast radius), an **`activeOrgIds` work-gate** (skip the fetch when no local client subscribes to the hint org), a **UUID gate** (reject non-UUID ids before the pool), and a **bounded in-flight cap**. Gates: `sse-bridge-hardening.integration.test.ts` SEC-1 (connect-count) + `sse-bridge-pointer.test.ts`.
- **SEC-3 (minor) — CRLF log injection** via the unvalidated pointer id in a log line. Closed by the same UUID gate; ids are UUID-validated before any interpolation.
- **SEC-2 (minor) — replay of real ids** (a compromised `scp_pgboss` can read ids from `pgboss.job`). Added a bounded recent-id dedupe (relay emits each id once, so it never suppresses a legit event). Gate: hardening SEC-2.
- **SEC-5 (minor) — resync storm.** Backoff reset to the floor on every connect, so a flapping LISTEN connection reconnected at ~4Hz, each firing a full cache-invalidation broadcast. `listen-client.ts` now resets the backoff only after a **stability window**, so a flapping connection backs off toward the ceiling. Gate: `listen-client.test.ts`.
- **SSE-2 (major) — bridge `stop()` didn't await in-flight fetches** (unlike its `outbox-relay.ts` sibling), racing pool teardown. Added the `inFlight` set + `stop()` drain. Gate: hardening SSE-2.
- **WD-1 (major) — watchdog sweep lost the per-candidate error isolation** every sibling loop in the diff has: one candidate's throw starved every later candidate for that org, forever. Added the per-candidate try/catch (log-and-continue). Gate: `watchdog-error-isolation.integration.test.ts`.
- **PV-1 (critical) — B9's NOLOGIN→LOGIN first-provisioning branch was an unlocked, unverified ALTER**, reintroducing the exact clobber race B9 exists to close, at first boot. Wrapped the whole read-decide-write in a per-role `pg_advisory_xact_lock`, so a concurrent second caller re-reads the committed LOGIN state and hits verify-or-refuse. Gate: `provision.integration.test.ts` PV-1 (iterated concurrent race) — this is also §7.5's credential-clobber concurrent gate, now built.

All of events/provision/watchdog integration + the new unit gates are green; `pnpm -w typecheck` and eslint clean. Known unpinned-by-dedicated-test loops from Item 3 (observe/inbox-loop/auto-relay/version-poll) keep their accepted representative coverage (reconcile + federation-sync are the pinned ones).

## Cross-session coordination (with the M25 campaigns session)

- **Migrations:** M25 holds **0084–0086** (0086_instance_freezes landed) and reserves **0087–0089**. **M26 claims 0090+ with `when` ≥ 1788150000000.** M26.1 adds NO migrations.
- **A2 (campaign-reconcile advisory lock):** taken by M25 (committed on `m25-campaign-levers`, keyed by `campaignObjectId` + in-lock re-read + N-concurrent race test), **not yet merged to main**. M26.1's obligation is a **verify-only gate**, to be written ONLY after the M25 session signals the fix has MERGED. If M25 drops it, it reverts to an M26.1 fix.
- **M25 touches that matter to M26.3:** `bump-gate.ts` moves (M25.8 freeze-gates dependency auto-merge) — the restore-re-executes runbook section must name BOTH halves: merges refused (M25.8), PR authoring still permitted under D8 (duplicate PRs possible after a restore). M25.7 may convert freezes projection→graph-object (worked example for projection→federating; org-scoped only — instance-scoped state cannot federate).

## Environment quirks on the ORIGINATING machine (may not apply on the remote)

- Node: repo pins engines to 22.x; default `node` here was v26 — prepend `/opt/homebrew/Cellar/node@22/22.23.2_1/bin`.
- Testcontainers/Docker via colima: `/var/run/docker.sock` is cleared on reboot (needs a sudo symlink to the colima socket). Workaround env: `DOCKER_HOST=unix:///Users/jag8765/.colima/default/docker.sock TESTCONTAINERS_RYUK_DISABLED=true` (b9-guard agent also needed `TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE=/var/run/docker.sock`). **Docker was DOWN at handoff** — a reason the work is moving to a stable-Docker remote.
- Integration tests: run from `apps/server` with `--config vitest.integration.config.ts`; plain vitest silently EXCLUDES integration files (vacuous green).
