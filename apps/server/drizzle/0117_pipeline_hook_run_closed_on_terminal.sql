-- 0117 — pipeline_hook_runs.closed_at: the SAME property migration 0115 closed for
-- approval_requests ("state that outlives the change it belongs to when the change reaches a
-- TERMINAL state") also holds here. A run left `pending`/`running` when its change goes
-- cancelled/rolled_back never finishes — nothing about the change coming back can make it
-- progress — but the row stays as history. `status` itself is untouched: it mirrors
-- `ExecutionPhase` from `@scp/plugin-api` member for member (see the column's doc in schema.ts),
-- so a 6th value here would break that lockstep the same way a third approval_requests.status
-- value would have broken the oasdiff-additive-response rule. `closed_reason` names the terminal
-- `toState` that closed it; `closed_decision_id` is the SAME Decision id the closing transition
-- itself recorded — not a second Decision row for the same event (see the unbounded-Decision-
-- growth incident).
--
-- The `pipeline_hook_runs_non_terminal` partial index is the poll driver's only scan
-- (`listNonTerminalHookRuns`/`pollNonTerminalHookRuns`) — it is rebuilt here to also exclude
-- closed rows, so a run whose change already went terminal drops out of the poll's work list in
-- the SAME transaction the closure happens in, instead of being polled (and billing an executor
-- `status()` call) forever, or until the underlying workflow happens to conclude on its own.
--
-- LOCKING: `DROP INDEX` + `CREATE INDEX` inside drizzle's migration transaction — same atomic-swap
-- shape as 0070/0044/0046/0069. `pipeline_hook_runs` is small and append-mostly; the rebuild is a
-- handful of milliseconds even at the estate's current size.
--
-- Idempotent (IF NOT EXISTS / IF EXISTS), like every migration since the 2026-08-13 three-branch
-- `when` collision.

ALTER TABLE "pipeline_hook_runs" ADD COLUMN IF NOT EXISTS "closed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "pipeline_hook_runs" ADD COLUMN IF NOT EXISTS "closed_reason" text;--> statement-breakpoint
ALTER TABLE "pipeline_hook_runs" ADD COLUMN IF NOT EXISTS "closed_decision_id" uuid;--> statement-breakpoint
DROP INDEX IF EXISTS "pipeline_hook_runs_non_terminal";--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pipeline_hook_runs_non_terminal" ON "pipeline_hook_runs" USING btree ("org_id","started_at") WHERE "pipeline_hook_runs"."status" IN ('pending','running') AND "pipeline_hook_runs"."closed_at" IS NULL;
