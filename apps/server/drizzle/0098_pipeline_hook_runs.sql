-- ===========================================================================================
-- 0098 — PIPELINE HOOK RUNS (team-pipeline-iac increment 8, the RUN-TRACKING layer)
--        Contract: packages/schemas/src/pipeline-behaviors.ts (D11/D21/D23).
--        Consumers: apps/server/src/coordination/pipeline-hook-runs.ts (claim/trigger/poll),
--                   which feeds apps/server/src/coordination/pipeline-hooks-repo.ts's
--                   `recordTestRunEvidence` on every terminal phase.
--
-- ===========================================================================================
-- SERVER-VERSION PREFLIGHT — THE FIRST MIGRATION IN THIS TREE THAT HARD-REQUIRES POSTGRES 15+
-- ===========================================================================================
-- `UNIQUE NULLS NOT DISTINCT` (see the guard's own comment below) is PostgreSQL 15+ syntax. Every
-- migration before this one runs unchanged on older servers, so 0097 is the first place the
-- documented floor (DESIGN.md: "PostgreSQL 16+", and every Testcontainers/CI/Dockerfile pin is
-- `postgres:16`) becomes load-bearing rather than aspirational.
--
-- Nothing in the tree checks the server version — not `doctor`, not startup, not the migrate
-- runner (verified by a filterless census, 2026-08-27). So on an operator's own older cluster this
-- file would fail with `syntax error at or near "NOT"`, pointing at a keyword rather than at the
-- requirement, part-way through a migration run. Charter principle 5 makes self-hosting
-- first-class, which makes a legible refusal the operator's due — an off-spec deployment is not an
-- excuse for an unreadable error.
--
-- This block turns that syntax error into a sentence, and it lives HERE rather than in `doctor`
-- because it must run at the exact moment before the DDL that needs it, and cannot be skipped.
DO $$
BEGIN
  IF current_setting('server_version_num')::int < 150000 THEN
    RAISE EXCEPTION
      'CommanderSCP migration 0097 requires PostgreSQL 15 or newer (this server is %). It uses UNIQUE NULLS NOT DISTINCT, which older servers cannot parse. DESIGN.md names PostgreSQL 16+ as the supported floor; please upgrade the database before continuing.',
      current_setting('server_version');
  END IF;
END
$$;
--> statement-breakpoint

-- ===========================================================================================
-- WHY THIS TABLE EXISTS AT ALL — THE GAP 0096 DELIBERATELY LEFT
-- ===========================================================================================
-- `pipeline_evidence.payload`'s `outcome` is `passed|failed` and NOTHING ELSE, and that is a
-- decision the contract states rather than an omission: "Evidence is a record of something that
-- FINISHED; an in-flight run is expressed by the ABSENCE of evidence" (TestRunEvidenceSchema).
--
-- Follow that through and a hole appears. If an in-flight run has no representation anywhere, then
-- between "SCP dispatched the postDeploy suite for wave 3" and "the suite finished" there is no row
-- in the database saying the dispatch happened. The reconcile tick runs once a second. Every one of
-- those ticks would look for evidence, find none, correctly conclude `awaiting` — and then trigger
-- the suite AGAIN, because nothing distinguishes "not started" from "started, still running".
--
-- So this table is not a second evidence table and must never become one. It records exactly one
-- fact evidence structurally cannot: THAT WE ALREADY ASKED. Evidence remains the record of the
-- answer; this is the record of the question having been posed, and it is deleted from nobody's
-- reasoning about verdicts — `evaluatePostDeployGate` never reads it.
--
-- ===========================================================================================
-- THE UNIQUE CONSTRAINT IS THE TRIGGER-IDEMPOTENCY GUARD, AND IT IS A DATABASE CONSTRAINT
-- ===========================================================================================
-- `(org_id, change_object_id, hook_id, wave_index)` is UNIQUE. Not "checked before inserting" —
-- UNIQUE. The two are not interchangeable and the difference is the entire point: a read-then-insert
-- has a window in which two reconcile ticks (this process's own overlapping tick, or a second Helm
-- `worker` replica, which by design shares no in-memory view with the first) both observe no row and
-- both go on to call `trigger()`. That is two real workflow dispatches in someone's estate for one
-- logical gate, and no amount of care in the function prevents it, because the function is not where
-- the race lives.
--
-- The claim row is therefore inserted BEFORE `trigger()` is called, and it is the insert winning or
-- losing that decides who triggers — the same three-step, crash-safe shape `reconcile.ts`'s
-- `triggerWaveTarget` uses for wave targets, for the same reason (PR #7 review CRITICAL #2).
--
-- ===========================================================================================
-- `NULLS NOT DISTINCT`, BECAUSE `postMerge` HAS NO WAVE AND A PLAIN UNIQUE WOULD SILENTLY LET IT
-- THROUGH
-- ===========================================================================================
-- This is the sharp edge, and it fails in the direction that looks fine. `postMerge` is not
-- target-specific and does not belong to a wave, so its `wave_index` is NULL. In a PLAIN unique
-- constraint, PostgreSQL's default `NULLS DISTINCT` means NULL is never equal to NULL — so
-- `(org, change, 'postMerge', NULL)` does not conflict with an identical `(org, change, 'postMerge',
-- NULL)`, and the guard that stops double-triggering every OTHER hook kind quietly stops applying to
-- this one. Nothing errors. Nothing logs. The suite just runs twice, or a hundred times.
--
-- `UNIQUE NULLS NOT DISTINCT` makes NULL compare equal to NULL for this constraint, which is
-- precisely the semantics wanted: one postMerge run per (org, change, hook). It needs PostgreSQL 15+
-- and DESIGN.md §3 pins the required floor at "PostgreSQL 16+", so it is inside the supported range
-- with a version to spare.
--
-- THE ALTERNATIVES WERE CONSIDERED AND ARE WORSE, recorded so nobody "simplifies" this later:
--   - a `coalesce(wave_index, -1)` expression index works on any version but writes a SENTINEL into
--     the index's value space, and `-1` is only safe for as long as nobody ever adds a negative or
--     relative wave index. That is an assumption about future data, enforced nowhere.
--   - two partial unique indexes (`WHERE wave_index IS NULL` / `IS NOT NULL`) is also correct, but
--     splits one invariant across two objects with two names, so a violation surfaces under a
--     constraint name that depends on which hook kind tripped it.
-- One constraint, one name, no sentinel.
-- ===========================================================================================

CREATE TABLE IF NOT EXISTS "pipeline_hook_runs" (
  "id" uuid PRIMARY KEY,
  "org_id" uuid NOT NULL,
  -- The component whose hook this run belongs to — AND the ownership pointer. NO `managed_by_stack`
  -- column, and none is ever added: `packages/schemas/src/iac.ts` settles this for the whole family
  -- of per-object configuration tables, and 0096 already applied it to `pipeline_hooks` /
  -- `pipeline_evidence`. A row belongs to stack S iff the graph object it hangs off is one THIS
  -- stack owns. A stack-label column would be a SECOND answer to "who owns this row", and the moment
  -- it can disagree with the first, a plan's prune set and its apply's prune set are computed from
  -- different facts.
  "component_object_id" uuid NOT NULL REFERENCES objects(id),
  -- NULLABLE, and the nullability is load-bearing rather than defensive: `postMerge` "runs before any
  -- artifact exists" and is not target-specific, so there is no target to name. The other three hook
  -- kinds all describe something already deployed and always carry one. See the header for what that
  -- NULL does to a plain UNIQUE.
  "target_object_id" uuid REFERENCES objects(id),
  -- The Change this run gates. Part of the identity: a hook is re-run per change, and a run for
  -- change A says nothing about change B even at the same wave index.
  "change_object_id" uuid NOT NULL REFERENCES objects(id),
  "hook_id" text NOT NULL,
  -- 'postMerge'|'postDeploy'|'continuous'|'bakeAlarms'. Plain text, no pg enum and no CHECK — the
  -- closed set lives ONCE, in `PipelineHookKindSchema` (packages/schemas), exactly as for
  -- `pipeline_hooks.kind`. A duplicate here would be a second definition to keep in step.
  "kind" text NOT NULL,
  -- NULL for `postMerge` (no wave). See the header: this NULL is why the constraint below is
  -- `NULLS NOT DISTINCT`.
  "wave_index" integer,
  -- The binding this run's eventual evidence will carry. `postMerge` binds to the built COMMIT (it
  -- runs before any artifact exists); the other three bind to the artifact DIGEST. Both nullable
  -- here because which one applies is the hook's business, and `PipelineEvidenceSubjectSchema`'s
  -- refine — exactly one required — is enforced at the evidence write, which is where a mismatch
  -- must be a refusal rather than a widening.
  "artifact_digest" text,
  "commit_sha" text,
  -- ===========================================================================================
  -- NULLABLE, AND THIS IS THE ONE COLUMN WHOSE NULLABILITY IS THE WHOLE DESIGN
  -- ===========================================================================================
  -- The row is inserted BEFORE `trigger()` is called, so at insert time there is no external run to
  -- name. Making this NOT NULL would force the opposite order — trigger first, insert second — and
  -- that order reintroduces the exact bug this table exists to prevent: a crash (or a rolled-back
  -- transaction) between the dispatch and the insert leaves the estate with a running workflow and
  -- SCP with no memory of it, so the next tick fires a second one.
  --
  -- So `external_run_id IS NULL` is a real, meaningful state: "we have durably claimed the right to
  -- trigger this, and either have not yet called the executor or did not survive to record the
  -- answer". The recovery for both is identical and safe — re-derive the SAME `idempotencyKey` and
  -- call `trigger()` again, which a conformant executor dedups into the same `ExternalRunRef`
  -- (`TriggerIntent.idempotencyKey`, plugin-api). Which is why the key must be derived from this
  -- row's identity and never freshly minted.
  "external_run_id" text,
  "external_url" text,
  -- Mirrors `ExecutionPhase` from `@scp/plugin-api` MEMBER FOR MEMBER. CHECKed in SQL — unlike
  -- `kind` above — precisely because no Zod schema stands over this column: `ExecutionPhase` is a
  -- TypeScript union in `@scp/plugin-api` (which is deliberately free of a `@scp/schemas`
  -- dependency), never a request field, so there is no parse door and the constraint is the only
  -- guard. Same reasoning that put a CHECK on `pipeline_evidence.source` in 0096.
  "status" text NOT NULL,
  -- Which plugin instance this run was dispatched to. Persisted rather than re-resolved at poll time
  -- for the reason `change_wave_targets.executor_plugin_id` is: a status poll must address the SAME
  -- instance the trigger used, or it polls a different pipeline for this run's ref.
  "plugin_instance_id" text NOT NULL,
  -- Retry count for the trigger call itself, so a repeatedly-refusing executor backs off instead of
  -- re-firing on every 1s tick (`reconcile.ts`'s `triggerBackoffMs` idiom).
  "attempt" integer NOT NULL DEFAULT 0,
  "started_at" timestamp with time zone NOT NULL DEFAULT now(),
  -- NULL until the first `status()` poll. Distinct from `started_at`, which is when SCP claimed the
  -- run; an un-polled run and a polled-and-still-pending run are different operator situations.
  "last_observed_at" timestamp with time zone,
  -- ===========================================================================================
  -- THE D23 PIN — AND WHY IT IS ALLOWED TO BE NULL RATHER THAN FILLED WITH SOMETHING PLAUSIBLE
  -- ===========================================================================================
  -- `TestRunEvidenceSchema.workflow` is a `CapturedWorkflowRef`: the declared (repo, branch, path)
  -- PLUS the BUILT `commitSha` PLUS a digest-pinned `bundle` (repository + sha256). The hook row's
  -- own `workflow` column is only the DECLARED half — "a pointer into whatever the cluster happens
  -- to hold right now" — and the captured half is per-BUILD, not per-hook, so it belongs on the run,
  -- not on the declaration.
  --
  -- D23's capture step (build-time capture of the named workflows into an OCI test bundle beside the
  -- image) DOES NOT EXIST IN THIS TREE YET. Nothing produces a bundle repository or digest. This
  -- column is therefore NULL for every run today, and the driver's response to that is to record the
  -- terminal status and write NO evidence, loudly — NOT to synthesise a bundle digest so the shape
  -- type-checks. A fabricated digest would produce an evidence row that is, by the contract's own
  -- words, "a claim about the word 'passed'": it would satisfy `evaluatePostDeployGate` while being
  -- bound to bytes nobody ever verified, which is exactly the failure `evaluateScanCoverage`'s
  -- `not_digest_bound` refusal exists to prevent one layer down.
  "captured_workflow" jsonb,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  -- THE TRIGGER-IDEMPOTENCY GUARD. `NULLS NOT DISTINCT` so `postMerge`'s NULL `wave_index` is
  -- covered too — see the header for why a plain UNIQUE fails silently for exactly that one kind.
  CONSTRAINT "pipeline_hook_runs_identity"
    UNIQUE NULLS NOT DISTINCT ("org_id", "change_object_id", "hook_id", "wave_index"),
  CONSTRAINT "pipeline_hook_runs_status_check"
    CHECK ("status" IN ('pending', 'running', 'succeeded', 'failed', 'aborted'))
);
--> statement-breakpoint

-- The poll driver's ONLY scan: "which runs in this org are still in flight". PARTIAL on the
-- non-terminal statuses so the index stays proportional to the work outstanding rather than to every
-- run ever dispatched — terminal rows are the overwhelming majority within a day of steady operation
-- and they are never scanned by this query again.
CREATE INDEX IF NOT EXISTS "pipeline_hook_runs_non_terminal"
  ON "pipeline_hook_runs" USING btree ("org_id", "started_at")
  WHERE "status" IN ('pending', 'running');
--> statement-breakpoint

-- "Every run for this change" — what a change's detail read and the wave-gate evaluation both want.
CREATE INDEX IF NOT EXISTS "pipeline_hook_runs_by_change"
  ON "pipeline_hook_runs" USING btree ("org_id", "change_object_id", "hook_id");
--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE ON pipeline_hook_runs TO scp_app;
--> statement-breakpoint

ALTER TABLE pipeline_hook_runs ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE pipeline_hook_runs FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS org_isolation ON pipeline_hook_runs;
--> statement-breakpoint
CREATE POLICY org_isolation ON pipeline_hook_runs
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
--> statement-breakpoint

COMMENT ON TABLE pipeline_hook_runs IS
  'team-pipeline-iac D11/D21/D23: in-flight and concluded pipeline hook runs — the state pipeline_evidence structurally cannot hold, because its outcome vocabulary is passed|failed only (evidence records something that FINISHED). Without this table every reconcile tick would re-trigger a suite it already dispatched. UNIQUE NULLS NOT DISTINCT (org_id, change_object_id, hook_id, wave_index) is the trigger-idempotency guard and is a DATABASE constraint on purpose: NULLS NOT DISTINCT because postMerge has no wave, and under the default NULLS DISTINCT the guard would silently not apply to exactly that kind. NO managed_by_stack column: ownership derives from component_object_id (packages/schemas/src/iac.ts).';
