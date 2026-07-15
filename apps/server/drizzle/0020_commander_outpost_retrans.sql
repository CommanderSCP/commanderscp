-- Service naming rename (owner decision, 2026-07-15; docs/adr/0004-service-naming-commander-outpost-retrans.md):
-- the federation role vocabulary is a CLEAN BREAK from `parent`/`child` to `commander`/`outpost`,
-- plus a NEW `retrans` role for the CDS (cross-domain solution) boundary. `FederationRoleSchema`
-- (packages/schemas/src/federation.ts) now enforces `z.enum(["unset","commander","outpost","retrans"])`
-- at the application layer, but `role` is a plain `text` column with no CHECK constraint on either
-- table that carries it (federation_self, federation_peers — schema.ts), so no earlier migration
-- hard-codes the old values and this is purely a DATA migration: rewrite any existing 'parent'/
-- 'child' rows to their new names. A fresh/never-initialized instance has no rows to touch
-- (federation_self is created lazily with role='unset' on first use — self-repo.ts).

UPDATE "federation_self" SET "role" = 'commander' WHERE "role" = 'parent';
UPDATE "federation_self" SET "role" = 'outpost' WHERE "role" = 'child';

UPDATE "federation_peers" SET "role" = 'commander' WHERE "role" = 'parent';
UPDATE "federation_peers" SET "role" = 'outpost' WHERE "role" = 'child';
