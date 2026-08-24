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

- **M26.1 (single-region hardening, §7.1) — CODE COMPLETE, review INCOMPLETE.** All five items built and passing their own tests + `pnpm -w typecheck` (green) + the integration battery (events/provision/federation-sync group 19/19; coordination group watchdog-race + reconcile-singleton + coordination + coupling + stage-dependency 54/54). The adversarial review round was **killed mid-run** (no findings recovered) — so this diff is NOT review-clean. One confirmed finding survived as F1 below.
- **M26.2, M26.3, M26.4 — NOT STARTED.**

## M26.1 items (all uncommitted on the branch at handoff, then committed as WIP)

1. **SSE bridge** (§4-A1, §7.1.1): relay publishes via transactional `pg_notify('scp_sse_events', …)` (7000-byte envelope, else an oversized marker + fetch under `SET LOCAL ROLE scp_relay`); new `sse-bridge.ts` fans it into the local `sseHub`; new reusable reconnecting `listen-client.ts` (also fixes A5, the relay's non-reconnecting LISTEN); resync-on-reconnect → web cache invalidation (`use-event-stream.ts` + SDK `onOpen`). ADR-0025 amended.
2. **Watchdog restructure** (§4-A3, §7.1.3): per-row short-tx claim (`UPDATE … WHERE watchdog_flagged_at IS NULL RETURNING id`) replacing the single sweep-wide tx; notification dispatch after commit. New `watchdog-race.integration.test.ts`. (Also took watchdog's own A4 initial-send singletonKey.)
3. **singletonKey on initial sends** (§4-A4, §7.1.4): five loops uniform; **federation-sync excepted** with a distinct `"startup"` key (10s) so its forced pull-on-reconnect isn't swallowed by a pending `tick`.
4. **Pool factory census** (§4-A6, §7.1.6): `createPool` sets `connectionTimeoutMillis: 5000` + `keepAlive: true`; the three inline `new pg.Pool` route sites routed through it; `pool-factory-census.test.ts` is the standing source-lint gate.
5. **B9 provisioning guard** (§4-B9, §7.4): `provision.ts` probes the live password before `ALTER ROLE`; refuses on mismatch naming `postgres.existingSecret` / `SCP_PROVISION_ALLOW_PASSWORD_RESET=1`; NOLOGIN roles treated as unprovisioned. Helm `migrations.allowPasswordReset` added.

## Open findings (must clear before M26.1 is accepted)

- **F1 — BLOCKER (confirmed by code inspection; probe converted to a red gate).** `sse-bridge.ts`'s full-envelope fast path (`RelayedEventSchema.safeParse` → `sseHub.publish(result.data)`, lines ~134–142) trusts the NOTIFY payload's `orgId` and body as authority. Postgres NOTIFY is not channel-access-controlled, so any DB login (incl. `scp_pgboss`, which has zero `outbox` grants by design) can `pg_notify('scp_sse_events', <forged>)` and inject a fabricated event into any tenant's live SSE stream — a cross-tenant integrity regression this diff introduces. Blast radius is bounded (SSE drives UI cache invalidation/live view, not authorization of mutations), but it defeats the deliberate `scp_pgboss` isolation.
  - **Repro / gate:** `apps/server/src/events/sse-bridge-notify-authenticity.integration.test.ts` — asserts a forged frame does NOT reach the spoofed org. **Expected RED until fixed.**
  - **Fix:** relay NOTIFYs an id (+ orgId as a hint only); the bridge ALWAYS re-derives the event from the authoritative `outbox` row under `SET LOCAL ROLE scp_relay`, collapsing the small/oversized paths into one fetch so the payload is never authority. Touches `outbox-relay.ts` (notify id-only) and `sse-bridge.ts` (always fetch). Outbox rows are retained (ADR-0024: nothing deleted) and present at NOTIFY time, so fetch-by-id always resolves.
- **Review coverage gap:** the four-lens adversarial review (SSE correctness, watchdog/provision correctness, security, mutation/vacuous sweep) never completed — rerun it after F1. Script: `.../workflows/scripts/m26-1-review-wf_e5fc0727-e71.js` (session-local; re-authorable from the proposal + this doc). Known unpinned-by-dedicated-test loops from Item 3: observe/inbox-loop/auto-relay/version-poll (spec accepted representative coverage — reconcile + federation-sync are pinned).

## Cross-session coordination (with the M25 campaigns session)

- **Migrations:** M25 holds **0084–0086** (0086_instance_freezes landed) and reserves **0087–0089**. **M26 claims 0090+ with `when` ≥ 1788150000000.** M26.1 adds NO migrations.
- **A2 (campaign-reconcile advisory lock):** taken by M25 (committed on `m25-campaign-levers`, keyed by `campaignObjectId` + in-lock re-read + N-concurrent race test), **not yet merged to main**. M26.1's obligation is a **verify-only gate**, to be written ONLY after the M25 session signals the fix has MERGED. If M25 drops it, it reverts to an M26.1 fix.
- **M25 touches that matter to M26.3:** `bump-gate.ts` moves (M25.8 freeze-gates dependency auto-merge) — the restore-re-executes runbook section must name BOTH halves: merges refused (M25.8), PR authoring still permitted under D8 (duplicate PRs possible after a restore). M25.7 may convert freezes projection→graph-object (worked example for projection→federating; org-scoped only — instance-scoped state cannot federate).

## Environment quirks on the ORIGINATING machine (may not apply on the remote)

- Node: repo pins engines to 22.x; default `node` here was v26 — prepend `/opt/homebrew/Cellar/node@22/22.23.2_1/bin`.
- Testcontainers/Docker via colima: `/var/run/docker.sock` is cleared on reboot (needs a sudo symlink to the colima socket). Workaround env: `DOCKER_HOST=unix:///Users/jag8765/.colima/default/docker.sock TESTCONTAINERS_RYUK_DISABLED=true` (b9-guard agent also needed `TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE=/var/run/docker.sock`). **Docker was DOWN at handoff** — a reason the work is moving to a stable-Docker remote.
- Integration tests: run from `apps/server` with `--config vitest.integration.config.ts`; plain vitest silently EXCLUDES integration files (vacuous green).
