import { z } from "zod";
import { cursorPageResponseSchema, stringArrayQueryParam } from "./common.js";

/** Full graph model contract. See docs/schemas.md §278. */

const URN_RE = /^urn:scp:[a-z0-9-]+:[a-z0-9_-]+:[a-zA-Z0-9._~:/-]+$/;

export const UrnSchema = z.string().regex(URN_RE, "must match urn:scp:{org}:{type}:{slug-path}");

export const JsonRecordSchema = z.record(z.string(), z.unknown());

/** JSON Schema document (Ajv validates instance `properties` against this at write time). */
export const JsonSchemaDocSchema = z.record(z.string(), z.unknown());

/** Which SIDE of an edge is singular. See docs/schemas.md §279. */
export const CardinalitySchema = z.enum([
  "one_to_one",
  "one_to_many",
  "many_to_one",
  "many_to_many"
]);
export type Cardinality = z.infer<typeof CardinalitySchema>;

export const ObjectTypeSchema = z.object({
  id: z.string().min(1).max(100),
  orgId: z.string().uuid().nullable(),
  displayName: z.string().min(1),
  propertySchema: JsonSchemaDocSchema.nullable(),
  isBuiltin: z.boolean(),
  createdAt: z.string().datetime()
});
export type ObjectType = z.infer<typeof ObjectTypeSchema>;

export const CreateObjectTypeRequestSchema = z.object({
  id: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[a-z][a-z0-9_-]*$/, "lowercase, digits, '-', '_' only, starting with a letter"),
  displayName: z.string().min(1),
  propertySchema: JsonSchemaDocSchema.optional()
});
export type CreateObjectTypeRequest = z.infer<typeof CreateObjectTypeRequestSchema>;

export const ObjectTypeListResponseSchema = cursorPageResponseSchema(ObjectTypeSchema);
export type ObjectTypeListResponse = z.infer<typeof ObjectTypeListResponseSchema>;

export const RelationshipTypeSchema = z.object({
  id: z.string().min(1).max(100),
  orgId: z.string().uuid().nullable(),
  displayName: z.string().min(1),
  propertySchema: JsonSchemaDocSchema.nullable(),
  fromTypes: z.array(z.string()).nullable(),
  toTypes: z.array(z.string()).nullable(),
  cardinality: CardinalitySchema,
  isBuiltin: z.boolean(),
  createdAt: z.string().datetime()
});
export type RelationshipType = z.infer<typeof RelationshipTypeSchema>;

export const CreateRelationshipTypeRequestSchema = z.object({
  id: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[a-z][a-z0-9_-]*$/, "lowercase, digits, '-', '_' only, starting with a letter"),
  displayName: z.string().min(1),
  propertySchema: JsonSchemaDocSchema.optional(),
  fromTypes: z.array(z.string()).optional(),
  toTypes: z.array(z.string()).optional(),
  cardinality: CardinalitySchema.default("many_to_many")
});
export type CreateRelationshipTypeRequest = z.infer<typeof CreateRelationshipTypeRequestSchema>;

export const RelationshipTypeListResponseSchema = cursorPageResponseSchema(RelationshipTypeSchema);
export type RelationshipTypeListResponse = z.infer<typeof RelationshipTypeListResponseSchema>;

export const GraphObjectSchema = z.object({
  id: z.string().uuid(),
  orgId: z.string().uuid(),
  domainId: z.string().uuid().nullable(),
  typeId: z.string(),
  name: z.string(),
  urn: z.string(),
  properties: JsonRecordSchema,
  labels: JsonRecordSchema,
  originDomainId: z.string().uuid(),
  revision: z.number().int(),
  // M6 (DESIGN.md §13): 'manual' = a hand-filled, unverified shadow copy of a commander-origin
  // object (`scp federation hand-fill`) awaiting reconciliation against a later signed bundle.
  // NULL = normal (either authored here, or a bundle-imported replica already confirmed by
  // signature verification).
  provenance: z.enum(["manual"]).nullable(),
  /** True when this object never leaves its security domain. See docs/schemas.md §280. */
  domainLocal: z.boolean(),
  /** Where this object's locality came from. See docs/schemas.md §281. */
  domainLocalInheritedFrom: z.object({ id: z.string().uuid(), urn: z.string() }).nullable(),
  version: z.number().int(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  deletedAt: z.string().datetime().nullable()
});
export type GraphObject = z.infer<typeof GraphObjectSchema>;

export const CreateObjectRequestSchema = z.object({
  id: z.string().uuid().optional(),
  urn: UrnSchema.optional(),
  name: z.string().min(1).max(500),
  /** The containment parent. See docs/schemas.md §282. */
  domainId: z
    .string()
    .uuid()
    .nullable()
    .optional()
    .describe(
      "Containment parent for the new object — an object id, not a URN. OMITTING IT DEFAULTS TO THE ORG ROOT. " +
        "The create is authorized with the type's write permission AT THE RESOLVED PARENT, and PATCH/DELETE later " +
        "re-check at the row's own id, so this field decides both where the row is placed and who may change it " +
        "afterwards. Authority expands strictly UPWARD from the scope object, so send the DEEPEST object you hold " +
        "write authority over: a narrowly-bound author who omits this is checked at the org root and refused with " +
        "\"lacks '<permission>' at scope '<org-root-uuid>'\" — a scope they never named, in a message that does not " +
        "mention this field. Worked example — a component team authoring a dependency subscription (ADR-0032 §8g) " +
        "sends THEIR OWN COMPONENT's id, which is accepted whether their policy:write sits at the component, at its " +
        "containment domain, or at the org root (sending the component's containment DOMAIN instead would work only " +
        'for the latter two): POST /api/v1/policies {"name":"deps-checkout-api","domainId":"<component-id>",' +
        '"properties":{"enforcement":"advisory","scope":{"objectRef":"<component-id>"},' +
        '"effects":[{"dependencySubscription":{"enabled":true}}]}}. The id appears twice because the two are ' +
        "different questions: domainId is CUSTODY (where the row lives, hence who may later edit or delete it), " +
        "scope.objectRef is JURISDICTION (what the policy reaches) — placement bounds reach not at all."
    ),
  properties: JsonRecordSchema.optional(),
  labels: JsonRecordSchema.optional(),
  /** Declare that this object never leaves its domain. See docs/schemas.md §283. */
  domainLocal: z.boolean().optional()
});
export type CreateObjectRequest = z.infer<typeof CreateObjectRequestSchema>;

/** Strict component create (M12 P5a). See docs/schemas.md §284. */
export const CreateComponentRequestSchema = CreateObjectRequestSchema.extend({
  /** id or URN of the service this component belongs to (the `contains` parent). Required. */
  service: z.string().min(1)
});
export type CreateComponentRequest = z.infer<typeof CreateComponentRequestSchema>;

/** The result of publishing a domain-local object. See docs/schemas.md §285. */
/** One swept edge, named well enough for an operator to act on it. See docs/schemas.md §286. */
export const SweptRelationshipSchema = z.object({
  id: z.string().uuid(),
  typeId: z.string(),
  /** The endpoint that is NOT the object being published. */
  otherEndpointId: z.string().uuid(),
  otherEndpointUrn: z.string(),
  otherEndpointName: z.string()
});
export type SweptRelationship = z.infer<typeof SweptRelationshipSchema>;

export const PublishObjectResponseSchema = z.object({
  object: GraphObjectSchema,
  /** Edges re-journaled alongside the object — their other endpoint already federates. */
  publishedRelationshipIds: z.array(z.string().uuid()),
  /** Edges deliberately left unpublished because their other endpoint is still domain-local. */
  withheldRelationshipIds: z.array(z.string().uuid()),
  /** The same two sets, described rather than merely identified. See docs/schemas.md §287. */
  publishedRelationships: z.array(SweptRelationshipSchema),
  withheldRelationships: z.array(SweptRelationshipSchema)
});
export type PublishObjectResponse = z.infer<typeof PublishObjectResponseSchema>;

export const UpdateObjectRequestSchema = z.object({
  name: z.string().min(1).max(500).optional(),
  domainId: z.string().uuid().nullable().optional(),
  properties: JsonRecordSchema.optional(),
  labels: JsonRecordSchema.optional(),
  version: z.number().int().positive().optional()
});
export type UpdateObjectRequest = z.infer<typeof UpdateObjectRequestSchema>;

/** `PUT /objects/{type}/{urn}` — idempotent upsert-by-URN (DESIGN.md §6). */
export const UpsertObjectRequestSchema = z.object({
  id: z.string().uuid().optional(),
  name: z.string().min(1).max(500),
  domainId: z.string().uuid().nullable().optional(),
  properties: JsonRecordSchema.optional(),
  labels: JsonRecordSchema.optional(),
  /** Accepted here, unlike on patch, so the declaration keeps. See docs/schemas.md §288. */
  domainLocal: z.boolean().optional()
});
export type UpsertObjectRequest = z.infer<typeof UpsertObjectRequestSchema>;

/** Strict upsert-by-URN for a component. See docs/schemas.md §289. */
export const UpsertComponentRequestSchema = UpsertObjectRequestSchema.extend({
  service: z.string().min(1).optional()
});
export type UpsertComponentRequest = z.infer<typeof UpsertComponentRequestSchema>;

/** Idempotent atomic assign-or-move of a component. See docs/schemas.md §290. */
export const SetComponentServiceRequestSchema = z.object({
  /** id or URN of the service the component should belong to. */
  service: z.string().min(1)
});
export type SetComponentServiceRequest = z.infer<typeof SetComponentServiceRequestSchema>;

/** `POST /components/{idOrUrn}/merge` — driving-case merge. See docs/schemas.md §291. */
export const MergeComponentsRequestSchema = z.object({
  /** id or URN of the component to merge INTO this one — it is soft-deleted after its bindings move. */
  loser: z.string().min(1)
});
export type MergeComponentsRequest = z.infer<typeof MergeComponentsRequestSchema>;

export const MergeComponentsResponseSchema = z.object({
  survivor: GraphObjectSchema,
  /** Types of the bindings moved from the loser onto the survivor (ADR-0007). */
  movedBindingTypes: z.array(z.string())
});
export type MergeComponentsResponse = z.infer<typeof MergeComponentsResponseSchema>;

export const ObjectListResponseSchema = cursorPageResponseSchema(GraphObjectSchema);
export type ObjectListResponse = z.infer<typeof ObjectListResponseSchema>;

export const ObjectTypeParamSchema = z.object({ type: z.string().min(1) });
export const ObjectIdOrUrnParamSchema = z.object({
  type: z.string().min(1),
  idOrUrn: z.string().min(1)
});
export const ObjectUrnParamSchema = z.object({ type: z.string().min(1), urn: z.string().min(1) });

export const ObjectListQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  domainId: z.string().uuid().optional(),
  includeDeleted: z.coerce.boolean().default(false)
});
export type ObjectListQuery = z.infer<typeof ObjectListQuerySchema>;

// Placements (ADR-0026 D2/D3/D14, post-import-configuration.md §3)

/** `POST /placements` — one component at one deployment target. See docs/schemas.md §292. */
export const CreatePlacementRequestSchema = z.strictObject({
  id: z.string().uuid().optional(),
  urn: UrnSchema.optional(),
  component: z.string().min(1),
  /** id or URN of the deployment-target it is placed at. */
  deploymentTarget: z.string().min(1),
  /** Defaults to `<component>@<deployment-target>` (ADR-0026 D3) when omitted. */
  name: z.string().min(1).max(500).optional(),
  domainId: z.string().uuid().nullable().optional(),
  labels: JsonRecordSchema.optional()
});
export type CreatePlacementRequest = z.infer<typeof CreatePlacementRequestSchema>;

/** `GET /placements` — the generic object list, plus the two pair filters that make it useful. */
export const PlacementListQuerySchema = ObjectListQuerySchema.extend({
  /** id or URN of a component — list only that component's placements. */
  component: z.string().min(1).optional(),
  /** id or URN of a deployment-target — list only the placements it holds. */
  deploymentTarget: z.string().min(1).optional(),
  /** Narrow the page to the containment subtree of ONE object. See docs/schemas.md §293. */
  scopeObjectId: z.string().uuid().optional()
});
export type PlacementListQuery = z.infer<typeof PlacementListQuerySchema>;

export const RelationshipSchema = z.object({
  id: z.string().uuid(),
  orgId: z.string().uuid(),
  typeId: z.string(),
  fromId: z.string().uuid(),
  toId: z.string().uuid(),
  properties: JsonRecordSchema,
  // M2 step 3 addition (BUILD_AND_TEST.md §8 M2 item 4). See docs/schemas.md §294.
  labels: JsonRecordSchema,
  originDomainId: z.string().uuid(),
  revision: z.number().int(),
  createdAt: z.string().datetime(),
  deletedAt: z.string().datetime().nullable()
});
export type Relationship = z.infer<typeof RelationshipSchema>;

export const CreateRelationshipRequestSchema = z.object({
  id: z.string().uuid().optional(),
  typeId: z.string().min(1),
  fromId: z.string().uuid(),
  toId: z.string().uuid(),
  properties: JsonRecordSchema.optional(),
  labels: JsonRecordSchema.optional()
});
export type CreateRelationshipRequest = z.infer<typeof CreateRelationshipRequestSchema>;

export const RelationshipListQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  fromId: z.string().uuid().optional(),
  toId: z.string().uuid().optional(),
  typeId: z.string().optional()
});
export type RelationshipListQuery = z.infer<typeof RelationshipListQuerySchema>;

export const RelationshipListResponseSchema = cursorPageResponseSchema(RelationshipSchema);
export type RelationshipListResponse = z.infer<typeof RelationshipListResponseSchema>;

export const RelationshipIdParamSchema = z.object({ id: z.string().uuid() });

// Named graph queries + generic traverse (DESIGN.md §5)

export const NamedGraphQuerySchema = z.enum([
  "owners-of",
  "dependents-of",
  "consumers-of",
  "impact-of",
  "blast-radius",
  "paths-between",
  "domains-impacted"
]);
export type NamedGraphQuery = z.infer<typeof NamedGraphQuerySchema>;

export const GraphQueryParamSchema = z.object({ name: NamedGraphQuerySchema });

export const GraphQueryRequestSchema = z.object({
  objectId: z.string().uuid(),
  /** Only used by `paths-between`. */
  targetId: z.string().uuid().optional(),
  relTypes: stringArrayQueryParam().optional(),
  maxDepth: z.coerce.number().int().min(1).max(10).default(10)
});
export type GraphQueryRequest = z.infer<typeof GraphQueryRequestSchema>;

export const GraphQueryResultSchema = z.object({
  query: NamedGraphQuerySchema,
  objects: z.array(GraphObjectSchema),
  counts: z.record(z.string(), z.number().int()).optional(),
  /** Populated by `paths-between`: ordered object ids per discovered path. */
  paths: z.array(z.array(z.string().uuid())).optional()
});
export type GraphQueryResult = z.infer<typeof GraphQueryResultSchema>;

export const TraverseRequestSchema = z.object({
  objectId: z.string().uuid(),
  direction: z.enum(["out", "in", "both"]).default("out"),
  relTypes: stringArrayQueryParam().optional(),
  maxDepth: z.coerce.number().int().min(1).max(10).default(3)
});
export type TraverseRequest = z.infer<typeof TraverseRequestSchema>;

export const TraverseEdgeSchema = z.object({
  id: z.string().uuid(),
  typeId: z.string(),
  fromId: z.string().uuid(),
  toId: z.string().uuid()
});

export const TraverseResultSchema = z.object({
  objects: z.array(GraphObjectSchema),
  edges: z.array(TraverseEdgeSchema)
});
export type TraverseResult = z.infer<typeof TraverseResultSchema>;

/** Induced-subgraph edges over an explicit object-id set. See docs/schemas.md §295. */
export const SubgraphRequestSchema = z.object({
  objectId: z.string().uuid(),
  ids: z.array(z.string().uuid()).min(1).max(2000)
});
export type SubgraphRequest = z.infer<typeof SubgraphRequestSchema>;

export const SubgraphResultSchema = z.object({
  edges: z.array(TraverseEdgeSchema)
});
export type SubgraphResult = z.infer<typeof SubgraphResultSchema>;

// Graph integrity (`GET /api/v1/graph/integrity`)

/** One live edge whose `from` and/or `to` object is soft-deleted. */
export const DanglingRelationshipSchema = z.object({
  id: z.string().uuid(),
  typeId: z.string(),
  deadEnd: z.enum(["from", "to", "both"]),
  fromUrn: UrnSchema,
  toUrn: UrnSchema,
  /** FALSE for a replica edge (`origin_domain_id != self`). `deleteRelationship` refuses those —
   *  single-writer authority — so a repair run must report and SKIP them, never attempt them. */
  repairable: z.boolean()
});
export type DanglingRelationship = z.infer<typeof DanglingRelationshipSchema>;

/** One projection row (`source_mappings` / `executor_bindings`) or placement whose owning object
 *  is soft-deleted. Neither table carries a foreign key to `objects`, which is why these persist. */
export const OrphanProjectionRowSchema = z.object({
  id: z.string().uuid(),
  ownerUrn: UrnSchema,
  ownerName: z.string(),
  detail: z.string()
});
export type OrphanProjectionRow = z.infer<typeof OrphanProjectionRowSchema>;

/** Rows that outlived the object they hang off. See docs/schemas.md §296. */
export const GraphIntegrityReportSchema = z.object({
  danglingRelationships: z.array(DanglingRelationshipSchema),
  orphanSourceMappings: z.array(OrphanProjectionRowSchema),
  orphanExecutorBindings: z.array(OrphanProjectionRowSchema),
  orphanPlacements: z.array(OrphanProjectionRowSchema)
});
export type GraphIntegrityReport = z.infer<typeof GraphIntegrityReportSchema>;
