-- ===========================================================================================
-- M14.1 — per-peer poke-mode flag (ADR-0009 optional poke-mode federation; proposal
-- docs/proposals/outpost-poke.md §Config).
--
-- EXPAND phase (additive, backward-compatible). One `poke_mode` boolean column on
-- `federation_peers`, BESIDE `delivery_target` — the per-peer "may the commander send this peer a
-- contentless wake signal / is this peer's frequent poll disabled" switch ADR-0009 defines.
--
-- NOT NULL DEFAULT false — DEFAULT-OFF. Every existing peer migrates as a no-op poll-mode peer
-- (its frequent interval pull, unchanged: M14.0's `startFederationSyncLoop`). Only an explicit
-- re-pair with `pokeMode: true` — which the M14.1 pair-time guard requires an https/mTLS-capable
-- `base_url` for (the poke must authenticate the caller as the enrolled commander, ADR-0001) —
-- flips it. Full endpoint enforcement (the outpost's poke listener; disabling the frequent leg)
-- is M14.2+/M14.4.
--
-- Plain additive column on an RLS-governed table: the existing `org_isolation` policy is inherited
-- unchanged — no policy/grant statement needed (same class as 0031 / 0033).
-- ===========================================================================================

ALTER TABLE "federation_peers" ADD COLUMN IF NOT EXISTS "poke_mode" boolean NOT NULL DEFAULT false;
