# Proposal: executor Type taxonomy — Category over Type, replacing `purpose` (software|infra)

**Status:** Draft — proposed 2026-07-17, pending owner review. Vocabulary + the four structural decisions (D1–D4) and the taxonomy shape were settled with the owner on 2026-07-17.

**Relates to:** [service-component-model.md](service-component-model.md) (Scope / walk-up), [coupled-pipelines.md](coupled-pipelines.md) (purpose as routing key), [organize-after.md](organize-after.md) (the `software` collision), `apps/server/drizzle/0023_executor_binding_purpose.sql`, `apps/server/drizzle/0024_wave_target_purpose.sql`, [ADR-0002](../adr/0002-execution-strategy.md) (four-arm ownership test: class-of-change × layer × domain), [ADR-0006](../adr/0006-fail-closed-on-missing-executor-binding-for-purpose.md) (no-executor fail-closed), [DESIGN.md](../DESIGN.md) §12, [PROJECT_CHARTER.md](../../PROJECT_CHARTER.md) principles 2 (graph-native), 3 (API-first parity), 6 (explainability), 7 (Simplicity-first).

---

## Why now

> **Owner:** *"`software` vs `infra` is too coarse. What we actually have are different kinds of thing: something that turns source into an artifact, something that stands up infrastructure, and something that applies desired state to a running system. And today's `software` is two of those wearing one label — the ArgoCD bindings are configuration, not build. Image generation is software, but an RPM is also software — another type."*

Today an executor binding, a source-mapping, and a change all carry a `purpose ∈ {infra, software}`. That single field is the **executor routing key** — `reconcile` resolves exactly one binding by exact-equality:

```
getExecutorBinding(tx, orgId, targetObjectId, purpose)   // apps/server/src/coordination/reconcile.ts
```

backed by `unique("executor_bindings_org_target_purpose_key").on(orgId, targetObjectId, purpose)` (`apps/server/src/db/schema.ts:1192`). Mislabelling drives a change through the *wrong executor* (coupled-pipelines.md:114). So the values are a **checkable routing dimension**, not free-form tags — and two values are too few to route correctly.

The conflation is already documented as a live problem, not a hypothesis. The schema itself records the narrow definition of infra and (mis)classes ArgoCD as software:

> *"infra = the IaC substrate (EC2, S3, the K8s cluster itself); **Argo CD is SOFTWARE**, since it deploys onto that substrate."* — `drizzle/0024_wave_target_purpose.sql:24`

And [organize-after.md:87](organize-after.md) records two ArgoCD discovery imports both defaulting to `purpose='software'` and then **colliding** on `UNIQUE(org_id, target_object_id, purpose)`. [coupled-pipelines.md:108-116](coupled-pipelines.md) found the two-value model *cannot* express the ArgoCD-vs-build distinction and deliberately routed *around* `purpose`. This proposal is that deferred resolution.

---

## The model: **Category** over **Type**

A two-level taxonomy replaces the flat `purpose`:

- **Category** — the coarse class of change. Closed set: **`build`**, **`infrastructure`**, **`configuration`**. Gate/policy-groupable ("gate *any* build").
- **Type** — the fine, artifact/action-specific value. **This is the routing key** (what `purpose` becomes). Closed set, extensible only by deliberate owner decision.

| Category | Type(s) *(initial closed set)* | What it does | Executor class (Module) |
|---|---|---|---|
| **build** | `image`, `rpm`, `deb`, `npm` *(add `wheel`/`jar`/`binary`/… by decision)* | turn source into an artifact | github (Actions) / kaniko / rpmbuild / CI |
| **infrastructure** | `infrastructure` | stand up / change infrastructure substrate (IaC) | terraform / opentofu / cdk / pulumi / managed-iac |
| **configuration** | `configuration` | apply declarative desired state to a running system (sync manifests) | argocd / flux / helm / kustomize |

**Category is derived from Type, not stored.** A Type belongs to exactly one Category (`image`→build, `rpm`→build, `configuration`→configuration, …), so Category is a small static `Type → Category` map in `packages/schemas`, **not** a second column on any table. Routing and the `UNIQUE(org, target, Type)` identity key stay on Type; gates that want coarse grouping resolve Category through the map. This keeps the two-level model without duplicating graph truth (charter principle 2) or widening the routing key.

Why build subdivides but infrastructure/configuration (for now) do not: `image`-build and `rpm`-build use genuinely different build tooling and warrant distinct routing/gating (owner decision **D1**). IaC-tool and config-tool differences (terraform vs cdk, argocd vs flux) are the **Module** axis, not Type — so `infrastructure` and `configuration` stay single Types until a concrete routing difference justifies splitting them (added by deliberate decision, per **D4**).

---

## Three orthogonal axes — the core discipline

The redesign's whole point is keeping these separate; `purpose` collapsed the first into two buckets and ignored that ArgoCD-sync differs in *kind* from image-build.

1. **Type** *(this proposal)* — the class of change / executor class. The routing key. `purpose` renamed, split, and subdivided.
2. **Scope** — *which graph object* the binding attaches to: cluster/platform, environment/deployment-target, service, component. This is the binding's `targetObjectId` attachment point, **not** a new column (owner decision **D2**). Walk-up resolution (component → service → deployment-target → cluster) is recognised-but-unbuilt future work (service-component-model.md:84, 121-122; DESIGN §12:616-632).
3. **Module** — the executor *tool*. Already a separate field: `pluginModule` (`packages/schemas/src/executors.ts:55`), whitelisted as `KNOWN_EXECUTOR_MODULES = [fake-executor, github, argocd, terraform, managed-iac]`. Unaffected.

---

## What `software` and `infra` actually split into

Both legacy buckets fan out — **neither is a clean rename**:

- **`software` →** `configuration` (all ArgoCD bindings — including the ~50 agentkit homelab Mode-A imports; they *sync* manifests, they do not build) **+** a build Type (`image`, `rpm`, …) for CI/artifact pipelines.
- **`infra` →** `infrastructure` (true IaC: Terraform/OpenTofu/CDK/Pulumi that stands up substrate) **+** `configuration` (GitOps manifest authorities like `homelab-gitops` — they are declarative *config* applied to a running cluster, not substrate provisioning).

That second split is the subtle one and it is exactly the agentkit trial's live gap: the `homelab-gitops` and `agentkit-hosting` mappings were labelled `infra`, but a push to them syncs *configuration*, and the components have no *infra* executor — which is why, post-ADR-0006, they fail-closed as `no_executor`. Under this taxonomy those mappings reclassify to `configuration`, resolve to the existing argocd binding, and stop parking. **The backfill classifies by `(Module, repo content/kind)`, not by the old column value** (see Migration).

---

## Decisions (settled with owner, 2026-07-17)

**D1 — `build` subdivides into distinct Types.** `image`, `rpm`, `deb`, `npm`, … are separate Type values (not one `build` Type with an artifact-flavor tag). Rationale: distinct build tooling ⇒ distinct routing/gating.

**D2 — Scope is graph-attachment + walk-up, not a facet.** Scope = the object the binding hangs on (`targetObjectId`); resolution walks up component→service→deployment-target→cluster (future work). No column, not part of the routing key. Keeps Type ⟂ Scope.

**D3 — Hard cutover, no legacy aliases.** `infra`/`software` are replaced outright, not accepted alongside the new values. Safe **now** because there is a single instance (homelab) — no federation version-skew. *Caveat:* once outposts exist, a hard cutover requires a **lockstep fleet upgrade** (a version-skewed outpost would hard-fail `purposeOf()`, which throws on unknown values, `changes-repo.ts:392-402`). Revisit expand/contract if a hard cutover is ever needed post-federation.

**D4 — Closed Type enum (+ closed Category set), not an open registry.** Type must stay a checkable, gate-enforceable routing key. New Types are added by deliberate owner decision (the same discipline that withdrew the `data` value, `executors.ts:15`), not by open registry data. Category is likewise a fixed three-value set.

**Taxonomy shape — two-level Category over Type.** Category `{build, infrastructure, configuration}` groups the Type set for gates/policies; Type is the routing key. Category derived from Type via a static map (no new column).

Type **keys gates and coupled-pipelines** (owner-confirmed). Gate-keying is *net-new* — no governance/policy/CEL/decision code reads `purpose` today. Coupled-pipelines already expresses ordering via the orthogonal `provides`/`requires` model (coupling.ts:42-63), so an `image → configuration` ordering ("image built ⇒ digest provided; sync requires digest@service") is expressible **today with no code change**; the Type split makes it a nameable first-class pattern (image built, *then* synced).

---

## Two worked examples

**(1) Root K8s cluster config = Type `configuration` @ cluster Scope.**
A single binding whose **Type = configuration** (it syncs declarative desired state onto the running cluster) and whose **Scope = cluster** (its `targetObjectId` points at the cluster/platform object). Two independent axes, one binding. It routes through the argocd/config executor class — never Terraform — because Type, not Module-guessing, is the key.

**(2) agentkit ArgoCD bindings reclassify `software` → `configuration`; `homelab-gitops` mappings reclassify `infra` → `configuration`.**
The homelab import landed ~50 ArgoCD Applications as `purpose='software'` bindings; they *sync*, so they become **Type = configuration**. The `homelab-gitops`/`agentkit-hosting` source-mappings labelled `infra` are GitOps *config* authorities, so they too become **configuration** — resolving to the same argocd binding instead of parking as `no_executor`. Because `UNIQUE(org, target, Type)` distinguishes rows by Type, a component can now legally hold a `configuration` binding (argocd sync) *and* an `image` binding (its container build) *and* an `infrastructure` binding (its Terraform) at once — the collision in organize-after.md:87 is resolved, not worked around.

---

## Migration (hard cutover — one coordinated change)

The value set lives in **one** Zod enum; every surface derives from it, so the contract change is one edit + `pnpm gen`. Because it is a hard cutover on a single instance, it ships as one coordinated migration rather than expand/contract.

1. **Contract source** — replace `BindingPurposeSchema` (`packages/schemas/src/executors.ts:18`) with the new closed **Type** enum `["image","rpm","deb","npm","infrastructure","configuration"]` (rename the export to `BindingTypeSchema`/`ExecutorTypeSchema`); add a `CATEGORY_OF_TYPE` static map + `ExecutorCategorySchema = ["build","infrastructure","configuration"]`. Run `pnpm gen` (re-emits all OpenAPI sites + the SDK union). *Note:* removing `infra`/`software` from REQUEST-position enums (the `?purpose=` query param and POST bodies of `/changes`, `/campaigns`, `/change-sources/{sourceKind}/mappings`, PUT/PATCH binding) is an oasdiff-breaking change → land behind an explicit **oasdiff exception** for this cutover (acceptable pre-v1-GA / single-instance; documented).
2. **Decode gate** — rewrite `purposeOf()` (`changes-repo.ts:392-402`) to accept the new Type values and **throw on the retired `infra`/`software`** (they must be gone from data first — step 4). Keep the throw-on-unknown safety net.
3. **Engine literals — filterless census.** Replace every inline `"infra" | "software"` union in lockstep — `source-mappings-repo.ts` (17, 28, 45, 70), `reconcile.ts` (547, 670, 711), `plan-service.ts` (151), the `BindingPurpose` type + `DEFAULT_BINDING_PURPOSE` (`executor-bindings-repo.ts:53, 58`). *(This is the exact "incomplete call-site census" bug class — fix the class, grep every literal, not the obvious few.)* Pick a new default Type (likely `configuration`, the most common) or make purpose required at write time.
4. **Data backfill — classify by `(Module, repo content/kind)`, NOT by old column value** (columns are plain `text`, so **no enum-type ALTER**):
   - argocd bindings/mappings → `configuration`.
   - github/CI mappings on image-building repos → `image` (or the specific build Type by artifact); RPM/deb/npm build repos → `rpm`/`deb`/`npm`.
   - Terraform/CDK/Pulumi bindings → `infrastructure`.
   - GitOps-manifest authorities mislabelled `infra` (e.g. `homelab-gitops`, `agentkit-hosting`) → `configuration`.
   - `ALTER COLUMN … SET DEFAULT` on all three columns (`schema.ts:500, 613, 1187`) to the new default; re-point `DEFAULT_BINDING_PURPOSE`.
5. **CLI** — help-text edits only on `--purpose` (rename to `--type`; add `--category` reads where useful). No `.choices()` exists today, so server Zod stays the sole runtime gate; add validation if desired.

The webhook-processor, `proposeChange`, `plan-service`, and the pure `plan-compiler` treat the value as an opaque token and need no logic change beyond the literal census + default.

**Ordering (single coordinated deploy):** ship schemas + engine (steps 1–3, 5) and run the classification backfill (step 4) together; there is no cross-version window to protect because there is one instance. Confirm zero rows remain with a retired value before enabling the `purposeOf()` throw.

---

## Charter alignment

- **Graph-native (principle 2):** Type is a graph-object property / projection column; Category is *derived* (a static map), not stored — **no new top-level table** (PROJECT_CHARTER.md:1236-1247). Scope stays graph-attachment; Module already exists as `pluginModule`.
- **API-first parity (principle 3):** one Zod enum is the single contract source → OpenAPI → SDK → CLI; `pnpm gen` propagates.
- **Additive /v1:** the new values are additive in RESPONSE positions; retiring `infra`/`software` from REQUEST enums is the one deliberate breaking step, taken as a documented oasdiff exception under the single-instance hard-cutover (D3) — *not* a precedent for post-GA breakage.
- **Simplicity-first (principle 7):** a closed two-level taxonomy — three Categories, a small extensible-by-decision Type set — the minimum that resolves the recorded `software`/`infra` collisions and routes correctly, without an open registry.
- **Explainability (principle 6):** Type as the routing key keeps every executor resolution a checkable, auditable decision rather than a Module guess; ADR-0006's `no_executor` block becomes sharper ("has a `configuration` binding, receives an `image` release").

---

## Non-goals / Deferred

- **Scope walk-up resolution** (component → service → deployment-target → cluster). Recognised-but-unbuilt; its own edge and M12 work (service-component-model.md:84, 121-122).
- **Splitting `infrastructure` or `configuration` into sub-Types.** Deferred until a concrete routing difference (not a Module difference) justifies it — added by deliberate decision (D4).
- **Multi-Type fan-out of a single push.** The "one release = one source = one pipeline" invariant is preserved. A monorepo push that both builds an image and syncs manifests is modelled as two path-scoped mappings (two changes) or via `provides`/`requires` coupling — not one change carrying two Types.
- **Expand/contract compatibility.** Explicitly rejected (D3) for the current single-instance cutover; reconsider only if a hard cutover is needed after federation/outposts exist.
- **Refining the ADR-0006 `no_executor` semantics under Type.** #66 merged to `main` (2026-07-17); its (a)/(b) masking-gap disambiguation already keys on the routing value via `getExecutorBinding`/`listExecutorBindingsForTarget`, so it carries into Type automatically. Sharpening the wording ("`configuration` binding, `image` release") is follow-on, not a dependency.

> **Process:** per project convention this warrants a **DESIGN.md edit** (§12 encodes the two-value model) and a **new ADR** (ADR-0002's four-arm test keys on "class-of-change" = Type/Category). Land those in lockstep with the schema before implementation.
