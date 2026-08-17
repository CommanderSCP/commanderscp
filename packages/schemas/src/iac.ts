import { z } from "zod";
import { JsonRecordSchema, UrnSchema } from "./graph.js";
import { ExecutorTypeSchema, PipelineClassificationSchema } from "./executors.js";

/**
 * `@scp/iac` desired-state manifest contract (DESIGN.md §15, BUILD_AND_TEST.md §8 M2 item 4).
 * CDK-style constructs (`packages/iac`) synthesize a value conforming to
 * `DesiredStateManifestSchema` via a PURE function — no API calls, no randomness, no wall-clock
 * reads — so the manifest is the one interchange point between IaC authoring (offline, air-gap
 * safe) and server-side reconciliation (`POST /plans`). Objects and relationships are addressed
 * by URN, never by a synth-time-random id, which is exactly what makes two independent synths of
 * an equivalent construct tree converge to byte-identical JSON.
 *
 * Lives in `@scp/schemas` (not `@scp/iac`) so both the IaC package (producer) and the server
 * (consumer, `apps/server/src/iac/plan-diff.ts`) share one contract — same rationale as every
 * other shape in this package (DESIGN.md §6, §15: "Zod schemas flow untranslated from the server
 * to the generated SDK and IaC").
 */

export const ManifestObjectSchema = z.object({
  urn: UrnSchema,
  typeId: z.string().min(1),
  name: z.string().min(1).max(500),
  /**
   * Object id this URN's containing domain resolves to; `undefined`/omitted defaults to the org
   * root, same as `CreateObjectRequestSchema.domainId` (graph.ts) — read that field's `.describe()`
   * for the full argument, because the default carries the same authorization consequence here:
   * `iac/plans-repo.ts` runs the SAME custody `authorize` at the resolved parent and the same
   * `assertPolicyScopeWithinAuthority` at apply time. An omitted `domainId` therefore puts a
   * narrowly-bound author's check at the org root, and the apply is refused for a scope the manifest
   * never named.
   *
   * The manifest equivalent of ADR-0032 §8g's component-team dependency subscription — note the
   * component's own id in BOTH places, `domainId` for custody (where the row lives, hence who may
   * later change it) and `scope.objectRef` for jurisdiction (what the policy reaches):
   *
   *     {
   *       "stackName": "checkout-api",
   *       "objects": [{
   *         "urn": "urn:scp:checkout-api:policy:deps-checkout-api",
   *         "typeId": "policy",
   *         "name": "deps-checkout-api",
   *         "domainId": "11111111-1111-1111-1111-111111111111",
   *         "properties": {
   *           "enforcement": "advisory",
   *           "scope": { "objectRef": "11111111-1111-1111-1111-111111111111" },
   *           "effects": [{ "dependencySubscription": { "enabled": true } }]
   *         }
   *       }],
   *       "relationships": []
   *     }
   *
   * `governance.integration.test.ts`'s IaC case builds its manifests exactly this way and says why
   * in a comment: `domainId: component.id` is what makes the custody check pass, which is what lets
   * that test isolate the declared-scope-authority check specifically.
   *
   * The `.describe()` below exists for the same reason it does on the create field: a JSDoc comment
   * does not reach `z.toJSONSchema()`, so a manifest author reading the generated SDK type would see
   * none of this.
   */
  domainId: z
    .string()
    .uuid()
    .nullable()
    .optional()
    .describe(
      "Containment parent for this object — an object id, not a URN. OMITTING IT DEFAULTS TO THE ORG ROOT. On a " +
        "CREATE, apply authorizes the type's write permission AT THE RESOLVED PARENT, so a narrowly-bound author " +
        "who omits it is checked at the org root and the apply is refused for a scope the manifest never named. On " +
        "an UPDATE of an object that currently lives inside a container, omitting it is a MOVE OUT to the org root " +
        "rather than 'leave it where it is' — authorized at the container the object is LEAVING, not at the org " +
        "root, so it is not refused for the applier who owns that container. Send the " +
        "deepest object you hold write authority over. Worked example — a component team declaring a dependency " +
        'subscription (ADR-0032 §8g) puts its OWN COMPONENT id here: {"urn":"urn:scp:checkout-api:policy:deps-' +
        'checkout-api","typeId":"policy","name":"deps-checkout-api","domainId":"<component-id>","properties":' +
        '{"enforcement":"advisory","scope":{"objectRef":"<component-id>"},"effects":[{"dependencySubscription":' +
        '{"enabled":true}}]}}. The id appears twice on purpose: domainId is CUSTODY (where the row lives), ' +
        "scope.objectRef is JURISDICTION (what the policy reaches)."
    ),
  properties: JsonRecordSchema.optional(),
  labels: JsonRecordSchema.optional()
});
export type ManifestObject = z.infer<typeof ManifestObjectSchema>;

export const ManifestRelationshipSchema = z.object({
  typeId: z.string().min(1),
  fromUrn: UrnSchema,
  toUrn: UrnSchema,
  properties: JsonRecordSchema.optional()
});
export type ManifestRelationship = z.infer<typeof ManifestRelationshipSchema>;

// ---------------------------------------------------------------------------------------------
// Projection collections (docs/proposals/post-import-configuration.md §8 C1)
//
// `source_mappings` and `executor_bindings` are the two configurations that were UNEXPRESSIBLE in a
// manifest: unlike everything else a stack declares, they are standalone projection tables rather
// than graph objects/relationships (`packages/schemas/src/executors.ts`: "projection tables ... no
// graph-object equivalent exists"), so `objects`/`relationships` could not carry them. That made
// principle 3 (API → SDK → CLI → IaC → UI parity) false for exactly the two things an operator must
// reproduce when standing a second instance up offline (principle 5). C1 closes that.
//
// OWNERSHIP IS DERIVED FROM THE OWNING OBJECT (the load-bearing decision — see
// `apps/server/src/iac/plan-diff.ts`'s `stackOwnedObjectUrns`): neither table has a `labels` column,
// and neither gets one. A row belongs to stack S iff the graph object it hangs off
// (`component_object_id` / `target_object_id`) is one THIS stack owns. Two consequences an author
// must know, both deliberate:
//   1. A manifest may only declare a mapping/binding for an object the SAME stack declares (or one
//      it already manages). Anything else is rejected 400 at plan-compute — a stack cannot configure
//      an object it does not own.
//   2. Because ownership is inherited, declaring an object in a stack means the stack owns that
//      object's mappings/bindings WHOLESALE. Adopting a discovery-imported component into a stack
//      and declaring no bindings prunes the imported ones — visible as `delete` entries in the plan
//      the operator reviews before applying, exactly like an object prune, never silent.
// ---------------------------------------------------------------------------------------------

/**
 * A `source_mappings` row: repo/path/ref glob → the component whose pipeline of `type` that source
 * drives (DESIGN §9.2 correlation). IDENTITY is the whole tuple
 * `(componentUrn, sourceKind, repoPattern, pathPattern, refPattern, type)` — the table has no unique
 * constraint and no update path, so a changed mapping is a delete + create, the same identity-only
 * treatment `ManifestRelationshipSchema` gets. Declaring the same tuple twice in one manifest is
 * rejected.
 *
 * `refPattern` had to join that identity (ADR-0030 §1): it is a routing discriminator, so a manifest
 * legitimately declares `refs/heads/dev` → dev pipeline and `refs/heads/main` → production as two
 * rows differing in nothing else. Without it in the tuple those two would collide as a duplicate
 * declaration, and a prune of either would match — and delete — both.
 *
 * `classification` is deliberately NOT part of the identity: it is a descriptive label, so changing
 * it should be an in-place correction rather than a delete-and-recreate of a live route.
 */
export const ManifestSourceMappingSchema = z.object({
  /** URN of the component this source drives. Must be an object THIS stack owns (see above). */
  componentUrn: UrnSchema,
  sourceKind: z.string().min(1),
  /** Glob matched against `source_ref.repo`. */
  repoPattern: z.string().min(1).optional(),
  /** Glob matched against `source_ref.path`. */
  pathPattern: z.string().min(1).optional(),
  /** Glob matched against the event's git ref (`refs/heads/dev`). Omitted ⇒ matches any ref. */
  refPattern: z.string().min(1).optional(),
  /** WHICH pipeline of the component this source drives (ADR-0007). Omitted ⇒ `configuration`. */
  type: ExecutorTypeSchema.optional(),
  /** The operator's declared pipeline classification (ADR-0030 §2) — UI/reporting only, never an
   *  enforcement input, and deliberately outside the identity tuple above. */
  classification: PipelineClassificationSchema.optional()
});
export type ManifestSourceMapping = z.infer<typeof ManifestSourceMappingSchema>;

/**
 * An `executor_bindings` row: the plugin instance that drives one pipeline of one target object.
 * IDENTITY is `(targetUrn, type)`, mirroring the table's `UNIQUE (org_id, target_object_id, type)`
 * — so unlike a source mapping this one supports `update`, and a plan can never propose two rows
 * that would collide on that constraint. Field-for-field the same shape as
 * `CreateExecutorBindingRequestSchema` (the `PUT /executors/{idOrUrn}/binding` body), including its
 * either-inline-or-execution-system-backed refinement: one contract, two doors.
 */
export const ManifestExecutorBindingSchema = z
  .object({
    /** URN of the Component/DeploymentTarget being bound. Must be an object THIS stack owns. */
    targetUrn: UrnSchema,
    /**
     * NARROWS `targetUrn` to a PLACEMENT: this component AT this deployment-target, rather than the
     * component itself. Omitted ⇒ the binding hangs off `targetUrn`'s object, as it always has.
     *
     * A placement is addressed this way rather than by its own URN because that URN is DERIVED
     * (ADR-0026 D3) from the org id plus both endpoints' display names — neither hand-writable nor
     * stable under a rename. Expressing it as a qualifier on `targetUrn` rather than as an
     * alternative to it also keeps `targetUrn` REQUIRED, so adding this field breaks no response
     * consumer, and leaves ownership a single unconditional rule: the stack must own `targetUrn`,
     * which for a placement is its component (decision Q4).
     */
    deploymentTargetUrn: UrnSchema.optional(),
    /** WHICH pipeline this binding drives (ADR-0007). Omitted ⇒ `configuration`. */
    type: ExecutorTypeSchema.optional(),
    /** Inline binding: plugin module + a stable instance id. Omitted for execution-system-backed. */
    pluginModule: z.string().min(1).optional(),
    pluginInstanceId: z.string().min(1).optional(),
    config: JsonRecordSchema.optional(),
    /** `{ configFieldName: secretKey }` — the secret must already exist (`PUT /secrets/{key}`).
     *  Manifests are authored offline and committed to git; this names secrets, never carries them. */
    secretRefs: z.record(z.string(), z.string()).optional(),
    allowedHosts: z.array(z.string()).optional(),
    /** Executor-specific target identifier (e.g. an Argo CD Application name). */
    externalRef: z.string().min(1).optional(),
    /** Id or URN of a registered `execution-system` object (Mode A) — module/serverUrl/token resolve
     *  from it, so omit `pluginModule`/`config`. */
    executionSystemId: z.string().min(1).optional()
  })
  .refine(
    (b) => (b.executionSystemId ? !b.pluginModule : Boolean(b.pluginModule && b.pluginInstanceId)),
    {
      message:
        "provide EITHER executionSystemId (execution-system-backed) OR pluginModule + pluginInstanceId (inline) — not both, and not neither"
    }
  )
  .refine(
    (b) =>
      !b.executionSystemId ||
      (b.pluginInstanceId === undefined &&
        b.config === undefined &&
        b.secretRefs === undefined &&
        b.allowedHosts === undefined),
    {
      message:
        "an execution-system-backed binding derives its module, instance id, config, credentials and egress allowlist FROM the system — remove pluginInstanceId/config/secretRefs/allowedHosts rather than declaring values the server will ignore"
    }
  );
export type ManifestExecutorBinding = z.infer<typeof ManifestExecutorBindingSchema>;

/**
 * A `placement` (ADR-0026): one component at one deployment-target.
 *
 * IDENTITY IS THE PAIR, and there is deliberately NO `urn` field. ADR-0026 D3 makes a placement's
 * URN *derived* from both endpoints, so a manifest that supplied one could disagree with what the
 * typed route would mint and the two would diverge silently. Addressing by the pair is the only
 * self-consistent choice, and it is what lets two independent synths converge.
 *
 * OWNERSHIP is the COMPONENT's stack (decision Q4) — the same rule `sourceMappings` already use, so
 * placements need no new ownership concept. A declaration whose component this stack does not own is
 * refused, which is what stops two stacks pruning each other's placements.
 */
export const ManifestPlacementSchema = z.object({
  /** URN of the component being placed. Must be an object THIS stack owns. */
  componentUrn: UrnSchema,
  /** URN of the deployment-target it is placed at. May belong to another stack. */
  deploymentTargetUrn: UrnSchema
});
export type ManifestPlacement = z.infer<typeof ManifestPlacementSchema>;

export const DesiredStateManifestSchema = z.object({
  /** Deployable-unit label — becomes the row's server-written `managed_by_stack` (drizzle/0068),
   *  which is what scopes pruning. It is ALSO mirrored into `labels` as `scp:stack` for humans; that
   *  mirror is descriptive and decides nothing (see `plan-diff.ts`'s `managedLabels`). */
  stackName: z.string().min(1),
  objects: z.array(ManifestObjectSchema),
  relationships: z.array(ManifestRelationshipSchema),
  /** C1. OPTIONAL, not defaulted: a manifest synthesized before C1 (or by a hand-rolled producer)
   *  stays valid and means "this stack declares no mappings", which is exactly right — an absent
   *  collection must not read as "prune everything". */
  sourceMappings: z.array(ManifestSourceMappingSchema).optional(),
  /** C1 — see `sourceMappings` for why this is optional rather than defaulted. */
  executorBindings: z.array(ManifestExecutorBindingSchema).optional(),
  /** C1 (ADR-0026). OPTIONAL for the same reason as the two above — but note what "optional" does
   *  and does NOT mean. It keeps a pre-C1 manifest VALID; it does not suppress pruning. `Stack.synth()`
   *  omits a collection when it is empty, so absent is the only way to say "this stack declares no
   *  placements", and it therefore prunes exactly as an empty array does. (`plan-diff.ts`'s
   *  `ResolvedManifest` carries the long form of this; I once read it the other way and broke three
   *  prune tests.) A PRESENT one is authoritative for the
   *  components this stack owns — removing an entry deletes that placement (decision Q3), which is
   *  safe only because a placement still carrying an executor binding is REFUSED rather than
   *  cascaded (decision Q2). Those two rulings are load-bearing together. */
  placements: z.array(ManifestPlacementSchema).optional()
});
export type DesiredStateManifest = z.infer<typeof DesiredStateManifestSchema>;

// ---------------------------------------------------------------------------------------------
// Server-side plan/apply (`apps/server/src/routes/plans.ts`)
// ---------------------------------------------------------------------------------------------

export const PlanActionSchema = z.enum(["create", "update", "delete", "noop"]);
export type PlanAction = z.infer<typeof PlanActionSchema>;

/** The full desired-state row a `create`/`update` entry will write — `labels` already include the
 *  merged `scp:managed-by`/`scp:stack` markers (plan-diff.ts). Those are a HUMAN-READABLE MIRROR
 *  since drizzle/0068 and are not what an apply prunes on; ownership is the server-written
 *  `managed_by_stack` column, which no request can set and which is therefore absent from this
 *  (request-reachable) shape. */
export const PlanObjectTargetSchema = z.object({
  urn: UrnSchema,
  typeId: z.string(),
  name: z.string(),
  domainId: z.string().uuid().nullable(),
  properties: JsonRecordSchema,
  labels: JsonRecordSchema
});
export type PlanObjectTarget = z.infer<typeof PlanObjectTargetSchema>;

export const PlanObjectDiffEntrySchema = z.object({
  kind: z.literal("object"),
  action: PlanActionSchema,
  urn: UrnSchema,
  typeId: z.string(),
  reason: z.string(),
  /** Present for `create`/`update` only. */
  target: PlanObjectTargetSchema.optional()
});
export type PlanObjectDiffEntry = z.infer<typeof PlanObjectDiffEntrySchema>;

export const PlanRelationshipDiffEntrySchema = z.object({
  kind: z.literal("relationship"),
  action: z.enum(["create", "delete", "noop"]),
  typeId: z.string(),
  fromUrn: UrnSchema,
  toUrn: UrnSchema,
  reason: z.string()
});
export type PlanRelationshipDiffEntry = z.infer<typeof PlanRelationshipDiffEntrySchema>;

/**
 * One `source_mappings` row's verdict. No `update`: identity is the whole tuple (see
 * `ManifestSourceMappingSchema`), so a changed mapping surfaces as a delete plus a create — the
 * same identity-only treatment `PlanRelationshipDiffEntrySchema` gets, for the same reason.
 * `repoPattern`/`pathPattern`/`type` are normalized here (null / the `configuration` default) so the
 * entry the operator reviews shows exactly the row that will be written, not the author's shorthand.
 */
/** A placement diff entry. No `update`: the pair IS the identity, so a changed pair is a different
 *  placement — a delete plus a create, never an in-place edit. */
export const PlanPlacementDiffEntrySchema = z.object({
  kind: z.literal("placement"),
  action: z.enum(["create", "delete", "noop"]),
  componentUrn: UrnSchema,
  deploymentTargetUrn: UrnSchema,
  reason: z.string()
});
export type PlanPlacementDiffEntry = z.infer<typeof PlanPlacementDiffEntrySchema>;

export const PlanSourceMappingDiffEntrySchema = z.object({
  kind: z.literal("source-mapping"),
  action: z.enum(["create", "delete", "noop"]),
  componentUrn: UrnSchema,
  sourceKind: z.string(),
  repoPattern: z.string().nullable(),
  pathPattern: z.string().nullable(),
  /** Normalized like the two above. Part of the identity tuple, so it MUST appear on the entry the
   *  operator reviews: a prune whose ref the plan did not show is a prune they cannot check. */
  refPattern: z.string().nullable(),
  type: ExecutorTypeSchema,
  /** Descriptive only, and outside the identity tuple — shown so a plan that introduces or clears a
   *  `dev` label is legible, not because it participates in matching. */
  classification: PipelineClassificationSchema.nullable(),
  reason: z.string()
});
export type PlanSourceMappingDiffEntry = z.infer<typeof PlanSourceMappingDiffEntrySchema>;

/** The full desired-state `executor_bindings` row a `create`/`update` entry will write. */
export const PlanExecutorBindingTargetSchema = z.object({
  pluginModule: z.string().nullable(),
  pluginInstanceId: z.string().nullable(),
  config: JsonRecordSchema,
  secretRefs: z.record(z.string(), z.string()),
  allowedHosts: z.array(z.string()),
  externalRef: z.string().nullable(),
  executionSystemId: z.string().nullable()
});
export type PlanExecutorBindingTarget = z.infer<typeof PlanExecutorBindingTargetSchema>;

/**
 * One `executor_bindings` row's verdict, keyed on `(target, type)` — the table's own uniqueness,
 * where `target` is `targetUrn` optionally narrowed by `deploymentTargetUrn` to a placement.
 */
export const PlanExecutorBindingDiffEntrySchema = z.object({
  kind: z.literal("executor-binding"),
  action: PlanActionSchema,
  targetUrn: UrnSchema,
  /** Present iff the bound row hangs off a PLACEMENT — see `ManifestExecutorBindingSchema`. */
  deploymentTargetUrn: UrnSchema.optional(),
  type: ExecutorTypeSchema,
  reason: z.string(),
  /** Present for `create`/`update` only. */
  target: PlanExecutorBindingTargetSchema.optional()
});
export type PlanExecutorBindingDiffEntry = z.infer<typeof PlanExecutorBindingDiffEntrySchema>;

export const PlanDiffSummarySchema = z.object({
  creates: z.number().int(),
  updates: z.number().int(),
  deletes: z.number().int(),
  noops: z.number().int()
});
export type PlanDiffSummary = z.infer<typeof PlanDiffSummarySchema>;

export const PlanDiffSchema = z.object({
  objects: z.array(PlanObjectDiffEntrySchema),
  relationships: z.array(PlanRelationshipDiffEntrySchema),
  /** C1. OPTIONAL because a plan row PERSISTED before C1 is read back through this schema on
   *  `GET /plans/{id}`: requiring the key would 500 every pre-C1 plan in the table. Consumers read
   *  it as `?? []`; `computePlanDiff` always emits it. */
  sourceMappings: z.array(PlanSourceMappingDiffEntrySchema).optional(),
  /** C1 (ADR-0026) — see `sourceMappings` for why this is optional. */
  placements: z.array(PlanPlacementDiffEntrySchema).optional(),
  /** C1 — see `sourceMappings` for why this is optional. */
  executorBindings: z.array(PlanExecutorBindingDiffEntrySchema).optional(),
  summary: PlanDiffSummarySchema
});
export type PlanDiff = z.infer<typeof PlanDiffSchema>;

export const PlanStatusSchema = z.enum(["pending", "applied", "stale"]);
export type PlanStatus = z.infer<typeof PlanStatusSchema>;

export const PlanSchema = z.object({
  id: z.string().uuid(),
  orgId: z.string().uuid(),
  actorId: z.string().uuid(),
  stackName: z.string(),
  manifest: DesiredStateManifestSchema,
  diff: PlanDiffSchema,
  status: PlanStatusSchema,
  createdAt: z.string().datetime(),
  appliedAt: z.string().datetime().nullable()
});
export type Plan = z.infer<typeof PlanSchema>;

export const CreatePlanRequestSchema = z.object({
  manifest: DesiredStateManifestSchema
});
export type CreatePlanRequest = z.infer<typeof CreatePlanRequestSchema>;

export const PlanIdParamSchema = z.object({ id: z.string().uuid() });

export const ApplyPlanResponseSchema = z.object({
  plan: PlanSchema,
  summary: PlanDiffSummarySchema
});
export type ApplyPlanResponse = z.infer<typeof ApplyPlanResponseSchema>;
