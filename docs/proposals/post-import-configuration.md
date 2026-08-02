# Proposal: post-import configuration — stages, placements, readiness, and the self-outpost

**Status:** Draft rev 3 — proposed 2026-08-01, revised twice the same day after owner review. Rev 1's §2 and rev 2's §4 are both withdrawn (see §2.0).
**Relates to:** [GLOSSARY.md](../GLOSSARY.md) (**authoritative** — its `stage`, `wave`, `instance` and `deployment` entries govern §3–§4), [ADR-0021](../adr/0021-terminology.md) (D6, the stage grammar), [organize-after.md](organize-after.md) (M12 P5 — assign/merge), [service-component-model.md](service-component-model.md), [ADR-0006](../adr/0006-fail-closed-on-missing-executor-binding-for-purpose.md), [ADR-0007](../adr/0007-executor-binding-type-taxonomy.md), [ADR-0011](../adr/0011-universal-outpost-validation.md), [ADR-0022](../adr/0022-outpost-config-authority-split.md), [PROJECT_CHARTER.md](../../PROJECT_CHARTER.md) principles 2 (graph-native), 3 (API-first parity), 6 (explainability).

---

## 0. Owner decisions recorded (2026-08-01)

| | Decision |
|---|---|
| **D1** | ~~Fix the executor-binding uniqueness constraint.~~ **Superseded by D8's model** — see §4. The constraint was never the problem; the graph was missing a level. |
| **D2** | The multi-target topology conflict is not a real problem — **dropped**, evidence in §1.4. |
| **D3** | A commander acting in an outpost capacity **is** an outpost and must be shown as one — exempt from polling and poking itself. |
| **D4** | Topology inheritance walks **past** the owning service. |
| **D5** | The readiness marker flags items **awaiting manual resolution by a user**. It is not an "acknowledged, stop counting" flag. |
| **D6** | No backfill. Applies only to changes created afterward. |
| **D7** | Convert env pairs **one at a time with a verification pass between**, not in one batch (§6). |
| **D8** | **A component spans multiple stages via multiple placements** — one per stage, each serving its environment. Placements are **declared manually in the UI or IaC**, never inferred from component names. |

**One vocabulary item is provisional.** "Placement" is this document's working name for the (component × stage) node. The owner's phrasing was *instance*, which [GLOSSARY.md:537](../GLOSSARY.md) reserves for *"one running deployment of the SCP binary"* — the term the whole federation model rests on ("commander instance", "outpost instance"). The concept genuinely has no word yet, so it needs a glossary entry and an ADR-0021 follow-on before implementation. Everything below is renameable; nothing depends on the spelling.

---

## Why now

`organize-after.md` shipped assign and merge (M12 P5b/P5d). On 2026-08-01 they ran against the homelab for the first time, closing the gap they were built for and exposing the rest.

| Gap, per component | Before | After assign |
|---|---:|---:|
| No service (`contains` edge) | 45 | **2** |
| No source mapping | 45 | **45** |
| No release topology | 51 | **51** |
| No executor binding | 8 | **8** |

The 51 have no tooling, and the cause is structural: **the graph has no word for the place a release lands, and no way to say the same software runs in two of them.** The glossary reserved `stage` for the first and says no such entity exists yet. The second is D8.

---

## 1. What we verified

Grounded against the running homelab instance and the code at `55ffe2d`.

### 1.1 A topology orders a change's targets; it cannot supply them

`plan-compiler.ts:133` — `if (!targetSet.has(t)) return { ok: false, error: "unknown_target", target: t }`. Every target a topology names must already be in the change's target set.

### 1.2 The two live topologies use different units, and one is rehearsal debris

| Topology | Created | Waves name | Real? |
|---|---|---|---|
| `forge-gamma-then-prod` | 2026-07-12 19:11 | 2 **deployment-targets** | No — fake-executor rehearsal, unused since |
| `agentkit-gamma-then-prod` | 2026-07-17 16:44 | 18 **components** | Yes — the only real one |

### 1.3 The same software is modelled as two unrelated components

Keycloak runs in both clusters, and the graph holds two component objects for it:

```
agentkit-keycloak       env (unset)  hosted_on gamma  → homelab-argo  ref: agentkit-keycloak
agentkit-keycloak-prod  env prod     hosted_on prod   → argocd-prod   ref: agentkit-keycloak
```

**Both bindings carry the same `external_ref`.** The only thing distinguishing the rows is which Argo CD they point at — the graph is already telling us this is one piece of software in two places, while the object model insists they are two unrelated components.

The reason it was modelled this way is `executor_bindings`' `UNIQUE (org_id, target_object_id, type)`: one component could hold at most one `configuration` binding, so a single `agentkit-keycloak` could not bind to both Argo CDs. The env-suffixed pairs were a workaround.

The duplication cost is everything that belongs to the *software* rather than to the *place* — source mappings, owner, dependencies, blast radius — carried twice, and the graph unable to answer "is prod keycloak behind gamma?"

### 1.4 Auto-created changes have exactly one target (D2's evidence)

`webhook-processor.ts:299` calls `proposeChange` once per matched mapping with `targets: [match.componentObjectId]`. Measured:

```
 1 target  → 277 changes
 2 targets →   1 change    (the 2026-07-12 rehearsal)
18 targets →   3 changes   (the real promotions)
```

A push to `AgentKitProject/agentkit` matches 24 mappings and creates 24 separate single-target changes. A single-target change has nothing to disagree with, so the rev 1 multi-target conflict cannot arise on the automatic path.

### 1.5 Consequence today

276 of 280 `change_plans` rows have `topology_object_id = NULL`, and 276 of 284 `change_waves` have an empty `name` — the single anonymous wave `plan-compiler.ts` emits by toposort. The two topology objects have **zero relationships**.

Two silent hazards worth fixing alongside:

- `plan-service.ts:39-43` — `parseTopologyWaves` returns `undefined` when `document.waves` is not an array, so a malformed topology is **silently ignored** and compiles to a single wave.
- `reconcile.ts:268-290` — if compilation throws, the change is **auto-cancelled** with the compiler message as its epitaph.

### 1.6 The federation role is advisory and gates nothing

`federation/self-repo.ts:80-92` documents `role` as *"advisory metadata for the CLI/UI, not a precondition"*. Its only product consumer is a banner at `federation-status.tsx:81`. `getFederationStatus` never filters on it. `outposts.tsx:508` filters `federation_peers` for `role IN ('outpost','retrans')`, so **self is structurally never a candidate row**. The one real role gate is `app.ts:263`, reading the env var `SCP_FEDERATION_ROLE`.

---

## 2.0 What the earlier revisions got wrong

**Rev 1** proposed attaching a topology to a component so webhook changes would inherit a pipeline. A webhook change targets one component (§1.4), the real topology names 18, and `plan-compiler.ts:133` rejects any topology target absent from the change's targets — the change would fail to compile with `unknown_target` rather than inherit anything.

**Rev 2** proposed fixing `executor_bindings`' uniqueness constraint with a nullable `stage_object_id` and `UNIQUE NULLS NOT DISTINCT`. That works, but it is unnecessary under D8: if the binding attaches to a **placement** rather than to a component, `keycloak@gamma` and `keycloak@prod` are different `target_object_id` values and the existing constraint is already correct. **No migration on `executor_bindings` at all.**

Both errors share a root: trying to encode "which place" into something that was not a place. The fix is to model the place.

---

## 3. Stages become first-class

The [glossary](../GLOSSARY.md) reserves the vocabulary and names the gap:

> **stage** | **Reserved:** one named deployment **place**, spelled `<domain>[-<location>]-<env>`. **No such entity exists yet**

> **wave** | One ordered step of a compiled plan — the **set of one-or-more stages** advanced at once

> **A stage is a place; a wave is a step.** … **a wave contains one or more stages.**

**Proposed:** a builtin object type `stage`, whose `name` obeys the ADR-0021 D6 grammar — `<domain>[-<location>]-<env>`, lowercase, fixed segment order, **every segment value hyphen-free** (the grammar parses by segment count, so `us-east` is invalid; use `useast`). Validation belongs in the type's `property_schema` and the typed create route: a name that cannot be parsed by segment count is unrecoverable later.

For the homelab, two stages — `commercial-gamma` and `commercial-prod`. No location segment; the glossary says to include it only when telling geographic peers apart, and there is one region.

**Stage versus deployment-target.** Both survive. The glossary is explicit that a `deployment-target` "may model a cluster, a host, an environment, or a region" — it is the concrete thing an executor points at. A stage is the *named place* in the release grammar. A stage relates to one or more deployment-targets, so `commercial-prod` points at `prod (DOKS hosted)`.

---

## 4. Placements (D8)

**A placement is one component at one stage.** `agentkit-keycloak@commercial-gamma` and `agentkit-keycloak@commercial-prod` are two placements of one `agentkit-keycloak` component. Each serves its environment; each is a separately running thing.

What lives where, and this split is the whole point:

| On the **component** (once) | On each **placement** |
|---|---|
| service membership (`contains`) | the executor binding |
| owner, dependencies, blast radius | the Argo CD `external_ref` |
| source mappings | the stage it serves |
| the release topology it uses | its own execution status |

**Identity.** A placement's name is derived — `<component>@<stage>` — and so is its URN, with a unique index on `(org_id, component, stage)`. Created through a typed route requiring both a component and a stage, which enforces the one-component-one-stage rule at the boundary and sidesteps the relationship-cardinality vocabulary entirely (`assertCardinality` only constrains the *to* side, and there is no `many_to_one` — see `relationships-repo.ts:56-79`).

**`executor_bindings` does not change.** Its `target_object_id` points at a placement instead of a component, and `UNIQUE (org_id, target_object_id, type)` is then exactly right: one placement, one `configuration` binding. Rev 2's nullable column, its `NULLS NOT DISTINCT` requirement, and the expand/contract migration all disappear.

**`change_wave_targets.target_object_id` points at a placement too** — "deploy keycloak at `commercial-prod`" — which is what the row has always meant, with the stage previously smuggled into a component's name.

**Placements are declared, never inferred (D8).** Nothing may pair components by name. §1.3's own data shows why: `agentkit-bootstrap` and `agentkit-db-bootstrap-prod` look like a pair and are **different Argo CD applications** (`agentkit-bootstrap` vs `agentkit-db-bootstrap`), as are `agentkit-selfhost` and `agentkit-hosted`. Name symmetry is not evidence. Declaration happens in the UI or in IaC (§8), and an undeclared component surfaces as a readiness gap (§7) rather than being auto-resolved.

---

## 5. Pipelines over stages

**Topology waves name stages**, not components:

```json
{ "waves": [ { "name": "gamma", "mode": "parallel", "stages": ["<commercial-gamma-id>"] },
             { "name": "prod",  "mode": "parallel", "stages": ["<commercial-prod-id>"] } ] }
```

**Compilation.** The change supplies components; the topology supplies ordered stages; each wave's targets are the **placements** of those components at that wave's stages. A single-target change now yields a real multi-wave plan — precisely what 277 of 281 changes need and none get.

**Q8 from rev 2 is resolved by D8.** The participation question — *how does a component say which stages it deploys to?* — needs no new mechanism: **participation is which placements exist.** A component with no `commercial-gamma` placement simply contributes no target to the gamma wave. Crucially this is not the hazardous binding-existence filter rev 2 warned about, because a placement is *declared* (D8): its absence is a deliberate statement, while a placement that exists with no binding is a genuine misconfiguration that still fails closed per ADR-0006. The graph never guesses whether an absence was intended.

Both topology shapes must be supported during migration, distinguished by whether a wave carries `stages` or `targets`. A wave carrying **both** is rejected outright rather than resolved by precedence — a silently-preferred key is how `parseTopologyWaves` already loses malformed documents (§1.5).

**Attachment and inheritance (D4).** A `releases_via` edge resolved in this order when a change carries no explicit `--topology`:

1. the change's own explicit topology (explicit always wins)
2. the component's `releases_via`
3. the owning service's (walk `contains` inbound)
4. **past the service, per D4** — domain, then org default
5. else `null` — today's single-wave behaviour

Cardinality: many components share one topology, so either the edge is declared `topology → component` (reads backwards, no engine change) or `assertCardinality` gains a `many_to_one` arm. **Recommended: add `many_to_one`.** See Q1.

**Resolution lives in `proposeChange`** (`changes-repo.ts:167-176`), not in `webhook-processor.ts` — several paths create changes, and fixing the caller rather than the single decision point is the incomplete-call-site-census mistake this repo has hit four times (BUILD_AND_TEST.md §4.4). The resolved topology and the rung it came from belong on the change's Decision (principle 6).

---

## 6. Migrating the live estate

The homelab's 18 env-scoped components become **13 components with placements**. Only five are true pairs, established by `external_ref` (the real Argo CD application name), not by name:

| Logical app | gamma component | prod component | Argo CD refs |
|---|---|---|---|
| keycloak | `agentkit-keycloak` | `agentkit-keycloak-prod` | **identical** |
| market | `agentkitmarket` | `agentkitmarket-prod` | **identical** |
| profile | `agentkitprofile` | `agentkitprofile-prod` | **identical** |
| auto | `agentkit-auto` | `agentkitauto-prod` | differ — `agentkit-auto` / `agentkitauto` |
| forge-web | `agentkit-forge-web` | `agentkitforge-web-prod` | differ — `agentkit-forge-web` / `agentkitforge-web` |

**Not pairs:** `agentkit-bootstrap` / `agentkit-db-bootstrap-prod` and `agentkit-selfhost` / `agentkit-hosted-prod` are different Argo CD applications. Four more are prod-only: `agentkitgateway-prod`, `agentkitproject-site-prod`, `agentkit-sealed-secrets-prod`, `agentkit-umami-prod`. These six need no conversion — each becomes a component with a single placement. Their `-prod` suffix then carries information the stage carries; renaming is cosmetic and reversible (Q7).

**This table is a suggestion for a human to confirm, not an input to automation (D8).** It is offered in the UI as a proposed pairing with the evidence shown — both `external_ref`s, both execution systems — and applied only on confirmation.

Sequence:

1. **Create the two stages** and their edges to the existing deployment-targets. Additive; nothing observes them yet.
2. **Create a placement per existing component**, at the stage implied by its current binding's execution system, and re-point the binding from the component to the placement. Mechanical and reversible; every component still resolves to exactly one binding, so no coordination behaviour changes.
3. **Convert the five confirmed pairs, one at a time with a verification pass between (D7).** Each: re-declare the prod component's placement under the gamma component, move the binding, soft-delete the now-empty prod component. Ordered lowest-risk first — the three whose refs are identical across stages (keycloak, market, profile), then the two whose refs differ (auto, forge-web).

   **Verification between each** — conversion is irreversible, so a pass that only checks it "succeeded" is worthless. Each must confirm: the surviving component has exactly two placements at the two distinct stages; each placement's binding `external_ref` is **unchanged** from before; the absorbed component is soft-deleted with no live `contains` edge; and `scp discovery run` against **both** Argo CD systems still resolves each binding to its real application. The last is what catches a swapped `external_ref` — the failure mode that would silently point a stage at the wrong cluster's app.

4. **Author one `commercial-gamma-then-prod` topology** over stages and attach it to the `agentkit` service. Every component inherits it via rung 3; the six single-placement components simply contribute nothing to the wave whose stage they have no placement at (§5).
5. **Retire `agentkit-gamma-then-prod`** and `forge-gamma-then-prod` once no in-flight plan references them. Compiled plans snapshot `topology_document` (`plan-service.ts:96-109`), so retiring the object cannot disturb history.

Per D6 there is **no backfill** — the 276 single-wave plans stay as they are; only changes created after step 4 compile stage-shaped.

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

`hasPlacement` is where D8's manual declaration surfaces: after step 2 every component has one, and any component that should span stages but does not shows up here until a human declares it.

### 7.2 The marker flags work, not permission to ignore it

Per D5 the marker means **awaiting manual resolution by a user**. It is not an acknowledgement that silences the count.

Resolution is one of two human acts, and **both** clear the flag:

- **wire it up** — declare the placement, create the source mapping, attach the pipeline; or
- **declare it not-for-coordination** — an explicit, recorded statement that this component is catalogue-only

The second is not a way of ignoring the first. It is a decision, made by a person, checked into git like any other configuration (principle 3) and visible in the audit trail. The distinction that matters: **an unresolved gap and a resolved-as-not-coordinated component must not look the same**, because only one of them is work.

Granularity: **per service, with a per-component override.** The homelab's 43 `homelab-platform` components are one decision, not 43.

Deliberately **not** proposed: notifications. These are static configuration gaps, not events; routing them through notification bindings would make them repeat.

---

## 8. IaC coverage

`packages/iac/src/index.ts:11-30` exports `Service`, `Component`, `Domain`, `Team`, `DeploymentTarget`, `Group`, `User`, `ServiceAccount`, `Campaign`, `Initiative`, `ReleaseTopology`. The manifest carries exactly two collections: `objects` and `relationships`.

| Configuration | Today | After |
|---|---|---|
| Services, components, `contains` | yes | yes |
| Release topologies | yes | yes |
| **Stages** (§3) | n/a | **yes** — a graph object, free |
| **Placements** (§4) | n/a | **yes** — a graph object, free |
| **Pipeline attachment** (§5) | no | **yes** — a relationship, free |
| **Source mappings** | **no** | needs C1 |
| **Executor bindings** | **no** | needs C1 |

D8 makes placement declaration in IaC a **requirement**, not a nicety — "declared manually in the UI or IaC" is only true if IaC can express it. Stages and placements being graph objects delivers that for free.

**C1 — extend the manifest** with `sourceMappings` and `executorBindings` collections. **Recommended.** Principle 3 is a parity guarantee, and these two are exactly what a user must reproduce when standing up a second instance — the air-gap and self-hosting story (principle 5).

Ordering constraint within one plan diff: stages → placements → bindings.

---

## 9. The self-outpost (D3)

**9.1 Make the role visible.** `federation_self.role` is advisory and gates nothing (§1.6). Keep it, require designation at bootstrap, and surface it where an operator sees it. Nothing should begin *gating* on it — `SCP_FEDERATION_ROLE` already does the one piece of real gating, and two disagreeing role sources is a bug generator.

**9.2 Synthesise a self row.** Per D3 a commander acting in an outpost capacity **is** an outpost and appears in the list, visually distinct, **exempt from polling and poking itself**.

That exemption is a correctness requirement. The federation-sync loop dials a peer's `base_url`; a self row entering the peer set would dial its own — a self-loop syncing a journal against itself. The exemption must live in the **data**, not only the rendering: the self row is synthesised for display and must never be inserted into `federation_peers`, or every loop that iterates peers inherits the bug.

ADR-0022 constrains the rest. Authority is split between a `federation_peers` row (transport, keys, sync state) and an `outpost` graph object (declared config, trust tier), and **self has neither**. So the self row must **omit** the fields that exist only for a real peer — last pull, sync cadence, poke mode, journal cursor, verification key — rather than render them blank or zeroed. A zeroed sync state for self is precisely the dishonesty `outposts-honesty.test.tsx` and `change-pipeline-boundary-honesty.test.tsx` exist to catch.

The self row carries: domain name and id from `federation_self`, the declared role, the stages it coordinates directly, and an explicit "this domain — not a paired peer" marker.

---

## 10. Charter check

| Principle | Effect |
|---|---|
| 1 — coordination, not execution | untouched; no new execution verbs |
| 2 — graph-native | `stage` and `placement` are registered object types, attachment is a relationship, readiness is computed. **No schema change to any existing table** — rev 2's `executor_bindings` migration is withdrawn. |
| 3 — API-first parity | stages, placements, attachment and readiness ship API → SDK → CLI → IaC → UI; §8 closes an existing hole and D8 makes it mandatory |
| 4 — PostgreSQL only | no new stateful dependency |
| 5 — air-gap | §8 directly serves reproducing an instance offline |
| 6 — explainability | resolved topology and its rung recorded on the change's Decision |
| 7 — priorities | Simplicity is the pressure point: two new object types. Against that, the estate loses 5 duplicate components, `executor_bindings` needs no migration, and the participation mechanism Q8 would have required disappears. Judged net-positive. |

---

## 11. Open questions

- **Q1 — `releases_via` cardinality.** Add a `many_to_one` arm to `assertCardinality` (recommended, edge reads naturally), or declare the edge `topology → component` and read it backwards for no engine change?
- **Q2 — inheritance beyond the service.** D4 says walk past it. Confirm the rungs: domain, then an org-level default? Is an org default a singleton object or a settings value?
- **Q3 — stage → deployment-target edge.** Reuse `hosted_on` (`{service, component} → deployment-target` today, so this widens an existing type), or add a dedicated one?
- **Q5 — stage naming for the homelab.** `commercial-gamma` / `commercial-prod` (proposed, no location segment), or `commercial-amer-*` to leave room for a region split? The glossary says omit unless disambiguating, but renaming a stage renames a *place*.
- **Q6 — the 8 unbound components.** They fail `hasExecutorBinding` and surface in the readiness count on day one. Wire them, or resolve them as not-for-coordination?
- **Q7 — renaming the six single-placement components.** Once stage is explicit, the `-prod` suffix on `agentkitgateway-prod` and the other five carries what the stage now carries. Rename, or leave as harmless history? A rename changes the derived URN.
- **Q9 — the placement's name.** "Placement" is provisional (§0). It needs a glossary entry and an ADR-0021 follow-on. Alternatives considered: *instance* (reserved — SCP installs), *footprint* (vague on cardinality), *component instance* (puts the reserved word in the head-noun position).

*Q4 and Q8 are answered — D7 and D8 respectively.*
