-- ===========================================================================================
-- 0091 — FEDERATION AUDIT WITNESS (rail §7.2.7 — turn every peer into a passive witness of an
--        exporter's audit-chain head, at near-zero cost)
--        (docs/proposals/multi-region-instance-resilience.md §7.2.7, M26.2)
--
-- Importers today DISCARD `audit_segment` journal entries (import-repo.ts's switch returns for
-- them). They already flow on every sync, already carry `auditEventId` + the entry's `contentHash`,
-- and are already hash-chain-verified on the exporting side. Persisting `(peer, origin, sequence,
-- auditEventId, contentHash)` makes this receiver a WITNESS of the exporter's audit-chain head: after
-- a commander restores from backup, the post-failover runbook compares its restored local chain head
-- against what its peers witnessed — the ONLY way to see truncation, since `scp audit verify` alone
-- verifies any prefix and so is structurally blind to it (B2). `auditEventId` is persisted alongside
-- the literal `(peer, sequence, contentHash)` tuple the proposal names because the runbook's join
-- back to this domain's own `audit_events` after a restore needs it, and it is already on the wire.
--
-- INFORMATIONAL ONLY: recording a witness NEVER blocks an import, never affects applied/skipped
-- counts — it is a detector, not a gate (federation is never a source of restoration, ADR-0031/§10;
-- peers are detectors of truncation, never sources of the truncated data).
--
-- Ordinary per-org tenant data (the 0071/0079 shape): FORCE-RLS org isolation, `scp_app` DML.
-- Hand-authored (RLS/grants are not expressible in drizzle-kit's schema diffing).
-- ===========================================================================================

CREATE TABLE IF NOT EXISTS "federation_audit_witness" (
  "id" uuid PRIMARY KEY,
  "org_id" uuid NOT NULL,
  -- TRUST sense (ADR-0021 D4): who this segment arrived FROM, and whose chain it originated in.
  "peer_domain_id" uuid NOT NULL,
  "origin_domain_id" uuid NOT NULL,
  "sequence" bigint NOT NULL,
  -- The join key back to a peer's OWN `audit_events` after a restore — free, already on the wire.
  "audit_event_id" uuid NOT NULL,
  -- The witnessed audit row's `contentHash` (the entry's rowHash), compared against the exporter's
  -- restored head to DETECT truncation. Never used to reconstruct the row.
  "content_hash" text NOT NULL,
  "witnessed_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint

-- Idempotent witnessing: re-importing the same segment must not double-record. One witness per
-- (org, origin, sequence) — the origin's own chain position is the natural key.
CREATE UNIQUE INDEX IF NOT EXISTS "federation_audit_witness_origin_seq"
  ON "federation_audit_witness" USING btree ("org_id", "origin_domain_id", "sequence");
--> statement-breakpoint

GRANT SELECT, INSERT ON federation_audit_witness TO scp_app;
--> statement-breakpoint

ALTER TABLE federation_audit_witness ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE federation_audit_witness FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS org_isolation ON federation_audit_witness;
--> statement-breakpoint
CREATE POLICY org_isolation ON federation_audit_witness
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
--> statement-breakpoint

COMMENT ON TABLE federation_audit_witness IS
  'multi-region-instance-resilience §7.2.7: a passive witness of a peer origin''s audit-chain head, persisted from the audit_segment journal entries importers used to discard. INFORMATIONAL — never blocks an import. The post-failover runbook compares a restored local head against peers'' witnessed (auditEventId, contentHash) at each sequence to detect truncation, which scp audit verify cannot see (any prefix verifies). Peers are detectors, never sources of restoration.';
