CREATE UNIQUE INDEX "executor_bindings_managed_iac_workspace_uq" ON "executor_bindings" USING btree ("org_id",lower(coalesce("external_ref", "target_object_id"::text))) WHERE "executor_bindings"."plugin_module" = 'managed-iac';
-- #417 re-verify (probe I): a managed-iac workspace is its binding's externalRef, else its target id,
-- and a second binding naming the same one — another target's, another Type, a hook lane — would plan
-- into it and overwrite the plan an approver accepted there. One workspace, one binding, per org,
-- case-insensitively (the lane's collision check lowercases too). Partial on the module; bindings are
-- hard-deleted, so no tombstone keeps a key claimed. No new GRANT: an index on an existing table.
