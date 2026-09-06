# component-pipeline

Reference for `apps/server/src/coordination/component-pipeline.ts`. The source carries a one-line headline at each site and points here.

> Partial: 4 of 23 multi-line comment blocks in this file have been
> moved here. The rest are still inline pending a hand-written one-line headline.

## §1. A COMPONENT'S PIPELINE

A COMPONENT'S PIPELINE — its stages, derived from durable graph state.

WHY THIS EXISTS, AND WHAT IT REPLACES
The pipeline surface used to be keyed on a CHANGE (`/changes/{id}/pipeline`), so a component with nothing in flight had no pipeline at all — the service board's link renders only when the row has a `latestChangeId`. That is a RUN view wearing a pipeline's name, and it inverted the model: a pipeline is a durable property of a component, and artifacts move THROUGH it.

Everything here is read from state that exists whether or not anything is releasing: - the STAGES are the resolved release topology's ordered waves (see below); - what EXECUTES at a stage is that stage's placement's executor binding; - the pipeline DEFINITION and the rung it was inherited from come from `pipeline-resolution.ts`. Only `current` reads change rows, and it is legitimately null for a stage nothing has released to.

WHY STAGES COME FROM THE TOPOLOGY AND NOT FROM THE PLACEMENTS (owner, 2026-08-10)
The first version of this module built the stage list from the component's PLACEMENTS. That is backwards for a pipeline. A pipeline's job is to show the JOURNEY — where a release goes next and where it stops — and placements can only ever show where the component already IS. A wave the component is not placed at did not render at all, so the single most operationally important fact, "this component never reaches prod", rendered as NOTHING.

Measured on the live estate the day it was reported: topology `commercial-gamma-then-prod` declares waves `gamma` then `prod`; `agentkit-bootstrap` holds ONE placement (gamma); the view showed one card and prod appeared nowhere.

So the journey is the topology's waves, in order. A wave place this component IS placed at becomes a `stages[]` entry, exactly as before; one it is NOT placed at becomes an `unplacedStages[]` entry, which a client renders greyed and explicitly "not placed" — deliberately distinguishable from "placed but nothing has released yet" (a `stages[]` entry with `current: null`), a different and much less alarming fact. `order` is contiguous across the union, so the two arrays recombine into one ordered pipeline. Why two arrays and not one nullable `placement`: see `ComponentPipelineResponseSchema.unplacedStages` — it is an oasdiff ERR, measured.

TWO CASES STILL COME FROM PLACEMENTS, and both are load-bearing:

```text
1. NO STAGE-SHAPED TOPOLOGY (`stageSource: "placements"`). No rung supplies a topology, or the
   one it supplies is LEGACY-shaped — its waves name the change's own targets rather than
   deployment-targets (`plan-service.ts` classifies the same two shapes the same way, from what
   the ids ARE, because both exist in real data). There is no declared journey to show, so the
   stages are the placements, exactly as before. This is why a component with placements and no
   topology still has a pipeline, which is the acceptance criterion this view was built for.
2. A PLACEMENT AT A TARGET NO WAVE NAMES. It is appended after the topology's stages, with a
   null `wave`. Dropping it would re-create this very bug mirror-imaged: real state — a place
   this component genuinely deploys to — hidden because a document does not mention it.
```

A MALFORMED topology (`parseTopologyWaves` throws) falls back to case 1 rather than failing the request: this is a read view, and a component page that fails outright because someone saved a bad document tells an operator less than one that shows the placements and says where its stages came from. The loud refusal stays where it changes behaviour — plan compilation, which is what `topology-waves.ts`'s header is about.

PER-STAGE VERSION (Phase 4a) — DERIVED, NEVER RE-OBSERVED
The design's "version staircase" comes from state `observe()` already writes — `change_wave_targets.observed_state` — read here a second time (`currentsByPlacement` selects `t.observed_state` alongside the rest of the row) and reduced with `preferredObservedVersion` (`@scp/schemas`): the first REAL deployed image, else the git-style revision. A stage whose newest current has never had `observed` written carries `version: null` and lists `"version"` in `unknownFields`, so a client renders "not observed" rather than a blank that reads as "no version" — same rule the service board and the graph health surfaces follow for every other unobserved field.

## §2. WHAT GATES ENTRY TO ONE STAGE

WHAT GATES ENTRY TO ONE STAGE — the same policy resolution the wave-boundary gate runs, so this view cannot disagree with the engine about what is required.

`actorObjectId` is the REQUESTING user, because `scope.group`'s ACTING half still matches on the acting subject (DESIGN §10.1): the honest reading of this field is therefore "what would gate a release YOU made", not "what gates everyone". Passing a system placeholder instead would drop every acting-half match and under-report the gate, which is the worse error of the two.

NARROWED 2026-08-15 (ADR-0016 §2a). `scope.group`'s OWNING half — the group, or a member of it, holding an `owns` edge into the target's containment chain — does NOT read this field, so the viewer-dependence of this view is now confined to the acting half. A group-scoped policy that reaches this placement through ownership renders identically for every viewer, and identically to the wave-boundary gate that passes `SYSTEM_ACTOR_ID`. Only a policy whose reach comes PURELY from the caller's own membership still shows differently to two people on the same page.

## §3. THE VERSION STAIRCASE

THE VERSION STAIRCASE (Phase 4a) — derived from the stage's newest current (`current`, `placementCurrents[0]`), never from a per-pipeline scan: `current` already IS "the most recent change to touch this stage in any pipeline", so the version rendered beside it must read the SAME wave target's `observed`, not a different pipeline's. `preferredObservedVersion` is the ONE preference rule (`@scp/schemas`, shared with `PipelineWaveCard.tsx`'s per-target render) — undefined only when nothing has ever been observed here, in which case the field stays `null` and `"version"` stays in `unknownFields`, exactly as before Phase 4a existed.

## §4. THE CORRELATED-INFRASTRUCTURE LANE

THE CORRELATED-INFRASTRUCTURE LANE (owner decision, 2026-08-24) — every infrastructure change NOT this component's own whose wave/bound target names a deployment-target this component's placements ALSO name, or that this component is `hosted_on`; plus a coupling arm for a `provides`/`requires` match. See `ComponentPipelineCorrelatedInfraChangeSchema` for the full rule and `ComponentPipelineCorrelatedInfraSchema` for the always-emitted-once-evaluated contract.

THE KEY SET, AND WHY IT IS THREE UNIONS
`change_wave_targets.target_object_id` is a PLACEMENT id under stage-shaped compilation (`plan-service.ts`'s `resolveStagePlacements` — every stage-mode wave target IS a placement, never the deployment-target it sits at), but a change that targets a deployment-target DIRECTLY (no component in its `targets` at all — a legitimate shape: an infrastructure change about the place itself, e.g. a cluster upgrade, has no component to be `placements`-resolved through) never enters stage mode and keeps the raw deployment-target id under legacy compilation. BOTH id shapes are real, so the key set is the union of this component's own placement ids (catches this component's OWN stage-mode releases — see the exclusion below) and its placements' own deployment-target ids (catches a direct infrastructure change against the place itself), plus every deployment-target this component is `hosted_on`.

WHY THE COMPONENT'S OWN CHANGES ARE EXCLUDED BY READING `properties.targets`, NOT BY IDENTITY
This component's own stage-mode infrastructure releases land in the key set for free (their wave target IS one of this component's own placement ids), which is exactly why they must be filtered OUT — the lane this section sits beside already renders them. The filter reads `properties.targets` (the same field `targetObjectIdsOf` names) rather than comparing wave-target identity, because that is the field that actually states "whose release this is" — a wave target id says WHERE a release lands, not WHOSE release it is.

WHAT IT COSTS
One relationship read (`hosted_on`), one bounded (`LIMIT 25`) scan of `change_wave_targets` keyed on the `change_wave_targets_org_target` index, and — only if this component's own recent changes declare a `requires` — one bounded scan for those plus one probe per distinct key, each served by the `obj_props` GIN index exactly as `coupling.ts`'s `requirementStatuses` is. Nothing for a component with no placements, no `hosted_on` edge and no `requires`: the key set is empty and the placement/hosted_on scan is skipped, and the coupling scan returns no keys to probe.
