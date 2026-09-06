# inventory-ingestion

Reference for `apps/server/src/dependencies/inventory-ingestion.ts`. The source carries a one-line headline at each site and points here.

> Partial: 5 of 26 multi-line comment blocks in this file have been
> moved here. The rest are still inline pending a hand-written one-line headline.

## §1. KNOWN PATHS FROM THIS REPOSITORY ONLY

KNOWN PATHS FROM THIS REPOSITORY ONLY. A row observed in another repo is not evidence about where this repo's manifests are, and probing it here is how a pass acquired `not_found` "evidence" it then pruned the other repository's inventory with. A row with NO recorded repository (written before drizzle/0063) is included so a re-observation stamps it and it heals; until then it is unprunable by construction.

## §2. WHEN THIS PASS LOOKED

WHEN THIS PASS LOOKED — captured before the first read, and the ONLY thing that orders two overlapping passes over the same component.

`observed_ref` cannot do it, and that is worth stating rather than leaving as an omission: it holds a COMMIT SHA, two shas carry no order between them, and deciding which is the descendant needs a git-history walk this system does not do (the plugin seam has exactly one file verb, `readFileAtRef`, and ADR-0032 §9 keeps it that way). What the ref DOES do is name what was read; what the read TIME does is say which of two readings is the later evidence. So the row carries both, this compares the second, and the honest residue is named on the guard in phase 3.

## §3. THE ORDERING GUARD

THE ORDERING GUARD — an OLDER pass must not land after a newer one.

Nothing orders two ingestion passes for the same component: both hops are at-least-once, the queue is a competing consumer, and a retry of an earlier accept can be delivered after a later one. Applied out of order, the older pass prunes each manifest down to what the OLDER commit declared and deletes the declarations the newer commit added — the same silent unsubscription this whole module exists to prevent, arriving by a race instead of a bug.

WHAT IS COMPARED, AND WHY IT IS NOT THE REF. `observed_ref` holds a commit sha; two shas have no order between them, and deciding which is the descendant needs a history walk that does not exist behind this seam (`readFileAtRef` is the only file verb, ADR-0032 §9). What IS orderable is WHEN each pass read the manifests, so that is what the row records (`observed_at` is stamped from phase 2, not from this write) and what this compares.

THE RESIDUE, STATED: this orders passes by when they LOOKED, not by commit ancestry. Two passes whose reads and whose commits are ordered oppositely — a job for a newer commit that read first — still land in the wrong order. Closing that needs ancestry, which this system deliberately cannot ask for; the next accepted change or a backfill re-derives the truth.

## §4. NOTHING IS WRITTEN

NOTHING IS WRITTEN — not the rows, not the prune, not a Decision AND NOT A STAMP.

The stamp is deliberately in that list. It describes WHAT THE INVENTORY IS, and this pass established nothing about that: its manifests are stale evidence that was not applied. A stamp here would publish per-path entries counting rows that are not in the table. (`mergeIngestionStamp` would refuse the slice anyway, because the winner read this same repository later — but relying on that would make the honest answer an accident of two guards agreeing rather than a decision made here.)

"Never attempted is the absence of a row" survives this: being superseded REQUIRES a newer pass to have written rows for the same component, and that pass stamped. A Decision here would alternate with the ordinary one for the same component and re-open the persist-on-change guard (`insertDecisionIfChanged` compares against the LATEST row, so alternating verdicts append forever); and there is nothing to explain that the winning pass's Decision does not already say.

## §5. PATH AND REASON, NEVER THE DETAIL

PATH AND REASON, NEVER THE DETAIL. A detail carries provider prose, an error message and (before this) the ref itself — all of which vary per commit, so a component whose ref never resolves wrote a fresh Decision per accepted change while its own doc claimed the inputs carry no commit. The REASON is the stable, explanatory half; the detail stays on the returned outcome, where the operator and the log read it.
