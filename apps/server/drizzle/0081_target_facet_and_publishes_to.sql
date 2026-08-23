-- 0065 — the deployment-target SUBSTRATE FACET and the `publishes_to` relationship type
-- (docs/proposals/pipeline-substrate-registry-scan.md §9.1 / §9.2, owner decisions 2026-08-16).
--
-- Both statements are registry DATA — an UPDATE to a builtin object type's property schema and one
-- more builtin relationship type. No new table, no new column (charter principle 2).
--
-- ===========================================================================================
-- §9.1 — `deployment-target` gains four typed, OPTIONAL string properties:
--   substrate  what runs the target — well-known values `aws|gcp|azure|kubernetes|vm|bare-metal|other`
--              (docs/GLOSSARY.md), rendered as-is, NEVER enforced here (see below)
--   account    the provider account / project / subscription id
--   region     the provider region (ALREADY load-bearing: ADR-0026 D1 stage names, M15.6 regional
--              gate — declared here once as the string it always was, no second key)
--   cluster    the cluster name inside that account/region
-- `environment` stays UNDECLARED on purpose: it is a gate input (M15.6 arms on environment+region
-- both non-empty), and declaring it here would be scope creep, not protection.
--
-- WHY THIS SCHEMA IS DELIBERATELY OPEN — no `enum`, no `required`, no `additionalProperties:false`
-- (0043 outpost / 0051 placement precedent, READ BEFORE TIGHTENING): `deployment-target` is JOURNALED
-- (`object_upsert`) and Ajv validates on the RECEIVING side of federation with no try/catch, so ONE
-- rejected entry aborts a peer's WHOLE sync bundle. A closed enum on `substrate` would make every
-- future 8th value — or any peer on an older migration set — a fail-closed version-skew hazard for
-- no new protection. Well-known values are vocabulary (GLOSSARY), not schema.
--
-- `UPDATE`, not `INSERT ... ON CONFLICT DO NOTHING`: 0002:159 shipped the row as `{"type":"object"}`
-- and DO NOTHING cannot change a shipped row (0055:50-56 uses the same UPDATE-after-DO-NOTHING shape
-- for `relationship_types`). Ajv runs on WRITE only, so no existing row is re-read against this; a
-- row already holding a non-string under one of these keys fails only on its NEXT write, loudly.
-- ===========================================================================================

UPDATE object_types
   SET property_schema = '{"type":"object","properties":{"substrate":{"type":"string"},"account":{"type":"string"},"region":{"type":"string"},"cluster":{"type":"string"}}}'::jsonb
 WHERE id = 'deployment-target';

-- ===========================================================================================
-- §9.2 — `publishes_to`: component → execution-system, "the registry this component's built
-- artifact lands in". A GRAPH FACT, not a binding: an executor binding's Type is WHICH PIPELINE the
-- binding DRIVES (ADR-0007), so the `image` binding names what BUILDS the image, never where it is
-- pushed — and a registry-kind system cannot be bound at all (KNOWN_EXECUTOR_MODULES). The edge is
-- the missing fact.
--
-- `many_to_many` — the vocabulary every builtin uses (0002:174-192): many components publish to one
-- registry, and "one registry per domain" is a PROJECTION statement (`ambiguous` when >1 edge), not
-- a DB constraint. Per-domain-ness comes from creating the registry object `domainLocal:true` at each
-- site: an edge with a domain-local endpoint never journals (relationships-repo.ts, M20.3), so each
-- site's Delivery lane shows only its own.
--
-- `property_schema` is OPEN, one typed optional key: `repository` — the repository/path inside the
-- registry (`acme/checkout-api`). Earlier builtin inserts omit the column (it defaults NULL = skip
-- validation); this one carries it, so a non-string `repository` is refused at write time.
-- ===========================================================================================

INSERT INTO relationship_types (id, org_id, display_name, property_schema, from_types, to_types, cardinality, is_builtin) VALUES
  ('publishes_to', NULL, 'Publishes To',
    '{"type":"object","properties":{"repository":{"type":"string"}}}'::jsonb,
    ARRAY['component'], ARRAY['execution-system'], 'many_to_many', true)
ON CONFLICT (id) DO NOTHING;
