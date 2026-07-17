# Proposal: coordination UI — service/component pipeline views + two-layer graph

**Status:** Draft — proposed 2026-07-17, pending owner review. The visual designs were reviewed and approved with the owner over three mockups (below); this doc captures them as a buildable spec.

**Relates to:** [coupled-pipelines.md](coupled-pipelines.md) + `packages/schemas/src/changes.ts` (`provides`/`requires`/`waiting`, `correlationKey`) + `apps/server/src/coordination/coupling.ts` (the cross-change chain), [ADR-0007](../adr/0007-executor-binding-type-taxonomy.md) (Category/Type — the per-stage pipeline-kind badges), [service-component-model.md](service-component-model.md) (component↔service), [DESIGN.md](../DESIGN.md) §9 (emergency changes), §10.3 (freeze), §14 (UI), the governance gate/approval model (`requireApprovals`), the graph query surface + PR #69 (`POST /v1/graph/subgraph`, `apps/web/src/components/graph/GraphCanvas.tsx`), managed scanning as a gate control, [PROJECT_CHARTER.md](../../PROJECT_CHARTER.md) principles 2 (graph-native), 3 (API-first), 6 (explainability), 7 (Simplicity).

**Mockups (visual reference — private Artifacts):**
- Service release board — https://claude.ai/code/artifact/49142e1f-0135-4757-8792-3c0c796c0bfa
- Component pipeline view — https://claude.ai/code/artifact/b236612a-08ac-47d4-a68e-652e44c4d1ef
- Two-layer graph explorer — https://claude.ai/code/artifact/1e7d2fe4-d867-488d-a2a8-5c96e2a6c89e

---

## Why now

CommanderSCP coordinates a release across build → registry → config → gamma → prod, chains changes with `provides`/`requires`, and gates promotions — but the UI today only lists changes/campaigns and offers a per-object graph. An owner UI review asked to **see a release flow end-to-end**, **scan a whole service at a glance**, and **read the org's connection topology cleanly**, with the operator in control (freeze, emergency, manual gates). This proposal specs three views to close that gap, and — critically — separates what is **buildable today from the existing model** from the **observe-enrichment** the richer parts require.

## The views

### 1. Service release board
A service's components in one scannable table: per-stage **version + status**, a summary strip (releasing / blocked / stable), and the one **blocked** component surfacing in red. A row opens the component pipeline. Header carries **Freeze service**; rows carry freeze / emergency-deploy actions. It's the "what's moving" board.

### 2. Component pipeline view
Component-scoped, two lanes **top-to-bottom**:
- **App release** — `Build & test` → `Image registry` → `Config bump` → `Gamma` → `Prod`. Each stage **links to its source or executor** (git source repo, image registry, git config repo, Argo CD app). `Build & test` carries a `Build → Test` sub-track (test optional). `Image registry` shows the **scan result**; the promotion after it is the **scan gate**.
- **Infra · correlated** — an infra change directly correlated to the component runs as a **parallel lane** beside the app release.

Between stages, promotions are **wide arrows** colored **green (open)** / **red (blocked: scan / window / gate)** / **amber (manual: approval or operator hold)**. Within a deploy stage, a left-to-right **Argo-native sub-track** (`Sync` · `Canary` · `Analysis` · `Promote` · `Abort`). Concurrency is shown as a **version staircase** (each stage's current version). Header carries **Freeze pipeline** + **Emergency deploy**.

### 3. Two-layer graph explorer
Pure connection topology at two zoom levels (the prior all-in-one graph was too busy):
- **Services** — services and their `depends_on`/`consumes` edges. Click a service → its components.
- **Components · \<service\>** — the service's internal component links **plus cross-service links** (dashed) to *other* services' components (a component edge whose endpoints are in different services); external nodes drawn as dashed outlines.
- **Optional health overlay** — a per-node dot (`up` / `degraded` / `down` / `no metric`), shown only when the owner reports an up/down metric.

## Operator controls → model mapping

The five controls are mostly **surfacing mechanisms SCP already has**, not new engines:

| Control | Where | Maps to |
|---|---|---|
| Emergency deploy | component header | the `emergency` change flag (`CreateChangeRequestSchema.emergency`, DESIGN §9) — bypasses gates |
| Manual approval step | a promotion arrow | `requireApprovals` policy effect (the mechanism behind the 11 prod-gate approvals) |
| Freeze pipeline / service | component + board headers | freeze / freeze-override (DESIGN §10.3), **scoped to a component or service object** |
| Manual open/close a promotion | any arrow | a **per-promotion operator override** on the gate — the one genuinely new bit |
| Scan gate | the registry→config arrow | a **gate control** whose evidence is the image scan verdict (managed-scanning direction) |

Net-new modeling is small: **promotion-level hold/release** and **freeze scoping** (component vs service), layered on the existing gate model.

## Layer A vs Layer B — the crux

The mockups split cleanly into what the current model already supports and what needs SCP to **observe more**.

### Layer A — buildable now (no model change)
- **Cross-change DAG** (build → config → deploy chaining): `provides`/`requires` + `correlationKey` + the `waiting` state (`changes.ts:88-93`, `coupling.ts`). The pipeline's stage-to-stage chain is a view over this.
- **Waves within a change** (gamma/prod) and their per-target status — already stored on `change_wave_targets`.
- **Category/Type badges** per stage — from ADR-0007 (`build` = image, `configuration` = argocd sync, …).
- **Gate + approval state** — `requireApprovals`, the gate Decision + `decision_id` (charter principle 6).
- **Emergency + freeze** — the `emergency` flag and freeze mechanism exist; the views surface + scope them.
- **Graph edges** — the two-layer graph is the existing `depends_on`/`consumes` edges filtered to service-level vs component-level; cross-service = a component edge across services. PR #69 already added the `subgraph` endpoint for real induced edges; this restyles it (typed nodes, two layers) on the shared `GraphCanvas`.
- **Stage source/executor links** — the binding's `externalRef` (Argo app), the source-mapping repo, the registry ref.

### Layer B — observe-enrichment (new signals SCP must capture)
A wave target today is one `trigger → succeeded/failed`. The richer view elements need SCP to **observe and store more per stage**:
- **Per-stage version / image digest** — to render the version staircase and the registry step.
- **Argo Rollouts progressive-delivery state** — `Sync` / `SetWeight` (canary %) / `Analysis` / `Promote` / `Abort` — mirrored from the executor via `observe()`, not modeled by SCP itself.
- **Gate verdicts with reasons** — scan result (Trivy HIGH), change-window open/closed, approval counts — to color the promotion arrows and name *why* one is blocked.
- **Component / service health** — an **optional owner-provided up/down metric** rendered as the graph health dot. This is a new observe/annotation signal per object.
- **Promotion hold/release + freeze-scope state** — the operator-override records.

Layer B is where the real modeling work is, and it is squarely **observe-model** territory — consistent with the charter (SCP observes execution systems; it does not run them).

## Phased build plan (implementation PRs, #71+)

Each phase is independently shippable and mostly Layer A first, enriching after.

1. **Component pipeline view — Layer A skeleton.** Render the cross-change chain (`provides`/`requires`/`correlationKey`) + waves + Category badges + gate/approval state, from existing data. Wide-arrow promotions with the states we already know (open / blocked-on-gate / awaiting-approval). Stage source/executor links.
2. **Service release board.** Aggregate a service's components' current stage + version (as available) + status into the scannable table; Freeze-service + row actions. Links to the component view.
3. **Two-layer graph restyle.** Build on #69's `GraphCanvas` + `subgraph`: service layer, component layer, cross-service links, typed node coloring, deliberate layout.
4. **Observe-enrichment (Layer B), incrementally:** (a) per-stage version/digest capture; (b) gate verdicts with reasons (scan/window/approvals) surfaced on arrows; (c) Argo Rollouts state mirrored via `observe()` into the sub-track; (d) the optional health metric ingestion + graph overlay.
5. **Operator controls surfacing.** Promotion-level manual hold/release and freeze scoping (component vs service) where not already exposed; emergency-deploy affordance.

## Charter alignment
- **Graph-native (2):** every view derives from graph objects + edges + change/gate rows; the health metric is an object-scoped observe signal, not a new top-level table (confirm the storage shape at Phase 4d — an observe/annotation record, not a bespoke table).
- **API-first (3):** views consume only the generated SDK; new read endpoints (e.g. a per-service board projection, a release-chain projection) are additive within `/v1`.
- **Explainability (6):** promotion blocks already carry a `decision_id`; the arrows surface it, they don't invent it.
- **Simplicity (7):** the graph was deliberately reduced to two layers; the pipeline reuses existing mechanisms rather than adding engines.

## Non-goals / deferred
- **SCP running progressive delivery.** Canary/analysis/promote happen *inside* Argo Rollouts; SCP observes and mirrors them — it does not orchestrate them (charter: coordinate, not execute).
- **A bespoke health-monitoring system.** Health is an *optional owner-supplied* up/down metric surfaced as an overlay — not SCP polling app health.
- **Auto-wiring every build→config→deploy chain.** `provides`/`requires` stays operator-declarable; auto-derivation from source-mappings is a separate question.
- **Fleet/org-wide roll-up beyond one service.** The board is service-scoped for now.

> **Process:** worth a small **DESIGN.md §14 (UI)** note pointing at these views, and — for the Layer B **health/observe signal** and the **promotion hold/release** state — an **ADR** when Phase 4/5 lands, since those add observe/annotation surface. This proposal is the umbrella; per-phase PRs (#71+) reference it.
