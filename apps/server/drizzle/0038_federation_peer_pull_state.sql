-- ===========================================================================================
-- M14.4 — per-peer live-pull DUE-STATE (ADR-0009 optional poke-mode federation; proposal
-- docs/proposals/outpost-poke.md §"Milestone scope"; owner decisions D1–D4, 2026-07-24).
--
-- EXPAND phase (additive, backward-compatible). THREE nullable timestamptz columns on
-- `federation_peers`, BESIDE `poke_mode` — the state the M14.4 scheduler mode needs and that
-- nothing existing can stand in for:
--
--   * `last_pull_attempt_at`  — stamped by the scheduler's CONDITIONAL claim
--     (`UPDATE … WHERE last_pull_attempt_at IS NULL OR last_pull_attempt_at <= $threshold`), which
--     is what makes the due-gate REPLICA-SAFE: two worker replicas ticking in the same window
--     cannot both pull the same peer, because only one UPDATE returns a row. An in-memory Map
--     would multiply the effective poll rate by the replica count and defeat "sparse" entirely.
--   * `last_pull_success_at` — stamped ONLY on an `imported` outcome. `last_pull_success_at IS NULL
--     OR < last_pull_attempt_at` therefore IS the "the last attempt FAILED" signal, which returns a
--     poke-mode peer to the FREQUENT cadence until one pull succeeds (the reconnect leg). No
--     counters — a pure pair of timestamps is replica-safe by construction.
--   * `last_poke_received_at` — stamped by the M14.2 poke handler when it ACCEPTS a poke from that
--     caller (owner decision D2, SELF-PROVING SPARSE). A peer goes sparse only once pokes have
--     ACTUALLY been observed arriving from it; merely setting the local `poke_mode` flag is not
--     enough. This closes the unilateral-sparse footgun: flip the outpost's flag, forget the
--     commander's, and staleness would silently grow from 60s to 15min with no error anywhere.
--
-- ALL THREE ARE NULLABLE WITH NO BACKFILL — NULL reads as "never", which the due-gate treats as
-- DUE NOW. Every existing peer therefore migrates as an exact no-op: its very next tick pulls
-- immediately (and `pull-on-startup` still survives the gate for the same reason).
--
-- Why not reuse `sync_cursors.updated_at`: `advanceCursor` early-returns when nothing advanced
-- (cursors-repo.ts), so an idempotent no-op pull leaves it untouched. It records APPLIED PROGRESS,
-- never a pull ATTEMPT — using it would make an up-to-date peer look permanently overdue.
--
-- Plain additive columns on an RLS-governed table: the existing `org_isolation` policy is inherited
-- unchanged — no policy/grant statement needed (same class as 0031 / 0033 / 0037).
-- ===========================================================================================

ALTER TABLE "federation_peers" ADD COLUMN IF NOT EXISTS "last_pull_attempt_at" timestamp with time zone;
ALTER TABLE "federation_peers" ADD COLUMN IF NOT EXISTS "last_pull_success_at" timestamp with time zone;
ALTER TABLE "federation_peers" ADD COLUMN IF NOT EXISTS "last_poke_received_at" timestamp with time zone;
