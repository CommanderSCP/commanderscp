-- M1 Graph Core (DESIGN.md §4.1-§4.3, §7, §8): full object_types/relationship_types/objects/
-- relationships graph model, RBAC (roles/role_bindings), hash-chained audit_events,
-- transactional outbox, and Idempotency-Key replay. Hand-authored (see drizzle/README note in
-- the M1 PR body: drizzle-kit's interactive rename-detection prompt for the `objects` table
-- (type -> type_id, name kept, new columns added) cannot run non-interactively in this
-- environment) but structurally identical to src/db/schema.ts — this is the source of truth.

CREATE TABLE IF NOT EXISTS "object_types" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" uuid,
	"display_name" text NOT NULL,
	"property_schema" jsonb,
	"is_builtin" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "relationship_types" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" uuid,
	"display_name" text NOT NULL,
	"property_schema" jsonb,
	"from_types" text[],
	"to_types" text[],
	"cardinality" text DEFAULT 'many_to_many' NOT NULL,
	"is_builtin" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "objects_v2" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"domain_id" uuid,
	"type_id" text NOT NULL,
	"name" text NOT NULL,
	"urn" text NOT NULL,
	"properties" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"labels" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"origin_domain_id" uuid NOT NULL,
	"revision" bigint DEFAULT 1 NOT NULL,
	"content_hash" text NOT NULL,
	"version" bigint DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "objects_org_id_urn_key" UNIQUE("org_id","urn")
);
--> statement-breakpoint
-- The M0 `objects` table (id/org_id/type/name/created_at) is superseded by the full graph model.
-- Rename it out of the way rather than dropping (M0's only consumer, /objects/service, is
-- reimplemented on the new substrate in this same milestone; nothing else reads the old table).
ALTER TABLE "objects" RENAME TO "objects_m0_deprecated";
--> statement-breakpoint
ALTER TABLE "objects_v2" RENAME TO "objects";
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "relationships" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"type_id" text NOT NULL,
	"from_id" uuid NOT NULL,
	"to_id" uuid NOT NULL,
	"properties" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"origin_domain_id" uuid NOT NULL,
	"revision" bigint DEFAULT 1 NOT NULL,
	"content_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "relationships_org_type_from_to_key" UNIQUE("org_id","type_id","from_id","to_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "roles" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid,
	"name" text NOT NULL,
	"permissions" text[] NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "role_bindings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"subject_id" uuid NOT NULL,
	"role_id" uuid NOT NULL,
	"scope_object_id" uuid NOT NULL,
	"effect" text DEFAULT 'allow' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "audit_events" (
	"seq" bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"domain_id" uuid,
	"actor_id" uuid NOT NULL,
	"action" text NOT NULL,
	"subject_id" uuid,
	"before_hash" text,
	"after_hash" text,
	"reason" text,
	"decision_id" uuid,
	"request_id" text NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"prev_hash" text NOT NULL,
	"row_hash" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "outbox" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"type" text NOT NULL,
	"source" text NOT NULL,
	"subject" text,
	"data" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "idempotency_keys" (
	"org_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"route" text NOT NULL,
	"request_hash" text NOT NULL,
	"response_status" bigint NOT NULL,
	"response_body" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "object_id" uuid;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "objects" ADD CONSTRAINT "objects_type_id_object_types_id_fk" FOREIGN KEY ("type_id") REFERENCES "public"."object_types"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "relationships" ADD CONSTRAINT "relationships_type_id_relationship_types_id_fk" FOREIGN KEY ("type_id") REFERENCES "public"."relationship_types"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "relationships" ADD CONSTRAINT "relationships_from_id_objects_id_fk" FOREIGN KEY ("from_id") REFERENCES "public"."objects"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "relationships" ADD CONSTRAINT "relationships_to_id_objects_id_fk" FOREIGN KEY ("to_id") REFERENCES "public"."objects"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "role_bindings" ADD CONSTRAINT "role_bindings_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "role_bindings" ADD CONSTRAINT "role_bindings_scope_object_id_objects_id_fk" FOREIGN KEY ("scope_object_id") REFERENCES "public"."objects"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "obj_type" ON "objects" USING btree ("org_id","type_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "obj_domain" ON "objects" USING btree ("org_id","domain_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "obj_created_cursor" ON "objects" USING btree ("org_id","created_at","id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "obj_props" ON "objects" USING gin ("properties" jsonb_path_ops);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "obj_labels" ON "objects" USING gin ("labels" jsonb_path_ops);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rel_fwd" ON "relationships" USING btree ("org_id","from_id","type_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rel_rev" ON "relationships" USING btree ("org_id","to_id","type_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rel_created_cursor" ON "relationships" USING btree ("org_id","created_at","id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "role_bindings_subject" ON "role_bindings" USING btree ("org_id","subject_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "role_bindings_scope" ON "role_bindings" USING btree ("org_id","scope_object_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_events_org_chain" ON "audit_events" USING btree ("org_id","occurred_at","id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_events_org_seq" ON "audit_events" USING btree ("org_id","seq");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "outbox_unprocessed" ON "outbox" USING btree ("processed_at","created_at");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idempotency_keys_pk" ON "idempotency_keys" USING btree ("org_id","idempotency_key");
