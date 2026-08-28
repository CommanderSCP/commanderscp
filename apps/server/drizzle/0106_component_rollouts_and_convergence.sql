-- `component_rollouts` AND `component_convergence` - THE TWO MANIFEST COLLECTIONS THAT WERE
-- AUTHORABLE AND THEN DROPPED (D12, D25(b); team-pipeline-iac sections 6 and 8).
--
-- ===========================================================================================
-- WHY THIS EXISTS: A DECLARATION THAT SYNTHESISED, VALIDATED, PLANNED GREEN, AND VANISHED
-- ===========================================================================================
-- The increment-8 contract defined `rollouts` and `convergence` as manifest collections; the
-- `@scp/iac` L1 doors and the `CanaryRollout` / `RollingRollout` constructs emit them. But
-- `plans-repo.ts` projected neither ("`rollouts` and `convergence` follow the ordinary rule and are
-- not projected at all yet"), so a team could write a canary strategy, watch `scp plan` come back
-- clean, apply it, and have the server discard it in silence. That is the FAKE SUCCESS shape this
-- whole design exists to remove, arriving through the authoring surface rather than the executor.
--
-- These two tables are where those collections land.
--
-- ===========================================================================================
-- IDENTITY, AND THE ORDINARY PRUNE RULE
-- ===========================================================================================
-- A rollout is keyed `(org, component, target_class)` - D12 keys the declaration by the CLASS of
-- target, so one component legitimately declares a canary for its clusters and a rolling batch for
-- its instance groups. Convergence is keyed `(org, component, target)` - D25(b) is about ONE
-- config pipeline placed at ONE infrastructure product.
--
-- BOTH FOLLOW THE ORDINARY COLLECTION RULE (absent = empty = prune), unlike `pipelineHooks` and
-- `producers` whose absence means UNMANAGED. That asymmetry is deliberate and is the contract's,
-- not this migration's: an omitted hook DISARMS A GATE and an omitted producer re-arms dependency
-- confusion, so both fail dangerous. An omitted rollout costs a declared strategy and an omitted
-- convergence costs a self-healing fleet - both visible, neither silent, and both recovered by
-- re-declaring. Nothing here should be "made consistent" with the other two.
--
-- NO `managed_by_stack` COLUMN on either: ownership is DERIVED from `component_object_id`, exactly
-- as `pipeline_hooks` (0096), `source_mappings` and `executor_bindings` do. Which stack owns a row
-- is answered by asking which stack owns the COMPONENT, so there is no second column that could
-- disagree with the first.

CREATE TABLE IF NOT EXISTS "component_rollouts" (
  "id" uuid PRIMARY KEY,
  "org_id" uuid NOT NULL,
  "component_object_id" uuid NOT NULL REFERENCES objects(id),
  -- 'cluster' | 'instanceGroup' (`RolloutTargetClassSchema`, an InfraKind.extract). Plain text, no
  -- pg enum and no CHECK - the closed set lives once in Zod and every write door parses through it,
  -- the same treatment `executor_bindings.type` gets.
  "target_class" text NOT NULL,
  -- `RolloutStrategySchema` - a discriminated union on `strategy`, so the stored document carries a
  -- discriminant rather than a strategy string the server has to interpret (D15(c)).
  "rollout" jsonb NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "component_rollouts_identity" UNIQUE ("org_id", "component_object_id", "target_class")
);
--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE ON component_rollouts TO scp_app;
--> statement-breakpoint
ALTER TABLE component_rollouts ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE component_rollouts FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS org_isolation ON component_rollouts;
--> statement-breakpoint
CREATE POLICY org_isolation ON component_rollouts
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "component_convergence" (
  "id" uuid PRIMARY KEY,
  "org_id" uuid NOT NULL,
  "component_object_id" uuid NOT NULL REFERENCES objects(id),
  -- The infrastructure PRODUCT whose observed membership drives convergence (D25(b)).
  "target_object_id" uuid NOT NULL REFERENCES objects(id),
  -- Written EXPLICITLY by synth even though it defaults on (D8: inference at synth, explicitness at
  -- apply), so "this fleet self-converges" is a reviewable line rather than a server-side default
  -- nobody can see. `false` opts out and is stored as such, never as an absent row.
  "converge" boolean NOT NULL,
  -- 'changedSubset' | 'fullGroup'. Plain text, Zod-enforced, like `target_class` above.
  "scope" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "component_convergence_identity"
    UNIQUE ("org_id", "component_object_id", "target_object_id")
);
--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE ON component_convergence TO scp_app;
--> statement-breakpoint
ALTER TABLE component_convergence ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE component_convergence FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS org_isolation ON component_convergence;
--> statement-breakpoint
CREATE POLICY org_isolation ON component_convergence
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
--> statement-breakpoint

COMMENT ON TABLE component_rollouts IS
  'team-pipeline-iac D12: the rollout strategy a component declares per TARGET CLASS. Ordinary prune rule (absent collection = empty = prune), unlike pipeline_hooks. Ownership derives from component_object_id - there is no managed_by_stack column.';
--> statement-breakpoint

COMMENT ON TABLE component_convergence IS
  'team-pipeline-iac D25(b): whether a configuration pipeline placed at an infrastructure product re-applies its released state when that product''s membership changes. `converge` is stored explicitly, including false, because D8 requires the manifest to say which rather than rely on a server-side default.';
