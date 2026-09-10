import { ExecutorTypeSchema, type ArtifactClass, type ExecutorType } from "@scp/schemas";
import {
  Component,
  Construct,
  ReleaseTopology,
  ResourceConstruct,
  Stack,
  type IResourceRef,
  type IService
} from "./construct.js";
import type { PlaceableTarget } from "./infra.js";
import { productsModuleSource } from "./products.js";
import { normalizeWaveItems, type WaveItem, type WaveTarget } from "./waves.js";

/** Typed pipeline-kind constructs. See docs/coordination-as-code.md §281. */

// `ExecutionSystem` — reference-only. See docs/coordination-as-code.md §282.

export type IExecutionSystem = IResourceRef<"execution-system">;

const EXECUTION_SYSTEM_NAME_REFERENCE_NAMESPACE = "named-ref";

function slugifyForReference(input: string): string {
  const slug = input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug : "resource";
}

export const ExecutionSystem = {
  /** A reference to an EXISTING execution-system by its display NAME (resolved server-side at plan
   *  time, D14) — e.g. `ExecutionSystem.fromName("org-registry")`, the platform estate's own
   *  registry (main doc §3's worked example; see `BuildPipelineProps.publishesTo`'s doc for why that
   *  exact name is this package's default). */
  fromName(name: string): IExecutionSystem {
    return {
      urn: `urn:scp:${EXECUTION_SYSTEM_NAME_REFERENCE_NAMESPACE}:execution-system:${slugifyForReference(name)}`,
      typeId: "execution-system"
    };
  },
  /** A reference to an EXISTING execution-system by its exact URN. */
  fromUrn(urn: string): IExecutionSystem {
    return { urn, typeId: "execution-system" };
  }
};

// ---------------------------------------------------------------------------------------------
// `repos()` — D18: "The `repos()` standards helper keeps it to the org-relative part
// (`repos('payments/payments-api')`)".
// ---------------------------------------------------------------------------------------------

/** Keeps a pipeline's `repo:` prop to the org-relative slug. See docs/coordination-as-code.md §283. */
export function repos(orgRelativePath: string): string {
  return orgRelativePath;
}

export interface PipelineSourceProps {
  /** The repo this pipeline releases from. REQUIRED — synth refuses a pipeline without one (D18:
   *  "the source repo is always explicit; it is never assumed"). Use `repos()` to keep it to the
   *  org-relative part. */
  readonly repo: string;
  /** Which branch this pipeline tracks — a per-pipeline choice (D18), joins the source mapping's
   *  identity as `refPattern: "refs/heads/{branch}"` (ADR-0030 §1).
   *  @default undefined — matches any ref. */
  readonly branch?: string;
  /** Slices `repo` to one subtree — what lets an infra pipeline share a component's repo with its
   *  image pipeline without colliding (D17: "a `path:` slice").
   *  @default undefined — the whole repo. */
  readonly path?: string;
  /** The correlation provider vocabulary (`source_mappings.sourceKind`) — operator data (ADR-0007),
   *  never enforced by this package.
   *  @default "gitea" — the platform's own self-hosted default (ADR-0012). */
  readonly sourceKind?: string;
}

export interface PipelineWavesProps {
  /** The wave topology (§8). See docs/coordination-as-code.md §284. */
  readonly waves: readonly WaveItem[];
  /**
   * AN ADOPTION AFFORDANCE, not a greenfield-authoring prop. See docs/coordination-as-code.md §285.
   * @default undefined — a fresh, synth-derived URN (ordinary authoring).
   */
  readonly adoptTopologyUrn?: string;
}

/** Build-kind-only publish-destination props (D18's second clause: "the publish destination... is
 *  estate infrastructure, never a team concern"). Mixed into a build-kind pipeline's props only —
 *  `InfrastructurePipeline`/`ConfigurationPipeline` never publish an artifact, so they never carry
 *  these (enforced by `MaybePublishProps`, below). */
export interface PublishProps {
  /** Where the built artifact publishes.
   *  @default `ExecutionSystem.fromName("org-registry")` — the platform estate's own unified
   *  registry (ADR-0012), matching the name the worked examples' own `Registry` construct uses
   *  (`new Registry(estate, "org-registry", {...})`, main doc §3). Teams never type a registry URL
   *  (D18); override only when an estate's registry construct uses a different id. */
  readonly publishesTo?: IExecutionSystem | string;
  /** Overrides the default `<service>/<component>` repository path within the publish destination.
   *  @default `${service-slug}/${component-slug}`, derived from the pipeline's own component (D18). */
  readonly repository?: string;
}

/** `K` is in the "build family" (D13's `ArtifactClassSchema`) iff `PublishProps` applies —
 *  `Infrastructure`/`ConfigurationPipeline` (`K` = `"infrastructure"` | `"configuration"`) resolve
 *  this to `object` (no publish props at all), so passing `publishesTo`/`repository` to either is a
 *  compile error, not a prop that is silently accepted and ignored. */
type MaybePublishProps<K extends ExecutorType> = K extends ArtifactClass ? PublishProps : object;

/** A `Component`/`Service` construct this stack ALREADY OWNS — the only legal nested-pipeline scope,
 *  because a `Pipeline` needs to read its parent's `.stack` (round A's `ResourceConstruct.stack`,
 *  widened public for exactly this composition) and a bare `fromXxx()` reference carries no stack to
 *  read. */
export type PipelineParentScope = Component | ResourceConstruct<"service">;

export interface RootPipelineProps extends PipelineSourceProps, PipelineWavesProps {
  /** The service this pipeline's (auto-created) component belongs to — required, mirroring
   *  `ComponentProps.service` (a component always belongs to a service). */
  readonly service: IService | string;
  /** @default derived deterministically from the root name, like every other construct's URN. */
  readonly urn?: string;
  readonly domainId?: string;
  readonly properties?: Record<string, unknown>;
  readonly labels?: Record<string, unknown>;
}

export interface NestedPipelineProps extends PipelineSourceProps, PipelineWavesProps {
  /** Distinguishes same-kind siblings under one scope — D16(6)'s stated CDK deviation: id defaults
   *  to the construct kind, and is required only when a second pipeline of the SAME kind is scoped
   *  here (e.g. two `ImagePipeline`s on one component).
   *  @default the pipeline kind (`"image"`, `"infrastructure"`, …). */
  readonly id?: string;
}

export type RootPipelinePropsFor<K extends ExecutorType> = RootPipelineProps & MaybePublishProps<K>;
export type NestedPipelinePropsFor<K extends ExecutorType> = NestedPipelineProps &
  MaybePublishProps<K>;

// Constructor-argument resolution, as a pure step. See docs/coordination-as-code.md §286.

interface ResolvedPipelineCtorArgs<K extends ExecutorType> {
  readonly stack: Stack;
  /** The construct-tree parent for this pipeline (a `Component`/`Service`) — `Construct.path` walks
   *  this, so a synth error names the file/construct a team actually wrote (D16(5)). */
  readonly parent: Construct & { readonly stack: Stack };
  readonly id: string;
  /** What the `releases_via` edge hangs off — the component (default rung) or the service (D8's
   *  deliberate shared-rung exception). Kept as the OWNED construct (not the looser `IComponent` /
   *  `IResourceRef<"service">` reference interface) so `instanceof Component` narrows cleanly when
   *  computing the default publish `repository` path off `Component.service`. */
  readonly attachedTo: Component | ResourceConstruct<"service">;
  readonly isComponentScoped: boolean;
  readonly props: NestedPipelinePropsFor<K> | RootPipelinePropsFor<K>;
}

function resolvePipelineCtorArgs<K extends ExecutorType>(
  kind: K,
  nameOrScope: string | PipelineParentScope,
  arg2: unknown,
  arg3: unknown
): ResolvedPipelineCtorArgs<K> {
  if (typeof nameOrScope === "string") {
    const props = arg2 as RootPipelinePropsFor<K>;
    const stack = new Stack(nameOrScope);
    const component = new Component(stack, nameOrScope, {
      name: nameOrScope,
      service: props.service,
      ...(props.urn !== undefined ? { urn: props.urn } : {}),
      ...(props.domainId !== undefined ? { domainId: props.domainId } : {}),
      ...(props.properties !== undefined ? { properties: props.properties } : {}),
      ...(props.labels !== undefined ? { labels: props.labels } : {})
    });
    return {
      stack,
      parent: component,
      id: kind,
      attachedTo: component,
      isComponentScoped: true,
      props
    };
  }

  const scope = nameOrScope;
  const isComponentScoped = scope instanceof Component;
  // `arg2` is either the props object (default id) or an explicit id string with `arg3` as props —
  // mirroring `NestedPipelineProps.id`'s doc: `new XxxPipeline(scope, props)` is the common case,
  // and a caller only ever reaches for `new XxxPipeline(scope, id, props)` when a second pipeline of
  // the SAME kind needs a distinct id (same-kind siblings, D16(6)).
  const explicitId = typeof arg2 === "string" ? arg2 : undefined;
  const props = (explicitId !== undefined ? arg3 : arg2) as NestedPipelinePropsFor<K>;
  const id = explicitId ?? props.id ?? kind;
  return {
    stack: scope.stack,
    parent: scope,
    id,
    attachedTo: scope,
    isComponentScoped,
    props
  };
}

function resourceUrn(ref: IResourceRef | string): string {
  return typeof ref === "string" ? ref : ref.urn;
}

function waveTargetUrn(target: WaveTarget): string {
  return typeof target === "string" ? target : target.urn;
}

/** The last URN path segment — the SLUG a `fromXxx()` reference or an owned construct's own
 *  deterministic URN always carries as its final component (`urn.ts`'s `deriveConstructUrn`,
 *  `construct.ts`'s `nameReferenceUrn` — both slugify the given name and place it last). Used only
 *  for the D18 default publish `repository` path, which wants human-readable slugs, not full URNs. */
function lastUrnSegment(ref: IResourceRef | string): string {
  const urn = resourceUrn(ref);
  const parts = urn.split(":");
  return parts[parts.length - 1] ?? urn;
}

// The shared synth logic every generated pipeline class uses. See docs/coordination-as-code.md §287.

export abstract class PipelineBase<K extends ExecutorType> extends Construct {
  readonly stack: Stack;
  readonly kind: K;
  /** What the `releases_via` edge hangs off (D8: component by default, service at the shared-rung
   *  exception). */
  readonly attachedTo: Component | ResourceConstruct<"service">;
  /** The pipeline's own repo and branch, re-exposed. See docs/coordination-as-code.md §288. */
  readonly repo: string;
  readonly branch?: string;
  private readonly isComponentScoped: boolean;
  private readonly topology: ReleaseTopology;

  /** The component every behaviour here is about, or undefined. See docs/coordination-as-code.md §289. */
  get componentUrn(): string | undefined {
    return this.isComponentScoped ? this.attachedTo.urn : undefined;
  }

  protected constructor(resolved: ResolvedPipelineCtorArgs<K>, kind: K) {
    super(resolved.parent, resolved.id);
    if (!resolved.props.repo || resolved.props.repo.trim().length === 0) {
      throw new Error(
        `Pipeline "${this.path}" (kind "${kind}") has no repo — synth refuses a pipeline without one ` +
          `(team-pipeline-iac.md D18: "the source repo is always explicit; it is never assumed").`
      );
    }

    this.stack = resolved.stack;
    this.kind = kind;
    this.attachedTo = resolved.attachedTo;
    this.isComponentScoped = resolved.isComponentScoped;
    this.repo = resolved.props.repo;
    if (resolved.props.branch !== undefined) this.branch = resolved.props.branch;

    const normalizedWaves = normalizeWaveItems(resolved.props.waves);
    this.topology = new ReleaseTopology(this.stack, `${this.id}-topology`, {
      name: `${lastUrnSegment(resolved.attachedTo)}-${kind}-pipeline`,
      waves: normalizedWaves,
      // `adoptTopologyUrn` (this file's own doc) — set only by an adopting caller (`scp iac
      // export`), so `scp apply` matches the LIVE topology object instead of creating a duplicate.
      ...(resolved.props.adoptTopologyUrn !== undefined
        ? { urn: resolved.props.adoptTopologyUrn }
        : {})
    });

    this.stack.addRelationship("releases_via", resolved.attachedTo, this.topology, { type: kind });

    // Source mapping + placement inference. See docs/coordination-as-code.md §290.
    if (this.isComponentScoped) {
      this.stack.addSourceMapping(resolved.attachedTo, {
        sourceKind: resolved.props.sourceKind ?? "gitea",
        repoPattern: resolved.props.repo,
        ...(resolved.props.path !== undefined ? { pathPattern: resolved.props.path } : {}),
        ...(resolved.props.branch !== undefined
          ? { refPattern: `refs/heads/${resolved.props.branch}` }
          : {}),
        type: kind
      });

      const seen = new Set<string>();
      for (const wave of normalizedWaves) {
        for (const target of wave.targets) {
          const targetUrn = waveTargetUrn(target);
          if (seen.has(targetUrn)) continue;
          seen.add(targetUrn);
          // D8: "an explicit declaration always overrides an inferred one" — enforced by never
          // emitting the inferred entry when the pair is already explicitly declared, rather than a
          // later dedup pass (`Stack.hasPlacement`'s own doc carries the full rule).
          if (!this.stack.hasPlacement(resolved.attachedTo, target)) {
            this.stack.addPlacement(resolved.attachedTo, target);
          }
        }
      }
    }

    // Publish destination (D18) — build-kind pipelines only. `MaybePublishProps<K>` already makes
    // `publishesTo`/`repository` a compile error on `InfrastructurePipeline`/`ConfigurationPipeline`
    // props; this runtime gate is the same rule applied to the constructor body, which is generic
    // over `K` and therefore cannot rely on the type-level exclusion alone.
    const isBuildKind = kind !== "infrastructure" && kind !== "configuration";
    if (isBuildKind && this.isComponentScoped && resolved.attachedTo instanceof Component) {
      const buildProps = resolved.props as unknown as PublishProps;
      const publishesTo = buildProps.publishesTo ?? ExecutionSystem.fromName("org-registry");
      const repository =
        buildProps.repository ??
        `${lastUrnSegment(resolved.attachedTo.service)}/${lastUrnSegment(resolved.attachedTo)}`;
      this.stack.addRelationship("publishes_to", resolved.attachedTo, publishesTo, { repository });
    }
  }

  /** Declares a dependency edge from this component to a target. See docs/coordination-as-code.md §291. */
  dependsOn(target: IResourceRef | string, properties?: Record<string, unknown>): this {
    this.stack.addRelationship("depends_on", this.attachedTo, target, properties);
    return this;
  }

  /** Declares which infra product. See docs/coordination-as-code.md §292. */
  placeAt(target: PlaceableTarget<K>): this {
    this.stack.addPlacement(this.attachedTo, target as unknown as IResourceRef);
    return this;
  }

  /** The products module for this pipeline's own owned infra. See docs/coordination-as-code.md §293. */
  synthProducts(): string {
    return productsModuleSource(this);
  }
}

// The 11 typed pipeline-kind classes. See docs/coordination-as-code.md §294.

export interface PipelineConstructStatics<K extends ExecutorType> {
  new (name: string, props: RootPipelinePropsFor<K>): PipelineBase<K>;
  new (scope: PipelineParentScope, props: NestedPipelinePropsFor<K>): PipelineBase<K>;
  new (scope: PipelineParentScope, id: string, props: NestedPipelinePropsFor<K>): PipelineBase<K>;
}

function definePipelineConstruct<K extends ExecutorType>(kind: K): PipelineConstructStatics<K> {
  class Klass extends PipelineBase<K> {
    constructor(nameOrScope: string | PipelineParentScope, arg2: unknown, arg3?: unknown) {
      super(resolvePipelineCtorArgs(kind, nameOrScope, arg2, arg3), kind);
    }
  }
  return Klass as unknown as PipelineConstructStatics<K>;
}

// Exhaustiveness: `ExecutorTypeSchema.options` is the SAME closed vocabulary this object's
// `satisfies` clause is checked against, so the two can never drift — a member added to one is a
// member the other must account for (the schema side by its own Zod enum, this side by the
// TypeScript compiler).
const PIPELINE_CLASSES = {
  image: definePipelineConstruct("image"),
  rpm: definePipelineConstruct("rpm"),
  deb: definePipelineConstruct("deb"),
  npm: definePipelineConstruct("npm"),
  maven: definePipelineConstruct("maven"),
  python: definePipelineConstruct("python"),
  go: definePipelineConstruct("go"),
  chart: definePipelineConstruct("chart"),
  "vm-image": definePipelineConstruct("vm-image"),
  infrastructure: definePipelineConstruct("infrastructure"),
  configuration: definePipelineConstruct("configuration")
} satisfies Record<ExecutorType, unknown>;

/** Runtime mirror of the same totality guarantee, for tests that want to enumerate rather than rely
 *  purely on the type checker (`pipeline.test.ts`'s exhaustiveness case). */
export const PIPELINE_KINDS: readonly ExecutorType[] = ExecutorTypeSchema.options;

/** An image build → push → bump-config → sync journey (D13, D17). `placeAt` accepts `ICluster` only. */
export const ImagePipeline = PIPELINE_CLASSES.image;
/** An RPM build → publish → batch-install journey. `placeAt` accepts `IInstanceGroup` only. */
export const RpmPipeline = PIPELINE_CLASSES.rpm;
/** A `.deb` build → publish → batch-install journey. `placeAt` accepts `IInstanceGroup` only. */
export const DebPipeline = PIPELINE_CLASSES.deb;
/** An npm package publish journey. Never placed — `placeAt` is uncallable (`PlaceableTarget` is
 *  `never`): npm packages publish to a registry and are never a deploy target (D24). */
export const NpmPipeline = PIPELINE_CLASSES.npm;
/** A Maven artifact publish journey. Never placed, same rule as `NpmPipeline`. */
export const MavenPipeline = PIPELINE_CLASSES.maven;
/** A Python package publish journey. Never placed, same rule as `NpmPipeline`. */
export const PythonPipeline = PIPELINE_CLASSES.python;
/** A Go module publish journey. Never placed, same rule as `NpmPipeline`. */
export const GoPipeline = PIPELINE_CLASSES.go;
/** A Helm chart build → push journey. `placeAt` accepts `ICluster` only. */
export const ChartPipeline = PIPELINE_CLASSES.chart;
/** A baked VM/AMI image build journey. `placeAt` accepts `IInstanceGroup` only. */
export const VmImagePipeline = PIPELINE_CLASSES["vm-image"];
/** Stands up / changes the IaC substrate itself — PRODUCES infra products (`Cluster`,
 *  `InstanceGroup`, …, `infra.ts`), never itself placed at one: `placeAt` is uncallable
 *  (`PlaceableTarget<"infrastructure">` is `never`, D24: "'placement' is not a concept that applies
 *  to it"). Never carries `publishesTo`/`repository` — it never publishes an artifact either. */
export const InfrastructurePipeline = PIPELINE_CLASSES.infrastructure;
/** Applies declarative desired state to a running system (GitOps sync). `placeAt` accepts `ICluster
 *  | IInstanceGroup` (D24: "a GitOps sync pipeline places at a cluster or instance group exactly
 *  like a build artifact does"). Never carries `publishesTo`/`repository` — a configuration sync
 *  never publishes an artifact either. */
export const ConfigurationPipeline = PIPELINE_CLASSES.configuration;
