-- ===========================================================================================
-- 0079 — `governance:move` AS A TOP-DOWN MONOTONE LATTICE
--        (docs/proposals/governance-reach-on-containment-move.md §9.2, owner ruling 2026-08-18)
--
-- A containment MOVE re-parents an object, and re-parenting decides which policies reach it and who
-- else holds authority over it. #244 made a move a write at BOTH ends (`object:write` at the source
-- and at the destination). This migration adds the substrate for the second, opt-in bar the owner
-- ruled on: an org may declare that moves under a given container are a GOVERNANCE act, requiring a
-- new `governance:move` permission at both ends.
--
-- THE LATTICE IS MONOTONE AND TOP-DOWN, in the owner's words: "flipped on/off at the commander
-- level; if enabled there, orgs can't disable it; same with the next layer … if an org enables it, a
-- service can't disable it." Two tables express that:
--
--   * `governance_move_instance_rung` — the INSTANCE (commander) rung. It ACTIVATES (owner decision
--     Q1-A), it does not merely permit: enabled here means enforced for every org and every object
--     on this deployment. Operator-authored, exactly like `dependency_subscription_unlock` (0062).
--   * `governance_move_rungs` — one row per container object (org root, containment domain, service,
--     assembly) an org has enabled. Enforcement applies to a move iff the instance rung is enabled
--     OR any object on the MOVED object's containment chain or on the DESTINATION's chain carries a
--     row here. Disabling a rung under an enabled upper rung is refused 409 (the state must not
--     silently stay enforced after a "successful" disable).
--
-- NOTHING CHANGES UNTIL A RUNG IS SET. Both tables ship empty; an empty `governance_move_rungs` and
-- an absent instance row mean "no enforcement anywhere", which is the state every existing
-- deployment and every existing test is in. That is why the four protected move/authoring suites
-- keep their outcomes across this change.
--
-- Hand-authored (same convention as 0002/0007/0010/0011/0014/0017/0028/0029/0035/0036/0061/0062):
-- RLS, grants and the built-in role grant are not expressible in drizzle-kit's schema diffing.
-- ===========================================================================================

-- ===========================================================================================
-- 1. THE PER-OBJECT RUNGS — ordinary tenant data (the 0071 shape, exactly).
-- ===========================================================================================

CREATE TABLE IF NOT EXISTS "governance_move_rungs" (
  "org_id" uuid NOT NULL,
  -- The CONTAINER the rung sits on. PRIMARY KEY: a rung is enabled or it is not — there is no
  -- second enablement of the same subject to represent, and an upsert is the whole write verb.
  -- ORG-UNBOUND `REFERENCES objects(id)` for the reason 0061/0071 state at length (`objects` carries
  -- no `(org_id, id)` unique constraint to hang a composite key on); the route owes the mitigation,
  -- and `routes/governance-move.ts` pays it by resolving every caller-supplied id through
  -- `getObjectByIdOrUrnAnyType` under the CALLER'S OWN org before it reaches this table.
  "subject_object_id" uuid NOT NULL REFERENCES objects(id),
  -- The tier LITERAL as it was at write time. EXPLAINABILITY ONLY, never re-derived on read: the
  -- same convention `dependencies/subscription-resolution.ts`'s `tierForObjectType` documents. If a
  -- subject's type ever changed, the rung would still explain itself as what it was enabled as.
  "tier" text NOT NULL,
  -- Principle 6: WHO enabled it. Stamped from the authenticated subject at the route, never from the
  -- request body — a caller-supplied provenance label is a forgeable one.
  "enabled_by_object_id" uuid NOT NULL REFERENCES objects(id),
  "enabled_at" timestamp with time zone NOT NULL DEFAULT now(),
  -- The Decision this enablement recorded. NULLABLE because a row written by a future importer or a
  -- backfill may legitimately have none; the route always fills it.
  "decision_id" uuid,
  CONSTRAINT "governance_move_rungs_pk" PRIMARY KEY ("subject_object_id"),
  CONSTRAINT "governance_move_rungs_tier_ck"
    CHECK ("tier" IN ('org', 'containment_domain', 'service', 'assembly'))
);
--> statement-breakpoint

-- "Which rungs has this org enabled?" — the list read, and the join the resolver runs against a
-- containment chain. The PK already covers the by-subject lookup.
CREATE INDEX IF NOT EXISTS "governance_move_rungs_org"
  ON "governance_move_rungs" USING btree ("org_id");
--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE ON governance_move_rungs TO scp_app;
--> statement-breakpoint

ALTER TABLE governance_move_rungs ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE governance_move_rungs FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS org_isolation ON governance_move_rungs;
--> statement-breakpoint
CREATE POLICY org_isolation ON governance_move_rungs
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
--> statement-breakpoint

COMMENT ON TABLE governance_move_rungs IS
  'governance-reach-on-containment-move §9.2: the containers under which a containment MOVE additionally requires the `governance:move` permission at BOTH ends. Monotone and top-down — enforcement applies iff the instance rung or ANY rung on the moved object''s chain or the destination''s chain is enabled, so a rung enabled above cannot be disabled below (the DELETE route answers 409 naming the upper rung). Empty means no enforcement anywhere, which is every deployment''s shipped state.';
--> statement-breakpoint

-- ===========================================================================================
-- 2. THE INSTANCE RUNG — the 0062 unlock shape, EXACTLY (singleton, tenant-read, operator-write).
--
-- It differs from 0062 in MEANING and not in shape: the dependency-subscription unlock UNLOCKS (it
-- permits an org to enable something; on its own it activates nothing), while this rung ACTIVATES
-- (owner decision Q1-A — "if enabled there, orgs can't disable it"). The storage is identical
-- because the AUTHORITY question is identical: a deployment-wide switch no tenant role may flip.
--
-- NO ROW MEANS DISABLED. `readInstanceMoveRung` is the ONE place that default is decided, exactly as
-- `readInstanceSubscriptionUnlock` is for the unlock — re-deriving it in a route is how the API and
-- the doors would come to disagree about a deployment that was never configured.
-- ===========================================================================================

CREATE TABLE IF NOT EXISTS "governance_move_instance_rung" (
  "id" text NOT NULL DEFAULT 'default',
  "enabled" boolean NOT NULL DEFAULT false,
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "governance_move_instance_rung_pk" PRIMARY KEY ("id"),
  CONSTRAINT "governance_move_instance_rung_singleton_ck" CHECK ("id" = 'default')
);
--> statement-breakpoint

-- Barrier 1 — the request-serving role may only READ.
GRANT SELECT ON governance_move_instance_rung TO scp_app;
--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE ON governance_move_instance_rung FROM scp_app;
--> statement-breakpoint

-- Barrier 2 — RLS with a SELECT-only policy. `USING (true)`: the row is instance-wide config holding
-- NO per-tenant data. The ABSENCE of any INSERT/UPDATE/DELETE policy is the write denial.
ALTER TABLE governance_move_instance_rung ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE governance_move_instance_rung FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_read ON governance_move_instance_rung;
--> statement-breakpoint
CREATE POLICY tenant_read ON governance_move_instance_rung FOR SELECT USING (true);
--> statement-breakpoint

COMMENT ON TABLE governance_move_instance_rung IS
  'governance-reach-on-containment-move §9.2/§9.6 Q1-A: the instance (commander) rung of the governance:move lattice. It ACTIVATES — enabled here means every org on this deployment enforces governance:move on containment moves, and no org may disable it. No row means DISABLED: absent never means enabled. Instance-scoped (no org_id, the 0029/0035/0036/0062 exception to DESIGN §4.2); tenant-read, operator-write.';
--> statement-breakpoint

-- ===========================================================================================
-- 3. THE DEFAULT GRANT — Administrator + Owner (owner decision Q2-A), the 0010 §4 shape.
--
-- This is THE LEVER that decides whether the switch does anything. Operator, Approver, Administrator
-- and Owner all hold `object:write`, so granting `governance:move` to Operator-and-above would make
-- every principal who can move also able to move under enforcement — the lattice inert until custom
-- roles exist (and no route authors a role yet). Granting it to the two roles that already hold
-- `policy:write` makes "moving a governed object" an Administrator act under an enabled rung, while
-- the daily Operator reorganisation continues everywhere no rung is set.
--
-- Guarded against double-append exactly as 0010 guards its four grants.
-- ===========================================================================================

UPDATE roles SET permissions = array_append(permissions, 'governance:move')
WHERE org_id IS NULL AND name IN ('Administrator', 'Owner')
  AND NOT ('governance:move' = ANY(permissions));
