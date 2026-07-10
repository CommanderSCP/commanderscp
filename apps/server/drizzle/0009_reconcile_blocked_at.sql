-- MAJOR #6 fix (PR #7 adversarial review of the M3 coordination engine — "reconcile batch
-- starvation"): `coordination/reconcile.ts`'s `listChangeRowsInStates` orders `executing` changes
-- oldest-`updated_at`-first, capped at 25 per tick. A change parked in `executing` because its
-- active wave has `failed` (M3 has no auto-retry — an operator must cancel/rollback it manually)
-- never touched `changes` again on its own, so `updated_at` stayed frozen at whenever it was last
-- legitimately updated — meaning 25+ such parked changes would sort ahead of every newer,
-- genuinely-progressing `executing` change and starve it out of every batch forever.
--
-- `reconcile_blocked_at` is set (once, idempotently) by `coordination/reconcile.ts` the moment it
-- observes an `executing` change's active wave has failed; `listChangeRowsInStates` filters this
-- column `IS NULL`, so a parked change simply stops occupying batch slots. An operator's manual
-- cancel/rollback goes through `transition.ts`'s guarded transition function directly from the API
-- route handlers — never through this batch listing — so parking a change here never blocks a
-- human from unsticking it; only the AUTOMATIC reconcile sweep skips it. No RLS/grant changes
-- needed: this is a plain column on the already-tenant-scoped `changes` table from 0007.

ALTER TABLE "changes" ADD COLUMN IF NOT EXISTS "reconcile_blocked_at" timestamptz;
