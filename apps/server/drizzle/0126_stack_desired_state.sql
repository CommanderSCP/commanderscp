CREATE TABLE "stack_backends" (
	"backend" text PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"size_tier" text DEFAULT 'small' NOT NULL,
	"spec_updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"phase" text,
	"running_version" text,
	"target_version" text,
	"last_error" text,
	"needs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"detail" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status_observed_at" timestamp with time zone,
	CONSTRAINT "stack_backends_backend_ck" CHECK ("stack_backends"."backend" IN ('argocd', 'argo-workflows', 'argo-rollouts', 'argo-events', 'gitea')),
	CONSTRAINT "stack_backends_size_tier_ck" CHECK ("stack_backends"."size_tier" IN ('small', 'medium', 'large'))
);
--> statement-breakpoint
CREATE TABLE "stack_settings" (
	"id" text PRIMARY KEY DEFAULT 'instance' NOT NULL,
	"update_policy" text DEFAULT 'automatic' NOT NULL,
	"upgrade_generation" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"controller_release" text,
	"controller_observed_upgrade_generation" integer,
	"controller_seen_at" timestamp with time zone,
	CONSTRAINT "stack_settings_singleton_ck" CHECK ("stack_settings"."id" = 'instance'),
	CONSTRAINT "stack_settings_update_policy_ck" CHECK ("stack_settings"."update_policy" IN ('automatic', 'manual')),
	CONSTRAINT "stack_settings_upgrade_generation_ck" CHECK ("stack_settings"."upgrade_generation" >= 0)
);
--> statement-breakpoint

-- ===========================================================================================
-- M29.4 (ADR-0058, E2) — hand-appended: grants and RLS, which drizzle-kit cannot express.
--
-- Both tables are INSTANCE-TIER operator configuration: TENANT-READ, OPERATOR-WRITE, the same
-- two barriers as scanner_assignments (0035) and its operator half (0076). The spec columns of
-- stack_backends are what the near-cluster-admin stack controller acts on, so this is the table a
-- tenant must never be able to write, however privileged inside its own org.
--   1. GRANT: scp_app gets SELECT only; INSERT/UPDATE/DELETE explicitly revoked.
--   2. RLS: FORCE, one FOR SELECT policy for everyone and one FOR ALL policy TO scp_operator.
--      A future migration that mistakenly re-granted scp_app a write still meets no policy.
-- The controller's STATUS columns are written through the same operator connection (it presents
-- an operator credential), so the request-serving role cannot forge a "ready" either.
-- ===========================================================================================
GRANT SELECT ON stack_backends, stack_settings TO scp_app;
--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE ON stack_backends, stack_settings FROM scp_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON stack_backends, stack_settings TO scp_operator;
--> statement-breakpoint
ALTER TABLE stack_backends ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE stack_backends FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE stack_settings ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE stack_settings FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_read ON stack_backends FOR SELECT USING (true);
--> statement-breakpoint
CREATE POLICY tenant_read ON stack_settings FOR SELECT USING (true);
--> statement-breakpoint
CREATE POLICY operator_write ON stack_backends
  FOR ALL TO scp_operator USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY operator_write ON stack_settings
  FOR ALL TO scp_operator USING (true) WITH CHECK (true);
--> statement-breakpoint
-- The singleton exists from the start, so the upgrade-generation bump is a plain UPDATE and the
-- controller's heartbeat never races an INSERT.
INSERT INTO stack_settings (id) VALUES ('instance') ON CONFLICT (id) DO NOTHING;
