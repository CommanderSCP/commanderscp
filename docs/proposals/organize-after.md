# Proposal: create-strict + organize-after (M12 P5)

**Status:** Draft — proposed 2026-07-16, pending owner review.
**Relates to:** [service-component-model.md](service-component-model.md) (§7–8 and its P5 phasing line), migrations `0021`/`0022` (`contains` edge + one-service-per-component), `0023` (executor bindings 1:N by purpose), [PROJECT_CHARTER.md](../../PROJECT_CHARTER.md) principles 2 (graph-native), 3 (API-first parity), 6 (explainability).

---

## Why now

Two things the service/component model promised but never delivered, and one concrete backlog they block:

> **Owner ruling (2026-07-15):** *"Users shouldn't be able to create a component without an associated service. Though the import process should be able to bypass that. For that, we can organize after."*

1. **Create-strict** — a component *created directly* must belong to a service; a component *imported* need not (organize later). Today **neither half exists**: a bare orphan component can be created through the typed `POST /components` route, and there is no way to require a service at create time.
2. **Organize-after** — the API to assign an imported orphan to a service, and to **merge** the common case where one real component was imported as two (an infra Argo CD app + a software Argo CD app → one component with two purpose-keyed bindings). Assign is almost free; merge does not exist at all.

**The driving case is concrete and already on the homelab:** `scp connect argocd` imported **50 Argo CD apps as 50 orphan components + 50 executor bindings**, none belonging to a service. The owner has said they must be assigned — and half have no service to assign to yet, so services must be created (strictly) first. This is the normal shape for anyone importing a real estate of applications, not an edge case.

---

## 1. What we verified (and what the docs / prior analyses claimed)

Grounded against code (a 4-probe survey + a 12-claim adversarial pass, every claim traced to `file:line`). This project's comments and prior analyses lie, so the corrections matter.

### 1.1 The create surface — the incomplete-census trap

`component` can be minted through **seven** entry points, all funnelling to one function — `createObject` (`graph/objects-repo.ts:138`, the only `insert(objects)` in the codebase):

| Entry point | Must become |
|---|---|
| typed `POST /components` (`typed-registries.ts:173`) | **strict** |
| typed `PUT /components/{urn}` upsert (`objects-repo.ts:536`) | **strict** |
| generic `POST /objects/component` (`objects-generic.ts:143`) | **refuse** |
| generic `PUT /objects/component/{urn}` | **refuse** |
| `discovery/accept` (`executors.ts:708`, server-side) | **permissive** |
| IaC `executePlanDiff` (`plans-repo.ts:470`, server-side) | permissive — see open Q2 |
| federation import / overlay (`import-repo.ts:155` / `overlay-repo.ts:78`) | **permissive** |

**The structural fact that makes the owner ruling implementable:** the permissive paths (discovery/IaC/federation) call `createObject` *directly, server-side, never through a route*. So enforcement at the **HTTP-route layer** automatically leaves them untouched — exactly the "import bypasses" the owner wants. Enforcement *inside* `createObject` would wrongly block them, and would break `seed.ts` (which mints orphan demo components). `validateWrite` is not a viable home either — it's a pure `void` validator with no `serviceId` and no ability to create an edge (`typed-registries.ts:158`).

### 1.2 The precedent to copy — and the one NOT to

`proposeInitiative` (`coordination/initiative-repo.ts:114–168`) does exactly the shape create-strict needs, in one `withTenantTx`: `createObject` → `authorize(relationship:write)` on both endpoints → `createRelationship` → `insertDecision`. Create-strict is that, with `contains` swapped for `coordinates`.

The prompt's original hypothesis — model it on campaign/change — is **wrong**: those store targets as a `properties.targets` *array*, not edges (`campaign-scope-authz.ts:9–14`). Do not model P5 on them.

### 1.3 The `contains` edge is fully wired — assign is nearly free

Registered `service → component`, `one_to_many`, builtin (`0021:24–27`). `createRelationship` validates endpoint types and enforces `one_to_many` (a second incoming `contains` is a 409 via `assertCardinality`, `relationships-repo.ts:53–68`), backstopped against the check-then-insert race by the `0022` partial unique index on `(org_id, to_id) WHERE type_id='contains' AND deleted_at IS NULL`. It is **not** system-managed (`system-managed-relationships.ts` blocklist is `{approves, coordinates, annotates}`), so the generic `POST /relationships` already creates it with correct typing, cardinality, race-safety, and **both-endpoint** authz. And `contains` **drives real behaviour** — RBAC scope expansion, policy resolution, freeze scoping, and approval scope all walk it (`authz/resolve.ts:90–95`, `graph/containment.ts:101–108`, `gate-orchestrator.ts:87,183`) — so a mis-assign silently moves a component under the wrong service's roles, policies, and freezes. That is the security reason `0022` exists.

### 1.4 Proven-false claims (prior analyses / assumptions)

1. **"Merge must re-point *jsonb* wave-targets" — FALSE.** Persisted wave targets are UUID columns (`change_wave_targets.target_object_id` `schema.ts:608`, `campaign_wave_targets.target_object_id` `schema.ts:886`). The jsonb `properties.targets` lives on the change/campaign *object*, not the wave-target rows.
2. **"Component-scoped `role_bindings` are a live merge concern" — FALSE today.** The only two production writers (`auth/local-auth.ts:84`, `auth/oidc.ts:178`) both scope to the org **root**; no route grants a caller-chosen component scope. So component-scoped role-binding re-pointing is moot.
3. **The general merge is mostly moot for the driving case.** Fresh imports have no in-flight changes, no `source_mappings` (§1.5), no component-scoped role_bindings, no freezes, and no services. The entire re-point surface collapses to **the executor bindings** — the one reference type that genuinely exists (50 live rows).

### 1.5 Two real bugs the survey surfaced (worth fixing regardless of P5)

- **Orphaned bindings are polled forever.** `observeOrgTick` enumerates bindings via `listExecutorBindings`, which selects `WHERE org_id = ?` with **no object-liveness / `deleted_at` filter** (`executor-bindings-repo.ts:144–153`). So soft-deleting a component does **not** stop its binding from being polled every tick — and there is no API to delete a binding. Merge cannot rely on soft-deleting the loser object; it must detach the binding explicitly. Fixed in P5c.
- **Import creates no `source_mappings`.** `discovery/accept` writes components + bindings but never a mapping (only the manual `POST /change-sources/:kind/mappings` route calls `createSourceMapping`). So the 50 imports can be *triggered* but never *self-report* via observe — pulled events correlate against nothing and drop. This is arguably a bigger lever for the homelab than merge; see open Q3.

---

## 2. The design

### 2.1 Create-strict

- **Refuse `component` on the generic object route** (all write verbs), mirroring how `campaign`/`change` are refused — **but via a NEW `SERVICE_MEMBER_OBJECT_TYPE_IDS = {component}` set + `assertNotServiceMemberObjectType`, not by reusing `COORDINATION_TARGET_SCOPED_OBJECT_TYPE_IDS`.** That set's documented meaning is *target-authority binding*; a component's reason is *service membership*. Reusing it would be exactly the semantic-lie-in-a-comment this repo is full of. Cost of the refusal itself: **zero** — a filterless census found nothing creates a component via the generic route today.
- **Replace the typed `component` template with a bespoke strict route.** Remove `component` from the typed-registry template set and register a hand-written `POST /components` + `PUT /components/{urn}` whose body is a new `CreateComponentRequestSchema` = the generic object fields **plus a required `serviceId`**. The handler is one `withTenantTx`: `createObject({typeId:"component"})` → `authorize(relationship:write)` on the component and the service → `createRelationship("contains", service→component)` → Decision. The one-service index and endpoint typing come free.
- **The real, bounded cost:** **74 `components.create`/`upsertByUrn` call sites across 9 files** (heavily the coordination/campaign tests) plus `seed.ts`, none of which passes a `serviceId` — they mint bare orphan components as coordination targets. This is the honest price of the owner's own ruling. Mitigation: a `createComponentInService(admin)` test helper (create a throwaway service, then the component), applied mechanically; and `seed.ts` gains a demo service so the built-in seed stops violating the invariant P5 introduces. This is a genuine behaviour change (a bare-component create now 400s), landed with its test migration in the same PR.

### 2.2 Assign (+ move)

- **`assignComponentToService(componentId, serviceId)`** — a thin typed convenience over the existing generic `contains` edge (same both-endpoint authz), closing the missing `contains` SDK helper (the SDK has `addComponentOwner/DependsOn/Consumes` but **none for `contains`**). No new engine path.
- **`moveComponentToService`** — re-assign is delete-old-edge + create-new-edge; as two HTTP requests it momentarily orphans the component (soft-delete frees it because both the cardinality check and the `0022` index filter `deleted_at IS NULL`). A verb doing delete+create in **one** tx removes that window. Cheap; recommended.
- Fix the misleading `0022` race 409 (`"relationship id … already exists"`) to a one-service-per-component message.

### 2.3 Binding primitives (prerequisite for merge, valuable alone)

The executor-binding surface is `get`+`put` only — **no delete, no re-point** — itself a parity hole. Add:
- **`deleteExecutorBinding`** (there is none today).
- **`setExecutorBindingPurpose` / re-point target** — because `upsertExecutorBinding` keys its lookup on `(target, purpose)`, *changing* a purpose today is an INSERT of a new row that leaves the stale one un-removable. Merge's mandatory relabel (§2.4) is impossible without this.
- **Fix the `listExecutorBindings` liveness bug** (§1.5) so soft-deleted targets stop being polled.

### 2.4 Merge (driving-case scope only)

For the owner's case (2 fresh argocd orphans → 1 component, 2 bindings), the binding-purpose collision is **guaranteed, not incidental**: both discovery imports default to `purpose='software'`, and `UNIQUE(org_id, target_object_id, purpose)` forbids two `software` bindings on the survivor. So one must be relabelled `infra`. Built on P5c, driving-case merge is one transaction: relabel the loser's binding to `infra` (or as directed — see open Q1), re-point its `target_object_id` to the survivor, delete the loser's binding, soft-delete the loser object (now binding-free), and resolve the surviving service — gated on **no in-flight (proposed/waiting/executing) change** on either target (reconcile resolves bindings fresh at trigger time and silently no-ops if a binding moved mid-flight), with **both-endpoint authz across loser, survivor, both services, and every moved binding's target**, and a full Decision recording exactly what moved. The general graph-rewrite (jsonb re-points, FK re-points, immutable-row guards) is explicitly **out of scope** until a non-fresh merge case demands it.

---

## 3. The owner's fixed decisions, and how this honours each

- **"Create strict, import permissive"** → enforcement at the HTTP route (strict typed `POST /components` + generic-route refusal); the server-side import paths are untouched by construction (§1.1).
- **"Organize after"** → assign/move/merge operate on already-imported orphans; nothing blocks the import.
- **The 50 orphans "must be assigned"** → **P5a + P5b together unblock this** (create the missing services strictly, assign the rest).

---

## 4. What this deliberately does NOT do

- **No new tables** (charter principle 2): `contains` is a registered relationship type; binding re-point/delete mutate the existing `executor_bindings` row; merge provenance is captured by the hash-chained audit + Decision, not a "merge history" table.
- **No general merge**: only the fresh/history-free driving case (§2.4).
- **No split**: no driving case (open Q4).
- **No auto-inference of couplings or mappings**: assign is explicit (open Q3 asks whether organize should *also* create `source_mappings`).

---

## 5. Proposed phasing (smallest-first, each independently shippable & behaviour-preserving except where noted)

- **P5a — Create-strict.** Bespoke strict `POST /components` + `PUT /components/{urn}` requiring `serviceId`; refuse `component` on the generic route via a new `SERVICE_MEMBER_OBJECT_TYPE_IDS` guard; the 74-site + `seed.ts` test migration. *Intentional behaviour change (bare create now 400s), gated and landed with its tests.*
- **P5b — Assign (+ move).** Typed `assignComponentToService` (closing the `contains` SDK gap) + atomic `moveComponentToService`; fix the `0022` race message. **P5a + P5b unblock the 50 orphans.**
- **P5c — Binding primitives.** `deleteExecutorBinding` + `setExecutorBindingPurpose`/re-point to full binding CRUD parity, **and** the `listExecutorBindings` liveness-filter bug fix. Independently valuable; prerequisite for merge.
- **P5d — Merge (driving-case scope).** Built on P5c (§2.4).
- **P5e — Split.** Deferred; build only if a case appears.

Every phase carries the full API → SDK → CLI → IaC → UI parity checklist (CI's oasdiff/drift gate catches a missed SDK regen; it does **not** catch a missed CLI or UI, so those are explicit checklist items — the exact hole P4A/P4B each slipped through once).

---

## 6. Open questions for the owner

The code already answers several (assign needs no engine verb; one-service-per-component is doubly enforced; merge needn't touch jsonb/role_bindings for the driving case; the shared-instance observe shape is safe). These genuinely need your call:

**Q1 — Merge's binding-collision resolution when both bindings are truly `software`.** The UNIQUE constraint forbids two `software` bindings on the survivor. Options: **(a)** reject the merge and require the operator to relabel one first (safest MVP); **(b)** auto-relabel the second to `infra` (right for the argocd infra+software case, wrong if both are genuinely app pipelines); **(c)** make the purpose mapping an explicit merge *parameter*. Leaning (c); (a) is the safe MVP.

**Q2 — Should IaC-applied (and generic-import) components also be forced to have a service?** Your ruling named only "the import process" (discovery) as the bypass. IaC `executePlanDiff` is arguably a *deliberate declarative* create, not an import — a component in HCL can declare its `contains` edge as a sibling resource. Options: **(a)** leave IaC permissive (simpler, matches "declarative"); **(b)** extend strictness to IaC.

**Q3 — Should assign/organize also create `source_mappings`?** The 50 imports have none, so their observed events correlate against nothing and drop (§1.5) — they can be triggered but never self-report. Options: **(a)** keep organize purely about services/bindings; **(b)** make discovery/accept (or a new organize step) also propose `source_mappings` so imports actually wire observe. This is arguably a bigger homelab lever than merge; worth deciding whether P5 owns it.

**Q4 — Is SPLIT in scope?** No driving case exists. **(a)** defer (recommended); **(b)** design merge's inverse now for symmetry.

**Q5 — CLI-first vs UI-first for organize.** The 50-orphan cleanup is bulk and scriptable → CLI/API is the natural first surface, UI tracked one phase behind (parity stays a hard requirement, just sequenced). Confirm the homelab cleanup is done via CLI so the UI can lag.

**Q6 — Move: atomic verb, or accept the two-request dance?** Delete-then-create works today (momentary orphan window). **(a)** ship non-atomic + document; **(b)** build `moveComponentToService` as one tx (cheap, cleaner — recommended in P5b).
