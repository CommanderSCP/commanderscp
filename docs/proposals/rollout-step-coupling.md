# Proposal: stage-scoped coupling between microservices

**Status:** v0.2 — **implemented and merged** (PR #220, 2026-08-05); [ADR-0028](../adr/0028-stage-scoped-component-coupling.md) is Accepted. Increments 0–3 and 5 shipped; **increment 4 (operator surfaces) did NOT ship** — see §5. v0.1 (2026-08-04) was written before the mechanism was grounded against code; **§0 records what that grounding refuted**, and the design below is a rewrite, not an edit. Owner rulings of 2026-08-05 are in §6.
**Role:** Lets one microservice's deploy *at a stage* wait on another's at the same stage, declared by the microservice's own CI — without requiring the dependency to be finished everywhere.
**Relates to:** [ADR-0008](../adr/0008-observe-enrichment-signals.md) (rollout state is **observed, not driven** — this design does **not** amend it; §2.1 says why), [ADR-0026](../adr/0026-placements-and-derived-stage-names.md) (placements, derived stage names), [ADR-0027](../adr/0027-service-rung-binding-resolution.md), [coupled-pipelines.md](coupled-pipelines.md) (`provides`/`requires` — the shipped CROSS-CHANGE mechanism this is **not** an extension of, §3.1), [GLOSSARY.md](../GLOSSARY.md) (`stage`, `wave`), DESIGN.md §9.3.

Owner ask, 2026-08-04:

> *"Services have dozens of microservices and so images. We need to find a way to couple them. Maybe we add optional fields within the code repos that show min dependencies on other microservices? That way if say we get to amer-gamma, microservice A won't deploy out until microservice B has done the same. We just need to be sure we don't require the full 100% deployment since engineers might purposefully want to be testing at the partial rollout stage (ex: 10% (microservice A then B) -> 50% -> 100%). In addition, this can be used to derive the dependency charts instead of guessing and assumptions."*

---

## 0. What the grounding refuted — read this before the design

v0.1 proposed holding component A **at a rollout step** until its dependency reached the same step, enforced at the wave-boundary gate, declared in a manifest collection, and materialised as `depends_on` edges "for free". **Four of those five choices are wrong**, three of them in ways that would have shipped a deadlock. Each was verified by reading the code, not the comments.

### 0.1 There is no "advance" for SCP to decline

> v0.1 §3: *"Consuming it as a gate input does not make SCP drive a rollout — SCP still never sets a weight, it only declines to advance A."*

**There is nothing to decline.** `ExecutorPlugin` is exactly five methods — `observe`, `trigger`, `status`, `abort`, `describeCapabilities` (`packages/plugin-api/src/index.ts:223-231`) — and the file states it outright at `:196-197`: *"No verb here promotes/pauses/aborts/re-weights a rollout."* `TriggerIntent.kind` is a closed union (`:157`). SCP fires **one** trigger per wave target (`reconcile.ts:1275-1280`) and thereafter only polls (`:857-881`), never revisiting a terminal target (`:801` `if (target.status === "succeeded") continue;`).

So once A is triggered, **Argo Rollouts is already driving it**. If the canary uses timed steps, A walks 10→50→100 with no further SCP involvement. If it uses an indefinite pause, the thing that would release it is Argo's `promote` — [ADR-0008](../adr/0008-observe-enrichment-signals.md) forbids that verb by name.

**Consequence: the finest grain SCP can enforce is "is A triggered at this stage at all".** v0.1 §5 Q5 ("does a dependency block the DEPLOY or just the STEP?") is not an open question — the verb set closed it. The honest semantic is §2.1.

### 0.2 The wave gate would deadlock the exact scenario in the ask

> v0.1 §5 Q6: *"The wave-boundary gate (`gate-orchestrator.ts`) is the natural home."*

`evaluateWaveGate` issues **one verdict for every target of the wave** (`reconcile.ts:686-698`), keyed on `{topologyObjectId, waveIndex}` with **no target dimension** (`gates.ts:206-207`). In stage mode, A and B placed at `amer-gamma` are in that **same wave** (`plan-compiler.ts:197-225` groups by place). Blocking the gate to hold A therefore also holds B — B never advances, A's dependency never clears, both park forever. The gate also fires exactly **once** per wave on `pending→running` (`reconcile.ts:683-684`), so it could not re-evaluate a hold even if it were per-target.

**The only per-target seam that exists** is the trigger-backoff `continue` at `reconcile.ts:814-830`. That is where this design goes (§3.3).

### 0.3 The "free second prize" is not free — declaring the edges breaks releases

> v0.1 §4: *"this is the part with no blockers… the existing wave toposort improves for free."*

False in both directions.

- **It never fires where the ask needs it.** `loadDependsOnEdges` requires **both endpoints in the change's own target set** (`plan-service.ts:36-47`, docblock at `:27-29`), and a webhook-born change targets exactly one component (`webhook-processor.ts:322`; 277 of 281 measured, [ADR-0026](../adr/0026-placements-and-derived-stage-names.md)). With one target the edge query returns `[]`.
- **Where it does fire, it can only break things.** In stage mode a dependent pair in one wave returns `topology_violates_dependency` (`plan-compiler.ts:263-280`) → `throw badRequest` (`plan-service.ts:163`) → `auto-cancelled: plan compilation failed` (`reconcile.ts:287`). Declaring exactly the edges the owner wants would start **auto-cancelling multi-target changes that work today**.

The edges are also already declarable via `manifest.relationships` (`iac.ts:31-37,168`) — the second prize is not a new capability, only its consequences are new.

### 0.4 SCP cannot read a file out of a microservice repo

> v0.1 §2: *"It belongs in the repo, beside the placements and executor bindings a stack already declares."*

Nothing in SCP fetches a file **body** from git. The three discovery plugins read directory **listings** and extract exactly one fact — whether a directory contains one of five marker filenames (`github/src/index.ts:715,738,747-749`; gitea `:600-635`; gitlab `:519-568`). There is no base64 content decode and **no YAML parser anywhere in the tree**. `readManifestFile` is `JSON.parse` on a **local** `--manifest <path>` (`cli.ts:710-721`).

Worse, v0.1 contradicts itself: `DesiredStateManifestSchema` is authored in the **central IaC stack repo** and is **pruning and stack-scoped** (`plan-diff.ts:690-693`, `plans-repo.ts:203,972`) — so for A's repo to declare `componentUrn: A` it must own and prune A's objects. The two measured live stacks are `agentkit-org` and `agentkit-monorepo`; neither is per-microservice. Meanwhile v0.1's own justification — *"the people who know that A calls B are the people editing A"* — argues for the microservice repo.

### 0.5 Per-dependency semantics cannot ride on an edge's `properties`

The manifest accepts relationship `properties` (`iac.ts:35`) and synth emits them (`construct.ts:248`), but the server **silently discards them in four places**: `plans-repo.ts:467-471` maps only `{typeId, fromUrn, toUrn}`, `ResolvedManifestRelationship` has no properties field (`plan-diff.ts:62-66`), `PlanRelationshipDiffEntrySchema` has none (`iac.ts:217-225`), and the apply passes none (`plans-repo.ts:964-973`). The manifest validates, the apply succeeds, and nothing is written. Relationships also have no update path, so editing a `minimum` would diff as `noop`.

### 0.6 Three corrections to v0.1 §1's table

| v0.1 row | Reality |
|---|---|
| `depends_on` → toposort, "WAVE: B's whole wave completes before A's wave starts" | **False in stage mode.** The toposort (`topoLayers`) is reached only when there is **no** topology (`plan-compiler.ts:298-311`). In stage mode `depends_on` provides **no ordering at all** — it only *rejects* same-wave pairs (§0.3). |
| Release-topology `requiresFanIn` | **A dead flag.** Written, persisted and API-surfaced; read by **no** engine code. Sequencing is unconditional fan-in by construction (`reconcile.ts:598,925-928`). |
| `provides`/`requires` "+ `correlationKey`" | `correlationKey` is **not part of the predicate** — that is a jsonb containment probe on `{provides, targets}` (`coupling.ts:50`). `correlationKey` is display grouping and gates nothing. |

Only the `observed.rollout` row survived.

---

## 1. What "amer-gamma" and "10% → 50% → 100%" actually are

Two vocabulary facts decide the whole design, and v0.1 conflated them.

**A stage is a PLACE.** Per [GLOSSARY](../GLOSSARY.md) and [ADR-0026](../adr/0026-placements-and-derived-stage-names.md), a stage is a **derived name** — `<domain>[-<location>]-<env>` — computed from a `deployment-target` carrying `environment` and optional `region`. There is no stage entity and no stage table. The owner's `amer-gamma` is shorthand: `amer` is a *location*, the domain segment is mandatory, so the canonical name is e.g. `commercial-amer-gamma`.

**10% / 50% / 100% is NOT a stage — it is canary weight inside one place**, driven by Argo Rollouts. Owner ruling D1: assume the common shape is a single Argo Rollout per stage walking the weights on its own, *but the design must not assume it* — it is whatever each user configures.

Together these give the achievable guarantee: **SCP coordinates across places; Argo drives within a place.** The ask's "don't require the full 100% deployment" is delivered by **stage scoping** — B need only be done at `commercial-amer-gamma`, not at prod — plus an **optional weight qualifier** where a weight is observable (§2.2).

---

## 2. The design

### 2.1 The guarantee, stated so it can be kept

> **A's deploy at stage S is not TRIGGERED until, for every declared dependency B of A that applies at S, B's deploy at S is satisfied.**

Not "A is held at step N". Not "A pauses mid-rollout". A either starts at S or does not, and the reason is recorded.

This is **not** an amendment to [ADR-0008](../adr/0008-observe-enrichment-signals.md). SCP adds no verb, never sets a weight, never promotes or aborts a Rollout. It declines to make a call it was always free not to make yet — the same authority the executor-binding gate ([ADR-0006](../adr/0006-fail-closed-on-missing-executor-binding-for-purpose.md)) and freezes already exercise. ADR-0008's decision 3 is about *driving progressive delivery*; withholding a trigger is not driving.

### 2.2 What "satisfied" means — one universal test, one optional qualifier

**Universal (every executor):** B's wave target at S has `status = 'succeeded'`. That is `change_wave_targets.status`, which every executor produces — not an ArgoCD-only field.

**Optional qualifier, where observable:** a dependency may declare `minWeight: N`, satisfied when B's observed canary weight at S is `>= N`. This is what lets A proceed once B is at 10% rather than waiting for B's stage to finish. It reads `observed_state.rollout.weight` and is **best-effort by construction** (§2.4).

Two hard constraints on the qualifier, both measured:

- **`weight` is the only comparable axis; `step` is not.** `currentStepIndex` is an index into *that Rollout's own* `spec.strategy.canary.steps` (`argocd/src/index.ts:180-185,268`), so "B's step ≥ A's step" is meaningless unless both manifests declare identical step lists, which nothing enforces. `minWeight` is a percentage, and percentages compare.
- **`weight` is structurally absent for blue-green**, not merely version-dependent — a blue/green Rollout populates no `status.canary` at all (`argocd/src/index.ts:269-270`).

### 2.3 The declaration — CI push (ruling D2)

Two optional fields on the **existing** typed CI report channel, following the `provides`/`requires` precedent exactly (`packages/schemas/src/executors.ts:438-462`):

```ts
/** A component this release's component must not deploy ahead of, at any stage they share. */
export const StageDependencySchema = z.strictObject({
  /** The component depended ON — id or URN. Resolved at propose time; a typo is refused,
   *  not left as a silent forever-wait. */
  dependsOn: z.string().min(1),
  /** Optional: satisfied once the dependency's observed canary weight at the stage reaches this
   *  percentage, instead of requiring its stage deploy to finish. Best-effort — §2.4. */
  minWeight: z.number().int().min(1).max(100).optional(),
  /** Optional: restrict the coupling to certain places, by deployment-target id/URN.
   *  Absent = every stage the two components share. */
  atTargets: z.array(z.string().min(1)).optional()
});
```

Added as `stageDependencies?: StageDependency[]` to `ChangeReportRequestSchema` and `CreateChangeRequestSchema`, threaded through `genericHint` (`webhook-processor.ts:100-139`), **re-forwarded in the adapter branch** (`:186-193` — the one line that would silently drop it), and into `proposeChange` (`:330`).

**Scope is by deployment-target reference, not by stage-name glob.** v0.1's `atStages` glob cannot work: stage names are derived in exactly one place, on a UI read path (`component-pipeline.ts:126-134`), and a **replicated** deployment-target derives `stageName: null` outright — a name glob would silently match nothing at precisely the federation boundary where the coupling matters. A URN resolves; a derived display name does not. (If globs are later wanted as sugar, the specificity-precedence spec at `correlation.ts:44-88` must be copied verbatim — its absence already cost this project once.)

### 2.4 The three-branch verdict (ruling D3)

v0.1 framed this as fail-open vs fail-closed. The code makes it three cases, and they must be distinguishable in the Decision:

| Case | Verdict | Why |
|---|---|---|
| **B is not placed at S** | **satisfied** | A *declared* fact per [ADR-0026](../adr/0026-placements-and-derived-stage-names.md) D8 — `plan-service.ts:194-197` births such a wave `skipped`, and `plan-compiler.ts:164-176` cites a real prod-only component. Failing closed here would hold A forever for a **correct** configuration. |
| **B is placed at S and demonstrably behind** | **HOLD** | The only case that actually blocks. |
| **Signal unreadable** — not ArgoCD, blue/green, the extra API call failed, or no observation yet | **proceed, warn visibly** | Unreadable is the **default**, not the exception: only argocd produces rollout data, via a second call whose failure returns `undefined` with no marker (`argocd/src/index.ts:299-305`). Blanket fail-closed would hang releases on an RBAC misconfiguration that surfaces nowhere. |

The unreadable branch applies **only to the `minWeight` qualifier**. The universal `status = 'succeeded'` test is always readable, because every executor writes that column — so an unreadable weight degrades the dependency to the universal test, **not** to "satisfied".

### 2.5 Freshness — no rule may say "B HAS REACHED 10%"

`updateWaveTargetObserved` **overwrites the jsonb in place** (`wave-targets-repo.ts:233-241`) and [ADR-0008](../adr/0008-observe-enrichment-signals.md) decision 1 explicitly deferred a time-series projection. Only B's **single last-observed snapshot** exists, it stops refreshing the moment the target terminalizes (`reconcile.ts:801`) so its age is unbounded, and it is NULL for the newest change until its first poll (`plan-service.ts:203-217`) — i.e. blank exactly when B starts releasing again.

The qualifier is therefore phrased **"B is currently observed at ≥ N"**, with an explicit freshness bound measured off **the reading's own timestamp, stamped into the `observed_state` payload where it is written** — never off `last_observed_at`, which dates the POLL: `updateWaveTargetObserved` refreshes that column unconditionally while writing the payload only when `observedStateFrom` returned something, and it returns `undefined` for a status carrying no stateRef, no images and no rollout (the argocd plugin's 404 shape, `index.ts:523-524`). A deleted or renamed Application would therefore freeze the weight while its poll timestamp kept moving, and the bound would never fire. A snapshot older than the bound is *unreadable* (§2.4 branch 3), not *satisfied*.

**One hazard to close first.** A paused Argo Rollout may aggregate to Application health `Suspended`, which SCP maps to `succeeded` (`argocd/src/index.ts:214-226`, comment at `:212`) — terminalizing the target and freezing its weight. If so, B paused at 10% reads as **done**, and the stored weight stays 10% forever even after someone promotes to 100%. There is **no test for `Suspended` anywhere**. A pinning test lands before anything reads this mapping (§5 increment 0), and whether Argo actually aggregates that way must be checked against a live instance — it cannot be established from this tree (the vendored `install.yaml` carries no Rollout health Lua).

### 2.5a MEASURED, 2026-08-05: the live estate runs no Argo Rollouts at all

§2.5 called the `Suspended` mapping the largest correctness risk and said a live instance had to settle it,
because the tree could not. It has been settled, against the homelab k3s cluster that runs the estate:

```
kubectl get crd rollouts.argoproj.io   ->  Error from server (NotFound)
kubectl get rollouts -A                ->  the server doesn't have a resource type "rollouts"
```

101 CRDs installed, none of them Argo Rollouts; no rollouts controller in any namespace; every AgentKit
and CommanderSCP app is a plain Argo CD `Application` sync. Three consequences, none of which change the
design but all of which change what to expect from it:

1. **The `Suspended` hazard is latent, not live.** There are no Rollouts to pause, so nothing can
   currently terminalize at a partial weight. The pinning test (increment 0) still guards SCP's half of
   the mapping for whenever Rollouts are adopted; it is insurance, not a fix for a present bug.
2. **`minWeight` has no signal source on this estate today.** `observed.rollout.weight` is populated only
   from a Rollout manifest, via the argocd plugin's second API call. No Rollouts means no weight, so every
   `minWeight` degrades to the universal `succeeded` test — §2.4's unreadable branch, behaving exactly as
   designed, but the qualifier is inert here until progressive delivery is actually installed.
3. **The owner's "10% then 10%" has no 10% to observe yet.** A deploy on this estate is binary: an
   `Application` syncs or it does not. The ladder in §7's first non-goal is therefore further away than a
   missing SCP feature — the weights themselves do not exist.

This is recorded rather than left as a caveat because the opposite belief is the dangerous one: a reader
who assumes `minWeight` is doing something here would mistake "the universal test passed" for "the canary
threshold was honoured."

### 2.6 The dependency graph (ruling D4)

Every declared dependency is also materialised as a **`depends_on` edge** between the two components — the edge type impact analysis already consumes (`named-queries.ts:40` `DEFAULT_IMPACT_TYPES = ["depends_on","consumes","hosted_on"]`). This is the "stop guessing at dependency charts" half of the ask, and it is worth stating plainly: **it cannot be inferred, only declared.** The ArgoCD resource tree models only `{group,version,kind,namespace,name,status,health}` (`argocd/src/index.ts:139-147`); discovery proposes no dependency edges; no scan/SBOM code creates graph edges. Nothing SCP observes today carries inter-component dependency data.

**The same-wave check is replaced, not deleted.** `plan-compiler.ts:263-280`'s `topology_violates_dependency` is today the only thing preventing two dependent components deploying in parallel. Once the per-target hold (§3.3) enforces ordering *within* a wave, that check becomes redundant **and** harmful (§0.3). It is replaced by the hold, in the same change, with a test pinning that a dependent same-wave pair now compiles and then serialises.

**Replaced means the SAME SET, and that has to be said in set terms or it is a silent regression.** The removed check keys on the **edge**, not on a declaration: `loadDependsOnEdges` (`plan-service.ts:36-47`) returns every `depends_on` edge with **both endpoints in the change's own target set**, and refuses any such pair sharing a wave — whatever wrote the edge (a seed at `seed.ts:117`, an IaC manifest at `iac.ts:31-37`, an operator, or an *earlier* change's declaration). A hold reading only `properties.stageDependencies` would therefore order **none** of those: the pair would compile into one wave and both targets would fire in parallel, with no hold and no record. So the hold's dependency set per target is the **union** of

- the change's declared `stageDependencies`, with their `minWeight`/`atTargets` qualifiers; and
- the in-target-set `depends_on` edges, with **no** qualifiers — the plain `succeeded` test — reusing `loadDependsOnEdges` itself so the compiler and the hold cannot drift apart.

**And no wider.** An edge with an endpoint *outside* the change's target set ordered nothing before and orders nothing now — the property that keeps a bulk edge import from making every edge in the org a release gate. Two corollaries worth pinning: an edge-derived verdict is marked `source: "edge"` (absent for a declared one, so no existing hold Decision changes shape) because an operator held behind a coupling their CI never wrote needs to know the remedy is a graph edge; and a declaration may only ADD to, or narrow the scope of, its own coupling — it may never weaken the pair's edge. `atTargets` narrows *where* it applies (an in-target-set pair whose declaration is scoped elsewhere still serialises, strictly weaker than the 400 that input used to get), and `minWeight` is a *relaxation* of the plain `succeeded` test the edge asserts, so for a pair carrying both the strictest applicable constraint wins — the edge's — with the declared minimum recorded as superseded. Otherwise `minWeight: 1` is a free way to neutralise an ordering somebody else wrote.

**One clause cannot be handed over: a CYCLE, so it stays a compile-time refusal.** Stage mode has no toposort, and after the same-wave check goes there is nothing between a mutual pair and the hold — where each waits for the other's wave target to leave `pending`, forever, silently. `compileStages` refuses a `depends_on` cycle among the change's own targets **placed at the same deployment-target**, naming the members and the place; `plan-service.ts` turns it into a 400 and `reconcile.ts` into the change's epitaph. Scoped per place because that is where the hold looks: a cycle whose members are never co-placed resolves to `not_placed` on both sides and deadlocks nothing, so refusing it would reject a working configuration.

Two consequences to design around, both measured:

- **`graph.dependentIds` is a live CEL policy input** (`governance/evaluate.ts:125-133`). Bulk edge writes can flip existing policy verdicts. The rollout must be observable before it is broad.
- **The estate is already inconsistent**: `seed.ts:117` uses `depends_on` service→service and `:122` uses `consumes` component→component. This design writes `depends_on` for component→component and leaves existing `consumes` edges alone; impact analysis reads both, so nothing is lost. Named here so the next reader does not "fix" one into the other.

---

## 3. Where it is enforced

### 3.1 Not the wave gate (§0.2), and not the `waiting` state

The shipped `provides`/`requires` engine is the wrong grain and has no legal edge for this. Its check runs **once**, on `coordinated → executing`, and parks the **whole change** (`reconcile.ts:348-377`) — so A would be held out of **dev** because B is behind in **gamma**. Its predicate requires the provider to be in `validating`/`accepted` (`coupling.ts:54`) — finished everywhere, the exact thing the ask rules out — and its `at` matches the provider change's `properties.targets`, always a **component** set (`changes-repo.ts:259`), never a stage. There is also no `executing → waiting` edge (`transitions.ts:49-52` lists exactly three).

This design leaves that engine untouched.

### 3.2 Per-(component, stage), because that is the grain of the ask

A and B release from **separate pushes to separate repos** — different changes, each with one target (§0.3). The coupling is therefore a **cross-change, stage-scoped** probe: *"what is B's most recent wave target at this deployment-target, and what is its status and observed weight?"*

### 3.3 The seam: the per-target loop in `reconcileExecutingChange`

`reconcile.ts:814-830`, immediately inside the `pending | triggering` branch, beside the existing backoff gate. Two invariants are copied from it verbatim, and both are load-bearing:

1. **The target is counted as still in flight BEFORE the `continue`** (`:815-817`). A held target has not finished; skipping without this makes the wave report complete while it never ran.
2. **Skip before taking the advisory trigger-claim lock**, as the backoff gate does, so a held target costs no lock and no binding re-read.

And **one thing the backoff gate never needed**, because a backed-off target is one the executor has already been handed and a held one is not: a held target must not keep an **already-failed** wave alive. The loop's "is anything still in flight" test therefore counts targets rather than setting a boolean, and asks whether every target still in flight is a *held* one; when it is and any target has failed/aborted/`no_executor`, the wave terminalizes as `failed` and the change takes the ordinary failure path (auto-rollback or the park). Holding a dependant on a doomed wave buys nothing — its dependency cannot arrive within a wave whose verdict is already decided — and with the boolean alone that wave never reached `markWaveTerminal` at all: no auto-rollback, no park, no epitaph, and a change wedged in `executing` occupying a `BATCH_LIMIT` slot forever, which is a silent regression on the loud 400 §2.6 removed. The held target is still never triggered on the way there; it is left `pending` on the terminal wave.

The dependency set the seam evaluates is the union described in §2.6 — the change's own declarations **plus** the `depends_on` edges between two of its own targets. The edge half is loaded **lazily and once per change per tick**, and a single-target change never loads it at all (both endpoints must be in the target set, so one target can only produce a self-edge). That matters because 277 of 281 measured changes have exactly one target: the ordinary release still pays nothing for a feature it does not use, which is the same inertness property the declaration parse has.

Unlike the backoff gate, the hold **writes a Decision** (charter principle 6). The Decision's `inputContext` must be **content-stable**: the dependency set, the resolved target, and the per-dependency verdict — **no live weight, no timestamp**. Otherwise it re-opens the 1.44 GB/day write-amplification bug ([ADR-0024](../adr/0024-decision-and-audit-retention.md); `decisions-repo.ts:272-277`), where a byte-identical Decision is rewritten every tick forever. **Persist on change only.**

---

## 4. Federation (D5 — CLOSED by the owner's standing ruling of 2026-07-15)

The gate is only computable where **both** components' wave targets were polled by the **same instance**. Nothing journals `change_wave_targets` or `observed_state` — `JournalEntryKindSchema` has nine kinds and none is wave-target-shaped (`federation.ts:43-53`) — and reconcile skips foreign-origin changes outright (`reconcile.ts:570`). Separately, `relationship_upsert` ships only under sync scope `full` (`federation/scope-filter.ts:24-48`): a `policies_only` / `changes_only` / `status_only` outpost never receives the dependency edges and would evaluate to "no dependencies" **silently**.

That silence is the worst available answer. Recommendation: evaluate the gate **where the deploy is coordinated**, and have an outpost whose sync scope withholds the inputs **refuse explicitly** — a named, visible verdict — rather than pass. This needs a ruling before the federation increment; it does not block increments 0–3, which are single-instance.

### 4.1 What shipped: the declaration is STRIPPED on promotion import

D5 is still open, but the reader shipped in increment 3 — and that combination is not neutral. A promoted change is re-proposed **locally**, with this domain's own origin, so the foreign-origin skip does **not** exclude it and the outpost really does evaluate the coupling. Under a sync scope narrower than `full` the depended-on component is not present locally at all, so every verdict resolves to `not_placed` → **satisfied**: exactly the silent, unrecorded fail-open this section calls the worst available answer, shipped by default.

So `applyPromotionImport` now strips `properties.stageDependencies` exactly as it strips `requires`, on the established precedent ([coupled-pipelines.md](coupled-pipelines.md) §8 Q2), and writes a `stage_dependency` Decision on the imported change recording what was stripped and that the coupling was **enforced upstream at the commander** — whose promotion of the bundle *is* the go-ahead. A promotion that declared nothing writes nothing and stays byte-identical.

**This is the ruling, not a deferral — it was already made.** Owner, 2026-07-15, on the sibling `requires` mechanism: *"While we can transfer both artifacts to the outpost for release, it should be the commander that gives the go ahead to actually release. Though the outposts should be able to handle the rollback themselves if there's issues."* ([coupled-pipelines.md](coupled-pipelines.md) §8 Q2.) The promotion of the bundle **is** the go-ahead, so the outpost must not re-evaluate: redundant at best, deadlock at worst. Stripping on import is exactly what `requires` does and for exactly the same reason. `applyPromotionImport` remains the seam a future cross-outpost coupling would change — a shape §8 Q2 already records as a non-goal.

---

## 5. Increments

Each is independently shippable and behaviour-preserving.

- **0 — Pin `Suspended`. SHIPPED**, and the live-Argo check is now DONE — see §2.5a. A test asserting `phaseAfterFinishedSync("Suspended") === "succeeded"` before anything reads it (§2.5), plus a live-Argo check of how a paused Rollout aggregates. *Largest correctness risk in the design; costs almost nothing.*
- **1 — The declaration channel. SHIPPED.** `StageDependencySchema`, the two schema fields, `webhook-processor` threading (including the adapter-branch re-forward), propose-time resolution of `dependsOn`/`atTargets` to object ids, CLI flags, `pnpm gen`. **Inert** — nothing reads it yet.
- **2 — The graph edges. SHIPPED.** Materialise declared dependencies as `depends_on` edges; replace `plan-compiler.ts:263-280`'s same-wave rejection, with a test asserting the pair now compiles. Delivers the dependency-chart half on its own. Keep the **cycle** refusal (§2.6) — it is the one clause the hold cannot take over.
- **3 — The hold. SHIPPED.** The per-target check at `reconcile.ts:814-830`, the three-branch verdict, the persist-on-change Decision, the freshness bound. Its dependency set is the union in §2.6, declarations **and** in-target-set edges; a hold that reads only declarations does not close increment 2's window.
- **4 — Surfaces. NOT SHIPPED — the one increment still outstanding.** `explain` and a CLI sub-command naming the held dependency, the stage badge in the component-pipeline view, the watchdog arm.
- **5 — Federation. SHIPPED** (strip on promotion import), and §4 is now closed by the owner's standing ruling rather than pending one.

**Groundwork found during grounding, worth doing regardless** — each small, independent, and currently silently broken: the discovery relationship channel emits `part_of`, a type registered in **no** migration, so discovery→graph edges have never worked end to end (`github:765`, `gitea:652`, `gitlab:587`; the existing tests pass `relationships: []` and prove nothing); `unownedProjectionDeclarations` (`plan-diff.ts:703-711`) checks two of three projection collections, missing placements — a live instance of this project's own census rule; `scp plan` never prints placement diffs (`cli.ts:775-780`), so an operator approves a diff they were never shown; and the demo estate is 3 components, so nothing anywhere exercises the owner's shape.

---

## 6. Owner rulings, 2026-08-05

| # | Question | Ruling |
|---|---|---|
| **D1** | How is 10→50→100 implemented? | **Canary weight inside one Argo Rollout** is the assumed common shape — *"though ultimately it's however the user configures their rollout."* The design therefore enforces at **stage** grain and treats weight as an **optional, best-effort qualifier** (§2.2), degrading per-executor and per-strategy rather than assuming one shape. |
| **D2** | Where is the dependency declared? | **CI push** via `scp change-source report`, following the `provides`/`requires` precedent (§2.3). Not the IaC manifest (wrong repo, prunes, drops edge properties — §0.4/§0.5); not a new repo-file reader (six pieces of net-new machinery, no parser in-tree). |
| **D3** | What happens when the gate cannot evaluate? | **Split by cause** (§2.4): not-placed = satisfied; unreadable = proceed with a visible warning; only placed-and-behind holds. |
| **D4** | Which edge type carries the dependency? | **Reuse `depends_on`**, replacing `plan-compiler.ts:263-280`'s same-wave check rather than deleting it (§2.6). |
| **D5** | Commander or outpost, and what on missing data? | **CLOSED — already ruled 2026-07-15**, for `requires`, and the reasoning transfers unchanged: the commander evaluates and its promotion is the go-ahead; the outpost does not re-evaluate. Raising it again was my error, not an open question (§4). |

## 7. Deliberate non-goals

- **No per-step / per-weight hold of a running rollout.** §0.1. Not deferred — foreclosed by the verb set and ADR-0008.
- **No new executor verb**; no `promote`/`pause`/`resume`/`abort` use.
- **No version matching.** The rule is "B is deployed at S", not "B is deployed at S **at the version A expects**". A@v2 depending on B@v2 specifically is a coherent future ask and a real gap; named here so it is a known omission rather than an assumed feature.
- **No stage-name globs.** §2.3 — the derived name is `null` for replicated targets.
- **No time-series of observed rollout state.** ADR-0008 deferred it; §2.5 works within a single snapshot plus a freshness bound instead.
- **No campaign changes.** Campaigns already order `depends_on` members (`campaign-plan-service.ts:52,69-73`) but pass **no** `placements`, so a campaign can never be stage-shaped, and its ordering requires the dependency's whole member change to terminalize — the thing the ask rules out. Campaigns remain the operator-driven path; this is the automatic per-push one. Stated so a second ordering mechanism is not built beside one that half-works.
