CREATE TABLE "instance_audit_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"seq" bigint NOT NULL,
	"action" text NOT NULL,
	"actor" jsonb NOT NULL,
	"subject" text,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"request_id" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"prev_hash" text NOT NULL,
	"row_hash" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "instance_operator_grants" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"granted_by" jsonb NOT NULL,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by" jsonb
);
--> statement-breakpoint
ALTER TABLE "instance_operator_credentials" ADD COLUMN "scope" text DEFAULT 'full' NOT NULL;--> statement-breakpoint
ALTER TABLE "stack_backends" ADD COLUMN "purge_generation" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "stack_backends" ADD COLUMN "last_good_sha256" text;--> statement-breakpoint
ALTER TABLE "stack_backends" ADD COLUMN "inventory_sha256" text;--> statement-breakpoint
ALTER TABLE "stack_settings" ADD COLUMN "controller_credential_id" uuid;--> statement-breakpoint
CREATE UNIQUE INDEX "instance_audit_events_seq_uq" ON "instance_audit_events" USING btree ("seq");--> statement-breakpoint
CREATE UNIQUE INDEX "instance_operator_grants_live_uq" ON "instance_operator_grants" USING btree ("org_id","user_id") WHERE "instance_operator_grants"."revoked_at" IS NULL;--> statement-breakpoint
ALTER TABLE "instance_operator_credentials" ADD CONSTRAINT "instance_operator_credentials_scope_ck" CHECK ("instance_operator_credentials"."scope" IN ('full', 'stack-controller'));
--> statement-breakpoint

-- ===========================================================================================
-- M29.4 review round (ADR-0058) — hand-appended grants and RLS.
--
-- instance_operator_grants: the instance-operator role, granted to users. TENANT-READ of the
-- caller's OWN org only (a session asks "do I hold it" inside its tenant tx), OPERATOR-WRITE. No
-- tenant role writes it: an OrgAdmin must never be able to confer authority over every org.
--
-- instance_audit_events: APPEND-ONLY. scp_operator gets SELECT + INSERT and a policy for exactly
-- those two commands; nothing gets UPDATE or DELETE, so a link once written cannot be rewritten
-- through any role the server holds. scp_app gets nothing at all.
-- ===========================================================================================
GRANT SELECT ON instance_operator_grants TO scp_app;
--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE ON instance_operator_grants FROM scp_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON instance_operator_grants TO scp_operator;
--> statement-breakpoint
ALTER TABLE instance_operator_grants ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE instance_operator_grants FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_read ON instance_operator_grants FOR SELECT
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY operator_write ON instance_operator_grants
  FOR ALL TO scp_operator USING (true) WITH CHECK (true);
--> statement-breakpoint
REVOKE ALL ON instance_audit_events FROM scp_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON instance_audit_events TO scp_operator;
--> statement-breakpoint
ALTER TABLE instance_audit_events ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE instance_audit_events FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY operator_read ON instance_audit_events FOR SELECT TO scp_operator USING (true);
--> statement-breakpoint
CREATE POLICY operator_append ON instance_audit_events FOR INSERT TO scp_operator WITH CHECK (true);