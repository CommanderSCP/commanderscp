ALTER TABLE "stack_settings" ADD COLUMN "authoring_revision" text;--> statement-breakpoint
ALTER TABLE "stack_settings" ADD COLUMN "authoring_clusters" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "stack_settings" ADD COLUMN "authoring_facts_sha256" text;--> statement-breakpoint
ALTER TABLE "stack_settings" ADD COLUMN "authoring_configured_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "stack_settings" ADD CONSTRAINT "stack_settings_authoring_revision_ck" CHECK ("stack_settings"."authoring_revision" IS NULL OR "stack_settings"."authoring_revision" ~ '^[0-9a-f]{40}$');

-- ===========================================================================================
-- M29.3 (ADR-0062) — hand-appended note, no statement needed: the four columns are on
-- stack_settings, whose grants (0126: scp_app SELECT only, scp_operator the writes) and FORCE RLS
-- policies are TABLE-level and already cover them. The canary-authoring hand-off is written only
-- through scp_operator, by the stack controller's credential (PUT/DELETE /instance/stack/authoring).
-- ===========================================================================================
