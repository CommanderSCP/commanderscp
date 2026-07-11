-- M8 security pass (BUILD_AND_TEST.md §8 M8 item 5: "RLS review"). Hand-authored (same pattern
-- as 0002/0007/0010/0011/0014): RLS is never expressible in drizzle-kit's schema diffing.
--
-- FINDING: `instance_keys` (db/schema.ts's doc comment) became org-scoped in M6
-- (0012_federation.sql — org_id NOT NULL, one row per org) but was never given an
-- `org_isolation` RLS policy; its ORIGINAL "no RLS" reasoning (M4, 0010_governance.sql) was
-- written when the table held exactly one GLOBAL, INSTANCE-WIDE row, "same treatment as
-- state_transitions (global, not tenant data)" — a premise the M6 org-scoping change made false,
-- but the RLS policy was never revisited to match. As of M6 this table holds each ORG's own
-- Ed25519 private signing key (used for approval-attestation AND federation sync-journal
-- signing, DESIGN §10.2/§13) in a table SHARED across every tenant in the same Postgres
-- instance — DESIGN.md §4.2's non-negotiable invariant ("cross-tenant leakage requires two
-- independent failures: app bug AND policy bug") did not hold for it: a single forgotten
-- `WHERE org_id = ...` filter in any future code path touching this table would leak one org's
-- private signing key to another org's request context, with no independent DB-level backstop —
-- letting that org forge federation journal entries/approval attestations as if genuinely signed
-- by the victim org. `governance/attestation.ts`'s only caller, `ensureInstanceKey`, already
-- takes a `TenantTx` (i.e. is always called from within `withTenantTx`, which sets
-- `app.current_org_id`), so this closes the gap with zero impact on the legitimate access path —
-- confirmed by reading every call site before writing this migration.

ALTER TABLE instance_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE instance_keys FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON instance_keys;
CREATE POLICY org_isolation ON instance_keys
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
