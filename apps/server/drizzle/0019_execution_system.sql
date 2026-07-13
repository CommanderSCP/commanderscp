-- M12 P2 (docs/proposals/import-existing-executors.md): the first-class "execution system" entity —
-- an execution system the org already runs (Argo CD first) that SCP coordinates rather than bundles
-- a duplicate of (Mode A / BYO-coordinate). Registered ONCE as a graph object; its serverUrl + token
-- live on the object (token via the secrets table, referenced by key), and many bound Components
-- reference it by id instead of re-specifying the URL/token per binding.

-- 1. Built-in object type (graph-native: registry data, not a new table — charter principle 2).
INSERT INTO object_types (id, org_id, display_name, property_schema, is_builtin) VALUES
  ('execution-system', NULL, 'Execution System', '{"type":"object"}'::jsonb, true)
ON CONFLICT (id) DO NOTHING;

-- 2. Executor bindings may reference an execution-system object. When set, reconcile resolves the
-- plugin's serverUrl + token from that object (executor-bindings-repo.ts) instead of the binding's
-- inline config, and keys the plugin instance on the system id so all bindings sharing one system
-- share a single observe() poll. Nullable — inline-config bindings (pre-M12) are unaffected. A plain
-- uuid (not an FK), matching target_object_id's convention; the app validates the reference.
ALTER TABLE "executor_bindings" ADD COLUMN IF NOT EXISTS "execution_system_id" uuid;
