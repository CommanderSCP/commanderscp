-- M7 (MAJOR #5, adversarial review): webhook redelivery/replay dedup. `change_source_events.id`
-- was freshly minted per HTTP request, so a redelivery of the same (even validly-signed) provider
-- payload created a NEW event -> a NEW Change -> a duplicate real workflow_dispatch/sync/apply.
-- This adds the provider's own delivery identity as a dedupe key with a unique constraint, so a
-- redelivered/replayed webhook is a no-op. Hand-authored (same pattern as 0007/0010/0014):
-- ALTER + unique index, nothing drizzle-kit can express non-interactively.

ALTER TABLE change_source_events ADD COLUMN IF NOT EXISTS "dedupe_key" text;
--> statement-breakpoint
-- Postgres treats NULLs as DISTINCT in a unique index, so any pre-existing rows (dedupe_key NULL)
-- never collide; only the non-null keys the M7 route now always writes are deduped.
CREATE UNIQUE INDEX IF NOT EXISTS "change_source_events_dedupe"
  ON "change_source_events" USING btree ("org_id","source_kind","dedupe_key");
