# line-head

Reference for `apps/server/src/dependencies/line-head.ts`. The source carries a one-line headline at each site and points here.

> Partial: 3 of 11 multi-line comment blocks in this file have been
> moved here. The rest are still inline pending a hand-written one-line headline.

## §1. WHICH INGRESS A HEAD WRITE IS COMING FROM

WHICH INGRESS A HEAD WRITE IS COMING FROM — the argument the write door re-checks the world against, INSIDE the transaction that writes.

WHY A RUNTIME ARGUMENT WHEN `ThirdPartyLine` ALREADY EXISTS (measured, not theorised)
The brand above is a COMPILE-TIME fact, and it is minted in a DIFFERENT TRANSACTION from the one that writes. Both ingresses deliberately straddle a transaction boundary, because a registry that takes 15s must never hold a tenant transaction open:

```text
version-poll.ts            buildLineWorkList (tx1) -> queryLineHead (NO tx) -> write (tx2)
internal-release-detection producer read (tx1)     -> resolution (NO tx)    -> write (tx3)
```

A `ThirdPartyLine` therefore says "no declaration existed when tx1 ran", which is not the same claim as "no declaration exists now". The gap was measured end to end against real Postgres: a `POST /dependencies/producers` landing between tx1 and tx3 confirmed the head cleared to null, and the poll's own in-flight write then put a PUBLIC `2.99.0` back on the just-declared internal line and fanned a bump out from it. The line was then PERMANENTLY WRONG — the poll's work-list excludes it (it is internal now, so nothing re-visits it) and internal detection's legitimate `2.1.0` is refused as `behind_head`. That is dependency confusion arriving through the one door built to end it.

So the fact is re-read at the write door under the same `FOR UPDATE` that guards the head, and this argument is what the door compares it against. It lives HERE, beside the three head rules, for the reason this module's opening states: a rule applied by each caller has one place per caller to regress.

AND THE INTERNAL ARM NAMES *WHICH* PRODUCER — because "is a producer declared?" is the wrong QUESTION, not merely a coarse answer (measured 2026-08-17)
The first cut of this type was the two bare strings `"third_party" | "internal"`, and the declaration it was compared against was a `boolean`. That asked whether the coordinate HAS a producer and never whether it has THIS one — so the whole rule was blind to the one act that changes a producer without removing it. A TRANSFER is ordinary and supported: `POST /dependencies/producers` upserts, and `routes/dependency-producers.ts` records `displacedProducerObjectId` precisely because coordinates move between components.

Replayed at the same seam as the two races above — declare to P, transfer to Q, then P's own in-flight phase-3 write:

```text
  { "recorded": true, "movement": "advanced", "detail": "'2.9.9' is the first head observed …" }
  outbox: line_head_advanced -> bump PRs authored into every subscriber's repo, onto P's version
```

and Q's genuine `2.4.0` is then refused `behind_head` FOREVER: the third-party poll never visits a declared line, backward movement is refused, and no API resets `latest_version`. That is the same permanence rule 0 was written to end, one level finer.

WHY THE IDENTITY RIDES ON THE INGRESS AND NOT ON `ObserveDependencyLineHeadInput`. That input is the OBSERVATION — the `latest_*` trio and nothing else — and it is a Zod schema in `@scp/schemas`, i.e. a shared contract shape. The producer id is not something observed about the line; it is the CLAIM the writer is making about its own standing, which is exactly what this type already is. Putting it on the input would also have to make it optional (the poll has none), and an optional field is a field an internal caller can omit — restoring, one level down, the same "I did not look" hole that made `ingress` a required argument in the first place. As the required member of the `internal` arm, an internal write that cannot name its producer DOES NOT COMPILE.

## §2. MAY THIS INGRESS MOVE THIS LINE'S HEAD?

MAY THIS INGRESS MOVE THIS LINE'S HEAD? Pure, so the rule is testable without a database; called by `recordDependencyLineHead` with a declaration read in the SAME transaction as the write.

ALL THREE DIRECTIONS ARE REFUSALS, not one guard and two conveniences. A retraction landing mid-flight of an internal-detection pass is the first race with the arrow reversed, and its outcome is the worse-reading of the two (`resetLineHead`'s header: a stale internal head on a coordinate that is third-party again is a security-gate input, not merely a stalled poll). A TRANSFER landing in the same window is the third, and it is the one the boolean form of this function could not express at all — see `HeadWriteIngress`.

THE DECLARATION IS PASSED AS AN IDENTITY-OR-NULL, NEVER AS A BOOLEAN, and that shape is the fix rather than a consequence of it. While the parameter was `{ hasDeclaredProducer: boolean }` the caller had to answer a question the caller could not get wrong — and the rule could not ask the question that mattered. `null` still means "no declaration"; anything else is the component that holds the coordinate right now.

It is a REFUSAL AND NOT A THROW because both callers already have a refusal path that records the reason in their Decision (`version-poll.ts`'s `not_recorded` verdict, `internal-release-detection.ts`'s `SkippedInternalRelease`). A throw would abort a sweep over other lines for a fact about one, and would put nothing on the record.

## §3. Is `candidate` a member of the line `major` names?

Is `candidate` a member of the line `major` names?

The test is STRUCTURAL, not textual: both sides are parsed, and the candidate must agree with the line on every numeric component the line actually SPELLS (`ComparableVersion.precision` is the receipt for how many that is). So `3` matches 3.x.y, `1.2` matches 1.2.z, and Go's `v2` matches 2.x.y. Comparing the strings instead would fail on `v2` vs `2.1.0` and would accept `3` against `30.1.0` by prefix.
