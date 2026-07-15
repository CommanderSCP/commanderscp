-- ===========================================================================================
-- `contains` — the service/component membership edge (docs/proposals/service-component-model.md).
--
-- Every component belongs to exactly ONE service (owner decision, 2026-07-15). Graph-native:
-- registry data, not a new table or column (charter principle 2), following the 0007
-- (`correlates`) / 0019 (`execution-system`) precedent.
--
-- DIRECTION IS FORCED, and is not a stylistic choice. The domain reads "component is part of a
-- service", but `component -> service` with cardinality `many_to_one` cannot work here:
--   * `many_to_one` is not in CardinalitySchema (packages/schemas/src/graph.ts) — the API rejects it;
--   * assertCardinality (graph/relationships-repo.ts) implements only many_to_many / one_to_one /
--     one_to_many and has NO branch for it, so a hand-inserted `many_to_one` would fall through
--     every check and be SILENTLY UNENFORCED.
-- `one_to_many` restricts the *to* side to one live incoming edge. Registered service -> component,
-- that is exactly "a service has many components; each component has at most one service" — using
-- enforcement that already exists and is already tested.
--
-- Cardinality is enforced by assertCardinality at relationship-create time; it does NOT make the
-- edge mandatory. Requiring every NEW component to have one is a separate, deliberate change on the
-- strict create path — imports must stay permissive and land unassigned by construction
-- (owner: "we should never prevent users from importing their resources").
-- ===========================================================================================

INSERT INTO relationship_types (id, org_id, display_name, from_types, to_types, cardinality, is_builtin) VALUES
  ('contains', NULL, 'Contains',
    ARRAY['service'], ARRAY['component'], 'one_to_many', true)
ON CONFLICT (id) DO NOTHING;
