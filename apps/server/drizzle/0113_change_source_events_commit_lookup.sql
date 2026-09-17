-- 0113 — `change_source_events.commit_sha`: look up a stored source event BY THE COMMIT IT IS ABOUT.
--
-- A CI run is not a release (docs/proposals/run-events-are-not-releases.md, owner decision
-- 2026-09-16). `workflow_run` / Pipeline Hook / Argo CD `sync` / deployment / pull-request events are
-- still ingested into this table, but they no longer propose a change. The component view's "built
-- upstream" line (`coordination/observed-run-facts.ts`) used to read the run off a run-born CHANGE.
-- It now finds the run for a release's own commit by joining this table on that commit. This column
-- and its index keep that read from scanning an append-only table that has no retention (ADR-0024).
--
-- ## WHY A GENERATED COLUMN AND NOT AN EXPRESSION INDEX — measured, not assumed
--
-- The first version was an expression index on the same `coalesce(...)`. Under the app role, EXPLAIN
-- showed it used only as an `(org_id, source_kind)` prefix, with the commit as a post-scan `Filter`.
-- `change_source_events` has FORCED row-level security, and the planner will not evaluate a
-- non-leakproof function (jsonb `->>`) as an index condition ahead of the RLS qual. Text equality on
-- a plain column is leakproof, so `commit_sha = ANY(...)` IS an index condition.
-- `run-events-are-not-releases.integration.test.ts` asserts the plan, including that the commit is
-- not a Filter.
--
-- One arm per writer shape that carries run identity: `commitSha` (every observed event, written
-- flat by `observe.ts#ingestObservedEvents`), `workflow_run.head_sha` (a github webhook run),
-- `object_attributes.sha` (a gitlab Pipeline Hook). Existing rows are filled by the ADD COLUMN itself
-- (a STORED generated column is computed during the rewrite), so the homelab's 87 already-stored runs
-- become findable with no backfill step.
--
-- Idempotent (IF NOT EXISTS), like every migration since the 2026-08-13 three-branch `when` collision.

ALTER TABLE "change_source_events" ADD COLUMN IF NOT EXISTS "commit_sha" text GENERATED ALWAYS AS (coalesce(payload ->> 'commitSha', payload -> 'workflow_run' ->> 'head_sha', payload -> 'object_attributes' ->> 'sha')) STORED;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "change_source_events_org_kind_commit" ON "change_source_events" USING btree ("org_id","source_kind","commit_sha");
