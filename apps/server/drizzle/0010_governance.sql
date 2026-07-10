-- M4 Governance Engine (BUILD_AND_TEST.md §8 M4, DESIGN.md §10). Hand-authored, same reason and
-- same pattern as 0002/0005/0007: drizzle-kit's interactive column-provenance prompt can't run
-- non-interactively here, and RLS/grants/seed data are never expressible in its schema diffing.

-- ===========================================================================================
-- 1. New tables — see db/schema.ts's doc comments for the design rationale on each.
-- ===========================================================================================

CREATE TABLE IF NOT EXISTS "control_bindings" (
  "id" uuid PRIMARY KEY NOT NULL,
  "org_id" uuid NOT NULL,
  "control_object_id" uuid NOT NULL,
  "plugin_module" text NOT NULL,
  "plugin_instance_id" text NOT NULL,
  "config" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "control_bindings_org_control_key" ON "control_bindings" USING btree ("org_id","control_object_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "control_bindings_org" ON "control_bindings" USING btree ("org_id");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "control_runs" (
  "id" uuid PRIMARY KEY NOT NULL,
  "org_id" uuid NOT NULL,
  "control_object_id" uuid NOT NULL,
  "change_object_id" uuid NOT NULL,
  "gate_kind" text NOT NULL,
  "gate_ref" jsonb NOT NULL,
  "status" text NOT NULL,
  "evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "detail" text,
  "decision_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "control_runs_org_change" ON "control_runs" USING btree ("org_id","change_object_id","created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "control_runs_org_control" ON "control_runs" USING btree ("org_id","control_object_id");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "approval_requests" (
  "id" uuid PRIMARY KEY NOT NULL,
  "org_id" uuid NOT NULL,
  "change_object_id" uuid NOT NULL,
  "policy_object_id" uuid NOT NULL,
  "policy_version" bigint NOT NULL,
  "effect_index" bigint NOT NULL,
  "required_count" bigint NOT NULL,
  "from_role" text NOT NULL,
  "scope_object_id" uuid NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "satisfied_at" timestamp with time zone,
  "satisfied_decision_id" uuid
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "approval_requests_dedup_key" ON "approval_requests" USING btree ("org_id","change_object_id","policy_object_id","policy_version","effect_index");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "approval_requests_org_change" ON "approval_requests" USING btree ("org_id","change_object_id");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "approval_votes" (
  "id" uuid PRIMARY KEY NOT NULL,
  "org_id" uuid NOT NULL,
  "approval_request_id" uuid NOT NULL,
  "voter_object_id" uuid NOT NULL,
  "decision_id" uuid,
  "attestation" jsonb NOT NULL,
  "voted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "approval_votes_no_double_vote" ON "approval_votes" USING btree ("org_id","approval_request_id","voter_object_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "approval_votes_org_request" ON "approval_votes" USING btree ("org_id","approval_request_id");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "freezes" (
  "id" uuid PRIMARY KEY NOT NULL,
  "org_id" uuid NOT NULL,
  "scope_object_id" uuid NOT NULL,
  "name" text,
  "starts_at" timestamp with time zone NOT NULL,
  "ends_at" timestamp with time zone NOT NULL,
  "reason" text NOT NULL,
  "created_by_actor_id" uuid NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "freezes_org_scope" ON "freezes" USING btree ("org_id","scope_object_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "freezes_org_window" ON "freezes" USING btree ("org_id","starts_at","ends_at");
--> statement-breakpoint

-- Singleton instance-wide Ed25519 keypair (db/schema.ts's doc comment) — no org_id, no RLS,
-- same treatment as `state_transitions` (global, not tenant data).
CREATE TABLE IF NOT EXISTS "instance_keys" (
  "id" uuid PRIMARY KEY NOT NULL,
  "public_key" text NOT NULL,
  "private_key" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

-- ===========================================================================================
-- 2. Grants — every new table is tenant data except `instance_keys` (global, like
--    `state_transitions`); `scp_app` never gets DELETE (append/update-only, same as every other
--    M3 tenant table — nothing in this milestone hard-deletes governance history).
-- ===========================================================================================

GRANT SELECT, INSERT, UPDATE ON
  control_bindings, control_runs, approval_requests, approval_votes, freezes
TO scp_app;
GRANT SELECT, INSERT ON instance_keys TO scp_app;

-- ===========================================================================================
-- 3. RLS — identical `org_isolation` shape as every other tenant table.
-- ===========================================================================================

ALTER TABLE control_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE control_bindings FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON control_bindings;
CREATE POLICY org_isolation ON control_bindings
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

ALTER TABLE control_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE control_runs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON control_runs;
CREATE POLICY org_isolation ON control_runs
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

ALTER TABLE approval_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE approval_requests FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON approval_requests;
CREATE POLICY org_isolation ON approval_requests
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

ALTER TABLE approval_votes ENABLE ROW LEVEL SECURITY;
ALTER TABLE approval_votes FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON approval_votes;
CREATE POLICY org_isolation ON approval_votes
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

ALTER TABLE freezes ENABLE ROW LEVEL SECURITY;
ALTER TABLE freezes FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON freezes;
CREATE POLICY org_isolation ON freezes
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

-- ===========================================================================================
-- 4. New permissions on the built-in roles (DESIGN §7's example names these exactly:
--    'policy:write', 'freeze:override'). Additive ALTER — existing role rows keep every
--    permission they already had; 0002's roles are re-targeted by name since their ids are
--    `gen_random_uuid()`-generated at seed time, not fixed constants.
--
--    - Approver already has 'approval:write' (0002 §7) — reused here for casting an approval
--      vote; DESIGN's N-of-M-quorum eligibility is enforced by role MEMBERSHIP at the vote's
--      scope (authz/resolve.ts `hasRoleAtScope`), not by this coarse permission alone.
--    - Administrator gains 'policy:write' (create/edit Policy + Control objects, create Freezes)
--      — the natural home for governance authoring alongside its existing type-registry/role
--      authority.
--    - Only Owner gains 'freeze:override' and 'change:emergency' — the two
--      highest-blast-radius bypass permissions (DESIGN §10.3), deliberately NOT granted to
--      Administrator by default.
-- ===========================================================================================

UPDATE roles SET permissions = array_append(permissions, 'policy:write')
WHERE org_id IS NULL AND name IN ('Administrator', 'Owner') AND NOT ('policy:write' = ANY(permissions));

UPDATE roles SET permissions = array_append(permissions, 'freeze:write')
WHERE org_id IS NULL AND name IN ('Administrator', 'Owner') AND NOT ('freeze:write' = ANY(permissions));

UPDATE roles SET permissions = array_append(permissions, 'freeze:override')
WHERE org_id IS NULL AND name = 'Owner' AND NOT ('freeze:override' = ANY(permissions));

UPDATE roles SET permissions = array_append(permissions, 'change:emergency')
WHERE org_id IS NULL AND name = 'Owner' AND NOT ('change:emergency' = ANY(permissions));

-- ===========================================================================================
-- 5. Policy/Control document JSON Schemas (DESIGN §10.1/§10.2) — enforced at write time by the
--    existing Ajv property-validation path (graph/property-validation.ts), same mechanism
--    0007 §9 used for `release-topology`'s `waves` document.
-- ===========================================================================================

UPDATE object_types SET property_schema = '{
  "type": "object",
  "required": ["enforcement"],
  "properties": {
    "scope": {
      "type": "object",
      "properties": {
        "selector": {
          "type": "object",
          "properties": { "labels": { "type": "object" } }
        },
        "objectRef": { "type": "string" },
        "group": { "type": "string" }
      }
    },
    "enforcement": { "type": "string", "enum": ["advisory", "recommended", "required"] },
    "condition": { "type": "string" },
    "effects": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "requireControls": { "type": "array", "items": { "type": "string" } },
          "requireApprovals": {
            "type": "object",
            "required": ["count", "fromRole"],
            "properties": {
              "count": { "type": "integer", "minimum": 1 },
              "fromRole": { "type": "string" },
              "scope": { "type": "string" }
            }
          }
        }
      }
    },
    "emergencyPolicy": { "type": "boolean" },
    "autoRollbackOnFailure": { "type": "boolean" }
  }
}'::jsonb
WHERE id = 'policy';

UPDATE object_types SET property_schema = '{
  "type": "object",
  "required": ["category"],
  "properties": {
    "category": { "type": "string", "enum": ["security", "quality", "operational", "compliance", "custom"] },
    "contract": { "type": "object" }
  }
}'::jsonb
WHERE id = 'control';
