-- `continuous_probe_retractions` — THE RETRACTION SWEEP'S DURABLE HANDOFF.
--
-- ===========================================================================================
-- THE GAP THIS CLOSES
-- ===========================================================================================
-- `coordination/continuous-probe-driver.ts` declares every `continuous` hook's schedule to its
-- executor once per tick, and its module doc has claimed since the driver landed that "the schedule
-- is removed by the retraction sweep below rather than expiring". There was no such sweep. `removeSchedule` is implemented on the contract, routed by the plugin-host RPC, and
-- implemented by the Argo Workflows plugin and the test fake, and NOTHING in the server ever called
-- it: a hook the commander retracted (IaC prune, or a federation tombstone) lost its `pipeline_hooks`
-- row and stopped being declared, while the executor kept running the orphaned cron FOREVER.
--
-- ===========================================================================================
-- WHY A QUEUE AND NOT A CALL, which is `config_source_sync_queue`'s argument (drizzle/0109) again
-- ===========================================================================================
-- `deleteHook` runs inside a tenant transaction, and `removeSchedule` is an out-of-process RPC to
-- an executor that may be unreachable. Calling it there holds a DB connection open across an
-- external call, and a failure aborts the transaction the delete lives in — so a temporarily
-- unreachable executor would fail the whole IaC apply, or the whole federation import batch, over a
-- cron nobody was waiting on. Worse, a retraction that failed would be LOST: the row is gone, so
-- nothing knows to try again.
--
-- The delete therefore does the one cheap safe thing it can: RECORD that a schedule is owed a
-- retraction. The driver drains it on the next tick, outside that transaction, where the RPC is
-- legal and a failure is isolated to one row and retried.
--
-- ===========================================================================================
-- WHY `schedule_id` IS STORED RATHER THAN RE-DERIVED
-- ===========================================================================================
-- `probeScheduleId(componentObjectId, hookId)` is derived, never stored, precisely so every replica
-- computes the same id. But the retraction has to name the id that was ACTUALLY declared — if that
-- function's derivation is ever changed, re-deriving at drain time would retract an id the executor
-- never heard of and leave the real schedule running, silently, which is the exact failure this
-- table exists to end. So the id is frozen at delete time.
--
-- ===========================================================================================
-- NO `processed_at`: DRAINED ROWS ARE DELETED
-- ===========================================================================================
-- Unlike `config_source_sync_queue`, there is no status surface that reads this table and no
-- "displayed state" a retracted probe leaves behind — the whole fact is "this is owed, until it is
-- not". Rows are deleted on success, which is also what makes the identity index below a plain
-- UNIQUE rather than a partial one. `attempts`/`last_error` make a row that keeps failing visible
-- without turning it into a log.

CREATE TABLE IF NOT EXISTS "continuous_probe_retractions" (
  "id" uuid PRIMARY KEY,
  "org_id" uuid NOT NULL,
  -- DELIBERATELY NOT `REFERENCES objects(id)`, unlike most id columns here. A retraction must
  -- OUTLIVE the thing it is about: the component can be deleted in the same apply that pruned the
  -- hook, and an FK would then refuse the enqueue and take the orphaned schedule with it.
  "component_object_id" uuid NOT NULL,
  "hook_id" text NOT NULL,
  -- Frozen at delete time — see the header.
  "schedule_id" text NOT NULL,
  "enqueued_at" timestamp with time zone NOT NULL DEFAULT now(),
  "attempts" integer NOT NULL DEFAULT 0,
  "last_error" text
);
--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE ON continuous_probe_retractions TO scp_app;
--> statement-breakpoint
ALTER TABLE continuous_probe_retractions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE continuous_probe_retractions FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS org_isolation ON continuous_probe_retractions;
--> statement-breakpoint
CREATE POLICY org_isolation ON continuous_probe_retractions
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
--> statement-breakpoint

-- ONE outstanding retraction per (component, hook), and it doubles as the drain's per-org read
-- path. A hook deleted, re-created and deleted again while the first retraction is still pending
-- is the SAME work — `schedule_id` is derived from the same two inputs — so the second enqueue is
-- an `ON CONFLICT DO NOTHING`.
CREATE UNIQUE INDEX IF NOT EXISTS "continuous_probe_retractions_identity"
  ON "continuous_probe_retractions" ("org_id", "component_object_id", "hook_id");
