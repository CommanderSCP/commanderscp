-- ===========================================================================================
-- `executor_bindings.purpose` — 1:1 -> 1:N per target (model P3,
-- docs/proposals/service-component-model.md).
--
-- Owner model (2026-07-15): "All services involve infra and software." A component may therefore own
-- BOTH pipelines — e.g. a fleet of static instances with its own infra pipeline AND its own
-- software-deployment pipeline, both belonging to ONE component. The schema made that impossible:
-- UNIQUE(org_id, target_object_id) allowed exactly one binding per target, and
-- upsertExecutorBinding keys its lookup on (org, target) — so binding a second pipeline SILENTLY
-- REPLACED the first rather than erroring.
--
-- `purpose` is a CLOSED set of two values (owner decision): 'infra' | 'software'. `data`/migrations
-- was considered and withdrawn — SCP's own migrations are a Helm pre-upgrade HOOK inside the deploy,
-- not a separate pipeline, which is the common shape. Adding a value later is additive (oasdiff
-- treats a new response enum value as a warning, not an ERR-level break), so this costs nothing if
-- another purpose ever earns its place. Enforced in the API layer (packages/schemas) rather than a
-- CHECK constraint, matching how every other enum in this schema is handled (plugin_module, role, ...).
--
-- DEFAULT 'software' is what makes this migration behaviour-preserving rather than a silent
-- re-interpretation: every EXISTING binding is exactly the one reconcile triggers today, and reconcile
-- now asks for purpose='software'. So today's bindings keep triggering exactly as before, and an
-- 'infra' binding is registerable + pollable immediately but not triggerable until waves can name a
-- purpose (P4 — plan-compiler's CompiledWave carries bare object ids with no notion of a binding).
-- Existing imports are labelled 'software' by assumption, not by knowledge: an imported Argo CD app
-- could genuinely be an infra app. Re-labelling is part of the organize-after flow, and this is the
-- honest default because it is the one that changes nothing.
-- ===========================================================================================

ALTER TABLE "executor_bindings"
  ADD COLUMN IF NOT EXISTS "purpose" text NOT NULL DEFAULT 'software';

-- Swap 1:1 -> 1:N. A target may hold at most one binding PER PURPOSE (so "the infra one" and "the
-- software one" coexist, but a second software pipeline on the same target is still a conflict).
--
-- BOTH drops are required, and dropping only the constraint is a silent no-op that leaves 1:N broken.
-- `executor_bindings_org_target_key` exists as a bare UNIQUE INDEX, not a table constraint (verified:
-- it appears in pg_indexes but NOT in pg_constraint, on a fresh migrate AND on the live homelab DB).
-- `DROP CONSTRAINT IF EXISTS` therefore matches nothing and — because of the IF EXISTS — says so
-- silently, leaving the old (org_id, target_object_id) uniqueness in force: the second binding on a
-- target then fails with "duplicate key value violates unique constraint
-- executor_bindings_org_target_key" no matter what its purpose is. Caught by the integration test
-- driving a real second bind; it would otherwise have shipped and broken 1:N in production.
ALTER TABLE "executor_bindings"
  DROP CONSTRAINT IF EXISTS "executor_bindings_org_target_key";
DROP INDEX IF EXISTS "executor_bindings_org_target_key";

ALTER TABLE "executor_bindings"
  ADD CONSTRAINT "executor_bindings_org_target_purpose_key"
  UNIQUE ("org_id", "target_object_id", "purpose");
