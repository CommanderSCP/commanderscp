-- ===========================================================================================
-- M21.2 — `component_dependencies.observed_repo`: WHICH REPOSITORY a declaration was read from.
--
-- ===========================================================================================
-- THE BUG THIS EXISTS TO CLOSE — an ingestion pass DESTROYED a component's inventory
--
-- 0061 recorded `observed_ref` ("the git ref the manifest was read at") and no repository beside
-- it. A commit sha without a repository is not an address, and the ingestion built on top of that
-- row inherited the gap: a pass reads ONE repo, then prunes each of the component's known manifest
-- PATHS — from every repo — against what it found in that one. A component fed by two repositories
-- (a real, supported shape: `source_mappings` is many-per-component and the webhook correlator
-- matches on `repo_pattern`) therefore lost one repo's entire inventory on every accepted change
-- originating in the other, because "there is no `b/package.json` in repo A" was read as "the
-- component's `b/package.json` was deleted".
--
-- Losing the inventory is not a cosmetic loss: `listSubscribedComponentLines` DERIVES subscription
-- from these rows, so a component whose inventory is emptied is silently unsubscribed from
-- everything it declared.
--
-- ===========================================================================================
-- WHY A COLUMN AND NOT A NARROWER PROBE SET
--
-- The ingestion is separately fixed to derive its candidate paths from the `source_mappings` that
-- name THIS repository, so the two-repository-two-subtrees shape is scoped before a read is even
-- attempted. That alone is not sufficient and the residue is exactly the case worth naming: two
-- repositories BOTH mapped at their root (a service whose code is in one repo and whose chart is in
-- another) produce identical candidate paths, so no path-shaped rule can attribute `package.json`
-- to one of them. Attribution has to be recorded when the row is written or it is not recoverable
-- afterwards — which is what this column does, and it is the same thing `observed_ref` was already
-- half-doing.
--
-- ===========================================================================================
-- NULLABLE, AND NOT IN THE PRIMARY KEY
--
-- NULLABLE because a NOT NULL column needs a value for existing rows and there is no honest one to
-- invent: a row written before this column existed records no repository, and stamping it with a
-- guess would be the "provenance label named after the branch that matched" mistake. `NULL` reads
-- as "this row's repository was never recorded", and the prune predicate is an equality — so a NULL
-- row is never pruned by any pass, which is the safe direction (stale, and visibly so, rather than
-- destroyed). A re-observation stamps it, so such rows heal on their first pass.
--
-- (In practice there are none: `upsertComponentDependency` had no non-test caller before M21.2's
-- ingestion, so `component_dependencies` is empty on every deployment. The nullable column is what
-- makes that a fact this migration does not have to DEPEND on.)
--
-- NOT IN THE PRIMARY KEY because widening the key is not needed to fix the destruction and would
-- cost the one thing the key buys: `(org_id, component_object_id)` is still the whole forward
-- lookup. Two repositories that declare the SAME line from the SAME path collapse onto one row
-- whose `observed_repo` is whichever pass wrote last; each pass then prunes only rows carrying its
-- own repository, so the collision costs a possible STALE row and can never cost a deleted one.
--
-- No index: every read of this column is already inside a `(org_id, component_object_id)` primary-key
-- descent, so it is a filter on a handful of rows rather than a lookup key.
-- ===========================================================================================

ALTER TABLE "component_dependencies"
  ADD COLUMN IF NOT EXISTS "observed_repo" text;
--> statement-breakpoint

COMMENT ON COLUMN component_dependencies.observed_repo IS
  'The repository this declaration was read from, as the provider spells it. NULL means the '
  'repository was not recorded (a row written before M21.2''s ingestion existed); such a row is '
  'never pruned, because a prune requires positive evidence from the SAME repository the row was '
  'observed in. Together with observed_ref this is the declaration''s full address.';
