# schemas

Long-form reference for the **schemas** subsystem — the rationale, hazards and open items that
used to sit inline. Each source file below carries a one-line headline at the site and points here.

> Partial: 477 of 477 multi-line comment blocks in this subsystem are here. The rest are
> still inline, pending a hand-written one-line headline.

## Files

- [`packages/schemas/src/artifact-infra-vocabulary.test.ts`](#packages-schemas-src-artifact-infra-vocabulary-test-ts) — §1–§1
- [`packages/schemas/src/audit-chain.ts`](#packages-schemas-src-audit-chain-ts) — §2–§4
- [`packages/schemas/src/audit.ts`](#packages-schemas-src-audit-ts) — §5–§5
- [`packages/schemas/src/auth.ts`](#packages-schemas-src-auth-ts) — §6–§9
- [`packages/schemas/src/binding-policy.ts`](#packages-schemas-src-binding-policy-ts) — §10–§12
- [`packages/schemas/src/campaign-recipe.test.ts`](#packages-schemas-src-campaign-recipe-test-ts) — §13–§14
- [`packages/schemas/src/campaigns.ts`](#packages-schemas-src-campaigns-ts) — §15–§48
- [`packages/schemas/src/canonical-json.test.ts`](#packages-schemas-src-canonical-json-test-ts) — §49–§51
- [`packages/schemas/src/canonical-json.ts`](#packages-schemas-src-canonical-json-ts) — §52–§54
- [`packages/schemas/src/changes.ts`](#packages-schemas-src-changes-ts) — §55–§86
- [`packages/schemas/src/common.ts`](#packages-schemas-src-common-ts) — §87–§91
- [`packages/schemas/src/components.ts`](#packages-schemas-src-components-ts) — §92–§123
- [`packages/schemas/src/dependencies.ts`](#packages-schemas-src-dependencies-ts) — §124–§172
- [`packages/schemas/src/doctor.ts`](#packages-schemas-src-doctor-ts) — §173–§174
- [`packages/schemas/src/domain-ids.ts`](#packages-schemas-src-domain-ids-ts) — §175–§179
- [`packages/schemas/src/events.ts`](#packages-schemas-src-events-ts) — §180–§180
- [`packages/schemas/src/executors.ts`](#packages-schemas-src-executors-ts) — §181–§204
- [`packages/schemas/src/federation-journal.test.ts`](#packages-schemas-src-federation-journal-test-ts) — §205–§206
- [`packages/schemas/src/federation-journal.ts`](#packages-schemas-src-federation-journal-ts) — §207–§214
- [`packages/schemas/src/federation.ts`](#packages-schemas-src-federation-ts) — §215–§257
- [`packages/schemas/src/governance-move.ts`](#packages-schemas-src-governance-move-ts) — §258–§258
- [`packages/schemas/src/governance.test.ts`](#packages-schemas-src-governance-test-ts) — §259–§259
- [`packages/schemas/src/governance.ts`](#packages-schemas-src-governance-ts) — §260–§277
- [`packages/schemas/src/graph.ts`](#packages-schemas-src-graph-ts) — §278–§296
- [`packages/schemas/src/health.ts`](#packages-schemas-src-health-ts) — §297–§298
- [`packages/schemas/src/coordination-as-code.ts`](#packages-schemas-src-iac-ts) — §299–§328
- [`packages/schemas/src/objects.ts`](#packages-schemas-src-objects-ts) — §329–§331
- [`packages/schemas/src/pipeline-behaviors.test.ts`](#packages-schemas-src-pipeline-behaviors-test-ts) — §332–§332
- [`packages/schemas/src/pipeline-behaviors.ts`](#packages-schemas-src-pipeline-behaviors-ts) — §333–§357
- [`packages/schemas/src/rbac.test.ts`](#packages-schemas-src-rbac-test-ts) — §358–§358
- [`packages/schemas/src/rbac.ts`](#packages-schemas-src-rbac-ts) — §359–§377
- [`packages/schemas/src/registries.ts`](#packages-schemas-src-registries-ts) — §378–§378
- [`packages/schemas/src/scan-db.ts`](#packages-schemas-src-scan-db-ts) — §379–§382
- [`packages/schemas/src/scan-exclusion-classes.test.ts`](#packages-schemas-src-scan-exclusion-classes-test-ts) — §383–§389
- [`packages/schemas/src/scan-exclusion-declared-override.test.ts`](#packages-schemas-src-scan-exclusion-declared-override-test-ts) — §390–§391
- [`packages/schemas/src/scanner-registry.test.ts`](#packages-schemas-src-scanner-registry-test-ts) — §392–§393
- [`packages/schemas/src/services.ts`](#packages-schemas-src-services-ts) — §394–§403
- [`packages/schemas/src/supply-chain.test.ts`](#packages-schemas-src-supply-chain-test-ts) — §404–§405
- [`packages/schemas/src/supply-chain.ts`](#packages-schemas-src-supply-chain-ts) — §406–§475
- [`packages/schemas/vitest.config.ts`](#packages-schemas-vitest-config-ts) — §476–§477

## `packages/schemas/src/artifact-infra-vocabulary.test.ts`

### §1. The artifact and infrastructure vocabulary schemas

D24 vocabulary: `ArtifactClassSchema`, `InfraKindSchema`, `RolloutTargetClassSchema` and the artifact-class x infra-kind compatibility matrix (`pipeline-behaviors.ts`). Every test here pins a PROPERTY the doc comments on those declarations state, not a mechanic — the point is that each one must fail if the derivation is ever replaced by a hand-written second list (the exact failure mode the provisional declarations this file replaces were written to avoid, per their own doc comments).

## `packages/schemas/src/audit-chain.ts`

### §2. Hash-chain canonicalization/verification (DESIGN.md §4.3)

Hash-chain canonicalization/verification (DESIGN.md §4.3) — deliberately NOT part of this package's default `"."` export (index.ts/package.json `exports`). It depends on Node's `node:crypto`, which can't run in a browser, and `@scp/schemas`' default entry is imported by `apps/web` (via `@scp/sdk`'s `DesiredStateManifestSchema` re-export) — a browser build. Import this file via the `@scp/schemas/audit-chain` subpath instead (apps/server's audit-repo.ts, packages/cli's `scp audit verify`), which keeps `node:crypto` out of any module graph Rollup resolves starting from the package's main entry, so the two are never in the same bundle.

The algorithm itself lives here (not duplicated in apps/server) so both the server (writes the chain) and the CLI (`scp audit verify`, which re-walks the chain via the public API only) share one implementation. Pure functions, table-driven-testable (BUILD_AND_TEST.md §4.1).

### §3. The deterministic canonical string for an event's content

Deterministic canonical string for the *content* of an audit event (everything except `row_hash` itself, which is derived from this). Field order is fixed so the same logical event always canonicalizes identically.

### §4. Re-walks a per-org audit chain

Re-walks a per-org audit chain (events must already be sorted oldest-first — chain order, i.e. `occurred_at, id` ascending) and verifies every `row_hash`/`prev_hash` link, per DESIGN.md §4.3. Pure function: no I/O, safe to unit-test and to run client-side against API-fetched pages (`scp audit verify`).

## `packages/schemas/src/audit.ts`

### §5. Hash-chained append-only audit log wire contract

Hash-chained append-only audit log wire contract (DESIGN.md §4.3) — the Zod schemas/types only. The hashing/canonicalization/verification algorithm (which needs `node:crypto`, so it can't be part of this package's browser-importable default entry) lives in `audit-chain.ts`/the `@scp/schemas/audit-chain` subpath instead — see that file's module doc.

## `packages/schemas/src/auth.ts`

### §6. Web UI v1 session discovery

Web UI v1 session discovery (M2 step 4, BUILD_AND_TEST.md §8 M2 item 2) — the SPA cannot read the httpOnly `scp_session` cookie itself, so `getCurrentUser`/`logout` give it an API surface to discover "am I logged in" and to end its session; `getAuthConfig` is public (no auth) so the login page can decide whether to offer "Continue with SSO" before the visitor has any credentials at all.

### §7. The install-time federation role of this instance

The install-time federation role of the INSTANCE serving this response (`SCP_FEDERATION_ROLE`, `apps/server/src/config.ts`) — outpost-ui.md §9.2. It decides ONLY which nav and route table the web shell mounts (a commander site vs the smaller outpost site); it authorizes nothing, and it is deliberately NOT `federation_self.role` (per-org, advisory, post-install — M16.3 P3 refused that axis for exactly this kind of decision). `retrans` never serves the SPA, so it never reaches a browser, but the enum mirrors the config rather than the UI.

### §8. Every role binding this caller holds anywhere in the org

Every role binding this caller holds ANYWHERE in the org, including ones reached through group or team membership (role-model.md §5 step 6).

Bindings rather than a rank, because after drizzle/0099 there is no rank: the five purpose roles are deliberately unordered, so "SecurityOfficer" tells a client nothing unless it also knows what SecurityOfficer carries and WHERE the binding sits.

### §9. ⚠️ THE UNION OF PERMISSIONS HELD AT *SOME* SCOPE

⚠️ THE UNION OF PERMISSIONS HELD AT *SOME* SCOPE — NOT AUTHORITY EVERYWHERE.

The name is `permissionsAnywhere` and not `permissions` on purpose, and it is the one place this step deviates from role-model.md §5 step 6's wording. A field called `permissions` on an endpoint called "me" reads as "what I can do", and the obvious client line — `me.permissions.includes("object:write")` to decide whether to render a Create button — is WRONG for exactly the principals these roles exist to express: a ComponentAdmin bound at one component holds `object:write` at that component and nowhere else, and would be shown a global control that 403s. The longer name makes the misuse visible at the call site.

WHAT IT IS LEGITIMATELY FOR: coarse navigation. "Should the Policies section appear in the nav at all" is answerable from this union — if the caller holds `policy:write` nowhere, the section is dead for them everywhere. Anything finer than that is `GET /api/v1/authz/effective`, which takes the object and is the only field that can answer per-scope questions.

## `packages/schemas/src/binding-policy.ts`

### §10. THE `executorBinding` POLICY EFFECT

THE `executorBinding` POLICY EFFECT (ADR-0046 §4; team-pipeline-iac §6, D4, §14 res 2 and 7).

WHAT THIS IS FOR: TEAMS AUTHOR THE WHAT, DOMAINS AUTHOR THE HOW
A team's stack declares services, components, placements and topologies — ordinary graph objects that federate. It does NOT declare which execution system runs them, and it cannot: ADR-0031 keeps `executor_bindings` domain-local because that is where credentials and executor addresses live, and the commander must not hold either.

So each domain declares, once, which of ITS execution systems serves which targets for which Type. That declaration is a policy EFFECT rather than a new object type, following `scanThreshold` (ADR-0016) and `dependencySubscription` (ADR-0032 §3a): `policy` is built-in on every instance and its upsert shares the importer's `object_upsert` case, so nothing new has to reach a not-yet-migrated outpost. A domain-local reconciler joins the federated WHAT against this local HOW and materializes the binding rows.

THE TEST LANE, AND WHY IT FALLS BACK RATHER THAN DEFAULTS (§14 resolution 7)
Test hooks (D11) should be able to run somewhere other than the deploy executor — a dedicated Argo Workflows instance, typically. That is the `test` lane. A domain that does not declare one FALLS BACK to the build lane, which is what makes the lane additive: an estate that never thinks about lanes behaves exactly as it does today, and one that does gets separation by writing a single extra policy line.

FALLBACK IS NOT THE SAME AS A DEFAULT, and the difference is the whole point of §14 res 2's "unbound and loud": falling back means "the build lane's answer, explicitly, because you declared no test lane" — a real declaration, resolvable, attributable to a policy someone wrote. A DEFAULT would mean "some org-tier executor nobody named", which this design refuses to have: a missing (target, Type) policy dispatches NOTHING and says so.

### §11. Which lane a binding serves

Which lane a binding serves. `build` is the ordinary lane every existing binding is in; `test` carries test-hook runs when a domain separates them.

A CLOSED ENUM HERE IS SAFE, unlike in a registered JSON Schema on the wire: this type governs the AUTHORING surface, and the policy document itself is validated by the schema a migration registers. See `pipeline-behaviors.ts`'s wave-gate note for the case where a closed enum on the wire would wedge a peer — the same care applies to the document schema, not to this.

### §12. One `executorBinding` effect

One `executorBinding` effect: which local execution system serves this scope, for which Type, in which lane.

`executionSystemUrn` is a URN rather than an id because the policy document is authored by a human in a domain HOW stack and must survive the object being recreated — the same reason manifest entries address by URN everywhere else.

## `packages/schemas/src/campaign-recipe.test.ts`

### §13. M25.4 — the AUTHOR'S DOOR, as a pure schema

M25.4 — the AUTHOR'S DOOR, as a pure schema.

Every case here is a document a real author could type, and the assertion is about what the document would MEAN if it were stored. A recipe that parses wrong does not error at trigger time — it reads as absent, and 47 components each roll their default pipeline while the campaign reports success. That is the failure this schema exists to make impossible, so the negative cases carry the weight.

### §14. M25.5 MOVED A KEY FROM UNKNOWN TO KNOWN, AND THIS CASE CAUGHT IT

M25.5 MOVED A KEY FROM UNKNOWN TO KNOWN, AND THIS CASE CAUGHT IT.

Until M25.5 this assertion used `adoption` as its unknown-key example — a deliberate choice at the time, because the proposal DESCRIBED that key while M25.4 shipped without it, so it was the most likely thing an author would write and the most valuable thing to refuse. Shipping `adoption` flipped it from refused to accepted, and this case went red on exactly the change that made it wrong, which is the whole reason to pick a live example over an invented one. Replaced with a key nothing in the design names, so it cannot go stale the same way.

## `packages/schemas/src/campaigns.ts`

### §15. M5 Campaigns wire contract

M5 Campaigns wire contract (DESIGN.md §9.5, BUILD_AND_TEST.md §8 M5). Campaigns introduce NO new engine machinery — a Campaign compiles its own plan/waves over the SAME `coordination/plan-compiler.ts` pure function a Change uses (`coordination/ campaign-plan-service.ts`); its wave targets fan out into real M3 Changes (`ChangeSchema`, unchanged) that run through the completely unmodified change lifecycle/gates. Campaign STATUS is a pure DERIVED aggregation (`coordination/campaign-status.ts`), never a stored state column — hence no `CampaignStateSchema` mirroring `ChangeStateSchema`'s 8-state machine here.

### §16. M25.4 — THE CAMPAIGN RECIPE

M25.4 — THE CAMPAIGN RECIPE (owner decision D3: a COORDINATION lever, never an authoring one)

WHAT A RECIPE IS. One authored trigger intent that a campaign fans across N components: which kind of trigger to ask each target's ALREADY-BOUND executor for, and what parameters to hand it. That is the whole of it, and the narrowness is the point.

WHAT A RECIPE IS NOT, and cannot become without a charter amendment. It carries NO patch, NO file content, NO command line, NO script. CommanderSCP does not write the python3 diff and does not know how to port Python — it triggers the TENANT'S OWN migration workflow, once per component, wave-ordered and gated (charter principle 1). If a tenant has no such workflow, a campaign has nothing to trigger and the honest outcome is the capability refusal below, not a managed migration. The `scp-managed-dep` grant is textually narrow ("editing the declared version of an already-declared dependency", "never authors any other content") and is deliberately NOT stretched to cover this: OQ-5 is unruled, so nothing here drives that actuator.

WHY `campaign.properties.recipe` AND NOT A TABLE — see `docs/adr/0041`. Short form: a recipe has no window, no lifecycle and no independent identity (charter principle 2 — new concepts arrive as data on existing objects), and the `freezes` projection table earns its exception on window semantics queried on a hot gate path, which a recipe read once per trigger does not have. The decisive argument is reach: config that must cross a federation boundary rides `object_upsert` as a graph OBJECT, and nothing table-shaped travels.

### §17. The trigger kinds a recipe may ask for, minus rollback

The trigger kinds a recipe may ask for — `TriggerIntent["kind"]` MINUS `"rollback"`.

The subtraction is a safety property, not tidiness. A rollback is addressed to a `priorStateRef` a prior `status()` call captured, and `reconcile.ts` decides `kind = "rollback"` from the CHANGE (`isRollback`), never from a document. If a recipe could name `"rollback"`, a campaign author could turn every member change into a restore; and because the recipe rides the change's properties through federation promotion, that document would arrive at an outpost too. The inverse is also enforced at the actuator: `isRollback` overrides the recipe's kind unconditionally, so a rollback of a recipe-carrying change is still a rollback.

### §18. Max serialized size of `trigger.parameters`, in bytes of JSON

Max serialized size of `trigger.parameters`, in bytes of JSON. Bounded BEFORE it becomes a row: the recipe is copied verbatim onto every member change's `properties` (one row per target — 47 for the motivating campaign) and reaches a `block` Decision's `inputContext` on the refusal path. An unbounded free-form bag on both of those is the shape of the measured 1.44 GB/day Decision growth incident, arriving through a different door.

### §19. Substrings that may not appear in any parameter key

Substrings that may not appear in ANY parameter key, at any depth, case-insensitively.

`objects.properties` is readable at `object:read`, and a recipe is copied onto every member change's properties — so a secret placed here is a secret published to everyone who can read any one of 47 changes. Secrets belong in `executor_bindings.secret_refs`, which the plugin host resolves per instance and never puts on the graph.

MATCHED AGAINST A NORMALIZED KEY — lowercased with every non-alphanumeric character removed — and a SUBSTRING rather than a prefix. Both halves were chosen after the first draft failed its own test: it listed `apikey` and `api_key` as separate entries and let `x-api-key` through, which is the "enumerate the symptoms" mistake in miniature. Normalizing collapses `api_key`, `api-key`, `x-api-key` and `apiKey` into one rule, so the list names CONCEPTS and the separator vocabulary cannot grow a hole. `githubToken`, `deploy_password` and `AWS_SECRET_ACCESS_KEY` are the shapes people actually write, and a prefix rule catches none of them.

The false-positive cost is one 400 naming the key and the remedy; the false-negative cost is a credential in a federated, `object:read`-visible document that no later fix can un-publish.

### §20. M25.5 — ADOPTION EVIDENCE

M25.5 — ADOPTION EVIDENCE ("has component X migrated yet?")

THE HONEST ANSWER FIRST, because everything below is shaped by it: **SCP cannot know in general whether a component has been migrated.** There is no per-component standing state store — `observed_state` is per-wave-target and `control_runs` is per-change — so the platform has no place to look unless the recipe TELLS it where. A recipe therefore NAMES its own evidence source, and where it names none, or where the named source is silent, the verdict is `unknown`, **never `adopted`**. That is `coordination/boundary-segment.ts`'s honesty rule R3 ("silence is never a pass") applied unchanged, and it is the entire safety property of this feature: M25.6's deadline lock fires on this predicate, so an `adopted` conjured out of an absent fact is a governance record asserting compliance that nobody verified.

WHY A DISCRIMINATED UNION AND NOT A BAG OF OPTIONAL FIELDS. Each kind reads a DIFFERENT table with different key columns, and a bag would let an author write `{ecosystem, controlObjectId}` — two sources, no rule for which wins. The union makes "which fact answers this question" a single authored choice that the reader cannot silently reinterpret.

`declared` IS DELIBERATELY ABSENT. OQ-6 IS UNRULED AND THIS SHIPS WITHOUT IT.
The proposal's §3.4 sketch lists a FOURTH kind — `{kind:"declared", key, value}`, read from a `component.properties.adoption.declarations` bag. It is not here, and its absence is a decision rather than an omission. §4.4 states the reason and its own recommendation ("do not ship `declared` until an above-component admission exists"): the beneficiary of the assertion "I have migrated" is exactly the party the deadline exists to coerce, writing at plain `object:write` on their OWN component, with none of M22's admission algebra above it. A self-attested deadline waiver produces a signed, hash-chained governance record asserting a migration nobody observed — strictly worse than having no lock at all.

ADDING IT LATER IS ADDITIVE AND BREAKS NOTHING. A new member of a `z.discriminatedUnion` is a new `oneOf` branch in the emitted OpenAPI: an old client never sends it and never has to parse one it did not author, and no existing branch changes shape. The same is true of a fifth kind. What is NOT additive — and must never be done to this union — is adding a required field to an EXISTING branch, or making one of the fields below optional on a response.

### §21. This campaign's own wave target for the component

THIS CAMPAIGN'S OWN wave target for the component is `succeeded`. Zero new machinery: the fact is already in `campaign_wave_targets`.

THE VERDICT STRING IS `"delivered"` AND NEVER `"migrated"`, and the distinction is the whole reason this kind is named the way it is. What `succeeded` means is: SCP triggered the tenant's OWN pipeline for that component and the resulting member Change reached `accepted`. It does not mean the code changed — the recipe's `workflow_dispatch` may have run a workflow that did nothing, and `github`/`gitea` resolve `intent.parameters?.workflowId ?? config.defaultWorkflowId` so a target whose binding names a different default runs THAT one and still succeeds.

IT IS ALSO NEARLY INERT IN THE CAMPAIGN RECONCILER, by construction rather than by accident, and the proposal (§4.4) says so plainly rather than selling it: the reconciler evaluates adoption only for a `pending` target, and a `pending` target has by definition not succeeded. So this kind can never make the reconciler skip a fan-out. Its value is on the READ surface (and, from M25.6, as the deadline lock's default signal) — which is exactly the "the campaign hasn't reached you yet, and now it never will" degeneracy §4.4 names, and the reason a real migration campaign should choose `dependency` or `control` instead.

### §22. The one that actually works, and what backs it

THE ONE THAT ACTUALLY WORKS FOR python2 -> python3, and the only kind backed by a standing, component-scoped, INDEPENDENTLY REFRESHED fact table: `component_dependencies`, re-read out of the repository itself by `dependencies/inventory-ingestion-loop.ts` whenever a change is accepted. After the migration workflow's push lands, the inventory reads `FROM python:3.12-slim` from the actual file — evidence SCP observed, not evidence anybody asserted.

`adopted` iff no live row for this `(ecosystem, coordinate)` resolves BELOW `minVersion`; `unknown` iff the component has ZERO inventory rows at all. That second clause is the load- bearing one: "never ingested" and "declares nothing on this coordinate" are different facts, and conflating them is precisely the silence-as-a-pass failure this whole file exists to refuse. See `coordination/campaign-adoption.ts` for the full verdict matrix, including how a NULL `resolved_version` (an open range — "the manifest pins no concrete version", never "we did not look") and a version pair the shared comparator declines to order are treated. Neither can ever produce `adopted`.

### §23. The latest control run for this campaign's member change

The latest `control_runs` row for `(this campaign's member change for the target, controlObjectId)` is `pass`. The STRONGEST kind: a control run is a governed, evidence-carrying observation the platform itself orchestrated.

`plugin_module` is read off the RUN ROW, never re-resolved from the binding. That column is stamped at insert (drizzle/0063) precisely so that re-pointing a control's binding cannot retroactively relabel a historical pass as having come from a different checker — the provenance-labels-are-read-not-inferred rule, applied to the one fact that decides whether a component escapes a deadline.

### §24. THE AUTHOR'S DOOR

THE AUTHOR'S DOOR — `z.strictObject` throughout, and open in the property registry (the 0043/0075 rule: `import-repo.ts`'s `object_upsert` branch Ajv-validates against the REGISTERED schema with no try/catch, so a closed registry schema makes every future key a fail-closed version-skew hazard that wedges a peer's whole signed bundle; a refusal here costs one 400 and nobody's bundle).

EVERY FUTURE KEY MUST BE OPTIONAL. M25.5's `adoption` evidence is the next one, and this schema is reachable through federation promotion (a promoted change carries its recipe — see `promotion-repo.ts`), so a REQUIRED addition would make a newer commander's promotion unparseable at an older outpost. `version` exists to say which vocabulary the document speaks, never as a licence to make a later version's key mandatory.

### §25. VERBATIM into `TriggerIntent.parameters`

VERBATIM into `TriggerIntent.parameters`. **SCP performs NO cross-provider translation** — a recipe written in `github` keys is never guessed into `gitlab` shape (see the adapter table in `docs/adr/0041`). Translating would mean re-rendering a declaration SCP does not fully model, and a wrong guess triggers the wrong automation in a tenant's own repository. The author picks the keys their bound executors read; a target whose executor cannot serve the recipe's KIND is refused loudly rather than silently defaulted.

### §26. Where to look to answer has this component migrated

M25.5 — WHERE TO LOOK to answer "has this component migrated yet?" (see `AdoptionEvidenceSchema`).

OPTIONAL, and the inertness that buys is a stated property rather than a nicety: a recipe that declares none makes `coordination/campaign-adoption.ts` return `unknown` before it issues a single query, and makes the campaign reconciler skip the predicate entirely. A campaign authored before M25.5 therefore costs exactly what it cost before M25.5.

ABSENT IS `unknown`, NOT `adopted`. There is no default evidence source and there must never be one — inferring `delivered` from a recipe that named nothing would be the platform answering a question it was not given the means to answer.

### §27. M25.6a — THE DEADLINE

M25.6a — THE DEADLINE (owner decision D4: the radius is THE CAMPAIGN'S OWN TARGETS)

WHAT A DEADLINE IS. A date, on a campaign, past which that campaign stops fanning out to targets it cannot observe as migrated. Nothing more.

WHAT ITS RADIUS IS, because this is the thing most easily got wrong. An unmigrated component stops receiving *THIS CAMPAIGN'S* changes. Unrelated releases — INCLUDING SECURITY FIXES — keep flowing to it, untouched. It is **not** a freeze on the component and it must not be implemented as one: not through `checkFreeze` (scope-based, campaign-blind and all-or-nothing across a wave — routing a per-target deadline through it would re-lock the crux M25.2 just fixed), and not through `evaluateWaveGate` (one verdict, no target dimension, fires exactly once).

WHY IT LIVES ON `campaign.properties` AND NOT IN A TABLE — the same three reasons ADR-0041 gives for the recipe, one of which is decisive here too: config that must cross a federation boundary rides `object_upsert` as a graph OBJECT, and nothing table-shaped travels. `campaign.properties` validates against an OPEN JSON Schema under `new Ajv({strict:false})` (drizzle/0011 §4), so this key costs no migration at all.

IT IS CONFIGURATION, NOT STATUS, and that is what keeps "campaign status is derived, never stored" intact. The deadline is an INPUT. Nothing anywhere ever writes "locked": the lock is re-derived from `(deadline.at, adoption)` on every tick, which is exactly what makes a late adoption or a moved deadline clear it with NO unlock verb.

### §28. WHICH adoption signal this deadline was authored against

WHICH adoption signal this deadline was authored against — DECLARATIVE ONLY.

IT IS NOT A SELECTOR, AND MUST NEVER BECOME ONE
The verdict "has this component migrated?" comes from `coordination/campaign-adoption.ts`'s `evaluateCampaignAdoption` reading the campaign's OWN `recipe.adoption` document — the ONE resolution core (§3.4 consumer 4: "reads this function and nothing else"). This field cannot select an evidence source even if someone wanted it to: a bare string carries no `ecosystem`, `coordinate`, `minVersion` or `controlObjectId`, so there is nothing here to resolve WITH. It is recorded so the durable record says which signal the author believed they were relying on, and so an operator reading the campaign can see at a glance whether the deadline is a real lock or the near-no-op §4.4 describes.

THE VOCABULARY IS `AdoptionEvidenceSchema`'s DISCRIMINATOR, not the proposal's §4.1 sketch. That sketch predates M25.5 and writes the first value as `"campaign_target_succeeded"`; the shipped name for that fact is `delivered` (see `AdoptionEvidenceSchema`, which chose it precisely to stop anyone reading it as "migrated"). Two spellings of one concept is how the two drift, so there is one. `campaign-deadline-lock.test.ts` pins this enum against the evidence union's members so a fourth evidence kind cannot land on only one of them.

`declared` IS ABSENT for the same reason it is absent from `AdoptionEvidenceSchema`: OQ-6 is unruled and §4.4's own recommendation is not to ship it until an above-component admission algebra exists. A self-attested deadline waiver produces a signed governance record asserting a migration nobody observed.

### §29. M25.6b — ONE PER-TARGET WAIVER of this campaign's deadline

M25.6b — ONE PER-TARGET WAIVER of this campaign's deadline (§4.5).

IT IS A STORED DOCUMENT, NEVER A REQUEST BODY — AND THAT SPLIT IS THE AUTHORITY CHECK
Every field here except `until` is filled in BY THE SERVER from the authenticated act: `targetObjectId` from the resolved target, `reason` from the mandatory request field, `actorId` from the bearer subject, `at` from the write's own clock. Nothing on the wire can author one.

That is not stylistic. `POST /campaigns` and `POST /campaigns/{id}/deadline` both take a `CampaignDeadlineInputSchema`, and `POST /campaigns/{id}/deadline-override` takes `OverrideCampaignDeadlineRequestSchema` behind the Owner-only `campaign:deadline-override`. If the two doors shared one schema, the deadline doors would mint waivers the override door exists to gate — a self-service waiver channel that LOOKS enforced, which is precisely the hazard M25.6a refused this key to avoid. `CampaignDeadlineSchema` (storage + read) carries `overrides`; `CampaignDeadlineInputSchema` (both authoring doors) does not, and it is `.strict()`, so naming the key there is a 400 rather than a silent drop.

THE SCHEMA SPLIT IS STILL THE CHECK, EVEN THOUGH THE PRICES NOW OVERLAP. Owner ruling 2026-08-25 (D1 b-i) made the WIDENING acts of `POST /campaigns/{id}/deadline` — clearing the deadline, and moving it to a later instant — demand `campaign:deadline-override` too. `POST /campaigns` and the tightening acts (a first set, a shortening) still run at plain `object:write`, so a schema carrying `overrides` would still be a waiver channel at a lower price. And even for a caller who DOES hold the override permission, minting a waiver through this key would skip the per-target `object:write`, the per-target audit event and the resolved-target list that `/deadline-override` produces — the split is about the SHAPE of the record as much as the bar.

`until` IS A BOUNDARY, NOT A TIMER, and its expiry is READ-TIME: `campaign-deadline-lock.ts` compares it against the tick's `now` on every evaluation and no job un-flips anything. An `until` in the past is simply not effective — the M22.6 ruling, applied a third time in this milestone. ABSENT means "until the deadline is cleared or the target adopts", which is the common case: an Owner excusing a laggard usually cannot say when it will be done.

### §30. THE STORED / READ SHAPE

THE STORED / READ SHAPE — `z.strictObject`, and OPEN in the property registry, the same 0043/0075 split `CampaignRecipeSchema` documents. Wire-side strictness is a LOCAL authoring refusal (one 400, nobody's bundle); a tightened REGISTRY schema is a fail-closed version-skew hazard that wedges a peer's whole signed bundle at an older receiver. Hence: no property-schema migration in this increment either, and a document a newer commander writes that this schema refuses degrades to "no deadline" on the read surface and to a loud `warn` at the predicate — never to a silent lock.

`overrides[]` — §4.1's fourth key — LANDS HERE IN M25.6b, and only here. The two AUTHORING doors take `CampaignDeadlineInputSchema`, which omits it; see `CampaignDeadlineOverrideSchema` for why that split is the authority check rather than a tidiness preference.

### §31. The instant past which unmigrated targets stop receiving

The instant past which unmigrated targets stop receiving this campaign's fan-out.

THE ONLY CLOCK-SHAPED VALUE ANY OF THIS FEATURE'S DECISIONS MAY CARRY. `at` is a stored BOUNDARY, byte-identical on every one of the 86,400 ticks in a day, which is what lets `insertDecisionIfChanged` collapse a standing lock to ONE row. Recording the clock instead — `now`, `evaluatedAt`, `overdueMs`, `daysLate`, `lockedSince`, any remaining-TTL — is the measured 1.44 GB/day production incident (ADR-0024) rebuilt from parts.

### §32. The per-target waivers in force, at most one per target

M25.6b — the per-target waivers in force, AT MOST ONE PER TARGET and stored sorted by `targetObjectId`.

BOTH OF THOSE ARE LOAD-BEARING RATHER THAN TIDY. This document rides `object_upsert` to every federated replica and is content-hashed on every write, so an append-only list would grow without bound and re-hash the campaign object on every re-statement of a waiver that already existed; sorting makes a re-issued waiver byte-identical instead. Re-overriding a target REPLACES its entry — the newest reason and the newest `until` are the ones in force, and the superseded one survives on the hash chain where history belongs.

### §33. THE AUTHOR'S DOOR

THE AUTHOR'S DOOR — what `POST /campaigns` and `POST /campaigns/{id}/deadline` accept.

IDENTICAL TO `CampaignDeadlineSchema` MINUS `overrides`, and still STRICT, so naming `overrides` at either door is a 400 rather than a value silently dropped on the floor. Minting a waiver takes `campaign:deadline-override` (Owner-only, drizzle/0088) at the campaign PLUS `object:write` at each named target. `POST /campaigns` takes plain `object:write` at the campaign alone (a create is always a FIRST set), and so does `POST /campaigns/{id}/deadline` when it sets a first deadline or SHORTENS one; only that route's WIDENING acts — clearing, and moving the instant later — also take `campaign:deadline-override` (owner ruling 2026-08-25, D1 b-i). Neither door demands the per-target `object:write` a waiver does, and the create door demands nothing extra at all, so one shared schema would still be the permission's bypass.

Deriving it by `.omit()` rather than declaring a second literal object is what keeps a future third key (`at`-like configuration, not a waiver) from being added to one and not the other.

### §34. `POST /api/v1/campaigns/{id}/deadline` — set, move, or CLEAR

`POST /api/v1/campaigns/{id}/deadline` — set, move, or CLEAR.

ONE VERB FOR ALL THREE, with `deadline: null` meaning clear. Campaigns have no PATCH and no DELETE today — the same entrance-with-no-exit gap M25.1 closed for freezes — and a deadline that cannot be moved is a deadline that gets worked around by deleting the campaign, which takes the whole governance record's SURFACE with it.

`reason` IS MANDATORY on every one of the three, including the clear. The audit event this produces records the PREVIOUS value beside the new one, because "the deadline slipped four times" is otherwise unreconstructible from a chain of writes that each say only where it landed.

TWO PRICES, ONE VERB (owner ruling 2026-08-25, D1 b-i). Setting a first deadline and SHORTENING an existing one are TIGHTENINGS — strictly more targets are withheld afterwards — and run at plain `object:write` at the campaign. CLEARING it, and moving `at` to an instant LATER than the stored one, RELEASE targets, and both additionally demand the Owner-only `campaign:deadline-override` (drizzle/0088) at the campaign. As shipped, all three ran at `object:write` while the NARROWER per-target waiver one route down needed an Owner, so an operator refused a one-target waiver could clear the whole deadline instead and excuse everybody, permanently — a wider verb at the narrower verb's price. The bar is ADDED, never substituted: `object:write` still governs all three acts.

### §35. The new deadline, or `null` to clear it

The new deadline, or `null` to clear it.

`CampaignDeadlineInputSchema`, NOT `CampaignDeadlineSchema`: accepting `overrides` here would let this verb mint the very waivers `POST /campaigns/{id}/deadline-override` exists to produce — at plain `object:write` whenever the act is a tightening, and without the per-target `object:write`, the per-target audit event or the named target list even when it is not. Naming the key is a 400 (the schema is strict), not a silent drop. The waivers already in force are PRESERVED across a set or a move — see `setCampaignDeadline`.

### §36. `POST /api/v1/campaigns/{id}/deadline-override` (M25.6b, §4.5)

`POST /api/v1/campaigns/{id}/deadline-override` (M25.6b, §4.5) — EXCUSE ONE LAGGARD without clearing the deadline for everybody, which is the only exit M25.6a shipped.

THE AUTHORIZATION IS THE SUBSTANCE, AND IT IS TWO CHECKS AT TWO DIFFERENT OBJECTS
* `campaign:deadline-override` **AT THE CAMPAIGN OBJECT**. The thing being waived is *this campaign's* deadline, so the authority that waives it is authority over the campaign. A target-scoped check would hand the laggard their own waiver — the component's own operator could excuse the component from the migration the campaign exists to force. * `object:write` **AT EACH NAMED TARGET**, so a waiver cannot be minted over a component the actor has no standing on at all.

It is deliberately NOT `freeze:override`. Borrowing that would let anyone holding a freeze override waive migration deadlines and vice versa — two unrelated blast radii collapsed onto one permission, and neither grant could afterwards be narrowed without taking the other with it.

### §37. WHICH targets to excuse

WHICH targets to excuse — object ids or URNs, each of which must already be a target of this campaign (a waiver over a non-target is dead data in a governance record, so it is a 400).

OMITTED MEANS EVERY TARGET THE CAMPAIGN CURRENTLY DECLARES, and that is NOT a synonym for clearing the deadline: the deadline stands, each waiver is recorded per target with its own audit event, `until` still expires them, and a target added to a later campaign is not covered. `object:write` is then demanded at every one of them, so the broad form needs broad standing.

### §38. The campaign's deadline, or null when it declares none

M25.6a — the campaign's deadline, or `null` when it declares none.

REQUIRED AND NULLABLE, not optional, and the asymmetry with `recipe` directly above is deliberate rather than an inconsistency. `recipe` is a lever an operator either configured or did not; `deadline` is a governance fact whose ABSENCE is itself the answer to "is anything being withheld from this campaign's laggards?" — and an operator must not have to distinguish "no deadline" from "this response predates the field". Same reasoning, and the same oasdiff arithmetic, as `FreezeSchema.atomic`/`liftedAt`: adding a required response property is additive; making an EXISTING required one optional is the break this project has already paid for once.

A document that does not parse reads as `null` HERE — a display surface, where absence is the honest rendering — while the ACTUATOR treats the same bytes as a loud, recorded `warn` and locks nothing (`coordination/campaign-deadline-lock.ts`). The two agree on the operator-visible outcome: nothing is being withheld.

### §39. WHICH pipeline every change this campaign fans out rolls

WHICH pipeline every change this campaign fans out rolls (M12 P4A) — the routing Type (ADR-0007). "Patch the base AMI across every cluster" is an `infrastructure` campaign, "roll the log4j bump across every service" a `configuration` one. Declared once on the campaign rather than per fanned-out change, which is what a campaign IS: one intent, many targets. Omitted means 'configuration' (the server default).

### §40. The date past which this campaign stops fanning out

M25.6a (owner decision D4) — the date past which this campaign stops fanning out to targets it cannot observe as migrated. A REQUEST widening, so oasdiff-free. Authoring it here rather than only through `POST /campaigns/{id}/deadline` is what keeps a deadlined campaign a single call; the dedicated route exists to MOVE and CLEAR it afterwards, with a mandatory reason and an audit event carrying the previous value.

`CampaignDeadlineInputSchema`, so a campaign cannot be CREATED carrying waivers: this route runs at `object:write`, and `overrides` takes the Owner-only `campaign:deadline-override` at the campaign plus `object:write` at every named target.

### §41. Narrow the page to the containment subtree of ONE object

Narrow the page to the containment subtree of ONE object — the authority hint (docs/proposals/role-model.md §8.2 step 6). A campaign authored with `domainId` lives under that object, so `?scopeObjectId=<service>` is "the campaigns of this service".

NEVER a widening: the caller is authorized at this object before it is used, so the rows it admits are always a subset of the rows they could already list. An id naming nothing is a **404** — authorizing at an unresolved value would answer 403 for everybody, org-root Owner included, because `scopeExpandCte` seeds its walk with the raw uuid and never checks existence.

### §42. `POST /campaigns/{id}/rollback` response

`POST /campaigns/{id}/rollback` response — DESIGN §9.5: "reverts its accepted member targets through the same wave/rollback machinery, each producing a Decision." One `rolledBack` entry per member Change actually rolled back (each `rollbackChange` is a real, independent Change); `skipped` names every member Change that was NOT eligible (never accepted, already rolled back, etc.) and why — never silently dropped.

### §43. THE WAVE-TARGET FREEZE-HOLD PROJECTION, campaign side

THE WAVE-TARGET FREEZE-HOLD PROJECTION, campaign side (M25.UI's closing "wave-target hold projection" section, extended per the change-wave layer's own `ChangeWaveTargetSchema.hold` doc — read that field's doc for the four properties this shape satisfies verbatim; this is a structural mirror, composed by the SAME `toWaveTargetHold` helper `plan-service.ts` exports, never a parallel reimplementation).

FREEZE-ONLY, unlike nothing — a campaign wave target has no stage-dependency concept at all (`campaign-plan-service.ts`'s `compileAndPersistCampaignPlan` never threads `declaredStageDependencies`; ADR-0028 is a Change-only coupling), so this field is already the WHOLE hold, not one half of it the way `ChangeWaveTargetSchema.hold` is.

ADDITIVE-OPTIONAL AND COMPOSED AT READ TIME, never persisted, and present ONLY while the target is genuinely held AND still a fan-out candidate (its own `memberChangeObjectId` is still `null` — once a member Change is minted, admission has already acted and a freeze bites that change's own wave targets one layer down, not this row). A lifted freeze, or a target outside the currently-governing wave, is simply absent on the next read — never a stale `held: true`.

### §44. SERVER-COMPUTED COUNT of this wave's currently-held targets

SERVER-COMPUTED COUNT of this wave's currently-held targets — mirrors `ChangeWaveSchema.heldTargetCount` exactly, but FREEZE-HELD ONLY (`targets[].hold`): a campaign wave target has no stage-dependency half to add in (see that field's own doc). ADDITIVE-OPTIONAL for oasdiff, and emitted ONLY for the wave admission currently governs — the one RUNNING wave the freeze evaluation ever looks at (`campaign-plan-service.ts`'s `resolveActiveCampaignWaveFreezeHolds`, the same `activeWaveOf` selector `coordination/plan-service.ts` uses for the change side, so "which wave was evaluated" and "which wave carries the count" cannot drift). Absent means "not evaluated" (a future wave's targets may sit under a standing freeze that will hold them at their turn — a zero there would be fabricated), never "zero by omission"; `0` means evaluated with nothing held. Clients must never recompute this from `targets[].hold` alone for a different wave than the one this count was emitted for.

### §45. THREE VALUES, AND THE THIRD IS NOT A DEGRADED SECOND

THREE VALUES, AND THE THIRD IS NOT A DEGRADED SECOND. `unknown` means "the named evidence source had nothing to say about this component" — never ingested, no control run, no wave target — and it is a DIFFERENT fact from `not_adopted` ("we looked and this component is below the floor / the control did not pass"). Collapsing them would make an un-ingested component indistinguishable from an observed laggard, and would put the platform one refactor away from reading a missing fact as a satisfied one.

BOTH `unknown` AND `not_adopted` KEEP A TARGET IN THE CAMPAIGN. Only `adopted` is an exit — from the fan-out here, and from M25.6's deadline lock. That asymmetry is the R3 rule in its operational form, and it is why the enum can never grow a fourth "probably" value.

### §46. The EVIDENCE ITSELF, one line per observed fact

The EVIDENCE ITSELF, one line per observed fact — a declared/resolved version pair and its position relative to the floor, a control run id with its status and stamped `plugin_module`, a wave target status.

**SORTED, and that is a correctness requirement rather than a presentation choice.** This exact array is what the reconciler puts in the `campaign_adoption` Decision's `inputContext`, and `decisions-repo.ts`'s `restatesDecision` canonicalizes object KEYS but deliberately preserves array ORDER ("a reordered array is a genuinely different input set and MUST write a new row"). An unsorted array — Postgres returns rows in no guaranteed order — would therefore make an unchanged situation look new on some ticks and write a fresh Decision row for it. That is the shape of the measured 1.44 GB/day incident (ADR-0024), reached through a different door.

NOTHING CLOCK-SHAPED APPEARS HERE. No evaluation timestamp, no attempt counter, no "checked N seconds ago" — those are the values that make every tick's observation differ from the last.

### §47. The per-target answer to has this component migrated

`GET /campaigns/{id}/adoption` — the per-target answer to "has this component migrated yet?", derived live at read time. There is NO stored adoption column and no scheduler: the verdict is re-derived from the named evidence source on every read, which is what makes a late migration, a re-ingested manifest or a re-run control clear it with no "mark adopted" verb anywhere.

### §48. Declared targets that resolved to no live object

Declared targets that could not be resolved to a live object, named rather than dropped.

Only reachable BEFORE a plan is compiled (afterwards the targets come from the plan, which by construction holds resolved ids). An IaC-authored campaign declares URN-shaped targets until the reconciler's first pass normalises them, and a target deleted after authoring never resolves at all — the same fault `campaign-reconcile.ts` records as a `plan_diff` block. Returning an empty `targets` array with no explanation would be this feature's own failure mode in miniature: an absence rendered as a clean result.

## `packages/schemas/src/canonical-json.test.ts`

### §49. The implementation this module replaces, copied verbatim

The implementation this module replaces, copied VERBATIM from `origin/main`'s `federation-journal.ts` (identical bytes in four other files). It is here as the differential oracle for the compatibility guarantee: for input with no own `__proto__` key the new canonicalizer must agree with it to the byte, because live estates hold `row_hash` / `content_hash` values computed by it.

### §50. THE assertion that had to flip

THE assertion that had to flip. On `origin/main` these two produced the byte-identical string `{"ok":1}`, so a peer could append an arbitrarily large subtree to a signed payload without changing its `rowHash` or its Ed25519 signature.

### §51. Snapshot every Object.prototype key, not three named ones

A full snapshot of `Object.prototype`'s own property names, captured at module load. Asserting that three named keys are absent only proves those three are absent; this proves NOTHING was added or removed. A leaked pollution would make every later assertion in the run untrustworthy, so it is checked rather than assumed.

## `packages/schemas/src/canonical-json.ts`

### §52. THE canonical JSON serializer for this repo

THE canonical JSON serializer for this repo — one implementation, deliberately.

Before this module existed there were FIVE byte-for-byte copies of the same `sortKeysDeep` helper (`@scp/schemas`'s `federation-journal.ts`, `apps/server`'s `util/canonical-json.ts` and `coordination/decisions-repo.ts` and `coordination/test-support/counting-cel-sandbox.ts`, and `@scp/coordination-as-code`'s `canonical.ts`), each carrying a comment explaining that it was "vendored" or "duplicated" to avoid a module-boundary violation. They all shared one bug (below), and fixing it in four of five places would have been the classic outcome this repo's census rule exists to prevent. `@scp/schemas` is the lowest common dependency of every one of those call sites, and this module is pure — no `node:crypto`, no I/O — so it is safe in the browser build too.

## Why the key-sort exists at all

A canonical form must be independent of key INSERTION order, because the same content reaches these functions through paths that do not agree on it: a `jsonb` column does not preserve the author's key order, so a hash computed at write time over an in-memory object literal would not match the same hash recomputed at verify time over the row read back. Sorting recursively makes the serialization a function of content alone.

## The bug this module fixes: canonicalization was not TOTAL

The old shape was `Object.keys(src).sort().reduce((acc, key) => { acc[key] = ...; return acc }, {})`. `JSON.parse` makes `__proto__` an **own, enumerable data property**, so `Object.keys` yields it — but `acc[key] = value` on a `{}` accumulator goes through the `__proto__` **setter inherited from `Object.prototype`**, which does not store anything. Two consequences, both measured on `origin/main` before this change:

```text
1. The subtree VANISHES from the canonical string. `{"ok":1}` and
   `{"ok":1,"__proto__":{...arbitrarily large...}}` canonicalized to the byte-identical
   `{"ok":1}` — therefore the same sha256 `rowHash` and the same Ed25519 signature. A
   signature that does not cover what a peer can smuggle past it is not a signature;
   `verifyJournalChain`, documented as "the fail-closed gate a tampered or truncated segment
   must never pass", passed such a segment.
2. The RETURNED object had its prototype silently swapped to the attacker's object. For input
   `{"ok":1,"__proto__":{"isAdmin":true}}` the result reported `Object.keys() === ["ok"]`
   while `result.isAdmin === true`. (This does not mutate the global `Object.prototype` — the
   setter retargets the receiver — but it hands every downstream reader an object whose
   inherited members an attacker chose.)
```

## Why REPRESENT rather than THROW, and why not `Object.defineProperty`

`Object.create(null)` accumulator. The accumulator then inherits no `__proto__` accessor, so `out[key] = value` is an ordinary data-property write for every key including `__proto__`, and `JSON.stringify` emits it. Canonicalization becomes total: distinct input, distinct output.

Not `Object.defineProperty` on a normal `{}`: that produces an object carrying `__proto__` as an own data property with `Object.prototype` still in its chain — a pollution gadget that would travel onward through the SDK to the CLI and the web app the first time anything `Object.assign`s it. A null-prototype object is not that gadget, and in any case the only value that escapes this module is a STRING; `canonicalizeDeep` is exported solely for the one caller that must embed the sorted form inside a larger literal it immediately stringifies.

Not THROW either, at this layer. Refusal belongs at the boundary — `apps/server`'s `util/safe-json.ts` rejects poisoned JSON at the two doors that admit foreign bytes (the HTTP body parser and the `.scpbundle` reader), which is where a refusal can become a 400 or a recorded file refusal.

THIS PARAGRAPH USED TO OVERSTATE ITS CASE, and the overstatement is corrected here rather than quietly deleted. It claimed that throwing from a fail-closed VERIFY path (`verifyJournalChain`, `restatesDecision`) "would convert a `valid: false` into an unhandled exception in the federation inbox loop". Measured: it would not. `verifySegment` (`apps/server`'s `federation/import-repo.ts`) ALREADY throws `conflict(...)` when verification fails, and `inbox-loop.ts` catches it — a 409 `ProblemError` becomes a structured `refuseFile` carrying its Decision, anything else falls to the `deferFile` arm, and one level up there is a containment catch for the genuinely unanticipated throw. So the real cost of throwing here is narrower than claimed: a tampered segment would be DEFERRED AND RETRIED every tick under an unstructured message, instead of REFUSED ONCE with a Decision an operator can read. Bad, and not the availability collapse the old sentence described.

THE DECISION STANDS ON A STRONGER ARGUMENT — the one that was actually measured. A boundary check cannot cover this module's inputs, because not all of them cross a boundary. `sync_journal.payload` and `decisions.input_context` are `jsonb` columns; content grafted straight into one of them by SQL — a compromised or buggy writer, a restored dump, an operator with a psql prompt — passes through NEITHER door by construction, and is read back and canonicalized as if it had. Only a TOTAL canonicalizer covers that input, and a canonicalizer that throws is not total. The integrity fix is that the canonical string covers everything; boundary rejection is defence in depth on top of totality, not a substitute for it.

## Compatibility guarantee

For every input containing no own `__proto__` key anywhere, the output is BYTE-IDENTICAL to the five implementations this replaces — including their quirks (a `Date` has no own enumerable keys, so it canonicalizes to `{}`; `undefined` at the top level yields `undefined`, not a string). That is not incidental: stored `row_hash`/`content_hash` values on live estates were computed with the old code and must keep verifying. `canonical-json.test.ts` pins it by running the verbatim old implementation side by side over a corpus.

### §53. Recursively key-sorted structural copy

Recursively key-sorted structural copy. Objects come back with a **null prototype** and may therefore carry an own `__proto__` key.

Prefer `canonicalJson`. This is exported only for `canonicalizeJournalEntry`, which needs the sorted PAYLOAD as a value inside a larger fixed-field-order literal that it stringifies in one go. Never spread, `Object.assign`, or otherwise merge the result into a normal object: doing so with an own `__proto__` key present is exactly the pollution step this module avoids.

### §54. Deterministic JSON serialization

Deterministic JSON serialization: recursively sorted object keys, total over its input.

Returns `undefined` (not the string `"undefined"`) for values `JSON.stringify` cannot represent at the top level — `undefined`, functions, symbols — matching both `JSON.stringify` and the five implementations this replaces. The `string` return type is the one the call sites have always declared; it is preserved rather than widened so this stays a drop-in.

## `packages/schemas/src/changes.ts`

### §55. M3 Change Coordination Engine wire contract

M3 Change Coordination Engine wire contract (DESIGN.md §9, §10.4, BUILD_AND_TEST.md §8 M3). The state machine's legal-edge DATA lives server-side (coordination/transitions.ts + drizzle/0007's `state_transitions` seed) — this file only carries the enum for wire validation.

### §56. WHO cancelled this change

WHO cancelled this change (migration 0053). `system` = the engine auto-cancelled it (today: a plan that would not compile); `user` = a human called cancel. NULL when the change is not cancelled, or was cancelled before this column existed — deliberately not backfilled, because inferring it from the old free-text reason would fabricate a fact.

Optional in the contract so a pre-0053 server's response still validates against this schema.

### §57. When this change's own row last CHANGED

When this change's own row last CHANGED — a transition, a `sourceRef` stamp, a park. It means what its name says, and it is safe to render as "last modified".

IT DID NOT ALWAYS. Until migration 0058 this column was also the reconcile engine's ROUND-ROBIN CURSOR: `listChangeRowsInStates` served oldest-first capped at a batch limit, and five paths re-stamped a change they had examined but could not advance, to send it to the back of the queue. Those re-stamps are load-bearing — without them, more than one batch's worth of stuck changes occupy every slot forever and everything behind them is never evaluated even once, measured in production as 13 days of fully stopped coordination behind green health checks. But sharing this field meant a change whose rollout had sat at the same canary weight for three days, polled once a second, reported `updatedAt` of one second ago. The scheduler was talking over the operator's only "last modified" signal, on exactly the changes an operator most needs to look at.

The cursor now has its own engine-owned column (`changes.reconcile_cursor_at`, beside `reconcileBlockedAt` and `stateEnteredAt`), and it is deliberately NOT on the wire. It is a queue position, not a fact about the change: a fresh cursor means the engine took this change's turn, which is true of every healthy change every few ticks and says nothing an operator can act on. Exposing it would re-create the misreading the split exists to end, one field over. `/v1` is additive-only, so adding it later stays possible if a real caller ever needs it; un-shipping it would not be.

**For "how long has this been stuck", the field is still `stateEnteredAt`** — the round-robin never touched it even when it shared this one, and the watchdog's stall SLA measures from it. `updatedAt` answers a different question ("has anything about this change moved"), which the split is what makes it able to answer honestly.

### §58. The underlying graph object's origin domain, additive

M16.3 P2 (additive) — the underlying graph object's `origin_domain_id` (`objects. origin_domain_id`, same field `GraphObjectSchema.originDomainId` carries for every other typed resource, and the SAME authoritative field `coordination/service-board.ts`'s `drivenHere`/`originDomainId` are already derived from — NOT `importedFromDomain` above, which is a narrower "which peer's promotion bundle did THIS import come through" stamp, set only on promotion-imported changes (federation/promotion-repo.ts), not the general single-writer-authority origin every object carries).

`originDomainId` was missing from the wire `Change` shape entirely before this — the ONLY SDK-reachable domain-identity field on a change was `importedFromDomain`, which is null for every plain (non-promotion-bundle) federation-synced change, so a UI could not tell "this change is a read-only replica of another domain's change" from "this change was authored here" without it. `federation.self()` (`GET /federation/self`) already gives a caller its OWN domain id; comparing the two is what `apps/web`'s `isForeignOriginObject` (`apps/web/src/lib/replica-origin.tsx`) uses to render the `ForeignOriginNotice` provenance badge on `change-detail.tsx`. It is deliberately NOT used there to disable Accept/Rollback/ Cancel: `apps/server/src/federation/foreign-origin-writes.integration.test.ts` measured the transition verbs answering a foreign-origin change identically to a local one in the same state (never a single-writer refusal, in `proposed` or in `validating`), so a client-side gate on this field would be simulating server enforcement that does not exist.

Optional (not `.nullable()`) so it defaults to `undefined` — matching every other additive `/v1` field (CLAUDE.md: "every new field must be OPTIONAL") — rather than forcing every existing caller that builds a `Change`-shaped object by hand (tests, fixtures) to supply it.

### §59. Mirrors the graph object's locality flag

M20-A3 (ADR-0031 §5) — mirrors `GraphObjectSchema.domainLocal`: `true` when this change's own existence stays inside its own security domain (INHERITED from its targets at `proposeChange`, never declared on the change itself — a change has no create-time locality checkbox of its own). Gates every journal writer this change touches (`change_status`, the underlying object's `object_upsert`), so a domain-local change never reaches a peer to be asked about.

REQUIRED, not optional, following `GraphObjectSchema.domainLocal`'s exact precedent: a boundary predicate has no unknown case, and every change row this instance can return already has this computed at propose time — there is no legacy row lacking it the way `originDomainId` had to accommodate.

What it is FOR on the wire: disambiguating an absent `boundarySegment` (M16.1) — "no boundary segment" is genuinely ambiguous between "domain-local, so there is nothing to cross" and "ordinary change, just not promoted yet" without it. `change-detail.tsx`/`change-pipeline.tsx` read it to render the same `DomainLocalBadge` objects already carry, and to branch the `NoBoundarySegment` copy onto the honest reason instead of the generic one.

### §60. `POST /changes` ("propose")

`POST /changes` ("propose") — `targets` (>=1 idOrUrn) is the set of graph objects (usually components/services/deployment-targets) this change acts on; the plan compiler (coordination/plan-compiler.ts) derives wave order from their `depends_on` edges plus the optional `topology`'s explicit wave groups.

### §61. Stage-scoped component couplings (ADR-0028)

Stage-scoped component couplings (ADR-0028): components this release's component must not deploy AHEAD OF at a shared place. Each entry's `dependsOn` and `atTargets` are ids or URNs resolved at propose time (a bad ref is a 404, never a silent forever-wait) and stored resolved in `properties.stageDependencies`. Omitted/empty ⇒ nothing holds this release's triggers.

`.optional()` and NOT `.default([])`: a Zod default renders the property REQUIRED in the generated SDK type, which oasdiff scores as a /v1 break.

### §62. Exact-match filter on `kind` (ADR-0028 increment 4)

Exact-match filter on `kind` (ADR-0028 increment 4) — `stage_dependency`, `watchdog`, `gate`, … Additive optional query parameter: an old client omits it and gets the unfiltered page it always got.

IT ANSWERS "which mechanism", NOT "what happened": several kinds carry more than one verdict against the same subject. `stage_dependency` in particular is written both as a `hold` (a trigger withheld — `reconcile.ts`) and as an `allow` (the declaration stripped on promotion import — `federation/promotion-repo.ts`), so on an outpost the newest row of that kind is an `allow` for a change that may well be held. Read the `verdict` on each row; a kind alone is not a state.

Usable WITHOUT `subjectId` on purpose — that is the whole point, the operator asking about a coupling does not have the change id — and drizzle/0056's `decisions_org_kind_created` is what makes that shape an index probe instead of the parallel seq scan it measured as.

### §63. THE OBSERVED-STATE SHAPE

THE OBSERVED-STATE SHAPE (ADR-0008 decisions 1-2, M23.1f/g), extracted so a second read site can carry the identical snapshot without re-declaring its honesty rules verbatim. `ChangeWaveTargetSchema` below is still the shape's home for documentation purposes — read the field-level comments there. `ComponentPipelineCurrentSchema` (components.ts) is the other reader, added for the pipeline view's per-stage version (component-pipeline.ts's `currentsByPlacement`).

### §64. What the persistence bound removed, keyed by field

WHAT THE PERSISTENCE BOUND REMOVED, KEYED BY THE FIELD IT HAPPENED TO — M23.1g, and the reason `revision`/`images`/`rollout` above are readable at all rather than merely present.

ABSENT MEANS NOTHING WAS REMOVED. That is every honest reading and it is the only thing a consumer has to check: an entry exists only for a field that lost something.

`dropped: true` IS THE WHOLE POINT. A field the bound refused outright is simply not in `observed`, byte-identical to a field the executor never reported — so a UI that renders `observed.rollout ?? "no rollout"` states a cause that is FALSE, blaming the executor for a cut this platform made. Same class as the `no_weight` reason ADR-0028's gate reported (charter principle 6). Read this before you render an absence.

A CONSUMER MUST NOT PATTERN-MATCH THE STORED VALUE INSTEAD. The bound's markers (`__scpElided`, `[elided: N more entries]`) are content-shaped — a plugin can put those exact characters in a revision, and one of the bound's branches emits no marker at all — and they live in `@scp/runner-launcher`, which the UI does not and must not depend on. This field is the API's answer, which is what makes it API-first (charter principle 3).

ADDITIVE-OPTIONAL: rows written before M23.1g carry no key, which reads as "nothing was removed". That is not backfilled and cannot be — the removed content is gone. The key `__scpElided` can appear here when the report itself was too wide to list every field; its `droppedFields` is how many were not listed.

### §65. The `ExternalRunRef` the executor's `trigger()` returned

The `ExternalRunRef` the executor's `trigger()` returned — plugin-shaped, opaque to SCP, and the handle `status()` is polled with.

BOUNDED, NOT VERBATIM (M23.1f), and unlike `observed` below it carries NO structured truncation signal — recorded here rather than left to be discovered. The reason is that the reader of this field is the PLUGIN, not an operator: a cut here is a broken handle, not a wrong thing on a screen, and the honest fix for that is refusing the write rather than describing the damage. See the note at `markWaveTargetTriggered` in `wave-targets-repo.ts` and M23.1g in BUILD_AND_TEST.md, where it is carried as still open.

### §66. The snapshot reconcile observed from status()

The snapshot reconcile observed from status() — the per-wave version (ADR-0008 decisions 1-2). Additive-optional: plans predating the `observed_state` column read back without it; `null` once observed with nothing.

`revision` is the executor's stateRef (a git SHA / Argo revision), opaque to SCP — but NOT necessarily as-is, which is what this comment claimed until M23.1g and what M23.1f made false. Every string here passes a persistence bound before it becomes a row, so it may be SHORTENED (an elision marker mid-value) and the two code points `jsonb` refuses — U+0000 and lone surrogates — are replaced one-for-one by U+FFFD. `truncation` below says which fields that happened to; nothing else here does.

`images` (P4C increment 3) is the deployed image refs (tag/digest, e.g. `ghcr.io/x/y:1.2.3` or `...@sha256:...`) — the human-facing per-wave version, preferred over the git SHA in the UI. It is a PREFIX of what the executor reported when `truncation.images` is present. `rollout` (P4D increment 4) is the OBSERVE-ONLY progressive-delivery snapshot (an Argo Rollout's phase/step/weight/message as the executor reports it) — display-only; SCP never drives it (ADR-0008: rollout state is OBSERVED, NOT DRIVEN). Every field is optional (only phase/message are reliably available; step/weight need the live manifest and are version-dependent).

### §67. THE WAVE-TARGET FREEZE-HOLD PROJECTION

THE WAVE-TARGET FREEZE-HOLD PROJECTION (M25.UI, ADR-0039:173, campaigns-rework.md's closing "wave-target hold projection" section, fixed by reading `PipelineWaveCard` rather than from memory — see that doc for the four properties this shape satisfies).

ADDITIVE-OPTIONAL AND COMPOSED AT READ TIME, never persisted: the `freeze_admission` Decision has no clearing counterpart (`freeze-hold.ts`'s own module doc), so a hold field fed from that row would still say "held" long after a lift — the exact permanent-marker trap ADR-0028's stage-dependency status module states at length and this field must not reproduce. Present ONLY while the target is genuinely held; a lifted freeze is simply absent on the next read.

CARRIES THE COVERING FREEZES THEMSELVES, NEVER A BOOLEAN (property 1) — a `frozen: true` flag would force the client to join back to something to say anything useful. Each entry's `summary` is a SERVER-COMPOSED sentence (property 2, charter principle 6 — the UI composes no copy from raw fields), the same idiom `describeStageDependencyHold` already uses for the stage-dependency hold. `scope` is enriched to `{objectId, name}` server-side (property 3) — `null` means instance-wide/platform-tier, which has no object id in any org's containment chain. `endsAt` is carried and `now` is never (property 4) — the client's own clock contextualizes it, and pushing `now` into a read response is exactly what produced ADR-0024's measured 1.44 GB/day when it was done to a WRITE path instead.

THE RAW `status` STAYS BESIDE THIS FIELD, UNCHANGED. A held target's `status` is still `pending` — `hold` explains that status, it does not replace it (same rule ADR-0028's stage-dependency hold follows on this same schema).

`continuousTests` — THE SECOND HALF (team-pipeline-iac increment 8, D21)
ADDITIVE-OPTIONAL BESIDE `freezes`, never in place of it: a target can be held by a freeze, by a stale/failed/never-reported `continuous` probe, or by both at once, and collapsing the two into one array would lose which authority an operator has to go and talk to. `freezes` STAYS REQUIRED on this object and is `[]` for a target held only by a probe — making it optional would be a breaking weakening of a shipped response field, which is not a trade this repo makes.

COMPOSED AT READ TIME, NEVER PERSISTED, for exactly the reason stated above for `freezes` and restated on `ContinuousTestHoldSchema` itself: the `continuous_test` Decision has no clearing counterpart, so a field fed from that row would still say "held" long after fresh green landed. `plan-service.ts` re-runs `evaluateContinuousHolds` — the SAME predicate `reconcile.ts`'s per-target loop refuses on — on every read. Present ONLY while the target is genuinely held; absent on the next read once a fresh pass arrives.

`now` NEVER CROSSES THIS SEAM (property 4, again): each entry carries `staleAfter` and `lastReportedAt` as DATA that the client's own clock contextualizes, and `summary` is a server-composed sentence naming the boundary rather than a relative time.

### §68. SERVER-COMPUTED COUNT of this wave's currently-held targets

SERVER-COMPUTED COUNT of this wave's currently-held targets — freeze-held (`targets[].hold`) plus stage-dependency-held (ADR-0028, carried separately via `ChangeExplainResponse.stageDependencyStatus` for the reason given on that field). ADDITIVE- OPTIONAL for oasdiff, and emitted ONLY for the wave admission currently governs (the active wave — the one wave the freeze evaluation ever looks at). Absent means "not evaluated" (a future wave's targets may sit under a standing freeze that will hold them at their turn — a zero there would be fabricated), never "zero by omission"; `0` means evaluated with nothing held. Clients must never recompute this from `targets[].hold` — a caller with no `stageDependencyStatus` in hand (e.g. `service-board.ts`) would undercount it.

### §69. `GET /changes/{id}:explain` — the change, its compiled plan

`GET /changes/{id}:explain` — the change, its compiled plan (if any), every Decision made about it, and every control run evidence persisted against it (DESIGN §10.4: a Decision's reasonTree names WHICH control fired and what its outcome status was — `contributingPolicyVersions` and each `requireControls` effect's `detail.controlObjectId`/`detail.outcome` — but the actual EVIDENCE payload only ever lives on `control_runs`; M4 adds this array so `scp change explain` can reconstruct "policy version + control outcome + evidence" end to end, not just the first two).

### §70. M12 P4B fail-closed (coupled-pipelines.md §6#14)

M12 P4B fail-closed (coupled-pipelines.md §6#14): stored `requires` entries that do NOT parse as `{key, at}` (federation peer skew, a legacy row, or raw-SQL corruption — propose-time typed validation refuses them, so they can only arrive PAST the API). A change carrying any is UNSATISFIABLE: it parks in `waiting` (the watchdog SLA flags it) rather than proceeding as if uncoupled, and the offending entries are surfaced here verbatim so an operator can see exactly what to fix. `.optional()` not `.default()` — additive, absent for every well-formed change.

### §71. ADR-0028 increment 4 — THE STAGE-DEPENDENCY WAIT STATUS

ADR-0028 increment 4 — THE STAGE-DEPENDENCY WAIT STATUS.

The `requires` wait status above and this one are DIFFERENT COUPLINGS and deliberately do not share a shape. `requires` is keyed on `{key, at}` and parks the WHOLE change in `waiting`; a stage dependency is keyed on (component x deployment-target) and withholds ONE wave target's trigger while the change stays `executing`. Widening `ChangeWaitStatusSchema` to carry both would have made `requirements[]` mean two things for its two existing consumers (the CLI's `printWaitStatusBody` and the web change-pipeline view), so this is a sibling field instead.

READ LIVE, NEVER OFF THE PINNED DECISION (coupled-pipelines.md §3.6, and the reason `resolveWaitStatus` exists at all). `recordStageDependencyHold` writes a `hold` Decision and NOTHING ever writes a clearing row, so the newest `stage_dependency` row of a change that was briefly held, triggered, succeeded and reached `accepted` is still a `hold` — answering "is this held?" from that row would rebuild, on a read surface, precisely the permanent-marker bug the `hold` verdict was chosen to avoid. Every field below is re-derived at request time by `evaluateStageDependencies`, the same predicate reconcile runs.

### §72. Which branch of ADR-0028 decision 4 produced a verdict

Which branch of ADR-0028 decision 4 produced a verdict — mirrors `StageDependencyBranch` (`coordination/stage-dependency-hold.ts`), whose doc comment defines each one. Three satisfy (`not_placed`/`succeeded`/`min_weight`), three hold (`never_deployed`/`behind`/ `weight_unreadable`), `undeclarable` holds an unparseable stored entry, and `unscopeable`/`self` record a coupling that had nothing to scope by / named its own declarer.

### §73. M16.1 — THE UNIVERSAL BOUNDARY SEGMENT

M16.1 — THE UNIVERSAL BOUNDARY SEGMENT (ADR-0011; ADR-0021 D6 vocabulary).

A boundary SEGMENT of the component pipeline, composed of two boundary PHASES — *transferred* and *validated*. NOT a "stage" (a stage is a deployment PLACE, `<domain>[-<location>]-<env>`) and NOT a "wave" (a wave is the set of stages advanced at once). The segment renders REAL local observations plus an explicit not-yet-verified/not-reported state, NEVER a fabricated pass, and it DRIVES NOTHING (coordinate-not-execute — this is Layer-B observe-enrichment, ADR-0008, applied to the federation boundary rather than to an executor).

### §74. drizzle/0087 — WHICH LEG this hop was

drizzle/0087 — WHICH LEG this hop was: `'metadata'` (an ordinary `.scpbundle` sync/promotion export or import) or `'bytes'` (a retrans byte-relay hop). Threaded straight from the `bundle_transfers` row's own `channel` column (`coordination/boundary-segment.ts`) — this is what finally lets a UI tell a retrans's byte-relay hop apart from an ordinary metadata promotion transfer of the same `kind`/`direction`/`status`. Optional/additive; `null` = not recorded (pre-0087 row, or a writer that genuinely could not determine it).

### §75. The TRANSFERRED phase. `exported`

The TRANSFERRED phase.

`exported` — this instance produced a promotion bundle for this change. It is the ONLY transfer statement an exporting instance can truthfully make: `bundle_transfers` has no UPDATE anywhere in the tree, and every `submitted`/`confirmed` row is written by a LATER hop's own database. So an exporting instance's row is and stays `created`, and whether the peer ever received the bundle is UNOBSERVABLE here — declared in `unknownFields` as `transfer.handoff`, never rendered as a delivered/confirmed handoff.

`received` — this instance imported and applied a promotion bundle for this change (a genuine local observation: the row is written in the same tx as the import).

`not_observed` — no ledger row here names any bundle that carried this change.

### §76. The VALIDATED phase

The VALIDATED phase — the signature + scan-attestation verify at the RECEIVING outpost (ADR-0011: universal, commercial included), read from the M17.4(b) pre-deploy artifact-verify Decision this instance persisted.

`verified`   — an `allow` Decision of kind `pre-deploy-artifact-verify` exists HERE: a real per-artifact cosign verification ran locally and every authorized artifact was present and authentic. (Only recordable since M16.1 I2 — a passing verify used to write nothing at all.) `refused`    — a `block` Decision exists here; `decisionId` carries the "why" (principle 6). `not_yet_verified` — this instance RECEIVED the change and its verify has not produced a verdict yet (or had nothing to verify — a metadata-only promotion deliberately records no verdict rather than a vacuous pass). An honest absence, not a failure. `not_reported` — this instance is NOT the receiving side. Validation happens at the receiving outpost and there is NO data path carrying its outcome back: federation journal entry kinds are lifecycle/graph-shaped, none is verification-shaped, and audit segments are discarded on import. The exporting instance therefore says exactly that, and `unknownFields` names `validate.state`. It is never `verified` here.

### §77. How many artifacts the verdict's AUTHORIZED SET held

How many artifacts the verdict's AUTHORIZED SET held — the set the gate was asked to check, read off the Decision's `inputContext.authorizedArtifacts`. Deliberately NOT named "verified": on a `refused` verdict the authorized set still has entries and some or all of them are precisely the ones that FAILED, so a "verified" count there would report unverified artifacts as verified — the exact claim class this segment exists to prevent, on the API, which is the parity surface (charter principle 3).

`null` when there is no verdict at all, AND on `refused`: a refusal's honest artifact story is the block Decision's `failing` list, not a bare number that reads as progress. So a non-null value here occurs only alongside `state: "verified"`, where authorized == verified by construction (the gate returns `ok` only when every authorized artifact passed). `null` — never 0 — is also what a malformed/absent `inputContext` yields, so a client can distinguish "no count available" from "a verdict over zero artifacts".

### §78. The stage-dependency status, re-evaluated live on read

ADR-0028 increment 4 — the stage-dependency status, re-evaluated LIVE on this request. `null` for a change that coupled nothing. `.nullable().optional()` following `boundarySegment`'s precedent below: additive within /v1, so a pre-increment-4 SDK reading a new response is unaffected and an old server's response is still valid here. Never `.default()` — a default renders the property REQUIRED in the generated SDK type, which is an oasdiff ERR.

### §79. The operator's PAUSE SWITCH

The operator's PAUSE SWITCH (migration 0063, owner ask 2026-08-14). Unlike `mirrorOfShared` above, this IS an enforcement input: `false` means the mapping stays declared but `matchComponentForSource` (coordination/correlation.ts) skips it — a push that would otherwise match this row routes to nothing. `true` for every pre-0063 row (the default), which was already routing.

### §80. The operator's DECLARED reach of this repo

The operator's DECLARED reach of this repo (pipeline-substrate-registry-scan.md §10.6, migration 0066): `global` = a cross-domain shared repo authored and tracked at the commander; `domain` = tracked only in this domain; `null` = NOT DECLARED — the pipeline renders no provenance label and infers nothing (a pre-0066 row on the commander is not thereby global). Orthogonal to `mirrorOfShared` (a `domain`-scope mapping may mirror a global one). Read, never inferred; UI/reporting/IaC only, never an enforcement input — the correlation matcher does not read it. Required-nullable like `mirrorOfShared`/`disabledUntil` beside it (a new REQUIRED response property is additive within /v1).

### §81. `DELETE /change-sources/{sourceKind}/mappings` body

`DELETE /change-sources/{sourceKind}/mappings` body — the full IDENTITY TUPLE, not an id.

`source_mappings` has no unique constraint and `POST /discovery/accept` inserts unconditionally, so an estate can hold several byte-identical rows (the homelab does). A by-id delete would remove one and leave the survivor still correlating — the operator would see the mapping "deleted" and a push would still route to it. Matching the tuple removes every row that says the same thing, which is the same reasoning `deleteSourceMappingsMatching` was written with for IaC prune.

`repoPattern`/`pathPattern` are NULLABLE rather than optional: a NULL pattern is meaningful (it means "match any"), so absent and null must be distinguishable — omitting one would otherwise silently target a different row than the caller sees in the list.

`refPattern` (ADR-0030 §1) JOINS THE TUPLE, and it had to: it is a routing discriminator, so two mappings may now differ ONLY by it — `refs/heads/dev` → the dev pipeline and `refs/heads/main` → the production one, same component, same repo, same path, same Type. A tuple that ignored the ref would match BOTH and delete the production route along with the dev one, silently, reporting a `deleted` count the operator would read as success.

It is `.nullable().optional()` rather than plain `.nullable()` — the ONE asymmetry in this tuple — because making it required would break every existing caller's request shape. **An ABSENT `refPattern` is treated as NULL, not as a wildcard**, which is the fail-closed reading: a legacy caller that omits it deletes only ref-agnostic rows and never reaches a ref-scoped one. It can therefore UNDER-delete (visible immediately — `deleted` reports 0, which this response exists to surface) but never OVER-delete a route nobody asked to remove.

### §82. `PATCH /change-sources/{sourceKind}/mappings/{id}` params

`PATCH /change-sources/{sourceKind}/mappings/{id}` params — the one mapping route addressed by id rather than the identity tuple, because unlike delete/create this is a genuine UPDATE of one specific row (migration 0063): flipping `enabled` on a mapping must never also flip its byte-identical sibling.

### §83. `PATCH /change-sources/{sourceKind}/mappings/{id}` body

`PATCH /change-sources/{sourceKind}/mappings/{id}` body — the pause switch (migration 0063). Deliberately not a general "patch a mapping" shape: every other column here is part of the identity tuple (`ManifestSourceMappingSchema`) or, like `mirrorOfShared`/`classification`, a create-time declaration with no update path. `scope` (§10.6) is the one other mutable label and has its OWN sibling PATCH below rather than a field here — `enabled` is REQUIRED in this body, so a caller that only wants to label a mapping would have to restate the pause state to do it (and could clobber a concurrent toggle); a route named `setSourceMappingEnabled` that also sets scope would be a name that lies. Additive either way; the sibling keeps this contract byte-identical.

### §84. `PATCH /change-sources/{sourceKind}/mappings/{id}/scope` body

`PATCH /change-sources/{sourceKind}/mappings/{id}/scope` body (§10.6) — set or clear the declared scope of ONE mapping, by id (same addressing as the pause switch, for the same reason: a genuine in-place update of one row must never touch its byte-identical siblings). `null` clears the declaration (back to "not declared" — no label). Required, not optional: an omitted field would make "clear it" and "I forgot the body" indistinguishable.

### §85. `POST /change-sources/{sourceKind}/webhook` body

`POST /change-sources/{sourceKind}/webhook` body — a source-specific payload, kept verbatim (`change_source_events.payload`, DESIGN §8 persist-then-process). M3 ships no per-provider payload parsing (that's M7's real executor plugins); `coordination/webhook-processor.ts` reads only the small, documented, provider-agnostic correlation hint (`repo`/`path`/ `correlationKey`) this schema's shape anticipates, but accepts (and persists) any JSON object.

### §86. The webhook-secret write route for a source kind

`PUT /change-sources/{sourceKind}/webhook-secret` (M7, DESIGN §12/BUILD_AND_TEST.md §8 M7) — configures the HMAC signing secret `routes/change-sources.ts`'s webhook route requires and verifies against once set (coordination/webhook-signature.ts). The plaintext secret is write-only from the API's perspective: it is encrypted at rest immediately (secrets/crypto.ts) and never echoed back by any endpoint.

## `packages/schemas/src/common.ts`

### §87. RFC 9457 (application/problem+json) error body

RFC 9457 (application/problem+json) error body — DESIGN.md §6. Every policy/gate-blocked 4xx also carries `decision_id`; that field is unused before the Governance Engine (M4) but reserved here so the contract never needs a breaking change.

### §88. A query-string array parameter

A query-string array parameter (e.g. `?relTypes=a&relTypes=b`). Most Node querystring parsers (including Fastify's default) only produce a real array when the key repeats 2+ times — a single `?relTypes=a` parses as the bare string `"a"`, which `z.array(z.string())` alone would reject. This normalizes both shapes before validating.

### §89. One STAGE-SCOPED component coupling

One STAGE-SCOPED component coupling (ADR-0028, docs/proposals/rollout-step-coupling.md §2.3): a component this release's component must not deploy AHEAD OF, at any place the two share.

Distinct from `ChangeRequirementSchema` above, and deliberately not an extension of it. `requires` is CROSS-CHANGE and WHOLE-CHANGE: it parks the entire change in `waiting` until some other change reaches `validating`/`accepted` — i.e. the prerequisite is finished EVERYWHERE. A stage dependency is per (component × stage): it holds A's TRIGGER at one deployment target while letting A proceed at every other one, which is the whole point of the ask (proposal §3.1 records why the shipped `waiting` engine is the wrong grain and is left untouched).

Lives here beside `ChangeRequirementSchema` and for the same reason: both `CreateChangeRequestSchema` (changes.ts) and `ChangeReportRequestSchema` (executors.ts) reuse the EXACT same shape, and changes.ts already imports executors.ts, so a shape declared in either would be an import cycle.

### §90. Optional: satisfied once the observed canary weight is

Optional qualifier: satisfied once the dependency's OBSERVED canary weight at the stage reaches this percentage, instead of requiring its stage deploy to finish. This is what lets a release proceed while its dependency sits at a partial rollout. BEST-EFFORT by construction — weight is observable only for an ArgoCD canary (a blue/green Rollout populates no `status.canary` at all), so an unreadable weight degrades the dependency to the universal "the dependency's wave target at this stage succeeded" test, never to "satisfied" (ADR-0028 decision 4).

`weight` and not `step`: `currentStepIndex` indexes that Rollout's OWN step list, so it is meaningless across two components; percentages compare.

### §91. Optional: restrict the coupling to certain places

Optional: restrict the coupling to certain places, by DEPLOYMENT-TARGET id or URN. Absent means every stage the two components share.

Deliberately not a stage-NAME glob: a stage name is derived on a UI read path and is `null` outright for a replicated deployment target, so a name glob would silently match nothing at exactly the federation boundary where the coupling matters. A URN resolves; a derived display name does not.

## `packages/schemas/src/components.ts`

### §92. WHO MAINTAINS A PLACE

WHO MAINTAINS A PLACE — the federation domain that owns the deployment-target, and therefore the execution that happens there.

The commander gives the go-ahead; the OUTPOST still runs and maintains its own targets (owner, 2026-08-04). That is not a UI nicety, it is the ownership split the platform is built on: ADR-0017 devolves build execution to the originating outpost and leaves the commander owning only the cross-boundary gate, and ADR-0011 has the receiving outpost validate every deploy inside its own domain. A pipeline view that shows a stage without saying whose domain it is in invites the reading that the commander deploys it — which is the one thing charter principle 1 says it does not do.

Derived from the target's OWN `origin_domain_id` matched against `federation_self` and `federation_peers` — never from this instance's identity, for the same reason ADR-0026 D1 derives a stage NAME from the target's origin: a replicated target must read the same at the commander and at the outpost.

### §93. Which outpost a target is part of, by trust domain

WHICH OUTPOST A TARGET IS PART OF (pipeline-substrate-registry-scan.md §10.2 — the owner's TRUST-DOMAIN RULE; §10.5 — every target is within an outpost, the HQ outpost (formerly 'co-located'; GLOSSARY, ADR-0021 D7)), resolved by the server and READ by the client, never inferred.

The rule: an `outpost` object carries `properties.peerDomainId` — a paired peer's federation identity, i.e. its trust domain, OR (§10.5) this instance's OWN trust domain, the HQ outpost (`outpost-binding.ts` refuses anything else); every object carries `originDomainId` — the trust domain that authored it; ADR-0017 §1 puts one outpost deployment per trust domain. So a target's outpost is THE `outpost` OBJECT WHOSE `peerDomainId` EQUALS THE TARGET'S `originDomainId`. No new data. Never derived from the target's name, and never from its containment `domain_id` (GLOSSARY: containment has nothing to do with deployment topology).

Five states, each STATED — the identity fields are nullable per state, and a client renders the state it is given rather than guessing from which fields happen to be null. PRECEDENCE (§10.5, OBJECT-FIRST — this supersedes §10.2's self-first sentence): an `outpost` object naming the target's origin domain wins WHETHER OR NOT that domain is self; then `self` (only when NO object names this instance's domain); then the peer lookup. So on an outpost site its own targets read `outpost <its own name> · <tier>` off its replica of its own config, and on a commander with a HQ outpost registered its own targets read that outpost — `self` is the stated absence of one. - `outpost`               — an `outpost` object names the target's origin domain (a paired peer's, or this instance's own — §10.5). `id`/`name` are that object's; `trustTier` its declared tier (null when the object declares none, or one this build does not know — `outposts-repo.ts`'s `readTrustTier`, never defaulted); `peerDomainId` the domain it names (the link target on the commander site, `/federation/outposts/$peerDomainId`, which renders the HQ record too); `peerRole` the peer row's role, or this instance's `federation_self.role` when the domain is self. - `self`                  — the target's origin IS this instance (`federation_self`) and NO `outpost` object names this instance's domain. `name` is this instance's federation name; the rest null. A stated absence: "this instance's domain — no outpost registered" (one can be declared under Federation › Outposts with `peerDomainId` = this instance's domain id). - `peer-without-outpost`  — the origin is a paired peer of role `outpost` with NO `outpost` object registered. `name` is the PEER's name and `peerDomainId` its id, so a client can say who — and, because the peer's role IS `outpost`, that an outpost record CAN be declared for it (POST /federation/outposts accepts only `outpost`-role peers — `outpost-binding.ts`). - `peer-not-outpost`      — the origin is a paired peer whose role is NOT `outpost` (`commander` or `retrans`). This is what EVERY commander-authored (replicated) target reads on an outpost site. `name` is the peer's name, `peerDomainId` its id, `peerRole` its role. No outpost record can be declared for it — the API refuses (400) — so a client must NOT offer that fix; it says `commander <name>` / `relay <name>`. - `unknown-domain`        — the origin names no peer known here (a replica whose peer row has not arrived; a foreign origin this instance never paired with). `peerDomainId` carries the raw origin id; the rest null. Not "ours".

### §94. The paired peer's federation ROLE

The paired peer's federation ROLE (`commander` / `outpost` / `retrans`), READ off its peer row, for the three peer states — the word a client uses for `peer-not-outpost` (`commander …` / `relay …`). For an `outpost` object naming THIS instance's own domain (§10.5) it is `federation_self.role`. Null for `self` and `unknown-domain`, and for an `outpost` object whose `peerDomainId` names neither self nor a peer row held here.

### §95. WHERE the ladder found it (ADR-0027/0029)

WHERE the ladder found it (ADR-0027/0029): "placement" when bound on the stage's own placement, else the ancestor's `object_types.id` verbatim ("component", "assembly", "service", "organization"). READ from the resolver's own provenance, never inferred (resolution-provenance.test.ts is the cautionary tale). Optional: absent on responses emitted before this field existed.

### §96. The same observed-state snapshot the wave target carries

THE SAME `change_wave_targets.observed_state` SNAPSHOT `ChangeWaveTargetSchema.observed` documents — read here from the identical column, per pipeline, so the stage's `version` below can be derived rather than hardcoded (increment "per-stage version threading"). ADDITIVE-OPTIONAL: absent on responses emitted before this field existed; `null` means the column itself was `null` (nothing observed yet), never fabricated.

### §97. THE SHARED VERSION-PREFERENCE RULE

THE SHARED VERSION-PREFERENCE RULE (ADR-0008 signal 1) — extracted so the server's stage `version` derivation (`component-pipeline.ts`) and the web's per-target render (`PipelineWaveCard.tsx`) cannot silently diverge on which observed field wins. Mirrors `PipelineWaveCard.tsx`'s `realImages`/version-slot rules exactly: prefer the first REAL (non-marker) deployed image over the git-style `revision`, because an image tag/digest is a better human-facing version than an opaque SHA (decision 1). Returns `undefined` — never `""` or `null` — when neither is observed, so a caller's own "unknown" handling stays a single `if`.

`realImages` strips the persistence bound's marker slot using the record's own `droppedEntries` COUNT, never by pattern-matching the stored value (M23.1g, the same rule `PipelineWaveCard.tsx` documents at length) — a cut that removed every real entry leaves the array holding the marker alone, and this must return `[]` for that case, not the marker string.

### §98. Where a component's releases come from: one mapping rule

WHERE A COMPONENT'S RELEASES COME FROM — one `source_mappings` rule: a push matching this repo (and path, if any) becomes a release of this component, of this Type.

This is the head of the journey, and the owner's question that prompted it was literal: *"agentkit-bootstrap comes from a repo right? When someone makes a change there, it should affect this right?"* The rule is durable state, so it answers that WITHOUT waiting for a push to prove it.

It carries the same `type`/`category` as a binding, so a mapping belongs to the same lane as the pipeline it feeds: an `infrastructure` mapping heads the infra pipeline, an `image` or `configuration` one heads the software pipeline.

### §99. DECLARED reach (§10.6, migration 0066)

DECLARED reach (§10.6, migration 0066): `global` → the tile's eyebrow reads "GLOBAL — shared across domains"; `domain` → "DOMAIN-SPECIFIC — tracked only here"; `null` (not declared) → NO eyebrow, nothing inferred. `mirrorOfShared` wins the eyebrow when both are set. Read, never inferred; never an enforcement input. Required-nullable like `mirrorOfShared`/`disabledUntil` (a new REQUIRED response property is additive within /v1).

### §100. WHAT MUST PASS BEFORE A RELEASE MOVES INTO A STAGE

WHAT MUST PASS BEFORE A RELEASE MOVES INTO A STAGE — the gate, as durable configuration.

Resolved from the `policy` objects matching this placement's containment chain (DESIGN §10.1, `policy-resolve.ts` + `policy-model.ts`'s stricter-wins merge) — the SAME resolution the wave-boundary gate runs, so this view cannot disagree with the engine about what is required.

It is a REQUIREMENT, not a verdict. A verdict exists only for a change in flight and carries a `decision_id`; this is what would be required of any release, which is exactly what a durable pipeline view can honestly state for a component with nothing releasing.

Measured on the live estate, and the reason this ships: 12 `prod-gate` policies each require ONE Owner approval before prod, and **282 approval requests are pending** against them. None of that appeared anywhere in this view — a release stopping at a gate looked identical to one nobody had started.

### §101. One automated check a policy requires, and its progress

ONE AUTOMATED CHECK a policy requires at this stage, with where it has got to.

`status` deliberately separates two absences that look identical in a naive rendering: `not_started` — nothing is at this gate, so there is nothing for the check to run against; `pending`     — a release IS here and this check has produced no outcome yet. The rest are `control_runs.status` verbatim (pass | fail | warning | skipped | timed_out | expired) — SCP does not invent an outcome, it reports the one the control recorded.

`changeId` is the release the status is AS OF, so "passed" can never be read as a standing property of the stage. Null exactly when `status` is `not_started`.

### §102. WHY A RELEASE IS SITTING AT THIS STAGE WITHOUT MOVING

WHY A RELEASE IS SITTING AT THIS STAGE WITHOUT MOVING — a stage-scoped component coupling (ADR-0028) is withholding its trigger, and this names what by.

THE BUG IT REMOVES. A held wave target's `change_wave_targets.status` is and stays `pending`: the hold `continue`s BEFORE `triggerWaveTarget`, so nothing advances it and nothing marks it. On this view that rendered as the same amber `pending` a stage gets when the wave simply has not reached it yet — so "waiting on something named" and "nothing is happening here" were the same picture, which is the confusion ADR-0028 increment 4 exists to remove.

PRESENT EXACTLY WHEN A TRIGGER IS BEING WITHHELD RIGHT NOW, and null otherwise — including for a change that declared a coupling which is now satisfied. It is RE-EVALUATED LIVE on every request by `resolveStageDependencyStatus`, never read off the persisted `stage_dependency` Decision: nothing anywhere writes a clearing row, so that Decision stays `hold` forever — through the trigger, through `accepted` — and a badge sourced from it would be the permanent-marker bug the `hold` verdict (rather than `block`) was chosen to avoid, rebuilt on a read surface. The kind is overloaded too: `applyPromotionImport` writes `stage_dependency`/`allow` for the import-time strip, so on an outpost the newest row of that kind is an `allow` whatever the change is doing.

WHOSE HOLD IT IS. Keyed on the wave target, which in stage mode IS the placement — so this is the hold on THIS stage, not the change's hold anywhere. A change held at gamma and free at prod carries this on its gamma stage alone.

NOT IN `unknownFields` WHEN NULL, deliberately, and the one case that argues otherwise was checked: on an OUTPOST an imported change has had its `stageDependencies` stripped (`applyPromotionImport`), so the resolver has nothing to evaluate and this is null. That is not an unknown — the commander already withheld the trigger until every dependency was satisfied there, and its promotion of the bundle IS the go-ahead, so locally there genuinely is no hold. Null here always means "no stage dependency is withholding this stage's release", never "we did not look".

### §103. ONE STAGE THE COMPONENT IS PLACED AT — one `placement`

ONE STAGE THE COMPONENT IS PLACED AT — one `placement` (ADR-0026): this component at one deployment-target.

A stage exists because the component IS PLACED there, not because something is releasing. That is the correction this view was built for: the previous pipeline surface was keyed on a change, so a component with nothing in flight had no pipeline at all.

It is NOT the whole pipeline. The stages a component's releases are DECLARED to pass through come from the release topology, and the ones it is not placed at are `unplacedStages` on the response — see the note there for why the journey is split across two arrays rather than one.

### §104. THE SUBSTRATE FACET

THE SUBSTRATE FACET (pipeline-substrate-registry-scan.md §9.1) — what the target physically IS, read verbatim from the target's own `properties` (migration 0065 types them as optional strings; a non-string is read as absent). Well-known `substrate` values are GLOSSARY vocabulary (`aws|gcp|azure|kubernetes|vm|bare-metal|other`), rendered as-is, never enforced on the wire. Null = NOT DECLARED — an absence of a declaration, not an unknown observation, so a client renders nothing (no `—`, no badge). A client MUST NOT derive any of these from `name`: fixture names like `us-east-1-prod (k8s)` look parseable and are exactly the trap.

### §105. ONE of this stage's pipelines

ONE of this stage's pipelines — see `bindings`. Retained because `/v1` is additive-only and it already ships required; it is `bindings[0]`, i.e. the lowest Type alphabetically, and a client rendering only this shows ONE of a stage's pipelines with no sign the others exist.

**Read `bindings`.**

### §106. EVERY PIPELINE BOUND AT THIS STAGE, ordered by Type

EVERY PIPELINE BOUND AT THIS STAGE, ordered by Type — the `image` build, the `infrastructure` plan/apply and the `configuration` sync are separate pipelines that a component runs at the same place, and `UNIQUE(org_id, target_object_id, type)` exists precisely so one target can carry all three at once (ADR-0007: Type IS the executor routing key). `listExecutorBindingsForTarget`'s own docstring calls what it returns "every pipeline … (all Types)".

This ships because the first version of this view read `bindings[0]` and rendered that alone, so a stage carrying both a build and a deploy pipeline drew one of them and gave no hint of the other — the two live deployment-targets each carry `image` + `configuration` today. Empty means genuinely unbound, which is the ADR-0006 case (a) alarm; a NON-empty array is never truncated.

### §107. THE MOST RECENT CHANGE PER PIPELINE

THE MOST RECENT CHANGE PER PIPELINE — at most one entry per Category, newest first.

A stage's pipelines release independently: the software pipeline may have run an hour ago and the infra pipeline last month. Collapsing them to one "last release" makes whichever ran most recently look like the state of ALL of them, so the quiet pipeline reads as up to date and the lane that has never run reads as if it had. Per-Category is the smallest split that cannot lie, and `change_wave_targets.type` (persisted per target at compile time) is what makes it a direct read rather than an inference.

### §108. WHAT IS WITHHOLDING THIS STAGE'S RELEASE RIGHT NOW

WHAT IS WITHHOLDING THIS STAGE'S RELEASE RIGHT NOW — see `ComponentPipelineHoldSchema`. Null when no stage dependency is holding it, which is the ordinary case.

`.nullable().optional()` and never `.default()`: `/v1` is additive-only (charter principle 3) and a default renders the property REQUIRED in the generated SDK type, which is an oasdiff ERR. It is a SIBLING of `currents[].targetStatus` rather than a new value inside it — that field is documented as `change_wave_targets.status` verbatim, and a held target's status IS and stays `pending`, so overloading it would make the raw column mean something it does not say. It is also NOT the service board's `blocked`: that flag is derived from a verdict-only Decision query with no recency gate, and conflating a transient self-clearing wait with a permanent marker is the exact bug ADR-0028 wrote `verdict: "hold"` to avoid.

### §109. The version staircase the design asks for

THE "version staircase" the design asks for (coordination-ui-views.md Phase 4a) — derived from this stage's newest `currents[0].observed` via `preferredObservedVersion` (`realObservedImages`'s first entry, else the git-style `revision`), the SAME preference `PipelineWaveCard.tsx`'s per-target render applies, so the two can never disagree about which observed field wins. `null`, with `"version"` listed in `unknownFields` below, exactly when the stage has never had a wave target report `observed` at all — a real absence, not a confident zero. Once observed, this stays populated even after the change that produced it moves on: it is the newest OBSERVED value, not a property of the change in flight.

### §110. A DECLARED STAGE THE COMPONENT NEVER REACHES

A DECLARED STAGE THE COMPONENT NEVER REACHES — a place the release topology puts in this component's journey, with no `placement` behind it.

This is the single most operationally important thing a pipeline view can say, and the first version of it said nothing at all: stages were derived from placements, so a wave the component is not placed at did not exist in the view. Measured on the live estate the day it was reported — topology `commercial-gamma-then-prod` declares gamma then prod, `agentkit-bootstrap` holds one gamma placement, and prod rendered nowhere (owner, 2026-08-10).

It carries no `binding`, `current` or `version`: all three are keyed on a placement that does not exist, and inventing nulls for them would invite a client to render "no executor" — the ADR-0006 case (a) ALARM — over what is really just an absence of a placement. The two must not look alike.

### §111. THE REGISTRY THIS COMPONENT PUBLISHES TO, AT THIS SITE

THE REGISTRY THIS COMPONENT PUBLISHES TO, AT THIS SITE (pipeline-substrate-registry-scan.md §9.2).

Resolved from the component's outgoing `publishes_to` edges (component → execution-system, migration 0065) — a GRAPH FACT, deliberately not the `image` executor binding: a binding's Type is WHICH PIPELINE it drives (ADR-0007), so the image binding names what BUILDS the artifact, never where it lands. A registry is created `domainLocal:true` at each site and an edge with a domain-local endpoint never journals (M20.3), which is what makes this per-site by construction: the commander's Delivery lane shows the commander's registry, an outpost's shows its own.

`state` is STATED, never chosen: `none`      — no `publishes_to` edge here; every identity field null, `edgeCount` 0. A client says "no registry declared for this component here" — an absence, not an unknown. `declared`  — exactly one edge; the identity fields describe it. `ambiguous` — MORE than one edge. The identity fields are null and `edgeCount` says how many; the projection does NOT pick one (there is no rule that would make the pick honest, and "one per site" is a projection statement, not a DB constraint).

### §112. ONE SCAN VERDICT over ONE artifact digest

ONE SCAN VERDICT over ONE artifact digest (pipeline-substrate-registry-scan.md §9.3) — a `control_runs` row of the artifact's change whose `evidence` parses as `ScanEvidenceSchema`, reduced to the NEWEST per (`scanner`, `digest`). Only what the evidence holds is here: severity COUNTS, never a CVE list (none is stored — §8 "Scan").

`managed` is THE ONE server-side discriminator between the commander's own promotion scan step (promotion-scan-step.ts, the synthetic control id) and an org-pipeline `scan-result-control` run — the wire `ControlRun` carries no gateKind/gateRef, so without this flag the two are indistinguishable to a client. Read from `controlObjectId`, not inferred from the scanner.

### §113. One export of this change to one peer, as stamped

ONE EXPORT OF THIS CHANGE TO ONE PEER, as the commander stamped it at export time (§9.4 — `sourceRef.promotionExports[]`, written under the same row lock as `boundaryBundleChecksums`). This is WHAT THE COMMANDER SIGNED: its own promotion manifest (ADR-0015 §5 — SCP never signs an origin artifact), the detached cosign signature over `canonicalStringify(manifest)`, and the fingerprint of the instance key that signed it. A record here says "signed and exported"; it says nothing about arrival or verification at the peer (`boundary-segment.ts` R1).

### §114. THE IMPORTED PROMOTION MANIFEST

THE IMPORTED PROMOTION MANIFEST (§10.4) — what an OUTPOST's Registry tile shows about the artifact that ARRIVED there. At promotion import the receiving instance stamps, on the imported change's `sourceRef`, the exporter's `promotionManifest` + detached cosign `manifestSignature` (plus `promotedFromDomain`, `artifactDigests[]`, `artifacts[]`, `boundaryBundleChecksums`). Import REJECTS on any signature / set-equality / digest-tie failure (`verifyPromotionManifest`), so a manifest stored here was verified at import BY CONSTRUCTION — the projection re-verifies nothing.

Non-null ONLY when BOTH the manifest (parsing as `PromotionManifestSchema`) AND the signature are stamped. A manifest without a signature is stated in `artifact.unknownFields` as `importedManifest:unsigned`; a manifest that does not parse as `importedManifest:unparseable`; neither key ⇒ null with no note (nothing arrived — the commander site reads this).

```text
- `exporterDomainId` — `manifest.exporterDomainId`, verbatim.
- `exporterName`     — the paired peer's `name` here when a `federation_peers` row carries that
                       domain id (the exporter IS a paired peer at the importer); null otherwise.
- `importedFromDomain` — `sourceRef.promotedFromDomain` when it is a string; null otherwise.
- `artifactCount`    — `manifest.artifacts.length`.
```

### §115. The artifact this pipeline is about, and its facts

THE ARTIFACT this pipeline is about, and every CHANGE-SCOPED fact the projection holds about it (§9.3). The pipeline is component-scoped; a digest, an SBOM reference, a scan verdict and a signed manifest are all facts about ONE CHANGE — so the projection PICKS a change and STATES the pick (`changeId`, `changeName`, `changeCreatedAt`): the newest change of the component whose `sourceRef` carries an artifact digest, preferring the changes at the stages' currents/holds, else the component's newest such change at all. No such change ⇒ the response carries `artifact: null` — "no artifact yet", not an empty artifact.

Every field is READ from stored data or stated absent: - `digests`     — `sourceRef.artifact_digest` / `artifactDigest` (string or string[]) plus the importer's `artifactDigests[]` stamp, union in that order, de-duplicated, verbatim. - `sbom`        — `sourceRef.sbom` when it parses as `SbomRefSchema`; else null and `unknownFields` carries `sbom:unparseable` (a malformed reference is stated, not silently dropped). - `scans`       — see `ComponentPipelineScanRunSummarySchema`. - `exportGate`  — the E6 export gate's OWN predicate applied read-only over the same runs: `not_run` when no scan evidence exists at all; else `pass`/`fail`. It is a re-evaluation, never a remembered verdict (E6 writes no Decision on pass). - `signing.promotionExports`   — the §9.4 stamps, newest last (append order). - `signing.originSignatureRefs` — every ORIGIN `signatureRef` the sourceRef holds (today only the SBOM blob's; there is no artifact-level one — an empty array is the honest answer, never a fabricated ref). - `signing.importedManifest` — §10.4, see `ComponentPipelineImportedManifestSchema`. Optional on the wire (additive; an older server omits it), null when nothing arrived under a signed manifest.

### §116. THE OBSERVED CI RUN a change names

THE OBSERVED CI RUN a change names — component-journey-view.md §3 Segment 2's "upstream build" case. `sourceKind` is the change's own `source_kind` ("github"/"gitea"/"gitlab" — the only kinds `observed-run-facts.ts` reads run identity out of today). `repo` and `url` are nullable because the "carries run identity" predicate accepts either alone (a citable run id plus AT LEAST ONE of url/repo); `workflowName`/`workflowPath` are nullable because not every provider's writer shape cites them (gitea's `GiteaActionRun` and gitlab's `GitlabPipeline` name neither). `observedAt` is the CHANGE's own `created_at` (when SCP recorded it), not a field read out of the run payload — every writer's `sourceRef` names a run creation time under a different, unpinned key. `changeId` is the change this was read off, the same way `artifact.changeId` states its pick.

### §117. ONE infrastructure change correlated to this component

ONE infrastructure change correlated to this component (owner decision, 2026-08-24, correlated-infrastructure lane): an infrastructure change is correlated when its wave/bound target names a deployment-target one of this component's placements ALSO names, or this component is `hosted_on` it; a `provides`/`requires` coupling additionally correlates, rendered with a distinct route so a client never renders it as though it were a placement-level fact it is not. `correlatedVia.route` states WHICH kind of match this is — read off the server's own matching, never re-derived client-side. `placement` beats `hosted_on` when both would apply to the same target (a component is rarely both placed at and `hosted_on` the same place, but the placement fact is the more specific one when it happens); a change found ONLY via a coupling gets `route: "coupling"` and a null `target` — there is no place to name for that match. This component's OWN changes are excluded (the lane already renders its own pipeline) by reading `properties.targets`, never re-derived from placement/wave-target identity.

### §118. THE CORRELATED-INFRASTRUCTURE LANE

THE CORRELATED-INFRASTRUCTURE LANE (owner decision, 2026-08-24) — every infrastructure change this component's placements/hosted-on/couplings implicate, that is not this component's own. The server ALWAYS emits `{ changes: [...] }` (possibly empty) once it has evaluated the correlation — an empty array is a real, evaluated "none found", never confused with "not computed".

### §119. A component's pipeline

A component's pipeline: its stages, and where its pipeline definition came from.

Derived entirely from durable graph state — the resolved release topology, the component's placements, their bindings, and the `releases_via` attachment. It is well-defined for a component that has never released, which the change-anchored surface it replaces could not represent at all.

### §120. Where the journey came from, which decides how to read

WHERE THE JOURNEY CAME FROM, which is what decides how to read an EMPTY `unplacedStages`.

`topology` — a stage-shaped release topology resolved, so the journey is its waves in release order and an empty `unplacedStages` genuinely means "this component reaches every declared stage".

`placements` — no rung supplies a stage-shaped topology (none is attached, its waves name the change's own targets rather than places, or the document is malformed). There is no declared journey, so `stages` is simply where the component is placed, every `wave` is null, and an empty `unplacedStages` means UNKNOWABLE, not "none". A client must not render "reaches every stage" from it.

### §121. The declared stages it is NOT placed at

The declared stages it is NOT placed at.

WHY THE JOURNEY IS TWO ARRAYS rather than one list with a nullable `placement`: `/v1` is additive-only (charter principle 3), and widening `stages[].placement` to nullable is an oasdiff ERR three times over — `response-property-type-changed` plus `response-required-property-removed` on `placement/id` and `placement/urn` (measured, not assumed). The split is not a workaround dressed up: these ARE two different facts — where the component is placed, and what the topology declares that it does not reach — and neither array repeats anything in the other. `order` makes their union a single ordered pipeline. Do NOT "simplify" this into one array without an `api-v2-exception` (tools/openapi/OASDIFF-EXCEPTIONS.md).

### §122. THE OBSERVED CI RUN

THE OBSERVED CI RUN — component-journey-view.md §3 Segment 2's "upstream build" marker: "the distinction [coordinated vs upstream] is the whole point of §2, and it must be visible … it reads 'GitHub Actions · CI · run 30858160395 ↗', not 'build: unknown'". Composed from the MOST RECENT change of this component whose `sourceRef` carries a citable run id AND at least one of `url`/`repo` (`coordination/observed-run-facts.ts`) — every provider webhook/observe writer shape this instance traces (github/gitea flat-and-nested, gitlab pipeline/webhook) is read defensively; an unrecognized or malformed shape counts as absent, never guessed. Optional on the wire (additive-only `/v1`); a server that emits it sends an object or `null` (null = no change names a run). Absent = an older server.

### §123. THE CORRELATED-INFRASTRUCTURE LANE

THE CORRELATED-INFRASTRUCTURE LANE — see `ComponentPipelineCorrelatedInfraSchema`. Optional on the wire (additive-only `/v1`; this shipped after the response did). A server that has evaluated correlation always sends an object (`{ changes: [] }` is itself a value — "evaluated, none found"). Absent = an older server that never computed this at all; a client must keep the two distinguishable, the same rule `registry`/`artifact`/`observedRun` already follow.

## `packages/schemas/src/dependencies.ts`

### §124. M21.2 — the DEPENDENCY INVENTORY contract

M21.2 — the DEPENDENCY INVENTORY contract (ADR-0032 §3/§4/§5/§7).

The inventory is what a component's own dependency manifests DECLARE: `dependency_lines` (the identity of one MAJOR LINE of one dependency) and `component_dependencies` (which component declares which line, at which version, from which manifest). Storage rationale — the four measurements behind the scoped bend of charter principle 2 — lives in `apps/server/drizzle/0061_dependency_inventory.sql`'s header; this file is the typed contract.

Three invariants ride on these shapes and are stated here because a later reader of the types alone would not see them:

1. DIRECT DECLARED DEPENDENCIES ONLY (§4). No shape here can express a transitive closure, and none may grow one: a stored closure is an SBOM by another name, and ADR-0013 keeps SBOM bytes out of SCP deliberately (`supply-chain.ts` stores an `SbomRef`, never the document). 2. NOTHING HERE EXPOSES A TRANSITIVE TRAVERSAL (§3). There is deliberately no "dependencies of my dependencies" shape. That boundary is what makes the table representation sufficient; without it the graph representation becomes necessary again and the measured `impact-of` recursive-CTE hazard (7+ minutes, then disk exhaustion, against a 5s `statement_timeout`) applies to this path too. 3. NO `depends_on` EDGE IS MINTED (§5). There is no relationship in this contract at all — `depends_on` is the wave-plan toposort input and package graphs routinely contain cycles.

Vocabulary (docs/GLOSSARY.md, ADR-0032 §2): a **dependency subscription** is always spelled in full — bare "subscription" belongs to `notification_bindings`. The subscription itself is a graph object (it must federate, ADR-0022 clause 2) and is NOT in this file; this file is the inventory it is written against.

### §125. The five ecosystems of M21

The five ecosystems of M21 (ADR-0032 §10), in the owner's build order Go -> images -> npm -> Python -> Maven.

`oci` — container base images — is a first-class member, not an afterthought: a `Dockerfile`'s `FROM alpine:1.0` is a declared direct dependency in exactly the sense this feature means, and it is the one ecosystem needing no operator-loaded air-gap feed (the org's own registry IS the index). It is also the one with a version grammar that is not semver — see `tagPattern` below.

THE DATABASE COLUMN IS PLAIN `text` WITH NO pg ENUM AND NO CHECK, matching `source_mappings.type` and `scanner_assignments.executor_type`: this enum is the only enforcement point, so a sixth ecosystem is an edit to this file rather than a migration.

### §126. The ECOSYSTEM-NATIVE coordinate, carried VERBATIM

The ECOSYSTEM-NATIVE coordinate, carried VERBATIM — case preserved, punctuation preserved, never slugified and never round-tripped through `deriveUrn`.

This is the single most load-bearing decision in the inventory's shape (ADR-0032 §3, Context 2). `graph/urn.ts`'s `slugify` lowercases and hyphenate-collapses every non-alphanumeric run, so `@acme/lib`, `acme/lib` and `acme-lib` ALL become the URN `urn:scp:{org}:{type}:acme-lib` — one identity for three different packages, colliding as a 409 with no auto-suffix and no upsert-by-coordinate. Storing the raw string and keying on `(org, ecosystem, coordinate, major)` is what keeps them three.

```text
npm     `@acme/lib`                    (scoped) or `lib`
go      `github.com/acme/lib`          module path; case-sensitive by spec
maven   `com.acme:lib`                 groupId:artifactId
python  `acme-lib`                     the distribution name as written
oci     `docker.io/library/alpine`     registry-qualified repository
```

No normalisation is applied on the way in. Two spellings the ecosystem itself considers equal (PyPI's `Acme_Lib` vs `acme-lib`) are two rows here; that is the conservative direction — it over-counts lines rather than silently merging two packages into one subscription target.

### §127. The major line, as the ecosystem spells it: a string

The major line, as the ECOSYSTEM spells it — a string, not a number. Go writes `v2`, an image line is `3.18` as often as `3`, and Maven lines are not reliably numeric. Coercing to an integer here would be the same lossy normalisation the URN scheme performs on the coordinate.

### §128. `oci` only: the tag shape whose version this follows

`oci` ONLY — the tag shape whose parsed version this line follows.

Image tags are not semver: `1.2.3`, `1.2.3-alpine`, `1.2`, `latest` and date stamps all coexist in one repository, and a registry has no notion of a major line at all. So an image line needs a tag pattern plus a parsed-version extractor, and a tag the extractor cannot parse is SKIPPED, NEVER GUESSED (ADR-0032 §7) — falling back to string ordering would make `latest` sort above `1.2.3` and bump a subscriber onto arbitrary bytes.

NULL for the four language ecosystems, whose version grammar is the ecosystem's own.

### §129. THE PRODUCER LINK IS NOT ON THIS ROW ANY MORE

THE PRODUCER LINK IS NOT ON THIS ROW ANY MORE (ADR-0032 §7e, proposal §12.1).

It used to be `producedByObjectId` + its two companions here, which made the declaration PER MAJOR LINE. "Component X publishes `@acme/lib`" is a fact about the COORDINATE, true across every major X ever cut, and the mismatch was not cosmetic: lines are minted only by a CONSUMER's manifest, so every new major minted a fresh row with a NULL producer, honestly third-party by default, and `buildLineWorkList` then handed the org's own coordinate to a PUBLIC INDEX — ADR-0032 §7b clause 1's dependency-confusion catastrophe, re-armed silently at each major bump. The declaration now lives in `dependency_line_producers`, keyed `(orgId, ecosystem, coordinate)`, so a new major of a declared coordinate is internal FROM THE INSTANT IT IS MINTED because there is no per-major field left to populate.

DO NOT ADD IT BACK AS A CACHE. Stamping it at mint time from the declaration table closes the same hole, but it puts a producer write back inside the ingestion verb and so deletes "declared, never inferred" — the property this whole feature exists to protect. Read `isInternalDependencyLine` with a `DependencyLineProducer | null` obtained by joining.

### §130. The head of the line as last OBSERVED

The head of the line as last OBSERVED (written by M21.4 detection, never by manifest ingestion — a component declaring `1.2.0` says nothing about what the line's head is).

`null` is "not yet observed", which is NOT "no newer version exists". Absent never means zero, the same reading `ScanRequirementFloor`'s nullable ceilings established, and the same reading the enablement chain uses for "absent never means enabled" (ADR-0032 §6).

### §131. The DECLARATION that an org produces one COORDINATE

The DECLARATION that an org produces one COORDINATE — the row of `dependency_line_producers` (ADR-0032 §7e, proposal §12.1). Identity is `(orgId, ecosystem, coordinate)`; the row's EXISTENCE is the declaration, so a half-written one is unrepresentable rather than refused by a CHECK.

It is a PROJECTION TABLE ROW AND NOT A GRAPH OBJECT, and that is a FEDERATION decision, not a storage-convenience one (§12.4). A `produces` relationship or a `producedBy` policy effect would federate, and a field outpost would then hold a declaration with no inventory behind it — a visible assertion nothing can act on, the exact "true elsewhere, inert here" shape `dependencyManagement` exists to close.

### §132. The shape every dependency read uses to name an object

`{objectId, name}` — the shape every dependency read uses to name a graph object beside its id (the inventory row's `producer` had it first). `name` is the object's CURRENT name as stored; a soft-deleted object still names (the row is a stored fact and the name is what it was) — a client that needs liveness reads the object.

### §133. THE WIRE VIEW of a declaration

THE WIRE VIEW of a declaration — the stored row PLUS the two names a reader needs and cannot derive: the producing component's and the declaring principal's (proposal dependency-subscription-ui.md §12.6 Q1, owner decision 2026-08-18: names are enriched server-side, one batched `objects` lookup, so every viewer sees the same answer in one round trip and no client pays N+1 reads it may not even be authorized to make — a user object is readable by few).

A VIEW, NOT THE ROW: `DependencyLineProducerSchema` stays the repo/domain type (`isInternalDependencyLine` and the internal-release derivation read it and never need a name), so the enrichment lives at the two routes that answer humans and nowhere else. Additive on the wire: two REQUIRED properties added to a RESPONSE (oasdiff-safe — PR #222 precedent).

### §134. True iff the coordinate has a DECLARED producer

True iff the coordinate has a DECLARED producer. The one place "internal" is decided — read from the declared row, never derived from `coordinate`. Kept as a function so no call site is tempted to re-derive it from a name (ADR-0032 §7).

It takes the DECLARATION, not the line, since M22's regrain: internal-ness is a property of the coordinate and a line row carries no producer field at all. A caller that has only a line must join, which is what makes a brand-new major of a declared coordinate internal immediately.

### §135. One component's declaration of one line, from one manifest

One component's DECLARATION of one line, out of one dependency manifest.

"Dependency manifest" is always qualified (docs/GLOSSARY.md): bare "manifest" in this codebase is the commander-signed PROMOTION manifest, which authorizes a boundary crossing. A dependency manifest authorizes nothing.

### §136. The repository the manifest was read from, as spelled

The REPOSITORY the manifest was read from, as the provider spells it — the half of the address that `observedRef` alone never carried (a commit sha names no repository).

It is what makes a prune attributable to the evidence that justifies it: an ingestion pass reads ONE repo, and "this path is not there" is evidence about THAT repo only. `null` means the repository was not recorded, and such a row is never pruned (drizzle/0063).

### §137. M21.3 — DEPENDENCY SUBSCRIPTIONS AND THEIR ENABLEMENT

M21.3 — DEPENDENCY SUBSCRIPTIONS AND THEIR ENABLEMENT (ADR-0032 §3a, §6).

A DEPENDENCY SUBSCRIPTION IS NOT AN OBJECT. It is a `dependencySubscription` EFFECT on an ordinary `policy` object (ADR-0032 §3a), validated by the policy document JSON Schema extended in `drizzle/0062_dependency_subscription_enablement.sql` and resolved by the existing `matchPoliciesForTargets` / `containmentChain` machinery. This mirrors `scanThreshold` (ADR-0016) in every structural respect, deliberately: `policy` is a built-in type on every instance and its upsert shares the importer's `object_upsert` case, so the subscription federates already, with no new type for a not-yet-migrated outpost to be missing.

The shapes below are therefore the AUTHORING SURFACE and the EXPLAINED RESULT. The merge itself lives in `apps/server/src/dependencies/subscription-resolution.ts` — a pure function, so its properties are unit-testable with no database (BUILD_AND_TEST.md §4.1).

### §138. How much of a line a subscriber accepts automatically

How much of a line a subscriber accepts automatically.

`patch` is the MORE RESTRICTIVE of the two, and the resolver's merge is most-restrictive-wins over EVERY enabling contribution — INCLUDING THE SILENT ONES, which are read as `patch`. So a contribution can only ever tighten what another contribution would have allowed, never loosen it, and no scope can hand a looser granularity to a scope that did not ask for one. There is no `major` member on purpose — a subscription is to a MAJOR LINE (ADR-0032's opening sentence), so crossing majors is a different subscription, never a looser setting on this one.

### §139. How the M21.5 actuator delivers a bump

How the M21.5 actuator delivers a bump (ADR-0032 §8, owner decision 2026-08-13).

`pull_request` is the MORE RESTRICTIVE of the two and the merge treats it as such.

AUTO-MERGE IS THE PRIVILEGED OPTION AND IS ACQUIRED UNANIMOUSLY. Every enabling contribution votes — and A SILENT CONTRIBUTION VOTES `pull_request`, because it never asked for anything else. The merge takes the MIN over those votes, so auto-merge is reached only when EVERY contribution that enabled this pair declared it. A BROADER SCOPE THEREFORE MAY NOT GRANT AUTO-MERGE TO A NARROWER ONE THAT STAYED SILENT: an org-wide `{"enabled": true, "delivery": "auto_merge"}` combined with a component's own `{"enabled": true}` resolves to `pull_request`, because the component team never asked for commits to land in their repo without a pull request. The cost is stated rather than discovered: a team that DOES want auto-merge cannot get it while any other enabling policy is silent — that policy must declare `auto_merge` too. That is the safe direction of the trade, and it is the direction the owner's requirement points ("teams choose").

`auto_merge` IS ACTUATED, AND NEVER ON A BUMP'S FIRST LOOK (M21.5, ADR-0032 §8c)
The charter grants automatic merge only where a governed control evidences the component's OWN checks passed ON THE BUMP'S OWN COMMIT — which cannot be true when the bump is authored, because the commit the control would have to have passed is the one that run is about to create. So the FIRST dispatch of an `auto_merge` subscription always resolves to `pull_request`, whatever the subscription asked for, and records why on the change: the option is visibly declined rather than silently ignored.

The SECOND look is what merges, and it exists (`apps/server/src/dependencies/bump-gate.ts`): when an observed provider event correlates to a bump SCP authored — the authored push, then the CI conclusion that names its commit — the EXISTING governance gate is run for that change, and the delivery question is asked again against what it deposited. A grant additionally requires the evidence to name the bump's own repository AND its own head commit, both read from SCP's own server-owned record of what it authored, and the merge is then addressed to the pull request SCP itself opened.

"The bump merges on its second look, never on its first" is the property. `bump-actuator.ts`'s `resolveEffectiveDelivery` states every narrowing and what each one closes.

### §140. ONE `dependencySubscription` EFFECT

ONE `dependencySubscription` EFFECT — the authoring surface, one item of a policy document's `effects[]`.

SELECTORS: `ecosystem` / `coordinate` / `major`. A contribution MATCHES a (component, line) when EVERY PRESENT selector equals the line's value; an ABSENT selector is a WILDCARD. That single rule is what makes both halves of the intended authoring expressible without a second surface:

```text
  {"enabled": true}                                   subscribe this whole scope
  {"coordinate": "@acme/lib", "enabled": false}       …but never that one package
```

`coordinate` is compared VERBATIM against `dependency_lines.coordinate` — byte-for-byte, case preserved, never slugified and never round-tripped through `deriveUrn`. See `DependencyCoordinateSchema` above for why: `@acme/lib`, `acme/lib` and `acme-lib` collapse to one URN, and an opt-out that matched all three would silently un-subscribe two packages nobody named.

`enabled` IS REQUIRED, not defaulted. ABSENT NEVER MEANS ENABLED (ADR-0032 §6), so an omitted flag would have to read as `false` — at which point a typo in the key name produces an opt-out-shaped effect that opts nothing out. The JSON Schema in 0062 requires it too, so the mistake is a 400 at authoring time rather than a silent inert policy.

`enabled: false` is an OPT-OUT, and an opt-out ALWAYS WINS over any number of enables at any tier (§6: "the deepest level may only subtract"). A `granularity`/`delivery` alongside `enabled: false` is therefore inert — the resolver reads those two only from contributions that actually enable.

`strictObject`, AND THAT IS THE SELECTOR PROPERTY'S OTHER HALF. A plain `z.object` STRIPS an unrecognised key, so `{"enabled": true, "coordinat": "@acme/lib"}` would parse cleanly into `{enabled: true}` — an effect with NO selectors, which is a WILDCARD. One transposed character would subscribe every dependency line in the scope instead of one npm package, and the same typo on an opt-out would wildcard the DISABLE across every line. That is the identical property 0062's header already argues for a bad ecosystem VALUE ("an unrecognised ecosystem on a SELECTOR silently voids the selector, and a voided selector fails OPEN") — A SELECTOR THAT FAILS TO BIND MUST VOID ITSELF, not the constraint. Stripping is exactly failing to bind, so it is refused here and, independently, by `additionalProperties: false` on 0062's `dependencySubscription` block. Two layers because they fail in different places: Ajv refuses the AUTHORING write, this refuses a document that reached the resolver by any other route (federation, a direct DB write, a migration that restated the policy document and dropped the constraint).

### §141. The tier a contribution came from — for EXPLAINABILITY ONLY

The tier a contribution came from — for EXPLAINABILITY ONLY (charter principle 6: a caller must be able to answer "WHICH level turned this off?").

NEVER FOR PRECEDENCE. There is no precedence in an AND, exactly as there is none in `scan-requirements.ts`'s MIN, and for the same documented reason: `graph/containment.ts:60-73` records that containment-domain-vs-service is NOT a strict ordering, so two ancestors of different kinds can TIE. Override semantics would be undefined at that tie; a monotone AND has no such failure mode.

A tier label is derived from the contributing object's `typeId`, NEVER from its position in the containment chain. `containmentChain` bounds its recursion at `depth < 10` and does not error at the bound — it stops expanding and then recomputes depth over the rows it DID return, so the org can arrive at a NONZERO depth while a top-level domain occupies index 0 (BUILD_AND_TEST.md's M21.3 "a ceiling whose ROOT LABELS CAN LIE"). Index 0 is not the org.

`instance` is the above-org tier and has no graph object at all — it is the `dependency_subscription_unlock` singleton row.

### §142. WHAT one contribution actually contributed to the AND

WHAT one contribution actually contributed to the AND.

- `unlock` / `lock` — the instance singleton. `unlock` PERMITS and never activates; `lock` is the answer to "which level turned this off" when the deployment never opened the feature at all. - `enable` / `disable` — a matching `dependencySubscription` effect. `disable` always wins. - `ignored` — a contribution that was FOUND on a matched policy and admitted to NEITHER side. It is recorded rather than dropped: a malformed or unevaluable opt-out that vanished silently would leave a line subscribed that an operator believed they had excluded, and principle 6 requires that be visible in the result rather than only in a log.

### §143. One level's contribution to the resolved enablement

ONE level's contribution to the resolved enablement, carried so a Decision can answer WHICH level turned this off (charter principle 6). Modelled on `ScanThresholdContribution` (`supply-chain.ts`), including the verbatim `objectTypeId` that keeps the tier mapping auditable instead of implicit.

### §144. The selectors this contribution carried, echoed back

The selectors this contribution carried, echoed back so "why did this apply to THIS line?" is answerable from the result alone. Absent KEYS were wildcards.

PRESENT-AND-EMPTY (`{}`) IS THE ANSWER TO "wildcard by intent, or wildcard by accident?". Every contribution whose effect PARSED and MATCHED the line carries this key, so `{}` records "matched every line of this scope, and every selector was DELIBERATELY absent" — it is never the residue of a selector that failed to bind, because `DependencySubscriptionEffectSchema` is a `strictObject` and 0062 sets `additionalProperties: false`, so a mistyped selector key is refused rather than stripped into a wildcard. The key is omitted only where there are no selectors to report at all: the instance `unlock`/`lock`, which is not a policy effect, and a `malformed` contribution, which never parsed.

### §145. WHY the resolution came out the way it did

WHY the resolution came out the way it did — a summary of the contributions below it, never a substitute for them (every cause is in `contributions` regardless of which one this names). Reported in a fixed order — `instance_locked` before `disabled` before `not_enabled` — so the value is order-independent like the rest of the result.

### §146. The resolved enablement of ONE

The resolved enablement of ONE (component, line) pair, with its full explanation.

`granularity`/`delivery` are ALWAYS present and always the MOST RESTRICTIVE across the contributions that actually enabled — `patch` / `pull_request` when none carried one. They are meaningful only when `enabled` is true; they are reported unconditionally so the shape is total.

### §147. M21.3 — THE API SURFACE for the enablement chain

M21.3 — THE API SURFACE for the enablement chain (charter principle 3: API -> SDK -> CLI).

TWO SURFACES HERE, AND DELIBERATELY NO SUBSCRIPTION-WRITE SURFACE ANYWHERE (the M21.6 READ surface — the inventory and the bump history, per component — is the last section of this file):

1. The INSTANCE UNLOCK — read + write of the `dependency_subscription_unlock` singleton. Read is tenant-facing (a team whose subscription is inert because the DEPLOYMENT never opened the feature must be able to see that — principle 6); write is operator-only, because the row binds every org on the deployment. 2. The RESOLUTION of one (component, line) pair, WITH its contributions. This is the explainability surface, and carrying `contributions` is the entire reason they exist: a caller must be able to answer "WHICH level turned this off?" without reading the policy set itself.

THERE IS NO SUBSCRIPTION-WRITE SHAPE HERE, ON PURPOSE. A dependency subscription IS a `dependencySubscription` effect on an ordinary `policy` object (ADR-0032 §3a), so it is authored, listed, versioned and federated through the EXISTING policy surface (`CreateObjectRequestSchema` / `scp policy register`). A bespoke create/update/delete shape here would be a second authoring path for one concept — it would need its own versioning, its own journal handling and its own scope semantics, and the two would drift. Do not add one.

### §148. The instance unlock singleton, as the API projects it

The instance unlock singleton as the API projects it — the FIRST conjunct of §6's AND, and nothing more. `unlocked: true` means "components on this deployment MAY be subscribed", NEVER "are subscribed": with no enabling policy anywhere it subscribes exactly zero components (ADR-0006, "managed execution is never a default").

`updatedAt` is `null` exactly when NO ROW EXISTS, which is the LOCKED default (absent never means enabled). The pair `{unlocked: false, updatedAt: null}` therefore reads "never set", and `{unlocked: false, updatedAt: <ts>}` reads "deliberately re-locked" — two different operator situations that a bare boolean would flatten into one.

### §149. The operator write body

The operator write body. `unlocked` is REQUIRED for the same reason the effect's `enabled` is: absent never means enabled, so an omitted flag would have to be read as `false` — and a PUT that silently LOCKED a deployment because a field name was misspelled is the same failure in the other direction. Requiring it makes both mistakes a 400.

### §150. Which deployment shape answered, in the role vocabulary

WHICH DEPLOYMENT SHAPE ANSWERED, in the vocabulary of `SCP_FEDERATION_ROLE` — plus the one value that is NOT a role.

`role_undeclared` IS ITS OWN VALUE AND IS NEVER FOLDED INTO `commander`. That is the whole point of carrying a reason rather than a bare boolean. `config.federationRole` DEFAULTS to `commander` when `SCP_FEDERATION_ROLE` is unset, so an outpost that predates the setting, or a chart that omits it, reads as a commander on the value alone — and dependency automation FAILS CLOSED there (ADR-0032 §7d, `apps/server/src/dependencies/commander-only.ts`). A reader handed `commander` for that deployment would be told the opposite of the truth: it looks like the place work happens, and it is precisely the place nothing will run. It is a distinct value so the remedy is distinct too — an outpost's operator calls the commander, an undeclared deployment's operator sets one env var.

### §151. Does dependency management actually happen on this one

DOES DEPENDENCY MANAGEMENT ACTUALLY HAPPEN ON THE DEPLOYMENT THAT ANSWERED THIS REQUEST?

WHEN `managedHere` IS FALSE, THE REST OF THE ENVELOPE IS NOT TO BE INTERPRETED
All dependency automation is COMMANDER-ONLY (ADR-0032 §7d): a FIELD outpost runs no dependency job and holds no dependency inventory, because the point of the feature is to pull from PUBLIC repositories and the resulting change is pushed down the global pipeline the commander manages. ("Field" is load-bearing, not decoration: an HQ outpost is the outpost in the COMMANDER'S OWN trust domain, so its inventory simply IS the commander's. Nothing on this wire can be one, which is why the values below need no fourth member — a `reason` of `outpost` means the answering deployment DECLARED `SCP_FEDERATION_ROLE=outpost`, and that is a field outpost by construction. `apps/server/src/dependencies/commander-only.ts` reads the distinction out of the code.) So on any deployment where `managedHere` is false:

```text
- inventory-shaped answers are STRUCTURALLY EMPTY — not "this component declares nothing", but
  "nothing here ever ingested a dependency manifest, and nothing ever will";
- a RESOLVE verdict is still computed, and it is still arithmetically correct FOR THIS
  DEPLOYMENT: the policy tiers it merges federated down from the commander. But NOTHING ON THIS
  DEPLOYMENT WILL ACT ON IT. An `enabled: true` here does not mean a bump will be authored here;
  it means a bump would be authored on the commander, for a subscription that also resolves
  there. Nor is it a prediction of the commander's answer: the INSTANCE UNLOCK conjunct is a
  local singleton row that does NOT federate, so `enabled: false, reason: instance_locked` here
  says this deployment is locked and says nothing about whether the commander is. Ask the
  commander — which is what a `managedHere: false` is telling a caller to do.
```

That gap is the reason this envelope is REQUIRED rather than advisory. Answering `enabled` where nothing acts on it is charter principle 6 FAILING — an answer whose reason is unavailable — and the honest sentence is not "enabled"/"disabled" but "enabled, and not managed here, because this deployment is an outpost". `reason` is what lets a caller write that sentence without a second round trip and without inferring a posture from a hostname.

`managedHere` is the FEDERATION axis only, deliberately, and so it is a fact about the DEPLOYMENT rather than about the process that served the request. In the split topology every HTTP request lands on an `SCP_ROLE=api` process while the jobs drain on a `worker`; a `managedHere` that also read the process axis would tell every caller of a perfectly correct commander that dependencies are not managed there. See `commanderOnlyFederationVerdict` for that argument in full.

### §152. Is this component subscribed to this line, and why

The answer to "is THIS component subscribed to THIS line, and why?" — the resolution plus the inputs it was computed for, so the response stands alone in a log or a Decision.

The line is ECHOED rather than assumed from the request because the coordinate is compared VERBATIM (`DependencySubscriptionEffectSchema`): seeing exactly which bytes were resolved is how an operator discovers that their opt-out named `acme-lib` while the manifest declares `@acme/lib`.

IT ANSWERS ENABLEMENT, NOT DECLARATION. Any well-formed line key resolves, whether or not the component declares it — which is what makes the surface useful BEFORE a dependency is added, and is why it never 404s on an undeclared line. What a component declares is the inventory's question (ADR-0032 §4), not this one.

### §153. WHETHER ANYTHING HERE WILL EVER ACT ON `resolution`

WHETHER ANYTHING HERE WILL EVER ACT ON `resolution`. REQUIRED, because a caller that could receive the verdict without it is exactly the caller this closes the hole for: the answer alone is unqualified, and on an outpost it is unqualified in the direction that reads as "yes, this is running". Adding a required response property to this operation was measured against the vendored oasdiff at the merge base and is not an ERR (nothing existing is removed and no required property became optional) — the same shape `/components/{idOrUrn}/pipeline` already carries. See `DependencyManagementSchema` for what a `false` does and does not mean.

### §154. The digest of that version, from the same observation

The digest OF `latestVersion`, resolved in the SAME observation — `null` when it could not be (a language ecosystem has none, an operator-loaded air-gap feed carries none, a registry inspect can fail).

REQUIRED, NOT OPTIONAL, and that is a defect fix rather than a style preference. While this key was optional a writer could move `latestVersion` and simply omit the digest, leaving the PREVIOUS version's digest standing beside the new tag — a (tag, digest) pair that never existed in any registry, in a column pair whose entire purpose is that "a mutable tag is not an identity" (ADR-0032 §7). The omission is now unrepresentable: the pair moves together or not at all. The whole meaning of the trio lives in `apps/server/src/dependencies/line-head.ts`.

### §155. M21.2 — THE INVENTORY BACKFILL

M21.2 — THE INVENTORY BACKFILL (ADR-0032 §4).

Ingestion is event-driven: a correlated, accepted change re-reads its component's dependency manifests. That covers every component that releases from now on and NO component that does not — so on an existing estate the inventory would stay empty until each team happened to commit, and a component that never pushes again would never acquire one at all.

The precedent was `POST /discovery/backfill-source-mappings`, which existed for exactly this class of problem ("create rows onto already-imported components"): operator-triggered, idempotent, and it reported every skip rather than only a count. That route has since been RETIRED — not because the shape was wrong, but because its population closed when `discovery/accept` was removed (see `packages/schemas/src/executors.ts`). The shape is still the right one here, where the population is open.

### §156. How many components this request may actually fetch for

How many components this request may actually FETCH for, before it stops and reports the rest as unattempted. Defaults to `DEFAULT_DEPENDENCY_INVENTORY_BACKFILL_FETCH_BUDGET`.

A BOUND IS REQUIRED, not a nicety. With no `componentIdsOrUrns` the run walks every component in the org INLINE IN ONE REQUEST, and each enabled one makes up to 40 live git-provider reads. On a four-hundred-component estate that is a single HTTP request holding tens of thousands of round trips against a user's provider and its rate limit, with a client that will have timed out long before. The bound counts only components that were actually fetched for: an unsubscribed component costs no read (the gate refuses before the repo is touched), so it does not consume budget and a whole-org run still reports every component's enablement.

### §157. Declarations deleted because the manifest dropped them

Declarations DELETED because the manifest no longer declares them.

REPORTED BECAUSE THE DESTRUCTIVE HALF MUST NOT BE INVISIBLE IN ITS OWN RECEIPT. Without it a run that emptied a component's entire inventory — every manifest gone from the ref the operator happened to name — reads exactly like a clean one: `verdict: "ingested"`, and only the counts of what was ADDED. An operator backfilling at the wrong ref would have no signal at all.

### §158. The COORDINATE half of a producer declaration

The COORDINATE half of a producer declaration — the natural key of `dependency_line_producers`, and the query shape of the read.

The coordinate travels in the BODY or the QUERY, never a path segment: coordinates contain `/`, `@` and `:` (`github.com/acme/lib`, `@acme/lib`, `docker.io/library/alpine`), so path-segmenting one is a trap. `GET /components/:idOrUrn/dependency-subscription` already makes this choice.

### §159. The operator-driven verb that makes a coordinate internal

The separate, operator-driven verb that makes a COORDINATE internal. Kept apart from `UpsertDependencyLineInput` on purpose: if ingestion could pass a producer alongside a coordinate it observed, "declared, never inferred" would survive only as long as every ingestion call site remembered to leave it unset. Splitting the verb removes the capability instead of guarding it.

THERE IS NO `declaredByObjectId` HERE, AND THERE MUST NOT BE. Principle 6 asks WHO asserted this, and an answer the asserter typed is not an answer. The route stamps the authenticated subject.

### §160. The producing COMPONENT's graph object id or URN

The producing COMPONENT's graph object id or URN.

A `service` IS REFUSED IN THE FIRST CUT (ADR-0032 §7e, proposal §12.2), and the refusal is not pedantry: `listProducedLines` derives a head only from the COMPONENT a prod placement names, so a service-valued declaration derives no head at all while still removing the coordinate from third-party polling — it does the harmful half silently and not the useful half.

### §161. One line the declaration

One line the declaration (or retraction) covers, and what it did to that line's head.

THE HEAD IS CLEARED BY BOTH VERBS, and the reason is a security one rather than a tidiness one (§12.3.2, and stronger since M22). `latest_version` is not only the poll's backward-movement floor: the M22 vendor rule grants a scan PASS when a component sits on the latest of its major line. A head left over from the internal era, on a coordinate that is third-party again, can therefore grant a vendor-pass against a version no registry ever published. In the other direction a poisoned public head (the stranger's `9.9.9`) would survive the very declaration that exists to undo it, and internal detection could never move the head back down to the org's real `2.1.0` — `recordDependencyLineHead` refuses backward movement.

### §162. A bump already authored and still open at retraction

A bump SCP already authored that is still open at the moment of a retraction.

IT IS REPORTED AND NEVER TOUCHED. A dispatched bump has left SCP: it is a pull request in another team's repository, or — under `auto_merge` — a commit on their branch. Closing or rewriting these rows would assert SCP closed a PR it did not close. Retraction stops FUTURE triggers only, and this list is what an operator takes away to go and close them (§12.3.2).

### §163. M21.6 — THE READ SURFACE

M21.6 — THE READ SURFACE (docs/proposals/dependency-subscription-ui.md §3.1/§3.2; owner decisions §8 Q1/Q4, 2026-08-16).

Everything above this line is the inventory's WRITE contract and the enablement chain's EXPLAINABILITY surface. What was missing — and what the UI cannot exist without — is a READ of what a component DECLARES (its inventory rows), the HEAD of each declared line, the resolved dependency subscription of every declared line at once, and the history of the bumps SCP authored for it. Two component-scoped, paged, additive GETs carry all of that:

```text
GET /components/{idOrUrn}/dependency-inventory   -> ComponentDependencyInventoryResponse
GET /components/{idOrUrn}/dependency-bumps       -> ComponentDependencyBumpsResponse
```

Both authorize `object:read` AT THE COMPONENT (never at the org), exactly as the resolution GET does, so a component-scoped viewer can read them.

THREE RULES THESE SHAPES CARRY, stated because a reader of the types alone would not see them:

1. NO SECOND AND. `rows[].subscription` is the SAME `DependencySubscriptionResolution` the resolution GET returns for the same actor and line — produced by the same merge, from the same gathered candidates — never a per-row recomputation, and `componentGate` is the SAME `ComponentIngestionGate` ingestion runs. A UI reads these; it derives nothing. 2. `null` IS "NOT RECORDED", NEVER "NOTHING". `ingestion: null` is "NEVER ATTEMPTED" (the stamp table's one reading of a missing row — `ingestion-stamp-repo.ts`), NEVER "no dependencies"; `head.latestVersion: null` is "not observed", never "nothing newer"; `producer: null` is "no producer declared" (third-party OR undeclared — the stored fact cannot say which); `pullRequestUrl: null` is "not stored". An empty `rows` beside a null `ingestion` and a null `lastIngestionDecision` is UNKNOWN, and a consumer must render it so. 3. THE COORDINATE TRAVELS VERBATIM in every field that carries one, as everywhere else in this file. 4. BOTH RESPONSES ARE QUALIFIED BY A REQUIRED `dependencyManagement` (ADR-0032 §7d, M21.7 — `DependencyManagementSchema` above, computed by the ONE predicate `commander-only.ts` exports). When `managedHere` is false the REST OF THE ENVELOPE IS NOT TO BE INTERPRETED: the routes still answer 200 with the same RBAC, but an empty inventory there is "nothing here ever ingested a manifest and nothing ever will", not "declares nothing", and an empty bump list is "no bump is ever dispatched here", not "up to date". A consumer renders the pointer to the commander and nothing else.

### §164. The page query for both read routes

The page query for both read routes. Its own schema rather than `CursorPageQuerySchema` because an inventory is read WHOLE far more often than paged (a component declares tens of lines, not thousands), so the ceiling and the default are both higher than the generic envelope's 100/20.

### §165. The per-component ingestion STAMP

The per-component ingestion STAMP — "when did ingestion last ATTEMPT this component, and what happened", including the attempts that write no Decision (`not_enabled`, unreadable). READ from `dependency_ingestion_stamps` (M21.7, migration 0065; `ingestion-stamp-repo.ts`'s `findIngestionStampByComponent`), one row per component, merged per REPOSITORY by its writer — which is why every `manifests[]` entry names its `repo`: a component fed by two repositories carries both slices, and the component-level `outcome` / `rowsWritten` are computed ACROSS them.

THE TRICHOTOMY THIS EXISTS TO BREAK. With no stamp (`ingestion: null`) the component was NEVER ATTEMPTED. `outcome: "ok"` with `rowsWritten: 0` is "read fine, genuinely declares nothing" — the state an empty inventory could not express before. `partial` / `unreadable` are "ingestion ran and some / every manifest could not be read", with the per-file verdicts in `manifests[]`. `not_enabled` is "the gate was closed; nothing was fetched". A consumer renders these differently and never collapses an empty `rows` into "no dependencies" without the stamp.

### §166. The newest ingestion Decision about this component

The newest `dependency_inventory_ingestion` Decision about this component, projected — what exists TODAY as evidence that an ingestion pass ran and what it read. It is written ONLY on the `ingested` verdict and under persist-on-change, so `firstObservedAt` is when THIS state was FIRST seen — never the time of the last pass — and its absence is ambiguous (never ingested, or refused as not-enabled / not-addressable / superseded, none of which write one).

### §167. The COMPONENT-LEVEL ingestion gate

The COMPONENT-LEVEL ingestion gate — "may this component's dependency manifests be fetched at all?" — as `resolveComponentIngestionGate` answers it for the calling actor. A THIRD reason vocabulary from the per-line resolution's, deliberately: the gate is existential over lines ("is there ANY line this component would be subscribed to?"), so its closed answers are `instance_locked` and `no_enabling_contribution`, not `disabled`/`not_enabled`.

### §168. ONE ROW of a component's inventory

ONE ROW of a component's inventory: one (line, dependency manifest) declaration, hydrated with the line's head, its DECLARED producer and its resolved dependency subscription.

`manifestPath` IS PART OF THE ROW KEY: one line declared from two manifests is TWO rows (it is in `component_dependencies`' primary key for exactly this reason — collapsing them would let a prune of one silently delete the other). A consumer that wants one row per line groups these.

### §169. The resolved subscription of this component and line

The resolved dependency subscription of (this component, this line) — the SAME shape, from the SAME merge, as `GET /components/{idOrUrn}/dependency-subscription` returns for the same actor and line. Resolved AS THE CALLER (the acting subject is the requesting principal, exactly as the resolution GET threads it), which is why the two are byte-equal for one caller and why a `scope.group` policy can make a human's answer differ from the SYSTEM actor's.

### §170. ONE BUMP SCP AUTHORED for this component

ONE BUMP SCP AUTHORED for this component — a `dependency_bump_authorships` row (server-written, every field), joined to its change's name and to the newest `dependency_bump_dispatch` / `dependency_bump_merge` Decisions about that change.

THE CHANGE'S `state` IS NOT HERE, ON PURPOSE. A bump change sits at `proposed` for its whole life (`bump-gate.ts`: it is deliberately never advanced down the lifecycle), so reading it as progress would show every bump as "proposed" forever. Progress is `pullRequestNumber` (opened), `headCommit` (the authored push observed back), `mergedAt` (the provider confirmed the merge) and `merge` (the gate's latest verdict) — nothing else.

### §171. The pull request's URL as the provider returned it

The pull request's web URL AS THE PROVIDER RETURNED IT, read off `dependency_bump_authorships.pull_request_url` (M21.7, migration 0066); `null` when SCP recorded no link (a row written before the column existed, an authoring run whose outcome carried no readable `html_url`). NEVER SYNTHESISED from `repo` + `pullRequestNumber`: the provider is not known here (a Gitea-authored bump composed as a GitHub URL would 404), and a guessed link is a fabricated record. A consumer links only when this is non-null.

### §172. When SCP RECORDED THE AUTHORSHIP

When SCP RECORDED THE AUTHORSHIP: the change and its branch were proposed and the `dependency_bump_dispatch` Decision written, in one transaction. The plugin trigger that actually opens the pull request runs AFTER that transaction, so this timestamp proves the record, not the trigger — a bump whose trigger failed is listed identically to one whose pull request is merely pending. `pullRequestNumber: null` therefore reads as "no pull request recorded", never as "pending". A stored trigger outcome is M21.7's.

## `packages/schemas/src/doctor.ts`

### §173. The operational self-check surface behind the command

`GET /api/v1/doctor` — the operational self-check surface behind `scp doctor`.

READ-ONLY, and deliberately so: every check here reports a condition whose remedy depends on which side of a mismatch is wrong, which is an operator decision, not a platform one. There is no companion repair endpoint for the same reason `GET /graph/integrity` has none — a bulk-repair door would be a second, cheaper way to mutate state that skips the audit event and journal entry the ordinary doors write (charter principle 6).

A LIST of checks rather than one bespoke payload because more of them are already queued behind this: ADR-0003 names `scp doctor` as the read-only surface for a deployment's executor-egress allowance, and docs/proposals/coupled-pipelines.md names it for "a required key with no prospective producer". Those arrive as additional entries, not as new endpoints.

### §174. The full operator-facing explanation, newline-separated

The full operator-facing explanation, newline-separated: what is wrong, why it is silent, how it happens, and what to do. Authored server-side so the boot log, this endpoint and `scp doctor` cannot drift from each other.

## `packages/schemas/src/domain-ids.ts`

### §175. Branded domain-id types

Branded domain-id types — [ADR-0021](../../../docs/adr/0021-terminology.md) D4, follow-on (i).

`domainId` in this codebase carries **two structurally identical but semantically incompatible** senses, both stored as plain `uuid`, historically with zero type-level separation:

1. **The trust / security-domain sense** — the federation identity of a whole SCP deployment: `federation_self.domainId`, `federation_peers.id`, every `peerDomainId`, every `originDomainId` (federation provenance), and `changes.importedFromDomain`. Per ADR-0021 D4 the preferred prose term for this tier is **security domain** (CNSSI-4009); `TrustDomainId` keeps the established `trust domain (partition)` spelling of ADR-0016, which remains valid. 2. **The containment sense** — `objects.domainId`, **the containment parent (any object; a domain in the common case)**. The canonical chain is org → containment domain → service → component, but the column is a bare `uuid` with no FK and `resolveContainmentParent` (`apps/server/src/graph/objects-repo.ts`) applies no type filter, so a `service.id` or a `component.id` is accepted and shipped tests pass exactly those. Nothing to do with trust.

The two sat nine lines apart on the same `objects` table (`domainId` vs `originDomainId`), both plain `uuid`, so passing one where the other was expected compiled cleanly. Branding makes that collision **uncompilable** rather than a naming convention someone has to remember.

## A third thing wore the name — it was renamed, not branded

`PluginContext` (`packages/plugin-api/src/index.ts`) used to carry a `domainId` that was neither of the above: an opaque **plugin-host scope key**, populated in-tree with non-UUID literals (`"default"`, `"commander"`, `"shared"`, `"domain-1"`). Branding it was impossible — it is not an id — so on **2026-07-24** the owner decided to rename it instead: `PluginContext.domainId` is now **`PluginContext.scopeKey`** (ADR-0021 D4), a deliberately unbranded plain `string`. Only two senses of `domainId` remain in the tree, and both are branded here.

## Where the brand stops

At the **API edge**. Zod request/response schemas and the generated SDK stay plain `string`, so branding costs no `/v1` change and produces no codegen drift. Brands are erased at runtime — a `TrustDomainId` *is* its string at every wire, SQL, and JSON boundary. The constructors below are therefore pure identity functions; their only job is to mark the exact line where an unbranded string was asserted to be one sense or the other, so those boundaries are greppable.

## The idiom

`string & { readonly [brand]: true }` with a module-private `declare const … : unique symbol`. `unique symbol` is only legal on a `const` declaration, so it cannot be written inline in the type; the `declare const` is type-only and erases completely. Because the brand symbols are not exported, no code outside this module can construct a branded value except through the constructors — the nominal typing is genuine, not a convention.

### §176. The stable identity of a **security domain**

The stable identity of a **security domain** (trust tier / partition) in federation — the value in `federation_self.domainId`, `federation_peers.id`, `peerDomainId`, `originDomainId`, and `changes.importedFromDomain`. A UUIDv7, generated once per domain and never reused.

### §177. The id of **the containment parent

The id of **the containment parent (any object; a domain in the common case)** — the value in `objects.domainId`. Never a federation identity.

The brand asserts the SENSE ("this is a containment placement, not a trust identity"), never the TYPE of the object it names. `objects.domain_id` has no FK (`drizzle/0001_graph_core.sql:32`) and `resolveContainmentParent` applies no type filter, so a service id or a component id is a valid `ContainmentDomainId` — and is what several shipped tests pass. Do not write a check, a doc, or a review comment that assumes a `domain` object here.

### §178. Assert that an unbranded string is a **trust**

Assert that an unbranded string is a **trust** (security-domain) id. Use ONLY at a boundary where the string demonstrably came from a trust-sense source: a wire/DB/JSON value, a validated request field, a certificate SAN, or a freshly minted domain identity. Never use it to convert a `ContainmentDomainId` — that is a real bug, not a typing inconvenience.

### §179. Assert that an unbranded string is a **containment-sense** id

Assert that an unbranded string is a **containment-sense** id. Use ONLY at a boundary where the string demonstrably came from a containment-sense source: a graph row, a validated request field naming a containment parent (any object; a domain in the common case), or a resolved containment parent. Never use it to convert a `TrustDomainId`.

## `packages/schemas/src/events.ts`

### §180. The live event stream's wire contract

The live event stream's wire contract (`GET /events/stream`, DESIGN.md §6/§8) — one `data:` frame per relayed outbox row, org-scoped by the server.

This schema is the whole point of the SSE API-parity work: until it existed the stream was the one endpoint absent from `openapi.v1.json`, so no generated operation, no generated type, and no `responseValidator` covered it — `apps/web` cast raw network bytes to an interface it declared itself (ADR-0023's "GET /events/stream is not in the spec at all"). Declaring it here puts every frame through the same Zod validation as every JSON response body: the generated SSE client awaits `responseValidator` on each parsed frame before yielding it.

The CloudEvents-shaped envelope mirrors `events/outbox-repo.ts`; `data` is deliberately unconstrained — it is the per-event-type payload, and pinning a union here would make every new event type a breaking contract change for a field no consumer dispatches on (they dispatch on `type`).

## `packages/schemas/src/executors.ts`

### §181. M7 Real Executor Integrations wire contract

M7 Real Executor Integrations wire contract (DESIGN.md §11/§12, BUILD_AND_TEST.md §8 M7). `executor_bindings`/`notification_bindings` are projection tables (like M4's `control_bindings`) — no graph-object equivalent exists for "which plugin instance backs this target/channel".

### §182. The executor **Type**

The executor **Type** — the fine, artifact/action-specific routing key that resolves exactly one executor binding (ADR-0007, docs/proposals/executor-type-taxonomy.md). Closed enum, extensible only by deliberate owner decision (D4). Replaces the flat `purpose ∈ {infra, software}`: the two old buckets fanned out — `software → {configuration, a build Type}`, `infra → {infrastructure, configuration}` — so this is a split-and-rename, not a straight alias.

```text
build family → image | rpm | deb | npm | maven | python | go | chart | vm-image
                          (turn source into an artifact)
infrastructure           (stand up / change the IaC substrate)
configuration            (apply declarative desired state to a running system — GitOps sync)
```

`maven`/`python`/`go`/`chart`/`vm-image` were added by the team-pipeline-IaC rework (D13/D24, owner ruling 2026-08-26): D13 reads "Type stays the closed three-value enum", which names this package's **Category** (below), not Type — Type was always meant to cover the full artifact-class vocabulary D13 also lists, and before this it did not. One vocabulary, not two: `ArtifactClass` (`pipeline-behaviors.ts`) is now a DERIVED SUBSET of this enum rather than a hand-written second list, so Type is where a new build kind is actually added.

### §183. The artifact-class taxonomy, derived as a build subset

D13/D24's artifact-class taxonomy, DERIVED as the "build family" subset of `ExecutorTypeSchema` (`@scp/schemas/executors`) — never a second hand-written list. D13's ruling this session: "Type stays the closed three-value enum" describes this package's **Category**, not `ExecutorType`; the resolution was to extend `ExecutorTypeSchema` itself with the missing artifact classes so one vocabulary covers everything, and make this a genuine subset of it.

MECHANISM: `.exclude(["infrastructure", "configuration"])` rather than `.extract([...the nine build members...])`, on purpose. `ExecutorCategorySchema` is closed at exactly three values forever (build/infrastructure/configuration — never stored, never accepted as input, see `executors.ts`), so "the build family" is structurally "every Type that is not infrastructure and not configuration" — a fact that holds by construction, not by enumeration. Excluding the two non-build members means a FUTURE build-family addition to `ExecutorTypeSchema` (another artifact class) is automatically part of `ArtifactClassSchema` with no second edit required and no chance to forget one; `.extract()` would have needed that second edit every time. Both `.exclude()` and `.extract()` are compile-checked against `ExecutorTypeSchema`'s own literal union (a member that does not exist on the base enum fails to type-check), so either direction satisfies "cannot drift" for members that DO exist — this choice is about which one also protects against a forgotten ADD.

### §184. The executor **Category**

The executor **Category** — the coarse, closed, gate-groupable class of change (ADR-0007). It is DERIVED from Type via the static `CATEGORY_OF_TYPE` map below, never stored as a column and never accepted as input: routing and the `UNIQUE(org, target, type)` identity stay on Type; a gate that wants coarse grouping ("gate any build") resolves Category through the map. Exposed as a read-only, derived field on binding / source-mapping / wave-target RESPONSE schemas only.

### §185. The operator's DECLARED classification of a pipeline

The operator's DECLARED classification of a pipeline (ADR-0030 §2). Set on the `source_mappings` row that routes a source into a pipeline; absent (`null`) for an ordinary one.

**This is UI/reporting vocabulary, not an enforcement primitive** (ADR-0030 §3, ADR-0018 §4). It is not threaded into the cross-boundary export gate, and forging or removing it changes NO gate outcome: a dev-built digest promoted across a boundary is still refused unless a passing, digest-bound scan exists for that exact digest. Enforcement keys on the PATH — a change targeting no federation peer never reaches `exportPromotionBundle`, so the gate structurally never applies.

DECLARED, never INFERRED. Nothing parses a branch name looking for "dev": a label named after WHICH BRANCH MATCHED goes false the moment that branch drives a second kind of pipeline, and reading the operator's declaration survives that.

### §186. The DECLARED reach of a source mapping's repo

The DECLARED reach of a source mapping's repo (pipeline-substrate-registry-scan.md §10.6, owner 2026-08-16; migration 0066): `global` = a cross-domain shared repo authored and tracked at the commander (outposts see it only as "source: the commander"); `domain` = tracked only in one domain. Stored NULL = NOT DECLARED → no label rendered, NOTHING inferred (not from the site's federation role, not from the repo host). Orthogonal to `mirrorOfShared` — a `domain`-scope mapping may mirror a global one. Same class of label as `PipelineClassificationSchema` above: UI/reporting/ IaC vocabulary, never a routing or enforcement input — the correlation matcher does not read it.

### §187. Scanner-assignment registry (ADR-0020 §2, proposal §13.3, M13.3a)

Scanner-assignment registry (ADR-0020 §2, proposal §13.3, M13.3a). The commander's promotion scan step reads each artifact's executor Type and selects the managed scan METHOD(S) assigned to that Type. This is REGISTRY DATA keyed on the EXISTING `ExecutorType` taxonomy (owner decision 2026-07-23) — NOT a new content-type axis — so a scanner is assigned to `image`/`rpm`/`deb`/`npm`/ `infrastructure`/`configuration`, the same closed set that already routes executor bindings.

INSTANCE-SCOPED (owner decision 2026-07-23), mirroring `scan_requirement_floors`: no `org_id`, the assignments bind every org on the deployment, operator-authored, tenant-readable. See drizzle/0035_scanner_assignments.sql (RLS mirrors 0029) and routes/scanner-assignments.ts.

FAIL-CLOSED BY DESIGN: a Type with NO assignment (or an empty `methods`) produces NO managed evidence — so E6 refuses that Type's cross-boundary promotion unless valid org-pipeline evidence already covers the digest. An unassigned/empty Type is a deliberate "no managed scanner", never a silent pass. The seed assigns `configuration -> []` for exactly this reason (documented in 0035).

### §188. Multi-region Argo CD

Multi-region Argo CD — the first-class config SURFACE for one outpost owning an Argo CD per region for a single prod environment (M15.6, ADR-0017 §3). This adds NO new object type: a region is an ordinary `deployment-target` carrying `properties.environment` (the env name it belongs to, e.g. "prod") + `properties.region` (e.g. "amer"), and its per-region Argo CD is an ordinary per-region executor binding (1:1, resolved per target via `getExecutorBinding`). The surface is a READ + VALIDATE view of `prod env -> {region -> argocd binding}`; the operator still declares each region by binding it (the existing `PUT /executors/{idOrUrn}/binding`), so nothing on the per-target binding path changes — the view itself is purely additive. It is BACKED by a deploy-time gate (`evaluateRegionalDeployGate`, enforced in the reconcile trigger path): a change to a declared region target with no resolvable executor binding of its type is REFUSED (fail-closed) rather than silently dispatched against the shared default executor.

### §189. True when every region has its own binding of that Type

True iff there is ≥1 region and EVERY region has its own Argo CD binding of `type`. This verdict combines an ENFORCED signal and an ADVISORY one. ENFORCED: every region must resolve SOME executor binding of `type` — an UNBOUND region target is REFUSED at deploy time (a fail-closed block Decision from the reconcile gate, `evaluateRegionalDeployGate`), never silently dispatched against the shared default executor. ADVISORY: each binding should resolve to Argo CD (`isExpectedModule`); a region bound to a non-Argo-CD module makes `valid:false` and is named in `problems`, but still deploys against its bound executor — fix it before relying on it. `problems` names each gap either way.

### §190. Plugin manifests, so config schemas surface as forms

Plugin manifests (DESIGN §11: "config schemas auto-surface as validated config forms in API, CLI, and UI") — a static, in-repo catalog of every bundled M7 plugin's `{id, kind, version, configSchema}`, surfaced so a config FORM can be generated client-side without hand-authoring one per plugin.

### §191. Discovery: proposed objects and relationships, reviewed

Discovery (DESIGN §11 DiscoveryPlugin — "proposed objects + relationships, reviewed/accepted into the graph, never auto-committed"). `discover()`'s raw proposal is returned to the caller for review; nothing is written to the graph until an explicit `POST .../accept`.

### §192. The proposal-local name this object is referenced by

The PROPOSAL-LOCAL name this object is referenced by in `relationships[].fromUrn`/`toUrn` — an alias, not the URN the object will be stored under.

Without it the two halves of a proposal cannot refer to each other, and that was not a theoretical gap: a proposed object carries only `typeId`/`name`, while accept mints `urn:scp:{orgId}:{typeId}:{slug(name)}` (`graph/urn.ts`) — a string a plugin cannot compute, because it contains an org id the plugin has no business knowing and a slug rule that lives server-side. So every plugin-proposed edge named endpoints that resolved to nothing. MEASURED before this field existed, on the gitea plugin's real `discover()` output pushed through the real accept door: `404 object 'urn:scp:component:gitea:acme/widgets/service-a' not found`.

DELIBERATELY AN ALIAS RATHER THAN THE STORED URN. Accept is a HUMAN REVIEW step — the UI/CLI flow renames proposed objects before accepting them (both end-to-end discovery tests do exactly that). An endpoint reference derived from the name would break under precisely the edit the review exists to make; an alias the reviewer never touches survives it.

Batch-local, and enforced so: accept refuses a proposal whose declared alias already names a live object, and refuses two proposed objects declaring the same one.

### §193. A `source_mapping` to create alongside an imported object

A `source_mapping` to create alongside an imported object (M12 P5, owner ruling Q3, github-webhook path) — so an imported component actually SELF-REPORTS releases via `observe()`/webhooks, not just being triggerable. References the object BY NAME (created in the same accept batch), exactly like a proposal binding. For an argocd import the discover step fills `sourceKind:'github'` + `repoPattern:<spec.source.repoURL>` (correlation matches on source_kind + repo/path globs; argocd's own events carry no repo, so releases are correlated from the underlying git repo's webhooks).

### §194. `POST /discovery/scaffold` (ADR-0047)

`POST /discovery/scaffold` (ADR-0047) — turn a discovery proposal into IaC SOURCE.

The replacement for `accept`, and deliberately a different SHAPE rather than the same verb with a flag: it writes nothing, reads nothing, and returns text. Its whole job is to run the emitter that `scp iac scaffold` runs, so the wizard and the CLI produce the same code from the same proposal.

WHY IT IS A SERVER ENDPOINT AND NOT A BROWSER IMPORT. `apps/web` may import only `@scp/sdk` and `@scp/schemas` — never `@scp/coordination-as-code`, `@scp/cli` or the server (eslint `no-restricted-imports`, the API -> SDK -> CLI -> IaC -> UI chain). The UI gets everything through the public API, and the emitter is no exception.

### §195. `POST /discovery/accept` AND ITS TWO SCHEMAS ARE GONE

`POST /discovery/accept` AND ITS TWO SCHEMAS ARE GONE (ADR-0047; team-pipeline-iac D1, section 14 resolution 3). Discovery is a SCAFFOLDER: `discovery/run` still proposes, and its output becomes IaC construct code a human reviews and commits, never a direct graph write.

The route was the only observation-driven write path, and it bypassed strict create — the homelab's ~50 imported components landed as RBAC orphans through it. Its replacement is `scp iac scaffold` and the /connect wizards, which emit code instead of rows.

Removed rather than deprecated: dev-stage, no external usage, so no transition window (res 3). The break is logged in `tools/openapi/OASDIFF-EXCEPTIONS.md`.

### §196. That backfill route and its two schemas are gone

`POST /discovery/backfill-source-mappings` AND ITS TWO SCHEMAS ARE GONE, following `accept` the same way ADR-0047 said they would (team-pipeline-iac section 13: it "survives until the estate migration completes, then is removed the same way").

It repaired components imported BEFORE discovery emitted mappings. That population is CLOSED: `discovery/accept` was the door that created mapping-less components and it no longer exists, so nothing can add to the set. The repair path for a component that predates the change is to adopt it into a stack (`scp iac export` carries any mappings it already has) and declare the source in the manifest — the ordinary `sourceMappings` collection, reconciled on apply, which is where mappings are authored now.

Removed rather than deprecated, on the same dev-stage ground as accept. Logged in `tools/openapi/OASDIFF-EXCEPTIONS.md`.

### §197. `scp change-source report`

`scp change-source report` (DESIGN §12 Mode 1: "a one-line CLI step... reports plan/apply results"). Bound to its OWN typed route, `POST /change-sources/{sourceKind}/report` (routes/change-sources.ts, operationId `reportChangeSource`) — the typed, PAT-authenticated counterpart to the raw `/webhook` ingress. Same persist-then-process engine path (one `change_source_events` row, processed by `coordination/webhook-processor.ts`), not a new one.

### §198. Strict, so unknown properties are refused on the wire

M10.6 (`.strict()`, `additionalProperties:false` — BUILD_AND_TEST.md §8 M10.6): "a REQUIRED structured-evidence report schema... the discipline that separates it from a 'call any URL' bus and makes every coordinate-generic verdict real." Before this, an unknown field (a typo, or an attempt to smuggle something the contract doesn't define — e.g. an SBOM DOCUMENT inside an SBOM REFERENCE, `SbomRefSchema`'s own `.strict()` a few fields below) was SILENTLY STRIPPED by Zod's default object parse: the report still 202'd and the extra field just vanished with no signal, same class of hazard `federation.ts`'s `CreateOutpostConfigRequestSchema` doc comment describes (review round 5, N6) — a client believing it declared something got a success and watched the field disappear. Refusing (400, naming the key) costs nothing in the field this route actually needs open-ended: `planJson` stays `z.unknown()`, so a full plan JSON blob is still accepted verbatim inside its own declared field.

### §199. Correlation hint: the fully-qualified git ref

Correlation hint: the fully-qualified git ref (`refs/heads/dev`) this release was built from, matched against a mapping's `ref_pattern` (ADR-0030 §1).

It has to be declared HERE, not merely read by the processor's generic hint extractor: this is a `strictObject`, so an undeclared `ref` on a report body is REFUSED outright — a CI step reporting a ref-scoped dev build would have got a validation error rather than a route.

### §200. The built commit this release came from, not a ref

The BUILT COMMIT this release was produced from — the git sha, not a ref.

Declared for the SAME reason `ref` above is, and found the same way: this is a `strictObject`, so until it was declared a CI step sending `commitSha` got a 400 rather than a route. The processor's generic hint extractor has always READ this key (`commitShaFromPayload`) and every provider webhook adapter has always supplied one — so a commit reached `sourceRef` from a raw push payload and could not reach it from the TYPED report door at all.

That gap is load-bearing for D23: `deriveCapturedWorkflow` needs the built commit as one of the three facts a hook run's `captured_workflow` is assembled from, and it will not substitute "whatever the branch holds now". Without this field a change created through the typed report route could never carry a pin, and every gate depending on one would hold forever with a correctly-named reason and no way for the reporter to fix it.

### §201. The same shape as a change's own prerequisite list

M12 P4B — the SAME shape as `CreateChangeRequestSchema.requires`: cross-change prerequisites `{key, at}`. `at` (id or URN) is resolved at PROPOSE time exactly as `POST /changes` resolves it — but this route is persist-then-process, so a bad `at` cannot 404 the reporter: it is recorded by the processor as a refused event (Decision + audit, event marked processed with no resulting change), never a silent drop and never a silent forever-wait.

### §202. ADR-0028 stage-scoped component coupling

ADR-0028 stage-scoped component coupling — the SAME shape as `CreateChangeRequestSchema.stageDependencies`: components this release's component must not deploy AHEAD OF at a shared place. This route is THE declaration channel (owner ruling D2): a microservice's own CI knows what it calls, and nothing SCP observes carries inter-component dependency data — it cannot be inferred, only declared. Threaded by `webhook-processor.ts` into `proposeChange` identically to `POST /changes`, with the same propose-time resolution of `dependsOn`/`atTargets`; as with `requires`, an unresolvable ref cannot 404 this persist-then-process route, so the processor records it as a refused event.

### §203. D23 (team-pipeline-iac increment 8)

D23 (team-pipeline-iac increment 8) — a REFERENCE to the TEST BUNDLE the build captured at this commit: the workflows this component's hooks name, bundled as an OCI artifact beside the image so a domain that provably cannot reach the source repo still runs the same tests.

MODELLED ON `sbom` DIRECTLY ABOVE, field for field, and the parallel is the point. OPTIONAL and purely ADDITIVE: every existing reporter keeps working unchanged. SCP stores the reference on the change's `sourceRef.testBundle` (`coordination/webhook-processor.ts`) and NEVER the bundle BYTES — it neither builds nor signs a test bundle (charter: coordinate, not execute).

WHAT THIS DELIBERATELY IS NOT: reporting a bundle does NOT mint an `artifact` object. ADR-0045 D2 keeps minting at promotion export and import only — "an artifact object means SCP attested it", and a build report is the executor's claim, not the commander's attestation. The reference reported here is what the export path later reads to put the bundle in the promotion manifest, which is where the one mint happens.

WHY IT MUST BE DECLARED HERE rather than merely read by the processor's generic hint extractor: this is a `strictObject`, so an undeclared `testBundle` on a report body is REFUSED outright (400 naming the key). A CI step reporting its captured bundle would have got a validation error rather than a route — the same trap `ref` above records.

### §204. D13 (team-pipeline-iac increment 8)

D13 (team-pipeline-iac increment 8) — WHAT THE BUILD ACTUALLY PRODUCED, so the class the pipeline DECLARED can be verified against it instead of assumed.

MODELLED ON `sbom` / `testBundle` above: OPTIONAL and purely ADDITIVE, so every existing reporter keeps working unchanged and a report that omits it is byte-for-byte unaffected. Absent yields the `unverified` verdict, which is deliberately spelled apart from `match` — "no evidence yet" must be a visible state, never an assumed pass.

WHY VERIFY AT ALL, GIVEN THE ENUM IS CLOSED AND TYPE-CHECKED: the closed enum stops a typo, not a lie. The declared class selects the journey template — an image builds/pushes/bumps/syncs, an RPM builds/publishes/batch-installs — so a component that declares `image` and actually produces an RPM gets an entire journey shaped for bytes it does not have, and every step "succeeds" against nothing. That failure is silent precisely because each individual step is fine.

WHAT THIS IS NOT: a trust boundary. Both sides of the comparison are the team's own — the `source_mappings.type` declaration and this report — so a reporter that lies in BOTH places is consistent and passes. That is the honest scope: this catches the two declarations DISAGREEING, which is the misconfiguration D13 names, and it is not a defence against a hostile reporter. The E6 self-exemption fix on the D23 path is the standing reminder of the difference: a value the subject supplies is only as narrow as the subject chooses to make it.

## `packages/schemas/src/federation-journal.test.ts`

### §205. THE END-TO-END PROOF that `verifyJournalChain`

THE END-TO-END PROOF that `verifyJournalChain` — documented in this module as "the fail-closed gate a tampered or truncated segment must never pass" — actually covers what a peer can put in a payload.

On the base commit it did not. `canonicalStringify` dropped any `__proto__` subtree, so a peer could append arbitrary content to a SIGNED entry's payload and the recomputed `rowHash` came out identical, the signature still verified, and `valid` came back `true`. The tamper was invisible precisely BECAUSE the canonicalizer refused to look at it.

### §206. Snapshot every Object.prototype key, not three named ones

A full snapshot of `Object.prototype`'s own property names, captured at module load. Asserting that three named keys are absent only proves those three are absent; this proves NOTHING was added or removed. A leaked pollution would make every later assertion in the run untrustworthy, so it is checked rather than assumed.

## `packages/schemas/src/federation-journal.ts`

### §207. Sync-journal hash-chain + Ed25519 signing/verification

Sync-journal hash-chain + Ed25519 signing/verification (DESIGN.md §13) — deliberately NOT part of this package's default `"."` export, for the exact reason `audit-chain.ts` isn't: it depends on Node's `node:crypto`, and `@scp/schemas`'s default entry is imported by `apps/web` (browser build) via `@scp/sdk`. Import via the `@scp/schemas/federation-journal` subpath instead (apps/server's federation module, `packages/cli`'s `scp federation` commands), keeping `node:crypto` out of any module graph Rollup resolves starting from the package's main entry.

Pure functions throughout (BUILD_AND_TEST.md §4.1/§7 — `federation/journal` is one of the modules held to ≥95% branch coverage): no I/O, table-driven-testable, safe to run both server-side (writing/verifying the journal) and client-side (`scp federation import` verifying a bundle before ever touching the DB).

SECURITY-SENSITIVE (M6 PR body flag): `verifyJournalChain` is the fail-closed gate a tampered or truncated segment must never pass — a bad signature, a broken hash link, a sequence gap, or a reordering all return `valid: false`, and callers MUST reject the entire segment/bundle on any such result (never apply a "mostly valid" prefix implicitly — callers that want partial-prefix application must slice the input themselves BEFORE calling this and treat that as a deliberate choice, not verification's default).

### §208. Deterministic JSON serialization

Deterministic JSON serialization (recursively sorted object keys) — an alias for the repo's single canonicalizer, `./canonical-json.ts` (read its doc comment; the reasoning lives there).

WHY `canonicalizeJournalEntry` NEEDS IT — SECURITY-SENSITIVE bug this fixes (caught by M6's own integration tests): `payload` is a free-form nested object that round-trips through a Postgres `jsonb` column, which does NOT guarantee preserving the original key insertion order. A row_hash computed with plain `JSON.stringify` at WRITE time (using the in-memory object's original key order) would then MISMATCH the same computation recomputed at VERIFY time against the entry as read back from the database — a false-positive "tampered" rejection on every single legitimately unmodified row, the moment it round-trips through storage.

This used to be a local copy of that helper, "duplicated (rather than imported) from `apps/server/src/graph/objects-repo.ts`'s identical helper because this package must stay server-independent". The module boundary was right; the duplication was not the way to keep it, and it is why a canonicalization defect that silently dropped `__proto__` subtrees — making two materially different payloads share one `rowHash` and one Ed25519 signature — existed in five files simultaneously. The shared home is inside THIS package, so the boundary still holds.

### §209. Signs a journal row's hash with the origin's private key

Signs a journal row's `rowHash` with the origin domain's Ed25519 private key (PKCS8 DER, base64). Signing the hash — rather than re-signing the full entry content — is sufficient: the hash is already a binding cryptographic commitment to `prevHash` (chain position) plus every content field, so a signature over it transitively authenticates the whole chain up to and including this entry.

### §210. WHY THE FAILURE IS CODED, not just described

WHY THE FAILURE IS CODED, not just described. Two of these mean "the run I was shown is not gap-free" — which is what a DELIBERATELY SCOPE-FILTERED sender produces — while the rest mean "this content is not what its signer produced". Callers that must tell those two apart (see `import-repo.ts`: a receiver at `full` facing a narrower sender) were otherwise left matching on prose, which is exactly the kind of coupling that rots. `reason` stays the human string.

### §211. Verifies chain contiguity and signature for a run

Verifies hash-chain contiguity AND Ed25519 signature for a contiguous run of entries from ONE origin domain, already sorted ascending by `sequence`. `resolvePublicKey` returns the public key in force for a given entry (callers resolve this from their peer-key registry, honoring rotation history — a segment signed before a rotation must still verify against the OLD key that was current at signing time); returning `null` is treated as "no key available" and fails closed.

Checks, in order, for every entry: (1) `sequence` is exactly one more than the previous entry's (or equals the caller-supplied starting sequence for the first entry) — catches gaps AND reordering; (2) `prevHash` matches the running expected hash — catches truncation/splicing; (3) `rowHash` recomputes correctly — catches content tampering; (4) the signature verifies against the resolved public key — catches a forged row that happens to hash-chain correctly (impossible without the private key, but checked independently regardless). ANY failure returns `valid: false` immediately — the caller must reject the WHOLE input, never apply a valid prefix implicitly.

### §212. The sequence the first entry must equal

The sequence the first entry must equal (omit = accept whatever the first entry claims, provided everything after it is contiguous — callers resuming from a cursor should pass `cursor + 1` here so a caller can't be fed a segment that silently skips entries). When `contiguous === false` this is a LOWER BOUND (first entry's sequence must be >= it) rather than an exact match.

### §213. Whether the run must be gap-free and prev_hash-linked

Whether the run must be gap-free and prev_hash-linked (default true — a peer's contiguous own journal). Pass `false` for a SCOPE-FILTERED bundle (MAJOR review fix — confidentiality: scoped peers now receive ONLY their in-scope entries, so the sequence has deliberate gaps and each entry's `prevHash` points at the omitted full-chain predecessor this side never sees). In sparse mode every entry's `rowHash` and Ed25519 signature are STILL verified and `sequence` must be strictly increasing — forgery/reorder are still caught; only OMISSION of in-scope entries becomes undetectable, which is inherent to scoping (you cannot prove completeness of a chain you are deliberately only shown part of) and is the documented scope tradeoff.

### §214. I hold no anchor, said out loud rather than faked

SECURITY-SENSITIVE — "I HOLD NO ANCHOR", said out loud instead of faked with genesis.

`expectedPrevHash: undefined` means genesis, i.e. "this run must be the START of the chain". That is a real, checkable claim, and it is the WRONG one for a caller resuming mid-chain that simply never recorded a row hash (see `import-repo.ts`: a receiver whose own `sync_scope` was narrow advances its cursor with a null hash, because the range tail may be an entry it was never shown). Such a caller has nothing to compare against; comparing against genesis is not a weaker check, it is a check that can only ever FAIL, which is how a widened receiver used to wedge permanently.

`true` therefore ADOPTS the first entry's `prevHash` as the anchor instead of comparing it, and chains strictly from there. It relaxes exactly one comparison, on the first entry only: `expectedStartSequence` still pins where the run must begin (so nothing can be skipped), every later entry's `prevHash` is still linked, and every `rowHash` and signature is still verified — so a run with a deleted MIDDLE entry is still refused. Callers must gate it on a LOCAL, AUTHENTICATED operator action, never on anything the sender supplied; passing it together with `expectedPrevHash` is a contradiction (the anchor wins is not defined — don't).

## `packages/schemas/src/federation.ts`

### §215. M6 Federation wire contract

M6 Federation wire contract (DESIGN.md §13, BUILD_AND_TEST.md §8 M6) — Zod schemas/types only. The hashing/signing/verification algorithms (which need `node:crypto`, so they can't be part of this package's browser-importable default entry — `apps/web` imports `@scp/schemas` via `@scp/sdk`) live in `federation-journal.ts`, the `@scp/schemas/federation-journal` subpath — same split as `audit.ts` / `audit-chain.ts`.

### §216. The three federation-role tiers

The three federation-role tiers (owner decision, 2026-07-15 — clean break from the earlier `parent`/`child` vocabulary; see docs/adr/0004-service-naming-commander-outpost-retrans.md):

- `commander` — the top/central service: the single source of truth for global config (the charter's Global Coordination Layer). Replaces the old `parent` role. - `outpost` — a lower/environment-specific domain instance (e.g. `commercial-amer`, `commercial-apac`, `federal`, `airgap-1`). One per environment/region. Replaces the old `child` role. - `retrans` (retransmission) — a NEW role for the CDS (cross-domain solution) boundary. It deliberately does much LESS than an outpost: it still validates (signature/hash-chain verification, same fail-closed checks as any import), but does essentially nothing beyond that plus pushing the artifact up through the CDS. It never originates config, never holds local authoritative objects, and never terminates a promotion — it is a store-and-forward validation relay. No new CDS transfer logic ships with this declaration; that lands with the dedicated CDS work.

### §217. OUTPOST-RUN PROBES (team-pipeline-iac D11/D23)

OUTPOST-RUN PROBES (team-pipeline-iac D11/D23). Three kinds, added together under one `api-v2-exception` because `entryKind` appears in two RESPONSES (`/federation/exports`, `/federation/resync`) and a response enum-value addition is breaking under `tools/openapi/ check.sh` — measured, not assumed. See `tools/openapi/OASDIFF-EXCEPTIONS.md`.

WHY THE JOURNAL AND NOT THE GRAPH: a `pipeline_hooks` row is deliberately a side table whose ownership DERIVES from `component_object_id` (migration 0096's header). Making hooks graph objects to ride `object_upsert` for free would reverse that decision; these carry the row.

DIRECTION IS PART OF THE MEANING. The two `pipeline_hook_*` kinds travel commander -> outpost (the WHAT: which probe to run). `pipeline_evidence_upsert` travels outpost -> commander (the RESULT). An outpost never authors a hook and a commander never authors probe evidence — that asymmetry is enforced in `scope-filter.ts` and re-checked at import, because a journal is signed but its CONTENTS are still a peer's claim.

### §218. This domain's cosign verification public key

M17.3 (E5) — this domain's cosign MANIFEST-VERIFICATION public key (`cosign.pub` PEM), the non-secret half of the org's `instance_cosign_keys` keypair. Distributed to peers via the SAME out-of-band pairing exchange as `publicKey` (the operator copies `scp federation status`/`self` output into the other side's `scp federation pair`), so an air-gapped peer that only receives files gets it with ZERO new transport. Verification of a cosign-signed promotion manifest AGAINST this key is E6/M17.4 — this increment only distributes it. `null` until lazily provisioned; optional so an older peer/client that never carried it still parses. NEVER the private half.

### §219. The per-peer delivery target, and what it addresses

M13.2a — DeliveryTarget (docs/proposals/airgap-cds-validate-promote.md §13.2). WHERE a signed channel artifact (a `.scpbundle` or an `scp-relay-*.tar.gz` byte tarball) is dropped for — or picked up from — one peer's CDS crossing. Per-peer configuration BESIDE `syncScope`; absent per-peer config falls back to the instance env (`SCP_RELAY_OUT_DIR`/`SCP_RELAY_IN_DIR` — PR #112's behavior, unchanged). SCP hands files TO the CDS; it never operates the CDS (charter principle 1) — everything past the drop is the org's CDS product.

### §220. An S3 object-key PREFIX per direction

An S3 object-key PREFIX per direction: relative (no leading `/`), traversal-free. The resolver normalizes a non-empty prefix to end in `/` before it is joined with the file basename, so a prefix `inbox` and a prefix `inbox/` address the same location. Empty/omitted ⇒ bucket root. A prefix is NOT an endpoint — it never widens which bucket/endpoint is reachable, so it needs no allowlist (unlike `endpoint`/`bucket`); it only scopes keys WITHIN the allowlisted bucket.

### §221. 13.2b — the `s3-compatible` provider

13.2b — the `s3-compatible` provider (proposal §13.2, owner decision D3: AWS SDK v3). WHERE a signed channel artifact is put/listed/got via an S3 API: an `endpoint` + `bucket`, with a per-direction key prefix. Driven with the SDK's `endpoint` override + `forcePathStyle` so MinIO and other S3-compatibles work, and `@aws-sdk/lib-storage`'s managed MULTIPART upload so a multi-GB relay tarball drops without a hand-rolled `PutObject`.

ENDPOINT/BUCKET IS OPERATOR CONFIG, NEVER BUNDLE-STEERED (the ADR-0019 §4 symmetry, load-bearing): `endpoint`/`bucket` are a data-supplied EGRESS target set by an org admin with `federation:write`, the same shape of hazard the filesystem `outDir`/`inDir` are — so they get the SAME operator allowlist treatment `SCP_DELIVERY_ROOTS` gives directories: an operator-declared endpoint/bucket allowlist (`SCP_DELIVERY_S3_ENDPOINTS`), enforced at BOTH pair-time (never store an out-of-allowlist target) and fail-closed at resolution (a stored out-of-allowlist target is a named per-gap problem, never used). UNSET allowlist + any s3 target ⇒ FAIL-CLOSED (refuse). A tenant must NEVER steer delivery to an arbitrary S3 endpoint. Credentials are NOT here — they live in the vault under `delivery/<peer>/<direction>` (ADR-0019 §3 artifact-store class), resolved at use, never in config.

### §222. PERMISSIVE RESPONSE VIEW of a DeliveryTarget

PERMISSIVE RESPONSE VIEW of a DeliveryTarget — the shape RESPONSE bodies advertise, deliberately NOT a discriminatedUnion. A strict `oneOf` in a RESPONSE is inherently NON-additive: every new provider member is an oasdiff `response-property-one-of-added` BREAKING change (a strict client generated against the old contract might reject the new variant). We dodge that permanently by advertising ONE open object that is a SUPERSET of every provider's fields — `provider` a plain string, all fields optional, no `oneOf`/discriminator — so adding the Nth provider only ever adds OPTIONAL properties (additive), never a union member. The stored strict-union value serialized on the wire is unchanged and is always a valid instance of this superset; this is a TYPE/CONTRACT loosening only, no runtime/behavior change. REQUESTS keep the strict `DeliveryTargetSchema` union — widening a REQUEST union is permissive-input, NOT oasdiff-breaking.

### §223. The peer's cosign key, carried alongside the other

M17.3 (E5) — the peer's cosign MANIFEST-VERIFICATION public key, carried ALONGSIDE its Ed25519 `publicKey` in the same out-of-band pairing exchange (the operator copies the peer's `scp federation status`/`self` output here). Optional/additive so an OLD pair request that predates E5 still pairs. Registered as this peer's TRUSTED cosign key; a cosign pubkey ever found INSIDE a promotion bundle is only match-checked against this REGISTERED value at verify time (E6/M17.4), never trusted over it — mirroring how approval-evidence `publicKey` is compared, never trusted (promotion-repo.ts).

### §224. M14.1 (ADR-0009, proposal §Config)

M14.1 (ADR-0009, proposal §Config) — per-peer poke-mode. Tri-state on re-pair, mirroring `deliveryTarget`'s additive discipline: ABSENT (undefined) preserves the current setting (an old client that never knew the field can't flip it); `true`/`false` SETS it. Default-off: a peer paired without ever supplying it stays poll-mode. An EFFECTIVE (post-write) `true` requires an https/mTLS-capable EFFECTIVE `baseUrl` (the M14.1 pair-time guard, made total over the merged tuple in M14.3) — the poke must authenticate the caller as the enrolled commander (ADR-0001); full endpoint enforcement is M14.2. So a re-pair can neither set poke-mode true on a non-https peer NOR downgrade `baseUrl` to http while poke-mode stays true. Boolean, not nullable — there is no "clear to null" state, only poll (false) vs poke (true).

### §225. M16.2 phase A (E1) — THE `outpost` GRAPH OBJECT

M16.2 phase A (E1) — THE `outpost` GRAPH OBJECT: commander-authored declared config about one outpost, which SYNCS DOWN because it is an ordinary graph object (`object_upsert`) and nothing written on a `federation_peers` ROW can ever reach a peer (the journal admits 9 entry kinds, none peer-shaped, and `peers-repo.ts` never appends one).

THE AUTHORITY SPLIT — 'outpost' now exists twice, and each half owns disjoint fields: * the `federation_peers` ROW owns TRANSPORT IDENTITY AND REACHABILITY (trust-domain id, keys, `baseUrl`, `syncScope`, `deliveryTarget`, `pokeMode`, scheduler timestamps): local to this side, never journaled, written only by pair/re-pair and the narrow PATCH below; * this OBJECT owns COMMANDER-DECLARED CONFIG (today `trustTier`) plus the `peerDomainId` binding: commander-origin, journaled, read-only at the outpost. Neither can express the other's fields, and THE REQUEST BODIES BELOW ARE WHAT ENFORCES IT: they carry no transport field of any kind and are the only operator-reachable write path, while `federation_peers` has no trust-tier column. The REGISTERED JSON SCHEMA (drizzle/0043) is deliberately NOT the enforcement — it is journaled and Ajv-validated on the RECEIVING side, so a closed schema would turn every future property into a fail-closed version-skew hazard that aborts whole sync bundles (review round 4, H7), and it accordingly carries neither `additionalProperties` nor a tier enum. This comment used to claim otherwise (review round 5, N5). See `federation/outpost-binding.ts` clause (3) for the normative statement and the tests that check it in both directions.

### §226. An owner-ENTERED trust-posture assertion about an outpost

An owner-ENTERED trust-posture assertion about an outpost — NOT derived, NOT negotiated with the outpost, and NOT connectivity. Extendable (new members are additive on a request union and are a new enum member on the response, which is why every response field carrying it is nullable and optional). CONNECTIVITY IS DELIBERATELY ABSENT: whether an outpost is air-gapped is a fact about its transport (`baseUrl`/`deliveryTarget`) and is derived separately — folding it in here would make one field mean two different things. Until an operator sets a tier there is NO value: the property is ABSENT from the object, never blank and never defaulted to `commercial`.

### §227. The members come from the glossary, which is authoritative

THE MEMBERS COME FROM THE GLOSSARY, WHICH IS AUTHORITATIVE FOR VOCABULARY (CLAUDE.md). The trust tier IS the SECURITY DOMAIN (`docs/GLOSSARY.md` "security domain": "In CommanderSCP this is the trust tier"), whose values that entry and the stage grammar give as `commercial`, `govcloud`, `il5`, `airgap`, plus FedRAMP in prose; ADR-0011 says "FedRAMP-High / IL5 / air-gap". The first cut of this enum was `['commercial','fedramp-high','il5']`, which left a GOVCLOUD outpost with NO representable value — an operator had to leave the tier unknown or assert `commercial`, an INVENTED POSTURE, which is the exact failure this milestone exists to prevent. See ADR-0022 for the alignment and for the one open item (`fedramp-high` carries a hyphen, so it is not usable as a stage `<domain>` SEGMENT).

### §228. Declare the commander-origin config object for a peer

`POST /federation/outposts` — declare the commander-origin config object for an ALREADY-PAIRED outpost peer. Carries no transport field of any kind: the peer row is the authority for those.

`.strict()` IS THE REFUSAL THE DOCS ALREADY PROMISED (review round 5, N6). Zod's default object parse SILENTLY STRIPS an unknown key, so `{peerDomainId, trustTier, somePhaseBProperty}` answered **201** and stored `{trustTier, peerDomainId}` — nothing false was stored, but a NEWER CLIENT writing a phase-B property to an OLDER commander got a success and watched its field vanish with no signal. That is a real hazard for a federated product whose whole point is version skew across domains, and drizzle/0043, ADR-0022 and `outpost-binding.ts` all described a refusal the operator never saw. An unknown key is now an actionable **400** naming the key. This costs nothing in forward-tolerance: the strictness is at the API, where an OPERATOR is typing; the REGISTERED JSON SCHEMA stays open so a REPLICA from a newer authority is still stored rather than aborting a whole sync bundle (H7 — that asymmetry is the entire design).

### §229. The paired peer this config is ABOUT

The paired peer this config is ABOUT (its trust-domain id = `federation_peers.id`). The peer row must already exist and hold role `outpost`; an unbound id is refused, and a second config object for the same peer conflicts. Since pipeline-substrate-registry-scan.md §10.5 the second accepted value is THIS instance's own domain id (`GET /federation/self`) — the HQ OUTPOST (formerly 'co-located'; GLOSSARY, ADR-0021 D7) — accepted only from a `commander`-role instance (an outpost's own record is commander-declared and arrives replicated; any other role is a 400).

### §230. Edit the commander-origin config for an outpost

`PATCH /federation/outposts/{peerDomainId}` — edit the commander-origin config. Absent means PRESERVE. `peerDomainId` is not patchable: the binding IS the object's identity.

`.strict()` for the same reason as the create body (review round 5, N6) — and it also makes the "not patchable" sentence above ENFORCED rather than merely stated: sending `peerDomainId` here now 400s instead of being quietly dropped, which is a materially clearer answer for a client that believed it was re-binding the object.

### §231. Review round 4 — ORIGIN-VS-SELF, resolved server-side

Review round 4 — ORIGIN-VS-SELF, resolved server-side. `true` on the instance that AUTHORED this config (the commander); `false` for the read-only replica an outpost holds, and for any foreign-origin copy. `originDomainId` alone cannot answer this: a client would have to already know the reading instance's own domain id to compare against, and phase B would then be one join away from rendering someone else's copy as this instance's own assertion.

### §232. pipeline-substrate-registry-scan.md §10.5 — THE HQ OUTPOST

pipeline-substrate-registry-scan.md §10.5 — THE HQ OUTPOST. `true` when `peerDomainId` is the READING instance's OWN trust domain (`federation_self.domainId`): the record describes this instance's own domain as an outpost (the commander-and-outpost-are-one case), and there is NO `federation_peers` row to join it to — every consumer that joins an outpost record to its peer row (peer name, role, transport, sync state) must render this record as "this instance" instead, taking name and role from `federation_self`. `false` for a record bound to a paired peer (a FIELD outpost — any outpost in another trust domain). Resolved server-side for the same reason `originIsSelf` is: a client would otherwise have to already know the reading instance's domain id. NOTE the two flags are independent — on an outpost site its own replica reads `originIsSelf: false` (the commander authored it) and `peerIsSelf: true` (it is about this domain). Optional for additivity.

### §233. THE RECONCILE PRECONDITION TOKEN

THE RECONCILE PRECONDITION TOKEN — one `objectId:version` pair per live claimant the caller PREVIEWED, sent as the repeatable `?ifClaimant=` query parameter (optimistic concurrency).

WHY A PAIR AND NOT A BARE ID. Reconcile's outcome is derived from the set of live `outpost` rows bound to one peer, read INSIDE the write transaction — i.e. after whatever the caller previewed. Three things can change in that window and all three change the outcome: * a claimant APPEARS — a new id enters the set (a locally-authored row can then outrank the shadow the operator meant to adopt, silently DROPPING their entered value); * a claimant DISAPPEARS — an id leaves the set (soft-deleted elsewhere); * a claimant's ORIGIN/PROVENANCE CHANGES — the id is UNCHANGED, so ids alone are blind to it, yet a shadow adopted in the meantime is no longer a shadow and no longer ranks last. `version` catches the third: every writer of `objects` that can restamp `originDomainId` or clear `provenance` bumps `version` unconditionally (`graph/objects-repo.ts` — adoption is `updateObject` with `existing.version + 1`). `revision` would NOT do: it is AUTHOR-assigned on the import path, so it is not locally monotone.

Both halves are already on `OutpostConfigSchema`, so the token is constructible from exactly the array `GET /federation/outposts` returned — no second fetch, no new read-side field, and the request stays CHECKABLE against the preview that was rendered beside it (which an opaque digest or a server-minted ETag would not be).

### §234. The recovery verb, for when the record diverged

`POST /federation/outposts/{peerDomainId}/reconcile` — THE RECOVERY VERB (review round 4). Restores the 1:1 peer↔config binding for a peer whose database holds duplicates: keeps the authoritative row, ADOPTS an unverified hand-filled shadow when nothing authoritative survives (so entered config is not discarded), and removes the remaining surplus rows. Refuses with **409 Conflict** rather than touch a signature-verified replica — the peer demonstrably HAS config on that path (`GET` answers 200 for it), so a 404 would tell a status-keyed consumer "no outpost config" and hide the very authority conflict this door exists to surface. 404 is reserved for the peer that genuinely has no rows at all.

`?keep=<objectId>` (review round 5, N9) names the row that should SURVIVE — absent keeps the most authoritative one, so the default call is unchanged. It exists to close the VERIFIED-DUPLICATE class: a signature-verified foreign-origin duplicate bound to one peer had no public-API recovery at all (PATCH 409, reconcile refuses, `DELETE /objects/outpost/{id}` 403, IaC prune touches only stack-managed objects). Not reachable in canonical hub-and-spoke, but reachable the moment two authoring domains describe one outpost. With `keep`, this domain can DELETE THE ROW IT AUTHORED ITSELF — an ordinary journaled tombstone, re-declarable at any time. Deleting a signature-verified replica stays refused unconditionally: that is what stops this trading a config wedge for a sync wedge. See `federation/outposts-repo.ts`'s `reconcileOutpostConfig`.

`removedObjectIds` WAS ONE BUCKET (review round 6, M1) and that bucket LIED for the local-origin case `?keep=` exists to serve: a removal it reported as an "unverified shadow" tidy-up is, for a row THIS domain authored, an ordinary JOURNALED TOMBSTONE that propagates downstream to the outpost — ordinary local config being permanently dropped and pushed onward, not a stray hand-typed copy being discarded. The two cases are split into two fields so a caller (the CLI, and any future UI) cannot collapse them back into one indistinguishable sentence.

### §235. THE STALE-PRECONDITION REFUSAL BODY

THE STALE-PRECONDITION REFUSAL BODY — `412 Precondition Failed` from `POST /federation/outposts/{peer}/reconcile` when the `?ifClaimant=` set does not match the live claimants read inside the transaction.

412, NOT A SECOND 409. The 409 on this route is the AUTHORITY CONFLICT and it is PERMANENT until the operator chooses differently (`?keep=`); staleness is TRANSIENT and retryable after a re-preview. Collapsing both onto one status turns "choose differently" into "look again, then press the same button" — and consumers here key on status alone. 412 is also already the house's optimistic-concurrency refusal (`updateObject`'s `expectedVersion`). NOT 428: the precondition is optional by design, so the server must never demand one.

`claimants` IS THE POINT. A bare refusal would force a second read and open a second window; the refusal carries the FRESH claimant list so a caller CAN re-render a real preview from the same response, then re-issue with a fresh token, without a second read. It is an RFC 9457 extension member, like the in-house `decision_id`.

NOT EVERY CALLER TAKES THAT OFFER (R3, PR #156 residual). `scp federation outpost reconcile` (`packages/cli/src/cli.ts`) does: it re-previews straight from this body. The Outposts web panel (`apps/web/src/routes/outpost-configuration.tsx`) does not — it treats the 412 as a signal to refetch the list instead, deliberately paying the second round trip this field exists to save.

### §236. Every live config row bound to the peer, at refusal

Every live `outpost` config row bound to the peer AT THE MOMENT OF REFUSAL, most authoritative first — the same projection `GET /federation/outposts` returns, so a caller can re-derive the token from it directly.

OPTIONAL, not required (R1 fix, PR #156 residual). This route today only ever throws `preconditionFailed` with the extension attached (`assertClaimantsUnchanged`), so `claimants` is always present in practice — but the SERIALIZER, not the throw site, is what decides whether a 412 reaching this handler is honest. `updateObject`'s bare `expectedVersion` 412 is unreachable here today only because reconcile never passes one (a prose argument, checked by `apps/server/src/routes/federation-reconcile-412-schema.test.ts`, not a type-level one), and the neighbouring verb already plumbs `expectedVersion` end to end — one refactor away. A REQUIRED field turned that latent reachability into a 500: zod's response serializer drops a response that fails to validate against its schema, and fastify has nothing else to fall back to. Optional means a bare 412 still serializes as 412, with no `claimants` array, which is the honest shape of a refusal that never got the extension.

### §237. M16.2 phase A (E4) — THE NARROW PEER PATCH

M16.2 phase A (E4) — THE NARROW PEER PATCH. `POST /federation/peers` (pair/re-pair) is the only peer write there was, and it is a FOOTGUN for a settings form: `publicKey` is REQUIRED there, and a DIFFERENT value is treated as a KEY ROTATION that supersedes the current key window and hard-revokes the old key (sequence-anchored, `peers-repo.ts`). A UI that round-trips a peer and re-pairs it therefore rotates the peer's trust anchor whenever it drops or mangles the key.

This request body admits NO KEY MATERIAL AT ALL — not `publicKey`, not `cosignPublicKey` — so the PATCH route is STRUCTURALLY incapable of rotating, superseding or revoking a peer key. `role` is likewise absent: a peer's federation role is an identity-level assertion established at pairing, not a settings-form field. Every field is optional and ABSENT MEANS PRESERVE (the same tri-state discipline re-pair uses); `deliveryTarget: null` explicitly CLEARS back to the instance-env fallback. Key rotation stays exactly where it was — a deliberate re-pair.

### §238. The bundle's checksum, the only per-change handle

M16.1 (I1) — the `.scpbundle`'s Ed25519 checksum, the ONLY per-change handle this ledger has (it carries no change/component column). A promotion bundle is 1:1 with a change, and both the exporting and the receiving instance stamp this same value onto that change's `sourceRef` (`federation/boundary-bundle-ref.ts`), which is how the boundary segment answers "which transfers carried THIS change?". Optional/additive — absent for a pre-M16.1 SDK's reads and null on a row recorded without one. Observational only; never authority.

### §239. drizzle/0087 — WHICH LEG this hop was

drizzle/0087 — WHICH LEG this hop was: `'metadata'` (an ordinary `.scpbundle` sync/promotion export or import) or `'bytes'` (a retrans byte-relay hop — `buildRelayTarball`'s submit, `validateAndForwardRelayTarball`'s confirm+submit, `importRelayTarball`'s confirm). Every transfer of `kind:'promotion'` was, until this column, byte-identical on the wire regardless of which of those it was — this field is the one place that provenance is READ (stated by the writer, `bundle-transfers-repo.ts::recordBundleTransfer`'s required-at-callsite parameter), never inferred from `direction`/`kind`/`status` downstream. Optional/additive (an old SDK is unaffected) and nullable — `null` is a genuine "not recorded" (a pre-0087 row, or a writer that could not determine it), never a stand-in for "not asked".

### §240. M14.4 (ADR-0009) — LIVE-PULL FRESHNESS

M14.4 (ADR-0009) — LIVE-PULL FRESHNESS. All optional/additive (an old SDK is unaffected) and nullable ("never"). `lastPullAttemptAt` is stamped on EVERY attempt, `lastPullSuccessAt` only on a successful import — so an attempt with no later success is a peer in the RECONNECT LEG (back on the frequent cadence until one pull succeeds). Distinct from `lastSyncedAt`, which is the last confirmed BUNDLE TRANSFER (the file/air-gap channel), and from `lastAppliedSequence`, which is applied progress — neither records that a pull was ATTEMPTED.

### §241. M16.2 phase A (E3) — PENDING-VS-APPLIED, HONESTLY

M16.2 phase A (E3) — PENDING-VS-APPLIED, HONESTLY. Every field below is optional/additive and nullable ("no observation"), and every NAME says what it MEASURES.

THE ONE-SIDED DERIVATION (the reason there is no `appliedAtPeer` field here, and never will be until M16.4 builds one): `sync_cursors` records only what WE applied FROM a peer, never what a peer applied FROM US; `export-repo.ts` ships only this domain's own entries, so a return bundle cannot carry our sequences back; and `bundle_transfers` has no production UPDATE path, so every EXPORT row is inserted `created` and never advances. The strongest honest commander-side statement is therefore PENDING-EXPORT — "this much of my own journal has not been put into a bundle addressed to that peer yet" — which says NOTHING about what the peer applied. A field named for application at the peer would be a fabrication, so there isn't one.

### §242. Whose assertion the trust tier is, so nothing is faked

Review round 4 — WHOSE assertion `trustTier` is, so a UI cannot render a hand-typed claim as a commander one. `"declared"` = the winning `outpost` object is authoritative for this instance (its own local-origin object on a commander; the signature-verified commander replica on an outpost). `"unverified"` = the only tier available comes from a `provenance:'manual'` hand-filled SHADOW; the value still rides the wire, and `"trustTier"` is ALSO listed in `unknownFields`. `null` = no tier. With two rows bound to one peer the authoritative one always wins — this used to be a last-write-wins map, in which a shadow could silently override the commander's own assertion.

### §243. THE CONFIGURED TRANSPORT CHANNEL

THE CONFIGURED TRANSPORT CHANNEL — config-derived, never an observation, and named for that (review round 4 replaced a `connectivity` field whose `"connected"` value asserted reachability this instance had not observed). `"dialable"` = an https/mTLS `baseUrl` is configured, so this side MAY dial the peer — it does NOT mean the peer has ever been reached; `lastPullAttemptAt`/ `lastPullSuccessAt`/`effectiveCadence` in this same row are the observations, and they do reflect failure. `"air-gap"` = NO base URL and a configured `deliveryTarget` (a file/object channel). `null` = not honestly derivable, declared in `unknownFields`, in two cases: no transport configured at all, or a base URL federation refuses to dial (plain http) — which is a contradictory configuration to surface, not an air-gap posture to infer.

### §244. The fields of this row this instance cannot observe

The fields of THIS peer-status row whose values this instance CANNOT OBSERVE, by name — the same honesty contract `ServiceBoardRowSchema.unknownFields` established. A listed field still carries its null/zero on the wire for shape stability, but that value is NOT an observation and a client must render it as unknown, never as a clean reading.

Optional for additivity; an old SDK simply never sees it. Names that appear here include `"trustTier"` (never asserted, unrecognised, or only an unverified hand-filled claim), `"transportMode"` (no transport configured, or one federation refuses to dial), `"lastSyncedBundleChecksum"`/`"lastExportedBundleChecksum"` (no identified bundle), `"pendingExportEntryCount"` (nothing exported yet), and `"healthRollup"` — a promised Overview field with NO source in this codebase at all, hence ABSENT from the schema and named here so a UI cannot mistake its absence for "healthy".

### §245. The headquarters outpost record, and what it is

pipeline-substrate-registry-scan.md §10.5 — THE HQ OUTPOST RECORD: the `outpost` config object whose `peerDomainId` is `self.domainId`, resolved by the same authority rule `GET /federation/outposts/{peerDomainId}` applies (`peerIsSelf: true` on it). It has NO peer row, so it can never appear in `peers[]`; this is where a client reads it. `null` = this instance's own domain has no outpost record (a stated absence — a client says "no outpost registered", never invents one); absent = an older server that does not resolve it. On an OUTPOST site this is that site's own replica of its config (`originIsSelf: false`). Optional for additivity.

### §246. DIVERGENCE RAIL 2

DIVERGENCE RAIL 2 (multi-region-instance-resilience.md §7.2) — the puller's cursor anchor: the `rowHash` of the entry it has applied AT `sinceSequence`. The exporter compares it against its OWN journal row at that sequence and refuses (`journal_divergence`) on mismatch — proof its tail was rolled back and re-minted after an async-replication failover. Additive & OPTIONAL: only FULL-scope receivers hold a real anchor (a sparse receiver's cursor `rowHash` is null and it omits this), and an un-upgraded puller simply never sends it (rail 1 still covers the strict `sinceSequence > tail` case with no new wire data).

### §247. RFC 9457 problem `type` for a detected journal fork/rollback

RFC 9457 problem `type` for a detected journal fork/rollback (multi-region-instance-resilience.md §7.2 rails 1–5). The FIRST custom problem type in this codebase (every other refusal uses the `about:blank` default) — a URN so it is stable, self-describing, and never a dereferenceable external URL (charter principle 5, air-gap). Exported so the server (throw site), the CLI, and tests all match ONE literal rather than restating it.

### §248. The `journal_divergence` 409 body

The `journal_divergence` 409 body. Extension members carry the exporter's OWN tail at the moment of refusal so an operator (or `scp federation doctor`) can see how far the fork/rollback reaches in one round trip. OPTIONAL, never required (the PR #156 lesson `OutpostReconcileStaleProblemSchema` records: a REQUIRED extension a throw path fails to populate turns a valid 409 into a serializer 500). Rails 1, 2, and 4 all refuse with this shape.

### §249. The `.scpbundle` envelope

The `.scpbundle` envelope (DESIGN §13 file transport). Deliberately NOT a tar/zip archive — see federation-journal.ts's module doc for the robustness rationale — a single bounded, checksummed, signed JSON document instead.

### §250. DIVERGENCE RAIL 4

DIVERGENCE RAIL 4 (multi-region-instance-resilience.md §7.2) — the exporter's SIGNED attestation of its OWN journal tail, carried on EVERY export (even an empty one). Signed over `{exporterDomainId, peerDomainId, tailSequence, tailRowHash}` with the same instance key the bundle uses — the domain ids are bound in so an attestation cannot be replayed onto another bundle. The importer persists it as a MONOTONIC high-water mark per (peer, origin) and refuses `journal_divergence` on any regression or same-height content change — which is what makes a lost/rolled-back tail detectable for a NARROW-scope peer, where rails 1–3 are silent.

### §251. §7.2.6 RESYNC — the SIGNED CROSS-DOMAIN HANDSHAKE

§7.2.6 RESYNC — the SIGNED CROSS-DOMAIN HANDSHAKE. The IMPORTER (the diverged side) sends this to the exporter's `POST /federation/resync`. `requestSignature` is the importer's signature over a canonical `{resync:true, importerDomainId, exporterDomainId}` payload, made with the importer's own instance key — the exporter verifies it against the importer's paired public key, so the request authenticates the importer authorizing a forced overwrite of ITS OWN replica. `peer` is the importer's own domain id (how the exporter knows it as a peer).

### §252. M17.3 (E3) — a TYPED entry in a promotion bundle's artifact set

M17.3 (E3) — a TYPED entry in a promotion bundle's artifact set. The rich source of truth the flat `artifactDigests` array is projected FROM: `artifacts[]` holds both the tracked OCI image(s) (`type: "oci"`) and the build-time SBOM blob (`type: "blob"`), while `artifactDigests` stays as `artifacts.map(a => a.digest)` so an OLDER outpost that reads only `artifactDigests` keeps working.

EXPAND phase (this increment): `artifacts` is OPTIONAL and DELIBERATELY EXCLUDED from the Ed25519 bundle checksum (which stays over `{header, change, controlOutcomes, approvals, artifactDigests}`), so a bundle with `artifacts` present is byte-identical, under the checksum, to a v1 bundle without it — the wire is backward/forward compatible and `formatVersion` stays `1`. The CONTRACT phase (fold `artifacts` into the checksum under `formatVersion 2`, drop `artifactDigests`) is a FUTURE release. NO cosign / signing is introduced here — `signatureRef` merely CARRIES the executor's pre-existing ORIGIN signature reference (empty where none was reported); SCP signs nothing new.

A superset shape holding both artifact kinds: `{type, digest}` are required; `location`/`format` describe a blob (e.g. the SBOM document's storage ref + document format); `signatureRef` is the ORIGIN executor's signature reference for that artifact.

### §253. M17.3 (E6) — the commander's SELF-BINDING promotion MANIFEST

M17.3 (E6) — the commander's SELF-BINDING promotion MANIFEST. A canonical JSON doc the commander cosign-signs (`manifestSignature`, detached) to attest "I, this exporter, authorized promoting THIS change with THIS artifact set toward THIS peer." It rides as a SIBLING of the Ed25519 bundle envelope and is DELIBERATELY EXCLUDED from the Ed25519 checksum (see `PromotionBundleSchema`), so a bundle with a manifest is byte-identical under the checksum to one without it (E3 invariant).

MANIFEST-SWAP DEFENSE (load-bearing): the manifest enumerates `sourceChangeObjectId`, `exporterDomainId`, `peerDomainId`, `changeUrn`, AND the full `artifacts[]` digest set, so a cosign signature computed over one bundle's manifest cannot be lifted onto a DIFFERENT bundle — the self-bound identity would no longer match. SCP signs ONLY this manifest (its own attestation); it NEVER signs an origin artifact (those origin signatures ride untouched in `artifacts[].signatureRef`).

### §254. M15.5(c) — the RETRANS VALIDATE-THEN-RELAY

M15.5(c) — the RETRANS VALIDATE-THEN-RELAY (ADR-0019 §2). The byte tarball itself is a SEPARATE channel artifact (never part of any federation bundle — bundles stay metadata-only, ADR-0009); these are only the API request/response shapes for driving the relay. The tarball crosses the CDS out-of-band as a file, exactly like the `.scpbundle` walk.

### §255. M13.1b — the AUTO-RELAY BUILD LEDGER's OPERATOR READ SURFACE

M13.1b — the AUTO-RELAY BUILD LEDGER's OPERATOR READ SURFACE (owner ask): `GET /federation/relay-builds` so an operator (CLI/API, on the retrans box — a retrans never serves the SPA, M16.3 P3) can see queue depth and exhausted rows without DB surgery. Populated only on a `role: retrans` instance (seeded at promotion import there); on any other role the ledger is honestly empty, so this list is ROLE-AGNOSTIC like every other read in this codebase (empty is the truth, never a 409). Data access: `federation/relay-builds-repo.ts`'s `listRelayBuilds`.

### §256. `GET /federation/relay-builds` response

`GET /federation/relay-builds` response — WRAPPED in `{ items }`, not a bare array.

Precedent survey before choosing: the OLDEST federation list routes (`listFederationPeers`, `listOutpostConfigs`, both this file) return a bare `z.array(...)`. Every NEWER non-cursor list response in this codebase wraps instead — `ExecutorBindingListResponseSchema` / `ScannerAssignmentListResponseSchema` / `PluginManifestListResponseSchema` (executors.ts), `InstanceScanFloorListResponseSchema` (supply-chain.ts) — all a plain `z.object({ items: z.array(...) })`. This route takes a `status` filter + a bounded `limit` with NO cursor (a triage read, not paged enumeration), so `cursorPageResponseSchema` (which additionally promises `nextCursor`) doesn't fit either. `{ items }` is therefore the closest actual precedent, and it keeps the door open to add a count/cursor later without a breaking response-shape change — the thing a bare array can never do additively.

### §257. FEDERATION AUDIT WITNESS

FEDERATION AUDIT WITNESS (multi-region-instance-resilience.md §7.2.7) — `GET /federation/audit-witnesses?originDomainId=`, the OPERATOR READ SURFACE for what this domain has passively witnessed of a peer's audit-chain head. This is what the post-failover runbook's peers-witness comparison (§7.2 step 5) actually reads: `scp audit verify` alone cannot see a truncated chain because any prefix of a valid hash chain verifies as valid, so the comparison needs a peer's independent, earlier-recorded view of the origin's chain. Data access: `federation/audit-witness-repo.ts`'s `listAuditWitnessesForOrigin`.

## `packages/schemas/src/governance-move.ts`

### §258. The contract for the top-down monotone move lattice

`governance:move` ENFORCEMENT — the contract for the top-down monotone lattice that decides whether a containment MOVE additionally requires the `governance:move` permission at both ends. (docs/proposals/governance-reach-on-containment-move.md §9.2; owner ruling 2026-08-18; the server substrate is drizzle/0083 and `apps/server/src/governance/move-enforcement.ts`.)

THE SEMANTICS A CONSUMER MUST KNOW, because none of them are guessable from the field names:

1. ENFORCEMENT IS AN OR, NOT A LOOKUP. A move is governed iff the INSTANCE rung is enabled, or any object on the moved object's containment chain, or any object on the destination's chain, carries a rung. So `GET /objects/{id}/governance-move-enforcement` answers about ONE object's chain, and a move involving it may be governed by the OTHER end even when this read says `enforced: false`. 2. THE INSTANCE RUNG ACTIVATES; IT DOES NOT PERMIT (owner decision Q1-A). Enabled at the instance means enforced for every org on the deployment, and no org may disable it. This is the one place it differs in meaning from the `dependency_subscription_unlock` whose storage shape it copies — that one unlocks and activates nothing. 3. AN ENABLEMENT ABOVE CANNOT BE UNDONE BELOW. `DELETE …/rungs/{idOrUrn}` answers 409 while any upper rung (the instance included) is enabled, naming it — because a disable that left every move under the subtree still enforced would be a successful-looking no-op. 4. `tier` IS THE LITERAL RECORDED AT WRITE TIME and is explainability only. It is never recomputed on read, so a rung keeps explaining itself as what it was enabled as. 5. NOTHING IS ENFORCED UNTIL A RUNG IS SET. Every deployment ships with no rungs and no instance row, and `enforced: false` is the answer everywhere in that state.

## `packages/schemas/src/governance.test.ts`

### §259. The wire contract of the control-run findings route

M22.9 (ADR-0033 §7) — the wire contract of `GET /control-runs/{id}/findings`.

WHAT IS ACTUALLY AT STAKE HERE, because a response-shape test can easily be about nothing: until M22.9 `scan_findings` had no reader at all, and the reader it was owed has ONE property that makes it safe — the finding-set MARKER comes back with the rows and cannot be omitted. Every marker state except `full` (`truncated`, `unsupported`, and ABSENT) refuses every exclusion for that scan, so a consumer handed a bare array reads a partial or structurally-empty set as the whole one. `findingsRecord` being REQUIRED-and-nullable is what forecloses that, and it is the first thing a later "tidy the schema" edit would relax.

MUTATIONS RUN against this file (2026-08-18) — the MEASURED results, because a green suite proves nothing about whether it would have gone red. 6 tests total:

```text
1. `findingsRecord: ScanFindingsRecordSchema.nullable()` -> `.nullable().optional()`
     -> 1 failed / 5 passed ("refuses an envelope with no marker at all"). This is exactly the
     defect this endpoint was built to foreclose: a reader that can hand back rows alone.
2. delete `retentionClass` from `PersistedScanFindingSchema`
     -> 2 failed / 4 passed ("projects the ordinal and the ADR-0024 class", "refuses 'P'"). Past
     `SCAN_EXCLUSION_EVIDENCE_CAP` (100) these rows are the only per-finding record of what an
     operator chose to tolerate, so losing the class loses the accepted-risk evidence itself.
3. add `pkgName: z.string().nullish()` to that same extend — the shape someone reaches for on
     seeing a `null` from a nullable column -> 1 failed / 5 passed ("refuses a NULL attribution
     column forwarded as `null`"). The columns are nullable and the wire fields are not, which
     is why `toPersistedScanFinding` (scan-findings-repo.ts) DROPS nulls rather than passing
     them through.
```

## `packages/schemas/src/governance.ts`

### §260. M4 Governance Engine wire contract

M4 Governance Engine wire contract (DESIGN.md §10, BUILD_AND_TEST.md §8 M4). Policies and Controls themselves are ordinary graph objects (typed-registry resources — `GraphObjectSchema` already covers them, same as `release-topology`); this file only carries the projection-table resources that have no graph-object equivalent: control run evidence, approval quorum, and freezes.

### §261. M22.8 — WHICH GATE CROSSING THIS RUN AUTHORIZED

M22.8 — WHICH GATE CROSSING THIS RUN AUTHORIZED. Both columns have existed on `control_runs` since M4; neither has ever been projected onto the wire.

That was survivable while a change had at most ONE run per control: `latestControlRun` was keyed `(orgId, changeObjectId, controlObjectId)`, so the single row WAS the change's answer and naming the crossing added nothing. M22.0a changed that — the cache key now carries gate identity, so a change legitimately carries a run per crossing (the `validating -> accepted` lifecycle edge, then one per wave boundary), and M22.7 adds forced re-runs on top. An operator reading `GET /changes/{id}/control-runs` today sees several rows with the same control and status and no way to tell which one let production through.

OPTIONAL ON THE WIRE, NOT NULLABLE, and the distinction is the oasdiff rule this repo has already paid for once: making an EXISTING required response field optional is a breaking change, so these are added as new optional fields beside the required ones rather than by re-shaping anything. The columns are `NOT NULL`, so a live server always sends them; the optionality exists for older generated clients, never as a licence to omit them.

### §262. M22.9 — `GET /control-runs/{id}/findings`

M22.9 — `GET /control-runs/{id}/findings`.

`findingsRecord` IS REQUIRED AND NULLABLE, and that is the whole contract, not a style choice. Every marker state except `full` — `truncated`, `unsupported`, and ABSENT — refuses every exclusion for that scan ("you cannot except what you did not record", ADR-0033 §7), so a response that hands back a bare array is one a consumer can use without ever learning that the set it is looking at is not the set the scanner produced. Required-and-nullable rather than optional so `null` POSITIVELY says "no marker was recorded"; an omitted optional field would be indistinguishable from a client too old to know the key, which is the ambiguity this field exists to remove.

### §263. Does this freeze park the whole wave, or the targets

M25.2 / owner decision D5 — does this freeze park the WHOLE wave, or only the targets it covers? `false` (the default) is per-target admission: a freeze over one region holds that region and its siblings ship. `true` restores pre-M25.2 all-or-nothing behaviour, for the coupled case where half-applied is worse than not-applied.

A REQUIRED response property, which is additive and oasdiff-safe (the standing rule is never to make an EXISTING required field optional). Required rather than optional deliberately: the column is `NOT NULL DEFAULT false`, so every row has an answer, and an operator asking "will this freeze stop the whole release?" must not have to distinguish absent from false.

### §264. When this freeze was retracted, or null while it stands

M25.1 — when this freeze was RETRACTED, or `null` while it still stands. A lifted freeze is no longer in force whatever `endsAt` says, and it is still returned by `GET /freezes/{id}` and `GET /freezes` FOREVER: a `gate`/`freeze_admission` Decision cites `freeze.id` in its `inputContext`, and "what was this freeze that blocked me?" must stay answerable (charter principle 6). LIFTED IS A FIELD, NOT AN ABSENCE — read it, don't infer it from a 404.

REQUIRED AND NULLABLE, exactly like `name` above: every row has an answer to "was this retracted", and `null` is that answer for the overwhelming majority. Adding a required response property is additive and oasdiff-safe (the rule is never to make an EXISTING required field optional).

### §265. The id of this freeze's graph object, or null

M25.7 / owner decision D6 — the id of this freeze's `freeze` GRAPH OBJECT, or `null` when this freeze does not federate (the default, and every freeze authored before M25.7).

READ, NEVER INFERRED. A client must not compute "does this federate?" from anything else — not from the presence of a peer, not from the actor's permissions. This is the column `governance/freeze-object.ts` writes, and it is also what tells an operator staring at a freeze on an OUTPOST whether it is one they can lift: a non-null `objectId` on a freeze whose object is a read-only replica means `DELETE`/`PATCH` will refuse with a 409 and the remedy is `freeze:override`.

REQUIRED AND NULLABLE, exactly like `liftedAt` and `name`: every row has an answer, and adding a required response property is additive and oasdiff-safe (the standing rule is never to make an EXISTING required field optional).

### §266. Opt this freeze out of per-target admission

M25.2 / owner decision D5 — opt this freeze OUT of per-target admission (see `FreezeSchema`).

OPTIONAL, defaulting to `false` server-side, which is a request widening and therefore oasdiff-safe. It exists because D5 is a change that newly PERMITS and applies RETROACTIVELY to every freeze already authored: the day per-target admission ships, an operator who freezes a service during an incident gets three quarters of a release instead of none. `atomic: true` is the escape hatch that decision was taken on the strength of, so it ships in the SAME increment as the loosening rather than in the one after it — a mitigation that lands later is a window in which the mitigation does not exist.

### §267. Also give this freeze a graph object, so it federates

M25.7 / owner decision D6 (ADR-0043) — ALSO GIVE THIS FREEZE A GRAPH OBJECT, so it rides the federation journal to this org's peers and BLOCKS there too.

DEFAULTS TO `false`, AND THAT IS THE POINT. Federation is a new REACH — a freeze declared here becomes a freeze that stops releases in another security domain — and a new reach never defaults on. Omitted, the request is byte-identical to a pre-M25.7 one and so is everything that happens to it.

GATED ON `federation:write`, NOT `freeze:write`. Declaring a freeze that binds another security domain is categorically different from describing your own estate; ADR-0022 drew exactly this line for commander-authored outpost config and this is the same act. `freeze:write` at the freeze's own scope is still required as well — this permission is added, never substituted. The same pair is demanded on `DELETE` and `PATCH` for any freeze that HAS an object, because both verbs re-publish it: extending or lifting a federating freeze reaches the other domain just as declaring it did.

IT REACHES `full`-SCOPE PEERS ONLY, AND THE DROP IS SILENT (ADR-0043 §5a). A federating freeze rides an `object_upsert`, and `federation/scope-filter.ts` admits that entry kind under `full` and under `changes_only` — the latter only for `typeId: "change"`, which this is not. A peer paired `policies_only`, `changes_only`, `status_only`, or with a non-empty `custom` label selector (a freeze object carries no labels) never receives it; the export filter records nothing and the receiver never sees it, so NEITHER instance can report that the freeze was withheld and this request still answers 201. Scope is evaluated per bundle at EXPORT time, so re-scoping a peer later changes the answer for freezes already authored. Read `GET /v1/federation/peers`' `syncScope` before relying on a freeze reaching a given outpost.

A PLATFORM-TIER FREEZE HAS NO EQUIVALENT AND CANNOT. `POST /v1/instance/freezes` carries no such field: the sync journal is org-scoped at every layer and `instance_freezes` has no `org_id`. See ADR-0040 and GLOSSARY's "platform-tier freeze".

### §268. This freeze's object never leaves this security domain

ADR-0031 — this freeze's graph object NEVER LEAVES THIS SECURITY DOMAIN, in either direction, even under a peer paired at `full` scope.

For the OUTPOST-declared case: an outpost that wants its freeze to be a first-class graph object locally, and to be structurally incapable of travelling upward to the commander. Only meaningful with `federate: true` (without an object there is nothing to withhold), and the route refuses the combination `domainLocal` without `federate` rather than silently ignoring it — a locality declaration that no-ops is a field that lies.

Locality is DECLARED, never inferred, and declaring it is a `federation:write` act (`federation/domain-local.ts`). Immutable after create, structurally: only the INSERT names the column.

### §269. M25.1 — the body of `DELETE /api/v1/freezes/{id}`

M25.1 — the body of `DELETE /api/v1/freezes/{id}`.

A BODY ON A DELETE, following `DeleteSourceMappingRequestSchema` (the shipped precedent on `DELETE /change-sources/{sourceKind}/mappings`), because the reason is MANDATORY and a free-text governance justification does not belong in a query string.

`reason` IS REQUIRED, and that is the whole schema. Lifting a freeze retracts a protection for EVERYONE covered by it — a strictly wider blast radius than `freeze:override`, which lets one change past and leaves the freeze standing, and which has refused to work without a reason since M4 (DESIGN §10.3). A loosening with no recorded reason is exactly what that refusal exists to prevent.

AND THAT RADIUS ARGUMENT IS ALSO THE PERMISSION (M25.9 / owner ruling D1(a-ii), 2026-08-25). This verb takes `freeze:write` at the freeze's own scope, plus the Owner-only `freeze:override` at that same scope whenever the acting subject is not the freeze's `created_by_actor_id` — the wider verb can no longer cost the narrower permission. Lifting YOUR OWN freeze stays `freeze:write` alone, so declaring a freeze is never an entrance with no exit for the role that declared it. The same pair governs a SHORTENING via `UpdateFreezeWindowRequestSchema`, or the retraction would be one PATCH away.

### §270. M25.1 — the body of `PATCH /api/v1/freezes/{id}`

M25.1 — the body of `PATCH /api/v1/freezes/{id}`: move `endsAt`, in either direction.

SHORTENING is a LOOSENING (governance stops protecting sooner) and EXTENDING is a TIGHTENING. Both need `freeze:write` at the freeze's own scope and both require a reason; the server records which direction it was, together with the old and new instants, in the audit event and the Decision — "who made governance weaker, and when" is the question an audit log is read with.

AND THE DIRECTION IS ALSO AN AUTHORIZATION INPUT (M25.9 / owner ruling D1(a-ii), 2026-08-25). A SHORTENING ends the protection early for everyone the freeze covers — the same act as `DELETE /freezes/{id}` with a different record — so it additionally demands the Owner-only `freeze:override` at the freeze's own scope whenever the acting subject is not the freeze's `created_by_actor_id`. Gating the lift alone would leave the retraction one PATCH away. EXTENDING takes nothing from anyone the freeze covers and stays `freeze:write` even on another actor's freeze, and so does re-sending the `endsAt` a freeze already has. The direction is computed under the row lock, against the window in force rather than the one the client last read.

`startsAt` IS DELIBERATELY NOT EDITABLE. Moving the start of an open window is either a no-op or a rewriting of history ("this freeze was in force from a time it was not"), and `endsAt` is the whole of the escape hatch M25.1 exists to provide. Shortening `endsAt` to a past instant is allowed and is NOT re-labelled a lift: same effect on admission, different and truthful record, and reversible where a lift is not.

### §271. `scp policy evaluate` (BUILD_AND_TEST.md §8 M4 item 7)

`scp policy evaluate` (BUILD_AND_TEST.md §8 M4 item 7) — a dry-run gate evaluation against a change's CURRENT state, without attempting any transition. Reuses the exact same governance/gate-orchestrator.ts logic the real lifecycle-edge/wave-boundary gates run, so its output is by construction identical in shape to what a real block's Decision would show.

### §272. M25.3 — THE INSTANCE-SCOPED

M25.3 — THE INSTANCE-SCOPED (PLATFORM) FREEZE TIER'S WIRE CONTRACT (drizzle/0086, docs/proposals/campaigns-rework.md §2, owner decision D1).

THE DELIBERATE TWIN of `InstanceScanFloor*` (supply-chain.ts) and `InstanceScanExclusionAdmission*`: same instance scope, same DESIGN §4.2 `org_id` exception, same two audiences and two credentials — tenant-facing READ (charter principle 6: a change blocked by a freeze must be able to name it), operator-only WRITE gated on `SCP_OPERATOR_TOKEN`, no RBAC permission anywhere on the write side.

THESE ARE ON THE WIRE. `supply-chain.ts`'s M22.8 note is worth repeating here because it corrects a claim that was once made wrongly in this repo: `/instance/scan-floors` and `/instance/scan-floors/{tier}` are published in `openapi.v1.json`, and so will these be. Editing any of the schemas below after they ship is an oasdiff-gated API change, not a refactor.

### §273. WHERE a platform freeze applies

WHERE a platform freeze applies — a STAGE COORDINATE, never an object id.

`freezes.scopeObjectId` names a graph object and the containment walk decides coverage. That is structurally unavailable above org: object ids are per-org rows, `containmentChain` is org-filtered on every join, and there is no object every tenant shares — one id would name at most one tenant's object. So a platform freeze addresses the coordinate SCP already defines and already reads (M15.6 / ADR-0017 §3): `properties.environment` (+ optional `properties.region`) on a `deployment-target`.

`allEnvironments` IS THE EXPLICIT DEPLOYMENT-WIDE FORM, and an omitted `environment` is NOT it. The proposal sketched `match_environment IS NULL` = everything; that was changed deliberately. A deployment-wide freeze stops every release for every tenant on the instance — the widest governance act this surface can express — and reaching it by OMITTING a field means a client that drops empty strings, a typo'd key, or a partially filled form authors maximum blast radius with no error anywhere. This repo already refuses to let a LOOSENING default on; the widest TIGHTENING gets the same treatment for the same reason. Send `allEnvironments: true` and mean it.

`allEnvironments: true` is also the only form that covers a target declaring no coordinate at all (a legacy component-shaped wave target, or a stage whose deployment-target sets no `environment`). An environment-addressed freeze reaches the stages that SAY they are that environment — ADR-0031's rule that locality is declared, never inferred.

### §274. A `deployment-target`'s `properties.environment`, e.g

A `deployment-target`'s `properties.environment`, e.g. `"prod"`. With no `region`, this matches EVERY region of that environment — including a stage that declares no region.

TRIMMED BEFORE `min(1)`, AND THE TRIM IS A CORRECTNESS FIX, NOT TIDINESS (M25.3 review finding 3). `readStageCoordinate` trims what the GRAPH declares, and `instanceFreezeCovers` compares the two with `!==`. Stored untrimmed, `" prod"` therefore matches NOTHING while the PUT returns 200 and `GET /v1/instance/freezes` lists the row cleanly — a freeze an operator believes is in force and which holds nothing, which is the exact failure mode a freeze must never have. The DB CHECK cannot close this: `length(btrim(...)) > 0` TESTS a value, it does not STORE one, so `" prod"` passes it. Trimming here is one barrier ahead of the table and covers every writer that goes through the API, which is all of them.

`.trim()` before `.min(1)` also makes an all-whitespace value a 400 naming the addressing rule rather than a row that silently matches nothing. It changes no emitted JSON Schema (`z.toJSONSchema` still yields `{"type":"string","minLength":1}`), so it is not an API change — verified against the generated document, not inferred.

### §275. Both refinements are enforced at runtime, not in the spec

BOTH REFINEMENTS ARE ENFORCED AT RUNTIME AND NEITHER APPEARS IN `openapi.v1.json`, which is worth stating because the generated spec is what a reader inspects. `app.ts` installs fastify-type-provider-zod's `validatorCompiler`, so request bodies are validated by the ZOD schema itself and a body with neither addressing form (or with both) is a 400 naming the rule. A cross-field constraint is not expressible in JSON Schema, so the emitted document shows three independent optional properties; the DB CHECK `instance_freezes_match_ck` is the second barrier behind it, for any writer that ever reaches the table without passing this schema.

### §276. The operator-authored write body: a full replacement

Operator-authored write body for `PUT /v1/instance/freezes/{key}` — a full replace of the row at that key, never a partial merge, the same posture `PutInstanceScanFloorRequest` takes.

`overridable` DEFAULTS TO FALSE and that default is the floor property. Nothing an org can author subtracts from a platform freeze — the merge across tiers is a UNION — so the ONLY place tenant relief exists is this bit, and a loosening never defaults on.

### §277. The body of `DELETE /v1/instance/freezes/{key}`

The body of `DELETE /v1/instance/freezes/{key}` — the SOFT retraction.

A body on a DELETE, following `LiftFreezeRequestSchema` and `DeleteSourceMappingRequestSchema`, because the reason is mandatory and a free-text governance justification does not belong in a query string. Retracting a platform freeze un-protects every org on the deployment at once — a strictly wider blast radius than the org-tier lift this rule already applies to.

## `packages/schemas/src/graph.ts`

### §278. Full graph model contract

Full graph model contract (DESIGN.md §4.1). Supersedes M0's single-purpose `ServiceObject` shape with the generic object/relationship model shared by every registry type — built-in or org-defined via the runtime type registry (§4.1 "custom types are data, not DDL").

### §279. Which SIDE of an edge is singular

Which SIDE of an edge is singular. `one_to_many` makes the **to** side singular (one live incoming edge of this type per `to_id`); `many_to_one` makes the **from** side singular (one live outgoing edge per `from_id`); `one_to_one` makes both; `many_to_many` neither.

`many_to_one` was added by ADR-0026 / post-import-configuration.md D11 for `releases_via` (`component -> release-topology`: each component releases via at most one pipeline, each pipeline serves many components). Before that it was ABSENT here and had no branch in `assertCardinality` — so a hand-inserted `many_to_one` fell through every check and was silently unenforced, which is why migration 0021 registered `contains` as the mirror instead. Every value in this enum now has an enforcing branch, and `assertCardinality` FAILS CLOSED on any value that does not (the column is plain `text` with no CHECK constraint).

### §280. True when this object never leaves its security domain

M20.1 ([ADR-0031](../../../docs/adr/0031-domain-local-objects-never-federate.md) §1) — `true` when this object's existence stays inside its own security domain: its journal entries match NO peer sync scope, in either direction, so no peer ever learns it exists.

DECLARED at create by a `federation:write` caller, never inferred. **Immutable** thereafter — shared → domain-local is refused permanently (federation has no un-send), and the reverse is the one-way M20.4 publication verb.

**Visibility only.** It is not an enforcement input: it grants no scan exemption and is read by no governance path. Domain-local content is outside the cross-boundary scan gate because it crosses no boundary (the *path*), never because of this flag or because of where it lives.

Always present on the wire (defaults to `false`), so a reader never has to distinguish "not declared" from "not sent".

### §281. Where this object's locality came from

M20.7 ([ADR-0031](../../../docs/adr/0031-domain-local-objects-never-federate.md) §6c) — **why** this object is domain-local.

Since M20.5 locality inherits at create, so `domainLocal: true` alone no longer means "someone chose this". The three states are exhaustive and need no separate discriminator:

| `domainLocal` | `domainLocalInheritedFrom` | meaning |
| `false` | `null` | federates normally | | `true` | `null` | **declared** by an operator | | `true` | present | **inherited** from that container |

**Declared wins when both apply.** Creating with `domainLocal: true` under an already-local container records *declared*, because that is what the operator did — even though the object would have been local anyway.

**HISTORICAL, not live.** It records the container as it was at create and is never updated to follow it, so after §6b's publish-container-then-child flow a still-local child legitimately points at a container that has since become shared. That is the true answer to "how did this become domain-local" — do not read it as "its container is currently domain-local", and do not use it to predict whether a publish will be refused (§6b's refusal is the server's census to run, over live state, along both containment routes).

The `urn` is carried because it is immutable and resolvable on every `idOrUrn` route, so a badge can name and link the container with no extra request. A container that has since been deleted still resolves here as provenance — treat an unresolvable reference as "inherited, source no longer present" rather than as an error.

### §282. The containment parent

The containment parent. Carried as a `.describe()` rather than as a JSDoc comment ON PURPOSE: JSDoc does not reach `z.toJSONSchema()`, so it would never appear in `tools/openapi/openapi.v1.json`, in the generated SDK, or in a client's editor — which is exactly where this fact was missing (ADR-0032 §8g). If you shorten this string, shorten the argument, not the literal request body: the body is the part a caller can copy.

### §283. Declare that this object never leaves its domain

M20.1 (ADR-0031 §1) — declare that this object never leaves its security domain. Optional and defaulting to `false`, so every existing client is unaffected.

Setting it `true` additionally requires **`federation:write`**, not merely `object:write`: a property that governs what crosses a trust boundary is not an ordinary object field, and ADR-0022 set exactly this precedent for the mirror-image case (commander-declared outpost config). Omitting it, or sending `false`, needs only the ordinary create permission.

There is deliberately **no counterpart on update or upsert-of-an-existing-row** — the capability is structurally absent rather than conditionally refused. See `GraphObject`.

### §284. Strict component create (M12 P5a)

Strict component create (M12 P5a): a component created DIRECTLY must name the service it belongs to — the object and its `service --contains--> component` edge are written in one transaction. The generic object fields plus a REQUIRED `service` (id or URN). Imports (discovery/federation/ overlay) do NOT use this path and stay permissive; see docs/proposals/organize-after.md.

### §285. The result of publishing a domain-local object

M20.4 (ADR-0031 §6) — the result of publishing a domain-local object.

Reports the edge sweep in two buckets rather than one, because a partial sweep is the CORRECT outcome and a silent one would be indistinguishable from a bug: edges to a neighbour that is itself still domain-local stay unpublished, and the operator needs to see which those were.

### §286. One swept edge, named well enough for an operator to act on it

One swept edge, named well enough for an operator to act on it.

The bare-id arrays below came first and could only ever render as UUIDs — which does not satisfy ADR-0031 §6's "the sweep is legible rather than implicit". Legible means knowing WHICH edge: its type, and above all the object at the other end. For a WITHHELD edge that other endpoint is literally the operator's next action ("publish that one too"), and a UI that only has an id has to issue a GET per relationship plus one per endpoint to say so.

### §287. The same two sets, described rather than merely identified

The same two sets, described rather than merely identified. ADDITIVE SIBLINGS of the id arrays rather than a change to them: the id arrays already have consumers (the CLI, and a shipped UI), and changing an existing array's item type is a breaking oasdiff hit. Same order, same membership — these are a richer view of the identical sweep, never a different one.

### §288. Accepted here, unlike on patch, so the declaration keeps

M20.1 (ADR-0031 §1) — accepted here, unlike on `PATCH`, so the declaration keeps full API → SDK → CLI → **IaC** → UI parity (charter principle 3): `scp plan`/`apply` reaches the graph through this upsert, and a property IaC could not express would be a parity hole.

On the **create** branch it declares locality, exactly as on `POST`, and requires `federation:write`. On the **update** branch it is a *precondition, never a write*: a value equal to the stored one is an idempotent no-op (so re-applying an unchanged IaC stack keeps working), and a value that **differs** is refused `409` — locality is immutable, and a PUT must not become the flip door that `PATCH` structurally is not.

### §289. Strict upsert-by-URN for a component

Strict upsert-by-URN for a component (M12 P5a). `service` is REQUIRED when the URN is new (the create branch honours the same "a component must belong to a service" invariant as POST) and OPTIONAL when it already exists (an update is field-only; re-assignment is the P5b move verb). The route enforces the create-branch requirement — the schema leaves it optional so a plain rename of an existing (possibly still-unassigned, imported) component needs no service.

### §290. Idempotent atomic assign-or-move of a component

`PUT /components/{idOrUrn}/service` — idempotent atomic assign-or-move (M12 P5b). Sets the component's sole `contains` parent to `service` whether it currently has none (assign), a different one (atomic move), or the same one (no-op).

### §291. `POST /components/{idOrUrn}/merge` — driving-case merge

`POST /components/{idOrUrn}/merge` — driving-case merge (M12 P5d). Folds `loser` into the path component (the survivor): the loser's executor bindings move onto the survivor and the loser is soft-deleted. Scoped to a freshly-imported, binding-only loser (the argocd double-import case).

### §292. `POST /placements` — one component at one deployment target

`POST /placements` — one component at one deployment target.

Both endpoints are REQUIRED and are the whole point: a placement naming only one of them is not a placement. Taking them here rather than as free-form `properties` is what lets the route enforce the pairing rule at the boundary — resolve each ref, type-check it, and write the two derived edges in the same transaction.

`strictObject` (not `z.object`) deliberately, following the `outpost` precedent: a plain `z.object` DROPS an unknown key and still answers 201, so a newer client writing a property an older server has never heard of would lose the field with no signal. Strict at the operator's door; the registered property schema stays open on the wire (migration 0050's header explains why those must differ).

### §293. Narrow the page to the containment subtree of ONE object

Narrow the page to the containment subtree of ONE object — the authority hint (docs/proposals/role-model.md §8.2 step 6).

NEVER a widening: the caller is authorized at this object before it is used, so the rows it admits are always a subset of the rows they could already list. It exists for the wide-binding case — a domain-bound principal (or an org-root one) who wants the placements of one service rather than a descend over everything.

A UUID, not an id-or-URN like the two refs above, so the parameter name stays literally true; accepting a URN later is an additive change. An id naming nothing is a **404**, deliberately: `scopeExpandCte` seeds its walk with the raw uuid and never checks existence, so authorizing at an unresolved value would answer 403 for everybody, org-root Owner included.

### §294. M2 step 3 addition (BUILD_AND_TEST.md §8 M2 item 4)

M2 step 3 addition (BUILD_AND_TEST.md §8 M2 item 4): mirrors `objects.labels` — additive, backward-compatible (DESIGN.md "additive-only within v1"), defaults to `{}` for every relationship created before this milestone.

An IaC apply writes `scp:managed-by`/`scp:stack` here, but SINCE drizzle/0068 THOSE ARE A DESCRIPTIVE MIRROR AND SCOPE NOTHING. Pruning is scoped by the server-written `relationships.managed_by_stack` column, precisely because this map is writable by the edge's own endpoints' owners and the previous wording ("the pruning convention") is what made a tenant-writable key into a delete decision.

### §295. Induced-subgraph edges over an explicit object-id set

Induced-subgraph edges over an explicit object-id set (DESIGN.md §5, additive within /v1). The named graph queries (`impact-of`/`blast-radius`/…) return only the reachable object SET, never the edges among it — so the UI graph explorer had to synthesize a hub-and-spoke star to render anything connected. This returns the REAL relationships whose BOTH endpoints are in `ids` (exactly the induced-subgraph edge set `traverse` already computes over its own walk), letting a caller render the true DAG for any set it already obtained. `objectId` is the root the caller is exploring — it scopes the `graph:query` authorization the same way the named query that produced the set did.

### §296. Rows that outlived the object they hang off

Rows that outlived the object they hang off.

READ-ONLY, and deliberately so: repair is performed by the ordinary `DELETE` doors (`/relationships/{id}`, `/change-sources/{kind}/mappings`, `/executors/{idOrUrn}/binding`), each of which already writes its audit event and journal entry in the same transaction. A dedicated bulk-repair endpoint would be a second, unaudited way to destroy rows — exactly what principle 6 exists to prevent.

## `packages/schemas/src/health.ts`

### §297. Object health contract

Object health contract (observe-enrichment signal 4; ADR-0008 decision 4). SCP does NOT probe, poll, or compute health — this is a PUSH-IN record an owner (or, later, an opt-in health-source binding writing the SAME row) supplies, stored as an object-referencing PROJECTION row keyed by `objects(id)` (DESIGN §4.1), NOT a new top-level concept table (charter principle 2). The `source` field is binding-ready: an owner push writes `source:'owner'` today; a future Prometheus/HTTP-probe binding on the 60s observe cadence writes `source:'prometheus:<query>'` into the same projection with no schema change (ADR-0008 non-goal: per-observation history).

### §298. Batch latest-health read over a caller-supplied object-id set

Batch latest-health read over a caller-supplied object-id set — the graph node-payload JOIN (`POST /graph/subgraph` returns EDGES ONLY, so health is joined at the node source in a parallel follow-up call, mirroring the subgraph batch-by-ids pattern). `objectId` is the exploration root that scopes `graph:query` authorization, identical to `SubgraphRequestSchema`. Objects with no pushed health are simply absent from `records` — the UI renders them grey/unknown (no fabrication).

## `packages/schemas/src/coordination-as-code.ts`

### §299. `@scp/coordination-as-code` desired-state manifest contract

`@scp/coordination-as-code` desired-state manifest contract (DESIGN.md §15, BUILD_AND_TEST.md §8 M2 item 4). CDK-style constructs (`packages/coordination-as-code`) synthesize a value conforming to `DesiredStateManifestSchema` via a PURE function — no API calls, no randomness, no wall-clock reads — so the manifest is the one interchange point between IaC authoring (offline, air-gap safe) and server-side reconciliation (`POST /plans`). Objects and relationships are addressed by URN, never by a synth-time-random id, which is exactly what makes two independent synths of an equivalent construct tree converge to byte-identical JSON.

Lives in `@scp/schemas` (not `@scp/coordination-as-code`) so both the IaC package (producer) and the server (consumer, `apps/server/src/coordination-as-code/plan-diff.ts`) share one contract — same rationale as every other shape in this package (DESIGN.md §6, §15: "Zod schemas flow untranslated from the server to the generated SDK and IaC").

### §300. The object id this URN's containing domain resolves to

Object id this URN's containing domain resolves to; `undefined`/omitted defaults to the org root, same as `CreateObjectRequestSchema.domainId` (graph.ts) — read that field's `.describe()` for the full argument, because the default carries the same authorization consequence here: `coordination-as-code/plans-repo.ts` runs the SAME custody `authorize` at the resolved parent and the same `assertPolicyScopeWithinAuthority` at apply time. An omitted `domainId` therefore puts a narrowly-bound author's check at the org root, and the apply is refused for a scope the manifest never named.

The manifest equivalent of ADR-0032 §8g's component-team dependency subscription — note the component's own id in BOTH places, `domainId` for custody (where the row lives, hence who may later change it) and `scope.objectRef` for jurisdiction (what the policy reaches):

```text
  {
    "stackName": "checkout-api",
    "objects": [{
      "urn": "urn:scp:checkout-api:policy:deps-checkout-api",
      "typeId": "policy",
      "name": "deps-checkout-api",
      "domainId": "11111111-1111-1111-1111-111111111111",
      "properties": {
        "enforcement": "advisory",
        "scope": { "objectRef": "11111111-1111-1111-1111-111111111111" },
        "effects": [{ "dependencySubscription": { "enabled": true } }]
      }
    }],
    "relationships": []
  }
```

`governance.integration.test.ts`'s IaC case builds its manifests exactly this way and says why in a comment: `domainId: component.id` is what makes the custody check pass, which is what lets that test isolate the declared-scope-authority check specifically.

The `.describe()` below exists for the same reason it does on the create field: a JSDoc comment does not reach `z.toJSONSchema()`, so a manifest author reading the generated SDK type would see none of this.

### §301. The projection collections an apply may manage

Projection collections (docs/proposals/post-import-configuration.md §8 C1)

`source_mappings` and `executor_bindings` are the two configurations that were UNEXPRESSIBLE in a manifest: unlike everything else a stack declares, they are standalone projection tables rather than graph objects/relationships (`packages/schemas/src/executors.ts`: "projection tables ... no graph-object equivalent exists"), so `objects`/`relationships` could not carry them. That made principle 3 (API → SDK → CLI → IaC → UI parity) false for exactly the two things an operator must reproduce when standing a second instance up offline (principle 5). C1 closes that.

OWNERSHIP IS DERIVED FROM THE OWNING OBJECT (the load-bearing decision — see `apps/server/src/coordination-as-code/plan-diff.ts`'s `stackOwnedObjectUrns`): neither table has a `labels` column, and neither gets one. A row belongs to stack S iff the graph object it hangs off (`component_object_id` / `target_object_id`) is one THIS stack owns. Two consequences an author must know, both deliberate: 1. A manifest may only declare a mapping/binding for an object the SAME stack declares (or one it already manages). Anything else is rejected 400 at plan-compute — a stack cannot configure an object it does not own. 2. Because ownership is inherited, declaring an object in a stack means the stack owns that object's mappings/bindings WHOLESALE. Adopting a discovery-imported component into a stack and declaring no bindings prunes the imported ones — visible as `delete` entries in the plan the operator reviews before applying, exactly like an object prune, never silent.

### §302. A `source_mappings` row

A `source_mappings` row: repo/path/ref glob → the component whose pipeline of `type` that source drives (DESIGN §9.2 correlation). IDENTITY is the whole tuple `(componentUrn, sourceKind, repoPattern, pathPattern, refPattern, type)` — the table has no unique constraint and no update path, so a changed mapping is a delete + create, the same identity-only treatment `ManifestRelationshipSchema` gets. Declaring the same tuple twice in one manifest is rejected.

`refPattern` had to join that identity (ADR-0030 §1): it is a routing discriminator, so a manifest legitimately declares `refs/heads/dev` → dev pipeline and `refs/heads/main` → production as two rows differing in nothing else. Without it in the tuple those two would collide as a duplicate declaration, and a prune of either would match — and delete — both.

`classification` is deliberately NOT part of the identity: it is a descriptive label, so changing it should be an in-place correction rather than a delete-and-recreate of a live route.

### §303. DECLARED reach (§10.6, migration 0066)

DECLARED reach (§10.6, migration 0066): `global` | `domain`. Outside the identity tuple, like the three above — but unlike them it IS converged on an existing row: a declared scope that differs from the live row's diffs as an `update` (`PlanSourceMappingDiffEntrySchema.action`), and apply writes it in place. Three states, deliberately: OMITTED ⇒ this manifest does not manage the scope (a manifest that has never heard of the field never clears a scope an operator set by hand); explicit `null` ⇒ declare it undeclared (clear a stale label); a value ⇒ that.

### §304. An `executor_bindings` row

An `executor_bindings` row: the plugin instance that drives one pipeline of one target object. IDENTITY is `(targetUrn, type)`, mirroring the table's `UNIQUE (org_id, target_object_id, type)` — so unlike a source mapping this one supports `update`, and a plan can never propose two rows that would collide on that constraint. Field-for-field the same shape as `CreateExecutorBindingRequestSchema` (the `PUT /executors/{idOrUrn}/binding` body), including its either-inline-or-execution-system-backed refinement: one contract, two doors.

### §305. NARROWS `targetUrn` to a PLACEMENT

NARROWS `targetUrn` to a PLACEMENT: this component AT this deployment-target, rather than the component itself. Omitted ⇒ the binding hangs off `targetUrn`'s object, as it always has.

A placement is addressed this way rather than by its own URN because that URN is DERIVED (ADR-0026 D3) from the org id plus both endpoints' display names — neither hand-writable nor stable under a rename. Expressing it as a qualifier on `targetUrn` rather than as an alternative to it also keeps `targetUrn` REQUIRED, so adding this field breaks no response consumer, and leaves ownership a single unconditional rule: the stack must own `targetUrn`, which for a placement is its component (decision Q4).

### §306. A placement: one component at one deployment target

A `placement` (ADR-0026): one component at one deployment-target.

IDENTITY IS THE PAIR, and there is deliberately NO `urn` field. ADR-0026 D3 makes a placement's URN *derived* from both endpoints, so a manifest that supplied one could disagree with what the typed route would mint and the two would diverge silently. Addressing by the pair is the only self-consistent choice, and it is what lets two independent synths converge.

OWNERSHIP is the COMPONENT's stack (decision Q4) — the same rule `sourceMappings` already use, so placements need no new ownership concept. A declaration whose component this stack does not own is refused, which is what stops two stacks pruning each other's placements.

### §307. A `dependency_line_producers` row (ADR-0032 §7e)

A `dependency_line_producers` row (ADR-0032 §7e): "this component's production releases are where this coordinate's versions come from". The IaC form of `POST /dependencies/producers`.

IDENTITY IS `(ecosystem, coordinate)` — the table's natural key — and the PRODUCER IS THE VALUE. That is why this collection has an `update` action where `sourceMappings` and `placements` do not: re-pointing `@acme/lib` from component P to component Q is one row changing, not a delete and a create, and the table's own `ON CONFLICT (org_id, ecosystem, coordinate) DO UPDATE` says so.

OWNERSHIP is the PRODUCER COMPONENT's stack, the same inheritance rule `sourceMappings` uses (this table has no `labels` column either). Two refusals follow, both at `POST /plans` and again at apply: 1. a declaration whose producer this stack does not own; and 2. a declaration that would DISPLACE a live one whose current producer this stack does not own. (2) is not symmetry for its own sake. Without it, stack A could take `@acme/lib` from stack B's component: B's ownership pool is keyed on B's own components, so after the theft the coordinate is invisible to B — B can neither prune it nor restore it, and nothing in B's plan output ever says it left. That is the same "a stack never touches another stack's rows" rule the projection tables already have, applied to the one collection where a row can change hands without being deleted.

THE PRODUCER MUST BE A `component`. A `service` is refused with the reason `DeclareDependencyLineProducerRequestSchema` gives: internal head derivation reads the COMPONENT a production placement names, so a service-valued declaration removes the coordinate from third-party polling and derives no head at all — the harmful half without the useful one.

### §308. A `governance_move_rungs` row

A `governance_move_rungs` row (ADR-0038 §2, proposal governance-reach-on-containment-move.md §9.6 Q4): "every containment move under this container needs `governance:move` at BOTH ends". The IaC form of `PUT /governance/move-enforcement/rungs/{idOrUrn}`.

IDENTITY IS THE SUBJECT and there is deliberately no value: a rung is either enabled at a container or it is not, so this collection has `create`/`delete`/`noop` and no `update` — the same identity-only treatment `placements` gets, for the same reason. The TIER is DERIVED from the subject's object type (`moveRungTierForObjectType`) and is never declared: a manifest that could name a tier could name one the subject is not, and the stored literal would then describe a containment shape the rest of the system does not believe in.

OWNERSHIP is the SUBJECT CONTAINER's stack — this table has no `labels` column either, so the same inheritance rule `sourceMappings`/`producers` use applies, and the same refusal follows at both `POST /plans` and apply: a rung declared on an object this stack does not manage is rejected 400. That is what stops two stacks enabling and pruning each other's rungs. The practical consequence: a rung on the ORG ROOT (or on a container another stack owns) is authored through the API/CLI, not through a manifest.

THE SUBJECT MUST BE A CONTAINER — the org root, a containment domain, a service or an assembly. A component is refused for the reason `assertRungSubjectType` gives: a rung governs moves of the things INSIDE a container, and nothing is contained by a component, so the rung would govern the empty set of moves.

AUTHORITY IS `policy:write` AT-OR-ABOVE THE SUBJECT, checked at apply against the REAL applying principal — the same bar `PUT /governance/move-enforcement/rungs/{idOrUrn}` takes, imported from one definition so the two doors cannot drift.

### §309. ROLE BINDINGS AND CUSTOM ROLES IN A MANIFEST

ROLE BINDINGS AND CUSTOM ROLES IN A MANIFEST (role-model.md — the IaC rung of principle 3)

WHAT IS DELIBERATELY NOT EXPRESSIBLE: a binding whose subject is a `group` or `team`.

D7 requires the granter to acknowledge every principal a group binding empowers, compared by SET EQUALITY at the door. In a manifest that value is a MEMBERSHIP SNAPSHOT and it goes stale the moment anyone joins or leaves. The failure is not that the snapshot is wrong — it is that a stale-snapshot refusal TRAINS the author to stop reading it: they paste whatever the last error said, and a control whose whole purpose is that a human looks at the current set becomes a checksum updated mechanically. So the construct refuses a group subject at SYNTH, and the operator uses `scp role-binding grant-preview` + `create`, where the set is read at the moment of granting.

WHO APPLIES MATTERS, AND IS NOT SPECIAL-CASED. The no-escalation subset rule (`authz/role-binding-door.ts`) is evaluated against the APPLYING principal, which for a config-source sync is the TEAM object (ADR-0046 §1 / D9). A team whose repo declares a binding must therefore already hold every permission that role carries at that scope — so a team's own repo cannot bootstrap that team's permissions. That is the rule working, not a gap: authority must not be conferrable by someone who lacks it, and "the applying identity is a team" does not change the argument.

### §310. C1 (ADR-0026). OPTIONAL for the same reason as the two above

C1 (ADR-0026). OPTIONAL for the same reason as the two above — but note what "optional" does and does NOT mean. It keeps a pre-C1 manifest VALID; it does not suppress pruning. `Stack.synth()` omits a collection when it is empty, so absent is the only way to say "this stack declares no placements", and it therefore prunes exactly as an empty array does. (`plan-diff.ts`'s `ResolvedManifest` carries the long form of this; I once read it the other way and broke three prune tests.) A PRESENT one is authoritative for the components this stack owns — removing an entry deletes that placement (decision Q3), which is safe only because a placement still carrying an executor binding is REFUSED rather than cascaded (decision Q2). Those two rulings are load-bearing together.

### §311. Absent means unmanaged, diverging from the collections

ABSENT MEANS **UNMANAGED**, AND THIS DELIBERATELY DIVERGES FROM THE THREE COLLECTIONS ABOVE
For `sourceMappings`, `executorBindings` and `placements`, an absent key and an empty array are the same thing and both PRUNE — `apps/server/src/coordination-as-code/plan-diff.ts` says so at length and records that changing it broke three `plans.integration` tests. DO NOT "fix" this collection to match them. The asymmetry is the ruling (owner, 2026-08-17), and the reason is the blast radius, not consistency:

```text
- Pruning a mapping, a binding or a placement costs a route or a pipeline an operator notices
  the same day.
- Pruning a producer declaration returns a coordinate the org PUBLISHES to a PUBLIC INDEX on a
  daily poll timer. The symptom is an ABSENCE of dependency updates, and the failure mode is
  dependency confusion (ADR-0032 §7b clause 1) re-armed by a stack that merely FORGOT A KEY.
```

So: key absent  -> this stack manages no producer declarations. NOTHING is pruned, ever. key present -> this stack is authoritative over the declarations it names, AND over any declaration whose producer is a component this stack owns. Removing an entry from a present collection DOES prune it (see below).

IS A PRESENT COLLECTION AUTHORITATIVE OVER ITS OWN MEMBERS? YES — AND HERE IS THE ALGORITHM
Removing entry B from `[A, B]` DOES prune B. `computePlanDiff`'s prune step is the same one every other collection gets — `pool.filter(row => !manifestKeys.has(key(row)))`, where `pool` is the declarations whose producer this stack owns. The ONLY thing the absent case changes is that the prune step is SKIPPED ENTIRELY; nothing else in the algorithm distinguishes one member from another. So the catastrophic case ("the whole key vanished") manages nothing, and the ordinary case ("I removed one of my three") is real, reviewable management.

THE CONSEQUENCE: IaC CANNOT RETRACT THE **LAST** DECLARATION THROUGH `@scp/coordination-as-code`
`Stack.synth()` OMITS a collection when it is empty, so a program that declares no producers and a program that declares none ANY MORE synthesize byte-identical manifests. Under the rule above both mean "unmanaged", so deleting your only `producesDependency(...)` call leaves the declaration standing. That is an ACCEPTED COST, not an oversight — the alternative is a forgotten key silently re-arming dependency confusion.

To retract, in order of preference: 1. `POST /dependencies/producers/retract` (`scp dependency producer retract`). Preferred even when IaC could do it: only the verb reports the bumps SCP has already authored and cannot recall. 2. Remove the entry while OTHER entries remain — the key stays present, so the prune fires. 3. Hand-author `"producers": []` and POST it to `/plans`. Present-and-empty is a deliberate statement ("I manage producers, and I declare none"), so it prunes every declaration on a component this stack owns. `@scp/coordination-as-code` cannot emit this; a hand-written manifest can.

### §312. Absent means unmanaged, the same divergence and reason

ABSENT MEANS **UNMANAGED**, THE SAME DIVERGENCE `producers` MAKES AND FOR THE SAME KIND OF REASON (proposal governance-reach-on-containment-move.md §9.6 Q4)
Read `producers` above first: absent and empty are the same thing for `sourceMappings`, `executorBindings` and `placements`, and both PRUNE. These two collections diverge, because the blast radius of a forgotten key is not "a route an operator notices the same day":

```text
- Pruning a rung DISABLES a governance bar. The symptom is an ABSENCE of refusals — moves that
  should have been refused quietly succeeding — and nothing surfaces it until somebody audits
  where a governed object ended up. A stack that merely FORGOT A KEY must not un-govern a
  subtree an operator deliberately governed.
```

So: key absent  -> this stack manages no rungs. NOTHING is disabled, ever. key present -> this stack is authoritative over the rungs it names, AND over any rung whose subject is an object this stack owns. Removing an entry from a present collection DOES disable it.

AND `@scp/coordination-as-code` THEREFORE CANNOT DISABLE THE **LAST** RUNG: `Stack.synth()` omits an empty collection, so a program that declares no rungs and one that declares none ANY MORE synthesize byte-identical manifests. Accepted cost, identical to `producers`. To disable, use `DELETE /governance/move-enforcement/rungs/{idOrUrn}` (`scp governance move-enforcement disable`), remove the entry while OTHER entries remain, or hand-author `"governanceMoveRungs": []`.

A DISABLE MAY STILL BE REFUSED. The lattice is monotone (ADR-0038 §2): a rung whose ancestor — or the instance rung — is enabled cannot be disabled below, so a manifest that drops such an entry fails its apply with the 409 the verb gives, naming the upper rung. That is deliberate: reporting a successful disable that leaves every move under the subtree enforced anyway is the worst of both.

### §313. THE THIRD `ABSENT MEANS **UNMANAGED**` COLLECTION

THE THIRD `ABSENT MEANS **UNMANAGED**` COLLECTION — read `producers` and `governanceMoveRungs` above first, because this follows their rule and NOT the rule of the three collections above them (docs/proposals/team-pipeline-iac.md D11/D21).
The test is not consistency, it is blast radius, and a pipeline hook fails the same test a governance rung fails:

```text
- Pruning a mapping, a binding or a placement costs a route or a pipeline an operator
  notices the same day.
- Pruning a HOOK disarms a gate. A `postDeploy` entry that vanishes stops gating every
  wave's exit; a `bakeAlarms` entry that vanishes stops holding the widening. The symptom in
  both cases is an ABSENCE — of refusals, of holds, of anything at all — and nothing
  surfaces it until a bad release walks the whole fleet unimpeded. That is precisely the
  argument `governanceMoveRungs` makes one field up, and it applies here without weakening.
```

So: key absent  -> this stack manages no hooks. NOTHING is disarmed, ever. key present -> this stack is authoritative over the hooks it names, AND over any hook on a component this stack owns. Removing an entry from a present collection DOES prune it, visible as a delete line in the plan.

AND `@scp/coordination-as-code` THEREFORE CANNOT REMOVE THE **LAST** HOOK, the identical accepted cost: `Stack.synth()` omits an empty collection, so a pipeline that declares no hooks and one that declares none ANY MORE synthesize byte-identical manifests. Remove an entry while others remain, or hand-author `"pipelineHooks": []`.

IDENTITY is `(componentUrn, kind, hookId)` — no update path keyed on a subset, so a changed hook is a delete + create, exactly as a changed source mapping is. Declaring one tuple twice in a manifest is rejected.

### §314. Ordinary rule: absent means empty, which means prune

ORDINARY RULE (absent = empty = prune), unlike `pipelineHooks` directly above — and the divergence is deliberate rather than an oversight, so here is the test being applied.

Dropping a rollout declaration does not disarm a safety bar. For a coordinated executor the rollout is the executor's own (D12: SCP's declaration is `triggerParams` or `verified`, never the thing that performs it), so what is lost when the declaration goes is SCP's declared-vs-observed divergence WARNING — the artifact still rolls out under the team's own Argo Rollouts spec. That is a real loss and a visible one (the plan shows the delete line), but it is not the silent un-gating that earns an exception. Three exceptions to one rule would make the exception the rule.

Identity is `(componentUrn, targetClass)`.

### §315. Ordinary rule, the same shape of reasoning as below

ORDINARY RULE (absent = empty = prune), same shape of reasoning as `rollouts` below: a dropped binding is a REVOCATION — visible on the plan line, and a NARROWING rather than a silent un-gating. The dangerous direction for a role binding is granting, and a forgotten key cannot grant anything.

Identity is `(subjectUrn, roleName, scopeUrn)` — the same triple `role_bindings_grant_key` (drizzle/0097) makes unique, so a manifest cannot express two bindings the database would collapse into one.

### §316. Ordinary rule, with identity the name within the org

ORDINARY RULE. Identity is `name` within the org.

A DELETE here is refused by the API while any binding still points at the role, so a manifest dropping a role whose bindings live elsewhere fails loudly at apply rather than performing an unreviewable mass revoke (`routes/role-bindings.ts`'s delete door).

### §317. ORDINARY RULE, for a second and simpler reason

ORDINARY RULE, for a second and simpler reason: D25 has synth write `converge` EXPLICITLY whenever a configuration pipeline places at a product, so an absent collection means this stack declares no such pipeline at all — there is nothing for a forgotten key to silently switch off.

Identity is `(componentUrn, targetUrn)`.

### §318. The full desired-state row a `create`/`update` entry will write

The full desired-state row a `create`/`update` entry will write — `labels` already include the merged `scp:managed-by`/`scp:stack` markers (plan-diff.ts). Those are a HUMAN-READABLE MIRROR since drizzle/0068 and are not what an apply prunes on; ownership is the server-written `managed_by_stack` column, which no request can set and which is therefore absent from this (request-reachable) shape.

### §319. Adoption: this entry claims an object that already exists

ADOPTION (§9) — this entry claims an object that ALREADY EXISTS and was managed by NO stack.

A QUALIFIER ON THE EXISTING ACTION, not a new `action` value, and the reason is measured rather than stylistic: adding a member to a response ENUM is a breaking change under the oasdiff gate (response enum-value additions are breaking; `oneOf` member additions are not), so an `"adopt"` action would have cost an `api-v2-exception` for a distinction that is genuinely a property OF a create/update rather than a third kind of thing. An optional boolean is additive.

Absent or `false` means the object was already this stack's, or is being created fresh. `true` means a review is looking at a stack CLAIMING EXISTING ESTATE — which §9 requires be visible, because it is the one action whose blast radius is invisible from the manifest alone.

### §320. One `source_mappings` row's verdict

One `source_mappings` row's verdict. Identity is the whole tuple (see `ManifestSourceMappingSchema`), so a changed TUPLE surfaces as a delete plus a create — the same identity-only treatment `PlanRelationshipDiffEntrySchema` gets, for the same reason. `update` (§10.6, additive — a response enum gaining a member) is the verdict for an existing tuple whose declared `scope` differs from the manifest's: scope is an attribute of the row, not part of its identity, so it converges IN PLACE (apply sets it on every row matching the tuple) rather than by re-creating a live route. `classification`/`mirrorOfShared`/`enabled` are NOT converged this way today (a differing value still reads `noop`) — pre-existing, and left as is here on purpose: `enabled` is an enforcement input a hand-set pause must survive an apply of a manifest that omits it, and the other two have no "omitted ⇒ unmanaged" reading yet. `repoPattern`/`pathPattern`/`type` are normalized here (null / the `configuration` default) so the entry the operator reviews shows exactly the row that will be written, not the author's shorthand.

### §321. One producer row's verdict, keyed on the coordinate

One `dependency_line_producers` row's verdict, keyed on `(ecosystem, coordinate)` — the table's own natural key, which is why this is the one projection collection with an `update`: the producer is the row's VALUE, so re-pointing a coordinate is an in-place change, not a delete plus a create.

READ `action: "create"` CAREFULLY. It means "no producer is declared for this coordinate at all". A coordinate that already has one and is being re-pointed is an `update` carrying `displacedProducerUrn`, whether or not the displaced producer belongs to this stack — the diff states what is true about the coordinate, and the ownership guard is what refuses the cross-stack case. A plan that silently reported `create` for a transfer would be a plan whose most consequential fact is missing from the thing the operator reviews.

### §322. One move-rung row's verdict, keyed on the container

One `governance_move_rungs` row's verdict, keyed on the SUBJECT container. No `update`: a rung has no value beyond its existence (the tier is derived from the subject's type), so the only verdicts are enable, disable and "already enabled" — the same identity-only treatment `PlanPlacementDiffEntrySchema` gets.

`subjectUrn` is the RESOLVED URN of whatever the manifest addressed by id-or-URN, so the entry an operator reviews names the container in the same vocabulary every other entry uses, and the apply path resolves it exactly like any other endpoint.

### §323. One `pipeline_hooks` row's verdict

One `pipeline_hooks` row's verdict (D11/D21). No `update`, and the reason is the one `PlanPlacementDiffEntrySchema` gives rather than the one `PlanSourceMappingDiffEntrySchema` gives: a hook has no attribute that converges in place. The DECLARATION is what the diff keys on — identity `(componentUrn, kind, hookId)` PLUS the payload beside it — so a hook whose `stage` or `maxAgeSeconds` moved surfaces as a `delete` line and a `create` line, exactly as `ManifestPipelineHookSchema` says it must. Both lines are shown; nothing about a gate changes without an entry the reviewer can read.

`kind` is the DISCRIMINANT every entry in this file carries, so the hook's OWN kind is `hookKind`. Two fields named `kind` on one object is how a reviewer reads the wrong one.

The per-kind fields are all nullable because the four kinds carry different ones (the table's own shape, migration 0096) — a `postMerge` entry has no `stage`, a `bakeAlarms` entry no `workflow`. They are on the ENTRY and not hidden behind a `target` object because they ARE the gate: a plan that pruned a `postDeploy` hook without showing which stage it gated is a prune the operator cannot check, and the whole reason this collection diverges from the prune-on-absent rule is that a disarmed gate announces itself only by an absence.

### §324. D12 — one rollout declaration's diff entry

D12 — one rollout declaration's diff entry.

ORDINARY PRUNE RULE, unlike the hook entry above it: an absent `rollouts` collection means the stack declares none and prunes the ones it owns. That asymmetry is the contract's and is deliberate — an omitted hook DISARMS A GATE (symptom: an absence of refusals), while an omitted rollout costs a declared strategy, which is visible the next time anything deploys.

### §325. One role binding's diff entry

One role binding's diff entry.

NO `update` ACTION, deliberately. A binding's identity is the WHOLE of it — `(subjectUrn, roleName, scopeUrn)` is the same triple `role_bindings_grant_key` makes unique, and `reason` is not stored on the row. So there is nothing a binding can change INTO; a different grant is a different binding, and the plan shows a delete beside a create rather than an "update" that would hide which authority went away.

⚠️ A `delete` HERE REVOKES A PERSON'S ACCESS, which is what makes this collection unlike every other prunable one. The plan line is the review surface for that, so it names the subject and the role rather than an opaque id.

### §326. Producer declarations (ADR-0032 §7e)

Producer declarations (ADR-0032 §7e). OPTIONAL FOR A SECOND REASON ON TOP OF THE PRE-C1 ONE, and the second reason is load-bearing: this key is ABSENT — not `[]` — whenever the manifest omitted its own `producers` collection, because absent there means UNMANAGED (`DesiredStateManifestSchema.producers`). So the stored plan itself records "this stack manages no producer declarations", and an operator reading the plan can tell that apart from "this stack manages them and has nothing to change". An empty array means the latter.

### §327. `governance:move` rungs (ADR-0038 §2)

`governance:move` rungs (ADR-0038 §2). OPTIONAL FOR THE SAME TWO REASONS `producers` is, and the second one is load-bearing in the same way: this key is ABSENT — not `[]` — whenever the manifest omitted its own `governanceMoveRungs` collection, because absent there means UNMANAGED. The stored plan therefore records "this stack manages no rungs", which an operator can tell apart from "this stack manages them and has nothing to change" (an empty array).

### §328. Pipeline test/bake hooks

Pipeline test/bake hooks (D11/D21). OPTIONAL FOR THE SAME TWO REASONS `producers` is, and the second one is load-bearing in the same way: this key is ABSENT — not `[]` — whenever the manifest omitted its own `pipelineHooks` collection, because absent there means UNMANAGED. The stored plan therefore records "this stack manages no hooks", which an operator can tell apart from "this stack manages them and has nothing to change" (an empty array). The third of the three collections that diverge; `rollouts` and `convergence` deliberately do not, and are not projected here at all yet.

## `packages/schemas/src/objects.ts`

### §329. The service object, the minimal slice of the model

`service` object — M0's minimal slice of the full graph object model (DESIGN.md §4.1). The real generic `objects`/`object_types` registry lands in M1; M0 ships just enough of the shape (id, org scoping, type discriminator, name, timestamp) to prove the contract pipeline end to end without building the whole graph substrate early.

ADR-0023 (the first violation SDK response validation caught): this is now the FULL `GraphObject` plus M0's `type` discriminator, not a five-field subset. Fastify's router prefers the literal static route `POST/GET /objects/service` over the parametric `/objects/:type`, so that handler is the only one that ever runs for the exact path `/objects/service` — while the SDK's `client.object("service")` calls the GENERIC `createObject`/`listObjects` operations, whose declared response is a full `GraphObject`. The narrow shape therefore meant `client.object("service").create(...).urn` (and `.typeId`, `.domainId`, `.properties`, `.labels`, `.version`, …) was `undefined` at runtime while TypeScript insisted it was a string — the exact bug class ADR-0023 exists to stop. Widening is additive within /v1 (response properties added, none removed or renamed; `type` is kept) and costs nothing: the underlying row is already a plain `service`-typed graph object, so every field was there to begin with.

### §330. Additive (DESIGN.md §6 "additive-only within v1")

Additive (DESIGN.md §6 "additive-only within v1") — M0 clients that send only `name` are unaffected. Added so `/objects/service` (kept at its M0 path/shape) has the same write capability as the generic `/objects/{type}` endpoint it's now a thin wrapper over (apps/server/src/services/objects-service.ts) — Fastify's router prefers this literal static route over the parametric `/objects/:type` for the exact path `/objects/service`, so without this, custom domainId/properties/labels/id/urn would be silently dropped for the 'service' type specifically.

### §331. A second instance of exactly the hazard named above

M20.1 (ADR-0031 §1) — and a second instance of exactly the hazard the comment above names.

That comment records that this shadowing route silently dropped `domainId`/`properties`/ `labels`/`id`/`urn` for the `service` type until they were added here. `domainLocal` was added to `CreateObjectRequestSchema` and was dropped the same way, for the same reason — Fastify prefers this literal route over the parametric one — until `domain-local-rbac.integration.test.ts`'s contract-derived census caught it.

Per CLAUDE.md: a well-written comment naming a hazard is a signal to sweep, not evidence the hazard was handled. Any future field added to the generic create body must be added here too.

## `packages/schemas/src/pipeline-behaviors.test.ts`

### §332. The pipeline behaviour contract, and what it pins

`packages/schemas/src/pipeline-behaviors.ts` — the pipeline BEHAVIOUR contract (D11/D12/D13/D21/ D23/D25). Every `it()` below proves a PROPERTY the file's own doc comments state, not a mechanic — see the header of that file for the reasoning each test is pinning.

## `packages/schemas/src/pipeline-behaviors.ts`

### §333. `@scp/schemas` — pipeline BEHAVIOUR contract

`@scp/schemas` — pipeline BEHAVIOUR contract: test hooks, rollout declarations, convergence, and the evidence those produce (docs/proposals/team-pipeline-iac.md D11/D12/D13/D21/D23/D24/D25).

WHY THIS FILE EXISTS, AND WHY IT IS IN `@scp/schemas` RATHER THAN `@scp/coordination-as-code`
Same rationale as `coordination-as-code.ts`: the manifest is the ONE interchange point between offline authoring and server-side reconciliation, so producer (`packages/coordination-as-code`) and consumer (`apps/server`) must share one contract or they drift. D16(6) makes that explicit for this surface — the construct props in `@scp/coordination-as-code` reuse the Zod types below VERBATIM, so a prop can never accept something plan/apply refuses.

The split is deliberate and cross-session: this file is the semantics (what a hook MEANS, what evidence must PROVE); `@scp/coordination-as-code`'s `Workflow` / `PostMergeTest` / `PostDeployTest` / `ContinuousTest` / `BakeAlarms` / `CanaryRollout` / `RollingRollout` constructs are the authoring sugar over it, and are built against these types once they are merged — never in parallel with them.

THE THREE MECHANISMS, AND WHICH ONE EACH HOOK COMPILES TO (measured, not assumed)
CommanderSCP has exactly two re-evaluated admission mechanisms, and they differ in blast radius:

```text
WAVE-BOUNDARY GATE  — `coordination/gates.ts`'s `evaluateWaveGate`, called from
  `reconcile.ts`'s `if (activeWave.status === "pending")` branch. It is EVALUATED EVERY TICK
  while the wave stays pending and fires the transition exactly once; a blocked wave simply
  stays `pending` and is re-decided next tick (`gate-orchestrator.ts`: "waiting at a wave
  boundary can never deadlock the engine"). Blocking here stops the WHOLE wave.
```

```text
PER-TARGET HOLD     — ADR-0028's shape: a predicate re-derived per target per tick, refusing
  by `continue` inside `reconcile.ts`'s per-target loop, so SIBLINGS PROCEED. A held target's
  `status` stays `pending`; the hold explains that status, it does not replace it.
```

The choice per hook is therefore a statement about what SHOULD happen to the siblings, and each one below is picked on that basis rather than by analogy:

```text
postMerge   -> wave-boundary gate at WAVE 1. See the `postMerge` doc for why this is not, and
               cannot be, a gate on "entry to the registry" (owner ruling, 2026-08-26).
postDeploy  -> wave-boundary gate at the NEXT wave's entry. Gating "promotion out of wave N"
               IS gating "entry into wave N+1"; a failing integration suite must stop the whole
               widening, not one target of it.
bakeAlarms  -> wave-boundary gate at the NEXT wave's entry, with evidence collected PER TARGET
               (each target's quiet window starts when THAT target deployed). Owner ruling
               2026-08-26, matching D21(b)'s literal "the wave's exit stays closed": an alarm
               anywhere in wave N stops the widening to wave N+1, which is the entire point of
               progressive delivery. A per-target hold would keep widening around the one
               target that noticed.
continuous  -> PER-TARGET HOLD, and this one genuinely must be: a stale canary probe on target
               A says nothing about target B, so blocking B would be a lie about what is known.
```

ASYNCHRONY: A TEST RUN TAKES MINUTES, AND THE CONTRACT ALREADY HAS A WORD FOR THAT
`ControlOutcomeStatus` has no `pending`/`running` member, and it does not need one. The shipped async precedent is `github-check`, which returns `expired` while CI is still in flight ("STILL- RUNNING CI -> `expired`, NOT `fail`"), and `control-runner.ts` re-polls ONLY `expired`, at most once per `EXPIRED_RECHECK_INTERVAL_MS`. Every other status is cached for that gate crossing forever. An in-flight Argo Workflows run is exactly the same situation and takes exactly the same answer — so nothing here invents a new outcome vocabulary, and a hook whose run has not concluded MUST NOT report `fail`.

### §334. Canonical D24 vocabularies

Canonical D24 vocabularies — artifact class, infra kind, the deploy-target narrowing, and the compatibility matrix that ties them together. Lives ONCE here per D24 ("the compatibility matrix ... lives once in @scp/schemas, shared by the construct types and the server"); `@scp/coordination-as-code`'s construct types and the server's plan-time validation both consume these, never a hand-rolled copy.

These replaced two PROVISIONAL declarations (`ArtifactClassSchema` as a bare `z.enum([...])`, `RolloutTargetClassSchema` likewise) that a sibling session shipped so the pipeline-behaviour contract could merge before this vocabulary existed. Every reference to either symbol below is unchanged by the replacement — same name, same shape — only the DEFINITION moved from a hand- written list to a derivation of `ExecutorTypeSchema` / `InfraKindSchema`.

### §335. D24's infra-kind taxonomy

D24's infra-kind taxonomy — the closed set of infrastructure PRODUCT kinds (§14 resolution 10: "a new kind arrives as a release carrying the enum value, the typed construct + interface, and its matrix rows"; org-defined custom kinds wait for a real tenant ask). `@scp/coordination-as-code`'s matching interface types (`ICluster`, `IInstanceGroup`, `IDatabase`, `IBucket`, `IQueue`) are built against this enum by the core IaC increment, not defined here.

SPELLING, RECONCILED DELIBERATELY: D24's prose names the kubernetes kind `Cluster` (as in `ICluster`), but the vocabulary that shipped first — the provisional `RolloutTargetClassSchema` this file already carried (`"kubernetes" | "instanceGroup"`) — spelled it `kubernetes`. This enum picks **`cluster`**, matching D24's own construct-name vocabulary and the sibling members' shape (`instanceGroup`, `database`, `bucket`, `queue` are all named after the KIND OF THING, not the technology backing it — `database` isn't spelled `postgres`). `kubernetes` was the odd one out: it named the implementation, not the product kind, and every other member already named the kind. `RolloutTargetClassSchema` below is now DERIVED from this enum, so its `kubernetes` member is renamed to `cluster` as part of the same change — `@scp/plugin-api`'s sanctioned third copy (`packages/plugin-api/src/index.ts`) is renamed identically, and its pinning test (`rollout-capability-vocabulary.test.ts`) is updated in lockstep so no side is left holding the old spelling.

### §336. `ArtifactClassSchema` / `ArtifactClass` MOVED to `executors.ts`

`ArtifactClassSchema` / `ArtifactClass` MOVED to `executors.ts` (D13 verification, increment 8).

It is DERIVED from `ExecutorTypeSchema` by `.exclude(["infrastructure", "configuration"])`, and that base lives in `executors.ts` — so the derivation now sits beside the thing it derives from. The move (rather than a copy) is forced, not stylistic: `ChangeReportRequestSchema` in `executors.ts` has to accept a reported artifact class, and this file already imports `ExecutorTypeSchema` FROM `executors.ts`. An import back would be a cycle whose failure mode is a ReferenceError at module-evaluation time, not a compile error — the same trap D23 hit and closed the same way when it relocated `Sha256DigestSchema`/`TestBundleRefSchema` to `supply-chain.ts`.

Re-exported here so every existing importer of `@scp/schemas/pipeline-behaviors` keeps working: one definition, two names for the same object, never two lists.

### §337. D12/D24's target class

D12/D24's target class — "TargetClass is this same discriminant — one vocabulary, not two" — now a DERIVED NARROWING of `InfraKindSchema`: only the infra kinds an artifact can actually be DEPLOYED ONTO. D24 is explicit that `Database`/`Bucket`/`Queue` are producible and referenceable (`dependsOn`, `hosted_on`) but "are never deploy targets for artifacts at all" — a rollout declaration keyed by one of them is not a thing that can exist, so it must not be a value this type can hold.

MECHANISM: `.extract(["cluster", "instanceGroup"])` — an explicit allow-list, DELIBERATELY THE OPPOSITE CHOICE from `ArtifactClassSchema` above, and for a reason that has to be stated or it looks like an inconsistency: here the narrow set (deploy targets) is the minority, and widening it must never happen by default. §14 resolution 10 already requires any new `InfraKind` to arrive "with its matrix rows" as a deliberate act; if this were instead `InfraKindSchema.exclude([ "database", "bucket", "queue"])`, a future non-deploy-target kind (say, a `LoadBalancer` product that is likewise never an artifact's placement) would silently become a legal rollout target the moment it was added to `InfraKindSchema`, purely because nobody remembered to add it to an exclude list — exactly the "widen it later for consistency" failure this declaration exists to prevent. An allow-list forces every widening through an edit that names the new deploy target explicitly, here, next to this comment.

### §338. D24's artifact-class × infra-kind compatibility matrix

D24's artifact-class × infra-kind compatibility matrix — the SINGLE definition shared by the construct types (`@scp/coordination-as-code`, core IaC increment) and the server's plan-time validation (`evaluatePlacementCompatibility`-shaped checks). Keyed on the FULL `ExecutorType` (all eleven members, not just the nine-member `ArtifactClassSchema`) because D24's own initial-rows list includes `configuration` — a GitOps sync pipeline places at a cluster or instance group exactly like a build artifact does, so it needs a row too, and keying on `ExecutorType` gives it one for free instead of inventing a second, wider key type.

TOTALITY IS THE POINT: `Record<ExecutorType, readonly InfraKind[]>` is a TOTAL mapping keyed by the enum itself, not a partial lookup table with a fallback default. Adding a member to `ExecutorTypeSchema` without adding its row HERE is a TypeScript compile error (a missing required key on the `Record`), not a silent gap that only shows up when someone tries to place that type and gets an unexplained refusal — or worse, an unchecked placement.

ROWS: `image`/`chart` → cluster; `rpm`/`deb`/`vm-image` → instance group (`deb` is not named in D24's own initial-rows prose, which predates `deb` being folded into the artifact-class vocabulary this session — it is given the same row as `rpm`, the other OS-package artifact class, rather than left with no row, which the `Record` type does not allow); `configuration` → cluster OR instance group (ADR-0017 GitOps sync targets either); `npm`/`maven`/`python`/`go` → empty (library artifacts that publish to a registry and are never placed anywhere — D24: "publish and are never placed"); `infrastructure` → empty (an infrastructure pipeline PRODUCES the infra product, it is never itself placed at one — "placement" is not a concept that applies to it).

### §339. What a test hook points at, never a bare template name

WHAT A TEST HOOK POINTS AT — and why it is never a bare template name.

A `WorkflowTemplate` name is a pointer into whatever the cluster happens to hold right now. Two domains can hold different objects under one name, and the same domain holds a different object next week; a gate that resolves a name at execution time is therefore gating on "whatever is installed today", which is unreproducible and, across a security boundary, unverifiable.

The declared identity is (repo, branch, path) — the pipeline's OWN repo and branch (D17: a `Workflow` scopes to its pipeline, which carries repo + branch, so those are inherited rather than re-typed), and a path within it. `templateName` selects WHICH template inside a multi- template file and is optional only because single-template files are the common case.

This is the DECLARED form. What actually runs is `CapturedWorkflowRefSchema` below.

### §340. Those two schemas live in the supply-chain module

`Sha256DigestSchema` and `TestBundleRefSchema` LIVE IN `./supply-chain.ts`, and the reason is a MODULE CYCLE rather than a taxonomy preference.

`ChangeReportRequestSchema` (`./executors.ts`) is the typed door a build reports its test bundle through, so it must reference `TestBundleRefSchema`. This file already imports `ExecutorTypeSchema` FROM `./executors.ts`, so a matching import back the other way is a cycle: `index.ts` loads this module first, which loads `executors.ts`, which would then evaluate `TestBundleRefSchema.optional()` against an uninitialised binding — a `ReferenceError` at import time, not a type error. `supply-chain.ts` imports neither module and is where digest normalisation (`normalizeSbomDigest`, whose canonical form `Sha256DigestSchema` deliberately matches) already lives, so ONE definition sits there and both sides import it.

### §341. What a hook's run is actually pinned to, once captured

What a hook's run is ACTUALLY pinned to, once the build has captured it.

`commitSha` is the BUILT commit — not "main at trigger time". This is what makes "which tests gate this wave" a reproducible statement about a specific artifact rather than a statement about whatever the branch happened to hold, and it is what lets the same question be answered identically in a domain that has never seen the repo.

### §342. Every hook carries these

Every hook carries these. `hookId` is D16(6)'s stated CDK deviation made concrete: a construct that is a natural singleton per scope defaults its id to the construct kind, and an author only types one when declaring same-kind siblings (two continuous probes on one component). The manifest is explicit either way — D8's rule is inference at synth, explicitness at apply, so the construct DEFAULTS it and the wire always CARRIES it.

IDENTITY is `(componentUrn, kind, hookId)`. Like `ManifestSourceMappingSchema`, there is no update path keyed on a subset: a changed hook is a delete + create, and declaring the same tuple twice in one manifest is rejected.

### §343. POST-MERGE — gates entry to WAVE 1

POST-MERGE — gates entry to WAVE 1.

WHAT THIS DOES NOT GATE, AND WHY (owner ruling 2026-08-26)
An earlier framing had this gating "entry to the registry step". A coordinator cannot do that, and the reason is structural rather than a matter of effort. D22 pins the build step's order as build -> unit -> scan -> origin signature -> push to the registry, ALL INSIDE the team's own build workflow. SCP first learns the artifact exists when the build REPORTS a digest — by which time it is already pushed. There is no moment at which SCP stands between the build and the registry without being in the build's critical path, and standing there would be executing, not coordinating (charter principle 1).

So this hook gates the first thing SCP genuinely controls: the change entering its first wave. The build-internal unit gate is not lost — it is DISPLAYED. D21(d) already requires `scp iac render` to show every gate that will apply "including estate-imposed ones the team never declared", and the build's own unit gate is exactly such a gate. The picture stays the truth; it is the enforcement point that is named honestly.

### §344. Post-deploy gates promotion out of a wave

POST-DEPLOY — gates promotion OUT of a wave, which is the same edge as entry INTO the next one.

`stage` ABSENT IS THE DEFAULT FORM AND GATES EVERY WAVE (D21(a)). A `stage` NARROWS it to waves at that stage. Read that direction carefully, because the intuitive reading is backwards: adding a `stage` REMOVES gates, it does not add one. The default is the strict end of the range on purpose — a team that declares an integration suite and forgets to say where it applies gets it applied everywhere, which is the safe direction to be wrong in.

### §345. Continuous: a canary probe whose latest result holds

CONTINUOUS — a canary probe on a cron, whose LATEST result is a per-target hold.

`maxAgeSeconds` IS REQUIRED, AND STALE-GREEN READS AS ABSENT — NOT AS PASS, NOT AS FAIL
This is the whole reason the hook exists, so it is not an optional refinement. Evidence from a probe that last succeeded six hours ago is not evidence that the target is healthy now; it is evidence that nobody has looked. Collapsing "stale" into "pass" makes a dead prober indis- tinguishable from a healthy fleet — and a dead prober is the more likely of the two.

It does not read as `fail` either, and that distinction is load-bearing for the operator: `fail` means the probe ran and the target is sick; ABSENT means the probe did not report in time. Those demand different actions and must not share a word. Both hold the target; only one of them means the target is broken.

`everySeconds` is the CronWorkflow's schedule and is descriptive here — Argo runs the cron, SCP does not. It is carried so `scp iac render` can show the declared cadence beside the freshness window, since a `maxAge` shorter than the cadence is a permanently-held target and is worth seeing in one place.

### §346. Bake alarms: a quiet window that must pass alarm-free

BAKE ALARMS — a declared quiet window that must pass alarm-free after a target deploys (D21(b)).

Evidence is PER TARGET (each target's window starts when THAT target deployed); the GATE is at the next wave's entry and requires all of them (owner ruling 2026-08-26). Triggers nothing, so it carries no `workflow` — it consumes signals that already exist: the rollout executor's own analysis/health (ADR-0008 observed state, which SCP already reads) and externally PUSHED alarm state (§14 resolution 8). There is no pull integration and no new egress class; see `AlarmStateEvidenceSchema` for why a quiet window has to be ASSERTED rather than inferred from the absence of a report.

### §347. The authority split, declared by the plugin and read

D12's authority split, DECLARED BY THE PLUGIN and read from the binding — never assumed per executor kind. The mirror of this union lives on `ExecutorCapabilities` in `@scp/plugin-api` (which is deliberately free of a `@scp/schemas` dependency) and is pinned to this enum by a total-`Record` test, the same way `DependencyIndexEcosystem` is.

```text
authoritative — SCP's declaration IS the rollout (the `scp-runner-*` managed classes).
triggerParams — passed to the executor's own automation as parameters, where it accepts them.
verified      — the executor owns the rollout; SCP compares DECLARED against OBSERVED
                (ADR-0008 already observes Rollouts weights) and divergence is LOUD. Never
                silently reconciled: SCP does not orchestrate traffic.
```

### §348. When a configuration pipeline places at a product

D25(b) — when a configuration pipeline places at an infrastructure PRODUCT, a change in that product's observed membership (ASG churn, scale-out, replacement) re-applies the CURRENTLY RELEASED, ALREADY-GATED state to the affected target. Not a new release; no wave re-entry.

`converge` is written EXPLICITLY by synth even though it defaults on (D8: inference at synth, explicitness at apply) — so "this fleet self-converges" is a reviewable line in the manifest rather than a server-side default nobody can see. `converge: false` opts out.

`scope` defaults to the changed subset (Ansible idempotence makes that sufficient); a full converge is the drift tool, not the routine path.

### §349. The gate kinds a wave document's native `gates` field may name

The gate kinds a wave document's native `gates` field may name.

OWNERSHIP: this vocabulary and the entry shape are defined here so that the `topology-waves` parser consumes ONE enum rather than minting a second spelling of the same concept; the PARSER change itself belongs to the core IaC increment. `continuous` is deliberately absent — it is a per-target hold, not a wave gate, and a wave document must not be able to ask for it.

A NOTE ON THE COMPATIBILITY POSTURE, because the recorded one does not match the code. §14 resolution 5 says an older outpost "rejects the entry and federation wedges until upgraded", on migration 0043's precedent. Measured, that is not what happens: `release-topology`'s registered property schema (migration 0007) has NO `additionalProperties: false` on the wave object, so Ajv on the receiving side ACCEPTS an unknown `gates` key and the document federates normally. The refusal happens later and more narrowly — an older outpost's `parseTopologyWaves` rejects the unknown key at PLAN-COMPILE time, failing that one change loudly instead of wedging the peer's whole sync. That is 0043's actual rule ("strict at the operator's door, open on the wire") and it is the better outcome; it is recorded here so nobody later "fixes" the wire to match the prose.

### §350. WHAT A PIECE OF EVIDENCE IS ABOUT

WHAT A PIECE OF EVIDENCE IS ABOUT — and why it must be bound to bytes or to a commit.

Unbound evidence is not evidence. "The integration suite passed" is a claim about a specific artifact at a specific place; without the binding it is a claim about the word "passed", and it will be read as covering whatever is deployed next. This repo has paid for that lesson once in the scan layer, where `evaluateScanCoverage` refuses evidence whose `digestMatch !== true` with an explicit `not_digest_bound` code rather than letting a shape-valid verdict cover a digest it never examined.

EXACTLY ONE binding kind is required, and which one is determined by the hook: `postMerge` runs before any artifact exists, so it binds to the built COMMIT; `postDeploy`, `continuous` and `bakeAlarms` all describe something already deployed, so they bind to the artifact DIGEST. Both are permitted on the wire and the consumer requires the one its hook needs — a mismatch is a refusal, never a widening.

### §351. A concluded test run. NOTE THE OUTCOME VOCABULARY

A concluded test run. NOTE THE OUTCOME VOCABULARY: there is no `running`/`pending` member, on purpose. Evidence is a record of something that FINISHED; an in-flight run is expressed by the ABSENCE of evidence (which the freshness rule below already handles correctly) plus the control's `expired` status, which is the mechanism the tree already uses and re-polls. A `running` member here would be a second, competing representation of the same fact.

### §352. ALARM STATE OVER A NAMED WINDOW

ALARM STATE OVER A NAMED WINDOW — a POSITIVE assertion of quiet, never an inference from silence.

THIS IS THE WHOLE DESIGN OF THE BAKE HOOK, SO IT IS WORTH BEING BLUNT
"No alarm report arrived" and "the window was observed and nothing fired" are not the same fact, and a bake gate that treats them as one passes every time the alarm pipeline is broken — which is precisely when it should not. So a report must NAME the window it covers (`windowStart` .. `windowEnd`) and list what fired in it; an EMPTY `alarms` array is then a real claim, and no report at all leaves the gate closed.

Same shape of reasoning as `continuous`'s stale-reads-as-absent rule, and the same failure mode on the other side of it: the state that means "I am not looking" must never be spelled the same way as the state that means "I looked and it was fine".

### §353. The push door's request body

The push door's request body (owner ruling 2026-08-26: a dedicated typed evidence route, NOT an evidence mode bolted onto `POST /change-sources/{kind}/report`).

WHAT IS DELIBERATELY *NOT* IN THIS SHAPE: THE PRODUCER
There is no `producer` / `source` / `reportedBy` field, and one must never be added. The governing rule is already written down in `federation/scan-evidence.ts`, which exists because a shape-valid payload is forgeable by anyone who can read the schema: PROVENANCE — which authenticated principal and which plugin module produced the row — IS THE AUTHORIZATION BOUNDARY, NOT THE PAYLOAD SHAPE. A caller-supplied producer field is a self-attested claim about exactly the thing being checked, so the server stamps it from the authenticated subject at insert, the same way `control_runs.plugin_module` is stamped and deliberately not re-derived later.

The second half of the same rule: this route authorizes at the SUBJECT'S TARGET, not at the org root. Pushed alarm state unlocks a production bake gate, so "who may say the window was quiet" has to be as narrow as "who may deploy there" — an org-root-scoped write permission on a gate unlock is a privilege escalation wearing a reporting API's clothes.

### §354. The push door's receipt

The push door's receipt.

IT ECHOES THE STAMPED PROVENANCE BACK, and that is the point of it rather than a courtesy: the request deliberately cannot say who produced the row (see above), so the only way a reporter can confirm what was actually recorded about it is to be TOLD. `producerSubjectId` is the authenticated subject the server stamped and `source` is the constant `pushed` — neither is echoed from anything the caller sent, because neither was sendable.

`evidenceId` is the row's own id, so an operator chasing a gate verdict can join a `HookFreshnessContext.latestEvidence.evidenceId` in a Decision back to the submission that produced it.

### §355. WHAT A HOOK'S DECISION RECORDS, AND WHY `now` IS NOT IN IT

WHAT A HOOK'S DECISION RECORDS, AND WHY `now` IS NOT IN IT.

THE TWO RULES THIS SATISFIES AT ONCE — THEY LOOK OPPOSED AND ARE NOT
Rule 1 (ADR-0033 §6a, and the campaign-deadline note): expiry is a READ-TIME comparison, never a status column a job flips. Nothing in this tree sweeps rows to mark them stale, so staleness must be decided fresh, every tick, against the clock.

Rule 2 (ADR-0024, and the measured 1.44 GB/day incident): a Decision persists ON CHANGE, so its `inputContext` must be BYTE-IDENTICAL across ticks while the underlying facts are unchanged. Put `now` in it and every tick writes a new row forever.

Both hold simultaneously because they govern different things. The COMPARISON uses the clock and is redone every tick (rule 1). The RECORD carries only the data the comparison consumed — the evidence's own `completedAt`, the declared `maxAgeSeconds`, and their sum as `staleAfter` — so it is stable for as long as that evidence is the latest, and changes exactly when the evidence does (rule 2). `gate-orchestrator.ts` already does precisely this for freezes: `endsAt` is read straight off the row into `inputContext`, with the comment "NOTHING HERE IS DERIVED FROM A CLOCK ... so a re-evaluated block is byte-identical on every tick". This is that pattern, named.

`staleAfter` is therefore a DERIVED CONSTANT, not a deadline anybody enforces — the enforcement is the read-time comparison. It is recorded so that an operator reading the Decision six weeks later can see the boundary the engine actually applied, instead of re-deriving it from a `maxAge` that may since have been edited.

### §356. The per-target hold entry a `continuous` hook produces

The per-target hold entry a `continuous` hook produces (ADR-0028 shape).

COMPOSED AT READ TIME, NEVER PERSISTED — the same rule the freeze-hold projection on `ChangeWaveTargetSchema` follows and for the same reason: a hold fed from a Decision row would still say "held" long after fresh evidence arrived, because the holding Decision has no clearing counterpart. Present only while the target is genuinely held; absent on the next read once a fresh green lands.

`reason` distinguishes the three states that all hold but mean different things, because an operator's next action differs for each: `no_evidence` (the probe has never reported — check the prober), `stale` (it reported and then stopped — check the prober), `failed` (it reported and the target is sick — check the target). `summary` is a SERVER-COMPOSED sentence, per charter principle 6 and the established idiom that the UI composes no copy from raw fields.

### §357. A pipeline declares its artifact class, then it is verified

D13 — a pipeline DECLARES its artifact class, and the declaration is then VERIFIED against what the build actually produced. A mismatch is loud, Decision-backed, and never silently re-inferred.

WHY VERIFY AT ALL, GIVEN THE ENUM IS CLOSED AND TYPE-CHECKED: the closed enum stops a typo, not a lie. The declared class selects the journey template — an image builds/pushes/bumps/syncs, an RPM builds/publishes/batch-installs — so a component that declares `image` and actually produces an RPM gets an entire journey shaped for bytes it does not have, and every step "succeeds" against nothing. That failure is silent precisely because each individual step is fine.

`observed` is `null` when the evidence carried nothing to check — which is NOT a match. The verdict for "no evidence yet" is `unverified`, and it is spelled differently from `match` so that a journey running on an unverified declaration is a visible state rather than an assumed pass.

`declared` IS THE FULL `ExecutorTypeSchema`, NOT `ArtifactClassSchema` — widened when this record gained its first consumer (increment 8). The declaration read at propose time is `source_mappings.type`, whose column default is `configuration`, so the non-build members are reachable values on the declared side and a narrower type would make them unrepresentable. That matters for a real case rather than a hypothetical one: an `infrastructure` or `configuration` pipeline that reports having produced an `image` is precisely a mismatch worth refusing, and narrowing `declared` would have forced a SECOND parallel mechanism to carry it. One total function, one record, one refusal path.

`evidenceSource` NARROWED to the single member `buildReport`, also on gaining its first consumer. It previously also listed `registryObservation`, which NOTHING PRODUCED — the whole reason this record sat unbuilt. A member no code can emit reads as coverage that does not exist, so it is removed rather than carried: registry observation returns to this enum when something actually observes a registry IN THIS VOCABULARY (today's `artifact` objects speak `artifactType`, a different vocabulary, and are minted at promotion export — after this verdict is computed). The field stays an enum rather than collapsing to a constant because naming WHICH evidence answered is the point, and the set is expected to grow.

## `packages/schemas/src/rbac.test.ts`

### §358. THE RBAC CONTRACTS

THE RBAC CONTRACTS — what the SCHEMA refuses, as opposed to what the door refuses

`routes/role-bindings.ts`'s handlers are exercised against real PostgreSQL in `apps/server`. This file is about the layer BELOW them: several of this increment's security properties are enforced by the Zod contract and by nothing else, so they are invisible to a test that goes through the route — a request the schema rejects never reaches a handler, and a field the schema STRIPS reaches it as `undefined` no matter what the client sent. If the contract silently relaxed, the integration suite would stay green while the property was gone.

The four properties pinned here, each with the consequence of losing it:

1. `effect` (and `roleName`) are NOT writable. `role_bindings.effect` is `'allow' | 'deny'` and a deny overrides every allow at any matching scope; the module doc rules a deny out of this increment because the no-escalation subset rule is UNSOUND for one. The repo never reads the field off the body, so what actually blocks the mass assignment is that the contract drops it. 2. `acknowledgedPrincipalIds` is OPTIONAL. D7's requirement is CONDITIONAL (groups and teams only) and is enforced at the door with a 422. Making it schema-required would force every grant to a user to carry `[]` and would be a BREAKING request change on this repo's oasdiff gate — the shape was chosen so the operation stays true if it is ever cut and re-landed. 3. `undefined` and `[]` are DIFFERENT values that survive parsing distinctly. The door reads them as "I did not look" and "I looked and it is empty" and admits only the second for a group. A `.default([])` on this field would erase that distinction silently, and the exploit D7 exists to stop — seat the group AFTER the grant — would be admitted with no acknowledgement at all. 4. Response fields that a client must not have to derive — `Role.deprecated`, `GrantPreviewResponse.acknowledgementComplete` — are REQUIRED and always present, because an absent field reads as "old server" and the client guesses.

## `packages/schemas/src/rbac.ts`

### §359. ROLES AND ROLE BINDINGS

ROLES AND ROLE BINDINGS — the API surface that finally makes `role_binding:write` mean something

`role_binding:write` has been seeded onto Administrator and Owner since `drizzle/0002` and was checked at ZERO call sites for its whole life, because there was no role-binding API at all: the committed OpenAPI document had ~177 paths and not one of them touched roles or bindings (docs/proposals/role-model.md §1.2). The only two production writers of `role_bindings` were `auth/local-auth.ts` (bootstrap admin -> Owner at the org root) and `auth/oidc.ts` (JIT OIDC user -> Viewer at the org root), so a real deployment had exactly TWO authority levels and every finer scope was reachable only by hand-written SQL — outside RLS, outside the audit chain, with no Decision record. Every purpose role `drizzle/0099` seeds is inert until these four operations exist. This is role-model.md §5 step 5.

WHAT IS DELIBERATELY *NOT* HERE
- **No `POST`/`PATCH`/`DELETE /roles`.** Custom roles are role-model.md §5 step 10 and are gated behind closing a live quorum bypass first: `hasRoleAtScope` (`authz/resolve.ts`) joins `roles` and matches `rl.name` with NO `org_id` predicate on the roles row, while the binding half IS org-filtered. So an org that could author a zero-permission role named `'Approver'` would instantly make its holders eligible quorum voters everywhere a policy names Approver — a self-service quorum bypass. `GET /roles` is READ-ONLY in this increment.

- **No `effect` on the write request.** `role_bindings.effect` is `'allow' | 'deny'` and a deny overrides every allow at any matching scope. It is present on the RESPONSE (a deny row that exists must be visible, and revocable) and absent from `CreateRoleBindingRequestSchema`, because the no-escalation subset rule that governs a grant is UNSOUND for a deny: writing a deny is not granting authority, it is removing it, and "is deny-X a subset of my permissions" is a category error rather than a hard question. role-model.md §5 step 5 rules it out of this increment; the shape a deny door needs is its own decision, not a boolean bolted onto this one.

- **No `roleName` on the write request** — `CreateRoleBindingRequestSchema` takes a role `id` only. A name would have to be resolved against `org_id IS NULL OR org_id = <this org>`, which the `roles_builtin_name_key` PARTIAL unique index (drizzle/0097) deliberately allows to match two rows, and picking between them is exactly the name-collision class the paragraph above refuses to open. An id cannot be ambiguous.

### §360. One role, as `GET /api/v1/roles` publishes it

One role, as `GET /api/v1/roles` publishes it.

`permissions` and `bindableAt` are `string[]`, NOT enums, and that is a contract decision rather than laziness. `roles.permissions` is a plain `text[]` with no CHECK and no enum type behind it (drizzle/0002 §7), so a restored dump or a hand-written row can legitimately hold a string that is not in today's `Permission` union — an enum here would make the endpoint 500 on data the database accepts. And measured previously on this repo's oasdiff gate: adding a member to a RESPONSE enum is a BREAKING change, so an enum would make every future permission split (there have been five grant migrations already) a `/v1` break. `effect` below is the deliberate exception: it is CHECK-constrained to exactly two values by `role_bindings_effect_check` (drizzle/0097), so that set is closed by the database rather than by convention.

### §361. D5 (owner ruling, role-model.md §7.1)

D5 (owner ruling, role-model.md §7.1) — `true` for a built-in the write door refuses NEW bindings to. A UI greys the row; the row itself stays, and every EXISTING binding to it keeps resolving unchanged. This is a refusal at the door, not a removal.

Required-and-always-present rather than optional: an absent field reads as "old server" and the UI would have to guess. It is `false` for every role but the deprecated ones.

### §362. Unpaginated, deliberately. `roles` is a bounded catalogue

Unpaginated, deliberately. `roles` is a bounded catalogue — ten built-in singletons today, plus whatever an org has hand-written, and there is no authoring API to grow it (see the module doc). Same shape as `PatListResponseSchema`. Adding `nextCursor` later is an additive response change; paginating a ten-row catalogue now would only make every consumer write a loop.

### §363. Filter to bindings written AT this exact object

Filter to bindings written AT this exact object. Deliberately an exact match and not a containment walk: "who is bound at this service" and "whose authority reaches this service" are different questions, and the second one is `GET /authz/effective` (role-model.md §5 step 6). Answering the second here under the first one's name would be the more dangerous of the two to get wrong.

### §364. `POST /api/v1/role-bindings` — a GRANT

`POST /api/v1/role-bindings` — a GRANT.

`reason` is MANDATORY, matching `LiftFreezeRequestSchema`: handing a principal authority over part of the estate is a governance act, `audit_events` has no payload column, and the operator's own words are the one thing the structured Decision this door writes cannot reconstruct.

### §365. The granter states whom this binding will empower

D7 (owner ruling 2026-08-27) — THE GRANTER STATES WHOM THIS BINDING WILL EMPOWER.

THE PROBLEM IT ANSWERS, and it is not escalation. Binding a role to a group hands that role to every principal `member_of` reaches, including one who self-joined while the group was empty. The granter already holds the role, so nothing is escalated — what they cannot do is SEE whom they are empowering, and a previous round measured that no membership-shape-blind rule separates the exploit from the legitimate "bind SecurityOfficer to the security team" (every authority bar on this door asks about the ACTOR, the ROLE and the SCOPE, and none reads the subject's identity, so a standing-based refusal here admits every request it is ever asked about). The owner ruled: make the grant INFORMED rather than refused.

WHY AN ID LIST, and not a count and not a digest
All three shapes were weighed against what a UI and a CLI can each produce and against what a stale value means.

- **A COUNT is producible without ever reading the membership** — which is precisely the blindness the ruling is about — and it is unchanged by a substitution (member A out, member B in), so it witnesses the wrong property. - **A DIGEST needs the same input an id list needs** (the caller must have the ids to hash them), so it costs the caller exactly as much, and it destroys the server's ability to name the DIFFERENCE: from a hash the 409 can say "not what you acknowledged" and nothing more. This repo's standing rule is that a refusal names what is wrong. - **AN ID LIST is the only shape in which the caller has demonstrably handled every principal**, and it lets the mismatch be reported in both directions — ids reached but not acknowledged (a member joined between the caller's read and its write), and ids acknowledged but no longer reached (a member left, or the caller sent something it never read).

The value is the FULL `member_of` closure below the subject — every principal at depth > 0, nested groups and teams included, because a nested group is itself empowered and naming it is how the caller learns the nesting exists. It is the identical set the door's §2b membership walk computes, from the identical `memberExpandCte` definition, so the field can never mean something different from what the binding does. Order is irrelevant; duplicates are irrelevant; the comparison is set equality.

OPTIONAL IN THE CONTRACT, REQUIRED AT THE DOOR — and which one this is, is a decision
The requirement is CONDITIONAL: mandatory when `subjectId` names a `group` or a `team`, absent for a `user` or `service-account`, because the ruling says not to burden the common case. A schema-level `required` cannot express "only when the subject is a group" — it would force every grant to a user to carry `[]` — so the field is optional here and its absence is refused at the door (422) when the subject is a group or team.

That also keeps the OpenAPI change unambiguously additive. Adding a REQUIRED request property to an existing operation is a breaking change on this repo's oasdiff gate; it happens not to bite here, because `POST /api/v1/role-bindings` does not exist in the committed document at all (it ships in this same increment, and a NEW path is an addition), but relying on that would leave a field that could never be relaxed afterwards. Optional-with-refusal is the shape that stays true if the operation is ever cut and re-landed.

HOW A CALLER LEARNS THE VALUE — `GET /api/v1/role-bindings/grant-preview?subjectId=…`
A field a CLI cannot compute is a field nobody can use. The preview operation (`GrantPreviewResponseSchema`) walks the same closure and returns `acknowledgedPrincipalIds` ready to paste into this body, alongside the per-principal detail a UI renders. One call, no `member_of` traversal in the client, and the same walk on both sides.

⚠️ **THE PREVIEW PROJECTS ONLY WHAT ITS CALLER COULD ALREADY READ**, so for a caller whose `object:read` does not reach every empowered principal the value it returns is INCOMPLETE and this door will 409 on it. That response says so in a field (`acknowledgementComplete`) rather than leaving it to be discovered, and `GrantPreviewResponseSchema` carries the measurement of who is and is not in that population. Such a caller is not stuck: the 409 this door throws NAMES every id it was not given, and that disclosure sits behind `role_binding:write` at the scope plus the whole no-escalation subset rule — a strictly stronger bar than the preview's `audit:read` — so the acknowledgement costs them one extra round trip rather than being unobtainable.

THE EMPTY GROUP — `[]` IS EXPRESSIBLE AND MEANS SOMETHING
`[]` states "this binding empowers nobody today", which is the legitimate seat-the-team-later flow AND the exploit's step 2. It is accepted, because acknowledging zero is a TRUE statement at the moment of the grant, and because the follow-on it enables is separately guarded: joining a group that already holds a binding runs the no-escalation subset rule at the choke point (`docs/authz/role-binding-door.md` §2a), so an empty group can only be seated afterwards by a principal who already holds everything it carries. `undefined` and `[]` are therefore NOT the same thing here — the first is "I did not look", the second is "I looked and it is empty" — and only the second is admitted for a group subject.

The bound is `member_of`'s registered cardinality times the closure depth in practice; 5000 is a request-size guard, not a model limit, and a group larger than that cannot be acknowledged through this field. Recorded as a limit rather than left to be discovered.

### §366. What the acknowledgement must equal, previewed

`GET /api/v1/role-bindings/grant-preview` — what `acknowledgedPrincipalIds` must say.

READ-ONLY, and it answers exactly one question: "if I bind a role to this subject, whom does that empower?". It names no role and no scope because the answer does not depend on either — the membership closure is a property of the subject alone — and inventing parameters the answer ignores would be a contract that lies about what it consults.

### §367. The prospective binding's subject

The prospective binding's subject. Any object; a `user`/`service-account` legitimately previews as an empty list, which is what makes the field's rule uniform rather than special-cased.

**THE ONLY PARAMETER, AND IT IS ALSO THE AUTHORIZATION ANCHOR.** An earlier revision took a `scopeObjectId` too, described as "an AUTHORIZATION input, not a filter": present, it admitted a holder of `audit:read` at-or-above THAT object. That was the §2b disclosure defect re-introduced one layer up, in the affordance built to make D7 usable — the scope a caller names is chosen by the caller, so any holder of a scoped `audit:read` anywhere in the org could name their own service and read the full transitive membership of ANY group in the org. The preview must not tell a caller anything they could not already read, so the check is now anchored to the SUBJECT whose membership is being disclosed (`routes/role-bindings.ts`).

**THE ANCHOR IS NECESSARY AND IS NOT SUFFICIENT**, and the next round measured why: the principals disclosed are not the subject, so authorizing at the subject still handed a team-scoped reader the identities of members that reader's own `GET /objects/user/{id}` refuses. The PROJECTION is filtered too — see `GrantPreviewResponseSchema`.

### §368. One principal the binding reaches and the caller may read

One principal a binding on the previewed subject would reach **and the caller may read**. See `GrantPreviewResponseSchema`'s projection rule: this array contains only principals inside the caller's readable scope as `authz/readable-scope.ts` computes it.

That set equals what `GET /api/v1/objects/{type}/{id}` admits, with ONE measured exception: an org-root reader carrying a `deny` lower down. `org-root-arm.ts`'s org-root arm never consults such a deny, so the filter's `null` short-circuit shows the row while get-by-id refuses it. That is not a widening introduced here — the LIST doors already return the same rows to the same caller from the same short-circuit — but it means "get-by-id would admit it" is the wrong rule to state, and stating it as an absolute is how a reader is misled. `role-binding-door.ts`'s `readableSubsetOf` carries the divergence in full.

### §369. THE PROJECTION RULE

THE PROJECTION RULE — this response must not tell a caller anything they could not already read

THE DEFECT IT CLOSES, MEASURED. Gating the operation at the SUBJECT (the previous round's fix) settles who may ask about a group. It does not settle what may come back, **because the principals disclosed are not the subject**: a `member_of` member is a separate graph object with its own containment chain, and `authz/resolve.ts`'s scope walk expands UPWARD, so a Viewer bound at a TEAM reaches the team and reaches nothing through it. Measured on that exact fixture — a team-scoped Viewer received a **200** carrying the `id`, `typeId` and `name` of a member whose own `GET /api/v1/objects/user/{id}` answers **403** for the same token.

SO THE PROJECTION IS FILTERED, NOT JUST THE GATE. `principals` and `acknowledgedPrincipalIds` contain only principals the caller holds `object:read` at — the same resolved answer `GET /objects/{type}/{idOrUrn}` is judged by — and the remainder is reported as `GrantPreviewResponseSchema`'s `withheldPrincipalCount`.

**A BARE COUNT, DELIBERATELY, AND IT IS A TRADE RATHER THAN A ZERO.** It still discloses that the group has members this caller may not see, which is a fact about rows they cannot otherwise reach. It is accepted for the reason role-model.md §8.2 accepts query-side filtering on the list doors: the alternative that leaks strictly less — omit the count entirely — makes the response indistinguishable from "this group is empty", which is exactly the state D7 exists to stop a granter mistaking. The count names nobody and cannot be resolved to an identity through any door, and it is already implied for any caller who can reach the grant door at all (its 409 names the full set). It is NOT inert, and the honest statement of the trade says so: it is a size signal that CHANGES with the membership, so a caller who may see none of a group can still poll it and observe that the group grew. Measured: a team-scoped Viewer seeing `principals: []` throughout read 0, then 1, then 2 as an admin added members. Accepted for the same reason the rest of the trade is.

**WHY NOT A DIGEST INSTEAD OF IDS.** Weighed and rejected for the same reason the request field is an id list rather than a hash (`CreateRoleBindingRequestSchema`): a digest is computable only by a caller who already holds the ids, so it withholds nothing from the caller who is refused here and destroys the ability to name the difference for the caller who is not.

D7 STILL WORKS, AND WHICH CALLERS IT WORKS FOR IS MEASURED RATHER THAN ASSUMED
The acknowledgement would be theatre if the preview hid members from the very person about to empower them. It does not, and the reason is a property of the seeded catalogue rather than a hope: **every built-in role that carries `audit:read` also carries `object:read`** (drizzle/0002 §7 and drizzle/0099 — Viewer, Operator, Approver, Administrator, Owner and every purpose role), so a caller admitted by this door's ORG-ROOT arm reads every rooted object in the org and `withheldPrincipalCount` is 0 for them. That is the caller who grants at the org root, which is where a group binding of an administrative role is written. Pinned by `routes/rbac-administrative-floor.integration.test.ts`, in both directions.

THE RESIDUAL POPULATION IS NAMED RATHER THAN WISHED AWAY: a caller admitted only by the SCOPED arm — `audit:read` at-or-above the group, from a binding somewhere below the org root — may hold no `object:read` over members that live elsewhere in the estate. They get `acknowledgementComplete: false`, and pasting the value they were given IS refused. **They are not handed a field that 409s forever**: `POST /role-bindings`'s own 409 names every id missing from the acknowledgement, and that refusal sits behind `role_binding:write` at the scope plus the full subset rule — a strictly stronger bar than this operation's `audit:read` — so the second attempt succeeds. Measured end to end (403-on-the-member, filtered preview, 409 naming the member, 201 on the retry) rather than reasoned about.

### §370. True when this caller can see the whole compared set

`true` when this caller can see the WHOLE set the door will compare against — i.e. `withheldPrincipalCount` is 0 — and `acknowledgedPrincipalIds` may therefore be sent as-is.

Required and always present rather than left to be derived from the count, for `RoleSchema`'s `deprecated` reason: a client that has to compute "is this value usable" from two other fields is a client that will get it wrong once, and getting it wrong here means pasting a value the grant door refuses.

### §371. True when this subject's membership is IdP-managed

`true` when this subject's membership is managed by an IDENTITY PROVIDER (`auth/identity-sync.ts` — the group carries an `externalIdentity.claimValue`).

WHY THIS IS ON THE PREVIEW AND NOT JUST IN A DOC. D7 asks the granter to acknowledge WHOM a group binding empowers, and the acknowledgement is a statement about a moment. For a directory-synced group that moment is shorter than it looks: the membership this response enumerates is whatever the provider said at the last login of each member, and it changes without anyone touching SCP. A granter who reads the list and concludes "these five people" has understood the wrong thing.

So the honest framing, which a UI should render and a CLI should print: binding a role here delegates the choice of WHO HOLDS IT to whoever administers the directory. The acknowledgement still means what it says about today; it stops being a control tomorrow, and this flag is how the caller finds that out BEFORE granting rather than afterwards.

### §372. Effective permissions: what this subject may do here

EFFECTIVE PERMISSIONS — role-model.md §5 step 6

`GET /api/v1/authz/effective?scopeObjectId=…` — "what may I do at THIS object".

WHY THIS OPERATION HAS TO EXIST. With five purpose-shaped roles the cumulative ladder is gone: a principal is no longer "Operator and therefore everything below Operator", and there is no ordering a UI can use to guess. A SecurityOfficer holds `scan:override` and NO `object:write`; an OrgAdmin holds `policy:write` and NOT `scan:override`. Nothing about either is derivable from a rank, so a client that wants to know whether to render a control has exactly two options: ask, or POST and find out from the 403. role-model.md §5 step 6 records that the second is not a usable UI.

THE ANSWER IS ABOUT ONE OBJECT, DELIBERATELY. `authz/resolve.ts`'s scope walk expands UPWARD, so authority at an object comes from bindings at it or ABOVE it, and "what may I do" has no org-wide answer — only a per-object one. This is the question `GET /role-bindings?scopeObjectId=` explicitly REFUSES to answer (that filter is an exact match on where a binding is written, and answering the containment question under its name would be the more dangerous of the two to get wrong).

### §373. The permissions held at this scope, deny already applied

The permissions held at this scope, sorted, deny-override already applied.

`string[]` and not an enum, for `RoleSchema`'s reason: `roles.permissions` is an unconstrained `text[]`, and a response enum cannot gain a member without breaking this repo's oasdiff gate — which would make every future permission split a `/v1` break.

### §374. Custom roles: the authoring routes and their shapes

CUSTOM ROLES — role-model.md §5 step 10

`POST /roles`, `PATCH /roles/{id}`, `DELETE /roles/{id}` — an org authoring its own roles.

THIS WAS GATED, AND THE GATE IS NOW CLOSED. The module doc above says `GET /roles` is read-only "gated behind closing a live quorum bypass first". That bypass — `hasRoleAtScope` matching `rl.name` with no `org_id` predicate, so an org's own 'Approver' conferred quorum eligibility everywhere a policy named Approver — was closed by owner decision on 2026-08-27: quorum eligibility resolves BUILT-IN names only. Custom roles carry permissions and are bindable; they can never satisfy an approval quorum. That is the property that makes this API safe to ship, and it is enforced in `authz/resolve.ts` rather than here.

WHAT AUTHORING IS AND IS NOT
Authoring a role CONFERS NOTHING BY ITSELF — a role with no bindings grants no one anything, and `POST /role-bindings` applies the full no-escalation subset rule to every attempt to bind it. So the load-bearing bar against escalation is, and remains, the binding door.

The subset rule is applied HERE TOO, and the reason is not escalation: a catalogue in which a `Viewer` can author a role named 'Estate Owner' carrying `freeze:override` is a catalogue that LIES to every operator who reads `GET /roles`, and it invites the social-engineering step where someone with authority binds it without reading its array. Refusing at authoring keeps the catalogue honest. Stated plainly because "defence in depth" is where unexamined bars accumulate.

### §375. A partial update

A partial update. Omitted fields are left alone rather than cleared — a PATCH that dropped `bindableAt` because the caller did not mention it would silently widen where the role may be bound.

⚠️ WIDENING A ROLE WIDENS EVERY EXISTING BINDING OF IT, with no re-check — the same property `docs/authz/role-binding-door.md` §8 records for built-ins, except that here it is reachable through the API rather than only through a migration. The subset rule bounds it: a caller may only add permissions they themselves hold at the org root, so a role can never be widened past its editor's own authority. It is NOT bounded by what the original AUTHOR held, and it is not re-checked against the holders — both stated rather than implied.

### §376. INSTANCE OPERATOR CREDENTIALS

INSTANCE OPERATOR CREDENTIALS — role-model.md §5 step 9 / §3B

Replaces the single shared `SCP_OPERATOR_TOKEN` with named, hashed, individually revocable, optionally expiring credentials. See `auth/operator-auth.ts` for what was wrong with the shared string; the short version is that it cannot be rotated, revoked for one person, or expired, and it makes "who was entitled to do this" have the same answer for everyone who has ever seen it.

NOT ORG-SCOPED. These are instance tier — the authority they carry binds every organization on the deployment — so the operations are gated by an operator credential, never by an RBAC permission. A tenant, however privileged inside its own org, must never author config that binds its neighbours.

### §377. How the CALLING request was admitted

How the CALLING request was admitted. `bootstrap-env-token` means this deployment is still relying on `SCP_OPERATOR_TOKEN` — surfaced because the migration from it is otherwise invisible: an operator would have no way to tell a deployment that has moved from one that has merely minted credentials and never stopped using the env var.

## `packages/schemas/src/registries.ts`

### §378. M2 typed-registry ergonomics

M2 typed-registry ergonomics (BUILD_AND_TEST.md §8 M2 item 1). The typed convenience endpoints (routes/typed-registries.ts) and their `owns`/`consumes`/`depends_on` sub-resources (routes/ownership.ts) are structurally identical to the generic `/objects/{type}` and `/relationships` endpoints — they reuse `GraphObjectSchema`, `CreateObjectRequestSchema`, `UpdateObjectRequestSchema`, `UpsertObjectRequestSchema`, `ObjectListResponseSchema`, `RelationshipSchema`, and `RelationshipListResponseSchema` directly (graph.ts). This file only adds the handful of shapes that don't exist yet: the ownership/consumes/depends-on request bodies, and path params for routes with a second id-or-urn segment in the URL.

## `packages/schemas/src/scan-db.ts`

### §379. M13.3b-ii — OFFLINE SCANNER-DB PRE-LOAD + REFRESH

M13.3b-ii — OFFLINE SCANNER-DB PRE-LOAD + REFRESH (ADR-0020, proposal §13.3b).

The commander's promotion scan step (`federation/promotion-scan-step.ts`) runs the `scp-runner-scan` container `--network none`; the Trivy vulnerability DB is either BAKED into that image at build time (the fail-closed fallback) or PRE-LOADED from a server-maintained cache that the operator keeps fresh. This file carries the TYPED shapes for that cache's operator surface (API -> SDK -> CLI, charter principle 3): its status, the operator-configurable staleness policy, the connected refresh, and the air-gap operator-load.

WHY OPERATOR-LOADED, NOT PROMOTION-CHANNEL, FOR THE AIR-GAP (owner decision 2026-07-24): the commander sits at the TOP of the federation with NO into-commander byte channel — the relay flows downward + change-bound, and `.scpbundle` is metadata-only (ADR-0009). So a disconnected commander cannot RECEIVE a DB over the promotion channel. The operator instead carries the cosign-signed DB blob across the CDS and loads it into the cache (digest-bound + detached-signature verify before accept). The proposal §13.3b's "promotion-channel refresh (air-gapped)" was wrong for the commander and is corrected to operator-loaded (proposal §13.3b + the scan-db-refresh runbook).

### §380. The commander-level, INSTANCE-SCOPED staleness policy

The commander-level, INSTANCE-SCOPED staleness policy — modeled EXACTLY like M17.5's `scan_requirement_floors` (governance/scan-requirements.ts + drizzle 0029): no `org_id`, tenant SELECT (a gate a tenant cannot inspect is not explainable), operator-only write. A company applies its own rules at RUNTIME (owner decision 2026-07-24), no redeploy. Both bounds nullable so an operator can clear one back to the built-in default without deleting the row.

### §381. The DB cache's status

The DB cache's status — tenant-readable so a blocked promotion's Decision (and an operator's `scp scan-db status`) can explain WHY the DB failed closed / warned. Surfaces the age + source + schema compatibility + which threshold fired + the active thresholds (item 4/5, owner 2026-07-24).

### §382. Air-gap operator load: a signed database blob

Air-gap operator-load — the operator produced a cosign-signed DB blob at the connected side (skopeo-pull + repackage + cosign sign-blob), walked it across the CDS, and placed it (plus its detached signature + the signing public key) on a path reachable by the commander. The server VERIFIES the detached signature (and, when given, the digest) BEFORE accepting the bytes into the cache (atomic swap). No new federation message/flow; the blob is the SAME `type:'blob'` shape as the connected-repackage. Paths are server-local (operator-token gated) so hundreds of MB never traverse the JSON API.

## `packages/schemas/src/scan-exclusion-classes.test.ts`

### §383. The no-fix and vendor-rule exclusion classes

M22.3 (`no fix available`) and M22.4 (the vendor rule, owner decision D1) — THE TWO CLASS PREDICATES, pure.

`scan-exclusion-classes` rather than an addition to `supply-chain.test.ts` because these are tests of the CLASSES, not of the exclusion machinery: M22.2 already pins the machinery (admission, application-before-counting, the truncation refusal, the evidence projection) and those tests must keep failing for their own reasons.

WHAT THE TWO CLASSES HAVE IN COMMON, and why they are in one file: both answer "is this finding one we have already done everything about?", and both must fail CLOSED on every absence. M22.3 reads one field off the finding; M22.4 reads facts the SERVER resolved and serialized. Neither may ever degrade into "the narrowing matchers alone", because a clause whose class contributes nothing excludes a strictly LARGER set than the same clause with its class enforced.

MUTATIONS RUN against this file — measured, reverted by an exact inverse edit, recorded in the increment report rather than predicted here.

### §384. Lines are keyed by major, and what at-head-ness means

`dependency_lines` is keyed by `(ecosystem, coordinate, MAJOR)` and at-head-ness is computed per line, so a component declaring `lodash@4.17.21` (head of `4`) AND `lodash@3.10.1` (behind head of `3`) has exactly one at-head line. A version-less key projected both onto `npm|lodash` and excused the 3.10.1 finding — the current sibling voting away the stale one that `foldVendorLatestFacts`' own docblock says cannot happen.

### §385. THIS CASE INVERTED

THIS CASE INVERTED (owner decision, 2026-08-18). A blanket `fixedVersion !== undefined ⇒ refuse` backstop was implemented in the review round and removed: it reads like free fail-closed safety and instead refuses the exact case D1 exists for. The component IS at the head of the line it declared; the fix shipped in a different major line, and a major upgrade is a project rather than a patch. With the backstop, `vendor_latest` excused nothing that `no_fix_available` would not already excuse, so the class could not earn its own existence.

### §386. The half that makes dropping the backstop safe

The half that makes dropping the backstop safe, and the reason it cost nothing real. If a fix shipped INSIDE the declared major line then the line's head has moved past what is installed, the org's own inventory says so, and the join refuses on that basis — from observed data rather than from the scanner's opinion. `atHead` puts the line at 4.17.21, so an artifact still carrying 4.17.20 misses the key no matter what `fixedVersion` says.

### §387. The parser retains an entry on its severity alone

`parseTrivyFindings` retains an entry on its severity alone, so this is a real shape. The facts say which VERSION is at head; a finding that will not say which version it is gets no pass, rather than falling back to matching on the name — which was the whole defect.

WHICH MUTATION THIS ACTUALLY KILLS, measured rather than claimed: deleting the predicate's `installedVersion === undefined` refusal leaves this green, because a `…|undefined` key misses the set anyway. It dies against the mutation that MATTERS — degrading the lookup to a name-prefix match, the pre-fix behaviour — which also kills the three cases above it.

### §388. The scanner emits other result kinds too, and they count

Trivy emits `license`, `secret` and `config` results too, and `parseTrivyFindings` retains an entry on its severity alone — so a finding with no `Class` at all is a real shape. Neither the base image nor a package line speaks for it, and guessing one is the inversion. Both carry a purl, a name AND the installed version the facts say is at head, so the ONLY thing refusing them is the class arm — without that, this would pass for the wrong reason.

### §389. Both of those classes are now BUILT

Both of those classes are now BUILT (M22.5/M22.6) and read their own facts, so this is no longer "unbuilt classes stay inert" — it is the stronger property that each class consults ONLY its own resolved fact. A `vendor_latest` resolution reaching a `declared_fact` clause would mean a component at the head of its dependency lines silently satisfied a declaration it never made.

## `packages/schemas/src/scan-exclusion-declared-override.test.ts`

### §390. The component-declared facts and the override request

M22.5 (component-declared facts, owner decision D2) and M22.6 (the override request, D3/D4) — THE TWO REMAINING CLASS PREDICATES, pure.

A separate file from `scan-exclusion-classes.test.ts` for the reason that file gives for existing at all: these are tests of the CLASSES, and the two here share a property the earlier two do not. `no_fix_available` and `vendor_latest` are assertions about the WORLD (the scanner shipped no fix; the registry has nothing newer). These two are assertions about an ACT SOMEONE PERFORMED — a component owner wrote a property, an authority approved a request — which makes the interesting cases the ones where the act was incomplete, misspelled, or has since expired.

WHAT IS DELIBERATELY NOT TESTED HERE: whether the facts are ever RESOLVED, and whether the resolution is WIRED into a gate. A pure test of a pure predicate can say nothing about either, and this repo's dominant defect is a component built, tested green against itself, and installed nowhere. `scan-declared-override-exclusions.integration.test.ts` drives the real gate for that.

MUTATIONS RUN against this file (2026-08-17), measured against a baseline of 20 passed and reverted by an exact inverse edit: S-1  `declaredFactPredicate` accepts a clause with a KEY and no VALUE -> 1 failed. The same mutation reaches the real gate only after `pnpm -w build`, because the plugin subprocess loads the BUILT `@scp/schemas` — the unit suite caught it with no rebuild at all.

### §391. The predicate is finding-independent once it holds

The class's predicate is finding-INDEPENDENT once the declaration holds, so with none of vulnerabilityId/pkgName/purl/findingClass it excludes EVERY finding at EVERY severity. Admission is per CLASS, so no tier above ever sees this clause's reach: one service-tier `policy:write` plus the component owner's own `object:write` on `properties.security` is the whole escalation.

THE READ HALF of a pair — `scan-rule-authoring-guard.ts` refuses the same shape at the write door. This half is the one that reaches a clause already stored, or federated in (where the door deliberately cannot throw without wedging a signed bundle).

## `packages/schemas/src/scanner-registry.test.ts`

### §392. The scanner method enum and the assignment registry

M13.3a — the scanner-method enum widening + scanner-assignment registry schemas (ADR-0020 §2). These are the SCHEMA-level invariants the build rests on: the enum accepts every shipped method (`trivy`, `openscap`, and the 13.3a machine-image arm `trivy-vm`), the evidence-widening is additive (a `trivy` document still parses, the newer ones parse too), the Trivy-DB predicate classifies every enum member, and the registry write body validates the executor Type + methods.

### §393. The one predicate every database-dependent concern uses

`usesTrivyDb` is the ONE predicate every Trivy-DB-dependent concern routes through (the M13.3b-ii offline pre-load seam, the staleness gate, the `scanDb*` evidence fields). Its whole reason to exist is that a `method === "trivy"` comparison would let the machine-image arm slip past the staleness gate and scan against an unclassified DB — so it is pinned EXHAUSTIVELY over the enum: a new method added without a decision about its DB dependence fails here, not in production.

## `packages/schemas/src/services.ts`

### §394. Service release board

Service release board (docs/proposals/coordination-ui-views.md § "Service release board", Phase 2, Layer A). A server-side projection: a service's components in one scannable table, each row carrying that component's LATEST change's per-wave summary + attention signals, plus a releasing / blocked / stable summary strip.

Why a projection and not client-aggregation: there is no target-filtered changes list, so a browser would have to page every change and `explain()` each to find "the latest change for this component" — an O(all-changes) fan-out per board render. This endpoint collapses that to one HTTP call with the fan-out contained in a single server transaction (the `latest-change-per-target` join is the sole net-new capability). Strictly Layer A: no invented per-wave image versions or health — those are Layer B and are surfaced by the UI as explicit placeholders, never fabricated here.

### §395. One WAVE of a component's latest change, summarized

One WAVE of a component's latest change, summarized (ADR-0021 D6 — this field was called a "stage" until 2026-07-25; under the glossary a **wave** IS the compiled step of a plan, while a **stage** is a named deployment *place* (`<domain>[-<location>]-<env>`) that has no entity in the code yet. What the board renders has always been the compiled wave, so `wave` is what it is now called). `status` is the raw wave status (pending|running|succeeded|failed|skipped); `kinds` are the distinct Category·Type pairs across the wave's targets; `failedTargets` counts targets in a terminal-failure status so the UI can surface a partial-failure wave without re-deriving it.

### §396. WHICH DOMAIN DRIVES this row's latest change

WHICH DOMAIN DRIVES this row's latest change (federation honesty — see `unknownFields`).

A change's graph OBJECT replicates across a federation link; its plan/waves, block Decisions and approval requests do NOT (they are local projection tables that never ride the sync journal). So a domain holding a change as a read-only REPLICA can see that the change exists and what lifecycle state its origin last reported, but genuinely cannot see whether it is blocked, awaiting approval, or how far its waves have rolled.

FREEZES USED TO BE ON THAT LIST AND ARE NOT ANY MORE (M25.7, owner decision D6). A freeze authored `federate: true` rides `object_upsert` as a graph object and is rebuilt into the receiving instance's own `freezes` table, so it is both visible and ENFORCED there. Freeze visibility is reported BOARD-LEVEL rather than per-row for that reason — see the board's own `unknownFields`.

`drivenHere` is false exactly when the change object's authoritative origin is another domain (`objects.origin_domain_id !== this instance's federation domain id`). `originDomainId` names that authoritative domain (null when this domain is the origin).

### §397. ONE PIPELINE'S HIGH-LEVEL STATE, summarised for a board row

ONE PIPELINE'S HIGH-LEVEL STATE, summarised for a board row.

The board was change-anchored: one `latestChangeId` per component, so a row said ONE thing about a component that runs several independent pipelines (ADR-0007 Category — a `build`, an `infrastructure` plan/apply, a `configuration` sync). Whichever pipeline moved most recently spoke for all of them, so a pipeline that had never run read exactly like one that just succeeded.

EVERY CATEGORY IS EMITTED, always — `bound: false` included. A component with no infrastructure pipeline is a fact worth seeing, and omitting the entry would make "none is bound" impossible to tell from "this board does not show infra".

### §398. An ASSEMBLY child of this service

An ASSEMBLY child of this service — the optional level between service and component (migration 0055, `intermediate-grouping.md` D3/D5).

D3 chose DIRECT children plus a per-child summary over flattening every descendant: a service with several assemblies of dozens of components each would otherwise render hundreds of rows and lose what the board is for. So an assembly appears as its own entry with a count and a link down, not as its components inlined here.

Before this the board filtered children to `typeId === "component"`, so an assembly child — and therefore everything under it — was silently absent from its parent's board. That is the one thing this entry exists to stop.

### §399. The row fields this domain cannot observe, by path

The row fields whose values this domain CANNOT OBSERVE, named by dotted path (e.g. `"waves"`, `"attention.blocked"`). Every listed field still carries its zero value on the wire for shape stability — but that zero is NOT an observation and a client must not render it as one.

Empty for a change this domain drives (there, `waves: []` / `blocked: false` really do mean "no waves compiled" / "not blocked"). Non-empty on a read-only replica, where the underlying plan/Decision/approval rows were never replicated. This is the same rule the graph health surfaces already follow — absent health renders `unknown`, never `healthy`.

A FREEZE ROW MAY NOW HAVE BEEN REPLICATED (M25.7, owner decision D6) — the list above used to name it and no longer does. `activeFreeze` still appears in a replica row's `unknownFields` when none was found locally, because a peer's un-federated freezes remain invisible.

Also non-empty — including `"latestChangeId"` itself — on a row with NO change found, when this deployment has a peer whose sync scope cannot carry change objects (`status_only` forwards change STATUS without the change; `policies_only` forwards neither; a `custom` selector may forward some and not others). There, "no change here" is not an observation: the domain may simply never have been sent the change that is rolling through this component.

### §400. The releasing, blocked, stable and not-here summary

The releasing / blocked / stable / not-driven-here summary strip. `blocked` counts rows whose latest change is blocked (failed wave/target or block Decision); `releasing` counts rows whose latest change is in-flight and not blocked; `notDrivenHere` counts rows whose latest change is a read-only replica of another domain's change, where blocked/releasing are not observable at all (see `ServiceBoardDriverSchema`); `stable` is every remaining row (accepted / settled / no active change). The four are mutually exclusive and sum to `rows.length`.

`notDrivenHere` is deliberately its OWN bucket rather than folded into `stable`: a replica's release may well be in flight, and counting it as stable is a fabricated all-clear — an operator on an outpost would read green while the commander drives a release through their components.

### §401. WHEN the upstream data behind this board last arrived, and how

WHEN the upstream data behind this board last arrived, and how — DESIGN.md §13's "as of &lt;bundle/date&gt;" label, which §13 pairs with an explicit ban: *"never presents stale data as live status"*.

A board on a federated instance renders change objects that arrived over the sync journal. Without this, nothing on the wire says whether they arrived thirty seconds ago or last quarter — and the reader has no way to tell a live view from a snapshot. It names the LIMITING peer (the oldest reading among the peers whose scope can carry change objects), because that is the one that bounds what the whole board may claim.

- `at` — the `confirmedAt` of the newest confirmed inbound sync bundle from that peer, or null if none has ever landed. Deliberately derived from bundle-transfer history rather than the live-pull timestamps, so it is equally true on a connected instance and an air-gapped one (the pull columns are NULL forever on an instance that never dials). - `via` — `"live-pull"` (the scheduler dialled the peer), `"bundle"` (a file/pushed/inbox import — the air-gap case §13 names), `"never"` (nothing has arrived), or `"unknown"` (the transfer predates the column that records this and is not guessed at). Read from the transfer row, never inferred from timestamps — "as of 3 days ago via bundle" is a healthy air-gapped domain and "as of 3 days ago via a wedged poller" is an incident, so a wrong attribution is worse than none. - `ageSeconds` — seconds since `at`, or since the peer was paired when nothing has ever arrived. - `expectedWithinSeconds` — the peer's OWN effective pull cadence (frequent poll vs proven sparse poke), or null when this instance schedules no pulls for that peer at all. - `staleAfterSeconds` — the age at which `stale` actually flips to `true`: the cadence above WITH the grace factor already applied, null exactly when `expectedWithinSeconds` is null. It is on the wire because `expectedWithinSeconds` is NOT the threshold and a client that renders it as one lies: `stale: false` covers ages well past one cadence, so "within its 60s cadence" is false of a 90-second-old reading that is legitimately not stale. Clients render this; nothing downstream re-derives the grace factor (see `federation/upstream-freshness.ts`). - `stale` — `true`/`false` against that cadence **plus a grace factor** (a peer's age necessarily exceeds its interval once per cycle; only a MISSED cycle is late — see `federation/upstream-freshness.ts`'s `FRESHNESS_GRACE_FACTOR`). **`null` when `expectedWithinSeconds` is null**: null is not "fresh", it means no schedule exists for the data to be late against (an air-gapped peer, or an outpost seen from the commander), so the label itself is the whole guarantee. A client must render null as "as of &lt;at&gt;", never as an all-clear. A scheduled peer that has never delivered anything reads `true`, never `false` — freshness is a claim about delivered data.

The peer reported is the one with the greatest `ageSeconds`, which is the board's actual freshness BOUND. `stale` is a per-peer verdict against that peer's own schedule and is never used to order peers against each other — doing so would let a barely-late connected peer mask an ancient air-gapped one.

When `stale` is `true` the response's `unknownFields` additionally names `"summary.stable"` and `"rows[].latestChangeId"`, for the same reason change-object blindness does: a newer change may exist upstream that this instance has not been sent yet.

### §402. PIPELINES BOUND TO THE SERVICE ITSELF

PIPELINES BOUND TO THE SERVICE ITSELF — infrastructure that serves the whole service.

A cluster, a shared database or a VPC stands up once and every component runs on top; declaring that as N identical component bindings is duplication that drifts. ADR-0027 added the service rung to binding resolution, so a binding here now actually routes — before it, this would have been inert config that ALSO blocked releases (fail-closed `no_executor`), which is why the view and the rung landed together rather than the view first.

### §403. BOARD-LEVEL unobservable fields, by dotted path

BOARD-LEVEL unobservable fields, by dotted path (`"serviceFreeze"`, `"rows[].activeFreeze"`) — the ones no row can observe regardless of who drives its change, as opposed to `ServiceBoardRowSchema`'s per-row `unknownFields` (what THAT row's driving domain withheld).

Two families ride here today.

FREEZE VISIBILITY (`"serviceFreeze"`, `"rows[].activeFreeze"`), whenever this org has a federation peer. A freeze declared in another domain reaches this instance ONLY if that domain declared it `federate: true` (M25.7, owner decision D6 — it then rides `object_upsert` as a `freeze` graph object and is rebuilt into this instance's own `freezes` table, where it blocks like any local one). Federation is opt-in and DEFAULTS OFF, and nothing in a bundle reports the freezes a peer withheld. So a null `activeFreeze`/`serviceFreeze` means "no freeze VISIBLE HERE", never "no freeze applies", and a client must not render it as an all-clear on a federated deployment. With no peer paired there is no other domain to be blind to, and the nulls are complete observations — the list is then empty rather than claiming an ignorance this instance does not have.

THE RETIRED REASON, kept because it is what a reader will otherwise re-derive: until M25.7 this said `freezes` is a local projection that never rides the sync journal in either direction, and that was ABSOLUTE — a freeze was not a graph object and no freeze-shaped `JournalEntryKind` existed. The caveat's wording changed; its conclusion did not.

CHANGE-OBJECT BLINDNESS (`"summary.stable"`, `"rows[].latestChangeId"`), whenever a peer's sync scope cannot carry change objects. `summary.stable` then mixes genuinely-settled rows with rows that merely came up empty and must not be painted as an all-clear; and no row's `latestChangeId` is certainly the LATEST, since a newer change from that peer would never have arrived. See `coordination/service-board.ts` and `federation/scope-filter.ts`.

## `packages/schemas/src/supply-chain.test.ts`

### §404. M22.1b (ADR-0033 §7) — the pure half of "persist the findings"

M22.1b (ADR-0033 §7) — the pure half of "persist the findings": the cap, the record marker, the per-row retention class, and the plugin→server transport seam.

MUTATIONS RUN against this file (2026-08-17) — the MEASURED results, not predicted ones, because a green suite proves nothing about whether it would have gone red:

```text
1. `scanMethodCarriesFindings` returning `true` for `openscap`  -> 3 failed / 14 passed
     ("says so about the METHOD", "refuses an openscap set that DOES arrive with findings",
     "full / truncated / unsupported / ABSENT"). The mutation that matters most: it is the one
     an implementer makes by writing `return true` or by deriving the answer from
     `findings.length`.
2. `capScanFindings` returning `truncated: false` unconditionally -> 3 failed / 14 passed
     ("caps a set OVER the cap", "the production cap is a real bound", "RE-CAPS server-side").
3. `takeScanFindingsFromTransport` returning the evidence unchanged (no `delete`)
     -> 2 failed / 15 passed ("the transport keys DO NOT SURVIVE the read", "a MALFORMED payload
     records nothing"). That first one is the property that keeps findings out of the bundle.
4. `scanFindingsRecordFor` returning `"full"` for `capped === undefined` -> 1 failed / 16 passed.
5. `scanFindingRetentionClass` returning `"E"` unconditionally -> 1 failed / 16 passed.
```

### §405. M22.2 (ADR-0033 §1–§4, §7) — the EXCLUSION dimension's pure half

M22.2 (ADR-0033 §1–§4, §7) — the EXCLUSION dimension's pure half: what a clause reaches, what refuses one outright, and how the post-exclusion count is derived.

MUTATIONS RUN against this file (2026-08-17), each reverted by an exact inverse edit. MEASURED results; baseline 33 passed. The WIRING mutations live in the header of `apps/server/src/governance/scan-exclusions.integration.test.ts`.

```text
S-1  skip the `record !== "full"` refusal entirely
       -> 4 failed (truncated refuses / OpenSCAP never excluded / an ABSENT record refuses /
          a truncated scan's effective counts equal its raw counts).
S-2  give the not-yet-built classes a predicate (`() => true`)
       -> 1 failed ("a clause of a class whose PREDICATE is not yet built").
S-3  stop decrementing in `effectiveSeverityCountsAfterExclusions`
       -> 1 failed ("effectiveSeverityCounts is severityCounts MINUS the excluded").
S-4  drop the `pkgName` matcher comparison
       -> 2 failed (A MATCHER MISS / a finding that LACKS the field a clause names).
```

## `packages/schemas/src/supply-chain.ts`

### §406. Supply-chain governance evidence

Supply-chain governance evidence (DESIGN §10, ADR-0013 "scan as a boundary-authorization gate", BUILD_AND_TEST.md §8 M17). This file carries the TYPED shape of a `ControlOutcome.evidence` payload for a coordinated Trivy scan verdict — the M17.1 `scan-result-control` ControlPlugin produces it, and it is persisted verbatim on the `control_runs.evidence` column (free-form `z.record` at the storage layer — `ControlRunSchema` in governance.ts).

Why a typed schema for something the DB stores as free-form JSON: today a control's evidence is an opaque bag, so a policy's CEL condition has no typed field to threshold on. Pinning the scan verdict's shape here gives policy authors stable, documented fields — `evidence.severityCounts.critical`, `evidence.artifactDigest`, `evidence.digestMatch` — to write conditions against, and gives the plugin a single source of truth it validates its own output against (scan-result-control parses its evidence through `ScanEvidenceSchema` before returning it, so a shape regression fails the plugin's own tests rather than silently shipping malformed evidence into a Decision).

CHARTER — coordinate, not execute: the SCP *gate* never runs Trivy; the charter-enumerated `scp-managed-scan` runner does, as the promotion scan step (ADR-0020). This evidence is the shape of a verdict the gate *consumes* — either from an org's own coordinated Trivy step (Argo Workflows, ADR-0012) or from the commander-resident `scp-managed-scan` promotion scan step (ADR-0020) — `scanner`/`scannerVersion` record WHICH scanner produced it, they are not a claim the gate scanned anything itself.

### §407. M22.1 (ADR-0033) — ONE Trivy finding, retained

M22.1 (ADR-0033) — ONE Trivy finding, retained.

Until now a scan verdict was four integers: both parsers walked `Results[].Vulnerabilities[]`, read `.Severity`, incremented a counter, and discarded the vulnerability object; the raw document was then deleted. Every rule in ADR-0033 is a rule ABOUT A FINDING — "this package is at the vendor's latest", "this one has no fix", "this component declared the finding inapplicable" — and none of them can be expressed against four integers. This type is what survives so they can be.

WHY NEARLY EVERY FIELD IS OPTIONAL, and why that is not laziness. Today an entry is counted on the strength of its `Severity` ALONE — nothing else is read, so an entry with no `VulnerabilityID`, no `PkgName` or no versions is still counted. Requiring those fields here would silently drop such entries and MOVE THE NUMBERS OPERATORS ALREADY SEE, which the M22.1 definition of done forbids. So a finding is retained whenever it would have been counted, and a finding that lacks an identifier is simply one that no exclusion clause can ever match — the safe direction, since an unmatchable finding still counts against the ceiling.

### §408. THE SHARED TRIVY PARSE

THE SHARED TRIVY PARSE — the single source of truth for both verdict producers.

This lives here rather than being duplicated because an earlier draft of ADR-0033 asserted that "a plugin cannot import `@scp/schemas`" and designed a duplicated parser with a cross-boundary conformance test to keep the copies honest. That premise was FALSE: `@scp/plugin-scan-result-control` already declares `@scp/schemas` as a dependency and already imports values from it. Two hand-synced parse loops with identical semantics is precisely the shape where a fix lands in one and the paths diverge silently, so the copies are now one function.

TOTAL AND DEFENSIVE, exactly as both originals were: a malformed or partial document yields an empty array (and therefore zero counts) rather than throwing. The runner already fails the run for a broken scan, so this path normally sees a real result.

PER-ENTRY, NOT PER-CVE. One finding per `Vulnerabilities[]` element, with no de-duplication — the same CVE affecting three packages counts three times, because that is what both parsers did before this. De-duplicating would be defensible and is NOT done here: it would change every operator's numbers on the day this ships.

`UNKNOWN` (and any unrecognized severity) is dropped, unchanged from both originals.

### §409. The counts are derived from the retained findings

`severityCounts` DERIVED from the retained findings, so the two can never disagree. Because `parseTrivyFindings` retains exactly the entries the old loops counted, this is numerically identical to what both parsers produced before M22.1 — that equivalence is the property the M22.1 suite pins, and it is why `severityCounts` can keep meaning "what the scanner found" while a separate post-exclusion count is introduced beside it.

### §410. The maximum number of findings persisted per scan

The maximum number of findings persisted per scan (ADR-0033 §7).

`scan_findings` is the highest-cardinality table in the system and one scan of a stale base image routinely yields thousands of entries. A cap is NOT a retention story (ADR-0024 §D0: retention never licenses write amplification); it is the bound on a single scan's write.

The cap keeps the FIRST N findings in parse order — deterministic, and not a severity-priority selection. Nothing is lost by that choice, because a TRUNCATED set refuses EVERY exclusion for that scan (ADR-0033 §7: "you cannot except what you did not record"), so the retained subset is only ever an explanation, never an input to a verdict.

`severityCounts` is derived BEFORE the cap and is therefore unaffected: capping what is persisted never moves what the scanner found.

### §411. What a scan's persisted finding set is, stated positively

WHAT A SCAN'S PERSISTED FINDING SET IS — stated positively in evidence, never inferred from the absence of rows.

ADR-0033's consequences list is explicit that "OpenSCAP verdicts can never be excluded from" must be "explicit and tested, not left to 'there were no findings to exclude'". The two are genuinely different states and a reader with only the rows cannot tell them apart:

```text
`full`        — every finding the scanner reported is on disk. Exclusions may apply.
`truncated`   — the set hit `SCAN_FINDINGS_PERSIST_CAP`. EVERY exclusion for this scan is
                refused (ADR-0033 §7).
`unsupported` — this scanner family structurally cannot carry findings (OpenSCAP: XCCDF
                rule-results have no package, no purl, no `FixedVersion` and no `Class`).
                Exclusions can never apply — not because none matched, but because there is no
                per-finding material to match on.
```

ABSENT is a fourth state and it is the one that matters most for safety: evidence written before M22.1b recorded no findings at all, so a consumer that reads no marker must refuse exclusions exactly as it does for `truncated`. Every state except `full` refuses.

### §412. Whether a scan METHOD can carry per-finding detail at all

Whether a scan METHOD can carry per-finding detail at all.

Deliberately an EXHAUSTIVE switch over `ScanMethod` rather than `method !== "openscap"`: a fourth method added later is then a compile error here, forcing a decision, instead of silently inheriting "yes, it has findings" — which for a rule-based scanner would be a fail-open (an exclusion applied against a finding set that was never populated).

It is also NOT `usesTrivyDb`, though the two agree today. That predicate answers "does this method read the Trivy vulnerability DB?" (a staleness-gate question); this one answers "does a verdict of this method decompose into findings?". Sharing one helper between two questions is how the answer to one silently becomes the answer to the other.

### §413. The one decision about a scan's finding set, shared

THE ONE DECISION about what a scan's finding set is — used by BOTH the evidence marker and the row writer, so the two can never disagree about the same scan.

`undefined` means NOTHING WAS RECORDED (the producer transported no findings at all). It is a real, distinct state and it is written as an ABSENT `evidence.findingsRecord`, matching every pre-M22.1b document — and like every state but `full`, it refuses exclusions.

The `unsupported` arm is deliberately decided BEFORE the payload is looked at. A caller that handed OpenSCAP findings (there is no such thing, but a future runner shim could) gets them refused because of WHAT SCANNED, never because the array happened to be empty — which is exactly the distinction ADR-0033's consequences list requires be explicit and tested.

### §414. The ADR-0024 §D1 evidentiary class of ONE persisted finding row

The ADR-0024 §D1 evidentiary class of ONE persisted finding row (D10).

`scan_findings` does not have a single class, and that is the whole point of assigning it per row:

```text
`E` — an EXCLUDED finding is accepted-risk evidence. It explains a LIVE verdict and records what
      an operator chose to tolerate, so it is retained at least as long as its subject is live.
`O` — an ordinary finding is telemetry: bookkeeping about what a scanner saw, on a short window.
```

This follows ADR-0024 §D1's EXISTING per-row assignment (`decisions` already splits across all three classes — P when cited or pinned, E while current for its subject, O when uncited and superseded) rather than introducing a new retention shape.

`P` is deliberately not in this enum: no finding is permanent evidence. The permanent record of a gate verdict is the Decision and the audit event, both of which cite it.

### §415. The class a finding row is written with

The class a finding row is written with. M22.2 landed the exclusion dimension, so the `E` arm is now REACHED in production: a finding an admitted clause excluded is accepted-risk evidence explaining a live verdict, and is written `E` in the same transaction as the verdict itself. Every other row stays `O` — telemetry about what a scanner saw.

### §416. The plugin-to-server transport seam, and why a key

THE PLUGIN → SERVER TRANSPORT SEAM, and why the key is not a field on `ScanEvidenceSchema`.

A ControlPlugin runs in the subprocess plugin host with NO `DATABASE_URL` — it cannot write `scan_findings` itself. Its ONLY channel back to the server is `ControlOutcome.evidence`, a free-form record. So the findings ride out on that record and the SERVER persists them.

They must NOT stay there. `control_runs.evidence` is copied VERBATIM into the promotion bundle (`federation/promotion-repo.ts` projects `{controlUrn, status, evidence, detail}` for every run), and ADR-0033 keeps findings COMMANDER-LOCAL — the bundle keeps counts. Leaving them on the evidence would both bloat every bundle and federate accepted-risk detail that §8 confines to grants.

Hence a `$`-prefixed transport key that `takeScanFindingsFromTransport` REMOVES as it reads. The extract and the strip are ONE function on purpose: a caller cannot obtain the findings and then forget to strip them, because the only way to get them hands back an already-stripped evidence object.

### §417. Read a plugin's transported findings out of the record

Read a plugin's transported findings OUT of an evidence record, returning the evidence WITHOUT the transport keys.

RE-VALIDATES AND RE-CAPS SERVER-SIDE. The producing plugin is a separate process; a buggy or tampered one must not be able to steer what lands in the database, so the payload is parsed through `ScanFindingSchema` and re-capped here rather than trusted. A malformed payload yields `undefined` (no findings recorded) — the safe direction, since every state but `full` refuses exclusions.

### §418. The scan methods the promotion step can actually run

The managed-scan METHODS the commander's promotion scan step can run (ADR-0020 §2, proposal §13.3). A closed enum, extended only by a deliberate owner decision (a new scanner plugin lands as a new value here + a new runner-image tool). This is the value set the scanner-assignment registry maps artifact types onto (`ScannerAssignmentSchema` in executors.ts) and the value set `ScanEvidence.scanner` is widened to below — so evidence is self-describing about WHICH method produced it. M13 ships `trivy` first, `openscap` second (proposal §13.3 "Increment order"); both are enumerated up front so the registry and evidence shapes are stable across the two 13.3a increments.

`trivy-vm` — THE MACHINE-IMAGE ARM (13.3a, owner decision D2: "image-only for M13, where image INCLUDES machine images"). A DISTINCT method rather than a mode of `trivy`, for two reasons that are both load-bearing: 1. **The registry can express it.** Scanner assignment is per `ExecutorType` (machine images ride `infrastructure`), and `infrastructure -> ["trivy-vm"]` is a statement the registry can make; "run `trivy`, but in vm mode, when the subject happens to be a disk" is not — it would force the runner to SNIFF the subject and silently pick a scan mode, which is exactly the kind of guess a fail-closed gate must not make. 2. **The evidence stays honest.** `scanner: "trivy-vm"` is the claim "this artifact was scanned as a VM disk image (partition table → filesystem → OS package DB)", which is a materially different assertion from "scanned as a container image layer stack" — same binary, same vulnerability DB, different subject model. A reader of a Decision can tell them apart. The widening is ADDITIVE and GATE-INVISIBLE, exactly as `openscap`'s was: E6 reads only `digestMatch`/`artifactDigest`, never `scanner`, so every pre-existing evidence document still parses and no gate code changes.

### §419. The subset of methods that read the vulnerability database

The subset of `ScanMethod`s that read the **Trivy vulnerability DB** — so every DB-dependent concern (the M13.3b-ii offline pre-load seam, the staleness gate, the `scanDb*` evidence fields) applies to ALL of them and never to `openscap` (which evaluates baked SSG content instead).

This predicate exists because the alternative — a `method === "trivy"` comparison at each site — is precisely how a second Trivy-family method silently escapes the staleness gate: a `trivy-vm` scan would then run against an unclassified (possibly hard-stale) DB and still emit passing evidence. One named predicate, every call site.

### §420. M17.5 — SCOPED SCAN-REQUIREMENT POLICIES

M17.5 — SCOPED SCAN-REQUIREMENT POLICIES (ADR-0016), most-restrictive-wins over six tiers.

platform -> trust domain (partition) -> org -> containment domain -> service -> component

The effective threshold is the per-severity MIN of `maxCritical`/`maxHigh`/`maxMedium`/`maxLow` across every APPLICABLE tier: a child may only TIGHTEN, never loosen. MIN over a set is commutative and associative, so resolution is ORDER-INDEPENDENT by construction — which is exactly why the documented containment-domain-vs-service ordering tie (`graph/containment.ts:60-73`) is harmless here and why most-restrictive-wins was the safe choice rather than "most specific wins" override semantics (ADR-0016 §4).

TWO SENSES OF "DOMAIN", never conflated (ADR-0016 terminology section): `trust_domain` is the ambient federation boundary (a partition) ABOVE org; `containment_domain` is the intra-org `domain` OBJECT TYPE BELOW org. The stored/emitted literal is `trust_domain` — never bare `domain`.

### §421. The tiers a scan-requirement floor can be authored at, top-down

The tiers a scan-requirement floor can be authored at, top-down.

`assembly` was ADDED 2026-08-17 (M22.0, ADR-0033 §5). It is the OPTIONAL rung between a service and its components (migration 0055, `CONTAINER_TYPES`), and it shipped AFTER ADR-0016 wrote this enum — so an assembly-anchored ceiling has always ENFORCED correctly (the merge is an order-independent per-severity MIN that never reads a tier label) while REPORTING itself as `component`, breaking ADR-0016 §5's promise that a block can name the tier that bound it. This is a LABEL fix, not an enforcement change: no threshold moves.

This is a WIRE enum. Adding a member changes the generated SDK and the OpenAPI response schema.

### §422. A PARTIAL threshold

A PARTIAL threshold — every severity independently optional. An absent severity means this tier SETS NO CEILING for it and therefore does NOT contribute to the MIN: "no floor" is never read as `0` (which would be the tightest possible ceiling and would silently block everything).

### §423. The gate-resolved threshold, threaded to the control

The gate-resolved effective threshold, threaded to `scan-result-control` on the control-run CONTEXT (`context.scanThreshold`) — reusing the shipped M17.1 `context.artifactDigest` threading pattern (ADR-0016 §4 design A, gate-orchestrator.ts `buildControlContext`).

### §424. M22.2 (ADR-0033 §1–§4) — THE EXCLUSION DIMENSION

M22.2 (ADR-0033 §1–§4) — THE EXCLUSION DIMENSION: what is COUNTED, resolved separately from what the count is compared against.

ADR-0016's ceiling is a per-severity MIN over an unordered set: commutative, associative, and a child may only ever TIGHTEN. That algebra is untouched here. This is the OPPOSITE direction and therefore gets the OPPOSITE guard — a monotone AND down the tier chain, so a loosening at any depth requires admission from every tier above it. The two dimensions never meet: exclusions change WHAT IS COUNTED, the ceiling changes WHAT THE COUNT IS COMPARED AGAINST.

THE INVARIANT THAT OUTRANKS EVERY CONVENIENCE HERE: `severityCounts` keeps meaning WHAT THE SCANNER FOUND. Operators author CEL conditions against `evidence.severityCounts.*`, so redefining that field post-exclusion would silently change the meaning of every rule already written — a compatibility promise to policy authors, not to a linter (there is no contract gate on this shape; `ScanEvidence` never reaches `openapi.v1.json`). The post-exclusion number lives in a NEW `effectiveSeverityCounts`, and ONLY the threshold comparison reads it.

### §425. The CLASSES of exclusion

The CLASSES of exclusion — the unit the tier chain admits or declines.

Admission is per CLASS, never per clause: SecOps above says "override requests of this kind may have effect beneath me", and a tier below then authors the individual clauses. That is what makes §6's accepted escalation seam (a component owner authors a declaration they benefit from, at a weaker permission than the one that set the constraint) bounded rather than unbounded — "the component authors the override; it does not author its own admission".

A CLOSED enum. A clause naming an unrecognized class fails to parse and therefore excludes nothing — the safe direction for a loosening.

### §426. M22.5 (owner decision D2) — THE COMPONENT-DECLARED FACT's vocabulary

M22.5 (owner decision D2) — THE COMPONENT-DECLARED FACT's vocabulary.

The owner chose DIRECT ENCODING: component info encodes the override, rather than SecOps authoring a mapping from a declaration to an exemption (recommended, declined). The escalation seam that follows is real and settled — a component's `properties` are writable at plain `object:write` SCOPED AT THAT COMPONENT, so the beneficiary of a declaration is also its author, at a weaker permission than the `policy:write` that set the constraint.

What D2 does NOT require is that the declaration be UNBOUNDED, and these two schemas are where that bound is drawn:

1. A declared value lands VERBATIM in `control_runs.evidence` and in the gate Decision's `inputContext` (ADR-0033 §6 guard 2 — an auditor reads *"passed because component X asserted `egress: none` under admission Y"*, never just *"passed"*). Both of those are read by humans and one of them is a row this project has already measured flooding at 1.44 GB/day, so an unbounded blob is not an option: keys and values are short, single-line, and countable. 2. NEVER `labels`. They are tenant-writable, unvalidated (no schema, no reserved namespace) and are already a live evasion path for selector-scoped policies (PR #247). A declaration lives in a TYPED `property_schema` instead.

### §427. ONE exclusion clause

ONE exclusion clause — what a `scanExclusion` policy effect's `exclude` key carries.

`class` is REQUIRED and is the admission key. The remaining fields NARROW which findings the clause reaches; every one that is PRESENT must equal the finding's corresponding field, and a finding that does not carry that field never matches (ADR-0033 §1: "on a matcher miss, yields no exclusion" — the opposite sign from the ceiling's fail-closed miss).

`z.strictObject` for exactly the reason drizzle/0062's header gives for `DependencySubscriptionEffectSchema`, and it bites HARDER here: a mistyped NARROWING key would be silently stripped, leaving a clause with FEWER matchers — which for a loosening is a WIDENING. `{"class": "no_fix_available", "pkgNmae": "openssl"}` must be refused, not quietly turned into "every finding with no fix, anywhere in scope".

### §428. Which component-declared fact this clause relies on

M22.5 (owner decision D2) — WHICH component-declared fact this clause relies on, and WHAT the component must have declared for it. BOTH are required for a `declared_fact` clause to resolve at all: a clause naming a key but no value would exclude on the mere PRESENCE of a declaration, which is a component writing its own exemption with a one-word property. See `declaredFactPredicate`. Ignored by every other class.

### §429. The `scanExclusion` POLICY EFFECT

The `scanExclusion` POLICY EFFECT — one effect kind carrying BOTH of §1's roles, because they are two halves of one authoring act and splitting them into two effect kinds would let a reader believe an `admit` had been authored where a `exclude` was.

```text
`{"scanExclusion": {"admit": ["no_fix_available"]}}`
    — this tier ADMITS that class BENEATH it. Authored by whoever holds `policy:write` at or
      above the object it is scoped to.
`{"scanExclusion": {"exclude": {"class": "no_fix_available", "pkgName": "openssl"}}}`
    — this tier CONTRIBUTES a clause. It has effect only if every tier ABOVE it admitted the
      class.
```

An effect carrying NEITHER key is INERT — not an error. It reaches the resolver only from a document that passed the migration's JSON Schema, and an inert contribution is the safe reading for a loosening.

### §430. A clause that survived, with the tiers that admitted it

A clause that survived the AND, with the full chain of tiers that admitted it.

`admittedBy` is not decoration: ADR-0033 §11 requires that "every applied exclusion names its clause, admitting tier, authority and expiry", and a verdict that says only "excluded" is exactly the coarse waiver §2 rejected.

### §431. M22.8 — THE READ SURFACE'S WIRE CONTRACT

M22.8 — THE READ SURFACE'S WIRE CONTRACT (`GET /components/{idOrUrn}/scan-requirements`).

THE CLAIM THAT USED TO BE HERE WAS FALSE and is corrected rather than deleted, because this repo has already paid for "never make a required response field optional" and the cost of that mistake is decided entirely by which schemas are on the wire. It said everything ABOVE this line travels only on `control_runs.evidence` and in a Decision's `inputContext` — free-form JSON, no contract — and that the schemas BELOW are "the first ones in this file that genuinely" reach the wire. Check `git show origin/main:tools/openapi/openapi.v1.json`: `/instance/scan-floors` and `/instance/scan-floors/{tier}` were published BEFORE this branch, and their request/response bodies are `InstanceScanFloorSchema`, `InstanceScanFloorListResponseSchema`, `InstanceScanFloorTierParamSchema` and `PutInstanceScanFloorRequestSchema` — all defined above this line. `InstanceScanExclusionAdmission*` (M22.9) joins them. Editing any of those is an oasdiff-gated API change, not a refactor.

ONLY THE PARENTHETICAL WAS RIGHT, and it is the part worth keeping: the SIX-TIER `ScanRequirementTierSchema` never reached `openapi.v1.json` before this increment (measured again for this correction — `assembly`, which only that enum carries, appears nowhere in main's spec). The floors surfaces publish their own two-value `z.enum(["platform", "trust_domain"])` instead, so the full tier enum genuinely does appear in the generated spec with M22.8 and not with M22.0.

### §432. One exclusion class, and where a clause would take effect

ONE exclusion class, and where a clause of it would actually have effect for this component.

`admittedBy` alone is not the answer an operator needs. ADR-0033 §1's algebra is a monotone AND *down the tier chain*: a clause anchored at tier T has effect only if EVERY represented tier strictly above T admits its class. So "org admits `no_fix_available`" tells you nothing about whether a clause you author at the component will work — that depends on `platform` and `trust_domain` too. `effectiveAtTiers` answers the question directly: these are the tiers at which a clause of this class would survive the AND right now.

An EMPTY `effectiveAtTiers` with a non-empty `admittedBy` is the diagnostic shape this field exists for — somebody admitted the class somewhere, and a rung above them did not, so every clause of that class is inert. That is the shipped default (admission is empty at every tier) and it is precisely the state that is invisible without this surface.

### §433. A contributing policy this route did not evaluate, named

A contributing policy this route DID NOT EVALUATE, named rather than silently folded in.

The route resolves scan requirements for a COMPONENT, not for a change — so there is no change, no subject, no graph facts and no gate instant to build a CEL context from. Evaluating a condition against a fabricated context would produce an answer that is confidently wrong; the route therefore evaluates NO CEL at all and treats every condition-carrying contributor conservatively **in each dimension's own direction** (see `scan-requirements-read.ts`).

### §434. What scan rules are in force for this component

`GET /components/{idOrUrn}/scan-requirements` — WHAT RULES ARE IN FORCE FOR THIS COMPONENT.

WRITES NO DECISION, and that is the reason it exists rather than pointing operators at `POST /policy-evaluate`: that endpoint runs the real orchestrator and writes one Decision row per call with NO write suppression, so a UI polling it would reproduce, on a per-viewer schedule, the exact 1.44 GB/day amplification ADR-0024 §D0 was raised to stop. This surface reads.

IT IS NOT A PREDICTION OF A GATE VERDICT. It answers "which ceiling and which loosenings are authored and admitted for this component", which is a question about POLICY. A gate verdict also depends on the change, the actor, the artifact, the scanner's findings and every CEL condition — none of which exist here.

### §435. The exclusion clauses that survive for this component

The exclusion clauses that survive the AND for this component today.

ADMISSION ONLY — never application. Whether a surviving clause actually excludes a finding depends on facts this route deliberately does not resolve (the dependency inventory's head, the component's declarations, live grants and their expiry) and on findings that do not exist until a scan runs. Conflating "admitted" with "applied" is the confusion ADR-0033 §1's last paragraph names; both halves are needed and they are different questions.

### §436. M22.9 — THE INSTANCE ADMISSION *WRITE* SURFACE'S WIRE CONTRACT

M22.9 — THE INSTANCE ADMISSION *WRITE* SURFACE'S WIRE CONTRACT (`GET`/`PUT /instance/scan-exclusion-admissions`).

WHY THIS EXISTS AT ALL, stated plainly because its absence was a blocking finding: the AND in §1 requires EVERY represented tier strictly above a clause to admit its class, and `buildScanExclusionTargetInputs` seeds `representedTiers` with `platform` and `trust_domain` UNCONDITIONALLY. `tierForObjectType` can never return either of those two, so no policy — at any tier, by any author — can contribute their admission. Their ONLY source is `scan_exclusion_admissions` (drizzle/0074), and until this increment that table had no writer outside the integration suite's admin pool. Every exclusion class M22.3–M22.6 built was therefore inert on a real deployment while its tests were green: the whole dimension was reachable only by hand-written SQL. A feature whose mandatory precondition has no production writer is not shipped.

THE ORG-AND-BELOW RUNGS NEED NOTHING HERE, and deliberately get nothing. `org`, `containment_domain`, `service`, `assembly` and `component` admit a class through the EXISTING `scanExclusion` policy effect (`{"scanExclusion": {"admit": ["no_fix_available"]}}`), authored over the ordinary policy write door and resolved by `matchPoliciesForTargets` — charter principle 2, new concepts as policy data. Building a second admission surface for those five tiers would be two constructions of one rule.

THE TWIN IS `routes/instance-scan-floors.ts` — same instance scope, same DESIGN §4.2 `org_id` exception, same operator-write / tenant-read split, same `x-scp-operator-token`. Read that file's header for the full argument; it is not restated here.

NO `DELETE` VERB, ON PURPOSE. The PUT is a whole-set replace for one `(tier, origin)`, so `{"classes": []}` IS the revocation, and it is the same request shape an operator already uses to narrow the set from three classes to two. A second verb that means "replace with nothing" would be a second way to say one thing (charter priority 1).

### §437. One instance-scoped admission row

One instance-scoped admission row — the API projection of `scan_exclusion_admissions` (no `orgId`: it speaks for the DEPLOYMENT, identically for every org hosted on it).

A ROW IS AN ADMISSION AND NO ROW IS NO ADMISSION (0074's header): this list is empty on every deployment that has not authored one, and that empty list is the safe default rather than a missing configuration.

### §438. Operator-authored write body

Operator-authored write body — the WHOLE admitted class set for one `(tier, origin)`.

A REPLACE RATHER THAN AN ADD, and the direction of the mistake is why. An additive verb makes withdrawal the harder operation: an operator who believes they have narrowed an admission, but whose request only ever adds, leaves the loosening in force with no error anywhere. A replace makes the request state what the deployment admits, so the read-back is the authored value.

`classes` is a SET: duplicates collapse, and `ScanExclusionClassSchema` refuses an unrecognised value here exactly as the table's CHECK constraint refuses it one layer down (0074's header: an operator typo that silently admits nothing is the failure worth two copies of the list).

### §439. M22.4 (ADR-0033 D1) — THE VENDOR RULE'S FACTS

M22.4 (ADR-0033 D1) — THE VENDOR RULE'S FACTS.

The owner's headline rule: a vendor dependency is accepted only if we are on the LATEST VERSION OF A MAJOR VERSION. That maps exactly onto `dependency_lines`' identity `(org_id, ecosystem, coordinate, major)` — being "at the head" of the line a declaration sits on.

WHY THE FACTS TRAVEL AS DATA RATHER THAN BEING LOOKED UP. The exclusion set is resolved at GATE time, before any scan has been read, and it is then handed to a PLUGIN that has no database and no lookup ability. So every fact the rule needs is resolved server-side against the ADR-0032 inventory and serialized here; the matcher below is pure and reaches nothing.

THREE FINDING CLASSES, TWO REACHABLE (ADR-0033 "costs/honesty"): - `os-pkgs`   — attributable to the BASE IMAGE line. `dockerfile.ts` parses every real `FROM` into a declared `oci` dependency, so "we are on the latest base image" is a fact about that line and it earns every OS-package finding a pass. - `lang-pkgs` with a DECLARED line — attributable to its own line, via `packageKeys`, AND ONLY AT THE VERSION THE ARTIFACT ACTUALLY SHIPS (see `vendorLatestPackageKey`). - `lang-pkgs` TRANSITIVE — NO line of its own, and so no key of its own. This line used to read "and therefore NO pass", which was FALSE for as long as the key carried no version: a transitive `lodash@3.10.1` matched the key emitted for a DECLARED `lodash@4.17.21` at head, because the two differed only in the field the key threw away. With the version in the key, a transitive is excused only when it sits at exactly the version some declared line is at the head of — the same bytes the manifest asked for, which is not a transitive escaping the rule. Anything else is fixed by moving the DIRECT parent that pulls it, and that parent has a line of its own.

### §440. The identity of one at-head line, canonicalised once

The `(ecosystem, coordinate)` identity of one at-head line, canonicalised ONCE, here, where both sides of the join are visible.

`ScanFindingSchema.purl` and `dependency_lines.coordinate` are BOTH stored deliberately un-normalised, each in its own producer's vocabulary, and both of those decisions say the same thing: canonicalisation belongs at the join, not smeared across the two writers. This is that join, and it is a single exported function precisely so the server (building the fact) and the matcher (consuming it) cannot drift into two spellings of one package.

ONLY `python` IS FOLDED, and only by its own published rule (PEP 503: lower-case, and runs of `-`, `_` and `.` collapsed to a single `-`) — Trivy reports a distribution's metadata name while a manifest spells the requirement, and `Flask` vs `flask` vs `zope.interface` vs `zope-interface` are the SAME distribution by specification. Nothing else is case-folded: npm names are lower-case by registry rule, Maven coordinates are case-sensitive, and Go module paths are case-sensitive by language specification (`github.com/Masterminds/semver`). Folding those would be inventing an equality the ecosystem does not grant — and for a LOOSENING an invented equality is a false positive, which is the one direction this feature may not fail in.

THE VERSION IS PART OF THE IDENTITY (added 2026-08-18), and leaving it out was a defect rather than a simplification. A key of `(ecosystem, coordinate)` alone made `keys.has(…)` answer *"the component's MANIFEST declares this package at head"* — never *"the ARTIFACT BEING SCANNED contains it at head"*, which is the only question a finding can be excused by. Two live falsifications, both LOOSENINGS:

1. DRIFT. A manifest declaring `lodash@4.17.21` (at head) over an image that actually ships `4.17.15` excused a HIGH whose `FixedVersion` was `4.17.21` — a finding with a shipped upstream fix, dropped under a rule whose entire justification is "there is nothing more the team can do". 2. THE MAJOR LINE. At-head-ness is computed PER LINE and `dependency_lines` is keyed by `(org_id, ecosystem, coordinate, major)`, so a component declaring `lodash@4.17.21` (at head of `4`) AND `lodash@3.10.1` (behind head of `3`) projected both onto one version-less `npm|lodash`, which then excused the `3.10.1` finding. That is precisely the current sibling voting away a stale one that `foldVendorLatestFacts`' own docblock claimed could not happen.

The version is compared VERBATIM on both sides — `component_dependencies.resolved_version` against Trivy's `InstalledVersion` — with no normalisation of its own. Both are exact published version strings rather than ranges, and a spelling difference between the two costs a pass rather than granting one, which is the only direction a loosening may fail in.

THE THIRD PARAMETER IS REQUIRED, not optional-with-a-default, and that is the whole reason this is one exported function: an optional version would let either side of the join silently keep the old shape, which is exactly the drift a single join point exists to make impossible at compile time.

### §441. purl `type` → this project's `DependencyEcosystem`

purl `type` → this project's `DependencyEcosystem`. A purl whose type is not one of the four LANGUAGE ecosystems (an `apk`/`deb`/`rpm` OS package, an unknown type, a malformed string) yields `undefined`, and a finding with no ecosystem can match no package key — the fail-closed direction. `oci` is deliberately ABSENT from this map: an image is never a `lang-pkgs` finding, and the base image is reached through `ScanVendorLatestFactsSchema.baseImageAtLatest` instead.

### §442. What the server resolved about this target's inventory

WHAT THE SERVER RESOLVED ABOUT THIS TARGET'S DEPENDENCY INVENTORY — the only input the `vendor_latest` predicate has.

ABSENT MEANS NO VENDOR-PASS, never "everything is current". That is the same reading `dependency_lines.latest_version`'s own NULL carries ("not yet observed" is never "no newer version exists") and the same reading `scan_requirement_floors` established for its nullable ceilings. Every one of D1's fail-closed cases — a NULL `latest_version`, a stale `latest_observed_at`, no inventory row at all, an `unresolved`/`unpinned` `FROM`, an outpost where `dependencyVersionPollRoleGuard` means the head was never observed locally, and a component with no dependency automation at all (D7) — arrives here as a MISSING fact rather than as a special case in the matcher.

### §443. True when every declared base-image line is at head

TRUE iff this target declares at least one `oci` base-image line AND every one of them is at its observed head BY DIGEST.

THE COMPARISON IS THE DIGEST, NEVER THE TAG (ADR-0033: "a tag is not an identity"). An OCI index reports tags, and a tag is mutable — `3.19` names a different set of bytes this week than last — so agreeing on a tag is not evidence of being on the same image. `latest_digest` is recorded in the SAME observation as `latest_version` for exactly this reason.

EVERY declared line, not any: a multi-stage build declares several, an `os-pkgs` finding names no image, and there is no material to attribute it to one of them. Requiring all of them is the only reading that cannot pass a finding that came from a stale base.

### §444. THE REQUEST-BODY VALIDATOR

THE REQUEST-BODY VALIDATOR — `z.strictObject`, and this is the guard ADR-0033 §6 names explicitly.

WHY STRICT HERE AND OPEN IN THE MIGRATION, which is not an inconsistency but the whole design. `import-repo.ts`'s `object_upsert` branch Ajv-validates an incoming object against the registered `property_schema` with NO `try/catch`, so ONE rejection aborts a peer's ENTIRE signed bundle and wedges the channel. A closed schema in the registry would therefore make every future property addition a fail-closed version-skew hazard — 0043's rule, and 0051's header restates it. So the registry stays OPEN and the strictness moves to the LOCAL author's door, where a refusal costs one 400 and nobody's bundle.

The strictness is load-bearing rather than tidy: `{"declarationz": {...}}` or `{"declarations": {...}, "egress": "none"}` would otherwise be stored, read as NO declarations, and the component owner would believe they had declared something. For a LOOSENING that mistake is only ever fail-closed — but it is silent, and the author has no way to discover it.

### §445. What the targets declared, as the gate resolved it

WHAT THE TARGETS DECLARED, as the gate resolved it — the only input the `declared_fact` predicate has, for the same reason the vendor facts are data: the matcher runs inside a plugin with no database.

A SORTED ARRAY OF PAIRS rather than a record, so the serialization is order-stable by construction on the way into the Decision's `inputContext`. (`restatesDecision` canonicalises object key order, so a record would in fact also be safe — but `packageKeys` next door is an array, and one shape for one job means nobody has to remember which of the two rules applies where.)

### §446. One standing grant, already approved and unexpired

ONE standing grant, already filtered to `approved` and already inside its expiry window by the resolver's read-time SQL comparison (ADR-0033 §6a: "expiry is a read-time SQL window, never a status column a job flips" — there is no sweeper in this tree and no `boss.schedule` to build one on).

`expiresAt` travels anyway, and NOT as a second enforcement point: it is the "until when" ADR-0033 §11 requires every applied exclusion to name. It is a STORED value, so two identical evaluations still serialize identically and write suppression holds.

### §447. The tier of that object, derived at resolve time

The TIER of `tierObjectId`, DERIVED at resolve time from the target's own containment chain — never a value anybody wrote down.

This is the field D3 is actually enforced on. `tierObjectId` is supplied by the REQUESTER, so on its own it decides nothing: naming a LOWER object would widen the approver set (`scopeExpandCte` expands upward), which is the exact inverse of "you cannot waive a constraint stricter than your own authority". The resolver therefore places the named object on the component's chain, reads its tier from that placement, and compares it against `ScanApprovedOverridesSchema`'s `requiredTier` — which is itself derived from the ceiling's contributing tiers. A grant that cannot be placed, or whose tier is junior to the bar, never reaches this array.

### §448. THE DERIVED BAR

THE DERIVED BAR (D3). The most senior tier that set any part of the ceiling this exclusion would loosen, and never below `org` — a bar of `component` used to mean "no tier set one", which was false: the control binding's `config.threshold` and the plugin's shipped fail-closed 0/0 are ceilings no tenant below `org` can author. See `requiredOverrideApprovalTier`. Present whenever the override dimension was resolved — it is the rule the grants above were measured against, and a Decision that named the grants without naming the bar would explain half of the verdict.

### §449. A grant's lifecycle, held in `properties.status`

A grant's lifecycle, held in `properties.status`.

FOUR STATES, and `expired` is deliberately NOT one of them. Expiry is a READ-TIME SQL WINDOW (ADR-0033 §6a) — `expiresAt > now()` evaluated by the resolver on every read — never a status a background job flips, because there is no sweeper anywhere in this tree and no `boss.schedule` usage to build one on. A fifth `expired` value would be a promise that something transitions rows into it, and nothing would.

`denied` and `revoked` are distinct on purpose: one is "this was never granted", the other is "this was granted and has been taken back", and an auditor reading a Decision that cites a grant needs to be able to tell those apart.

### §450. RAISING a request

RAISING a request. `tierObjectId` names the object whose tier set the rule the requester wants waived. It is constitutive of the request rather than something the approver supplies later.

IT IS A CLAIM, NOT A GRANT OF STANDING, and the difference is load-bearing. The first version of this comment said "naming a tier confers nothing: the approval check runs against the named object" — which was false in the one direction that mattered. `authz/resolve.ts`'s `scopeExpandCte` expands UPWARD, so naming a LOWER object strictly WIDENS the set of principals whose bindings satisfy the approve check. A requester could therefore select their own approver standing by naming an object they already held `policy:write` at, and waive a ceiling set far above it. Three derived checks now bound the claim, none of which trusts it:

```text
1. AT RAISE — the named object must lie on the component's own containment chain
   (`assertOverrideTierStanding`). An object elsewhere in the graph has no standing over this
   component at all.
2. AT APPROVE — the same chain check, re-derived, plus a refusal when an INSTANCE floor
   (`platform`/`trust_domain`) contributes any ceiling: those rungs are operator-authored and no
   tenant object maps to them, so such a grant could never apply and approving it would leave
   the approver with a false belief.
3. AT THE GATE — the decisive one. The resolver places `tierObjectId` on the target's chain,
   reads its TIER from that placement, and drops the grant unless that tier is at-or-above the
   most senior tier that contributed to the effective ceiling. That comparison is derived from
   `EffectiveScanThreshold.contributors`, which M22.0 recorded precisely so a verdict can name
   the tier that bound it.
```

### §451. WHY EVERY EXCLUSION FOR A SCAN WAS REFUSED

WHY EVERY EXCLUSION FOR A SCAN WAS REFUSED — a positive statement, never an inference from an empty applied list.

```text
`truncated`    — the persisted finding set hit `SCAN_FINDINGS_PERSIST_CAP`. "You cannot except
                 what you did not record" (ADR-0033 §7).
`unsupported`  — this scanner family carries no per-finding material at all. OpenSCAP: XCCDF
                 rule-results have no package, no purl, no `FixedVersion`, no `Class`, and
                 XCCDF emits no `critical`. ADR-0033's consequences list requires this be
                 explicit and tested rather than left to "there were no findings to exclude".
`not_recorded` — no finding set was recorded at all (a pre-M22.1b verdict, or a producer whose
                 payload did not survive validation).
```

### §452. THE CLASS'S OWN PREDICATE

THE CLASS'S OWN PREDICATE — the half of a clause that the class name promises.

A clause is `class` + narrowing matchers, and the class is NOT merely a label for admission: it is an assertion about the finding. A `no_fix_available` clause that excluded a finding which HAS a fix would make the Decision misdescribe its own inputs (charter principle 6), so the class is enforced as a conjunct, not trusted as a name.

`undefined` means THIS CLAUSE CANNOT BE RESOLVED, and it then yields NO exclusion. All four classes are now built (`vendor_latest` an ADR-0032 inventory join, `declared_fact` a typed component property, `approved_override` a standing grant with a read-time expiry window), so `undefined` no longer means "not written yet" — it means THE FACTS THIS CLAUSE NEEDS WERE NOT RESOLVED, which is the ordinary shape of every one of ADR-0033's fail-closed cases: no inventory, no declaration, no live grant. That the two states share a return value is deliberate and the reason is unchanged: a clause whose input is missing must fail CLOSED rather than degrade into "the matchers alone". Degrading would mean `{"class": "approved_override", "pkgName": "openssl"}` excluded every openssl finding — a blanket waiver written as an exception.

EXHAUSTIVE over `ScanExclusionClass` on purpose: a fifth class added later is a compile error here, forcing a decision, rather than silently inheriting either arm.

### §453. Pure data over the retained fields, with no join

M22.3 — PURE DATA OVER THE RETAINED FIELDS, no join of any kind. `fixedVersion` is absent exactly when Trivy reported no `FixedVersion` — read as the signal, never inferred from anything else (an EMPTY string is already normalized to absent by `parseTrivyFindings`, so `""` and a missing key are one state here rather than two).

NOTE WHAT THIS DELIBERATELY DOES NOT DO: it does not ask whether a fix exists ANYWHERE, only whether THE SCANNER SAID SO for this entry. A finding whose `FixedVersion` the scanner could not populate (an old vulnerability DB, a package ecosystem Trivy tracks without fix data) is excluded by a clause of this class, and that is the accepted meaning of the class: "the scanner offered us no remediation". Inferring the opposite from a second source would be a provenance label named after the branch that matched.

### §454. The component declared a fact making this inapplicable

M22.5 (D2) — "the component declared a fact that makes this finding inapplicable".

TWO CONDITIONS, both required, and the second is what keeps D2's accepted escalation seam bounded rather than unbounded:

1. The CLAUSE must name BOTH the fact and the value it relies on. A clause naming only `declaredFact: "egress"` would fire on any value at all — including `egress: "internet"` — which is a component excusing itself by writing a property whose CONTENT nobody constrained. Absent either key the predicate is `undefined` and the clause excludes nothing. 2. The TARGETS must actually have declared that exact pair. The comparison is a plain string equality on values that were bounded at the write door; there is no case-folding and no truthiness reading, because `"None"` and `"none"` being the same fact is the org's decision to make in its own vocabulary, not one this file may invent. An invented equality is a false positive, and for a loosening that is the one direction this feature may not fail in.

NOTE WHAT THIS DELIBERATELY IS NOT: the declaration does not describe the FINDING, so the predicate is finding-INDEPENDENT once the fact holds. The narrowing to the findings the fact actually excuses is the CLAUSE's other matchers (`findingClass`, `pkgName`, `vulnerabilityId`), authored at `policy:write` by whoever admitted the class — never by the component. That split is the whole of ADR-0033 §6 guard 1: the component authors the override, it does not author its own admission.

WHICH IS WHY AN UNNARROWED CLAUSE OF THIS CLASS IS INERT (third condition, added 2026-08-18)
The paragraph above is only true if the matchers EXIST. `ScanExclusionClauseSchema` makes all four of them optional, so `{"class": "declared_fact", "declaredFact": "egress", "declaredValue": "none"}` used to return a bare `() => true` — every finding, every severity, for every target that declared the pair. Admission is per CLASS, so the tiers above consent to "`declared_fact` may be used beneath me" and can NEVER see the blast radius of the clause a lower tier then writes: one service-tier author plus any component owner's `object:write` on their own `properties` turns the scan gate off for that component entirely. So a clause carrying none of `vulnerabilityId` / `pkgName` / `purl` / `findingClass` resolves to `undefined` — no exclusion at all.

THIS IS THE READ HALF OF A PAIR, and neither half is redundant. `scan-rule-authoring-guard.ts` refuses the shape at the local write door with a 400 that names the fix; this refuses it at evaluation, which is the only reach a clause ALREADY STORED has (authored before the guard existed, or arriving over federation import, which the guard deliberately cannot touch because a throw there aborts a whole signed bundle).

THE CENSUS — the property is "a class predicate that does not itself narrow per finding", and it is unique to this class. `no_fix_available` reads `fixedVersion` OFF THE FINDING; `vendor_latest` joins the finding's class, purl, name and installed version against the resolved facts; `approved_override` joins the finding's `vulnerabilityId` against a specific grant. Each of those is a genuine per-finding test whose reach an admitting tier can predict from the class name alone, so an unnarrowed clause of those classes excludes exactly what the class says and no more. This one alone collapses to a constant, and only this one gets the extra requirement.

### §455. Does this clause narrow which findings it reaches

Does this clause carry at least one matcher that narrows WHICH FINDINGS it reaches?

EXPORTED because the authoring guard (`apps/server/src/governance/scan-rule-authoring-guard.ts`) refuses exactly the shape this rejects, and two hand-synced spellings of "narrowed" is the shape where the door and the evaluator drift into disagreeing — the door accepting a clause the gate silently ignores, or worse, the reverse. It is a predicate over the CLAUSE only, so it stays here beside the schema that declares the four fields optional.

`declaredFact`/`declaredValue` are deliberately NOT counted: they narrow which COMPONENTS the clause resolves for, never which findings it then excuses, and it is the finding reach that the admitting tiers above cannot see. `reason` is free text and narrows nothing.

### §456. An override was raised and approved at the required tier

M22.6 (D3/D4) — "an owner raised an override request, it was approved at the tier that set the rule, and it has not expired".

Every one of those three words is decided BEFORE this predicate: the resolver reads only grants whose status is `approved` and whose expiry is still in the future at the moment of the read (the read-time SQL window), and approval itself required `policy:write` at the object naming the tier that set the rule. What is left here is the per-finding join, and it is deliberately EXACT: `vulnerabilityId` must be equal, and a grant that also names a `pkgName` must match that too.

NO grants resolved yields `undefined` — no exclusion — rather than a predicate that is always false, so a clause of this class with nothing granted behaves identically to a class whose machinery does not exist. Both are "excludes nothing"; keeping them the same shape means a later reader cannot mistake one for the other.

### §457. WHICH grant excuses this finding

WHICH grant excuses this finding — the SINGLE definition, shared by the predicate above and by the evidence projection in `applyScanExclusions`.

Two functions answering "does a grant match?" and "which grant matched?" is exactly the shape where the evidence names one grant and the verdict was decided by another. The first grant in the resolver's own deterministic order wins, so two identical evaluations attribute identically.

### §458. We are on the latest version of this major line

M22.4 (D1) — "we are on the latest version of this dependency's major line", read off the SERVER-RESOLVED facts and the finding's own `Results[].Class`.

`undefined` when NO facts were resolved: a `vendor_latest` clause with no inventory behind it excludes nothing at all, which is the whole of D7's "the gate is decoupled from automation, the data is not" — a component with no dependency automation has no ingested manifests and no polled head, so it gets no vendor-pass and upgrades manually.

THE FACTS DESCRIBE THE MANIFEST; THE FINDING DESCRIBES THE ARTIFACT. Everything below exists to keep those two from being confused, because the inventory is resolved from what a component DECLARED and the scan is run against what an image actually SHIPS, and nothing forces the two to agree — a rebuild, a lockfile, a cached layer or a base image that vendors its own copy all make them differ. Both narrowings below are that one property, applied twice.

### §459. NO `fixedVersion` BACKSTOP HERE, AND THAT IS A DECISION

NO `fixedVersion` BACKSTOP HERE, AND THAT IS A DECISION (owner, 2026-08-18).

A blanket `finding.fixedVersion !== undefined ⇒ refuse` was implemented during the review round and REMOVED. It reads like free fail-closed safety and is not: it refuses the exact case D1 exists for. D1 is "we are on the latest version OF A MAJOR VERSION" — so a component at the head of the `3` line, against a fix that shipped only in `4.x`, IS at head of the line it declared, and a major upgrade is a project rather than a patch. The blanket rule excused nothing that `no_fix_available` would not already excuse, which left this class unable to earn its own existence.

THE SAME-MAJOR CASE NEEDS NO BACKSTOP, which is why dropping it costs nothing real: if a fix shipped within the declared major line, then the line's head has moved past the installed version, the inventory says so, and the version join below refuses on that basis — from the org's own observed data rather than from the scanner's opinion.

OS PACKAGES → THE BASE IMAGE LINE. An `apk`/`deb`/`rpm` package is not declared in any manifest; what the component declares is the `FROM` it came in on, so the base image line's head is the fact that speaks for it. The `oci` arm of `evaluateVendorLineAtHead` compares DIGESTS, so `baseImageAtLatest` already speaks about bytes rather than about a tag — there is no version for the join below to narrow.

### §460. A LANGUAGE PACKAGE → ITS OWN DECLARED LINE

A LANGUAGE PACKAGE → ITS OWN DECLARED LINE. `pkgName` is the join key rather than the purl's own name segment because Trivy spells a package the way its ecosystem does — `@babel/core`, `com.acme:lib`, `github.com/acme/lib` — which is exactly how the manifest parsers spell a coordinate. The purl is read for the ECOSYSTEM only, and a finding with no purl (or a purl of an OS type) yields no ecosystem and therefore no match: the alternative, matching a bare name across all four ecosystems, would let a transitive npm `requests` be excused by a declared Python `requests` at head.

### §461. NO `InstalledVersion` ⇒ NO PASS

NO `InstalledVersion` ⇒ NO PASS. `parseTrivyFindings` retains an entry on its severity alone, so a finding with no installed version is a real shape, and it is one this rule cannot answer: the facts say which VERSION of a package is at head, and a finding that will not say which version it is cannot be shown to be that one.

MEASURED, NOT ASSUMED: deleting this line alone changes no behaviour — every key in the set is built from a non-null `resolved_version`, so a `…|undefined` lookup misses anyway, and the mutation run confirmed the suite stays green. It is kept because it is what makes the required third parameter below type-check, and that is the load-bearing part: without it the only way to compile is to coerce the missing version or to drop it from the lookup, and THAT mutation (degrading to a name-prefix match) kills four tests. Stated here rather than left as a line a future reader deletes as dead.

### §462. APPLY the resolved clauses to a scan's findings

APPLY the resolved clauses to a scan's findings — BEFORE counting, never as a waiver on a verdict (ADR-0033 §2).

PURE, and the ONE place a clause meets a finding, so both verdict producers (the `scan-result-control` plugin and the commander's own promotion scan step) can never diverge about what an exclusion means.

`record` is the finding set's own marker and it GATES EVERYTHING. Only `full` admits an exclusion: `truncated`, `unsupported` and ABSENT each refuse EVERY exclusion for the scan, with the reason stated positively in evidence. That is not defensive coding — it is the ADR-0033 §7 rule, and it is why the per-scan cap keeping the first N findings in parse order is safe.

FIRST MATCHING CLAUSE WINS for attribution. A finding is excluded once; which of two matching clauses is named is decided by the clauses' own deterministic order, so two identical evaluations attribute identically (the M22.0 write-suppression rule — nothing here may vary between two evaluations of the same inputs).

### §463. The post-exclusion counts, derived from what was produced

The POST-EXCLUSION counts, derived from the counts the scanner actually produced MINUS one per excluded finding.

Deliberately a DELTA on `severityCounts` rather than a recount of the survivors. The survivor list is the CAPPED set, so recounting it would silently report a truncated scan's numbers as smaller than the scanner's own — while `severityCounts` is derived BEFORE the cap. A truncated set refuses every exclusion, so the delta is zero there and the two counts stay identical, which is exactly the property a recount would break.

### §464. The full evidence payload a scan outcome carries

The full evidence payload a `scan-result-control` outcome carries. Bound to a SPECIFIC artifact digest (`artifactDigest` = the digest Trivy actually scanned; `expectedDigest` = the digest the change is promoting): `digestMatch` is the ADR-0013 "nothing slipped in" check at the control level — a verdict whose scanned digest does not match the change's artifact does NOT authorize the change (the control returns `fail`, and this evidence records `digestMatch: false`).

### §465. WHICH scan method produced this verdict

WHICH scan method produced this verdict. Widened from `z.literal("trivy")` to `ScanMethodSchema` (ADR-0020 §2 / proposal §13.3, 13.3a) — this was designed as a field "so a future second scanner slots in without a shape change", and `openscap` is that second scanner (`trivy-vm`, the machine-image arm, is the third). The widening is strictly ADDITIVE and GATE-INVISIBLE: `trivy` is still accepted, so every existing evidence document (and the E6 export gate's `ScanEvidenceSchema.safeParse`, promotion-repo.ts) parses byte-for-byte unchanged; the gate reads only `digestMatch`/`artifactDigest`, never `scanner`.

### §466. What the persisted finding set is for this verdict

M22.1b (ADR-0033 §7) — WHAT THE PERSISTED FINDING SET IS for this verdict: `full`, `truncated` at the per-scan cap, or `unsupported` because this scanner family carries no per-finding material at all (OpenSCAP). Written by the SERVER at persist time — the only party that knows what actually landed — never by the producing plugin.

Optional, so every pre-M22.1b evidence document still parses. ABSENT means no finding set was recorded, and a consumer must treat it exactly like `truncated`: refuse every exclusion. Only `full` admits one.

This is the MARKER, not the findings. The findings themselves are commander-local rows in `scan_findings` and deliberately never reach this document, because evidence is copied verbatim into the promotion bundle.

### §467. The counts the threshold was actually compared against

M22.2 (ADR-0033 §2) — the counts the threshold was ACTUALLY compared against, AFTER exclusions.

`severityCounts` above is untouched and keeps meaning WHAT THE SCANNER FOUND, because operators author CEL conditions against `evidence.severityCounts.*` and redefining it post-exclusion would silently change the meaning of every rule already written. Those conditions stay STRICTER than the gate's own comparison — a divergence, but safe-signed, and documented here rather than discovered.

WRITTEN ONLY WHEN THE GATE RESOLVED AT LEAST ONE ADMITTED CLAUSE. With nothing authored this key is absent and the evidence document is byte-identical to pre-M22.2.

### §468. M22.7 (ADR-0033 §10) — THE ACTUATOR'S HANDLE

M22.7 (ADR-0033 §10) — THE ACTUATOR'S HANDLE: a content hash of the exclusion set the GATE RESOLVED AND THREADED for this run.

WHAT IT IS FOR. A control outcome is cached and treated as a historical fact (`control-runner.ts`), so without this every grant is inert on any change whose gate has already run — "a signal with no lever". The reconcile prewarm and the wave-boundary gate re-resolve the set on every pass, hash it, and force a re-run when this recorded value differs. A grant approved (or expired, or revoked) after a verdict was reached is therefore noticed exactly once, at the next evaluation, rather than never.

WHAT IT IS NOT. It is NOT a claim about what the producer *did* with the set — that is `ScanExclusionEvidenceSchema` above, which records the applications and the refusals. It is the label "this verdict was computed while THIS set was in force", written by the server, which is the only party that knows what it threaded. Reading it as "the producer honoured these clauses" would be exactly the inferred-provenance-label defect this codebase has already paid for once.

IT CARRIES NO TIMESTAMP AND NOTHING DERIVED FROM `now`. The digest is taken over the RESOLVED SET — clause list, admitting tiers, and the stored facts (a grant's own `expiresAt` is a stored value, not a clock reading). Hashing anything time-varying would make it differ on every tick and re-run the control forever, re-creating the measured 1.44 GB/day write-amplification pattern in a new sink.

ABSENT when the gate resolved NO admitted clause, so a deployment with nothing authored writes a byte-identical evidence document to pre-M22 — and absent on every run written before M22.7, which the comparison treats as "not the current set" and re-runs once.

### §469. Where the applied ceilings came from, per severity

M17.5 (ADR-0016) — WHERE the APPLIED ceilings actually came from, per severity. This is the honest label: the two sources are merged per-severity (tighter wins), so "the gate threaded a scoped floor" is NOT the same claim as "the scoped floor decided this verdict". `"config"` = the flat per-binding `config.threshold` supplied the applied (tightest) value; `"scoped"` = the gate-resolved six-tier merge did; `"default"` = neither source constrained that severity and the historical fail-closed default (0) applies.

### §470. Summary of `thresholdSources`

Summary of `thresholdSources`: `"config"`/`"scoped"` when every constrained severity was decided by that one source, `"mixed"` when both decided at least one severity each, and `"default"` when NEITHER source constrained anything and the applied ceilings are entirely the historical fail-closed default (0/0). Never reports `"scoped"` merely because a scoped floor was present, and never reports `"config"` merely because nothing was decided — see `thresholdSources`. Optional so every pre-M17.5 evidence document still parses.

### §471. Provenance and freshness of the scanner database used

M13.3b-ii — provenance + freshness of the scanner DB this verdict was produced against, so a Decision (and the status read) can explain "scanned with a stale/refreshed/operator-loaded DB". Only `fresh`/`warn` ever reach evidence (a `hard-fail`/`missing`/`corrupt` DB produces NO scan → no evidence → E6 refuses). All optional — a scan run before this increment, or with the baked fallback and no cache, simply omits them and still parses. Trivy-only (OpenSCAP uses SSG).

### §472. M17.2 — BUILD-TIME SBOM, stored as a REFERENCE on the promotion

M17.2 — BUILD-TIME SBOM, stored as a REFERENCE on the promotion (ADR-0015 §5).

CHARTER — coordinate, not execute: SCP NEVER generates an SBOM and NEVER stores its BYTES. The EXECUTOR's coordinated Trivy pass emits the SBOM at BUILD time and cosign-signs it at ORIGIN; SCP persists only this reference — WHERE the document lives, WHAT it hashes to, and WHICH origin signature attests it. `scanner`/`scannerVersion`/`signatureRef` record WHO produced and signed it externally; none of them is a claim that SCP did anything.

Why reference-only is FORCED, not a preference: SCP has no blob storage anywhere (no binary column in the schema, no multipart ingress, no object store) — every artifact in the system is already a string reference inside a jsonb column — and federation/promotion bundles are METADATA-ONLY by ADR-0009. Storing SBOM bytes would be a net-new storage subsystem AND would break the metadata-only bundle invariant. So: reference in, reference out.

2026-07-23 evolution (ADR-0020, "managed-scan-evidence"): this reference-only posture is evolved — narrowly — for evidence the commander's own `scp-managed-scan` promotion scan step produces. That evidence lands commander-resident in a Postgres-backed evidence store (still no blob storage, no new stateful service — a registry-shaped table, not bytes-out-to-Gitea) because the commander is that evidence's ORIGIN, not a cache of someone else's bytes. Org-pipeline SBOM/scan evidence above stays reference-only, unchanged; see ADR-0020 §3 and the merged proposal docs/proposals/airgap-cds-validate-promote.md §13.3.

WHERE it is persisted: `changes.sourceRef.sbom` (the report body is persisted verbatim and becomes the change's canonical `sourceRef` — `coordination/webhook-processor.ts`). `source_ref` is jsonb, so this shape costs ZERO migration. HOW it arrives: the typed first-party report ingress (`POST /change-sources/{sourceKind}/report`, `ChangeReportRequestSchema.sbom`) — the only TYPED, SDK-generating ingress (charter principle 3), already PAT-authed and already carrying the artifact digest this SBOM describes.

This shape is the M17.3 CONTRACT: the promotion manifest's artifact set reads these fields.

### §473. The same canonical digest form the normaliser produces

`sha256:<lowercase-hex>`. Deliberately the same canonical form `normalizeSbomDigest` produces, so a test-bundle digest and an artifact digest compare byte-for-byte against each other and against scan evidence.

DEFINED HERE, NOT IN `pipeline-behaviors.ts` WHERE D23 IS SPECIFIED, for one mechanical reason: `pipeline-behaviors.ts` imports `ExecutorTypeSchema` from `executors.ts`, and `executors.ts` needs `TestBundleRefSchema` below for `ChangeReportRequestSchema.testBundle`. Defining these two in `pipeline-behaviors.ts` would close that loop into an import cycle whose failure mode is a `ReferenceError` at module-evaluation time, not a compile error. This file imports neither, and it is where the digest normalisation these forms agree with already lives.

### §474. The test bundle (D23, §14 resolution 9)

The test bundle (D23, §14 resolution 9) — an OCI artifact beside the image.

WHY TESTS CROSS AS ARTIFACTS AND NOT AS REFERENCES: a govcloud or air-gapped domain provably cannot reach back to the commercial source repo, so a `path:` alone cannot be what runs there. The workflows a pipeline's tests name are captured AT THE BUILT COMMIT into this bundle, which is origin-signed, enumerated in the promotion manifest, signature-verified per hop, and distributed lazily on the image's OWN admitted crossing. It is NOT scanned — scan stays image-only per M13.

The consequence worth stating: EVERY domain, commercial included, runs the local digest-pinned copy. One behaviour, not two. A design where commercial resolved from git and the air gap resolved from a bundle would be two mechanisms wearing one contract's name.

WHERE IT IS PERSISTED, and the exact parallel to `SbomRefSchema` below: a build REPORTS this reference on `ChangeReportRequestSchema.testBundle` and SCP stores it on the change's `sourceRef.testBundle`. SCP does not build the bundle, does not sign it, and does not mint an `artifact` object from the report — a reported reference is the executor's claim, and ADR-0045 D2 keeps minting at promotion export/import, where the commander's own attestation is real.

### §475. A REFERENCE to a build-time SBOM

A REFERENCE to a build-time SBOM. Never the document itself.

`digest` is the SBOM DOCUMENT's own content digest (what the reader must verify the fetched bytes hash to) — it is NOT the artifact digest; the artifact this SBOM describes is the change's own `sourceRef.artifact_digest`, which travels alongside it on the same report.

M10.6 `.strict()`: this is the field-level half of the M10.6 discipline (`ChangeReportRequestSchema`'s own doc comment) — SCP has no column, no codec, and no route that stores SBOM bytes, and this is what makes "no way to smuggle the document inside the reference" an ENFORCED refusal (400 naming the unknown key) rather than a silent strip. A REFERENCE has a small, closed field set on purpose; an SBOM DOCUMENT (e.g. a `document`/`bomFormat`/`components` field) is exactly what `.strict()` now refuses.

## `packages/schemas/vitest.config.ts`

### §476. THE PER-TEST BUDGET, DECLARED RATHER THAN INHERITED

THE PER-TEST BUDGET, DECLARED RATHER THAN INHERITED (M23.1f clause 6).

Vitest's implicit default is 5,000ms. `@scp/runner-launcher` ran its unit suite on it while holding the repo's heaviest sweeps and flaked 5 runs in 23 of `pnpm -w test` — never once in 420 isolated runs, because isolation is the wrong load profile: what consumes the headroom is the 109-task parallel graph, not the test. `apps/server` had already raised its own budget for exactly this reason in 2026-08 and the sibling packages were left on the default, which is the incomplete-call-site-census property CLAUDE.md names.

The rule is now machine-checked by `@scp/source-census`'s `test-budget-census.test.ts`: every package whose `test` script is vitest must DECLARE a number, and that number must be one the census table names. This is headroom, not a slow-test licence — a passing test is unaffected by the budget, so the only cost is that a genuinely wedged test takes longer to be declared dead.

### §477. The hook budget: a second deadline nobody chose

THE HOOK BUDGET, declared for the reason `@scp/source-census`'s `test-budget-census.test.ts` gives in full: vitest's `hookTimeout` is a SECOND, independent deadline whose implicit default (10,000ms) nobody chose, and the only hook cost this repo has ever measured under CI's load profile — `@scp/cli`'s lazy-import warm-up — was 5,400ms against it. 30,000 is 25x the isolated worst case in the unit layer (1,205ms) and half the un-declarable 60,000ms `onTaskUpdate` RPC deadline a synchronous hook would otherwise be free to cross.
