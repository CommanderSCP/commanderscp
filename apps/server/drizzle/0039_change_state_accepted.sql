-- ===========================================================================================
-- ADR-0021 D5 — the change-lifecycle `promote`/`promoted` is renamed to `accept`/`accepted`.
--
-- AUTHORITY: docs/adr/0021-terminology.md D5 (owner-decided 2026-07-24), vocabulary fixed by
-- docs/GLOSSARY.md. The change-lifecycle approval gate is a HUMAN DECISION ABOUT A CHANGE, not
-- an artifact advancing — so it is an `accept`, and the word "promotion" is left to mean only
-- what the glossary's genus says it means (the same already-built artifact advancing).
--
-- SHAPE: IN-PLACE, SINGLE-PHASE. No expand/contract, no dual-accept window, no back-compat
-- alias. That is sound HERE and only here because of the deployment reality this migration was
-- written against (owner decision O1, 2026-07-24): CommanderSCP runs as a SINGLE INSTANCE (the
-- homelab k3s deployment) with NO second instance to skew against, NO independently-versioned
-- SDK consumer outside this monorepo, and the API + worker + UI + CLI all shipping from this
-- one commit. There is therefore no window in which an old writer and a new reader coexist —
-- the condition that makes expand/contract necessary simply does not obtain. If a second
-- instance or an external SDK consumer ever exists, this reasoning expires and a future
-- vocabulary change must be staged.
--
-- ===========================================================================================
-- WHAT IS DELIBERATELY *NOT* MIGRATED — and why. Read before adding a table here.
-- ===========================================================================================
--
--   * `audit_events` — HASH-CHAINED (charter principle 6). Each row's hash covers its own
--     contents and its predecessor's. Rewriting any historical `action`, `reason`, or hash
--     input would break the chain from that row forward, and `scp audit verify` — the command
--     whose whole purpose is to detect exactly this kind of after-the-fact edit — would fail.
--     Historical audit rows keep saying `change.transition` with a `promoted` reason, which is
--     the TRUE record of what the system did at the time. That is the correct outcome, not a
--     gap: an audit log that can be retroactively re-worded is not an audit log.
--
--   * `federation_journal` payloads — each entry carries a `contentHash` and a detached
--     signature computed over the payload bytes. Any edit invalidates both, so every peer that
--     re-verifies the journal (which is the entire point of signed federation exchange) would
--     reject the rewritten entries. Bundles already exported to peers cannot be recalled and
--     re-signed anyway, so rewriting the local copy would only guarantee a mismatch.
--
-- Both exclusions are structural, not conservatism: those two stores are append-only,
-- cryptographically sealed histories, and the whole value they provide is that a later commit
-- cannot change what they say.
--
-- ===========================================================================================
-- WHAT *IS* MIGRATED — live state and explainability data, all plain text/jsonb.
-- ===========================================================================================
--
-- `changes.state` is a plain `text` column (see apps/server/src/db/schema.ts) — there is NO
-- CHECK constraint and NO pgEnum on it; legality is enforced by `ChangeStateSchema` (Zod, on
-- the wire) and `coordination/transitions.ts` (`LEGAL_TRANSITIONS`, the sole runtime authority).
-- So this is a pure data UPDATE with no DDL and no type surgery.
--
-- Every statement below is IDEMPOTENT (its WHERE clause is false on a second run) and narrowly
-- targeted (it names the exact jsonb path or the exact edge, never a blanket text rewrite of a
-- jsonb document, so no operator-authored or tenant-authored value can be caught by accident).
--
-- 0007 SEEDED the `state_transitions` rows this migration rewrites. 0007 IS APPLIED ON LIVE
-- DEPLOYMENTS AND ITS HASH IS VERIFIED — it is NOT edited here. Same discipline as 0032, which
-- added the `waiting` edges by a new migration rather than by touching 0007.
-- ===========================================================================================

-- 1. Live change state. ---------------------------------------------------------------------
UPDATE "changes" SET "state" = 'accepted' WHERE "state" = 'promoted';
--> statement-breakpoint

-- 2. The `state_transitions` mirror of `LEGAL_TRANSITIONS`.
--    `transitions.integration.test.ts` asserts SET EQUALITY (both directions AND triggers)
--    between these rows and the constant, so these two UPDATEs are what keep that test passing.
--    Neither violates the `state_transitions_pk` UNIQUE (from_state, to_state) index: the new
--    keys ('validating','accepted') and ('accepted','rolled_back') do not exist in the table —
--    no seed has ever inserted an `accepted` row — and each statement updates exactly one row.
UPDATE "state_transitions"
   SET "to_state" = 'accepted', "trigger" = 'accept'
 WHERE "from_state" = 'validating' AND "to_state" = 'promoted';
--> statement-breakpoint

UPDATE "state_transitions"
   SET "from_state" = 'accepted'
 WHERE "from_state" = 'promoted' AND "to_state" = 'rolled_back';
--> statement-breakpoint

-- 3. Operator-authored gate bindings keyed on the lifecycle edge.
--    `coordination/gates.ts` looks bindings up by (scope_kind='lifecycle_edge', from_state,
--    to_state). A binding left saying 'promoted' would silently STOP MATCHING once the code
--    asks for 'accepted' — i.e. an operator's required control would quietly go un-enforced.
--    This is live configuration, not history, so it must move with the rename.
UPDATE "gate_bindings"
   SET "to_state" = 'accepted'
 WHERE "scope_kind" = 'lifecycle_edge' AND "from_state" = 'validating' AND "to_state" = 'promoted';
--> statement-breakpoint

UPDATE "gate_bindings"
   SET "from_state" = 'accepted'
 WHERE "scope_kind" = 'lifecycle_edge' AND "from_state" = 'promoted';
--> statement-breakpoint

-- 4. `control_runs.gate_ref` — the jsonb `{fromState,toState}` a lifecycle-edge control run is
--    filed under. The E6 export gate and `scp change explain` read runs back by this key, so a
--    stale 'promoted' here would orphan historical evidence from the edge it belongs to.
--    (`gate_ref` for a wave boundary is `{waveIndex,topologyObjectId}` and for the managed
--    promotion scan step is `{promotionScanStep,...}` — neither carries these keys, so both are
--    untouched by the path-scoped WHERE below.)
UPDATE "control_runs"
   SET "gate_ref" = jsonb_set("gate_ref", '{toState}', '"accepted"', false)
 WHERE "gate_kind" = 'lifecycle_edge' AND "gate_ref" ->> 'toState' = 'promoted';
--> statement-breakpoint

UPDATE "control_runs"
   SET "gate_ref" = jsonb_set("gate_ref", '{fromState}', '"accepted"', false)
 WHERE "gate_kind" = 'lifecycle_edge' AND "gate_ref" ->> 'fromState' = 'promoted';
--> statement-breakpoint

-- 5. `decisions.input_context` — the explainability record's inputs (charter principle 6).
--    `coordination/transition.ts` writes {fromState,toState,trigger,...,gate:{...}}; the nested
--    `gate` object is `coordination/gates.ts`'s own inputContext, which repeats fromState and
--    toState. Both levels are set, each by exact path.
UPDATE "decisions"
   SET "input_context" = jsonb_set("input_context", '{toState}', '"accepted"', false)
 WHERE "kind" = 'transition' AND "input_context" ->> 'toState' = 'promoted';
--> statement-breakpoint

UPDATE "decisions"
   SET "input_context" = jsonb_set("input_context", '{fromState}', '"accepted"', false)
 WHERE "kind" = 'transition' AND "input_context" ->> 'fromState' = 'promoted';
--> statement-breakpoint

UPDATE "decisions"
   SET "input_context" = jsonb_set("input_context", '{trigger}', '"accept"', false)
 WHERE "kind" = 'transition' AND "input_context" ->> 'trigger' = 'promote';
--> statement-breakpoint

UPDATE "decisions"
   SET "input_context" = jsonb_set("input_context", '{gate,toState}', '"accepted"', false)
 WHERE "input_context" -> 'gate' ->> 'toState' = 'promoted';
--> statement-breakpoint

UPDATE "decisions"
   SET "input_context" = jsonb_set("input_context", '{gate,fromState}', '"accepted"', false)
 WHERE "input_context" -> 'gate' ->> 'fromState' = 'promoted';
--> statement-breakpoint

-- 6. `decisions.reason_tree.summary` — the human-readable half of the same Decision record.
--    These summaries are ENGINE-GENERATED templates, never operator- or tenant-supplied text
--    (`transition.ts`: "transition '<from>' -> '<to>' allowed|blocked by gate" and "illegal
--    transition: ..."; `gates.ts`: "...exempt from governance at validating->promoted..."), so
--    replacing the two exact tokens below cannot corrupt authored prose. Scoped by a LIKE guard
--    so a summary that merely mentions a promotion BUNDLE (the keep-sense of the word) is never
--    matched — the tokens require the quoted state literal or the edge arrow.
UPDATE "decisions"
   SET "reason_tree" = jsonb_set(
         "reason_tree",
         '{summary}',
         to_jsonb(replace(replace("reason_tree" ->> 'summary', '''promoted''', '''accepted'''),
                          'validating->promoted', 'validating->accepted')),
         false)
 WHERE "reason_tree" ->> 'summary' IS NOT NULL
   AND ("reason_tree" ->> 'summary' LIKE '%''promoted''%'
        OR "reason_tree" ->> 'summary' LIKE '%validating->promoted%');
--> statement-breakpoint

UPDATE "decisions"
   SET "reason_tree" = jsonb_set(
         "reason_tree",
         '{gate,summary}',
         to_jsonb(replace(replace("reason_tree" -> 'gate' ->> 'summary', '''promoted''', '''accepted'''),
                          'validating->promoted', 'validating->accepted')),
         false)
 WHERE "reason_tree" -> 'gate' ->> 'summary' IS NOT NULL
   AND ("reason_tree" -> 'gate' ->> 'summary' LIKE '%''promoted''%'
        OR "reason_tree" -> 'gate' ->> 'summary' LIKE '%validating->promoted%');
