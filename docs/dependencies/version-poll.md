# version-poll

Reference for `apps/server/src/dependencies/version-poll.ts`. The source carries a one-line headline at each site and points here.

> Partial: 4 of 13 multi-line comment blocks in this file have been
> moved here. The rest are still inline pending a hand-written one-line headline.

## §1. MAY THIS PROCESS RUN THE POLL?

MAY THIS PROCESS RUN THE POLL?

Two independent axes, both required, and they are different questions:

- `config.federationRole` is the OPERATOR'S INSTALL-TIME declaration of what this deployment IS (`SCP_FEDERATION_ROLE`, Helm's `federationRole`). Only a `commander` polls. An `outpost` is frequently air-gapped or high-side and must never initiate outbound registry traffic on a timer — that is the exact hazard ADR-0032 §7 names when it calls the guard explicit. A `retrans` node sits ON a CDS boundary and runs less than an outpost, not more. - `config.role` is the PROCESS SPLIT (`SCP_ROLE`). Background work belongs to `all`/`worker`; an `api` process must stay a request server, exactly as the reconcile/observe/watchdog loops already require (`main.ts`'s `runsBackgroundWork`).

Deliberately NOT derived from `self_domain.role`: that value is per-org, set lazily through the federation API, and advisory (config.ts's own doc comment, and M15.4's helm-verify note). A background job that decided whether to reach the internet from tenant-writable data would be exactly the runtime/install-time fork M15.4 declined to create.

THE BRANCH ORDER IS PART OF THE CONTRACT, NOT A DETAIL OF THIS COPY (M21.7 follow-up, LOW 5). This body is hand-written rather than delegating to `commanderOnlyJobVerdict` because its refusal TEXT carries a fact a shared string cannot ("dials package registries from an air-gapped site") — but the VERDICT and the ORDER the axes are tested in are shared. It used to test federation first, so a deployment misconfigured on more than one axis was sent to a DIFFERENT setting depending on which job complained: the poll said "federationRole is 'outpost'", the dispatcher said "SCP_ROLE is 'api'", for one and the same deployment. Process axis FIRST, then the undeclared case, then the declared non-commander — the order `commanderOnlyJobVerdict` documents and `commander-only.test.ts` pins across every copy by comparing each multi-axis refusal against the single-axis refusal it must be identical to.

## §2. A background tick has no human actor

A background tick has no human actor. `SYSTEM_ACTOR_ID` is the same sentinel the reconcile loop threads into `matchPoliciesForTargets`. This comment used to draw a conclusion from that which is FALSE (ADR-0032 §6a-ii): "it is a member of no group, so a `group`-scoped ENABLE does not contribute for this caller — the SAFE direction". The sentinel's membership is still nothing, but group scope's OWNING half never reads the actor, so a group-scoped enable DOES contribute here wherever that group owns something on the component's chain. Neither direction is therefore inert for this caller; what makes both safe is upstream, not here — ADR-0032 §6a refuses authoring a group-scoped effect at all, in either direction.

## §3. The Decision for one polled line

The Decision for one polled line.

NOTHING TIME-VARYING MAY ENTER THIS OBJECT. `insertDecisionIfChanged` compares the candidate's `verdict` + `inputContext` + `reasonTree` against the latest row of the same kind for the same subject; a timestamp, an age, or an elapsed-ms field would make every daily comparison unequal and restore the unbounded write with no visible symptom — the 1.44 GB/day shape. "When did we last look" is already recorded, in the place that belongs to observation state rather than to a verdict: `dependency_lines.latest_observed_at`.

`detail` on an `unavailable` outcome IS included even though it is the one field that can vary between two failures. That is deliberate: two DIFFERENT failure texts are two different facts about the deployment (a redirect today, a refused connection tomorrow) and principle 6 wants both on the record. Two IDENTICAL failures — the steady state, and the only one that could amplify — still compare equal and are still suppressed.

THE WRITE DOOR'S `advanced`/`restated` LABEL IS DELIBERATELY NOT CARRIED HERE, for the same rule one paragraph up: it describes a TRANSITION, so the first tick that sees a head says `advanced` and every identical tick after it says `restated` — a field that differs between two otherwise byte-identical verdicts, which is precisely how persist-on-change is defeated without a symptom. A REFUSAL is carried, because it is a statement about the world (this index is behind this line's head) that stays true, and therefore compares equal, for as long as it holds.

## §4. AND IT SAYS SO WHEN IT ALLOWS, TOO

AND IT SAYS SO WHEN IT ALLOWS, TOO. A guard that logs only its refusals makes the ON state the invisible one — an operator reading a boot log could not tell "this deployment polls package registries daily" from "this line of code does not exist", which is the wrong way round for the posture that actually sends traffic. Both verdicts are now on the record (principle 6), and this one names the cadence so the log answers "how often" as well as "whether".
