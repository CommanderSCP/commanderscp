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
-- fields: `additionalProperties: false` over exactly `{peerDomainId, trustTier}` makes a transport
-- field UNREPRESENTABLE in this object, and there is no trust-tier column on `federation_peers`.
--
-- `trustTier` is an owner-ENTERED assertion, never derived and never negotiated: until an operator
-- sets one there is NO value (the key is absent — never blank, never defaulted to 'commercial').
-- CONNECTIVITY (air-gap vs connected) is deliberately NOT a tier: it is DERIVED from transport
-- facts (`base_url`/`delivery_target`) and stays on the peer row's side of the split, because a
-- single field that means both trust posture and reachability means neither.
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
         "trustTier": { "type": "string", "enum": ["commercial", "fedramp-high", "il5"] }
       },
       "required": ["peerDomainId"],
       "additionalProperties": false
     }'::jsonb,
    true
  )
ON CONFLICT (id) DO NOTHING;
