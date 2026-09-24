CREATE TABLE "ops_run_redemptions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"change_object_id" uuid NOT NULL,
	"wave_target_id" uuid NOT NULL,
	"domain_id" uuid NOT NULL,
	"authority_id" uuid NOT NULL,
	"role" text NOT NULL,
	"inventory" text NOT NULL,
	"egress_allowlist" text[] NOT NULL,
	"principals" text[] NOT NULL,
	"role_arguments" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"source_address" text,
	"secret_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"redeemed_at" timestamp with time zone,
	"issued_serial" text,
	"failed_attempts" integer DEFAULT 0 NOT NULL,
	"burned_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ops_run_redemptions_redeemed_has_serial" CHECK (("ops_run_redemptions"."redeemed_at" IS NULL) = ("ops_run_redemptions"."issued_serial" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "ssh_certificate_issuances" ADD COLUMN "source_address" text;--> statement-breakpoint
CREATE INDEX "ops_run_redemptions_org_change_idx" ON "ops_run_redemptions" USING btree ("org_id","change_object_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ops_run_redemptions_org_serial_uq" ON "ops_run_redemptions" USING btree ("org_id","issued_serial");--> statement-breakpoint
-- M28.2 (ADR-0054). SELECT/INSERT for reconcile minting a redemption, UPDATE for the redeem door
-- (redeemed_at / issued_serial / failed_attempts / burned_at). NO DELETE: a redemption is evidence
-- of a credential SCP was prepared to issue, and removing it would make an issued serial
-- unattributable to the run that asked for it.
GRANT SELECT, INSERT, UPDATE ON ops_run_redemptions TO scp_app;--> statement-breakpoint
ALTER TABLE ops_run_redemptions ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS org_isolation ON ops_run_redemptions;--> statement-breakpoint
CREATE POLICY org_isolation ON ops_run_redemptions
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
