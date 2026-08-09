# Proposal: an intermediate level between service and component

**Status:** v0.1 Draft — **proposed, pending review.** Nothing built.
**Role:** How to express "a service is made of 2+ macro components, each made of dozens of components" without inventing a parallel hierarchy.
**Relates to:** migration `0021_service_contains_component.sql` (the `contains` type), `0022_contains_single_service_constraint.sql` (one parent per child), `apps/server/src/graph/containment.ts` (`containmentChain`, `nearestAncestorOfKind`), [ADR-0026](../adr/0026-placements-and-derived-stage-names.md), [ADR-0027](../adr/0027-service-rung-binding-resolution.md), `service-component-model.md`, PROJECT_CHARTER principle 2 (graph-native).

Owner ask, 2026-08-04: *"A service might be made up of 2+ macro components that are made up of dozens of components. How do you suggest we organize that?"*

## 1. What the model allows today — measured

| | |
|---|---|
| `contains` | `one_to_many`, `from_types: {service}`, `to_types: {component}` |
| unique index | `relationships_contains_one_service_per_component` on `(org_id, to_id)` — **one parent per component** |
| `depends_on` / `consumes` | `many_to_many` over `{service, component}` — service↔service edges are already legal as *dependencies* |
| `containmentChain` | a **recursive** walk that already handles arbitrary depth, keeping max depth per id |
| `nearestAncestorOfKind` | already exists, and its docblock says it is **safe under the depth tie** because it compares only ancestors of the same kind |

So the graph already walks nesting; only the `contains` **type registry row** forbids it. That single row is the whole structural barrier.

## 2. Options

### Option A — nested services (recommended)

Widen `contains` to `from_types: {service}, to_types: {service, component}`. A "macro component" is then a **service that contains services**; a leaf service contains components. The unique index is unchanged and still means one parent per child.

**Why this and not a new type:** a macro component that owns dozens of components, has its own repos, its own release topology, its own on-call and its own policy scope **is a service** by every behaviour SCP already attaches to the word. Adding a second type that behaves identically is precisely the duplication charter principle 2 warns about, and it would leave two things to keep in sync forever.

**What it gets for free:** `containmentChain` already recurses, so policy resolution, scan requirements and the gate orchestrator inherit nesting with no change. `nearestAncestorOfKind("service")` is the primitive the "which service owns this?" questions need, and it already exists.

### Option B — a new `subsystem` object type

Not a charter violation as such — `object_types` is a registry table and custom types are supported, so this is registry data, not a new top-level table. But every consumer that says "the owning service" must learn a new rung **explicitly**, and nothing inherits the behaviour. It buys a clearer name for a strictly larger census.

### Option C — labels (`macro=payments`)

Rejected. No identity, so nothing can own it, gate on it, freeze it, or attach a release topology to it. The whole point of grouping dozens of components is to have something to *scope* — and a label is the one option that cannot be a scope.

### Option D — reuse the `domain` type

Rejected. `domain` is already overloaded (containment domain vs security/trust domain — [ADR-0021](../adr/0021-terminology.md) had to separate them once), and it carries RBAC and freeze semantics that a product grouping should not inherit by accident.

## 3. The real work is not the type change — it is the ONE-HOP census

Widening the type is one row. The cost is every place that assumes a component's parent is exactly one hop away and is a service. Found by reading the code, not by grep alone:

| Site | Assumption today | Under nesting |
|---|---|---|
| `pipeline-resolution.ts` rung 2 (`owningServiceId`) | the direct `contains` parent | a component under a sub-service would **not** inherit a topology attached to the top-level service |
| `binding-resolution.ts` `owningServiceOf` (ADR-0027) | the direct `contains` parent | same — a cluster binding on the top service would not resolve for a component two levels down |
| `service-board.ts` | `traverse(..., maxDepth: 1)` | a nested service's components **vanish** from the parent's board |
| component create-strict ([ADR-0005](../adr/0005-component-create-strict.md)) | parent must be a service | must accept a sub-service, and refuse a cycle |
| `contains` write path | no cycle possible (types forbade it) | **A contains B contains A becomes expressible and must be refused at write time** |

The first three are the same bug in three places: *walk to the nearest service ancestor, not the immediate parent* — or *walk all the way up*, which differs per site and must be decided per site, not globally.

That pattern — a concept fixed at some of its call sites — is the failure mode this repo has been bitten by repeatedly (`bindings[0]`, the `currents` collapse, the service rung's own first draft). The census belongs in the implementation plan as a checklist, and the cycle check belongs in the same PR as the type widening, never after it.

## 4. Owner decisions (2026-08-04)

- **D1 — walk up, nearest wins.** A component under a sub-service DOES inherit a release topology or
  executor binding attached to an ancestor; the nearest ancestor carrying one wins. Every site listed
  in §3 must state which it implements, and the three that currently read the immediate parent all
  become nearest-ancestor walks.
- **D2 — depth cap of 3.** Bounded so every walk's cost is provable, rather than unbounded nesting.
- **D3 — the board shows DIRECT children plus a per-child-service summary**, and links down. Rolling
  hundreds of descendant components into one table loses what the board is for.
- **D4 — infra scope is the ATTACHMENT POINT, not a correlation rule** (settling the question this
  proposal inherited from `component-journey-view.md` §6 Q2). A cluster serving an org binds at the
  org; one serving a service binds at the service; an S3 bucket serving one component binds at the
  component. There is no rule to write and nothing to infer — where the binding hangs IS the
  declaration of what it serves, and D1's walk-up is what makes a component find it.

  **This extends the walk beyond ADR-0027.** That ADR stopped at the service (its D4) and explicitly
  excluded the org rung. D4 here requires it, so the full walk becomes
  `placement → component → subsystem… → service → org`. That is an amendment to ADR-0027 and should
  be recorded as one.

- **D5 — the term is `assembly`.** A service may contain assemblies; an assembly contains
  components; a component may still sit directly under a service, so the level is OPTIONAL and
  skippable. Chosen over `subsystem` (which echoes the NIST wording inside GLOSSARY's *security
  domain* entry) and over `macro component` (whose name contains the leaf type it contains).
  `assembly` collides with nothing in the codebase or the glossary, and means composed-of-parts,
  which is exactly the relationship. It needs a GLOSSARY entry of its own.

## 5. Why `assembly` and not the alternatives (decided — D5)

The level is OPTIONAL: a component may still sit directly under a service, so the term names a rung
that may be skipped rather than a mandatory one.

| Candidate | For | Against |
|---|---|---|
| `subsystem` | Immediately legible; "service → subsystem → component" reads correctly; free as an identifier — it appears nowhere in the codebase as a type or term of art | Appears in GLOSSARY's *security domain* entry inside a NIST quote ("a system or subsystem under a single trusted authority"), so there is a faint echo to disambiguate |
| **`assembly`** (CHOSEN) | Precise — means composed-of-parts; no collisions anywhere | Unusual in this domain; readers will need the glossary entry |
| `macro component` | The owner's own coinage, so it already communicates | Two words; and containing "component" invites confusion with the leaf type it contains |

**Ruled out by collision**, each already meaning something specific here: `module` (ADR-0007's
executor-tool axis), `group` (the RBAC Groups registry), `domain` (containment vs security domain —
ADR-0021 had to separate those once already), `system` (`execution-system`), `bundle` (GLOSSARY says
always qualify), `stack` (the IaC unit).

## 6. Remaining open questions

1. **Inherit-through or nearest-wins?** For a topology or a binding attached to the top-level service, does a component under a sub-service inherit it (walk all the way up, nearest wins) or not (stop at the nearest service)? Recommend **walk up, nearest wins** — it matches how policy already behaves and is what "the cluster serves the whole service" means — but it is a per-site decision and each site should state which it chose.
2. **How deep?** Unbounded nesting, or a hard cap (e.g. 3)? Unbounded is simpler to implement and harder to reason about; a cap makes every walk's cost provable.
3. **Does the board roll up?** A parent service's board showing every descendant component could be hundreds of rows. Roll up with a per-child-service summary, or show direct children only with a link down?
4. **Naming.** "Service containing services" is accurate but reads oddly in the UI. A `kind` property (`system` / `service`) distinguishing the role without a second type would keep the model single and the vocabulary clear — and would need a GLOSSARY entry either way.
