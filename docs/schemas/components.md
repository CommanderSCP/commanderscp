# components

Reference for `packages/schemas/src/components.ts`. The source carries a one-line headline at each site and points here.

> Partial: 15 of 32 multi-line comment blocks in this file have been
> moved here. The rest are still inline pending a hand-written one-line headline.

## §1. WHO MAINTAINS A PLACE

WHO MAINTAINS A PLACE — the federation domain that owns the deployment-target, and therefore the execution that happens there.

The commander gives the go-ahead; the OUTPOST still runs and maintains its own targets (owner, 2026-08-04). That is not a UI nicety, it is the ownership split the platform is built on: ADR-0017 devolves build execution to the originating outpost and leaves the commander owning only the cross-boundary gate, and ADR-0011 has the receiving outpost validate every deploy inside its own domain. A pipeline view that shows a stage without saying whose domain it is in invites the reading that the commander deploys it — which is the one thing charter principle 1 says it does not do.

Derived from the target's OWN `origin_domain_id` matched against `federation_self` and `federation_peers` — never from this instance's identity, for the same reason ADR-0026 D1 derives a stage NAME from the target's origin: a replicated target must read the same at the commander and at the outpost.

## §2. THE SHARED VERSION-PREFERENCE RULE

THE SHARED VERSION-PREFERENCE RULE (ADR-0008 signal 1) — extracted so the server's stage `version` derivation (`component-pipeline.ts`) and the web's per-target render (`PipelineWaveCard.tsx`) cannot silently diverge on which observed field wins. Mirrors `PipelineWaveCard.tsx`'s `realImages`/version-slot rules exactly: prefer the first REAL (non-marker) deployed image over the git-style `revision`, because an image tag/digest is a better human-facing version than an opaque SHA (decision 1). Returns `undefined` — never `""` or `null` — when neither is observed, so a caller's own "unknown" handling stays a single `if`.

`realImages` strips the persistence bound's marker slot using the record's own `droppedEntries` COUNT, never by pattern-matching the stored value (M23.1g, the same rule `PipelineWaveCard.tsx` documents at length) — a cut that removed every real entry leaves the array holding the marker alone, and this must return `[]` for that case, not the marker string.

## §3. WHERE A COMPONENT'S RELEASES COME FROM

WHERE A COMPONENT'S RELEASES COME FROM — one `source_mappings` rule: a push matching this repo (and path, if any) becomes a release of this component, of this Type.

This is the head of the journey, and the owner's question that prompted it was literal: *"agentkit-bootstrap comes from a repo right? When someone makes a change there, it should affect this right?"* The rule is durable state, so it answers that WITHOUT waiting for a push to prove it.

It carries the same `type`/`category` as a binding, so a mapping belongs to the same lane as the pipeline it feeds: an `infrastructure` mapping heads the infra pipeline, an `image` or `configuration` one heads the software pipeline.

## §4. WHAT MUST PASS BEFORE A RELEASE MOVES INTO A STAGE

WHAT MUST PASS BEFORE A RELEASE MOVES INTO A STAGE — the gate, as durable configuration.

Resolved from the `policy` objects matching this placement's containment chain (DESIGN §10.1, `policy-resolve.ts` + `policy-model.ts`'s stricter-wins merge) — the SAME resolution the wave-boundary gate runs, so this view cannot disagree with the engine about what is required.

It is a REQUIREMENT, not a verdict. A verdict exists only for a change in flight and carries a `decision_id`; this is what would be required of any release, which is exactly what a durable pipeline view can honestly state for a component with nothing releasing.

Measured on the live estate, and the reason this ships: 12 `prod-gate` policies each require ONE Owner approval before prod, and **282 approval requests are pending** against them. None of that appeared anywhere in this view — a release stopping at a gate looked identical to one nobody had started.

## §5. WHY A RELEASE IS SITTING AT THIS STAGE WITHOUT MOVING

WHY A RELEASE IS SITTING AT THIS STAGE WITHOUT MOVING — a stage-scoped component coupling (ADR-0028) is withholding its trigger, and this names what by.

THE BUG IT REMOVES. A held wave target's `change_wave_targets.status` is and stays `pending`: the hold `continue`s BEFORE `triggerWaveTarget`, so nothing advances it and nothing marks it. On this view that rendered as the same amber `pending` a stage gets when the wave simply has not reached it yet — so "waiting on something named" and "nothing is happening here" were the same picture, which is the confusion ADR-0028 increment 4 exists to remove.

PRESENT EXACTLY WHEN A TRIGGER IS BEING WITHHELD RIGHT NOW, and null otherwise — including for a change that declared a coupling which is now satisfied. It is RE-EVALUATED LIVE on every request by `resolveStageDependencyStatus`, never read off the persisted `stage_dependency` Decision: nothing anywhere writes a clearing row, so that Decision stays `hold` forever — through the trigger, through `accepted` — and a badge sourced from it would be the permanent-marker bug the `hold` verdict (rather than `block`) was chosen to avoid, rebuilt on a read surface. The kind is overloaded too: `applyPromotionImport` writes `stage_dependency`/`allow` for the import-time strip, so on an outpost the newest row of that kind is an `allow` whatever the change is doing.

WHOSE HOLD IT IS. Keyed on the wave target, which in stage mode IS the placement — so this is the hold on THIS stage, not the change's hold anywhere. A change held at gamma and free at prod carries this on its gamma stage alone.

NOT IN `unknownFields` WHEN NULL, deliberately, and the one case that argues otherwise was checked: on an OUTPOST an imported change has had its `stageDependencies` stripped (`applyPromotionImport`), so the resolver has nothing to evaluate and this is null. That is not an unknown — the commander already withheld the trigger until every dependency was satisfied there, and its promotion of the bundle IS the go-ahead, so locally there genuinely is no hold. Null here always means "no stage dependency is withholding this stage's release", never "we did not look".

## §6. THE SUBSTRATE FACET

THE SUBSTRATE FACET (pipeline-substrate-registry-scan.md §9.1) — what the target physically IS, read verbatim from the target's own `properties` (migration 0065 types them as optional strings; a non-string is read as absent). Well-known `substrate` values are GLOSSARY vocabulary (`aws|gcp|azure|kubernetes|vm|bare-metal|other`), rendered as-is, never enforced on the wire. Null = NOT DECLARED — an absence of a declaration, not an unknown observation, so a client renders nothing (no `—`, no badge). A client MUST NOT derive any of these from `name`: fixture names like `us-east-1-prod (k8s)` look parseable and are exactly the trap.

## §7. ONE of this stage's pipelines — see `bindings`

ONE of this stage's pipelines — see `bindings`. Retained because `/v1` is additive-only and it already ships required; it is `bindings[0]`, i.e. the lowest Type alphabetically, and a client rendering only this shows ONE of a stage's pipelines with no sign the others exist.

**Read `bindings`.**

## §8. THE MOST RECENT CHANGE PER PIPELINE

THE MOST RECENT CHANGE PER PIPELINE — at most one entry per Category, newest first.

A stage's pipelines release independently: the software pipeline may have run an hour ago and the infra pipeline last month. Collapsing them to one "last release" makes whichever ran most recently look like the state of ALL of them, so the quiet pipeline reads as up to date and the lane that has never run reads as if it had. Per-Category is the smallest split that cannot lie, and `change_wave_targets.type` (persisted per target at compile time) is what makes it a direct read rather than an inference.

## §9. WHAT IS WITHHOLDING THIS STAGE'S RELEASE RIGHT NOW

WHAT IS WITHHOLDING THIS STAGE'S RELEASE RIGHT NOW — see `ComponentPipelineHoldSchema`. Null when no stage dependency is holding it, which is the ordinary case.

`.nullable().optional()` and never `.default()`: `/v1` is additive-only (charter principle 3) and a default renders the property REQUIRED in the generated SDK type, which is an oasdiff ERR. It is a SIBLING of `currents[].targetStatus` rather than a new value inside it — that field is documented as `change_wave_targets.status` verbatim, and a held target's status IS and stays `pending`, so overloading it would make the raw column mean something it does not say. It is also NOT the service board's `blocked`: that flag is derived from a verdict-only Decision query with no recency gate, and conflating a transient self-clearing wait with a permanent marker is the exact bug ADR-0028 wrote `verdict: "hold"` to avoid.

## §10. A DECLARED STAGE THE COMPONENT NEVER REACHES

A DECLARED STAGE THE COMPONENT NEVER REACHES — a place the release topology puts in this component's journey, with no `placement` behind it.

This is the single most operationally important thing a pipeline view can say, and the first version of it said nothing at all: stages were derived from placements, so a wave the component is not placed at did not exist in the view. Measured on the live estate the day it was reported — topology `commercial-gamma-then-prod` declares gamma then prod, `agentkit-bootstrap` holds one gamma placement, and prod rendered nowhere (owner, 2026-08-10).

It carries no `binding`, `current` or `version`: all three are keyed on a placement that does not exist, and inventing nulls for them would invite a client to render "no executor" — the ADR-0006 case (a) ALARM — over what is really just an absence of a placement. The two must not look alike.

## §11. THE IMPORTED PROMOTION MANIFEST

THE IMPORTED PROMOTION MANIFEST (§10.4) — what an OUTPOST's Registry tile shows about the artifact that ARRIVED there. At promotion import the receiving instance stamps, on the imported change's `sourceRef`, the exporter's `promotionManifest` + detached cosign `manifestSignature` (plus `promotedFromDomain`, `artifactDigests[]`, `artifacts[]`, `boundaryBundleChecksums`). Import REJECTS on any signature / set-equality / digest-tie failure (`verifyPromotionManifest`), so a manifest stored here was verified at import BY CONSTRUCTION — the projection re-verifies nothing.

Non-null ONLY when BOTH the manifest (parsing as `PromotionManifestSchema`) AND the signature are stamped. A manifest without a signature is stated in `artifact.unknownFields` as `importedManifest:unsigned`; a manifest that does not parse as `importedManifest:unparseable`; neither key ⇒ null with no note (nothing arrived — the commander site reads this).

```text
- `exporterDomainId` — `manifest.exporterDomainId`, verbatim.
- `exporterName`     — the paired peer's `name` here when a `federation_peers` row carries that
                       domain id (the exporter IS a paired peer at the importer); null otherwise.
- `importedFromDomain` — `sourceRef.promotedFromDomain` when it is a string; null otherwise.
- `artifactCount`    — `manifest.artifacts.length`.
```

## §12. THE CORRELATED-INFRASTRUCTURE LANE

THE CORRELATED-INFRASTRUCTURE LANE (owner decision, 2026-08-24) — every infrastructure change this component's placements/hosted-on/couplings implicate, that is not this component's own. The server ALWAYS emits `{ changes: [...] }` (possibly empty) once it has evaluated the correlation — an empty array is a real, evaluated "none found", never confused with "not computed".

## §13. The declared stages it is NOT placed at

The declared stages it is NOT placed at.

WHY THE JOURNEY IS TWO ARRAYS rather than one list with a nullable `placement`: `/v1` is additive-only (charter principle 3), and widening `stages[].placement` to nullable is an oasdiff ERR three times over — `response-property-type-changed` plus `response-required-property-removed` on `placement/id` and `placement/urn` (measured, not assumed). The split is not a workaround dressed up: these ARE two different facts — where the component is placed, and what the topology declares that it does not reach — and neither array repeats anything in the other. `order` makes their union a single ordered pipeline. Do NOT "simplify" this into one array without an `api-v2-exception` (tools/openapi/OASDIFF-EXCEPTIONS.md).

## §14. THE OBSERVED CI RUN

THE OBSERVED CI RUN — component-journey-view.md §3 Segment 2's "upstream build" marker: "the distinction [coordinated vs upstream] is the whole point of §2, and it must be visible … it reads 'GitHub Actions · CI · run 30858160395 ↗', not 'build: unknown'". Composed from the MOST RECENT change of this component whose `sourceRef` carries a citable run id AND at least one of `url`/`repo` (`coordination/observed-run-facts.ts`) — every provider webhook/observe writer shape this instance traces (github/gitea flat-and-nested, gitlab pipeline/webhook) is read defensively; an unrecognized or malformed shape counts as absent, never guessed. Optional on the wire (additive-only `/v1`); a server that emits it sends an object or `null` (null = no change names a run). Absent = an older server.

## §15. THE CORRELATED-INFRASTRUCTURE LANE

THE CORRELATED-INFRASTRUCTURE LANE — see `ComponentPipelineCorrelatedInfraSchema`. Optional on the wire (additive-only `/v1`; this shipped after the response did). A server that has evaluated correlation always sends an object (`{ changes: [] }` is itself a value — "evaluated, none found"). Absent = an older server that never computed this at all; a client must keep the two distinguishable, the same rule `registry`/`artifact`/`observedRun` already follow.
