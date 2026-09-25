CREATE TABLE "stack_backend_registrations" (
	"org_id" uuid NOT NULL,
	"backend" text NOT NULL,
	"object_id" uuid NOT NULL,
	"registered_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stack_backend_registrations_pkey" PRIMARY KEY("org_id","backend"),
	CONSTRAINT "stack_backend_registrations_backend_ck" CHECK ("stack_backend_registrations"."backend" IN ('argocd', 'argo-workflows', 'argo-events', 'gitea'))
);
--> statement-breakpoint
CREATE TABLE "stack_backend_tokens" (
	"backend" text PRIMARY KEY NOT NULL,
	"ciphertext" text NOT NULL,
	"nonce" text NOT NULL,
	"key_version" integer NOT NULL,
	"minted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stack_backend_tokens_backend_ck" CHECK ("stack_backend_tokens"."backend" IN ('argocd', 'argo-workflows', 'argo-events', 'gitea'))
);
--> statement-breakpoint
CREATE TABLE "stack_backend_wirings" (
	"backend" text PRIMARY KEY NOT NULL,
	"server_url" text,
	"namespace" text,
	"ca_pem" text,
	"ca_sha256" text,
	"account" text,
	"facts_sha256" text NOT NULL,
	"rotation_generation" integer DEFAULT 0 NOT NULL,
	"wired_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stack_backend_wirings_backend_ck" CHECK ("stack_backend_wirings"."backend" IN ('argocd', 'argo-workflows', 'argo-events', 'gitea'))
);
--> statement-breakpoint
CREATE TABLE "stack_served_orgs" (
	"org_id" uuid PRIMARY KEY NOT NULL,
	"attached_by" jsonb NOT NULL,
	"attached_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "stack_backends" ADD COLUMN "rotate_generation" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "stack_settings" ADD COLUMN "served_orgs_initialized" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "stack_backend_registrations" ADD CONSTRAINT "stack_backend_registrations_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stack_served_orgs" ADD CONSTRAINT "stack_served_orgs_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "stack_backend_registrations_object_uq" ON "stack_backend_registrations" USING btree ("object_id");
--> statement-breakpoint

-- ===========================================================================================
-- M29.2 (ADR-0061) — hand-appended: grants and RLS, which drizzle-kit cannot express.
--
-- All four tables are INSTANCE-TIER and OPERATOR-WRITE: the stack controller's wiring hand-off and
-- the stack's registrations are written only through scp_operator (the controller's credential for
-- wirings and tokens; an instance operator for served orgs). scp_app — every tenant request — holds
-- SELECT only, and the policies bound what a tenant tx can read:
--   stack_backend_wirings        every row (the Stack page shows endpoints; nothing secret here);
--   stack_backend_tokens         ONLY from an org the stack serves — the resolver reads the token
--                                inside the served org's own tenant tx, and no other org's can;
--   stack_served_orgs            the caller's own org's row (is my org served?);
--   stack_backend_registrations  the caller's own org's rows (is this system stack-managed?).
-- A future migration that mistakenly re-granted scp_app a write still meets no policy.
-- ===========================================================================================
GRANT SELECT ON stack_backend_wirings, stack_backend_tokens, stack_served_orgs, stack_backend_registrations TO scp_app;
--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE ON stack_backend_wirings, stack_backend_tokens, stack_served_orgs, stack_backend_registrations FROM scp_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON stack_backend_wirings, stack_backend_tokens, stack_served_orgs, stack_backend_registrations TO scp_operator;
--> statement-breakpoint
-- The served-org doors name organizations (and serve the bootstrap one by default by NAME), so the
-- operator connection reads an org's id and name — those two columns, nothing else of any org.
GRANT SELECT (id, name) ON orgs TO scp_operator;
--> statement-breakpoint
ALTER TABLE stack_backend_wirings ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE stack_backend_wirings FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE stack_backend_tokens ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE stack_backend_tokens FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE stack_served_orgs ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE stack_served_orgs FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE stack_backend_registrations ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE stack_backend_registrations FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_read ON stack_backend_wirings FOR SELECT USING (true);
--> statement-breakpoint
CREATE POLICY tenant_read ON stack_served_orgs FOR SELECT
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY tenant_read ON stack_backend_tokens FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM stack_served_orgs s
     WHERE s.org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid));
--> statement-breakpoint
CREATE POLICY tenant_read ON stack_backend_registrations FOR SELECT
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY operator_write ON stack_backend_wirings
  FOR ALL TO scp_operator USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY operator_write ON stack_backend_tokens
  FOR ALL TO scp_operator USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY operator_write ON stack_served_orgs
  FOR ALL TO scp_operator USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY operator_write ON stack_backend_registrations
  FOR ALL TO scp_operator USING (true) WITH CHECK (true);