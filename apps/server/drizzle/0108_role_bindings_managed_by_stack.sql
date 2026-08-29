-- ================================================================================================
-- IaC-MANAGED ROLE BINDINGS — role-model.md's IaC rung (owner decision 2026-08-28)
-- ================================================================================================
--
-- `managed_by_stack` is how every other IaC-managed row answers "does this stack own me, and should
-- an apply that no longer declares it PRUNE it" (drizzle/0068 introduced the column on `objects` and
-- `relationships`). `role_bindings` never had one, because until now nothing declared a binding
-- declaratively.
--
-- ⚠️ WHAT THIS COLUMN MAKES POSSIBLE, STATED PLAINLY BECAUSE IT IS NOT LIKE THE OTHERS.
-- Every existing use of `managed_by_stack` prunes a row whose loss disarms or removes a
-- CAPABILITY — a pipeline hook, a rollout strategy, a placement. This one prunes a row whose loss
-- removes a PERSON'S ACCESS. Dropping a line from a manifest and merging it will, on the next
-- apply, revoke authority from whoever held it. That is the requested behaviour (the manifest is
-- the desired state and drift must be visible), and it is an owner decision taken with the risk
-- named: the failure mode is somebody losing access as a side effect of a merge nobody read
-- closely.
--
-- THREE THINGS BOUND IT, none of which this migration provides — they are in the doors already:
--   1. `assertOrgRetainsAdministrativeFloor` refuses the delete that would leave an org with no
--      administrative binding, so an apply cannot brick an org even by pruning everything.
--   2. The no-escalation subset rule runs against the APPLYING principal, so an apply cannot grant
--      authority its applier lacks — and for a config-source sync that applier is the TEAM object.
--   3. Group and team subjects are not declarable at all (`packages/iac/src/rbac.ts`), because D7's
--      acknowledgement is a statement about a membership at a moment and a manifest can only carry
--      a snapshot.
--
-- NULLABLE, and NULL is the important value: a binding written through `POST /role-bindings` or by
-- `ensureBootstrapAdmin` carries NULL and is therefore invisible to every stack's prune. Only rows
-- an apply created are ever pruned by one, which is the same rule `objects` and `relationships`
-- follow and the reason a hand-granted Owner binding cannot be deleted by an unrelated manifest.

ALTER TABLE role_bindings ADD COLUMN IF NOT EXISTS managed_by_stack text;
--> statement-breakpoint

-- The prune query is "every binding this org's stack owns", so the index leads with `(org_id,
-- managed_by_stack)` and is PARTIAL on the non-NULL half — the overwhelming majority of rows are
-- hand-granted and would otherwise bloat it for a scan that never selects them.
CREATE INDEX IF NOT EXISTS "role_bindings_managed_stack"
  ON role_bindings (org_id, managed_by_stack)
  WHERE managed_by_stack IS NOT NULL;
--> statement-breakpoint

COMMENT ON COLUMN role_bindings.managed_by_stack IS
  'IaC stack that created this binding, or NULL for one granted through POST /role-bindings or at bootstrap. An apply prunes only rows carrying its own stack name — so a hand-granted binding is invisible to every manifest. Unlike every other managed_by_stack, pruning here revokes a PERSON''S ACCESS rather than a capability; the administrative floor and the no-escalation subset rule are what bound it (role-model.md, owner decision 2026-08-28).';

-- ------------------------------------------------------------------------------------------------
-- THE SAME MARKER ON `roles`, for the same reason and with a much smaller blast radius
-- ------------------------------------------------------------------------------------------------
-- A stack that declares an org role must be able to prune it too, and needs the same "is this
-- mine" answer. Pruning a ROLE is far less dangerous than pruning a binding: the delete door
-- already refuses while any binding still points at it, so the worst case is a loud 409 rather
-- than a silent revocation.
--
-- BUILT-INS ARE UNREACHABLE BY THIS, structurally rather than by convention: they are the shared
-- `org_id IS NULL` singletons, and `roles-repo.ts`'s update/delete both filter `org_id = :orgId`,
-- so no stack name can ever be written onto one and no manifest can prune one.
ALTER TABLE roles ADD COLUMN IF NOT EXISTS managed_by_stack text;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "roles_managed_stack"
  ON roles (org_id, managed_by_stack)
  WHERE managed_by_stack IS NOT NULL;
--> statement-breakpoint

COMMENT ON COLUMN roles.managed_by_stack IS
  'IaC stack that authored this org role, or NULL for one created through POST /roles. Never set on a built-in: those are org_id IS NULL singletons that roles-repo.ts refuses to address by org. Pruning a role is bounded by the delete door, which refuses while any binding still points at it.';
