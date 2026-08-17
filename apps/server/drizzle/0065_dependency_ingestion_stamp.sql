-- ===========================================================================================
-- M21.7 — `dependency_ingestion_stamps`: WHETHER A COMPONENT'S DEPENDENCY MANIFESTS WERE EVER READ
-- (ADR-0032 §4, the per-component half of §6's "a disabled component is never fetched").
--
-- ===========================================================================================
-- THE GAP THIS CLOSES — THREE DIFFERENT TRUTHS THAT PRODUCE THE SAME EMPTY LIST
--
-- `component_dependencies.observed_at` is PER ROW. A component with ZERO rows therefore carries no
-- timestamp anywhere, and these three states are INDISTINGUISHABLE from the data:
--
--   1. never ingested — it has not released since it was enabled, and no backfill has reached it;
--   2. ingested, successfully, and it genuinely declares nothing;
--   3. ingestion RAN and every manifest was unreadable (a 404 body, an LFS pointer, a truncated
--      response, no git binding for the repo).
--
-- The ingestion has always COMPUTED which of the three it is — `ingestComponentManifests` returns a
-- verdict, a per-manifest skip reason and a detail for each, `POST /dependencies/inventory/backfill`
-- reports them per component and the loop logs them — and NOTHING PERSISTED IT. So a reader coming
-- to the table later has only the absence of rows to go on, and any UI over it is forced to render
-- "no dependencies" across all three. State 3 rendered as state 2 is a lie told with a straight
-- face: the component is silently unsubscribed from everything it declares
-- (`listSubscribedComponentLines` derives subscription from those rows) and the screen says it has
-- no dependencies.
--
-- This table is the ingestion's own receipt: one row per component, restated on every pass.
--
-- ===========================================================================================
-- "NEVER ATTEMPTED" IS THE ABSENCE OF A ROW — NEVER A VALUE
--
-- There is deliberately no `outcome = 'never'`. A value would have to be WRITTEN by something, and
-- the only honest writer of "we have never looked at this component" is a pass that ran — which is
-- a contradiction. So state 1 above is the missing row, and that is also why `scp_app` holds NO
-- DELETE grant here (see the grants section): deleting a stamp does not clear a fact, it FABRICATES
-- "never attempted" for a component that was attempted.
--
-- ===========================================================================================
-- WHY `rows_written` IS NOT NULLABLE AND WHY 0 IS THE INTERESTING VALUE
--
-- `outcome = 'ok'` with `rows_written = 0` is precisely state 2 — "we read this component's
-- manifests, and it genuinely declares nothing" — which is the state that cannot be expressed at
-- all today. It is the reason this table exists, so the column that carries it is NOT NULL and 0 is
-- a first-class value rather than an absence.
--
-- ===========================================================================================
-- WHY `manifests` IS PER PATH AND NOT A SUMMARY COUNT
--
-- `manifest_path` is part of `component_dependencies`' PRIMARY KEY precisely because one component
-- legitimately declares from several manifests (two Dockerfiles; a root and a workspace
-- `package.json`; a `go.mod` beside a `Dockerfile`). The MIXED case — one manifest read, another
-- unreadable — is therefore ordinary rather than hypothetical, and it is the case a summary count
-- cannot describe: "1 of 2 manifests unreadable" does not tell an operator WHICH file to go and
-- fix, and the path is the only actionable half. That is the same argument
-- `candidateManifestPaths` already makes for reporting `read_budget_exhausted` BY NAME.
--
-- `outcome = 'partial'` exists for exactly that mixed case.
--
-- ===========================================================================================
-- WHY A TABLE AND NOT A DECISION ROW
--
-- The ingestion already persists a Decision (`dependency_inventory_ingestion`) and it is the wrong
-- instrument for this, in both directions:
--
--   - IT IS NOT WRITTEN ON THE REFUSED PATHS. A component that is not enabled, or that has no
--     addressable repository, writes NO Decision — deliberately, because a row per accepted change
--     per unsubscribed component is write amplification with nothing to learn from row 2 onward.
--     Those are exactly the components whose empty list needs explaining.
--   - IT IS PERSIST-ON-CHANGE AND CARRIES NO TIME. `insertDecisionIfChanged` writes only when the
--     content moves, and the content deliberately excludes the ref, the commit and every timestamp
--     (ADR-0024's 1.44 GB/day shape). "When did we last look?" is therefore unanswerable from it BY
--     DESIGN, and answering it there would re-open exactly the growth the guard closed.
--
-- A stamp is one UPSERTED row per component. The table's size is bounded by the component count and
-- does not grow with the event rate, which is the property ADR-0024 is about — an update per
-- accepted change costs a dead tuple that autovacuum reclaims, never an appended row.
--
-- ===========================================================================================
-- WHY 0065, AND THE `when`
--
-- 0064 is main's highest at the time this branch merges; its `when` is 1788089137000 and this
-- entry's is 1788115137000 — STRICTLY GREATER, which is the only comparison drizzle makes. It gates
-- on `when` alone and SILENTLY SKIPS an entry whose `when` does not exceed what a database has
-- already applied (no error, no warning; the failure surfaces later as a missing table). 0061's
-- header records the three-way collision that taught this, and `db/journal-ordering.test.ts` guards
-- the file. This `when` sits inside a block claimed for this branch (1788110000000-1788119999999)
-- and above a peer branch's highest in-flight value, so a merge in either order still applies.
--
-- ===========================================================================================
-- RLS AND GRANTS — mirrored from 0061, which mirrored 0007 §7/§8
--
-- Ordinary tenant data: `org_id NOT NULL` (DESIGN §4.2), the identical `org_isolation` policy shape
-- with BOTH `USING` and `WITH CHECK`, ENABLE + FORCE. A stamp names a component and describes its
-- source layout; getting this wrong leaks one org's estate to another.
--
-- THERE IS NO COMPOSITE FOREIGN KEY HERE, AND THAT IS A FINDING RATHER THAN AN OMISSION.
-- `component_dependencies` carries one — `(org_id, line_id)` into `dependency_lines (org_id, id)` —
-- because a row of it points at a LINE, and 0061 gave `dependency_lines` a `(org_id, id)` UNIQUE
-- constraint expressly so a composite key had something to reference. This table has no `line_id`
-- and no reference to any org-scoped table: its ONLY reference is `component_object_id ->
-- objects(id)`, and `objects` carries NO `(org_id, id)` unique constraint to hang a composite key
-- on. So it takes the same plain, ORG-UNBOUND `REFERENCES objects(id)` form that
-- `component_dependencies.component_object_id` and `changes.object_id` already use, and it inherits
-- 0061's barrier-2 residue verbatim:
--   - a session in org B CAN write a row stamped `org_id = B` whose `component_object_id` is one of
--     org A's objects (RI triggers are not subject to RLS), and
--   - FK-violation-vs-success is therefore an EXISTENCE ORACLE for another tenant's object ids to
--     anything already holding a raw `scp_app` connection that can set the GUC.
-- Unreachable through the public API: this table has no route, no IaC type and no federation
-- importer. The mitigation any future read route OWES is to resolve a caller-supplied component id
-- under the CALLER'S OWN org before it reaches this table. Do not read RLS as having done that.
--
-- NO DELETE GRANT — see "NEVER ATTEMPTED IS THE ABSENCE OF A ROW" above. Same shape as 0061's
-- `dependency_lines` and 0064's authorships.
-- ===========================================================================================

CREATE TABLE IF NOT EXISTS "dependency_ingestion_stamps" (
  "org_id" uuid NOT NULL,
  -- The component this stamp is about, by its GRAPH OBJECT ID — the same "thin projection table
  -- that references its graph object" pattern `component_dependencies.component_object_id` uses.
  -- Org-unbound `REFERENCES objects(id)`; see the header for the scope of that.
  "component_object_id" uuid NOT NULL REFERENCES objects(id),
  -- WHEN THIS PASS LOOKED at the component — the phase-2 read time on the paths that read, and the
  -- moment the pass started on the paths that refused before reaching a provider. Deliberately not
  -- the write time: it is the same clock `component_dependencies.observed_at` is stamped from, so
  -- the stamp and the rows a pass wrote describe the same instant and two overlapping passes order
  -- identically here and there.
  "last_attempt_at" timestamp with time zone NOT NULL,
  -- WHICH PRODUCER WROTE THIS STAMP: `loop` (the event-driven ingestion, reacting to an accepted
  -- change) or `backfill` (an operator running POST /dependencies/inventory/backfill). It answers
  -- "is this component's inventory maintained by its own releases, or only by whoever last ran a
  -- backfill?" — two very different degrees of freshness behind the same timestamp.
  --
  -- PLAIN text with NO pg enum and NO CHECK, matching `dependency_lines.ecosystem`,
  -- `source_mappings.type` and `scanner_assignments.executor_type`. The closed set is enforced in
  -- TypeScript at the ONE write door (`recordIngestionStamp`, whose parameter is a union type), and
  -- the value is a REQUIRED input of `ingestComponentManifests` — so a third producer cannot
  -- silently inherit a wrong label, it does not compile until it names itself. That is the property
  -- that matters; a CHECK would only add a second place to edit.
  "source" text NOT NULL,
  -- WHAT THIS PASS ESTABLISHED about the component's manifests:
  --   `ok`           every manifest this pass had evidence about was read and parsed. With
  --                  `rows_written = 0` this is "genuinely declares nothing" — the state that was
  --                  impossible to express before this table.
  --   `partial`      at least one manifest was read AND at least one could not be. The mixed case;
  --                  `manifests` names which is which.
  --   `unreadable`   nothing was read: every candidate failed, or there was no addressable
  --                  repository to read from at all.
  --   `not_enabled`  the enablement gate was closed, so NOTHING WAS FETCHED (ADR-0032 §6). The
  --                  empty list is correct and is not evidence about the component's manifests.
  -- Same plain-text treatment and same reasoning as `source`.
  "outcome" text NOT NULL,
  -- The one-sentence explanation behind `outcome`, as the ingestion itself worded it — why the gate
  -- was closed, which repository has no mapping, that no repository was named at all. Nullable
  -- because the ordinary `ok` pass has nothing to add beyond `manifests`. It exists because
  -- `manifests` is keyed BY PATH and the refusals that matter most have no path: "there is no
  -- repository to read this component's manifests from" cannot be said in a per-path array.
  "detail" text,
  -- HOW MANY `component_dependencies` ROWS THIS PASS WROTE. NOT NULL, and 0 is legal and meaningful
  -- — see the header. Counts what was upserted (a re-observation of an unchanged declaration
  -- counts), never what was pruned: this describes the observation, not the delta.
  "rows_written" integer NOT NULL,
  -- PER MANIFEST PATH: `[{path, outcome: 'ok'|'unreadable'|'unsupported', detail?}]`, sorted by
  -- path. See the header for why this is per path rather than a count. `unsupported` is the file
  -- SCP structurally cannot read (no parser registered for that filename in this build, an LFS
  -- pointer, a directory, a binary, an encoding the decoder does not implement) as distinct from
  -- `unreadable`, which is a read or a parse that failed THIS TIME and may succeed on the next
  -- pass. The two carry different operator actions, which is the whole test for whether a reason
  -- deserves its own name (ADR-0032 §7b clause 6).
  --
  -- Empty array, never NULL: "this pass named no manifests" is a fact and `[]` states it.
  "manifests" jsonb DEFAULT '[]'::jsonb NOT NULL,
  -- When this component was FIRST attempted. Distinct from `last_attempt_at` and not derivable from
  -- it: "enabled months ago, attempted once, never since" and "attempted for the first time an hour
  -- ago" are different operational stories behind the same last-attempt timestamp.
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  -- ONE ROW PER COMPONENT. `org_id` LEADS so the primary-key index IS both reads: the point lookup
  -- ("what happened to component C?") and the batched one a list view takes over many components at
  -- once. No second index exists because there is no second access path.
  CONSTRAINT "dependency_ingestion_stamps_pk" PRIMARY KEY ("org_id","component_object_id")
);
--> statement-breakpoint

-- ===========================================================================================
-- Grants — SELECT/INSERT/UPDATE, and deliberately NO DELETE (see the header).
-- ===========================================================================================

GRANT SELECT, INSERT, UPDATE ON dependency_ingestion_stamps TO scp_app;
--> statement-breakpoint
-- Explicit and intentionally redundant (0035/0061/0064 use the same belt-and-braces form): a future
-- migration that blanket-grants on this schema has to step over this line to make "never attempted"
-- forgeable.
REVOKE DELETE ON dependency_ingestion_stamps FROM scp_app;
--> statement-breakpoint

-- ===========================================================================================
-- RLS — the identical `org_isolation` shape as every other tenant table (0002 §2 / 0007 §8 / 0061).
-- ===========================================================================================

ALTER TABLE dependency_ingestion_stamps ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE dependency_ingestion_stamps FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS org_isolation ON dependency_ingestion_stamps;
--> statement-breakpoint
CREATE POLICY org_isolation ON dependency_ingestion_stamps
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
--> statement-breakpoint

COMMENT ON TABLE dependency_ingestion_stamps IS
  'ADR-0032 §4: the dependency ingestion''s own receipt, one row per component. Exists because component_dependencies.observed_at is per ROW, so a component with no rows carries no timestamp and "never ingested", "ingested and genuinely declares nothing" and "ingestion ran and the manifests were unreadable" are indistinguishable — three truths behind one empty list. Written by both producers through ingestComponentManifests (the event-driven loop and the operator backfill). NEVER ATTEMPTED is the ABSENCE of a row, never a value, which is why there is no DELETE grant.';
--> statement-breakpoint
COMMENT ON COLUMN dependency_ingestion_stamps.rows_written IS
  'component_dependencies rows this pass upserted. 0 is legal and meaningful: outcome=''ok'' with rows_written=0 is "read fine, genuinely declares nothing", which is the state that could not be expressed before this table.';
--> statement-breakpoint
COMMENT ON COLUMN dependency_ingestion_stamps.manifests IS
  'Per manifest PATH: [{path, outcome: ok|unreadable|unsupported, detail?}]. Per path rather than a count because manifest_path is part of component_dependencies'' key — one component legitimately declares from several manifests, so the mixed case (one readable, one not) is ordinary, and "1 of 2 unreadable" does not tell an operator which file to fix.';
