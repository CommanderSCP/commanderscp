-- ===========================================================================================
-- M12 P4B close-out: seed the THREE `waiting` edges into `state_transitions` (drift fix).
--
-- `coordination/transitions.ts`'s `LEGAL_TRANSITIONS` — the SOLE runtime authority on legal
-- edges — gained `coordinated->waiting`, `waiting->executing`, and `waiting->cancelled` when the
-- coupled-pipelines `waiting` state landed (docs/proposals/coupled-pipelines.md §3.4/§3.8), but
-- the mirror table 0007 seeds was never updated: 13 rows vs 16 edges. Nothing READS this table
-- at runtime (it is reference data mirroring the constant, DESIGN §9.1) — but 0007's own header
-- claims a `transitions.integration.test.ts` cross-checks the two, a test that had NEVER existed
-- until this migration's companion commit created it. That test now asserts SET EQUALITY (both
-- directions, triggers included) between these rows and `LEGAL_TRANSITIONS`, so the two can
-- never silently drift again; this migration is what makes it pass.
--
-- ADDITIVE ONLY: 0007 is applied on live deployments and its hash is verified — this new
-- migration inserts the missing rows rather than touching 0007. Triggers mirror the constant
-- verbatim ('await-prerequisites' / 'prerequisites-satisfied' / 'cancel').
-- ===========================================================================================

INSERT INTO state_transitions (from_state, to_state, trigger) VALUES
  ('coordinated', 'waiting',   'await-prerequisites'),
  ('waiting',     'executing', 'prerequisites-satisfied'),
  ('waiting',     'cancelled', 'cancel')
ON CONFLICT DO NOTHING;
