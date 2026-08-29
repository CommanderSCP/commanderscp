import type {
  DependencyEcosystem,
  ExecutorType,
  PlanDependencyProducerDiffEntry,
  PlanDiff,
  PlanExecutorBindingDiffEntry,
  PlanExecutorBindingTarget,
  PlanGovernanceMoveRungDiffEntry,
  PlanObjectDiffEntry,
  PlanObjectTarget,
  PlanConvergenceDiffEntry,
  PlanPipelineHookDiffEntry,
  PlanPlacementDiffEntry,
  PlanRolloutDiffEntry,
  PlanRoleBindingDiffEntry,
  PlanRoleDiffEntry,
  PlanRelationshipDiffEntry,
  PlanSourceMappingDiffEntry,
  PipelineClassification,
  PipelineHookKind,
  SourceMappingScope,
  WorkflowRef
} from "@scp/schemas";
import { canonicalJson } from "../graph/objects-repo.js";
import { moveRungTierForObjectType } from "../governance/move-enforcement.js";

/** The relationship type that binds a component to its owning service (migration 0021).
 *  EXPORTED because `plans-repo.ts`'s apply path has to ask the same question at its door — a
 *  second string literal one module over is how one of the two comes to mean something else. */
export const CONTAINS_TYPE_ID = "contains";
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
/**
 * STACK THEFT — a manifest claiming an object another stack already manages (§9: "adopting an
 * object already managed by a DIFFERENT stack is refused (409) — stack theft is not a merge").
 *
 * ================================================================================================
 * WHAT THIS CLOSES, MEASURED ON THE TREE BEFORE IT EXISTED
 * ================================================================================================
 * `stampObjectStackOwnership`'s predicate is `managed_by_stack IS NULL OR <> $stack`, so an apply
 * re-stamped ANY object in its diff — including one another stack owned. Its own header states the
 * consequence plainly and treats it as the design ("the only other way out would be another stack
 * declaring it — which is a `create`/`update`/`noop` in that stack's diff, i.e. a re-stamp by this
 * same function"). The effect: a manifest that names a foreign URN takes the object over silently,
 * and the LOSING stack's next apply then proposes deleting rows it no longer owns, or proposes
 * nothing at all for an object it still believes it manages.
 *
 * ADOPTION OF AN *UNMANAGED* OBJECT REMAINS LEGAL AND IS THE POINT — it is how an existing estate
 * comes under IaC (§9, and `scp iac export`'s whole purpose). Only the cross-stack case is refused.
 * The two are distinguished by reading `managed_by_stack`, which is server-written and, unlike the
 * labels it replaced, not writable by the subject of the decision.
 */
export class StackOwnershipConflictError extends Error {
  constructor(
    readonly conflicts: readonly { urn: string; ownedBy: string }[],
    readonly stackName: string
  ) {
    super(
      `stack '${stackName}' declares ${conflicts.length} object(s) already managed by another ` +
        `stack: ` +
        conflicts.map((c) => `'${c.urn}' (owned by '${c.ownedBy}')`).join(", ") +
        ` — adopting an object another stack manages is refused; remove it from that stack's ` +
        `manifest first, or declare it under the stack that owns it`
    );
    this.name = "StackOwnershipConflictError";
  }
}

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
  /** Declared mirror-of-shared provenance (outpost-ui.md §9.3a) — descriptive like
   *  `classification`, and like it NOT part of `sourceMappingKey`: a mapping whose declared
   *  provenance changed is the same mapping, not a delete + create. */
  mirrorOfShared: boolean;
  /** The pause switch (migration 0063) — like `classification`/`mirrorOfShared`, NOT part of
   *  `sourceMappingKey`: disabling a live mapping is an in-place correction, not a delete + create
   *  of the route. (It IS an enforcement input at the correlation matcher — but that read happens
   *  off the live table, never off this diff, so it has no bearing on identity here.) */
  enabled: boolean;
  /** Declared reach (migration 0066, §10.6) — an attribute, NOT part of `sourceMappingKey`, but the
   *  ONE attribute this diff CONVERGES on an existing tuple (an `update` verdict; apply sets it in
   *  place on every row sharing the tuple). Three states on the DESIRED side: `undefined` = this
   *  manifest does not manage the scope (never proposes an update, and a create writes NULL);
   *  `null` = declare it undeclared (clears a label); a value = that value. On the ACTUAL side
   *  (`managedSourceMappings`) always `null` or a value — what the row holds. */
  scope?: SourceMappingScope | null;
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

/**
 * A declared pipeline hook (D11/D21, migration 0096). IDENTITY is `(componentUrn, hookKind, hookId)`
 * — the table's own `pipeline_hooks_identity` — but the DIFF keys on the whole declaration
 * ({@link pipelineHookKey}), because a hook has no attribute that converges in place: a `stage` or
 * `maxAgeSeconds` that moved is a different gate, and `ManifestPipelineHookSchema` states the
 * consequence ("a changed hook is a delete + create").
 *
 * Every per-kind field is NORMALIZED to `null` here rather than left `undefined`, so the ACTUAL side
 * (rows read back from a table whose per-kind columns are nullable) and the DESIRED side (a
 * discriminated union whose members simply lack the fields they do not use) key identically. Without
 * that, a `postMerge` hook would key one way from the manifest and another from the database and
 * every plan would propose a delete plus a create for a hook that never changed.
 */
export interface ResolvedManifestPipelineHook {
  componentUrn: string;
  /** The hook's own kind. Named `hookKind` for the reason `PlanPipelineHookDiffEntrySchema` gives:
   *  `kind` is already the discriminant every diff entry carries. */
  hookKind: PipelineHookKind;
  hookId: string;
  workflow: WorkflowRef | null;
  stage: string | null;
  everySeconds: number | null;
  maxAgeSeconds: number | null;
  quietWindowSeconds: number | null;
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
  /** THE SECOND `| null` COLLECTION, and it is null for the same KIND of reason `producers` is —
   *  read that comment first (proposal governance-reach-on-containment-move.md §9.6 Q4).
   *
   *  `null`  = the manifest had NO `governanceMoveRungs` key = this stack manages no rungs. The
   *            prune step is skipped ENTIRELY and no diff entries are emitted at all.
   *  `[]`    = the key was present and empty = "I manage rungs and declare none" -> disable all.
   *
   *  A rung is a governance BAR: pruning one on a forgotten key un-governs a subtree, and the
   *  symptom is an ABSENCE of refusals — moves that should have been refused quietly succeeding,
   *  which nothing surfaces until somebody audits where a governed object ended up. Same accepted
   *  cost as `producers`: `Stack.synth()` omits an empty collection, so `@scp/iac` cannot disable a
   *  stack's LAST rung; use `DELETE /governance/move-enforcement/rungs/{idOrUrn}` or hand-author
   *  `"governanceMoveRungs": []`.
   *
   *  Each member is the SUBJECT CONTAINER'S URN — the whole identity. A rung has no value beyond
   *  existing, and its TIER is derived from the subject's object type, never declared. */
  governanceMoveRungs: string[] | null;
  /** THE THIRD `| null` COLLECTION, null for the same KIND of reason the two above are — read both
   *  of those comments first (docs/proposals/team-pipeline-iac.md D11/D21).
   *
   *  `null`  = the manifest had NO `pipelineHooks` key = this stack manages no hooks. The prune step
   *            is skipped ENTIRELY and no diff entries are emitted at all.
   *  `[]`    = the key was present and empty = "I manage hooks and declare none" -> prune all.
   *
   *  A hook is a GATE. Pruning a `postDeploy` entry stops gating every wave's exit; pruning a
   *  `bakeAlarms` entry stops holding the widening. The symptom in both cases is an ABSENCE — of
   *  refusals, of holds, of anything at all — and nothing surfaces it until a bad release walks the
   *  whole fleet unimpeded. A stack that merely FORGOT A KEY must not disarm a gate an operator
   *  deliberately armed. Same accepted cost as the two above: `Stack.synth()` omits an empty
   *  collection, so `@scp/iac` cannot remove a stack's LAST hook; remove one while others remain, or
   *  hand-author `"pipelineHooks": []`.
   *
   *  Ownership is DERIVED from the owning COMPONENT (`pipeline_hooks` has no `managed_by_stack`),
   *  exactly as `sourceMappings`/`executorBindings` are: the pool a prune considers is hooks whose
   *  component this stack owns. */
  pipelineHooks: ResolvedManifestPipelineHook[] | null;
  /**
   * D12 / D25(b) — the two collections that were authorable and dropped until migration 0106.
   *
   * ORDINARY RULE, unlike `pipelineHooks` directly above: absent and empty are the SAME here and
   * both prune, so these are plain arrays rather than `| null`. The asymmetry is the contract's and
   * is deliberate — an omitted hook DISARMS A GATE, while an omitted rollout costs a declared
   * strategy that is visible the next time anything deploys.
   */
  rollouts: ResolvedManifestRollout[];
  roleBindings: ResolvedManifestRoleBinding[];
  roles: ResolvedManifestRole[];
  convergence: ResolvedManifestConvergence[];
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

export interface ResolvedManifestRollout {
  componentUrn: string;
  targetClass: string;
  rollout: unknown;
}

export interface ResolvedManifestRoleBinding {
  subjectUrn: string;
  roleName: string;
  scopeUrn: string;
  reason: string;
}

export interface ResolvedManifestRole {
  name: string;
  permissions: string[];
  bindableAt?: string[];
  reason: string;
}

export interface ResolvedManifestConvergence {
  componentUrn: string;
  targetUrn: string;
  converge: boolean;
  scope: string;
}

/** Identity keys. A rollout's identity is `(component, targetClass)` and a convergence row's is
 *  `(component, target)` — the PAYLOAD is deliberately NOT part of either, which is what makes a
 *  changed strategy an `update` in place rather than the delete+create a hook gets. */
function rolloutKey(r: { componentUrn: string; targetClass: string }): string {
  return [r.componentUrn, r.targetClass].join("\u0000");
}

function convergenceKey(c: { componentUrn: string; targetUrn: string }): string {
  return [c.componentUrn, c.targetUrn].join("\u0000");
}

/** A role binding's identity is the WHOLE grant — the same triple `role_bindings_grant_key`
 *  (drizzle/0097) makes unique. Nothing is left over to be its "value", which is why the diff has
 *  no `update`: a different grant is a different binding, and showing it as an update would hide
 *  which authority went away. */
function roleBindingKey(b: { subjectUrn: string; roleName: string; scopeUrn: string }): string {
  return [b.subjectUrn, b.roleName, b.scopeUrn].join("\u0000");
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
  /**
   * Live `governance_move_rungs` rows whose SUBJECT CONTAINER this stack owns, as subject URNs — the
   * prune pool AND the existence pool, which for this collection is ONE pool rather than the two
   * `producers` needs.
   *
   * The second pool exists there because a producer declaration is keyed on the COORDINATE and can
   * change hands with no row deleted, so "who holds it" is a question the ownership-scoped pool
   * cannot answer. A rung is keyed on its SUBJECT and cannot change hands at all: it is enabled at
   * that container or it is not. And a declaration whose subject this stack does not own is REFUSED
   * (`invalidGovernanceMoveRungDeclarations`), so every rung this diff asks about is one whose
   * subject is in the pool. One pool is therefore not a simplification — it is the whole question.
   */
  managedGovernanceMoveRungs: string[];
  /**
   * Live `pipeline_hooks` rows whose COMPONENT this stack owns — the prune pool AND the existence
   * pool, ONE pool for the reason the projection tables have one: ownership is inherited from the
   * component the row hangs off, so a hook on a component this stack owns is this stack's to
   * converge and a hook on any other component is invisible here and therefore unprunable.
   *
   * `plans-repo.ts` builds it and it is left EMPTY when the manifest omits the collection — reading
   * a prune pool we must never act on would only invite a later edit to act on it.
   */
  managedPipelineHooks: ResolvedManifestPipelineHook[];
  /** Rows on components this stack owns — the pool for both matching and pruning, exactly as for
   *  hooks. Always read (unlike the hook pool) because absent means empty here, so a prune is
   *  always in scope. */
  managedRollouts: ResolvedManifestRollout[];
  /** Bindings carrying THIS stack's `managed_by_stack` (drizzle/0108) — the prune population.
   *  Hand-granted bindings carry NULL and are invisible here, which is what stops one manifest
   *  revoking an Owner binding somebody granted through the typed door. */
  managedRoleBindings: ResolvedManifestRoleBinding[];
  managedRoles: { name: string; permissions: string[] }[];
  managedConvergence: ResolvedManifestConvergence[];
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
 * A hook's DIFF key — the WHOLE declaration, identity and payload alike, exactly as
 * {@link sourceMappingKey} keys nearly the whole tuple and for the same reason.
 *
 * A hook has no attribute that converges in place. `sourceMappings` has one (`scope`) and pays for
 * it with an `update` verdict; a hook's every field IS the gate, so a `stage` that moved from
 * `undefined` (every wave) to `"prod"` is not the same gate wearing a new value — it is a narrower
 * gate, and D21(a) is emphatic that adding a `stage` REMOVES gates. Keying on the identity alone
 * would render that change as a `noop` while the apply's upsert quietly rewrote it: a gate changed
 * with no plan line, which is precisely the class of silence this whole collection exists to
 * prevent.
 *
 * So the key includes the payload and a changed hook is a `delete` plus a `create` — two lines the
 * reviewer sees. The identity tuple still matters, at the DB (`pipeline_hooks_identity`) and at
 * {@link pipelineHookIdentityKey}, where a manifest declaring one tuple twice is REJECTED rather
 * than collapsed: two declarations sharing an identity but differing in payload would race through
 * one row and the last would silently win.
 */
function pipelineHookKey(h: ResolvedManifestPipelineHook): string {
  return canonicalJson({
    componentUrn: h.componentUrn,
    hookKind: h.hookKind,
    hookId: h.hookId,
    workflow: h.workflow,
    stage: h.stage,
    everySeconds: h.everySeconds,
    maxAgeSeconds: h.maxAgeSeconds,
    quietWindowSeconds: h.quietWindowSeconds
  });
}

/** The `pipeline_hooks_identity` tuple — the UNIQUE constraint, and the write key an apply uses.
 *  See {@link pipelineHookKey} for why the DIFF keys on more than this. */
function pipelineHookIdentityKey(h: ResolvedManifestPipelineHook): string {
  return canonicalJson({
    componentUrn: h.componentUrn,
    hookKind: h.hookKind,
    hookId: h.hookId
  });
}

/** Human-readable identity for a hook, for a refusal message. */
function describePipelineHook(h: {
  componentUrn: string;
  hookKind: string;
  hookId: string;
}): string {
  return `${h.hookKind} hook '${h.hookId}' on ${h.componentUrn}`;
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
  /** Collected across the WHOLE loop rather than thrown at the first one, so an operator fixing a
   *  bad manifest sees every conflicting URN at once instead of one per attempt. */
  const ownershipConflicts: { urn: string; ownedBy: string }[] = [];

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
    // ADOPTION AND THEFT ARE THE SAME READ, taken once and used twice: `managed_by_stack` is NULL
    // for an unmanaged object (adoptable), this stack's name (ordinary), or another stack's (theft).
    const adopted = existing !== undefined && existing.managedByStack === null;
    if (
      existing !== undefined &&
      existing.managedByStack !== null &&
      existing.managedByStack !== manifest.stackName
    ) {
      ownershipConflicts.push({ urn: obj.urn, ownedBy: existing.managedByStack });
    }
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
        // A `noop` CAN be an adoption: the declared state already matches, but ownership does not.
        // Apply still stamps it, so calling this a plain no-op would hide the one thing that
        // changes.
        reason: adopted
          ? "ADOPTING an unmanaged object; declared state already matches"
          : "matches current state",
        ...(adopted ? { adopted: true } : {})
      });
      noops++;
    } else {
      objectEntries.push({
        kind: "object",
        action: "update",
        urn: obj.urn,
        typeId: obj.typeId,
        // The reason SAYS adoption when it is one — §9 requires a review to see a stack claiming
        // existing estate, and "properties changed" would hide the part that matters.
        reason: adopted
          ? `ADOPTING an unmanaged object; ${changedFields.join(", ")} changed`
          : `${changedFields.join(", ")} changed`,
        ...(adopted ? { adopted: true } : {}),
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

  // Keyed to the ROWS (not a bare key set) so the scope convergence below can read what the live
  // tuple currently holds; several rows may share one key (no unique constraint on the table).
  const existingMappingsByKey = new Map<string, ResolvedManifestSourceMapping[]>();
  for (const managed of snapshot.managedSourceMappings) {
    const key = sourceMappingKey(managed);
    const rows = existingMappingsByKey.get(key);
    if (rows) rows.push(managed);
    else existingMappingsByKey.set(key, [managed]);
  }
  const manifestMappingKeys = new Set<string>();
  const sourceMappingEntries: PlanSourceMappingDiffEntry[] = [];

  for (const mapping of manifest.sourceMappings) {
    const key = sourceMappingKey(mapping);
    // A manifest declaring the same tuple twice would produce two identical create entries and
    // two identical rows on apply — the table has no unique constraint to stop it. Collapse to
    // one; the second declaration is redundant, not a second mapping.
    if (manifestMappingKeys.has(key)) continue;
    manifestMappingKeys.add(key);
    const existing = existingMappingsByKey.get(key);
    // §10.6 — the ONE in-place convergence this diff performs on a mapping. A declared scope that
    // differs from the live row's is an `update` (an attribute changed, not the identity — never a
    // delete + create of a live route). An OMITTED scope manages nothing: the row's current value
    // is reported and left alone, so a manifest that predates the field never clears a label an
    // operator set by hand. Duplicate rows sharing the tuple: any one differing is enough to
    // propose the update — apply converges every row matching the tuple, so the plan converges.
    const desiredScope = mapping.scope;
    const scopeDrifts =
      existing !== undefined &&
      desiredScope !== undefined &&
      existing.some((row) => (row.scope ?? null) !== desiredScope);
    const action = existing === undefined ? "create" : scopeDrifts ? "update" : "noop";
    const currentScope = existing?.[0]?.scope ?? null;
    sourceMappingEntries.push({
      kind: "source-mapping",
      action,
      componentUrn: mapping.componentUrn,
      sourceKind: mapping.sourceKind,
      repoPattern: mapping.repoPattern,
      pathPattern: mapping.pathPattern,
      refPattern: mapping.refPattern,
      type: mapping.type,
      classification: mapping.classification,
      mirrorOfShared: mapping.mirrorOfShared,
      enabled: mapping.enabled,
      // What the row WILL hold after apply: the declaration for create/update; the live value
      // (unmanaged, or already equal) for noop.
      scope: desiredScope !== undefined ? desiredScope : currentScope,
      reason:
        action === "create"
          ? "no existing source mapping with this identity"
          : action === "update"
            ? `scope differs: ${currentScope ?? "not declared"} -> ${desiredScope ?? "not declared"}`
            : "matches current state"
    });
    if (action === "noop") noops++;
    else if (action === "update") updates++;
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
      mirrorOfShared: managed.mirrorOfShared,
      enabled: managed.enabled,
      scope: managed.scope ?? null,
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

  // -----------------------------------------------------------------------------------------
  // `governance:move` RUNGS (ADR-0038 §2; proposal §9.6 Q4). Converge-then-prune like the four
  // above, with the SAME divergence `producers` has and NONE of its additions:
  //
  //  - THE DIVERGENCE: `manifest.governanceMoveRungs === null` (no key) means UNMANAGED. The whole
  //    block is skipped — no entries, no prune, and the diff carries no `governanceMoveRungs` key at
  //    all, so the stored plan itself records that this stack manages no rungs.
  //  - NO `update`: a rung has no value beyond existing (the tier is derived from the subject's
  //    type), so the verdicts are enable, disable and "already enabled".
  //  - NO transfer case: identity is the SUBJECT, and a rung cannot change hands.
  // -----------------------------------------------------------------------------------------
  let governanceMoveRungEntries: PlanGovernanceMoveRungDiffEntry[] | undefined;
  if (manifest.governanceMoveRungs !== null) {
    const entries: PlanGovernanceMoveRungDiffEntry[] = [];
    const live = new Set(snapshot.managedGovernanceMoveRungs);
    const declared = new Set<string>();

    for (const subjectUrn of manifest.governanceMoveRungs) {
      // Two declarations of one subject are one rung; collapsing keeps the diff well-formed (the
      // same treatment a duplicate producer coordinate gets). There is nothing to reject here — a
      // repeated rung is idempotent rather than ambiguous, because the collection carries no value
      // the two copies could disagree about.
      if (declared.has(subjectUrn)) continue;
      declared.add(subjectUrn);
      if (live.has(subjectUrn)) {
        entries.push({
          kind: "governance-move-rung",
          action: "noop",
          subjectUrn,
          reason: "matches current state"
        });
        noops++;
        continue;
      }
      entries.push({
        kind: "governance-move-rung",
        action: "create",
        subjectUrn,
        reason:
          "governance:move enforcement is not enabled at this container — this plan ENABLES it, so " +
          "every containment move under it will require 'governance:move' at BOTH ends"
      });
      creates++;
    }

    // THE PRUNE, reached only because the key was present. Sorted by subject so the reviewed diff is
    // stable regardless of row order from the DB, exactly like every other prune here.
    const prunes = [...live].filter((urn) => !declared.has(urn)).sort((a, b) => a.localeCompare(b));
    for (const subjectUrn of prunes) {
      entries.push({
        kind: "governance-move-rung",
        action: "delete",
        subjectUrn,
        reason:
          "enabled at a container this stack owns, no longer present in the desired manifest's " +
          "governanceMoveRungs — this plan DISABLES the bar (refused 409 at apply if an upper rung " +
          "is enabled, because an enablement above cannot be undone below)"
      });
      deletes++;
    }
    governanceMoveRungEntries = entries;
  }

  // -----------------------------------------------------------------------------------------
  // PIPELINE HOOKS (D11/D21; migration 0096). Converge-then-prune like every collection above,
  // with the SAME divergence `producers` and `governanceMoveRungs` have and one shape note:
  //
  //  - THE DIVERGENCE: `manifest.pipelineHooks === null` (the manifest had no `pipelineHooks` key)
  //    means UNMANAGED. The whole block is skipped — no entries, NO PRUNE, and the diff carries no
  //    `pipelineHooks` key at all, so the stored plan itself records that this stack manages no
  //    hooks. Read `ResolvedManifest.pipelineHooks` for why, and do not "fix" the inconsistency:
  //    pruning a hook DISARMS A GATE and the symptom is an absence of refusals.
  //  - NO `update`: the diff keys on the WHOLE declaration (`pipelineHookKey`), so a hook whose
  //    payload moved is a delete plus a create — two lines the reviewer sees.
  //  - OWNERSHIP IS THE COMPONENT'S. The pool is hooks on components this stack owns, exactly as
  //    the projection tables' is; `unownedProjectionDeclarations` refuses the write half.
  //
  // ROLLOUTS AND CONVERGENCE ARE NOW BELOW, and they follow the ORDINARY rule rather than this one
  // (absent = empty = prune). Until migration 0106 they had no storage and this file said so — the
  // half-wired state that comment warned about was live for both: `@scp/iac` emitted them and the
  // server discarded them.
  // -----------------------------------------------------------------------------------------
  let pipelineHookEntries: PlanPipelineHookDiffEntry[] | undefined;
  if (manifest.pipelineHooks !== null) {
    const entries: PlanPipelineHookDiffEntry[] = [];
    const existingHookKeys = new Set(snapshot.managedPipelineHooks.map(pipelineHookKey));
    const manifestHookKeys = new Set<string>();

    const hookEntryFields = (h: ResolvedManifestPipelineHook) => ({
      componentUrn: h.componentUrn,
      hookKind: h.hookKind,
      hookId: h.hookId,
      workflow: h.workflow,
      stage: h.stage,
      everySeconds: h.everySeconds,
      maxAgeSeconds: h.maxAgeSeconds,
      quietWindowSeconds: h.quietWindowSeconds
    });

    for (const hook of manifest.pipelineHooks) {
      const key = pipelineHookKey(hook);
      // A byte-identical repeat is one hook, not two; collapsing keeps the diff well-formed. The
      // ambiguous case — two declarations sharing an IDENTITY but differing in payload — is not
      // collapsed here, it is REJECTED by `duplicateProjectionDeclarations` before this output is
      // ever used, because there the two copies disagree about what the gate is.
      if (manifestHookKeys.has(key)) continue;
      manifestHookKeys.add(key);
      const exists = existingHookKeys.has(key);
      entries.push({
        kind: "pipeline-hook",
        action: exists ? "noop" : "create",
        ...hookEntryFields(hook),
        reason: exists ? "matches current state" : "no existing pipeline hook with this declaration"
      });
      if (exists) noops++;
      else creates++;
    }

    // THE PRUNE, reached only because the key was present. Sorted by declaration so the reviewed
    // diff is stable regardless of row order from the DB, exactly like every other prune here.
    const hookPrunes = [...snapshot.managedPipelineHooks]
      .filter((h) => !manifestHookKeys.has(pipelineHookKey(h)))
      .sort((a, b) => pipelineHookKey(a).localeCompare(pipelineHookKey(b)));
    for (const managed of hookPrunes) {
      entries.push({
        kind: "pipeline-hook",
        action: "delete",
        ...hookEntryFields(managed),
        reason:
          "declared on a component this stack owns, no longer present in the desired manifest's " +
          "pipelineHooks — this plan DISARMS the gate"
      });
      deletes++;
    }
    pipelineHookEntries = entries;
  }

  // -----------------------------------------------------------------------------------------
  // ROLLOUTS (D12) and CONVERGENCE (D25(b)) — the ORDINARY collection rule.
  //
  // Absent and empty mean the same thing and both prune, so there is no `!== null` guard above
  // these: a stack that stops declaring a rollout retracts it, and the cost of being wrong in that
  // direction is a strategy that has to be re-declared — visible the next time anything deploys,
  // unlike a disarmed gate whose symptom is an absence of refusals.
  //
  // UNLIKE HOOKS, THESE CARRY `update`. A hook's diff keys on the whole declaration, so a changed
  // hook is a delete plus a create — two lines a reviewer sees, which is right when the change may
  // disarm something. A rollout's identity is genuinely `(component, targetClass)`: the strategy is
  // its VALUE, so a changed strategy is one object changing, and showing it as a deletion would
  // imply a window in which the component had no strategy at all.
  // -----------------------------------------------------------------------------------------
  const rolloutEntries: PlanRolloutDiffEntry[] = [];
  const existingRollouts = new Map(snapshot.managedRollouts.map((r) => [rolloutKey(r), r]));
  const declaredRolloutKeys = new Set<string>();
  for (const declared of manifest.rollouts) {
    const key = rolloutKey(declared);
    if (declaredRolloutKeys.has(key)) continue;
    declaredRolloutKeys.add(key);
    const existing = existingRollouts.get(key);
    const same =
      existing !== undefined && canonicalJson(existing.rollout) === canonicalJson(declared.rollout);
    rolloutEntries.push({
      kind: "rollout",
      action: existing === undefined ? "create" : same ? "noop" : "update",
      componentUrn: declared.componentUrn,
      targetClass: declared.targetClass,
      rollout: declared.rollout,
      reason:
        existing === undefined
          ? "no existing rollout for this component and target class"
          : same
            ? "matches current state"
            : "declared strategy differs from the stored one"
    });
    if (existing === undefined) creates++;
    else if (same) noops++;
    else updates++;
  }
  for (const managed of [...snapshot.managedRollouts]
    .filter((r) => !declaredRolloutKeys.has(rolloutKey(r)))
    .sort((a, b) => rolloutKey(a).localeCompare(rolloutKey(b)))) {
    rolloutEntries.push({
      kind: "rollout",
      action: "delete",
      componentUrn: managed.componentUrn,
      targetClass: managed.targetClass,
      rollout: null,
      reason:
        "declared on a component this stack owns, no longer present in the desired manifest's rollouts"
    });
    deletes++;
  }

  // -----------------------------------------------------------------------------------------
  // ROLE BINDINGS (drizzle/0108) — CREATE and DELETE only, and a delete REVOKES A PERSON'S ACCESS
  // -----------------------------------------------------------------------------------------
  // No `update`: `(subjectUrn, roleName, scopeUrn)` is the whole identity — the same triple
  // `role_bindings_grant_key` makes unique — so nothing is left over to be a binding's "value".
  // A different grant is a different binding, and rendering it as an update would hide which
  // authority went away behind a line that reads like an edit.
  //
  // The prune population is `snapshot.managedRoleBindings`, which the repo scopes to this stack's
  // own `managed_by_stack` rows. A binding granted by hand carries NULL and is therefore invisible
  // here — that, not any check in this function, is what stops a manifest revoking an Owner
  // binding somebody granted through the typed door.
  //
  // PRUNE-ON-ABSENCE IS DELIBERATE HERE AND DELIBERATELY ABSENT ON TWO OTHER COLLECTIONS, so the
  // asymmetry is a decision on the record rather than an inconsistency to be "fixed" later.
  // `pipelineHooks` and `producers` do NOT prune on absence: a forgotten manifest key there would
  // disarm a gate or re-arm dependency confusion, and the symptom of both is an ABSENCE OF
  // REFUSALS, which nobody notices until it matters. A role binding fails the opposite way — a
  // forgotten key revokes access and the person says so within minutes. Loud-and-recoverable is
  // the safe direction to be wrong in, which is why the owner's ruling here was
  // "Both, with revocation" (2026-08-28).
  const roleBindingEntries: PlanRoleBindingDiffEntry[] = [];
  const existingRoleBindings = new Map(
    snapshot.managedRoleBindings.map((b) => [roleBindingKey(b), b])
  );
  const declaredRoleBindingKeys = new Set<string>();
  for (const declared of manifest.roleBindings) {
    const key = roleBindingKey(declared);
    if (declaredRoleBindingKeys.has(key)) continue;
    declaredRoleBindingKeys.add(key);
    const exists = existingRoleBindings.has(key);
    roleBindingEntries.push({
      kind: "roleBinding",
      action: exists ? "noop" : "create",
      subjectUrn: declared.subjectUrn,
      roleName: declared.roleName,
      scopeUrn: declared.scopeUrn,
      reason: exists
        ? "matches current state"
        : "no existing binding for this subject, role and scope"
    });
    if (exists) noops++;
    else creates++;
  }
  for (const managed of [...snapshot.managedRoleBindings]
    .filter((b) => !declaredRoleBindingKeys.has(roleBindingKey(b)))
    .sort((a, b) => roleBindingKey(a).localeCompare(roleBindingKey(b)))) {
    roleBindingEntries.push({
      kind: "roleBinding",
      action: "delete",
      subjectUrn: managed.subjectUrn,
      roleName: managed.roleName,
      scopeUrn: managed.scopeUrn,
      // Worded as what it DOES, not as what the manifest omits — this line is the review surface
      // for someone losing access.
      reason:
        "granted by this stack, no longer declared — applying this plan REVOKES this subject's " +
        `'${managed.roleName}' at this scope`
    });
    deletes++;
  }

  // -----------------------------------------------------------------------------------------
  // ORG ROLES — create/update/delete. `update` IS meaningful: a role's identity is its NAME and
  // its permission set is its value, so widening one is a change in place.
  // -----------------------------------------------------------------------------------------
  const roleEntries: PlanRoleDiffEntry[] = [];
  const existingRoles = new Map(snapshot.managedRoles.map((r) => [r.name, r]));
  const declaredRoleNames = new Set<string>();
  for (const declared of manifest.roles) {
    if (declaredRoleNames.has(declared.name)) continue;
    declaredRoleNames.add(declared.name);
    const existing = existingRoles.get(declared.name);
    const same =
      existing !== undefined &&
      canonicalJson([...existing.permissions].sort()) ===
        canonicalJson([...declared.permissions].sort());
    roleEntries.push({
      kind: "role",
      action: existing === undefined ? "create" : same ? "noop" : "update",
      name: declared.name,
      permissions: declared.permissions,
      reason:
        existing === undefined
          ? "no existing org role of this name"
          : same
            ? "matches current state"
            : "declared permissions differ from the stored set"
    });
    if (existing === undefined) creates++;
    else if (same) noops++;
    else updates++;
  }
  for (const managed of [...snapshot.managedRoles]
    .filter((r) => !declaredRoleNames.has(r.name))
    .sort((a, b) => a.name.localeCompare(b.name))) {
    roleEntries.push({
      kind: "role",
      action: "delete",
      name: managed.name,
      permissions: null,
      // The delete door refuses while any binding still points at the role, so this line can fail
      // LOUDLY at apply rather than performing an unreviewable mass revoke.
      reason: "authored by this stack, no longer declared"
    });
    deletes++;
  }

  const convergenceEntries: PlanConvergenceDiffEntry[] = [];
  const existingConvergence = new Map(
    snapshot.managedConvergence.map((c) => [convergenceKey(c), c])
  );
  const declaredConvergenceKeys = new Set<string>();
  for (const declared of manifest.convergence) {
    const key = convergenceKey(declared);
    if (declaredConvergenceKeys.has(key)) continue;
    declaredConvergenceKeys.add(key);
    const existing = existingConvergence.get(key);
    const same =
      existing !== undefined &&
      existing.converge === declared.converge &&
      existing.scope === declared.scope;
    convergenceEntries.push({
      kind: "convergence",
      action: existing === undefined ? "create" : same ? "noop" : "update",
      componentUrn: declared.componentUrn,
      targetUrn: declared.targetUrn,
      // `false` is a DECLARED VALUE, not an absence — a plan showing `converge: false` is showing
      // an opt-out someone wrote, which is exactly why D8 makes the manifest say which.
      converge: declared.converge,
      scope: declared.scope,
      reason:
        existing === undefined
          ? "no existing convergence declaration for this component and product"
          : same
            ? "matches current state"
            : "declared convergence differs from the stored one"
    });
    if (existing === undefined) creates++;
    else if (same) noops++;
    else updates++;
  }
  for (const managed of [...snapshot.managedConvergence]
    .filter((c) => !declaredConvergenceKeys.has(convergenceKey(c)))
    .sort((a, b) => convergenceKey(a).localeCompare(convergenceKey(b)))) {
    convergenceEntries.push({
      kind: "convergence",
      action: "delete",
      componentUrn: managed.componentUrn,
      targetUrn: managed.targetUrn,
      converge: null,
      scope: null,
      reason:
        "declared on a component this stack owns, no longer present in the desired manifest's convergence"
    });
    deletes++;
  }

  // REFUSED BEFORE ANYTHING IS RETURNED, so a stolen object cannot appear in a reviewable plan at
  // all. `plans-repo.ts` maps this to a 409 at BOTH doors — plan computation and apply — because a
  // plan is stored and applied later, and ownership can change in between.
  if (ownershipConflicts.length > 0) {
    throw new StackOwnershipConflictError(ownershipConflicts, manifest.stackName);
  }

  return {
    objects: objectEntries,
    relationships: relationshipEntries,
    sourceMappings: sourceMappingEntries,
    executorBindings: executorBindingEntries,
    placements: placementEntries,
    // OMITTED, not `[]`, when the stack manages no producers — the absent key IS the statement.
    ...(producerEntries !== undefined ? { producers: producerEntries } : {}),
    // Same rule, same reason — see `ResolvedManifest.governanceMoveRungs`.
    ...(governanceMoveRungEntries !== undefined
      ? { governanceMoveRungs: governanceMoveRungEntries }
      : {}),
    // Same rule, same reason — see `ResolvedManifest.pipelineHooks`.
    ...(pipelineHookEntries !== undefined ? { pipelineHooks: pipelineHookEntries } : {}),
    // ORDINARY RULE, so these are emitted whenever they have content and omitted when empty — the
    // omission carries no meaning here (absent and empty are the same), it just keeps a manifest
    // that declares neither byte-identical to one from before they existed.
    ...(rolloutEntries.length > 0 ? { rollouts: rolloutEntries } : {}),
    ...(roleBindingEntries.length > 0 ? { roleBindings: roleBindingEntries } : {}),
    ...(roleEntries.length > 0 ? { roles: roleEntries } : {}),
    ...(convergenceEntries.length > 0 ? { convergence: convergenceEntries } : {}),
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
  // A HOOK IS KEYED ON ITS IDENTITY HERE AND NOT ON ITS DECLARATION, which is the opposite of what
  // `pipelineHookKey` (the DIFF key) does, and the divergence is the whole point. Two declarations
  // sharing `(componentUrn, hookKind, hookId)` but differing in payload are the dangerous shape: they
  // race through one `pipeline_hooks_identity` row and the last one silently wins — the
  // silently-preferred key proposal §11 names. A BYTE-IDENTICAL repeat is not an offender; the diff
  // collapses it, because the two copies cannot disagree about what the gate is.
  const seenHooks = new Map<string, string>();
  for (const hook of manifest.pipelineHooks ?? []) {
    const identity = pipelineHookIdentityKey(hook);
    const declaration = pipelineHookKey(hook);
    const first = seenHooks.get(identity);
    if (first === undefined) {
      seenHooks.set(identity, declaration);
      continue;
    }
    if (first === declaration) continue;
    offenders.push(describePipelineHook(hook));
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
 * Human-readable descriptions of any `governanceMoveRungs` entry this plan may not make (ADR-0038 §2;
 * proposal §9.6 Q4). Two refusals, both derived PURELY from the diff so `plans-repo.ts` can re-run
 * them at apply against the STORED diff — the same defence-in-depth every other guard here gets:
 *
 *  1. THE SUBJECT IS NOT AN OBJECT THIS STACK OWNS. `governance_move_rungs` carries no labels, so
 *     ownership is inherited from the subject container — the rule the projection tables and
 *     `producers` already use. Without it, stack A enables a rung on stack B's service: a row A can
 *     never see again (it is outside A's pool) and B's next apply disables one it never enabled. The
 *     practical consequence is worth stating rather than discovering: a rung on the ORG ROOT, or on
 *     a container another stack owns, is authored through the API/CLI, not through a manifest.
 *
 *  2. THE SUBJECT CANNOT CARRY A RUNG. `moveRungTierForObjectType` is the one place that decides
 *     which types can (`assertRungSubjectType` is its throwing form at the HTTP door): a rung governs
 *     moves of the things INSIDE a container, and nothing is contained by a component or a
 *     deployment-target, so a rung on one would govern the empty set of moves — a bar an operator
 *     believes they set and that refuses nothing, which is worse than no bar. The typed verb refuses
 *     it; this door must too, or IaC is the way around it.
 *
 * `delete` entries are exempt from BOTH: a prune entry can only have come from the ownership-scoped
 * pool (so ownership is proved), its subject's type was proved when the rung was enabled, and the
 * subject container may legitimately be being deleted by this same plan.
 */
export function invalidGovernanceMoveRungDeclarations(diff: PlanDiff): string[] {
  const typeByUrn = new Map<string, string>();
  for (const obj of diff.objects) {
    if (obj.action !== "delete") typeByUrn.set(obj.urn, obj.typeId);
  }

  const offenders: string[] = [];
  for (const entry of diff.governanceMoveRungs ?? []) {
    if (entry.action === "delete") continue;
    const typeId = typeByUrn.get(entry.subjectUrn);
    if (typeId === undefined) {
      offenders.push(
        `governance:move rung at ${entry.subjectUrn}, which this stack does not manage — a rung's ` +
          `ownership is inherited from its subject container, so declare that container in this ` +
          `stack's manifest, or enable the rung through PUT /governance/move-enforcement/rungs`
      );
      continue;
    }
    if (!moveRungTierForObjectType(typeId)) {
      offenders.push(
        `governance:move rung at ${entry.subjectUrn}, which is a '${typeId}' — a rung sits on a ` +
          `CONTAINER (the org root, a containment domain, a service or an assembly), because it ` +
          `governs moves of the things inside it, and nothing is contained by a '${typeId}'`
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
  // PIPELINE HOOKS, under the identical rule and for the identical reason. `pipeline_hooks` carries
  // no owner of its own, so ownership is inherited from the COMPONENT the row hangs off — and
  // inheritance only scopes pruning if the converse also holds. Without this, stack A arms (or
  // re-declares) a gate on stack B's component: a row A can never see again, because it is outside
  // A's prune pool, and B's next apply DISARMS a gate it never declared. `delete` is exempt for the
  // same reason it is above: a prune entry can only have come from the ownership-scoped pool, and
  // its component may legitimately be being deleted by this same plan.
  for (const hook of diff.pipelineHooks ?? []) {
    if (hook.action === "delete") continue;
    if (!ownedUrns.has(hook.componentUrn)) {
      offenders.push(`pipelineHook -> ${describePipelineHook(hook)}`);
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
