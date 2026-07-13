-- M12 P1 (docs/proposals/import-existing-executors.md): the EXECUTOR-SPECIFIC target identifier a
-- graph object maps to (e.g. an Argo CD Application name), passed as ExecutorPlugin.trigger().targetRef.
-- Nullable — reconcile falls back to the object id when unset, so every pre-M12 binding is unaffected.
-- This is what lets ONE execution system coordinate MANY objects whose SCP ids differ from their
-- external names (Mode A / importing an existing Argo CD). Column inherits executor_bindings' existing
-- RLS + scp_app grant (no new grant needed). Hand-authored (same convention as 0017).

ALTER TABLE "executor_bindings" ADD COLUMN IF NOT EXISTS "external_ref" text;
