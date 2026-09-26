CREATE SEQUENCE "public"."stack_credential_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE TABLE "stack_credentials" (
	"backend" text NOT NULL,
	"secret_name" text NOT NULL,
	"key" text NOT NULL,
	"state" text NOT NULL,
	"pending_op" text,
	"delivery_id" uuid,
	"seq" bigint,
	"sealed_to" text,
	"not_after" timestamp with time zone,
	"envelope" jsonb,
	"requested_by" jsonb,
	"requested_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"last_error" text,
	CONSTRAINT "stack_credentials_pkey" PRIMARY KEY("backend","secret_name","key"),
	CONSTRAINT "stack_credentials_state_ck" CHECK ("stack_credentials"."state" IN ('pending', 'set', 'failed', 'unset')),
	CONSTRAINT "stack_credentials_pending_ck" CHECK (("stack_credentials"."state" = 'pending') = ("stack_credentials"."pending_op" IS NOT NULL AND "stack_credentials"."envelope" IS NOT NULL)),
	CONSTRAINT "stack_credentials_op_ck" CHECK ("stack_credentials"."pending_op" IS NULL OR "stack_credentials"."pending_op" IN ('set', 'delete'))
);
--> statement-breakpoint
CREATE TABLE "stack_workload_identities" (
	"backend" text NOT NULL,
	"service_account" text NOT NULL,
	"provider" text NOT NULL,
	"identifier" text NOT NULL,
	"declared_by" jsonb NOT NULL,
	"declared_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stack_workload_identities_pkey" PRIMARY KEY("backend","service_account"),
	CONSTRAINT "stack_workload_identities_provider_ck" CHECK ("stack_workload_identities"."provider" IN ('aws-irsa', 'gke-workload-identity', 'azure-workload-identity'))
);
--> statement-breakpoint
ALTER TABLE "stack_settings" ADD COLUMN "credential_sealing_key" text;--> statement-breakpoint
ALTER TABLE "stack_settings" ADD COLUMN "credential_sealing_key_sha256" text;--> statement-breakpoint
ALTER TABLE "stack_settings" ADD COLUMN "credential_sealing_key_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "stack_credentials_delivery_uq" ON "stack_credentials" USING btree ("delivery_id");
--> statement-breakpoint

-- ===========================================================================================
-- M29.5 (ADR-0063) — hand-appended: grants and RLS, which drizzle-kit cannot express.
--
-- stack_credentials holds SEALED envelopes (never a value) and who asked for them. It is read and
-- written ONLY through scp_operator — the instance-authority doors and the stack controller's
-- credential. scp_app, every tenant request, gets NO grant at all: not even a sealed envelope is
-- readable from a tenant transaction, and a future re-grant still meets FORCE RLS with no tenant
-- policy.
--
-- stack_workload_identities is what the controller renders into ServiceAccount annotations; the
-- spec read goes through the request pool, so scp_app reads it (tenant_read USING (true), as
-- stack_backends does). Every write is scp_operator's.
--
-- The delivery sequence is advanced only by scp_operator.
-- ===========================================================================================
REVOKE ALL ON stack_credentials FROM scp_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON stack_credentials TO scp_operator;
--> statement-breakpoint
REVOKE ALL ON SEQUENCE stack_credential_seq FROM scp_app;
--> statement-breakpoint
GRANT USAGE, SELECT ON SEQUENCE stack_credential_seq TO scp_operator;
--> statement-breakpoint
GRANT SELECT ON stack_workload_identities TO scp_app;
--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE ON stack_workload_identities FROM scp_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON stack_workload_identities TO scp_operator;
--> statement-breakpoint
ALTER TABLE stack_credentials ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE stack_credentials FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE stack_workload_identities ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE stack_workload_identities FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY operator_write ON stack_credentials
  FOR ALL TO scp_operator USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY tenant_read ON stack_workload_identities FOR SELECT USING (true);
--> statement-breakpoint
CREATE POLICY operator_write ON stack_workload_identities
  FOR ALL TO scp_operator USING (true) WITH CHECK (true);