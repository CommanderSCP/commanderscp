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
  type ManifestSourceMapping,
  type SourceMappingScope
} from "@scp/schemas";
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

/**
 * Root scope holding one or more `Stack`s. `App` itself never appears in a manifest — it's purely
 * an in-memory aggregation point, mirroring real CDK's `App`.
 *
 * SYNTH PLUMBING, not authoring surface (team-pipeline-iac.md D15a): `new Stack("platform-estate")`
 * auto-creates one of these internally, so no user-facing IaC file ever needs to write `new App()`.
 * It stays exported (and constructible) for the two cases that still need it directly: synthesizing
 * SEVERAL stacks together via `app.synth()` / `app.listStacks()`, and the pre-D15a two-argument
 * `new Stack(app, stackName)` form that some existing callers still use (see `Stack`'s constructor
 * doc) — both legitimate, neither the form any NEW authoring code should reach for.
 */
export class App extends Construct {
  private readonly stacks: Stack[] = [];

  constructor() {
    super(undefined, "App");
  }

  /** @internal called by `Stack`'s constructor. */
  _registerStack(stack: Stack): void {
    this.stacks.push(stack);
  }

  listStacks(): readonly Stack[] {
    return this.stacks;
  }

  /**
   * Synthesizes every stack in this app. Sorted by `stackName` (not registration order) so an app
   * whose stacks were added in a different order still produces the same array — same determinism
   * discipline as `Stack.synth()`'s object/relationship ordering.
   */
  synth(): DesiredStateManifest[] {
    return [...this.stacks]
      .sort((a, b) => a.stackName.localeCompare(b.stackName))
      .map((s) => s.synth());
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
  private readonly sourceMappingDecls: ManifestSourceMapping[] = [];
  private readonly placementDecls: ManifestPlacement[] = [];
  private readonly executorBindingDecls: ManifestExecutorBinding[] = [];
  private readonly dependencyProducerDecls: ManifestDependencyProducer[] = [];
  private readonly governanceMoveRungDecls: ManifestGovernanceMoveRung[] = [];

  /**
   * `new Stack("platform-estate")` is the authoring form (D15a): `App` is internal synth plumbing
   * and is auto-created when omitted — nothing in a component's, team's, or estate's file ever
   * writes `new App()`. The two-argument form (`new Stack(app, stackName)`) is kept for callers that
   * already construct an `App` themselves to synthesize several stacks together (`app.synth()`);
   * `apps/server`'s integration tests are the one place in this repo that still does, and this
   * overload is what lets them keep compiling unmodified — it is not the form new authoring code
   * should reach for.
   */
  constructor(stackName: string);
  constructor(app: App, stackName: string);
  constructor(appOrStackName: App | string, maybeStackName?: string) {
    const explicitApp = appOrStackName instanceof App ? appOrStackName : undefined;
    const stackName = explicitApp ? (maybeStackName ?? "") : (appOrStackName as string);
    const app = explicitApp ?? new App();
    super(app, stackName);
    if (stackName.trim().length === 0) throw new Error("Stack name must be non-empty");
    this.stackName = stackName;
    app._registerStack(this);
  }

  /** @internal called by `ResourceConstruct`'s constructor. */
  _registerResource(resource: ResourceConstruct): void {
    this.resources.push(resource);
  }

  /** @internal called by `ResourceConstruct`'s relationship fluent methods. */
  _registerRelationship(decl: RelationshipDecl): void {
    this.relationshipDecls.push(decl);
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
   */
  addSourceMapping(component: IComponent | string, spec: SourceMappingSpec): this {
    this.sourceMappingDecls.push({
      componentUrn: resolveUrn(component),
      sourceKind: spec.sourceKind,
      ...(spec.repoPattern !== undefined ? { repoPattern: spec.repoPattern } : {}),
      ...(spec.pathPattern !== undefined ? { pathPattern: spec.pathPattern } : {}),
      ...(spec.type !== undefined ? { type: spec.type } : {}),
      // Omitted stays OMITTED (not `null`): the two mean different things server-side (§10.6).
      ...(spec.scope !== undefined ? { scope: spec.scope } : {})
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
   */
  addPlacement(component: IComponent | string, deploymentTarget: IDeploymentTarget | string): this {
    this.placementDecls.push({
      componentUrn: resolveUrn(component),
      deploymentTargetUrn: resolveUrn(deploymentTarget)
    });
    return this;
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
   */
  addPlacementExecutorBinding(
    component: IComponent | string,
    deploymentTarget: IDeploymentTarget | string,
    spec: ExecutorBindingSpec = {}
  ): this {
    this.executorBindingDecls.push({
      targetUrn: resolveUrn(component),
      deploymentTargetUrn: resolveUrn(deploymentTarget),
      ...executorBindingFields(spec)
    });
    return this;
  }

  addExecutorBinding(target: IResourceRef | string, spec: ExecutorBindingSpec = {}): this {
    this.executorBindingDecls.push({
      targetUrn: resolveUrn(target),
      ...executorBindingFields(spec)
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
   */
  addDependencyProducer(component: IComponent | string, spec: DependencyProducerSpec): this {
    this.dependencyProducerDecls.push({
      producerUrn: resolveUrn(component),
      ecosystem: spec.ecosystem,
      coordinate: spec.coordinate
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
    this.governanceMoveRungDecls.push({ subjectIdOrUrn: resolveUrn(subject) });
    return this;
  }

  /**
   * Pure synth: no `Date.now()`, no `Math.random()`, no `crypto.randomUUID()`, no network/
   * filesystem I/O — everything comes from the construct tree's own props. Objects are sorted by
   * URN and relationships by `(typeId, fromUrn, toUrn)` so re-ordering how constructs were added
   * in code never changes the synthesized manifest, only their CONTENT does — the property
   * `construct.determinism.test.ts` exercises.
   */
  synth(): DesiredStateManifest {
    const objects: ManifestObject[] = this.resources
      .map((r) => r._toManifestObject())
      .sort((a, b) => a.urn.localeCompare(b.urn));

    const relationships: ManifestRelationship[] = this.relationshipDecls
      .map((decl): ManifestRelationship => ({
        typeId: decl.typeId,
        fromUrn: typeof decl.from === "string" ? decl.from : decl.from.urn,
        toUrn: typeof decl.to === "string" ? decl.to : decl.to.urn,
        ...(decl.properties ? { properties: decl.properties } : {})
      }))
      .sort((a, b) => relationshipSortKey(a).localeCompare(relationshipSortKey(b)));

    // C1's two collections are OMITTED WHEN EMPTY rather than emitted as `[]`, so a stack that
    // declares neither synthesizes the byte-identical manifest it did before C1 — the interchange
    // format stays stable for every existing program, and an absent key already means "declares
    // none" server-side (`DesiredStateManifestSchema`).
    const sourceMappings: ManifestSourceMapping[] = [...this.sourceMappingDecls].sort((a, b) =>
      sourceMappingSortKey(a).localeCompare(sourceMappingSortKey(b))
    );
    const executorBindings: ManifestExecutorBinding[] = [...this.executorBindingDecls].sort(
      (a, b) => executorBindingSortKey(a).localeCompare(executorBindingSortKey(b))
    );
    // Sorted on the PAIR, which is the whole identity (ADR-0026 D3) — so declaration order in code
    // never changes the synthesized bytes, only content does.
    const placements: ManifestPlacement[] = [...this.placementDecls].sort((a, b) =>
      `${a.componentUrn}\u0000${a.deploymentTargetUrn}`.localeCompare(
        `${b.componentUrn}\u0000${b.deploymentTargetUrn}`
      )
    );
    // Sorted on `(ecosystem, coordinate)` — the declaration's identity, and NOT the producer, which
    // is the row's value. Two programs that declare the same coordinate from differently-ordered
    // code synthesize the same bytes; one that re-points it does not, which is correct.
    const producers: ManifestDependencyProducer[] = [...this.dependencyProducerDecls].sort((a, b) =>
      `${a.ecosystem}\u0000${a.coordinate}`.localeCompare(`${b.ecosystem}\u0000${b.coordinate}`)
    );
    // Sorted on the SUBJECT, which is the whole identity — a rung has no value beyond existing, so
    // there is nothing else two entries could differ in. Duplicates are left in rather than
    // de-duplicated here: `synth()` reports what the program said, and the server collapses two
    // declarations of one subject into one rung (a repeated rung is idempotent, not ambiguous).
    const governanceMoveRungs: ManifestGovernanceMoveRung[] = [
      ...this.governanceMoveRungDecls
    ].sort((a, b) => a.subjectIdOrUrn.localeCompare(b.subjectIdOrUrn));

    return DesiredStateManifestSchema.parse({
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
      ...(governanceMoveRungs.length > 0 ? { governanceMoveRungs } : {})
    });
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
  /** `protected`, not `private`: `Component.mapsSource` (a subclass) registers through it. */
  protected readonly stack: Stack;

  constructor(
    scope: Stack,
    id: string,
    readonly typeId: TypeId,
    private readonly props: ResourceProps
  ) {
    super(scope, id);
    this.stack = scope;
    this.urn = props.urn ?? deriveConstructUrn(scope.stackName, typeId, id);
    scope._registerResource(this);
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

  /** @internal */
  _toManifestObject(): ManifestObject {
    return {
      urn: this.urn,
      typeId: this.typeId,
      name: this.props.name,
      domainId: this.props.domainId,
      properties: this.props.properties ?? {},
      labels: this.props.labels ?? {}
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
 * A component (server-side object type `"component"`). Unlike the uniform `defineResourceConstruct`
 * types, `Component` is a bespoke subclass because create-in-service is strict: it emits a
 * `contains` edge from `props.service` to itself so the synthesized manifest satisfies the strict
 * apply invariant. Re-assignment (moving a component between services) is P5b's `move` verb, not an
 * IaC concern here.
 *
 * Carries its own `fromName()`/`fromUrn()` statics (D16(2)) rather than going through
 * `defineResourceConstruct` — same contract as every other typed-registry construct
 * (`ResourceConstructStatics<"component">`), hand-written here because `Component` already is.
 */
export class Component extends ResourceConstruct<"component"> {
  constructor(scope: Stack, id: string, props: ComponentProps) {
    super(scope, id, "component", props);
    scope._registerRelationship({ typeId: "contains", from: props.service, to: this });
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
