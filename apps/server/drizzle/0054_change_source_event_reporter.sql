-- ===========================================================================================
-- `change_source_events.reported_by_object_id` — WHO reported this event, carried from the
-- ingress route to the processor (ADR-0028).
--
-- The persist-then-process ingress authenticates a reporting principal at the ROUTE and then
-- forgets it: `webhook-processor.ts` proposes every change born from a report or webhook as
-- SYSTEM_ACTOR_ID. That is right for the CHANGE (nobody asked for the change; a push happened),
-- and wrong for the one thing on that path that is a deliberate, authorized declaration — ADR-0028's
-- `stageDependencies`, which mints a `depends_on` edge. Those edge writes were attributed to the
-- system actor in the audit chain, the federation journal and the `scp.relationship.created` event,
-- so "who declared that A depends on B?" had no answer — and a minted edge changes
-- `graph.dependentIds`, a live CEL policy input, for the depended-on component. An unattributable
-- write of it is an auditability gap (charter principle 6).
--
-- NULL for every pre-existing row, and for every event with no principal behind it: the observe()
-- driver (`coordination/observe.ts`) writes this same queue from a poll, where the system actor IS
-- the honest answer. The processor falls back to it, so a NULL never becomes a broken attribution.
--
-- Deliberately NOT a foreign key, matching `resulting_change_object_id` beside it: subjects are
-- graph objects and this table is a raw ingress ledger that must keep its rows verbatim even if the
-- subject is later removed.
-- ===========================================================================================

ALTER TABLE "change_source_events" ADD COLUMN IF NOT EXISTS "reported_by_object_id" uuid;

COMMENT ON COLUMN "change_source_events"."reported_by_object_id" IS
  'The authenticated principal that reported this event (NULL for observe()-driven rows and rows written before 0054). Attributes the depends_on edges an ADR-0028 declaration mints.';
