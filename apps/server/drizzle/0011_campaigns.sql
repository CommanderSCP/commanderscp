-- M5 Campaigns & Initiatives (BUILD_AND_TEST.md §8 M5, DESIGN.md §9.5). Hand-authored, same
-- reason and same pattern as 0002/0005/0007/0010: drizzle-kit's interactive column-provenance
-- prompt can't run non-interactively here, and RLS/grants/seed data are never expressible in its
-- schema diffing anyway.
--
-- KEY DESIGN DECISION (M5 principle — "no new engine machinery"): a Campaign is NOT given its own
-- transition-guarded state-machine row. `campaign`/`initiative` graph objects were already
-- pre-seeded as built-in types in 0002 §5, and the `coordinates` relationship type (campaign/
-- initiative -> change/campaign) already exists — nothing new needed there. What a campaign DOES
-- need, that the generic object model has no place for, is exactly what a change needed in 0007
-- §6: its own compiled plan -> waves -> wave_targets rows, over the SAME plan-compiler pure
-- function (`coordination/plan-compiler.ts`, unmodified, zero forking). `campaign_wave_targets`
-- differs from `change_wave_targets` in one way: a campaign wave target's "unit of work" is not a
-- direct executor trigger, it is an entire real M3 Change (`member_change_object_id`) — the
-- campaign reconciler (`coordination/campaign-reconcile.ts`) proposes one per wave target once
-- that wave's gate allows, and that Change then runs through the EXISTING, completely unmodified
-- change lifecycle/reconcile loop/governance gates. Campaign STATUS is a pure, derived aggregation
-- (`coordination/campaign-status.ts`) over these waves + member Change states — never a second
-- stored state machine — matching the DoD's own language ("campaign status AGGREGATES
-- correctly") and the initiative roll-up's "derived by traversal, not stored/duplicated state"
-- principle one level down.

-- ===========================================================================================
-- 1. `campaign_plans` / `campaign_waves` / `campaign_wave_targets` — mirrors 0007 §6's
--    `change_plans`/`change_waves`/`change_wave_targets` shape exactly (see db/schema.ts's doc
--    comments), keyed by `campaign_object_id` instead of `change_object_id`.
-- ===========================================================================================

CREATE TABLE IF NOT EXISTS "campaign_plans" (
  "id" uuid PRIMARY KEY NOT NULL,
  "org_id" uuid NOT NULL,
  "campaign_object_id" uuid NOT NULL,
  "topology_object_id" uuid,
  "topology_version" bigint,
  "topology_document" jsonb,
  "status" text DEFAULT 'active' NOT NULL, -- active|completed|aborted
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "campaign_plans_org_campaign" ON "campaign_plans" USING btree ("org_id","campaign_object_id");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "campaign_waves" (
  "id" uuid PRIMARY KEY NOT NULL,
  "org_id" uuid NOT NULL,
  "plan_id" uuid NOT NULL REFERENCES campaign_plans(id),
  "wave_index" bigint NOT NULL,
  "name" text,
  "requires_fan_in" boolean DEFAULT true NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL, -- pending|blocked|running|succeeded|failed|skipped
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "started_at" timestamp with time zone,
  "completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "campaign_waves_org_plan" ON "campaign_waves" USING btree ("org_id","plan_id","wave_index");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "campaign_wave_targets" (
  "id" uuid PRIMARY KEY NOT NULL,
  "org_id" uuid NOT NULL,
  "wave_id" uuid NOT NULL REFERENCES campaign_waves(id),
  "target_object_id" uuid NOT NULL,
  -- Set once the campaign reconciler proposes this target's member Change (real M3 Change, linked
  -- back to the campaign via a `coordinates` relationship) — DESIGN §9.5 / this milestone's spec:
  -- "Member changes are real Changes linked to the campaign via coordinates relationships."
  "member_change_object_id" uuid,
  "status" text DEFAULT 'pending' NOT NULL, -- pending|change_proposed|succeeded|failed
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "campaign_wave_targets_org_wave" ON "campaign_wave_targets" USING btree ("org_id","wave_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "campaign_wave_targets_org_target" ON "campaign_wave_targets" USING btree ("org_id","target_object_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "campaign_wave_targets_org_member_change" ON "campaign_wave_targets" USING btree ("org_id","member_change_object_id");
--> statement-breakpoint

-- ===========================================================================================
-- 2. Grants — tenant data, same treatment as 0007 §6/0010 §2: scp_app never gets DELETE
--    (append/update-only — nothing in this milestone hard-deletes campaign history).
-- ===========================================================================================

GRANT SELECT, INSERT, UPDATE ON campaign_plans, campaign_waves, campaign_wave_targets TO scp_app;

-- ===========================================================================================
-- 3. RLS — identical `org_isolation` shape as every other tenant table.
-- ===========================================================================================

ALTER TABLE campaign_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_plans FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON campaign_plans;
CREATE POLICY org_isolation ON campaign_plans
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

ALTER TABLE campaign_waves ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_waves FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON campaign_waves;
CREATE POLICY org_isolation ON campaign_waves
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

ALTER TABLE campaign_wave_targets ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_wave_targets FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON campaign_wave_targets;
CREATE POLICY org_isolation ON campaign_wave_targets
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

-- ===========================================================================================
-- 4. `campaign`/`initiative` document JSON Schemas (both pre-seeded built-in object types,
--    0002 §5) — enforced at write time by the existing Ajv property-validation path
--    (graph/property-validation.ts), same mechanism 0007 §9 used for `release-topology`.
--    `campaign.targets` mirrors a Change's own `targets` (0007's `proposeChange` stashes resolved
--    target object ids into `properties.targets` the same way — coordination/changes-repo.ts).
-- ===========================================================================================

UPDATE object_types SET property_schema = '{
  "type": "object",
  "required": ["targets"],
  "properties": {
    "targets": { "type": "array", "items": { "type": "string" }, "minItems": 1 },
    "description": { "type": "string" }
  }
}'::jsonb
WHERE id = 'campaign';

UPDATE object_types SET property_schema = '{
  "type": "object",
  "properties": {
    "description": { "type": "string" }
  }
}'::jsonb
WHERE id = 'initiative';
