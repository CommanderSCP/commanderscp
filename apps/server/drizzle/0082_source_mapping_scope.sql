-- 0066 — `source_mappings.scope`: the DECLARED reach of a source mapping — `global` (a cross-domain
-- shared repo authored and tracked at the commander) or `domain` (tracked only in one domain)
-- (docs/proposals/pipeline-substrate-registry-scan.md §10.6, owner decision 2026-08-16: "Global
-- sources should be labeled as such in pipelines (and our CommanderSCP IaC, SDK, CLI)").
--
-- ## NULL = NOT DECLARED → NO LABEL, NOTHING INFERRED
--
-- Nullable on purpose, and unlike `mirror_of_shared` (0062, `NOT NULL DEFAULT false`) there is NO
-- default value: a two-state boolean had an honest pre-column meaning for every existing row, but
-- "global" vs "domain" does not — a pre-0066 mapping on the commander is not thereby global, and one
-- on an outpost is not thereby domain-specific. So every existing row reads NULL, the pipeline
-- renders NO provenance eyebrow for it (the tile's title says "scope not declared — set it with
-- `--scope`"), and nothing parses the site's federation role, the repo host, or a name pattern to
-- fill it in. Same read-never-infer discipline as `classification` (0057 / ADR-0030 §2) and
-- `mirror_of_shared`, for the same charter-principle-6 reason.
--
-- ## Orthogonal to `mirror_of_shared`
--
-- A `domain`-scope mapping may ALSO be a mirror of a global one (the owner's row 2 — a domain's
-- local COPY of the commander's shared IaC): `scope='domain', mirror_of_shared=true`. The two are
-- read together on the tile (mirror wins the eyebrow); neither replaces the other.
--
-- ## Never an enforcement input
--
-- A LABEL, like the two beside it: the correlation matcher (`coordination/correlation.ts`) does not
-- read it, no gate or export decision consults it, and forging or clearing it changes no routing
-- outcome. Pinned by source-mapping-scope.integration.test.ts (a global-scope and a domain-scope
-- mapping route identically). Unlike `classification`/`type` it DOES carry a CHECK — the value set
-- is closed at both ends (Zod on the wire, this constraint at rest) because a third value here
-- would render as no label at all, silently.
--
-- Idempotent (IF NOT EXISTS / DO $$ … $$ guarded constraint), like every migration since the
-- 2026-08-13 three-branch `when` collision.

ALTER TABLE "source_mappings" ADD COLUMN IF NOT EXISTS "scope" text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'source_mappings_scope_check'
  ) THEN
    ALTER TABLE "source_mappings"
      ADD CONSTRAINT "source_mappings_scope_check"
      CHECK ("scope" IS NULL OR "scope" IN ('global', 'domain'));
  END IF;
END $$;
