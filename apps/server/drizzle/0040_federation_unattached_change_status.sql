-- ===========================================================================================
-- Pre-M16 residual (Track A) — the EVIDENCE store for peer change status this domain received
-- but could not attach to anything: `federation_unattached_change_status`.
--
-- WHAT THIS IS. `federation/import-repo.ts`'s `change_status` branch has always had a documented
-- hole in its own comment: "Carrying it honestly needs a federation-layer store for unattached
-- peer status (a real feature, out of scope for the read projection that surfaced it)." This is
-- that store. A `change_status` journal entry is POSITIVE EVIDENCE that a change exists and is
-- moving on the peer — it names `payload.objectId` and a state — but when no local replica of
-- that object exists (the normal shape for a peer that ships change STATUS without the change's
-- `object_upsert`), or when this receiver's own scope filter discards the entry, the evidence was
-- dropped on the floor. `coordination/service-board.ts` then reported the affected components as
-- a confident `stable`.
--
-- WHY IT CLOSES A HOLE THE SCOPE-DERIVED TREATMENT CANNOT. The board's existing caveat is derived
-- from the RECEIVER's own `federation_peers.sync_scope`. `sync_scope` is purely local per-peer
-- config that never rides the wire, and the two sides' values are set independently by two
-- operators. So when the SENDER is the narrow side (commander exports `status_only`) and the
-- RECEIVER is wider (`changes_only`), the receiver's scope predicate says "I can see change
-- objects" while no change object is ever shipped — and the board fabricates an all-clear. The
-- drop recorded here happens at IMPORT, downstream of BOTH scopes, so it fires on that mismatch
-- exactly as it fires on the receiver-scope case. Both arms are kept: a `policies_only` RECEIVER
-- produces no evidence at all, and there the scope predicate is the only signal.
--
-- WHY A TABLE, and not a column / counter / audit event.
--   * a `federation_peers` column would be per-peer only, with no per-change state and no
--     self-clearing semantics;
--   * `bundle_transfers` has the wrong grain, and its own header declares it purely observational
--     and never consulted for authority;
--   * `sync_cursors` is per (peer, origin) with no per-change state;
--   * an audit event is a hash-chained append-only LOG, not a queryable state projection —
--     answering "is anything unattached in flight right now?" would mean scanning it.
-- Charter principle 2 (graph-native) is not in tension here: this is federation-layer transport
-- bookkeeping about entries that were NOT applied to the graph, exactly like `sync_cursors` and
-- `federation_inbox_files`, not a new top-level domain concept.
--
-- SELF-CLEARING, AND IDEMPOTENT UNDER REPLAY. Rows are keyed on (org, peer, change object id) and
-- UPSERTED, so a from-genesis re-sync converges rather than accumulating (DESIGN §6's replay
-- invariant). The `object_upsert` path DELETES any row for a change object that finally lands, so
-- the mechanism can never fabricate persistent ignorance once the evidence resolves. That is why
-- `scp_app` needs UPDATE and DELETE here, unlike 0034's insert-only ledger.
--
-- WHAT IT DELIBERATELY DOES NOT CARRY: the change's TARGETS, and therefore per-COMPONENT
-- attribution. Neither `change_status` payload shape (propose / transition) carries `targets`, and
-- the change urn (`urn:scp:{org}:change:{slug(name)}`) encodes nothing about them. Widening the
-- propose-time payload would buy per-component attribution and is wire-safe, but it would disclose
-- target component ids to a peer scoped precisely to withhold graph content — an owner decision,
-- deliberately not taken here. The caveat therefore stays board-level, same grain as today.
--
-- Hand-authored (same convention as 0002/0007/0010/0016/0030/0034): RLS/grants are never
-- expressible in drizzle-kit's schema diffing.
-- ===========================================================================================

CREATE TABLE IF NOT EXISTS "federation_unattached_change_status" (
  "id" uuid PRIMARY KEY NOT NULL,
  "org_id" uuid NOT NULL,
  -- TRUST sense (ADR-0021 D4) — the peer whose bundle carried the dropped entry.
  "peer_domain_id" uuid NOT NULL,
  -- `payload.objectId` — the change GRAPH OBJECT id on the origin domain. Not a local FK: the
  -- whole point is that no local row with this id exists (yet).
  "change_object_id" uuid NOT NULL,
  -- Propose-time enrichment only (`urn`/`name` ride the propose payload, never the transition
  -- payload), so both stay NULLABLE and are preserved across later transitions.
  "urn" text,
  "name" text,
  -- The last lifecycle state the peer reported for this change (`payload.toState ?? payload.state`).
  -- NULL when neither was present. Read by the board to condition the caveat on IN-FLIGHT states,
  -- so one long-completed change cannot make a board claim ignorance forever.
  "last_state" text,
  -- Which drop this was: 'no_local_replica' (the entry was admitted, but nothing local carries
  -- `change_object_id` — the sender withheld the change object) or 'receiver_scope' (this
  -- receiver's own scope filter discarded the entry). Recorded because they are different
  -- operator-visible causes with different fixes, and collapsing them would repeat the very
  -- conflation this table exists to end.
  "drop_reason" text NOT NULL,
  "first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

-- Upsert key. One row per (org, peer, change) — idempotent under a from-genesis re-sync.
CREATE UNIQUE INDEX IF NOT EXISTS "federation_unattached_change_identity"
  ON "federation_unattached_change_status" USING btree ("org_id", "peer_domain_id", "change_object_id");
--> statement-breakpoint

-- The board's read: "does this org hold unattached evidence in an IN-FLIGHT state right now?"
CREATE INDEX IF NOT EXISTS "federation_unattached_change_org_state"
  ON "federation_unattached_change_status" USING btree ("org_id", "last_state");
--> statement-breakpoint

-- Grants — SELECT/INSERT/UPDATE/DELETE: this is a self-clearing state projection (upserted on
-- every re-seen entry, DELETEd when the change object finally lands), not 0034's insert-only ledger.
GRANT SELECT, INSERT, UPDATE, DELETE ON "federation_unattached_change_status" TO scp_app;
--> statement-breakpoint

-- RLS — the identical `org_isolation` shape as every other tenant table (DESIGN §4.2's "two
-- independent failures" invariant).
ALTER TABLE "federation_unattached_change_status" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "federation_unattached_change_status" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS org_isolation ON "federation_unattached_change_status";
--> statement-breakpoint
CREATE POLICY org_isolation ON "federation_unattached_change_status"
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
