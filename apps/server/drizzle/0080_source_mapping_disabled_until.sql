-- 0064 — `source_mappings.disabled_until`: a TIMED close for a source mapping (owner, 2026-08-14:
-- "disable for x period of time or until manually enabled again").
--
-- Read together with `enabled` (0063), the same way a freeze window is read (governance/
-- freezes-repo.ts): there is NO timer job that re-opens anything — the correlation matcher
-- evaluates now() at every push, so a timed close re-opens automatically and exactly on time with
-- zero moving parts to fail. Three states:
--
--   enabled = true                                → OPEN   (this column is ignored)
--   enabled = false, disabled_until IS NULL       → CLOSED until an operator re-opens
--   enabled = false, disabled_until = T           → CLOSED while now() < T, then OPEN again
--
-- Nullable on purpose: NULL is meaningful ("no bound"), so a two-state boolean cannot carry it.
-- Idempotent (IF NOT EXISTS), like every migration since the 2026-08-13 collision.

ALTER TABLE "source_mappings" ADD COLUMN IF NOT EXISTS "disabled_until" timestamptz;
