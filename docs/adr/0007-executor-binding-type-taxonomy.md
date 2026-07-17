# ADR 0007 — Executor binding Type taxonomy: Category over Type, replacing `purpose` (software|infra)

**Status:** Accepted (owner decisions in chat, 2026-07-17). Implementation deferred — detailed design and migration in [docs/proposals/executor-type-taxonomy.md](../proposals/executor-type-taxonomy.md).

**Relates to:** [ADR-0002](0002-execution-strategy.md) (the four-arm ownership test keys on *class-of-change* — now = Type/Category), [ADR-0005](0005-component-create-strict.md) (M12 create-strict), [ADR-0006](0006-fail-closed-on-missing-executor-binding-for-purpose.md) (no-executor fail-closed), [DESIGN.md](../DESIGN.md) §12 (per-layer composition), `apps/server/drizzle/0023_executor_binding_purpose.sql`, `apps/server/drizzle/0024_wave_target_purpose.sql`, [PROJECT_CHARTER.md](../../PROJECT_CHARTER.md) principles 2 (graph-native), 3 (API-first parity), 6 (explainability), 7 (Simplicity-first).

## Context

The executor binding, source-mapping, and change all carry `purpose ∈ {infra, software}` (`packages/schemas/src/executors.ts:18`), and it is the **executor routing key**: `reconcile` resolves exactly one binding by exact-equality via `getExecutorBinding(tx, orgId, targetObjectId, purpose)`, backed by `unique("executor_bindings_org_target_purpose_key")` on `(org, target, purpose)` (`schema.ts:1192`). Two values are too few:

- `software` conflates two genuinely different executor classes — the ArgoCD bindings **sync desired state** (configuration), they do not **build**. The schema itself mislabels this: *"Argo CD is SOFTWARE, since it deploys onto that substrate"* (`drizzle/0024_wave_target_purpose.sql:24`).
- `infra` conflates true IaC (Terraform/CDK — stands up substrate) with GitOps-manifest authorities (e.g. `homelab-gitops` — declarative *config* applied to a running cluster).
- Two ArgoCD imports both default to `software` and **collide** on the unique key (organize-after.md:87); coupled-pipelines.md:108-116 routed *around* `purpose` because it could not express the distinction.
- **DESIGN §12 already models ~8 layers** (App build/test, Artifact/registry, k8s GitOps CD, Cloud IaC, Host OS/packages, …) — the code collapsed them to two. This taxonomy reconciles the routing key back toward that layer model.

## Decision

Replace the flat `purpose` with a **two-level taxonomy**:

- **Category** — coarse, closed, gate-groupable: **`build`**, **`infrastructure`**, **`configuration`**.
- **Type** — fine, the **routing key** (what `purpose` becomes); closed enum, extensible only by deliberate owner decision:
  - **build** → `image`, `rpm`, `deb`, `npm` (initial set; `wheel`/`jar`/`binary`/… by decision)
  - **infrastructure** → `infrastructure`
  - **configuration** → `configuration`

**Category is derived from Type** via a static `Type → Category` map in `packages/schemas` — **not** a stored column. Routing and the `UNIQUE(org, target, Type)` identity stay on Type; gates that want coarse grouping resolve Category through the map.

Type is one of three **orthogonal axes**, kept strictly separate:
1. **Type** — class of change / executor class (this ADR). The routing key.
2. **Scope** — which graph object the binding attaches to (`targetObjectId`: cluster/env/service/component). Graph-attachment + future walk-up resolution — **not** a column, **not** part of the routing key.
3. **Module** — the executor tool (`pluginModule`, already separate). Unaffected.

Owner decisions (chat, 2026-07-17):
- **D1** — `build` subdivides into distinct Types (`image`/`rpm`/`deb`/`npm`), not one `build` Type with an artifact-flavor tag. Distinct build tooling ⇒ distinct routing/gating.
- **D2** — Scope is graph-attachment + walk-up, not a binding facet.
- **D3** — **Hard cutover** — `infra`/`software` are replaced outright (no legacy aliases). Safe now (single instance, no federation skew); a post-federation cutover would require a lockstep fleet upgrade (`purposeOf()` throws on unknown values, `changes-repo.ts:392-402`).
- **D4** — Closed Type enum + closed Category set (not an open registry) — Type must stay a checkable, gate-enforceable routing key.

Type **keys gates and coupled-pipelines** (net-new — no governance/CEL code reads `purpose` today). `provides`/`requires` already expresses an `image → configuration` ordering with no code change; the split names it.

## Consequences

- **Both legacy buckets fan out** (not a clean rename): `software → {configuration (argocd), build-Type (CI)}`; `infra → {infrastructure (IaC), configuration (GitOps authorities)}`. The migration **backfill classifies by `(Module, repo content/kind)`**, not by the old column value.
- **Resolves the agentkit `no_executor` parking gap**: the `homelab-gitops`/`agentkit-hosting` mappings mislabelled `infra` reclassify to `configuration` and resolve to the existing argocd binding instead of parking (ADR-0006). ADR-0006's masking-gap check carries into Type automatically (it keys on the routing value) and its wording sharpens: "has a `configuration` binding, receives an `image` release."
- **Graph-native, no new table** (principle 2): Type is a graph-object property/projection column; Category is derived; Scope is attachment; Module already exists.
- **API impact**: one Zod enum → `pnpm gen` propagates to OpenAPI/SDK/CLI. Adding Types is additive in responses; **retiring `infra`/`software` from request-position enums is oasdiff-breaking** and lands as a documented **oasdiff exception** for this single-instance hard cutover — not a precedent for post-GA breakage.
- **Migration is a filterless call-site census**: ~8 duplicated inline `"infra" | "software"` unions (`source-mappings-repo.ts`, `reconcile.ts`, `plan-service.ts`, `executor-bindings-repo.ts`) must widen in lockstep; `purposeOf()` learns the new values before the throw is enabled.
- **ADR-0002's four-arm ownership test** keys on *class-of-change*; that dimension is now precisely **Type/Category**.

## Non-goals / Deferred

- Scope walk-up resolution (component → service → deployment-target → cluster) — own work.
- Splitting `infrastructure`/`configuration` into sub-Types — only on a concrete *routing* (not Module) difference, by deliberate decision.
- Multi-Type fan-out of a single push — the "one release = one source = one pipeline" invariant is preserved (two path-scoped mappings, or `provides`/`requires` coupling).
- Wiring specific gate policies onto Type/Category — this ADR makes them *available*; policy authoring is separate.
