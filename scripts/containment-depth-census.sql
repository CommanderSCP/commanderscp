-- Containment depth census (ADR-0037 + the door invariant of 2026-08-18).
--
-- Answers, for ONE database: how many LIVE rows sit past CONTAINMENT_WALK_MAX_DEPTH (10 hops) on
-- their longest containment route, and how deep the deepest route is. Since 2026-08-18 no write
-- door can create such a row (graph/containment.ts assertContainmentDepthAdmits), so a non-zero
-- count means rows planted BEFORE the doors or arrived through the federation-import carve-out —
-- the shape the walk-409 -> door-400 conversion in containmentParentChainForDoor exists for.
--
-- Mirrors containmentChain's three routes exactly (domain_id parent; `contains` edge walked
-- backwards; BOTH endpoints of a placement pair), live parents only, bounded at 12 so the probe
-- depth (11) is observable. Read-only. Run against each database of an estate:
--
--   psql "$DATABASE_URL" -At -f scripts/containment-depth-census.sql
--
-- Measured 2026-08-18 on the review pair: scp 0 past the bound (deepest 5, 77 live rows);
-- scp_outpost 0 (deepest 6, 75 live rows). Production: not measured from a laptop — run the
-- command above there and record the answer beside the comment that cites this file.
WITH RECURSIVE up AS (
  SELECT o.id AS leaf, o.id AS node, 0 AS depth FROM objects o WHERE o.deleted_at IS NULL
  UNION
  SELECT u.leaf, p.id, u.depth + 1
  FROM up u
  CROSS JOIN LATERAL (
    SELECT po.id FROM objects co JOIN objects po ON po.id = co.domain_id
      WHERE co.id = u.node AND po.deleted_at IS NULL
    UNION ALL
    SELECT r.from_id FROM relationships r JOIN objects po ON po.id = r.from_id
      WHERE r.to_id = u.node AND r.type_id = 'contains' AND r.deleted_at IS NULL AND po.deleted_at IS NULL
    UNION ALL
    SELECT po.id FROM objects pl JOIN objects po
      ON po.id::text IN (pl.properties->>'componentId', pl.properties->>'deploymentTargetId')
      WHERE pl.id = u.node AND pl.type_id = 'placement' AND po.deleted_at IS NULL
  ) p
  WHERE u.depth < 12
)
SELECT count(DISTINCT leaf) FILTER (WHERE depth >= 11) AS rows_past_bound,
       max(depth) AS deepest_route,
       count(DISTINCT leaf) AS live_rows
FROM up;
