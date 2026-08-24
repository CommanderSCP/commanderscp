-- ===========================================================================================
-- 0093 — MEMBER-CLUSTER VERSION HEARTBEAT (§7.4 version-skew mechanism)
--        (docs/proposals/multi-region-instance-resilience.md §7.4, M26.2/M26.3)
--
-- DESIGN §17's original "single image version (no skew)" row was written for ONE cluster. Once an
-- instance spans member clusters, an upgrade rolls them one at a time, so the supported window is N
-- and N+1 only, and a migration's CONTRACT half must not run until every member cluster runs the
-- release that shipped its EXPAND half. This table is the mechanism: each process HEARTBEATS its
-- (cluster_id, app_version) on boot, and the migrations Job refuses a contract-phase deploy while any
-- LIVE heartbeat still reports a different version (i.e. an old-version member cluster is still up).
--
-- INSTANCE-WIDE, not per-org (the 0029/0035/0062 exception to DESIGN §4.2): one row per member
-- cluster, no org_id. RLS is enabled with a permissive policy so the runtime `scp_app` role can
-- upsert its OWN heartbeat (it holds no tenant data — just a cluster id + a version string). The
-- migrations Job reads it over the admin connection. Hand-authored (RLS/grants).
-- ===========================================================================================

CREATE TABLE IF NOT EXISTS "member_cluster_heartbeat" (
  -- Operator-supplied per-cluster identity (SCP_CLUSTER_ID), else the pod/host name. One row each.
  "cluster_id" text PRIMARY KEY,
  "app_version" text NOT NULL,
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE ON member_cluster_heartbeat TO scp_app;
--> statement-breakpoint

ALTER TABLE member_cluster_heartbeat ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE member_cluster_heartbeat FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS instance_wide ON member_cluster_heartbeat;
--> statement-breakpoint
-- Instance-wide config holding NO per-tenant data: USING/WITH CHECK true so any runtime session may
-- read every cluster's heartbeat and upsert its own. The row's key IS the cluster id, so a cluster
-- can only ever clobber its own row.
CREATE POLICY instance_wide ON member_cluster_heartbeat USING (true) WITH CHECK (true);
--> statement-breakpoint

COMMENT ON TABLE member_cluster_heartbeat IS
  'multi-region-instance-resilience §7.4: one row per member cluster, heartbeating (cluster_id, app_version) on boot. The migrations Job refuses a contract-phase deploy while any live heartbeat reports a version != the deploying version (an old member cluster still up). N and N+1 only.';
