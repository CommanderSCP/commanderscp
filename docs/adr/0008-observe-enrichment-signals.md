# ADR 0008 — Observe-enrichment: Layer-B signal storage, health ingestion, and observe-not-drive

**Status:** Accepted (owner decisions in chat, 2026-07-17). Detailed design + incremental plan in [docs/proposals/observe-enrichment.md](../proposals/observe-enrichment.md).

**Relates to:** [coordination-ui-views.md](../proposals/coordination-ui-views.md) (Layer A shipped #71/#72/#73; this is its Layer-B follow-through), [ADR-0006](0006-fail-closed-on-missing-executor-binding-for-purpose.md) + [ADR-0007](0007-executor-binding-type-taxonomy.md) (sibling wave-target status/type decisions), [DESIGN.md](../DESIGN.md) §4.1 (thin projection tables for hot lifecycle state), §11/§12 (the executor verb set + coordinate-not-execute boundary), [PROJECT_CHARTER.md](../../PROJECT_CHARTER.md) principles 1 (coordination not execution), 2 (graph-native), 3 (API-first), 6 (explainability), 7 (Simplicity).

## Context

The coordination views need four richer per-stage signals SCP does not capture today — per-stage version/digest, Argo Rollouts progressive-delivery state, gate verdicts-with-reasons, and component/service health (proposal § "The four signals"). Two of them are structural model additions, so they warrant a recorded decision:

- SCP's two executor read verbs already *compute* some of this and throw it away — `status()` returns `stateRef = status.sync.revision` and a health string in `detail`, but `updateWaveTargetObserved` persists only `{status, lastObservedAt}` (`reconcile.ts:593-622`, `wave-targets-repo.ts:155-165`). `change_wave_targets` has no column for observed version/digest/health/rollout-state (`schema.ts:602-633`), and `ExecutionStatus` is a coarse `phase|detail|stateRef|progress` with no rollout vocabulary (`plugin-api/src/index.ts:130-139`).
- A **standing** component/service health metric has no path at all — `observe()` emits only change-detection events, and health is read only while a target is actively coordinating (`observe.ts:239-254`). There is no health-provider plugin kind.
- The coordinate-not-execute boundary is structural: the `ExecutorPlugin` interface has no `execute()`/`deploy()` verb (`DESIGN.md:534-540`). Mirroring rich rollout state must not become driving it.

## Decision

1. **Enriched per-target observed state → an additive nullable jsonb `observed_state` column on `change_wave_targets`.** It holds the last-observed snapshot (synced revision, image digest, and — later — the rollout sub-state), written by extending `updateWaveTargetObserved` and surfaced additively on `ChangeWaveTargetSchema` (`status` is already `z.string()`). It mirrors the existing `executorRef`/`priorStateRef` jsonb precedent on the same row. **No new top-level table** (charter principle 2); **not** `object.properties` (which would bump the object revision every scrape). A per-observation time-series projection table is added *only if* progression history is later required — the views render current state.

2. **`ExecutionStatus` gains a new optional, typed `observed` field.** The version/digest/rollout signals are machine-readable structured data, not parsed out of the free-form `detail` string or the rollback-reserved `stateRef`. Additive to the plugin contract.

3. **Argo Rollouts / progressive-delivery state is OBSERVED (mirrored), never DRIVEN.** SCP reads current step index, canary set-weight %, analysis phase/result, and a promote/abort/paused flag from the ArgoCD Application resource-tree (the API SCP already integrates — no new credential, no new executor). **No `promote`/`abort`/`retry` verb is added to the executor interface.** This is a normative restatement of principle 1 / DESIGN §11-12: SCP coordinates and records; Argo Rollouts drives the canary.

4. **Component/service health is an object-scoped observation record, ingested via an owner push API (binding-ready).** Health is an **optional owner-supplied** up/down metric written to a thin projection record referencing `objects(id)` (DESIGN §4.1) — not a bespoke health table, not `object.properties`, and **not** SCP polling app health itself. The record shape is designed so a later **health-source binding** (a Prometheus query / HTTP probe polling on the existing 60s observe cadence, mirroring `executor_bindings`/`source_mappings`) can write the *same* record without a schema change; that polling binding is deferred until an org needs SCP-side sampling.

**Out of ADR scope (reuses existing machinery, no model decision):** gate verdicts-with-reasons (signal 3) — the gate `Decision`/`reasonTree`, `control_runs` evidence, freezes, and approval quorum already exist and are API-surfaced; the views read them. A native typed managed-scan-verdict `ControlPlugin` is a **separate track** with the managed-scanning direction.

## Consequences

- **Graph-native, additive within /v1:** per-target signals are additive columns/jsonb on the existing projection row; health is a projection record referencing the object; nothing removes or breaks an existing schema/enum, so the oasdiff gate stays green.
- **Coordinate-not-execute preserved and reinforced:** the richest new signal (rollout state) is read-only mirror; the ADR pins that no execute-style verb is introduced.
- **Cheapest-value-first delivery:** persisting `status().stateRef` is near-zero new plumbing (the engine already round-trips it into `priorStateRef`); gate-reason surfacing needs no model change; the heavy pieces (image digest, rollout mirror, health) land incrementally, each its own PR against the proposal.
- **Explainability intact:** promotion blocks already carry a `decision_id`; the views surface it.

## Non-goals

- SCP running progressive delivery (canary/analysis/promote is Argo Rollouts' job).
- A bespoke health-monitoring subsystem (health is an optional owner-supplied metric).
- A per-observation time-series of stage state (deferred to a projection table only if history is needed).
