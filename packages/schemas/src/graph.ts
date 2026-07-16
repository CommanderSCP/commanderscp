import { z } from "zod";
import { cursorPageResponseSchema, stringArrayQueryParam } from "./common.js";

/**
 * Full graph model contract (DESIGN.md §4.1). Supersedes M0's single-purpose `ServiceObject`
 * shape with the generic object/relationship model shared by every registry type — built-in or
 * org-defined via the runtime type registry (§4.1 "custom types are data, not DDL").
 */

const URN_RE = /^urn:scp:[a-z0-9-]+:[a-z0-9_-]+:[a-zA-Z0-9._~:/-]+$/;

export const UrnSchema = z.string().regex(URN_RE, "must match urn:scp:{org}:{type}:{slug-path}");

export const JsonRecordSchema = z.record(z.string(), z.unknown());

/** JSON Schema document (Ajv validates instance `properties` against this at write time). */
export const JsonSchemaDocSchema = z.record(z.string(), z.unknown());

export const CardinalitySchema = z.enum(["one_to_one", "one_to_many", "many_to_many"]);
export type Cardinality = z.infer<typeof CardinalitySchema>;

// ---------------------------------------------------------------------------------------------
// Type registry
// ---------------------------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------------------------
// Objects
// ---------------------------------------------------------------------------------------------

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
  domainId: z.string().uuid().nullable().optional(),
  properties: JsonRecordSchema.optional(),
  labels: JsonRecordSchema.optional()
});
export type CreateObjectRequest = z.infer<typeof CreateObjectRequestSchema>;

/**
 * Strict component create (M12 P5a): a component created DIRECTLY must name the service it belongs
 * to — the object and its `service --contains--> component` edge are written in one transaction.
 * The generic object fields plus a REQUIRED `service` (id or URN). Imports (discovery/federation/
 * overlay) do NOT use this path and stay permissive; see docs/proposals/organize-after.md.
 */
export const CreateComponentRequestSchema = CreateObjectRequestSchema.extend({
  /** id or URN of the service this component belongs to (the `contains` parent). Required. */
  service: z.string().min(1)
});
export type CreateComponentRequest = z.infer<typeof CreateComponentRequestSchema>;


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
  labels: JsonRecordSchema.optional()
});
export type UpsertObjectRequest = z.infer<typeof UpsertObjectRequestSchema>;

/**
 * Strict upsert-by-URN for a component (M12 P5a). `service` is REQUIRED when the URN is new (the
 * create branch honours the same "a component must belong to a service" invariant as POST) and
 * OPTIONAL when it already exists (an update is field-only; re-assignment is the P5b move verb). The
 * route enforces the create-branch requirement — the schema leaves it optional so a plain rename of
 * an existing (possibly still-unassigned, imported) component needs no service.
 */
export const UpsertComponentRequestSchema = UpsertObjectRequestSchema.extend({
  service: z.string().min(1).optional()
});
export type UpsertComponentRequest = z.infer<typeof UpsertComponentRequestSchema>;

/**
 * `PUT /components/{idOrUrn}/service` — idempotent atomic assign-or-move (M12 P5b). Sets the
 * component's sole `contains` parent to `service` whether it currently has none (assign), a
 * different one (atomic move), or the same one (no-op).
 */
export const SetComponentServiceRequestSchema = z.object({
  /** id or URN of the service the component should belong to. */
  service: z.string().min(1)
});
export type SetComponentServiceRequest = z.infer<typeof SetComponentServiceRequestSchema>;

/**
 * `POST /components/{idOrUrn}/merge` — driving-case merge (M12 P5d). Folds `loser` into the path
 * component (the survivor): the loser's executor bindings move onto the survivor and the loser is
 * soft-deleted. Scoped to a freshly-imported, binding-only loser (the argocd double-import case).
 */
export const MergeComponentsRequestSchema = z.object({
  /** id or URN of the component to merge INTO this one — it is soft-deleted after its bindings move. */
  loser: z.string().min(1)
});
export type MergeComponentsRequest = z.infer<typeof MergeComponentsRequestSchema>;

export const MergeComponentsResponseSchema = z.object({
  survivor: GraphObjectSchema,
  /** Purposes of the bindings moved from the loser onto the survivor. */
  movedBindingPurposes: z.array(z.string())
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

// ---------------------------------------------------------------------------------------------
// Relationships
// ---------------------------------------------------------------------------------------------

export const RelationshipSchema = z.object({
  id: z.string().uuid(),
  orgId: z.string().uuid(),
  typeId: z.string(),
  fromId: z.string().uuid(),
  toId: z.string().uuid(),
  properties: JsonRecordSchema,
  // M2 stage 3 addition (BUILD_AND_TEST.md §8 M2 item 4): mirrors `objects.labels` so IaC's
  // `scp:managed-by`/`scp:stack` pruning convention applies uniformly to relationships too
  // (apps/server/src/iac/plan-diff.ts) — additive, backward-compatible (DESIGN.md "additive-only
  // within v1"), defaults to `{}` for every relationship created before this milestone.
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

// ---------------------------------------------------------------------------------------------
// Named graph queries + generic traverse (DESIGN.md §5)
// ---------------------------------------------------------------------------------------------

export const NamedGraphQuerySchema = z.enum([
  "owners-of",
  "dependents-of",
  "consumers-of",
  "impact-of",
  "blast-radius",
  "paths-between",
  "domains-impacted",
  // M5 (DESIGN.md §5/§9.5): initiative roll-up status is "DERIVED BY TRAVERSAL... not
  // stored/duplicated state" — walks `coordinates` from an initiative to its member campaigns and
  // returns each as an object plus `status:<derived-status>` tallies in `counts` (the same
  // counts-by-tag shape `blast-radius`/`domains-impacted` already use), reusing
  // `coordination/campaign-status.ts`'s pure aggregation for each campaign's own status.
  "initiative-rollup"
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
  /** Populated by `blast-radius` (counts by type/domain) and `domains-impacted`. */
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
