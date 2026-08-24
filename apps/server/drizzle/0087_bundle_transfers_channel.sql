-- ===========================================================================================
-- 0087 — `bundle_transfers.channel`: make the retrans BYTE-RELAY leg distinguishable from an
--         ordinary METADATA `.scpbundle` handoff in the ledger.
--
-- SINCE M13.1b, EVERY hop `recordBundleTransfer` writes — an ordinary sync/promotion `.scpbundle`
-- export/import AND a retrans's byte-tarball build/relay/import — lands in this table with the same
-- shape: `{direction, kind:'promotion', status, checksum}`. A retrans's `buildRelayTarball` submits,
-- `validateAndForwardRelayTarball` confirms-then-submits, and `importRelayTarball` confirms — all
-- `kind:'promotion'`, byte-for-byte identical on the wire to `promotion-repo.ts`'s plain metadata
-- bundle export/import rows of the same kind. The UI has no column that says which job a row did
-- (`boundary-segment.ts`'s `BoundaryTransferHop` — the read model consuming this ledger — inherits
-- the same blindness). Provenance must be READ, stated by the writer, never inferred downstream
-- (charter principle 6 / repo discipline) — hence a column, not a `kind`-plus-heuristic reconstruction
-- at read time (kind stays `'promotion'` for every hop above; a heuristic keyed on it cannot tell
-- them apart either).
--
-- NULL = GENUINELY UNKNOWN, not "metadata" by default. Every row written before this migration
-- predates the concept and is honestly unlabelled — same convention as `transport` (0041) and
-- `source_mappings.scope` (0082): no backfill, no inferred default, nothing parses `direction`/`kind`
-- to fill it in after the fact. `bundle-transfers-repo.ts::recordBundleTransfer` makes the parameter
-- REQUIRED at every call site from this migration forward (TypeScript, not a DB constraint — the
-- column itself stays nullable so a caller that is genuinely unable to know may still pass `null`
-- deliberately, distinct from an old row that was never asked).
--
-- Plain additive DDL on an already-RLS-governed, already-granted table: the `org_isolation` RLS
-- policy is a row-level `org_id` predicate and the grants are table-wide, so neither depends on the
-- column list. Precedents: 0041 added the nullable `transport` column to THIS table without
-- re-declaring either, and the ADD COLUMN + conditional CHECK idiom below is 0082's
-- (`source_mappings.scope`), applied unchanged.
-- ===========================================================================================

ALTER TABLE "bundle_transfers" ADD COLUMN IF NOT EXISTS "channel" text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'bundle_transfers_channel_check'
  ) THEN
    ALTER TABLE "bundle_transfers"
      ADD CONSTRAINT "bundle_transfers_channel_check"
      CHECK ("channel" IS NULL OR "channel" IN ('metadata', 'bytes'));
  END IF;
END $$;

COMMENT ON COLUMN "bundle_transfers"."channel" IS
  'Which leg this hop was: ''metadata'' (an ordinary .scpbundle sync/promotion export or import) or ''bytes'' (a retrans byte-relay hop — buildRelayTarball''s submit, validateAndForwardRelayTarball''s confirm+submit, importRelayTarball''s confirm). NULL = not recorded (pre-0087 row, or a writer that genuinely could not determine it) — never inferred from direction/kind/status, which are identical across both channels for a kind=''promotion'' row.';
