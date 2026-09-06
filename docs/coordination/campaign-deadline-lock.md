# campaign-deadline-lock

Reference for `apps/server/src/coordination/campaign-deadline-lock.ts`. The source carries a one-line headline at each site and points here.

> Partial: 3 of 14 multi-line comment blocks in this file have been
> moved here. The rest are still inline pending a hand-written one-line headline.

## §1. `decisions.kind` for the lock

`decisions.kind` for the lock. `kind` is unconstrained `text` and the read schemas are `z.string()`, so this new value costs no migration (the proposal's data-model table records it alongside `freeze_admission` and `campaign_adoption`).

A DEDICATED KIND, for the reason `recordCampaignFreezeAdmissionHold` and `CAMPAIGN_ADOPTION_DECISION_KIND` both record: `insertDecisionIfChanged` dedupes against the LATEST row of a `(subject_id, kind)` pair, so two writers sharing a kind make their rows alternate under one another and suppression never fires once — ADR-0024's measured 1.44 GB/day rebuilt from parts. The campaign wave gate (`gate`), the freeze hold (`freeze_admission`), the adoption shortcut (`campaign_adoption`) and this all write about the SAME subject, so all four kinds must stay distinct.

## §2. NOT DUE => INERT

NOT DUE => INERT. `tx` IS UNTOUCHED ON THIS PATH.
`<=`, not `<`: the deadline instant itself is still inside the window an author was given. The boundary is exercised in `campaign-deadline-lock.test.ts` in both directions, because an off-by-one here locks a fleet a second early and nothing in the record would say so.

## §3. THE ONE RESOLUTION CORE

THE ONE RESOLUTION CORE. `evaluateCampaignAdoption` AND NOTHING ELSE (§3.4 consumer 4).
A second implementation of "has this component migrated?" is how two surfaces come to disagree about whether a component is compliant — and here the disagreement would be between a page saying "adopted" and a hash-chained audit event asserting the component missed a deadline. There is exactly one.

ONLY `adopted` IS AN EXIT. `not_adopted` and `unknown` are different facts and BOTH keep the target locked — R3 ("silence is never a pass") in its operational form. The asymmetry is the whole safety property of the pair: an `unknown` costs a component staying in a campaign it may already have left, while an `adopted` conjured out of an absent fact would waive a governance deadline nobody observed being met.

NOT MEMOISED, deliberately, and this is the M22.0a lesson rather than an oversight: each `(campaign, target)` is asked exactly once per tick by the reconciler's loop and once per request by the read surface, so a cache would buy nothing and would introduce the one thing that failure was made of — a key coarser than the question.

WORTH STATING PLAINLY: from the RECONCILER this call is very nearly always redundant, and the redundancy is the price of the seam being correct in isolation. When the recipe declares adoption, M25.5's seam sits directly above this one and has already terminalized every `adopted` target, so only non-adopted targets ever arrive here; when it declares none, this call returns `unknown` before issuing a single query. The branch is not dead — the read surface and the unit tests reach it, and the day the two seams are ever reordered it is the only thing standing between an adopted component and a signed record saying it missed a deadline — but nobody should expect to see it fire from the tick.
