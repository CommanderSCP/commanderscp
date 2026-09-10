import { type ExecutorType, type InfraKind } from "@scp/schemas";
import {
  Construct,
  ResourceConstruct,
  Stack,
  type IDeploymentTarget,
  type IResourceRef,
  type ResourceProps
} from "./construct.js";
import { slugify } from "./urn.js";

/** Typed infra-product constructs (team-pipeline-iac.md D19/D24). See docs/coordination-as-code.md §268. */
export const PLACEMENT_MATRIX = {
  image: ["cluster"],
  chart: ["cluster"],
  rpm: ["instanceGroup"],
  deb: ["instanceGroup"],
  "vm-image": ["instanceGroup"],
  configuration: ["cluster", "instanceGroup"],
  npm: [],
  maven: [],
  python: [],
  go: [],
  infrastructure: []
} as const satisfies Record<ExecutorType, readonly InfraKind[]>;

/** Every `InfraKind` mapped to the interface type an owned/referenced construct of that kind
 *  implements (D24: "matching interface types `ICluster`, `IInstanceGroup`, `IDatabase`, …"). */
export interface InfraKindInterfaceMap {
  cluster: ICluster;
  instanceGroup: IInstanceGroup;
  database: IDatabase;
  bucket: IBucket;
  queue: IQueue;
}

/** The infra interfaces a pipeline of that kind accepts. See docs/coordination-as-code.md §269. */
export type PlaceableTarget<K extends ExecutorType> =
  (typeof PLACEMENT_MATRIX)[K][number] extends infer Row
    ? Row extends keyof InfraKindInterfaceMap
      ? InfraKindInterfaceMap[Row]
      : never
    : never;

// -------------------------------------------------------------------------------------------
// Infra product constructs — scope is a `Pipeline`, never a bare `Stack` (D19: "declared by —
// scoped to — the Infrastructure or Configuration pipeline that manages it").
// -------------------------------------------------------------------------------------------

/** Any construct owning a stack, which can parent a product. See docs/coordination-as-code.md §270. */
export type InfraProductScope = Construct & { readonly stack: Stack };

export interface InfraProductProps extends ResourceProps {
  /** The BROADER deployment-target. See docs/coordination-as-code.md §271. */
  readonly within: IDeploymentTarget | string;
}

function resourceUrn(ref: IResourceRef | string): string {
  return typeof ref === "string" ? ref : ref.urn;
}

/** The reserved namespace `fromName()` placeholders live in — MUST match `construct.ts`'s private
 *  `NAME_REFERENCE_NAMESPACE` (not exported from there, so duplicated as a literal rather than
 *  imported; see that module's `nameReferenceUrn` doc for the full rule this mirrors). */
const INFRA_NAME_REFERENCE_NAMESPACE = "named-ref";

/** Every infra product's placeholder reference lives in the SAME. See docs/coordination-as-code.md §272. */
function infraNameReferenceUrn(name: string): string {
  return `urn:scp:${INFRA_NAME_REFERENCE_NAMESPACE}:deployment-target:${slugify(name)}`;
}

/** A reference to an infra product. See docs/coordination-as-code.md §273. */
export interface IInfraProductRef<Kind extends InfraKind = InfraKind> extends IDeploymentTarget {
  readonly kind: Kind;
}

/** Type guard: true for an owned resource of this module. See docs/coordination-as-code.md §274. */
export function isInfraProductConstruct(
  resource: ResourceConstruct
): resource is ResourceConstruct<"deployment-target"> & IInfraProductRef {
  return (
    resource.typeId === "deployment-target" &&
    typeof (resource as { kind?: unknown }).kind === "string"
  );
}

export interface InfraProductStatics<Kind extends InfraKind> {
  /** A reference to an EXISTING infra product of this kind, by its display NAME — resolved
   *  server-side at plan time (D14/D20), same rule as every other `fromName()` in this package. */
  fromName(name: string): IInfraProductRef<Kind>;
  /** A reference to an EXISTING infra product of this kind, by its exact URN. */
  fromUrn(urn: string): IInfraProductRef<Kind>;
}

/** One factory, invoked per `InfraKind`, mirroring `construct.ts`'s `defineResourceConstruct` — so a
 *  member added to `InfraKindSchema` without a matching class here is a one-line fix, never eleven
 *  hand-copied class bodies drifting independently (D17's "generated... rather than hand-written"
 *  rule applied to the infra-product side of D24, not just the pipeline-kind side). */
function defineInfraProductConstruct<Kind extends InfraKind>(
  kind: Kind
): (new (
  scope: InfraProductScope,
  id: string,
  props: InfraProductProps
) => ResourceConstruct<"deployment-target"> & IInfraProductRef<Kind>) &
  InfraProductStatics<Kind> {
  class Klass extends ResourceConstruct<"deployment-target"> {
    readonly kind: Kind = kind;
    constructor(scope: InfraProductScope, id: string, props: InfraProductProps) {
      const { within, properties, ...rest } = props;
      // `typeId` is the WIRE type — always `"deployment-target"` (this module's doc). `kind` rides
      // as an ordinary, already-open property (D24's infra-kind vocabulary), never a second typeId.
      super(scope, id, "deployment-target", {
        ...rest,
        properties: { ...(properties ?? {}), kind, within: resourceUrn(within) }
      });
    }
    static fromName(name: string): IInfraProductRef<Kind> {
      return { urn: infraNameReferenceUrn(name), typeId: "deployment-target", kind };
    }
    static fromUrn(urn: string): IInfraProductRef<Kind> {
      return { urn, typeId: "deployment-target", kind };
    }
  }
  return Klass as unknown as (new (
    scope: InfraProductScope,
    id: string,
    props: InfraProductProps
  ) => ResourceConstruct<"deployment-target"> & IInfraProductRef<Kind>) &
    InfraProductStatics<Kind>;
}

/** A reference to an EXISTING `cluster` product, owned or `Cluster.fromName()`/`.fromUrn()`. */
export type ICluster = IInfraProductRef<"cluster">;
/** A reference to an EXISTING `instanceGroup` product, owned or `InstanceGroup.fromName()`/`.fromUrn()`. */
export type IInstanceGroup = IInfraProductRef<"instanceGroup">;
/** A reference to an EXISTING `database` product, owned or `Database.fromName()`/`.fromUrn()`. Never
 *  a deploy target for any artifact — D24: producible and referenceable (`dependsOn`), never placed. */
export type IDatabase = IInfraProductRef<"database">;
/** A reference to an EXISTING `bucket` product — same non-deploy-target rule as `IDatabase`. */
export type IBucket = IInfraProductRef<"bucket">;
/** A reference to an EXISTING `queue` product — same non-deploy-target rule as `IDatabase`. */
export type IQueue = IInfraProductRef<"queue">;

/** A kubernetes-style cluster. See docs/coordination-as-code.md §275. */
export const Cluster = defineInfraProductConstruct("cluster");
/** A VM fleet (`InfraKindSchema`'s `"instanceGroup"`) — the deploy target for `rpm`/`deb`/
 *  `vm-image`/`configuration` pipelines. */
export const InstanceGroup = defineInfraProductConstruct("instanceGroup");
/** A database (`InfraKindSchema`'s `"database"`) — producible and referenceable, never a deploy
 *  target for any artifact (D24). */
export const Database = defineInfraProductConstruct("database");
/** An object-storage bucket — same non-deploy-target rule as `Database`. */
export const Bucket = defineInfraProductConstruct("bucket");
/** A message queue — same non-deploy-target rule as `Database`. */
export const Queue = defineInfraProductConstruct("queue");
