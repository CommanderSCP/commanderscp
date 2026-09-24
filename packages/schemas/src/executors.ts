import { z } from "zod";
import {
  ChangeRequirementSchema,
  StageDependencySchema,
  cursorPageResponseSchema
} from "./common.js";
import { SbomRefSchema, ScanMethodSchema, TestBundleRefSchema } from "./supply-chain.js";

/** M7 Real Executor Integrations wire contract. See docs/schemas.md §181. */

// -------------------------------------------------------------------------------------------
// Executor bindings (DESIGN §12 — a Component/DeploymentTarget bound to a configured
// ExecutorPlugin instance).
// -------------------------------------------------------------------------------------------

/** The executor **Type**. See docs/schemas.md §182. */
export const ExecutorTypeSchema = z.enum([
  "image",
  "rpm",
  "deb",
  "npm",
  "maven",
  "python",
  "go",
  "chart",
  "vm-image",
  "infrastructure",
  "configuration"
]);
export type ExecutorType = z.infer<typeof ExecutorTypeSchema>;

/** The artifact-class taxonomy, derived as a build subset. See docs/schemas.md §183. */
export const ArtifactClassSchema = ExecutorTypeSchema.exclude(["infrastructure", "configuration"]);
export type ArtifactClass = z.infer<typeof ArtifactClassSchema>;

/** WHAT KIND OF REPOSITORY A BUILT ARTIFACT IS PUBLISHED INTO (M28.1, ADR-0053).
 *
 *  The destination half of the artifact class. A registry is an `execution-system` reached by a
 *  `publishes_to` edge, and its `properties.kind` already names the PRODUCT (`gitea`, `harbor`) —
 *  which cannot answer this, because one product serves several formats: ADR-0012 makes Gitea the
 *  unified registry for OCI images AND rpm AND npm. So the formats a registry serves are their own
 *  declared data, `properties.packageFormats`, and this is the closed set SCP can derive a
 *  destination for. A format outside it is still storable on a registry; it just never matches. */
export const PackageFormatSchema = z.enum(["oci", "rpm"]);
export type PackageFormat = z.infer<typeof PackageFormatSchema>;

/** What a registry that declares no `packageFormats` serves. Every registry that existed before
 *  M28.1 was a container registry, so this default is what lets them keep working untouched. */
export const DEFAULT_REGISTRY_PACKAGE_FORMATS: readonly PackageFormat[] = ["oci"];

/** Type → the destination format its build publishes into (ADR-0053's table).
 *
 *  `null` means SCP has NO destination class for that Type yet: it derives no destination
 *  parameters for it and does not consult the registry at all. That is deliberately not a guess in
 *  either direction — handing an npm build an OCI `host/repository` was the defect, and refusing
 *  one because its registry is "wrong" would claim knowledge of a format SCP does not model.
 *  `chart` is `null` rather than `oci` because `helm push` addresses a registry NAMESPACE and takes
 *  the repository from Chart.yaml, so the `host/repository` SCP assembles for images is not its
 *  input. `vm-image` publishes to an image store (ADR-0049), never an OCI registry. */
export const DESTINATION_FORMAT_OF_TYPE: Record<ArtifactClass, PackageFormat | null> = {
  image: "oci",
  rpm: "rpm",
  deb: null,
  npm: null,
  maven: null,
  python: null,
  go: null,
  chart: null,
  "vm-image": null
};

/** Which LANE a binding serves.
 *
 *  DEFINED HERE, not in `binding-policy.ts`, although the policy effect is its other consumer:
 *  `binding-policy.ts` already imports `ExecutorTypeSchema` from this module, so defining the lane
 *  there and importing it back created a CYCLE — and a cycle between two Zod modules does not fail
 *  at import, it leaves the const `undefined` at initialisation. It surfaced as
 *  "Cannot access 'ExecutorTypeSchema' before initialization" from `openapi-emit`, which was the
 *  lucky version; the documented failure mode is a schema that silently validates nothing.
 *  `binding-policy.ts` re-exports it, so every existing importer is unaffected. */
export const ExecutorLaneSchema = z.enum(["build", "test"]);
export type ExecutorLane = z.infer<typeof ExecutorLaneSchema>;

/** The executor **Category**. See docs/schemas.md §184. */
export const ExecutorCategorySchema = z.enum(["build", "infrastructure", "configuration"]);
export type ExecutorCategory = z.infer<typeof ExecutorCategorySchema>;

/** The operator's DECLARED classification of a pipeline. See docs/schemas.md §185. */
export const PipelineClassificationSchema = z.enum(["dev", "beta"]);
export type PipelineClassification = z.infer<typeof PipelineClassificationSchema>;

/** Parse a stored `classification` value, total over anything the column can hold. A value outside
 *  the closed enum (only reachable from a pre-Zod or version-skewed row, never from a validated
 *  input) reads back as `null` — an unrecognised label must degrade to "unclassified", never crash a
 *  routing or list path, and never be mistaken for a recognised one. */
export function parsePipelineClassification(value: string | null): PipelineClassification | null {
  const parsed = PipelineClassificationSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** The DECLARED reach of a source mapping's repo. See docs/schemas.md §186. */
export const SourceMappingScopeSchema = z.enum(["global", "domain"]);
export type SourceMappingScope = z.infer<typeof SourceMappingScopeSchema>;

/** Parse a stored `scope` value, total over anything the column can hold — same shape and reason
 *  as `parsePipelineClassification`: an unrecognised value reads back as `null` (undeclared), never
 *  crashes a list path and is never mistaken for a recognised scope. */
export function parseSourceMappingScope(value: string | null): SourceMappingScope | null {
  const parsed = SourceMappingScopeSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** WHICH RELEASE PATH a change from this source takes — the JOURNEY discriminator (journey-view
 *  §8.14, owner decision 2026-09-14 option ii). Named after the journey node a change ENTERS at, in
 *  the order the GLOSSARY defines: `source` enters at the source-code node and runs the whole spine
 *  (source → build → scan/sign → registry → config → waves); `config` enters at the config node and
 *  goes straight to the waves. A third path would name a third node rather than invent a word.
 *
 *  THIS IS NOT A ROUTING KEY, and keeping it out of routing is the entire reason it exists. ADR-0007's
 *  `type` already answers "which executor pipeline rolls this", and `source_mappings.type` was doing
 *  BOTH jobs — which is why typing a service repo `image` to describe its journey made every release
 *  from it resolve a `build` binding that does not exist and terminalise `no_executor` (measured,
 *  §8.14). A journey kind must never reach `resolveBindingForTarget`, `plan-service` wave-target
 *  compilation, or any admission gate; it is a declared label for the view, the genus of
 *  `classification`/`scope`/`mirrorOfShared`. */
export const JourneyKindSchema = z.enum(["source", "config"]);
export type JourneyKind = z.infer<typeof JourneyKindSchema>;

/** Parse a stored/carried `journeyKind`, total over anything the column or a change's `properties`
 *  can hold — same shape and reason as `parsePipelineClassification`. Deliberately UNLIKE
 *  `typeOf` (`changes-repo.ts`), which THROWS on an unrecognised Type because guessing a pipeline
 *  would route a release somewhere nobody asked for: an unrecognised journey kind costs a label on a
 *  tile, so it degrades to `null` (undeclared) and never breaks a read path. */
export function parseJourneyKind(value: unknown): JourneyKind | null {
  const parsed = JourneyKindSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Static Type → Category map (ADR-0007). Every Type belongs to exactly one Category, so Category
 *  needs no column — it is a projection of Type. The single source of truth for the derivation. */
export const CATEGORY_OF_TYPE: Record<ExecutorType, ExecutorCategory> = {
  image: "build",
  rpm: "build",
  deb: "build",
  npm: "build",
  maven: "build",
  python: "build",
  go: "build",
  chart: "build",
  "vm-image": "build",
  infrastructure: "infrastructure",
  configuration: "configuration"
};

/** Derive a Type's Category (ADR-0007). Total over the closed Type enum; a value outside it (only
 *  reachable from legacy/version-skewed jsonb, never from a Zod-validated input) maps to the
 *  `configuration` default so a derived read-only field can never crash a list/read path. */
export function categoryOfType(type: ExecutorType | string): ExecutorCategory {
  return CATEGORY_OF_TYPE[type as ExecutorType] ?? "configuration";
}

export const CreateExecutorBindingRequestSchema = z
  .object({
    /** Inline binding: the plugin module + a stable instance id. Optional because an
     *  execution-system-backed binding derives both from the referenced `execution-system` object. */
    pluginModule: z.string().min(1).optional(),
    pluginInstanceId: z.string().min(1).optional(),
    config: z.record(z.string(), z.unknown()).optional(),
    /** `{ configFieldName: secretKey }` — `secretKey` must already exist (`PUT /secrets/{key}`);
     *  the plaintext value is resolved server-side and never appears in this request/response. */
    secretRefs: z.record(z.string(), z.string()).optional(),
    /** Egress allowlist (hostnames) for this instance's `ctx.http` — empty/omitted means the
     *  plugin's own manifest defaults apply. */
    allowedHosts: z.array(z.string()).optional(),
    /** The executor-specific target identifier this object maps to (e.g. an Argo CD Application
     *  name), passed as `trigger().targetRef`. Omitted ⇒ reconcile uses the object id (legacy). */
    externalRef: z.string().min(1).optional(),
    /** Reference (id or URN) to a registered `execution-system` graph object (Mode A). When set, the
     *  plugin module, serverUrl, and token are resolved FROM that object — omit pluginModule/config. */
    executionSystemId: z.string().min(1).optional(),
    /** WHICH pipeline this binding drives — the routing Type (ADR-0007). A target may hold one
     *  binding per Type (e.g. a `configuration` sync AND an `image` build AND an `infrastructure`
     *  apply), so this is what distinguishes them. Omitted ⇒ 'configuration' (the server default). */
    type: ExecutorTypeSchema.optional(),
    /** Which LANE this binding serves (ADR-0007 sits beside it: Type says which pipeline, lane says
     *  which arm of it). Absent ⇒ `build`, which is what every caller got before this was
     *  accepted — `executor_bindings` is keyed `(org, target, type, lane)` with a `build` column
     *  default. The DELETE door already took `?lane=`, precisely because the binding-policy
     *  reconciler writes `test` rows; until this was added they could be deleted through the API
     *  but never CREATED through it, so a test-lane binding was reachable only by authoring a
     *  policy. */
    lane: ExecutorLaneSchema.optional()
  })
  .refine(
    (b) => (b.executionSystemId ? !b.pluginModule : Boolean(b.pluginModule && b.pluginInstanceId)),
    {
      message:
        "provide EITHER executionSystemId (execution-system-backed) OR pluginModule + pluginInstanceId (inline) — not both, and not neither"
    }
  );
export type CreateExecutorBindingRequest = z.infer<typeof CreateExecutorBindingRequestSchema>;

export const ExecutorBindingSchema = z.object({
  id: z.string().uuid(),
  targetObjectId: z.string().uuid(),
  type: ExecutorTypeSchema,
  /** DERIVED, read-only (ADR-0007): the Category of `type`, computed via `categoryOfType`. Not an
   *  input, not stored — a projection returned so a gate/UI can group by Category without the map. */
  category: ExecutorCategorySchema,
  pluginModule: z.string(),
  pluginInstanceId: z.string(),
  config: z.unknown(),
  secretRefs: z.record(z.string(), z.string()),
  allowedHosts: z.array(z.string()),
  externalRef: z.string().nullable(),
  executionSystemId: z.string().nullable()
});
export type ExecutorBinding = z.infer<typeof ExecutorBindingSchema>;

/** All of a target's bindings (M12 P5c) — a target holds at most one per Type, so no pagination. */
export const ExecutorBindingListResponseSchema = z.object({
  items: z.array(ExecutorBindingSchema)
});
export type ExecutorBindingListResponse = z.infer<typeof ExecutorBindingListResponseSchema>;

/** Body for `PATCH /executors/{idOrUrn}/binding` (M12 P5c) — relabel the binding named by the
 *  `?type=` query (its CURRENT Type) to this NEW `type`. */
export const RepurposeExecutorBindingRequestSchema = z.object({
  type: ExecutorTypeSchema
});
export type RepurposeExecutorBindingRequest = z.infer<typeof RepurposeExecutorBindingRequestSchema>;

// Scanner-assignment registry (ADR-0020 §2, proposal §13.3, M13.3a). See docs/schemas.md §187.

/** One Type's scanner assignment — the API projection of a `scanner_assignments` row. `methods` is
 *  the set of managed scan methods the promotion scan step runs for this Type (possibly empty). */
export const ScannerAssignmentSchema = z.object({
  executorType: ExecutorTypeSchema,
  methods: z.array(ScanMethodSchema),
  updatedAt: z.string()
});
export type ScannerAssignment = z.infer<typeof ScannerAssignmentSchema>;

export const ScannerAssignmentListResponseSchema = z.object({
  items: z.array(ScannerAssignmentSchema)
});
export type ScannerAssignmentListResponse = z.infer<typeof ScannerAssignmentListResponseSchema>;

/** Operator-authored write body for `PUT /instance/scanner-assignments`. `executorType` MUST be in
 *  the closed `ExecutorType` set (Zod-validated, not a pg enum — mirrors `executor_bindings.type`);
 *  `methods` MUST be valid `ScanMethod`s (duplicates are de-duplicated server-side). An empty
 *  `methods` explicitly clears the assignment (that Type produces no managed evidence — fail-closed). */
export const PutScannerAssignmentRequestSchema = z.object({
  executorType: ExecutorTypeSchema,
  methods: z.array(ScanMethodSchema)
});
export type PutScannerAssignmentRequest = z.infer<typeof PutScannerAssignmentRequestSchema>;

// Multi-region Argo CD. See docs/schemas.md §188.

/** The executor module a region's binding is EXPECTED to resolve to for this milestone — Argo CD
 *  (GitOps `configuration` sync). Kept as a named constant so the surface, the validator, and the
 *  docs share one definition of "regional Argo CD". */
export const REGIONAL_EXECUTOR_EXPECTED_MODULE = "argocd" as const;

/** Path param for the regional-executor view — the prod environment's name (the value each region
 *  deployment-target carries under `properties.environment`). */
export const RegionalExecutorEnvParamSchema = z.object({
  environment: z.string().min(1)
});
export type RegionalExecutorEnvParam = z.infer<typeof RegionalExecutorEnvParamSchema>;

/** One region's slot in the view: the region deployment-target and whether it has an Argo CD
 *  binding of the requested Type. `isExpectedModule` is the per-region validity signal (bound AND
 *  the binding resolves to `argocd`). */
export const RegionalExecutorEntrySchema = z.object({
  region: z.string(),
  targetId: z.string().uuid(),
  targetName: z.string(),
  /** True iff a binding of the requested Type exists for this region target. */
  bound: z.boolean(),
  /** The module the binding resolves to (the execution-system's `kind`, or an inline module), or
   *  null when unbound. */
  pluginModule: z.string().nullable(),
  /** True iff `bound` AND `pluginModule === "argocd"` — the per-region pass signal. */
  isExpectedModule: z.boolean(),
  /** The imported/coordinated Argo CD execution-system backing this region, when system-backed. */
  executionSystemId: z.string().nullable(),
  externalRef: z.string().nullable()
});
export type RegionalExecutorEntry = z.infer<typeof RegionalExecutorEntrySchema>;

/** The coherent `prod env -> {region -> argocd binding}` view + validation verdict (M15.6). */
export const RegionalExecutorViewSchema = z.object({
  environment: z.string(),
  /** The binding Type resolved for each region (default `configuration` — Argo CD is GitOps sync). */
  type: ExecutorTypeSchema,
  /** The module each region is expected to be bound to — `argocd`. */
  expectedModule: z.literal(REGIONAL_EXECUTOR_EXPECTED_MODULE),
  regions: z.array(RegionalExecutorEntrySchema),
  /** True when every region has its own binding of that Type. See docs/schemas.md §189. */
  valid: z.boolean(),
  problems: z.array(z.string())
});
export type RegionalExecutorView = z.infer<typeof RegionalExecutorViewSchema>;

// Notification bindings (DESIGN §11 NotificationPlugin — an org's configured channels).

export const NotificationSeveritySchema = z.enum(["info", "warning", "critical"]);
export type NotificationSeverity = z.infer<typeof NotificationSeveritySchema>;

export const CreateNotificationBindingRequestSchema = z.object({
  pluginModule: z.string().min(1),
  config: z.record(z.string(), z.unknown()).optional(),
  secretRefs: z.record(z.string(), z.string()).optional(),
  allowedHosts: z.array(z.string()).optional(),
  minSeverity: NotificationSeveritySchema.optional()
});
export type CreateNotificationBindingRequest = z.infer<
  typeof CreateNotificationBindingRequestSchema
>;

export const NotificationBindingSchema = z.object({
  id: z.string().uuid(),
  pluginModule: z.string(),
  pluginInstanceId: z.string(),
  config: z.unknown(),
  secretRefs: z.record(z.string(), z.string()),
  allowedHosts: z.array(z.string()),
  minSeverity: NotificationSeveritySchema
});
export type NotificationBinding = z.infer<typeof NotificationBindingSchema>;
export const NotificationBindingListResponseSchema =
  cursorPageResponseSchema(NotificationBindingSchema);
export type NotificationBindingListResponse = z.infer<typeof NotificationBindingListResponseSchema>;

// Secrets (write-only — a value is never readable back through the API once stored).

export const PutSecretRequestSchema = z.object({ value: z.string().min(1) });
export type PutSecretRequest = z.infer<typeof PutSecretRequestSchema>;

export const SecretKeyParamSchema = z.object({ key: z.string().min(1) });

/** Notification bindings are keyed by a caller-chosen `pluginInstanceId`, not a graph object —
 *  distinct from `RegistryIdOrUrnParamSchema` (registries.ts) on purpose. */
export const NotificationInstanceParamSchema = z.object({ instanceId: z.string().min(1) });

export const SecretConfiguredResponseSchema = z.object({
  configured: z.literal(true),
  key: z.string()
});
export type SecretConfiguredResponse = z.infer<typeof SecretConfiguredResponseSchema>;

export const SecretKeyListResponseSchema = z.object({ keys: z.array(z.string()) });
export type SecretKeyListResponse = z.infer<typeof SecretKeyListResponseSchema>;

// Plugin manifests, so config schemas surface as forms. See docs/schemas.md §190.

export const PluginKindSchema = z.enum([
  "executor",
  "control",
  "identity",
  "notification",
  "federation-transport",
  "discovery"
]);
export type PluginKind = z.infer<typeof PluginKindSchema>;

export const PluginManifestSchema = z.object({
  id: z.string(),
  kind: PluginKindSchema,
  version: z.string(),
  configSchema: z.record(z.string(), z.unknown()),
  requiredCapabilities: z.array(z.string()).optional()
});
export type PluginManifest = z.infer<typeof PluginManifestSchema>;

export const PluginManifestListResponseSchema = z.object({ items: z.array(PluginManifestSchema) });
export type PluginManifestListResponse = z.infer<typeof PluginManifestListResponseSchema>;

// Discovery: proposed objects and relationships, reviewed. See docs/schemas.md §191.

export const DiscoveryProposalObjectSchema = z.object({
  typeId: z.string(),
  name: z.string(),
  properties: z.record(z.string(), z.unknown()).optional(),
  /** The proposal-local name this object is referenced by. See docs/schemas.md §192. */
  urn: z.string().min(1).optional()
});
export const DiscoveryProposalRelationshipSchema = z.object({
  typeId: z.string(),
  /** Either a pre-existing object's real id/URN, or the `urn` alias a proposed object declares. */
  fromUrn: z.string(),
  toUrn: z.string()
});
/** A proposed executor binding (M12 P3b) — so `discovery accept` can wire an imported object to an
 *  execution-system in the same step, not just create the object. `objectName` references a proposed
 *  object BY NAME (resolved to its freshly-created id at accept, alongside the object's own creation). */
export const DiscoveryProposalBindingSchema = z.object({
  objectName: z.string().min(1),
  executionSystemId: z.string().min(1),
  externalRef: z.string().min(1).optional()
});

/** A `source_mapping` to create alongside an imported object. See docs/schemas.md §193. */
export const DiscoveryProposalSourceMappingSchema = z.object({
  objectName: z.string().min(1),
  sourceKind: z.string().min(1),
  repoPattern: z.string().min(1).optional(),
  pathPattern: z.string().min(1).optional(),
  type: ExecutorTypeSchema.optional()
});
export const DiscoveryProposalSchema = z.object({
  objects: z.array(DiscoveryProposalObjectSchema),
  relationships: z.array(DiscoveryProposalRelationshipSchema),
  /** Optional executor bindings to create alongside the objects (import → coordinate in one accept). */
  bindings: z.array(DiscoveryProposalBindingSchema).optional(),
  /** Optional source_mappings to create alongside the objects (M12 P5, Q3) — so imports self-report. */
  sourceMappings: z.array(DiscoveryProposalSourceMappingSchema).optional()
});
export type DiscoveryProposal = z.infer<typeof DiscoveryProposalSchema>;

export const RunDiscoveryRequestSchema = z.object({
  pluginModule: z.string().min(1),
  pluginInstanceId: z.string().min(1),
  config: z.record(z.string(), z.unknown()).optional(),
  secretRefs: z.record(z.string(), z.string()).optional(),
  allowedHosts: z.array(z.string()).optional()
});
export type RunDiscoveryRequest = z.infer<typeof RunDiscoveryRequestSchema>;

/** `POST /discovery/scaffold` (ADR-0047). See docs/schemas.md §194. */
export const ScaffoldDiscoveryRequestSchema = z.object({
  proposal: DiscoveryProposalSchema,
  /** component name -> service name. A component absent from this map is UNGROUPED and is reported
   *  rather than emitted — ADR-0047's rule, applied server-side so the CLI and the wizard cannot
   *  disagree about what "ungrouped" means. */
  group: z.record(z.string(), z.string().min(1))
});
export type ScaffoldDiscoveryRequest = z.infer<typeof ScaffoldDiscoveryRequestSchema>;

export const ScaffoldDiscoveryResponseSchema = z.object({
  stacks: z.array(
    z.object({
      stackName: z.string(),
      serviceName: z.string(),
      source: z.string(),
      /** How many `repo` placeholders the author must fill before this will typecheck (D18). */
      placeholderCount: z.number().int()
    })
  ),
  ungrouped: z.array(z.object({ name: z.string(), typeId: z.string() }))
});
export type ScaffoldDiscoveryResponse = z.infer<typeof ScaffoldDiscoveryResponseSchema>;

// `POST /discovery/accept` AND ITS TWO SCHEMAS ARE GONE. See docs/schemas.md §195.

// That backfill route and its two schemas are gone. See docs/schemas.md §196.

// `scp change-source report`. See docs/schemas.md §197.

/** Strict, so unknown properties are refused on the wire. See docs/schemas.md §198. */
export const ChangeReportRequestSchema = z.strictObject({
  repo: z.string().optional(),
  path: z.string().optional(),
  /** Correlation hint: the fully-qualified git ref. See docs/schemas.md §199. */
  ref: z.string().optional(),
  correlationKey: z.string().optional(),
  workspace: z.string().optional(),
  artifactDigest: z.string().optional(),
  /** The built commit this release came from, not a ref. See docs/schemas.md §200. */
  commitSha: z.string().optional(),
  status: z.enum(["planned", "applied", "errored", "discarded"]),
  planJson: z.unknown().optional(),
  /** M12 P4B coupled pipelines — the SAME shape as `CreateChangeRequestSchema.provides`: opaque
   *  keys this release makes true at its targets when it succeeds. This is THE declaration channel
   *  for a CI pipeline (a raw provider push webhook cannot carry a key — coupled-pipelines.md §6#1);
   *  threaded by `webhook-processor.ts` into `proposeChange` identically to `POST /changes`. */
  provides: z.array(z.string().min(1)).optional(),
  /** The same shape as a change's own prerequisite list. See docs/schemas.md §201. */
  requires: z.array(ChangeRequirementSchema).optional(),
  /** ADR-0028 stage-scoped component coupling. See docs/schemas.md §202. */
  stageDependencies: z.array(StageDependencySchema).optional(),
  /** M17.2 — a REFERENCE to the build-time SBOM the executor's coordinated Trivy pass emitted and
   *  cosign-signed at origin (ADR-0015 §5). OPTIONAL and purely ADDITIVE: every existing reporter
   *  keeps working unchanged. SCP stores the reference on the change's `sourceRef.sbom` and NEVER
   *  the document bytes — it neither generates nor signs an SBOM (charter: coordinate, not execute). */
  sbom: SbomRefSchema.optional(),
  /** D23 (team-pipeline-iac increment 8). See docs/schemas.md §203. */
  testBundle: TestBundleRefSchema.optional(),
  /** D13 (team-pipeline-iac increment 8). See docs/schemas.md §204. */
  artifactClass: ArtifactClassSchema.optional()
});
export type ChangeReportRequest = z.infer<typeof ChangeReportRequestSchema>;
