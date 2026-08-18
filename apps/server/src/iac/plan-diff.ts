import type {
  DependencyEcosystem,
  ExecutorType,
  PlanDependencyProducerDiffEntry,
  PlanDiff,
  PlanExecutorBindingDiffEntry,
  PlanExecutorBindingTarget,
  PlanObjectDiffEntry,
  PlanObjectTarget,
  PlanPlacementDiffEntry,
  PlanRelationshipDiffEntry,
  PlanSourceMappingDiffEntry,
  PipelineClassification
} from "@scp/schemas";
import { canonicalJson } from "../graph/objects-repo.js";

/** The relationship type that binds a component to its owning service (migration 0021). */
const CONTAINS_TYPE_ID = "contains";
/** The object type that must always belong to a service (M12 P5a). */
const COMPONENT_TYPE_ID = "component";

/**
 * Pure desired-vs-actual diff engine for `@scp/iac` plans (BUILD_AND_TEST.md §8 M2 item 4,
 * DESIGN.md §15). Takes plain data in, produces plain data out — no DB, no I/O — per
 * BUILD_AND_TEST.md §4.1's "anything testable as a pure function must be written as a pure
 * function" rule (same split as `authz/resolve.ts` vs its integration test). The DB-aware
 * assembly of `PlanDiffSnapshot` (querying live objects/relationships) lives in the thin wrapper,
 * `iac/plans-repo.ts`.
 */

export const MANAGED_BY_LABEL = "scp:managed-by";
export const STACK_LABEL = "scp:stack";
export const MANAGED_BY_IAC_VALUE = "iac";

/**
 * The HUMAN-READABLE MIRROR of stack ownership, merged into every managed row's labels at PLAN time
 * (goal statement — "this happens at PLAN time... not an apply-time surprise").
 *
 * DESCRIPTIVE ONLY SINCE drizzle/0068 — READ BY NOTHING THAT DECIDES ANYTHING. It used to BE the
 * ownership record, which meant the prune target wrote its own match key under plain `object:write`:
 * two label keys enrolled an arbitrary object into a stack's delete pool, or walked an object out of
 * one so its own decommission silently did nothing. Ownership now lives in the server-written
 * `managed_by_stack` column (`iac/stack-ownership.ts`); these keys survive only so operators,
 * dashboards and `scp` output keep the marker they already grep for.
 *
 * They are self-healing rather than protected: a tenant edit makes the object's labels differ from
 * what the manifest merges, so the next plan diffs it as an `update` and the apply rewrites them.
 * Between those two moments the label can lie to a human reader; it can no longer lie to the diff.
 *
 * IF YOU ARE ABOUT TO KEY A DECISION ON THESE, DON'T — read `managed_by_stack` instead. That is the
 * one sentence this whole change exists to make true.
 */
export function managedLabels(stackName: string): Record<string, unknown> {
  return { [MANAGED_BY_LABEL]: MANAGED_BY_IAC_VALUE, [STACK_LABEL]: stackName };
}

/**
 * True if this row is owned by THIS stack — the sole scoping test for pruning (goal statement:
 * "pruning is scoped").
 *
 * TAKES THE COLUMN, NOT THE LABELS, and the signature changed to `string | null` for exactly that
 * reason: a predicate that still ACCEPTED a labels map would let a caller re-introduce the evasion
 * by passing the wrong argument, and it would type-check. There is one input and it is server-written.
 */
export function isStackManaged(
  managedByStack: string | null | undefined,
  stackName: string
): boolean {
  return managedByStack === stackName;
}

/**
 * A manifest object with `domainId` already resolved to a concrete value — `undefined` ("default
 * to the org root") resolved via `graph/objects-repo.ts`'s `resolveDomainId` in `plans-repo.ts`,
 * since that resolution needs a DB read and this function must stay pure. `properties`/`labels`
 * are defaulted to `{}` by the same caller (the raw `ManifestObject` from `@scp/schemas` leaves
 * both optional).
 */
export interface ResolvedManifestObject {
  urn: string;
  typeId: string;
  name: string;
  domainId: string | null;
  properties: Record<string, unknown>;
  labels: Record<string, unknown>;
}

export interface ResolvedManifestRelationship {
  typeId: string;
  fromUrn: string;
  toUrn: string;
}

/**
 * A manifest `sourceMappings` entry with every optional field normalized to the row that will
 * actually be written (`null` patterns, the `configuration` Type default) — so the diff compares
 * like with like and the reviewed entry shows the real row, not the author's shorthand.
 */
export interface ResolvedManifestSourceMapping {
  componentUrn: string;
  sourceKind: string;
  repoPattern: string | null;
  pathPattern: string | null;
  refPattern: string | null;
  type: ExecutorType;
  classification: PipelineClassification | null;
}

/**
 * A manifest `executorBindings` entry, normalized the same way, with `executionSystemId` already
 * resolved from an id-or-URN reference to a real object id by `plans-repo.ts` (a DB read, hence not
 * here). Without that resolution a manifest naming a system by URN would diff as a perpetual
 * `update` against the uuid the table stores — DoD (b)'s "apply twice is a no-op" would be false.
 */
export interface ResolvedManifestExecutorBinding {
  targetUrn: string;
  /** Non-null iff the row hangs off a PLACEMENT (`targetUrn` @ this deployment-target). The diff
   *  must key on the same identity the manifest declared, or a re-plan would never match. */
  deploymentTargetUrn: string | null;
  type: ExecutorType;
  pluginModule: string | null;
  pluginInstanceId: string | null;
  config: Record<string, unknown>;
  secretRefs: Record<string, string>;
  allowedHosts: string[];
  externalRef: string | null;
  executionSystemId: string | null;
}

/** A declared placement (ADR-0026). Identity IS the pair — there is no id or urn to resolve,
 *  which is why this type has no resolution step of its own. */
export interface ResolvedManifestPlacement {
  componentUrn: string;
  deploymentTargetUrn: string;
}

/** A declared `dependency_line_producers` row (ADR-0032 §7e). Identity is `(ecosystem, coordinate)`;
 *  `producerUrn` is the VALUE, which is why this collection has an `update`. Nothing to normalize —
 *  the coordinate is carried verbatim by contract and there are no optional fields. */
export interface ResolvedManifestDependencyProducer {
  producerUrn: string;
  ecosystem: DependencyEcosystem;
  coordinate: string;
}

export interface ResolvedManifest {
  stackName: string;
  objects: ResolvedManifestObject[];
  relationships: ResolvedManifestRelationship[];
  /** ABSENT AND EMPTY ARE THE SAME THING HERE, deliberately — do not "fix" this.
   *
   *  `Stack.synth()` OMITS a collection when it is empty (construct.ts), so an absent key is the
   *  ONLY way an author can express "this stack has no mappings/bindings/placements". If absent
   *  meant "assert nothing, prune nothing", the LAST row in a collection could never be removed
   *  through IaC — you could add the final mapping and never take it away.
   *
   *  `@scp/schemas`'s "an absent collection must not read as 'prune everything'" is about a
   *  pre-C1 or hand-rolled manifest staying VALID, not about suppressing prune. I misread it as the
   *  latter, made absent skip pruning, and broke three `plans.integration` tests that assert exactly
   *  this: `build(false)` synthesizes a manifest with no `sourceMappings` key and expects
   *  `deletes === 2`. The tests were right. */
  sourceMappings: ResolvedManifestSourceMapping[];
  executorBindings: ResolvedManifestExecutorBinding[];
  placements: ResolvedManifestPlacement[];
  /** HERE, AND ONLY HERE, ABSENT AND EMPTY ARE DIFFERENT — `null` vs `[]`. The type is the ruling.
   *
   *  Read the comment on `sourceMappings` above first: for those three collections absent and empty
   *  are the same thing on purpose, and someone already tried to change that and broke three
   *  `plans.integration` tests. THIS ONE DIVERGES, by owner ruling (2026-08-17), and the divergence
   *  is expressed as `| null` rather than as a boolean flag beside an array precisely so a caller
   *  cannot forget to consult it: `computePlanDiff` cannot read the collection without deciding what
   *  `null` means.
   *
   *  `null`  = the manifest had NO `producers` key = this stack manages no producer declarations.
   *            The prune step is skipped ENTIRELY and no diff entries are emitted at all.
   *  `[]`    = the key was present and empty = "I manage producers and declare none" -> prune all.
   *
   *  WHY THE ASYMMETRY IS CORRECT AND MUST SURVIVE THE NEXT SWEEP. For the three above, a
   *  prune-on-absent costs a route or a binding that an operator notices immediately. Here it
   *  returns a coordinate the org PUBLISHES to a public index on a daily poll timer, and the symptom
   *  is an ABSENCE of dependency updates: dependency confusion (ADR-0032 §7b clause 1) re-armed by a
   *  stack that merely forgot a key. The consistency argument is real and it loses to that.
   *
   *  THE ACCEPTED COST, stated where it bites: `Stack.synth()` omits an empty collection, so
   *  "unmanaged" and "I declare none" are indistinguishable in a SYNTHESIZED manifest, and `@scp/iac`
   *  therefore cannot retract a stack's LAST declaration. Use the retract verb (which also reports
   *  the bumps already in flight), or hand-author `"producers": []`. */
  producers: ResolvedManifestDependencyProducer[] | null;
}

export interface ExistingObjectSnapshot {
  urn: string;
  typeId: string;
  name: string;
  domainId: string | null;
  properties: Record<string, unknown>;
  labels: Record<string, unknown>;
  /** drizzle/0068 — the server-written owning stack, or `null`. THE prune-scoping input; `labels`
   *  above is compared for drift and read for nothing else. */
  managedByStack: string | null;
}

export interface ExistingRelationshipTriple {
  typeId: string;
  fromUrn: string;
  toUrn: string;
}

export interface PlanDiffSnapshot {
  /**
   * Live objects the diff needs to reason about, keyed implicitly by `urn` (one entry per live
   * URN). Must cover: every URN referenced by `manifest.objects` that currently exists, every URN
   * referenced as a relationship endpoint (`fromUrn`/`toUrn`, including "external" URNs outside
   * this stack) that currently exists, AND every object whose `managed_by_stack` is this stack
   * (drizzle/0068) regardless of whether it's still in the manifest (prune detection). A superset
   * is harmless — `plans-repo.ts` errs toward fetching more rather than risking a missed
   * prune/create signal.
   */
  existingObjects: ExistingObjectSnapshot[];
  /**
   * Live relationship `(typeId, fromUrn, toUrn)` triples whose `managed_by_stack` is this stack
   * (drizzle/0068) — the exhaustive prune-candidate pool. Anything in here NOT present in
   * `manifest.relationships` becomes a `delete` entry.
   */
  managedRelationships: ExistingRelationshipTriple[];
  /**
   * Live relationship `(typeId, fromUrn, toUrn)` triples that exist for ANY reason (managed by
   * this stack, another stack, or created by hand) — the "does this already exist" pool used for
   * create/noop determination, so a plan never proposes creating a relationship that would 409 at
   * apply time. Overlapping with `managedRelationships` is expected and harmless.
   */
  existingRelationships: ExistingRelationshipTriple[];
  /**
   * Live `source_mappings` rows hanging off an object THIS stack owns, URN-keyed (C1). This is BOTH
   * the prune-candidate pool AND the "does this already exist" pool — ONE pool, because ownership is
   * inherited from the owning object rather than carried on the row (see `@scp/schemas`'s `iac.ts`
   * C1 note): a row on an object this stack owns is this stack's to converge, and a row on any other
   * object is invisible here and therefore unprunable. `plans-repo.ts` builds it; a duplicate tuple
   * (the table has no unique constraint) collapses to one entry here, and pruning removes every
   * duplicate.
   */
  managedSourceMappings: ResolvedManifestSourceMapping[];
  /** Live `executor_bindings` rows hanging off an object THIS stack owns — same one-pool rationale. */
  managedExecutorBindings: ResolvedManifestExecutorBinding[];
  /** Live `placement` objects whose COMPONENT this stack owns (decision Q4) — same one-pool
   *  rationale. Ownership follows the component, not the deployment-target, so a placement at a
   *  target owned by another stack is still this stack's to converge. */
  managedPlacements: ResolvedManifestPlacement[];
  /**
   * Live `dependency_line_producers` rows whose PRODUCER COMPONENT this stack owns — the PRUNE
   * pool, and the only one of the three producer inputs that is ownership-scoped.
   */
  managedDependencyProducers: ResolvedManifestDependencyProducer[];
  /**
   * Live declarations for the coordinates THIS MANIFEST NAMES, regardless of who owns the producer —
   * the "does this coordinate already have a producer" pool, exactly parallel to
   * `existingRelationships` sitting beside `managedRelationships`.
   *
   * TWO POOLS, NOT ONE, AND THE SECOND IS WHAT MAKES A TRANSFER VISIBLE. `dependency_line_producers`
   * is keyed on the COORDINATE, so a declaration can change hands without any row being deleted:
   * `ON CONFLICT (org_id, ecosystem, coordinate) DO UPDATE` silently re-points it. With only the
   * ownership-scoped pool, a manifest claiming a coordinate another stack currently produces would
   * diff as a plain `create` and apply would perform the steal without a word — and the victim stack
   * could never see it, because after the transfer the row is outside ITS pool too. This pool is how
   * the diff learns to say `update` + `displacedProducerUrn`, which is in turn what lets the
   * ownership guard refuse the cross-stack case from the STORED diff at apply time.
   *
   * A coordinate the manifest does not name may be absent here; the diff only ever asks about keys
   * it is converging.
   */
  existingDependencyProducers: ResolvedManifestDependencyProducer[];
}

function relKey(t: ExistingRelationshipTriple): string {
  return `${t.typeId} ${t.fromUrn} ${t.toUrn}`;
}

/** Whole-tuple identity for a source mapping (`ManifestSourceMappingSchema`: no update path). */
/** A placement's identity is the PAIR and nothing else (ADR-0026 D3) — no urn, no id. That is why
 *  there is no `update` action for placements: a changed pair is a DIFFERENT placement, so it
 *  diffs as a delete plus a create rather than an in-place edit. */
function placementKey(p: ResolvedManifestPlacement): string {
  return canonicalJson({
    componentUrn: p.componentUrn,
    deploymentTargetUrn: p.deploymentTargetUrn
  });
}

/**
 * `refPattern` is IN the key and `classification` is deliberately OUT of it (ADR-0030 §1/§2).
 *
 * The ref is a ROUTING discriminator: `refs/heads/dev` → the dev pipeline and `refs/heads/main` →
 * the production one are two legitimate rows differing in nothing else. Leaving it out would make
 * them one key — the second declaration would diff as a `noop` (so the dev pipeline would never be
 * created, silently), and a prune of either would match both.
 *
 * The classification is a descriptive label. Keying on it would turn "relabel this pipeline `dev`"
 * into a delete-plus-create of a LIVE route, which is a real interruption for a cosmetic edit.
 */
/**
 * A producer declaration's identity — `(ecosystem, coordinate)`, mirroring the table's
 * `PRIMARY KEY (org_id, ecosystem, coordinate)`. The PRODUCER IS DELIBERATELY OUT OF THE KEY: it is
 * the row's value, so re-pointing a coordinate is an `update` of one row. Putting the producer in
 * would turn every transfer into a delete-plus-create of the same primary key — two entries whose
 * apply order decides the outcome, for a table that can only hold one of them.
 */
function producerKey(p: { ecosystem: DependencyEcosystem; coordinate: string }): string {
  return canonicalJson({ ecosystem: p.ecosystem, coordinate: p.coordinate });
}

/** How a producer declaration reads in an error message — the coordinate, never the URN slug of it. */
function describeProducerCoordinate(p: {
  ecosystem: DependencyEcosystem;
  coordinate: string;
}): string {
  return `${p.ecosystem} '${p.coordinate}'`;
}

/**
 * THE STAND-IN URN FOR A LIVE DECLARATION WHOSE PRODUCER OBJECT CANNOT BE NAMED — a tombstoned (or
 * hard-deleted) component, which `plans-repo.ts` cannot resolve to a URN because every object read
 * there filters `deleted_at IS NULL`.
 *
 * WHY A SENTINEL AND NOT A DROP. `dependency_line_producers` has no `deleted_at` of its own and
 * `deleteObject` is a SOFT delete, so tombstoning a producer component leaves the declaration
 * STANDING: the coordinate still has a holder, and the next declaration of it is an `ON CONFLICT DO
 * UPDATE` that overwrites that holder. Dropping the row from the existence pool made the diff say
 * `create` — whose reason sentence is literally "no producer is declared for this coordinate — it is
 * polled as third-party today" — for a coordinate that IS declared. The plan an operator reviews
 * would then be false about the single fact that decides whether the apply is a first declaration or
 * a silent overwrite.
 *
 * WHY IT IS NOT THE TOMBSTONED OBJECT'S REAL URN. `invalidProducerDeclarations` refuses a
 * displacement whose URN is not in `diff.objects`; a real URN can legitimately BE there (a manifest
 * still naming the deleted component diffs it as a `create`), which would let the overwrite through
 * on exactly the plan that should be refused. A sentinel is refused by its own named branch instead
 * of by set membership, so no manifest can construct a passing case.
 *
 * NOT a valid address for anything: nothing resolves it, `executePlanDiff` never passes it to
 * `endpointId`, and it appears only in `displacedProducerUrn`, which is read by the guard and by the
 * operator. It satisfies `UrnSchema` because the diff is validated on the way into `plans.diff`.
 */
const UNRESOLVED_PRODUCER_URN_PREFIX = "urn:scp:unresolvable:producer-object:";

/** @see UNRESOLVED_PRODUCER_URN_PREFIX */
export function unresolvedProducerUrn(producerObjectId: string): string {
  return `${UNRESOLVED_PRODUCER_URN_PREFIX}${producerObjectId}`;
}

/** @see UNRESOLVED_PRODUCER_URN_PREFIX */
export function isUnresolvedProducerUrn(urn: string): boolean {
  return urn.startsWith(UNRESOLVED_PRODUCER_URN_PREFIX);
}

function sourceMappingKey(m: ResolvedManifestSourceMapping): string {
  return canonicalJson({
    componentUrn: m.componentUrn,
    sourceKind: m.sourceKind,
    repoPattern: m.repoPattern,
    pathPattern: m.pathPattern,
    refPattern: m.refPattern,
    type: m.type
  });
}

/**
 * A binding's identity — `(target, type)`, mirroring `UNIQUE (org_id, target_object_id, type)`.
 *
 * The two addressings are TAGGED rather than merged into one string. An untagged key would let an
 * object URN and a placement pair collide in principle, and — more practically — makes the key
 * unreadable in a failing diff. `target_object_id` is a single column, so the two forms are two
 * ways of naming one row, never two rows.
 */
function bindingKey(b: {
  targetUrn: string;
  deploymentTargetUrn: string | null;
  type: ExecutorType;
}): string {
  return canonicalJson({
    targetUrn: b.targetUrn,
    deploymentTargetUrn: b.deploymentTargetUrn,
    type: b.type
  });
}

/** As `describeBindingTarget`, for a DIFF entry (whose qualifier is `undefined`, not `null`). */
function describeDiffTarget(b: { targetUrn: string; deploymentTargetUrn?: string }): string {
  return describeBindingTarget({ ...b, deploymentTargetUrn: b.deploymentTargetUrn ?? null });
}

/** How a binding's target reads in an error message. */
function describeBindingTarget(b: {
  targetUrn: string;
  deploymentTargetUrn: string | null;
}): string {
  return b.deploymentTargetUrn ? `placement ${b.targetUrn}@${b.deploymentTargetUrn}` : b.targetUrn;
}

/** The addressing fields to copy onto a diff entry, omitting the qualifier for an object target. */
function bindingAddress(b: { targetUrn: string; deploymentTargetUrn: string | null }): {
  targetUrn: string;
  deploymentTargetUrn?: string;
} {
  return b.deploymentTargetUrn
    ? { targetUrn: b.targetUrn, deploymentTargetUrn: b.deploymentTargetUrn }
    : { targetUrn: b.targetUrn };
}

/**
 * The fields whose drift makes a binding an `update`. MODE-DEPENDENT, and that is load-bearing: for
 * an execution-system-backed binding the module, instance id, config, secret refs and egress
 * allowlist are all SERVER-derived from the system at write time (`bindTargetToExecutionSystem`), so
 * comparing the manifest's (necessarily absent) values against the stored derived ones would make
 * every re-plan an `update` forever — DoD (b)'s "apply the same manifest twice is a no-op" would be
 * false for every Mode A binding. Only what the author actually declares is compared.
 */
function bindingComparisonKey(b: ResolvedManifestExecutorBinding): string {
  if (b.executionSystemId) {
    return canonicalJson({ executionSystemId: b.executionSystemId, externalRef: b.externalRef });
  }
  return canonicalJson({
    pluginModule: b.pluginModule,
    pluginInstanceId: b.pluginInstanceId,
    config: b.config,
    secretRefs: b.secretRefs,
    allowedHosts: b.allowedHosts,
    externalRef: b.externalRef,
    executionSystemId: null
  });
}

function bindingTarget(b: ResolvedManifestExecutorBinding): PlanExecutorBindingTarget {
  return {
    pluginModule: b.pluginModule,
    pluginInstanceId: b.pluginInstanceId,
    config: b.config,
    secretRefs: b.secretRefs,
    allowedHosts: b.allowedHosts,
    externalRef: b.externalRef,
    executionSystemId: b.executionSystemId
  };
}

/**
 * Computes the create/update/delete/noop diff for one `@scp/iac` plan (DESIGN.md §15 —
 * "Kubernetes-apply semantics, not client-side Terraform semantics"). Object identity is the
 * URN; comparison uses the same canonical-JSON-equality discipline as
 * `objects-repo.ts`'s `upsertObjectByUrn` true-idempotency check, so a plan re-computed against
 * unchanged state is always all-noop (BUILD_AND_TEST.md §8 M2 DoD (b)).
 *
 * Relationship diffing is identity-only (does a live `(typeId, fromUrn, toUrn)` triple exist?) —
 * relationship `properties` drift is not diffed in this milestone (a changed relationship is
 * effectively a delete+create the caller must express explicitly in the manifest); documented
 * simplification, not an oversight.
 */
export function computePlanDiff(manifest: ResolvedManifest, snapshot: PlanDiffSnapshot): PlanDiff {
  const existingByUrn = new Map(snapshot.existingObjects.map((o) => [o.urn, o] as const));
  const manifestUrns = new Set(manifest.objects.map((o) => o.urn));

  let creates = 0;
  let updates = 0;
  let deletes = 0;
  let noops = 0;

  const objectEntries: PlanObjectDiffEntry[] = [];

  for (const obj of manifest.objects) {
    const target: PlanObjectTarget = {
      urn: obj.urn,
      typeId: obj.typeId,
      name: obj.name,
      domainId: obj.domainId,
      properties: obj.properties,
      // Merged at PLAN time (module doc) — the diff the caller reviews already shows what apply
      // will write, including any user-supplied labels from the manifest itself.
      labels: { ...obj.labels, ...managedLabels(manifest.stackName) }
    };

    const existing = existingByUrn.get(obj.urn);
    if (!existing) {
      objectEntries.push({
        kind: "object",
        action: "create",
        urn: obj.urn,
        typeId: obj.typeId,
        reason: "no existing object with this URN",
        target
      });
      creates++;
      continue;
    }

    const changedFields: string[] = [];
    if (existing.typeId !== target.typeId) changedFields.push("typeId");
    if (existing.name !== target.name) changedFields.push("name");
    if (existing.domainId !== target.domainId) changedFields.push("domainId");
    if (canonicalJson(existing.properties) !== canonicalJson(target.properties)) {
      changedFields.push("properties");
    }
    if (canonicalJson(existing.labels) !== canonicalJson(target.labels)) {
      changedFields.push("labels");
    }

    if (changedFields.length === 0) {
      objectEntries.push({
        kind: "object",
        action: "noop",
        urn: obj.urn,
        typeId: obj.typeId,
        reason: "matches current state"
      });
      noops++;
    } else {
      objectEntries.push({
        kind: "object",
        action: "update",
        urn: obj.urn,
        typeId: obj.typeId,
        reason: `${changedFields.join(", ")} changed`,
        target
      });
      updates++;
    }
  }

  // Prune: objects this stack managed last time that are no longer in the manifest. Strictly
  // scoped by `isStackManaged` — an object whose server-written `managed_by_stack` is not this
  // stack is never a delete candidate here, even if its URN happens to collide with something
  // (security self-check item 2, goal statement) and even if its LABELS say otherwise. That last
  // clause is drizzle/0068: the labels are a mirror the subject can edit, the column is not.
  for (const existing of snapshot.existingObjects) {
    if (manifestUrns.has(existing.urn)) continue;
    if (!isStackManaged(existing.managedByStack, manifest.stackName)) continue;
    objectEntries.push({
      kind: "object",
      action: "delete",
      urn: existing.urn,
      typeId: existing.typeId,
      reason: "previously managed by this stack, no longer present in the desired manifest"
    });
    deletes++;
  }

  const existingRelSet = new Set(snapshot.existingRelationships.map(relKey));
  const manifestRelKeys = new Set<string>();
  const relationshipEntries: PlanRelationshipDiffEntry[] = [];

  for (const rel of manifest.relationships) {
    const key = relKey(rel);
    manifestRelKeys.add(key);
    if (existingRelSet.has(key)) {
      relationshipEntries.push({
        kind: "relationship",
        action: "noop",
        typeId: rel.typeId,
        fromUrn: rel.fromUrn,
        toUrn: rel.toUrn,
        reason: "matches current state"
      });
      noops++;
      continue;
    }
    const bothEndpointsExist =
      (existingByUrn.has(rel.fromUrn) || manifestUrns.has(rel.fromUrn)) &&
      (existingByUrn.has(rel.toUrn) || manifestUrns.has(rel.toUrn));
    relationshipEntries.push({
      kind: "relationship",
      action: "create",
      typeId: rel.typeId,
      fromUrn: rel.fromUrn,
      toUrn: rel.toUrn,
      reason: bothEndpointsExist
        ? "no existing relationship of this type between these endpoints"
        : "will be created once its endpoint object(s), also created by this plan, exist"
    });
    creates++;
  }

  // Prune: relationships this stack managed last time that are no longer in the manifest — same
  // strict scoping as the object prune above (`managedRelationships` is already filtered to this
  // stack's labels by the caller, `plans-repo.ts`).
  for (const managed of snapshot.managedRelationships) {
    const key = relKey(managed);
    if (manifestRelKeys.has(key)) continue;
    relationshipEntries.push({
      kind: "relationship",
      action: "delete",
      typeId: managed.typeId,
      fromUrn: managed.fromUrn,
      toUrn: managed.toUrn,
      reason: "previously managed by this stack, no longer present in the desired manifest"
    });
    deletes++;
  }

  // -----------------------------------------------------------------------------------------
  // Projection collections (C1). Same converge-then-prune shape as the two above; the difference
  // is only WHERE ownership comes from — the row's owning object, not a label on the row.
  // -----------------------------------------------------------------------------------------

  const existingMappingKeys = new Set(snapshot.managedSourceMappings.map(sourceMappingKey));
  const manifestMappingKeys = new Set<string>();
  const sourceMappingEntries: PlanSourceMappingDiffEntry[] = [];

  for (const mapping of manifest.sourceMappings) {
    const key = sourceMappingKey(mapping);
    // A manifest declaring the same tuple twice would produce two identical create entries and
    // two identical rows on apply — the table has no unique constraint to stop it. Collapse to
    // one; the second declaration is redundant, not a second mapping.
    if (manifestMappingKeys.has(key)) continue;
    manifestMappingKeys.add(key);
    const exists = existingMappingKeys.has(key);
    sourceMappingEntries.push({
      kind: "source-mapping",
      action: exists ? "noop" : "create",
      componentUrn: mapping.componentUrn,
      sourceKind: mapping.sourceKind,
      repoPattern: mapping.repoPattern,
      pathPattern: mapping.pathPattern,
      refPattern: mapping.refPattern,
      type: mapping.type,
      classification: mapping.classification,
      reason: exists ? "matches current state" : "no existing source mapping with this identity"
    });
    if (exists) noops++;
    else creates++;
  }

  // -----------------------------------------------------------------------------------------
  // PLACEMENTS (C1, ADR-0026). Same one-pool shape as source mappings; no `update`, because the
  // pair IS the identity, so a changed pair is a different placement.
  // -----------------------------------------------------------------------------------------
  const existingPlacementKeys = new Set(snapshot.managedPlacements.map(placementKey));
  const manifestPlacementKeys = new Set<string>();
  const placementEntries: PlanPlacementDiffEntry[] = [];

  for (const placement of manifest.placements) {
    const key = placementKey(placement);
    // The unique index would reject a duplicate at apply time; collapsing here means a manifest
    // that says the same thing twice still plans cleanly rather than failing mid-apply.
    if (manifestPlacementKeys.has(key)) continue;
    manifestPlacementKeys.add(key);
    const exists = existingPlacementKeys.has(key);
    placementEntries.push({
      kind: "placement",
      action: exists ? "noop" : "create",
      componentUrn: placement.componentUrn,
      deploymentTargetUrn: placement.deploymentTargetUrn,
      reason: exists ? "matches current state" : "no existing placement for this pair"
    });
    if (exists) noops++;
    else creates++;
  }

  const placementPrunes = [...snapshot.managedPlacements]
    .filter((pl) => !manifestPlacementKeys.has(placementKey(pl)))
    .sort((a, b) => placementKey(a).localeCompare(placementKey(b)));
  const seenPlacementPrunes = new Set<string>();
  for (const managed of placementPrunes) {
    const key = placementKey(managed);
    if (seenPlacementPrunes.has(key)) continue;
    seenPlacementPrunes.add(key);
    placementEntries.push({
      kind: "placement",
      action: "delete",
      componentUrn: managed.componentUrn,
      deploymentTargetUrn: managed.deploymentTargetUrn,
      reason: "managed by this stack but no longer declared"
    });
    deletes++;
  }

  // Prune, sorted by identity so the reviewed diff is stable regardless of row order from the DB.
  const mappingPrunes = [...snapshot.managedSourceMappings]
    .filter((m) => !manifestMappingKeys.has(sourceMappingKey(m)))
    .sort((a, b) => sourceMappingKey(a).localeCompare(sourceMappingKey(b)));
  const seenMappingPrunes = new Set<string>();
  for (const managed of mappingPrunes) {
    const key = sourceMappingKey(managed);
    if (seenMappingPrunes.has(key)) continue; // duplicate rows collapse to one delete entry
    seenMappingPrunes.add(key);
    sourceMappingEntries.push({
      kind: "source-mapping",
      action: "delete",
      componentUrn: managed.componentUrn,
      sourceKind: managed.sourceKind,
      repoPattern: managed.repoPattern,
      pathPattern: managed.pathPattern,
      refPattern: managed.refPattern,
      type: managed.type,
      classification: managed.classification,
      reason:
        "on an object this stack owns, no longer present in the desired manifest's sourceMappings"
    });
    deletes++;
  }

  const existingBindingsByKey = new Map(
    snapshot.managedExecutorBindings.map((b) => [bindingKey(b), b] as const)
  );
  const manifestBindingKeys = new Set<string>();
  const executorBindingEntries: PlanExecutorBindingDiffEntry[] = [];

  for (const binding of manifest.executorBindings) {
    const key = bindingKey(binding);
    // Two declarations for the same (target, type) would race each other through the SAME upsert
    // row: whichever ran last would silently win. `UNIQUE (org_id, target_object_id, type)` says
    // there is exactly one, so a manifest claiming two is malformed desired state, not a
    // precedence question (proposal §11: "a silently-preferred key is how parseTopologyWaves
    // already loses malformed documents"). Rejected outright by `duplicateBindingDeclarations`
    // before this function's output is ever used; the guard here just keeps the diff well-formed.
    if (manifestBindingKeys.has(key)) continue;
    manifestBindingKeys.add(key);

    const existing = existingBindingsByKey.get(key);
    if (!existing) {
      executorBindingEntries.push({
        kind: "executor-binding",
        action: "create",
        ...bindingAddress(binding),
        type: binding.type,
        reason: "no existing executor binding for this target and type",
        target: bindingTarget(binding)
      });
      creates++;
      continue;
    }
    if (bindingComparisonKey(existing) === bindingComparisonKey(binding)) {
      executorBindingEntries.push({
        kind: "executor-binding",
        action: "noop",
        ...bindingAddress(binding),
        type: binding.type,
        reason: "matches current state"
      });
      noops++;
    } else {
      executorBindingEntries.push({
        kind: "executor-binding",
        action: "update",
        ...bindingAddress(binding),
        type: binding.type,
        reason: "binding configuration changed",
        target: bindingTarget(binding)
      });
      updates++;
    }
  }

  const bindingPrunes = [...snapshot.managedExecutorBindings]
    .filter((b) => !manifestBindingKeys.has(bindingKey(b)))
    .sort((a, b) => bindingKey(a).localeCompare(bindingKey(b)));
  for (const managed of bindingPrunes) {
    executorBindingEntries.push({
      kind: "executor-binding",
      action: "delete",
      ...bindingAddress(managed),
      type: managed.type,
      reason:
        "on an object this stack owns, no longer present in the desired manifest's executorBindings"
    });
    deletes++;
  }

  // -----------------------------------------------------------------------------------------
  // DEPENDENCY-LINE PRODUCERS (ADR-0032 §7e). Converge-then-prune like the three above, with ONE
  // divergence and one addition:
  //
  //  - THE DIVERGENCE: `manifest.producers === null` (the manifest had no `producers` key) means
  //    UNMANAGED. The whole block is skipped — no entries, no prune, and the diff carries no
  //    `producers` key at all, so the stored plan itself records that this stack manages none.
  //    Every other collection treats absent as empty; read `ResolvedManifest.producers` for why
  //    this one must not, and do not "fix" the inconsistency.
  //  - THE ADDITION: identity is the COORDINATE, so a declaration changes hands without a delete.
  //    A live declaration by ANOTHER producer is an `update` naming the displaced one, not a
  //    `create` — see `existingDependencyProducers`.
  // -----------------------------------------------------------------------------------------
  let producerEntries: PlanDependencyProducerDiffEntry[] | undefined;
  if (manifest.producers !== null) {
    const entries: PlanDependencyProducerDiffEntry[] = [];
    const existingProducerByKey = new Map(
      snapshot.existingDependencyProducers.map((p) => [producerKey(p), p] as const)
    );
    const manifestProducerKeys = new Set<string>();

    for (const declaration of manifest.producers) {
      const key = producerKey(declaration);
      // Two declarations of one coordinate would race through the SAME primary-key row and the last
      // would silently win — the shape `duplicateProjectionDeclarations` rejects for bindings, for
      // the same reason. Collapsing here only keeps the diff well-formed; the rejection is the
      // caller's, before this output is used.
      if (manifestProducerKeys.has(key)) continue;
      manifestProducerKeys.add(key);

      const existing = existingProducerByKey.get(key);
      if (!existing) {
        entries.push({
          kind: "dependency-producer",
          action: "create",
          ecosystem: declaration.ecosystem,
          coordinate: declaration.coordinate,
          producerUrn: declaration.producerUrn,
          reason: `no producer is declared for ${describeProducerCoordinate(declaration)} — it is polled as third-party today`
        });
        creates++;
        continue;
      }
      if (existing.producerUrn === declaration.producerUrn) {
        entries.push({
          kind: "dependency-producer",
          action: "noop",
          ecosystem: declaration.ecosystem,
          coordinate: declaration.coordinate,
          producerUrn: declaration.producerUrn,
          reason: "matches current state"
        });
        noops++;
        continue;
      }
      entries.push({
        kind: "dependency-producer",
        action: "update",
        ecosystem: declaration.ecosystem,
        coordinate: declaration.coordinate,
        producerUrn: declaration.producerUrn,
        // THE TRANSFER, ON THE ENTRY THE OPERATOR REVIEWS. Also the input the ownership guard needs
        // to refuse a cross-stack steal from the STORED diff at apply time, without re-reading.
        displacedProducerUrn: existing.producerUrn,
        reason: `${describeProducerCoordinate(declaration)} is currently produced by '${existing.producerUrn}' — this plan TRANSFERS it`
      });
      updates++;
    }

    // THE PRUNE, reached only because the key was present. Sorted by identity so the reviewed diff
    // is stable regardless of row order from the DB, exactly like the mapping/placement prunes.
    const producerPrunes = [...snapshot.managedDependencyProducers]
      .filter((p) => !manifestProducerKeys.has(producerKey(p)))
      .sort((a, b) => producerKey(a).localeCompare(producerKey(b)));
    for (const managed of producerPrunes) {
      entries.push({
        kind: "dependency-producer",
        action: "delete",
        ecosystem: managed.ecosystem,
        coordinate: managed.coordinate,
        producerUrn: managed.producerUrn,
        reason:
          "declared on a component this stack owns, no longer present in the desired manifest's " +
          "producers — the coordinate RETURNS TO THIRD-PARTY POLLING"
      });
      deletes++;
    }
    producerEntries = entries;
  }

  return {
    objects: objectEntries,
    relationships: relationshipEntries,
    sourceMappings: sourceMappingEntries,
    executorBindings: executorBindingEntries,
    placements: placementEntries,
    // OMITTED, not `[]`, when the stack manages no producers — the absent key IS the statement.
    ...(producerEntries !== undefined ? { producers: producerEntries } : {}),
    summary: { creates, updates, deletes, noops }
  };
}

/**
 * URNs of components this plan CREATES that have no incoming `contains` edge in the same plan — the
 * strict create-in-service invariant, enforced on the IaC path too (owner ruling 2026-07-16, "make
 * IaC strict"; M12 P5a, docs/proposals/organize-after.md). A component ALWAYS belongs to a service;
 * a manifest that mints one with no owning service is malformed desired state, rejected 400 at
 * plan-compute AND (defense-in-depth, matching every other invariant this module's apply path
 * re-checks) at apply — `plans-repo.ts` is the caller for both.
 *
 * Pure (plain data in, `string[]` out — this module's discipline) so it's unit-testable without a
 * DB. Only object CREATES are checked: updating or reading an already-existing component (including
 * an orphan imported via discovery/accept, which is permissive by design) needs no service, and
 * re-assigning one between services is P5b's `move` verb. A `contains` edge counts whether it is
 * itself being created (the usual case — both endpoints are new) or already live and merely
 * restated as a noop; only a `delete` of the edge does NOT satisfy containment.
 */
/**
 * Human-readable descriptions of any `sourceMappings`/`executorBindings` entry declared TWICE in one
 * manifest (C1). Rejected 400 at plan-compute rather than resolved by precedence: for a binding the
 * two declarations would race through the same `UNIQUE (org_id, target_object_id, type)` row and the
 * last one would silently win; for a mapping the table has no unique constraint, so both would be
 * written and correlation would match a component twice. Proposal §11's rule — "a silently-preferred
 * key is how `parseTopologyWaves` already loses malformed documents" — applied to the same shape.
 *
 * Pure over the RESOLVED manifest (normalized patterns/Types), so `{repoPattern: undefined}` and an
 * omitted `repoPattern` are correctly seen as the same declaration rather than two.
 */
export function duplicateProjectionDeclarations(manifest: ResolvedManifest): string[] {
  const offenders: string[] = [];
  const seenMappings = new Set<string>();
  for (const mapping of manifest.sourceMappings) {
    const key = sourceMappingKey(mapping);
    if (seenMappings.has(key)) {
      offenders.push(
        `sourceMapping ${mapping.sourceKind}:${mapping.repoPattern ?? "*"}:${mapping.pathPattern ?? "*"}` +
          `:${mapping.refPattern ?? "*"} -> ${mapping.componentUrn} (${mapping.type})`
      );
      continue;
    }
    seenMappings.add(key);
  }
  const seenBindings = new Set<string>();
  for (const binding of manifest.executorBindings) {
    const key = bindingKey(binding);
    if (seenBindings.has(key)) {
      offenders.push(`executorBinding ${describeBindingTarget(binding)} (${binding.type})`);
      continue;
    }
    seenBindings.add(key);
  }
  // A coordinate declared twice — to the SAME producer or to two different ones. Both are rejected,
  // and the second is the one that matters: the table holds one row per coordinate, so the two
  // declarations are not two rows but two opinions, and `ON CONFLICT DO UPDATE` would silently keep
  // whichever the array happened to end on. "Declared, never inferred" is worth nothing if WHICH
  // component was declared depends on array order.
  const seenProducers = new Set<string>();
  for (const declaration of manifest.producers ?? []) {
    const key = producerKey(declaration);
    if (seenProducers.has(key)) {
      offenders.push(
        `producer ${describeProducerCoordinate(declaration)} (-> ${declaration.producerUrn})`
      );
      continue;
    }
    seenProducers.add(key);
  }
  return offenders;
}

/** The object type a producer declaration must name — mirrored from `assertDeclarableProducer`. */
const PRODUCER_TYPE_ID = "component";

/**
 * Human-readable descriptions of every producer declaration this plan may not make — the IaC twin of
 * the two refusals `routes/dependency-producers.ts` performs, re-expressed so they can be re-derived
 * from the STORED DIFF at apply time (exactly like `unownedProjectionDeclarations`, and for the same
 * fail-closed reason: a plan computed by an older build must not be trusted).
 *
 * THREE REFUSALS.
 *
 *  1. THE PRODUCER IS NOT AN OBJECT THIS STACK OWNS. `dependency_line_producers` carries no labels,
 *     so ownership is inherited from the producing component — the same rule the projection tables
 *     use. Without this, stack A writes a declaration onto stack B's component: a row A can never
 *     see again (it is outside A's prune pool) and B's next apply prunes one it never declared.
 *
 *  2. THE DISPLACED PRODUCER IS NOT THIS STACK'S EITHER. This one has no analogue in the other
 *     collections and it is the reason `displacedProducerUrn` exists. A producer declaration changes
 *     hands WITHOUT A DELETE — the key is the coordinate, and the table upserts — so refusal (1)
 *     alone lets stack A take `@acme/lib` from stack B's component P by declaring it on A's own
 *     component Q. Refusal (1) passes (Q is A's). The row is then outside B's pool forever: B cannot
 *     prune it, cannot restore it, and no plan of B's ever mentions it again. The coordinate the org
 *     publishes silently changed hands. Transfers are legitimate — through the VERB, which reports
 *     the blast radius and the bumps in flight, or within one stack — but not as a side effect of a
 *     manifest that never names the component it takes from.
 *
 *     AND THE HOLDER MAY BE UNNAMEABLE. A tombstoned producer component leaves its declaration
 *     standing (soft delete; the table has no `deleted_at`), and no object read resolves it to a
 *     URN — so the displacement carries {@link unresolvedProducerUrn} and gets its own refusal
 *     branch. Same act, same reason; only the remedy differs, because there is no stack to hand the
 *     coordinate back to.
 *
 *     "This stack's" here means "appears in `diff.objects` AT ALL", `delete` entries included. A
 *     delete entry can only have come from the label-scoped prune pool, so its presence PROVES
 *     ownership; excluding it would refuse the ordinary "component P is being replaced by Q, and the
 *     coordinate moves with it" manifest, which is a legitimate one-stack transfer.
 *
 *  3. THE PRODUCER IS NOT A `component`. `listProducedLines` derives a head only from the component
 *     a production placement names, so a `service`-valued declaration removes the coordinate from
 *     third-party polling and derives no head at all — the harmful half without the useful one
 *     (ADR-0032 §7e). The typed verb refuses it; this door must too, or IaC is the way around it.
 *
 * `delete` entries are exempt from (1) and (3): a prune entry can only have come from the
 * ownership-scoped pool, and its producer component may legitimately be being deleted by this same
 * plan.
 */
export function invalidProducerDeclarations(diff: PlanDiff): string[] {
  const ownedUrns = new Set<string>();
  const typeByUrn = new Map<string, string>();
  /** Every URN this stack owns OR owned — see refusal (2) on why a `delete` entry counts. */
  const stackUrns = new Set<string>();
  for (const obj of diff.objects) {
    stackUrns.add(obj.urn);
    if (obj.action !== "delete") {
      ownedUrns.add(obj.urn);
      typeByUrn.set(obj.urn, obj.typeId);
    }
  }

  const offenders: string[] = [];
  for (const entry of diff.producers ?? []) {
    const coordinate = `${entry.ecosystem} '${entry.coordinate}'`;
    if (entry.action !== "delete") {
      if (!ownedUrns.has(entry.producerUrn)) {
        offenders.push(
          `producer ${coordinate} -> ${entry.producerUrn}, which this stack does not manage`
        );
        continue;
      }
      const typeId = typeByUrn.get(entry.producerUrn);
      if (typeId !== PRODUCER_TYPE_ID) {
        offenders.push(
          typeId === "service"
            ? `producer ${coordinate} -> ${entry.producerUrn}, which is a SERVICE — a service-valued ` +
                `declaration is refused in the first cut (ADR-0032 §7e): it would remove the coordinate ` +
                `from third-party polling and derive no head at all. Declare the component that ` +
                `publishes the artifact`
            : `producer ${coordinate} -> ${entry.producerUrn}, which is a ${typeId ?? "non-object"}, not a component`
        );
        continue;
      }
    }
    if (entry.displacedProducerUrn && isUnresolvedProducerUrn(entry.displacedProducerUrn)) {
      // REFUSAL (2b) — the same displacement, with the holder unnameable. Its own branch rather than
      // set membership: see {@link UNRESOLVED_PRODUCER_URN_PREFIX} for why a real URN here could be
      // made to pass the membership test on precisely the plan that must be refused.
      offenders.push(
        `producer ${coordinate} is currently declared on a producer object that no longer resolves ` +
          `(${entry.displacedProducerUrn}) — the component was deleted and the declaration outlived ` +
          `it, so this plan would OVERWRITE a standing declaration rather than make a first one. ` +
          `Retract it through POST /dependencies/producers/retract, which reports the bumps already ` +
          `in flight, and then declare`
      );
    } else if (entry.displacedProducerUrn && !stackUrns.has(entry.displacedProducerUrn)) {
      offenders.push(
        `producer ${coordinate} is currently produced by ${entry.displacedProducerUrn}, which this ` +
          `stack does not manage — a transfer away from another stack's component must go through ` +
          `POST /dependencies/producers, which reports the blast radius and the bumps in flight`
      );
    }
  }
  return offenders;
}

/**
 * Human-readable descriptions of any `sourceMappings`/`executorBindings` entry this plan would WRITE
 * whose owning object the stack does not own (C1) — the enforcement half of the ownership-scoping
 * decision documented in `@scp/schemas`'s `iac.ts`.
 *
 * WHY IT MUST EXIST. Neither projection table carries an owner of its own, so ownership is
 * inherited from the graph object the row hangs off. Inheritance only scopes pruning if the converse
 * also holds: a stack may only WRITE a row onto an object it owns. Without this, stack A could
 * create or update a binding on stack B's component — a row A can never see again (it is outside A's
 * prune pool, because the object's `managed_by_stack` is B), so A can never remove it and B's next
 * apply prunes a row it never declared. Refusing the write is what keeps ownership single-valued in
 * both directions, and it is what makes "a stack never touches another stack's rows" true rather
 * than merely true-for-deletes.
 *
 * DERIVED PURELY FROM THE DIFF, exactly like `uncontainedComponentCreates`, so `plans-repo.ts` can
 * re-run it at APPLY time against the STORED diff without re-reading the graph — defence in depth
 * against a plan computed by an older build. An object entry with any action other than `delete` is
 * an object this stack will own once the plan applies (the diff carries an entry for every manifest
 * object, and apply stamps `managed_by_stack = <stack>` on each — drizzle/0068). A `delete` mapping
 * or binding entry is exempt: it can only have come from the prune pool, which is already
 * ownership-scoped, and its owning object may legitimately be being deleted by this same plan.
 */
export function unownedProjectionDeclarations(diff: PlanDiff): string[] {
  const ownedUrns = new Set<string>();
  for (const obj of diff.objects) {
    if (obj.action !== "delete") ownedUrns.add(obj.urn);
  }
  const offenders: string[] = [];
  for (const mapping of diff.sourceMappings ?? []) {
    if (mapping.action === "delete") continue;
    if (!ownedUrns.has(mapping.componentUrn)) {
      offenders.push(`sourceMapping -> ${mapping.componentUrn}`);
    }
  }
  // A placement this plan will own once applied. `noop` counts: the pair is already live AND
  // declared, so it survives the prune. `delete` does not — see the second check below.
  const declaredPlacements = new Set<string>();
  for (const placement of diff.placements ?? []) {
    if (placement.action !== "delete") {
      declaredPlacements.add(
        canonicalJson([placement.componentUrn, placement.deploymentTargetUrn])
      );
    }
  }

  for (const binding of diff.executorBindings ?? []) {
    if (binding.action === "delete") continue;
    // ONE unconditional ownership rule for both shapes, which is the point of expressing a placement
    // as a QUALIFIER on `targetUrn` rather than as an alternative to it: for a placement-targeted
    // binding `targetUrn` IS the component, and ownership follows the component (decision Q4).
    if (!ownedUrns.has(binding.targetUrn)) {
      offenders.push(`executorBinding -> ${describeDiffTarget(binding)} (${binding.type})`);
      continue;
    }
    // The pair must ALSO survive this plan. Apply runs binding-prune, placement-prune,
    // placement-create, binding-create in that order, so a binding declared on a pair the manifest
    // does not declare would be written onto a placement the SAME apply just pruned — failing at the
    // resolve step, mid-apply, after other writes had landed. Refusing here turns that into a
    // plan-time error naming both halves.
    if (
      binding.deploymentTargetUrn &&
      !declaredPlacements.has(canonicalJson([binding.targetUrn, binding.deploymentTargetUrn]))
    ) {
      offenders.push(
        `executorBinding -> ${describeDiffTarget(binding)} (${binding.type}), whose pair this manifest does not declare in placements`
      );
    }
  }
  return offenders;
}

export function uncontainedComponentCreates(diff: PlanDiff): string[] {
  const containedToUrns = new Set<string>();
  for (const rel of diff.relationships) {
    if (rel.typeId === CONTAINS_TYPE_ID && rel.action !== "delete") containedToUrns.add(rel.toUrn);
  }
  const offenders: string[] = [];
  for (const obj of diff.objects) {
    if (
      obj.action === "create" &&
      obj.typeId === COMPONENT_TYPE_ID &&
      !containedToUrns.has(obj.urn)
    ) {
      offenders.push(obj.urn);
    }
  }
  return offenders;
}
