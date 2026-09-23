-- `infrastructure_members` — the OBSERVED membership of an infrastructure product
-- (team-pipeline-iac D25(a), M27.6).
--
-- D25(a): "Inventory is derived from the product, never authored — which hosts comes from the
-- product's observed membership at execution time, deleting the TF-outputs→inventory-file sync
-- toil and its drift class outright." `scp-runner-ops` compiles its Ansible inventory from this
-- table, which is why a tenant `hosts` parameter has no path into a run: the runner reads a file
-- the server wrote from these rows, and the parameter marshaller refuses the `ansible_*` namespace
-- outright (M27.2).
--
-- A REPORT IS A SNAPSHOT, NOT A DELTA. The reporter sends the product's CURRENT full membership and
-- the server replaces what it held for that product. A delta protocol would let one dropped or
-- reordered message leave a host in the inventory that no longer exists — and for a host-reaching
-- runner that means SSHing at an address which may by then belong to someone else. Replacement
-- converges the stored set to the truth on every report rather than accumulating error.
--
-- IDENTITY IS THE PROVIDER'S ID, NOT THE ADDRESS. An instance keeps its id across a reboot that
-- changes its address, so `member_id` is the identity and `address` an attribute of it. Keyed the
-- other way round, one replaced address would read as a new host joining and the old one never
-- leaving.
--
-- The DDL below is drizzle-kit generated from schema.ts; the GRANTs and RLS policy after it are
-- hand-written, because drizzle emits neither.

CREATE TABLE "infrastructure_members" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"product_object_id" uuid NOT NULL,
	"member_id" text NOT NULL,
	"address" text NOT NULL,
	"reported_by_subject_id" uuid NOT NULL,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "infrastructure_members" ADD CONSTRAINT "infrastructure_members_product_object_id_objects_id_fk" FOREIGN KEY ("product_object_id") REFERENCES "public"."objects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "infrastructure_members_product_idx" ON "infrastructure_members" USING btree ("org_id","product_object_id");--> statement-breakpoint
CREATE UNIQUE INDEX "infrastructure_members_identity" ON "infrastructure_members" USING btree ("org_id","product_object_id","member_id");
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON infrastructure_members TO scp_app;--> statement-breakpoint
-- DELETE is granted, unlike `ssh_certificate_issuances`: this is current-state, not an evidence
-- log, and a snapshot report must be able to remove a member that has genuinely gone away.

ALTER TABLE infrastructure_members ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS org_isolation ON infrastructure_members;--> statement-breakpoint
CREATE POLICY org_isolation ON infrastructure_members
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
