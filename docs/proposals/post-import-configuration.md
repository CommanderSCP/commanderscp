# Proposal: post-import configuration — placements, pipelines, readiness, and the self-outpost

**Status:** Draft rev 4 — proposed 2026-08-01, revised three times the same day through owner review. All open questions are closed; this revision is ready for review as a whole. Rev 1 §2, rev 2 §4 and rev 3 §3 are withdrawn (see §2).
**Relates to:** [GLOSSARY.md](../GLOSSARY.md) (**authoritative for vocabulary**), [ADR-0021](../adr/0021-terminology.md) (D6 stage grammar; this proposal answers its deferred stage-entity question), [ADR-0016](../adr/0016-scoped-scan-requirement-policies.md) (security domain is ambient), [ADR-0017](../adr/0017-ownership-refinement.md) §3 (place-role deployment-targets, M15.6), [ADR-0006](../adr/0006-fail-closed-on-missing-executor-binding-for-purpose.md), [ADR-0007](../adr/0007-executor-binding-type-taxonomy.md), [ADR-0022](../adr/0022-outpost-config-authority-split.md), [organize-after.md](organize-after.md), [service-component-model.md](service-component-model.md), [PROJECT_CHARTER.md](../../PROJECT_CHARTER.md) principles 2, 3, 5, 6.

---

## 0. Owner decisions

| | Decision |
|---|---|
| **D1** | ~~Fix the executor-binding uniqueness constraint.~~ Withdrawn — superseded by D9. |
| **D2** | The multi-target topology conflict is not real — **dropped**, evidence in §1.4. |
| **D3** | A commander acting in an outpost capacity **is** an outpost and must be shown as one — exempt from polling and poking itself. |
| **D4** | Pipeline inheritance walks **past** the owning service. |
| **D5** | The readiness marker flags items **awaiting manual resolution by a user**, not "acknowledged, stop counting". |
| **D6** | No backfill. Applies only to changes created afterward. |
| **D7** | Convert env pairs **one at a time with a verification pass between**. |
| **D8** | A component spans multiple places via multiple **placements**, declared manually in the UI or IaC, **never inferred from names**. |
| **D9** | The (component × place) pair gets its **own object type**, rather than a second dimension on `executor_bindings`. |
| **D10** | **No `stage` entity.** A placement points at a `deployment-target`; the stage *name* is derived. |
| **D11** | Add **`many_to_one`** to `assertCardinality` rather than pointing the pipeline edge backwards. |
| **D12** | ~~Pipeline resolution mirrors `containmentChain`.~~ **AMENDED by D15** — the walk disclaims providing a single winner across kinds, so it never offered what resolution needs. |
| **D15** | Resolution uses a **dedicated three-rung walk** (component → service → org root), not `containmentChain`, which is left unchanged. |
| **D16** | **No `stages` wave key** — it was vestigial from rev 2's withdrawn `stage` entity. Waves name deployment-targets via `targets`; the wave schema gains `additionalProperties: false`. |
| **D17** | A `placement` stores its endpoints as **validated properties** (source of truth, uniquely indexed) **plus derived edges** written in the same transaction, and refuses the generic `/objects/placement` door. |
| **D13** | **Do not rename** the six `-prod`-suffixed components; the URN cannot be rewritten. |
| **D14** | The word is **`placement`**. |

---

## Why now

`organize-after.md` shipped assign and merge (M12 P5b/P5d). On 2026-08-01 they ran against the homelab for the first time, closing the gap they were built for and exposing the rest.

| Gap, per component | Before | After assign |
|---|---:|---:|
| No service (`contains` edge) | 45 | **2** |
| No source mapping | 45 | **45** |
| No release topology | 51 | **51** |
| No executor binding | 8 | **8** |

The 51 have no tooling, and the cause is structural: **the graph cannot say that one piece of software runs in more than one place.**

---

## 1. What we verified

Grounded against the running homelab instance and the code at `55ffe2d`.

### 1.1 A topology orders a change's targets; it cannot supply them

`plan-compiler.ts:133` — `if (!targetSet.has(t)) return { ok: false, error: "unknown_target", target: t }`.

### 1.2 The same software is modelled as two unrelated components

Keycloak runs in both clusters. The graph holds two component objects:

```
agentkit-keycloak       hosted_on gamma  → homelab-argo  ref: agentkit-keycloak
agentkit-keycloak-prod  hosted_on prod   → argocd-prod   ref: agentkit-keycloak
```

**Both carry the same `external_ref`.** Only the Argo CD server differs — the graph is already saying this is one piece of software in two places while the object model insists on two components.

### 1.3 The cross-product gap — why it was modelled that way

`getExecutorBinding` (`executor-bindings-repo.ts:111`) is a flat lookup on `(org_id, target_object_id, type)` — one object id, no second dimension, no walk-up. `change_wave_targets` likewise has a single `target_object_id`.

But a binding must answer two independent questions: **which Argo CD server** (a function of *where*) and **which application inside it** (a function of *what*). The estate is a grid — 13 logical apps × 2 places, 18 filled cells, 15 distinct app names.

A one-column key cannot address a two-dimensional grid, so one axis must be materialised as extra objects. Choosing the component as the key means two components per app (what you have). Choosing the deployment-target means 13 targets per cluster, and "deployment-target" stops meaning a place.

**Why ADR-0017 §3 did not hit this.** Multiregion is one app across N regions — a 1×N grid, where the region target *uniquely is* the pair, so a flat key works. Its rejection of a "region object type" was correct and is not disturbed here. Likewise `service-component-model.md`'s ruling that gamma-vs-prod is a `deployment-target` concern is true as far as it goes; it does not say how one component reaches both. The prior rulings are **under-determined for the cross product**, not wrong — which is why ADR-0021 left the stage entity as an open design question rather than closing it.

### 1.4 Auto-created changes have exactly one target (D2's evidence)

`webhook-processor.ts:299` calls `proposeChange` with `targets: [match.componentObjectId]`. Measured:

```
 1 target  → 277 changes      2 targets → 1 change (rehearsal)      18 targets → 3 changes
```

A single-target change has nothing to disagree with.

> **Correction (2026-08-02).** Earlier revisions of this section said the processor calls
> `proposeChange` **once per matched mapping**, so that a push to a repository with 24 mappings
> produced 24 separate single-target changes. **That was wrong**, and the mechanism is materially
> different from what it described.
>
> `matchComponentForSource` (`coordination/correlation.ts`) returns **exactly one** component — it
> iterates mappings ordered by specificity, then oldest-first, and `return`s on the first match.
> One source event therefore produces **one** change, never a fan-out. Because a `path_pattern`
> mapping was skipped whenever the event carried no path — and nothing populated a path for a git
> push — every mapping on a monorepo was necessarily repo-only, all ranked equally, and the oldest
> won every event forever. On the homelab that meant **45 of 47 source mappings had never fired**,
> and 286 changes across four repositories had landed on exactly two components.
>
> The measured distribution above is unaffected, and **D2 stands more firmly, not less**: a single
> event cannot produce a multi-target change at all, so the conflict D2 drops could never arise on
> the automatic path.
>
> The routing defect itself is fixed separately (changed-path extraction, `paths` on the
> correlation hint); §7's `hasSourceMapping` readiness check is unchanged by it, but note that a
> mapping's *existence* is not evidence it can ever fire.

### 1.5 Consequence today

276 of 280 `change_plans` have `topology_object_id = NULL`, and 276 of 284 `change_waves` have an empty `name` — the single anonymous wave the toposort emits with no topology. The two topology objects have **zero relationships**.

Two silent hazards to fix alongside:

- `plan-service.ts:39-43` — `parseTopologyWaves` returns `undefined` when `document.waves` is not an array, so a malformed topology is **silently ignored** and compiles to one wave.
- `reconcile.ts:268-290` — if compilation throws, the change is **auto-cancelled** with the compiler message as its epitaph.

### 1.6 Bindings cannot cross a federation boundary

`JournalEntryKindSchema` admits exactly nine kinds — `object_upsert`, `object_tombstone`, `relationship_upsert`, `relationship_tombstone`, `change_status`, `policy_upsert`, `approval_evidence`, `audit_segment`, `key_rotation`. **None is a binding.**

This is decisive for D9. A model that stored "keycloak runs at prod" only as columns on `executor_bindings` could never federate that fact — the commander could not author or govern the estate topology, breaking the invariant that the commander holds global config while execution-system access stays with the outpost.

### 1.7 The federation role is advisory and gates nothing

`federation/self-repo.ts:80-92` documents `role` as *"advisory metadata for the CLI/UI, not a precondition"*. Its only product consumer is a banner at `federation-status.tsx:81`. `outposts.tsx:508` filters `federation_peers` for `role IN ('outpost','retrans')`, so **self is structurally never a candidate row**. The one real role gate is `app.ts:263`, reading the env var `SCP_FEDERATION_ROLE`.

---

## 2. What earlier revisions got wrong

**Rev 1** proposed attaching a topology to a component so webhook changes would inherit a pipeline. A webhook change targets one component, the real topology names 18, and `plan-compiler.ts:133` rejects any topology target absent from the change's targets — it would fail to compile, not inherit.

**Rev 2** proposed a nullable `stage_object_id` on `executor_bindings` with `UNIQUE NULLS NOT DISTINCT`. It works, but §1.6 kills it: bindings cannot federate, so the estate topology would be unjournalable. It also threads a second dimension through **43 non-test files** including `reconcile.ts`, `rollback.ts`, `gates.ts` and `campaign-reconcile.ts` — the largest and most dangerous call-site census in the codebase.

**Rev 3** additionally proposed a `stage` object type. Withdrawn per D10: a stage and a place-role deployment-target would carry *identical* fields (`environment` plus optional `region`, domain ambient), and working code already keys on the latter.

---

## 3. Placements (D8, D9, D14)

**A placement is one component at one deployment-target.** `agentkit-keycloak@prod (DOKS hosted)` and `agentkit-keycloak@gamma (self-host canary)` are two placements of one `agentkit-keycloak` component.

What lives where — this split is the whole point:

| On the **component** (once) | On each **placement** |
|---|---|
| service membership (`contains`) | the executor binding |
| owner, dependencies, blast radius | the Argo CD `external_ref` |
| source mappings | the deployment-target it serves |
| the pipeline it releases via | its own execution status |

**Identity (D17).** A new builtin object type `placement`, created through a typed route requiring both endpoints — and the generic `POST /objects/placement` door is **refused outright**, modelled on how `outpost` solved the same problem. Without that refusal the pairing rule is advisory rather than enforced.

The endpoints are stored as **validated object properties**, which are the source of truth, with a partial unique expression index over both. Edges to the component and the deployment-target are **derived** from those properties and written in the SAME transaction, so graph traversal and blast-radius still see the pair.

This shape is one fact in two places, and that cost is deliberate. The original text here said only "a unique index on `(org_id, component, deployment_target)`" without saying whether the endpoints were properties or relationships — and it matters, because **nothing can uniquely index across two `relationships` rows**. That is the same constraint ADR-0026 used to reject the attributed-relationship alternative, so specifying the endpoints as edges would have contradicted the ADR's own reasoning. Properties are the only form a single index can express; the edges exist so the graph is not blind to the pair.

**The index is load-bearing, not belt-and-braces.** The `many_to_one` work proved the SELECT-then-INSERT race is real: with the app-level check disabled, only the index held. The same applies here.

**URN separator.** `<component>@<deployment-target>` cannot be derived naively — `slugify` maps `[^a-z0-9]+` to `-` and collapses runs, so `keycloak@commercial-prod` becomes `keycloak-commercial-prod` and collides with a literal component of that name. D8 forbids relying on name-based uniqueness anyway (the index is the guarantee), but the URN must not be quietly ambiguous.

**`executor_bindings` does not change.** Its `target_object_id` points at a placement, and `UNIQUE (org_id, target_object_id, type)` is then exactly right: one placement, one `configuration` binding. No migration on that table.

**`change_wave_targets.target_object_id` points at a placement** — "deploy keycloak at prod" — which is what the row has always meant. Note its existing per-row `executor_ref`, `prior_state_ref`, `observed_state`, `status` and `attempt` columns are all facts about *this component at this place*; they work today only because the component-per-env duplication makes `target_object_id` accidentally unique per pair. Placements give those columns a durable subject.

**Placements are declared, never inferred (D8).** Nothing may pair components by name. §1.2's own data shows why: `agentkit-bootstrap` and `agentkit-db-bootstrap-prod` look like a pair and are **different Argo CD applications**, as are `agentkit-selfhost` and `agentkit-hosted`. Declaration happens in the UI or IaC; an undeclared component surfaces as a readiness gap (§7).

**Vocabulary — landed.** `placement` is reserved by [ADR-0026](../adr/0026-placements-and-derived-stage-names.md) and defined in [GLOSSARY.md](../GLOSSARY.md), whose entry disambiguates it from *instance* (one running deployment of the SCP binary), *stage* (the place alone), *deployment* (the per-environment event), *deployment target* (the place as an executor sees it), and the casual containment sense in `import-repo.ts:163`. ADR-0026 also answers the stage-entity question ADR-0021 deferred, and ADR-0021's rejected-alternatives section now points forward to it.

---

## 4. Stage names are derived (D10)

No `stage` entity. A place remains a `deployment-target` carrying ADR-0017's properties, and the grammar name is computed:

```
deployment-target "prod (DOKS hosted)"
  properties.environment = "prod"          ← operator sets this
  properties.region      = "nyc3"          ← optional
  origin_domain_id       = <trust domain>  ← the security domain it was authored in
                       ⇓
              stage name: commercial-nyc3-prod
```

The target keeps whatever display name reads well; nothing parses it. This reuses ADR-0017 §3's convention verbatim, including M15.6's shipped view, deploy gate and the scope guard that leaves plain non-place targets alone.

**The domain segment is free.** Per ADR-0016 via the glossary, a security domain is **ambient** — *"a partition is ambient… it is not modelled as a row"* — and an instance "lives in exactly **one**". So `<domain>` is never data a place carries.

**Three prerequisites, none optional:**

1. **A domain label must exist.** `federation_self.name` on the homelab is currently `019f577f-e911-…` — the org UUID, because the row was lazily minted rather than initialised. Every stage name would derive as a UUID. Fix: `scp federation init --name commercial`.
2. **The domain segment derives from the object's `origin_domain_id`, not the local instance.** Otherwise a replicated target derives `commercial-prod` at the commander and `govcloud-prod` at an outpost — one object, two names.
3. **Uniqueness on `(origin domain, region, environment)`.** Two prod targets with no region both derive `commercial-prod`. The grammar's answer is that peers are told apart by the location segment, so this must be enforced, not assumed.

Also required before placements can resolve anything: **the two existing targets carry neither `environment` nor `region`**, and prod's `domain` property is a *DNS* name (`agentkitproject.com`) — one of the six senses the glossary warns about, and not a security domain.

---

## 5. Pipelines over places

**Topology waves name deployment-targets:**

```json
{ "waves": [ { "name": "gamma", "mode": "parallel", "targets": ["<gamma-target-id>"] },
             { "name": "prod",  "mode": "parallel", "targets": ["<prod-target-id>"] } ] }
```

This is the shape `forge-gamma-then-prod` already uses. That object is rehearsal debris from 2026-07-12 and should be retired, but its *shape* was the sanctioned one all along.

**Compilation.** The change supplies components; the topology supplies ordered places; each wave's targets are the **placements** of those components at that wave's deployment-targets. A single-target change now yields a real multi-wave plan — what 277 of 281 changes need and none get.

**Participation needs no new mechanism.** A component with no placement at a wave's target simply contributes nothing to that wave. This is *not* the hazardous binding-existence filter: because a placement is declared (D8), its absence is a deliberate statement, while a placement that exists with **no binding** is a genuine misconfiguration that still fails closed per ADR-0006. The graph never guesses whether an absence was intended.

**Attachment and inheritance (D4, D11, D12).** A `releases_via` edge, `component → release-topology`, cardinality **`many_to_one`** — each component uses at most one pipeline; each pipeline serves many components.

`assertCardinality` (`relationships-repo.ts:56-79`) has no `many_to_one` today, but the from-side check it needs **already exists** as the second block used by `one_to_one`. Adding the value means running that block and skipping the to-side one, plus a partial unique index on `(org_id, from_id) WHERE type_id='releases_via' AND deleted_at IS NULL` as the race backstop — the mirror of migration `0022` for `contains`, needed for the same reason (the app-level check is read-committed with no row lock).

Resolution order (**amended by D15 — see below**):

1. the change's explicit `--topology` — always wins
2. the component's own `releases_via`
3. its owning service's, via the `contains` edge walked inbound
4. the org root's, via `getOrgRootObjectId`
5. else `null` — today's single anonymous wave

> **D15 (2026-08-02): resolution uses a DEDICATED three-rung walk, NOT `containmentChain`. D12 is amended and this paragraph corrects a wrong claim.**
>
> The original text said D12 "reuses the existing ladder rather than inventing one" and that the ladder "already encodes service-beats-domain precedence". **The second claim is false**, and the first rested on it.
>
> `containmentChain` (`graph/containment.ts`) walks two axes per hop — the `contains` edge *and* `domain_id` — and its own docblock states that when a component's `domain_id` differs from its service's, the two are "each exactly ONE hop from C and **TIE** … no ordering of these two routes is obviously 'correct'", followed by: *"DO NOT write code that assumes a strict org < domain < service < component ordering across DIFFERENT kinds"* and *"it WOULD become a real precedence bug the moment any code compares depth across differently-named policies to pick a single 'most specific' winner — if you are about to write that, fix this first."*
>
> "Take the nearest match" is precisely that code. The walk never offered a single winner across kinds, so reusing it could not have delivered what resolution needs.
>
> **Why the three rungs still reach the org.** The org root is reached *via the domain axis* — every object's `domain_id` points at the `organization` object — so dropping that axis would have dropped the org default with it. Rung 4 gets it directly instead, which preserves D4 ("walk past the service") and keeps the org default as a `releases_via` edge on the `organization` object. No settings table is needed, which `orgs` (`id, name, created_at`) could not have provided anyway.
>
> **Reachability, measured 2026-08-02.** On the live estate: 0 components whose `domain_id` differs from their service's, 0 `domain`-type objects, 1 distinct `domain_id`. The tie is unreachable there today — so this is not fixing a live break, it is declining to depend on an ordering the walk explicitly disclaims.
>
> `containmentChain` is deliberately left unchanged. Its hazard comment is now *more* true, not less: this was the code that was about to write that, and it chose not to. Modifying the walk would also have altered RBAC scope, policy resolution, freeze scope and approval scope — four security-relevant consumers — for a feature none of them needs.

**Resolution lives in `proposeChange`** (`changes-repo.ts:167-176`), not in `webhook-processor.ts`. Several paths create changes, and fixing the caller rather than the single decision point is the incomplete-call-site-census mistake this repo has hit four times (BUILD_AND_TEST.md §4.4). The resolved topology and the rung it came from belong on the change's Decision (principle 6).

---

## 6. Migrating the live estate

18 env-scoped components become **13**. Only five are true pairs, established by `external_ref`, never by name:

| Logical app | gamma component | prod component | Argo CD refs |
|---|---|---|---|
| keycloak | `agentkit-keycloak` | `agentkit-keycloak-prod` | **identical** |
| market | `agentkitmarket` | `agentkitmarket-prod` | **identical** |
| profile | `agentkitprofile` | `agentkitprofile-prod` | **identical** |
| auto | `agentkit-auto` | `agentkitauto-prod` | differ — `agentkit-auto` / `agentkitauto` |
| forge-web | `agentkit-forge-web` | `agentkitforge-web-prod` | differ |

**Not pairs:** `agentkit-bootstrap` / `agentkit-db-bootstrap-prod` and `agentkit-selfhost` / `agentkit-hosted-prod` are different Argo CD applications. Four more are prod-only: `agentkitgateway-prod`, `agentkitproject-site-prod`, `agentkit-sealed-secrets-prod`, `agentkit-umami-prod`. These eight need no conversion — each becomes a component with a single placement.

**The table is a suggestion shown to a human with both `external_ref`s as evidence, never an input to automation (D8).**

Sequence:

1. **Initialise the domain label** (`scp federation init --name commercial`) and add `environment` (+ `region`) to the two deployment-targets. Nothing derives a valid stage name until this lands (§4).
2. **Create a placement per existing component**, at the target implied by its current binding's execution system, and re-point the binding from the component to the placement. Mechanical and reversible; every component still resolves exactly one binding, so no coordination behaviour changes.
3. **Convert the five confirmed pairs, one at a time with a verification pass between (D7).** Each: re-declare the prod component's placement under the gamma component, move the binding, soft-delete the emptied component. Ordered lowest-risk first — the three whose refs are identical (keycloak, market, profile), then the two whose refs differ (auto, forge-web).

   **Verification between each.** Conversion is irreversible, so a pass that only checks it "succeeded" is worthless. Each must confirm: the surviving component has exactly two placements at the two distinct targets; each placement's binding `external_ref` is **unchanged**; the absorbed component is soft-deleted with no live `contains` edge; and `scp discovery run` against **both** Argo CD systems still resolves each binding to its real application. The last catches a swapped `external_ref` — the failure mode that would silently point a place at the wrong cluster's app.

4. **Author one `gamma-then-prod` topology** over the two deployment-targets and attach it to the `agentkit` service. Every component inherits it via the containment walk; single-placement components contribute nothing to the wave they have no placement at (§5).
5. **Retire** `agentkit-gamma-then-prod` and `forge-gamma-then-prod` once no in-flight plan references them. Compiled plans snapshot `topology_document` (`plan-service.ts:96-109`), so retiring the object cannot disturb history.

Per D6 there is **no backfill** — the 276 single-wave plans stay as they are.

**A naming rule falls out of D13.** `deriveUrn` runs only at create (`objects-repo.ts:171`) and `updateObject` never recomputes it, so a rename leaves the URN frozen — renaming `agentkitgateway-prod` would give it a clean name and a permanently stale URN. The six keep their names. Going forward, **a new component must never carry an environment in its name**, because the URN preserves it forever. Revisit only if one of the six gains a second placement, at which point the name is actively wrong and delete-and-recreate is justified by a real change rather than tidiness.

---

## 7. Readiness and the manual-resolution marker (D5)

### 7.1 The computation

Derived per component, **no new table**:

| Check | Source | Meaning if absent |
|---|---|---|
| `hasService` | `contains` edge inbound | invisible on every service board; no RBAC/policy/freeze scope |
| `hasPlacement` | placements for this component | it exists nowhere; nothing can deploy it |
| `hasExecutorBinding` | binding per placement | that placement cannot execute |
| `hasSourceMapping` | `source_mappings` by component | no change will ever be created from a push |
| `hasPipeline` | `releases_via`, own or inherited | releases compile to one anonymous wave |

Exposed as `GET /v1/components/{idOrUrn}/readiness` and aggregated at `GET /v1/readiness`, then SDK → CLI → UI per principle 3.

On the homelab today:

```
                 service   binding   source_mapping
agentkit-auto      yes       yes         yes
homelab-loki       yes       yes         NO
homelab-pihole     yes       yes         NO
```

### 7.2 The marker flags work, not permission to ignore it

Per D5 the marker means **awaiting manual resolution by a user**. Resolution is one of two human acts, and **both** clear it:

- **wire it up** — declare the placement, create the source mapping, attach the pipeline; or
- **declare it not-for-coordination** — an explicit, recorded statement that this component is catalogue-only

The second is not a way of ignoring the first. It is a decision, made by a person, checked into git like any other configuration and visible in the audit trail. The distinction that matters: **an unresolved gap and a resolved-as-not-coordinated component must not look the same**, because only one of them is work.

Granularity: **per service, with a per-component override.** The 43 `homelab-platform` components are one decision, not 43.

**The 8 unbound components are already answered by their own data** — six are `kind: library` (build-time, consumed not deployed) and two are `kind: datastore` (external managed). None is deployable, so none should have a placement or a binding; all eight resolve as not-for-coordination.

Deliberately **not** proposed: notifications. These are static configuration gaps, not events.

---

## 8. IaC coverage

The manifest carries exactly two collections: `objects` and `relationships`.

| Configuration | Today | After |
|---|---|---|
| Services, components, `contains` | yes | yes |
| Release topologies, deployment-targets | yes | yes |
| **Placements** (§3) | n/a | **yes** — a graph object, free |
| **Pipeline attachment** (§5) | no | **yes** — a relationship, free |
| **Source mappings** | **no** | needs C1 |
| **Executor bindings** | **no** | needs C1 |

D8 makes placement declaration in IaC a **requirement** — "declared in the UI or IaC" is only true if IaC can express it. Placements being graph objects delivers that for free.

**C1 — extend the manifest** with `sourceMappings` and `executorBindings` collections. **Recommended.** Principle 3 is a parity guarantee, and these two are exactly what a user must reproduce when standing up a second instance (principle 5).

Ordering within one plan diff: deployment-targets → placements → bindings.

---

## 9. The self-outpost (D3)

**9.1 Make the role visible.** `federation_self.role` is advisory and gates nothing (§1.7). Keep it, require designation at bootstrap — §4's prerequisite 1 forces this anyway — and surface it where an operator sees it. Nothing should begin *gating* on it; `SCP_FEDERATION_ROLE` already does the one piece of real gating, and two disagreeing role sources is a bug generator.

**9.2 Synthesise a self row.** Per D3 a commander acting in an outpost capacity **is** an outpost and appears in the list, visually distinct, **exempt from polling and poking itself**.

That exemption is a correctness requirement. The federation-sync loop dials a peer's `base_url`; a self row entering the peer set would dial its own — a self-loop syncing a journal against itself. The exemption must live in the **data**, not only the rendering: the self row is synthesised for display and must never be inserted into `federation_peers`, or every loop that iterates peers inherits the bug.

ADR-0022 constrains the rest. Authority is split between a `federation_peers` row (transport, keys, sync state) and an `outpost` graph object (declared config, trust tier), and **self has neither**. The self row must **omit** fields that exist only for a real peer — last pull, sync cadence, poke mode, journal cursor, verification key — rather than render them blank. A zeroed sync state for self is precisely the dishonesty `outposts-honesty.test.tsx` exists to catch.

The self row carries: domain name and id from `federation_self`, the declared role, the places it coordinates directly, and an explicit "this domain — not a paired peer" marker.

---

## 10. Charter check

| Principle | Effect |
|---|---|
| 1 — coordination, not execution | untouched; no new execution verbs |
| 2 — graph-native | `placement` is a registered object type, attachment is a relationship, readiness is computed. **No schema change to `executor_bindings`**; `change_wave_targets` keeps its single target column. |
| 3 — API-first parity | placements, attachment and readiness ship API → SDK → CLI → IaC → UI; §8 closes an existing hole and D8 makes it mandatory |
| 4 — PostgreSQL only | no new stateful dependency |
| 5 — air-gap | §8 serves reproducing an instance offline; §1.6 keeps the estate topology journalable |
| 6 — explainability | resolved topology and its rung recorded on the change's Decision |
| 7 — priorities | Simplicity is the pressure point: one new object type and one new cardinality value. Against that, the estate loses 5 duplicate components, `executor_bindings` needs no migration, 43 files stay untouched, and the participation mechanism disappears. Judged net-positive. |

---

## 11. Implementation notes carried forward

Not open questions — decided items that must not be lost:

- `many_to_one` needs the seed, the schema types, and any UI rendering cardinality to agree; `cardinality` is plain `text` with no CHECK constraint.
- The `releases_via` race backstop index mirrors `0022`, on `from_id` rather than `to_id`.
- §4's three prerequisites gate everything else in the migration.
- Fix the two silent hazards in §1.5 alongside: a malformed topology document must fail loudly, and an auto-cancelled change must be distinguishable from a user-cancelled one.
- ~~A wave carrying both `stages` and `targets` keys must be rejected outright.~~ **D16: there is no `stages` key.** It was vestigial from rev 2, which proposed a `stage` ENTITY; D10 withdrew that, and under this revision a wave names deployment-targets via `targets` alone. §5 only ever showed `targets`; the rule described a key nothing defines.
  The real gap this rule was groping at is narrower and worse: migration `0007`'s wave schema requires `["mode","targets"]`, so a `stages`-only wave is *already* rejected by Ajv — but a wave carrying **unknown extra keys is accepted**, because the schema sets no `additionalProperties: false`. Adding that closes the actual hole and generalises the intent. Check the two live topologies for stray wave keys before tightening, so the migration cannot reject existing data.
  Authoring waves by derived stage NAME instead of target UUID is a genuinely better operator experience, but it depends on §4's stage-name derivation prerequisites, none of which are met. Deferred, not rejected.
