-- ===========================================================================================
-- 0090 — RAIL 4: EXPORTER TAIL ATTESTATION HIGH-WATER MARK
--        (docs/proposals/multi-region-instance-resilience.md §7.2 rail 4, M26.2)
--
-- The EXPAND-phase substrate for divergence rail 4. Every export response will carry a signed
-- `(tailSequence, tailRowHash)` attestation of the exporter's own journal tail, OUTSIDE the signed
-- bundle checksum (an additive sibling field old importers ignore). The importer persists it here
-- as a MONOTONIC high-water mark per `(org_id, peer_domain_id, origin_domain_id)` — the same grain
-- the rest of this row already uses — and refuses (`journal_divergence`) on any regression or a
-- content change at the same height. This is what makes B1 (a lost/rolled-back tail after an
-- async-replication failover) detectable for a NARROW-scope peer, where rails 1–3 are silent
-- because that peer never holds a real anchor.
--
-- Both columns are NULLABLE with no backfill — exactly the `reanchor_from_seq` (0042) precedent: a
-- cursor that has never yet seen a signed attestation simply has NULL here, and rail 4 no-ops
-- (never blocks, never regresses the mark) until the first one arrives. NOTHING CHANGES UNTIL rail
-- 4's read/write logic (cursors-repo.ts, a later increment) consumes these columns; this migration
-- only adds the storage, so every existing deployment and test is unaffected.
--
-- No grant/RLS change: `sync_cursors` is already FORCE-RLS with the runtime `scp_app` role holding
-- SELECT/INSERT/UPDATE/DELETE (advanceCursor writes this table), and adding NULLABLE columns is
-- covered by those existing table-level grants. Hand-authored (drizzle-kit cannot express the
-- reasoning; the DDL itself is a plain ALTER).
-- ===========================================================================================

ALTER TABLE "sync_cursors" ADD COLUMN IF NOT EXISTS "attested_tail_seq" bigint;
--> statement-breakpoint
ALTER TABLE "sync_cursors" ADD COLUMN IF NOT EXISTS "attested_tail_row_hash" text;
--> statement-breakpoint

COMMENT ON COLUMN sync_cursors.attested_tail_seq IS
  'multi-region-instance-resilience §7.2 rail 4: the highest journal tail SEQUENCE this side has seen the exporter sign in a SyncBundle.tailAttestation, monotonic per (org, peer, origin). NULL until the first signed attestation. A later attestation whose tailSequence regresses is a journal_divergence refusal, never a regression of this column.';
--> statement-breakpoint
COMMENT ON COLUMN sync_cursors.attested_tail_row_hash IS
  'multi-region-instance-resilience §7.2 rail 4: the rowHash the exporter attested AT attested_tail_seq. A later attestation with a DIFFERENT rowHash at the SAME height is a journal_divergence refusal (a rewritten/forked tail). NULL until the first signed attestation.';
