-- ===========================================================================================
-- M25.1 — LIFTING A FREEZE: `freezes.lifted_at` (+ who and why)
-- docs/proposals/campaigns-rework.md §"M25.1 — freeze API completion"
--
-- `/api/v1/freezes` shipped as CREATE / LIST / GET. There has never been a way to LIFT a freeze or
-- to SHORTEN one. That was survivable while a freeze parked a whole wave — the operator waited for
-- `ends_at` and the release resumed on its own. M25.2 (drizzle/0084) made it unsurvivable: a
-- far-future `ends_at` now holds a SUBSET of a wave's targets while the siblings have already
-- shipped, so a mistyped year leaves a fleet split across two versions with no API exit. The only
-- escapes were `scp change cancel` / `scp change rollback`, both of which throw the RELEASE away
-- rather than lifting the FREEZE.
--
-- ===========================================================================================
-- WHY A SOFT LIFT AND NOT `DELETE FROM freezes`
--
-- Charter principle 6: every blocked response carries a `decision_id` and stays reconstructible.
-- Two Decision writers put `freeze.id` in their `inputContext` — `gate-orchestrator.ts`'s
-- freeze-block (`inputContext.freeze.id`) and `reconcile.ts`'s `recordFreezeAdmissionHold`
-- (`inputContext.held[].freezes[].id`) — and those rows are permanent. A hard DELETE dangles every
-- one of them: `scp change explain` would name a freeze id that resolves to nothing, and the
-- question an operator actually asks ("what was this freeze that blocked me, and who took it
-- away?") would have no answer at all. So the row STAYS, readable by id forever, and stops being
-- ACTIVE.
--
-- The house pattern for exactly this shape is `personal_access_tokens.revoked_at` (schema.ts:105,
-- drizzle/0004): a projection row a DELETE route retires in place, still listed, still gettable,
-- carrying the instant it stopped counting. `objects.deleted_at` / `relationships.deleted_at` are
-- the same idea one table class over. This column is that pattern, named for the domain verb the
-- proposal and the CLI use — an operator LIFTS a freeze, they do not revoke or delete it.
--
-- ===========================================================================================
-- WHY A COLUMN AND NOT "JUST SET ends_at = now()"
--
-- Tempting, and it would need no migration at all: `starts_at <= at < ends_at` already makes a
-- freeze with a past `ends_at` inactive. Rejected on one decisive case and two supporting ones.
--
--   * A FREEZE THAT HAS NOT STARTED YET CANNOT BE EXPRESSED THAT WAY. A freeze scheduled for next
--     week has `starts_at` in the future; setting `ends_at = now()` produces `ends_at < starts_at`,
--     a row that violates the one invariant `createFreeze` and `POST /freezes` both enforce, that
--     `GET /freezes/{id}` would render as nonsense, and that a future window predicate could read
--     either way. A scheduled freeze declared by mistake is precisely a freeze someone needs to
--     retract, so the encoding must cover it.
--   * A LIFT IS NOT CLOCK-RELATIVE. `lifted_at IS NOT NULL` is a durable, order-independent fact.
--     "ends_at is in the past" is a fact about the clock that a later PATCH can silently reverse.
--   * THE TWO ACTS ARE DIFFERENT AND BOTH ARE AUDITED. "I retract this declaration" and "this
--     window ends sooner than I said" are different operator intents; recording them as one loses
--     the distinction in the only place it is ever read back from.
--
-- The converse holds and is deliberate: SHORTENING `ends_at` to a past instant is left as an
-- ordinary window edit, NOT silently re-labelled a lift. It has the same effect on admission
-- (the freeze leaves the window) and a different record, which is the truth.
--
-- ===========================================================================================
-- THE LIVENESS FILTER GOES IN EXACTLY ONE PLACE
--
-- `governance/freezes-repo.ts`'s `activeFreezesInWindow` — the ONE function that knows the window
-- predicate, which is why M25.2 split it out of `activeFreezesForScopes` in the first place. Every
-- consumer of "is this freeze in force" (`checkFreeze`, `freezesByTarget`, `evaluateFreezeHolds`,
-- the service board) composes over it, so one `IS NULL` retires a freeze on every path at once.
-- A SECOND liveness filter anywhere else rebuilds the drift hazard that once made a service-scoped
-- freeze fail OPEN (see `graph/containment.ts`'s header) one column over.
--
-- `listFreezes` and `getFreeze` deliberately do NOT filter: a lifted freeze must stay readable so a
-- Decision citing it resolves. "Lifted" is a FIELD on the response, not an absence from it.
--
-- ===========================================================================================
-- NO INDEX CHANGE
--
-- `freezes_org_window (org_id, starts_at, ends_at)` already narrows to "freezes covering this
-- instant", which is ZERO rows for nearly every org nearly all the time — the regime
-- `freeze-scope.ts`'s INERTNESS property is built on. `lifted_at IS NULL` is then a filter over a
-- handful of rows at most; making the index partial would buy nothing measurable and would mean
-- rewriting an index the hot path depends on. Revisit only if an estate accumulates many
-- simultaneously-active freezes.
--
-- ===========================================================================================
-- NO NEW GRANTS, NO NEW POLICY
--
-- A column inherits its table's grants and RLS. `freezes` is an ordinary TENANT table (0007) with
-- `org_isolation` (USING + WITH CHECK), ENABLE + FORCE RLS and the ordinary `scp_app` grants —
-- and, unlike 0076's operator-write/tenant-read tables, nothing here needs `scp_operator`. The
-- route already held `UPDATE` on this table implicitly by holding the table; it just never used it.
--
-- `lifted_by_actor_id` is NOT a foreign key, matching every other `*_actor_id` on this table
-- (`created_by_actor_id` has no FK either) — actors are graph objects that can be tombstoned, and a
-- lift record must outlive the operator who made it.
--
-- ===========================================================================================
-- WHY 0085, AND THE `when` — RENUMBERED FROM 0078, SEE 0084's HEADER
--
-- 0084 is this branch's next-highest entry (`when` 1788142000000); this one is 1788143000000 —
-- STRICTLY GREATER, which is the only comparison drizzle makes. Both are above `main`'s highest
-- (0083_governance_move_rungs, 1788141000000), which is the comparison that matters and the one
-- the originally-authored pair got wrong: this file's 1788146000000 cleared `main` by luck while
-- its sibling's 1788140000000 did not, so the pair would have SPLIT — `lifted_at` applied,
-- `atomic` skipped forever, and every freeze read broken on any instance already at 0083. 0084's
-- header carries the full account; `db/journal-ordering.test.ts` is the guard that catches it.
--
-- Hand-authored, same reason as 0002/0005/0007/0010/0011/0084: drizzle-kit's interactive
-- column-provenance prompt cannot run non-interactively here, and RLS/grants are never expressible
-- in its schema diffing anyway.
-- ===========================================================================================

ALTER TABLE "freezes"
  ADD COLUMN IF NOT EXISTS "lifted_at" timestamptz,
  ADD COLUMN IF NOT EXISTS "lifted_by_actor_id" uuid,
  ADD COLUMN IF NOT EXISTS "lift_reason" text;
--> statement-breakpoint

COMMENT ON COLUMN freezes.lifted_at IS
  'NON-NULL = this freeze was RETRACTED by an operator at this instant and is no longer in force, regardless of ends_at. Filtered in exactly ONE place — governance/freezes-repo.ts''s activeFreezesInWindow, the single function that knows the window predicate — so every consumer (checkFreeze, freezesByTarget, evaluateFreezeHolds, the service board) retires it at once. listFreezes/getFreeze deliberately do NOT filter: a lifted freeze stays readable by id forever so a Decision that cites it still resolves (charter principle 6).';
--> statement-breakpoint

COMMENT ON COLUMN freezes.lifted_by_actor_id IS
  'The actor object that lifted this freeze. No FK, matching created_by_actor_id: an actor is a graph object that can be tombstoned, and the lift record must outlive them.';
--> statement-breakpoint

COMMENT ON COLUMN freezes.lift_reason IS
  'MANDATORY at the route (non-empty) whenever lifted_at is set. A freeze is a governance TIGHTENING and lifting it is a LOOSENING that applies to everyone at once; freeze:override already refuses to bypass a freeze without a reason, and retracting one outright cannot be held to a lower standard.';
