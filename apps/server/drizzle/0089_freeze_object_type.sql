-- ===========================================================================================
-- M25.7 — ORG-TIER FREEZES FEDERATE (owner decision D6, ADR-0043)
-- docs/proposals/campaigns-rework.md §2.3
--
-- THIS MIGRATION RETRACTS A DELIBERATE, TESTED ABSENCE. Until today a freeze was a projection row
-- and nothing else: the "M4 Governance Engine" banner in `db/schema.ts` (immediately above
-- `controlBindings`) stated outright that the generic object model has no place for control-run
-- evidence, approval quorum, or freezes, and `JournalEntryKindSchema` has nine kinds,
-- none freeze-shaped. CITED BY SECTION, NOT BY LINE — that banner now carries BOTH halves of the
-- narrowed claim (a freeze's ENFORCEMENT state still has no place in the generic model, which is
-- why the projection table stays; its WIRE form is a `freeze` object), and the line number this
-- header used to carry would have gone on pointing at the retracted sentence.
-- That was not an oversight — it was the reason `service-board.ts` tells an
-- operator that a null `activeFreeze` is "no freeze declared HERE", never "no freeze applies", and
-- it was pinned by `coordination/service-board-precedence.integration.test.ts`. D6 overturns it.
--
-- ===========================================================================================
-- WHY A GRAPH OBJECT AND NOT A NEW JOURNAL KIND — TWO INDEPENDENT CLIFFS
-- ===========================================================================================
--   1. `JournalEntryKindSchema` is a nine-literal `z.enum` that also appears in the 200 RESPONSE of
--      `POST /federation/exports`. Widening it is an oasdiff `response-property-one-of-added`
--      break.
--   2. Worse, it is FAIL-CLOSED at the far end. `POST /federation/imports` validates the whole
--      bundle against `SyncBundleSchema` AT THE ROUTE BOUNDARY, so an older peer receiving an
--      unknown kind 400s the ENTIRE bundle — every unrelated entry in it lost, and retried forever
--      by `inbox-loop.ts`. `import-repo.ts`'s tolerant `default: return;` is never reached.
--
-- A registered object type rides the EXISTING `object_upsert` kind, which every peer already
-- understands. Same structural argument ADR-0022 used for `outpost` (drizzle/0043) and ADR-0026
-- for `placement` (drizzle/0051): the journal cannot carry a table, so config that must cross a
-- boundary becomes a graph object.
--
-- `object_types` NEVER JOURNALS. It is a migration seed on BOTH sides — which is exactly what makes
-- this work with no new entry kind and no importer branch for type registration: `import-repo.ts`'s
-- `object_upsert` branch resolves `typeId` through `upsertObjectByUrn`. Both ends carry this seed
-- because both ends run this migration.
--
-- CORRECTED (round 2). This paragraph used to end "(aborting the peer's whole signed bundle)" as
-- though it were a hazard the seed made unreachable. IT IS NOT: the seed is only present once an
-- instance has RUN the migration, and a rolling upgrade guarantees a window in which the commander
-- has and the outpost has not. `createObject` 404s on an unregistered type, the `object_upsert`
-- branch has no try/catch, and `inbox-loop.ts` retries the same bundle forever — so the FIRST
-- federated freeze would have wedged an un-upgraded peer's inbox completely, and every unrelated
-- entry in every subsequent bundle with it. M25.7 is the first type reachable by an ordinary
-- operator action (declaring a freeze) rather than by an operator registering a custom type, which
-- is why the tolerance was added now: `import-repo.ts` checks registration BEFORE the write and
-- SKIPS-AND-RECORDS the entry into this org's hash-chained audit log
-- (`federation.import.entry_dropped`). One entry may be lost; the channel must not be. Recovery is
-- a from-genesis re-sync once the peer has this migration. 0043 (`outpost`) and 0051 (`placement`)
-- carried the same exposure and were lucky.
--
-- ===========================================================================================
-- A PLATFORM-TIER FREEZE DOES NOT FEDERATE AND CANNOT — `instance_freezes` IS NOT TOUCHED HERE
-- ===========================================================================================
-- `SyncJournalEntrySchema.orgId` is REQUIRED, `appendJournalEntry` takes `input.orgId`, the hash
-- chain is keyed `(orgId, originDomainId)` under an advisory lock on that pair, and
-- `exportSyncBundle` runs inside `withTenantTx(db, orgId, …)`. Every layer is org-scoped.
-- `instance_freezes` (drizzle/0086) has no `org_id` and is declared by no commander, so it has no
-- non-arbitrary way to acquire one. ADR-0040 and GLOSSARY's "platform-tier freeze" entry both say
-- so and both stay TRUE after this migration. Org tier and below only.
--
-- ===========================================================================================
-- WHY THE PROJECTION ROW STAYS — object PLUS projection, the `changes`/`campaigns` pattern
-- ===========================================================================================
-- Everything that ENFORCES a freeze reads `freezes`: `activeFreezesInWindow` (the one function that
-- knows the window predicate), `freezesByTarget`, `checkFreeze`, `evaluateFreezeHolds`, the service
-- board. Moving that state into `objects.properties` would mean re-expressing the half-open window
-- predicate as jsonb comparisons on a hot gate path and rewriting every one of those readers — for
-- no gain, since the object exists only to TRAVEL. So the object is the wire form and the row is
-- the enforcement form, and `federation/import-repo.ts` rebuilds the row from the object at the
-- receiving instance. That rebuild is what makes an imported freeze actually BLOCK, which is the
-- whole feature; without it this migration would ship a row nothing reads.
--
-- ===========================================================================================
-- WHY THE REGISTERED SCHEMA HAS `required` BUT NOT `additionalProperties: false`
-- ===========================================================================================
-- 0043's rule, restated by 0051: this type is JOURNALED and Ajv-validated on the RECEIVING side by
-- `federation/import-repo.ts`, whose `object_upsert` branch has NO try/catch — a validation failure
-- aborts THE WHOLE SYNC BUNDLE. A CLOSED schema makes every future property addition a fail-closed
-- version-skew hazard: an older receiver would reject a bundle from a newer commander outright.
-- `required` carries none of that risk in that direction and is load-bearing in the other: the five
-- listed fields are CONSTITUTIVE of a freeze (there is no freeze without a scope, a window and a
-- reason), so no newer authority would ever author one without them.
--
-- `freezeId` is required and is the projection row's PRIMARY KEY at every instance, which is what
-- makes the rebuild idempotent (`ON CONFLICT (id) DO UPDATE`) and what keeps `scp change explain`
-- answerable across a boundary: a `freeze_admission` Decision written at the outpost names the same
-- id the commander's operator can `GET /v1/freezes/{id}`.
--
-- `liftedAt` is NOT required and is deliberately part of the snapshot: a commander that lifts a
-- federated freeze must be able to lift it DOWNSTREAM too, or M25.1's "a surface with an entrance
-- and no exit" defect is rebuilt one boundary over — with the freeze standing at the outpost until
-- `endsAt` and no local verb able to retract it (the replica guard refuses one, by design).
--
-- ===========================================================================================
-- AND WHY THERE IS NO `"format": "uuid"` ON THE FOUR ID FIELDS — CONSIDERED AND REFUSED
-- ===========================================================================================
-- Four of these properties become `uuid` COLUMNS at the receiving instance (`freezes.id`,
-- `scope_object_id`, `created_by_actor_id`, `lifted_by_actor_id`), so constraining them here looks
-- like free authoring-time refusal. It is not, in two independent ways, and both point the wrong
-- direction:
--
--   1. `"format"` IS INERT UNDER THIS DEPLOYMENT'S AJV. `graph/property-validation.ts` constructs
--      `new Ajv({ allErrors: true, strict: false })` and `ajv-formats` is NOT a dependency of this
--      repo, so an unknown format is silently ignored — the constraint would validate nothing while
--      READING as coverage, which is worse than its absence.
--   2. A NON-INERT SPELLING (`"pattern"`) WOULD BE A NEW WEDGE VECTOR, on the branch this whole
--      milestone is about. `validateProperties` runs on the RECEIVING side inside the same
--      try/catch-less `object_upsert` branch, so a payload failing the pattern would abort the
--      peer's ENTIRE signed bundle — turning "one malformed freeze is skipped" back into "the
--      channel is wedged". Exactly the reason `additionalProperties: false` is refused above.
--
-- The refusal therefore lives where it can fail safely: `rebuildFreezeProjectionFromObject` reads
-- these four through `isUuid` (`graph/objects-repo.ts`) and treats a non-UUID exactly like an
-- absent value — skip, never throw. Authoring-time refusal is unaffected: the only local door that
-- mints a `freeze` object is `POST /api/v1/freezes`, which builds these properties from a `freezes`
-- row whose columns are already `uuid`.
-- ===========================================================================================

INSERT INTO object_types (id, org_id, display_name, property_schema, is_builtin) VALUES
  (
    'freeze',
    NULL,
    'Freeze',
    '{
       "type": "object",
       "properties": {
         "freezeId":        { "type": "string", "minLength": 1 },
         "scopeObjectId":   { "type": "string", "minLength": 1 },
         "scopeObjectUrn":  { "type": "string", "minLength": 1 },
         "startsAt":        { "type": "string", "minLength": 1 },
         "endsAt":          { "type": "string", "minLength": 1 },
         "reason":          { "type": "string", "minLength": 1 },
         "atomic":          { "type": "boolean" },
         "liftedAt":        { "type": ["string", "null"] },
         "liftReason":      { "type": ["string", "null"] }
       },
       "required": ["freezeId", "scopeObjectId", "startsAt", "endsAt", "reason"]
     }'::jsonb,
    true
  )
ON CONFLICT (id) DO NOTHING;
--> statement-breakpoint

-- ===========================================================================================
-- `freezes.object_id` — THE LINK, AND THE FEDERATION SWITCH ITSELF
--
-- NULL (the default, and retroactively true of every freeze on every estate) = this freeze has no
-- graph object, journals nothing, and is BYTE-IDENTICAL to a pre-M25.7 freeze on every path. That
-- is not a convenience: D6 adds a new REACH, and a new reach never defaults on. `POST
-- /api/v1/freezes` gains `federate` defaulting to `false`, gated on `federation:write` rather than
-- `freeze:write` — declaring a freeze that binds another security domain is categorically different
-- from describing your own estate (ADR-0022's argument, same direction).
--
-- NON-NULL = the id of this freeze's `freeze` graph object. Two things read it and they are the two
-- halves of the feature:
--   * `governance/freezes-repo.ts`'s `lockFreezeRow` — the read half of BOTH write verbs — refuses
--     a lift or a window edit when the object is a read-only replica. That is what stops an outpost
--     lifting a commander freeze; the remedy is `freeze:override` at the replica's own scope,
--     per-change, reasoned and audited, never deletion.
--   * `governance/freeze-object.ts`'s `rebuildFreezeProjectionFromObject`, at the importing
--     instance, which is also the UPSERT KEY's other half (see the index below).
--
-- A plain uuid, NOT a foreign key, matching `scope_object_id` and every `*_actor_id` on this table.
-- `scp_app` is never granted DELETE on `objects` (DESIGN §4.1 append/soft-delete-only), so the
-- referent cannot vanish; and a tombstoned object must not take the freeze's audit trail with it.
--
-- NO NEW GRANTS, NO NEW POLICY. A column inherits its table's grants and RLS, and `freezes` is an
-- ordinary TENANT table (0007) already carrying `org_isolation` with USING + WITH CHECK, ENABLE +
-- FORCE RLS and the ordinary `scp_app` grants. Unlike 0076's operator-write/tenant-read tables,
-- nothing here needs `scp_operator` — this is org-tier data by construction.
-- ===========================================================================================

ALTER TABLE "freezes"
  ADD COLUMN IF NOT EXISTS "object_id" uuid;
--> statement-breakpoint

COMMENT ON COLUMN freezes.object_id IS
  'M25.7 / owner decision D6 (ADR-0043) — the id of this freeze''s `freeze` GRAPH OBJECT, or NULL when this freeze does not federate (the default, and retroactively true of every freeze authored before M25.7). The object is the WIRE form (it rides the existing object_upsert entry kind; no new JournalEntryKind exists and none can, because widening that nine-literal enum is both an oasdiff response break and a fail-closed cliff that aborts a whole bundle at an older peer); this row is the ENFORCEMENT form that activeFreezesInWindow/freezesByTarget/checkFreeze/evaluateFreezeHolds actually read. Non-null also makes this row REPLICA-AWARE: freezes-repo.ts''s lockFreezeRow refuses a local lift or window edit when the named object is authoritatively owned by another domain, so an outpost cannot lift a commander freeze. A platform-tier freeze (instance_freezes, drizzle/0086) has no such column and never federates — the sync journal is org-scoped at every layer.';
--> statement-breakpoint

-- ===========================================================================================
-- ONE PROJECTION ROW PER FREEZE OBJECT — the re-import idempotency guarantee, in the schema
--
-- `rebuildFreezeProjectionFromObject` upserts on the PRIMARY KEY (`freezes.id` = the origin's
-- `properties.freezeId`, preserved verbatim across the boundary), so a replayed bundle converges
-- rather than duplicating. This index is the OTHER direction of the same invariant: it makes a
-- SECOND row claiming the same object impossible, so the rebuild's `WHERE object_id = …` guard can
-- never match two rows and no reader has to pick a winner. Partial, so the overwhelming majority
-- of freezes (`object_id IS NULL`, non-federating) are unconstrained and unindexed.
--
-- Keyed `(org_id, object_id)` rather than on `object_id` alone: `objects.id` is globally unique
-- WITHIN one instance's database, but this instance's `freezes` rows are tenant data and every
-- other index on this table is org-first (`freezes_org_scope`, `freezes_org_window`).
-- ===========================================================================================

CREATE UNIQUE INDEX IF NOT EXISTS "freezes_org_object" ON "freezes" ("org_id", "object_id")
  WHERE "object_id" IS NOT NULL;
