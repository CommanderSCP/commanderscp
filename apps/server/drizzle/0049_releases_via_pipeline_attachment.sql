-- ===========================================================================================
-- `releases_via` — the pipeline-attachment edge (ADR-0026, docs/proposals/post-import-configuration.md
-- §5, decisions D4/D11/D12).
--
-- `component --releases_via--> release-topology`: each component releases via AT MOST ONE pipeline;
-- each pipeline serves MANY components. That is `many_to_one` — the from side is singular.
--
-- WHY THE DIRECTION IS NOT INVERTED THIS TIME. Migration 0021 faced the same shape and inverted the
-- edge (`service --contains--> component`, `one_to_many`) because `many_to_one` was absent from
-- CardinalitySchema AND had no branch in `assertCardinality`, so it would have been SILENTLY
-- UNENFORCED. D11 closes that hole instead of inverting again: `many_to_one` is now a member of the
-- enum and runs the from-side check that `one_to_one` already had, and `assertCardinality` fails
-- closed on any cardinality it cannot enforce. Inverting here would have been actively wrong — the
-- resolution walk reads OUTWARD from a component (`component -> its pipeline`), and D12's
-- containment walk asks the same question of each rung, so the natural direction is the one that is
-- read.
--
-- 0021's own header still describes the pre-D11 world; it is annotated rather than rewritten,
-- because `contains` keeps its shipped direction (0022's index and the authz walks key on it) and
-- the history of WHY should stay legible.
--
-- The `from_types` list is `component` ONLY, deliberately. §5's inheritance ladder attaches a
-- pipeline at higher rungs too (service, domain, the org root), and those are added when the
-- resolution walk that reads them lands — registering endpoints nothing can yet resolve would let
-- an operator attach a pipeline that silently does nothing.
-- ===========================================================================================

INSERT INTO relationship_types (id, org_id, display_name, from_types, to_types, cardinality, is_builtin) VALUES
  ('releases_via', NULL, 'Releases Via',
    ARRAY['component'], ARRAY['release-topology'], 'many_to_one', true)
ON CONFLICT (id) DO NOTHING;

-- ===========================================================================================
-- The race backstop — the FROM-side mirror of migration 0022, needed for the same reason.
--
-- `assertCardinality` is a SELECT-then-INSERT under READ COMMITTED with no row lock, so two
-- concurrent `releases_via` creates for the same component can BOTH pass the check and BOTH insert.
-- The pre-existing UNIQUE (org_id, type_id, from_id, to_id) does not help: the to_ids differ. A
-- component with two live pipelines resolves nondeterministically — whichever edge the resolution
-- query happens to return first decides how a change compiles.
--
-- Scoped to `releases_via` for the same reason 0022 was scoped to `contains`: a partial index
-- expresses this one exactly, and the generic fix (locking or SERIALIZABLE across every
-- relationship write) is a larger, riskier change that deserves its own review.
--
-- `deleted_at IS NULL` matches both `assertCardinality`'s filter and the resolution walk's, so a
-- soft-deleted edge frees the component to be re-attached — exactly as re-assignment already works
-- for `contains`.
-- ===========================================================================================

CREATE UNIQUE INDEX IF NOT EXISTS "relationships_releases_via_one_pipeline_per_component"
  ON "relationships" ("org_id", "from_id")
  WHERE "type_id" = 'releases_via' AND "deleted_at" IS NULL;
