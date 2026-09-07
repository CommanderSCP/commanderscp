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

/** Omitting over a union distributes across its members. See docs/iac.md §197. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
import { deriveConstructUrn, slugify } from "./urn.js";

/** The construct tree, in the shape a CDK user expects. See docs/iac.md §198. */

/** Minimal construct base — just enough identity (`scope`, `id`) for deterministic URN derivation. */
export abstract class Construct {
  constructor(
    readonly scope: Construct | undefined,
    readonly id: string
  ) {}

  /** Slash-joined construct-tree path from the root, e.g. See docs/iac.md §199. */
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

/** A URN plus which typed-registry kind it names. See docs/iac.md §200. */
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

/** The placeholder urn a by-name reference resolves to. See docs/iac.md §201. */
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

/** Root scope every `Stack` sits under. See docs/iac.md §202. */
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
  /**
   * Glob matched against the event's git ref (`refs/heads/main`). See docs/iac.md §203.
   * @default undefined — matches any ref.
   */
  readonly refPattern?: string;
  /** Which pipeline of the component this source drives (ADR-0007). @default "configuration" */
  readonly type?: ExecutorType;
  /**
   * Declared reach of the repo. See docs/iac.md §204.
   * @default undefined — this program does not manage the scope (an apply never clears one set by
   * hand); explicit `null` declares it undeclared, a different value from omission.
   */
  readonly scope?: SourceMappingScope | null;
}

/** An `executor_bindings` declaration minus the target it binds. See docs/iac.md §205. */
/** All fields optional. See docs/iac.md §206. */
export interface ExecutorBindingSpec {
  /** Which pipeline this binding drives (ADR-0007). @default "configuration" */
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
  /** Executor-specific target identifier (e.g. an Argo CD Application name). @default undefined */
  readonly externalRef?: string;
  /** A registered `execution-system` construct/reference, or its id/URN (Mode A). When set, module,
   *  instance id, config and credentials all resolve from that system — declare none of them here.
   *  @default undefined — an INLINE binding (`pluginModule` + `pluginInstanceId`) instead. */
  readonly executionSystem?: IResourceRef | string;
}

/** A named deployable unit (`new Stack('billing-platform')`). See docs/iac.md §207. */
export interface DependencyProducerSpec {
  readonly ecosystem: DependencyEcosystem;
  /** The ECOSYSTEM-NATIVE coordinate, VERBATIM — `@acme/lib`, `github.com/acme/lib`,
   *  `com.acme:lib`, `docker.io/library/alpine`. Never a URN and never slugified: `@acme/lib` and
   *  `acme-lib` share a URN slug and are two different packages. */
  readonly coordinate: string;
}

/** A named deployable unit (`new Stack('billing-platform')`). See docs/iac.md §208. */
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

  /** `new Stack("platform-estate")` is the ONLY form (D15a). See docs/iac.md §209. */
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

  /** L1 — the guaranteed raw manifest-entry door. See docs/iac.md §210. */
  addManifestEntry(object: ManifestObject): this {
    this.rawObjectDecls.push(object);
    return this;
  }

  /** L1 — the guaranteed raw relationship door. See docs/iac.md §211. */
  addRelationship(
    typeId: string,
    from: IResourceRef | string,
    to: IResourceRef | string,
    properties?: Record<string, unknown>
  ): this {
    this._registerRelationship({ typeId, from, to, properties });
    return this;
  }

  /** Declares a `source_mappings` row for `component`. See docs/iac.md §212. */
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

  /** Declares an `executor_bindings` row for `target`. See docs/iac.md §213. */
  /** Declares a `placement` (ADR-0026). See docs/iac.md §214. */
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

  /** Whether this stack already declares that exact placement. See docs/iac.md §215. */
  hasPlacement(component: IResourceRef | string, deploymentTarget: IResourceRef | string): boolean {
    const componentUrn = resolveUrn(component);
    const targetUrn = resolveUrn(deploymentTarget);
    return this.placementDecls.some(
      (d) => d.entry.componentUrn === componentUrn && d.entry.deploymentTargetUrn === targetUrn
    );
  }

  /** Declares a binding on a placement, addressed by its pair. See docs/iac.md §216. */
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

  /** Declares that `component` PRODUCES one dependency coordinate. See docs/iac.md §217. */
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

  /** Declares that moves beneath this subject need permission. See docs/iac.md §218. */
  addGovernanceMoveRung(subject: IResourceRef | string): this {
    this.governanceMoveRungDecls.push({
      location: locationOf(subject),
      entry: { subjectIdOrUrn: resolveUrn(subject) }
    });
    return this;
  }

  /** Pure synth: no clock, no randomness, no ambient input. See docs/iac.md §219. */
  /** L1 ESCAPE HATCH for a pipeline hook (D11, D21). See docs/iac.md §220. */
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

  /** L1 ESCAPE HATCH for a rollout declaration. See docs/iac.md §221. */
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

  /** L1 ESCAPE HATCH for a convergence declaration (D25(b)). See docs/iac.md §222. */
  /** L1 ESCAPE HATCH for a role binding. See docs/iac.md §223. */
  addRoleBinding(binding: ManifestRoleBinding, location?: string): this {
    this.roleBindingDecls.push({
      location: location ?? `${binding.subjectUrn}/${binding.roleName}`,
      entry: binding
    });
    return this;
  }

  /** L1 ESCAPE HATCH for an org-defined role. See docs/iac.md §224. */
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
      // OMITTED WHEN EMPTY, like the three above. See docs/iac.md §225.
      ...(producers.length > 0 ? { producers } : {}),
      // Omitted when empty, meaning what the sibling's omission does. See docs/iac.md §226.
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
      // Omitted when empty, and this is the third such collection. See docs/iac.md §227.
      ...(pipelineHooks.length > 0 ? { pipelineHooks } : {}),
      ...(rollouts.length > 0 ? { rollouts } : {}),
      ...(convergence.length > 0 ? { convergence } : {})
    };

    // TWO OBJECTS, ONE URN. See docs/iac.md §228.
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

    // Every synth error names the tree path that produced it. See docs/iac.md §229.
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

/** Sorts on the mapping's full identity tuple. See docs/iac.md §230. */
function sourceMappingSortKey(m: ManifestSourceMapping): string {
  return [
    m.componentUrn,
    m.sourceKind,
    m.repoPattern ?? "",
    m.pathPattern ?? "",
    m.refPattern ?? "",
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

/** Base class for the 8 typed-registry resource constructs. See docs/iac.md §231. */
export class ResourceConstruct<TypeId extends string = string>
  extends Construct
  implements IResourceRef<TypeId>
{
  readonly urn: string;
  /** Public, widened from the earlier round's narrower access. See docs/iac.md §232. */
  readonly stack: Stack;

  /** `scope` accepts either a `Stack` directly. See docs/iac.md §233. */
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

  /** Declares the binding that drives one of these pipelines. See docs/iac.md §234. */
  bindsExecutor(spec: ExecutorBindingSpec = {}): this {
    this.stack.addExecutorBinding(this, spec);
    return this;
  }

  // NOTE — there is deliberately NO `coordinates()` fluent method. See docs/iac.md §235.

  private manifestOverride: Partial<Omit<ManifestObject, "urn" | "typeId">> = {};

  /** L1 escape hatch, PER-CONSTRUCT (D16(1)). See docs/iac.md §236. */
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

/** One tiny factory per resource type, not eight subclasses. See docs/iac.md §237. */
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
/** A policy (server-side object type `"policy"`). See docs/iac.md §238. */
export const Policy = defineResourceConstruct("policy");

export interface ComponentProps extends ResourceProps {
  /** The service this component belongs to, or a reference. See docs/iac.md §239. */
  readonly service: IService | string;
}

/** Resolves the two constructor forms into one triple. See docs/iac.md §240. */
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

/** A component (server-side object type `"component"`). See docs/iac.md §241. */
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

  /** Declares a source mapping onto this component (C1). See docs/iac.md §242. */
  mapsSource(spec: SourceMappingSpec): this {
    this.stack.addSourceMapping(this, spec);
    return this;
  }

  /** Declares that this component PRODUCES a dependency coordinate. See docs/iac.md §243. */
  producesDependency(spec: DependencyProducerSpec): this {
    this.stack.addDependencyProducer(this, spec);
    return this;
  }

  /** Places this component at `deploymentTarget` (ADR-0026). See docs/iac.md §244. */
  placeAt(deploymentTarget: IDeploymentTarget | string): Placement {
    return new Placement(this.stack, this, deploymentTarget);
  }
}

/** A placement as a standalone construct (decision Q1's second form). See docs/iac.md §245. */
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

  /** Declares an `executor_bindings` row on THIS placement. See docs/iac.md §246. */
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

// Campaign / Release Topology constructs (M5, BUILD_AND_TEST.md §8). See docs/iac.md §247.

/** Resolves a relationship-style reference to a URN string. See docs/iac.md §248. */
function resolveUrn(target: IResourceRef | string): string {
  return typeof target === "string" ? target : target.urn;
}

/** Best-effort human-readable LOCATION for a synth validation error. See docs/iac.md §249. */
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

/** A named, reusable wave plan. See docs/iac.md §250. */
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
  /** The objects this campaign fans out to, one change each. See docs/iac.md §251. */
  readonly targets: (IResourceRef | string)[];
  /** @default none */
  readonly description?: string;
  /** Links this campaign to an existing Release Topology — a construct reference (resolved to its
   *  URN, then re-resolved to a real object id server-side, same as `targets` above) or a raw
   *  object id/URN string.
   *  @default none — no topology; waves fall back to whatever `campaign-plan-service.ts` defaults to. */
  readonly topology?: ReleaseTopology | string;
}

/** A coordinated multi-target rollout. See docs/iac.md §252. */
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
