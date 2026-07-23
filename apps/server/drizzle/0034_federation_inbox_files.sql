-- ===========================================================================================
-- M13.1a — the staging-node inbox PROCESSED-FILE LEDGER (`federation_inbox_files`).
--
-- WHAT THIS IS (docs/proposals/airgap-cds-validate-promote.md §13.1). The unattended inbox loop
-- (federation/inbox-loop.ts) lists a delivery inbox every tick and must know which files it has
-- ALREADY processed — the dedupe that makes re-processing an already-imported file a no-op. This
-- table is that ledger: one row per (org, inbox dir, file name, content sha256) the loop has
-- terminally handled, with the outcome ('imported' | 'forwarded' | 'refused' | 'skipped') and the
-- Decision the outcome hangs off (when one exists).
--
-- WHY A LEDGER TABLE AND NOT bundle_transfers ALONE (the documented §13.1a "decide the ledger"
-- decision). `bundle_transfers` stays what its header says it is — purely observational per-HOP
-- bookkeeping, never consulted for authority/idempotency — and the import paths keep writing it
-- (validate-gated, D4). But it has no file identity: it cannot answer "was THIS file, at THIS
-- content hash, already handled?", and a refused file writes no transfer row at all (a refusal
-- must never be re-refused every 60 seconds forever). The ledger keys on content identity
-- (file name + sha256), so a REPLACED file with the same name but new bytes is processed as new,
-- while a re-listed identical file is a silent no-op. Quarantine posture (documented): files are
-- LEFT IN PLACE in the inbox — the loop never deletes or moves what an operator (or a CDS
-- product) dropped; "quarantined" is a ledger state, not a filesystem move.
--
-- INSERT-ONLY from the loop (rows are never mutated; a re-processed replaced file gets a NEW row
-- at its new sha256) — so scp_app gets SELECT + INSERT only, mirroring instance_cosign_keys.
--
-- Hand-authored (same convention as 0002/0007/0010/0016/0030): RLS/grants are never expressible
-- in drizzle-kit's schema diffing.
-- ===========================================================================================

CREATE TABLE IF NOT EXISTS "federation_inbox_files" (
  "id" uuid PRIMARY KEY NOT NULL,
  "org_id" uuid NOT NULL,
  -- The RESOLVED inbox directory the file was listed in (per-peer DeliveryTarget inDir or the
  -- instance SCP_RELAY_IN_DIR fallback) — part of the identity so two peers' inboxes never
  -- shadow each other's file names.
  "inbox_dir" text NOT NULL,
  "file_name" text NOT NULL,
  -- sha256 (hex) of the file CONTENT at processing time; the sentinel '-' for a file that could
  -- not be read at all (e.g. a traversal-shaped name refused before any read).
  "sha256" text NOT NULL,
  -- 'imported' (bundle/tarball landed via the existing verify paths) | 'forwarded' (retrans
  -- push-less validate-and-forward) | 'refused' (validation failure — block Decision) |
  -- 'skipped' (foreign/unknown file — logged, never a crash).
  "outcome" text NOT NULL,
  "detail" text,
  -- The Decision this outcome hangs off: the verify path's own Decision when it wrote one, else
  -- the loop's `federation-inbox-ingest` block Decision for refusals. NULL for skips/imports
  -- whose underlying path writes no Decision (e.g. a sync bundle import).
  "decision_id" uuid,
  "processed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

-- Content identity: one terminal outcome per (org, inbox, name, content-hash). The loop's dedupe
-- check is a point lookup on exactly these columns.
CREATE UNIQUE INDEX IF NOT EXISTS "federation_inbox_files_identity"
  ON "federation_inbox_files" USING btree ("org_id", "inbox_dir", "file_name", "sha256");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "federation_inbox_files_org_processed"
  ON "federation_inbox_files" USING btree ("org_id", "processed_at");
--> statement-breakpoint

-- Grants — SELECT + INSERT only (insert-only ledger; rows are never mutated or deleted over the
-- request-serving role), mirroring instance_cosign_keys (0030).
GRANT SELECT, INSERT ON "federation_inbox_files" TO scp_app;
--> statement-breakpoint

-- RLS — the identical `org_isolation` shape as every other tenant table (DESIGN §4.2's "two
-- independent failures" invariant).
ALTER TABLE "federation_inbox_files" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "federation_inbox_files" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS org_isolation ON "federation_inbox_files";
--> statement-breakpoint
CREATE POLICY org_isolation ON "federation_inbox_files"
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
