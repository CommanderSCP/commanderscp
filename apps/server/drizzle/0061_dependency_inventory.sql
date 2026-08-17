-- ===========================================================================================
-- M21.2 — THE DEPENDENCY INVENTORY SUBSTRATE: `dependency_lines` + `component_dependencies`
-- (ADR-0032 §3/§4/§5/§7, proposal docs/proposals/dependency-subscriptions.md §4).
--
-- Two projection tables holding what a component's own dependency manifests DECLARE. Nothing here
-- is a graph object, nothing here is a relationship, and nothing here federates.
--
-- ===========================================================================================
-- WHY THIS IS 0061 AND NOT 0060 — a three-way collision, and what it teaches about `when`
--
-- THREE branches each took 0060 off a `main` whose highest was 0059 — this one,
-- `0060_remove_initiative` (UI branch) and `0060_domain_local_inherited_from` (M20.7). Each checked
-- the highest number correctly and each still collided, because the number was free when they looked
-- and taken by the time they merged. Git does NOT flag it: the filenames differ, so both files simply
-- arrive and `meta/_journal.json` ends up with two entries at one `idx`. Only `db/journal-ordering.test.ts`
-- catches it, and only after the merge produces the broken file.
--
-- M20.7 merged first and kept 0060, so this became 0061 at that merge — NOT at branch time. The
-- number is contested until the merge lands, which is precisely why it is resolved here rather than
-- reserved earlier.
--
-- THE `when` IS THE HALF THAT BITES, AND IT CANNOT BE CHOSEN AT BRANCH TIME. drizzle gates on `when`
-- alone (`idx` orders the array; it decides nothing — see journal-ordering.test.ts's header), and it
-- SILENTLY SKIPS an entry whose `when` does not exceed what a database has already applied. No error,
-- no warning; the failure surfaces later as a missing table.
--
-- This entry's original `when` was 1788036400000 — BYTE-IDENTICAL to the UI branch's, because both
-- derived it by adding the customary +10,000,000 ms to 0059. Two branches doing correct arithmetic
-- from the same parent produce the same answer. M20.7 dodged that by picking a deliberately odd
-- offset (1788039137000), which protected it only in the direction where it merged SECOND; once it
-- merged FIRST, every database applied it, and any lower `when` behind it became unapplyable.
--
-- The rule that survives all three cases: **a `when` is only correct relative to what a database has
-- actually applied, so it can only be finalised at MERGE time.** Renumbering is therefore always a
-- two-field edit — bump `idx` AND `when` — and the check is "strictly greater than every entry now
-- ahead of it", never "different from them". This file's 1788059137000 was set against main's actual
-- max at merge (1788039137000), read from `origin/main`, not inferred.
--
-- Note what the test does NOT cover: it guards the FILE, so fresh databases and main-line CI are
-- safe. A long-lived dev instance that applied a BRANCH migration before the merge order settled is
-- outside it — for those, read `drizzle.__drizzle_migrations` directly and compare its max
-- `created_at` against this entry's `when`.
--
-- ===========================================================================================
-- WHY TABLES AND NOT THE GRAPH — a scoped, deliberate bend of charter principle 2
--
-- ADR-0032 §3 records this as a bend, not an oversight, on four things measured at HEAD 2026-08-13:
--
--   1. URNs CANNOT REPRESENT A PACKAGE COORDINATE. `graph/urn.ts:6-14` lowercases and
--      hyphenate-collapses every non-alphanumeric run, so `@acme/lib`, `acme/lib` and `acme-lib`
--      all slug to `acme-lib` and collide into ONE urn — a 409 with no auto-suffix and no
--      upsert-by-coordinate. See "THE COORDINATE IS NOT A URN" below; the unique index on this
--      table is the direct consequence.
--   2. WRITE AMPLIFICATION. Every object/relationship write takes two per-org
--      `pg_advisory_xact_lock`s held to commit plus an Ed25519 signature per journal row. Bulk
--      dependency ingestion through that path serialises every other write in the org.
--   3. A NEW BUILT-IN TYPE CAN WEDGE A FEDERATION CHANNEL mid-fleet-upgrade — `federation/
--      import-repo.ts`'s `object_upsert` branch has no try/catch and `createObject` 404s on a type
--      the outpost has not registered yet, so one such object aborts the whole signed bundle.
--      THIS MIGRATION ADDS NO OBJECT TYPE AND NO RELATIONSHIP TYPE, deliberately (the open
--      importer-tolerance question is proposal §10 Q6, and it stays out of this increment's way).
--   4. This is derived, per-domain, HIGH-CHURN OBSERVATION data — the same category
--      `change_source_events` and `object_health` already occupy, both of which are tables.
--
-- THE BOUNDARY THAT JUSTIFIES ALL OF THAT (ADR-0032 §3, load-bearing): nothing in the dependency
-- path may expose a TRANSITIVE TRAVERSAL. The moment it does, the graph representation becomes
-- necessary again and reason 2's measurement applies. Both queries this feature needs are
-- single-hop index lookups and the two indexes below are exactly those two lookups:
--     "what does component C declare?"  -> the primary key's (org_id, component_object_id) prefix
--     "which components declare line L?" -> `component_dependencies_org_line`
-- Neither is a recursive CTE. The repo's own load test measured `impact-of`'s recursive CTE at 7+
-- minutes then disk exhaustion at fan-out 8-14, against a 5s production `statement_timeout`.
--
-- ===========================================================================================
-- DIRECT DECLARED DEPENDENCIES ONLY (ADR-0032 §4)
--
-- `component_dependencies` holds what a manifest DECLARES. The transitive closure is NOT stored
-- and no column here can hold one: ADR-0013 keeps SBOM bytes out of SCP deliberately, and a stored
-- closure is an SBOM by another name. Row counts stay at roughly components x direct-deps.
--
-- ===========================================================================================
-- NO `depends_on` EDGE IS MINTED, EVER (ADR-0032 §5)
--
-- `depends_on` is endpoint-constrained to service|component -> service|component
-- (0002_rls_rbac_seed.sql:181-183) and is SIMULTANEOUSLY the wave-plan toposort input, the
-- `impact-of`/`blast-radius` default relType, and the `stageDependencies` materialisation target
-- (0054:9,27; 0055:92). A cycle among co-placed targets is a HARD plan-compile error, and package
-- dependency graphs routinely contain cycles. Package dependencies therefore live here and only
-- here; the plan compiler's toposort cannot see them because there is nothing for it to see.
-- Pinned by `dependencies/dependency-inventory.integration.test.ts`.
--
-- ===========================================================================================
-- THE COORDINATE IS NOT A URN, AND THAT IS THE POINT
--
-- `coordinate` is the ECOSYSTEM-NATIVE string, stored VERBATIM, byte-for-byte, case preserved:
--     npm     `@acme/lib`            (scoped) or `lib`
--     go      `github.com/acme/lib`  (module path, case-sensitive by spec)
--     maven   `com.acme:lib`         (groupId:artifactId)
--     python  `acme-lib`             (the distribution name as written)
--     oci     `docker.io/library/alpine`
-- It is NEVER slugified and never round-tripped through `deriveUrn`. `(org_id, ecosystem,
-- coordinate, major)` is the identity, so `@acme/lib` and `acme-lib` are two rows in two
-- ecosystems' worth of ways to be different packages — which they are.
--
-- `major` is `text`, not an integer, for the same "ecosystem-native" reason: Go spells it `v2`,
-- an image line is `3.18` as often as `3`, and Maven lines are not always numeric. Parsing it into
-- a number here would be the same lossy normalisation the URN scheme performs.
--
-- ===========================================================================================
-- OCI: A MUTABLE TAG IS NOT AN IDENTITY (ADR-0032 §7)
--
-- Image tags are not semver — `1.2.3`, `1.2.3-alpine`, `1.2`, `latest` and date stamps all coexist,
-- and a registry has no notion of a major line. So an `oci` line carries `tag_pattern` (the
-- extractor's pattern; tags that do not parse are SKIPPED, never guessed) and both sides carry a
-- digest: `dependency_lines.latest_digest` is the bytes the line's head resolves to, and
-- `component_dependencies.resolved_digest` is the bytes the component is actually on. "We are on
-- 1.2.3" is then a statement about bytes rather than about a label someone can repoint.
--
-- ===========================================================================================
-- INTERNAL vs THIRD-PARTY IS DECLARED, NEVER INFERRED (ADR-0032 §7, ADR-0030 §2)
--
-- A line is INTERNAL iff `produced_by_object_id` names the component/service this org tracks as its
-- producer. That link is operator-DECLARED. Nothing here parses a coordinate looking for the org's
-- name, a repo prefix, or a registry host. This is the ADR-0030 §2 lesson ("read, never inferred
-- from a repo name, a target label or a branch string") and the provenance-label lesson already
-- shipped once in this repo: a label named after WHAT MATCHED goes false the moment the matcher
-- covers a second case. There is no material to infer it from anyway — SCP has no artifact name at
-- all (`ArtifactRef` is `{type, digest}`, and no `purl` exists in the tree).
--
-- TWO DIFFERENT MECHANISMS carry that rule and they are NOT equally strong. Naming which is which
-- is the point of this paragraph: an earlier draft called the CHECK "the capability is missing
-- rather than guarded", which is the comment-that-overstates class CLAUDE.md warns about — a
-- comment naming a hazard is a signal to sweep, not evidence the hazard was handled.
--
--   MISSING, not guarded (the strong half, and it is not this constraint): the INGESTION verb has
--   no producer field to set. `UpsertDependencyLineInputSchema` does not carry one, and
--   `upsertDependencyLine`'s ON CONFLICT set cannot reach `produced_by_*` at all
--   (`src/dependencies/dependency-inventory-repo.ts`). A manifest-parsing path that "worked out" a
--   producer has nowhere to put it without deliberately calling a different verb. This is the shape
--   0059 used for `objects.domain_local`.
--
--   GUARDED, not missing (this CHECK): it refuses a HALF-WRITTEN row — a producer link with no
--   declaration timestamp, or none of the declaring principal — from raw SQL, a psql session, or a
--   future verb that forgets one of the three columns. It does NOT stop
--   `declareDependencyLineProducer` from being called by machinery rather than a human: that verb
--   unconditionally stamps all three columns, so the CHECK never fires on it. "A HUMAN asserted
--   this" is a property of that verb's CALL SITES and of whatever authz an M21.3 route puts in
--   front of it — never of this constraint.
--
-- ===========================================================================================
-- RLS AND GRANTS — mirrored from 0007_change_coordination.sql §7/§8, EXACTLY
--
-- Both tables are ordinary tenant data: `org_id NOT NULL` (DESIGN §4.2), the identical
-- `org_isolation` policy shape with both USING and WITH CHECK, ENABLE + FORCE. A dependency
-- inventory is a map of an org's entire software estate; getting this wrong leaks one org's estate
-- to another, so it is copied verbatim rather than re-derived.
--
-- Two structural barriers apply, and they cover DIFFERENT references — the scope is the load-bearing
-- part, so it is stated rather than summarised:
--   1. RLS WITH CHECK pins a row's OWN `org_id` to the session GUC, on both tables.
--   2. `component_dependencies_line_fk` is a COMPOSITE `(org_id, line_id)` foreign key into
--      `dependency_lines (org_id, id)` — so a row cannot point at another org's LINE even though
--      the session passes barrier 1 for its own org.
--
-- BARRIER 2 COVERS `line_id` AND NOTHING ELSE. The three `objects(id)` references here —
-- `component_dependencies.component_object_id`, `dependency_lines.produced_by_object_id` and
-- `dependency_lines.produced_by_declared_by_object_id` — are plain, ORG-UNBOUND
-- `REFERENCES objects(id)`, the form `changes.object_id` already uses, because `objects` carries no
-- `(org_id, id)` unique constraint to hang a composite key on and this migration changes no existing
-- table. Two consequences follow, and both are recorded by a test rather than left to be discovered
-- ("cross-org OBJECT references are not structurally prevented" in
-- `src/dependencies/dependency-inventory.integration.test.ts`):
--   - a session in org B CAN write a row stamped `org_id = B` whose `component_object_id` is one of
--     org A's objects. RI triggers are not subject to RLS, so the foreign-key check sees org A's row
--     and passes; RLS never looks at the referenced table.
--   - which makes FK-violation-vs-success an EXISTENCE ORACLE for another tenant's object ids, to
--     anything that already holds a raw `scp_app` connection and can set the GUC.
-- Neither is reachable through the public API today — M21.2 is substrate and there is no route yet.
-- The mitigation an M21.3 route OWES is to resolve every caller-supplied object id under the
-- CALLER'S OWN org before it reaches this table. Do not read barriers 1+2 as having done that.
--
-- DELETE is granted on `component_dependencies` and NOT on `dependency_lines`, deliberately:
-- a manifest that drops a dependency must be able to prune its projection row (the precedent is
-- 0050, which added source_mappings' DELETE grant for exactly this "the declaration went away"
-- reason), whereas a LINE is the identity a dependency subscription is written against. Deleting
-- one would silently orphan the subscription that references it, so lines are append-and-observe.
-- ===========================================================================================

CREATE TABLE IF NOT EXISTS "dependency_lines" (
  "id" uuid PRIMARY KEY NOT NULL,
  "org_id" uuid NOT NULL,
  -- npm|go|maven|python|oci. PLAIN text with NO pg enum and NO CHECK, matching `source_mappings.type`
  -- and `scanner_assignments.executor_type`: the closed value set is enforced in packages/schemas
  -- (Zod, `DependencyEcosystemSchema`), so adding a sixth ecosystem is a schema-package edit rather
  -- than a migration.
  "ecosystem" text NOT NULL,
  -- The ecosystem-native coordinate, VERBATIM. See "THE COORDINATE IS NOT A URN" above.
  "coordinate" text NOT NULL,
  -- The major line this row is the identity of, as the ecosystem spells it (`1`, `v2`, `3.18`).
  "major" text NOT NULL,
  -- `oci` only: the tag shape whose parsed version the line follows. NULL for the four language
  -- ecosystems, where the version grammar is the ecosystem's own.
  "tag_pattern" text,
  -- DECLARED internal-producer link. NULL = third-party. See "INTERNAL vs THIRD-PARTY" above.
  "produced_by_object_id" uuid REFERENCES objects(id),
  "produced_by_declared_at" timestamp with time zone,
  -- WHO asserted it (principle 6). Carries `REFERENCES objects(id)` and is part of the CHECK below,
  -- because the COMMENT on this column promises "which human asserted this line is internal?" is
  -- answerable: without both, a producer link could persist beside a NULL principal or a fabricated
  -- uuid and every constraint would still pass, leaving the promise false. Org-unbound, like the two
  -- other `objects(id)` references here — see barrier 2's scope note in the header.
  "produced_by_declared_by_object_id" uuid REFERENCES objects(id),
  -- The head of the line as last OBSERVED. Written by M21.4 detection, never by ingestion of a
  -- component's manifest — a component declaring `1.2.0` says nothing about what the line's head is.
  -- NULL means "not yet observed", which is NOT "no newer version exists": absent never means zero,
  -- the same reading `scan_requirement_floors` established for its nullable ceilings.
  "latest_version" text,
  -- `oci`: the digest `latest_version`'s tag resolved to when it was observed (a tag is not an
  -- identity). NULL for the language ecosystems.
  "latest_digest" text,
  "latest_observed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  -- The composite-FK target for `component_dependencies` (see barrier 2 in the header). Redundant
  -- with the primary key for uniqueness purposes; it exists so a `(org_id, id)` foreign key has
  -- something to reference.
  CONSTRAINT "dependency_lines_org_id_key" UNIQUE ("org_id", "id"),
  -- The producer link, its declaration timestamp and its declaring principal exist TOGETHER or not
  -- at all: all three NULL (third-party) or all three set (declared internal). The third conjunct is
  -- not decoration — without it a link could be stored with a NULL principal, which is precisely the
  -- state that makes `produced_by_declared_by_object_id`'s COMMENT untrue. See the header for what
  -- this constraint does and does not buy (it refuses a half-write; it does not make the writer a
  -- human).
  CONSTRAINT "dependency_lines_internal_is_declared"
    CHECK (
      ("produced_by_object_id" IS NULL) = ("produced_by_declared_at" IS NULL)
      AND ("produced_by_object_id" IS NULL) = ("produced_by_declared_by_object_id" IS NULL)
    )
);
--> statement-breakpoint

-- THE identity of a line. `@acme/lib` and `acme-lib` are DIFFERENT rows here and identical URNs
-- under `deriveUrn` — that difference is the whole reason this is a table (ADR-0032 §3, Context 2).
CREATE UNIQUE INDEX IF NOT EXISTS "dependency_lines_identity"
  ON "dependency_lines" USING btree ("org_id","ecosystem","coordinate","major");
--> statement-breakpoint

-- "Which lines does component X publish?" — the M21.4 internal-detection derivation, which runs
-- once per accepted prod change and needs the producer's lines, not a scan of every line in the org.
-- PARTIAL over the declared minority: internal lines are the exception, third-party the rule, so
-- this stays proportional to the exception instead of to the table (0059's partial index, same
-- reasoning).
CREATE INDEX IF NOT EXISTS "dependency_lines_org_producer"
  ON "dependency_lines" USING btree ("org_id","produced_by_object_id")
  WHERE "produced_by_object_id" IS NOT NULL;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "component_dependencies" (
  "org_id" uuid NOT NULL,
  -- Keyed by the COMPONENT'S GRAPH OBJECT ID, the same "thin projection table that references its
  -- graph object" pattern `changes.object_id`, `object_health` and `freezes.scope_object_id` use
  -- (DESIGN §4.1). The component stays a first-class graph object; only this projection is tabular.
  "component_object_id" uuid NOT NULL REFERENCES objects(id),
  "line_id" uuid NOT NULL,
  -- The manifest this declaration was read out of, repo-relative (`package.json`, `go.mod`,
  -- `services/api/Dockerfile`). Part of the key: one component can legitimately declare the same
  -- line from two manifests (two Dockerfiles, a root and a workspace package.json), and collapsing
  -- them would make a prune of one silently delete the other's declaration.
  "manifest_path" text NOT NULL,
  -- What the manifest LITERALLY says: `^1.2.3`, `~=1.4`, `v1.2.3`, `3.18-alpine`. Kept verbatim
  -- because it is the string the M21.5 actuator has to edit, and a normalised copy of it would be
  -- an edit target that does not appear in the file.
  "declared_version" text NOT NULL,
  -- The concrete version parsed OUT of `declared_version`, or NULL when the declaration pins none
  -- (an open range). Derived from the MANIFEST ALONE — no lockfile is read and no package manager
  -- is run, which is ADR-0032 §8's manifest-only scope boundary, stated here rather than discovered
  -- later. NULL therefore means "the manifest does not pin one", never "we could not be bothered".
  "resolved_version" text,
  -- `oci`: the digest this component's `FROM` currently resolves to. See "A MUTABLE TAG IS NOT AN
  -- IDENTITY" above.
  "resolved_digest" text,
  -- The git ref the manifest was read at (`refs/heads/main`), so a declaration is attributable to a
  -- point in the repo rather than to "whenever we last looked".
  "observed_ref" text,
  "observed_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  -- `org_id` LEADS the key so the primary key index IS the forward lookup ("what does component C
  -- declare?", always org-scoped) and no second index is needed for it.
  CONSTRAINT "component_dependencies_pk"
    PRIMARY KEY ("org_id","component_object_id","line_id","manifest_path"),
  -- Barrier 2 (see header): a row cannot reference another org's line.
  CONSTRAINT "component_dependencies_line_fk"
    FOREIGN KEY ("org_id","line_id") REFERENCES "dependency_lines" ("org_id","id")
);
--> statement-breakpoint

-- The REVERSE lookup — "which components declare line L?" — which is the fan-out list a dependency
-- subscription resolves against. Single-hop, one index descent; deliberately not a traversal.
CREATE INDEX IF NOT EXISTS "component_dependencies_org_line"
  ON "component_dependencies" USING btree ("org_id","line_id");
--> statement-breakpoint

-- ===========================================================================================
-- Grants — mirrors 0007 §7. DELETE on the projection only; see the header for why lines have none.
-- ===========================================================================================

GRANT SELECT, INSERT, UPDATE ON dependency_lines, component_dependencies TO scp_app;
--> statement-breakpoint
GRANT DELETE ON component_dependencies TO scp_app;
--> statement-breakpoint
-- Explicit and intentionally redundant (0035 uses the same belt-and-braces form): a future
-- migration that blanket-grants on this schema should have to step over this line to break the
-- "lines are append-and-observe" property.
REVOKE DELETE ON dependency_lines FROM scp_app;
--> statement-breakpoint

-- ===========================================================================================
-- RLS — the identical `org_isolation` shape as every other tenant table (0002 §2 / 0007 §8).
-- ===========================================================================================

ALTER TABLE dependency_lines ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE dependency_lines FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS org_isolation ON dependency_lines;
--> statement-breakpoint
CREATE POLICY org_isolation ON dependency_lines
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
--> statement-breakpoint

ALTER TABLE component_dependencies ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE component_dependencies FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS org_isolation ON component_dependencies;
--> statement-breakpoint
CREATE POLICY org_isolation ON component_dependencies
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
--> statement-breakpoint

COMMENT ON TABLE dependency_lines IS
  'ADR-0032 §3: the identity of ONE MAJOR LINE of one dependency. A projection table, not a graph object — package coordinates are not representable as URNs (graph/urn.ts collapses @acme/lib and acme-lib to one slug). Identity is (org_id, ecosystem, coordinate, major); the coordinate is stored ecosystem-native and verbatim. Does NOT federate; each domain derives its own.';
--> statement-breakpoint
COMMENT ON COLUMN dependency_lines.produced_by_object_id IS
  'ADR-0032 §7: the component/service this org DECLARES produces this line. NULL = third-party. Operator-declared, NEVER inferred from a coordinate, repo name or registry host (ADR-0030 §2). What keeps inference out is that the INGESTION verb has no producer field (UpsertDependencyLineInputSchema; upsertDependencyLine cannot reach these columns) — not the CHECK, which only refuses a half-written row.';
--> statement-breakpoint
COMMENT ON COLUMN dependency_lines.produced_by_declared_by_object_id IS
  'Principle 6: the principal (graph user object) that asserted this line is internal. REFERENCES objects(id) and bound to produced_by_object_id by dependency_lines_internal_is_declared, so "which principal asserted this?" cannot be answered with NULL or with a fabricated uuid. It does NOT prove the principal was a human — that is the calling route''s authz, not this column''s.';
--> statement-breakpoint
COMMENT ON TABLE component_dependencies IS
  'ADR-0032 §4: which component DECLARES which dependency line, at which version, from which dependency manifest. DIRECT declared dependencies ONLY — never the transitive closure, which is an SBOM by another name (ADR-0013). Mints NO depends_on edge (ADR-0032 §5): that type is the wave toposort input and package graphs contain cycles. Both hot queries are single-hop index lookups; exposing a transitive traversal here would invalidate the reason this is a table at all.';
