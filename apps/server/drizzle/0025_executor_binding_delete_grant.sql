-- 0025_executor_binding_delete_grant.sql
--
-- M12 P5c adds `DELETE /executors/{idOrUrn}/binding` — the detach primitive (executor-bindings-repo.ts's
-- `deleteExecutorBinding`). `executor_bindings` was granted SELECT, INSERT, UPDATE only (migration
-- 0014's "append/update-only convention... no DELETE route exists for either — both are upserted in
-- place"). Now one does, so the least-privileged runtime role `scp_app` needs DELETE, or the new
-- route gets a live "permission denied for table executor_bindings" from Postgres — the exact class
-- of bug 0014's own comment records for `secrets`/`notification_bindings` (caught by the M7 E2E).
--
-- No table/column/RLS change — a pure privilege grant, mirroring 0014's `secrets`/`notification_bindings`
-- DELETE grant. RLS still confines every DELETE to the caller's org (the unchanged `org_isolation`
-- policy on this table); this grant only lifts the table-level privilege block.

GRANT DELETE ON executor_bindings TO scp_app;
