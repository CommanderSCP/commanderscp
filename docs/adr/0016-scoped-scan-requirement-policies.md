# ADR-0016: Scoped scan-requirement policies (platform / org / service / component), most-restrictive-wins

**Status:** Accepted (owner-decided 2026-07-19)
**Context doc:** [docs/proposals/promotion-and-execution-model.md](../proposals/promotion-and-execution-model.md)
**Relates to:** [ADR-0013](0013-supply-chain-scan-sbom-manifest.md) (scan as a boundary-authorization gate); [ADR-0015](0015-cosign-cross-boundary-signing.md) (the sibling cosign-verify gate); charter principle 2 (graph-native), principle 4 (PostgreSQL-only), principle 6 (explainability)

## Context

ADR-0013 made scanning a **boundary-crossing authorization gate**. But the pass-criteria is fixed too coarsely today: the scan control reads a **flat per-binding** `config.threshold` (`scan-result-control/src/index.ts` `resolveThreshold`; `ScanThresholdSchema` = `maxCritical`/`maxHigh`/`maxMedium`/`maxLow` in `supply-chain.ts`). One threshold per binding cannot express "the platform floor is *maxCritical: 0*, this org tightens *maxHigh* to 0, and this component tightens *maxMedium* to 5."

The policy engine **already** does exactly the right kind of resolution for other controls: `policy-resolve.ts` `matchPoliciesForTargets` matches org→domain→service→component containment, and `policy-model.ts` `resolvePolicies` **unions** `requireControls` with **stricter-wins** semantics — a child scope can only **ADD** controls, never drop one. Scan pass-criteria should reuse this resolver rather than invent a parallel one.

Two gaps to close:

1. There is **no instance-wide (cross-org) scope** today. Everything is org-rooted under RLS (`tenant-tx.ts`; every table carries `orgId`). A **platform** floor that applies to *all* orgs is a new primitive.
2. The gate passes only `{changeId, targetObjectIds, gateRef}` as context (`gate-orchestrator.ts`). M17.1 already threads `context.artifactDigest` — that is the pattern a resolved effective-threshold reuses.

## Decision

Make scan pass-criteria **graph-native, scoped policy data** at four tiers — **platform / org / service / component** — resolved **most-restrictive-wins**.

### 1. Scoping + precedence

- Precedence is **top-down** (platform is the outermost floor, component the innermost), but a child may only **TIGHTEN**, never loosen. The **effective threshold is the per-severity MIN** across every applicable scoped scan-requirement:
  `effective.maxCritical = MIN(platform, org, service, component).maxCritical` — and likewise for `maxHigh`/`maxMedium`/`maxLow`.
- This mirrors the existing stricter-wins `requireControls` union (`resolvePolicies`): a child scope can make the gate harder to pass, never easier. A tenant cannot loosen the platform floor; an org cannot loosen below its own service/component floors.

### 2. Graph-native (charter principle 2)

Scan-requirements at **org / service / component** are ordinary **policy/graph data**, matched and resolved by the **existing** `matchPoliciesForTargets` / `resolvePolicies` seam — no new resolution engine, no new top-level table for the org-rooted tiers. New pass-criteria arrive as relationship/policy data, exactly as the charter requires.

### 3. The platform tier — the one new primitive

The **platform** tier is instance-scoped and sits **above** org. It is the single new structural piece:

- An **instance-scoped table with no `orgId`** — it is a single operator-set floor for the whole instance.
- **Operator-write / tenant-read**, via the **privileged connection** — it lives **outside tenant RLS**. This is called out as the sharp edge: because it is outside RLS, the read path must guarantee a tenant can **never see across** to another tenant's data and can **never loosen** the floor. It is exposed only as an **always-present, read-only contributor** to the MIN — a single operator-set floor merged into every org's resolution, never a tenant-writable row.
- It is a **Postgres table, not a service** (principle 4). No authz service, no external policy engine.

### 4. Resolution — design (A), recommended

- **(A, recommended):** **ONE** scan control whose **effective threshold** is the per-severity MIN across all applicable scoped scan-requirements. The requirements are resolved from graph-native policy data (platform floor merged in as the always-present contributor) and the resolved effective threshold is **threaded to the control via the gate context** — reusing the M17.1 `context.artifactDigest` threading pattern. One Trivy verdict is evaluated once against the merged floor.

### 5. Charter alignment

- **Graph-native (principle 2):** OK — org/service/component requirements are policy/graph data on the existing resolver; only the platform floor is a new (single) primitive.
- **PostgreSQL-only (principle 4):** OK — the platform tier is a **Postgres table**, not a service; no new required stateful dependency.
- **Explainability (principle 6):** the effective threshold and its contributing scopes persist in the scan gate's Decision record, so a blocked promotion can show *which* scope set the binding severity floor.

## Alternatives considered

- **(B) N conjoined scan controls (considered, not chosen).** Each applicable scope contributes **its own** scan control, conjoined through the existing `requireControls` **union** + all-pass gate. Most-restrictive falls out for free (all must pass ⇒ the tightest dominates) with **zero new resolution code**. **Rejected as the primary design because:** it re-evaluates the scan gate **N times** — N redundant Trivy-result fetches/evaluations for the same artifact — and produces N Decisions for one logical criterion, muddying explainability. Design (A) evaluates once against a single merged floor. (B) remains a viable fallback if (A)'s context-threading proves awkward, since it needs no new resolver.
- **Flat per-binding threshold only (status quo, rejected).** Cannot express layered platform/org/service/component floors; the owner explicitly wants scoped, tightening-only criteria.
- **Platform tier as a tenant-writable row (rejected).** Would let a tenant see or alter an instance-wide floor — breaks RLS isolation. The platform floor is operator-write / tenant-read only.

## Consequences

**Positive**
- Layered, tightening-only scan criteria at four tiers, reusing the proven stricter-wins resolver; only the platform floor is net-new structure.
- One control, one Trivy evaluation, one Decision per artifact (design A) — clean explainability.
- Independent of the signing track (ADR-0015): M17.5 can proceed in parallel.

**Costs / honesty**
- The platform table lives **outside tenant RLS** (privileged connection) — a carefully-guarded read path is required so no tenant sees across or loosens the floor.
- `ScanThresholdSchema` gains a scoped-requirement representation and the gate context carries a resolved effective threshold (additive schema/codegen work).
