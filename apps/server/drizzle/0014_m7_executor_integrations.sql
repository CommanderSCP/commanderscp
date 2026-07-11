-- M7 Real Executor Integrations (BUILD_AND_TEST.md §8 M7, DESIGN.md §11/§12). Hand-authored, same
-- reason and same pattern as 0002/0005/0007/0010: drizzle-kit's interactive column-provenance
-- prompt can't run non-interactively here, and RLS/grants are never expressible in its schema
-- diffing.

-- ===========================================================================================
-- 1. New tables — see db/schema.ts's doc comments for the design rationale on each.
-- ===========================================================================================

CREATE TABLE IF NOT EXISTS "secrets" (
  "id" uuid PRIMARY KEY NOT NULL,
  "org_id" uuid NOT NULL,
  "key" text NOT NULL,
  "ciphertext" text NOT NULL,
  "nonce" text NOT NULL,
  "key_version" integer DEFAULT 1 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "secrets_org_key" ON "secrets" USING btree ("org_id","key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "secrets_org" ON "secrets" USING btree ("org_id");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "executor_bindings" (
  "id" uuid PRIMARY KEY NOT NULL,
  "org_id" uuid NOT NULL,
  "target_object_id" uuid NOT NULL,
  "plugin_module" text NOT NULL,
  "plugin_instance_id" text NOT NULL,
  "config" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "secret_refs" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "allowed_hosts" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "executor_bindings_org_target_key" ON "executor_bindings" USING btree ("org_id","target_object_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "executor_bindings_org" ON "executor_bindings" USING btree ("org_id");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "notification_bindings" (
  "id" uuid PRIMARY KEY NOT NULL,
  "org_id" uuid NOT NULL,
  "plugin_module" text NOT NULL,
  "plugin_instance_id" text NOT NULL,
  "config" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "secret_refs" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "allowed_hosts" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "min_severity" text DEFAULT 'info' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "notification_bindings_org_instance_key" ON "notification_bindings" USING btree ("org_id","plugin_instance_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notification_bindings_org" ON "notification_bindings" USING btree ("org_id");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "change_source_webhook_secrets" (
  "id" uuid PRIMARY KEY NOT NULL,
  "org_id" uuid NOT NULL,
  "source_kind" text NOT NULL,
  "secret_key" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "change_source_webhook_secrets_org_source_key" ON "change_source_webhook_secrets" USING btree ("org_id","source_kind");
--> statement-breakpoint

-- ===========================================================================================
-- 2. Grants. `executor_bindings`/`change_source_webhook_secrets` follow the append/update-only
--    convention every other milestone's tenant tables use (no DELETE route exists for either —
--    both are upserted in place). `secrets` and `notification_bindings` are a deliberate
--    EXCEPTION: routes/executors.ts exposes real DELETE endpoints for both (an operator rotating
--    off a compromised credential, or removing a stale notification channel, needs an actual
--    delete, not just "overwrite with something else") — caught by the M7 golden-path E2E
--    (scripts/e2e-m7.sh) attempting `scp secret delete` against a real deployment and getting a
--    live "permission denied for table secrets" from Postgres before this grant was added.
-- ===========================================================================================

GRANT SELECT, INSERT, UPDATE ON
  executor_bindings, change_source_webhook_secrets
TO scp_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON
  secrets, notification_bindings
TO scp_app;

-- ===========================================================================================
-- 3. RLS — identical `org_isolation` shape as every other tenant table. Unlike `instance_keys`
--    (M4/M6 — plaintext, no RLS, a deliberate narrow exception), `secrets` gets full RLS: it is a
--    general-purpose, multi-tenant credential store, not a single per-org signing keypair.
-- ===========================================================================================

ALTER TABLE secrets ENABLE ROW LEVEL SECURITY;
ALTER TABLE secrets FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON secrets;
CREATE POLICY org_isolation ON secrets
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

ALTER TABLE executor_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE executor_bindings FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON executor_bindings;
CREATE POLICY org_isolation ON executor_bindings
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

ALTER TABLE notification_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_bindings FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON notification_bindings;
CREATE POLICY org_isolation ON notification_bindings
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

ALTER TABLE change_source_webhook_secrets ENABLE ROW LEVEL SECURITY;
ALTER TABLE change_source_webhook_secrets FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON change_source_webhook_secrets;
CREATE POLICY org_isolation ON change_source_webhook_secrets
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
