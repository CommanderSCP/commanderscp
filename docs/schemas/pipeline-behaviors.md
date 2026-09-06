# pipeline-behaviors

Reference for `packages/schemas/src/pipeline-behaviors.ts`. The source carries a one-line headline at each site and points here.

> Partial: 6 of 25 multi-line comment blocks in this file have been
> moved here. The rest are still inline pending a hand-written one-line headline.

## §1. Every hook carries these

Every hook carries these. `hookId` is D16(6)'s stated CDK deviation made concrete: a construct that is a natural singleton per scope defaults its id to the construct kind, and an author only types one when declaring same-kind siblings (two continuous probes on one component). The manifest is explicit either way — D8's rule is inference at synth, explicitness at apply, so the construct DEFAULTS it and the wire always CARRIES it.

IDENTITY is `(componentUrn, kind, hookId)`. Like `ManifestSourceMappingSchema`, there is no update path keyed on a subset: a changed hook is a delete + create, and declaring the same tuple twice in one manifest is rejected.

## §2. POST-MERGE — gates entry to WAVE 1

POST-MERGE — gates entry to WAVE 1.

WHAT THIS DOES NOT GATE, AND WHY (owner ruling 2026-08-26)
An earlier framing had this gating "entry to the registry step". A coordinator cannot do that, and the reason is structural rather than a matter of effort. D22 pins the build step's order as build -> unit -> scan -> origin signature -> push to the registry, ALL INSIDE the team's own build workflow. SCP first learns the artifact exists when the build REPORTS a digest — by which time it is already pushed. There is no moment at which SCP stands between the build and the registry without being in the build's critical path, and standing there would be executing, not coordinating (charter principle 1).

So this hook gates the first thing SCP genuinely controls: the change entering its first wave. The build-internal unit gate is not lost — it is DISPLAYED. D21(d) already requires `scp iac render` to show every gate that will apply "including estate-imposed ones the team never declared", and the build's own unit gate is exactly such a gate. The picture stays the truth; it is the enforcement point that is named honestly.

## §3. WHAT A PIECE OF EVIDENCE IS ABOUT

WHAT A PIECE OF EVIDENCE IS ABOUT — and why it must be bound to bytes or to a commit.

Unbound evidence is not evidence. "The integration suite passed" is a claim about a specific artifact at a specific place; without the binding it is a claim about the word "passed", and it will be read as covering whatever is deployed next. This repo has paid for that lesson once in the scan layer, where `evaluateScanCoverage` refuses evidence whose `digestMatch !== true` with an explicit `not_digest_bound` code rather than letting a shape-valid verdict cover a digest it never examined.

EXACTLY ONE binding kind is required, and which one is determined by the hook: `postMerge` runs before any artifact exists, so it binds to the built COMMIT; `postDeploy`, `continuous` and `bakeAlarms` all describe something already deployed, so they bind to the artifact DIGEST. Both are permitted on the wire and the consumer requires the one its hook needs — a mismatch is a refusal, never a widening.

## §4. A concluded test run

A concluded test run. NOTE THE OUTCOME VOCABULARY: there is no `running`/`pending` member, on purpose. Evidence is a record of something that FINISHED; an in-flight run is expressed by the ABSENCE of evidence (which the freshness rule below already handles correctly) plus the control's `expired` status, which is the mechanism the tree already uses and re-polls. A `running` member here would be a second, competing representation of the same fact.

## §5. ALARM STATE OVER A NAMED WINDOW

ALARM STATE OVER A NAMED WINDOW — a POSITIVE assertion of quiet, never an inference from silence.

THIS IS THE WHOLE DESIGN OF THE BAKE HOOK, SO IT IS WORTH BEING BLUNT
"No alarm report arrived" and "the window was observed and nothing fired" are not the same fact, and a bake gate that treats them as one passes every time the alarm pipeline is broken — which is precisely when it should not. So a report must NAME the window it covers (`windowStart` .. `windowEnd`) and list what fired in it; an EMPTY `alarms` array is then a real claim, and no report at all leaves the gate closed.

Same shape of reasoning as `continuous`'s stale-reads-as-absent rule, and the same failure mode on the other side of it: the state that means "I am not looking" must never be spelled the same way as the state that means "I looked and it was fine".

## §6. The push door's receipt

The push door's receipt.

IT ECHOES THE STAMPED PROVENANCE BACK, and that is the point of it rather than a courtesy: the request deliberately cannot say who produced the row (see above), so the only way a reporter can confirm what was actually recorded about it is to be TOLD. `producerSubjectId` is the authenticated subject the server stamped and `source` is the constant `pushed` — neither is echoed from anything the caller sent, because neither was sendable.

`evidenceId` is the row's own id, so an operator chasing a gate verdict can join a `HookFreshnessContext.latestEvidence.evidenceId` in a Decision back to the submission that produced it.
