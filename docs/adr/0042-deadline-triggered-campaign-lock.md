# ADR-0042: The deadline-triggered campaign lock — a per-(campaign × target) admission gate, not a freeze

**Status:** Accepted (owner decision **D4**, 2026-08-23, recorded in [campaigns-rework.md](../proposals/campaigns-rework.md) §4). Shipped as **M25.6a**; the per-target override route and its `campaign:deadline-override` permission followed as **M25.6b** — see §9, which records what M25.6b added and the two things it decided that this ADR did not.

**Numbering note (2026-08-23):** `main` topped out at 0033; 0034 is reserved in prose by `docs/proposals/governance-label-namespace.md`; 0035 is M23's; 0036/0037/0038 are taken on the UI branch. 0039–0042 are reserved by campaigns-rework.md; this is 0042.

**Relates to:** [campaigns-rework.md §4](../proposals/campaigns-rework.md), [ADR-0041](0041-campaign-recipes.md) (adoption evidence — the resolution core this reads), [ADR-0039](0039-per-target-freeze-admission.md) (the per-target seam this reuses and the reason it is *not* the wave gate), [ADR-0028](0028-stage-scoped-component-coupling.md) (the predicate/actuator split, and the fail-**closed** rule this deliberately departs from), [ADR-0024](0024-decision-and-audit-retention.md) (the measured 1.44 GB/day, and the boundary-never-the-clock contract), [ADR-0008](0008-observe-enrichment-signals.md) (no pause verb — the ceiling on what any of this can promise), charter principles 1, 6 and 7.

## Context

Owner decision D4 asks for a deadline: past a date, a component that has not migrated stops receiving the campaign's changes.

The whole design turns on **what the radius is**, because the obvious implementation is wrong in a way that is hard to see afterwards.

> **D4's radius is the campaign's own targets.** An unmigrated component stops receiving ***that campaign's*** changes. **Unrelated releases — including security fixes — keep flowing.**

It is **not** a freeze on the component, and it must not be built as one. A freeze at that component's scope is a strictly larger thing that D4 explicitly excludes: it would stop the laggard shipping *anything*, which converts a migration deadline into an outage of that team's ability to patch. The distinction is invisible in a status column and obvious in a test, which is why §8's radius case exists.

## Decision

### 1. It is a read-time predicate. Nothing is ever written to mean "locked"

`coordination/campaign-deadline-lock.ts` is a **predicate only**, the same split ADR-0028 states for itself. `reconcileOneCampaign`'s per-target `pending` branch is the seam that refuses, and **the refusal is that it does not call `proposeChange`.**

Nothing is written to the target row. The lock is re-derived from `(deadline.at, adoption)` on **every** subsequent tick, which is precisely what makes a late adoption, a moved deadline, or a cleared deadline release it **with no unlock verb**. That is the M22.6 ruling applied again: a materialized copy of a time-window predicate needs a job to un-flip it, and the job is the part that breaks.

There is no scheduler. There is only the 1 s reconcile tick.

### 2. Not the wave gate, and not `checkFreeze`

Both were available and both are wrong:

* **`checkFreeze`** is scope-based and campaign-blind. Routing a per-campaign deadline through it would relock the exact crux ADR-0039 just fixed, and would give the lock a freeze's radius — the thing D4 excludes.
* **`evaluateWaveGate`** issues one verdict for a whole wave with no target dimension, and fires once on `pending → running`. A deadline that passes *mid-wave* would never be seen.

### 3. Storage is configuration, not status

`campaign.properties.deadline` — no new table, **no migration**. It survives `campaign-reconcile.ts`'s own properties rewrite because that spreads `...properties`.

This does **not** violate "campaign status is derived, never stored": the deadline is an **input**, not an output. Nothing anywhere writes "locked".

Strict in Zod at the authoring door; the property-schema fragment stays **typed but open** (`at` gets `format: date-time`; `adoptionSignal` is a plain string in the registry) — a tightened property schema is a federation wedge that aborts an older receiver's entire signed bundle.

### 4. `adoptionSignal` is spelled in `AdoptionEvidenceSchema`'s vocabulary — the proposal's is stale

§4.1 sketches `adoptionSignal: "campaign_target_succeeded"`. That literal does not exist anywhere in the shipped evidence model, whose discriminator is `delivered | dependency | control` (ADR-0041). The shipped field uses the real discriminator, and a test pins the two vocabularies against each other so they cannot drift.

**And the field is declarative, not a selector.** A bare string carries no `ecosystem`, `minVersion` or `controlObjectId`, so it *cannot* resolve evidence on its own — the recipe's `adoption` block is what does that. `adoptionSignal` records which kind the deadline was authored against; it does not choose one.

### 5. One resolution core

`evaluateCampaignAdoption` (ADR-0041) and nothing else. `adopted` is the **only** exit from the lock. `not_adopted` locks, and — decisively — **`unknown` locks too.**

That asymmetry is deliberate and is the mirror of ADR-0041's rule. *Silence is never a pass* means absent evidence cannot be read as adopted; it follows that a target whose migration cannot be observed is a target the deadline still applies to. Reading `unknown` as "not locked" would make the deadline evaporate for exactly the components least visible to the platform — the ones a deadline exists for.

### 6. It fails **OPEN** on a malformed bag, loudly — departing from ADR-0028 on purpose

`stage-dependency-hold.ts` fails **closed** on an undeclarable dependency, and this predicate does the opposite. The departure is argued rather than inherited:

ADR-0028 guards a **safety** coupling, where dropping the hold deploys something ahead of a dependency it needs. A deadline is a **coercion** mechanism. Failing closed on a typo would park an entire campaign — every target, indefinitely — because one JSON key was misspelled, and the failure would look exactly like the feature working.

So a malformed bag locks **nothing** and records one `verdict: "warn"` Decision naming what did not parse. Its detail is bounded by the same `describeRecipeIssues` M25.4 introduced, so an unparseable deadline cannot write an unbounded string into a permanent record.

### 7. The Decision, and the 1.44 GB/day contract

`kind: "campaign_deadline"`, `verdict: "block"`, `subjectId: campaignObjectId`.

`inputContext` is exactly `{ waveId, waveIndex, deadlineAt, locked }` — **`deadlineAt` is the only clock-shaped value, and it is a boundary, not a clock.** Banned and verified absent by census: `now`, `evaluatedAt`, `overdueMs`, `daysLate`, `lockedSince`, any remaining-TTL. `locked[]` is **sorted**, because `restatesDecision` canonicalizes object *keys* while array *order* is significant.

**`verdict: "block"` is safe here, and was re-verified rather than assumed.** `latestBlockDecisionForSubject` selects on `verdict = 'block'` alone and feeds the service board's sticky `attention.blocked` — but it is called only over a list of **change** ids, and this Decision's subject is a **campaign**, so a campaign-subject row is unreachable from it.

**The authoring act writes a different kind.** `campaign_deadline_set` (`verdict: "allow"`) is deliberately not `campaign_deadline`: `insertDecisionIfChanged` compares against the latest row of the same `(subject_id, kind)`, so sharing one kind would interleave human `allow` rows with tick-driven `block` rows and suppression would never fire — ADR-0024's flood rebuilt from parts, which is the same trap ADR-0039 §7 avoided for `freeze_admission`.

A high-severity `campaign.deadline.lock` audit event is appended **only when `insertDecisionIfChanged` reports `created`**. Appending on a no-op tick would make the hash chain assert an occurrence that did not occur.

### 8. Clock injection, resolved once per tick

`reconcileCampaignsOrgTick(..., opts: { now?: Date } = {})`, on `watchdog.ts`'s precedent — and resolved **once per tick for the whole batch**, so two campaigns straddling the same instant cannot disagree within a tick. Production passes nothing.

### 9. What M25.6a deliberately deferred, and what M25.6b then decided (2026-08-24)

**The per-target override route and the `campaign:deadline-override` permission were M25.6b.** Every role grant in this repo lands via an `array_append` migration, and migration numbering was serialized across three concurrent sessions under a hard contiguity gate (`db/journal-ordering.test.ts` asserts `idx` contiguous from 0, so an out-of-order number reds the *unit* suite, not merely a merge). M25.6a therefore added **no migration at all**.

**M25.6b has since shipped it** — `POST /api/v1/campaigns/{id}/deadline-override`, `drizzle/0088_campaign_deadline_override_permission.sql` (Owner alone, the 0010 §4 `array_append` idiom), `deadline.overrides[]` read first in the predicate, and a sixth Decision kind `campaign_deadline_override`. Two decisions inside it are **not** derivable from anything above and are recorded here rather than only in code:

1. **The authoring doors take a NARROWER schema than the stored document.** `CampaignDeadlineSchema` carries `overrides`; `CampaignDeadlineInputSchema` — what `POST /campaigns` and `POST /campaigns/{id}/deadline` accept — omits it and stays `.strict()`. Both of those run at plain `object:write`, so one shared schema would have made the cheap door the Owner-only permission's bypass. The split *is* the authority check; it is not tidiness. Naming the key at either door is a 400, never a silently dropped value, because a dropped key leaves an operator believing they excused a target that is still locked.

2. **A `set`/`move` PRESERVES waivers already in force; a `clear` takes them with the deadline.** The move verb's body cannot express `overrides`, so an author moving the date has said nothing about the waivers, and dropping them would be an unexpressed **tightening** — re-locking targets an Owner deliberately excused, performed by someone holding only `object:write` and therefore no authority to un-excuse them. A clear is different in kind: it removes the deadline, so there is nothing left to be excused from.

Two further properties worth naming, both consequences of the shape rather than new choices: **at most one waiver per target, stored sorted** (this document rides `object_upsert` to every replica and is content-hashed on every write, so append-only would grow unbounded and re-hash on every restatement), and **`until` expires at read time** — no job, an instant in the past is simply not effective, the M22.6 ruling applied a third time in this milestone.

**This is not an entrance with no exit** — the failure mode M25.1 existed to close for freezes. `POST /api/v1/campaigns/{id}/deadline` **sets, moves and clears** at plain `object:write` with a mandatory reason, and clearing releases every locked target on the next tick. `scp campaign deadline --clear` is the operator-reachable form. The per-target waiver is a finer-grained convenience, not the only way out — and the two remain deliberately different prices for different radii: the blunt exit costs `object:write` at the campaign, the narrow one costs the Owner-only permission at the campaign **plus** `object:write` at every named target.

`campaign.deadline.set` records the **previous** value, or "the deadline slipped four times" is unreconstructible.

## Consequences

**Under the `delivered` signal the lock is very nearly a no-op, and this must be documented rather than sold.** A target is a lock candidate only while `pending`, which means its member Change was never proposed, which means it can only be un-adopted. "Locked" degenerates to *"the campaign hasn't reached you yet, and now it never will"* — self-defeating, since the campaign **is** the migration.

It acquires force in exactly two situations, and the second is the one worth building for:

1. **Adoption observed outside the campaign's own fan-out** — ADR-0041's `dependency` or `control` evidence — so a long-lived campaign genuinely cuts a laggard out of a stream that was still flowing.
2. **The record is the product.** A Decision plus a hash-chained audit event making *"component X missed campaign Y's deadline on date Z"* a durable, signed, queryable fact.

Call it a **tripwire**, not a lock.

**A build-time discovery about the ordering.** M25.5's adoption seam sits *above* this one and terminalizes every `adopted` target with no member change. So from the reconciler, this predicate's `adopted ⇒ not locked` branch is **unreachable when the recipe declares adoption** — it is reached by the read surface and by tests. That is not dead code (the predicate has other callers and the branch is the honest answer), but it means the proposal's §4.3 test sketch is not satisfiable as written: "B adopted and B has a member change" only describes a B the campaign already delivered to. The shipped case is a two-wave campaign whose deadline passes part-way through, which is also the more honest scenario.

**Wave semantics, inherited and unchanged.** A locked target keeps `allTerminal = false`, so **siblings ship and reach `accepted`**, but the wave never terminalizes and **later waves never start**. Both alternatives are worse: terminalizing locked targets `failed` makes the lock irreversible (a terminal wave is never re-served), and `skipped` produces a campaign that "completed" while a target it was created for never migrated — a lie in the one record the feature exists to produce.

**`computeCampaignStatus` reports the existing `blocked`**, threaded exactly as M25.2's `frozenTargetCount` already is. `CampaignStatusSchema` is **not** widened — a response-enum addition is an oasdiff break with no upside. The predicate short-circuits on `deadline === null` before any query, because `getCampaignStatus` runs per campaign inside `listCampaigns`'s already-N+1 loop.

**A real hole, named.** Deleting the campaign removes the surface entirely. The Decisions and hash-chained audit events survive (keyed on the campaign's object id), so the record is reconstructible, but nothing surfaces it. Out of scope here; it belongs with adoption reporting.

**Federation costs nothing.** A campaign object federates via `object_upsert` with `properties.deadline` riding along and no new journal kind. The replica never acts on it — `listActiveCampaignObjectIds` filters foreign-origin campaigns out in SQL — so **the lock is evaluated only at the campaign's origin domain, which is where fan-out happens.** No sync-down design and no clock-skew-across-domains question.

**No timezones, ever.** UTC instants only. *"End of business Dec 31 in each region"* means N different instants for N regions, which is the multi-axis model D2 rejects; the answer is N campaigns.

## The standing mutation gate

Deleting the `continue` that is the refusal, and — separately — replacing `opts.now ?? new Date()` with `new Date()`, each fail the actuator case identically:

> `AssertionError: the locked target must have NO member Change minted for it: expected 2 to be 1`

Both must be re-run if either seam is touched. The radius case (`W-radius`) is the other one that matters: a locked component must still accept an unrelated change — the fixture names it `CVE-2026-0001 hotfix` — with **no** `campaign_deadline` Decision attached to it. If that case ever goes green while the lock has become scope-based, the feature has quietly turned into the freeze D4 excluded.

**M25.6b adds two more to the same standing set** (`campaign-deadline-override.integration.test.ts`):

* deleting the waiver branch — `if (findEffectiveDeadlineOverride(...)) continue;` — from `evaluateCampaignDeadlineLock` fails case `O` with
  > `AssertionError: the waived target must get its member Change minted: expected +0 to be 1`
* deleting the per-target `object:write` block from `routes/campaigns.ts` fails case `A2` with
  > `AssertionError: expected 200 to be 403`

The second is the one to re-run whenever that handler is touched: it is the only thing standing between "authority over a campaign" and "authority to mint a permanent governance record about any component in the org".
