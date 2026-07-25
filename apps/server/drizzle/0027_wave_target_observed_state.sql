-- ===========================================================================================
-- P4B increment 2 — persist the OBSERVED revision reconcile already computes and discards
-- (ADR-0008 decision 1; docs/proposals/observe-enrichment.md signal 1).
--
-- reconcile's status-poll path (coordination/reconcile.ts) already receives `status().stateRef`
-- from every executor (argocd = the synced revision; fake-executor = v${version}) but threw it
-- away — `updateWaveTargetObserved` persisted only { status, lastObservedAt }. This column is the
-- durable home for that stateRef, surfaced as the per-stage version on `scp change explain` and
-- the pipeline UI (StageCard).
--
-- Additive, nullable, no backfill: null until the first successful observe writes a revision. A
-- status() that reports no stateRef (e.g. an Argo CD app that has never synced) does NOT null a
-- previously-captured value — the repo writes `observed_state` only when a stateRef is present.
-- Mirrors the `executor_ref` / `prior_state_ref` jsonb precedent on the same row: bare
-- jsonb, no NOT NULL, no pg enum. Stores the opaque revision as-is (string today; a typed
-- digest/rollout object in a later increment needs no schema change — jsonb already widens).
-- ===========================================================================================

ALTER TABLE "change_wave_targets"
  ADD COLUMN IF NOT EXISTS "observed_state" jsonb;
