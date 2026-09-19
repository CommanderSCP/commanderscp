-- `federation_peer_observations` — WHAT THE EXECUTING DOMAIN SAW, AS THIS DOMAIN RECEIVED IT.
--
-- ===========================================================================================
-- THE GAP THIS CLOSES (docs/proposals/pipeline-mockup-data.md §5.3, owner decisions D3/D4)
-- ===========================================================================================
-- A change is coordinated in exactly ONE domain, and only that domain has `change_wave_targets`
-- and `pipeline_hook_runs` rows. Until now no journal kind carried either of them upward
-- (`change_status` carries coarse lifecycle only), so a commander showing an outpost-driven change
-- had nothing to render: no rollout pips, no check state. It said "not reported", which was true
-- and is what the owner asked to end. The new `wave_target_observed` journal kind carries both
-- subjects up; this table is where the receiver puts them.
--
-- ===========================================================================================
-- WHY A SEPARATE REPLICA AND NOT `change_wave_targets` / `pipeline_hook_runs`
-- ===========================================================================================
-- Projecting a peer's observation into the real tables would put a row in front of the reconcile
-- loop, the wave gates and the stage-dependency hold that no local plan compiled and no local
-- executor drives — `findLatestWaveTargetForObject` feeds the hold, and a peer-authored
-- "succeeded" there would satisfy a gate on evidence this instance never took. That is the
-- "unbound placement fake-succeeds" failure with a peer's data in it. Kept in its own table, the
-- worst a hostile or broken peer can do is put a wrong reading on a display that NAMES the peer it
-- came from.
--
-- ===========================================================================================
-- PROVENANCE IS RECEIVER-STAMPED, AND `observed_at` IS NOT PROVENANCE
-- ===========================================================================================
-- `peer_domain_id` is the domain whose signature the bundle verified against (TRUST sense,
-- ADR-0021 D4) — never a payload field, the rule `pipeline_evidence_upsert` already states for
-- `source`/`producer_subject_id`. `received_at` is this instance's own clock. `observed_at` is the
-- sender's statement of when it looked: useful, and DATA. The read surface ages the row against
-- `received_at`/now and reports `stale` instead of believing an old reading is current — an
-- air-gapped outpost delivering by bundle is legitimately hours behind, and saying so is the
-- point.
--
-- ===========================================================================================
-- WHY THE IDENTITY IS `UNIQUE NULLS NOT DISTINCT`, AND WHY THAT BOUNDS D3
-- ===========================================================================================
-- D3 chose FULL run progress (every status transition of a post-merge/post-deploy run) over
-- terminal-only. The volume bound has two halves: the sender emits only on a real forward status
-- change (never per poll tick, never on an `attempt` bump), and the receiver keeps ONE row per
-- identity — so the table's size is proportional to (runs + targets) per change, not to
-- transitions and never to elapsed time. `NULLS NOT DISTINCT` is what makes that true for a
-- `postMerge` run, whose `target_object_id` and `wave_index` are both NULL: under the default
-- NULLS DISTINCT the upsert would never conflict and every transition would insert a new row.
-- That is exactly the trap `pipeline_hook_runs_identity` (drizzle/0098) documents. PostgreSQL 15+
-- syntax; DESIGN.md names 16 as the floor and 0098 already requires it.

CREATE TABLE IF NOT EXISTS "federation_peer_observations" (
  "id" uuid PRIMARY KEY,
  "org_id" uuid NOT NULL,
  -- TRUST sense (ADR-0021 D4): the verified bundle signer, stamped by the import door.
  "peer_domain_id" uuid NOT NULL,
  -- The payload union's discriminant: 'target' | 'hook_run'.
  "subject" text NOT NULL,
  -- DELIBERATELY NOT `REFERENCES objects(id)`: the observation may arrive before (or without) the
  -- replica change object — scope filtering and bundle ordering both allow it, and refusing the
  -- reading would lose it forever. `federation_unattached_change_status` makes the same call.
  "change_object_id" uuid NOT NULL,
  "target_object_id" uuid,
  "type" text,
  "wave_index" integer,
  "component_object_id" uuid,
  "hook_id" text,
  "hook_kind" text,
  "status" text NOT NULL,
  "attempt" integer NOT NULL DEFAULT 0,
  "external_url" text,
  "started_at" timestamp with time zone,
  -- The rest of the reading as the peer stated it, bounded at the sender and re-bounded here.
  "observation" jsonb,
  "observed_at" timestamp with time zone NOT NULL,
  "received_at" timestamp with time zone NOT NULL DEFAULT now(),
  "first_seen_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "federation_peer_observation_identity"
    UNIQUE NULLS NOT DISTINCT
    ("org_id", "peer_domain_id", "subject", "change_object_id", "target_object_id", "type", "hook_id", "wave_index"),
  CONSTRAINT "federation_peer_observation_subject_check" CHECK ("subject" IN ('target','hook_run'))
);
--> statement-breakpoint

-- The read path: every observation for one change, which is what the service board's
-- not-driven-here branch asks for once per row.
CREATE INDEX IF NOT EXISTS "federation_peer_observation_by_change"
  ON "federation_peer_observations" ("org_id", "change_object_id");
--> statement-breakpoint

-- The request-serving role writes these rows (the import door runs on the tenant pool), so it
-- needs INSERT and UPDATE as well as SELECT. Without the GRANT the omission would surface as a
-- 500 on an authorized import — the integration superuser hides it, which is why it is stated
-- here beside the table rather than assumed.
GRANT SELECT, INSERT, UPDATE, DELETE ON federation_peer_observations TO scp_app;
--> statement-breakpoint
ALTER TABLE federation_peer_observations ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE federation_peer_observations FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS org_isolation ON federation_peer_observations;
--> statement-breakpoint
CREATE POLICY org_isolation ON federation_peer_observations
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
--> statement-breakpoint

COMMENT ON TABLE federation_peer_observations IS
  'pipeline-mockup-data.md D3/D4: a READ-ONLY replica of wave-target and pipeline-hook-run observations reported upward by a peer through the wave_target_observed journal kind. Never read by the reconcile loop, the wave gates or the stage-dependency hold — a peer-authored reading must not satisfy a local gate. peer_domain_id and received_at are receiver-stamped from the verified bundle signer and this clock; observed_at is the sender''s own statement and is aged before it is displayed. UNIQUE NULLS NOT DISTINCT on the identity is what bounds D3: one row per (peer, subject, identity), not one per status transition.';
