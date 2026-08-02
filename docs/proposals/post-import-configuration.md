# Proposal: post-import configuration — stages, stage-shaped pipelines, readiness, and the self-outpost

**Status:** Draft rev 2 — proposed 2026-08-01, revised the same day after owner review. Rev 1's §2 was withdrawn (see §2.0).
**Relates to:** [GLOSSARY.md](../GLOSSARY.md) (**authoritative** — its `stage` and `wave` entries govern §3), [ADR-0021](../adr/0021-terminology.md) (D6, the stage grammar), [organize-after.md](organize-after.md) (M12 P5 — assign/merge, the half that shipped), [service-component-model.md](service-component-model.md), [ADR-0006](../adr/0006-fail-closed-on-missing-executor-binding-for-purpose.md) (fail-closed on a missing binding), [ADR-0007](../adr/0007-executor-binding-type-taxonomy.md) (the binding Type facet), [ADR-0011](../adr/0011-universal-outpost-validation.md), [ADR-0022](../adr/0022-outpost-config-authority-split.md), [PROJECT_CHARTER.md](../../PROJECT_CHARTER.md) principles 2 (graph-native), 3 (API-first parity), 6 (explainability).

---

## 0. Owner decisions recorded (2026-08-01)

| | Decision |
|---|---|
| **D1** | **Fix the executor-binding uniqueness constraint.** Pipelines become stage-shaped, not component-shaped. Supersedes rev 1 §2 entirely. |
| **D2** | The multi-target topology conflict is not a real problem — **dropped**, evidence in §1.4. |
| **D3** | A commander acting in an outpost capacity **is** an outpost and must be shown as one — exempt from polling and poking itself. |
| **D4** | Topology inheritance walks **past** the owning service. |
| **D5** | The readiness marker flags items **awaiting manual resolution by a user**. It is not an "acknowledged, stop counting" flag. |
| **D6** | No backfill. Applies only to changes created afterward. |
| **D7** | Merge the env pairs **one at a time with a verification pass between**, not in one batch (§6 step 3). |

---

## Why now

`organize-after.md` predicted the post-import problem and shipped one half: an imported orphan can be assigned to a service (`scp component assign`, M12 P5b) or merged (P5d). On 2026-08-01 those ran against the homelab for the first time. The result closed the gap they were built for and exposed the rest.

| Gap, per component | Before | After assign |
|---|---:|---:|
| No service (`contains` edge) | 45 | **2** |
| No source mapping | 45 | **45** |
| No release topology | 51 | **51** |
| No executor binding | 8 | **8** |

The 51 have no tooling, and the reason is structural rather than a missing feature: **the graph has no word for the place a release lands.** The glossary reserved one — `stage` — and states plainly that no such entity exists yet. Everything below follows from giving it a home.

---

## 1. What we verified

Grounded against the running homelab instance and the code at `55ffe2d`. Every claim traced to `file:line` or a query.

### 1.1 A topology orders a change's targets; it cannot supply them

`plan-compiler.ts:133`:

```js
if (!targetSet.has(t)) return { ok: false, error: "unknown_target", target: t };
```

Every target a topology names **must already be in the change's target set**. A topology is an ordering template over targets the change already has.

### 1.2 The two live topologies use different units, and one is rehearsal debris

| Topology | Created | Waves name | Real? |
|---|---|---|---|
| `forge-gamma-then-prod` | 2026-07-12 19:11 | 2 **deployment-targets** | No — left from the fake-executor rehearsal, unused since |
| `agentkit-gamma-then-prod` | 2026-07-17 16:44 | 18 **components** | Yes — the only real one |

There is exactly one real pipeline in the estate, and it is expressed over components.

### 1.3 Why it is expressed over components — the root cause

`agentkit-gamma-then-prod` must name 18 components because gamma and prod are modelled as **separate component objects**: `agentkit-auto` and `agentkitauto-prod`, `agentkitmarket` and `agentkitmarket-prod`, and so on.

That pairing is not a modelling preference. `executor_bindings` carries:

```
UNIQUE (org_id, target_object_id, type)      -- executor_bindings_org_target_type_key
```

One component can hold **at most one `configuration` binding**. A single `agentkit-auto` cannot be bound to both the homelab Argo CD (`homelab-argo`) and the prod Argo CD (`argocd-prod`). **The env-suffixed component pairs exist to work around this constraint** — they are stages wearing a component costume, and `agentkitauto-prod` names a *place*, not a *thing*.

This single fact shapes the rest of the proposal.

### 1.4 Auto-created changes have exactly one target (D2's evidence)

`webhook-processor.ts:299` calls `proposeChange` once per matched source mapping, with `targets: [match.componentObjectId]`. Measured distribution of targets per plan:

```
 1 target  → 277 changes
 2 targets →   1 change    (the 2026-07-12 rehearsal)
18 targets →   3 changes   (the real promotions)
```

A push to `AgentKitProject/agentkit` matches 24 mappings and creates **24 separate single-target changes**. A single-target change has nothing to disagree with, so the multi-target conflict raised in rev 1 cannot arise on the automatic path. **Dropped per D2.**

### 1.5 Consequence today

276 of 280 `change_plans` rows have `topology_object_id = NULL`, and 276 of 284 `change_waves` rows have an empty `name` — the single anonymous wave `plan-compiler.ts` emits by toposort when no topology is supplied. The two topology objects have **zero relationships** and are reachable only by a human typing `--topology`.

Two silent hazards worth fixing alongside:

- `plan-service.ts:39-43` — `parseTopologyWaves` returns `undefined` when `document.waves` is not an array. A malformed topology is **silently ignored** and compiles to a single wave, indistinguishable from having no topology at all.
- `reconcile.ts:268-290` — if compilation throws, the change is **auto-cancelled** with the compiler message as its epitaph. 9 of 280 changes are `cancelled`; whether any died this way is not distinguishable from outside.

### 1.6 The federation role is advisory and gates nothing

- `federation/self-repo.ts:80-92` documents `role` as *"advisory metadata for the CLI/UI, not a precondition"*.
- Its only product consumer is a banner at `federation-status.tsx:81`.
- `getFederationStatus` (`federation/status-repo.ts:60-140`) reads `federation_self` only for `domainId`/`name`; it never filters on `role`.
- `outposts.tsx:508` builds the list as `peers.filter(isOutpostPeer)`, where `isOutpostPeer` (`outposts.tsx:42`) tests `["outpost","retrans"].includes(status.peer.role)`. **Self is structurally never a candidate row.**
- The one real role gate is `app.ts:263` (`if (deps.config.federationRole !== "retrans")`), reading the install-time env var `SCP_FEDERATION_ROLE`, *not* `federation_self.role`.

---

## 2.0 What rev 1 got wrong

Rev 1 proposed a `releases` relationship attaching a topology to a component, so webhook-created changes would inherit a pipeline. **That cannot work.** A webhook change targets one component (§1.4); `agentkit-gamma-then-prod` names 18; `plan-compiler.ts:133` rejects any topology target absent from the change's targets. The change would fail to compile with `unknown_target` rather than inherit anything.

The error was treating "which pipeline does this component use?" as the question. With gamma and prod modelled as different components, a pipeline is inherently multi-component and no per-component edge can express it. The real question is what a pipeline is expressed *over* — which the glossary already answered.

---

## 3. Stages become first-class

The [glossary](../GLOSSARY.md) reserves the vocabulary and names the gap:

> **stage** | **Reserved:** one named deployment **place**, spelled `<domain>[-<location>]-<env>`. **No such entity exists yet**

> **wave** | One ordered step of a compiled plan — the **set of one-or-more stages** advanced at once

> **A stage is a place; a wave is a step.** … **a wave contains one or more stages.**

A wave containing stages is exactly the model D1 asks for. Nothing here is invented; this is implementation of a decided vocabulary.

**Proposed:** a new builtin object type `stage`, whose `name` obeys the ADR-0021 D6 grammar — `<domain>[-<location>]-<env>`, lowercase, fixed segment order, **every segment value hyphen-free**. The grammar is parsed by segment count, so `us-east` is invalid; use `useast`. Validation belongs in the type's `property_schema` and the typed create route, because a name that cannot be parsed by segment count is unrecoverable later.

For the homelab that is two stages — `commercial-gamma` and `commercial-prod`. No location segment: the glossary says to include it only when telling geographic peers apart, and there is one region.

**Stage versus deployment-target.** Not the same, and both survive. The glossary is explicit that a deployment-target "may or may not represent an environment" — it models a concrete cluster or host. A stage is the *named place* in the release grammar. Proposed: a stage relates to one or more deployment-targets, so `commercial-prod` points at `prod (DOKS hosted)`. See Q3 on which edge.

---

## 4. The binding constraint fix (D1)

**Today:** `UNIQUE (org_id, target_object_id, type)` — one binding per (component, type).

**Proposed:** `UNIQUE (org_id, target_object_id, stage_object_id, type)`, via a new nullable `stage_object_id` column on `executor_bindings`.

`stage_object_id IS NULL` means **stage-agnostic** — the binding applies wherever the component is released. Every existing row migrates to `NULL` unchanged, so this is expand-only and no current behaviour shifts on the migration itself.

**One detail that must not be missed.** Postgres treats `NULL`s as distinct in a unique constraint by default, so a nullable column would permit unlimited stage-agnostic duplicates — silently removing the protection ADR-0006 depends on. On PostgreSQL 16 the fix is `UNIQUE NULLS NOT DISTINCT`, available since PG15 and usable directly given charter principle 4 pins PG16. Without it this migration is a regression, not a feature.

**Resolution order** when reconcile resolves a binding for (component, stage, type):

1. the binding for that exact `(component, stage, type)`
2. else the stage-agnostic binding `(component, NULL, type)`
3. else no binding — ADR-0006's fail-closed path, unchanged

Step 2 preserves today's semantics exactly for every component that never gains a stage-scoped binding.

**`change_wave_targets` gains `stage_object_id` too.** A wave target becomes the pair (component, stage) — "deploy `agentkit-auto` at `commercial-prod`" — which is what the row has always meant, with the stage previously smuggled into the component identity. `status` is already plain text with no enum or check constraint, and this column is additive, so the migration is expand-only.

---

## 5. Pipelines over stages

**Topology documents name stages in their waves**, not components:

```json
{ "waves": [ { "name": "gamma", "mode": "parallel", "stages": ["<commercial-gamma-id>"] },
             { "name": "prod",  "mode": "parallel", "stages": ["<commercial-prod-id>"] } ] }
```

**Compilation changes shape.** Today the compiler intersects topology targets with change targets and rejects any that are absent (§1.1). Stage-shaped, it takes the **cartesian product**: the change supplies the components, the topology supplies the ordered stages, and each wave's targets are (every change target × every stage in that wave). A single-target change now yields a real multi-wave plan — precisely what 277 of 281 changes need and none of them get.

Both shapes must be supported during migration (§6), distinguished by whether a wave carries `stages` or `targets`. A wave carrying **both** should be rejected outright rather than resolved by precedence — a silently-preferred key is how `parseTopologyWaves` already loses malformed documents (§1.5).

### 5.1 The cartesian product needs a filter, and the filter is a hazard

A naive product breaks on the six single-stage components (§6). `agentkit-umami-prod` exists only at prod; under a `gamma → prod` pipeline the product would emit a (umami × `commercial-gamma`) wave target for which no binding exists, and ADR-0006 would correctly fail it closed. The change parks forever on a stage the component was never meant to reach.

So the product must be filtered by which stages a component actually participates in. Two things make that harder than it looks:

- **The compiler is pure** (`plan-compiler.ts`, zero I/O by design, per BUILD_AND_TEST.md §4.1) and cannot look up bindings. The participation set must be resolved by `plan-service.ts` — which already does the DB I/O — and passed in, preserving the purity property the toposort property tests depend on.
- **Filtering on binding-existence alone re-introduces exactly what ADR-0006 forbids.** "No binding at this stage" would silently shrink the plan, and a component that *lost* its gamma binding would look identical to one that never had it. That is the silent no-op ADR-0006 exists to eliminate, reappearing one level up.

This is the §7 readiness problem in another guise: an unresolved gap and a deliberate absence are indistinguishable in the data unless somebody declares which it is. The resolution should be the same mechanism — a component (or its service) **declares the stages it participates in**, the compiler filters on the declaration rather than on binding-existence, and a declared stage with no binding still fails closed per ADR-0006. Absent any declaration, fail closed rather than infer.

That keeps one rule: *the graph never guesses whether an absence was intended.* See Q8.

**Attachment and inheritance (D4).** With pipelines now reusable, the attachment edge from rev 1 becomes worth having — but pointing at a *pipeline*, not at a bundle of components. A `releases_via` edge, resolved in this order when a change carries no explicit `--topology`:

1. the change's own explicit topology (unchanged — explicit always wins)
2. the component's `releases_via`
3. the owning service's `releases_via` (walk `contains` inbound)
4. **past the service, per D4** — domain, then org default
5. else `null`, today's single-wave behaviour

Because many components now share one topology, the cardinality question from rev 1 returns in its original form: `assertCardinality` (`relationships-repo.ts:56-79`) only ever constrains the **to** side, and there is no `many_to_one`. Either the edge is declared `topology → component` (reads backwards, no engine change), or `assertCardinality` gains a `many_to_one` arm. **Recommended: add `many_to_one`** — the edge is read far more often than written, and a backwards-reading edge in a system whose glossary is this careful about vocabulary is a poor trade. See Q1.

**Resolution must live in `proposeChange`** (`changes-repo.ts:167-176`), not in `webhook-processor.ts`. Several paths create changes, and fixing the caller rather than the single decision point is the incomplete-call-site-census mistake this repo has hit four times (BUILD_AND_TEST.md §4.4). The resolved topology and the rung it came from belong on the change's Decision (principle 6), so "why did this change get this pipeline?" is answerable.

---

## 6. Migrating the live estate

The homelab's 18 env-scoped components collapse to **13**, not 9 — only five are true pairs. Matched by the `external_ref` on each binding (the real Argo CD application name), the estate is:

| Logical app | gamma component | prod component | Argo CD refs |
|---|---|---|---|
| keycloak | `agentkit-keycloak` | `agentkit-keycloak-prod` | **identical** |
| market | `agentkitmarket` | `agentkitmarket-prod` | **identical** |
| profile | `agentkitprofile` | `agentkitprofile-prod` | **identical** |
| auto | `agentkit-auto` | `agentkitauto-prod` | differ — `agentkit-auto` / `agentkitauto` |
| forge-web | `agentkit-forge-web` | `agentkitforge-web-prod` | differ — `agentkit-forge-web` / `agentkitforge-web` |

**Not pairs, and must not be merged:** `agentkit-bootstrap` (`agentkit-bootstrap`) and `agentkit-db-bootstrap-prod` (`agentkit-db-bootstrap`) are different Argo CD applications, as are `agentkit-selfhost` (`agentkit-selfhost`) and `agentkit-hosted-prod` (`agentkit-hosted`). The name symmetry is misleading; the refs are not. Four more are prod-only with no gamma counterpart: `agentkitgateway-prod`, `agentkitproject-site-prod`, `agentkit-sealed-secrets-prod`, `agentkit-umami-prod`.

The six non-pairs need no merge — they are single-stage components that simply gain a stage-scoped binding. Their `-prod` suffix becomes misleading once stage is explicit (the suffix was carrying the stage), so a rename is worth considering separately; it is cosmetic and reversible, unlike a merge. See Q7.

This is the disruptive part and should be staged.

1. **Create the two stages** (`commercial-gamma`, `commercial-prod`) and their edges to the existing deployment-targets. Additive; nothing observes them yet.
2. **Backfill `stage_object_id`** on the 61 existing bindings, from each component's `properties.environment` (already present on the 11 prod components) and its Argo CD execution-system. Still additive — resolution rung 2 keeps every component working.
3. **Merge the five pairs, one app at a time, with a verification pass between each** (owner, D7). Uses the shipped `scp component merge` (P5d), which already moves bindings and soft-deletes the loser. The binding-type collision that would previously 409 is exactly what step 2 resolves: the two `configuration` bindings now differ by stage.

   Note the owner's chosen granularity was "one service at a time", which **does not decompose here** — only `agentkit` contains env pairs, so per-service is a single batch of five. Per-app-pair is the finest increment the estate actually offers, and is what this step uses.

   Order, lowest risk first — the three whose Argo CD refs are identical across stages, then the two whose refs differ:

   1. `agentkit-keycloak` ← `agentkit-keycloak-prod`
   2. `agentkitmarket` ← `agentkitmarket-prod`
   3. `agentkitprofile` ← `agentkitprofile-prod`
   4. `agentkit-auto` ← `agentkitauto-prod` *(refs differ)*
   5. `agentkit-forge-web` ← `agentkitforge-web-prod` *(refs differ)*

   **Verification between each** — the merge is irreversible, so a pass that only checks the merge "succeeded" is worthless. Each must confirm: the survivor holds exactly two `configuration` bindings whose `stage_object_id` values are the two distinct stages; each binding's `external_ref` is unchanged from before the merge; the loser is soft-deleted with no live `contains` edge; and a `scp discovery run` against **both** Argo CD systems still resolves each binding to its real application. The last is the one that catches a swapped or dropped `external_ref`, which is the failure mode that would silently point a stage at the wrong cluster's app.
4. **Author one `commercial-gamma-then-prod` topology** over stages and attach it to the `agentkit` service. Every component in it inherits the pipeline via rung 3 — including the six single-stage ones, whose plans simply compile to the one wave whose stage they have a binding for.
5. **Retire `agentkit-gamma-then-prod`** and `forge-gamma-then-prod` once no in-flight plan references them. Compiled plans snapshot `topology_document` (`plan-service.ts:96-109`), so retiring the object cannot disturb history.

Per D6 there is **no backfill of existing changes** — the 276 single-wave plans stay as they are, and only changes created after step 4 compile stage-shaped.

Step 3 is the only irreversible step and is the natural stopping point for owner review.

---

## 7. Readiness and the manual-resolution marker (D5)

### 7.1 The computation

Derived per component, **no new table**:

| Check | Source | Meaning if absent |
|---|---|---|
| `hasService` | `contains` edge inbound | invisible on every service board; no RBAC/policy/freeze scope |
| `hasExecutorBinding` | `executor_bindings` by target | nothing can execute for it |
| `hasSourceMapping` | `source_mappings` by component | no change will ever be created from a push |
| `hasPipeline` | `releases_via`, own or inherited (§5) | releases compile to one anonymous wave |

Exposed as `GET /v1/components/{idOrUrn}/readiness` and aggregated at `GET /v1/readiness`, then SDK → CLI → UI per principle 3.

On the homelab today:

```
                 service   binding   source_mapping
agentkit-auto      yes       yes         yes
homelab-loki       yes       yes         NO
homelab-pihole     yes       yes         NO
```

### 7.2 The marker flags work, not permission to ignore it

Per D5 the marker means **awaiting manual resolution by a user** — these gaps are real and a human must close them. It is not an acknowledgement that silences the count.

Resolution is one of two human acts, and **both** clear the flag:

- **wire it up** — create the source mapping, attach the pipeline; or
- **declare it not-for-coordination** — an explicit, recorded statement that this component is catalogue-only

The second is not a way of ignoring the first. It is a decision, made by a person, checked into git like any other configuration (principle 3) and visible in the audit trail. The distinction that matters: **an unresolved gap and a resolved-as-not-coordinated component must not look the same**, because only one of them is work.

Granularity: **per service, with a per-component override.** The homelab's 43 `homelab-platform` components are one decision, not 43.

Deliberately **not** proposed: notifications. These are static configuration gaps, not events; routing them through notification bindings would make them repeat.

---

## 8. IaC coverage

`packages/iac/src/index.ts:11-30` exports `Service`, `Component`, `Domain`, `Team`, `DeploymentTarget`, `Group`, `User`, `ServiceAccount`, `Campaign`, `Initiative`, `ReleaseTopology`. The manifest carries exactly two collections: `objects` and `relationships`.

| Configuration | IaC-expressible today | After this proposal |
|---|---|---|
| Services, components, `contains` | yes | yes |
| Release topologies | yes | yes |
| **Stages** (§3) | n/a | **yes** — a graph object, free |
| **Pipeline attachment** (§5) | no | **yes** — a relationship, free |
| **Source mappings** | **no** | needs C1 below |
| **Executor bindings** | **no** | needs C1 below |

Making stages objects and attachment a relationship puts both inside the IaC surface at no cost. The two standalone tables do not get that for free.

**C1 — extend the manifest** with `sourceMappings` and `executorBindings` collections. **Recommended.** Principle 3 is written as a parity guarantee, and these two are exactly what a user must reproduce when standing up a second instance — the air-gap and self-hosting story (principle 5). Leaving them out is a documented hole in the parity claim.

Ordering constraint: an executor binding now references a stage, so stages must apply before bindings within one plan diff.

---

## 9. The self-outpost (D3)

Two separable changes.

**9.1 Make the role visible.** `federation_self.role` is advisory and gates nothing (§1.6). Keep it, require designation at bootstrap, and surface it where an operator sees it. An instance with `role: 'unset'` should say so plainly. Nothing should begin *gating* on it — `SCP_FEDERATION_ROLE` already does the one piece of real gating, and two disagreeing role sources is a bug generator.

**9.2 Synthesise a self row.** Per D3, a commander acting in an outpost capacity **is** an outpost and appears in the list, visually distinct, **exempt from polling and poking itself**.

That exemption is a correctness requirement, not an optimisation. The federation-sync loop dials a peer's `base_url`; a self row entering the peer set would dial its own — a self-loop syncing a journal against itself. The exemption must therefore live in the **data**, not only in the rendering: the self row is synthesised for display and must never be inserted into `federation_peers`, or every loop that iterates peers inherits the bug.

ADR-0022 constrains the rest. Authority is split between a `federation_peers` row (transport, keys, sync state) and an `outpost` graph object (declared config, trust tier), and **self has neither**. So the self row must **omit** the fields that exist only for a real peer — last pull, sync cadence, poke mode, journal cursor, verification key — rather than render them blank or zeroed. Showing a zeroed sync state for self is precisely the dishonesty `outposts-honesty.test.tsx` and `change-pipeline-boundary-honesty.test.tsx` exist to catch.

What the self row carries: domain name and id from `federation_self`, the declared role, the stages it coordinates directly, and an explicit "this domain — not a paired peer" marker.

---

## 10. Charter check

| Principle | Effect |
|---|---|
| 1 — coordination, not execution | untouched; no new execution verbs |
| 2 — graph-native | `stage` is a registered object type, attachment is a relationship, readiness is computed. The two new **columns** sit on existing projection tables, not new top-level tables. |
| 3 — API-first parity | stages, attachment and readiness ship API → SDK → CLI → IaC → UI; §8 closes an existing hole |
| 4 — PostgreSQL only | no new stateful dependency; §4 uses a PG15+ feature the pinned PG16 provides |
| 5 — air-gap | §8 directly serves reproducing an instance offline |
| 6 — explainability | resolved topology and the rung it came from recorded on the change's Decision |
| 7 — priorities | Simplicity is the pressure point. This adds one entity and two columns, and **removes** the env-suffixed component duplication — the estate gets smaller. Judged net-positive. |

---

## 11. Open questions

- **Q1 — `releases_via` cardinality.** Add a `many_to_one` arm to `assertCardinality` (recommended, edge reads naturally), or declare the edge `topology → component` and read it backwards for no engine change?
- **Q2 — inheritance beyond the service.** D4 says walk past it. Confirm the rungs: domain, then an org-level default? And is an org default a singleton object or a settings value?
- **Q3 — stage → deployment-target edge.** Reuse `hosted_on` (whose `from_types` is `{service, component}` today, so this widens an existing type), or add a dedicated relationship type?
- ~~**Q4 — merge timing.**~~ **Answered (D7):** one at a time with a verification pass between. Recorded in §6 step 3, at per-app-pair granularity since per-service does not decompose.
- **Q8 — stage participation (§5.1).** How does a component declare which stages it participates in? Options: an explicit `deploys_to`-style edge component → stage (graph-native, and `deploys_to` already exists with `{service,component,change,campaign} → deployment-target`); a property listing stage names; or inherited from the service with a per-component override, mirroring §7.2's granularity. This is the one open question that blocks §5 rather than merely refining it.
- **Q7 — renaming the six non-pairs.** Once stage is explicit, the `-prod` suffix on `agentkitgateway-prod`, `agentkitproject-site-prod`, `agentkit-sealed-secrets-prod`, `agentkit-umami-prod`, `agentkit-db-bootstrap-prod` and `agentkit-hosted-prod` is carrying information the stage now carries. Rename them, or leave the suffix as harmless history? A rename changes the derived URN, so it is cheap but not free.
- **Q5 — stage naming for the homelab.** `commercial-gamma` / `commercial-prod` (proposed, no location segment), or `commercial-amer-*` to leave room for a region split? The glossary says omit unless disambiguating, but renaming a stage later renames a *place*.
- **Q6 — the 8 unbound components.** Out of scope here, but they fail `hasExecutorBinding` and surface in the readiness count on day one. Wire them, or resolve them as not-for-coordination?
