-- M3 Change Coordination Engine (BUILD_AND_TEST.md §8 M3, DESIGN.md §9, §10.4). Hand-authored,
-- same reason and same pattern as 0001/0002/0005: drizzle-kit's interactive column-provenance
-- prompt can't run non-interactively here, and RLS/grants/seed data are never expressible in its
-- schema diffing anyway.

-- ===========================================================================================
-- 1. `changes` — the projection table (DESIGN §9.1), referencing its graph object (type
--    'change', already pre-seeded in 0002 §5).
-- ===========================================================================================

CREATE TABLE IF NOT EXISTS "changes" (
  "object_id" uuid PRIMARY KEY NOT NULL REFERENCES objects(id),
  "org_id" uuid NOT NULL,
  "state" text DEFAULT 'proposed' NOT NULL,
  "source_kind" text,
  "source_ref" jsonb,
  "correlation_key" text,
  "emergency" boolean DEFAULT false NOT NULL,
  "imported_from_domain" uuid,
  "topology_object_id" uuid,
  "topology_version" bigint,
  "rollback_of_object_id" uuid,
  "rollback_trigger_reason" text,
  "state_entered_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_heartbeat_at" timestamp with time zone DEFAULT now() NOT NULL,
  "watchdog_flagged_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "changes_org_state" ON "changes" USING btree ("org_id","state");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "changes_org_state_entered" ON "changes" USING btree ("org_id","state","state_entered_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "changes_rollback_of" ON "changes" USING btree ("org_id","rollback_of_object_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "changes_org_created" ON "changes" USING btree ("org_id","created_at","object_id");
--> statement-breakpoint

-- ===========================================================================================
-- 2. `state_transitions` — legal edges as DATA (DESIGN §9.1), mirrored exactly from
--    coordination/transitions.ts's `LEGAL_TRANSITIONS` constant (cross-checked by
--    coordination/transitions.integration.test.ts so the two never drift).
-- ===========================================================================================

CREATE TABLE IF NOT EXISTS "state_transitions" (
  "from_state" text NOT NULL,
  "to_state" text NOT NULL,
  "trigger" text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "state_transitions_pk" ON "state_transitions" USING btree ("from_state","to_state");
--> statement-breakpoint

INSERT INTO state_transitions (from_state, to_state, trigger) VALUES
  ('proposed',   'evaluated',   'evaluate'),
  ('proposed',   'cancelled',   'cancel'),
  ('evaluated',  'coordinated', 'coordinate'),
  ('evaluated',  'cancelled',   'cancel'),
  ('coordinated','executing',   'execute'),
  ('coordinated','cancelled',   'cancel'),
  ('executing',  'validating',  'validate'),
  ('executing',  'cancelled',   'cancel'),
  ('executing',  'rolled_back', 'rollback'),
  ('validating', 'promoted',    'promote'),
  ('validating', 'cancelled',   'cancel'),
  ('validating', 'rolled_back', 'rollback'),
  ('promoted',   'rolled_back', 'rollback')
ON CONFLICT DO NOTHING;
--> statement-breakpoint

-- ===========================================================================================
-- 3. `gate_bindings` — the M4 governance seam (BUILD_AND_TEST.md §8 M3 item 1). No rows are
--    written in M3; coordination/gates.ts always allows when none match.
-- ===========================================================================================

CREATE TABLE IF NOT EXISTS "gate_bindings" (
  "id" uuid PRIMARY KEY NOT NULL,
  "org_id" uuid NOT NULL,
  "scope_kind" text NOT NULL,
  "from_state" text,
  "to_state" text,
  "topology_object_id" uuid,
  "wave_index" bigint,
  "control_refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "enforcement" text DEFAULT 'required' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "gate_bindings_org_edge" ON "gate_bindings" USING btree ("org_id","from_state","to_state");
--> statement-breakpoint

-- ===========================================================================================
-- 4. `decisions` — DESIGN §10.4 exactly.
-- ===========================================================================================

CREATE TABLE IF NOT EXISTS "decisions" (
  "id" uuid PRIMARY KEY NOT NULL,
  "org_id" uuid NOT NULL,
  "kind" text NOT NULL,
  "subject_id" uuid NOT NULL,
  "verdict" text NOT NULL,
  "input_context" jsonb NOT NULL,
  "reason_tree" jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "decisions_org_subject" ON "decisions" USING btree ("org_id","subject_id","created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "decisions_org_created" ON "decisions" USING btree ("org_id","created_at","id");
--> statement-breakpoint

-- ===========================================================================================
-- 5. `source_mappings` + `change_source_events` — correlation + webhook ingress (DESIGN §8, §9.2).
-- ===========================================================================================

CREATE TABLE IF NOT EXISTS "source_mappings" (
  "id" uuid PRIMARY KEY NOT NULL,
  "org_id" uuid NOT NULL,
  "source_kind" text NOT NULL,
  "repo_pattern" text,
  "path_pattern" text,
  "component_object_id" uuid NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "source_mappings_org_source" ON "source_mappings" USING btree ("org_id","source_kind");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "change_source_events" (
  "id" uuid PRIMARY KEY NOT NULL,
  "org_id" uuid NOT NULL,
  "source_kind" text NOT NULL,
  "signature_verified" boolean DEFAULT false NOT NULL,
  "headers" jsonb NOT NULL,
  "payload" jsonb NOT NULL,
  "processed_at" timestamp with time zone,
  "resulting_change_object_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "change_source_events_unprocessed" ON "change_source_events" USING btree ("processed_at","created_at");
--> statement-breakpoint

-- ===========================================================================================
-- 6. `change_plans` / `change_waves` / `change_wave_targets` — DESIGN §9.3 plan compiler output.
-- ===========================================================================================

CREATE TABLE IF NOT EXISTS "change_plans" (
  "id" uuid PRIMARY KEY NOT NULL,
  "org_id" uuid NOT NULL,
  "change_object_id" uuid NOT NULL,
  "topology_object_id" uuid,
  "topology_version" bigint,
  "topology_document" jsonb,
  "status" text DEFAULT 'compiled' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "change_plans_org_change" ON "change_plans" USING btree ("org_id","change_object_id");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "change_waves" (
  "id" uuid PRIMARY KEY NOT NULL,
  "org_id" uuid NOT NULL,
  "plan_id" uuid NOT NULL REFERENCES change_plans(id),
  "wave_index" bigint NOT NULL,
  "name" text,
  "requires_fan_in" boolean DEFAULT true NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "started_at" timestamp with time zone,
  "completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "change_waves_org_plan" ON "change_waves" USING btree ("org_id","plan_id","wave_index");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "change_wave_targets" (
  "id" uuid PRIMARY KEY NOT NULL,
  "org_id" uuid NOT NULL,
  "wave_id" uuid NOT NULL REFERENCES change_waves(id),
  "target_object_id" uuid NOT NULL,
  "executor_plugin_id" text,
  "executor_ref" jsonb,
  "prior_state_ref" jsonb,
  "status" text DEFAULT 'pending' NOT NULL,
  "attempt" bigint DEFAULT 0 NOT NULL,
  "last_observed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "change_wave_targets_org_wave" ON "change_wave_targets" USING btree ("org_id","wave_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "change_wave_targets_org_target" ON "change_wave_targets" USING btree ("org_id","target_object_id");
--> statement-breakpoint

-- ===========================================================================================
-- 7. Grants (mirrors 0002 §1 / 0005 §3 exactly) — every new table is tenant data except
--    `state_transitions`, which is global reference data like object_types/relationship_types
--    (readable by every org, never written by scp_app).
-- ===========================================================================================

GRANT SELECT ON state_transitions TO scp_app;
GRANT SELECT, INSERT, UPDATE ON
  changes, gate_bindings, decisions, source_mappings, change_source_events,
  change_plans, change_waves, change_wave_targets
TO scp_app;

-- ===========================================================================================
-- 8. RLS — identical `org_isolation` shape as every other tenant table (0002 §2 / 0005 §3).
--    `state_transitions` carries no `org_id` (global data, like object_types with org_id NULL)
--    so it gets no RLS policy — same treatment as `object_types`' built-in rows, but simpler
--    since 100% of its rows are global.
-- ===========================================================================================

ALTER TABLE changes ENABLE ROW LEVEL SECURITY;
ALTER TABLE changes FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON changes;
CREATE POLICY org_isolation ON changes
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

ALTER TABLE gate_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE gate_bindings FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON gate_bindings;
CREATE POLICY org_isolation ON gate_bindings
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

ALTER TABLE decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE decisions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON decisions;
CREATE POLICY org_isolation ON decisions
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

ALTER TABLE source_mappings ENABLE ROW LEVEL SECURITY;
ALTER TABLE source_mappings FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON source_mappings;
CREATE POLICY org_isolation ON source_mappings
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

ALTER TABLE change_source_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE change_source_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON change_source_events;
CREATE POLICY org_isolation ON change_source_events
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

ALTER TABLE change_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE change_plans FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON change_plans;
CREATE POLICY org_isolation ON change_plans
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

ALTER TABLE change_waves ENABLE ROW LEVEL SECURITY;
ALTER TABLE change_waves FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON change_waves;
CREATE POLICY org_isolation ON change_waves
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

ALTER TABLE change_wave_targets ENABLE ROW LEVEL SECURITY;
ALTER TABLE change_wave_targets FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON change_wave_targets;
CREATE POLICY org_isolation ON change_wave_targets
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

-- ===========================================================================================
-- 9. New built-in object type (`coordinated-change` — DESIGN §9.2 grouping object for correlated
--    changes) + relationship type (`correlates`) + release-topology's document JSON Schema.
-- ===========================================================================================

INSERT INTO object_types (id, org_id, display_name, property_schema, is_builtin) VALUES
  ('coordinated-change', NULL, 'Coordinated Change', '{"type":"object"}'::jsonb, true)
ON CONFLICT (id) DO NOTHING;

INSERT INTO relationship_types (id, org_id, display_name, from_types, to_types, cardinality, is_builtin) VALUES
  ('correlates', NULL, 'Correlates',
    ARRAY['change'], ARRAY['coordinated-change'], 'many_to_many', true)
ON CONFLICT (id) DO NOTHING;

-- Release Topologies (DESIGN §9.3): versioned declarative JSON documents, stored as
-- `release-topology` graph objects (already pre-seeded in 0002 §5) via the generic typed-registry
-- endpoint (routes/typed-registries.ts, extended in M3 to include this resource). The document
-- lives at `properties.waves`; this JSON Schema is enforced at write time by the existing Ajv
-- property-validation path (graph/property-validation.ts) — no new validation machinery.
UPDATE object_types SET property_schema = '{
  "type": "object",
  "properties": {
    "waves": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["mode", "targets"],
        "properties": {
          "name": { "type": "string" },
          "mode": { "type": "string", "enum": ["parallel", "sequential"] },
          "targets": { "type": "array", "items": { "type": "string" }, "minItems": 1 },
          "requiresFanIn": { "type": "boolean" }
        }
      }
    }
  }
}'::jsonb
WHERE id = 'release-topology';
