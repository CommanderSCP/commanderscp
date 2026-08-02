-- ===========================================================================================
-- `changes.cancellation_kind` — tell an AUTO-cancelled change from a USER-cancelled one
-- (post-import-configuration.md §1.5 / §11, the second of the two silent hazards).
--
-- Both land in state `cancelled`, and until now the ONLY thing separating them was the free-text
-- `reason` carried on the transition's Decision and audit event. Nothing on the change row said
-- which had happened, so "how many of last week's changes did the engine kill?" could only be
-- answered by substring-matching an English sentence — and any rewording of that sentence silently
-- changed the answer. `reconcile.ts` auto-cancels on a plan-compilation failure, which is exactly
-- the population an operator most needs to count and least wants to discover by eye.
--
-- NULL for every pre-existing row and for every change that is not cancelled. Deliberately NOT
-- backfilled: the distinction was not recorded at the time, and inferring it now from reason text
-- would fabricate a fact — the same reason D6 forbids backfilling inherited pipelines. A NULL on a
-- cancelled row honestly means "cancelled before this column existed".
--
-- Not an enum type: the codebase's convention is `text` with the domain documented at the write
-- site (see `state`, `status` on the sibling tables). The writer is a single choke point in
-- `coordination/transition.ts` — the actor is the system actor or it is not — so there is exactly
-- one place a bad value could come from.
-- ===========================================================================================

ALTER TABLE "changes" ADD COLUMN IF NOT EXISTS "cancellation_kind" text;

COMMENT ON COLUMN "changes"."cancellation_kind" IS
  'system|user — who cancelled this change. NULL when not cancelled, or cancelled before 0053.';
