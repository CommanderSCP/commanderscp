-- ===========================================================================================
-- `releases_via` gains its two INHERITANCE rungs (ADR-0026, post-import-configuration.md §5,
-- owner decisions D4 and D15).
--
-- Migration 0049 registered the edge with `from_types = ['component']` ONLY, deliberately: the
-- higher rungs exist to be READ by a resolution walk, and registering an endpoint nothing could
-- resolve would have let an operator attach a pipeline that silently did nothing. That walk lands
-- with this migration, so the endpoints open now and not before.
--
-- The three rungs (D15's dedicated walk, NOT `containmentChain` — see the amendment in §5):
--
--   1. the component's own `releases_via`
--   2. its owning service's, via the `contains` edge walked inbound
--   3. the org root's — a `releases_via` edge on the `organization` object
--
-- WHY THE ORG ROOT IS AN ENDPOINT AT ALL. "The org default pipeline" needs somewhere to live, and
-- `orgs` (`id, name, created_at`) has no settings columns and should not grow any (charter
-- principle 2: new concepts arrive as relationship/registry data). The `organization` graph object
-- already exists — every object's `domain_id` chain terminates there — so the org default is just
-- this edge hanging off it. No new table, no new column.
--
-- `domain` is deliberately NOT an endpoint. D15 dropped the domain axis from the walk precisely
-- because reading it required the cross-kind ordering `containment.ts` disclaims; registering it
-- here would re-create the same attach-but-never-resolve trap 0049 avoided.
--
-- Cardinality is unchanged and still `many_to_one`: each of these objects has AT MOST ONE outgoing
-- `releases_via`, which is what makes a rung's answer unambiguous. Migration 0049's partial unique
-- index on `(org_id, from_id)` is not type-scoped, so it already covers the new endpoints — no new
-- index is needed, and the org root cannot acquire two default pipelines.
-- ===========================================================================================

UPDATE relationship_types
   SET from_types = ARRAY['component', 'service', 'organization']
 WHERE id = 'releases_via';
