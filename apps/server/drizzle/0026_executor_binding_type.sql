-- ===========================================================================================
-- ADR-0007 — Executor binding **Type** taxonomy (Category over Type), replacing `purpose`.
-- Spec: docs/adr/0007-executor-binding-type-taxonomy.md, docs/proposals/executor-type-taxonomy.md.
--
-- HARD CUTOVER (owner decision D3, 2026-07-17). The flat routing key `purpose ∈ {infra, software}`
-- on `executor_bindings`, `source_mappings`, and `change_wave_targets` is RENAMED to `type` and
-- migrated to a closed two-level taxonomy:
--
--   Category (derived, NOT stored): build | infrastructure | configuration
--   Type     (the routing key):     image | rpm | deb | npm | infrastructure | configuration
--
-- Category is a static Type→Category map in packages/schemas (`CATEGORY_OF_TYPE`); it is NEVER a
-- column. Routing and the UNIQUE(org, target, type) identity stay on Type. The value set is a plain
-- `text` column (no pg enum / CHECK) enforced in the API layer (Zod), exactly as `purpose` was — so
-- this migration is column-rename + value-backfill + default-change only, with NO enum-type ALTER.
--
-- Safe as a single coordinated migration because there is ONE instance (homelab) — no federation
-- version-skew (ADR-0007 D3). A post-federation cutover would instead need a lockstep fleet upgrade,
-- since `changes-repo.ts`'s `typeOf()` now THROWS on the retired 'infra'/'software' values.
--
-- BACKFILL is GENERIC + DETERMINISTIC ONLY. It classifies by the executor MODULE (bindings) or the
-- old column value (mappings / wave targets) — it does NOT hardcode any org's repo names. Precise,
-- org-specific reclassification of individual imports (e.g. an image-building GitHub repo that should
-- be `image` rather than the `configuration` default, or a `homelab-gitops` mapping) is a SEPARATE
-- live-data step performed post-deploy against the running instance — it is org data, not schema.
--
-- oasdiff: removing 'infra'/'software' from request-position enums and renaming the field is a
-- deliberate breaking change to /v1, landed under the one-time `api-v2-exception` this cutover
-- carries (ADR-0007 "API impact"; tools/openapi/OASDIFF-EXCEPTIONS.md).
-- ===========================================================================================

-- (a) Rename the column `purpose` -> `type` on all three tables. The old DEFAULT 'software' rides
--     along with the column until step (d) replaces it; existing values are rewritten in step (c).
ALTER TABLE "executor_bindings"    RENAME COLUMN "purpose" TO "type";
ALTER TABLE "source_mappings"      RENAME COLUMN "purpose" TO "type";
ALTER TABLE "change_wave_targets"  RENAME COLUMN "purpose" TO "type";

-- (b) Rename the unique constraint to match the renamed column (identity stays on the routing key).
ALTER TABLE "executor_bindings"
  RENAME CONSTRAINT "executor_bindings_org_target_purpose_key"
  TO "executor_bindings_org_target_type_key";

-- (c) Backfill the new vocabulary.
--
--   executor_bindings — classify by MODULE (a binding's `plugin_module` says what kind of executor
--   it is, which is the honest signal; the old 'software'/'infra' value mislabelled argocd bindings):
--     terraform / managed-iac        -> infrastructure (true IaC substrate);
--     github + old 'software'         -> image         (CI/build bindings observe an image pipeline);
--     github + old 'infra'            -> configuration (github infra bindings observe a GitOps/config authority);
--     everything else (argocd, fake…)-> configuration (the safe default — argocd bindings SYNC desired state).
--
--   The github split is deterministic on `plugin_module` + the retired value (still present in the
--   renamed column at this point) — NOT on any repo name. It is also REQUIRED for correctness: a target
--   may legitimately hold two same-module bindings under distinct old purposes (a deployment-target
--   observing both a build repo AND a config authority via github). Collapsing both to one Type would
--   violate the UNIQUE(org, target, type) key renamed in step (b) and abort the migration. Splitting
--   github by the old value keeps them distinct ({image, configuration}). Precise per-repo Type
--   refinement (e.g. rpm/deb vs image, or an infra github binding that wraps Terraform) remains the
--   separate org-data step.
UPDATE "executor_bindings"
  SET "type" = CASE
    WHEN "plugin_module" IN ('terraform', 'managed-iac') THEN 'infrastructure'
    WHEN "plugin_module" = 'github' AND "type" = 'software' THEN 'image'
    WHEN "plugin_module" = 'github' AND "type" = 'infra' THEN 'configuration'
    ELSE 'configuration'
  END;

--   source_mappings + change_wave_targets — deterministic value map from the retired vocabulary:
--     'infra' -> 'infrastructure', 'software' -> 'configuration', anything else -> 'configuration'.
UPDATE "source_mappings"
  SET "type" = CASE
    WHEN "type" = 'infra' THEN 'infrastructure'
    WHEN "type" = 'software' THEN 'configuration'
    ELSE 'configuration'
  END;

UPDATE "change_wave_targets"
  SET "type" = CASE
    WHEN "type" = 'infra' THEN 'infrastructure'
    WHEN "type" = 'software' THEN 'configuration'
    ELSE 'configuration'
  END;

-- (d) Point the column DEFAULT at the new default Type (was 'software' on all three).
ALTER TABLE "executor_bindings"    ALTER COLUMN "type" SET DEFAULT 'configuration';
ALTER TABLE "source_mappings"      ALTER COLUMN "type" SET DEFAULT 'configuration';
ALTER TABLE "change_wave_targets"  ALTER COLUMN "type" SET DEFAULT 'configuration';
