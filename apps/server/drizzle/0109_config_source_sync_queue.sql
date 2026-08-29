-- `config_source_sync_queue` — THE TRIGGER'S DURABLE HANDOFF (ADR-0046 section 2; proposal section 4).
--
-- ===========================================================================================
-- WHY A QUEUE AND NOT A CALL
-- ===========================================================================================
-- A push to a registered config repo has to end in a plan/apply. The obvious implementation - call
-- the sync engine from `processChangeSourceEvents` - is wrong twice over, and both reasons are
-- structural rather than stylistic:
--
--  1. THE SYNC READS A MANIFEST OVER AN OUT-OF-PROCESS RPC. `readFileAtRef` runs in the plugin
--     subprocess. `processChangeSourceEvents` runs inside a tenant transaction, and holding a DB
--     connection open across an external call is the exact hazard already tracked against
--     `triggerWaveTarget` in this repo's deferred-security list.
--
--  2. THE SYNC WRITES THE GRAPH. A failed write inside that shared transaction ABORTS it, and a
--     try/catch does not make it tolerant - a caught Postgres error leaves the tx aborted and the
--     next statement dies with 25P02 somewhere unrelated. So a sync that fails would take the
--     webhook batch down with it, wedging correlation for every other event in the tick.
--
-- The event pass therefore does the one cheap thing it can do safely: RECORD that a registered repo
-- moved. Draining happens on its own step, outside that transaction, where an RPC is legal and a
-- failure is isolated to one row.
--
-- ===========================================================================================
-- IDENTITY, AND WHY IT IS NOT (source, commit)
-- ===========================================================================================
-- `(org_id, config_source_id, commit_sha)` would collapse two pushes of the same commit to one
-- entry, which sounds right and is not: the same commit can legitimately be delivered twice with
-- DIFFERENT touched paths (a provider redelivery carrying a narrower diff, a force-push replay), and
-- the paths decide which manifests are read. So the primary key is the row's own id and dedup is a
-- PARTIAL UNIQUE INDEX on the pending rows only - a second delivery while one is still pending is
-- the same work, but once drained a later delivery of the same commit is a new, legitimate request.
--
-- `processed_at IS NULL` in that index is what makes it a QUEUE rather than a log: drained rows stay
-- for the status surface (proposal section 4's "the repo being ahead of the graph must be a DISPLAYED
-- state") and stop constraining new work.

CREATE TABLE IF NOT EXISTS "config_source_sync_queue" (
  "id" uuid PRIMARY KEY,
  "org_id" uuid NOT NULL,
  -- The `config-source` object whose repo moved. Org-unbound `REFERENCES objects(id)`, the form
  -- `config_source_stacks.config_source_id` uses.
  "config_source_id" uuid NOT NULL REFERENCES objects(id),
  -- Carried verbatim from the delivery rather than re-derived at drain time: the registration could
  -- be edited between enqueue and drain, and the work item is about the repo that ACTUALLY moved.
  "repo" text NOT NULL,
  "commit_sha" text NOT NULL,
  -- `ExtractedHint.paths` - every path the commit touched. The drain intersects these with the
  -- registration's globs; an empty array is legitimate (a provider that reports no paths) and means
  -- "read every manifest the registration selects", which is the conservative direction.
  "paths" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "enqueued_at" timestamp with time zone NOT NULL DEFAULT now(),
  -- NULL until drained. Set even on a FAILED drain: the failure is recorded in `last_error` and
  -- surfaced as config-source status, never retried forever. A repo that is still ahead of the graph
  -- is a displayed state, not an infinite retry loop.
  "processed_at" timestamp with time zone,
  "attempts" integer NOT NULL DEFAULT 0,
  "last_error" text
);
--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE ON config_source_sync_queue TO scp_app;
--> statement-breakpoint
ALTER TABLE config_source_sync_queue ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE config_source_sync_queue FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS org_isolation ON config_source_sync_queue;
--> statement-breakpoint
CREATE POLICY org_isolation ON config_source_sync_queue
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
--> statement-breakpoint

-- One PENDING entry per (source, commit). See the header for why `processed_at IS NULL` belongs in
-- the predicate rather than the key.
CREATE UNIQUE INDEX IF NOT EXISTS "config_source_sync_queue_pending_identity"
  ON "config_source_sync_queue" ("org_id", "config_source_id", "commit_sha")
  WHERE "processed_at" IS NULL;
--> statement-breakpoint

-- The drain's claim query: oldest pending first, per org.
CREATE INDEX IF NOT EXISTS "config_source_sync_queue_pending"
  ON "config_source_sync_queue" ("org_id", "enqueued_at")
  WHERE "processed_at" IS NULL;
