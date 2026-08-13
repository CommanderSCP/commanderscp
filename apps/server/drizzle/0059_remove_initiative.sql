-- ===========================================================================================
-- Remove the `initiative` concept (ADR-0032; owner instruction 2026-08-10, explicit).
--
-- An initiative was the portfolio rung above campaigns: a strategic objective ("FedRAMP
-- Certification", "Data Center Exit") grouping campaigns via `coordinates`, with a roll-up status
-- always DERIVED by traversal and never stored. It carried no plan, compiled no waves, and
-- executed nothing — every actuator lived one rung down, on the campaign. The owner's ruling is
-- that the rung is not worth its surface area.
--
-- THIS MIGRATION DELETES TENANT DATA. Every `initiative` object in every org is removed, along
-- with the `coordinates` edges that made campaigns members of one. That is unavoidable for a type
-- removal — an `object_types` row cannot be dropped while `objects` still reference it — and it is
-- the owner's explicit instruction, recorded here because a reader a year from now deserves to
-- know a DELETE ran rather than infer it. Campaigns themselves are untouched: an initiative's only
-- relationship to a campaign was membership, so deleting the grouping strands nothing.
--
-- `coordinates` SURVIVES, NARROWED. This is the one thing in here that is easy to get wrong.
-- `coordinates` was seeded (0002 §5) as ARRAY['campaign','initiative'] -> ARRAY['change','campaign'],
-- which is TWO distinct memberships sharing one type:
--
--     initiative -> campaign   (the rung being removed)
--     campaign   -> change     (STILL LOAD-BEARING — `coordination/campaign-reconcile.ts` writes
--                               one per fanned-out member change, and campaign rollback reads
--                               membership to decide what to revert)
--
-- Dropping the type would silently break every campaign on the instance. So the type stays and its
-- endpoints are narrowed to the surviving membership. Narrowing `to_types` to just `change` also
-- retires the campaign -> campaign combination the old arrays permitted: nothing ever wrote one,
-- and it was only ever reachable as an artefact of the two memberships sharing a row.
--
-- ORDER IS FORCED by referential integrity: edges before objects, objects before the type row.
-- ===========================================================================================

-- 1. The membership edges of the rung being removed. Scoped by the FROM endpoint's type rather
--    than by `to_type`, so a campaign -> change edge can never be caught by this: those have a
--    campaign on the `from` side and are exactly what must survive.
DELETE FROM relationships r
USING objects o
WHERE r.type_id = 'coordinates'
  AND r.from_id = o.id
  AND o.type_id = 'initiative';

-- 2. Any other edge hanging off an initiative in either direction — `owns` from a team, a
--    `governed_by` to a policy, and anything a custom relationship type allowed. Deliberately NOT
--    filtered to a known list: the whole point of a graph-native model is that an operator can
--    register their own relationship types (charter principle 2), so enumerating the ones we
--    happen to ship would leave exactly the rows that block step 4.
DELETE FROM relationships r
USING objects o
WHERE (r.from_id = o.id OR r.to_id = o.id)
  AND o.type_id = 'initiative';

-- 3. Rows in the satellite projections that name an object id. Measured against the live schema,
--    exactly two of these are FK-enforced against `objects(id)` and would therefore BLOCK step 4:
--    `object_health.object_id` (0028) and `role_bindings.scope_object_id`. `freezes.scope_object_id`
--    carries no foreign key, so its delete is housekeeping rather than a precondition — included
--    because leaving a freeze scoped to an object that no longer exists is a row nothing can ever
--    resolve, explain, or lift.
DELETE FROM object_health WHERE object_id IN (SELECT id FROM objects WHERE type_id = 'initiative');
DELETE FROM role_bindings  WHERE scope_object_id IN (SELECT id FROM objects WHERE type_id = 'initiative');
DELETE FROM freezes        WHERE scope_object_id IN (SELECT id FROM objects WHERE type_id = 'initiative');

-- 4. The objects themselves. Hard delete, not the soft `deleted_at` the API uses: a soft-deleted
--    row still references `object_types`, so it would block step 6 and leave the type undroppable.
DELETE FROM objects WHERE type_id = 'initiative';

-- 5. Narrow `coordinates` to the membership that survives (see the header).
UPDATE relationship_types
SET from_types = ARRAY['campaign'],
    to_types   = ARRAY['change']
WHERE id = 'coordinates';

-- 6. Retire the object type. Its `property_schema` (0011 §4) goes with the row.
DELETE FROM object_types WHERE id = 'initiative';
