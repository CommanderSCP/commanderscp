-- ===========================================================================================
-- Pre-M16 residual — make the §13 "as of" label's TRANSPORT attribution derivable, and stop the
-- board's freshness anchor from doing a sequential scan on every render.
--
-- 1. `bundle_transfers.transport` — WHY A COLUMN AND NOT AN INFERENCE.
--
-- `ServiceBoardAsOf.via` distinguishes "as of 3 days ago via an air-gap bundle" (a normal, healthy
-- air-gapped domain) from "as of 3 days ago because the live poller is wedged" (an incident). Those
-- are different operator situations, so getting the attribution BACKWARDS is worse than omitting it.
--
-- The first attempt inferred it: `federation_peers.last_pull_success_at >= transfers.confirmed_at`
-- must mean the scheduler delivered it, on the stated grounds that the scheduler stamps the success
-- column AFTER the import transaction. It does not. `federation-sync.ts`'s tick captures `now` ONCE
-- at TICK START and passes that same value to `markPeerPullSuccess`, so a live pull's
-- `last_pull_success_at` is always EARLIER than the `confirmed_at` its own import wrote a moment
-- later. The predicate was therefore false for essentially every real live pull, and every one of
-- them was reported as a bundle import.
--
-- No pair of existing timestamps can carry this: the two columns are written by different clocks in
-- different transactions for different purposes, and an air-gapped instance has no pull columns at
-- all. The transport is a FACT KNOWN AT IMPORT TIME by the caller and by nobody else afterwards, so
-- it is recorded at import time. `'live-pull'` is written only by the scheduler
-- (`pullFromCommanderPeer`); `'bundle'` by every file/pushed/inbox path.
--
-- NULLABLE WITH NO BACKFILL, deliberately. A row written before this migration genuinely does not
-- record its transport, and inventing one would be the same fabrication this column exists to end.
-- NULL surfaces as `via: "unknown"` — see `federation/upstream-freshness.ts`.
--
-- 2. `bundle_transfers_org_peer_confirmed` — the board's hot path.
--
-- `lastConfirmedSyncImportAt` runs ONCE PER PEER on every service-board render, ordering by
-- `confirmed_at DESC LIMIT 1`. The only existing index is `(org_id, peer_domain_id, created_at)`,
-- which cannot serve that ORDER BY, so the query degraded into a scan-and-sort of every transfer row
-- ever written for that peer — a table that only ever grows (this module exposes no pruning, by
-- design: it is the air-gap handoff ledger). The partial index matches the predicate exactly
-- (`direction='import' AND kind='sync' AND status='confirmed'`, which is also the only combination
-- that ever carries a non-null `confirmed_at`) and orders by `confirmed_at DESC`, so the lookup is a
-- single index seek regardless of history depth. `transport` is INCLUDEd so the read is index-only.
--
-- Both statements are plain additive DDL on an RLS-governed table: the existing `org_isolation`
-- policy and grants are inherited unchanged (same class as 0031 / 0033 / 0037 / 0038).
-- ===========================================================================================

ALTER TABLE "bundle_transfers" ADD COLUMN IF NOT EXISTS "transport" text;

CREATE INDEX IF NOT EXISTS "bundle_transfers_org_peer_confirmed"
  ON "bundle_transfers" ("org_id", "peer_domain_id", "confirmed_at" DESC)
  INCLUDE ("transport")
  WHERE "direction" = 'import' AND "kind" = 'sync' AND "status" = 'confirmed';
