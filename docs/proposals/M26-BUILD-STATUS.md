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

## Where M26 stands (updated 2026-08-24)

**LANDED & tested & pushed on `multi-region-ha`:**
- **M26.1 (§7.1) — REVIEW-CLEAN.** All five items; F1 fixed; four-lens review reran, nine findings cleared, each mutation-proven. (A2 verify-only gate still owed — blocked on the M25 advisory-lock merge to `main`, STILL not merged as of 2026-08-24; watch `main`.)
- **M26.2 rails 1/2/4/5 (§7.2)** — fork/rollback detection, commit `47bb4bd`. `journal_divergence` problem type; export tail check; anchor verification; signed tail attestation with a monotonic high-water mark (replay-safe); reanchor refusal under standing divergence. Rail 3 verified already covered by `verifySegment`. Gate `divergence-rails.integration.test.ts` 8/8; `federation.integration` 77/77. Migration 0090.
- **M26.2 §7.2.7 audit witness** — commit `ebee565`, migration 0091, gate 2/2.
- **M26.2 §7.3 D6 + decrypt canary** — commit `3604df8`. Deployment mode (production default), production refusal of ephemeral secrets, per-org RLS-correct decrypt canary before `app.listen`. Gate 3/3. Compose/dev set `evaluation`.
- **M26.3 chart packaging** — commit `a4573ba`. PDB, topology spread, multi-cluster values contract, retrans volumes. `helm lint` clean.
- **M26.4 docs** — commit `a4573ba`. `docs/runbooks/resilience.md`, GLOSSARY (member cluster / infra region / XO / instance), DESIGN §17, **ADR-0042**.

**NOT YET BUILT (the remaining work to "finish M26"):**
- **M26.2 §7.2.6 RESYNC — the big one, NOT started.** Owner chose a **SIGNED CROSS-DOMAIN HANDSHAKE** (below), a net-new authenticated cross-domain mutation surface. This is the highest-risk item and deserves its own focused pass. Grounded seams: migration 0092 = `federation_self.generation` stamp (`when` 1788152000000, ABOVE 0091's 1788151000000 — keep `when` monotonic with build order or hit the equal-`when` skip trap); new `FederationResyncRequestSchema`/`ResultSchema`; `graph/objects-repo.ts:867` revision-staleness guard (`if (input.federationImport.revision <= existing.revision) return`) needs a `forceOverwrite?` on `FederationImportContext` gated to bypass ONLY that early-return, NEVER the single-writer authority check just above it; `cursors-repo` `resetCursor` (unconditional, unlike forward-only `advanceCursor`); `self-repo` `bumpFederationGeneration`; `POST /api/v1/federation/resync`; and it must write a NEWER `federation-divergence`-kind Decision that SUPERSEDES the standing block so **rail 5's reanchor refusal clears** (that linkage is already built — resync just needs to record the clearing Decision). Model the one-shot permit shape on `reconcileOutpostConfig` (routes/federation.ts) + `scp federation outpost reconcile` (cli.ts). Permanent gate: the §7.5 lost-tail simulation.
- **M26.2 §7.3 instance doctor** — `GET /api/v1/doctor/instance`, operator-token-gated (DSN reachability, `pg_is_in_recovery()`, mTLS SAN coverage, S3 endpoint consistency, XO readiness). NOT started.
- **M26.3 S3 object-storage provider (C3)** + version-skew heartbeat mechanism (migration + migrate-bin refusal of a contract migration while a member cluster trails). NOT started.
- **M26.4 CI drills** — Testcontainers failover drill, lost-tail simulation (permanent gate, depends on resync), two-member compose topology, boot-refusal tests for the D6 ephemeral case. NOT started (the credential-clobber gate already exists as provision PV-1; the decrypt-canary gate exists).

### M26.2 owner decisions (2026-08-24, settled)

- **Resync (§7.2.6) = SIGNED CROSS-DOMAIN HANDSHAKE.** Not two independent local commands — the owner chose a new *authenticated cross-domain request/response* so one side initiates and the other consents live. This is net-new wire surface (no existing live two-way federation handshake today — pairing is unilateral-declare + out-of-band). Design it carefully; it is the highest-risk M26.2 item and sequenced last.
- **§7.3 instance doctor = NEW operator-token-gated route.** `GET /api/v1/doctor/instance` gated by the existing `requireOperator` operator-token (the pattern governance-move/scan-db use), separate from the per-org bearer-scoped `GET /doctor`. The instance checks (DSN reachability, `pg_is_in_recovery()`, mTLS SAN coverage, S3 endpoint consistency, XO readiness) are instance-wide, not per-tenant.
- **Sequencing:** build the unblocked rails (1/2/4 + migration) now; hold resync/audit-witness/doctor until those land.
- **ADR-0042** at M26.2 acceptance.

### M26.2 rail-4 grounding (verified against code 2026-08-24 — build on these, don't re-derive)

- **Migration numbering (re-verified after PR #269 landed):** `origin/main` is now at **0085** (`0084_freeze_atomic` 1788141500000-ish, `0085_freeze_lift` **when 1788143000000**). M25 reserves through 0089. **M26 uses 0090+ with `when` = 1788150000000** (safely above; re-verify it exceeds M25's real final 0089 `when` at integration). This branch is at 0083, so 0090 leaves an intentional gap — drizzle orders by `when` in `_journal.json`, not by contiguous file number, so that is fine here and fills in on merge (expect a `_journal.json` merge conflict to resolve in `when`-order). **Migrations are HAND-AUTHORED** here: write `drizzle/0090_*.sql` AND append a `_journal.json` entry `{idx:90, version:"7", when:1788150000000, tag:"0090_...", breakpoints:true}` (single baseline `0000_snapshot.json`; `db:generate` is drizzle-kit but the repo hand-authors). The **equal-`when` silent-skip trap** is real (BUILD_AND_TEST census rule): drizzle applies every entry with `when > max(applied when)` against a watermark captured once — a duplicate/too-low `when` is skipped with no error.
- **Rail 4 (tail attestation) exact seams:**
  - Signing (`packages/schemas/src/federation-journal.ts`): `computeBundleChecksum(payload)` = `sha256(canonicalStringify(payload))` hex; `signBundleChecksum(privB64, checksum)` → base64; `verifyBundleSignature(checksum, sigB64, pubB64)` → bool (fail-closed). Compute the attestation checksum over `{exporterDomainId, peerDomainId, tailSequence, tailRowHash}` and sign with the SAME instance key the bundle uses.
  - Export (`apps/server/src/federation/export-repo.ts`): builds `{header, entries, checksum, bundleSignature}`; `checksum = computeBundleChecksum({header, entries})` — so a new **`tailAttestation` sibling key is legitimately OUTSIDE the signed checksum** (old importers drop it; `SyncBundleSchema` is non-strict). `const tail = await ownJournalTail(tx, orgId)` (returns `{sequence, rowHash}`) is ALREADY computed and currently `void tail;` — reuse it. Key from `ensureInstanceKey` (already imported). Attach attestation UNCONDITIONALLY (even empty bundles — that is what catches B1 for narrow-scope peers).
  - Schema (`packages/schemas/src/federation.ts:769`): add `tailAttestation: JournalTailAttestationSchema.optional()` to `SyncBundleSchema`; new `JournalTailAttestationSchema = z.object({ tailSequence: nonneg int, tailRowHash: string, signature: string })`. **Additive/optional** → oasdiff-safe; run `pnpm gen`.
  - Import (`apps/server/src/federation/import-repo.ts` ~698–720): already resolves the exporter public key via `getPeerByIdOrName` → `listPeerKeyWindows`/`verificationKeyForSequence` (`bundleKey`) and calls `verifyBundleSignature(bundle.checksum, bundle.bundleSignature, bundleKey)` at ~720. Verify the attestation signature against that SAME `bundleKey`, then verify-and-advance the high-water mark. Do it UNCONDITIONALLY (both full and sparse receivers), independent of `isFullScope`/entry count.
  - High-water mark (`apps/server/src/db/schema.ts:1411` `sync_cursors`, keyed `(orgId, peerDomainId, originDomainId)`): add two NULLABLE columns `attested_tail_seq bigint`, `attested_tail_row_hash text` (migration 0090). Refuse (rail 1's `journal_divergence` 409 — so rail 4 needs that problem type, shared with rail 1) on `tailSequence` regression or same-height content change; else advance. New `cursors-repo.ts` fn `verifyAndAdvanceTailAttestation`.
  - **NOTE — rail 4 is coupled to rail 1's `journal_divergence` problem type** (the refusal vehicle). Building rail 4 pulls in that problem-type + response-map plumbing; consider building rail 1's problem-type scaffold first, then 1/2/4 together. `journal_divergence` would be the FIRST custom RFC 9457 `type` in the codebase (all existing 409s use `about:blank`); extension fields on the problem schema MUST be `.optional()` (a required-but-unpopulated extension turns a 409 into a serializer 500 — documented precedent, PR #156).
  - Test: `createIsolatedDomain` (two real databases) — attestation persists+advances on success; refuses on regression; refuses on same-height content change; a narrow-scope peer is caught by rail 4 where rails 1–3 miss it. Plus the **lost-tail simulation** permanent gate (§7.5) once resync exists.

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
