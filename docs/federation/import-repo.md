# import-repo

Reference for `apps/server/src/federation/import-repo.ts`. The source carries a one-line headline at each site and points here.

> Partial: 9 of 30 multi-line comment blocks in this file have been
> moved here. The rest are still inline pending a hand-written one-line headline.

## §1. THE EVIDENCE RESOLVES ITSELF

THE EVIDENCE RESOLVES ITSELF. If this domain had previously recorded unattached `change_status` for this very object (the status entry arrived before its object — routine at any scope wide enough to ship both), that ignorance is now over: the change object IS here and the board's normal replica treatment takes over. Clearing it is what stops the signal from being a ratchet — see `unattached-change-status-repo.ts`. Keyed on the object id rather than on `typeId === "change"` so it is correct even if a future entry kind carries the same id; a delete that matches nothing is a no-op. The id comes from the row that ACTUALLY landed, not from `payload.id` (which is optional on the wire).

## §2. A TOMBSTONED FREEZE MUST STOP BLOCKING

A TOMBSTONED FREEZE MUST STOP BLOCKING (M25.7 round 2)
Soft-deleting the `objects` row is the whole job for every type whose object IS the record. A freeze's enforcement lives in `freezes`, and nothing that reads that table joins to `objects` — so without this the projection row OUTLIVED its own wire form: still returned by `activeFreezesInWindow`, still refusing every gate and per-target admission, and UNLIFTABLE, because `lockFreezeRow` refuses a local lift of a foreign-origin freeze and the declaring domain has just destroyed the object a re-snapshot would have travelled on. A commander deleting a freeze object would have frozen its outposts permanently.

A LIFT, NOT A DELETE — the row stays readable so a `freeze_admission` Decision citing it keeps resolving (M25.1's ruling for the local verb, charter principle 6).

## §3. Endpoints not yet replicated locally

Endpoints not yet replicated locally. Skipped rather than failing the whole bundle over one edge.

CORRECTED M20.3 (ADR-0031 §4). This used to say the case "should not happen for a from-genesis or contiguous-cursor import, since a relationship's origin domain always creates its endpoints first in its OWN chain". That premise was true when written and is NOT a safe thing to keep asserting: locality is now a property an endpoint can have, and an origin domain legitimately creates endpoints this side will never be shown.

As things actually stand the case still cannot arise from locality, because §4 makes an edge inherit locality from EITHER endpoint — so an edge whose endpoint is withheld is itself never journaled, and never reaches this importer. That is the reason it does not happen; the sentence above was not. A stale rationale inside a defensive catch is how the next instance hides (CLAUDE.md: a comment naming a hazard is a signal to sweep, not evidence it was handled), so if a future change ever lets a one-sided edge cross, THIS is the line that quietly absorbs it — and the skip below is then the only thing standing between a partial graph and a wedged bundle.

## §4. THE OPENING CLAUSE MUST MATCH THE CODE

THE OPENING CLAUSE MUST MATCH THE CODE — AND THE ANCHOR THIS SIDE ACTUALLY HAS. The two contiguity codes do not mean the same thing, and neither does "we compared against an anchor" when there was no anchor to compare against: - `sequence_gap` really is "the run I was shown has holes in it" — sequences are missing. - `prev_hash_mismatch` against a HELD anchor is "this run does not link to the anchor I am holding". The run can be perfectly contiguous, gap-free and authentic and still fail this, because the anchor is THIS side's state, not the peer's. Telling that operator their peer shipped a chain with gaps sends them hunting for something that is not there. - `prev_hash_mismatch` on the run's FIRST entry with NO anchor held is a third thing entirely, and the previous wording got it flatly wrong (W2): it blamed "this side's last known-good anchor" and "the previous scope regime" when the measured cursor was `{sequence: N, rowHash: null}` and the comparison was against JOURNAL_GENESIS_HASH. There was no anchor at all. Say that, because it is the fact that determines the recovery.

## §5. THE ANCHOR CLAUSE

THE ANCHOR CLAUSE — what this side is holding, measured, and what to do about it. This is where W2's dishonesty lived: the message asserted a stale anchor from "the previous scope regime" for a cursor that had no anchor at all, and prescribed a recovery (align the scopes and re-export) that was INERT for that state.

## §6. THE DIAGNOSTIC for a contiguity break

THE DIAGNOSTIC for a contiguity break. Three things the operator cannot see from one side: what shape the arriving run actually has, what THIS side is configured to expect, and what THIS side's cursor is actually holding. Deliberately NOT a verdict in either direction — the likely causes plus what to check, and an explicit note that a genuine break looks identical, because this check is exactly where that is caught.

THE CAUSES ARE THE ONES THE PRODUCT ACTUALLY PRODUCES. (1) A sender narrower than this side ships a sparse chain (`sequence_gap`). (2) Whatever this side's anchor really is — see `describeAnchorClause`, which reads it from the cursor rather than asserting it. The withheld-after-signing clause is kept, and stays gated on "the two sides already agree and no scope changed since the last accepted import", because that is exactly the condition under which none of the benign explanations apply.

## §7. §7.2.6 RESYNC ONLY

§7.2.6 RESYNC ONLY. When true, every applied entry carries `forceOverwrite` into its `FederationImportContext`, so a stale-revision entry OVERWRITES instead of no-op'ing — how a lost-tail restore re-converges. The single-writer authority check is still enforced. Set only by the mutually-authorized resync path, which resets the cursor to genesis first (so rail 4's high-water mark, cleared by that reset, does not refuse the resync bundle as a regression).

## §8. DIVERGENCE RAIL 4

DIVERGENCE RAIL 4 (§7.2) — the exporter's SIGNED tail attestation, verified and advanced against this side's monotonic high-water mark BEFORE any entry is applied, so a rolled-back/forked tail fails the whole import closed. Runs for BOTH full and sparse receivers and even for an entry-empty bundle — which is exactly what makes it catch a lost/rolled-back tail for a narrow-scope peer that rails 1–3 are structurally blind to. The attestation rides OUTSIDE the bundle checksum (a sibling field), so its signature is verified independently here against the same peer key; an un-upgraded exporter sends none and the rail no-ops (never blocks). `isReplay` (this bundle's tail is at or below what we already applied) keeps an idempotent re-import of an older bundle from being mistaken for a live regression.

## §9. THE SECOND DROP CHOKEPOINT

THE SECOND DROP CHOKEPOINT. This receiver's OWN scope discarded a change-status entry that the sender did ship — e.g. a `policies_only` receiver. The board's scope-derived caveat already covers this case, but recording it is strictly more precise (it names WHICH change and its state, so the caveat can be conditioned on the change still being in flight rather than firing forever). Recorded only for `change_status`: no other skipped entry kind carries a lifecycle state this domain could otherwise mistake for "nothing is happening".
