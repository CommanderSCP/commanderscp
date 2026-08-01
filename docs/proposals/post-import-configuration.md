# Proposal: post-import configuration — default topologies, readiness, and the self-outpost

**Status:** Draft — proposed 2026-08-01, pending owner review.
**Relates to:** [organize-after.md](organize-after.md) (M12 P5 — assign/merge, the half of this problem that shipped), [service-component-model.md](service-component-model.md) (import-permissive / create-strict), [import-existing-executors.md](import-existing-executors.md) (Mode A), [ADR-0007](../adr/0007-executor-binding-type-taxonomy.md) (routing Type), [ADR-0011](../adr/0011-universal-outpost-validation.md), [ADR-0022](../adr/0022-outpost-config-authority-split.md) (peer row vs `outpost` object), [PROJECT_CHARTER.md](../../PROJECT_CHARTER.md) principles 2 (graph-native), 3 (API-first parity), 6 (explainability).

---

## Why now

`organize-after.md` predicted the shape of the post-import problem and solved one half of it: an imported orphan can now be assigned to a service (`scp component assign`, M12 P5b) or merged into one (P5d). Both shipped. On 2026-08-01 they were run against the homelab for the first time, and the result exposed the other half.

A census of the live homelab instance, before and after:

| Gap, per component | Before | After assign |
|---|---:|---:|
| No service (`contains` edge) | 45 | **2** |
| No source mapping | 45 | **45** |
| No release topology | 51 | **51** |
| No executor binding | 8 | **8** |

Assign fixed exactly the gap it was built for and nothing else. The remaining rows are the point of this proposal, and one of them has no tooling at all: **51 of 69 components cannot be released through a pipeline, because nothing in the model can say which pipeline they belong to.**

The instance is not failing. It is silently presenting an unconfigured estate as a working one — 45 components imported, bound to Argo CD, visible in the graph, through which no change has ever flowed and none ever can. That silence is the common thread across all three parts below.

---

## 1. What we verified

Grounded against the running instance and the code on `main` at `55ffe2d`. Every claim traced to `file:line` or a query.

### 1.1 A topology cannot be attached to anything

`release-topology` is a registered builtin object type with a `properties.waves` JSON Schema, and the compiler that consumes it works. What is missing is any way to say *"this component releases via this topology."*

- `topologyIdOrUrn` is resolved in exactly one place — `coordination/changes-repo.ts:169-176` — and **only when a caller passes it**. It is type-checked there (`if (topology.typeId !== "release-topology") throw badRequest(...)`) and persisted to `changes.topology_object_id`.
- The only callers that can pass it are `routes/changes.ts` (`POST /v1/changes`) and `routes/campaigns.ts` (`POST /v1/campaigns`). Verified by grepping every `topologyIdOrUrn` reference in `apps/server/src`.
- **`coordination/webhook-processor.ts:299` — the ingress that creates changes from a matched source mapping — does not pass it.** It threads `targets`, `type`, `provides` and `requires`, and stops there. So every change born from a webhook has `topology_object_id = NULL`.
- None of the 14 rows in `relationship_types` has `release-topology` in its `from_types` or `to_types`. There is no edge that could carry the fact.

The consequence, measured on the homelab: **276 of 280 `change_plans` rows have `topology_object_id = NULL`**, and 276 of 284 `change_waves` rows have an empty `name` — the single anonymous wave that `plan-compiler.ts` emits by toposort when no topology is supplied. Only 4 changes have ever run a real pipeline, each proposed by hand. The two `release-topology` objects that exist (`forge-gamma-then-prod`, `agentkit-gamma-then-prod`) have **zero relationships** and are reachable only by a human typing `--topology`.

Two hazards worth naming while we are here, both currently silent:

- `plan-service.ts:39-43` — `parseTopologyWaves` returns `undefined` when `document.waves` is not an array. A topology whose document is malformed is **silently ignored**, and the change compiles to a single wave as though no topology were attached. Indistinguishable, today, from the ordinary case.
- `reconcile.ts:268-290` — if compilation *throws* (cycle, unknown target, topology violating a `depends_on` edge), the change is **auto-cancelled** with the compiler message as its epitaph. On the homelab, 9 of 280 changes are `cancelled`; whether any died this way is not currently distinguishable from the outside.

### 1.2 The IaC surface cannot express the configuration either

`packages/iac/src/index.ts:11-30` exports `Service`, `Component`, `Domain`, `Team`, `DeploymentTarget`, `Group`, `User`, `ServiceAccount`, `Campaign`, `Initiative`, `ReleaseTopology`. The synthesised manifest (`DesiredStateManifest`) carries exactly two collections: `objects` and `relationships`.

So today, declaratively:

| Configuration | IaC-expressible? | Why |
|---|---|---|
| Services, components, `contains` edges | **yes** | graph objects + a registered relationship |
| Release topologies (the object) | **yes** | a graph object |
| Deployment targets | **yes** | a graph object |
| **Which topology a component releases via** | **no** | the concept does not exist in any surface |
| **Source mappings** | **no** | `source_mappings` is a standalone table, not a graph object |
| **Executor bindings** | **no** | `executor_bindings` is a standalone table, not a graph object |

The last three are the entire remaining gap in the census table. A user cannot today check their post-import configuration into git, which is precisely what charter principle 3 (API → SDK → CLI → IaC → UI parity) exists to prevent.

Note that making the topology attachment a **relationship** (§2) puts it inside the IaC surface for free — no manifest change. Source mappings and executor bindings do not get that for free, because they are not graph data.

### 1.3 There is no notion of "configured" anywhere

Grepping `apps/server/src` and `apps/web/src` for `readiness`, `unconfigured`, `needsConfiguration`, `pendingMapping` returns only unrelated federation-loop hits. Nothing computes, stores, or displays whether a component is wired up. The Components and Graph views render a fully-configured component and an inert one identically.

### 1.4 The federation role is advisory and gates nothing

The homelab is a single instance with `federation_self.role = 'unset'` and zero `federation_peers` rows.

- `federation/self-repo.ts:80-92` documents `role` as *"advisory metadata for the CLI/UI, not a precondition"*, and `ensureFederationSelf` lazily mints the row with `role: 'unset'`.
- Its only consumer in the product is an informational banner: `federation-status.tsx:81` (`const notInitialized = selfQuery.data?.role === "unset"`).
- `getFederationStatus` (`federation/status-repo.ts:60-140`) reads `federation_self` only for `domainId`/`name`. It never filters on `role`.
- `outposts.tsx:508` builds its list as `peers.filter(isOutpostPeer)`, where `isOutpostPeer` (`outposts.tsx:42`) is `["outpost","retrans"].includes(status.peer.role)`. **Self is structurally never a candidate row.**
- The one role-based gate in the system is `app.ts:263` (`if (deps.config.federationRole !== "retrans")`), which suppresses the whole SPA on a relay node. It reads the install-time env var `SCP_FEDERATION_ROLE`, *not* `federation_self.role`.

So an operator running a single instance that coordinates every environment directly sees an Outposts page reading "No outpost or retrans peers are paired yet" and nothing anywhere stating that this instance is itself the domain where everything lands. The UI is not wrong; it is silent.

---

## 2. Proposal A — `releases`, a topology attachment edge

Add one registered builtin relationship type:

| | |
|---|---|
| `id` | `releases` |
| `from_types` | `{release-topology}` |
| `to_types` | `{service, component}` |
| `cardinality` | `one_to_many` |

**The direction is load-bearing, and it is the opposite of the obvious one.** The natural first instinct is `component → release-topology` ("this component releases via that topology"). That cannot be constrained correctly today. `assertCardinality` (`graph/relationships-repo.ts:56-79`) only ever constrains the **to** side — its own comment at line 67 reads *"'to' side is singular: this `to_id` may not already have an incoming edge of this type"* — and the `cardinality` column is free `text` whose only live values are `one_to_many` and `many_to_many`, with `one_to_one` also handled in code. There is **no `many_to_one`**. So on a `component → topology` edge:

- `one_to_many` would constrain the *topology*, i.e. only one component could ever use each topology — the exact opposite of what a shared pipeline is for
- `one_to_one` would constrain both sides, same problem
- expressing the real rule would require a new cardinality value plus an engine change to `assertCardinality`

Declaring it `topology → component` instead makes the constraint we want — **at most one topology per component, one topology serving many components** — precisely what the existing `one_to_many` already means, with **zero engine changes**. It becomes the exact structural twin of `contains` (`service → component`, `one_to_many`), down to the race backstop: a partial unique index on `(org_id, to_id) WHERE type_id='releases' AND deleted_at IS NULL`, mirroring migration `0022`'s index for `contains` (verified at `apps/server/drizzle/0022_contains_single_service_constraint.sql:27-29`).

The edge reads "topology T releases component C", which is also the honest description of what a release topology does.

**Resolution order** when `proposeChange` is called without an explicit `topologyIdOrUrn`:

1. the change's own `topologyIdOrUrn`, if the caller passed one (unchanged — explicit always wins)
2. else the incoming `releases` edge on the **component** being targeted
3. else the incoming `releases` edge on that component's owning **service** (walk the `contains` edge inbound)
4. else `null` — today's behaviour, single toposorted wave

Steps 2-3 give the umbrella-service model its natural payoff: attach one topology to `agentkit` and all 24 of its components inherit it, overriding per-component only where a component genuinely differs.

**Where the resolution lives.** It must be inside `proposeChange` (`changes-repo.ts`), not in `webhook-processor.ts`. The webhook processor is one of several change-creating paths, and putting resolution in the caller is precisely the incomplete-call-site-census mistake this repo has been bitten by four times (BUILD_AND_TEST.md §4.4). Resolution belongs at the single point where `topologyObjectId` is already decided — `changes-repo.ts:167-176`.

**Multi-target changes.** A change may target several components (`targets: string[]`). If two targets resolve to different topologies, that is a genuine conflict. Proposed: **refuse the change with a 400 naming both topologies**, consistent with ADR-0007's "one release = one source = one pipeline" ruling, which already treats the routing Type as a property of the change rather than of each target. Open question Q2.

**Charter fit.** New relationship type = registry data, not a new top-level table (principle 2). Free IaC expressibility via the existing `relationships` collection (principle 3). The resolution outcome should be recorded on the Decision the change already writes, so "why did this change get this pipeline?" is answerable (principle 6).

---

## 3. Proposal B — configuration readiness, and an honest badge

### 3.1 The computation

A derived, per-component readiness record — **no new table**, computed from what already exists:

| Check | Source | Meaning if absent |
|---|---|---|
| `hasService` | `contains` edge inbound | invisible on every service board; no RBAC/policy/freeze scope |
| `hasExecutorBinding` | `executor_bindings` by `target_object_id` | nothing can execute for it |
| `hasSourceMapping` | `source_mappings` by `component_object_id` | no change will ever be created from a webhook |
| `hasTopology` | `releases` (§2), own or inherited | releases compile to one anonymous wave |

Exposed as `GET /v1/components/{idOrUrn}/readiness` and aggregated at `GET /v1/readiness` for the instance-wide count. API-first, then SDK/CLI/UI per principle 3.

### 3.2 The part that makes or breaks it: acknowledgement

A badge that can never reach zero is a badge operators learn to ignore. On the homelab, 43 components are **deliberately** catalog-only — imported for visibility, with no intention of ever coordinating a release through them. If those permanently show as unconfigured, the count is noise from day one.

So readiness needs an explicit escape: a component (or a whole service) can be marked **catalog-only**, which excludes it from the count and displays as a distinct, deliberate state rather than a gap. Proposed as a label or property rather than a new type, set through the same API/CLI/IaC path as everything else — so the *decision not to wire something up* is itself checked into git.

This is the difference between "45 things are broken" and "45 things are catalog, 0 gaps" — the same data, one of them actionable.

### 3.3 Surfacing

- a count in the nav next to Components/Services, suppressed entirely at zero
- per-component detail listing which of the four checks failed, each linking to the action that fixes it
- on the service board, a per-row indicator, since that is where "this service's components" is already the frame

Deliberately **not** proposed: a notification or alert. These are static configuration gaps, not events; they do not need to interrupt anyone, and routing them through the notification bindings would make them repeat.

---

## 4. Proposal C — IaC coverage for the two non-graph tables

`source_mappings` and `executor_bindings` are the only post-import configuration that cannot be declared. Two options:

**C1 — extend the manifest.** Add `sourceMappings` and `executorBindings` collections to `DesiredStateManifest`, with matching constructs. Honest about what they are (projections, not graph objects), and keeps `executePlanDiff` as the single apply path. Cost: the manifest stops being purely `objects` + `relationships`, and the plan-diff engine grows two more resource kinds.

**C2 — leave them out.** Accept that bindings and mappings are imperative (`scp connect argocd`, `scp change-source create-mapping`) and not part of desired state.

**Recommendation: C1**, because principle 3 is written as a parity guarantee and these are the two things a user most needs to reproduce when standing up a second instance — which is exactly the air-gap/self-hosting story (principle 5). C2 leaves a documented hole in the parity claim.

Note this is independent of §2: `releases` needs no manifest change either way.

---

## 5. Proposal D — the self-outpost

Two distinct problems, and they should not be conflated.

### 5.1 Make the role mean something

`federation_self.role` is advisory and gates nothing (§1.4). Either it should be set and displayed, or it should be removed. Proposed: keep it, require it to be designated during bootstrap or first-run, and **surface it prominently** — the instance header or the Federation page — so "this is a commander" is a stated fact rather than an inference. A `role: 'unset'` instance should say so plainly.

This is a display and bootstrap change only. Nothing should start *gating* on `federation_self.role`, because `SCP_FEDERATION_ROLE` already does the one piece of real gating (`app.ts:263`) and two role sources that can disagree is a bug generator.

### 5.2 Show self in the Outposts list

An operator running one instance that coordinates every environment has, in every practical sense, a commander that is also the domain where releases land. Proposed: **synthesise a self row** at the top of the Outposts list, visually distinct from paired peers.

The constraint comes from ADR-0022, which splits authority between a `federation_peers` row (transport, keys, sync state) and an `outpost` graph object (declared config, trust tier). **Self has neither.** So the self row must not render the fields that only exist for a real peer — last pull, sync cadence, poke mode, journal cursor, verification key. Showing an empty or zeroed sync state for self would be exactly the dishonesty the boundary-honesty tests (`outposts-honesty.test.tsx`, `change-pipeline-boundary-honesty.test.tsx`) exist to prevent.

What the self row should carry: the domain name and id from `federation_self`, the declared role, the deployment targets it coordinates directly, and an explicit "this domain — not a paired peer" marker. Everything else omitted rather than blanked.

Open question Q3: whether self should additionally get a real `outpost` config object so its trust tier is declarable, or whether trust tier is meaningless for the domain you are standing in.

---

## 6. Charter and principle check

| Principle | Effect |
|---|---|
| 1 — coordination, not execution | untouched; no new execution verbs |
| 2 — graph-native | `releases` is registry data, not a table. Readiness is computed, not stored. |
| 3 — API-first parity | readiness and `releases` ship API → SDK → CLI → IaC → UI. §4 closes an existing parity hole. |
| 4 — PostgreSQL only | no new stateful dependency |
| 5 — air-gap | §4 (C1) directly serves reproducing an instance offline |
| 6 — explainability | topology resolution recorded on the change's Decision; readiness is derived and inspectable |
| 7 — priorities | Simplicity is the pressure point: §3.2's acknowledgement mechanism is the one place this adds user-facing concept weight. Judged worth it — without it the feature is ignorable. |

---

## 7. Open questions for the owner

- **Q1 — edge direction.** §2 proposes `topology → component` specifically so the existing `one_to_many` expresses the constraint with no engine change, at the cost of an edge that points "backwards" relative to how one says it in English. The alternative is `component → topology` plus a new `many_to_one` cardinality and an `assertCardinality` change. Confirm the trade is the right way round.
- **Q2 — multi-target conflict.** Refuse a change whose targets resolve to different topologies (proposed), or take the service-level one as the tie-break?
- **Q3 — trust tier for self.** Does a self-outpost row get a real `outpost` config object, or is trust tier meaningless for the local domain?
- **Q4 — inheritance depth.** Component → owning service is proposed. Should it walk further (service → domain → org), or stop at the service?
- **Q5 — catalog-only granularity.** Set per component, per service, or both? Per-service would have marked all 43 homelab-platform components in one action.
- **Q6 — retrofit.** Should attaching a topology to a service backfill anything for the 276 existing single-wave changes, or apply only to changes created after? (Proposed: only after — a compiled plan is already snapshotted deliberately, per `plan-service.ts`'s topology-document snapshot comment.)
