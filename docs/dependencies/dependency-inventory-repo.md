# dependency-inventory-repo

Reference for `apps/server/src/dependencies/dependency-inventory-repo.ts`. The source carries a one-line headline at each site and points here.

> Partial: 3 of 21 multi-line comment blocks in this file have been
> moved here. The rest are still inline pending a hand-written one-line headline.

## §1. WHICH INGRESS IS ASKING

WHICH INGRESS IS ASKING — REQUIRED, and there is deliberately no default (an omitted argument does not compile). A default would mean "whatever the last caller to be written meant", which is precisely the per-caller divergence `line-head.ts` was created to end; and defaulting to either value silently authorizes the other ingress's race.

It cannot be the `ThirdPartyLine` brand instead: that brand is minted in an EARLIER transaction, so it carries a compile-time fact about a world that may have changed by the time this transaction opens. `HeadWriteIngress` carries the caller's claim; the declaration read below carries the world; the disagreement between them is the refusal.

AND THE `internal` ARM MUST NAME ITS PRODUCER (a required field of that arm, so it cannot be omitted any more than the argument itself can). The claim being checked is "this component's production release owns this line", and a claim with no subject can only be checked against the coordinate's category — which is how a TRANSFERRED coordinate's former producer went on writing heads and fanning bumps out of them.

## §2. THE PAIR MOVES TOGETHER

THE PAIR MOVES TOGETHER. On an ADVANCE the digest is whatever THIS observation resolved — including `null`, which honestly says "this version's bytes were not resolved" and is the only way the previous version's digest cannot survive beside a new tag. On a RESTATEMENT the stored digest already belongs to this same version, so a null leaves it and a non-null (a repointed tag) replaces it.

## §3. AND THIS IS WHERE THE BUMP STARTS

AND THIS IS WHERE THE BUMP STARTS — EMITTED AT THE WRITE DOOR, NOT AT EACH INGRESS (M21.5)
"A new head on a subscribed line produces a bump" is the whole point of M21.5, and it has to be true of BOTH ingresses and of any third one. Emitting it here rather than in `internal-release-detection.ts` and `version-poll.ts` is the same argument that put the head RULES here (this function's own header; ADR-0032 §7b's closing line): a fact applied by each caller has one place per caller to regress, and this file exists precisely because the two callers demonstrably disagreed about what these columns meant. A future ingress — an air-gap feed import, an operator-supplied head — dispatches a bump by construction rather than by remembering to.

ONLY ON `advanced`, never on `restated`. A restatement is the same point on the line re-observed: the daily poll re-reads an unchanged head every day for every third-party line, and enqueuing a job for each of those is a per-day-per-dependency job for work already done. Nothing is lost — a component still declaring an older version is picked up by the next advance, and the dispatch job re-derives from the row rather than from the event.

The event rides the ORDINARY OUTBOX in this same transaction (DESIGN §8), so it is atomic with the head write: a head that moved cannot fail to notify, and an event cannot name a head whose transaction rolled back. Its consumer is a ROUTER on `domain-events` (`dependencies/bump-dispatch.ts`), never a second worker on that queue — see `events/pgboss.ts`'s `DomainEventRouter` for why that distinction is load-bearing.
