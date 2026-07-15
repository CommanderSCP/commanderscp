-- ===========================================================================================
-- Enforce "each component belongs to at most ONE service" in the DATABASE, not just in code.
--
-- Found by adversarial review of the P2 containment walk (docs/proposals/service-component-model.md).
-- `assertCardinality` (graph/relationships-repo.ts) implements one_to_many as a SELECT-then-INSERT:
-- it checks "does this to_id already have a live incoming edge of this type" and then inserts. Under
-- READ COMMITTED (our default; there is no SELECT ... FOR UPDATE on that path) two concurrent creates
-- of `contains` S1->C and S2->C can BOTH pass the check before either commits, and both succeed. The
-- pre-existing UNIQUE(org_id, type_id, from_id, to_id) does not help: the from_ids differ.
--
-- That race is pre-existing and shared by every one_to_many/one_to_one type, and it was a benign
-- data-integrity nit — until migration 0021 + the P2 walk made `contains` cardinality the thing that
-- BOUNDS RBAC and policy reach (authz/resolve.ts's scopeExpandCte, governance/policy-resolve.ts's
-- containmentChain both walk EVERY live incoming `contains` edge). A doubly-contained component is
-- reachable from BOTH services' role bindings and policies simultaneously. A security invariant
-- enforced only by a check-then-insert is not enforced.
--
-- Scoped deliberately to `contains` rather than "fix assertCardinality for all types": this is the
-- one whose cardinality is load-bearing for authorization today, a partial index expresses it exactly,
-- and the generic fix (locking or SERIALIZABLE across every relationship write) is a much larger,
-- riskier change that deserves its own review. Tracked as a follow-up for the other one_to_many types.
--
-- `deleted_at IS NULL` matches the walks' own filter, so a soft-deleted edge frees the component to be
-- re-assigned (the organize-after flow) exactly as assertCardinality already intends.
-- ===========================================================================================

CREATE UNIQUE INDEX IF NOT EXISTS "relationships_contains_one_service_per_component"
  ON "relationships" ("org_id", "to_id")
  WHERE "type_id" = 'contains' AND "deleted_at" IS NULL;
