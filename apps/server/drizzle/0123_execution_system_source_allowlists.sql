CREATE TABLE "execution_system_source_allowlists" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"execution_system_object_id" uuid NOT NULL,
	"repos" text[] NOT NULL,
	"recorded_by_subject_id" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "execution_system_source_allowlists" ADD CONSTRAINT "execution_system_source_allowlists_execution_system_object_id_objects_id_fk" FOREIGN KEY ("execution_system_object_id") REFERENCES "public"."objects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "execution_system_source_allowlist_one_per_system" ON "execution_system_source_allowlists" USING btree ("org_id","execution_system_object_id");--> statement-breakpoint
-- M28.3 (ADR-0056 §7a, owner ruling R1). Written ONLY through the `secret:write`-at-org-root door:
-- SELECT/INSERT/UPDATE for the upsert. NO DELETE — an empty list is how nothing is allowed, and a row
-- that could be deleted and re-created would hide what a past run was allowed to run.
GRANT SELECT, INSERT, UPDATE ON execution_system_source_allowlists TO scp_app;--> statement-breakpoint
ALTER TABLE execution_system_source_allowlists ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS org_isolation ON execution_system_source_allowlists;--> statement-breakpoint
CREATE POLICY org_isolation ON execution_system_source_allowlists
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);