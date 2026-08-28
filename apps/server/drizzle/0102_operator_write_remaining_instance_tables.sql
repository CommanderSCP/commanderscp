-- ================================================================================================
-- THE LAST TWO INSTANCE-SCOPED TABLES WITHOUT A WRITE PRINCIPAL — role-model.md §5 step 9
-- ================================================================================================
--
-- THE PROPERTY, NOT THE SYMPTOM. An instance-scoped table here is tenant-READ (a `tenant_read`
-- policy, `FOR SELECT USING (true)`) and operator-WRITE (the `scp_operator` role from 0076). Both
-- halves of the write principal are required under FORCE ROW LEVEL SECURITY: the grant alone is
-- denied by the absent policy, and the policy alone is denied by the absent grant.
--
-- THIS HAS NOW SHIPPED WRONG THREE TIMES. 0029/0035/0036/0074 created four such tables with no
-- write principal at all, and 0076 came back for them. 0083 §2 then created
-- `governance_move_instance_rung` without one — which 0086's own comment records, in as many words,
-- as having happened "AGAIN" — and 0062 had already created `dependency_subscription_unlock` the
-- same way. So the fix was applied to the instances that were noticed, twice, and the class was
-- never swept.
--
-- SWEPT BY PROPERTY THIS TIME. Every table carrying a `tenant_read` policy was enumerated and
-- differenced against every table carrying an `operator_write` policy; the remainder is exactly the
-- two below, and after this migration that difference is empty. The census was run over the
-- migration corpus with no filter on filename or subsystem, because a filter is where the next
-- instance hides.
--
-- WHAT WAS ACTUALLY BROKEN. `routes/governance-move.ts` and `routes/dependency-subscriptions.ts`
-- each opened `createPool(config.databaseUrl)` inline instead of using `withOperatorDb`. That is
-- wrong twice over, and the second reason is why this migration is needed rather than just a code
-- change:
--
--   1. `config.databaseUrl` is the ADMIN/bootstrap connection, and the hardened Helm shape does not
--      give it to api/worker pods at all (only the migrations Job holds admin credentials). With
--      `DATABASE_URL` unset, `loadConfig` falls back to `postgres://scp:scp@localhost:5432/scp`, so
--      each handler dialled 127.0.0.1 INSIDE its own pod and returned a bare 500 on ECONNREFUSED.
--   2. Behind that sat an independent refusal: `scp_app` holds SELECT only on both tables, which
--      are FORCE RLS with a SELECT-only policy and no write policy for anyone. Routing the write
--      through `scp_operator` without THIS migration would simply move the failure.
--
-- The integration suite never saw either layer, because its `DATABASE_URL` is the Testcontainers
-- SUPERUSER, which bypasses grants and RLS outright. That is why these two survived a full green
-- suite for as long as they did, and it is worth stating plainly: a passing integration run is not
-- evidence that a grant exists.
--
-- `WITH CHECK` IS SPELLED OUT on both policies. An omitted `WITH CHECK` on a `FOR ALL` policy is
-- SILENT — reads and row-matching pass, and only the write is refused — which is the failure shape
-- 0086 documented after paying for it.

-- ------------------------------------------------------------------------------------------------
-- 1. governance_move_instance_rung (created by 0083 §2, tenant-read since, no write principal)
-- ------------------------------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON governance_move_instance_rung TO scp_operator;
--> statement-breakpoint
DROP POLICY IF EXISTS operator_write ON governance_move_instance_rung;
--> statement-breakpoint
CREATE POLICY operator_write ON governance_move_instance_rung
  FOR ALL TO scp_operator USING (true) WITH CHECK (true);
--> statement-breakpoint

-- ------------------------------------------------------------------------------------------------
-- 2. dependency_subscription_unlock (created by 0062, same shape, same omission)
-- ------------------------------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON dependency_subscription_unlock TO scp_operator;
--> statement-breakpoint
DROP POLICY IF EXISTS operator_write ON dependency_subscription_unlock;
--> statement-breakpoint
CREATE POLICY operator_write ON dependency_subscription_unlock
  FOR ALL TO scp_operator USING (true) WITH CHECK (true);
