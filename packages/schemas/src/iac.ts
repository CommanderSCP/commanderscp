import { z } from "zod";
import { JsonRecordSchema, UrnSchema } from "./graph.js";
import {
  ExecutorTypeSchema,
  PipelineClassificationSchema,
  SourceMappingScopeSchema
} from "./executors.js";
import { DependencyCoordinateSchema, DependencyEcosystemSchema } from "./dependencies.js";
import {
  ManifestConvergenceSchema,
  ManifestPipelineHookSchema,
  ManifestRolloutSchema,
  PipelineHookKindSchema,
  WorkflowRefSchema
} from "./pipeline-behaviors.js";

/** `@scp/iac` desired-state manifest contract. See docs/schemas.md §299. */

export const ManifestObjectSchema = z.object({
  urn: UrnSchema,
  typeId: z.string().min(1),
  name: z.string().min(1).max(500),
  /** The object id this URN's containing domain resolves to. See docs/schemas.md §300. */
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

// The projection collections an apply may manage. See docs/schemas.md §301.

/** A `source_mappings` row. See docs/schemas.md §302. */
export const ManifestSourceMappingSchema = z.object({
  /** URN of the component this source drives. Must be an object THIS stack owns (see above). */
  componentUrn: UrnSchema,
  sourceKind: z.string().min(1),
  repoPattern: z.string().min(1).optional(),
  pathPattern: z.string().min(1).optional(),
  /** Glob matched against the event's git ref (`refs/heads/dev`). Omitted ⇒ matches any ref. */
  refPattern: z.string().min(1).optional(),
  /** WHICH pipeline of the component this source drives (ADR-0007). Omitted ⇒ `configuration`. */
  type: ExecutorTypeSchema.optional(),
  /** The operator's declared pipeline classification (ADR-0030 §2) — UI/reporting only, never an
   *  enforcement input, and deliberately outside the identity tuple above. */
  classification: PipelineClassificationSchema.optional(),
  /** Declared mirror-of-shared provenance (outpost-ui.md §9.3a). Like `classification`, NOT part
   *  of the mapping's identity — a descriptive label; omitted means domain-specific. */
  mirrorOfShared: z.boolean().optional(),
  /** The pause switch (migration 0063). Like `classification`/`mirrorOfShared`, deliberately
   *  outside the identity tuple — disabling a live mapping is an in-place correction, not a
   *  delete-and-recreate of the route. Omitted ⇒ enabled, the pre-0063 behaviour. */
  enabled: z.boolean().optional(),
  /** DECLARED reach (§10.6, migration 0066). See docs/schemas.md §303. */
  scope: SourceMappingScopeSchema.nullable().optional()
});
export type ManifestSourceMapping = z.infer<typeof ManifestSourceMappingSchema>;

/** An `executor_bindings` row. See docs/schemas.md §304. */
export const ManifestExecutorBindingSchema = z
  .object({
    /** URN of the Component/DeploymentTarget being bound. Must be an object THIS stack owns. */
    targetUrn: UrnSchema,
    /** NARROWS `targetUrn` to a PLACEMENT. See docs/schemas.md §305. */
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

/** A placement: one component at one deployment target. See docs/schemas.md §306. */
export const ManifestPlacementSchema = z.object({
  /** URN of the component being placed. Must be an object THIS stack owns. */
  componentUrn: UrnSchema,
  /** URN of the deployment-target it is placed at. May belong to another stack. */
  deploymentTargetUrn: UrnSchema
});
export type ManifestPlacement = z.infer<typeof ManifestPlacementSchema>;

/** A `dependency_line_producers` row (ADR-0032 §7e). See docs/schemas.md §307. */
export const ManifestDependencyProducerSchema = z.object({
  /** URN of the producing COMPONENT. Must be an object THIS stack owns, and must be a `component`. */
  producerUrn: UrnSchema,
  ecosystem: DependencyEcosystemSchema,
  /** Carried VERBATIM — never slugified, never lowercased. `@acme/lib`, `github.com/acme/lib` and
   *  `docker.io/library/alpine` are three coordinates that share nothing but a URN slug. */
  coordinate: DependencyCoordinateSchema
});
export type ManifestDependencyProducer = z.infer<typeof ManifestDependencyProducerSchema>;

/** A `governance_move_rungs` row. See docs/schemas.md §308. */
export const ManifestGovernanceMoveRungSchema = z.object({
  /** The container the rung sits on — an object id OR a URN. It must be an object THIS stack
   *  declares (ownership is inherited from it), and must be a type that can carry a rung. */
  subjectIdOrUrn: z.string().min(1).max(512)
});
export type ManifestGovernanceMoveRung = z.infer<typeof ManifestGovernanceMoveRungSchema>;

/** ROLE BINDINGS AND CUSTOM ROLES IN A MANIFEST. See docs/schemas.md §309. */
export const ManifestRoleBindingSchema = z.object({
  /** The `user` or `service-account` receiving the authority, by URN. */
  subjectUrn: z.string().min(1).max(512),
  /** Built-in name (`Owner`, `OrgAdmin`, …) or an org role's name. Resolved at apply. */
  roleName: z.string().min(1).max(200),
  /** The object at-or-below which the role grants, by URN. */
  scopeUrn: z.string().min(1).max(512),
  /** Mandatory, as on the typed door: handing a principal authority is a governance act, and the
   *  operator's own words are the one thing the structured Decision cannot reconstruct. */
  reason: z.string().min(1).max(2000)
});
export type ManifestRoleBinding = z.infer<typeof ManifestRoleBindingSchema>;

/** One org-defined role. `permissions` must all be strings this system defines AND ones the
 *  applying principal holds at the org root (`docs/authz/role-binding-door.md` §9). */
export const ManifestRoleSchema = z.object({
  name: z.string().min(1).max(200),
  permissions: z.array(z.string()).max(100),
  /** Object type ids this role may be bound at; absent means ANY scope. */
  bindableAt: z.array(z.string()).max(50).optional(),
  reason: z.string().min(1).max(2000)
});
export type ManifestRole = z.infer<typeof ManifestRoleSchema>;

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
  /** C1 (ADR-0026). OPTIONAL for the same reason as the two above. See docs/schemas.md §310. */
  placements: z
    .array(ManifestPlacementSchema)
    .optional()
    .describe(
      "Placements this stack declares. A PRESENT collection is authoritative and prunes; an ABSENT one is " +
        "the same as an empty one and prunes too (Stack.synth() omits an empty collection). Note that " +
        "'producers' deliberately does NOT follow this rule — read its own description."
    ),
  /** Absent means unmanaged, diverging from the collections. See docs/schemas.md §311. */
  producers: z
    .array(ManifestDependencyProducerSchema)
    .optional()
    .describe(
      "Dependency-line producer declarations (ADR-0032 §7e). UNLIKE every other collection here, an ABSENT " +
        "'producers' key means UNMANAGED and prunes NOTHING — retracting a declaration returns a coordinate the " +
        "org publishes to a public index on a poll timer, so a forgotten key must not re-arm dependency " +
        "confusion. A PRESENT collection IS authoritative over its members: removing an entry prunes that " +
        "declaration, and a present-but-empty array prunes every declaration on a component this stack owns. " +
        "Because Stack.synth() omits an empty collection, @scp/iac cannot retract the LAST declaration — use " +
        "POST /dependencies/producers/retract (which also reports the bumps already in flight), or hand-author " +
        '"producers": []. Ownership follows the producer COMPONENT; a plan that would take a coordinate from a ' +
        "producer this stack does not own is refused."
    ),
  /** Absent means unmanaged, the same divergence and reason. See docs/schemas.md §312. */
  governanceMoveRungs: z
    .array(ManifestGovernanceMoveRungSchema)
    .optional()
    .describe(
      "governance:move enforcement rungs (ADR-0038 §2). LIKE 'producers' and UNLIKE every other collection here, " +
        "an ABSENT key means UNMANAGED and disables NOTHING — a rung is a governance bar, and the symptom of " +
        "dropping one is an absence of refusals. A PRESENT collection IS authoritative over its members: removing " +
        "an entry disables that rung, and a present-but-empty array disables every rung on a container this stack " +
        "owns. Because Stack.synth() omits an empty collection, @scp/iac cannot disable the LAST rung — use " +
        'DELETE /governance/move-enforcement/rungs/{idOrUrn}, or hand-author "governanceMoveRungs": []. The ' +
        "subject must be a CONTAINER this stack declares; apply requires policy:write at-or-above it, and a " +
        "disable under an enabled upper rung is refused 409."
    ),
  /** THE THIRD `ABSENT MEANS **UNMANAGED**` COLLECTION. See docs/schemas.md §313. */
  pipelineHooks: z
    .array(ManifestPipelineHookSchema)
    .optional()
    .describe(
      "Pipeline test/bake hooks (D11/D21). LIKE 'producers' and 'governanceMoveRungs' and UNLIKE mappings/" +
        "bindings/placements, an ABSENT key means UNMANAGED and prunes NOTHING — a hook is a gate, and the " +
        "symptom of dropping one is an absence of refusals. A PRESENT collection IS authoritative over its " +
        "members: removing an entry prunes that hook, and a present-but-empty array prunes every hook on a " +
        "component this stack owns. Because Stack.synth() omits an empty collection, @scp/iac cannot remove " +
        'the LAST hook — remove one while others remain, or hand-author "pipelineHooks": []. Identity is ' +
        "(componentUrn, kind, hookId); a changed hook is a delete + create."
    ),
  /** Ordinary rule: absent means empty, which means prune. See docs/schemas.md §314. */
  /** Ordinary rule, the same shape of reasoning as below. See docs/schemas.md §315. */
  roleBindings: z.array(ManifestRoleBindingSchema).optional(),
  /** Ordinary rule, with identity the name within the org. See docs/schemas.md §316. */
  roles: z.array(ManifestRoleSchema).optional(),
  rollouts: z.array(ManifestRolloutSchema).optional(),
  /** ORDINARY RULE, for a second and simpler reason. See docs/schemas.md §317. */
  convergence: z.array(ManifestConvergenceSchema).optional()
});
export type DesiredStateManifest = z.infer<typeof DesiredStateManifestSchema>;

export const PlanActionSchema = z.enum(["create", "update", "delete", "noop"]);
export type PlanAction = z.infer<typeof PlanActionSchema>;

/** The full desired-state row a `create`/`update` entry will write. See docs/schemas.md §318. */
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
  target: PlanObjectTargetSchema.optional(),
  /** Adoption: this entry claims an object that already exists. See docs/schemas.md §319. */
  adopted: z.boolean().optional()
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

/** One `source_mappings` row's verdict. See docs/schemas.md §320. */
export const PlanSourceMappingDiffEntrySchema = z.object({
  kind: z.literal("source-mapping"),
  action: z.enum(["create", "update", "delete", "noop"]),
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
  mirrorOfShared: z.boolean(),
  /** Descriptive on this entry too, like `mirrorOfShared` above — outside the identity tuple, so
   *  its presence here is purely so the operator reviewing the plan can see whether the row they
   *  are creating/pruning is currently paused. */
  enabled: z.boolean(),
  /** The scope the row WILL HAVE after apply (§10.6): the manifest's declaration for `create`/
   *  `update`; the live row's value for `noop`/`delete` and for a manifest that omits it (unmanaged).
   *  `null` = not declared. Optional on the wire — a plan stored before 0066 has no key — read it as
   *  "unknown", never as "undeclared". */
  scope: SourceMappingScopeSchema.nullable().optional(),
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

/** One producer row's verdict, keyed on the coordinate. See docs/schemas.md §321. */
export const PlanDependencyProducerDiffEntrySchema = z.object({
  kind: z.literal("dependency-producer"),
  action: PlanActionSchema,
  ecosystem: DependencyEcosystemSchema,
  coordinate: DependencyCoordinateSchema,
  /** The producing component. On a `delete` this is the producer being retracted, resolved from the
   *  live row — so the reviewed prune names WHO is losing the coordinate, not only which coordinate. */
  producerUrn: UrnSchema,
  /** Present iff a DIFFERENT producer holds this coordinate right now. This is the transfer, spelled
   *  out: the declarer names one coordinate and takes it from a component the request never mentions
   *  (charter principle 6, and the same field the verb records as `displacedProducerObjectId`). */
  displacedProducerUrn: UrnSchema.optional(),
  reason: z.string()
});
export type PlanDependencyProducerDiffEntry = z.infer<typeof PlanDependencyProducerDiffEntrySchema>;

/** One move-rung row's verdict, keyed on the container. See docs/schemas.md §322. */
export const PlanGovernanceMoveRungDiffEntrySchema = z.object({
  kind: z.literal("governance-move-rung"),
  action: z.enum(["create", "delete", "noop"]),
  subjectUrn: UrnSchema,
  reason: z.string()
});
export type PlanGovernanceMoveRungDiffEntry = z.infer<typeof PlanGovernanceMoveRungDiffEntrySchema>;

/** One `pipeline_hooks` row's verdict. See docs/schemas.md §323. */
export const PlanPipelineHookDiffEntrySchema = z.object({
  kind: z.literal("pipeline-hook"),
  action: z.enum(["create", "delete", "noop"]),
  componentUrn: UrnSchema,
  /** The hook's own kind — see the note above on why this is not called `kind`. */
  hookKind: PipelineHookKindSchema,
  hookId: z.string(),
  workflow: WorkflowRefSchema.nullable(),
  /** `postDeploy`/`bakeAlarms`. `null` = EVERY wave — the STRICT end, so a plan that shows `null`
   *  here is showing a gate on every wave, not an unset field. */
  stage: z.string().nullable(),
  /** `continuous` only. */
  everySeconds: z.number().int().nullable(),
  /** `continuous` only. */
  maxAgeSeconds: z.number().int().nullable(),
  /** `bakeAlarms` only. */
  quietWindowSeconds: z.number().int().nullable(),
  reason: z.string()
});
export type PlanPipelineHookDiffEntry = z.infer<typeof PlanPipelineHookDiffEntrySchema>;

/** D12 — one rollout declaration's diff entry. See docs/schemas.md §324. */
export const PlanRolloutDiffEntrySchema = z.object({
  kind: z.literal("rollout"),
  action: z.enum(["create", "update", "delete", "noop"]),
  componentUrn: UrnSchema,
  targetClass: z.string(),
  /** `RolloutStrategySchema` as declared. `null` on a `delete`, where there is no desired state. */
  rollout: z.unknown().nullable(),
  reason: z.string()
});
export type PlanRolloutDiffEntry = z.infer<typeof PlanRolloutDiffEntrySchema>;

/** One role binding's diff entry. See docs/schemas.md §325. */
export const PlanRoleBindingDiffEntrySchema = z.object({
  kind: z.literal("roleBinding"),
  action: z.enum(["create", "delete", "noop"]),
  subjectUrn: z.string(),
  roleName: z.string(),
  scopeUrn: z.string(),
  reason: z.string()
});
export type PlanRoleBindingDiffEntry = z.infer<typeof PlanRoleBindingDiffEntrySchema>;

/** One org-role diff entry. `update` IS meaningful here — a role's identity is its name and its
 *  permission set is its value, so widening one is a change in place rather than a delete. */
export const PlanRoleDiffEntrySchema = z.object({
  kind: z.literal("role"),
  action: z.enum(["create", "update", "delete", "noop"]),
  name: z.string(),
  /** As declared. `null` on a `delete`, where there is no desired state. */
  permissions: z.array(z.string()).nullable(),
  reason: z.string()
});
export type PlanRoleDiffEntry = z.infer<typeof PlanRoleDiffEntrySchema>;

/** D25(b) — one convergence declaration's diff entry. Same prune rule as `rollouts`. */
export const PlanConvergenceDiffEntrySchema = z.object({
  kind: z.literal("convergence"),
  action: z.enum(["create", "update", "delete", "noop"]),
  componentUrn: UrnSchema,
  targetUrn: UrnSchema,
  /** `null` on a `delete`. Note `false` is a REAL declared value, not an absence — D8 makes the
   *  manifest say which, so a plan showing `converge: false` is showing an opt-out someone wrote. */
  converge: z.boolean().nullable(),
  scope: z.string().nullable(),
  reason: z.string()
});
export type PlanConvergenceDiffEntry = z.infer<typeof PlanConvergenceDiffEntrySchema>;

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
  /** Producer declarations (ADR-0032 §7e). See docs/schemas.md §326. */
  producers: z.array(PlanDependencyProducerDiffEntrySchema).optional(),
  /** `governance:move` rungs (ADR-0038 §2). See docs/schemas.md §327. */
  governanceMoveRungs: z.array(PlanGovernanceMoveRungDiffEntrySchema).optional(),
  /** Pipeline test/bake hooks. See docs/schemas.md §328. */
  pipelineHooks: z.array(PlanPipelineHookDiffEntrySchema).optional(),
  /** D12 / D25(b). OPTIONAL for the same wire-compatibility reason `pipelineHooks` is: a plan
   *  computed by a build that predates them carries neither key, and an absent key here means the
   *  stack declared none — which, under the ordinary prune rule these two follow, prunes. */
  rollouts: z.array(PlanRolloutDiffEntrySchema).optional(),
  /** ⚠️ A `delete` line here REVOKES ACCESS — the plan is the review surface for that. */
  roleBindings: z.array(PlanRoleBindingDiffEntrySchema).optional(),
  roles: z.array(PlanRoleDiffEntrySchema).optional(),
  convergence: z.array(PlanConvergenceDiffEntrySchema).optional(),
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
