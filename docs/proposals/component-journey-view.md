# Proposal: the component journey view — source → build → deploy

**Status:** v0.2, 2026-08-24 — v0.1's design was accepted and built out; see §7 "Reality as of 2026-08-24" for what shipped, what this revision adds, and what is still open.
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
| Per-stage **version** | `observe()`-captured version/digest — `coordination-ui-views.md` Phase 4a, unbuilt. Already rendered "not observed yet". |
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
