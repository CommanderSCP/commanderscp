-- ===========================================================================================
-- M13.1b — the staging-node AUTO-RELAY BUILD LEDGER (`federation_relay_builds`).
--
-- WHAT THIS IS (docs/proposals/airgap-cds-validate-promote.md §13.1, BUILD_AND_TEST.md M13.1b).
-- M13.1a automated the retrans's INBOUND half (inbox arrival -> the existing verify paths). The
-- OUTBOUND half — *"when a promotion import succeeds on a `retrans`-role instance, the loop
-- schedules `buildRelayTarball` for it"* (proposal §13.1) — stayed operator-gated (M14.4's
-- honest-scope note, owner decision D3). This table is the durable state that lets an unattended
-- sweep do it exactly once per imported promotion, retry a transient failure, and STOP.
--
-- CAUSAL, NOT DERIVED. A row is written by the promotion IMPORT itself (`promotion-repo.ts`), in
-- the same transaction, only on a `role: retrans` instance, only for a promotion that carries a
-- non-empty typed artifact set. The sweep then drives EXCLUSIVELY off this table. It deliberately
-- does NOT stand a predicate scan over `changes`, because "an imported change carrying a verified
-- manifest" is also true of every promotion the HIGH-side retrans successfully forwarded — that
-- node would enumerate builds it can never perform (the source registry is on the far side of the
-- air gap, which is why the tarball exists at all) and would bury a real crossing under a trail of
-- fabricated refusals. Seeding on the causal event means a node that RECEIVED the bytes simply has
-- nothing seeded to build.
--
-- STATES
--   'pending'   — owed. `next_attempt_at` is the RETRY gate (now()+backoff after a failed attempt);
--                 `claimed_until` is the LEASE a worker holds while skopeo pulls multi-GB layers.
--                 The two are separate columns on purpose: one column doing both jobs cannot tell
--                 an operator "a build is running right now" from "a build failed and is waiting".
--   'built'     — TERMINAL: the signed tarball was produced and dropped for the onward hop.
--   'forwarded' — TERMINAL: the BYTES arrived here instead and were validated-and-forwarded
--                 (`validateAndForwardRelayTarball`). This node is the receiving side of the hop,
--                 not the building side; there is nothing to build.
--   'exhausted' — TERMINAL: `failed_attempts` hit the operator-configured cap. The manual
--                 `POST /api/v1/federation/relay` is the documented exit and CLEARS this state on
--                 success (routes/federation.ts), so a terminal row is never an unrecoverable trap.
--
-- TWO COUNTERS, ON PURPOSE. `attempts` counts CLAIMS (incremented by the claim statement, which is
-- also the fence token that makes a release safe). `failed_attempts` counts VERDICTS — attempts
-- that actually ran and failed. The cap is measured against `failed_attempts` ONLY: a worker that
-- claims and is then evicted (pod rescheduled, node drained) must not spend the change's lifetime
-- budget without ever having produced a verdict.
--
-- WHY A LEDGER TABLE AND NOT AN EXISTING SURFACE (the three candidates, and why each fails):
--
--   * `bundle_transfers` — its own header is explicit: "purely observational bookkeeping, never
--     consulted for authority/idempotency decisions". Making a timer-driven builder depend on it
--     would break exactly that invariant, and it carries no attempt count and no lease.
--   * `decisions` — a Decision is a VERDICT, not scheduler state: no attempt counter, no lease, and
--     since PR #153 (`insertDecisionIfChanged`, after a measured 1.44 GB/day unbounded write in
--     production) a repeated identical refusal deliberately does NOT write a new row, so counting
--     Decisions could never count attempts. Decisions are also a retention target; scheduler state
--     that silently resets when a retention sweep runs is not scheduler state.
--   * "does the tarball still exist in the drop directory" — the drop directory is the org's CDS
--     intake. The CDS CONSUMES what lands there (charter principle 1: everything past the drop is
--     the org's, out of scope), so an absent file means "delivered", not "never built".
--
-- Same precedent as `federation_inbox_files` (0034): a small, instance-local ledger for an
-- unattended loop's own bookkeeping. It holds no graph concept and no cross-domain state — nothing
-- here ever rides a federation bundle.
--
-- UNLIKE 0034 this ledger IS mutated (claim / lease / backoff / terminal transitions), so `scp_app`
-- gets UPDATE in addition to SELECT + INSERT — but never DELETE.
--
-- Hand-authored (same convention as 0002/0007/0010/0016/0030/0034): RLS/grants are never
-- expressible in drizzle-kit's schema diffing.
-- ===========================================================================================

CREATE TABLE IF NOT EXISTS "federation_relay_builds" (
  "id" uuid PRIMARY KEY NOT NULL,
  "org_id" uuid NOT NULL,
  -- The LOCAL imported change (`changes.object_id`) whose M17.4(a)-verified authorized artifact
  -- set is relayed. No FK: the ledger must survive independently of the change row, exactly like
  -- `federation_inbox_files` carries no FK to anything it describes.
  "change_object_id" uuid NOT NULL,
  -- The EXPORTER's change id, i.e. `changes.source_ref->>'sourceChangeObjectId'` — recorded
  -- because it names the emitted tarball (`scp-relay-<sourceChangeObjectId>.tar.gz`) and is
  -- therefore what an operator greps for at the CDS. Nullable: a change may carry none.
  "source_change_object_id" text,
  -- 'pending' | 'built' | 'forwarded' | 'exhausted' (see the header).
  "status" text NOT NULL,
  -- CLAIMS taken (also the fence token every release is guarded on).
  "attempts" integer NOT NULL DEFAULT 0,
  -- Attempts that produced a VERDICT and failed. The cap is measured against THIS, never
  -- `attempts` — an evicted worker must not spend the budget without a verdict.
  "failed_attempts" integer NOT NULL DEFAULT 0,
  -- The retry gate: a 'pending' row is workable only at/after this instant.
  "next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
  -- The lease a claiming worker holds. NULL = unclaimed. A dead worker's lease simply lapses and
  -- the row is reclaimed — no janitor, no stuck state.
  "claimed_until" timestamp with time zone,
  -- The last refusal/error text and the Decision it hangs off — `buildRelayTarball`'s OWN
  -- `retrans-relay-validate` block Decision, byte-identical to what the manual path writes
  -- (charter principle 6: an unattended refusal is explainable by exactly the same record).
  "last_reason" text,
  "last_decision_id" uuid,
  -- Where the signed tarball was dropped, on success.
  "tarball_path" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

-- The claim's conflict target: at most ONE relay-build record per local change, per org. This is
-- what makes the `INSERT … ON CONFLICT DO UPDATE … WHERE` claim in `relay-builds-repo.ts` atomic
-- across worker replicas, and what makes the causal seed idempotent under bundle replay.
CREATE UNIQUE INDEX IF NOT EXISTS "federation_relay_builds_change"
  ON "federation_relay_builds" USING btree ("org_id", "change_object_id");
--> statement-breakpoint

-- The due-scan the sweep drives off: (org, status, next_attempt_at). In steady state every row is
-- terminal, so this is an index-only probe that returns nothing rather than a table walk.
CREATE INDEX IF NOT EXISTS "federation_relay_builds_due"
  ON "federation_relay_builds" USING btree ("org_id", "status", "next_attempt_at");
--> statement-breakpoint

-- Grants — SELECT + INSERT + UPDATE (the claim mutates the row); never DELETE.
GRANT SELECT, INSERT, UPDATE ON "federation_relay_builds" TO scp_app;
--> statement-breakpoint

-- RLS — the identical `org_isolation` shape as every other tenant table (DESIGN §4.2's "two
-- independent failures" invariant).
ALTER TABLE "federation_relay_builds" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "federation_relay_builds" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS org_isolation ON "federation_relay_builds";
--> statement-breakpoint
CREATE POLICY org_isolation ON "federation_relay_builds"
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
