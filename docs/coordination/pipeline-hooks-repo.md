# pipeline-hooks-repo

Reference for `apps/server/src/coordination/pipeline-hooks-repo.ts`. The source carries a one-line headline at each site and points here.

> Partial: 3 of 15 multi-line comment blocks in this file have been
> moved here. The rest are still inline pending a hand-written one-line headline.

## §1. WHO PRODUCED a piece of evidence

WHO PRODUCED a piece of evidence. Server-side only — it appears nowhere in `openapi.v1.json` (measured), so adding a member costs no oasdiff exception.

`peer_reported` is the OUTPOST-RUN PROBE source: evidence a peer produced in its own domain and journalled upward. It is STAMPED BY THE RECEIVER at import, never read from the entry's payload — provenance is the authorization boundary, not the payload shape, and a shape-valid payload is forgeable by anyone who can read the schema. A peer's journal is SIGNED, which proves who sent it; it does not make the contents true, so the receiver records what it knows (this came from that peer) rather than what the sender claimed about itself.

## §2. OUTPOST-RUN PROBES, THE UPWARD HALF

OUTPOST-RUN PROBES, THE UPWARD HALF. A probe runs in the domain, so its result is produced HERE and the commander's gate needs it. Journalled on the same seam the hook declaration came down on, which is what makes the air gap work by construction: the entry rides return media with everything else, and no outpost ever needs an outbound credential to the commander.

`federationImport` skips it for the same reason the hook doors do — a commander that re-journalled a peer's evidence would send it back, and with peers paired both ways, loop.

## §3. Records one alarm-state report

Records one alarm-state report. THIS ACCUMULATES — it deliberately does NOT supersede.

WHY, AND WHAT THAT COSTS
A bake gate is not asking "what is the latest alarm state"; it is asking "was the whole quiet window observed, alarm-free, by a single source". `evaluateBakeGate` answers that by MERGING the intervals a source asserted and checking they contiguously cover `[deployedAt, deployedAt + quietWindowSeconds]` — "A GAP IS NOT COVERAGE". Superseding older reports would delete precisely the earlier slices of the window that coverage is computed from, so a bake gate over a one-hour window fed by five-minute reports would see exactly one five-minute interval and refuse forever. The history IS the evidence here, in a way it structurally is not for test runs.

THE CONSEQUENCE, STATED RATHER THAN GLOSSED: this table grows without bound. Retention for it is an OPEN QUESTION and is deliberately left to the existing Decision/audit retention thread (ADR-0024's retention classes, the measured 1.44 GB/day unbounded-decision incident) rather than invented here. Inventing a local sweeper would be a second, uncoordinated retention policy in a tree that already has one — and, worse, one written by the module least able to say which windows are still needed.

`source` and `producerSubjectId` are stamped by the caller from the authenticated request, never from the body — same rule as `recordTestRunEvidence`, and it bites harder here: coverage is evaluated PER SOURCE, so a caller able to choose its own `source` could manufacture single-source coverage of a window nobody observed.
