-- ===========================================================================================
-- `placement` — ONE COMPONENT AT ONE DEPLOYMENT TARGET (ADR-0026 D2/D3/D14,
-- docs/proposals/post-import-configuration.md §3, owner decision D17).
--
-- A component says WHAT the software is; a deployment-target says WHERE; a placement is the
-- intersection, and it is what an executor binding attaches to and what a wave target names.
-- Neither endpoint alone can identify a deployment — a binding must resolve both which execution
-- system to call (a function of where) and which application inside it (a function of what), and a
-- one-column key cannot address a two-dimensional grid.
--
-- WHY AN OBJECT AND NOT A SECOND DIMENSION ON `executor_bindings` (ADR-0026 D9): the sync journal
-- cannot carry a binding. `JournalEntryKindSchema` admits exactly nine entry kinds and none is a
-- binding, so estate topology stored as binding columns could never cross a federation boundary —
-- the commander could not author or govern where software runs. An object rides `object_upsert`
-- like any other registered type. Same structural fact 0043 built the `outpost` object on.
--
-- `executor_bindings` and `change_wave_targets` are NOT migrated: their `target_object_id` now
-- points at a placement, and `UNIQUE (org_id, target_object_id, type)` becomes exactly right (one
-- placement, one `configuration` binding). That is what keeps the 43 non-test files referencing
-- `targetObjectId` untouched.
--
-- ============================================================================================
-- STORAGE SHAPE (owner decision D17) — PROPERTIES ARE THE SOURCE OF TRUTH, EDGES ARE DERIVED
-- ============================================================================================
-- The pair lives in `properties.componentId` / `properties.deploymentTargetId`, and the two
-- relationships below are DERIVED from them, written in the same transaction by the typed route
-- (`graph/placements-repo.ts`). This is one fact in two places and that cost is deliberate:
--
--   * Only the properties can be UNIQUELY INDEXED. Nothing in the schema can reference a
--     relationship id, and uniqueness over a PAIR of relationship rows is not expressible as one
--     index — the same architectural fact ADR-0026 used to reject the attributed-relationship
--     alternative.
--   * Only the edges are TRAVERSABLE. `traverse`, blast-radius and the graph explorer walk
--     `relationships`; a placement whose endpoints existed only as property UUIDs would be an
--     island in the graph, invisible to every impact query (charter principle 2).
--
-- Neither representation can do the other's job, so both exist. `placements-repo.ts` is the single
-- writer that keeps them agreeing.
--
-- WHY THIS REGISTERED SCHEMA HAS `required` BUT NOT `additionalProperties: false` — read 0043's
-- header before tightening it. This type is JOURNALED and validated with Ajv on the RECEIVING side
-- (`federation/import-repo.ts`), whose `object_upsert` branch has no try/catch: a validation failure
-- aborts THE WHOLE SYNC BUNDLE. A CLOSED schema would make every future property addition a
-- fail-closed version-skew hazard. `required` carries none of that risk and is load-bearing in the
-- other direction — the two endpoint ids are CONSTITUTIVE of a placement, no newer authority would
-- ever author one without them, and requiring them here enforces the pairing rule at EVERY write
-- door (typed route, IaC apply, discovery) rather than only at the API. Strict at the operator's
-- door, open on the wire — 0043's rule, applied.
-- ===========================================================================================

INSERT INTO object_types (id, org_id, display_name, property_schema, is_builtin) VALUES
  (
    'placement',
    NULL,
    'Placement',
    '{
       "type": "object",
       "properties": {
         "componentId": { "type": "string", "minLength": 1 },
         "deploymentTargetId": { "type": "string", "minLength": 1 }
       },
       "required": ["componentId", "deploymentTargetId"]
     }'::jsonb,
    true
  )
ON CONFLICT (id) DO NOTHING;

-- ===========================================================================================
-- The two DERIVED edges. Both `many_to_one` (migration 0049): the FROM side — the placement — is
-- singular, because a placement has exactly one component and exactly one deployment-target, while
-- a component has many placements and a target holds many. This is the first use of the cardinality
-- 0049 added, and it is the shape that motivated it.
--
-- Direction is placement -> endpoint, not the reverse, because the singular side must be the FROM
-- side for `many_to_one` to constrain it, and because a placement is read outward to its endpoints.
-- ===========================================================================================

INSERT INTO relationship_types (id, org_id, display_name, from_types, to_types, cardinality, is_builtin) VALUES
  ('places', NULL, 'Places',
    ARRAY['placement'], ARRAY['component'], 'many_to_one', true),
  ('placed_at', NULL, 'Placed At',
    ARRAY['placement'], ARRAY['deployment-target'], 'many_to_one', true)
ON CONFLICT (id) DO NOTHING;

-- ===========================================================================================
-- IDENTITY — unique on (org_id, component, deployment_target) (ADR-0026 D3).
--
-- This index IS the uniqueness guarantee, not a backstop. Placements are DECLARED, never inferred
-- (D8), and the URN cannot carry the guarantee: it is derived from the two objects' NAMES, and two
-- deployment-targets may legitimately share a display name. Relying on URN uniqueness would be
-- exactly the name-based pairing D8 forbids.
--
-- It is also the race guard, and 0049's mutation testing established that this is not theoretical:
-- with the application-level check disabled and only the index in place the invariant held, and with
-- the index removed and only the application check in place two CONCURRENT creates both got through.
-- The application layer here is a SELECT-then-INSERT under READ COMMITTED with no row lock, exactly
-- as it was there.
--
-- `deleted_at IS NULL` so a soft-deleted placement frees the pair to be re-declared, matching every
-- other partial unique index in this schema (0022, 0049) and the read paths' own filter.
-- ===========================================================================================

CREATE UNIQUE INDEX IF NOT EXISTS "objects_placement_one_per_component_target"
  ON "objects" ("org_id", (("properties" ->> 'componentId')), (("properties" ->> 'deploymentTargetId')))
  WHERE "type_id" = 'placement' AND "deleted_at" IS NULL;
