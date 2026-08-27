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

/**
 * Which SIDE of an edge is singular. `one_to_many` makes the **to** side singular (one live
 * incoming edge of this type per `to_id`); `many_to_one` makes the **from** side singular (one live
 * outgoing edge per `from_id`); `one_to_one` makes both; `many_to_many` neither.
 *
 * `many_to_one` was added by ADR-0026 / post-import-configuration.md D11 for `releases_via`
 * (`component -> release-topology`: each component releases via at most one pipeline, each pipeline
 * serves many components). Before that it was ABSENT here and had no branch in
 * `assertCardinality` — so a hand-inserted `many_to_one` fell through every check and was silently
 * unenforced, which is why migration 0021 registered `contains` as the mirror instead. Every value
 * in this enum now has an enforcing branch, and `assertCardinality` FAILS CLOSED on any value that
 * does not (the column is plain `text` with no CHECK constraint).
 */
export const CardinalitySchema = z.enum([
  "one_to_one",
  "one_to_many",
  "many_to_one",
  "many_to_many"
]);
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
  /**
   * M20.1 ([ADR-0031](../../../docs/adr/0031-domain-local-objects-never-federate.md) §1) — `true`
   * when this object's existence stays inside its own security domain: its journal entries match
   * NO peer sync scope, in either direction, so no peer ever learns it exists.
   *
   * DECLARED at create by a `federation:write` caller, never inferred. **Immutable** thereafter —
   * shared → domain-local is refused permanently (federation has no un-send), and the reverse is
   * the one-way M20.4 publication verb.
   *
   * **Visibility only.** It is not an enforcement input: it grants no scan exemption and is read by
   * no governance path. Domain-local content is outside the cross-boundary scan gate because it
   * crosses no boundary (the *path*), never because of this flag or because of where it lives.
   *
   * Always present on the wire (defaults to `false`), so a reader never has to distinguish
   * "not declared" from "not sent".
   */
  domainLocal: z.boolean(),
  /**
   * M20.7 ([ADR-0031](../../../docs/adr/0031-domain-local-objects-never-federate.md) §6c) — **why**
   * this object is domain-local.
   *
   * Since M20.5 locality inherits at create, so `domainLocal: true` alone no longer means "someone
   * chose this". The three states are exhaustive and need no separate discriminator:
   *
   * | `domainLocal` | `domainLocalInheritedFrom` | meaning |
   * |---|---|---|
   * | `false` | `null` | federates normally |
   * | `true` | `null` | **declared** by an operator |
   * | `true` | present | **inherited** from that container |
   *
   * **Declared wins when both apply.** Creating with `domainLocal: true` under an already-local
   * container records *declared*, because that is what the operator did — even though the object
   * would have been local anyway.
   *
   * **HISTORICAL, not live.** It records the container as it was at create and is never updated to
   * follow it, so after §6b's publish-container-then-child flow a still-local child legitimately
   * points at a container that has since become shared. That is the true answer to "how did this
   * become domain-local" — do not read it as "its container is currently domain-local", and do not
   * use it to predict whether a publish will be refused (§6b's refusal is the server's census to run,
   * over live state, along both containment routes).
   *
   * The `urn` is carried because it is immutable and resolvable on every `idOrUrn` route, so a badge
   * can name and link the container with no extra request. A container that has since been deleted
   * still resolves here as provenance — treat an unresolvable reference as "inherited, source no
   * longer present" rather than as an error.
   */
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
  /**
   * The containment parent. Carried as a `.describe()` rather than as a JSDoc comment ON PURPOSE:
   * JSDoc does not reach `z.toJSONSchema()`, so it would never appear in
   * `tools/openapi/openapi.v1.json`, in the generated SDK, or in a client's editor — which is
   * exactly where this fact was missing (ADR-0032 §8g). If you shorten this string, shorten the
   * argument, not the literal request body: the body is the part a caller can copy.
   */
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
  /**
   * M20.1 (ADR-0031 §1) — declare that this object never leaves its security domain. Optional and
   * defaulting to `false`, so every existing client is unaffected.
   *
   * Setting it `true` additionally requires **`federation:write`**, not merely `object:write`: a
   * property that governs what crosses a trust boundary is not an ordinary object field, and
   * ADR-0022 set exactly this precedent for the mirror-image case (commander-declared outpost
   * config). Omitting it, or sending `false`, needs only the ordinary create permission.
   *
   * There is deliberately **no counterpart on update or upsert-of-an-existing-row** — the
   * capability is structurally absent rather than conditionally refused. See `GraphObject`.
   */
  domainLocal: z.boolean().optional()
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

/**
 * M20.4 (ADR-0031 §6) — the result of publishing a domain-local object.
 *
 * Reports the edge sweep in two buckets rather than one, because a partial sweep is the CORRECT
 * outcome and a silent one would be indistinguishable from a bug: edges to a neighbour that is
 * itself still domain-local stay unpublished, and the operator needs to see which those were.
 */
/**
 * One swept edge, named well enough for an operator to act on it.
 *
 * The bare-id arrays below came first and could only ever render as UUIDs — which does not satisfy
 * ADR-0031 §6's "the sweep is legible rather than implicit". Legible means knowing WHICH edge: its
 * type, and above all the object at the other end. For a WITHHELD edge that other endpoint is
 * literally the operator's next action ("publish that one too"), and a UI that only has an id has to
 * issue a GET per relationship plus one per endpoint to say so.
 */
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
  /**
   * The same two sets, described rather than merely identified. ADDITIVE SIBLINGS of the id arrays
   * rather than a change to them: the id arrays already have consumers (the CLI, and a shipped UI),
   * and changing an existing array's item type is a breaking oasdiff hit. Same order, same
   * membership — these are a richer view of the identical sweep, never a different one.
   */
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
  /**
   * M20.1 (ADR-0031 §1) — accepted here, unlike on `PATCH`, so the declaration keeps full
   * API → SDK → CLI → **IaC** → UI parity (charter principle 3): `scp plan`/`apply` reaches the
   * graph through this upsert, and a property IaC could not express would be a parity hole.
   *
   * On the **create** branch it declares locality, exactly as on `POST`, and requires
   * `federation:write`. On the **update** branch it is a *precondition, never a write*: a value
   * equal to the stored one is an idempotent no-op (so re-applying an unchanged IaC stack keeps
   * working), and a value that **differs** is refused `409` — locality is immutable, and a PUT
   * must not become the flip door that `PATCH` structurally is not.
   */
  domainLocal: z.boolean().optional()
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

// ---------------------------------------------------------------------------------------------
// Placements (ADR-0026 D2/D3/D14, post-import-configuration.md §3)
// ---------------------------------------------------------------------------------------------

/**
 * `POST /placements` — one component at one deployment target.
 *
 * Both endpoints are REQUIRED and are the whole point: a placement naming only one of them is not a
 * placement. Taking them here rather than as free-form `properties` is what lets the route enforce
 * the pairing rule at the boundary — resolve each ref, type-check it, and write the two derived
 * edges in the same transaction.
 *
 * `strictObject` (not `z.object`) deliberately, following the `outpost` precedent: a plain
 * `z.object` DROPS an unknown key and still answers 201, so a newer client writing a property an
 * older server has never heard of would lose the field with no signal. Strict at the operator's
 * door; the registered property schema stays open on the wire (migration 0050's header explains
 * why those must differ).
 */
export const CreatePlacementRequestSchema = z.strictObject({
  id: z.string().uuid().optional(),
  urn: UrnSchema.optional(),
  /** id or URN of the component being placed. */
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
  /**
   * Narrow the page to the containment subtree of ONE object — the authority hint
   * (docs/proposals/role-model.md §8.2 step 6).
   *
   * NEVER a widening: the caller is authorized at this object before it is used, so the rows it
   * admits are always a subset of the rows they could already list. It exists for the wide-binding
   * case — a domain-bound principal (or an org-root one) who wants the placements of one service
   * rather than a descend over everything.
   *
   * A UUID, not an id-or-URN like the two refs above, so the parameter name stays literally true;
   * accepting a URN later is an additive change. An id naming nothing is a **404**, deliberately:
   * `scopeExpandCte` seeds its walk with the raw uuid and never checks existence, so authorizing at
   * an unresolved value would answer 403 for everybody, org-root Owner included.
   */
  scopeObjectId: z.string().uuid().optional()
});
export type PlacementListQuery = z.infer<typeof PlacementListQuerySchema>;

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
  // M2 step 3 addition (BUILD_AND_TEST.md §8 M2 item 4): mirrors `objects.labels` — additive,
  // backward-compatible (DESIGN.md "additive-only within v1"), defaults to `{}` for every
  // relationship created before this milestone.
  //
  // An IaC apply writes `scp:managed-by`/`scp:stack` here, but SINCE drizzle/0068 THOSE ARE A
  // DESCRIPTIVE MIRROR AND SCOPE NOTHING. Pruning is scoped by the server-written
  // `relationships.managed_by_stack` column, precisely because this map is writable by the edge's
  // own endpoints' owners and the previous wording ("the pruning convention") is what made a
  // tenant-writable key into a delete decision.
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

/**
 * Induced-subgraph edges over an explicit object-id set (DESIGN.md §5, additive within /v1). The
 * named graph queries (`impact-of`/`blast-radius`/…) return only the reachable object SET, never
 * the edges among it — so the UI graph explorer had to synthesize a hub-and-spoke star to render
 * anything connected. This returns the REAL relationships whose BOTH endpoints are in `ids`
 * (exactly the induced-subgraph edge set `traverse` already computes over its own walk), letting a
 * caller render the true DAG for any set it already obtained. `objectId` is the root the caller is
 * exploring — it scopes the `graph:query` authorization the same way the named query that produced
 * the set did.
 */
export const SubgraphRequestSchema = z.object({
  objectId: z.string().uuid(),
  ids: z.array(z.string().uuid()).min(1).max(2000)
});
export type SubgraphRequest = z.infer<typeof SubgraphRequestSchema>;

export const SubgraphResultSchema = z.object({
  edges: z.array(TraverseEdgeSchema)
});
export type SubgraphResult = z.infer<typeof SubgraphResultSchema>;

// ---------------------------------------------------------------------------------------------
// Graph integrity (`GET /api/v1/graph/integrity`)
// ---------------------------------------------------------------------------------------------

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

/**
 * Rows that outlived the object they hang off.
 *
 * READ-ONLY, and deliberately so: repair is performed by the ordinary `DELETE` doors
 * (`/relationships/{id}`, `/change-sources/{kind}/mappings`, `/executors/{idOrUrn}/binding`), each
 * of which already writes its audit event and journal entry in the same transaction. A dedicated
 * bulk-repair endpoint would be a second, unaudited way to destroy rows — exactly what principle 6
 * exists to prevent.
 */
export const GraphIntegrityReportSchema = z.object({
  danglingRelationships: z.array(DanglingRelationshipSchema),
  orphanSourceMappings: z.array(OrphanProjectionRowSchema),
  orphanExecutorBindings: z.array(OrphanProjectionRowSchema),
  orphanPlacements: z.array(OrphanProjectionRowSchema)
});
export type GraphIntegrityReport = z.infer<typeof GraphIntegrityReportSchema>;
