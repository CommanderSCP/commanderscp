-- ===========================================================================================
-- M13.3a (machine-image arm) — reassign the `infrastructure` executor Type from `trivy` to the
-- new `trivy-vm` managed scan METHOD (ADR-0020 §2, proposal §13.3, owner decision D2).
--
-- WHY. 0035 seeded `infrastructure -> ["trivy"]` with the comment "`infrastructure` covers the
-- trivy-vm / machine-image case" — but at that point no `trivy-vm` method existed, so the seed
-- pointed the machine-image Type at the CONTAINER-IMAGE scan arm. `trivy image` cannot read a VM
-- disk image: it would fail the runner and produce no evidence, so the row was fail-closed but
-- also functionally dead. This increment builds the arm (`apps/runner-scan/run.sh`'s `trivy-vm`
-- case) and points the Type at it, which is what 0035 always intended.
--
-- NEVER STOMPS AN OPERATOR CHOICE. Scanner assignments are OPERATOR-WRITABLE instance config
-- (`PUT /api/v1/instance/scanner-assignments`, `SCP_OPERATOR_TOKEN`). This migration therefore
-- rewrites the row ONLY while it still holds the exact 0035 SEED value `["trivy"]`. An operator
-- who has already set `infrastructure` to something deliberate — `[]`, `["openscap"]`,
-- `["trivy","openscap"]`, anything — keeps it untouched. A data migration that silently replaced
-- a governance decision the operator authored would be the worse failure by far.
--
-- `updated_at` is bumped with the rewrite so the assignments read (and its `updatedAt` column in
-- the UI/CLI) honestly reports that this row changed at upgrade time, rather than claiming the
-- operator's last edit produced the new value.
--
-- Hand-authored (same convention as 0035): drizzle-kit's schema diffing does not express seed data.
-- ===========================================================================================

UPDATE scanner_assignments
   SET methods = '["trivy-vm"]'::jsonb,
       updated_at = now()
 WHERE executor_type = 'infrastructure'
   AND methods = '["trivy"]'::jsonb;
--> statement-breakpoint

-- Belt and braces: if the row is absent entirely (a deployment whose 0035 seed was pruned), seed
-- the machine-image assignment now. `DO NOTHING` keeps this a no-op wherever the row exists,
-- including the operator-authored case guarded above.
INSERT INTO scanner_assignments (executor_type, methods) VALUES
  ('infrastructure', '["trivy-vm"]'::jsonb)
ON CONFLICT (executor_type) DO NOTHING;
