-- `artifact` — THE IMMUTABLE BUILT THING IDENTIFIED BY DIGEST, as a first-class object
-- (ADR-0045, owner decisions 2026-08-25).
--
-- Registry rows, not a table (charter principle 2; ADR-0026/0051's precedent, applied verbatim):
-- one object type, one relationship type, one partial unique index. No new column anywhere else.
--
-- ===========================================================================================
-- IDENTITY (ADR-0045 D1) — `(org_id, digest, artifactType)`, `artifactType` an OPEN STRING
-- ===========================================================================================
-- `artifactType` is `'oci' | 'blob'` TODAY (matching `PromotionManifestSchema.artifacts[].type`,
-- packages/schemas/src/federation.ts) but is declared here with NO `enum` and NO
-- `additionalProperties: false` — 0081's header rule (`deployment-target`.substrate,
-- `publishes_to`), restated: this type is JOURNALED (`object_upsert`) and Ajv-validated on the
-- RECEIVING side of federation with no try/catch around that branch (federation/import-repo.ts),
-- so a closed schema turns every future artifact kind — or any peer one migration behind — into a
-- fail-closed abort of the peer's WHOLE signed bundle, not just the one entry. `required` carries
-- none of that risk: `digest`/`artifactType` are CONSTITUTIVE of an artifact, so requiring them
-- enforces the identity rule at every write door without narrowing what a value may be.
-- ===========================================================================================

INSERT INTO object_types (id, org_id, display_name, property_schema, is_builtin) VALUES
  (
    'artifact',
    NULL,
    'Artifact',
    '{
       "type": "object",
       "properties": {
         "digest": { "type": "string", "minLength": 1 },
         "artifactType": { "type": "string", "minLength": 1 }
       },
       "required": ["digest", "artifactType"]
     }'::jsonb,
    true
  )
ON CONFLICT (id) DO NOTHING;

-- ===========================================================================================
-- `derived_from` (ADR-0045 D4) — artifact -> artifact, `many_to_one`.
--
-- One derivative names exactly one base (the FROM side singular); a base may be the origin of
-- many derivatives (the TO side plural — many destination-modified images can derive from one
-- commander-attested base). Enforced by `graph/relationships-repo.ts`'s `assertCardinality`:
-- `SINGULAR_SIDES.many_to_one = { from: true, to: false }` refuses a SECOND `derived_from` edge
-- out of the same `from_id` (a from-side clash on `(org_id, type_id, from_id)`), which is exactly
-- "one derivative cannot claim two bases". `produced_by` (artifact -> the run that built it) is
-- named in ADR-0045 and DEFERRED — a different question ("what process made this" vs. "what
-- artifact is this a modification of"); not this migration's concern.
-- ===========================================================================================

INSERT INTO relationship_types (id, org_id, display_name, from_types, to_types, cardinality, is_builtin) VALUES
  ('derived_from', NULL, 'Derived From',
    ARRAY['artifact'], ARRAY['artifact'], 'many_to_one', true)
ON CONFLICT (id) DO NOTHING;

-- ===========================================================================================
-- IDENTITY, ENFORCED — mirrors 0051's `objects_placement_one_per_component_target` shape exactly.
--
-- `deleted_at IS NULL` so a soft-deleted artifact frees its identity to be re-minted (matching
-- every other partial unique index in this schema — 0022, 0049, 0051). Minting is UPSERT-BY-
-- IDENTITY (`mintArtifactObjects`, coordination), so this index is the race guard for two
-- concurrent mints of the same digest — export and import can run at genuinely different times on
-- different domains, but within ONE domain a re-export of an already-exported change must converge
-- on the SAME row, never a duplicate.
-- ===========================================================================================

CREATE UNIQUE INDEX IF NOT EXISTS "objects_artifact_one_per_digest_type"
  ON "objects" ("org_id", (("properties" ->> 'digest')), (("properties" ->> 'artifactType')))
  WHERE "type_id" = 'artifact' AND "deleted_at" IS NULL;
