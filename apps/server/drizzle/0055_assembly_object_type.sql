-- ===========================================================================================
-- `assembly` — the OPTIONAL level between a service and its components
-- (docs/proposals/intermediate-grouping.md, owner decisions 2026-08-10 D1-D5; owner chose the
-- distinct-type shape over a `kind` property on a nested service, 2026-08-04).
--
-- A service may be made of two or more assemblies, each made of dozens of components. Graph-native:
-- an `object_types` row and a widened `relationship_types` row, not a new table or column (charter
-- principle 2), following the 0019 (`execution-system`) / 0051 (`placement`) precedent.
--
-- OPTIONAL BY CONSTRUCTION. `contains` accepts BOTH `service -> component` and
-- `service -> assembly`, so a component may still sit directly under a service exactly as it does
-- today. Nothing about the existing 61 placements or the estate's current shape changes, and no
-- backfill is needed: this migration adds capability, it does not reclassify anything.
--
-- WHY NOT A `kind` PROPERTY ON A NESTED SERVICE (the alternative, rejected 2026-08-04). Measured
-- first: only ~4 places in non-test code branch on `typeId === 'service' | 'component'`, and
-- `containmentChain` is type-agnostic — so policy resolution, scan requirements, freeze scope and
-- RBAC scope inherit the new level for FREE either way. With the census that small, the distinct
-- type's clarity is close to free: the URN reads `...:assembly:payments`, the registry lists
-- Assemblies, and an owner attached to an assembly is visibly not the owner of a service. A `kind`
-- property would have left the URN, the registry and the graph all still saying "service".
--
-- WHAT THE REGISTRY CANNOT DO, so the app must (and this is why the check below is NOT here).
-- `relationship_types` holds FLAT `from_types` / `to_types` arrays, i.e. a cross-product. It can
-- express "{service, assembly} contains {assembly, component}" but it CANNOT express the pairwise
-- rule we actually want:
--
--     service  -> assembly    WANTED
--     service  -> component   WANTED (unchanged, the common case)
--     assembly -> component   WANTED
--     assembly -> assembly    NOT WANTED  <-- expressible here, refused in the app
--
-- So `assembly -> assembly` is refused by `relationships-repo.ts` at write time, alongside the
-- containment-cycle check, and the depth cap of 3 (intermediate-grouping D2) then means the deepest
-- legal chain is `service -> assembly -> component`. A reader who widens either array must go and
-- look at that refusal, which is why it is named here and not merely implied.
--
-- CARDINALITY IS UNCHANGED and still load-bearing. `one_to_many` restricts the *to* side to one live
-- incoming edge, and migration 0022's partial unique index on ("org_id", "to_id") enforces the same
-- thing at the database. Together they now mean: a component has at most one parent, which may be a
-- service OR an assembly; and an assembly has at most one parent service. That is exactly the
-- invariant `pipeline-resolution.ts` and `binding-resolution.ts` rely on when they walk UP one
-- parent at a time (ADR-0029), so the walks need no ambiguity rule.
-- ===========================================================================================

INSERT INTO object_types (id, org_id, display_name, property_schema, is_builtin) VALUES
  ('assembly', NULL, 'Assembly', '{"type":"object"}'::jsonb, true)
ON CONFLICT (id) DO NOTHING;

-- Widen `contains` to admit the new level on both sides. `ON CONFLICT DO NOTHING` cannot update an
-- existing row, so this is an explicit UPDATE against the shipped 0021 row.
UPDATE relationship_types
   SET from_types = ARRAY['service', 'assembly'],
       to_types   = ARRAY['assembly', 'component']
 WHERE id = 'contains';

-- ===========================================================================================
-- `releases_via` must accept the new rung too, or the level is only half real.
--
-- Migration 0052 widened it to `['component', 'service', 'organization']` — the three rungs
-- `pipeline-resolution.ts` walks. `intermediate-grouping.md` D1 makes the middle rung a LADDER
-- (assembly, then service), so an assembly must be able to CARRY the attachment it is now consulted
-- for. Without this the ladder would walk to an assembly and find nothing there by construction, and
-- the level would silently be decoration.
--
-- Found by a test, not by reading: the ladder resolved correctly and attaching a topology to an
-- assembly returned 400. That prompted the full census below rather than leaving "a third may
-- exist" as a warning — because a warning is how the next one gets missed.
-- ===========================================================================================

UPDATE relationship_types
   SET from_types = ARRAY['component', 'assembly', 'service', 'organization']
 WHERE id = 'releases_via';

-- ===========================================================================================
-- THE FULL CENSUS — every relationship type whose endpoints name 'service', and the ruling for each.
--
-- Done because the `releases_via` gap above was found by a test rather than by reading, which means
-- reading had already missed one. Enumerated from `grep "ARRAY\[.*'service'"` across every migration,
-- with NO filter, so the list is the population and not a sample.
--
--   contains            WIDENED above — the membership edge that makes the level exist.
--   releases_via        WIDENED above — the ladder consults an assembly, so it must be able to carry.
--
--   owns                WIDENED below. An assembly is exactly the thing a team owns; omitting it
--                       would mean the new level cannot have an owner, and ownership is one of the
--                       reasons for grouping dozens of components in the first place.
--   governed_by         WIDENED below. Policy scope must be attachable to an assembly, or the level
--                       cannot be a governance scope — see intermediate-grouping's rejection of
--                       labels, which was rejected precisely for not being a scope.
--
--   depends_on          LEFT ALONE, deliberately. These are COMPONENT-topology edges: they feed the
--   consumes            plan compiler's toposort and the two-layer graph, which reason about the
--   communicates_with   things that actually call each other. An assembly does not make a request;
--                       its components do. Admitting assemblies would put a node in the dependency
--                       graph that no runtime edge corresponds to.
--   hosted_on           LEFT ALONE. A place hosts a running thing. An assembly runs nowhere.
--   deploys_to          LEFT ALONE, same reason — and ADR-0026 made the component/target pair a
--                       `placement`, so this edge is legacy on the component path already.
-- ===========================================================================================

UPDATE relationship_types
   SET to_types = ARRAY['service', 'assembly', 'component', 'domain', 'deployment-target', 'contract']
 WHERE id = 'owns';

UPDATE relationship_types
   SET from_types = ARRAY['organization', 'domain', 'service', 'assembly', 'component', 'team']
 WHERE id = 'governed_by';
