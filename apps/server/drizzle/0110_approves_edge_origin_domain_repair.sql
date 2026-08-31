-- REPAIR: `approves` edges stamped with the ORG id instead of this domain's minted domain id.
--
-- ===========================================================================================
-- WHAT WAS WRITTEN, AND WHY IT IS WRONG
-- ===========================================================================================
-- `governance/approvals-repo.ts`'s `castApprovalVote` wrote the idempotent graph-visible
-- `approves` edge (voter -> change) with `origin_domain_id = org_id`. Every other writer of that
-- column (`graph/relationships-repo.ts`, `graph/objects-repo.ts`) stamps
-- `federation_self.domain_id` — a uuid MINTED per org (0012), not derived from `org_id` — so
-- these rows claim an origin domain that appears in no `federation_self` row at all.
--
-- The consequence is not confined to federation. `graph/objects-repo.ts`'s `deleteObject` cascade
-- selects the edges to tombstone with `origin_domain_id = self.domain_id`, so an `approves` edge
-- never matched: deleting the voter or the change left the edge LIVE and dangling, locally,
-- permanently. The federated-delete single-writer check misses it for the same reason.
--
-- ===========================================================================================
-- THE REPAIR
-- ===========================================================================================
-- PER ORG, THROUGH `federation_self`. The join is what makes this tenant-safe: each row can only
-- ever be rewritten to ITS OWN org's minted domain id, and an org with no `federation_self` row
-- (one that has never taken a federation action) matches nothing and is left alone — its next
-- vote calls `ensureFederationSelf` and mints the identity, but there is no correct value to
-- write here today, and inventing one would be worse than leaving the row for a later pass.
--
-- THE PREDICATE IS THE DEFECT'S EXACT SIGNATURE: `origin_domain_id = org_id` on a `type_id =
-- 'approves'` row. A legitimately federated `approves` edge imported from a peer carries that
-- peer's domain id and is untouched; a domain whose minted `domain_id` happened to equal its
-- `org_id` would be a no-op rewrite. Both are safe, and both are why the type filter and the
-- equality are stated together rather than either alone.
--
-- `content_hash` IS NOT RECOMPUTED, deliberately: `computeRelationshipContentHash` covers
-- `(id, orgId, typeId, fromId, toId, properties, labels)` and has never included
-- `origin_domain_id`, so the stored hash is still the hash of this row. Rewriting it would
-- invalidate every attestation over it for no gain.
--
-- `revision` IS NOT BUMPED and no journal entry is written: this corrects a column that was never
-- a fact about the edge's content, and a bump would present a repair to peers as a new authoring
-- write from a domain that never made one.
--
-- RLS NOTE: `relationships` is `FORCE ROW LEVEL SECURITY` (0002 §2). Migrations run as the
-- bootstrap connection role, which bypasses RLS in every supported deployment (it is the role
-- that CREATEs the policies) — the same reliance 0077 and 0097 already document. A non-bypassing
-- role would silently match zero rows here; that leaves the pre-repair state, which the
-- application code (fixed in the same change) no longer adds to.
-- ===========================================================================================

UPDATE relationships r
SET origin_domain_id = fs.domain_id
FROM federation_self fs
WHERE r.org_id = fs.org_id
  AND r.type_id = 'approves'
  AND r.origin_domain_id = r.org_id;
