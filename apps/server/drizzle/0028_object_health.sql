-- ===========================================================================================
-- Observe-enrichment signal 4 — latest OBJECT HEALTH (ADR-0008 decision 4; docs/proposals/
-- observe-enrichment.md signal 4).
--
-- Graph-native (charter principle 2): an object-referencing PROJECTION table keyed by objects(id)
-- (DESIGN §4.1 "thin projection tables that reference their graph object"), the SAME class as
-- `changes.object_id`, `freezes.scope_object_id` and `executor_observe_cursors` — NOT a new
-- top-level concept/registry table. It projects the hot latest-health state of an EXISTING object.
--
-- INVARIANT (coordinate-not-execute, principle 1): SCP never probes/polls/computes health. This
-- row is written ONLY by a PUSH-IN (owner PUT today; a future opt-in health-source binding writes
-- the SAME row via `source`). One latest row per (org, object), UPSERT-IN-PLACE — no DELETE route
-- exists (grant omits DELETE), mirroring `executor_observe_cursors` (0017). Per-observation
-- history is a deferred non-goal (ADR-0008). Hand-authored (RLS is never expressible in
-- drizzle-kit's schema diffing — same convention as 0007/0014/0017).

CREATE TABLE IF NOT EXISTS "object_health" (
  "org_id" uuid NOT NULL,
  "object_id" uuid NOT NULL REFERENCES objects(id),
  "status" text NOT NULL,
  "detail" text,
  "observed_at" timestamp with time zone NOT NULL,
  "source" text,
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "object_health_pk" PRIMARY KEY ("org_id","object_id")
);
--> statement-breakpoint

-- Upsert-in-place only (the latest-health row is overwritten each push; no DELETE route exists),
-- matching the executor_observe_cursors grant convention from 0017.
GRANT SELECT, INSERT, UPDATE ON object_health TO scp_app;
--> statement-breakpoint

ALTER TABLE object_health ENABLE ROW LEVEL SECURITY;
ALTER TABLE object_health FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON object_health;
CREATE POLICY org_isolation ON object_health
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
