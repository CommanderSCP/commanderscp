CREATE TABLE "ssh_ca_argo_ops_pins" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"domain_id" uuid NOT NULL,
	"server_url" text NOT NULL,
	"namespace" text NOT NULL,
	"template_ref" text NOT NULL,
	"sealing_public_key" text NOT NULL,
	"source_addresses" text[] NOT NULL,
	"runner_image_digest" text NOT NULL,
	"redeem_url" text NOT NULL,
	"recorded_by_subject_id" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ssh_ca_argo_ops_pin_source_addresses_present" CHECK (cardinality("ssh_ca_argo_ops_pins"."source_addresses") > 0)
);
--> statement-breakpoint
ALTER TABLE "ops_run_redemptions" ADD COLUMN "certified_public_key" text;--> statement-breakpoint
CREATE UNIQUE INDEX "ssh_ca_argo_ops_pin_one_per_domain" ON "ssh_ca_argo_ops_pins" USING btree ("org_id","domain_id");--> statement-breakpoint
CREATE INDEX "ops_run_redemptions_org_target_idx" ON "ops_run_redemptions" USING btree ("org_id","wave_target_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "ops_run_redemptions_org_pubkey_uq" ON "ops_run_redemptions" USING btree ("org_id","certified_public_key");--> statement-breakpoint
-- M28.2 (ADR-0054 D9). The pin is written ONLY through the `secret:write`-at-org-root door (the
-- enrolment door's own permission): SELECT/INSERT/UPDATE for the upsert. NO DELETE: an unpinned
-- domain simply refuses every Argo host-ops run, and a pin that could be deleted and re-created
-- would hide which endpoint a past token was sealed for.
GRANT SELECT, INSERT, UPDATE ON ssh_ca_argo_ops_pins TO scp_app;--> statement-breakpoint
ALTER TABLE ssh_ca_argo_ops_pins ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS org_isolation ON ssh_ca_argo_ops_pins;--> statement-breakpoint
CREATE POLICY org_isolation ON ssh_ca_argo_ops_pins
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
