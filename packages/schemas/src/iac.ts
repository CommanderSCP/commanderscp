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
  /** DECLARED reach (§10.6, migration 0066): `global` | `domain`. Outside the identity tuple, like
   *  the three above — but unlike them it IS converged on an existing row: a declared scope that
   *  differs from the live row's diffs as an `update` (`PlanSourceMappingDiffEntrySchema.action`),
   *  and apply writes it in place. Three states, deliberately: OMITTED ⇒ this manifest does not
   *  manage the scope (a manifest that has never heard of the field never clears a scope an operator
   *  set by hand); explicit `null` ⇒ declare it undeclared (clear a stale label); a value ⇒ that. */
  scope: SourceMappingScopeSchema.nullable().optional()
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

/**
 * A `dependency_line_producers` row (ADR-0032 §7e): "this component's production releases are where
 * this coordinate's versions come from". The IaC form of `POST /dependencies/producers`.
 *
 * IDENTITY IS `(ecosystem, coordinate)` — the table's natural key — and the PRODUCER IS THE VALUE.
 * That is why this collection has an `update` action where `sourceMappings` and `placements` do not:
 * re-pointing `@acme/lib` from component P to component Q is one row changing, not a delete and a
 * create, and the table's own `ON CONFLICT (org_id, ecosystem, coordinate) DO UPDATE` says so.
 *
 * OWNERSHIP is the PRODUCER COMPONENT's stack, the same inheritance rule `sourceMappings` uses (this
 * table has no `labels` column either). Two refusals follow, both at `POST /plans` and again at
 * apply:
 *   1. a declaration whose producer this stack does not own; and
 *   2. a declaration that would DISPLACE a live one whose current producer this stack does not own.
 * (2) is not symmetry for its own sake. Without it, stack A could take `@acme/lib` from stack B's
 * component: B's ownership pool is keyed on B's own components, so after the theft the coordinate is
 * invisible to B — B can neither prune it nor restore it, and nothing in B's plan output ever says
 * it left. That is the same "a stack never touches another stack's rows" rule the projection tables
 * already have, applied to the one collection where a row can change hands without being deleted.
 *
 * THE PRODUCER MUST BE A `component`. A `service` is refused with the reason
 * `DeclareDependencyLineProducerRequestSchema` gives: internal head derivation reads the COMPONENT a
 * production placement names, so a service-valued declaration removes the coordinate from
 * third-party polling and derives no head at all — the harmful half without the useful one.
 */
export const ManifestDependencyProducerSchema = z.object({
  /** URN of the producing COMPONENT. Must be an object THIS stack owns, and must be a `component`. */
  producerUrn: UrnSchema,
  ecosystem: DependencyEcosystemSchema,
  /** Carried VERBATIM — never slugified, never lowercased. `@acme/lib`, `github.com/acme/lib` and
   *  `docker.io/library/alpine` are three coordinates that share nothing but a URN slug. */
  coordinate: DependencyCoordinateSchema
});
export type ManifestDependencyProducer = z.infer<typeof ManifestDependencyProducerSchema>;

/**
 * A `governance_move_rungs` row (ADR-0038 §2, proposal governance-reach-on-containment-move.md §9.6
 * Q4): "every containment move under this container needs `governance:move` at BOTH ends". The IaC
 * form of `PUT /governance/move-enforcement/rungs/{idOrUrn}`.
 *
 * IDENTITY IS THE SUBJECT and there is deliberately no value: a rung is either enabled at a
 * container or it is not, so this collection has `create`/`delete`/`noop` and no `update` — the same
 * identity-only treatment `placements` gets, for the same reason. The TIER is DERIVED from the
 * subject's object type (`moveRungTierForObjectType`) and is never declared: a manifest that could
 * name a tier could name one the subject is not, and the stored literal would then describe a
 * containment shape the rest of the system does not believe in.
 *
 * OWNERSHIP is the SUBJECT CONTAINER's stack — this table has no `labels` column either, so the same
 * inheritance rule `sourceMappings`/`producers` use applies, and the same refusal follows at both
 * `POST /plans` and apply: a rung declared on an object this stack does not manage is rejected 400.
 * That is what stops two stacks enabling and pruning each other's rungs. The practical consequence:
 * a rung on the ORG ROOT (or on a container another stack owns) is authored through the API/CLI, not
 * through a manifest.
 *
 * THE SUBJECT MUST BE A CONTAINER — the org root, a containment domain, a service or an assembly. A
 * component is refused for the reason `assertRungSubjectType` gives: a rung governs moves of the
 * things INSIDE a container, and nothing is contained by a component, so the rung would govern the
 * empty set of moves.
 *
 * AUTHORITY IS `policy:write` AT-OR-ABOVE THE SUBJECT, checked at apply against the REAL applying
 * principal — the same bar `PUT /governance/move-enforcement/rungs/{idOrUrn}` takes, imported from
 * one definition so the two doors cannot drift.
 */
export const ManifestGovernanceMoveRungSchema = z.object({
  /** The container the rung sits on — an object id OR a URN. It must be an object THIS stack
   *  declares (ownership is inherited from it), and must be a type that can carry a rung. */
  subjectIdOrUrn: z.string().min(1).max(512)
});
export type ManifestGovernanceMoveRung = z.infer<typeof ManifestGovernanceMoveRungSchema>;

/** ROLE BINDINGS AND CUSTOM ROLES IN A MANIFEST. See docs/schemas/iac.md §1. */
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
  /** C1 (ADR-0026). OPTIONAL for the same reason as the two above — but note what "optional" does
   *  and does NOT mean. It keeps a pre-C1 manifest VALID; it does not suppress pruning. `Stack.synth()`
   *  omits a collection when it is empty, so absent is the only way to say "this stack declares no
   *  placements", and it therefore prunes exactly as an empty array does. (`plan-diff.ts`'s
   *  `ResolvedManifest` carries the long form of this; I once read it the other way and broke three
   *  prune tests.) A PRESENT one is authoritative for the
   *  components this stack owns — removing an entry deletes that placement (decision Q3), which is
   *  safe only because a placement still carrying an executor binding is REFUSED rather than
   *  cascaded (decision Q2). Those two rulings are load-bearing together. */
  placements: z
    .array(ManifestPlacementSchema)
    .optional()
    .describe(
      "Placements this stack declares. A PRESENT collection is authoritative and prunes; an ABSENT one is " +
        "the same as an empty one and prunes too (Stack.synth() omits an empty collection). Note that " +
        "'producers' deliberately does NOT follow this rule — read its own description."
    ),
  /**
   * ===========================================================================================
   * ABSENT MEANS **UNMANAGED**, AND THIS DELIBERATELY DIVERGES FROM THE THREE COLLECTIONS ABOVE
   * ===========================================================================================
   * For `sourceMappings`, `executorBindings` and `placements`, an absent key and an empty array are
   * the same thing and both PRUNE — `apps/server/src/iac/plan-diff.ts` says so at length and records
   * that changing it broke three `plans.integration` tests. DO NOT "fix" this collection to match
   * them. The asymmetry is the ruling (owner, 2026-08-17), and the reason is the blast radius, not
   * consistency:
   *
   *   - Pruning a mapping, a binding or a placement costs a route or a pipeline an operator notices
   *     the same day.
   *   - Pruning a producer declaration returns a coordinate the org PUBLISHES to a PUBLIC INDEX on a
   *     daily poll timer. The symptom is an ABSENCE of dependency updates, and the failure mode is
   *     dependency confusion (ADR-0032 §7b clause 1) re-armed by a stack that merely FORGOT A KEY.
   *
   * So: key absent  -> this stack manages no producer declarations. NOTHING is pruned, ever.
   *     key present -> this stack is authoritative over the declarations it names, AND over any
   *                    declaration whose producer is a component this stack owns. Removing an entry
   *                    from a present collection DOES prune it (see below).
   *
   * ===========================================================================================
   * IS A PRESENT COLLECTION AUTHORITATIVE OVER ITS OWN MEMBERS? YES — AND HERE IS THE ALGORITHM
   * ===========================================================================================
   * Removing entry B from `[A, B]` DOES prune B. `computePlanDiff`'s prune step is the same one every
   * other collection gets — `pool.filter(row => !manifestKeys.has(key(row)))`, where `pool` is the
   * declarations whose producer this stack owns. The ONLY thing the absent case changes is that the
   * prune step is SKIPPED ENTIRELY; nothing else in the algorithm distinguishes one member from
   * another. So the catastrophic case ("the whole key vanished") manages nothing, and the ordinary
   * case ("I removed one of my three") is real, reviewable management.
   *
   * ===========================================================================================
   * THE CONSEQUENCE: IaC CANNOT RETRACT THE **LAST** DECLARATION THROUGH `@scp/iac`
   * ===========================================================================================
   * `Stack.synth()` OMITS a collection when it is empty, so a program that declares no producers and
   * a program that declares none ANY MORE synthesize byte-identical manifests. Under the rule above
   * both mean "unmanaged", so deleting your only `producesDependency(...)` call leaves the
   * declaration standing. That is an ACCEPTED COST, not an oversight — the alternative is a forgotten
   * key silently re-arming dependency confusion.
   *
   * To retract, in order of preference:
   *   1. `POST /dependencies/producers/retract` (`scp dependency producer retract`). Preferred even
   *      when IaC could do it: only the verb reports the bumps SCP has already authored and cannot
   *      recall.
   *   2. Remove the entry while OTHER entries remain — the key stays present, so the prune fires.
   *   3. Hand-author `"producers": []` and POST it to `/plans`. Present-and-empty is a deliberate
   *      statement ("I manage producers, and I declare none"), so it prunes every declaration on a
   *      component this stack owns. `@scp/iac` cannot emit this; a hand-written manifest can.
   */
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
  /**
   * ===========================================================================================
   * ABSENT MEANS **UNMANAGED**, THE SAME DIVERGENCE `producers` MAKES AND FOR THE SAME KIND OF
   * REASON (proposal governance-reach-on-containment-move.md §9.6 Q4)
   * ===========================================================================================
   * Read `producers` above first: absent and empty are the same thing for `sourceMappings`,
   * `executorBindings` and `placements`, and both PRUNE. These two collections diverge, because the
   * blast radius of a forgotten key is not "a route an operator notices the same day":
   *
   *   - Pruning a rung DISABLES a governance bar. The symptom is an ABSENCE of refusals — moves that
   *     should have been refused quietly succeeding — and nothing surfaces it until somebody audits
   *     where a governed object ended up. A stack that merely FORGOT A KEY must not un-govern a
   *     subtree an operator deliberately governed.
   *
   * So: key absent  -> this stack manages no rungs. NOTHING is disabled, ever.
   *     key present -> this stack is authoritative over the rungs it names, AND over any rung whose
   *                    subject is an object this stack owns. Removing an entry from a present
   *                    collection DOES disable it.
   *
   * AND `@scp/iac` THEREFORE CANNOT DISABLE THE **LAST** RUNG: `Stack.synth()` omits an empty
   * collection, so a program that declares no rungs and one that declares none ANY MORE synthesize
   * byte-identical manifests. Accepted cost, identical to `producers`. To disable, use
   * `DELETE /governance/move-enforcement/rungs/{idOrUrn}` (`scp governance move-enforcement
   * disable`), remove the entry while OTHER entries remain, or hand-author
   * `"governanceMoveRungs": []`.
   *
   * A DISABLE MAY STILL BE REFUSED. The lattice is monotone (ADR-0038 §2): a rung whose ancestor —
   * or the instance rung — is enabled cannot be disabled below, so a manifest that drops such an
   * entry fails its apply with the 409 the verb gives, naming the upper rung. That is deliberate:
   * reporting a successful disable that leaves every move under the subtree enforced anyway is the
   * worst of both.
   */
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
  /**
   * ===========================================================================================
   * THE THIRD `ABSENT MEANS **UNMANAGED**` COLLECTION — read `producers` and `governanceMoveRungs`
   * above first, because this follows their rule and NOT the rule of the three collections above
   * them (docs/proposals/team-pipeline-iac.md D11/D21).
   * ===========================================================================================
   * The test is not consistency, it is blast radius, and a pipeline hook fails the same test a
   * governance rung fails:
   *
   *   - Pruning a mapping, a binding or a placement costs a route or a pipeline an operator
   *     notices the same day.
   *   - Pruning a HOOK disarms a gate. A `postDeploy` entry that vanishes stops gating every
   *     wave's exit; a `bakeAlarms` entry that vanishes stops holding the widening. The symptom in
   *     both cases is an ABSENCE — of refusals, of holds, of anything at all — and nothing
   *     surfaces it until a bad release walks the whole fleet unimpeded. That is precisely the
   *     argument `governanceMoveRungs` makes one field up, and it applies here without weakening.
   *
   * So: key absent  -> this stack manages no hooks. NOTHING is disarmed, ever.
   *     key present -> this stack is authoritative over the hooks it names, AND over any hook on a
   *                    component this stack owns. Removing an entry from a present collection DOES
   *                    prune it, visible as a delete line in the plan.
   *
   * AND `@scp/iac` THEREFORE CANNOT REMOVE THE **LAST** HOOK, the identical accepted cost:
   * `Stack.synth()` omits an empty collection, so a pipeline that declares no hooks and one that
   * declares none ANY MORE synthesize byte-identical manifests. Remove an entry while others
   * remain, or hand-author `"pipelineHooks": []`.
   *
   * IDENTITY is `(componentUrn, kind, hookId)` — no update path keyed on a subset, so a changed
   * hook is a delete + create, exactly as a changed source mapping is. Declaring one tuple twice in
   * a manifest is rejected.
   */
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
  /**
   * ORDINARY RULE (absent = empty = prune), unlike `pipelineHooks` directly above — and the
   * divergence is deliberate rather than an oversight, so here is the test being applied.
   *
   * Dropping a rollout declaration does not disarm a safety bar. For a coordinated executor the
   * rollout is the executor's own (D12: SCP's declaration is `triggerParams` or `verified`, never
   * the thing that performs it), so what is lost when the declaration goes is SCP's
   * declared-vs-observed divergence WARNING — the artifact still rolls out under the team's own
   * Argo Rollouts spec. That is a real loss and a visible one (the plan shows the delete line), but
   * it is not the silent un-gating that earns an exception. Three exceptions to one rule would
   * make the exception the rule.
   *
   * Identity is `(componentUrn, targetClass)`.
   */
  /**
   * ORDINARY RULE (absent = empty = prune), same shape of reasoning as `rollouts` below: a dropped
   * binding is a REVOCATION — visible on the plan line, and a NARROWING rather than a silent
   * un-gating. The dangerous direction for a role binding is granting, and a forgotten key cannot
   * grant anything.
   *
   * Identity is `(subjectUrn, roleName, scopeUrn)` — the same triple `role_bindings_grant_key`
   * (drizzle/0097) makes unique, so a manifest cannot express two bindings the database would
   * collapse into one.
   */
  roleBindings: z.array(ManifestRoleBindingSchema).optional(),
  /**
   * ORDINARY RULE. Identity is `name` within the org.
   *
   * A DELETE here is refused by the API while any binding still points at the role, so a manifest
   * dropping a role whose bindings live elsewhere fails loudly at apply rather than performing an
   * unreviewable mass revoke (`routes/role-bindings.ts`'s delete door).
   */
  roles: z.array(ManifestRoleSchema).optional(),
  rollouts: z.array(ManifestRolloutSchema).optional(),
  /**
   * ORDINARY RULE, for a second and simpler reason: D25 has synth write `converge` EXPLICITLY
   * whenever a configuration pipeline places at a product, so an absent collection means this stack
   * declares no such pipeline at all — there is nothing for a forgotten key to silently switch off.
   *
   * Identity is `(componentUrn, targetUrn)`.
   */
  convergence: z.array(ManifestConvergenceSchema).optional()
});
export type DesiredStateManifest = z.infer<typeof DesiredStateManifestSchema>;

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
  target: PlanObjectTargetSchema.optional(),
  /**
   * ADOPTION (§9) — this entry claims an object that ALREADY EXISTS and was managed by NO stack.
   *
   * A QUALIFIER ON THE EXISTING ACTION, not a new `action` value, and the reason is measured rather
   * than stylistic: adding a member to a response ENUM is a breaking change under the oasdiff gate
   * (response enum-value additions are breaking; `oneOf` member additions are not), so an `"adopt"`
   * action would have cost an `api-v2-exception` for a distinction that is genuinely a property OF
   * a create/update rather than a third kind of thing. An optional boolean is additive.
   *
   * Absent or `false` means the object was already this stack's, or is being created fresh. `true`
   * means a review is looking at a stack CLAIMING EXISTING ESTATE — which §9 requires be visible,
   * because it is the one action whose blast radius is invisible from the manifest alone.
   */
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

/** One `source_mappings` row's verdict. See docs/schemas/iac.md §2. */
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

/**
 * One `dependency_line_producers` row's verdict, keyed on `(ecosystem, coordinate)` — the table's own
 * natural key, which is why this is the one projection collection with an `update`: the producer is
 * the row's VALUE, so re-pointing a coordinate is an in-place change, not a delete plus a create.
 *
 * READ `action: "create"` CAREFULLY. It means "no producer is declared for this coordinate at all".
 * A coordinate that already has one and is being re-pointed is an `update` carrying
 * {@link displacedProducerUrn}, whether or not the displaced producer belongs to this stack — the
 * diff states what is true about the coordinate, and the ownership guard is what refuses the
 * cross-stack case. A plan that silently reported `create` for a transfer would be a plan whose most
 * consequential fact is missing from the thing the operator reviews.
 */
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

/**
 * One `governance_move_rungs` row's verdict, keyed on the SUBJECT container. No `update`: a rung has
 * no value beyond its existence (the tier is derived from the subject's type), so the only verdicts
 * are enable, disable and "already enabled" — the same identity-only treatment
 * {@link PlanPlacementDiffEntrySchema} gets.
 *
 * `subjectUrn` is the RESOLVED URN of whatever the manifest addressed by id-or-URN, so the entry an
 * operator reviews names the container in the same vocabulary every other entry uses, and the apply
 * path resolves it exactly like any other endpoint.
 */
export const PlanGovernanceMoveRungDiffEntrySchema = z.object({
  kind: z.literal("governance-move-rung"),
  action: z.enum(["create", "delete", "noop"]),
  subjectUrn: UrnSchema,
  reason: z.string()
});
export type PlanGovernanceMoveRungDiffEntry = z.infer<typeof PlanGovernanceMoveRungDiffEntrySchema>;

/** One `pipeline_hooks` row's verdict (D11/D21). See docs/schemas/iac.md §3. */
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

/** D12 — one rollout declaration's diff entry. See docs/schemas/iac.md §4. */
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

/** One role binding's diff entry. See docs/schemas/iac.md §5. */
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
  /** Producer declarations (ADR-0032 §7e). See docs/schemas/iac.md §6. */
  producers: z.array(PlanDependencyProducerDiffEntrySchema).optional(),
  /** `governance:move` rungs (ADR-0038 §2). See docs/schemas/iac.md §7. */
  governanceMoveRungs: z.array(PlanGovernanceMoveRungDiffEntrySchema).optional(),
  /** Pipeline test/bake hooks (D11/D21). See docs/schemas/iac.md §8. */
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
