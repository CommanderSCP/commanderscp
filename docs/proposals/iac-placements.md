# Declaring placements in IaC — finishing §8 item C1

**Status:** Proposed, 2026-08-03. Needs owner review before implementation.
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

## 6. Open questions for the owner

1. **A2 (`component.placeAt(target)`) or A1 (standalone `Placement`)?** Recommendation A2.
2. **Should pruning a placement that still has a binding refuse, or cascade?** Recommendation: **refuse**, with the binding named in the error. A cascade quietly deletes execution configuration the manifest never mentioned, and this estate's bindings carry `external_ref` values that took a careful migration to get right.
3. **Should `placements` be pruned at all in the first release?** A stack that declares none currently means "declares no placements", not "delete them all" — the same rule the other optional collections use. But once a stack *does* declare some, removing one from the manifest must delete it, or the collection is write-only. Recommendation: prune, with the refusal in (2) as the guard.
4. **Does a placement belong to the stack that owns its COMPONENT, or its DEPLOYMENT-TARGET?** Not hypothetical — measured 2026-08-03: the two deployment-targets are labelled `scp:stack=agentkit-org`, and the **pending** `agentkit-monorepo` plan declares those same two URNs (`urn:scp:agentkit-org:deployment-target:gamma|prod`). So a placement's two endpoints can already belong to different stacks on this estate.

   Recommendation: the **component's** stack, matching how `sourceMappings` are already scoped ("a mapping belongs to the stack that owns its component"), and refuse a declaration whose component the stack does not own.

   **Related hazard, worth surfacing on its own.** That overlap is a problem *today*, before any placement work: applying `agentkit-monorepo` would re-label two objects that `agentkit-org` owns, and the agentkit stack file's own header already warns "never move an object between the two stacks without landing both sides in the same change — the losing stack would prune it". Nobody has hit it because `agentkit-org` has no manifest in any repo and so is never re-applied. That is luck, not design.
