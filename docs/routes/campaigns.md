# campaigns

Reference for `apps/server/src/routes/campaigns.ts`. The source carries a one-line headline at each site and points here.

> Partial: 3 of 15 multi-line comment blocks in this file have been
> moved here. The rest are still inline pending a hand-written one-line headline.

## §1. THE GATE, AND THE ROW FILTER, IN ONE CALL

THE GATE, AND THE ROW FILTER, IN ONE CALL (role-model.md §8.2, increment 2.5b). The org-root `object:read` check this replaced runs first, unchanged, and still throws the same 403 when nothing else grants; a principal bound BELOW the org root now lists the campaigns their binding reaches. A campaign authored with `domainId` genuinely lives under that object (`POST /campaigns` resolves and authorizes it), which is what makes the downward walk find it — §8.4 measured that a CHANGE, by contrast, has no such parent.

## §2. RESOLVE, THEN SCOPE

RESOLVE, THEN SCOPE — see `GET /campaigns/{id}`'s block above. Unlike the two doors there, this one costs a genuine extra row read: `buildCampaignAdoptionReport` resolves the campaign itself (through `getCampaign`, which is also where "that uuid is not a campaign" 404s), and that resolution happens far too late to scope an authorization check on. A single indexed lookup is the price of not turning this route's 404 into a 403; `resolveCampaignForScope` is the cheap half of it — it filters tombstones, pins `type_id = 'campaign'` and resolves nothing else. The TYPE check is not decoration: with a bare any-type lookup the campaign bar was satisfiable at whatever object the caller named (see that function's docblock).

## §3. THE SECOND BAR ON THE WIDENING ACTS

THE SECOND BAR ON THE WIDENING ACTS — ADDED, NEVER SUBSTITUTED (owner ruling 2026-08-25)
`object:write` above still governs all three acts of this verb; a WIDENING one additionally demands the Owner-only `campaign:deadline-override` at the campaign. The reasoning — why clearing is a strict superset of the per-target waiver below, and why a move to a later instant is the same act by another name — is on `widensCampaignDeadline`. This is the established idiom (ADR-0043, drizzle/0088): a second, narrower bar beside the existing one, never a replacement for it, so nothing an `object:write` holder could do before becomes unavailable except the acts the ruling names.

THE PREVIOUS VALUE HAS TO BE READ BEFORE THE PERMISSION IS DECIDED — "later than what?" has no answer otherwise. Read HERE rather than taken from `setCampaignDeadline`'s return, because that would decide the authority for a write only after performing it. Same transaction, and the same scope the check above already admitted the caller at, so this discloses nothing to anybody `object:write` did not already let read the campaign.

THIS READ IS NOT LOCKED, AND THE CONSEQUENCE IS BOUNDED RATHER THAN ABSENT — stated, because `setCampaignDeadline` locks the SAME row `FOR UPDATE` a moment later and a reader is entitled to ask why this one does not. Under READ COMMITTED a concurrent writer can SHORTEN the deadline between this read and that lock, and this request's shortening then lands as a move LATER than the value it actually replaced. What that can produce is bounded by the value THIS caller already observed: the gate refuses anything later than `storedDeadline`, so the worst a race yields is a deadline no later than one that stood moments earlier — a lost update, undoing someone else's shortening, never a deadline nobody had authority to set. And it is not silent: `setCampaignDeadline` computes `before` under the lock, so the Decision records the true `from`, `loosening: true`, the actor and their mandatory reason. Taking the lock here instead would need a locked read exported from `coordination/campaign-repo.ts`; that is a repo-layer change, and the exposure above did not earn one.
