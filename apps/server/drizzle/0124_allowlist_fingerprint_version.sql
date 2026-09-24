ALTER TABLE "execution_system_source_allowlists" ADD COLUMN "routing_fingerprint_version" integer DEFAULT 1 NOT NULL;
-- #417 verification (SHOULD-FIX 3): which `executionSystemRoutingFingerprint` a row was set under.
-- Every row written before this migration used #415's four-field v1 — hence DEFAULT 1 — and is still
-- checked under v1, so upgrading does not void existing allowlists; the next secret:write re-set
-- stamps the current version. The table's GRANT and RLS policy (0123) already cover the new column.
