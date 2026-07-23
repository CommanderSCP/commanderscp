-- ===========================================================================================
-- M13.3a — the SCANNER-ASSIGNMENT REGISTRY table (ADR-0020 §2, proposal §13.3).
--
-- The commander's promotion scan step reads each artifact's executor Type and selects the managed
-- scan METHOD(S) assigned to that Type. This table is that mapping, keyed on the EXISTING
-- `ExecutorType` taxonomy (owner decision 2026-07-23) — NOT a new content-type axis:
--
--   executor_type ∈ {image, rpm, deb, npm, infrastructure, configuration}  ──▶  methods[]
--
-- GRAPH-NATIVE (charter principle 2): scanning methods arrive as REGISTRY DATA assigned to an
-- existing routing key, not as a new top-level concept. One assignment SET per Type (PK on
-- executor_type), so this is a small operator-config table, not tenant traffic.
--
-- INSTANCE-SCOPED — NO `org_id` (owner decision 2026-07-23), the SAME exception to DESIGN §4.2's
-- "`org_id NOT NULL` on every tenant-scoped table" invariant that `scan_requirement_floors`
-- (0029) documents: the assignment of a scanner to an artifact type is a fact about the
-- DEPLOYMENT's managed-scan capability, identical for every org hosted on it; per-org rows would
-- encode a fact already true of the whole deployment and would invite a tenant-writable surface.
--
-- TENANT-READ / OPERATOR-WRITE — this table's RLS MIRRORS 0029_scan_requirement_floors.sql EXACTLY,
-- for the same two reasons (a gate a tenant cannot inspect is not explainable; these assignments
-- bind every org, so no tenant role may author them). TWO INDEPENDENT BARRIERS keep a tenant from
-- writing (DESIGN §4.2's "cross-tenant leakage requires two independent failures"):
--   1. GRANT: `scp_app` (the request-serving login role, NOSUPERUSER/NOBYPASSRLS) gets SELECT only.
--      INSERT/UPDATE/DELETE are explicitly REVOKEd.
--   2. RLS: the only policy is `FOR SELECT`. There is NO permissive policy for INSERT/UPDATE/DELETE,
--      so even a future migration that mistakenly re-granted write privileges would still see every
--      tenant write denied by RLS.
-- Operator writes therefore run over the ADMIN connection (routes/scanner-assignments.ts), never
-- over the request-serving pool — exactly as instance-scan-floors does. Reads stay inside ordinary
-- tenant-scoped access, so no scan-step read path ever needs the privileged connection.
--
-- `executor_type` is a PLAIN `text` column with NO pg enum / CHECK — the closed set is enforced in
-- the API layer (Zod: `ExecutorTypeSchema`), exactly as `executor_bindings.type` is (0026). This
-- keeps the DB column identical to the one that already routes bindings, and lets the owner extend
-- the Type set (D4) by a schema-package edit without a migration.
--
-- FAIL-CLOSED SEED (proposal §13.3): a Type with an EMPTY `methods` produces NO managed evidence,
-- so E6 refuses that Type's cross-boundary promotion unless valid org-pipeline evidence already
-- covers the digest. `configuration -> []` seeds exactly that: no managed scanner for GitOps-config
-- artifacts. The build-family/machine-image Types get Trivy (D2: image scope; `infrastructure`
-- covers the trivy-vm / machine-image case). This is fail-closed by design, not a silent pass.
--
-- Hand-authored (same convention as 0002/0007/0010/0011/0014/0017/0028/0029): RLS/grants are never
-- expressible in drizzle-kit's schema diffing.
-- ===========================================================================================

CREATE TABLE IF NOT EXISTS "scanner_assignments" (
  "executor_type" text NOT NULL,
  "methods" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "scanner_assignments_pk" PRIMARY KEY ("executor_type")
);
--> statement-breakpoint

-- Barrier 1 — the request-serving role may only READ.
GRANT SELECT ON scanner_assignments TO scp_app;
--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE ON scanner_assignments FROM scp_app;
--> statement-breakpoint

-- Barrier 2 — RLS with a SELECT-only policy. USING (true): the row set is instance-wide config
-- holding NO per-tenant data at all, so it exposes no cross-tenant visibility. The absence of any
-- INSERT/UPDATE/DELETE policy is the write denial.
ALTER TABLE scanner_assignments ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE scanner_assignments FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_read ON scanner_assignments;
--> statement-breakpoint
CREATE POLICY tenant_read ON scanner_assignments FOR SELECT USING (true);
--> statement-breakpoint

-- Fail-closed sensible defaults (proposal §13.3 / ADR-0020 §2). `image`/`rpm`/`deb`/`npm` and the
-- machine-image (`infrastructure`, the trivy-vm case, D2) Types get Trivy; `configuration` gets NO
-- managed scanner (`[]`) — its promotions must carry org-pipeline evidence or refuse at E6.
INSERT INTO scanner_assignments (executor_type, methods) VALUES
  ('image',          '["trivy"]'::jsonb),
  ('rpm',            '["trivy"]'::jsonb),
  ('deb',            '["trivy"]'::jsonb),
  ('npm',            '["trivy"]'::jsonb),
  ('infrastructure', '["trivy"]'::jsonb),
  ('configuration',  '[]'::jsonb)
ON CONFLICT (executor_type) DO NOTHING;
