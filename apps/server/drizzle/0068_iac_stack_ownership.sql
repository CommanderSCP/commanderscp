-- ============================================================================================
-- IaC STACK OWNERSHIP MOVES OUT OF `labels` — a description is not an assertion.
-- ============================================================================================
--
-- THE DEFECT. `iac/plan-diff.ts`'s `isStackManaged` and `iac/plans-repo.ts`'s
-- `labels @> {"scp:managed-by":"iac","scp:stack":"<name>"}` decided the IaC PRUNE POOL — which
-- live objects and relationships an apply DELETES — by reading two keys out of the object's own
-- `labels` map. `labels` is writable at plain `object:write` AT THE OBJECT, validated by nothing:
-- no schema (every type registers `labels` with none), no reserved namespace, no prefix rule.
--
-- Both directions were reproduced through real HTTP doors
-- (`iac/iac-stack-ownership.integration.test.ts`):
--
--   ENROLMENT — an Operator bound at ONE object, holding no IaC authority whatsoever, PATCHes the
--   two keys onto it. The stack's UNCHANGED manifest then proposes deleting it, over the reason
--   "previously managed by this stack, no longer present in the desired manifest", which is false.
--   The apply executes the delete, under the applier's authority, and takes the object's
--   `source_mappings`, `placements` and `executor_bindings` with it (they are pooled by owned
--   object id).
--
--   ESCAPE — the object's owner strips the two keys. The object leaves the pool, so when its stack
--   later drops it from the manifest to decommission it, NO delete is proposed. It survives its own
--   decommission silently: no error, no Decision, nothing in the diff a reviewer could notice.
--
-- THE REMEDY, and why it is a column rather than a reserved label namespace. PR #247 reserved
-- `scp.governance/` for keys a governance constraint may match on, and explicitly could not cover
-- this instance: those keys are written by an AUTHORITY holding org-root `policy:write`, whereas
-- stack ownership is written by the IaC apply itself, at whatever permission the applied objects
-- require. There is no principal who should be able to type it. That is not a namespace rule, it is
-- "this is not tenant data" — the same statement `origin_domain_id`, `provenance`, `revision` and
-- `domain_local` already make by being columns rather than map entries.
--
-- WHAT THE COLUMN ALSO GETS, which no label rule could. `labels` FEDERATE and `managed_by_stack`
-- does not: it is absent from the journal payload, so a replica arrives owned by nobody, which is
-- the truth — the local domain's IaC does not manage a row another domain authored. Read from the
-- code and NOT reproduced end-to-end (unlike the two directions above, which were): `labels` go
-- into the journal payload verbatim, `fetchManagedObjects` had no origin filter, and `deleteObject`
-- refuses a foreign-origin row with a 409 that aborts the whole apply. A reason to prefer the
-- column, not a second reported defect.
--
-- THE BACKFILL IS A ONE-TIME SNAPSHOT OF WHAT THE OLD CODE ALREADY TRUSTED, deliberately — not an
-- endorsement of it. Deriving the column from the labels preserves every estate's current prune
-- pool exactly: no stack silently loses its ability to converge (which would strand objects), and
-- no stack silently gains a delete candidate. Whatever poisoning predates this migration is carried
-- over once and then frozen, because from here the column moves only when an apply moves it. The
-- alternative — starting every column NULL — would empty every prune pool in the estate on
-- upgrade, which is the loud-but-wrong failure: an operator's next `terraform destroy`-shaped apply
-- would report nothing to do.
-- ============================================================================================

ALTER TABLE objects ADD COLUMN managed_by_stack text;
ALTER TABLE relationships ADD COLUMN managed_by_stack text;

COMMENT ON COLUMN objects.managed_by_stack IS
  'The `@scp/iac` stack whose apply owns this row, or NULL. SERVER-WRITTEN ONLY: the sole writer is apps/server/src/iac/stack-ownership.ts, called from the IaC apply path; no request body can reach it, and no route passes it. This is what scopes PRUNING — an apply deletes exactly the live rows carrying its own stack name that its manifest no longer declares. It lived in `labels` until 0068, where the prune target could rewrite it under plain object:write. Does NOT federate: it is absent from the journal payload, so a replica is owned by nobody, which is correct — the importing domain''s IaC does not manage a row another domain authored.';

COMMENT ON COLUMN relationships.managed_by_stack IS
  'Mirrors objects.managed_by_stack for edges — see that column''s comment. Same single writer, same non-federating behaviour, same reason.';

-- Preserve every live pool exactly as the label-based query computed it (see the header).
UPDATE objects
   SET managed_by_stack = labels ->> 'scp:stack'
 WHERE labels ->> 'scp:managed-by' = 'iac'
   AND labels ->> 'scp:stack' IS NOT NULL;

UPDATE relationships
   SET managed_by_stack = labels ->> 'scp:stack'
 WHERE labels ->> 'scp:managed-by' = 'iac'
   AND labels ->> 'scp:stack' IS NOT NULL;

-- The prune-pool query is `org_id = $1 AND managed_by_stack = $2 AND deleted_at IS NULL`, run once
-- per plan-compute and once per apply. Partial on `managed_by_stack IS NOT NULL` because the
-- overwhelming majority of rows on any estate are not IaC-managed at all, and the query never asks
-- for those.
CREATE INDEX obj_managed_stack
    ON objects (org_id, managed_by_stack)
 WHERE managed_by_stack IS NOT NULL AND deleted_at IS NULL;

CREATE INDEX rel_managed_stack
    ON relationships (org_id, managed_by_stack)
 WHERE managed_by_stack IS NOT NULL AND deleted_at IS NULL;
