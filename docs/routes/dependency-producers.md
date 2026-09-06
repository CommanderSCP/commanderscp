# dependency-producers

Reference for `apps/server/src/routes/dependency-producers.ts`. The source carries a one-line headline at each site and points here.

> Partial: 4 of 7 multi-line comment blocks in this file have been
> moved here. The rest are still inline pending a hand-written one-line headline.

## §1. THE PRODUCER DECLARATION'S AUTHORING SURFACE

THE PRODUCER DECLARATION'S AUTHORING SURFACE (ADR-0032 §7e, proposal §12) — API-first per charter principle 3 (API -> SDK -> CLI).

THE DEFECT THIS CLOSES
`dependency_lines.produced_by_object_id` decided whether a line was INTERNAL, and its only writer — `declareDependencyLineProducer` — had NO NON-TEST CALLER: no route, no CLI verb, no job, no IaC construct. So in production the column was never set, `isInternalDependencyLine` was always false, and THE INTERNAL HALF OF DEPENDENCY SUBSCRIPTIONS COULD NOT FIRE AT ALL — half of what was asked for ("internal dependencies refresh the database once released to production"). Third-party polling worked; internal release detection derived lines for the empty set of declared producers. That is the built-never-installed shape, one layer down from where M21.5 already met it.

SO THIS FILE'S OWN WIRING IS THE FIRST THING TO PIN, because shipping a second uncalled function would be absurd. `dependency-producers.integration.test.ts`'s "WIRING: the declare route is REGISTERED" fails if `registerDependencyProducerRoutes` is removed from `app.ts` — deleting the registration was measured to turn it red.

WHAT MUST NOT BE THE FIX
Wiring the producer link into INGESTION. `UpsertDependencyLineInputSchema` has no producer field and `upsertDependencyLine`'s ON CONFLICT set list cannot reach one; the capability is ABSENT from the ingestion verb rather than guarded on it, and since drizzle/0068 the declaration is not even in the same table. Wiring it in would delete "declared, never inferred" and call it a completion. The missing piece was an authoring surface for a deliberately MANUAL declaration, and that is all this file is.

A VERB, NOT A FIELD WRITE — ON TWO OF ADR-0031 §6'S THREE GROUNDS
1. WORK BEYOND THE FIELD WRITE — TRANSFERS, more strongly than for `publish`. A declaration removes EVERY major of the coordinate from the poll's work-list and MOVES THE HEAD-DERIVATION INGRESS for those lines from a public index to the org's own production releases. It also clears observation state. None of that is visible in a field edit. 2. ONE-WAY — DOES NOT TRANSFER, and the verb does not borrow the rhetoric. Retraction is part of the concept, and it is a peer verb below. 3. A LEGIBLE REPORT — TRANSFERS, and is where the verb earns its keep. The response enumerates the lines the declaration covers, each line's head, and the subscribed components per line. THAT LIST IS THE BLAST RADIUS AND IT IS UNGUESSABLE FROM THE REQUEST: the declarer names one coordinate and affects a set of repositories they cannot see. `dryRun` returns the same report and writes nothing, which is the only way to look before you leap.

AUTHORITY, AND THE ACT ITSELF, ARE NOT DEFINED HERE ANY MORE
`policy:write` at the ORG ROOT (owner decision, 2026-08-17), and the four things a write does — the row, the head-clearing, the Decision and the audit event — live in `dependencies/producer-declaration.ts`. This route is now ONE OF TWO DOORS: `iac/plans-repo.ts`'s apply is the other (charter principle 3's IaC rung). Both read `dependencyProducerScopeCheck` for the authority and both call the same two effect functions, so neither the bar nor the effects can drift. That module's header carries the full argument for both; do not restate it here, because two copies of a security rule is how the copies come to disagree.

THE FK CONSTRAINT THE MIGRATIONS COULD NOT EXPRESS
`producer_object_id` is `REFERENCES objects(id)` and ORG-UNBOUND (drizzle/0061's header states why: `objects` carries no `(org_id, id)` unique constraint to hang a composite key on, and RI triggers are not subject to RLS). So the raw table would accept a deployment-target, a user, or ANOTHER TENANT'S OBJECT. 0061's header names the mitigation an eventual route owes — "resolve every caller-supplied object id under the CALLER'S OWN org before it reaches this table" — and `assertDeclarableProducer` is it. Do not read RLS as having done that.

A `service` IS REFUSED, with a message that says so (ADR-0032 §7e, owner decision). Not pedantry: `listProducedLines` derives a head only from the COMPONENT a prod placement names, so today a service-valued declaration derives no head at all while still removing the coordinate from third-party polling — the harmful half, silently, and not the useful half.

COMMANDER-ONLY ON THE FEDERATION AXIS ONLY
The WRITES answer 409 off `commanderOnlyFederationVerdict` for the reason `dependency-subscriptions.ts` already gives at length — "right request, wrong place", and a route must not carry the PROCESS axis (every HTTP request lands on an `SCP_ROLE=api` process in the split topology by design). The READ stays tenant-facing: a team must be able to see why their coordinate is not being polled.

## §2. POST /dependencies/producers — DECLARE

POST /dependencies/producers — DECLARE.

The coordinate travels in the BODY, never a path segment: coordinates contain `/`, `@` and `:` (`github.com/acme/lib`, `@acme/lib`, `docker.io/library/alpine`), and path-segmenting one is a trap `GET /components/:idOrUrn/dependency-subscription` already avoided by using a query.

## §3. NO PROJECTED DECLARATION

NO PROJECTED DECLARATION — `null`, the same answer a dry-run RETRACT already gives, and the reason is `declaredAt` (corrected 2026-08-17). The projection used to fill it with `previous?.declaredAt ?? ""`, and an EMPTY STRING SAYS NOTHING: it is not a timestamp, it is not "never", and a client that renders `declaration.declaredAt` prints blank or throws on a date parse. The two available fixes were to make `declaredAt` nullable or to drop the projection; dropping it is chosen because making a REQUIRED response property nullable is an oasdiff-visible weakening of `DependencyLineProducerSchema` — which is also the READ model of `GET /dependencies/producers`, where `declaredAt` genuinely is always present. One dry run must not loosen a type for every reader of the real thing.

Nothing an operator needs is lost. `ecosystem` and `coordinate` are on the envelope, `dryRun: true` says why this is null, a `producerIdOrUrn` that did not resolve to a live in-org component never reaches here (`assertDeclarableProducer` throws 404/400), so a 200 IS the resolution result — and `lines` is the blast radius the dry run exists for.

## §4. GET /dependencies/producers — the read

GET /dependencies/producers — the read. TENANT-FACING and NOT commander-only.

"Why is my coordinate not being polled?" is a question a team on any deployment may legitimately ask, and refusing it there would leave them with a verdict whose reason is unavailable — charter principle 6 failing rather than being satisfied. The answer is QUALIFIED by `dependencyManagement` for the same reason the resolution read is: on a field outpost this table is empty by design (ADR-0032 §7d), and an unqualified empty list reads as "nothing is declared" when the truth is "declarations live at the commander".
