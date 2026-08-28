-- ================================================================================================
-- CUSTOM ROLES — role-model.md §5 step 10, unblocked by the quorum-bypass fix
-- ================================================================================================
--
-- This migration adds NO column and NO role. It adds the one uniqueness guarantee an org-owned
-- roles catalogue needs before an authoring API can exist.
--
-- WHAT 0097 DELIBERATELY DID NOT COVER. `roles_builtin_name_key` is PARTIAL —
-- `UNIQUE (name) WHERE org_id IS NULL` — so it constrains the SHARED SINGLETON rows only. That was
-- correct for its increment and it leaves org rows entirely unconstrained: an org could hold two
-- roles both named 'Release Captain', with different permission arrays. Both are bindable, both
-- render identically in `GET /roles`, and a revoke names one of them. `role_bindings` takes a role
-- by ID so nothing MISRESOLVES, but the catalogue becomes unreadable and an operator cannot tell
-- which row a binding points at without joining by id — the same class of defect
-- `role_bindings_grant_key` was added to close for duplicate grants (0097 §2).
--
-- WHY IT IS SAFE TO ADD NOW. No authoring API has ever existed, so org rows can only have arrived
-- by hand SQL or a restored dump. The index is created WITHOUT a cleanup step because, unlike
-- 0097's, there is nothing to clean on any deployment that has not been hand-edited — and on one
-- that HAS, a hard failure naming the duplicate is the right outcome: this migration must not
-- silently pick a winner between two roles that confer different authority.
--
-- NAME COLLISION WITH A BUILT-IN IS NOT CONSTRAINED HERE, deliberately. An org row named 'Approver'
-- stays creatable at the DDL level; it is refused at the AUTHORING door (`POST /roles`) and, for
-- rows that predate that door, at the BINDING door by `builtInNameCollisionReason`. Constraining it
-- in the database would need a cross-partition check no unique index can express, and the two doors
-- already cover every path a new one can arrive by.

CREATE UNIQUE INDEX IF NOT EXISTS "roles_org_name_key"
  ON roles (org_id, name)
  WHERE org_id IS NOT NULL;

-- ------------------------------------------------------------------------------------------------
-- THE DELETE GRANT — the half a new delete verb always needs, and 0002 never gave `roles`
-- ------------------------------------------------------------------------------------------------
-- 0002 granted `scp_app` SELECT, INSERT, UPDATE on `roles` and no DELETE, which was right for its
-- increment: nothing could delete a role because no verb existed. 0097 hit the identical shape from
-- the other side and added `GRANT DELETE ON role_bindings TO scp_app` so that a revoke verb could
-- exist at all.
--
-- `DELETE /api/v1/roles/{id}` is the verb that makes this one necessary. Without it the route's
-- refusals all pass, the door admits the request, and the statement fails at the database — a 500
-- on a request that was fully authorized, which is the least debuggable way for a missing grant to
-- present. MEASURED: it did exactly that before this line existed.
--
-- Nothing about RLS changes. `org_isolation`'s `USING` clause still confines a tenant to its own
-- rows plus the readable built-in singletons, and `roles-repo.ts`'s `deleteRoleById` additionally
-- names `org_id = :orgId` so a built-in is not addressable by that function at all.
GRANT DELETE ON roles TO scp_app;
