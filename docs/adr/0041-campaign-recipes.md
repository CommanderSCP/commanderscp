# ADR-0041: Campaign recipes — one authored trigger intent, fanned across N targets, refused loudly where it cannot be honoured

**Status:** Accepted for the lever itself (owner decision **D3**, 2026-08-23, recorded in [campaigns-rework.md §3](../proposals/campaigns-rework.md)). **§7 records two departures from the proposal's §3 sketch and one hazard the implementation found that the proposal did not anticipate** — the third is flagged for owner attention because it touches unruled **OQ-5**.

**Numbering note (2026-08-23):** 0039–0042 are reserved by campaigns-rework.md; this is 0041. See [ADR-0040](0040-platform-tier-freezes.md)'s identical note for why `main`'s highest number is not the answer.

**Relates to:** [campaigns-rework.md §3](../proposals/campaigns-rework.md) (design and grounding), [ADR-0022](0022-outpost-config-authority-split.md) clause 2 (config that crosses a boundary rides `object_upsert`), [ADR-0006](0006-fail-closed-on-missing-executor-binding-for-purpose.md) (the refuse-rather-than-fake-succeed precedent this reuses three times), [ADR-0007](0007-executor-binding-type-taxonomy.md) (the routing Type a campaign declares once), [ADR-0032 §6a](0032-dependency-subscriptions.md) (the authoring-guard census that found three doors), charter principles 1, 2 and 6.

## Context

The owner asked for campaigns to "provide levers to make migrations easier (python2 → python3, a 1-click upgrade)". Decision **D3** settles what kind of lever that is: **a coordination lever, not an authoring one.** CommanderSCP fans out, orders, gates and *triggers the tenant's own pipeline*. It never writes the patch.

That constraint is not a preference. Charter principle 1 says SCP coordinates rather than executes, and the one standing exception — the `scp-managed-*` grant — is textually narrow ("editing the declared version of an already-declared dependency", "never authors any other content", "never builds, compiles, or tests"). A python2→python3 port is code. Nothing in this ADR stretches that grant.

The mechanism turned out to already exist and to be **unwired**. `TriggerIntent.parameters` has been on the `ExecutorPlugin` interface since M3 and **every** adapter reads it, but the only server call sites that ever populated it were `dependencies/bump-dispatch.ts`, `dependencies/bump-gate.ts` and `federation/promotion-scan-step.ts`. The generic release path in `coordination/reconcile.ts` constructed `{kind, targetRef, priorStateRef, idempotencyKey}` and nothing else. So the channel from "an operator's declared intent" to "the tenant's pipeline, per component" was complete except for its last inch.

## Decision

### 1. The recipe is a document at `campaign.properties.recipe` — not a table, not a new object type

`campaign.properties` validates against an **open** JSON Schema (`0011_campaigns.sql:120-128`, no `additionalProperties:false`) under `new Ajv({strict:false})`, and `proposeCampaign` already writes `type`/`topologyObjectId`/`topologyVersion` into it. A new `recipe` key validates today with **zero schema work and no migration**.

Two alternatives were considered and rejected, and the second is the one a reviewer expects to win:

- **A new `migration-recipe` object type.** `federation/import-repo.ts`'s `object_upsert` branch resolves `typeId` with no try/catch and `createObject` 404s on an unregistered type — so one such object aborts a peer's **entire signed bundle**. A runtime custom type federates to nobody.
- **A `campaign_recipes` projection table**, on the [ADR-0040](0040-platform-tier-freezes.md) `freezes` precedent. Rejected. That precedent is real but it earns its table on **window semantics queried on a hot gate path**; a recipe has no window, no lifecycle and no independent identity, and is read once per trigger. Charter principle 2 is the general rule here — new concepts arrive as data on existing objects — but the decisive argument is **reach**: [ADR-0022](0022-outpost-config-authority-split.md) clause 2, config that must cross a federation boundary rides `object_upsert` as a graph object. **Nothing table-shaped travels.** `freezes` gets away with a table precisely because freezes did not federate when it was written.

The registry schema stays **open** (the 0043/0075 rule): a closed registry schema makes every future key a fail-closed version-skew hazard that wedges a peer's whole bundle. Strictness lives at the author's door instead (§3), where a refusal costs one 400 and nobody's bundle.

### 2. The recipe is copied **by value** onto each member change

`campaign-reconcile.ts` writes the parsed recipe into each fanned-out change's `properties` at proposal time. Three consequences, each load-bearing:

- **Immutability.** Editing the campaign later cannot retroactively re-narrate what an already-fanned-out change did — the `control_runs.plugin_module` rule applied to the same class of question.
- **Federation reach.** `federation/promotion-repo.ts` re-proposes a promoted change *locally*, carrying `properties` through and stripping exactly `requires` and `stageDependencies` (verified at `:912-916`). A recipe on the **change** therefore arrives at an outpost intact, and that outpost's own reconcile resolves the **outpost's** binding and triggers through its own local gates. A recipe left only on the campaign object would reach the outpost as an inert replica — `listActiveCampaignObjectIds` filters foreign-origin campaigns out, and that filter is correct, not an oversight.
- **One reader.** The trigger path needs no campaign lookup and no `coordinates`-edge walk; it reads `change.properties` exactly as it already does for `stageDependencies`.

The strip list is pinned by a regression test, because a future *third* stripped key would silently drop the recipe and the campaign would go green having triggered a bare sync.

### 3. Strictness at the `objects-repo` choke point — three doors, not one

`campaign.properties` has exactly **three** write doors, and the typed route is only one of them:

1. `POST /api/v1/campaigns` → `proposeCampaign` → `createObject`
2. **IaC apply** → `iac/plans-repo.ts` → `createObject`/`updateObject` **directly**, with free-form `typeId` and free-form `properties`. It never touches the campaign route.
3. **Federation import** → `import-repo.ts`'s `object_upsert` branch and its operator-facing twin `federation/handfill-repo.ts`.

The generic `/objects/{type}` route is **not** a fourth door — `coordination/campaign-scope-authz.ts` refuses `campaign` on every write verb there. A guard at the route would therefore miss two of three, which is precisely the miss [ADR-0032 §6a](0032-dependency-subscriptions.md) records. The guard goes at `graph/objects-repo.ts`'s `createObject`/`updateObject`, plus `handFillObject`. The `updateObject` half is checked against the value **about to be stored**, since an ordinary PATCH can rewrite a valid recipe into an unreadable one without passing through a create.

**`change` is deliberately NOT guarded**, and this is the considered half of the census rather than a gap. `promotion-repo.ts` re-proposes a promoted change locally with `federationImport` unset, so a refusal on `change` fires on the promotion path — and `federation/inbox-loop.ts:552-556` **defers a 400 and retries it forever**. An older outpost meeting a newer recipe vocabulary would loop silently instead of failing once. That gap is closed at the other end, fail-closed, by §4's `recipe_unreadable` refusal. Strict where a human is standing there to read the 400; loud-and-terminal where they are not.

### 4. Three refusals, three statuses, three remedies — and `trigger()` is never called

`change_wave_targets.status` is plain `text` with no CHECK constraint and `ChangeWaveTargetSchema.status` is `z.string()`, so each new value costs **no migration** and is API-additive within `/v1` — the same three facts [ADR-0006](0006-fail-closed-on-missing-executor-binding-for-purpose.md) recorded for `no_executor`.

| status | cause | remedy |
|---|---|---|
| `recipe_unreadable` | the document does not parse | fix the document |
| `recipe_unsupported` | `describeCapabilities().triggerKinds` omits the recipe's kind | bind an executor that has the verb, or narrow the campaign's targets |
| `recipe_managed_executor` | the target is bound to one of SCP's own actuators (§5) | remove the target, or bind the pipeline that performs the migration |

Three statuses rather than one status with a `cause` field is `terminalizeRefusedWaveTarget`'s own stated rule — it takes the status as a *parameter* "precisely so a second cause could not be smuggled in under the first one's name". The remedies differ, and collapsing them sends an operator to the wrong surface.

Each writes a `block` Decision with a resolvable `decision_id` and a hash-chained audit event (charter principle 6), terminalizes the row, and fails the wave. **`trigger()` is never called** — asserted directly rather than inferred, because the failure this prevents is not an error. `github` and `gitea` resolve `intent.parameters?.workflowId ?? config.defaultWorkflowId`: a silently-dropped recipe **dispatches the target's ordinary workflow, that run succeeds, the target goes `succeeded`, and the campaign reports a migration that never happened.** A refusal is the only outcome that leaves nobody with a false belief.

**Fail-closed on an undeclared capability set.** Capabilities that omit `triggerKinds` — a third-party plugin predating the field, a malformed reply — are treated as "cannot serve it". An executor that does not say what it can do is not evidence that it can do this. A *thrown* `describeCapabilities()` is **not** a refusal: it propagates and the target retries next tick with nothing terminalized, the same fail direction `readTargetLiveness` documents, because a plugin-host blip must never be mistaken for "this executor cannot do that".

### 5. A recipe may not drive CommanderSCP's own actuators (OQ-5, unruled)

**OQ-5 asks whether a campaign may delegate to the already-built `managed-dep` bump actuator. It is unruled, and M25 ships without it.** Enforcing that turned out to need explicit code, because the capability check alone does *not* deliver it.

Measured at HEAD:

| module | `triggerKinds` | what `custom` means to it |
|---|---|---|
| `managed-dep` | `["custom"]` | `parameters.action: "bump"\|"merge"` — **writes a commit to a tenant repository** |
| `managed-scan` | `["custom"]` | `parameters.inputDir`/`outputDir` — server-controlled scan layout |
| `managed-iac` | `["sync","rollback","custom"]` | `parameters.sourceFiles` — authored file bodies |

All three answer **yes** to `"custom"`. So a recipe of `{kind:"custom", parameters:{action:"bump", …}}` passes the capability check against a `managed-dep` binding, and reconcile would hand author-controlled parameters straight to the bump actuator. `managed-dep` is on `KNOWN_EXECUTOR_MODULES`, and `executor-bindings-repo.ts` states plainly that server settings "are still injected below for a managed-dep binding an operator creates by hand" — so such a binding is a supported shape that `resolveBindingForTarget` resolves like any other.

`RECIPE_FORBIDDEN_EXECUTOR_MODULES` refuses all three, **checked before `describeCapabilities()`** since asking the capability question first returns "supported" and lets the parameters through. The capability check asks what an executor *can* do; this asks what CommanderSCP *may ask it to*, and only the second is a charter question.

This is a **fail-closed default on an unruled question, not a ruling**. If OQ-5 later permits it, this constant is the single seam that changes.

### 6. No cross-provider translation — pass through verbatim, or refuse

A recipe written in `github` keys (`workflowId`, `ref`, `inputs`) is **never** rewritten into `gitlab` shape (`ref`, `variables`) or `argocd` shape (`targetRevision`). The parameter bag reaches `TriggerIntent.parameters` byte-for-byte.

Measured adapter table (source lines in `packages/plugins/*/src/index.ts`):

| module | `triggerKinds` | reads from `intent.parameters` |
|---|---|---|
| `github` | `workflow_dispatch`, `custom` | `workflowId`, `ref`, `inputs`; `eventType` + `clientPayload` when `kind === "custom"` |
| `gitea` | `workflow_dispatch` | `workflowId`, `ref`, `inputs` |
| `gitlab` | `workflow_dispatch` | `ref`, `variables` (sent as a `[{key,value}]` array) |
| `argocd` | `sync`, `rollback` | `targetRevision` |
| `pipeline-generic` / `terraform` | `sync`, `rollback`, `custom` | the whole bag, passed through |
| `fake-executor` | all four | — |

Two decisive reasons not to translate. First, a translation layer must re-render a declaration SCP does not fully model, and **a wrong guess does not fail — it triggers the wrong automation in the tenant's own repository**. `inputs` and `variables` are not the same thing: GitHub validates inputs against the workflow's declared `workflow_dispatch.inputs`, GitLab variables are free-form CI variables. Any mapping between them is a guess about semantics. Second, the per-component variance a 47-component estate actually has is **already solved one layer down**: `github`/`gitea` resolve `intent.parameters?.workflowId ?? config.defaultWorkflowId`, and each binding already carries its own. The recipe supplies the *migration* parameters; the *which-workflow* answer stays on the binding, where a genuine outlier overrides it — never in a 47-entry map on the campaign.

The safety valve for a mixed estate is not translation, it is §4's refusal. Note that `argocd`'s `["sync","rollback"]` and `github`'s `["workflow_dispatch","custom"]` are **disjoint**, so no single recipe kind can cover a mixed estate — which is exactly why the refusal must be explainable per target rather than validated once at authoring time.

### 7. Rollback ignores the recipe entirely — both directions

`CampaignRecipeTriggerKindSchema` is `TriggerIntent["kind"]` **minus `"rollback"`**: a campaign author may not turn every member change into a restore, and because the recipe rides the change through federation promotion, such a document would arrive at an outpost too.

The inverse is enforced at the actuator: `isRollback` overrides the recipe's kind unconditionally, **and the recipe's parameters are withheld from a rollback as well**. Passing migration parameters to a restore would re-run the migration under the name of undoing it — `github` would resolve the recipe's `workflowId` and dispatch the python3 workflow again while the operator believed they were reverting. This is why the whole refusal-and-parameters block sits behind `!isRollback`, not merely the kind assignment.

### 8. Absent recipe ⇒ byte-identical to pre-M25.4

`parameters` is spread conditionally, so a change with no recipe produces the exact same intent object it did before — `parameters` **absent**, not `{}`. `pipeline-generic` passes the bag straight through to a tenant's own HTTP endpoint, so a new empty object appearing on every trigger on the instance is a wire change, not a no-op. Likewise `resolveChangeRecipe` returns on a pure key-absence check before parsing anything, since this runs once per wave target per trigger for every change on the instance.

### 9. Bounded before it becomes a row

`trigger.parameters` is capped at **8 KiB** of serialized JSON and **6** levels of nesting, and no parameter key may contain a credential-shaped substring (`secret`, `token`, `password`, `passwd`, `credential`, `apikey`, `privatekey`, `accesskey`) — matched against a key **normalized to lowercase alphanumerics**, so `api_key`, `x-api-key` and `apiKey` collapse to one rule and the separator vocabulary cannot grow a hole.

The size cap is not hygiene: the recipe is copied onto **every** member change's `properties` (47 rows for the motivating campaign) and reaches a `block` Decision's `inputContext` on the refusal path. An unbounded free-form bag on both is the shape of the measured 1.44 GB/day Decision-growth incident arriving through a different door. The key rule is not hygiene either: `objects.properties` is readable at `object:read` and travels through federation, so a credential placed there is published to everyone who can read any one of 47 changes, and **no later fix can un-publish it**. Credentials belong in `executor_bindings.secret_refs`, which the plugin host resolves per instance and never puts on the graph.

## Departures from the proposal, and one thing it did not anticipate

1. **`recipeFrom` is not built.** campaigns-rework.md §3.2 proposes `CreateCampaignRequestSchema.recipeFrom?: string` — a campaign idOrUrn resolved and inlined at create time, for reuse without a new type. It is additive, costs nothing to defer, and no owner decision turns on it. Deferred.
2. **A third refusal status exists that the proposal's §9 table does not list.** The proposal names `recipe_unsupported` only; `recipe_unreadable` and `recipe_managed_executor` were added for the reasons in §3 and §5.
3. **OQ-5 needed active enforcement, not abstention.** The proposal treats "ship M25 without it" as a decision to *not build* a coupling. Because `TriggerIntent.parameters` is the shared channel, not building it was not sufficient — wiring the channel *created* the coupling transitively through `kind: "custom"`. §5 is the code that actually delivers the proposal's stated position. **Flagged for owner attention:** if OQ-5 is ruled permissive, §5 is what changes; if it is ruled restrictive, §5 should be re-read as the enforcement point rather than re-invented.

## Consequences

- A campaign is a real coordination lever: configure one trigger intent, and N components each get their own governed, wave-ordered, gated member change triggered against their **own** already-bound executor.
- SCP still writes no patch. A tenant with no migration workflow has nothing to trigger, and the honest outcome is a refusal, not a managed migration.
- Three new terminal wave-target statuses exist. Any consumer enumerating terminal statuses must derive from `REFUSED_WAVE_TARGET_STATUSES` rather than restating the set — the mechanism that made the set one list was added in the same milestone and immediately proved itself, since `recipe_managed_executor` needed exactly one edit to land in all five consumers.
- A mixed-provider estate cannot be covered by one recipe. That is a true fact about the estate surfaced per target, not a limitation this design chose.
