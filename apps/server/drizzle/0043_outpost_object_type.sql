-- M16.2 phase A (E1) — the `outpost` BUILTIN GRAPH OBJECT TYPE.
--
-- WHY A GRAPH OBJECT AND NOT A COLUMN ON `federation_peers` (owner decision): the sync journal
-- cannot carry a peer. `JournalEntryKindSchema` admits exactly 9 kinds, none peer-shaped, and
-- `federation/peers-repo.ts` never calls `appendJournalEntry` — so nothing written onto a peer ROW
-- can ever reach an outpost. Commander-AUTHORED outpost config must therefore be a graph object:
-- it then rides the existing `object_upsert` entry kind and `federation/import-repo.ts` applies it
-- at the outpost like any other registered type, landing as a read-only replica (single-writer
-- authority, DESIGN §13).
--
-- THE AUTHORITY SPLIT (see `federation/outpost-binding.ts` for the normative statement and the
-- tests that check it). `federation_peers` (+ `federation_peer_keys`) stays the SOLE authority for
-- TRANSPORT IDENTITY AND REACHABILITY — keys, `base_url`, `sync_scope`, `delivery_target`,
-- `poke_mode`, scheduler timestamps: local, per-side, never journaled. This OBJECT is the SOLE
-- authority for COMMANDER-DECLARED CONFIG about that outpost — today `trustTier` — plus the
-- `peerDomainId` binding that anchors it to a paired peer row. Neither can express the other's
-- fields: the create/update REQUEST BODIES (`CreateOutpostConfigRequestSchema` /
-- `UpdateOutpostConfigRequestSchema`) carry no transport field of any kind and are the only
-- operator-reachable write path — so no transport field is writable into this object — and there is
-- no trust-tier column on `federation_peers`. NOTE (review round 5, N5): this clause used to claim
-- `additionalProperties: false` over exactly `{peerDomainId, trustTier}` did the work. It does not,
-- and it has not since H7: the registered schema below is DELIBERATELY OPEN and carries neither
-- `additionalProperties` nor a tier enum (see the section 25 lines down, and the INSERT itself). The
-- enforcement is at the API, where it costs nothing — naming a protection that no longer exists is
-- worse than naming none.
--
-- `trustTier` is an owner-ENTERED assertion, never derived and never negotiated: until an operator
-- sets one there is NO value (the key is absent — never blank, never defaulted to 'commercial').
-- Its MEMBERS come from `docs/GLOSSARY.md`, which is authoritative for vocabulary: the trust tier IS
-- the SECURITY DOMAIN (`commercial`, `govcloud`, `fedramp-high`, `il5`, `airgap` — ADR-0022).
-- The TRANSPORT CHANNEL (air-gap vs dialable) is deliberately NOT a tier: it is DERIVED from
-- transport facts (`base_url`/`delivery_target`) and stays on the peer row's side of the split,
-- because a single field that means both trust posture and reachability means neither.
--
-- ============================================================================================
-- WHY THIS REGISTERED SCHEMA IS DELIBERATELY OPEN (review round 4, H7) — READ BEFORE TIGHTENING IT
-- ============================================================================================
-- This type is JOURNALED: an `outpost` object rides `object_upsert` and is validated with Ajv against
-- THIS schema on the RECEIVING side (`federation/import-repo.ts`), whose `object_upsert` branch has no
-- try/catch — a validation failure aborts THE WHOLE SYNC BUNDLE, not just the entry. A CLOSED schema
-- therefore makes every future addition a FAIL-CLOSED VERSION-SKEW HAZARD: the moment phase B adds a
-- second declared-config property (or a newer commander asserts a tier this build has never heard of),
-- every outpost still on an older migration set rejects that entry and federation WEDGES for that peer
-- until it is upgraded. `outpost` would also have been the FIRST builtin with a closed property schema
-- (0002/0007/0019 all leave theirs open), i.e. a new failure mode for no new protection.
--
-- The strictness that matters is at the API, where it costs nothing: the create/update request bodies
-- (`CreateOutpostConfigRequestSchema` / `UpdateOutpostConfigRequestSchema`) are `z.strictObject`, so an
-- unknown property or an invented tier is REFUSED WITH 400 — not silently stripped (review round 5, N6:
-- a plain `z.object` DROPPED the key and answered 201, so a newer client writing a phase-B property to
-- an older commander lost its field with no signal). What the open schema buys is that a REPLICA from a
-- newer authority is stored rather than rejected, and `outposts-repo.ts` reads an unrecognised tier as
-- NO tier — honestly declared unknown. Strict at the operator's door, open on the wire.
-- Clause (3) of the authority-split rule (no transport field is representable in the object) is
-- therefore enforced by the REQUEST BODIES, which carry no transport field at all, not by this schema.
--
-- Graph-native (charter principle 2): registry DATA, no new table, no new column.
INSERT INTO object_types (id, org_id, display_name, property_schema, is_builtin) VALUES
  (
    'outpost',
    NULL,
    'Outpost',
    '{
       "type": "object",
       "properties": {
         "peerDomainId": { "type": "string", "minLength": 1 },
         "trustTier": { "type": "string", "minLength": 1 }
       },
       "required": ["peerDomainId"]
     }'::jsonb,
    true
  )
ON CONFLICT (id) DO NOTHING;
