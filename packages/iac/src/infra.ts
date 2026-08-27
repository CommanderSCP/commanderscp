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

/**
 * Typed infra-product constructs (team-pipeline-iac.md D19/D24) — `Cluster`, `InstanceGroup`,
 * `Database`, `Bucket`, `Queue`, one per member of `InfraKindSchema` (`@scp/schemas/pipeline-
 * behaviors.ts`). Each is a `ResourceConstruct` whose `typeId` IS its infra kind, scoped to the
 * Infrastructure/Configuration `Pipeline` that manages it (`pipeline.ts` — `Cluster`'s scope type
 * is a pipeline, never a bare `Stack`, which is what round A's widened `ResourceConstruct` scope
 * union exists to allow).
 *
 * ## Why the compile-time compatibility derivation lives here, and what "derived" actually means
 *
 * D24: "Each pipeline kind's `placeAt` accepts only the infra interfaces its artifact can actually
 * land on... Derive the per-kind signatures from `ARTIFACT_INFRA_COMPATIBILITY` so the types and
 * the server's matrix cannot drift."
 *
 * `@scp/schemas` exports `ARTIFACT_INFRA_COMPATIBILITY` typed as `Record<ExecutorType, readonly
 * InfraKind[]>` — an explicit WIDENING annotation, deliberate on that side (D24's own doc: "TOTALITY
 * IS THE POINT... a TOTAL mapping keyed by the enum itself"). The cost of that annotation is that
 * TypeScript cannot recover each key's LITERAL row (`image: ["cluster"]`) from the exported VALUE —
 * once a value is typed `readonly InfraKind[]`, every element reads back as the general union
 * `InfraKind`, not the specific literal(s) that row actually holds. A `placeAt` overload keyed off
 * the erased type could therefore only accept `InfraKind` in general, which is exactly the "anything
 * accepts anything" hole D24 exists to close — so pulling the TYPE-LEVEL information through the
 * VALUE-LEVEL export, alone, cannot produce a compile-time-checked `placeAt`.
 *
 * The derivation therefore happens in two layers, and BOTH must hold for the guarantee to be real:
 *
 *   1. TYPE level — `PLACEMENT_MATRIX` below is `@scp/schemas`'s rows, re-declared `as const` so
 *      TypeScript keeps each key's LITERAL tuple, combined with `satisfies Record<ExecutorType,
 *      readonly InfraKind[]>` (not a `:` annotation) so the totality guarantee is STILL compile-
 *      checked — a member added to `ExecutorTypeSchema` without a row here is a compile error,
 *      exactly like the schemas-side export. `satisfies` is what lets both things be true at once:
 *      totality-checked AND literal-preserving, which a `:`-annotated `Record` cannot be.
 *   2. VALUE level — `infra.compatibility-parity.test.ts` asserts, by `Object.entries`, that this
 *      constant is deep-equal to the real `ARTIFACT_INFRA_COMPATIBILITY` import, row for row. A row
 *      that drifts from the server's own matrix fails that test immediately.
 *
 * Together: a member or a value can never drift from `@scp/schemas` without one of the two layers
 * catching it at build time or test time — which is the best TypeScript can do here, since it has no
 * way to recover literal types from an already-widened value it does not itself declare. This is the
 * "if TypeScript cannot express that derivation cleanly, say so" case D24's build instructions
 * anticipate; the honest answer is a two-layer derivation, not a single one, and NOT eleven
 * hand-written `placeAt` signatures with no check tying them back to the schema's matrix.
 */
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

/**
 * The infra interface(s) a `K`-kind pipeline's `placeAt` accepts, derived from `PLACEMENT_MATRIX`
 * (see the module doc above for exactly what "derived" means and does not mean here). Distributes
 * over a multi-row kind (`configuration` → `ICluster | IInstanceGroup`); a kind whose row is `[]`
 * (`npm`, `infrastructure`, …) derives `never`, which is what makes `placeAt` UNCONSTRUCTABLE for
 * those kinds — a compile error at the call site, not a runtime check (D24's compile rung).
 */
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

/** Any construct that owns a `Stack` and can therefore parent an infra product — round A's
 *  `ResourceConstruct` (widened) or round B's `Pipeline` base. Kept narrow and structural rather
 *  than importing `PipelineBase` here, so `infra.ts` has no dependency on `pipeline.ts` (the reverse
 *  dependency — `pipeline.ts` imports `infra.ts` for `PlaceableTarget`/the interface types — would
 *  otherwise become circular). */
export type InfraProductScope = Construct & { readonly stack: Stack };

export interface InfraProductProps extends ResourceProps {
  /** The deployment-target (stage) this infra product lives at/within — GLOSSARY's stage grammar.
   *  Recorded as `properties.within` (a plain URN, resolved from a construct/reference/string like
   *  every other endpoint in this package) rather than as a new relationship type, since no
   *  cross-boundary consumer of that edge exists yet in this increment. */
  readonly within: IDeploymentTarget | string;
}

function resourceUrn(ref: IResourceRef | string): string {
  return typeof ref === "string" ? ref : ref.urn;
}

/** The reserved namespace `fromName()` placeholders live in — MUST match `construct.ts`'s private
 *  `NAME_REFERENCE_NAMESPACE` (not exported from there, so duplicated as a literal rather than
 *  imported; see that module's `nameReferenceUrn` doc for the full rule this mirrors). */
const INFRA_NAME_REFERENCE_NAMESPACE = "named-ref";

function infraNameReferenceUrn(typeId: string, name: string): string {
  return `urn:scp:${INFRA_NAME_REFERENCE_NAMESPACE}:${typeId}:${slugify(name)}`;
}

export interface InfraProductStatics<Kind extends keyof InfraKindInterfaceMap> {
  /** A reference to an EXISTING infra product of this kind, by its display NAME — resolved
   *  server-side at plan time (D14/D20), same rule as every other `fromName()` in this package. */
  fromName(name: string): InfraKindInterfaceMap[Kind];
  /** A reference to an EXISTING infra product of this kind, by its exact URN. */
  fromUrn(urn: string): InfraKindInterfaceMap[Kind];
}

/** One factory, invoked per `InfraKind`, mirroring `construct.ts`'s `defineResourceConstruct` — so a
 *  member added to `InfraKindSchema` without a matching class here is a one-line fix, never eleven
 *  hand-copied class bodies drifting independently (D17's "generated... rather than hand-written"
 *  rule applied to the infra-product side of D24, not just the pipeline-kind side). */
function defineInfraProductConstruct<Kind extends keyof InfraKindInterfaceMap>(
  typeId: Kind
): (new (
  scope: InfraProductScope,
  id: string,
  props: InfraProductProps
) => ResourceConstruct<Kind> & InfraKindInterfaceMap[Kind]) &
  InfraProductStatics<Kind> {
  class Klass extends ResourceConstruct<Kind> {
    constructor(scope: InfraProductScope, id: string, props: InfraProductProps) {
      const { within, properties, ...rest } = props;
      super(scope, id, typeId, {
        ...rest,
        properties: { ...(properties ?? {}), within: resourceUrn(within) }
      });
    }
    static fromName(name: string): InfraKindInterfaceMap[Kind] {
      return { urn: infraNameReferenceUrn(typeId, name), typeId } as InfraKindInterfaceMap[Kind];
    }
    static fromUrn(urn: string): InfraKindInterfaceMap[Kind] {
      return { urn, typeId } as InfraKindInterfaceMap[Kind];
    }
  }
  return Klass as unknown as (new (
    scope: InfraProductScope,
    id: string,
    props: InfraProductProps
  ) => ResourceConstruct<Kind> & InfraKindInterfaceMap[Kind]) &
    InfraProductStatics<Kind>;
}

/** A reference to an EXISTING `cluster` product, owned or `Cluster.fromName()`/`.fromUrn()`. */
export type ICluster = IResourceRef<"cluster">;
/** A reference to an EXISTING `instanceGroup` product, owned or `InstanceGroup.fromName()`/`.fromUrn()`. */
export type IInstanceGroup = IResourceRef<"instanceGroup">;
/** A reference to an EXISTING `database` product, owned or `Database.fromName()`/`.fromUrn()`. Never
 *  a deploy target for any artifact — D24: producible and referenceable (`dependsOn`), never placed. */
export type IDatabase = IResourceRef<"database">;
/** A reference to an EXISTING `bucket` product — same non-deploy-target rule as `IDatabase`. */
export type IBucket = IResourceRef<"bucket">;
/** A reference to an EXISTING `queue` product — same non-deploy-target rule as `IDatabase`. */
export type IQueue = IResourceRef<"queue">;

/**
 * A kubernetes-style cluster (D24 `InfraKindSchema`'s `"cluster"` member) — the deploy target for
 * `image`/`chart`/`configuration` pipelines (`PLACEMENT_MATRIX`).
 */
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
