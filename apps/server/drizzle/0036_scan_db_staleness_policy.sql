-- ===========================================================================================
-- M13.3b-ii — the INSTANCE-SCOPED scanner-DB STALENESS POLICY table (ADR-0020, proposal §13.3b).
--
-- The commander's promotion scan step consumes a Trivy vulnerability DB (baked into the runner
-- image, or pre-loaded from a server-maintained cache the operator keeps fresh). HOW STALE a DB may
-- be before it WARNs or FAILS CLOSED is a COMMANDER-LEVEL SETTING — "a company applies their own
-- rules" (owner decision 2026-07-24) — configurable at RUNTIME via API -> SDK -> CLI, no redeploy.
--
-- This table is that setting, modeled EXACTLY like `scan_requirement_floors` (0029) and
-- `scanner_assignments` (0035): INSTANCE-SCOPED (NO `org_id` — the same documented exception to
-- DESIGN §4.2 those tables carry; the staleness of the deployment's ONE managed-scan DB is a fact
-- about the deployment, identical for every org on it), TENANT-READ / OPERATOR-WRITE (a gate a
-- tenant cannot inspect is not explainable, charter principle 6; but these bounds bind every org, so
-- no tenant role may author them).
--
-- SINGLETON — one policy per deployment. `id` is pinned to the literal `'default'` by a CHECK, so
-- the table holds at most one row and the operator PUT is a plain upsert on that key.
--
-- BOTH BOUNDS NULLABLE. NULL means "use the built-in default for this bound" (soft 7d / hard 30d,
-- proposal §13.3b — `packages/schemas/src/scan-db.ts` DEFAULT_SCAN_DB_*), never 0. A stored 0 would
-- be a legitimately tightest bound; NULL is the "unset, fall back to default" signal, exactly as the
-- nullable ceilings on `scan_requirement_floors` mean "this tier sets no ceiling".
--
-- TWO INDEPENDENT BARRIERS keep a tenant from writing (DESIGN §4.2's "cross-tenant leakage requires
-- two independent failures"), mirrored from 0029/0035:
--   1. GRANT: `scp_app` (the request-serving login role, NOSUPERUSER/NOBYPASSRLS) gets SELECT only.
--      INSERT/UPDATE/DELETE are explicitly REVOKEd.
--   2. RLS: the only policy is `FOR SELECT`. There is NO permissive policy for INSERT/UPDATE/DELETE,
--      so even a future migration that mistakenly re-granted write privileges would still see every
--      tenant write denied by RLS.
-- Operator writes therefore run over the ADMIN connection (routes/scan-db.ts), never over the
-- request-serving pool. Reads stay inside ordinary tenant-scoped access, so no scan-step read path
-- ever needs the privileged connection.
--
-- Hand-authored (same convention as 0002/0007/0010/0011/0014/0017/0028/0029/0035): RLS/grants are
-- never expressible in drizzle-kit's schema diffing.
-- ===========================================================================================

CREATE TABLE IF NOT EXISTS "scan_db_staleness_policy" (
  "id" text NOT NULL DEFAULT 'default',
  "soft_max_age_hours" integer,
  "hard_max_age_hours" integer,
  "note" text,
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "scan_db_staleness_policy_pk" PRIMARY KEY ("id"),
  CONSTRAINT "scan_db_staleness_policy_singleton_ck" CHECK ("id" = 'default'),
  CONSTRAINT "scan_db_staleness_policy_nonneg_ck" CHECK (
    ("soft_max_age_hours" IS NULL OR "soft_max_age_hours" > 0)
    AND ("hard_max_age_hours" IS NULL OR "hard_max_age_hours" > 0)
  )
);
--> statement-breakpoint

-- Barrier 1 — the request-serving role may only READ.
GRANT SELECT ON scan_db_staleness_policy TO scp_app;
--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE ON scan_db_staleness_policy FROM scp_app;
--> statement-breakpoint

-- Barrier 2 — RLS with a SELECT-only policy. USING (true): the row is instance-wide config holding
-- NO per-tenant data at all, so it exposes no cross-tenant visibility. The absence of any
-- INSERT/UPDATE/DELETE policy is the write denial.
ALTER TABLE scan_db_staleness_policy ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE scan_db_staleness_policy FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_read ON scan_db_staleness_policy;
--> statement-breakpoint
CREATE POLICY tenant_read ON scan_db_staleness_policy FOR SELECT USING (true);
