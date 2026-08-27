-- ===========================================================================================
-- 0096 — PIPELINE HOOKS AND THEIR EVIDENCE (team-pipeline-iac increment 8, storage layer)
--        Contract: packages/schemas/src/pipeline-behaviors.ts (D11/D12/D13/D21/D23).
--        Consumers: apps/server/src/coordination/pipeline-hook-verdicts.ts (pure verdicts).
--
-- Two ordinary per-org tenant tables (the 0071/0079/0091 shape): FORCE-RLS org isolation, `scp_app`
-- DML, hand-authored because RLS and grants are not expressible in drizzle-kit's schema diffing.
--
-- `pipeline_hooks` is the DECLARED half — what a team's manifest said must gate. `pipeline_evidence`
-- is the OBSERVED half — what actually happened, and which is allowed to say so. They are separate
-- tables because they have different authors, different lifecycles and different write doors: a hook
-- is written by IaC apply from a reviewed manifest; evidence is written by an executor observation or
-- a pushed report, at a rate nobody declares.
-- ===========================================================================================

-- ===========================================================================================
-- `pipeline_hooks` — the four declared hook kinds, one row each.
--
-- IDENTITY IS `(org_id, component_object_id, kind, hook_id)`, and that is a UNIQUE CONSTRAINT rather
-- than a convention the writer observes. `ManifestPipelineHookSchema`'s doc states it directly:
-- "IDENTITY is `(componentUrn, kind, hookId)` ... there is no update path keyed on a subset: a
-- changed hook is a delete + create, and declaring the same tuple twice in one manifest is rejected."
-- The manifest-level rejection is a plan-compile check; this constraint is the one that survives a
-- second write door being added later.
--
-- ===========================================================================================
-- NO `managed_by_stack` COLUMN, AND NONE IS EVER ADDED
-- ===========================================================================================
-- `packages/schemas/src/iac.ts` settles this for the whole family of per-object configuration
-- tables, and a hook is one: "OWNERSHIP IS DERIVED FROM THE OWNING OBJECT ... neither table has a
-- `labels` column, and neither gets one. A row belongs to stack S iff the graph object it hangs off
-- (`component_object_id` / `target_object_id`) is one THIS stack owns."
--
-- `source_mappings` and `executor_bindings` are the two precedents, and this table joins them for the
-- same reason rather than by analogy: a stack-label column is a SECOND answer to "who owns this row",
-- and the moment it can disagree with the first one (the owning object's ownership), a plan's prune
-- set and its apply's prune set are computed from different facts. Deriving it means an adopted
-- component brings its hooks with it WHOLESALE — visible as `delete` entries in the plan the operator
-- reviews, never silent.
--
-- The nullable columns are per-kind and deliberately not split into four tables: `workflow` is NULL
-- exactly on `bakeAlarms` (which "triggers nothing, so it carries no `workflow`"), `every_seconds` /
-- `max_age_seconds` are `continuous`-only, `quiet_window_seconds` is `bakeAlarms`-only, and `stage` is
-- `postDeploy`/`bakeAlarms`-only. The closed per-kind shape is enforced by the Zod discriminated
-- union at every write door; a CHECK matrix here would be a second, driftable copy of it.
-- ===========================================================================================

CREATE TABLE IF NOT EXISTS "pipeline_hooks" (
  "id" uuid PRIMARY KEY,
  "org_id" uuid NOT NULL,
  -- The component whose pipeline declares this hook. Org-unbound `REFERENCES objects(id)`, the form
  -- `changes.object_id` (0007) and `dependency_lines`/`bump_authorship` (0061/0064/0065) already use.
  -- This is ALSO the ownership pointer: which stack owns this row is answered by asking which stack
  -- owns THIS object (see the header) — there is no second column that could disagree.
  "component_object_id" uuid NOT NULL REFERENCES objects(id),
  -- 'postMerge' | 'postDeploy' | 'continuous' | 'bakeAlarms'. Plain text, no pg enum and no CHECK —
  -- the same treatment `source_mappings.type` and `executor_bindings.type` get, and for the same
  -- reason: the closed set lives ONCE, in `PipelineHookKindSchema` (packages/schemas), and every
  -- write door parses through it. A duplicate here would be a second definition to keep in step.
  "kind" text NOT NULL,
  -- D16(6)'s CDK deviation made concrete: defaulted at synth to the construct kind, ALWAYS explicit
  -- on the wire, and typed only when an author declares same-kind siblings on one component.
  "hook_id" text NOT NULL,
  -- `WorkflowRefSchema` — (repo, branch, path, templateName?). NULL on `bakeAlarms` only.
  "workflow" jsonb,
  -- `postDeploy` / `bakeAlarms`. NULL = EVERY wave, which is the STRICT end of the range: "adding a
  -- `stage` REMOVES gates, it does not add one" (ManifestPostDeployHookSchema). Operator vocabulary
  -- (D6) — SCP never enforces the value set.
  "stage" text,
  -- `continuous` only. DESCRIPTIVE: Argo runs the cron, SCP does not schedule it. Carried so render
  -- can show cadence beside freshness window.
  "every_seconds" integer,
  -- `continuous` only, and REQUIRED there. Evidence older than this reads as ABSENT — not
  -- stale-pass, not fail (`ManifestContinuousHookSchema`; `evaluateContinuousHold`).
  "max_age_seconds" integer,
  -- `bakeAlarms` only. How long a target must stay alarm-free after ITS deploy before the wave may
  -- exit (`evaluateBakeGate`'s `quietWindowSeconds`).
  "quiet_window_seconds" integer,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "pipeline_hooks_identity" UNIQUE ("org_id", "component_object_id", "kind", "hook_id")
);
--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE ON pipeline_hooks TO scp_app;
--> statement-breakpoint

ALTER TABLE pipeline_hooks ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE pipeline_hooks FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS org_isolation ON pipeline_hooks;
--> statement-breakpoint
CREATE POLICY org_isolation ON pipeline_hooks
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
--> statement-breakpoint

COMMENT ON TABLE pipeline_hooks IS
  'team-pipeline-iac D11/D21: the four declared test hooks (postMerge|postDeploy|continuous|bakeAlarms) per component. Identity is (org_id, component_object_id, kind, hook_id) — no update path keyed on a subset. NO managed_by_stack column: ownership is DERIVED from component_object_id, exactly as for source_mappings and executor_bindings (packages/schemas/src/iac.ts).';
--> statement-breakpoint

-- ===========================================================================================
-- `pipeline_evidence` — what actually happened, and WHO SAID SO.
--
-- ===========================================================================================
-- `source` AND `producer_subject_id` ARE SERVER-STAMPED. THEY ARE NEVER SETTABLE FROM A REQUEST BODY.
-- ===========================================================================================
-- `SubmitPipelineEvidenceRequestSchema` carries no `producer`/`source`/`reportedBy` field and must
-- never gain one; `federation/scan-evidence.ts` is where this repo already paid for the lesson.
-- The rule in one sentence: PROVENANCE — which authenticated principal and which module produced the
-- row — IS THE AUTHORIZATION BOUNDARY, NOT THE PAYLOAD SHAPE, because a shape-valid payload is
-- forgeable by anyone who can read the schema. A caller-supplied producer field is a self-attested
-- claim about exactly the thing being checked.
--
-- So both columns are filled at INSERT from the authenticated subject and from which door the row
-- arrived through, the same way `control_runs.plugin_module` is stamped and deliberately not
-- re-derived later. This matters beyond bookkeeping: `evaluateBakeGate` evaluates window coverage
-- PER SOURCE ("source A's reports never fill source B's gaps"), so a caller who could choose its own
-- `source` could manufacture single-source coverage of a window it never observed — a gate unlock
-- wearing a reporting API's clothes.
--
-- `payload` holds the parsed `PipelineEvidenceSchema` body VERBATIM (a `TestRunEvidence` or an
-- `AlarmStateEvidence`). The columns beside it are the ones that get QUERIED — the binding
-- (`artifact_digest` / `commit_sha`), the subject, and the stamped provenance. Everything else stays
-- in the bag rather than being shredded into columns that would have to be kept in step with the Zod
-- contract by hand.
-- ===========================================================================================

CREATE TABLE IF NOT EXISTS "pipeline_evidence" (
  "id" uuid PRIMARY KEY,
  "org_id" uuid NOT NULL,
  "component_object_id" uuid NOT NULL REFERENCES objects(id),
  -- The deployment target this evidence is ABOUT. Required even for `postMerge`, whose run is not
  -- target-specific, because the AUTHORIZATION is scoped at the target and "an evidence row nobody
  -- can attribute is an evidence row nobody can revoke" (PipelineEvidenceSubjectSchema).
  "target_object_id" uuid NOT NULL REFERENCES objects(id),
  "hook_id" text NOT NULL,
  -- 'testRun' | 'alarmState'. Plain text, Zod-enforced — see `pipeline_hooks.kind`.
  "kind" text NOT NULL,
  -- EXACTLY ONE of these two bindings is what the consuming hook requires: `postMerge` runs before
  -- any artifact exists so it binds to the built COMMIT; the other three describe something already
  -- deployed so they bind to the artifact DIGEST. Both are permitted on the wire and the CONSUMER
  -- requires the one its hook needs — a mismatch is a refusal, never a widening. Unbound evidence is
  -- not evidence: it gets read as covering whatever deploys next.
  "artifact_digest" text,
  "commit_sha" text,
  -- SERVER-STAMPED. NEVER settable from a request body — see the header. CHECKed here rather than
  -- left to Zod precisely BECAUSE it is not on the wire: there is no request schema standing over
  -- this column, so the constraint is the only guard, and the value set is closed at both ends
  -- (`BakeAlarmReport["source"]` is a closed union the verdict function switches on).
  "source" text NOT NULL,
  -- SERVER-STAMPED. NEVER settable from a request body — see the header. The authenticated subject
  -- whose credential wrote the row. NULLABLE and deliberately un-FK'd: an `executor_observed` row has
  -- no human subject, and evidence must outlive a deleted subject rather than cascade away with it —
  -- the audit question "who said the window was quiet" cannot be answered by a row that vanished.
  "producer_subject_id" uuid,
  -- The parsed `PipelineEvidenceSchema` body, verbatim.
  "payload" jsonb NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "pipeline_evidence_source_check"
    CHECK ("source" IN ('rollout_analysis', 'pushed', 'executor_observed'))
);
--> statement-breakpoint

-- "The latest evidence for this (org, target, hook)" — the read `evaluateContinuousHold` and
-- `evaluatePostDeployGate` both stand on. `created_at DESC` is in the index so that read is an index
-- scan stopping at the first row, not a sort of every report ever filed against a long-lived target.
CREATE INDEX IF NOT EXISTS "pipeline_evidence_latest"
  ON "pipeline_evidence" USING btree ("org_id", "target_object_id", "hook_id", "created_at" DESC);
--> statement-breakpoint

-- Bake window-coverage lookups: `alarmReportsInWindow` fetches EVERY `alarmState` row for a
-- (target, hook) whose asserted window overlaps the required one — a range predicate over jsonb
-- `windowStart`/`windowEnd`, so `kind` earns its place in the index to keep the far more numerous
-- `testRun` rows out of the scan entirely.
CREATE INDEX IF NOT EXISTS "pipeline_evidence_bake_window"
  ON "pipeline_evidence" USING btree ("org_id", "target_object_id", "hook_id", "kind");
--> statement-breakpoint

-- NEWEST-WINS SUPERSESSION FOR TEST RUNS, ENFORCED (see `recordTestRunEvidence`'s doc for WHY this
-- is semantics and not a retention hack). `COALESCE(..., '')` because the binding is "digest OR
-- commit" with the unused one NULL, and NULL never equals NULL in a unique index — without the
-- coalesce this index would permit unlimited duplicates of exactly the rows it exists to collapse.
-- Partial on `kind = 'testRun'`: `alarmState` rows accumulate ON PURPOSE and must not be caught here.
CREATE UNIQUE INDEX IF NOT EXISTS "pipeline_evidence_test_run_identity"
  ON "pipeline_evidence" USING btree (
    "org_id",
    "component_object_id",
    "target_object_id",
    "hook_id",
    (COALESCE("artifact_digest", '')),
    (COALESCE("commit_sha", ''))
  )
  WHERE "kind" = 'testRun';
--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE ON pipeline_evidence TO scp_app;
--> statement-breakpoint

ALTER TABLE pipeline_evidence ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE pipeline_evidence FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS org_isolation ON pipeline_evidence;
--> statement-breakpoint
CREATE POLICY org_isolation ON pipeline_evidence
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
--> statement-breakpoint

COMMENT ON TABLE pipeline_evidence IS
  'team-pipeline-iac D21/D23: concluded test runs and asserted alarm-state windows, bound to an artifact digest or a built commit. `source` and `producer_subject_id` are SERVER-STAMPED and never settable from a request body — provenance, not payload shape, is the authorization boundary (federation/scan-evidence.ts). testRun rows supersede newest-wins; alarmState rows accumulate, because a bake window needs a history to compute coverage over.';
