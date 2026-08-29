import {
  DesiredStateManifestSchema,
  type DependencyEcosystem,
  type DesiredStateManifest,
  type ExecutorType,
  type ManifestDependencyProducer,
  type ManifestGovernanceMoveRung,
  type ManifestExecutorBinding,
  type ManifestObject,
  type ManifestRelationship,
  type ManifestPlacement,
  type ManifestConvergence,
  type ManifestPipelineHook,
  type ManifestRollout,
  type ManifestRoleBinding,
  type ManifestRole,
  type ManifestSourceMapping,
  type RolloutStrategy,
  type RolloutTargetClass,
  type SourceMappingScope
} from "@scp/schemas";

/**
 * `Omit` over a DISCRIMINATED UNION distributes across the members instead of collapsing them into
 * one object type — without this, `Omit<ManifestPipelineHook, "componentUrn">` erases the union and
 * `kind` stops narrowing `workflow`/`stage`/`maxAgeSeconds`, so a `bakeAlarms` hook carrying a
 * `workflow` would typecheck at the L1 door and be refused only by Zod at synth.
 */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
import { deriveConstructUrn, slugify } from "./urn.js";

/**
 * CDK-style construct tree, inspired by AWS CDK's `App`/`Stack`/`Construct` shape but far
 * simpler and written from scratch (no CDK library dependency, per the goal statement). The tree
 * is a plain in-memory object graph; `synth()` is the one place it turns into data
 * (`DesiredStateManifest` — `@scp/schemas`). Nothing here does I/O, reads the clock, or generates
 * randomness — PURE synth (goal statement's load-bearing determinism requirement), verified by
 * `construct.determinism.test.ts`'s fast-check property.
 *
 * **Relationship ergonomics decision (documented):** fluent methods on the resource construct
 * itself (`service.dependsOn(other)`, `team.owns(service)`) rather than standalone `new Owns(...)`
 * constructs — reads closer to real CDK (`bucket.grantRead(role)`-style) and needs no extra
 * import per relationship type. The tradeoff: relationship declarations live on `Stack` internally
 * (`_registerRelationship`), not as their own addressable construct id — acceptable here since
 * relationships have no independent lifecycle state to reference later within a single synth.
 *
 * ## Layering: L1 / L2 / L3 (team-pipeline-iac.md D16(1))
 *
 * **L1 — the raw manifest entry.** `Stack.addManifestEntry(object)` appends a `ManifestObject`
 * verbatim; `Stack.addRelationship(typeId, from, to, properties?)` does the same for an edge; every
 * `ResourceConstruct` additionally offers `overrideManifestEntry(patch)` to patch fields its own
 * typed props don't expose. None of these doors consult a registry of "known" typeIds — a `typeId`
 * no typed construct in this package has ever heard of synthesizes exactly as well as `"service"`
 * does. That is what makes "no L2 construct may block reaching L1" structurally true: there is no
 * gate to bypass, because the L2 constructs below are themselves built on these same doors and
 * contribute to the SAME collections `synth()` sorts and emits.
 *
 * **L2 — the typed constructs.** Everything exported from this module below this comment:
 * `Service`, `Component`, `Campaign`, `ReleaseTopology`, the `add*`/fluent sugar. Each is a thin
 * layer that resolves references to URNs and calls the L1 doors underneath — `Component.placeAt`
 * constructs a `Placement`, which calls `Stack.addPlacement`; `ResourceConstruct.dependsOn` calls
 * `Stack._registerRelationship`. An L1-authored entry and its L2 equivalent synthesize IDENTICALLY
 * (pinned in `construct.test.ts`), because the L2 form is never anything more than the L1 call
 * plus ergonomics.
 *
 * **L3 — patterns shipped via standards packages.** Not part of `@scp/iac` itself: an org's
 * `@corp/scp-standards`-style package (D10) composes L2 constructs into higher-level authoring
 * patterns (a `waves.standard` wave shape, a `repos()` helper) and publishes them like any other
 * package. `@scp/iac` has no special knowledge of L3 — it is ordinary code built on L1/L2's public
 * surface, which is exactly why nothing here needs to change for a new L3 pattern to exist.
 */

// -------------------------------------------------------------------------------------------
// Base types
// -------------------------------------------------------------------------------------------

/** Minimal construct base — just enough identity (`scope`, `id`) for deterministic URN derivation. */
export abstract class Construct {
  constructor(
    readonly scope: Construct | undefined,
    readonly id: string
  ) {}

  /**
   * Slash-joined construct-tree path from the root, e.g. `billing-platform/billing-api`
   * (team-pipeline-iac.md D16(5)) — every synth validation error names this, so a refusal maps back
   * to the construct a team actually wrote, not just an array index in the assembled manifest. `App`
   * is excluded from the path (it is synth plumbing, D15a, and never appears in user-facing IaC).
   */
  get path(): string {
    const parts: string[] = [];
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- walking the scope chain upward.
    let node: Construct | undefined = this;
    while (node) {
      if (!(node instanceof App)) parts.unshift(node.id);
      node = node.scope;
    }
    return parts.join("/");
  }
}

/**
 * A URN plus which typed-registry kind it names — the shape BOTH an owned `ResourceConstruct` and a
 * `fromXxx()` reference satisfy (D16(2)). `Kind` is the construct's `typeId` literal (`"service"`,
 * `"component"`, …), so `IService` and `ITeam` are structurally distinct in TypeScript even though
 * neither carries any field beyond identity — passing a `Team` reference where an `IService` is
 * expected is a compile error, not just a naming convention.
 */
export interface IResourceRef<Kind extends string = string> {
  readonly urn: string;
  readonly typeId: Kind;
}

// Per-kind aliases of `IResourceRef<Kind>` (not `interface X extends IResourceRef<"…"> {}` —
// an interface adding no members over its supertype is the same type, and this repo's lint config
// (`@typescript-eslint/no-empty-object-type`) refuses to let the two spellings drift silently).

/** A reference to an EXISTING `service`, owned or `Service.fromName()`/`Service.fromUrn()`. */
export type IService = IResourceRef<"service">;
/** A reference to an EXISTING `domain`, owned or `Domain.fromName()`/`Domain.fromUrn()`. */
export type IDomain = IResourceRef<"domain">;
/** A reference to an EXISTING `team`, owned or `Team.fromName()`/`Team.fromUrn()`. */
export type ITeam = IResourceRef<"team">;
/** A reference to an EXISTING `policy`, owned or `Policy.fromName()`/`Policy.fromUrn()`. */
export type IPolicy = IResourceRef<"policy">;
/** A reference to an EXISTING `deployment-target`, owned or `DeploymentTarget.fromName()`/`.fromUrn()`. */
export type IDeploymentTarget = IResourceRef<"deployment-target">;
/** A reference to an EXISTING `group`, owned or `Group.fromName()`/`Group.fromUrn()`. */
export type IGroup = IResourceRef<"group">;
/** A reference to an EXISTING `user`, owned or `User.fromName()`/`User.fromUrn()`. */
export type IUser = IResourceRef<"user">;
/** A reference to an EXISTING `service-account`, owned or `ServiceAccount.fromName()`/`.fromUrn()`. */
export type IServiceAccount = IResourceRef<"service-account">;
/** A reference to an EXISTING `component`, owned or `Component.fromName()`/`Component.fromUrn()`. */
export type IComponent = IResourceRef<"component">;

/** The reserved, syntactically-URN-shaped namespace `fromName()` placeholders live in — see
 *  `nameReferenceUrn`'s doc for the whole rule. Not a real stack name; no owned construct's stack
 *  is ever slugified to exactly this token (`slugify` never emits a bare word with no input, and no
 *  real stack is named literally "named-ref"), so it cannot collide with a genuine synth-derived URN. */
const NAME_REFERENCE_NAMESPACE = "named-ref";

/**
 * Builds the placeholder URN a `fromName()` reference resolves to at synth time (D16(2)/D14).
 *
 * `@scp/iac` synth is pure, offline, and single-stack-scoped (`urn.ts`'s module doc) — it has no
 * visibility into WHICH stack owns an object merely named `"payments"`, so it cannot derive that
 * object's real `deriveConstructUrn`-style URN the way an OWNED construct can. What it CAN do is
 * name the reference unambiguously by (kind, name) in a reserved namespace that still satisfies
 * `UrnSchema`'s `urn:scp:{org}:{type}:{slug-path}` shape (`@scp/schemas`), so the reference is legal
 * wherever a construct's own URN would be.
 *
 * Resolving `urn:scp:named-ref:service:payments` to the real object — matching by (typeId, name)
 * across whatever stack actually declared it — is SERVER-SIDE behavior at plan time
 * (team-pipeline-iac.md D14: "every fromName()/fromUrn() reference resolves server-side at plan
 * time"). That resolution is not built yet; until it lands, a manifest using a `fromName()`
 * reference REFUSES THE PLAN LOUDLY (not-found) rather than silently succeeding against the wrong
 * object — which is the correct behavior for an unresolved structural reference, not a defect of
 * this placeholder.
 */
function nameReferenceUrn(typeId: string, name: string): string {
  return `urn:scp:${NAME_REFERENCE_NAMESPACE}:${typeId}:${slugify(name)}`;
}

interface RelationshipDecl {
  typeId: string;
  /** A construct, a `fromXxx()` reference, or an external endpoint's URN string — symmetric with
   *  `to`. The fluent methods (`dependsOn`/`consumes`/`owns`) always pass `this` (a construct);
   *  `Component`'s `contains` edge passes `props.service`, which may be a `Service`
   *  construct/reference OR an external service URN. */
  from: IResourceRef | string;
  to: IResourceRef | string;
  properties?: Record<string, unknown> | undefined;
}

/** A projection-collection entry paired with the construct-tree LOCATION that declared it
 *  (D16(5)) — `locationOf()`'s output at the time the `addXxx` call was made. `Stack.synth()` keeps
 *  this alongside the resolved manifest entry through sorting, so a validation error on entry N of
 *  the sorted array can still name where entry N came from. */
interface LocatedDecl<T> {
  readonly entry: T;
  readonly location: string;
}

/**
 * Root scope every `Stack` sits under. `App` itself never appears in a manifest — it is purely
 * in-memory synth plumbing (`Construct.path` excludes it, mirroring real CDK's `App`), and it is
 * NOT part of `@scp/iac`'s public surface (D15a: "`App` disappears from user code entirely").
 * `new Stack("platform-estate")` auto-creates one internally; no user-facing IaC file ever needs to
 * write `new App()`, because there is no longer any form of `Stack`'s constructor that accepts one.
 */
class App extends Construct {
  constructor() {
    super(undefined, "App");
  }
}

/**
 * A `source_mappings` declaration minus the component it hangs off (which the fluent method
 * supplies) — see `ManifestSourceMappingSchema`.
 */
export interface SourceMappingSpec {
  readonly sourceKind: string;
  /** @default undefined — matches any repo. */
  readonly repoPattern?: string;
  /** @default undefined — matches any path. */
  readonly pathPattern?: string;
  /** Glob matched against the event's git ref (`refs/heads/main`) — ADR-0030 §1's routing
   *  discriminator, joining the mapping's identity tuple alongside `repoPattern`/`pathPattern`/
   *  `type` (`ManifestSourceMappingSchema`). Added for team-pipeline-iac.md D17/D18: a pipeline's
   *  `branch` prop threads through to here (`refs/heads/${branch}`) so two pipelines sharing a repo
   *  but differing only in branch (`main` vs `dev`) synthesize two distinct mappings rather than
   *  colliding as one.
   *  @default undefined — matches any ref. */
  readonly refPattern?: string;
  /** Which pipeline of the component this source drives (ADR-0007).
   *  @default "configuration" */
  readonly type?: ExecutorType;
  /** Declared reach of the repo (pipeline-substrate-registry-scan.md §10.6): `global` (shared across
   *  domains, tracked at the commander) | `domain` (tracked only in one domain). A label read by
   *  pipelines, the CLI and plans — never a routing input.
   *  @default undefined — this program does not manage the scope (an apply never clears one set by
   *  hand); explicit `null` declares it undeclared, a different value from omission. */
  readonly scope?: SourceMappingScope | null;
}

/**
 * An `executor_bindings` declaration minus the target it binds — see
 * `ManifestExecutorBindingSchema`, whose either-inline-or-system-backed rule this shape inherits
 * (the server rejects a manifest that satisfies neither, at `POST /plans`).
 */
/**
 * All fields optional — the either-inline-or-execution-system-backed refinement (which combination
 * is legal) is enforced by `ManifestExecutorBindingSchema` at synth, not by this type. Every call
 * site that takes one (`bindsExecutor`, `addExecutorBinding`, `addPlacementExecutorBinding`) makes
 * the parameter itself optional too, per D16(6)'s "props? omitted entirely when all fields are
 * optional" — `component.bindsExecutor()` is legal TypeScript; it just fails synth validation like
 * any other incomplete binding.
 */
export interface ExecutorBindingSpec {
  /** Which pipeline this binding drives (ADR-0007).
   *  @default "configuration" */
  readonly type?: ExecutorType;
  /** @default undefined — required together with `pluginInstanceId` for an INLINE binding; omit
   *  both for an execution-system-backed one. */
  readonly pluginModule?: string;
  /** @default undefined — see `pluginModule`. */
  readonly pluginInstanceId?: string;
  /** @default undefined — inline binding config; not legal alongside `executionSystem`. */
  readonly config?: Record<string, unknown>;
  /** `{ configFieldName: secretKey }`. Names secrets stored via `PUT /secrets/{key}` — a synthesized
   *  manifest is committed to git, so it must never carry the values themselves.
   *  @default undefined */
  readonly secretRefs?: Record<string, string>;
  /** @default undefined */
  readonly allowedHosts?: string[];
  /** Executor-specific target identifier (e.g. an Argo CD Application name).
   *  @default undefined */
  readonly externalRef?: string;
  /** A registered `execution-system` construct/reference, or its id/URN (Mode A). When set, module,
   *  instance id, config and credentials all resolve from that system — declare none of them here.
   *  @default undefined — an INLINE binding (`pluginModule` + `pluginInstanceId`) instead. */
  readonly executionSystem?: IResourceRef | string;
}

/**
 * A named deployable unit (`new Stack('billing-platform')`) — this name becomes the row's
 * server-written `managed_by_stack` (drizzle/0068), which is what scopes pruning, and the "org"
 * segment of every URN this stack's constructs derive (`urn.ts` — synth is offline and has no real
 * org id to key off). It is also mirrored into `labels` as `scp:stack`, for humans only.
 * A `dependency_line_producers` declaration minus the component that produces it (which the fluent
 * method supplies) — see `ManifestDependencyProducerSchema`.
 */
export interface DependencyProducerSpec {
  readonly ecosystem: DependencyEcosystem;
  /** The ECOSYSTEM-NATIVE coordinate, VERBATIM — `@acme/lib`, `github.com/acme/lib`,
   *  `com.acme:lib`, `docker.io/library/alpine`. Never a URN and never slugified: `@acme/lib` and
   *  `acme-lib` share a URN slug and are two different packages. */
  readonly coordinate: string;
}

/**
 * A named deployable unit (`new Stack('billing-platform')`) — this name becomes the
 * `scp:stack` managed-by marker (`apps/server/src/iac/plan-diff.ts`) that scopes pruning, and the
 * "org" segment of every URN this stack's constructs derive (`urn.ts` — synth is offline and has
 * no real org id to key off).
 */
export class Stack extends Construct {
  readonly stackName: string;
  private readonly resources: ResourceConstruct[] = [];
  private readonly relationshipDecls: RelationshipDecl[] = [];
  private readonly sourceMappingDecls: LocatedDecl<ManifestSourceMapping>[] = [];
  private readonly placementDecls: LocatedDecl<ManifestPlacement>[] = [];
  private readonly executorBindingDecls: LocatedDecl<ManifestExecutorBinding>[] = [];
  private readonly dependencyProducerDecls: LocatedDecl<ManifestDependencyProducer>[] = [];
  private readonly governanceMoveRungDecls: LocatedDecl<ManifestGovernanceMoveRung>[] = [];
  private readonly pipelineHookDecls: LocatedDecl<ManifestPipelineHook>[] = [];
  private readonly rolloutDecls: LocatedDecl<ManifestRollout>[] = [];
  private readonly roleBindingDecls: LocatedDecl<ManifestRoleBinding>[] = [];
  private readonly roleDecls: LocatedDecl<ManifestRole>[] = [];
  private readonly convergenceDecls: LocatedDecl<ManifestConvergence>[] = [];
  /** L1 raw objects (D16(1)) — entries added via `addManifestEntry`, never through a typed
   *  construct. Kept separate from `resources` (which holds typed CONSTRUCTS, not manifest
   *  objects) so `_toManifestObject()` is only ever called on something that actually has one. */
  private readonly rawObjectDecls: ManifestObject[] = [];

  /**
   * `new Stack("platform-estate")` is the ONLY form (D15a): `App` is internal synth plumbing,
   * auto-created here, and never appears in user code — nothing in a component's, team's, or
   * estate's file ever writes `new App()`.
   */
  constructor(stackName: string) {
    super(new App(), stackName);
    if (stackName.trim().length === 0) throw new Error("Stack name must be non-empty");
    this.stackName = stackName;
  }

  /** @internal called by `ResourceConstruct`'s constructor. */
  _registerResource(resource: ResourceConstruct): void {
    this.resources.push(resource);
  }

  /**
   * @internal Every registered resource whose construct-tree ancestor chain (walked via `.scope`,
   * `Construct.path`'s own traversal) includes `scope` — direct child or nested arbitrarily deep,
   * in REGISTRATION order (callers that need a deterministic order, e.g. `products.ts`, sort the
   * result themselves). Used by `products.ts` to find the infra products (`Cluster`/`InstanceGroup`/
   * …, D19/D20) an owned Infrastructure/Configuration `Pipeline` declared as ITS OWN, without
   * `construct.ts` needing to know anything about `pipeline.ts`'s types (`InfraProductScope`,
   * `infra.ts`, is the same plain `Construct & { stack }` shape this walk works against).
   */
  _resourcesWithin(scope: Construct): ResourceConstruct[] {
    return this.resources.filter((r) => {
      let node: Construct | undefined = r.scope;
      while (node) {
        if (node === scope) return true;
        node = node.scope;
      }
      return false;
    });
  }

  /** @internal called by `ResourceConstruct`'s relationship fluent methods. */
  _registerRelationship(decl: RelationshipDecl): void {
    this.relationshipDecls.push(decl);
  }

  /**
   * L1 — the guaranteed raw manifest-entry door (D16(1)). Appends `object` to this stack's
   * `objects` VERBATIM, exactly as if a typed construct had synthesized it — no L2 construct
   * (`Service`, `Component`, …) sits between this call and the manifest, and none of them can
   * block it: this method takes any `typeId`, including one no typed construct in this package
   * knows about yet. It is what makes "no L2 construct may block reaching L1" structurally true
   * rather than a promise — there is no registry of "known" typeIds this checks against.
   *
   * The one thing it does NOT do that a typed construct does: derive a URN when one is omitted.
   * `ManifestObjectSchema.urn` is required, so callers supply it — `deriveConstructUrn` (`urn.ts`,
   * also exported from `./index.js`) is the same deterministic algorithm every typed construct
   * uses, so an L1 entry can reproduce an L2 one byte-for-byte (see `construct.test.ts`'s "an L1
   * addManifestEntry object and its L2 equivalent synthesize identically" case).
   */
  addManifestEntry(object: ManifestObject): this {
    this.rawObjectDecls.push(object);
    return this;
  }

  /**
   * L1 — the guaranteed raw relationship door (D16(1)). Declares an edge of ANY `typeId`, from and
   * to any construct/reference/URN — the same escape hatch `addManifestEntry` is for objects.
   * `dependsOn`/`consumes`/`owns` are convenience sugar over exactly this call (with `from` fixed
   * to `this`); reach for this one directly for an edge type none of those three name, or when
   * `from` is not the construct doing the declaring.
   */
  addRelationship(
    typeId: string,
    from: IResourceRef | string,
    to: IResourceRef | string,
    properties?: Record<string, unknown>
  ): this {
    this._registerRelationship({ typeId, from, to, properties });
    return this;
  }

  /**
   * Declares a `source_mappings` row for `component` (docs/proposals/post-import-configuration.md
   * §8 C1). Prefer `component.mapsSource(...)`; this stack-level form exists for a component that
   * lives OUTSIDE this program and is referenced by URN — the same escape hatch relationship
   * endpoints already have.
   *
   * The component must be one this stack owns: declared here, or already carrying this stack's
   * name in its server-written `managed_by_stack` (drizzle/0068). `POST /plans` rejects anything
   * else with a 400 —
   * ownership of a mapping is inherited from its component, so a stack cannot configure a component
   * it does not manage.
   *
   * DELIBERATELY typed `IResourceRef`, not `IComponent`: this is the L1-adjacent escape hatch, not
   * the typed sugar (`Component.mapsSource`) — it exists precisely so a caller CAN write something
   * `Component.mapsSource` cannot, and the SERVER is the authority on whether the target is a
   * component (`iac-dependency-producers.integration.test.ts`'s analogous
   * "…refused, exactly as the typed verb refuses one" pins the same shape for
   * `addDependencyProducer`). Narrowing the parameter here would make that a compile error instead
   * of the intended 400.
   */
  addSourceMapping(component: IResourceRef | string, spec: SourceMappingSpec): this {
    this.sourceMappingDecls.push({
      location: locationOf(component),
      entry: {
        componentUrn: resolveUrn(component),
        sourceKind: spec.sourceKind,
        ...(spec.repoPattern !== undefined ? { repoPattern: spec.repoPattern } : {}),
        ...(spec.pathPattern !== undefined ? { pathPattern: spec.pathPattern } : {}),
        ...(spec.refPattern !== undefined ? { refPattern: spec.refPattern } : {}),
        ...(spec.type !== undefined ? { type: spec.type } : {}),
        // Omitted stays OMITTED (not `null`): the two mean different things server-side (§10.6).
        ...(spec.scope !== undefined ? { scope: spec.scope } : {})
      }
    });
    return this;
  }

  /**
   * Declares an `executor_bindings` row for `target` (C1). Prefer `target.bindsExecutor(...)`; this
   * form exists for a target referenced by URN from outside this program. Same ownership rule as
   * `addSourceMapping`.
   */
  /**
   * Declares a `placement` (ADR-0026) — this component at this deployment-target.
   *
   * Prefer `component.placeAt(target)`; this stack-level form exists for a component referenced by
   * URN from outside this program, the same escape hatch mappings and relationships already have.
   *
   * OWNERSHIP is the COMPONENT's stack (decision Q4), matching `addSourceMapping` — a declaration
   * whose component this stack does not own is rejected at `POST /plans`, which is what stops two
   * stacks pruning each other's placements.
   *
   * There is no `urn` argument and cannot be: a placement's URN is DERIVED from both endpoints
   * (ADR-0026 D3), so supplying one could disagree with what the server mints.
   *
   * DELIBERATELY typed `IResourceRef` on both parameters, not `IComponent`/`IDeploymentTarget` —
   * see `addSourceMapping`'s doc for why the stack-level escape hatch stays loose while the sugar
   * (`Component.placeAt`) stays typed.
   */
  addPlacement(component: IResourceRef | string, deploymentTarget: IResourceRef | string): this {
    this.placementDecls.push({
      location: locationOf(component),
      entry: {
        componentUrn: resolveUrn(component),
        deploymentTargetUrn: resolveUrn(deploymentTarget)
      }
    });
    return this;
  }

  /**
   * Whether this stack already declares a placement for this exact `(component, deploymentTarget)`
   * pair — the identity is the pair (ADR-0026 D3), same as `addPlacement`. Exists so a HIGHER-LEVEL
   * inference step (team-pipeline-iac.md D8: "placements from the stages a component's waves name")
   * can check "did an explicit declaration already say this?" before adding an inferred one, rather
   * than emitting two `ManifestPlacement` entries for one pair — D8's rule that "an explicit
   * declaration always overrides an inferred one" is enforced by never emitting the inferred one at
   * all when the explicit one already exists, not by a later dedup pass.
   */
  hasPlacement(component: IResourceRef | string, deploymentTarget: IResourceRef | string): boolean {
    const componentUrn = resolveUrn(component);
    const targetUrn = resolveUrn(deploymentTarget);
    return this.placementDecls.some(
      (d) => d.entry.componentUrn === componentUrn && d.entry.deploymentTargetUrn === targetUrn
    );
  }

  /**
   * Declares an `executor_bindings` row on a PLACEMENT, addressed by its pair.
   *
   * The placement is expressed as `targetUrn` (the component) NARROWED by `deploymentTargetUrn`,
   * not by a URN of its own: a placement's URN is derived (ADR-0026 D3) from the org id and both
   * endpoints' display names, so it is neither hand-writable nor stable under a rename.
   * Prefer `component.placeAt(target).bindsExecutor(...)`.
   *
   * The pair must ALSO be declared as a placement by this same stack — `POST /plans` refuses a
   * binding on a pair the manifest does not declare, because apply would otherwise write it onto a
   * placement the same apply just pruned.
   *
   * DELIBERATELY typed `IResourceRef` — see `addSourceMapping`'s doc.
   */
  addPlacementExecutorBinding(
    component: IResourceRef | string,
    deploymentTarget: IResourceRef | string,
    spec: ExecutorBindingSpec = {}
  ): this {
    this.executorBindingDecls.push({
      location: locationOf(component),
      entry: {
        targetUrn: resolveUrn(component),
        deploymentTargetUrn: resolveUrn(deploymentTarget),
        ...executorBindingFields(spec)
      }
    });
    return this;
  }

  addExecutorBinding(target: IResourceRef | string, spec: ExecutorBindingSpec = {}): this {
    this.executorBindingDecls.push({
      location: locationOf(target),
      entry: {
        targetUrn: resolveUrn(target),
        ...executorBindingFields(spec)
      }
    });
    return this;
  }

  /**
   * Declares that `component` PRODUCES one dependency coordinate (ADR-0032 §7e) — the IaC form of
   * `POST /dependencies/producers`. Prefer `component.producesDependency(...)`; this stack-level
   * form exists for a component referenced by URN from outside this program, the same escape hatch
   * mappings, placements and relationships already have.
   *
   * WHAT THE DECLARATION DOES, so it is not mistaken for a label: it makes the coordinate INTERNAL.
   * Every major line of it stops being polled against its public index, and its versions start being
   * derived from `component`'s own production releases instead. Every other component in the org
   * that depends on the coordinate is affected. That is why it takes `policy:write` AT THE ORG ROOT
   * rather than write authority on `component`, and why the API verb — not this — is the surface
   * that reports the blast radius before you commit to it (`--dry-run`).
   *
   * The component must be one this stack owns AND must be a `component` (a `service` is refused).
   * `POST /plans` rejects anything else with a 400, including a plan that would take the coordinate
   * away from a producer belonging to ANOTHER stack.
   *
   * ==========================================================================================
   * READ THIS BEFORE YOU DELETE A CALL TO IT: REMOVING YOUR LAST ONE RETRACTS NOTHING
   * ==========================================================================================
   * `producers` is the ONE manifest collection where an ABSENT key does not prune. It means
   * UNMANAGED, deliberately and unlike `sourceMappings`/`executorBindings`/`placements`: retracting
   * a declaration hands a coordinate the org PUBLISHES back to a public index on a daily poll timer,
   * and the symptom is an ABSENCE of dependency updates — dependency confusion re-armed by a stack
   * that merely forgot a key. So:
   *
   *   - Removing ONE of several calls DOES retract that coordinate. The collection is still present,
   *     so it is authoritative over its own members and the plan shows a `delete` entry.
   *   - Removing your ONLY call retracts NOTHING. `synth()` omits an empty collection, so the
   *     manifest becomes indistinguishable from one that never managed producers at all. This is an
   *     ACCEPTED COST of the rule above, not a bug to work around.
   *
   * To retract a final declaration, use `scp dependency producer retract`
   * (`POST /dependencies/producers/retract`) — which is the better path anyway, because only the
   * verb reports the bumps SCP has already authored and cannot recall. A hand-authored manifest
   * carrying `"producers": []` also works; `@scp/iac` cannot emit one.
   *
   * DELIBERATELY typed `IResourceRef`, not `IComponent`: this stack-level door is the escape hatch,
   * not the typed sugar (`Component.producesDependency`) — it must stay able to express a
   * SERVICE-valued producer so the server's own refusal of one is testable
   * (`iac-dependency-producers.integration.test.ts`'s "a SERVICE-valued producer is refused, exactly
   * as the typed verb refuses one"). Narrowing this parameter would turn that server-authority test
   * into a compile error instead.
   */
  addDependencyProducer(component: IResourceRef | string, spec: DependencyProducerSpec): this {
    this.dependencyProducerDecls.push({
      location: locationOf(component),
      entry: {
        producerUrn: resolveUrn(component),
        ecosystem: spec.ecosystem,
        coordinate: spec.coordinate
      }
    });
    return this;
  }

  /**
   * Declares that containment moves BENEATH `subject` require `governance:move` at BOTH ends
   * (ADR-0038 §2) — the IaC form of `PUT /governance/move-enforcement/rungs/{idOrUrn}`, and the
   * follow-up named in `docs/proposals/governance-reach-on-containment-move.md` §9.6 Q4.
   *
   * WHAT THE RUNG DOES, so it is not mistaken for a label: from the moment it exists, every move of
   * an object under `subject` — through `objects[].domainId`, through a `contains` relationship,
   * through `setComponentService`, through discovery-accept and through this very apply path — is
   * refused unless the mover holds `governance:move` at-or-above the object AND at-or-above the
   * destination. `object:write` at both ends is no longer enough. That is a bar on other people's
   * ordinary work, so it takes `policy:write` at-or-above `subject` to set.
   *
   * THERE IS NO TIER ARGUMENT, and the omission is the design: the tier is DERIVED server-side from
   * `subject`'s object type (org root / domain / service / assembly). A manifest that could name one
   * could name a tier the subject is not, and the stored literal would then describe a containment
   * shape nothing else in the system believes in.
   *
   * THE SUBJECT MUST BE A CONTAINER THIS STACK OWNS. `governance_move_rungs` carries no stack
   * labels, so ownership is inherited from the subject container, exactly like a source mapping's
   * and a producer declaration's — `POST /plans` rejects 400 anything else, including a component
   * (nothing is contained by a component, so the rung would govern the empty set of moves). The
   * practical consequence is worth knowing before you reach for this: a rung on the ORG ROOT, or on
   * a container another stack manages, is authored through the API/CLI, never through a manifest.
   *
   * THERE IS DELIBERATELY NO FLUENT `subject.governsMoves()`. `Service` and `Domain` come from the
   * uniform `defineResourceConstruct` factory, so a fluent method would have to live on
   * `ResourceConstruct` and would therefore be offered on `Component`, `Team`, `Policy` and
   * `DeploymentTarget` — every one of which `POST /plans` refuses. That is the reason
   * `producesDependency` sits on `Component` alone rather than on the base class; here the same
   * reasoning lands on "stack-level only".
   *
   * ==========================================================================================
   * READ THIS BEFORE YOU DELETE A CALL TO IT: REMOVING YOUR LAST ONE DISABLES NOTHING
   * ==========================================================================================
   * `governanceMoveRungs` is the SECOND collection where an ABSENT key does not prune (`producers`
   * is the first), and the reason is sharper: pruning a rung DISABLES A GOVERNANCE BAR, and the
   * symptom is an ABSENCE of refusals — moves that should have been refused quietly succeeding,
   * which nothing surfaces until somebody audits where a governed object ended up. So:
   *
   *   - Removing ONE of several calls DOES disable that rung. The collection is still present, so it
   *     is authoritative over its members and the plan shows a `delete` entry.
   *   - Removing your ONLY call disables NOTHING. `synth()` omits an empty collection, so the
   *     manifest becomes indistinguishable from one that never managed rungs at all. ACCEPTED COST
   *     of the rule above, identical to `producers`.
   *
   * To disable a final rung use `scp governance move-enforcement disable`
   * (`DELETE /governance/move-enforcement/rungs/{idOrUrn}`), or hand-author
   * `"governanceMoveRungs": []`; `@scp/iac` cannot emit one. And note a disable may still be
   * REFUSED: the lattice is monotone, so a rung whose ancestor — or the instance rung — is enabled
   * cannot be turned off below, and the apply fails 409 naming the upper rung.
   */
  addGovernanceMoveRung(subject: IResourceRef | string): this {
    this.governanceMoveRungDecls.push({
      location: locationOf(subject),
      entry: { subjectIdOrUrn: resolveUrn(subject) }
    });
    return this;
  }

  /**
   * Pure synth: no `Date.now()`, no `Math.random()`, no `crypto.randomUUID()`, no network/
   * filesystem I/O — everything comes from the construct tree's own props. Objects are sorted by
   * URN and relationships by `(typeId, fromUrn, toUrn)` so re-ordering how constructs were added
   * in code never changes the synthesized manifest, only their CONTENT does — the property
   * `construct.determinism.test.ts` exercises.
   */
  /**
   * L1 ESCAPE HATCH for a pipeline hook (D11, D21) — the `pipelineHooks` half of the increment-8
   * contract (`@scp/schemas`'s `ManifestPipelineHookSchema`).
   *
   * D16(1)'s guarantee is that no L2 construct may block reaching L1. Until this existed, the
   * guarantee was empty for this collection in the strongest possible sense: there were no L2
   * constructs for hooks AND `synth()` did not assemble the collection at all, so a CDK program
   * could not emit a hook by any route. The server half has been waiting since the contract merged
   * — `plans-repo.ts` applies `pipelineHooks`, `render.ts` displays them — and the only way to get
   * one into the database was a hand-authored manifest POSTed to `/plans`, which is precisely the
   * authoring experience the construct library exists to replace.
   *
   * Takes the hook MINUS its `componentUrn`, which is resolved from `component` the way every other
   * hatch here resolves its subject — so a caller cannot accidentally declare a hook against a URN
   * that does not match the construct they passed.
   *
   * PREFER THE TYPED CONSTRUCTS once they exist (`PostMergeTest`, `PostDeployTest`, `ContinuousTest`,
   * `BakeAlarms`); this door stays for a component referenced by URN from outside the program, and
   * for a hook kind the library has not grown sugar for yet.
   */
  addPipelineHook(
    component: IResourceRef | string,
    hook: DistributiveOmit<ManifestPipelineHook, "componentUrn">
  ): this {
    this.pipelineHookDecls.push({
      location: locationOf(component),
      entry: { ...hook, componentUrn: resolveUrn(component) } as ManifestPipelineHook
    });
    return this;
  }

  /**
   * L1 ESCAPE HATCH for a rollout declaration (D12), keyed by TARGET CLASS — one component
   * legitimately declares a canary for its clusters and a rolling batch for its instance groups.
   *
   * The strategy is the contract's own discriminated union, so the wire carries a discriminant
   * rather than a strategy string the server has to interpret (D15(c)), and percentages are plain
   * numbers on self-describing props (D16(3)).
   */
  addRollout(
    component: IResourceRef | string,
    spec: { targetClass: RolloutTargetClass; rollout: RolloutStrategy }
  ): this {
    this.rolloutDecls.push({
      location: locationOf(component),
      entry: {
        componentUrn: resolveUrn(component),
        targetClass: spec.targetClass,
        rollout: spec.rollout
      }
    });
    return this;
  }

  /**
   * L1 ESCAPE HATCH for a convergence declaration (D25(b)) — a configuration pipeline placed at an
   * infrastructure PRODUCT re-applies its currently-released, already-gated state when that
   * product's observed membership changes.
   *
   * BOTH FIELDS ARE REQUIRED HERE even though `converge` defaults on and `scope` defaults to the
   * changed subset. That is D8's rule (inference at synth, explicitness at apply) applied to the
   * door it was written for: the typed construct picks the defaults, the MANIFEST always says which,
   * and "this fleet self-converges" stays a reviewable line rather than a server-side default nobody
   * can see. An L1 caller is authoring the manifest directly, so it says both.
   */
  /**
   * L1 ESCAPE HATCH for a role binding — grant `roleName` to `subjectUrn` at `scopeUrn`.
   *
   * SUBJECT MUST BE A `user` OR `service-account`, and that is enforced by the L2 construct rather
   * than here: this door takes URNs it cannot resolve to a type at synth time, so the refusal lives
   * where the type is known. The reasoning is in `ManifestRoleBindingSchema` — D7's acknowledgement
   * is a statement about a membership at a moment, and a manifest can only carry a snapshot that
   * goes stale and trains its author to stop reading the refusal.
   *
   * The applying principal, not the author, is who the no-escalation subset rule judges. For a
   * config-source sync that is the TEAM object, so a team's own repo cannot bootstrap that team's
   * permissions.
   */
  addRoleBinding(binding: ManifestRoleBinding, location?: string): this {
    this.roleBindingDecls.push({
      location: location ?? `${binding.subjectUrn}/${binding.roleName}`,
      entry: binding
    });
    return this;
  }

  /**
   * L1 ESCAPE HATCH for an org-defined role. `permissions` must be strings this system defines AND
   * ones the APPLYING principal holds at the org root — authoring a role that advertises authority
   * its author cannot confer is refused at the door, not here.
   */
  addRole(role: ManifestRole, location?: string): this {
    this.roleDecls.push({ location: location ?? role.name, entry: role });
    return this;
  }

  addConvergence(
    component: IResourceRef | string,
    target: IResourceRef | string,
    spec: { converge: boolean; scope: ManifestConvergence["scope"] }
  ): this {
    this.convergenceDecls.push({
      location: locationOf(component),
      entry: {
        componentUrn: resolveUrn(component),
        targetUrn: resolveUrn(target),
        converge: spec.converge,
        scope: spec.scope
      }
    });
    return this;
  }

  synth(): DesiredStateManifest {
    // L1 raw entries (`addManifestEntry`) sort in seamlessly alongside typed constructs' own
    // objects — by URN, same as everything else — so which door an object came through leaves no
    // trace in the synthesized bytes (D16(1): "an L1-authored entry and its L2 equivalent
    // synthesize identically").
    const locatedObjects = [
      ...this.resources.map((r) => ({ entry: r._toManifestObject(), location: r.path })),
      ...this.rawObjectDecls.map((entry) => ({ entry, location: entry.urn }))
    ].sort((a, b) => a.entry.urn.localeCompare(b.entry.urn));
    const objects: ManifestObject[] = locatedObjects.map((o) => o.entry);
    const objectLocations: string[] = locatedObjects.map((o) => o.location);

    const locatedRelationships = this.relationshipDecls
      .map((decl) => ({
        entry: {
          typeId: decl.typeId,
          fromUrn: typeof decl.from === "string" ? decl.from : decl.from.urn,
          toUrn: typeof decl.to === "string" ? decl.to : decl.to.urn,
          ...(decl.properties ? { properties: decl.properties } : {})
        } satisfies ManifestRelationship,
        location: locationOf(decl.from)
      }))
      .sort((a, b) => relationshipSortKey(a.entry).localeCompare(relationshipSortKey(b.entry)));
    const relationships: ManifestRelationship[] = locatedRelationships.map((r) => r.entry);
    const relationshipLocations: string[] = locatedRelationships.map((r) => r.location);

    // C1's two collections are OMITTED WHEN EMPTY rather than emitted as `[]`, so a stack that
    // declares neither synthesizes the byte-identical manifest it did before C1 — the interchange
    // format stays stable for every existing program, and an absent key already means "declares
    // none" server-side (`DesiredStateManifestSchema`).
    const sortedSourceMappings = [...this.sourceMappingDecls].sort((a, b) =>
      sourceMappingSortKey(a.entry).localeCompare(sourceMappingSortKey(b.entry))
    );
    const sourceMappings: ManifestSourceMapping[] = sortedSourceMappings.map((d) => d.entry);
    const sourceMappingLocations: string[] = sortedSourceMappings.map((d) => d.location);

    const sortedExecutorBindings = [...this.executorBindingDecls].sort((a, b) =>
      executorBindingSortKey(a.entry).localeCompare(executorBindingSortKey(b.entry))
    );
    const executorBindings: ManifestExecutorBinding[] = sortedExecutorBindings.map((d) => d.entry);
    const executorBindingLocations: string[] = sortedExecutorBindings.map((d) => d.location);
    // Sorted on the PAIR, which is the whole identity (ADR-0026 D3) — so declaration order in code
    // never changes the synthesized bytes, only content does.
    const sortedPlacements = [...this.placementDecls].sort((a, b) =>
      `${a.entry.componentUrn}\u0000${a.entry.deploymentTargetUrn}`.localeCompare(
        `${b.entry.componentUrn}\u0000${b.entry.deploymentTargetUrn}`
      )
    );
    const placements: ManifestPlacement[] = sortedPlacements.map((d) => d.entry);
    const placementLocations: string[] = sortedPlacements.map((d) => d.location);
    // Sorted on `(ecosystem, coordinate)` — the declaration's identity, and NOT the producer, which
    // is the row's value. Two programs that declare the same coordinate from differently-ordered
    // code synthesize the same bytes; one that re-points it does not, which is correct.
    const sortedProducers = [...this.dependencyProducerDecls].sort((a, b) =>
      `${a.entry.ecosystem}\u0000${a.entry.coordinate}`.localeCompare(
        `${b.entry.ecosystem}\u0000${b.entry.coordinate}`
      )
    );
    const producers: ManifestDependencyProducer[] = sortedProducers.map((d) => d.entry);
    const producerLocations: string[] = sortedProducers.map((d) => d.location);
    // Sorted on the SUBJECT, which is the whole identity — a rung has no value beyond existing, so
    // there is nothing else two entries could differ in. Duplicates are left in rather than
    // de-duplicated here: `synth()` reports what the program said, and the server collapses two
    // declarations of one subject into one rung (a repeated rung is idempotent, not ambiguous).
    const sortedGovernanceMoveRungs = [...this.governanceMoveRungDecls].sort((a, b) =>
      a.entry.subjectIdOrUrn.localeCompare(b.entry.subjectIdOrUrn)
    );
    const governanceMoveRungs: ManifestGovernanceMoveRung[] = sortedGovernanceMoveRungs.map(
      (d) => d.entry
    );
    const governanceMoveRungLocations: string[] = sortedGovernanceMoveRungs.map((d) => d.location);

    // PIPELINE HOOKS (D11/D21). Sorted on the full identity tuple `(componentUrn, kind, hookId)` —
    // the same tuple the server keys on — so declaration order in code never changes the bytes.
    const sortedPipelineHooks = [...this.pipelineHookDecls].sort((a, b) =>
      pipelineHookSortKey(a.entry).localeCompare(pipelineHookSortKey(b.entry))
    );
    const pipelineHooks: ManifestPipelineHook[] = sortedPipelineHooks.map((d) => d.entry);
    const pipelineHookLocations: string[] = sortedPipelineHooks.map((d) => d.location);

    // ROLLOUTS (D12), sorted on `(componentUrn, targetClass)` — the declaration's identity.
    const sortedRollouts = [...this.rolloutDecls].sort((a, b) =>
      `${a.entry.componentUrn}\u0000${a.entry.targetClass}`.localeCompare(
        `${b.entry.componentUrn}\u0000${b.entry.targetClass}`
      )
    );
    const rollouts: ManifestRollout[] = sortedRollouts.map((d) => d.entry);
    const rolloutLocations: string[] = sortedRollouts.map((d) => d.location);

    // ROLE BINDINGS, sorted on `(subjectUrn, roleName, scopeUrn)` — the same triple
    // `role_bindings_grant_key` (drizzle/0097) makes unique, so declaration order in code never
    // changes the synthesized bytes and a manifest cannot express two bindings the database would
    // collapse into one.
    const sortedRoleBindings = [...this.roleBindingDecls].sort((a, b) =>
      `${a.entry.subjectUrn}\u0000${a.entry.roleName}\u0000${a.entry.scopeUrn}`.localeCompare(
        `${b.entry.subjectUrn}\u0000${b.entry.roleName}\u0000${b.entry.scopeUrn}`
      )
    );
    const roleBindings: ManifestRoleBinding[] = sortedRoleBindings.map((d) => d.entry);
    const roleBindingLocations: string[] = sortedRoleBindings.map((d) => d.location);

    // ROLES, sorted on `name` — the identity within an org (`roles_org_name_key`, drizzle/0103).
    const sortedRoles = [...this.roleDecls].sort((a, b) =>
      a.entry.name.localeCompare(b.entry.name)
    );
    const roles: ManifestRole[] = sortedRoles.map((d) => d.entry);
    const roleLocations: string[] = sortedRoles.map((d) => d.location);

    // CONVERGENCE (D25), sorted on `(componentUrn, targetUrn)` — the pair is the identity.
    const sortedConvergence = [...this.convergenceDecls].sort((a, b) =>
      `${a.entry.componentUrn}\u0000${a.entry.targetUrn}`.localeCompare(
        `${b.entry.componentUrn}\u0000${b.entry.targetUrn}`
      )
    );
    const convergence: ManifestConvergence[] = sortedConvergence.map((d) => d.entry);
    const convergenceLocations: string[] = sortedConvergence.map((d) => d.location);

    const candidate = {
      stackName: this.stackName,
      objects,
      relationships,
      ...(sourceMappings.length > 0 ? { sourceMappings } : {}),
      ...(executorBindings.length > 0 ? { executorBindings } : {}),
      ...(placements.length > 0 ? { placements } : {}),
      // OMITTED WHEN EMPTY, like the three above — but here that omission MEANS SOMETHING DIFFERENT
      // server-side. For the others, absent and empty both prune. For this one, absent means
      // UNMANAGED and prunes nothing, which is why a stack that drops its last
      // `producesDependency(...)` call does not retract it. See `addDependencyProducer` for the
      // whole rule and for how to retract a final declaration.
      ...(producers.length > 0 ? { producers } : {}),
      // OMITTED WHEN EMPTY, and meaning the same thing `producers`' omission means — UNMANAGED, not
      // "manages them and declares none" — which is why dropping the last `addGovernanceMoveRung`
      // call disables nothing. See that method for the whole rule and for how to disable a final
      // rung. This is the more dangerous of the two omissions to get wrong: pruning here would turn
      // OFF a governance bar, and the symptom would be an absence of refusals.
      ...(governanceMoveRungs.length > 0 ? { governanceMoveRungs } : {}),
      // OMITTED WHEN EMPTY, and here that omission means the ORDINARY thing (absent = empty =
      // prune), unlike the three above. Dropping a binding is a REVOCATION: visible on the plan
      // line, and a narrowing rather than a silent un-gating. The dangerous direction for a role
      // binding is granting, and a forgotten key cannot grant anything.
      ...(roleBindings.length > 0 ? { roleBindings } : {}),
      // ORDINARY RULE too. A dropped role whose bindings still exist fails LOUDLY at apply — the
      // delete door refuses while any binding points at it — rather than performing an
      // unreviewable mass revoke.
      ...(roles.length > 0 ? { roles } : {}),
      // OMITTED WHEN EMPTY, and `pipelineHooks` is the THIRD collection whose omission means
      // UNMANAGED rather than "manages none" — the contract says so explicitly and for the same
      // reason `producers` does: dropping the last declaration would silently DISARM a gate, and
      // the symptom of a disarmed gate is an absence of refusals. Retracting a final hook needs a
      // hand-authored `"pipelineHooks": []`, exactly as retracting a final producer does.
      //
      // `rollouts` and `convergence` follow the ORDINARY rule (absent = empty = prune): neither
      // gates anything, so a forgotten key costs a declared strategy, not a removed bar.
      ...(pipelineHooks.length > 0 ? { pipelineHooks } : {}),
      ...(rollouts.length > 0 ? { rollouts } : {}),
      ...(convergence.length > 0 ? { convergence } : {})
    };

    // TWO OBJECTS, ONE URN — REFUSED HERE, BEFORE THE MANIFEST CAN CARRY BOTH.
    //
    // A URN is derived from `(stackName, construct id)` through `slugify`, WHICH LOWERCASES. So
    // sibling constructs whose ids differ only in case — `Api` and `api`, `payBlue` and `PayBlue` —
    // are two distinct constructs (the tree's own duplicate-id check compares ids exactly, and CDK
    // semantics say those are different resources) that derive ONE URN. Punctuation folds the same
    // way: `pay-blue` and `pay_blue` both slug to `pay-blue`.
    //
    // Nothing downstream could catch it. `DesiredStateManifestSchema` has no cross-entry
    // constraint, and the server DIFFS BY URN (`iac/plan-diff.ts`), so the second entry silently
    // becomes an update of the first: one of the two objects the author declared never exists, and
    // the plan reads as a clean create + update. The symptom is a missing object, discovered
    // whenever someone goes looking for it.
    //
    // MEASURED, not theorised: `new Service(stack, "Api", …)` beside `new Service(stack, "api", …)`
    // synthesized two entries both carrying `urn:scp:probe:service:api`. Found by the fast-check
    // generator in `products.test.ts`, which produced the id pair `("F", "f")` and hit
    // `collectProducts`'s identifier-collision throw — the products module was the only place in
    // the library incidentally protected, and only because `camelIdentifier` folds case too.
    //
    // Named by CONSTRUCT PATH, not by URN: the URNs are identical (that is the defect), so printing
    // them twice tells the author nothing about what to change. The paths are what differ and what
    // they must rename — D16's construct-path error rule, which the validation branch below already
    // follows.
    const urnOwners = new Map<string, string>();
    for (const [i, entry] of objects.entries()) {
      const location = objectLocations[i] ?? entry.urn;
      const existing = urnOwners.get(entry.urn);
      if (existing !== undefined) {
        throw new Error(
          `Stack "${this.stackName}" declares two objects with the same URN "${entry.urn}":\n` +
            `  [construct: ${existing}]\n` +
            `  [construct: ${location}]\n` +
            `A URN is derived by lowercasing and slugifying the construct id, so ids differing ` +
            `only in case or punctuation collide. Rename one of the two.`
        );
      }
      urnOwners.set(entry.urn, location);
    }

    const parsed = DesiredStateManifestSchema.safeParse(candidate);
    if (parsed.success) return parsed.data;

    // D16(5): every synth validation error names the construct-tree PATH that produced the entry
    // it is about. A `safeParse` failure's `issue.path` starts with the collection name and, for a
    // collection member, the array index into it — the SAME index `objectLocations`/
    // `relationshipLocations`/… line up with, because every array above was built and sorted in
    // lockstep with its location array.
    const locationsByCollection: Record<string, string[] | undefined> = {
      objects: objectLocations,
      relationships: relationshipLocations,
      sourceMappings: sourceMappingLocations,
      executorBindings: executorBindingLocations,
      placements: placementLocations,
      producers: producerLocations,
      governanceMoveRungs: governanceMoveRungLocations,
      pipelineHooks: pipelineHookLocations,
      rollouts: rolloutLocations,
      roleBindings: roleBindingLocations,
      roles: roleLocations,
      convergence: convergenceLocations
    };
    const lines = parsed.error.issues.map((issue) => {
      const [collection, index] = issue.path;
      const locations =
        typeof collection === "string" ? locationsByCollection[collection] : undefined;
      const location = typeof index === "number" ? locations?.[index] : undefined;
      const where = location ? ` [construct: ${location}]` : "";
      return `  ${issue.path.join(".")}${where}: ${issue.message}`;
    });
    throw new Error(`Stack "${this.stackName}" failed synth validation:\n${lines.join("\n")}`);
  }
}

/** Sorts on the mapping's full identity tuple — the same tuple the server diffs on, so declaration
 *  order in code never changes the synthesized manifest, only content does. */
function sourceMappingSortKey(m: ManifestSourceMapping): string {
  return [
    m.componentUrn,
    m.sourceKind,
    m.repoPattern ?? "",
    m.pathPattern ?? "",
    m.type ?? ""
  ].join(" ");
}

/** Sorts on `(componentUrn, kind, hookId)` — the hook's full identity, which is also what the
 *  server keys on and what it refuses a duplicate of. */
function pipelineHookSortKey(h: ManifestPipelineHook): string {
  return [h.componentUrn, h.kind, h.hookId].join("\u0000");
}

/** Sorts on `(targetUrn, type)` — the binding's identity, matching `UNIQUE (org, target, type)`. */
function executorBindingSortKey(b: ManifestExecutorBinding): string {
  return [b.targetUrn, b.type ?? ""].join(" ");
}

function relationshipSortKey(r: ManifestRelationship): string {
  return `${r.typeId} ${r.fromUrn} ${r.toUrn}`;
}

// -------------------------------------------------------------------------------------------
// Resource constructs
// -------------------------------------------------------------------------------------------

export interface ResourceProps {
  readonly name: string;
  /** Explicit URN.
   *  @default derived deterministically from `(stack name, construct id)` (`urn.ts`) */
  readonly urn?: string;
  /** An existing object's id this resource nests under.
   *  @default the org root at apply time (same as `CreateObjectRequestSchema.domainId`) */
  readonly domainId?: string;
  /** @default {} */
  readonly properties?: Record<string, unknown>;
  /** @default {} */
  readonly labels?: Record<string, unknown>;
}

/**
 * Base class for the 8 typed-registry resource constructs. `typeId` is fixed per subclass
 * (`Service` -> `'service'`, etc.) via `defineResourceConstruct` below, mirroring
 * `routes/typed-registries.ts`'s server-side "one factory, invoked per resource" pattern instead
 * of 8 hand-copied classes.
 *
 * Generic over `TypeId` (D16(2)) so an OWNED construct structurally implements the SAME
 * `IResourceRef<Kind>`-family interface a `fromXxx()` reference returns — `new Service(...)` is an
 * `IService` and `Service.fromName(...)` is an `IService`, interchangeable wherever the interface is
 * accepted, which is the whole point of the reference statics.
 */
export class ResourceConstruct<TypeId extends string = string>
  extends Construct
  implements IResourceRef<TypeId>
{
  readonly urn: string;
  /**
   * PUBLIC (widened from round A's `protected`, team-pipeline-iac.md D17/D19/D24 round B): a
   * `Pipeline` construct scoping infra products (`Cluster`, `InstanceGroup`, …) or nested pipelines
   * under an owned `Component`/`Service` lives in a DIFFERENT module (`pipeline.ts`) from this
   * class, so it needs to read the owning `Stack` off a construct it did not itself create —
   * `protected` only reaches subclasses in the SAME file. Still `readonly`: nothing outside the
   * constructor may reassign which stack a construct belongs to.
   */
  readonly stack: Stack;

  /**
   * `scope` accepts either a `Stack` directly (every construct round A shipped) OR any construct
   * that itself carries a `.stack` (round B's `Pipeline` — a non-`Stack` scope for infra products
   * and nested pipelines, team-pipeline-iac.md D19). This is a WIDENING, not a behavior change: a
   * `Stack` scope resolves to itself exactly as before, and every existing call site (`new
   * Service(stack, …)`, `new Component(stack, …)`, …) is unaffected because `Stack` still satisfies
   * the union's first arm.
   */
  constructor(
    scope: Stack | (Construct & { readonly stack: Stack }),
    id: string,
    readonly typeId: TypeId,
    private readonly props: ResourceProps
  ) {
    super(scope, id);
    const stack = scope instanceof Stack ? scope : scope.stack;
    this.stack = stack;
    this.urn = props.urn ?? deriveConstructUrn(stack.stackName, typeId, id);
    stack._registerResource(this);
  }

  /** Declares a `depends_on` edge FROM this resource TO `target` (another construct, a `fromXxx()`
   *  reference, or an external URN string). */
  dependsOn(target: IResourceRef | string, properties?: Record<string, unknown>): this {
    this.stack._registerRelationship({ typeId: "depends_on", from: this, to: target, properties });
    return this;
  }

  /** Declares a `consumes` edge FROM this resource TO `target`. */
  consumes(target: IResourceRef | string, properties?: Record<string, unknown>): this {
    this.stack._registerRelationship({ typeId: "consumes", from: this, to: target, properties });
    return this;
  }

  /** Declares an `owns` edge FROM this resource (the owner — team/group/user/service-account) TO `target` (the owned resource). */
  owns(target: IResourceRef | string, properties?: Record<string, unknown>): this {
    this.stack._registerRelationship({ typeId: "owns", from: this, to: target, properties });
    return this;
  }

  /**
   * Declares the executor binding that drives one of this target's pipelines (C1) — the IaC form of
   * `PUT /executors/{idOrUrn}/binding`, closing principle 3's parity hole for the projection tables
   * (docs/proposals/post-import-configuration.md §8). Call once per Type: a target holds at most one
   * binding per Type (`UNIQUE (org_id, target_object_id, type)`), and declaring two of the same Type
   * is rejected at `POST /plans` rather than silently resolved.
   *
   * Unlike `dependsOn`/`owns` this is NOT a relationship — `executor_bindings` is a projection table
   * with no graph-object equivalent, which is precisely why it needed its own manifest collection.
   */
  bindsExecutor(spec: ExecutorBindingSpec = {}): this {
    this.stack.addExecutorBinding(this, spec);
    return this;
  }

  // NOTE — there is deliberately NO `coordinates()` fluent method (M5 CRITICAL, adversarial
  // review). `coordinates` is a system-managed relationship type (campaign MEMBERSHIP):
  // the server refuses it on BOTH the generic `POST /relationships` endpoint AND the IaC plan/apply
  // path (`apps/server/src/graph/system-managed-relationships.ts`), because a `coordinates` edge
  // injected by any actor with `relationship:write` could sweep an arbitrary Change into a victim
  // campaign's rollback. Legitimate campaign IaC membership is declared through a `Campaign`'s
  // authority-checked `targets` (which the server binds to the applying actor's own authority at
  // apply time via `assertCampaignTargetsWithinAuthority`). Offering a `.coordinates()` synth
  // method here would just produce a manifest that fails at apply — so it doesn't exist.

  private manifestOverride: Partial<Omit<ManifestObject, "urn" | "typeId">> = {};

  /**
   * L1 escape hatch, PER-CONSTRUCT (D16(1)): patches this construct's own synthesized manifest
   * object with fields its typed L2 props don't expose — `name`, `domainId`, `properties`, or
   * `labels`, applied AFTER whatever the construct's own props computed, so an override always
   * wins. `urn`/`typeId` are excluded on purpose: those are identity, already settled by the
   * constructor, and an override that disagreed with them would desynchronize this construct's
   * `.urn` (still used by every reference to it) from what actually lands in `objects`.
   *
   * Composable with repeated calls — each patches over the last, `properties`/`labels` replaced
   * wholesale (not deep-merged) so the override is exactly what the caller wrote, not a guess at
   * how to combine it with the construct's own value.
   */
  overrideManifestEntry(patch: Partial<Omit<ManifestObject, "urn" | "typeId">>): this {
    this.manifestOverride = { ...this.manifestOverride, ...patch };
    return this;
  }

  /** @internal */
  _toManifestObject(): ManifestObject {
    return {
      urn: this.urn,
      typeId: this.typeId,
      name: this.props.name,
      domainId: this.props.domainId,
      properties: this.props.properties ?? {},
      labels: this.props.labels ?? {},
      ...this.manifestOverride
    };
  }
}

/** The static side every `defineResourceConstruct`-built class and `Component` carry — the
 *  `fromXxx()` reference statics (D16(2)). Declared once so the two implementations (the uniform
 *  factory below, and `Component`'s bespoke class) cannot drift on the doc/behavior contract. */
interface ResourceConstructStatics<Kind extends string> {
  /** A reference to an EXISTING object of this kind, by its display NAME — never creates anything
   *  in the manifest, only yields a URN placeholder for other entries to point at. See
   *  `nameReferenceUrn`'s doc for exactly what that placeholder is and how/when it resolves. */
  fromName(name: string): IResourceRef<Kind>;
  /** A reference to an EXISTING object of this kind, by its exact URN — never creates anything in
   *  the manifest. Unlike `fromName()`, this resolves the ordinary way (exact URN lookup) with no
   *  server-side name-matching involved, because the caller already supplied the real identity. */
  fromUrn(urn: string): IResourceRef<Kind>;
}

/**
 * One tiny factory invoked per resource type instead of 8 hand-copied subclasses. Explicitly
 * typed as a constructor-of-`ResourceConstruct` (rather than letting TS infer the anonymous
 * subclass's own shape) so declaration emission doesn't need to describe `ResourceConstruct`'s
 * private members on an anonymous exported class type (TS4094).
 */
function defineResourceConstruct<Kind extends string>(
  typeId: Kind
): (new (scope: Stack, id: string, props: ResourceProps) => ResourceConstruct<Kind>) &
  ResourceConstructStatics<Kind> {
  class Klass extends ResourceConstruct<Kind> {
    constructor(scope: Stack, id: string, props: ResourceProps) {
      super(scope, id, typeId, props);
    }
    static fromName(name: string): IResourceRef<Kind> {
      return { urn: nameReferenceUrn(typeId, name), typeId };
    }
    static fromUrn(urn: string): IResourceRef<Kind> {
      return { urn, typeId };
    }
  }
  return Klass;
}

// The required first-class constructs (goal statement). `Component` is bespoke (below) — it must
// emit its `contains` edge — so it is NOT in this uniform factory list.
export const Service = defineResourceConstruct("service");
export const Domain = defineResourceConstruct("domain");
export const Team = defineResourceConstruct("team");
/**
 * A policy (server-side object type `"policy"`) — first-class in a stack since M21.6 so that a
 * DEPENDENCY SUBSCRIPTION, which IS a `dependencySubscription` effect on an ordinary policy
 * (ADR-0032 §3a) and has no bespoke construct or verb anywhere, can be declared in IaC:
 *
 *   new Policy(stack, "checkout-deps", {
 *     name: "checkout-deps",
 *     properties: {
 *       enforcement: "advisory",
 *       scope: { objectRef: "urn:scp:…:component:checkout-api" },
 *       effects: [{ dependencySubscription: { enabled: true, granularity: "minor_and_patch" } }]
 *     }
 *   });
 *
 * The properties travel VERBATIM into the manifest (the policy document is validated server-side by
 * the type's JSON Schema at plan/apply, exactly as through `POST /policies`); a sole `group` scope
 * on a dependencySubscription policy is refused there in both directions (ADR-0032 §6a). Uniform —
 * no custom constructor logic — so it belongs in the factory list, not beside `Component`.
 */
export const Policy = defineResourceConstruct("policy");

export interface ComponentProps extends ResourceProps {
  /**
   * The service this component belongs to — a `Service` construct/reference, or an external
   * service's URN string. Required: a component ALWAYS belongs to a service (M12 P5a,
   * docs/proposals/organize-after.md), mirroring `CreateComponentRequest.service` on the API. The
   * constructor emits the `contains` edge (service -> component) from it; a component an IaC plan
   * CREATES with no incoming `contains` edge is rejected at plan-compute time server-side
   * (`plan-diff.ts`'s `uncontainedComponentCreates`), so requiring it here just moves that failure
   * from apply time to a TypeScript compile error.
   */
  readonly service: IService | string;
}

/**
 * Resolves `Component`'s two constructor forms into one `(scope, id, props)` triple, computed BEFORE
 * `super()` is called (team-pipeline-iac.md D15a/D17 round B) so a root-form `Component` creates
 * exactly ONE `Stack` — calling the resolution twice (once to compute `super()`'s arguments, once
 * more inside the constructor body) would construct two DIFFERENT `Stack` instances and register the
 * component under the one nobody kept a reference to. A plain (non-`this`-touching) statement before
 * `super()` is legal JS, which is what lets this run once and be reused for both.
 */
function resolveComponentCtorArgs(
  scopeOrName: Stack | string,
  idOrProps: string | ComponentProps,
  maybeProps: ComponentProps | undefined
): { scope: Stack; id: string; props: ComponentProps } {
  if (typeof scopeOrName === "string") {
    return { scope: new Stack(scopeOrName), id: scopeOrName, props: idOrProps as ComponentProps };
  }
  return { scope: scopeOrName, id: idOrProps as string, props: maybeProps as ComponentProps };
}

/**
 * A component (server-side object type `"component"`). Unlike the uniform `defineResourceConstruct`
 * types, `Component` is a bespoke subclass because create-in-service is strict: it emits a
 * `contains` edge from `props.service` to itself so the synthesized manifest satisfies the strict
 * apply invariant. Re-assignment (moving a component between services) is P5b's `move` verb, not an
 * IaC concern here.
 *
 * Carries its own `fromName()`/`fromUrn()` statics (D16(2)) rather than going through
 * `defineResourceConstruct` — same contract as every other typed-registry construct
 * (`ResourceConstructStatics<"component">`), hand-written here because `Component` already is.
 *
 * TWO CONSTRUCTOR FORMS (team-pipeline-iac.md D15a/D17 round B): `new Component(scope, id, props)`
 * (round A, unchanged) for a `Component` declared inside an existing `Stack`, and `new
 * Component(name, props)` for a MULTI-PIPELINE repo's root file — "a multi-pipeline repo roots at
 * `Component`" (D17) — which auto-creates its own `Stack` exactly the way a root `Pipeline` class
 * does (`pipeline.ts`), so `App`/`Stack` stay absent from that file's own code (D15a).
 */
export class Component extends ResourceConstruct<"component"> {
  /** The service this component belongs to, as a reference — recorded so composition built on top
   *  of an owned `Component` (round B's `Pipeline`, computing a default publish `repository` path)
   *  can read it back; `props.service` itself is consumed by the constructor and not otherwise kept. */
  readonly service: IService;

  constructor(name: string, props: ComponentProps);
  constructor(scope: Stack, id: string, props: ComponentProps);
  constructor(
    scopeOrName: Stack | string,
    idOrProps: string | ComponentProps,
    maybeProps?: ComponentProps
  ) {
    const resolved = resolveComponentCtorArgs(scopeOrName, idOrProps, maybeProps);
    super(resolved.scope, resolved.id, "component", resolved.props);
    this.service = { urn: resolveUrn(resolved.props.service), typeId: "service" };
    resolved.scope._registerRelationship({
      typeId: "contains",
      from: resolved.props.service,
      to: this
    });
  }

  /** A reference to an EXISTING component by its display NAME — see `nameReferenceUrn`'s doc. */
  static fromName(name: string): IComponent {
    return { urn: nameReferenceUrn("component", name), typeId: "component" };
  }

  /** A reference to an EXISTING component by its exact URN. */
  static fromUrn(urn: string): IComponent {
    return { urn, typeId: "component" };
  }

  /**
   * Declares a source mapping onto this component (C1) — the repo/path glob whose events correlate
   * to one of this component's pipelines (DESIGN §9.2). Declared on `Component` rather than on
   * `ResourceConstruct` because `source_mappings.component_object_id` is exactly that: a mapping
   * routes a source to a COMPONENT, and offering the method on every resource type would invite
   * mappings onto services and deployment-targets that correlation would never consult.
   * `stack.addSourceMapping(urn, ...)` remains available for a component outside this program.
   *
   * Call it once per source: mappings are identified by their whole tuple, so several are fine
   * (a repo that drives both an `image` build and a `configuration` sync), but declaring the same
   * tuple twice is rejected at `POST /plans`.
   */
  mapsSource(spec: SourceMappingSpec): this {
    this.stack.addSourceMapping(this, spec);
    return this;
  }

  /**
   * Declares that this component PRODUCES a dependency coordinate (ADR-0032 §7e) — "this component's
   * production releases are where `@acme/lib`'s versions come from". Sugar over
   * `stack.addDependencyProducer(this, spec)`, which carries the full rule.
   *
   * Declared on `Component` and not on `ResourceConstruct` for the same reason `mapsSource` is:
   * `dependency_line_producers.producer_object_id` must be a component, and a `service`-valued
   * declaration is REFUSED at `POST /plans` — internal head derivation reads the component a
   * production placement names, so a service declaration would stop the coordinate being polled and
   * derive no head at all. Offering the method on every resource type would invite exactly that.
   *
   * TWO THINGS THIS SURFACE CANNOT DO, both by design:
   *   1. Retract the stack's LAST declaration — deleting the call leaves it standing, because an
   *      absent `producers` collection means UNMANAGED (`addDependencyProducer`).
   *   2. Show you the blast radius first. The API verb's `--dry-run` lists the components whose
   *      repositories this reaches; a manifest cannot, so run it before you commit the code.
   */
  producesDependency(spec: DependencyProducerSpec): this {
    this.stack.addDependencyProducer(this, spec);
    return this;
  }

  /**
   * Places this component at `deploymentTarget` (ADR-0026) — the form to reach for.
   *
   * Sugar over the standalone `Placement` construct, which it CONSTRUCTS rather than duplicating:
   * one implementation, two spellings (decision Q1). Reads like `dependsOn`/`consumes`/`owns`, and
   * names the component implicitly, which is what makes it the ergonomic default.
   *
   * Note it is NOT the safety argument for preferring it: both endpoints are required on the
   * standalone form too, so a half-declared placement is unexpressible either way — the pair IS the
   * identity (D3).
   */
  placeAt(deploymentTarget: IDeploymentTarget | string): Placement {
    return new Placement(this.stack, this, deploymentTarget);
  }
}

/**
 * A placement as a standalone construct (decision Q1's second form) — for the case the sugar cannot
 * serve, e.g. a component referenced by URN from outside this program.
 *
 * NOT a `ResourceConstruct`: a placement is not emitted into the manifest's `objects` at all. It is
 * a side-table declaration like a source mapping, because it cannot be created through a door taking
 * free-form `properties` — that door is refused outright, since it could not resolve or type-check
 * the endpoints nor write the derived edges (PR #207).
 */
/** The non-target half of a binding declaration, shared by the object and placement doors so the
 *  two can never drift. Undefined fields are OMITTED rather than emitted as `undefined`, which is
 *  what keeps `synth()` byte-stable. */
function executorBindingFields(spec: ExecutorBindingSpec): Record<string, unknown> {
  return {
    ...(spec.type !== undefined ? { type: spec.type } : {}),
    ...(spec.pluginModule !== undefined ? { pluginModule: spec.pluginModule } : {}),
    ...(spec.pluginInstanceId !== undefined ? { pluginInstanceId: spec.pluginInstanceId } : {}),
    ...(spec.config !== undefined ? { config: spec.config } : {}),
    ...(spec.secretRefs !== undefined ? { secretRefs: spec.secretRefs } : {}),
    ...(spec.allowedHosts !== undefined ? { allowedHosts: spec.allowedHosts } : {}),
    ...(spec.externalRef !== undefined ? { externalRef: spec.externalRef } : {}),
    ...(spec.executionSystem !== undefined
      ? { executionSystemId: resolveUrn(spec.executionSystem) }
      : {})
  };
}

export class Placement {
  private readonly stack: Stack;
  private readonly component: IComponent | string;
  private readonly deploymentTarget: IDeploymentTarget | string;

  constructor(
    stack: Stack,
    component: IComponent | string,
    deploymentTarget: IDeploymentTarget | string
  ) {
    stack.addPlacement(component, deploymentTarget);
    this.stack = stack;
    this.component = component;
    this.deploymentTarget = deploymentTarget;
  }

  /**
   * Declares an `executor_bindings` row on THIS placement — `component.placeAt(prod).bindsExecutor({…})`.
   *
   * This is the pipeline that actually releases the component AT that target, which is why it hangs
   * off the placement rather than off either endpoint: the same component at two targets is two
   * bindings, and the same target for two components likewise.
   */
  bindsExecutor(spec: ExecutorBindingSpec = {}): this {
    this.stack.addPlacementExecutorBinding(this.component, this.deploymentTarget, spec);
    return this;
  }
}

// The remaining 4 typed-registry resources — cheap to add given the factory above. Each carries
// fromName()/fromUrn() statics returning IDeploymentTarget/IGroup/IUser/IServiceAccount (D16(2)).
export const DeploymentTarget = defineResourceConstruct("deployment-target");
export const Group = defineResourceConstruct("group");
export const User = defineResourceConstruct("user");
export const ServiceAccount = defineResourceConstruct("service-account");

// -------------------------------------------------------------------------------------------
// Campaign / Release Topology constructs (M5, BUILD_AND_TEST.md §8) — written as
// real `ResourceConstruct` subclasses rather than via `defineResourceConstruct`, because each
// needs custom constructor logic (resolving construct references to URN strings, typed
// `waves`/`targets` props) that plain `ResourceProps` doesn't support.
// -------------------------------------------------------------------------------------------

/** Resolves a relationship-style reference to a URN string — the same
 *  `typeof t === "string" ? t : t.urn` pattern `Stack.synth()` uses for relationship endpoints,
 *  reused here for the `properties.targets`/`properties.waves[].targets` arrays these constructs
 *  synthesize (which are plain JSON, not relationship declarations). Accepts an owned construct, a
 *  `fromXxx()` reference, or a bare URN string — all three carry `.urn` except the string, which
 *  already IS one. A reference is NEVER registered anywhere by this call; it only ever contributes
 *  the URN it already carries (D16(2): "a reference must never create an object in the manifest"). */
function resolveUrn(target: IResourceRef | string): string {
  return typeof target === "string" ? target : target.urn;
}

/**
 * Best-effort human-readable LOCATION for a synth validation error (D16(5)): the construct's tree
 * PATH when the reference is an owned construct in this program, else the raw URN/id string it
 * names (an external reference, a `fromXxx()` placeholder, or a bare id — none of which sit in this
 * program's construct tree, so there is no path to report beyond the identifier itself). Used to
 * annotate every entry `Stack.synth()` pushes into a collection the final schema validation checks,
 * so a refusal names the file/construct a team actually wrote, not just an array index.
 */
function locationOf(ref: IResourceRef | string): string {
  if (typeof ref === "string") return ref;
  return ref instanceof ResourceConstruct ? ref.path : ref.urn;
}

export interface ReleaseTopologyWaveSpec {
  readonly mode: "parallel" | "sequential";
  readonly targets: (IResourceRef | string)[];
  /** @default none — the wave is unnamed. */
  readonly name?: string;
  /** Left unset here means "let the server default it" rather than this construct silently picking
   *  a value.
   *  @default true server-side (except an implicit wave 0) */
  readonly requiresFanIn?: boolean;
}

export interface ReleaseTopologyProps extends Omit<ResourceProps, "properties"> {
  readonly waves: ReleaseTopologyWaveSpec[];
}

/**
 * A named, reusable wave plan (server-side object type `"release-topology"`, pre-seeded —
 * `drizzle/0007_change_coordination.sql`). A `Campaign` (or a Change) links one by id — see
 * `CampaignProps.topology`'s doc comment for the id-vs-URN caveat that applies there.
 */
export class ReleaseTopology extends ResourceConstruct {
  constructor(scope: Stack, id: string, props: ReleaseTopologyProps) {
    const waves = props.waves.map((wave) => ({
      ...(wave.name !== undefined ? { name: wave.name } : {}),
      mode: wave.mode,
      targets: wave.targets.map(resolveUrn),
      ...(wave.requiresFanIn !== undefined ? { requiresFanIn: wave.requiresFanIn } : {})
    }));
    super(scope, id, "release-topology", {
      name: props.name,
      urn: props.urn,
      domainId: props.domainId,
      labels: props.labels,
      properties: { waves }
    });
  }
}

export interface CampaignProps extends Omit<ResourceProps, "properties"> {
  /**
   * Object ids or URNs this campaign fans out to — one member Change per target, per wave.
   * Resolved to URN strings here, mirroring `CreateCampaignRequestSchema.targets`'s idOrUrn
   * semantics. `coordination/campaign-reconcile.ts` re-resolves every declared target (and
   * `topology`, below) to a real object id the first time the campaign's plan compiles — the same
   * `getObjectByIdOrUrnAnyType` idOrUrn resolution `POST /campaigns` (`proposeCampaign`) and
   * `POST /changes` (`proposeChange`) already do at creation time, just deferred to reconcile time
   * for an IaC-authored campaign (which has no such creation-time hook — `iac/plans-repo.ts`
   * persists a manifest's declared `properties` verbatim). This is what makes an IaC-authored
   * campaign's implicit `depends_on`-based wave auto-sequencing work identically to an
   * API-created campaign's: `campaign-plan-service.ts`'s `loadDependsOnEdges` queries
   * `relationships` by real object id, so resolution has to land BEFORE that query runs, not after
   * — reconcile.ts's ordering guarantees exactly that. The campaign's own stored
   * `properties.targets` is canonicalized to the resolved real ids as a side effect of that first
   * compile (a one-time, idempotent no-op for an already-real-id API-created campaign).
   */
  readonly targets: (IResourceRef | string)[];
  /** @default none */
  readonly description?: string;
  /** Links this campaign to an existing Release Topology — a construct reference (resolved to its
   *  URN, then re-resolved to a real object id server-side, same as `targets` above) or a raw
   *  object id/URN string.
   *  @default none — no topology; waves fall back to whatever `campaign-plan-service.ts` defaults to. */
  readonly topology?: ReleaseTopology | string;
}

/**
 * A coordinated multi-target rollout (server-side object type `"campaign"`, pre-seeded —
 * `drizzle/0011_campaigns.sql`). See `CampaignProps.targets`/`CampaignProps.topology` for how
 * IaC-authored (URN-only, pre-apply) references get resolved to real object ids server-side.
 *
 * SECURITY NOTE: `campaign.properties.targets` is bound to the applying actor's own
 * `object:write` authority at apply time (`coordination/campaign-scope-authz.ts`'s
 * `assertCampaignTargetsWithinAuthority`, wired into `iac/plans-repo.ts`'s `prepareApplyChecks`)
 * — every declared target is individually resolved and `authorize()`-checked, the same shape as
 * `POST /campaigns`. The generic `/objects/campaign` endpoint refuses campaign writes outright
 * (forcing ordinary API clients through `POST /campaigns`); IaC apply is exempt from that block
 * only because it runs this equivalent per-target check itself. Net effect for IaC authors: an
 * `apply` can 403 on a single target inside an otherwise-valid plan, not just reject the whole
 * manifest up front — every `checks` entry is authorized before ANY mutation executes
 * (`plans-repo.ts`'s module doc), so a partial/mismatched campaign is never created, but the
 * failure is per-target, not whole-manifest.
 */
export class Campaign extends ResourceConstruct {
  constructor(scope: Stack, id: string, props: CampaignProps) {
    const properties: Record<string, unknown> = {
      targets: props.targets.map(resolveUrn),
      ...(props.description !== undefined ? { description: props.description } : {}),
      ...(props.topology !== undefined ? { topologyObjectId: resolveUrn(props.topology) } : {})
    };
    super(scope, id, "campaign", {
      name: props.name,
      urn: props.urn,
      domainId: props.domainId,
      labels: props.labels,
      properties
    });
  }
}
