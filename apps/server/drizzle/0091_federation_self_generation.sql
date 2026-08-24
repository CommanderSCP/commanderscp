-- ===========================================================================================
-- 0091 — FEDERATION GENERATION STAMP (§7.2.6 resync + the promotion runbook)
--        (docs/proposals/multi-region-instance-resilience.md §7.2.6, M26.2)
--
-- A per-org monotonic counter, bumped by the RESYNC operation (and, out of this milestone's scope,
-- by the promotion runbook). It is recorded WITH the resync Decision so a later forensic reading can
-- attribute which entries pre- and post-date a lost-tail event — and it gives §5-I1's unfenced
-- split-brain case a post-hoc identifier. It deliberately does NOT enter the signed journal-entry
-- format (§10: the reserved base_revision/conflict fields stay reserved; the rails and this stamp
-- live in local persistence + request/response space, never the entry format).
--
-- `federation_self` is the per-org, instance-wide identity singleton (one row per org). NOT NULL
-- DEFAULT 0 backfills every existing row to generation 0 — no deployment starts "already resynced".
-- Hand-authored (the column carries security-relevant provenance semantics; the DDL is a plain ALTER).
-- ===========================================================================================

ALTER TABLE "federation_self" ADD COLUMN IF NOT EXISTS "generation" bigint NOT NULL DEFAULT 0;
--> statement-breakpoint

COMMENT ON COLUMN federation_self.generation IS
  'multi-region-instance-resilience §7.2.6: a per-org monotonic counter bumped by the resync operation (and the promotion runbook). Recorded with the resync Decision so a forensic reading can attribute entries to before/after a lost-tail event. Never enters the signed journal-entry format.';
