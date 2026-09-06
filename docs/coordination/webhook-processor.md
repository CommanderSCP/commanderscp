# webhook-processor

Reference for `apps/server/src/coordination/webhook-processor.ts`. The source carries a one-line headline at each site and points here.

> Partial: 5 of 38 multi-line comment blocks in this file have been
> moved here. The rest are still inline pending a hand-written one-line headline.

## §1. Resolve the event NAME

Resolve the event NAME. HEADER-DRIVEN for adapters that name their event in an HTTP header (github/gitea/gitlab — behavior UNCHANGED: a non-string header still yields the generic shape). BODY-DERIVED for an adapter that declares no `eventHeaderName` (harbor, M15.3c — its event type is in `payload.type`, not a header); without this the header-only path would read `undefined` and silently drop every harbor event before ever calling `mapEvent`.

## §2. D23: same story, same one line

D23: same story, same one line. A test-bundle reference arrives only on the typed report body, and this branch reconstructs the hint FIELD BY FIELD rather than spreading `generic` — omitting this line would silently drop the bundle from any first-party report whose `sourceKind` also resolves an adapter (a `scp change-source report` for sourceKind `github`, the common case), and the loss would surface only as `no_captured_workflow` on every hook run of that change.

## §3. M21.5 THE PROVENANCE LOOP

M21.5 THE PROVENANCE LOOP (ADR-0032 §9) — BEFORE source-mapping correlation, because a bump SCP authored WOULD match the component's ordinary mapping and would then be proposed as a second, unrelated change for a release that already has one. Attaching here is what makes the returning event the originating change's own rather than a duplicate of it.

Deliberately NOT a filter on `sourceKind` or on the mapping: the push arrives through the component's own git provider, so it is indistinguishable from any other push except by the ref SCP chose and the change that claims it. See `correlation.ts`'s `matchAuthoredBumpChange` for why BOTH halves of that claim are required.

## §4. ADR-0046 §2 — THE CONFIG-SOURCE TRIGGER

ADR-0046 §2 — THE CONFIG-SOURCE TRIGGER. A push to a registered config repo enqueues a sync.

AN ADDITIONAL EFFECT OF THIS EVENT, NOT AN ALTERNATIVE TO CORRELATION: a repo can be both a team's config source AND a component's release source, so this runs BEFORE the `matchComponentForSource` branch and does not `continue`. Making it exclusive would mean a repo that gained a config-source registration silently stopped proposing changes.

IT ONLY ENQUEUES. Reading the manifest is an out-of-process RPC and applying it writes the graph; neither belongs in this transaction, whose other work is correlating unrelated events. A failure here would abort the tx — and a try/catch would not save it, because a caught Postgres error leaves the tx aborted and the next statement dies somewhere unrelated. So the only thing done here is the one cheap, safe write. See `config-source/sync-queue-repo.ts`.

## §5. WHO DECLARED IT

WHO DECLARED IT. The CHANGE stays the system actor's — nobody asked for it, a push happened — but the `depends_on` edges the declaration mints are a deliberate, authorized graph write by the REPORTING PRINCIPAL, and the route that authorized it (`routes/change-sources.ts`, `relationship:write` at both endpoints) is the only place that principal exists. Carried on the event row since 0054 so it survives to here. Without it the edge's audit event, journal entry and emitted event all name the system actor, leaving "who declared that A depends on B?" unanswerable — for a write that changes `graph.dependentIds`, a live CEL policy input for the depended-on component. NULL (an observe()-driven row, or one written before 0054) falls back to the change's own actor, which is the system actor and is the honest answer there.
