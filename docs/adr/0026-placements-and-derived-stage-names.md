# ADR-0026: No `stage` entity — a stage name is derived, and the (component × place) pair is a `placement`

**Status:** Accepted (2026-08-01). This ADR settles **vocabulary and the object model**; the implementation plan and migration sequence live in the context doc and are separately under review.
**Context doc:** [docs/proposals/post-import-configuration.md](../proposals/post-import-configuration.md)
**Relates to:** [ADR-0021](0021-terminology.md) (**D6 reserved the word and deferred the entity — this ADR answers the question it deferred**); [ADR-0017](0017-ownership-refinement.md) §3 (place-role deployment-targets, shipped as M15.6); [ADR-0016](0016-scoped-scan-requirement-policies.md) (a security domain is ambient, not a row); [ADR-0006](0006-fail-closed-on-missing-executor-binding-for-purpose.md) (fail-closed on a missing binding); [ADR-0007](0007-executor-binding-type-taxonomy.md) (the binding Type facet); [ADR-0022](0022-outpost-config-authority-split.md) (the authority-split pattern); [GLOSSARY.md](../GLOSSARY.md) (**authoritative for vocabulary**); [service-component-model.md](../proposals/service-component-model.md)

## Context

ADR-0021 D6 reserved **stage** for one named deployment place, settled its `<domain>[-<location>]-<env>` grammar, and then deferred the entity explicitly:

> **Rejected: introduce a `stage` entity now.** Rejected as premature. D6 reserves the *word* and settles its grammar; building the entity is a separate design question (**what a stage owns, how it relates to `deployment-target`, and whether it subsumes the missing `environment` concept**).

Those three sub-questions came due on 2026-08-01, when the first post-import census of the homelab found **51 of 69 components with no release pipeline and no tooling capable of giving them one**.

### The cross-product gap

`getExecutorBinding` (`apps/server/src/coordination/executor-bindings-repo.ts:111`) is a flat lookup on `(org_id, target_object_id, type)` — one object id, no walk-up, no second dimension. `change_wave_targets` likewise carries a single `target_object_id`.

But a binding must answer two independent questions: **which execution system to call** (a function of *where*) and **which application inside it** (a function of *what*). The homelab estate is a grid — 13 logical apps across 2 places, 18 filled cells, 15 distinct application names.

**A one-column key cannot address a two-dimensional grid**, so one axis must be materialised as extra objects. The estate materialised the component axis: `agentkit-keycloak` and `agentkit-keycloak-prod` are two component objects carrying **identical `external_ref`s**, differing only in which Argo CD they point at. That is a place wearing a component costume, and it is why nothing can attach a pipeline to a component — a pipeline over such an estate must enumerate all 18 components, so a webhook-created change (which targets exactly one component; 277 of 281 measured) can never inherit one.

### Why the prior rulings did not settle it

Two accepted documents already say "no new object type" for something adjacent, and **neither is disturbed by this ADR**:

- **ADR-0017 §3** rejected a `region` object type, ruling that "a region is a deploy-target" with per-region bindings. Its case is **one application across N regions** — a 1×N grid, where the region target *uniquely is* the pair and a flat key works perfectly. That ruling stands; M15.6's shipped view, deploy gate and scope guard are untouched here.
- **service-component-model.md** resolved infra "shared across a subset of components — the agentkit gamma env; prod is a separate set" as a `deployment-target` concern, no new type. True, and it does not address how one *component* reaches both.

Both are **under-determined for the cross product**, not wrong. ADR-0021's deferral is the honest record that the question remained open.

### The constraint that decided the object model

`JournalEntryKindSchema` (`packages/schemas/src/federation.ts:43`) admits exactly nine entry kinds: `object_upsert`, `object_tombstone`, `relationship_upsert`, `relationship_tombstone`, `change_status`, `policy_upsert`, `approval_evidence`, `audit_segment`, `key_rotation`.

**None is an executor binding.** A model that stored "this component runs at this place" only as columns on `executor_bindings` could never cross a federation boundary — the commander could not author or govern the estate topology, and every outpost would declare its own locally. For a platform whose charter is federated coordination, that is disqualifying rather than a trade-off. This is the same structural fact ADR-0022 built its authority split on.

## Decision

### D1. There will be **no `stage` entity**. A stage name is **derived**.

Answering ADR-0021's three sub-questions in order:

- **What does a stage own?** Nothing — it is not a row. A stage is a *name*, computed as `<origin domain>-[<region>-]<environment>`.
- **How does it relate to `deployment-target`?** It **is** one. A place-role `deployment-target` carries ADR-0017 §3's `environment` (required) and `region` (optional) properties; those are precisely the segments the grammar needs. A separate type would carry identical fields while working code already keys on the existing one.
- **Does it subsume `environment`?** **No.** `environment` remains a property on the place-role target and is the last segment of the derived name. The missing `environment` entity stays missing — it now has a de facto home, which is a smaller claim than subsumption and the honest one.

The domain segment is read from the object's **`origin_domain_id`**, never from the local instance — otherwise a replicated target derives `commercial-prod` at the commander and `govcloud-prod` at an outpost, one object with two names. It is stored nowhere, because per ADR-0016 a security domain is **ambient**: *"a partition is ambient… it is not modelled as a row,"* and an instance lives in exactly one.

**Not every deployment-target is a stage.** Only those carrying `environment` derive a name — the same membership convention `regional-executors.ts` already uses to leave plain targets alone.

### D2. The (component × place) pair is a **first-class object type**.

Not a second dimension on `executor_bindings`, for two reasons:

1. **It must federate** (see Context). An object journals via `object_upsert`; a binding column cannot journal at all.
2. **A binding attached to the pair needs no schema change.** `UNIQUE (org_id, target_object_id, type)` becomes exactly right — one pair, one `configuration` binding — so `executor_bindings` is not migrated, `change_wave_targets` keeps its single target column, and the **43 non-test files** referencing `targetObjectId` (including `reconcile.ts`, `rollback.ts`, `gates.ts` and `campaign-reconcile.ts`) are untouched. Threading a second dimension through those is the largest call-site census in the codebase, in the precise place BUILD_AND_TEST.md §4.4's convention exists because we have been bitten four times.

The pair also already carries state. `change_wave_targets` holds per-row `executor_ref`, `prior_state_ref`, `observed_state`, `status` and `attempt` — every one a fact about *this component at this place*. They work today only because the component-per-env duplication makes `target_object_id` accidentally unique per pair. A thing that has state needs identity.

### D3. The word is **`placement`**.

Reserved vocabulary, defined in [GLOSSARY.md](../GLOSSARY.md). Named `<component>@<deployment-target>`, unique on `(org_id, component, deployment_target)`.

`instance` — the owner's first phrasing, and the most natural English for it — is **reserved** for one running deployment of the SCP binary, the term the whole federation model rests on. `placement` is unclaimed as a defined term; the eleven bare uses in-tree are generic English about code location and evidence storage, plus one adjacent sense in `import-repo.ts:163` where "LOCAL PLACEMENT" means an object's containment parent. The glossary entry disambiguates all of them.

## Alternatives considered

- **A `stage` object type (proposal rev 3) — rejected.** It would carry identical fields to a place-role `deployment-target` (`environment` + optional `region`, domain ambient) while ADR-0017's shipped code keys on the latter. A second type holding the same data as an existing one is duplication, not clarification. Cost paid: `deployment-target` stays overloaded — the glossary already calls it "the most overloaded object type in the model" — and grammar validation lives in a convention rather than at a type boundary. Accepted knowingly.
- **A second dimension on `executor_bindings` (proposal rev 2) — rejected.** Technically workable (`UNIQUE NULLS NOT DISTINCT` on PG16 handles the nullable-column trap), but it cannot federate, and it threads a dimension through 43 files including the most delicate in the system.
- **An attributed relationship, `component -deployed_at-> deployment-target`, with the binding keyed on the pair — rejected, though it is the most conceptually correct.** Edges here are genuinely first-class (`relationships` carries `properties`, `labels`, `revision`, `content_hash`), principle 2 names them explicitly, and node-ifying a relationship is a known modelling error. It fails on architecture, not concept: **nothing in the schema can reference a relationship id** — no foreign key targets `relationships`, and bindings, wave targets, gates and policies all key on objects. Adopting it means teaching every one of those to reference an edge, which is rev 2's problem and more. Recorded here because it is the strongest argument against D2 and should not have to be rediscovered.
- **`instance` as the word — rejected.** Reserved; see D3.
- **Keep the env-suffixed duplication — rejected.** It costs the same N×M object growth as D2 while giving the pair no identity, leaves component-level facts (source mappings, owner, dependencies, blast radius) duplicated per place, leaves the graph unable to relate `agentkit-keycloak` to `agentkit-keycloak-prod`, and keeps the 51-component pipeline gap permanently open.

## Consequences

**Positive**

- ADR-0021's deferred question is closed in both directions: the word stays reserved *and* what fills it is settled, so no future reader has to re-open it.
- One new object type and one new cardinality value (`many_to_one`, see the context doc) is the entire model cost. No migration to `executor_bindings`, no change to `change_wave_targets`' shape.
- A pipeline becomes reusable: one topology over places serves every component, instead of one bespoke topology enumerating 18 components.
- The estate shrinks — 18 env-scoped components become 13 — and component-level facts stop being carried twice.
- The estate topology becomes federable, so a commander can declare and govern where software runs.

**Costs / honesty**

- **`deployment-target` gets more overloaded, not less.** D1 adds a third role to a type the glossary already flags as the most overloaded in the model. The alternative was a fourth place-ish type; this was judged the lesser harm, but it is a real cost and a future ADR may revisit it.
- **Stage names are a derived join, not a stored value** — over `origin_domain_id`, `region` and `environment`. Three prerequisites follow, none optional: a real domain label must exist (`federation_self.name` is currently the org UUID, so every name would derive as a UUID); the domain segment must come from `origin_domain_id`; and `(origin domain, region, environment)` must be unique, since two prod targets with no region would otherwise derive the same name. The grammar cannot be enforced at a type boundary as a consequence.
- **Placements are declared, never inferred** — deliberately, because name-based pairing is unsafe here: `agentkit-bootstrap` / `agentkit-db-bootstrap-prod` and `agentkit-selfhost` / `agentkit-hosted` look like pairs and are different Argo CD applications. The cost is that an undeclared pair leaves its component's gap open until a human acts.
- **Object count grows with the cross product.** ~18 placements on the homelab today. This is the axis that scales worst as stages multiply, and it is the point at which a composite key would age better.
- **The migration converting env pairs is irreversible**, and its failure mode — a swapped `external_ref` — is silent. The context doc's §6 requires re-resolving both bindings against both Argo CD systems between each conversion for exactly this reason.
- **Nothing here is built.** This ADR reserves vocabulary and settles the model; `placement` does not exist in the schema, and the glossary entry says so.
