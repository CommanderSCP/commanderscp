-- M2 stage 3: `@scp/iac` + server-side plan/apply (BUILD_AND_TEST.md §8 M2 item 4, DESIGN.md §15).
-- Hand-authored, structurally identical to src/db/schema.ts (same reason as 0001_graph_core.sql:
-- drizzle-kit's interactive column-provenance prompt can't run non-interactively in this
-- environment, and no per-migration snapshots have been committed since 0000 — see that file's
-- header) plus a hand-authored RLS block for the new `plans` table (same pattern as
-- 0002_rls_rbac_seed.sql §1-§2: `plans` is TENANT data, unlike the M2 stage 2 auth-substrate
-- tables in 0004_auth_expansion.sql, so it needs `FORCE ROW LEVEL SECURITY` + `org_isolation` +
-- grants, not the "no RLS" auth-substrate treatment).

-- ===========================================================================================
-- 1. `relationships.labels` — mirrors `objects.labels` so the `scp:managed-by`/`scp:stack` IaC
--    pruning convention (apps/server/src/iac/plan-diff.ts) applies uniformly to relationships,
--    not just objects (db/schema.ts doc comment on `relationships`). Existing rows default to
--    `{}`, identical in shape to how `objects.labels` was introduced in 0001.
-- ===========================================================================================

ALTER TABLE "relationships" ADD COLUMN IF NOT EXISTS "labels" jsonb DEFAULT '{}'::jsonb NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rel_labels" ON "relationships" USING gin ("labels" jsonb_path_ops);
--> statement-breakpoint

-- ===========================================================================================
-- 2. `plans` — a projection table for hot lifecycle state (DESIGN.md §4.1's "projection tables
--    for hot lifecycle state" paragraph): a plan's lifecycle (pending -> applied, or stale) needs
--    real columns/constraints, unlike M2 stage 1's typed registries (domains/services/teams/...)
--    which deliberately reused the generic objects/relationships substrate. `manifest`/`diff` are
--    kept verbatim (URN-keyed, per @scp/schemas' DesiredStateManifest/PlanDiff) rather than a
--    graph `object_id` FK, because a single plan touches many objects across many scopes, not one.
-- ===========================================================================================

CREATE TABLE IF NOT EXISTS "plans" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"actor_id" uuid NOT NULL,
	"stack_name" text NOT NULL,
	"manifest" jsonb NOT NULL,
	"diff" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"applied_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "plans_org_created" ON "plans" USING btree ("org_id","created_at","id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "plans_org_stack" ON "plans" USING btree ("org_id","stack_name");

-- ===========================================================================================
-- 3. Grants + RLS for `plans` (mirrors 0002 §1/§2 exactly — `plans` is tenant data like
--    objects/relationships, not auth substrate like orgs/users/personal_access_tokens).
-- ===========================================================================================

GRANT SELECT, INSERT, UPDATE ON plans TO scp_app;

ALTER TABLE plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE plans FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON plans;
CREATE POLICY org_isolation ON plans
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
