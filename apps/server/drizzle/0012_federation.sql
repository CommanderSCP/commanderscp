-- M6 Federation (BUILD_AND_TEST.md §8 M6, DESIGN.md §13). Hand-authored, same reason and same
-- pattern as 0002/0007/0010/0011: drizzle-kit's interactive column-provenance prompt can't run
-- non-interactively (it can't tell "add objects.provenance" apart from "rename an existing
-- column"), and RLS/grants/seed data are never expressible in its schema diffing.

-- ===========================================================================================
-- 1. `objects.provenance` — hand-fill tracking (DESIGN §13: "manually entered parent-origin
--    objects are stored as `provenance: manual`... reconciled when a signed bundle later
--    arrives"). NULL = normal; 'manual' = unverified shadow copy.
-- ===========================================================================================

ALTER TABLE objects ADD COLUMN IF NOT EXISTS "provenance" text;

-- ===========================================================================================
-- 1b. `instance_keys` becomes org-scoped (db/schema.ts's updated doc comment on this table
--    explains why — M4's own doc comment anticipated exactly this evolution: "multi-org
--    attestation verification is out of M4 scope (no federation yet — M6)"). Pre-1.0/unreleased
--    system, no production deployments to migrate: any existing singleton row predates every org
--    association and is simply regenerated per-org, lazily, on next use
--    (governance/attestation.ts `ensureInstanceKey`) — safe to drop outright rather than backfill.
-- ===========================================================================================

ALTER TABLE instance_keys ADD COLUMN IF NOT EXISTS "org_id" uuid;
DELETE FROM instance_keys;
ALTER TABLE instance_keys ALTER COLUMN "org_id" SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "instance_keys_org_id_key" ON instance_keys USING btree ("org_id");

-- ===========================================================================================
-- 2. New tables — see db/schema.ts's doc comments for the design rationale on each.
-- ===========================================================================================

CREATE TABLE IF NOT EXISTS "federation_self" (
  "org_id" uuid PRIMARY KEY NOT NULL,
  "domain_id" uuid NOT NULL,
  "name" text NOT NULL,
  "role" text DEFAULT 'unset' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "federation_self_domain_id_key" ON "federation_self" USING btree ("domain_id");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "federation_peers" (
  "id" uuid PRIMARY KEY NOT NULL,
  "org_id" uuid NOT NULL,
  "name" text NOT NULL,
  "role" text NOT NULL,
  "base_url" text,
  "sync_scope" jsonb DEFAULT '{"mode":"full"}'::jsonb NOT NULL,
  "paired_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "federation_peers_org_id_key" ON "federation_peers" USING btree ("org_id","id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "federation_peers_org" ON "federation_peers" USING btree ("org_id");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "federation_peer_keys" (
  "id" uuid PRIMARY KEY NOT NULL,
  "org_id" uuid NOT NULL,
  "peer_domain_id" uuid NOT NULL,
  "public_key" text NOT NULL,
  "effective_from" timestamp with time zone DEFAULT now() NOT NULL,
  "superseded_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "federation_peer_keys_org_peer" ON "federation_peer_keys" USING btree ("org_id","peer_domain_id","superseded_at");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "sync_journal" (
  "seq" bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  "id" uuid PRIMARY KEY NOT NULL,
  "org_id" uuid NOT NULL,
  "origin_domain_id" uuid NOT NULL,
  "sequence" bigint NOT NULL,
  "entry_kind" text NOT NULL,
  "payload" jsonb NOT NULL,
  "content_hash" text NOT NULL,
  "base_revision" bigint,
  "conflict" text,
  "prev_hash" text NOT NULL,
  "row_hash" text NOT NULL,
  "signature" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "sync_journal_origin_sequence_key" ON "sync_journal" USING btree ("org_id","origin_domain_id","sequence");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sync_journal_org_origin_seq" ON "sync_journal" USING btree ("org_id","origin_domain_id","sequence");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "sync_cursors" (
  "org_id" uuid NOT NULL,
  "peer_domain_id" uuid NOT NULL,
  "origin_domain_id" uuid NOT NULL,
  "last_applied_seq" bigint DEFAULT 0 NOT NULL,
  "last_applied_row_hash" text,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "sync_cursors_pk" ON "sync_cursors" USING btree ("org_id","peer_domain_id","origin_domain_id");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "bundle_transfers" (
  "id" uuid PRIMARY KEY NOT NULL,
  "org_id" uuid NOT NULL,
  "peer_domain_id" uuid NOT NULL,
  "direction" text NOT NULL,
  "kind" text DEFAULT 'sync' NOT NULL,
  "status" text DEFAULT 'created' NOT NULL,
  "since_sequence" bigint,
  "through_sequence" bigint,
  "checksum" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "confirmed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bundle_transfers_org_peer" ON "bundle_transfers" USING btree ("org_id","peer_domain_id","created_at");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "imported_approval_evidence" (
  "id" uuid PRIMARY KEY NOT NULL,
  "org_id" uuid NOT NULL,
  "change_object_id" uuid NOT NULL,
  "origin_domain_id" uuid NOT NULL,
  "attestation" jsonb NOT NULL,
  "verified" boolean NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "imported_approval_evidence_org_change" ON "imported_approval_evidence" USING btree ("org_id","change_object_id");
--> statement-breakpoint

-- ===========================================================================================
-- 3. Grants — tenant data, same treatment as 0007/0010/0011: scp_app never gets DELETE
--    (append/update-only — nothing in this milestone hard-deletes federation history; the sync
--    journal in particular must stay append-only, matching audit_events' own discipline).
-- ===========================================================================================

GRANT SELECT, INSERT, UPDATE ON
  federation_self, federation_peers, federation_peer_keys, sync_cursors, bundle_transfers
TO scp_app;
GRANT SELECT, INSERT ON sync_journal, imported_approval_evidence TO scp_app;

-- `sync_journal.seq` is a GENERATED ALWAYS AS IDENTITY column — same belt-and-braces grant
-- 0002 §1 already applies to every sequence in the schema, re-stated here for clarity.
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO scp_app;

-- ===========================================================================================
-- 4. RLS — identical `org_isolation` shape as every other tenant table.
-- ===========================================================================================

ALTER TABLE federation_self ENABLE ROW LEVEL SECURITY;
ALTER TABLE federation_self FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON federation_self;
CREATE POLICY org_isolation ON federation_self
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

ALTER TABLE federation_peers ENABLE ROW LEVEL SECURITY;
ALTER TABLE federation_peers FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON federation_peers;
CREATE POLICY org_isolation ON federation_peers
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

ALTER TABLE federation_peer_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE federation_peer_keys FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON federation_peer_keys;
CREATE POLICY org_isolation ON federation_peer_keys
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

ALTER TABLE sync_journal ENABLE ROW LEVEL SECURITY;
ALTER TABLE sync_journal FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON sync_journal;
CREATE POLICY org_isolation ON sync_journal
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

ALTER TABLE sync_cursors ENABLE ROW LEVEL SECURITY;
ALTER TABLE sync_cursors FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON sync_cursors;
CREATE POLICY org_isolation ON sync_cursors
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

ALTER TABLE bundle_transfers ENABLE ROW LEVEL SECURITY;
ALTER TABLE bundle_transfers FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON bundle_transfers;
CREATE POLICY org_isolation ON bundle_transfers
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

ALTER TABLE imported_approval_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE imported_approval_evidence FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON imported_approval_evidence;
CREATE POLICY org_isolation ON imported_approval_evidence
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

-- ===========================================================================================
-- 5. `annotates` becomes system-managed (DESIGN §13 overlays: "policy overlays may only add
--    strictness" — an authority-checked rule that only `federation/overlay-repo.ts`'s dedicated
--    `createOverlay` enforces, mirroring 0002 §6's `approves`/`coordinates` treatment). The
--    generic `/relationships` endpoint and IaC plan/apply must refuse to create/delete it
--    directly from here on (graph/system-managed-relationships.ts is updated in the same PR).
-- ===========================================================================================
-- (no schema change needed — enforcement lives in application code; this comment documents the
--  migration boundary at which the code-level allowlist changed, for anyone bisecting history.)

-- ===========================================================================================
-- 6. New permission for federation write operations (pairing, export/import, hand-fill) — the
--    natural home is Administrator, alongside its existing type-registry/policy authority.
-- ===========================================================================================

UPDATE roles SET permissions = array_append(permissions, 'federation:write')
WHERE org_id IS NULL AND name IN ('Administrator', 'Owner') AND NOT ('federation:write' = ANY(permissions));

UPDATE roles SET permissions = array_append(permissions, 'federation:read')
WHERE org_id IS NULL AND name IN ('Viewer', 'Operator', 'Approver', 'Administrator', 'Owner')
  AND NOT ('federation:read' = ANY(permissions));
