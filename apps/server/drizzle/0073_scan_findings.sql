-- ===========================================================================================
-- M22.1b — `scan_findings`: the per-finding projection a scan verdict can finally be explained by
-- (ADR-0033 §7/§7a, BUILD_AND_TEST.md §8 M22.1).
--
-- Until M22.1a a scan verdict was FOUR INTEGERS: both Trivy parse sites read `.Severity`,
-- incremented a counter and discarded the vulnerability object; the raw document was then deleted.
-- M22.1a made both producers derive their counts from a shared `parseTrivyFindings`, so findings now
-- EXIST at parse time — and nothing persisted them. Every rule in ADR-0033 ("this package is at the
-- vendor's latest", "this one has no fix", "the component declared it inapplicable") is a rule ABOUT
-- A FINDING, so this table is the substrate the whole milestone queues behind.
--
-- ===========================================================================================
-- WHY A TABLE AND NOT A GRAPH OBJECT TYPE — drizzle/0061's four MEASURED tests, re-applied
--
-- ADR-0033 §11 records this as the same scoped, deliberate bend of charter principle 2 that
-- `dependency_lines`/`component_dependencies` took, on the same four grounds. Re-checked here rather
-- than cited, because a bend justified by measurement is only as good as the measurement still
-- holding:
--
--   1. THE IDENTITY IS NOT SLUGGABLE. `graph/urn.ts` lowercases and hyphenate-collapses every
--      non-alphanumeric run, so `pkg:deb/debian/libssl1.1@1.1.1n-0+deb11u5` and
--      `pkg:deb/debian/libssl1.1@1.1.1n-0-deb11u5` slug to ONE urn — and worse, a finding has NO
--      stable identity to slug at all: the same `CVE-2026-1234` legitimately appears three times in
--      one scan for three packages, and an entry may carry no `VulnerabilityID` whatsoever (see
--      `ScanFindingSchema`'s "why nearly every field is optional"). `ordinal` below is the direct
--      consequence: position within the persisted set IS the identity, because nothing else is.
--   2. WRITE AMPLIFICATION. Every object/relationship write takes two per-org
--      `pg_advisory_xact_lock`s held to commit plus an Ed25519 journal signature. A single image
--      scan yields up to `SCAN_FINDINGS_PERSIST_CAP` (2000) rows; through the graph path that is
--      2000 signed journal rows serialising every other write in the org, per scan, per gate.
--   3. A NEW BUILT-IN TYPE CAN WEDGE A FEDERATION CHANNEL mid-fleet-upgrade —
--      `federation/import-repo.ts`'s `object_upsert` branch has no try/catch and `createObject` 404s
--      on a type an outpost has not registered yet, so ONE such object aborts a peer's entire signed
--      bundle. THIS MIGRATION ADDS NO OBJECT TYPE AND NO RELATIONSHIP TYPE, deliberately.
--   4. This is derived, HIGH-CHURN OBSERVATION data — the category `change_source_events`,
--      `object_health` and `component_dependencies` already occupy, all of which are tables.
--
-- The boundary that justifies it is the same one: nothing here exposes a TRANSITIVE TRAVERSAL. The
-- only query this feature needs is "the findings of control run R", which is the primary key's own
-- prefix — one index descent, never a recursive CTE.
--
-- ===========================================================================================
-- ORDINARY TENANT DATA. NOT A TENANCY EXCEPTION (ADR-0033 §7a)
--
-- `org_id NOT NULL` under the identical `org_isolation` RLS policy every other tenant table carries
-- (0002 §2 / 0007 §7-§8 / 0061), because a finding IS tenant data: it says which CVEs one org's
-- artifacts carry. This is worth stating explicitly because M22's OTHER new storage — the
-- instance-tier exclusion ADMISSION rows of M22.2 — IS the documented DESIGN §4.2 exception
-- (`scan_requirement_floors` 0029 / `scanner_assignments` 0035: operator-write, tenant-read, no
-- `org_id`). The two land in the same milestone and must not be copied from each other. An admission
-- is an operator statement about the deployment; a finding is an observation about a tenant's
-- artifact.
--
-- TWO INDEPENDENT BARRIERS (DESIGN §4.2 "cross-tenant leakage requires two independent failures"),
-- and unlike 0061 BOTH cover this table's only outward reference:
--   1. RLS WITH CHECK pins a row's OWN `org_id` to the session GUC.
--   2. `scan_findings_control_run_fk` is a COMPOSITE `(org_id, control_run_id)` foreign key into
--      `control_runs (org_id, id)`, so a row cannot point at another org's control run even from a
--      session that passes barrier 1 for its own org. 0061 could not do this for its `objects(id)`
--      references because `objects` carries no `(org_id, id)` unique constraint; `control_runs` did
--      not either, so this migration ADDS one. It is free of ambiguity (`id` is already the primary
--      key, so `(org_id, id)` is trivially unique) and exists solely to give the composite key
--      something to reference.
--
-- ON DELETE CASCADE is deliberate and is a RETENTION statement (§7 below): findings are class O,
-- their control run is class E, so the run outlives them — but if a run is ever pruned, findings that
-- explain a verdict which no longer exists must not survive it as orphans.
--
-- ===========================================================================================
-- COMMANDER-LOCAL. OUT OF THE PROMOTION BUNDLE (ADR-0033 §8)
--
-- The bundle keeps COUNTS. `federation/promotion-repo.ts` projects `{controlUrn, status, evidence,
-- detail}` for every control run and copies `evidence` VERBATIM, so anything on that jsonb column
-- federates. Findings are therefore NOT on it — they are rows here, and the transport key a plugin
-- uses to hand them to the server is STRIPPED as it is read (`takeScanFindingsFromTransport`).
-- Nothing in this file federates, and no federation code path reads it.
--
-- ===========================================================================================
-- RETENTION IS PER ROW, NOT PER TABLE (ADR-0033 §7, owner decision D10; ADR-0024 §D1)
--
-- `retention_class` carries each row's ADR-0024 evidentiary class:
--
--   'E'  an EXCLUDED finding is ACCEPTED-RISK EVIDENCE — it explains a live verdict and records what
--        an operator chose to tolerate. Retained at least as long as its subject is live, then the
--        long configurable window.
--   'O'  an ordinary finding is TELEMETRY — bookkeeping about what a scanner saw. Short window.
--
-- This is not a new retention shape: ADR-0024 §D1 already assigns classes PER ROW rather than per
-- table, and `decisions` itself already splits across all three (P when cited or pinned, E while
-- current for its subject, O when uncited and superseded). This follows that precedent.
--
-- 'P' is deliberately NOT an accepted value. No finding is permanent evidence; the permanent record
-- of a gate verdict is the Decision and the audit event, both of which cite the control run.
--
-- WHEN THIS MIGRATION RUNS, NOTHING IS EXCLUDED YET: M22.2 (0074/0075) is the increment that
-- resolves exclusions, so every row written between the two is 'O'. The DEFAULT of 'O' outlives that
-- window and is not merely a placeholder for it — a row whose class nobody stated is telemetry, and
-- the 'E' arm is only ever reached by a writer that has an admitted clause's ordinals in hand.
-- ADR-0024 §D0 applies unchanged — a per-scan cap is not a retention story, and neither of these
-- bounds licenses write amplification.
--
-- WHAT ACTUALLY BOUNDS THIS TABLE TODAY: NOTHING BUT THE CASCADE. THE CLASS IS RECORDED, NOT
-- ACTUATED — and a reader is owed that plainly, here, rather than inferring a sweeper from the fact
-- that a column names a window.
--
-- There is no sweeper for `scan_findings`, no `boss.schedule` entry for one, and no generic retention
-- job to join: ADR-0024 designs the mechanism and its own status line records that it ships NO CODE
-- (F1-F3 carry the work). No bespoke sweeper is added here, deliberately — it would be a SECOND
-- retention mechanism landing ahead of the general one, and charter priority 7 puts Simplicity first.
-- What is done instead is to put this table inside the general one's scope before it is built:
-- ADR-0024 §D1's class assignment now names `scan_findings` explicitly, so F3 cannot land without it.
--
-- Until F3 exists the only bound is this table's own `ON DELETE CASCADE` from `control_runs`, and
-- since `control_runs` is class E, a class-O finding inherits an E LIFETIME. Every row therefore
-- currently lives as long as the evidence class above it. That is the safe direction (nothing is lost
-- early) and it is not the design; the column is an honest record of what each row IS, and is not yet
-- a statement about how long it lives.
--
-- ===========================================================================================
-- THE CAP, AND WHY TRUNCATION IS RECORDED SOMEWHERE ELSE
--
-- At most `SCAN_FINDINGS_PERSIST_CAP` (2000, packages/schemas/src/supply-chain.ts) rows land per
-- scan. M22.2 must REFUSE EVERY EXCLUSION for a truncated scan ("you cannot except what you did not
-- record"), so whether truncation happened has to be readable — and it is NOT a column here.
--
-- It lives on the control run's own `evidence.findingsRecord` (`full` | `truncated` | `unsupported`)
-- for two reasons. First, truncation is a property of the SET, not of a row; a per-row boolean
-- repeated 2000 times is a value that can disagree with itself. Second, and decisively, the ABSENCE
-- of rows is ambiguous in a way no column here can resolve: a scan with genuinely zero findings, a
-- pre-M22.1b scan that never recorded any, and an OpenSCAP verdict that structurally CANNOT have any
-- all present as "no rows". ADR-0033's consequences list requires the OpenSCAP case be explicit "and
-- tested, not left to 'there were no findings to exclude'", and only a positive marker on the
-- verdict can say it. Every marker state except `full` — including ABSENT — refuses exclusions.
-- ===========================================================================================

-- Barrier 2's reference target. `id` is already the primary key, so this adds no new uniqueness —
-- only something a composite `(org_id, control_run_id)` foreign key can name.
ALTER TABLE "control_runs"
  ADD CONSTRAINT "control_runs_org_id_key" UNIQUE ("org_id", "id");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "scan_findings" (
  "org_id" uuid NOT NULL,
  -- The scan verdict these findings decompose. A `control_runs` row is exactly one scan outcome, for
  -- one artifact digest, at one gate crossing (M22.0a made that key carry gate identity), which is
  -- precisely the unit an exclusion is resolved for.
  "control_run_id" uuid NOT NULL,
  -- POSITION within the persisted set, in the producing parser's order. This is the identity because
  -- a finding has no other one: the same CVE appears once per affected package, and an entry may
  -- carry no `VulnerabilityID` at all yet is still counted (ScanFindingSchema's optionality note —
  -- requiring identifiers would drop entries and MOVE operators' numbers).
  "ordinal" integer NOT NULL,
  -- One of the four the threshold model acts on. Trivy's `UNKNOWN` is folded away upstream and never
  -- reaches a row, exactly as it never reaches a count.
  "severity" text NOT NULL,
  -- Every attribution column is NULLABLE, for the same reason the schema field is optional: an entry
  -- is retained whenever it would have been COUNTED, on the strength of `Severity` alone. A finding
  -- with no identifier is simply one no exclusion clause can ever match — the safe direction, since
  -- an unmatchable finding still counts against the ceiling.
  "vulnerability_id" text,
  "pkg_name" text,
  "installed_version" text,
  -- ABSENT means upstream has shipped no fix. M22.3's "no fix available" class reads exactly this
  -- absence as the signal rather than inferring it from anything else.
  "fixed_version" text,
  -- Trivy `Results[].Class` — `os-pkgs` attributes a finding to the BASE IMAGE line, `lang-pkgs` to
  -- a declared manifest dependency (or to nothing, when transitive). The single field that makes
  -- M22.4's vendor rule expressible without an inventory join.
  "class" text,
  "target" text,
  -- `PkgIdentifier.PURL` VERBATIM, never normalised. The dependency inventory stores its coordinate
  -- deliberately un-normalised too, so canonicalisation belongs at the join, once, where both sides
  -- are visible — not smeared across a parser and a column.
  "purl" text,
  -- ADR-0024 §D1 class, per row (D10). See the header. DEFAULT 'O' because nothing is excluded until
  -- M22.2 exists to exclude it.
  "retention_class" text DEFAULT 'O' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  -- `org_id` LEADS, so the primary key index IS the one hot lookup ("the findings of control run R",
  -- always org-scoped) and no second index is needed.
  CONSTRAINT "scan_findings_pk" PRIMARY KEY ("org_id","control_run_id","ordinal"),
  -- Barrier 2 (see header): a row cannot reference another org's control run.
  CONSTRAINT "scan_findings_control_run_fk"
    FOREIGN KEY ("org_id","control_run_id") REFERENCES "control_runs" ("org_id","id")
    ON DELETE CASCADE,
  CONSTRAINT "scan_findings_severity_check"
    CHECK ("severity" IN ('critical','high','medium','low')),
  -- 'P' is refused: no finding is permanent evidence (header).
  CONSTRAINT "scan_findings_retention_class_check"
    CHECK ("retention_class" IN ('E','O'))
);
--> statement-breakpoint

-- ===========================================================================================
-- Grants — mirrors 0007 §7 / 0061. NO UPDATE, and its absence is a CORRECTION, not an omission.
--
-- This block previously granted UPDATE and justified it as "M22.2 promotes an EXCLUDED row from 'O'
-- to 'E' in place". THAT WAS FALSE, and it was false when it was written: M22.2 assigns the class at
-- INSERT from the ordinals the producer transported alongside the findings, and
-- `governance/scan-findings-repo.ts` says so in as many words — a two-step would leave a window in
-- which a row's class contradicts the evidence beside it, so a later UPDATE is the design's REJECTED
-- alternative rather than its plan. A filterless census of the tree finds no UPDATE against this
-- table anywhere. The privilege was granted for a consumer that does not exist and was never going
-- to, so it is not granted.
--
--   DELETE: kept, and labelled honestly rather than by implying a job. NOTHING sweeps this table
--   today (see the retention section above); this is the privilege ADR-0024 F3's generic prune will
--   need, held here so that increment does not also have to ship a migration to obtain it.
-- ===========================================================================================

GRANT SELECT, INSERT, DELETE ON scan_findings TO scp_app;
--> statement-breakpoint

-- ===========================================================================================
-- RLS — the identical `org_isolation` shape as every other tenant table (0002 §2 / 0007 §8 / 0061).
-- ===========================================================================================

ALTER TABLE scan_findings ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE scan_findings FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS org_isolation ON scan_findings;
--> statement-breakpoint
CREATE POLICY org_isolation ON scan_findings
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
--> statement-breakpoint

COMMENT ON TABLE scan_findings IS
  'ADR-0033 §7/§7a (M22.1b): the per-finding projection of ONE scan verdict (one control_runs row). Ordinary tenant data under RLS with org_id NOT NULL — NOT the DESIGN §4.2 tenancy exception that M22.2''s instance-tier admission rows are. A projection table, not a graph object type (drizzle/0061''s four measured tests): a finding has no sluggable identity, 2000 rows per scan through the graph write path is 2000 signed journal rows, a new builtin type can wedge a federation channel, and this is high-churn derived observation data. COMMANDER-LOCAL: never in a promotion bundle — the bundle keeps counts.';
--> statement-breakpoint
COMMENT ON COLUMN scan_findings.retention_class IS
  'ADR-0024 §D1 evidentiary class, assigned PER ROW (ADR-0033 D10): ''E'' = an EXCLUDED finding, accepted-risk evidence explaining a live verdict, floored retention; ''O'' = an ordinary finding, telemetry, short window. Not a new retention shape — decisions already splits per row across all three classes. ''P'' is refused: the permanent record of a verdict is the Decision and the audit event, not the finding. Every row is ''O'' until M22.2 resolves exclusions.';
--> statement-breakpoint
COMMENT ON COLUMN scan_findings.ordinal IS
  'Position within the PERSISTED set, in the producing parser''s order — the identity, because a finding has no other one (the same CVE recurs per affected package, and an entry with no VulnerabilityID is still counted). The set is capped at SCAN_FINDINGS_PERSIST_CAP; whether it was TRUNCATED is recorded on the control run''s evidence.findingsRecord, not here, because truncation is a property of the set and because the ABSENCE of rows is ambiguous (zero findings vs. a pre-M22.1b scan vs. OpenSCAP, which structurally cannot have any).';
