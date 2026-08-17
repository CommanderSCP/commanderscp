-- ===========================================================================================
-- 0068 — THE PRODUCER DECLARATION GETS ITS OWN TABLE, KEYED BY THE COORDINATE (ADR-0032 §7e).
--
-- EXPAND half of an expand/contract pair. 0069 drops `dependency_lines.produced_by_object_id` and
-- its two companions; this file creates the table those columns move into and BACKFILLS it, so at
-- no point does a declaration exist in neither place.
--
-- -------------------------------------------------------------------------------------------
-- WHY A NEW TABLE AND NOT A COLUMN THAT ALREADY EXISTED
-- -------------------------------------------------------------------------------------------
-- `dependency_lines.produced_by_object_id` decides whether a line is INTERNAL — whether its head is
-- derived from the org's own production releases or fetched from a PUBLIC INDEX. It was written by
-- exactly one function, `declareDependencyLineProducer`, and until this change a filterless census
-- of that symbol found NO NON-TEST CALLER: no route, no CLI verb, no job, no IaC construct. So in
-- production the column was never set, `isInternalDependencyLine` was always false, and the internal
-- half of dependency subscriptions could not fire at all. This migration is the substrate of the fix;
-- the authoring surface is `routes/dependency-producers.ts`.
--
-- Building that surface forced the grain question, and the answer is NOT the column's grain. A
-- `dependency_lines` row is `(org_id, ecosystem, coordinate, major)`, so a declaration written onto
-- it is PER MAJOR LINE. But "component X publishes @acme/lib" is a fact about the COORDINATE, true
-- across every major X has ever cut. Two consequences, and the second is the reason this is a
-- migration rather than a route on top of the old shape:
--
--   1. A PRODUCER WITH NO CONSUMERS HAS NOTHING TO ATTACH TO. `upsertDependencyLine` has one
--      non-test caller, `placeDeclarationOnLine`, and it mints a line from a CONSUMER's manifest.
--      Nothing mints a line from what a component PUBLISHES — SCP has no artifact name at all. So a
--      per-line declaration is unrepresentable until some other team's manifest happens to be
--      ingested, i.e. ordered after an event the declarer does not control.
--
--   2. EVERY NEW MAJOR SILENTLY RE-ARMED DEPENDENCY CONFUSION. X releases 3.0.0; the first consumer
--      moves to ^3; ingestion mints a NEW row with produced_by_object_id = NULL. That row is
--      third-party BY HONEST DEFAULT, and once any component subscribes to it `buildLineWorkList`
--      hands `@acme/lib` to a public index plugin — ADR-0032 §7b clause 1's named catastrophe: "a
--      stranger's package sharing the coordinate answers 9.9.9 … every subscriber is bumped onto
--      it … delivered by a background job on a daily timer, with no error anywhere."
--
--      The two structural barriers built against exactly that do not help, and why they do not is
--      the whole argument. `listThirdPartyDependencyLinesByIds` narrows in SQL on
--      `produced_by_object_id IS NULL`; `asThirdPartyLine` re-reads the same column to mint the
--      brand. BOTH BARRIERS PROTECT THE COLUMN'S MEANING; NEITHER CAN PROTECT A COLUMN NOBODY
--      FILLED IN — and on a fresh major nobody has. Per-line grain converts "declare once" into
--      "re-declare at every major bump", an obligation that fails silently in the dangerous
--      direction.
--
-- Keyed by coordinate, a brand-new major of a declared coordinate is INTERNAL FROM THE INSTANT IT IS
-- MINTED, because there is no per-major field left to populate.
--
-- THE REJECTED ALTERNATIVE, NAMED BECAUSE IT IS THE TEMPTING ONE: keep the column as a materialized
-- projection and have `upsertDependencyLine` stamp it at mint time out of this table. It closes the
-- same hole with no human step, and the value it copies is a prior human declaration rather than
-- anything read out of a manifest. It is rejected anyway: it puts a `produced_by_*` write back
-- INSIDE THE INGESTION VERB, which deletes "the capability is absent from ingestion" — the property
-- that makes "declared, never inferred" structural rather than a rule every call site must remember.
-- The join makes the projection unnecessary instead of making it safe.
--
-- -------------------------------------------------------------------------------------------
-- EVERY COLUMN IS NOT NULL, WHICH RETIRES A CHECK RATHER THAN REPRODUCING IT
-- -------------------------------------------------------------------------------------------
-- `dependency_lines_internal_is_declared` existed only because three columns hung off a row that
-- exists for another reason, so "all three or none" had to be asserted. Here THE ROW'S EXISTENCE IS
-- THE DECLARATION: a half-written declaration is not representable rather than refused.
--
-- -------------------------------------------------------------------------------------------
-- THE ACCEPTED LIMITATION, RECORDED RATHER THAN DESIGNED AROUND
-- -------------------------------------------------------------------------------------------
-- An org that consumes upstream `requests` from PyPI *and* publishes a private package also called
-- `requests` gets ONE answer for both: declaring the producer stops the upstream one being polled,
-- losing its security-update path, silently. Per-major grain would not fix this — it would split the
-- wrong answer across majors. The ambiguity is in the LINE IDENTITY, which carries no registry host;
-- the real fix is registry-scoped coordinates, a separate and much larger change.
--
-- -------------------------------------------------------------------------------------------
-- RLS AND GRANTS — mirrored from 0061 §RLS, which mirrored 0007 §7/§8, EXACTLY
-- -------------------------------------------------------------------------------------------
-- Ordinary tenant data: `org_id NOT NULL`, the identical `org_isolation` policy with both USING and
-- WITH CHECK, ENABLE + FORCE.
--
-- DELETE *IS* GRANTED HERE, and that is a deliberate difference from `dependency_lines`. A line is
-- the identity a dependency subscription is written against, so lines are append-and-observe; a
-- PRODUCER DECLARATION is a statement an operator must be able to withdraw, and retraction is a real
-- part of the concept rather than an escape hatch. Retracting by deleting the row is what keeps
-- "the row's existence is the declaration" true — a `retracted_at` column would put the table back
-- in the business of representing a half-state.
--
-- THE TWO `objects(id)` REFERENCES ARE ORG-UNBOUND, exactly as 0061's three are, and for the same
-- structural reason: `objects` carries no `(org_id, id)` unique constraint to hang a composite key
-- on. 0061's header states the consequence and names the mitigation a route OWES — "resolve every
-- caller-supplied object id under the CALLER'S OWN org before it reaches this table". THAT
-- MITIGATION IS NOW BUILT, in `routes/dependency-producers.ts`'s `assertDeclarableProducer`, which
-- resolves the producer through `getObjectByIdOrUrn` under the caller's org and additionally
-- requires it to be a LIVE, NON-DELETED `component`. Do not read RLS as having done that.
-- ===========================================================================================

CREATE TABLE IF NOT EXISTS "dependency_line_producers" (
  "org_id" uuid NOT NULL,
  -- npm|go|maven|python|oci. PLAIN text, no pg enum, no CHECK — the closed set is enforced in
  -- packages/schemas (`DependencyEcosystemSchema`), matching `dependency_lines.ecosystem`.
  "ecosystem" text NOT NULL,
  -- VERBATIM and case-preserved. The join to `dependency_lines` is BYTE EQUALITY on this column, so
  -- any normalisation here would silently answer about a different package.
  "coordinate" text NOT NULL,
  -- The producing COMPONENT's graph object. `service` is refused by the verb, not by this column:
  -- the refusal carries an explanation, and a CHECK could not read `objects.type_id` anyway.
  "producer_object_id" uuid NOT NULL REFERENCES objects(id),
  "declared_at" timestamp with time zone DEFAULT now() NOT NULL,
  -- Principle 6. Stamped from the AUTHENTICATED SUBJECT at the route, never from the request body.
  "declared_by_object_id" uuid NOT NULL REFERENCES objects(id),
  -- ONE declaration per coordinate. This refuses to represent "we produce @acme/lib@2, upstream
  -- produces @acme/lib@1" — a shape that means a public index legitimately answers for a coordinate
  -- the org also publishes, i.e. dependency confusion with a data model behind it.
  CONSTRAINT "dependency_line_producers_pk" PRIMARY KEY ("org_id","ecosystem","coordinate")
);
--> statement-breakpoint

-- "Which coordinates does component X produce?" — the FIRST hop of M21.4's internal-release
-- derivation, replacing the partial `dependency_lines_org_producer`. The second hop is
-- `dependency_lines_identity`'s `(org_id, ecosystem, coordinate)` PREFIX, so no new index is needed
-- on `dependency_lines`. NOT partial: unlike the old column, every row here IS a declaration, so the
-- index is already proportional to the declared minority.
CREATE INDEX IF NOT EXISTS "dependency_line_producers_org_producer"
  ON "dependency_line_producers" USING btree ("org_id","producer_object_id");
--> statement-breakpoint

-- ===========================================================================================
-- BACKFILL — before 0069 drops the columns, so a declaration is never in neither place.
--
-- In production there are provably none: the writer had no non-test caller (see the header). In
-- dev databases and in any environment whose fixtures called the repo function directly there ARE
-- rows, and losing them would silently return a coordinate to public polling — the exact failure
-- direction this whole change exists to close.
--
-- COLLAPSING TO THE COORDINATE IS WHERE THE OLD GRAIN'S AMBIGUITY SURFACES. The old shape could
-- hold two majors of one coordinate declared to DIFFERENT producers. The new shape cannot, so one
-- must win, and it is chosen by `declared_at DESC` — the most recent human assertion, which is the
-- only ordering that is a statement rather than an accident of uuid generation.
-- ===========================================================================================

INSERT INTO dependency_line_producers
  (org_id, ecosystem, coordinate, producer_object_id, declared_at, declared_by_object_id)
SELECT DISTINCT ON (l.org_id, l.ecosystem, l.coordinate)
  l.org_id,
  l.ecosystem,
  l.coordinate,
  l.produced_by_object_id,
  l.produced_by_declared_at,
  l.produced_by_declared_by_object_id
FROM dependency_lines l
WHERE l.produced_by_object_id IS NOT NULL
  AND l.produced_by_declared_at IS NOT NULL
  AND l.produced_by_declared_by_object_id IS NOT NULL
ORDER BY l.org_id, l.ecosystem, l.coordinate, l.produced_by_declared_at DESC, l.id
ON CONFLICT ON CONSTRAINT dependency_line_producers_pk DO NOTHING;
--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE ON dependency_line_producers TO scp_app;
--> statement-breakpoint

ALTER TABLE dependency_line_producers ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE dependency_line_producers FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS org_isolation ON dependency_line_producers;
--> statement-breakpoint
CREATE POLICY org_isolation ON dependency_line_producers
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
--> statement-breakpoint

COMMENT ON TABLE dependency_line_producers IS
  'ADR-0032 §7e: which COMPONENT this org DECLARES it produces one coordinate. Grain is (org_id, ecosystem, coordinate) — NOT per major line: lines are minted only by a consumer''s manifest, so per-line grain left every NEW MAJOR with a NULL producer that the version poll then handed to a public index (§7b clause 1 dependency confusion). DECLARED, NEVER INFERRED: no ingestion path writes this table. A projection table rather than a graph object for a FEDERATION reason — a policy effect or a relationship would federate, and a field outpost would hold a declaration with no inventory behind it.';
--> statement-breakpoint
COMMENT ON COLUMN dependency_line_producers.declared_by_object_id IS
  'Principle 6: the principal that asserted this coordinate is ours. Stamped from the authenticated subject by routes/dependency-producers.ts and never accepted from the request body — a caller-supplied provenance label is a forgeable one.';
