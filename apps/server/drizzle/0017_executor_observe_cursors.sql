-- M10.2 (BUILD_AND_TEST.md §8 M10 item 2): the observe()-driver watermark table. The pull-based
-- change-detection loop (coordination/observe.ts) stores one cursor per (org, executor plugin
-- instance) and passes it to ExecutorPlugin.observe(since). Bindings that share a plugin_instance_id
-- share observe scope (same configured source), so the cursor is instance-scoped, not binding-scoped.
-- Wired for connected-but-unwebhookable and air-gapped domains whose executors cannot reach SCP's
-- inbound webhook ingress. Hand-authored (RLS is never expressible in drizzle-kit's schema diffing —
-- same convention as 0007/0014).

CREATE TABLE IF NOT EXISTS "executor_observe_cursors" (
  "org_id" uuid NOT NULL,
  "plugin_instance_id" text NOT NULL,
  "cursor_token" text,
  "last_polled_at" timestamp with time zone,
  CONSTRAINT "executor_observe_cursors_pk" PRIMARY KEY ("org_id","plugin_instance_id")
);
--> statement-breakpoint

-- Upsert-in-place only (the cursor is overwritten each poll; no DELETE route exists), matching the
-- executor_bindings/change_source_webhook_secrets grant convention from 0014.
GRANT SELECT, INSERT, UPDATE ON executor_observe_cursors TO scp_app;
--> statement-breakpoint

ALTER TABLE executor_observe_cursors ENABLE ROW LEVEL SECURITY;
ALTER TABLE executor_observe_cursors FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON executor_observe_cursors;
CREATE POLICY org_isolation ON executor_observe_cursors
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
