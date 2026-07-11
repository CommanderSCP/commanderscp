-- M6 review fix (CRITICAL: key rotation gave no compromise recovery). Anchor peer-key validity to
-- the AUTHENTICATED, monotonic journal sequence instead of a self-declared, attacker-choosable
-- timestamp. See db/schema.ts `federationPeerKeys` doc comment for the full model.
--
-- Hand-authored (the project's established convention for column additions — drizzle-kit generate
-- prompts interactively for column provenance, which cannot run non-interactively in CI). Existing
-- rows are pre-1.0 dev data: the very first key of a peer legitimately spans all sequences, so the
-- backfill defaults (effective_from_sequence = 0, superseded_at_sequence = NULL) are correct for
-- every already-current key. A previously-superseded key (there are none in practice pre-1.0) would
-- need its sequence anchor set by hand; none exist, so no data backfill statement is required.

ALTER TABLE "federation_peer_keys"
  ADD COLUMN IF NOT EXISTS "effective_from_sequence" bigint DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "federation_peer_keys"
  ADD COLUMN IF NOT EXISTS "superseded_at_sequence" bigint;
