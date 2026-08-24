-- ===========================================================================================
-- 0088 — `campaign:deadline-override`: the Owner-only permission behind M25.6b's per-target
--         campaign-deadline waiver (`POST /api/v1/campaigns/{id}/deadline-override`).
--
-- WHY A MIGRATION AT ALL. Every role grant in this repo lands as an additive `array_append` over
-- `roles.permissions` — 0010 §4 is the original (`policy:write`, `freeze:write`, `freeze:override`,
-- `change:emergency`) and 0083 §3 is the most recent (`governance:move`). This is that idiom
-- unchanged, down to the `NOT (... = ANY(permissions))` guard that makes re-running it a no-op.
-- ADR-0042 §9 records that M25.6a deliberately shipped NO migration and left this one to M25.6b,
-- because migration numbering is serialized across concurrent sessions behind a hard contiguity gate
-- (`db/journal-ordering.test.ts`).
--
-- OWNER ALONE — the `freeze:override` grant's shape (0010 §4: "only Owner gains 'freeze:override'
-- and 'change:emergency' — the two highest-blast-radius bypass permissions, deliberately NOT granted
-- to Administrator by default"). A deadline waiver is that same family: it excuses a component from
-- a governance deadline the platform is otherwise enforcing, and the record it produces asserts that
-- somebody with standing chose to excuse it.
--
-- NOT `freeze:override` REUSED, and the reason is a blast-radius argument rather than a stylistic
-- one. One permission carrying both would mean a freeze-override holder can waive migration
-- deadlines and a deadline-waiver holder can bypass release freezes, and neither grant could
-- afterwards be narrowed without taking the other with it. Two names, two grants, two futures.
--
-- The permission is CHECKED AT THE CAMPAIGN OBJECT (`routes/campaigns.ts`), never at the target: a
-- target-scoped check would hand the laggard their own waiver. `object:write` at each named target
-- is demanded as a second, narrower bar in the same handler.
--
-- `roles.permissions` is a plain `text[]` with no CHECK constraint or enum backing it (0002 §7), so
-- a new member costs no type change and no other DDL. `org_id IS NULL` selects the BUILT-IN roles;
-- an org's own custom roles are its business and are untouched. Existing role rows keep every
-- permission they already had.
-- ===========================================================================================

UPDATE roles SET permissions = array_append(permissions, 'campaign:deadline-override')
WHERE org_id IS NULL AND name = 'Owner'
  AND NOT ('campaign:deadline-override' = ANY(permissions));
