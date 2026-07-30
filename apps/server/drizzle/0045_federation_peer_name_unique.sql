-- M16.2 phase A, review round 4 (H6) — `federation_peers.name` IS A RESOLUTION KEY, SO MAKE IT UNIQUE.
--
-- THE DEFECT. `getPeerByIdOrName` (federation/peers-repo.ts) resolves a NON-UUID path parameter BY NAME
-- with `LIMIT 1` and no ORDER BY, and `federation_peers` had no `(org_id, name)` uniqueness. Two peers
-- could therefore hold the SAME name — both renames returned 200 — after which
-- `GET`/`PATCH /v1/federation/peers/{name}` resolved to whichever row Postgres happened to return. On
-- the PATCH that is a TRANSPORT WRITE (baseUrl / syncScope / deliveryTarget / pokeMode) LANDING ON A PEER
-- THE OPERATOR DID NOT SELECT. Re-pairing could already collide names, so E4's narrow PATCH did not
-- introduce this — but E4 exists precisely so a settings form can RENAME a peer, which makes it the
-- likely trigger, on the same route that then writes transport.
--
-- WHY A CONSTRAINT AND NOT "ONLY ACCEPT IDS ON THE PATCH". Narrowing one route leaves the ambiguity in
-- place for every other name-resolving caller (`getPeerByIdOrName` also backs the peer GET, hand-fill,
-- and both export routes). A database constraint fixes the class: after this, a name IDENTIFIES a peer,
-- and the resolution's `LIMIT 1` can no longer be a coin flip. (`peers-repo.ts` also gained a total
-- ORDER BY, so even a pre-migration duplicate resolves deterministically rather than arbitrarily.)
--
-- SELF-HEALING BACKFILL. A live database may ALREADY hold duplicates — this migration must not fail on
-- one. Every duplicate except the oldest is suffixed with a short slice of its own trust-domain id, which
-- is unique by construction and legible to an operator ('outpost-a' -> 'outpost-a-3f2c1a4b'). The OLDEST
-- row per (org_id, name) keeps the bare name so an operator's existing scripts keep resolving to the peer
-- they have always meant.
UPDATE federation_peers p
SET name = p.name || '-' || substring(p.id::text from 1 for 8)
WHERE EXISTS (
  SELECT 1 FROM federation_peers q
  WHERE q.org_id = p.org_id
    AND q.name = p.name
    AND (q.paired_at, q.id) < (p.paired_at, p.id)
);

CREATE UNIQUE INDEX IF NOT EXISTS federation_peers_org_name_key
  ON federation_peers (org_id, name);
