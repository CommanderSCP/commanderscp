# Proposal: the service/component model — membership, infra scope, and import

**Status:** Draft — proposed 2026-07-15, pending owner review.
**Supersedes the topology claims in:** [import-existing-executors.md](import-existing-executors.md) (its `coordinated_by` relationship never existed — see §1).
**Relates to:** [ADR-0002](../adr/0002-execution-strategy.md) (Mode A), [ADR-0003](../adr/0003-internal-egress-for-execution-systems.md), [DESIGN.md](../DESIGN.md) §7 (RBAC scoping), §10 (governance), §12 (executors), [PROJECT_CHARTER.md](../../PROJECT_CHARTER.md) principle 2 (graph-native).

## Why now

The 2026-07-15 homelab Mode-A import proved the pipeline works end to end — 50 Argo CD applications discovered and coordinated through one shared plugin instance, `external_ref` correctly wired — and simultaneously proved the result is **not yet a graph**. All 50 landed as orphans: no service, no owner, no relationship to the execution system coordinating them. The graph cannot answer "what coordinates this component?" or "what does this Argo CD manage?"; only the `executor_bindings` projection table can. For a graph-native system of record (charter principle 2), that is the wrong place for it.

Owner decisions taken during that review (2026-07-15) frame this proposal:

> **"We should never prevent users from importing their resources. Initially they won't be topographically correct yet, but we can have them change it after. We can enforce it for newly created services though."**

> **"Each component needs to be part of a service."** … **"All services involve infra and software. In some cases the infra is managed by the component, in others it's shared across a service or subset of components."** … Dependencies are **optional, but enforceable at the org or service level**.

## 0. The governing principle: import is permissive, create is strict

Two paths with different rules, and this shapes every decision below:

- **Import** must never be blocked by topology requirements. Imported objects land as-is and incomplete. This is not a compromise — it is the only honest behaviour, because discovery *cannot* know the operator's service model (§2).
- **Create** may be strict. A human authoring a new component can be required to say which service it belongs to.

Anything that would make import fail a topology check is out of scope by construction.

## 1. What we verified (and what the docs claimed)

Grounded against the code, not assumed — the last proposal's central claim turned out to be fiction, so each of these carries evidence:

| Claim | Reality |
|---|---|
| discovery emits a `coordinated_by` relationship (import-existing-executors.md:48,64) | **False.** `packages/plugins/argocd/src/index.ts:466` hardcodes `relationships: []`, and `coordinated_by` was never a registered type. The real `coordinates` is `{campaign,initiative} → {change,campaign}` — unrelated. |
| a component belongs to a service | **No such relationship type exists.** `owns` is `{team,group,user,service-account} → {service,component,…}` (ownership); `depends_on`/`consumes` are peer edges. |
| `component → service → domain → organization` containment, used for RBAC + policy (DESIGN.md:367, :479) | **Not realized.** `authz/resolve.ts` and `governance/policy-resolve.ts` both walk **`objects.domain_id` only**. Components and services are *siblings* under a domain; service never appears in the chain. |
| a component has one executor binding | **Enforced in the DB**: `UNIQUE (org_id, target_object_id)` (`schema.ts:1174`), and `upsertExecutorBinding` keys only on `(org, target)` — so binding a second pipeline *silently replaces the first*. |

## 2. Membership: `service → component`, not `component → service`

The intuitive modelling — `component --part_of--> service`, cardinality `many_to_one` — **cannot work**, twice over:

1. `many_to_one` is not a legal value. `CardinalitySchema = z.enum(["one_to_one","one_to_many","many_to_many"])` (`packages/schemas/src/graph.ts:19`), so the API rejects it.
2. `assertCardinality` (`graph/relationships-repo.ts:51-70`) implements only `many_to_many` (no-op), `one_to_one`, and `one_to_many`. There is **no `many_to_one` branch and no default** — force-insert it via SQL and every check falls through. It would be silently unenforced.

**Proposal:** register `contains` as `from_types: [service]`, `to_types: [component]`, `cardinality: one_to_many`. `one_to_many` restricts the **`to`** side to one live incoming edge — i.e. *each component has at most one service; a service has many components*. Exactly the required semantics, using enforcement code that already exists.

This is pure registry data — one `INSERT` into `relationship_types`, no DDL, no engine change — following the precedent of `0007` (`coordinated-change`/`correlates`) and `0019` (`execution-system`). Charter principle 2 holds.

**Open:** name (`contains` vs `comprises` vs `groups`). Direction is not open — it is forced by the cardinality implementation.

## 3. The blocker: service-scoped enforcement does not exist

This is the most important finding in this document, and it is **independent of §2**.

The requirement "dependencies … enforceable at the org or **service** level" assumes a policy or permission scoped at a service reaches that service's components. It does not. Both containment walks are `domain_id`-only recursive CTEs (`authz/resolve.ts:52-67`, `governance/policy-resolve.ts:32-53`). A component's real chain today is `component → domain → org`. **Adding §2's relationship changes nothing here** — the walks don't traverse relationships at all.

So service-level enforcement requires **updating both containment queries** to traverse the new edge. Until then, a service-scoped policy is inert against its components, silently. That is the same failure shape as the `coordinated_by` fiction: documented behaviour that no code implements.

**Open (needs owner input):**
- Should service membership confer **RBAC inheritance** too (a role bound at a service grants over its components)? That is a real authorization change, and it should be decided deliberately rather than inherited by accident from a modelling edit.
- Cost/complexity of the recursive walk once it follows both `domain_id` **and** a relationship edge.

## 4. Infra scope: the (a)/(b)/(c) split

> "All services involve infra and software. In some cases the infra is managed by the component, in others it's shared across a service or subset of components."

| case | example | needs |
|---|---|---|
| **(a)** infra managed **by the component** | a fleet of static instances with its *own* infra pipeline **and** its own software-deploy pipeline — both belong to one component | **two bindings on one component** (§5) |
| **(b)** infra shared **across a service** | microservices whose only per-component thing is the image deployment | a binding on the **service**, resolvable from a component (§5) |
| **(c)** infra shared **across a subset of components** | between (a) and (b) | **a new construct** (§6) |

## 5. Bindings: 1:1 → 1:N, and service-level resolution

**(a) needs 1:N.** Today `UNIQUE (org_id, target_object_id)` makes it impossible, and worse, `upsertExecutorBinding` (`executor-bindings-repo.ts:140-157`) looks up by `(org, target)` and **updates in place** — so today, binding infra then software to one component destroys the first binding *silently*.

Proposed: add a discriminator (`purpose`, e.g. `infra` | `software`), replace the index with `UNIQUE (org_id, target_object_id, purpose)`, and thread it through the read path.

What we verified about the blast radius:
- ✅ `change_wave_targets.executor_plugin_id` stores the **plugin instance id as a free string**, not an FK to `executor_bindings.id` (`wave-targets-repo.ts:70-74`) — dropping the unique index does **not** break waves.
- ✅ `listExecutorBindings` (used by `observe.ts:160-174`) is already 1:N-tolerant at the SQL level.
- ❌ `getExecutorBinding` does `.limit(1)` with **no `ORDER BY`** — with the constraint gone it returns an arbitrary row. Every caller assumes exactly one.
- ❌ **The wave model cannot express *which* pipeline to trigger.** `plan-compiler`'s `CompiledWave.targets` is `string[]` of bare object ids — there is no notion of a binding/purpose. So "roll the infra, then the software" is **not expressible today** even with 1:N bindings.

**(b) is not just a targeting question.** A binding *can* technically point at a service — `target_object_id` is a bare UUID with no type constraint (`schema.ts:1156`). But **no resolution logic lets a component's wave target fall back to its service's binding**: every call site keys strictly off the target's own object id (`reconcile.ts:629`). So (b) needs new resolution — "component has no binding of purpose X → walk to its service" — which depends on §2's edge existing.

**Open:** is `purpose` a closed enum (`infra`|`software`) or free-form? A closed enum is checkable and matches the owner's framing; free-form is more flexible and less enforceable. And how does a wave say *"the infra one"*?

## 6. Case (c): a genuinely new construct

Neither existing candidate fits, and we checked before inventing:

- **`release-topology`** is a *per-change* wave-ordering document (`properties.waves: [{mode, targets}]`, `0007_change_coordination.sql:289-311`), snapshotted per compiled plan so later edits never affect in-flight changes. It describes rollout *strategy* (canary/blue-green/rolling), not durable membership.
- **`group`** is a **principal** grouping — "arbitrary collections of users" (charter:714). `member_of` is `{user,service-account,group,team} → {group,team}`: service and component appear on **neither** side. It is structurally barred from attaching to resources.

**Options (owner call):**
1. **A new object type** (e.g. `component-group`) with membership edges — most explicit, another type in the registry.
2. **Attach infra bindings to an arbitrary "scope-holder"** and let (c) be *"a binding on a service that only some components resolve to"* — avoids a new type but needs per-component opt-in, which is a relationship anyway.
3. **Defer (c)** — ship (a) and (b), and treat (c) as a service-level binding until real demand shapes it.

I recommend **3 for v1**: (a)+(b) cover the owner's two concrete examples; (c) was described as the in-between case without a driving example yet, and inventing a grouping type before it has a shape risks a second `release-topology` (a construct that exists but doesn't fit).

## 7. Import and the "organize after" flow

Import already satisfies the governing principle: nothing requires a component to have a service, so imports cannot be blocked. What is missing is the **after**.

- **Granularity mismatch:** `argocd-discovery` maps **1 Argo CD app → 1 component**. Under the owner's model, an infra pipeline and a software pipeline are **2 apps → 1 component with 2 bindings** (§5). So organizing is not merely "assign a service" — it is **merge/regroup**, and there is no API for it. Users must currently delete and recreate, losing the bindings.
- **Enforcement on create** cannot live in the shared object-write path if `discovery/accept` uses it: it needs a write-time hook that can distinguish a create from an import. The generic relationship endpoint cannot compel an edge to exist at object-creation time (the object and its edge are two calls), so "a component must have a service" is enforceable at create **only** by a dedicated create path that takes the service inline.

**Proposal:** `POST /components` (or `create` gaining a required `serviceId`) creates object **and** edge in one transaction, and is the *strict* path. `discovery/accept` stays permissive. The requirement then lives in the strict path, not in validation shared by both.

**Open:** what does the organize-after flow look like (assign, merge, split, re-point a binding), and is it CLI-first with the UI following, as with `connect argocd`?

## 8. What this means for the 50 already imported

They are orphans and, per owner instruction, must be assigned. That is blocked on §2 landing, and half of them (`homelab-pihole`, `homelab-minecraft`, `homelab-loki`, …) have **no service to assign to** — services would have to be created first. This is the normal case for anyone importing a real estate of applications, not an edge case, and it is the strongest argument that §7's organize-after flow is the actual product surface, not an afterthought.

## Phasing (proposed)

- **P1 — membership.** Register `service --contains--> component` (`one_to_many`). Migration + CLI. Unblocks assigning the homelab's 50.
- **P2 — containment.** Teach `authz/resolve.ts` + `governance/policy-resolve.ts` to traverse it; decide the RBAC-inheritance question (§3). **Without this, "enforce at the service level" does not work.**
- **P3 — bindings 1:N.** `purpose` discriminator, index change, `getExecutorBinding` call-site audit, service-level fallback resolution for (b).
- **P4 — waves.** Let a wave target a `(component, purpose)` rather than a bare object id — otherwise 1:N is unusable by coordination.
- **P5 — create-strict + organize-after.** The strict create path and the assign/merge API.
- **Deferred:** case (c) (§6), pending a driving example.

## Decisions needed before implementation

1. §2: relationship name.
2. §3: **does service membership confer RBAC inheritance?** (real authz change)
3. §5: `purpose` closed enum or free-form; how a wave names a binding.
4. §6: new grouping type now, or defer (c)?
5. §7: strict create path shape; organize-after surface.
