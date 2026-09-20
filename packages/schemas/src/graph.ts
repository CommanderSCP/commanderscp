import { z } from "zod";
import { cursorPageResponseSchema, stringArrayQueryParam } from "./common.js";
// No cycle: neither module imports graph.ts (executors.ts -> common/supply-chain,
// binding-policy.ts -> executors.ts). Reused rather than re-declared so the integrity report and the
// binding door can never disagree about what a Type or a lane is.
import { ExecutorTypeSchema } from "./executors.js";
import { ExecutorLaneSchema } from "./binding-policy.js";
// Same no-cycle argument: `governance-move.ts` imports zod and nothing else. Reused so the integrity
// report and the rung doors can never disagree about what a tier is.
import { GovernanceMoveTierSchema } from "./governance-move.js";

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
 *  is soft-deleted. Neither table carries a foreign key to `objects`, which is why these persist.
 *
 *  `repairable`/`blockedReason` are declared ONCE here, not once per kind, so every arm of the
 *  integrity report answers "would `--repair` act on this?" the same way — a non-CLI consumer of
 *  `GET /graph/integrity` used to have to reimplement `orphanExecutorBindings`' rule
 *  (`!policyManaged`) itself, since the server only carried `policyManaged` and left the CLI to
 *  compute `repairable` client-side (the fix `OrphanPlacementSchema` already applied for the
 *  placement arm — see its own doc comment — generalized here to the base every kind shares). */
export const OrphanProjectionRowSchema = z.object({
  id: z.string().uuid(),
  ownerUrn: UrnSchema,
  ownerName: z.string(),
  detail: z.string(),
  /** FALSE when the row's own delete door would refuse it, OR — for a mapping — when there is no
   *  id-addressed door at all. See `blockedReason`. */
  repairable: z.boolean(),
  /** Why not, in the operator's own vocabulary and (where one exists) naming the command that
   *  unblocks it; null when `repairable` is true. Nullable rather than absent so a client never has
   *  to branch on presence. */
  blockedReason: z.string().nullable()
});
export type OrphanProjectionRow = z.infer<typeof OrphanProjectionRowSchema>;

/** THE ONE PROJECTION ROW A REPAIR RUN CAN ACT ON. See docs/schemas.md §296a. */
export const OrphanExecutorBindingRowSchema = OrphanProjectionRowSchema.extend({
  /** The binding's routing Type and LANE — the two halves, beside `ownerUrn`, of what
   *  `DELETE /executors/{idOrUrn}/binding` is keyed by. Structured rather than left inside `detail`
   *  because `--repair` has to pass them: parsing them back out of a display string is the
   *  read-the-label-you-printed mistake, and a `lane` recovered wrongly silently means `build`. */
  targetType: ExecutorTypeSchema,
  lane: ExecutorLaneSchema,
  /** TRUE when `managed_by_policy_id` is set. Such a row is re-derived from the live placements
   *  every reconcile tick and pruned by `pruneUnwanted` once its target is a tombstone, so a repair
   *  run must SKIP it and say so — the same reason `DanglingRelationship.repairable` is false for a
   *  replica edge. Read off the column, never inferred from the plugin or the detail text. Kept
   *  alongside the inherited `repairable` (which is simply `!policyManaged` for this arm) because
   *  `--repair`'s skip message names the reconciler, not just "false". */
  policyManaged: z.boolean()
});
export type OrphanExecutorBindingRow = z.infer<typeof OrphanExecutorBindingRowSchema>;

/** A PLACEMENT is not a projection row, and conflating the two made the report lie. See
 *  docs/schemas.md §296b.
 *
 *  A placement is a graph OBJECT: it has its own id, its own URN, its own `origin_domain_id` and its
 *  own `managed_by_stack`, and it is removed at `DELETE /api/v1/placements/{idOrUrn}` — which the
 *  other two arms have no equivalent of, since a mapping and a binding are addressed through their
 *  OWNER. Reporting it through `OrphanProjectionRowSchema` therefore dropped the three facts that
 *  decide whether a repair run may touch it, and the CLI filled the gap by hardcoding
 *  `repairable: true` for every row — false for a replica (single-writer authority refuses the
 *  delete), false while an executor binding still names it (orphan-guard route 6 refuses), and
 *  unwanted for a stack-managed row (the IaC apply prune is its reaper). Same rule the edge arm has
 *  carried since it was written: a row must never be offered as actionable if its door would refuse
 *  it. `repairable`/`blockedReason` now live on the shared base (`OrphanProjectionRowSchema`); this
 *  extends it with only the field that IS placement-specific. */
export const OrphanPlacementSchema = OrphanProjectionRowSchema.extend({
  /** WHICH end died. `malformed` means the row does not name two resolvable object ids at all —
   *  reported rather than skipped, because a row nothing can explain is the one worth seeing. */
  deadEnd: z.enum(["component", "deployment-target", "both", "malformed"])
});
export type OrphanPlacement = z.infer<typeof OrphanPlacementSchema>;

/** A `governance_move_rungs` row whose subject container is soft-deleted. See docs/schemas.md §296d.
 *
 *  `id` IS `ownerUrn`'s object id, not a separate row id: this table's primary key is
 *  `subject_object_id` alone (drizzle/0083), so the row's identity and its owner's identity are the
 *  same uuid. Carried through the shared base anyway rather than given a bespoke shape, because
 *  every consumer of this report reads `id`/`ownerUrn`/`repairable`/`blockedReason` uniformly and a
 *  fourth row shape would be one more thing to special-case for no gain. */
export const OrphanGovernanceMoveRungSchema = OrphanProjectionRowSchema.extend({
  /** The stored tier literal, never recomputed from the subject's current type — the same rule
   *  `move-enforcement.ts`'s `toRung` follows, and for the same reason: an operator matching this
   *  row against `scp governance move-enforcement rungs` is matching on what was written. */
  tier: GovernanceMoveTierSchema
});
export type OrphanGovernanceMoveRung = z.infer<typeof OrphanGovernanceMoveRungSchema>;

/** Rows that outlived the object they hang off. See docs/schemas.md §296. */
export const GraphIntegrityReportSchema = z.object({
  danglingRelationships: z.array(DanglingRelationshipSchema),
  orphanSourceMappings: z.array(OrphanProjectionRowSchema),
  // Two members carry a richer row type than `OrphanProjectionRow`, and for DIFFERENT reasons.
  // A binding's is the (type, lane) its door is keyed by plus the policy-managed flag `--repair`
  // must skip on (owner decision 2026-09-19). A placement's is the three facts that decide whether
  // its OWN door would refuse — it is a graph object, not a projection row (§296b). Only
  // `orphanSourceMappings` stays plain: a mapping is addressed by a five-part tuple this report does
  // not carry, so it is the one arm a repair run genuinely cannot reach.
  orphanExecutorBindings: z.array(OrphanExecutorBindingRowSchema),
  orphanPlacements: z.array(OrphanPlacementSchema),
  /** The FOURTH kind, added 2026-09-19 (§296d). `governance_move_rungs` was recorded in
   *  docs/graph.md §125b as one of eight tables with "no `.delete(...)` statement anywhere" — a
   *  census keyed on the drizzle identifier, which missed `move-enforcement.ts`'s raw
   *  `DELETE FROM governance_move_rungs`. It has an HTTP door, a CLI verb and an IaC apply prune, so
   *  it is the one member of that list that can be both guarded and repaired. */
  orphanGovernanceMoveRungs: z.array(OrphanGovernanceMoveRungSchema)
});
export type GraphIntegrityReport = z.infer<typeof GraphIntegrityReportSchema>;
