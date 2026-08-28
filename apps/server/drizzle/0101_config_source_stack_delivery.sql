-- `config_source_stacks` — WHICH STACKS A CONFIG SOURCE ACTUALLY DELIVERS
-- (D26, owner ruling 2026-08-27; docs/proposals/team-pipeline-iac.md §5; ADR-0046 §3).
--
-- ===========================================================================================
-- THE GAP THIS CLOSES, AND WHY IT NEEDED A ROW RATHER THAN A RULE
-- ===========================================================================================
-- Two accepted clauses disagreed. §4 makes the explicit `stackTeams` map the D7 binding ("binding
-- a stack here marks it repo-owned"); D9 gives an UNCLAIMED stack the registration's DEFAULT team
-- ("each matched repo's stack applies as that team"), which `config-source/registration-match.ts`
-- implements. So a stack could be applied by the sync every time the repo changed while
-- `findStackConfigSourceBinding` said it was unowned — meaning a direct `scp apply` succeeded and
-- the next sync silently reverted it. That is D7's OWN failure mode, reached by forgetting a line
-- in a map rather than by doing anything wrong.
--
-- The ruling: OWNERSHIP FOLLOWS DELIVERY. A stack this config source has applied is repo-owned,
-- claimed or not. That is a FACT ABOUT WHAT HAPPENED, so it is recorded when it happens; it cannot
-- be derived from the registration document, which is exactly why the two clauses could disagree.
--
-- ===========================================================================================
-- IDENTITY IS `(org_id, stack_name)` — ONE STACK HAS ONE OWNER, ENFORCED BY THE PRIMARY KEY
-- ===========================================================================================
-- Not `(org_id, config_source_id, stack_name)`. The invariant D7 exists to protect is that a stack
-- has exactly ONE writer, and the PK is what makes "two config sources delivering one stack"
-- unrepresentable instead of merely discouraged — the same reasoning 0049's one-per-component
-- `releases_via` index and 0051's placement identity use. `registration-match.ts` already refuses
-- that state loudly at sync (`stack_owned_elsewhere`) for EXPLICIT claims; this is the same rule
-- for delivered ones, one layer lower, where a race cannot slip past a read-then-write.
--
-- The delivery writer therefore inserts ON CONFLICT DO UPDATE guarded by config_source_id, and a
-- second config source's delivery of the same stack updates ZERO rows — which the engine reports
-- as a refusal rather than swallowing. A bare `DO UPDATE` with no guard would be last-writer-wins,
-- the precise thing D9 says must never happen.
--
-- NO `managed_by_stack` COLUMN, and no ownership pointer beyond `config_source_id`: this table is
-- not part of any stack's desired state. It is the server's own record of what it did, in the same
-- category as `plans`/`decisions` — an IaC manifest can neither declare nor prune a row here.

CREATE TABLE IF NOT EXISTS "config_source_stacks" (
  "org_id" uuid NOT NULL,
  -- The `DesiredStateManifest.stackName` delivered. Plain text and the whole identity: `plans`,
  -- `objects.managed_by_stack` and `relationships.managed_by_stack` all key on this same bare
  -- string, and a second spelling here (normalized, prefixed, hashed) would be a second definition
  -- of what a stack IS.
  "stack_name" text NOT NULL,
  -- The `config-source` object that delivered it. Org-unbound `REFERENCES objects(id)`, the form
  -- `pipeline_hooks.component_object_id` and `changes.object_id` already use. ON DELETE is
  -- deliberately absent: deleting the registration must NOT silently drop the ownership record,
  -- because "removing the stack from the config-source registration returns it to CLI-push" (D7) is
  -- an operator act that should be visible, and a soft-deleted `config-source` object keeps its row
  -- so the engine can report a stack whose owner is gone rather than reading as never-owned.
  "config_source_id" uuid NOT NULL REFERENCES objects(id),
  -- The team the apply RAN AS (`registration-match.ts`'s resolution: the per-stack claim, else the
  -- registration's default). Recorded rather than re-derived so an audit answers "whose authority
  -- wrote this stack" from the row, never from re-running a matcher against a document that has
  -- since been edited — the same provenance-is-read-not-inferred rule ADR-0046 §4 states for
  -- derived executor bindings.
  "team_object_id" uuid NOT NULL REFERENCES objects(id),
  -- The commit the last delivery came from, for the status surface and for a Decision to be
  -- correlated against. Not a foreign key to anything: SCP does not model commits.
  "last_commit_sha" text NOT NULL,
  -- The manifest path within the repo, likewise for the status surface.
  "last_manifest_path" text NOT NULL,
  "first_delivered_at" timestamp with time zone NOT NULL DEFAULT now(),
  "last_delivered_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "config_source_stacks_pkey" PRIMARY KEY ("org_id", "stack_name")
);
--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE ON config_source_stacks TO scp_app;
--> statement-breakpoint

ALTER TABLE config_source_stacks ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE config_source_stacks FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS org_isolation ON config_source_stacks;
--> statement-breakpoint
CREATE POLICY org_isolation ON config_source_stacks
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
--> statement-breakpoint

-- Every stack one config source delivers, for the status surface and for the prune question
-- ("this registration no longer selects that manifest — what did it used to own?").
CREATE INDEX IF NOT EXISTS "config_source_stacks_by_source"
  ON "config_source_stacks" ("org_id", "config_source_id");
--> statement-breakpoint

COMMENT ON TABLE config_source_stacks IS
  'team-pipeline-iac D26 (owner ruling 2026-08-27): ownership follows delivery. One row per stack a config source has applied; PRIMARY KEY (org_id, stack_name) makes one-stack-one-owner unrepresentable rather than merely refused. Read by the D7 CLI-apply guard UNION the registration''s explicit stackTeams claims. Server-owned: no IaC manifest can declare or prune a row here.';
