-- ===========================================================================================
-- M21.5 — WHAT COMMANDERSCP ITSELF AUTHORED, IN A PLACE ONLY THE SERVER WRITES
-- (ADR-0032 §8/§9, charter `scp-managed-dep` amendment 2026-08-13/2026-08-15)
--
-- ===========================================================================================
-- THE DEFECT THIS TABLE EXISTS TO CLOSE — A CONFUSED DEPUTY, NOT A TIDINESS PROBLEM
--
-- Until this migration, every input that decided WHOSE CREDENTIAL MERGED WHAT — the repository, the
-- authored ref, the base branch, the component, the line, the branch's head commit — was read out of
-- `changes.source_ref.scp_authored`. `source_ref` is the RAW DELIVERY PAYLOAD plus a few lifted keys,
-- and any authenticated principal can write it verbatim through `POST /api/v1/changes`; the trigger
-- that starts the merge gate can likewise be produced through `POST /change-sources/{kind}/report`.
-- So a tenant could fabricate a change whose `scp_authored` named ANY repository and have SCP merge
-- into it with SCP's own installation credential.
--
-- The unifying rule, and the reason this is a table rather than another jsonb key: A MERGE IS THE ONE
-- IRREVERSIBLE THING THIS FEATURE DOES, SO IT MUST ACT ONLY ON FACTS SCP ITSELF RECORDED. Never on a
-- field a tenant can write, and never on state read back from the provider. `source_ref` can never be
-- the authority for that, however carefully it is validated — validation of an attacker-writable field
-- yields a well-formed attacker-supplied answer. This table is the authority instead: it is written by
-- `dependencies/bump-actuator.ts`'s `recordBumpAuthorship` at the moment SCP DECIDES to author, and
-- updated only by the ingress that observes SCP's own branch coming back. Nothing tenant-facing can
-- reach it — there is no route, no IaC type and no import path that writes it.
--
-- `changes.source_ref.scp_authored` KEEPS BEING WRITTEN, and that is not a contradiction: it is the
-- human-readable explanation on the change (principle 6, "why was this not auto-merged?") and the
-- correlation hint's readable twin. It is no longer READ by anything that decides a write.
--
-- ===========================================================================================
-- WHY 0063, AND THE `when`
--
-- 0062 is main's highest at the time this branch merges; its `when` is 1788069137000 and this entry's
-- is 1788089137000 — STRICTLY GREATER, which is the only comparison drizzle makes. It gates on `when`
-- alone and SILENTLY SKIPS an entry whose `when` does not exceed what a database has already applied
-- (no error, no warning; the failure surfaces later as a missing table). 0061's header records the
-- three-way collision that taught this, and `db/journal-ordering.test.ts` guards the file.
--
-- ===========================================================================================
-- WHY THIS IS A TABLE AND NOT GRAPH OBJECTS — the same four reasons as 0061
--
-- It is derived, per-domain, high-churn bookkeeping about a change; it mints no object type and no
-- relationship type (so it cannot wedge a federation channel mid-fleet-upgrade); it takes no per-org
-- advisory locks on the bump path; and both of its queries are single-hop index lookups. It does NOT
-- federate: a bump is authored by the commander that holds the credential, and an outpost never
-- authors one (`bumpDispatchRoleGuard`).
--
-- ===========================================================================================
-- THE SECOND CHANGE IN THIS FILE: `control_runs.plugin_module`
--
-- A control run recorded WHAT happened and never WHAT KIND OF CONTROL produced it, so the auto-merge
-- grant had to read the module off the CURRENT `control_bindings` row by LEFT JOIN. A binding is
-- mutable: re-pointing one control from `webhook-control` to `github-check` retroactively relabelled
-- every historical run of that control as "the component's own checks passed", and the grant reads
-- historical runs. Evidence about the past must not be re-narrated by a present-tense edit
-- (ADR-0030 §2's "declared, never inferred", and this repo's own provenance-label lesson: a label
-- named after WHAT MATCHED goes false the moment the matcher covers a second case).
--
-- So the module is stamped ON THE RUN, at insert, from the binding that actually ran. NULLABLE and
-- backfilled to NULL rather than to the current binding: rows written before this column existed
-- genuinely do not record what produced them, and inventing an answer for them is the same mistake at
-- one remove. `bump-actuator.ts` treats NULL as "not an own-check", which is the fail-closed
-- direction — it costs a pull request, never an unattended merge.
-- ===========================================================================================

CREATE TABLE IF NOT EXISTS "dependency_bump_authorships" (
  "org_id" uuid NOT NULL,
  -- The bump change this authorship is about. `REFERENCES objects(id)` in the same org-unbound form
  -- `changes.object_id` uses (0061's barrier-2 note applies verbatim: `objects` carries no
  -- `(org_id, id)` unique constraint to hang a composite key on).
  "change_object_id" uuid NOT NULL REFERENCES objects(id),
  "component_object_id" uuid NOT NULL REFERENCES objects(id),
  "line_id" uuid NOT NULL,
  -- `owner/repo`, as the provider spells it. THE authority for which repository a merge may touch.
  "repo" text NOT NULL,
  -- The branch the pull request targets. Sent to the plugin, which asserts the provider agrees the
  -- pull request's OWN base is this before it merges — so a retargeted pull request refuses.
  "base_branch" text NOT NULL,
  -- `refs/heads/scp/dep-bump/<change_object_id>`, recorded rather than only derived so the two sides
  -- of the provenance join are both facts on disk.
  "authored_ref" text NOT NULL,
  "ecosystem" text NOT NULL,
  "coordinate" text NOT NULL,
  "manifest_path" text NOT NULL,
  "from_version" text NOT NULL,
  "to_version" text NOT NULL,
  -- The commit SCP's own branch is at, written by `coordination/webhook-processor.ts` when the
  -- authored push is observed back through the two-sided branch check. NULL until then, which is a
  -- real state and the reason a FIRST dispatch can never auto-merge.
  "head_commit" text,
  -- THE PULL REQUEST SCP OPENED, recorded when it opened it (read back from the authoring run's own
  -- `status().stateRef`). The merge is addressed to THIS NUMBER — never to "the first open pull
  -- request whose head is our branch", which is provider list ordering deciding what gets merged.
  "pull_request_number" integer,
  -- Set once the provider confirms the merge. It is what stops the merge-commit's OWN webhook from
  -- re-running the gate, finding no open pull request, and overwriting the audit trail with a
  -- `withheld / merge_refused` verdict for a bump that DID merge (principle 6 inverted).
  "merged_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  -- One authorship per change. `org_id` leads so the primary-key index IS the hot lookup ("what did
  -- SCP author for change C?", always org-scoped).
  CONSTRAINT "dependency_bump_authorships_pk" PRIMARY KEY ("org_id","change_object_id"),
  -- A row cannot point at another org's line — the composite-FK barrier 0061 established.
  CONSTRAINT "dependency_bump_authorships_line_fk"
    FOREIGN KEY ("org_id","line_id") REFERENCES "dependency_lines" ("org_id","id")
);
--> statement-breakpoint

-- "WHICH BUMP IS THIS COMMIT THE HEAD OF?" — the CI-conclusion correlation route (GitHub's
-- `workflow_run` names a commit and NO ref). It ran as a full scan of every dependency-bump change in
-- the org, unbounded and unindexed, INSIDE the ingress transaction, on essentially every webhook.
-- PARTIAL over the rows that have a head at all: a bump whose push has not returned can never be the
-- answer, and the majority of rows at any moment are either that or long-since merged.
CREATE INDEX IF NOT EXISTS "dependency_bump_authorships_org_head_commit"
  ON "dependency_bump_authorships" USING btree ("org_id","head_commit")
  WHERE "head_commit" IS NOT NULL;
--> statement-breakpoint

-- "IS THERE ALREADY AN OPEN BUMP FOR THIS (component, manifest, coordinate, target version)?" — the
-- idempotency lookup a redelivered head-advance takes. Every column of the key is compared, which is
-- the property `findOpenBumpChange`'s header records the cost of getting wrong.
CREATE INDEX IF NOT EXISTS "dependency_bump_authorships_org_subject"
  ON "dependency_bump_authorships" USING btree
    ("org_id","component_object_id","manifest_path","coordinate","to_version");
--> statement-breakpoint

-- ===========================================================================================
-- Grants — SELECT/INSERT/UPDATE, and deliberately NO DELETE.
--
-- An authorship is the record of an irreversible act SCP performed against somebody's repository.
-- Deleting one would make "did we author this?" answerable with silence, which is the state the whole
-- provenance loop exists to prevent. Same reasoning as 0061's `dependency_lines`.
-- ===========================================================================================

GRANT SELECT, INSERT, UPDATE ON dependency_bump_authorships TO scp_app;
--> statement-breakpoint
-- Explicit and intentionally redundant (0035/0061 use the same belt-and-braces form): a future
-- migration that blanket-grants on this schema has to step over this line to break it.
REVOKE DELETE ON dependency_bump_authorships FROM scp_app;
--> statement-breakpoint

-- ===========================================================================================
-- RLS — the identical `org_isolation` shape as every other tenant table (0002 §2 / 0007 §8).
-- ===========================================================================================

ALTER TABLE dependency_bump_authorships ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE dependency_bump_authorships FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS org_isolation ON dependency_bump_authorships;
--> statement-breakpoint
CREATE POLICY org_isolation ON dependency_bump_authorships
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
--> statement-breakpoint

COMMENT ON TABLE dependency_bump_authorships IS
  'ADR-0032 §8/§9: what CommanderSCP ITSELF authored for a dependency bump — repo, base branch, authored ref, subject, head commit, the pull request it opened, and whether it merged. SERVER-OWNED: written only by the bump actuator and by the ingress that observes SCP''s own branch back. It exists because changes.source_ref is tenant-writable through POST /changes and can never be the authority for a merge; a change with no row here is NOT a bump change and never reaches the merge path.';
--> statement-breakpoint
COMMENT ON COLUMN dependency_bump_authorships.pull_request_number IS
  'The pull request SCP opened, recorded when it opened it. The merge is addressed to this number — never to the first entry of a provider list filtered on head branch, which lets provider ordering (or a second pull request opened from SCP''s branch to a protected base) decide what gets merged.';
--> statement-breakpoint

-- ===========================================================================================
-- `control_runs.plugin_module` — see the header for why a LEFT JOIN to the current binding was
-- retroactive re-narration rather than a lookup.
-- ===========================================================================================

ALTER TABLE control_runs ADD COLUMN IF NOT EXISTS "plugin_module" text;
--> statement-breakpoint

COMMENT ON COLUMN control_runs.plugin_module IS
  'The control_bindings.plugin_module that PRODUCED this run, stamped at insert. Not read from the binding at query time: a binding is mutable, so re-pointing one control at github-check would retroactively relabel every historical run of it as "the component''s own checks passed". NULL means the row predates this column (or was deposited with no binding at all) and is treated as NOT an own-check — the fail-closed direction.';
