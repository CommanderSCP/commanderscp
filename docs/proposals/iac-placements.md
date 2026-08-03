# Declaring placements in IaC — finishing §8 item C1

**Status:** **ACCEPTED 2026-08-03 — all four open questions decided (§6). Ready to implement.** The design in §3/§4 stands as written; §6 records the four rulings and what each costs.
**Relates to:** [ADR-0026](../adr/0026-placements-and-derived-stage-names.md) (D2/D3/D17 — the pair type and how its endpoints are stored); [post-import-configuration.md §8](post-import-configuration.md) (item C1); PR #207 (pair-bound types refused at every generic write door).

## 1. What is actually missing

C1 is **mostly built**, which was not obvious and is worth stating plainly because at least one in-tree comment still says otherwise. `DesiredStateManifestSchema` already carries `sourceMappings` and `executorBindings`, and `plan-diff.ts` already diffs and prunes them.

What is missing is the **`placement`** type. And the gap is not cosmetic:

| measured on the live homelab, 2026-08-03 | |
|---|---:|
| live placements | 61 |
| executor bindings on a **placement** | **61** |
| executor bindings on a deployment-target | 4 |
| executor bindings on a component | 1 |

After the ADR-0026 §6 migration, **92% of the estate's executor bindings hang off a placement**. A manifest's `executorBindings[].targetUrn` must name an object that exists, and IaC cannot create a placement — so C1's binding support, though real, cannot express 61 of 66 bindings on this estate. The one feature is blocked by the other's absence.

The same is true of the estate's shape generally: 61 objects and every pipeline attachment the migration produced are unreproducible from a manifest. A stack that "declares the agentkit service" today describes its components and is silent about where any of them run.

## 2. The constraint that shapes the design

A placement **cannot** be declared as a raw `objects[]` entry. That door is refused by construction at every generic write surface (PR #207), because a free-form `properties` door:

1. stores two UUIDs without resolving or type-checking them,
2. cannot write the derived `places`/`placed_at` edges, leaving an island invisible to every traversal and impact query,
3. cannot derive the URN, which is built from both endpoints.

That refusal was added at two doors after both were **proven** to write edgeless islands. So this proposal must not reach for "just let IaC declare it as an object" — the guard is the reason the type is safe, and relaxing it for one caller reintroduces exactly what it prevents.

## 3. Options

### Option A — a typed `placements` manifest collection (recommended)

A fourth side-table collection beside `sourceMappings` and `executorBindings`, following their established shape: addressed by the URNs of the objects it relates, optional so an older manifest stays valid, pruned within the stack.

```ts
export const ManifestPlacementSchema = z.object({
  /** URN of the component being placed. Must be an object THIS stack owns. */
  componentUrn: UrnSchema,
  /** URN of the deployment-target it is placed at. */
  deploymentTargetUrn: UrnSchema
});
```

**Identity is the pair** — `(componentUrn, deploymentTargetUrn)` — matching the table's partial unique index. Deliberately **no `urn` field**: ADR-0026 D3 makes the URN *derived* from both endpoints, so a manifest that supplied one could disagree with what the typed route would mint, and the two would diverge silently. Addressing by the pair is the only self-consistent choice, and it is what makes a re-synth converge.

Apply must call the same repo function `POST /v1/placements` uses, **not** `createObject` — that function is what writes the two derived edges in the same transaction. This is the whole reason the collection is typed rather than generic.

### Option B — relax the pair-bound refusal for the IaC path

Rejected. It re-opens what #207 closed, at the one door that is user-authored rather than an import path. The refusal is not a policy preference; it is the mechanism that guarantees a placement is traversable.

### Option C — leave placements out of IaC, document them as API-managed

Rejected, but it is the honest status quo and worth naming. It means 61 objects, all 61 placement-scoped bindings, and the entire output of the §6 migration stay unreproducible — a stack that cannot describe where anything runs is not a description of the estate. It also guarantees drift: the estate has already drifted once this session (the `environment` properties), and that was caught only because someone looked.

## 4. Design detail, if A is chosen

**Ordering.** Apply must sequence: objects → **placements** → executorBindings/sourceMappings. A binding targeting a placement is unresolvable before the placement exists, and both existing side-collections already assume their target object is created earlier in the same apply.

**Prune ordering is the reverse, and matters more.** A placement pruned while its binding still exists orphans the binding — `executor_bindings` has no FK and no `deleted_at`, and its reader-side guard (`targetObjectIsLive`) makes the orphan *inert but invisible*, which is worse than an error. So prune must run bindings-before-placements, and a plan that would prune a placement whose binding is NOT in the same prune set should refuse rather than proceed.

**Adoption, not duplication.** The estate's 61 placements already exist. A plan must diff on the pair and emit `noop` for a match, never `create` — a duplicate would be rejected by the partial unique index at apply time, turning a re-synth of the current estate into a failed apply. This is the same adoption property the explicit-URN convention gives objects today.

**Authoring construct.** Two shapes are possible and the choice is a real one:

```ts
// A1 — standalone construct
new Placement(stack, "keycloak-prod", { component: keycloak, deploymentTarget: prod });

// A2 — sugar on the component
keycloak.placeAt(prod);
```

A2 reads better, makes an orphan placement unexpressible, and matches how `dependsOn`/`consumes`/`owns` already work. A1 is more uniform with every other construct and gives the placement a construct id for later reference. **Recommendation: A2**, with A1 available if a placement ever needs its own properties.

## 5. What this does not solve

**`hosted_on` still has no fluent method** — the agentkit stack declares those edges through `stack._registerRelationship`, reaching past the public surface. Same family, worth fixing alongside.

**Stage names remain underivable from a manifest alone.** They come from `origin_domain_id` + the target's `environment`/`region`, and `origin_domain_id` is assigned server-side. A manifest can declare the inputs but cannot assert the resulting name, so a stack cannot pin "this must be `commercial-nyc3-prod`".

## 6. Decisions (all four settled 2026-08-03)

1. **How is a placement authored? — DECIDED: BOTH. `placeAt` is sugar over a standalone `Placement`.**

   `component.placeAt(target)` is the form to reach for, and it constructs a `Placement` underneath rather than a second code path — one implementation, two spellings. The standalone `new Placement(stack, "id", { component, deploymentTarget })` stays available for the case the sugar cannot serve: a placement that needs its own construct id to be referenced later.

   The cost, stated: there are two ways to say one thing from day one, which is a real documentation burden and the kind of thing that later grows divergent behaviour. Two things keep it honest — the sugar must *construct the same object*, not duplicate the logic, and BOTH endpoints stay REQUIRED props on the standalone form. That second point matters more than it looks: it is why "the sugar prevents orphan placements" is not actually the argument for sugar-only. A placement with a missing endpoint is unexpressible either way, because the pair IS the identity (D3) and neither form lets you omit half of it.
2. **Should pruning a placement that still has a binding refuse, or cascade? — DECIDED 2026-08-03: REFUSE, naming the binding.**

   An apply that would prune a placement whose executor binding is not *also* being pruned fails, and the error names the binding. It does not delete it.

   The reasoning that decided it: a cascade quietly deletes execution configuration **the manifest never mentioned**. On this estate those bindings carry `external_ref` values that took a careful, irreversible migration to get right — and the failure mode of losing one is not an error but a *silent* one. An orphaned binding is inert-but-invisible (`executor_bindings` has no FK and no `deleted_at`, and `targetObjectIsLive` hides it at read time), which is precisely the shape of bug this codebase keeps paying for.

   The cost is accepted knowingly: removing a placement becomes a **two-step** operation for the operator — drop the binding, then drop the placement. That is more friction than a cascade, and it is the correct trade when the alternative is a destructive action nobody wrote down. The refusal must NAME the binding, or the operator is left guessing what to remove.

   **Implementation note.** The check belongs on the same prune path as the ordering rule in §4: prune runs bindings-before-placements, so by the time a placement is considered its binding has already gone *if the manifest asked for that*. A surviving binding at that point therefore means the manifest genuinely did not ask — which is exactly the case to refuse on, and it means the check is a cheap lookup rather than a cross-collection diff.
3. **Should `placements` be pruned in the first release? — DECIDED: YES, guarded by (2).**

   Removing a declared placement deletes it. An absent `placements` collection still means "this stack declares no placements" and prunes nothing — the same rule the other optional collections already use — but once a stack declares some, dropping one from the manifest removes it.

   The alternative was rejected for a specific reason rather than a stylistic one: an additive-only collection is *write-only*, so the estate drifts from the manifest with no way to reconcile, and pruning would have to be added later as a behaviour change to stacks already in use. Shipping the destructive half from the start is safe **only because (2) refuses** when a placement still carries execution configuration — the two rulings are load-bearing together, and neither should be implemented without the other.
4. **Does a placement belong to the stack that owns its COMPONENT, or its DEPLOYMENT-TARGET?** Not hypothetical — measured 2026-08-03: the two deployment-targets are labelled `scp:stack=agentkit-org`, and the **pending** `agentkit-monorepo` plan declares those same two URNs (`urn:scp:agentkit-org:deployment-target:gamma|prod`). So a placement's two endpoints can already belong to different stacks on this estate.

   **DECIDED: the COMPONENT's stack.** It matches how `sourceMappings` are already scoped ("a mapping belongs to the stack that owns its component"), so placements need no new ownership concept — and the component is the thing being deployed. A declaration whose component the stack does not own is REFUSED, which is what stops two stacks fighting over one placement and pruning each other's.

   Rejected: the deployment-target's stack, because a platform team owning the targets would then own every app team's placements; and first-writer-wins, which is precisely the mutual-prune failure the live `agentkit-org`/`agentkit-monorepo` target overlap already risks.

   **Related hazard, worth surfacing on its own.** That overlap is a problem *today*, before any placement work: applying `agentkit-monorepo` would re-label two objects that `agentkit-org` owns, and the agentkit stack file's own header already warns "never move an object between the two stacks without landing both sides in the same change — the losing stack would prune it". Nobody has hit it because `agentkit-org` has no manifest in any repo and so is never re-applied. That is luck, not design.
