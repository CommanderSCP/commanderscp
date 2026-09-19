-- 0115 — approval_requests.closed_at: a request whose CHANGE reaches a terminal state
-- (`cancelled`, `rolled_back`) stops being actionable forever, but the row stays as history — its
-- `status`/vote count still explain what quorum state it was in when the change died. `status`
-- itself stays "pending" | "satisfied": a third enum member on a RESPONSE is an oasdiff-breaking
-- wire change (enum-value additions on a response ARE breaking, unlike a oneOf-member addition —
-- see the fix this migration ships with). `closed_reason` names the terminal `toState` that closed
-- it; `closed_decision_id` is the SAME Decision id the closing transition itself recorded — not a
-- second Decision row for the same event (see the unbounded-Decision-growth incident).
--
-- Idempotent (IF NOT EXISTS), like every migration since the 2026-08-13 three-branch `when` collision.

ALTER TABLE "approval_requests" ADD COLUMN IF NOT EXISTS "closed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "approval_requests" ADD COLUMN IF NOT EXISTS "closed_reason" text;--> statement-breakpoint
ALTER TABLE "approval_requests" ADD COLUMN IF NOT EXISTS "closed_decision_id" uuid;
