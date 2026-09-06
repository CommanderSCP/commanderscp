# campaign-repo

Reference for `apps/server/src/coordination/campaign-repo.ts`. The source carries a one-line headline at each site and points here.

> Partial: 3 of 22 multi-line comment blocks in this file have been
> moved here. The rest are still inline pending a hand-written one-line headline.

## §1. THE CAMPAIGN ROW, LOCKED `FOR UPDATE`

THE CAMPAIGN ROW, LOCKED `FOR UPDATE` — shared by both deadline writers.

Extracted rather than copied because both are read-modify-writes over the SAME JSON document (`properties.deadline`) and a second copy of the lock is a second chance to omit it. Two concurrent writers without it would each compute their edit against a snapshot the other is about to replace: a move would record a `from` nobody ever set, and — worse for M25.6b — two overrides minted in the same instant would produce a document containing only one of them, with two audit events on the chain asserting both.

## §2. `null` CLEARS it — the exit

`null` CLEARS it — the exit. Carries NO `overrides`: the wire schema for this verb is `CampaignDeadlineInputSchema`, which omits the key, because this door is never the waiver door. A first set or a shortening runs at plain `object:write` while minting a waiver takes the Owner-only `campaign:deadline-override`; and even on the acts where D1(b-i) DOES demand that same permission here (a clear, or a move to a later instant), this door still never demands the per-target `object:write` a waiver does, nor names targets, nor writes the per-target audit event. Either way, accepting the key would make this route the waiver route's bypass.

## §3. THE COST GUARD

THE COST GUARD (§4.6) — RESOLVED BEFORE ANY QUERY IN THIS FUNCTION.
`getCampaignStatus` runs once per campaign inside `listCampaigns`'s already-N+1 loop, so a per-target read added here is multiplied by the page size. A campaign with no deadline — every campaign authored before M25.6a, and every one that simply does not want the feature — must pay exactly what it paid before, and it does: this is a pure key-absence check on an object already in hand, decided before `getLatestCampaignPlan` is even called.
