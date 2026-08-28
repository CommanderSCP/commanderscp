-- `config-source` — THE REGISTRATION THAT MAKES A GIT REPO A DELIVERY DOOR FOR IaC
-- (ADR-0046 §1; docs/proposals/team-pipeline-iac.md §4, D2/D7/D9).
--
-- Registry rows, not a table (charter principle 2; ADR-0046 §1's own words, "graph-native registry
-- data, not a new top-level table"): one object type. No new column anywhere else, and no
-- relationship type — a config source names its team by URN in `properties`, exactly as
-- `policy.properties.scope` names its scope, because the naming is a DOCUMENT the authoring door
-- binds to the author's authority, not an edge anyone may create from either end.
--
-- ===========================================================================================
-- WHAT A ROW OF THIS TYPE GRANTS, stated here because it is the reason the door is guarded
-- ===========================================================================================
-- A config source says: "manifests under these path globs, in this repo/namespace, at this ref,
-- apply AS THIS TEAM." The sync loop (a later increment) passes that team's object id straight in
-- as `actorObjectId`, and the team's own role bindings resolve at depth 0 in `authz/resolve.ts`.
-- So minting one of these is an IDENTITY DELEGATION with exactly the shape a `member_of` edge has
-- (`routes/relationships.ts`'s module doc: a from-side-only check would let any subject with
-- `relationship:write` somewhere inherit an arbitrary team's bindings). It is guarded the same
-- way and in the same place every other authoring refusal in this codebase lives — at
-- `graph/objects-repo.ts`'s create/update choke point, so `POST /objects/{type}`, `POST /plans` +
-- apply, `POST /federation/hand-fill` and `POST /federation/overlays` are covered by construction
-- rather than by four lists happening to agree. See `config-source/authoring-guard.ts`.
--
-- ===========================================================================================
-- WHY THIS SCHEMA IS PERMISSIVE WHERE THE AUTHORING DOOR IS STRICT
-- ===========================================================================================
-- 0095's header rule, restated (and 0081's before it): this type is JOURNALED (`object_upsert`)
-- and Ajv-validated on the RECEIVING side of federation with no try/catch around that branch
-- (`federation/import-repo.ts`), so anything here that can FAIL on a peer one migration behind
-- fails that peer's WHOLE signed bundle, not just this entry.
--
-- Hence, deliberately absent:
--   * no `additionalProperties: false` — a later field must not wedge a peer;
--   * no `enum` anywhere;
--   * NO `anyOf` REQUIRING ONE OF `repo`/`repoPattern`, even though exactly one of them must be
--     set for a registration to mean anything. That constraint encodes a CLOSED SET OF ADDRESSING
--     MODES: the day a third form is added, every not-yet-upgraded peer rejects the bundle. The
--     rule is real and it IS enforced — synchronously, at the authoring door, where a refusal
--     costs one 400 to the operator who wrote it and nothing to anyone else. "Strict at the
--     operator's door, permissive on the wire" (`coordination/topology-waves.ts`'s module doc).
--
-- `required` carries none of that risk and is used for what is CONSTITUTIVE: without `ref`,
-- `paths` and `team` there is no registration — nothing to read, nothing to select, nobody to
-- apply as — so requiring them enforces the identity rule at every write door without narrowing
-- what any value may be.
-- ===========================================================================================

INSERT INTO object_types (id, org_id, display_name, property_schema, is_builtin) VALUES
  (
    'config-source',
    NULL,
    'Config Source',
    '{
       "type": "object",
       "properties": {
         "repo":        { "type": "string", "minLength": 1 },
         "repoPattern": { "type": "string", "minLength": 1 },
         "ref":         { "type": "string", "minLength": 1 },
         "paths":       { "type": "array", "items": { "type": "string", "minLength": 1 } },
         "team":        { "type": "string", "minLength": 1 },
         "stackTeams":  { "type": "object" }
       },
       "required": ["ref", "paths", "team"]
     }'::jsonb,
    true
  )
ON CONFLICT (id) DO NOTHING;
