-- ===========================================================================================
-- 0069 — CONTRACT: the per-line producer columns go away (ADR-0032 §7e).
--
-- The EXPAND half is 0068, which created `dependency_line_producers` and backfilled it from these
-- columns. This file removes them, and it removes them rather than leaving them NULLable-and-unused
-- for a reason: a dead column that still means something is a column the next reader will "fix" by
-- populating, and populating it from ingestion is precisely the change that would delete
-- "declared, never inferred" (0068's header states why that must not happen).
--
-- READERS THAT MOVED, so the census is on the record rather than in a commit message:
--
--   listThirdPartyDependencyLinesByIds  isNull(produced_by_object_id)
--                                       -> NOT EXISTS anti-join on dependency_line_producers
--                                          by (org_id, ecosystem, coordinate)
--   asThirdPartyLine                    re-read the column
--                                       -> takes the joined "no declaration for this coordinate"
--                                          fact as an argument; the BRAND is unchanged, so
--                                          `queryLineHead` still accepts nothing else
--   listProducedLines                   partial index on the column
--                                       -> the producer's coordinates from
--                                          dependency_line_producers_org_producer, then the lines
--                                          by (org_id, ecosystem, coordinate) — a PREFIX of the
--                                          existing dependency_lines_identity index
--
-- Both third-party barriers still read ONE fact (does a declaration exist for this coordinate), so
-- removing either alone still leaves the other refusing — the property 0061 built and this keeps.
--
-- THE INDEX AND THE CHECK GO WITH THE COLUMNS. Postgres would drop both automatically with the
-- columns; they are named explicitly so the intent is legible in the file rather than implied by a
-- cascade, and so a reader of `\d+ dependency_lines` who remembers them can find where they went.
-- The CHECK is RETIRED, not reproduced: every column of the new table is NOT NULL and the row's
-- existence IS the declaration, so a half-written declaration is unrepresentable rather than
-- refused.
-- ===========================================================================================

DROP INDEX IF EXISTS "dependency_lines_org_producer";
--> statement-breakpoint
ALTER TABLE dependency_lines DROP CONSTRAINT IF EXISTS "dependency_lines_internal_is_declared";
--> statement-breakpoint
ALTER TABLE dependency_lines DROP COLUMN IF EXISTS "produced_by_object_id";
--> statement-breakpoint
ALTER TABLE dependency_lines DROP COLUMN IF EXISTS "produced_by_declared_at";
--> statement-breakpoint
ALTER TABLE dependency_lines DROP COLUMN IF EXISTS "produced_by_declared_by_object_id";
