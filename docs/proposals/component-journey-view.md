# Proposal: the component journey view — source → build → deploy

**Status:** v0.7, 2026-09-14 — v0.1's design was accepted and built out (§7); §8 adds the owner's two release paths and the per-change path selection they require, with §8.7 D1–D3 **decided by the owner 2026-09-12** and §8.8 sequencing the build. §8.9–§8.11 record what building step 1 found, including **§8.11, a blocker on D3** — resolved by **§8.12 (owner, 2026-09-14): re-scope D3 to the build half; Path A is two correlated changes and the discriminator is the correlation key, not the routing Type.** §8.8 steps 1 and 2 are **landed** (§8.10, §8.13). **§8.14 STOPPED step 3** — measured through the real reconcile loop, option A does *not* avoid the `no_executor` block, because the block is on the image arm itself, and `source_mappings.type` turns out to be one column doing two jobs. **§8.15 resolves it (owner, option ii, built): the journey is its own field, `source_mappings.journey_kind` (migration 0112)**, so a service repo stays typed `configuration` — which is what routes it — and declares its journey separately. §8.2's rendering defect is fixed with it. What remains of step 3 is a LABELLING pass over the estate, which changes no routing. **§8.16 corrects two claims §8.10/§8.13 made**: a push's correlation key named the BRANCH, so every push to `main` shared one coordinated-change group (34 unrelated commits in one, measured live) and D2's fan-out synthesis was dead code in production while its tests passed on a different code path. **Proposed, pending review.**
**Role:** Extends the component pipeline view (`coordination-ui-views.md` §2) from the deploy segment it renders today to the whole journey a change makes: the repo it comes from, the build that produces the artifact, and the stages it rolls through.
**Relates to:** [ADR-0007](../adr/0007-executor-binding-type-taxonomy.md) (Type taxonomy — the routing key), [ADR-0017](../adr/0017-ownership-refinement.md) (build devolves to the originating outpost; the commander never runs build), [ADR-0026](../adr/0026-placements-and-derived-stage-names.md) (placements, derived stage names), [ADR-0006](../adr/0006-fail-closed-on-missing-executor-binding-for-purpose.md) (no-executor fail-closed), `promotion-and-execution-model.md` (the authoritative end-to-end flow this view is trying to draw), `coupled-pipelines.md` (`provides`/`requires`), `coordination-ui-views.md` §2.

Owner ask, 2026-08-10, on seeing the corrected pipeline view: *"the overall pipeline is very incomplete. Where are all the repos and such? agentkit-bootstrap comes from a repo right? When someone makes a change there, it should affect this right?"* — and, asked how far to go, **the full source→build→deploy journey**, not just a sources header. Then, on seeing it running: *"The component pipeline is missing: 1. The infra pipeline 2. The software pipeline 3. The code repos 4. The image/RPM/etc repo."*

## 0. This is not a new design — it is the rest of an accepted one

`coordination-ui-views.md` §2 already specifies all four, verbatim:

> Component-scoped, two lanes **top-to-bottom**:
> - **App release** — `Build & test` → `Image registry` → `Config bump` → `Gamma` → `Prod`. Each stage **links to its source or executor** (git source repo, image registry, git config repo, Argo CD app). …
> - **Infra · correlated** — an infra change directly correlated to the component runs as a **parallel lane** beside the app release.

What shipped is the **tail of one lane** — `Gamma → Prod` of App release. So the four items map onto the accepted design as: (1) the Infra lane, (2) the App-release lane's head, (3) the "git source repo" / "git config repo" stage links, (4) the `Image registry` stage. No new design decision is needed for the *shape*; what this document adds is the measured grounding for which parts can be built honestly today, and one correction (§2) the accepted design does not settle.

### Where each of the four stands

| Owner's item | Accepted design | Buildable now? |
|---|---|---|
| 1. Infra pipeline | "Infra · correlated" parallel lane | **Partly, as of 2026-08-03.** The `infrastructure`-Type binding is Layer A and now renders per stage (see §0.1). The *correlated infra change as its own lane* needs the correlation rule settled — `correlationKey` exists; which infra changes count as "directly correlated to this component" does not. **SUPERSEDED, §7 (2026-08-24): the infra lane shipped as its OWN TAB instead of a parallel lane** (`ComponentInfrastructurePage` / `/components/$id/infrastructure`, `apps/web/src/routes/component-pipeline.tsx`) — Q2's correlation rule is still open, but the shape question this row asked is answered. |
| 2. Software pipeline | "App release" lane | **Partly.** The `image`-Type binding is Layer A and now renders. The `Build & test` → `Image registry` → `Config bump` CHAIN is `provides`/`requires` + `correlationKey`, which §"Layer A" calls buildable — but **0 changes on the estate carry either**, so the chain renders empty until something populates it (§1). **UPDATED, §7: the Build tile now renders BOTH cases (§2's decision) — coordinated when a `build`-Type binding resolves, upstream with the observed CI run otherwise** — the chain populating itself is still open. |
| 3. Code repos | "links to its source or executor (git source repo …)" | **Yes, fully.** `source_mappings` (durable rule) + `changes.source_ref` (the observed CI run). Layer A, and the data is rich. |
| 4. Image/RPM/etc repo | `Image registry` stage, "shows the **scan result**" | **No, not honestly — AS MEASURED 2026-08-03.** The registry *ref* is Layer A, but on this estate the two `image` bindings have EMPTY `external_ref`s, so there is nothing to link to. Contents, digest and scan verdict are explicitly **Layer B** — "per-stage version / image digest" and "gate verdicts with reasons (scan result)" are listed there as observe-enrichment SCP does not yet capture. Building this stage today paints a box labelled "unknown" on every component. **SUPERSEDED, §7 (2026-08-24): this row is no longer true.** `publishes_to` gave the registry stage a real place to link to (never the empty `image`-binding `external_ref` this row worried about — see §7's Q3), and observe-enrichment landed for digests, SBOM and scan verdicts. The registry AND Scan & sign tiles are both built and shipped; "paints a box labelled unknown" no longer describes them. |

### 0.1 A defect this review found, fixed 2026-08-03

`getComponentPipeline` read `bindings[0]` and rendered that alone. `UNIQUE(org_id, target_object_id, type)` exists precisely so ONE target can carry an `image` build, an `infrastructure` plan/apply and a `configuration` sync at once (ADR-0007 — Type IS the routing key), and `listExecutorBindingsForTarget`'s own docstring describes what it returns as "every pipeline … (all Types)". Taking `[0]` silently collapsed a component's several pipelines into one, with no sign the others existed — which is exactly items 1 and 2 as the owner experienced them. The response now carries `bindings[]` (ordered by Type) and the card renders one row per pipeline, each labelled with its Type. Both live deployment-targets carry `image` + `configuration` today, so this was live, not hypothetical.

---

## 1. What exists today — measured on the live estate, 2026-08-03

Everything in this section is a count from the homelab commander's database, not a reading of the code.

| Fact | Measured |
|---|---|
| `source_mappings` rows | **148**, every one `source_kind = github`, every one `type = configuration` |
| …for `agentkit-bootstrap` | **3**: `AgentKitProject/agentkit` (no path), `jag8765-personal/homelab-gitops` (no path), `jag8765-personal/homelab-gitops` scoped to `agentkit-selfhost/bootstrap/**` |
| `executor_bindings` by Type | **63 `configuration`**, **2 `image`** |
| …what the `image` bindings hang off | both on **deployment-targets** (`gamma`, `prod`), not placements; both with an **empty `external_ref`** and `plugin_module = github` |
| changes by Type | **332 `configuration`**, 11 untyped, **0 `image`** (or any other `build` Type) |
| changes carrying `provides` / `requires` | **0** |
| changes carrying real source provenance | **336 of 343** have `changes.source_kind = github` **and** a `source_ref` naming the GitHub Actions run — repo, run id, URL, workflow name, workflow path |
| graph object types in use | 13 — `change`, `component`, `coordinated-change`, `deployment-target`, `execution-system`, `organization`, `placement`, `policy`, `release-topology`, `service`, `service-account`, `team`, `user`. **There is no `artifact` object type.** |

Three conclusions follow, and they shape the whole design:

**(a) The SOURCE end is fully derivable, twice over.** Durably, from `source_mappings` — "a push matching this repo/path becomes a release of this component, of this Type". Observationally, from `changes.source_ref` — the actual CI run that produced each change, with a link straight to it. Neither is surfaced anywhere in the UI today.

**(b) The BUILD arm is declared but has never run.** Zero changes of any `build` Type exist, and zero changes carry the `provides`/`requires` coupling that `coupled-pipelines.md` designed to sequence an `image` build ahead of a `configuration` deploy — a mechanism that is built, tested (M12 P4B) and shipped, and has never been exercised in production. The two `image` bindings have empty `external_ref`s, so they name no external job.

**(c) On this estate, build is UPSTREAM of SCP, not a stage within it.** GitHub Actions builds and pushes; SCP observes the *completed workflow run* and creates a `configuration` change from it. That is a legitimate BYO-CI arrangement — `promotion-and-execution-model.md` §1 explicitly supports "BYO CI (GitHub Actions / GitLab) coordinated instead where present" — but it means a view that draws Build as a stage SCP owns would be **overstating what the platform coordinates**, which is the one thing charter principle 1 does not permit a UI to do.

---

## 2. The design question this forces (owner decision needed)

> **Is build a STAGE of a component's pipeline, or the SOURCE of it?**

Both answers are already sanctioned by accepted design, for different orgs:

- **Build as source (today's estate).** BYO CI owns build. SCP's journey begins when a run completes. The head of the pipeline is the repo + the run; there is no build stage SCP gates, and drawing one would be fiction.
- **Build as stage (the bundled/coordinated arrangement).** The originating outpost's Argo Workflows (or a coordinated BYO pipeline) runs build as a step SCP triggers, observes and gates, producing an `image`-Type change that `provides` an artifact key which the `configuration` change `requires` (ADR-0017 §2, `coupled-pipelines.md`).

The proposal's answer: **the view must render whichever is true for the component in front of it, and say which** — the same `stageSource`-style honesty the deploy segment just adopted. It must never draw a build stage that nothing will run, and it must never hide a build stage that SCP genuinely coordinates. Concretely, a `build`-Type executor binding resolvable for the component is what makes the build segment real; its absence means build is upstream, and the view says so in words.

---

## 3. The journey, segment by segment

The view becomes three segments over one ordered spine. Nothing below adds a graph concept: every segment is a projection of rows that already exist.

### Segment 1 — Source (durable)

One card per `source_mapping` matching this component: `source_kind`, `repo_pattern`, `path_pattern`, and the **Type** the mapping produces. This is the answer to "when someone makes a change there, does it affect this?" — stated from the rule, not inferred from history.

Two honesty rules fall straight out of the measured data:

- **A mapping with a null `path_pattern` matches the WHOLE repo**, and must render as such rather than as a blank cell. `agentkit-bootstrap` has exactly this: any commit anywhere in `jag8765-personal/homelab-gitops` maps to it. That is very likely a configuration mistake, and the view surfacing it is a feature, not a side effect.
- **A component with NO mapping can never be released from a push at all.** It is the source-side twin of the unplaced stage — the loud, greyed "nothing arrives here" card.

### Segment 2 — Build (observed, or absent)

Two sub-cases, distinguished by whether a `build`-Type executor binding resolves for the component:

- **Coordinated build** — the binding exists: draw a real stage, with the execution system, the external ref, and (once one runs) the `build`-Type change and its status. This is where the `provides`/`requires` coupling renders as the arrow into the deploy segment.
- **Upstream build** — no binding: draw a single "built upstream" marker carrying what SCP *did* observe, which is a lot — `changes.source_ref` gives the workflow name, the run id and a link to the run. It reads "GitHub Actions · CI · run 30858160395 ↗", not "build: unknown".

The distinction is the whole point of §2, and it must be visible, not encoded in styling.

### Segment 3 — Deploy (built, shipped 2026-08-03)

The topology's waves × the component's placements, with unplaced declared stages rendered greyed — the fix this proposal extends. Unchanged.

### The spine

One contiguous `order` across all three segments, exactly as the deploy segment's `order` already works, so the client sorts once and never infers an interleaving.

---

## 4. What is NOT derivable, and must render as unknown

Named explicitly so nothing here ships as a confident blank (the rule the version staircase already follows):

| Wanted | Why it is not available |
|---|---|
| The **artifact** a build produced, as a first-class thing | There is no `artifact` object type. Digests and refs travel on changes and promotion manifests (metadata-only bundles, ADR-0019); the graph has no node to hang a version staircase off. This is the same gap `machine-image-publication.md` names as `derived_from` provenance. |
| Per-stage **version** | `observe()`-captured version/digest — `coordination-ui-views.md` Phase 4a, unbuilt. Already rendered "not observed yet". **BUILT, 2026-08-25** (commit `33c3e3a`): `component-pipeline.ts`'s `currentsByPlacement` now derives each stage's version from its newest `change_wave_targets.observed_state` via the shared `preferredObservedVersion` helper — real deployed image preferred over git revision, server and web sharing one derivation. Still renders `null` + `"version"` in `unknownFields` when nothing has ever been observed at a stage; that half of this row's rule is unchanged. ADR-0045's Context section cites this same Phase 4a as already-landed groundwork for the artifact-object-type gap it closes — this row is no longer that gap, only the ARTIFACT row above still is. |
| **Test** results as a distinct segment | Build and test are one step in `promotion-and-execution-model.md` §1; SCP consumes pass/fail as gate evidence, and there is no separate test record to draw. |
| Which mapping produced a **given** change | `changes.source_ref` names the run, and `source_mappings` names the rule, but nothing correlates the two after the fact. Reconstructing it by re-matching the pattern would be a guess presented as a record. |

---

## 5. API shape

Additive to `GET /components/{idOrUrn}/pipeline`, for the same reason the deploy fix was additive — `/v1` is additive-only, and widening an existing required response field is an oasdiff ERR (measured, not assumed; see `ComponentPipelineResponseSchema.unplacedStages`).

- `sources: ComponentPipelineSource[]` — one per matching `source_mapping`: `sourceKind`, `repoPattern`, `pathPattern` (nullable, and **null means the whole repo**), `type`, `order`.
- `build: ComponentPipelineBuild | null` — `{ kind: "coordinated", binding, current } | { kind: "upstream", lastObservedRun }`, where `lastObservedRun` projects `changes.source_ref`. Null only when neither is knowable.
- No change to `stages` / `unplacedStages`.

---

## 6. Open questions for review

1. **DECIDED (owner, 2026-08-10) — per component, and the view says which.** A component with a
   `build`-Type binding shows a coordinated Build stage; one without shows "built upstream" plus the
   CI run observed in `changes.source_ref`. Both arrangements are sanctioned by
   `promotion-and-execution-model.md` §1, so the product does not have to choose one — but the VIEW
   must state which applies, or the two become indistinguishable. On this estate today every
   component is the upstream case (0 build-Type changes; all 148 source mappings `configuration`).
   **BUILT, §7 (2026-08-24): the coordinated/upstream split shipped with the Build tile itself; the
   "CI run observed in `changes.source_ref`" half of this decision — the part that was still just a
   sentence — is what `observedRun` builds.**
2. **What makes an infra change "directly correlated to the component"** (item 1's lane)? `correlationKey` is the mechanism; the rule is not written down anywhere. Without it the infra lane cannot be drawn from data.
   **DECIDED, §7 (2026-08-24) — not `correlationKey`.** The owner's rule: an infrastructure change is
   correlated to a component when its wave/bound target names a deployment-target one of the
   component's placements ALSO names, or the component is `hosted_on` it; a `provides`/`requires`
   coupling ADDITIONALLY correlates, rendered with a distinct label. See §7's "What this increment
   adds" for what shipped against this rule.
3. **DECIDED — the two `image` bindings are to be DELETED.** Provenance settled it: hand-created
   2026-07-17 at 15:37 and 15:41 with deliberate instance names, inline config, no execution-system —
   someone starting the build arm on the day ADR-0007 was decided, and stopping. Nothing emits
   `image`-Type changes, so they are unused; and they are not inert, because `reconcile.ts`'s
   `targetRef: claim.externalRef ?? targetObjectId` means the first such change would resolve (ADR-0006
   fail-closed never fires — there IS a binding) and dispatch the deployment-target's UUID where a repo
   belongs. Removal is via the audited route, not SQL: `DELETE /v1/executors/{target}/binding?type=image`.
   **STILL OPEN, §7 (2026-08-24): decided, not yet done.** This is an ESTATE ACTION (a live homelab
   DELETE call), not a code change — it is pending operator credentials/execution, not a design
   question.

4. **Superseded — does the empty `external_ref` mean anything** — a half-finished import, or a deliberate placeholder? It decides whether item 4's registry stage can ever link anywhere, and whether those bindings are live pipelines or dead rows.
4. **Item 4 is Layer B and cannot be built honestly first.** The registry stage's whole value is the digest and the scan verdict, and SCP captures neither. Recommend it waits on observe-enrichment rather than shipping a permanently-"unknown" box.
   **SUPERSEDED, §7 (2026-08-24): observe-enrichment landed — see §7's shipped list. This
   recommendation was followed, not abandoned: registry/scan&sign were built AFTER this, once the
   enrichment existed, not instead of it.**
5. **Suggested build order**, each independently shippable: **(a)** source repos — Layer A, full data, answers the literal question; **(b)** the build/deploy chain via `provides`/`requires`, which also needs something to start populating it; **(c)** the infra lane once Q2 is settled; **(d)** the registry stage with observe-enrichment.
   **FOLLOWED, §7: (a), (d) and the Build tile's coordinated/upstream split shipped, in roughly this
   order. (b) and (c) are the two items still open — see §7.**

---

## 7. Reality as of 2026-08-24

v0.1's design (§§1–6) was accepted and built out in the batches §6#5 suggested. This section is an
annotation, not a rewrite: §§1–6 are left as measured 2026-08-03/08-10 and marked SUPERSEDED/BUILT
inline where a since-shipped fact changed their answer; nothing above was deleted.

### What shipped since v0.1

- **Source tiles (§3 Segment 1), including the two honesty rules §3 calls out.** One card per
  `source_mapping`, with the null-`path_pattern` ("whole repo") and null-ref ("any branch") cases
  rendered as loud amber warnings rather than blank cells (`SourceNode`,
  `apps/web/src/routes/component-pipeline.tsx` — the "matches the whole repo" / "any branch" copy),
  and a component with zero mappings drawn as the loud "nothing arrives here" card §3 asked for.
- **The coordinated-vs-upstream Build tile (§2's decision, §3 Segment 2).** `BuildNode`
  (`apps/web/src/routes/component-pipeline.tsx`) draws a real stage per resolved `build`-Type binding
  when one exists, and states "No build executor is bound — this component's artifact is built
  upstream of CommanderSCP" when none does — the §2 distinction rendered as words, not styling, as
  required. `laneNodes` gates the whole Build/Registry/Scan&sign chain on `buildsHere` (a resolved
  binding OR a build-category source mapping).
- **The registry tile (item 4's `Image registry` stage), off `publishes_to` rather than the empty
  `image`-binding `external_ref` §1/§6#4 measured as dead.** `registryForComponent`
  (`apps/server/src/coordination/component-pipeline.ts`) reads the component's outgoing
  `publishes_to` edge to an `execution-system`, resolved per site; `RegistryNode`
  (`apps/web/src/routes/component-pipeline.tsx`) renders `declared`/`ambiguous`/`none` as stated
  facts, never a guess at where an artifact might have landed.
- **Artifact facts and Scan & sign (item 4's "shows the scan result", §4's "per-stage version" scope
  narrowed to what IS captured).** `artifactFactsForComponent`
  (`apps/server/src/coordination/artifact-facts.ts`) picks the newest digest-carrying change and
  projects its digests, SBOM reference, scan verdicts (reduced per §9.3's own rule — producer
  identity, latest answer wins, instance floor) and the E6 export-gate re-evaluation; `RegistryNode`'s
  digest line and `ScanSignNode` (`apps/web/src/routes/component-pipeline.tsx`) render it,
  commander-only for the signing facts.

None of the above needed a new graph concept — every one is a projection of `source_mappings`,
`executor_bindings`, `publishes_to` edges, `changes.source_ref`, and `control_runs` that already
existed, exactly as §3's "nothing below adds a graph concept" promised.

### What this increment adds

**`observedRun`** — the one piece of §3 Segment 2's upstream case that stayed a sentence until now:
"it reads 'GitHub Actions · CI · run 30858160395 ↗', not 'build: unknown'." Composed from the most
recent change of the component whose `sourceRef` carries a citable run id and at least one of
`url`/`repo` (`apps/server/src/coordination/observed-run-facts.ts`, wired into
`getComponentPipeline` in `apps/server/src/coordination/component-pipeline.ts`), traced across every
writer shape (github/gitea observed-poll, github webhook, gitlab pipeline/webhook — see that module's
doc comment) and typed as `ComponentPipelineObservedRunSchema`
(`packages/schemas/src/components.ts`). The web Build tile renders it as one line beneath "built
upstream of CommanderSCP", linked when the server named a `url`, plain text when not
(`ObservedRunLine`, `apps/web/src/routes/component-pipeline.tsx`) — present only in the upstream
case, absent leaves the tile unchanged.

### What remains open, with owners

- **Q2 — the infra-correlation rule (§6#2) — DECIDED (owner, 2026-08-24) and BUILT this increment.**
  Not `correlationKey`: an infrastructure change is correlated to a component when its wave/bound
  target names a deployment-target one of the component's placements ALSO names, or the component is
  `hosted_on` it; a `provides`/`requires` coupling ADDITIONALLY correlates, rendered with a distinct
  label. Each entry states its provenance (`correlatedVia.route` — `placement` / `hosted_on` /
  `coupling`, plus the target it matched through) — READ off the server's own matching, never
  inferred client-side. Server: `correlatedInfraForComponent`
  (`apps/server/src/coordination/component-pipeline.ts`), wired into `getComponentPipeline`'s
  `correlatedInfra` field (`ComponentPipelineCorrelatedInfraSchema`,
  `packages/schemas/src/components.ts`). Web: the "Correlated infrastructure" section renders on the
  infra TAB only (`CorrelatedInfraSection`, `apps/web/src/routes/component-pipeline.tsx`) — the shape
  question §1 row 1 raised (own tab vs. parallel lane) stays answered in the tab's favour.
- **Q3 — the two stray `image` bindings (§6#3), DECIDED but not yet DONE.** Deletion via
  `DELETE /v1/executors/{target}/binding?type=image` is an estate action against the live homelab, not
  a code change, and it is pending operator credentials. Owner: the platform operator (homelab
  access holder).
- **The artifact object type and per-stage version (§4), future and UNCHANGED.** Still no `artifact`
  graph object to hang a version staircase off, and per-stage version is still unbuilt observe
  capture. `observedRun` does not touch this gap — it names the CI run that produced a release, not
  the artifact's own identity or its version at a given stage.

---

## 8. The two release paths (2026-09-12)

Owner statement, 2026-09-12, on how an image release actually runs:

> If change is in source code: source code (unit tests) → build (local run tests if provided) →
> scan/sign → registry → chart → gamma (integration test, probe + bake) → prod (integration test,
> probe + bake)
>
> If change is in chart: chart → gamma (integration test, probe + bake) → prod (integration test,
> probe + bake)

This is not a new lane. It is a correction to **when the existing lane's head is drawn**, and it is
the first statement in this document that makes the journey a property of the **change** rather than
of the component.

### 8.1 What is already right

`laneNodes` (`apps/web/src/routes/component-pipeline.tsx`) already branches, and branches correctly:

- `buildsHere = uniqueBuilds.length > 0 || buildSources.length > 0` (line 1101) — true when the
  component has a resolved `build`-category binding or a `build`-category source mapping.
  **Category, not Type** — and that is the trap §8.2 turns on: `CATEGORY_OF_TYPE`
  (`packages/schemas/src/executors.ts`) maps BOTH `image` and `chart` to `build`, so this flag
  cannot tell the owner's two paths apart even in principle. It reads as Path-B-vs-Path-A today
  only because every mapping on the estate is typed `configuration` (§8.4).
- When true it pushes `Source code` → `build`, then the registry and Scan & sign nodes as
  `lane.hasRegistry` and commander-role allow. That is **Path A's head**.
- When false it pushes none of them. That is **Path B**: the lane opens at the chart/config source
  and runs straight to the waves.
- Line 1139 flips the stage-source label — `buildsHere ? "Config" : "Source code"` — so the same
  node reads as *the config commit that triggers the deploy* on Path A and as *the repo this
  component comes from* on Path B. The two paths' vocabulary is already distinct.

Nothing above needs rebuilding. §8 changes one thing only: **what the branch reads.**

### 8.2 The defect — the branch reads Category, and both paths share one

`buildsHere` is computed from the component's mappings and bindings. It carries no reference to the
change being rendered. So for any component that is Path-A-capable — one `image` source and one
`chart` source, the ordinary shape of a deployed service — **every** change renders the full
build → registry → scan/sign spine, including a chart-only edit that never went near a builder.

It is worse than static, and this is the part that sizes the fix: `buildsHere` reads the source's
**Category**, and `image` and `chart` are both Category `build`. A component whose ONLY source is a
`chart`-typed mapping — which is precisely what D3's retyping pass creates — therefore has
`buildsHere` **true**, renders Path A's head on every change, and lists the chart repo under a node
labelled *Source code* with a build step after it. So the fix is not "read the same flag per
change"; the flag reads the wrong field. Only Type discriminates the paths (§8.3), and a Category
can never be narrowed into one.

That is the §4 honesty failure this document exists to prevent, inverted: not a box labelled
"unknown", but a box labelled with someone *else's* build. A chart bump would render the digest,
scan verdict and signature of whatever artifact `artifactFactsForComponent` last found, presented as
though this change produced them. The `digestMatch` field (`ComponentPipelineScanRunSummarySchema`,
`packages/schemas/src/components.ts` — "true iff the scanned digest equals the promoted one") is
precisely the guard against claiming an unrelated artifact, and it cannot fire here, because on a
chart-path change there is no promoted artifact of this change's to compare against.

The estate has never exhibited this, for the reason §8.4 gives: nothing on it is Path-A-capable.
The defect is latent, and it lands the moment the first `image` mapping is created.

### 8.3 The discriminator — DECIDED (owner, 2026-09-12): the mapping's Type

Three candidates were put; the Type was taken.

- **Type (taken).** ADR-0007 already makes Type the routing key, and §3 Segment 1 already renders
  "the **Type** the mapping produces" on every source card. An `image`-Type mapping matched by the
  push selects Path A; a `chart`-Type mapping selects Path B. The view **reads** the matched
  mapping's Type off the server's own matching rather than inferring a path from repo layout — the
  same discipline `correlatedVia.route` established in §7's Q2: a provenance label is read off the
  resolved object, never computed from which branch matched.
- **`path_pattern` (not taken).** Would handle one repo holding both code and chart, which Type
  alone cannot. Rejected as the *base* mechanism for the same reason operator-declared `depends_on`
  was rejected in Q2: it encodes a layout convention as an authority. It remains available as the
  way an operator expresses the mixed repo — two mappings over the same repo, `chart/**` typed
  `chart` and the remainder typed `image`, which the Type rule then reads correctly with no extra
  machinery. **The mixed-repo case is therefore served by the taken option, not lost to it.**
  One correction from building it: "the remainder" is *not expressible as a glob* — globs have no
  negation, so the whole-repo `image` mapping also matches `chart/values.yaml`. What makes the
  two-mapping shape work is that correlation attributes each changed **file** to its most specific
  mapping rather than asking which mappings match the event; see §8.10.
- **Repo identity (not taken).** Matches this estate's split exactly (98 gitops vs. 49 service
  repos) with no data churn, but breaks the instant one repo holds both, and states nothing a
  reviewer could check.

Consequence: `buildsHere` must be superseded by a per-change path selection, with `buildsHere`
retained as the fallback when no change is in view (the component-level "what can arrive here"
reading the view gives today when it renders no specific change).

### 8.4 Estate precondition — nothing can branch on this estate yet

Measured on the live homelab commander, 2026-09-12 (`scp` DB, 195 MB, persistent longhorn PVC):

| Fact | Count |
|---|---|
| `source_mappings` | 148 — **all `type=configuration`**; zero `image`, zero `chart` |
| …with NULL `path_pattern` (whole repo matches) | 40 |
| …with NULL `ref_pattern` (**every branch matches**) | **148** |
| `executor_bindings` | 63, all `configuration` — 61 `argocd`, 2 `github`; zero `build` |
| `publishes_to` edges (the registry link, §7) | **0** |
| `artifact` objects (ADR-0045) | **0** |

By repo: `jag8765-personal/homelab-gitops` 98, `AgentKitProject/agentkit` 31, `agentkit-hosting` 15,
`agentkit-commercial` 3, `CommanderSCP/commanderscp` 1. The split the owner's two paths describe is
present in the data as **repos**, and absent from it as **Types** — every service repo is typed
`configuration`, so SCP models a push to `AgentKitProject/agentkit` as a config change that goes
straight to deploy, when in reality it goes build → scan/sign → registry → chart → gamma → prod.

So `buildSources` is empty for every component, `buildsHere` is false everywhere, and **the estate
renders Path B for everything — correct logic on wrong data.** Retyping the mappings is an estate
action, not a code change, and it is the precondition for §8.2's defect becoming reachable *and* for
Path A ever rendering. It must land **after** the fix, not before it — and not only because the
defect would otherwise be reachable: typing a chart repo `chart` puts it in Category `build`, which
flips `buildsHere` true for a component that has no build at all (§8.2). Retyping first would not
merely expose the defect, it would create a second one.

### 8.5 The gate vocabulary the owner's statement names

The owner's two paths name gates this view does not yet distinguish. They are listed here as the
scope of the rendering work, not as new engine concepts — each is a `pipeline_hook` /
`control_run` that already has a home:

| Gate | Path | Where it sits |
|---|---|---|
| unit tests | A | at the source, before build |
| local run tests (*if provided*) | A | at build — **optional, and its absence is not a failure** |
| scan | A | commander-side, over the digest — see §8.9, they are not one gate |
| sign | A **and** B | commander-side, at every crossing — see §8.9 |
| integration test | A and B | at each of gamma and prod |
| probe | A and B | at each of gamma and prod |
| bake | A and B | at each of gamma and prod |

Two honesty rules carry over from §4 unchanged. A gate that is **not part of this path** renders
absent, never as "not run" — the distinction §8.2 turns on. A gate that is **declared but has not
started** renders as a stated pending, never as absent; an unstarted bake and an absent bake are
different facts.

### 8.6 API shape

Additive to `GET /components/{idOrUrn}/pipeline`, for the reason §5 gives — `/v1` is additive-only
and widening a required response field is an oasdiff ERR (measured, not assumed) — see
§5's own `unplacedStages` precedent, which is why the journey is two arrays joined by `order`.

**Two code facts, measured 2026-09-12, set this shape.** Both correct the first draft of this
section.

1. **The path is already persisted per change, so `kind` is a read.** `proposeChange` writes the
   routing Type into the change object's `properties.type`, straight from the mapping that matched
   (`apps/server/src/coordination/changes-repo.ts:288`, fed from
   `apps/server/src/coordination/webhook-processor.ts:379`). The view must **read** that field, not
   recompute the path from mappings at render time — a label recomputed from "which mapping would
   match now" goes silently false the moment a mapping is edited after the change was proposed.
2. **A stage's change is per stage, not per response.** `asOfChangeId` is
   `placementCurrents[0]?.changeId` for *each* prepared stage
   (`apps/server/src/coordination/component-pipeline.ts:640`). Gamma can hold a chart change while
   prod still holds the image change that preceded it. A single top-level `journeyPath` would
   therefore have to pick one of them and mislabel the rest.

So the field hangs off the stage:

- **Per stage** — `journeyPath: { kind: "image" | "chart", selectedBy: "change-type", changeId } |
  null`. The path *this stage's current change* is on, read from that change's `properties.type`.
  Null when the stage holds no change, which is the signal to fall back to the component-level
  `buildsHere` reading ("what can arrive here", the view's answer today).
- **Per stage** — `deploys: { digest, artifactChangeId } | null` (D1 below). The artifact this
  stage's change puts into service, as distinct from an artifact this change *produced*. Null on an
  image-path change, where the produced artifact is already the top-level `artifact` and repeating
  it on the wave would assert two facts where there is one.
- No change to `sources`, `stages`' existing fields, `unplacedStages`, `artifact`, `registry` or
  `observedRun`.

A `kind` of `"chart"` is what suppresses the build/registry/scan nodes for that rendering; the
server does not omit the underlying fields, because the same response still answers "what can
arrive at this component" for the component-level view.

### 8.7 Decisions (owner, 2026-09-12)

**D1 — a chart-path change shows the artifact it deploys, on the wave node, labelled as deployed.**
It has a digest: the image already in the registry, unchanged by this push. Suppressing it hides the
one fact an operator most wants during a chart bump ("which image is this chart going to run?");
rendering it in the produced-artifact block would be §8.2's exact confusion. It therefore renders
**on the wave node**, where §8.6's per-stage finding puts the change that explains it, through the
separate `deploys` field and never through `artifact`. *Rejected: suppress entirely (hides the
useful fact); a new top-level `deploying` field (spends API surface to say what a label says, and
top-level is the wrong scope per §8.6 fact 2).*

**D2 — a push touching both arms becomes two releases, per ADR-0007, and the correlator must be
made to do it.** This reverses the first draft's recommendation, on a measured reading:

- `matchComponentForSource` returns **at most one** match — it ranks by specificity and `return`s on
  the first hit (`apps/server/src/coordination/correlation.ts:117`).
- Its Rule 1 ranks by *how many globs are set at all*, so a `chart/**` mapping outranks a whole-repo
  `image` mapping. A both-arms push would be classified **`chart` → Path B, skipping the build
  spine entirely** — the opposite of the owner's model, and silently.
- The intended answer is already written down at the call site: *"One release = one source = one
  pipeline, so the Type belongs to the CHANGE rather than to each target — a release needing both
  would be two releases"* (`webhook-processor.ts`, citing ADR-0007 / M12 P4A). The correlator does
  not implement it.

So: the correlator returns the distinct matched `(component, Type)` pairs, and the processor
proposes **one change per Type**, grouped by the `correlationKey` they share —
`linkToCoordinatedChange` already keys on exactly that, so the grouping needs no new machinery.
*Rejected: rank `image` above `chart` on ties (produces the right answer for a reason no operator
can see — the provenance-label failure again); render a both-arms warning and leave routing alone
(honest, but leaves a known-wrong route in place once retyping makes it reachable).*

**D3 — `ref_pattern` is set in the same retyping pass.** All 148 mappings are NULL, so `dev` and
`main` route identically (ADR-0030 §1; M18's "dev pipelines selected by source ref"). This is pure
estate data, and the pass already opens every one of these rows to retype it. *Rejected: leave NULL
(survivable — the view already draws the amber "any branch" warning 148 times — but it leaves M18's
dev-pipeline selection inert); make NULL fail-closed (`correlation.ts:117` treats NULL as match-all
**by design**; flipping that semantic breaks all 148 mappings at once).*

### 8.8 Build sequence

The ordering is load-bearing: each step is unreachable on this estate until the one after it lands,
so no step can render a wrong answer in the window before its successor.

1. **D2, the correlator — LANDED 2026-09-12 (`d7baf27a`).** Done **first, while it was
   unreachable** — zero mappings are typed `image` today (§8.4), so the both-arms case could not
   occur and the change could not break live routing. What it does, and what building it found, is
   §8.10.
2. **§8.2's rendering fix, carrying D1 — LANDED 2026-09-14.** Built on §8.12's discriminator
   (**correlation**, not the `properties.type` reading this step was first written against — see
   §8.11 for why that reading cannot separate the two paths), and reachable before step 3 for the same
   reason step 1 was: it changes what the view SAYS about an artifact, never what routes. §8.13.
3. **The estate pass, carrying D3 — re-scoped by §8.12, BLOCKED by §8.14, and replaced by §8.15.** No
   longer a *retyping* pass at all: with `journey_kind` on its own field it is a **labelling** pass,
   which changes no routing and therefore cannot stop a release. 49 service repos declare `source`, 98
   gitops repos `config`, plus D3's `ref_pattern` half. Estate action, no code, owner's call.

### 8.9 Scan and sign are one tile but two gates, and only one of them is Path A

Owner invariant, restated 2026-09-12: **scan and sign can only ever happen on the commander**; an
outpost or retrans may only validate that a signature is valid. The placement is right, and the
view already draws it that way — but the two gates do not sit on the same path, and the invariant
is not enforced anywhere except in the renderer. Measured 2026-09-12.

**Where it runs.** Both are phases of ONE act: building a promotion bundle for a peer. Not at build
time, not at the outpost. `buildPromotionExport` runs the scan at Phase 1.5
(`apps/server/src/federation/promotion-repo.ts:227` → `federation/promotion-scan-step.ts:327`) and
cosign-signs the canonical manifest bytes at Phase 3 (`promotion-repo.ts:375`). Per promotion
journey, commander-side, over the digest — exactly where the charter puts it.

**Why they split across the two paths.** The scan step reads the OCI digests off the change's
`sourceRef` and returns early when there are none — *"metadata-only promotion — nothing to scan"*.
A chart-path change carries no artifact digest of its own, so **scan is effectively Path A**. The
signature is not conditional on that: Phase 3 signs whatever manifest was assembled, so **every
commander-side crossing is signed, on both paths**. A chart-path crossing therefore produces a
signed manifest with an EMPTY artifact set.

**Consequence for D1, and it is a copy rule.** The digest D1 puts on the wave node — the image the
chart is about to run — is *not* covered by that crossing's signature, because it is not in that
crossing's manifest. The wave node must say **deployed**, never *signed* or *verified*, or it
asserts a provenance that does not exist. This is the same failure §8.2 is about, one field over.

**The validate-only half is real and layered.** Import verifies the cosign signature over the exact
canonical bytes, requires the arrived artifact set to equal the signed manifest's, and requires the
Ed25519-anchored digest list to equal the cosign-anchored one — and it rejects a manifest-less
bundle from a peer known to have a cosign key as a downgrade attack
(`promotion-repo.ts:498–617`). The outpost tile copy already says the commander creates manifests
and imports none.

**What is NOT enforced — open, and not part of §8's rendering scope.** Nothing stops a non-commander
from performing the act:

- The role check is in the RENDERER only — `instanceRole === "commander"` at
  `apps/web/src/routes/component-pipeline.tsx:1122`. That decides whether a tile is drawn, not
  whether a manifest can be signed.
- `POST /api/v1/federation/exports/promotion` (`apps/server/src/routes/federation.ts:681`) is gated
  on the `federation:write` permission and on no role at all.
- Key custody is not the lever either: `ensureInstanceCosignKey` generates a keypair **on first
  use** for whatever instance calls it, so an outpost would mint its own and sign with it.
- The guard already exists and is not wired here. `commanderOnlyFederationVerdict`
  (`apps/server/src/dependencies/commander-only.ts`), including its fail-closed "an UNDECLARED role
  is its own answer, checked first" rule — a census with no filters finds it used by the dependency
  loops, the dependency routes and `routes/plans.ts`, and **never by federation promotion export**.

This is the component-built-never-installed shape: the right guard exists, in the right form, wired
to a different subsystem. Whether an outpost-signed manifest would then be ACCEPTED depends on
whether the receiving peer has that outpost's cosign key registered, which pairing may well do —
worth measuring before sizing the fix, but the act itself is already unguarded.

**§8.9 — enforced (2026-09-16).** `POST /api/v1/federation/exports/promotion` now asks
`commanderOnlyFederationVerdict` after authentication and before any work
(`routes/federation.ts:715`): an outpost, a retrans, or an UNDECLARED deployment answers 409 — the
dependency routes' shape — and mints no cosign key on the way. The check is still one definition;
only the refusal's rationale text became per-capability. Pinned at the HTTP route over four
deployments (`routes/federation-promotion-commander-only.integration.test.ts`), each guard
mutation-proved.

*Measured first: an outpost-signed manifest would have been ACCEPTED, not merely producible.* Every
instance serves its own cosign key, minting it on first use (`GET /federation/self`,
`routes/federation.ts:250`); pairing stores whatever `cosignPublicKey` the operator supplies for a
peer of ANY role (`PairPeerRequestSchema` in `packages/schemas/src/federation.ts:157`,
`peers-repo.ts:178–234`); and import verifies against the exporter peer's key and, before this change, with no check of that
peer's role (`promotion-repo.ts:653–683`). The documented pairing — `scp federation pair
--cosign-public-key` from the peer's `scp federation self` — is all it took.

*So the importer checks too.* `importPromotionBundle` now asks `commanderOnlyPeerVerdict` — beside
the deployment verdict in `dependencies/commander-only.ts`, sharing its one predicate — once the
bundle is authenticated as the exporter peer's and before the manifest is verified: a peer paired as
anything but `commander` is refused through the manifest-verify block path (Decision, audit event,
`decision_id`), a stored role outside commander|outpost|retrans takes the undeclared fail-closed
branch, and a manifest-STRIPPED bundle is refused too rather than riding pre-E5 back-compat
(`federation/promotion-import-exporter-role.integration.test.ts`). The relay is unaffected, measured:
the retrans signs only the byte tarball, and the `.scpbundle` it carries is still exported and signed
by the commander, so the retrans-relay, inbox-loop and auto-relay suites pass unchanged — and all die
when the peer verdict is mutated to refuse everything, which proves they go through it.

*Census, no filters — three server paths produce a cosign signature or mint the instance key:*

| Path | Mints | Signs | Now |
|---|---|---|---|
| `exportPromotionBundle` ← the export route (its only caller) | `promotion-repo.ts:199` | manifest, `:394` | **commander-only** |
| `buildRelayTarball` ← `POST /federation/relay` and the auto-relay loop (`auto-relay.ts:315`) | `retrans-relay.ts:628` | relay `CHECKSUMS.txt`, `:638` | retrans-only, by design (`:353`) |
| `getInstanceCosignPublicKey` ← `GET /federation/self`, `GET /federation/status` | `cosign-keys.ts:97` | — | any role |

The air-gap release bundle (`deploy/airgap/src/build-bundle.ts`) signs with an operator key, not the
instance key; every other cosign site verifies.

**Key minting is NOT restricted — stopped, owner's call.** Row two is a legitimate non-commander
signer: the retrans signs each relay tarball with its OWN instance cosign key (ADR-0019), and the
outpost inbox verifies it against the retrans peer's registered key (`inbox-loop.ts:287–290`); row
three is how that key gets distributed. Refusing to mint off the commander breaks the byte relay.
It also contradicts the invariant as restated above — *"an outpost or retrans may only validate"*.
Options: **(a)** narrow the invariant to "only the commander signs a *promotion manifest*; a retrans
signs transport integrity of bytes it has validated", then refuse minting on outposts only —
recommended, as it matches what is built; **(b)** keep the invariant literal and give the relay a
separate transport key, so the instance key becomes commander-only; **(c)** leave minting open, as
now, relying on the export route being the only manifest signer. Whichever is chosen, ACCEPTANCE is
already closed: the importer refuses a promotion from any peer not paired as `commander`.

### 8.10 What building D2 found

D2 landed as `d7baf27a`. Four things came out of building it that the decision did not anticipate.

**Ownership is per changed FILE, not per event.** §8.3's mixed repo — `chart/**` typed `chart`, the
remainder typed `image` — cannot be expressed as two disjoint globs, because globs have no negation:
the whole-repo `image` mapping also matches `chart/values.yaml`. Asking *which mappings match this
event* therefore fans a **chart-only** push out into a spurious image release on every chart bump.
`matchComponentsForSource` instead attributes each changed path to its most specific mapping — the
precedence rank the query already computed — and returns the distinct Types of the owners. Found by
a test expectation that was wrong for a real reason; both readings are now mutation-proved against
each other.

**Deduped by Type alone, deliberately.** Same-Type matches still collapse to the highest-ranked,
*including when they name different components* — the monorepo-of-services case. Fanning out per
component is wider than D2 decided and would multiply changes on every estate that exists today.
This keeps `[0]` exactly what the old single-match function returned, which is why the seven
existing correlation suites assert unchanged behaviour through it.

**Three mechanics a fan-out forces, none of which were in D2:**

- **A git push carries no `correlationKey`.** ~~No webhook adapter sets one; only an explicit
  `scp change-source report` does.~~ **FALSE WHEN WRITTEN — corrected in §8.16.** The github, gitea and
  gitlab adapters *all* set `correlationKey: p.ref` on a push, so the hint always carried a key and the
  synthesis below was **dead code on every estate that receives pushes**. The claim was copied from a
  comment in `webhook-processor.ts` that was itself wrong. It is true *now*, because §8.16 removed those
  assignments. A fan-out synthesises `change-source-event:<id>`, only when fanning out, so a single-Type
  event stores exactly the key it stored before.
- **`objects` is UNIQUE on (org_id, urn)** and both arms share one event id, so the Type
  disambiguates the change name and URN. A single-Type event keeps its exact pre-D2 name and URN.
- **`resulting_change_object_id` is one column with two candidates.** It holds the highest-ranked
  arm; the coordinated-change group holds the full set — which is why the synthesised key above is
  not optional.

**A coupling declaration cannot be split, so a fan-out carrying one is refused.** `provides` names
what ONE release provides; duplicating it onto both arms declares the same thing twice, and
attaching it to one arm is a guess. The refusal is loud, and it is atomic — both proposes share one
savepoint, so a both-arms push lands both releases or neither.

**An open gap, additive and not blocking.** `ChangeReportRequestSchema`
(`packages/schemas/src/executors.ts`) is a `z.strictObject` carrying `path` and **no `paths`**, so
the typed first-party report cannot describe a push that touched two files at all — and a one-file
push can never fan out. D2 is therefore reachable only through the raw `/webhook` ingress, where the
provider adapter (or the flat generic shape) supplies the full changed-file set. Adding `paths` to
the typed report is purely additive and would let a CI reporter express a both-arms push; nothing
needs it yet.

### 8.11 STOP — D3's retyping pass would stop deployments, and Path A is two changes

Measured 2026-09-12, before writing any of step 2. This is a blocker on D3 and it changes what D1
has to render.

**Binding resolution is by Type, and it does not fall back.** The chain:

1. A change's routing Type is stamped onto every wave target as a snapshot
   (`apps/server/src/coordination/plan-service.ts:209` — *"not re-read from the change at trigger
   time"*).
2. At trigger, the wave target's Type is what resolves the executor
   (`apps/server/src/coordination/reconcile.ts:1380` → `resolveBindingForTarget(..., type)`).
3. A Type with no binding does **not** fall back to another Type — asserted by an existing passing
   test, `binding-type.integration.test.ts:156` (*"404s for a Type with no binding (rather than
   falling back to another)"*). A miss blocks the wave target `no_executor` (ADR-0006, fail-closed).

**The estate has 63 executor bindings and every one is `configuration`; zero are `build` (§8.4).**

So retyping a service repo's mapping from `configuration` to `image` — exactly what D3's pass does —
makes every change from that repo resolve an `image` binding at gamma and prod, find none, and block
`no_executor`. **D3 as written does not merely misrender the journey; it stops the deployments.**
Add this to §8.2's Category collision and §8.8's ordering is not enough on its own: the retyping pass
itself has to be narrowed.

**What this says about the model.** The owner's Path A — source → build → scan/sign → registry →
chart → gamma → prod — is one *story* told across **two SCP changes**, not one:

- an `image`-typed change that ends at the registry, and
- a `configuration`-typed change (the chart/gitops bump) that deploys it through gamma and prod.

That is not a workaround, it is what the estate already is: 98 gitops repos against 49 service repos
(§8.4), and ADR-0007 puts ArgoCD in `configuration`. Making Path A one change would require binding
ArgoCD as an `image` executor, which contradicts ADR-0007 outright. It also retro-justifies D2: a
push touching both arms producing **two** releases is the *normal* Path A shape, not an edge case.

**Consequence for D1 and §8.2 — the discriminator is correlation, not Type.** The defect is not
"a chart-path change wrongly renders the build spine". It is: *the view cannot tell whether the
artifact it is showing belongs to this journey.* On Path A the deploy-stage change is `configuration`
and the artifact legitimately comes from a different, correlated change; on a bare chart bump the
artifact comes from an unrelated older one. Type cannot separate those two — both deploy-stage
changes are `configuration`. Only correlation can.

**What the wire already has, and the one thing it lacks.** `artifact.changeId`
(`ComponentPipelineArtifactSchema`) already names the change whose digest is shown, and
`pickArtifactChange` already prefers the changes in view and falls back to the newest digest-carrying
one — so the server is already honest about *which* change it picked. `stage.currents[].changeId`
names the change at each stage. **Neither the response nor `component-pipeline.ts` carries any
correlation link** — no `correlationKey`, no coordinated-change reference. That is the one genuinely
new server field the real fix needs, and D2 has just made it load-bearing, because the fan-out is
what puts the two arms in one coordinated-change group in the first place.

**Open for the owner — DECIDED, §8.12.** D3 must be re-scoped, and D1's rendering rule follows from
it. Nothing in §8.8 step 2 should be built until that is settled — building it on the Type
discriminator would encode a rule that is already known to be wrong.

### 8.12 DECIDED (owner, 2026-09-14): re-scope D3 to the build half; the discriminator is correlation

§8.11's blocker is resolved. Presented as three options — (A) type only the build half, (B) keep D3
whole and create `build`-Type executor bindings at every deployment target, (C) do not retype and find
another discriminator — **the owner chose A.**

**What A settles.**

1. **D3 types the 49 service repos `image` and leaves the 98 gitops repos `configuration`.** No
   `build` binding is ever resolved at a deployment target, so the `no_executor` block §8.11 measured
   cannot occur. ADR-0007 stands untouched: ArgoCD stays a `configuration` executor.
2. **Path A is two SCP changes, correlated.** The `image` change ends at the registry; the
   `configuration` change deploys it. This is what the estate already is — it is not a workaround for
   the binding rule, and §8.11's reading of ADR-0007 is the reason it is also the *correct* model.
3. **D1's discriminator is the correlation key, not the routing Type.** At a wave node the artifact
   shown belongs to *this journey* iff its change IS the stage's change or shares its non-null
   `changes.correlation_key`; otherwise it is an older artifact this release merely rolls forward.
4. **D3's `ref_pattern` half is unaffected** and can proceed independently of everything above.

**Two readings this rules out, and why each would have been wrong.**

- *Type-based.* Both deploy-stage changes are `configuration`, so a Type test answers the same for a
  Path-A gitops bump and a Path-B chart edit. Already established in §8.11; restated here because it
  is the rule §8.8 step 2 was originally written against.
- *Treating a null key as a match.* `webhook-processor.ts` synthesises a correlation key **only on a
  fan-out** (§8.10), so a single-Type push leaves the column NULL. Correlating null-with-null would
  therefore report *every* Path-B bump as `produced`: the original §8.2 defect, reintroduced one field
  over. A null key is the server stating this release names no event, which positively rules out a
  shared one.

  The parenthetical *"which is nearly every change on the estate today"* was **wrong when written, and
  in the more dangerous direction** — measured 2026-09-15, **120 of 120** live changes carried a
  non-null key, 34 of them the same one. §8.16 has the diagnosis and the fix; the rule itself is
  unchanged and is now true of the data it describes.

### 8.13 Step 2, as built (2026-09-14)

§8.8 step 2, reached by §8.12's route rather than the Type route it was first written against. The
wire gains **one field, in two places**; the rule lives in **one function**.

**Server.** `ComponentPipelineCurrentSchema.correlationKey` and
`ComponentPipelineArtifactSchema.correlationKey`, both `string | null | optional` — projected from
`changes.correlation_key` by `currentsByPlacement` (`component-pipeline.ts`) and by
`pickArtifactChange` (`artifact-facts.ts`). Additive optional response properties, so the oasdiff gate
is untouched. The artifact carries its own change's key specifically because the pick may legitimately
return a change **no stage is showing** — that fallback is the whole reason `changeId` alone cannot
answer the question.

**Web.** `artifactRelationToStage(artifact, current)` → `produced | deployed | unknown`, and
`StageArtifactLine` on every placed stage of a registry-bearing lane:

| relation | when | the line says |
|---|---|---|
| `produced` | same change, or same non-null key | *built by this release* |
| `deployed` | different change, no shared event | *deployed here — built by another release*, naming the change that did |
| `unknown` | either key absent (an older server) | *this server does not say which release built it* |

`unknown` is the established older-server reading in this file, not a third path: an absent field is
"not known", never resolved into one of the other two. The line is silent in four cases that would
each be a claim nobody made — no artifact projected, a stated absence of one, an artifact carrying no
digest, and a stage nothing has released to (naming a digest there would assert a deployment that
never happened). The infra lane draws no artifact line at all: an infra plan/apply produces no
digest-addressed artifact, so an OCI digest there would be borrowed from another pipeline.

**What is proved, and how.** 15 web unit tests and 4 integration tests, every guard mutation-proved —
six mutations of the rule and the render (null-vs-null counts as correlated; `undefined` resolves to
`deployed`; the lane gate dropped; the no-current guard dropped; the no-digest guard dropped; the
same-change shortcut dropped) each kill at least one test, and three server mutations (currents stop
projecting the key; the artifact stops carrying its change's key; the artifact reports `null` instead
of its own key) kill 4, 4 and 3 of the integration tests. The integration tests assert the projection
**per change** rather than per component, which is the shape that would otherwise pass every case
while making the two sides equal by construction.

**Still §8.8 step 3.** The retyping pass. Nothing above makes Path A render on this estate — 148
mappings remain `configuration`, so `buildsHere` is still false everywhere and the new line reports
`deployed` for every real release, which is the honest answer for a single-change config release.

### 8.14 STOP on step 3 — option A does not dodge the block, and `source_mappings.type` is overloaded

Measured 2026-09-14, immediately after §8.13 landed, before recommending the retyping pass. §8.12 is
right that Path A is two changes and right that the discriminator is correlation; it is **wrong that
option A avoids §8.11's `no_executor` stop.** It does not, and the reason is worth stating precisely
because the same mistake is easy to make again.

**The measurement.** One component, two placements (gamma, prod), a `configuration` executor binding on
each — the estate's exact shape. Driven through the REAL reconcile loop, not reasoned about:

| the change | wave target at gamma |
|---|---|
| `type: configuration` (what a push produces today) | **`triggered`**, dispatched against the execution system |
| `type: image`, same component, same bindings | **`no_executor`**, `executorPluginId: null` |

**Why option A does not help.** §8.11 framed the block as coming from retyping the *gitops* repos, so
leaving those alone looked sufficient. It is not: the block is on the **image arm itself**, and typing
the 49 service repos `image` is exactly what creates image-typed changes. Every push to a service repo
would terminalize `no_executor` at every placement. Option A narrows the blast radius from "everything"
to "the 49 service repos' releases" — which is still a stop, and still the repos that matter.

**And the plan shape is wrong even if a binding existed.** The same probe shows an image-typed change
compiles **one wave target per placement** — gamma AND prod, `category: build`, with `requiresFanIn`
on the second wave. So an `image` binding at an ancestor rung (`binding-resolution.ts`'s service rung
would find one) makes it *resolve* rather than *correct*: it would build the same artifact once per
place, sequenced behind a fan-in gate, contradicting the build node's own words — *"runs once per
release, not once per place"*. Nothing special-cases `category: build` in `plan-service.ts` or
`reconcile.ts`; a build target is planned and dispatched exactly like a deploy target.

**The root cause: one column, two jobs.** `source_mappings.type` is simultaneously

1. *what kind of change is this* — the journey discriminator D3 wants, and
2. *which executor pipeline routes it* — ADR-0007's routing key.

The chain is unbroken: `correlation.ts` returns the mapping's `type` → `webhook-processor.ts` passes it
to `proposeChange` → `plan-service.ts:209` snapshots it onto every wave target → `reconcile.ts:1380`
resolves the binding by it. On this estate those two jobs need *different values* for a service repo:
"this was a source-code change" (journey) but "route it to the config pipeline" (execution), because
**SCP does not build here** — GitHub Actions does, and SCP observes the completed run (`observedRun`,
§7; 0 build-Type changes have ever existed on this estate). `source_mappings.classification` is not the
spare field: it is the `dev | beta` M18 pipeline selector, unrelated.

**So D3 as decided cannot be executed, and this is an owner decision, not an implementation choice:**

- **(i) Don't type the build arm; render it from what already exists.** Service-repo mappings stay
  `configuration`; the source/build/registry spine draws from `observedRun` + artifact facts, which is
  what is true here — build is upstream (ADR-0017, and the charter's coordinate-not-execute line). Path
  A renders without any image-typed change existing. Cheapest, and matches the estate. Cost: the
  journey discriminator has no column, so §8.2's `buildsHere` defect stays latent rather than fixed.
- **(ii) Separate the two jobs.** A journey/kind field on the mapping distinct from the routing Type.
  Honest and general, and it is the only option that actually fixes §8.2. Cost: a new column, a
  migration, and a second vocabulary next to ADR-0007's that has to be kept from drifting into it.
- **(iii) Make SCP coordinate the build.** A `build`-Type binding plus a plan shape that compiles a
  build arm ONCE per release instead of once per placement. Largest, and it changes what the platform
  executes on this estate — charter-adjacent.

Nothing should be retyped until this is settled. §8.13 stands either way: the correlation field and the
`produced | deployed | unknown` rule are correct under all three, because all three keep Path A's
artifact on a change other than the stage's.

### 8.15 DECIDED and BUILT (owner, 2026-09-14): option (ii) — the journey is its own field

§8.14's three options went to the owner and **(ii) was chosen**: separate the two jobs
`source_mappings.type` was doing. Built the same day.

**The field.** `source_mappings.journey_kind`, migration 0112, values `source | config` — named after the
journey NODE a change from this mapping *enters at*, in the order the GLOSSARY already defines, so a
third path names a third node rather than inventing a word. `source` runs the whole
source → build → scan/sign → registry → config → waves spine; `config` enters at the config node.
NULL = not declared, which is all 148 live mappings.

**The invariant, and why it is load-bearing rather than boilerplate.** A journey kind must never reach
routing. It is the genus of `classification` / `mirror_of_shared` / `scope`: correlation does not read
it, no gate, plan compilation or binding resolution consults it, and forging or clearing it changes no
routing outcome. It *is* carried on `SourceMatch` — unlike `scope`, which is absent there — because the
CHANGE has to record it: the journey a release **took** is a historical fact, and re-deriving it from
today's mapping would silently rewrite history after a re-declaration (the same hazard as reading a
provenance label off which branch matched).

§8.14's measurement is now a permanent regression test rather than a note. One test asserts, side by
side, that a `source`-journey release **dispatches** while the same journey described the old way — by
retyping the mapping `image` — terminalises **`no_executor`** at the same placement with the same
binding. Folding the journey back into `type` fails it.

**Reads degrade where `typeOf` throws.** `parseJourneyKind` / `journeyKindOf` are total. `typeOf`
refuses to guess an unrecognised Type because that would route a release nobody chose; an unrecognised
journey kind costs one label on one tile. The column is closed at both ends (Zod on the wire, a CHECK at
rest), so the only surface skew can reach is a change's jsonb `properties` — which is exactly how a peer
running a different CommanderSCP arrives.

**What the view does with it (§8.2, finally fixed).** `laneNodes` now decides which node a source hangs
under from the **declaration** where there is one, and from the pre-0112 Category reading where there is
not. Three properties are pinned:

- The Category still decides **lane membership** — a declared journey cannot drag a configuration source
  into the infrastructure lane. (The first version of the fix did exactly that.)
- A declared `source` journey **never conjures a build node in the infra lane**, which has no build arm
  by design: plan and apply are the same executor acting at each place.
- An **undeclared** source renders exactly as it did. All 805 web tests passed untouched, which is the
  measurement of that claim. The estate declares nothing yet, so silently re-drawing its lanes on
  upgrade would be a behaviour change nobody asked for.

This is what makes the estate's real shape expressible at last: a service repo stays typed
`configuration` — because that is what *routes* it — and declares `journeyKind: source`, so the view
draws its build spine without the retyping that would have stopped its releases.

**A census by type name missed a site, and the miss is the lesson.** `grep -rna SourceMappingScope`
found 12 files and every one of them looked correctly wired — schema, diff, apply, CLI. The IaC
desired-side normalizer (`plans-repo.ts:800`) enumerates the desired side field by field and says
`m.journeyKind`, not the type name, so it silently dropped the field: the plan reported the right value
and the row was written without it. It was caught by the **apply-path** integration test (the plan-diff
unit tests all passed), and then confirmed by re-censusing on `mirrorOfShared` — a field of the same
genus that must appear at every field-enumeration site — which also surfaced `outpost-dashboard.tsx` and
the CLI plan-diff row, both correctly unaffected. The property is *"enumerates a source mapping's
fields"*, not *"mentions the type"*. Recorded because the type-name census is the obvious thing to run
and it is the thing that fails.

**Surfaces.** Migration 0112 + drizzle snapshot, the column, the repo, `SourceMappingSchema` and the
create request, `PATCH .../mappings/{id}/journey-kind` (its own route, so a journey can be re-declared
without touching `type`), the pipeline projection per source **and** per stage-current, the change stamp
at ingress, the IaC manifest + plan diff + apply, the CLI (`--journey-kind`,
`set-mapping-journey-kind`, the list column), and the hand-written `ScpClient` wrapper. Additive
optional response properties only — the oasdiff gate is untouched.

**What remains.** Declaring the journeys on the estate — the re-scoped step 3, now a *labelling* pass
rather than a retyping one, and therefore safe: it changes no routing. 148 mappings, 49 service repos to
declare `source` and 98 gitops repos `config`, plus D3's `ref_pattern` half. That is an estate action and
the owner's call.

### 8.16 A push's correlation key named the BRANCH, so D2 was dead in production (2026-09-15)

Found by deploying nothing — by asking why the §8.13 UI showed nothing on the homelab, and measuring the
live database instead of trusting the doc. It disproves two claims §8.10/§8.12 made, and it is the reason
this section exists rather than a footnote.

**The measurement.** On the live commander: **120 of 120** changes carry a non-null `correlation_key` —
81 distinct, and **one key held 34 of them**, `Coordinated: refs/heads/*` with 34 `correlates` edges.
§8.13 asserted the opposite ("nearly every change … NULL"), which is what made the error worth chasing.

**The cause, and the part that matters.** `packages/plugins/{github,gitea,gitlab}` all set
`correlationKey: p.ref` on a webhook push, and a hardcoded `correlationKey: "refs/heads/*"` on the
`observe()` poll path (the commits LIST response carries no per-commit ref, so a constant stood in for
one). A ref names a **branch**; a branch is not an event. Two consequences, the second worse than the
first:

1. **Every push to a branch landed in one `coordinated-change` group**, forever. That group is what
   §8.13's rule reads: "same non-null key ⇒ same push ⇒ `produced`". Across 34 unrelated releases that
   is a false `produced` — the very failure the null-vs-null rule was written to avoid, arriving through
   a different door. Latent on this estate only because **zero changes carry an OCI digest**, so the
   artifact tile renders nothing at all.
2. **D2's fan-out synthesis was unreachable.** `hint.correlationKey ?? (fansOut ? synthesised :
   undefined)` prefers the hint, and the hint always had the ref — so `change-source-event:<id>` never
   fired for a real git push. The both-arms grouping that §8.10 built, and that §8.13 called
   "load-bearing", has never run outside its own tests.

**Why the tests were green.** The D2 integration tests drive sourceKind `terraform`, which has **no entry
in the webhook adapter registry**, so the flat generic hint applied and carried no key — leaving the
synthesis free to fire. Production sends `github`, which resolves the real adapter. The tests and
production took different paths through the same function, and the tests took the one that works. The new
tests all drive sourceKind `github` with a real push payload **and the `x-github-event` header**, because
without that header `mapEvent` returns null and the delivery silently falls back to the generic shape —
accepted, settled, and matching nothing. That fallback is invisible in a green run.

**The hazard was already named, and handled one layer too shallow.**
`observed-event-identity.test.ts` documents that the same constant once collapsed *dedupe* — "the homelab
ingested 4 push events across its entire history" — fixed by adding `commitSha` as the discriminator. The
constant itself was left in place, so the **grouping** consequence survived the fix. A comment naming a
hazard is a signal to sweep, not evidence it was handled.

**The census found more than the symptom.** The property is *"a correlation key that names a class of
events rather than one event"*, not *"the literal `refs/heads/*`"*. Over all 23 assignments in every
plugin, with no filters: **8 instances** — 3 poll-path constants, 3 webhook push refs (the symptom search
would have missed these, and they are the ones production hits), GitLab's `: attrs?.ref` pipeline
fallback, and GitHub's `deployment` → `environment` (every deployment to prod, one key). Left alone
deliberately: `pr-`/`mr-`/`run-`/`pipeline-`/package/release/harbor keys, which name one event;
argo-workflows' workflow **instance** name, which is per-run; and ArgoCD's app name, which is the
subject an app's sync events legitimately share and which produced no groups on the estate.

**The fix.** A push emits **no** `correlationKey` — `ref` stays, under its own name, as the routing input
it always was (ADR-0030 §1). A single-Type push is one release and needs no group; a fan-out gets a real
per-event key from the server. Dedupe is unaffected: `observedEventIdentity` already discriminates on the
sha, and watermarks are keyed on `ev.kind`, so no event is re-ingested.

**Verified.** 4 integration tests through the real adapter — two pushes to one branch stay two events
with NULL keys and no group; a both-arms push produces one synthesised key and one 2-member group (D2,
alive for the first time); two both-arms pushes get separate groups; and a ref-scoped mapping still
routes, asserted in both directions. Restoring the original one-line defect kills **all four**. Plus the
three plugin suites, whose push/poll assertions now pin the *absence* with `toEqual`.

**Not done here.** The existing 120 rows keep their historical keys, and the 34-member group still exists
on the homelab. Nothing renders from it today (no digests), but it is a latent wrong answer if artifacts
ever appear. Repairing it is an estate data mutation and the owner's call.
