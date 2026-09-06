# construct

Reference for `packages/iac/src/construct.ts`. The source carries a one-line headline at each site and points here.

> Partial: 9 of 56 multi-line comment blocks in this file have been
> moved here. The rest are still inline pending a hand-written one-line headline.

## §1. Slash-joined construct-tree path from the root, e.g

Slash-joined construct-tree path from the root, e.g. `billing-platform/billing-api` (team-pipeline-iac.md D16(5)) — every synth validation error names this, so a refusal maps back to the construct a team actually wrote, not just an array index in the assembled manifest. `App` is excluded from the path (it is synth plumbing, D15a, and never appears in user-facing IaC).

## §2. Root scope every `Stack` sits under

Root scope every `Stack` sits under. `App` itself never appears in a manifest — it is purely in-memory synth plumbing (`Construct.path` excludes it, mirroring real CDK's `App`), and it is NOT part of `@scp/iac`'s public surface (D15a: "`App` disappears from user code entirely"). `new Stack("platform-estate")` auto-creates one internally; no user-facing IaC file ever needs to write `new App()`, because there is no longer any form of `Stack`'s constructor that accepts one.

## §3. L1 — the guaranteed raw manifest-entry door (D16(1))

L1 — the guaranteed raw manifest-entry door (D16(1)). Appends `object` to this stack's `objects` VERBATIM, exactly as if a typed construct had synthesized it — no L2 construct (`Service`, `Component`, …) sits between this call and the manifest, and none of them can block it: this method takes any `typeId`, including one no typed construct in this package knows about yet. It is what makes "no L2 construct may block reaching L1" structurally true rather than a promise — there is no registry of "known" typeIds this checks against.

The one thing it does NOT do that a typed construct does: derive a URN when one is omitted. `ManifestObjectSchema.urn` is required, so callers supply it — `deriveConstructUrn` (`urn.ts`, also exported from `./index.js`) is the same deterministic algorithm every typed construct uses, so an L1 entry can reproduce an L2 one byte-for-byte (see `construct.test.ts`'s "an L1 addManifestEntry object and its L2 equivalent synthesize identically" case).

## §4. L1 — the guaranteed raw relationship door (D16(1))

L1 — the guaranteed raw relationship door (D16(1)). Declares an edge of ANY `typeId`, from and to any construct/reference/URN — the same escape hatch `addManifestEntry` is for objects. `dependsOn`/`consumes`/`owns` are convenience sugar over exactly this call (with `from` fixed to `this`); reach for this one directly for an edge type none of those three name, or when `from` is not the construct doing the declaring.

## §5. Declares an `executor_bindings` row for `target` (C1)

Declares an `executor_bindings` row for `target` (C1). Prefer `target.bindsExecutor(...)`; this form exists for a target referenced by URN from outside this program. Same ownership rule as `addSourceMapping`.

## §6. L1 ESCAPE HATCH for an org-defined role

L1 ESCAPE HATCH for an org-defined role. `permissions` must be strings this system defines AND ones the APPLYING principal holds at the org root — authoring a role that advertises authority its author cannot confer is refused at the door, not here.

## §7. TWO OBJECTS, ONE URN

TWO OBJECTS, ONE URN — REFUSED HERE, BEFORE THE MANIFEST CAN CARRY BOTH.

A URN is derived from `(stackName, construct id)` through `slugify`, WHICH LOWERCASES. So sibling constructs whose ids differ only in case — `Api` and `api`, `payBlue` and `PayBlue` — are two distinct constructs (the tree's own duplicate-id check compares ids exactly, and CDK semantics say those are different resources) that derive ONE URN. Punctuation folds the same way: `pay-blue` and `pay_blue` both slug to `pay-blue`.

Nothing downstream could catch it. `DesiredStateManifestSchema` has no cross-entry constraint, and the server DIFFS BY URN (`iac/plan-diff.ts`), so the second entry silently becomes an update of the first: one of the two objects the author declared never exists, and the plan reads as a clean create + update. The symptom is a missing object, discovered whenever someone goes looking for it.

MEASURED, not theorised: `new Service(stack, "Api", …)` beside `new Service(stack, "api", …)` synthesized two entries both carrying `urn:scp:probe:service:api`. Found by the fast-check generator in `products.test.ts`, which produced the id pair `("F", "f")` and hit `collectProducts`'s identifier-collision throw — the products module was the only place in the library incidentally protected, and only because `camelIdentifier` folds case too.

Named by CONSTRUCT PATH, not by URN: the URNs are identical (that is the defect), so printing them twice tells the author nothing about what to change. The paths are what differ and what they must rename — D16's construct-path error rule, which the validation branch below already follows.

## §8. Base class for the 8 typed-registry resource constructs

Base class for the 8 typed-registry resource constructs. `typeId` is fixed per subclass (`Service` -> `'service'`, etc.) via `defineResourceConstruct` below, mirroring `routes/typed-registries.ts`'s server-side "one factory, invoked per resource" pattern instead of 8 hand-copied classes.

Generic over `TypeId` (D16(2)) so an OWNED construct structurally implements the SAME `IResourceRef<Kind>`-family interface a `fromXxx()` reference returns — `new Service(...)` is an `IService` and `Service.fromName(...)` is an `IService`, interchangeable wherever the interface is accepted, which is the whole point of the reference statics.

## §9. A component (server-side object type `"component"`)

A component (server-side object type `"component"`). Unlike the uniform `defineResourceConstruct` types, `Component` is a bespoke subclass because create-in-service is strict: it emits a `contains` edge from `props.service` to itself so the synthesized manifest satisfies the strict apply invariant. Re-assignment (moving a component between services) is P5b's `move` verb, not an IaC concern here.

Carries its own `fromName()`/`fromUrn()` statics (D16(2)) rather than going through `defineResourceConstruct` — same contract as every other typed-registry construct (`ResourceConstructStatics<"component">`), hand-written here because `Component` already is.

TWO CONSTRUCTOR FORMS (team-pipeline-iac.md D15a/D17 round B): `new Component(scope, id, props)` (round A, unchanged) for a `Component` declared inside an existing `Stack`, and `new Component(name, props)` for a MULTI-PIPELINE repo's root file — "a multi-pipeline repo roots at `Component`" (D17) — which auto-creates its own `Stack` exactly the way a root `Pipeline` class does (`pipeline.ts`), so `App`/`Stack` stay absent from that file's own code (D15a).
