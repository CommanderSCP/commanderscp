import { createHash } from "node:crypto";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import {
  ExecutorTypeSchema,
  type Change,
  type ChangeState,
  type ContainmentDomainId,
  type ExecutorType,
  type StageDependency,
  type TrustDomainId
} from "@scp/schemas";
import type { TenantTx } from "../db/tenant-tx.js";
import { changes, objects } from "../db/schema.js";
import { badRequest, notFound } from "../errors.js";
import { decodeCursor, encodeCursor, keysetAfter, keysetOrderBy } from "../pagination.js";
import { createObject, getObjectByIdOrUrnAnyType } from "../graph/objects-repo.js";
import { createRelationship } from "../graph/relationships-repo.js";
import { insertDecision } from "./decisions-repo.js";
import {
  resolvePipelineForTargets,
  type PipelineResolution,
  type PipelineRung
} from "./pipeline-resolution.js";
import { appendJournalEntry } from "../federation/journal-repo.js";
import { withBoundaryBundleChecksum } from "../federation/boundary-bundle-ref.js";

/** `change_status` journal entries aren't tied to a graph object's own `content_hash` (that one
 *  covers the change's static metadata; this covers the lifecycle-state snapshot) — hashed
 *  independently so a state-only change (e.g. a transition) still produces a distinct, verifiable
 *  content_hash on its journal entry. */
export function changeStatusContentHash(payload: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

export type ChangeRow = typeof changes.$inferSelect;
type ObjectRow = typeof objects.$inferSelect;
/** The minimal object shape `toChangeShape` actually reads — satisfied by both a raw `ObjectRow`
 *  (joined-query callers below) and a `GraphObject` (createObject's return shape in `proposeChange`,
 *  which has ISO-string dates and no `contentHash`) without forcing either side to convert.
 *  `originDomainId` is typed as plain `string` (not `ObjectRow`'s branded `TrustDomainId`) so
 *  `GraphObject.originDomainId` (also plain `string` on the wire schema) satisfies it directly —
 *  a `TrustDomainId` is itself always a valid `string`, so an `ObjectRow` still satisfies this too. */
type ObjectLike = Pick<ObjectRow, "id" | "urn" | "name"> & {
  properties: unknown;
  originDomainId: string;
};

export function toChangeShape(change: ChangeRow, object: ObjectLike): Change {
  return {
    id: object.id,
    orgId: change.orgId,
    urn: object.urn,
    name: object.name,
    state: change.state as ChangeState,
    sourceKind: change.sourceKind,
    sourceRef: (change.sourceRef as Record<string, unknown> | null) ?? null,
    correlationKey: change.correlationKey,
    emergency: change.emergency,
    importedFromDomain: change.importedFromDomain,
    topologyObjectId: change.topologyObjectId,
    topologyVersion: change.topologyVersion,
    rollbackOfObjectId: change.rollbackOfObjectId,
    rollbackTriggerReason: change.rollbackTriggerReason,
    cancellationKind: (change.cancellationKind as "system" | "user" | null) ?? null,
    stateEnteredAt: change.stateEnteredAt.toISOString(),
    lastHeartbeatAt: change.lastHeartbeatAt.toISOString(),
    watchdogFlaggedAt: change.watchdogFlaggedAt?.toISOString() ?? null,
    properties: object.properties as Record<string, unknown>,
    createdAt: change.createdAt.toISOString(),
    updatedAt: change.updatedAt.toISOString(),
    // M16.3 P2 (additive): the authoritative single-writer-authority origin (graph/objects-repo.ts's
    // module doc) — same field every other typed resource's `GraphObjectSchema.originDomainId`
    // carries, and what `coordination/service-board.ts`'s `drivenHere` is derived from. Distinct
    // from `importedFromDomain` above (promotion-bundle provenance only).
    originDomainId: object.originDomainId
  };
}

export interface ProposeChangeInput {
  orgId: string;
  actorObjectId: string;
  requestId: string;
  id?: string;
  urn?: string;
  /** CONTAINMENT sense (ADR-0021 D4). */
  domainId?: ContainmentDomainId | null;
  name: string;
  properties?: Record<string, unknown>;
  labels?: Record<string, unknown>;
  sourceKind?: string;
  sourceRef?: Record<string, unknown>;
  correlationKey?: string;
  emergency?: boolean;
  /** Resolved release-topology idOrUrn -> pinned (objectId, version) at compile time (evaluate step), not here. */
  topologyIdOrUrn?: string;
  /** Object ids or URNs this change targets — resolved to ids and stashed in properties for the plan compiler. */
  targets: string[];
  /**
   * WHICH pipeline of its targets this change rolls (M12 P4A) — the routing Type (ADR-0007). Omitted
   * ⇒ 'configuration' (the server default).
   *
   * Deliberately per-CHANGE, not per-target: a change IS a release, and a release comes from ONE
   * source per pipeline, so one change drives one pipeline. A release needing both is two releases.
   * This also keeps `properties.targets` a plain string[] — it is PERSISTED on every existing change
   * object, and restructuring it would break them all.
   */
  type?: ExecutorType;
  /** Coupled-pipeline keys this release provides at its targets (M12 P4B). Stored verbatim in
   *  `properties.provides`. */
  provides?: string[];
  /** Cross-change prerequisites (M12 P4B): each `{ key, at }`'s `at` is an idOrUrn RESOLVED to an
   *  object id here (a bad ref 404s), then stored in `properties.requires`. When set, the change
   *  parks in `waiting` until every requirement is satisfied. */
  requires?: { key: string; at: string }[];
  /** Stage-scoped component couplings (ADR-0028): each entry's `dependsOn`, and every member of its
   *  `atTargets`, is an idOrUrn RESOLVED to an object id here (a bad ref 404s), then stored in
   *  `properties.stageDependencies`. Unlike `requires`, this does NOT park the change: it is read
   *  per (target × stage) in the executing loop to decide whether to fire that target's trigger. */
  stageDependencies?: StageDependency[];
  /** Set only when this Change IS a rollback of another change (coordination/rollback.ts). */
  rollbackOfObjectId?: string;
  /** M6 (DESIGN §13): set when this Change was instantiated from a Promotion Bundle —
   *  `federation/promotion-repo.ts`'s `importPromotionBundle` is the only caller that sets this.
   *  The resulting Change is a genuinely LOCAL, locally-authoritative Change (its own graph object
   *  originates at THIS domain) that must still pass every local policy/control/approval gate —
   *  approvals carried in the bundle are evidence attached separately (imported_approval_evidence),
   *  never a bypass of local governance. */
  importedFromDomain?: TrustDomainId;
}

/** One human-readable line for `scp change explain`, per rung. */
function pipelineSummary(
  rung: PipelineRung | "explicit" | null,
  attachedToObjectId: string | null,
  reason: PipelineResolution["reason"]
): string {
  switch (rung) {
    case "explicit":
      return "pipeline set explicitly on the change (no inheritance walk)";
    case "component":
      return "pipeline inherited from the target's own releases_via edge";
    case "service":
      return `pipeline inherited from the owning service ${attachedToObjectId}`;
    case "organization":
      return `pipeline inherited from the org default on ${attachedToObjectId}`;
    default:
      return reason === "targets_disagree"
        ? "no pipeline: the change's targets resolve to different pipelines, so none is inherited"
        : "no pipeline: no releases_via edge on the target, its service, or the org root";
  }
}

/**
 * Creates a Change: a graph object (type `change`) via the existing `createObject` (which itself
 * writes the `change.create` audit event + outbox publish, DESIGN §4.1/§8) plus the `changes`
 * projection row in state `proposed`, plus one Decision record so `scp change explain` always has
 * at least one entry from the moment a change exists (DESIGN §10.4). This is NOT a state
 * transition (there is no "from" state) so it does not go through `transitionChange` — but it
 * follows the identical "write the thing + write a Decision" discipline.
 *
 * Also the SINGLE POINT where a change acquires its release topology, whether set explicitly or
 * inherited from the graph (ADR-0026 §5) — see the resolution block below for why it lives here.
 */
export async function proposeChange(
  tx: TenantTx,
  input: ProposeChangeInput
): Promise<{ change: Change; targetObjectIds: string[] }> {
  if (input.targets.length === 0) throw badRequest("a change must target at least one object");

  const targetObjectIds: string[] = [];
  for (const idOrUrn of input.targets) {
    const target = await getObjectByIdOrUrnAnyType(tx, input.orgId, idOrUrn);
    targetObjectIds.push(target.id);
  }

  // M12 P4B: resolve each requirement's `at` idOrUrn to an object id NOW, so a typo is a 404 at
  // propose time rather than a change that waits forever on an object that never existed.
  //
  // `requires` is TYPED-FIELD-ONLY: a value smuggled in via the free-form `properties` is dropped
  // (stripped from the spread below), never stored. That is deliberate — an unresolved `at` string
  // in `properties.requires` would sail past this resolution and become exactly the silent
  // forever-wait we forbid, and NO legitimate caller needs the properties path: the typed field
  // covers the API/CLI, and federation promotion STRIPS `requires` (`promotion-repo.ts`) precisely
  // so it is not re-evaluated in the receiving domain. `provides`, by contrast, IS carried in
  // properties (federation replay preserves it), so it keeps a properties fallback.
  const resolvedRequires =
    input.requires === undefined
      ? []
      : await Promise.all(
          input.requires.map(async (req) => ({
            key: req.key,
            at: (await getObjectByIdOrUrnAnyType(tx, input.orgId, req.at)).id
          }))
        );
  // ADR-0028: resolve every stage dependency's `dependsOn` — and every member of its `atTargets` —
  // to an object id NOW, for exactly the reason `requires[].at` is resolved above: an unresolvable
  // reference must be refused where it was AUTHORED, not become a hold that never clears because
  // the thing it names never existed. Both halves are resolved: an `atTargets` typo would otherwise
  // scope the coupling to a place that does not exist, which reads as "applies nowhere" — a silent
  // fail-OPEN, the mirror image of the forever-wait.
  //
  // AND THE TYPE IS CHECKED, ON THE SAME PRINCIPLE. Resolving proves the object EXISTS; it does not
  // prove the declaration can ever be enforced, and a reference of the wrong type is inert in
  // exactly the silent way an unresolvable one would have been:
  //
  //   * `dependsOn` MUST BE A COMPONENT. The `depends_on` edge type permits a service at both
  //     endpoints, and a service is the shape users write (`seed.ts` has service->service), so this
  //     is accepted-looking: the edge is minted, the declaration is stored, and NOTHING EVER HOLDS.
  //     The hold resolves a wave target to its placement and asks `listPlacementsForComponents` for
  //     the dependency's placements — and a placement's `component` must be typeId `component`
  //     (`graph/placements-repo.ts`), so a service returns no rows, every verdict is `not_placed`
  //     -> satisfied, and not even the `stage_dependency_unscoped` warn fires. Silently inert
  //     forever is the worst of the available answers.
  //   * `atTargets` MUST BE DEPLOYMENT-TARGETS. The hold matches these against the placement's own
  //     `deploymentTargetId`, so anything else matches nothing, the declaration applies nowhere, and
  //     the release runs uncoupled — the same fail-open the unresolvable-ref 404 above exists to
  //     prevent, just wearing a valid id.
  //
  // Refused with a 400 where it was authored, the same call `createRelationship` already makes for
  // an endpoint its type forbids (a `dependsOn` naming a deployment-target used to reach that check
  // and is now refused here instead, with a message that says what to do about it).
  const resolveDeclaredRef = async (
    idOrUrn: string,
    expectedTypeId: "component" | "deployment-target",
    describe: (actualTypeId: string) => string
  ): Promise<string> => {
    const object = await getObjectByIdOrUrnAnyType(tx, input.orgId, idOrUrn);
    if (object.typeId !== expectedTypeId) throw badRequest(describe(object.typeId));
    return object.id;
  };
  const resolvedStageDependencies =
    input.stageDependencies === undefined
      ? undefined
      : await Promise.all(
          input.stageDependencies.map(async (dep) => ({
            dependsOn: await resolveDeclaredRef(
              dep.dependsOn,
              "component",
              (typeId) =>
                `stage dependency '${dep.dependsOn}' names a '${typeId}' — \`stageDependencies[].dependsOn\` must name a component, because a stage-scoped hold is evaluated against the dependency's PLACEMENTS and only a component can be placed; a '${typeId}' would never hold anything`
            ),
            ...(dep.minWeight === undefined ? {} : { minWeight: dep.minWeight }),
            ...(dep.atTargets === undefined
              ? {}
              : {
                  atTargets: await Promise.all(
                    dep.atTargets.map((t) =>
                      resolveDeclaredRef(
                        t,
                        "deployment-target",
                        (typeId) =>
                          `stage dependency '${dep.dependsOn}' is scoped to '${t}', which is a '${typeId}' — \`atTargets\` must name deployment-targets, and a scope that names anything else matches no place at all, so the coupling would silently apply nowhere`
                      )
                    )
                  )
                })
          }))
        );
  const providesValue = input.provides ?? providesOf(input.properties);
  const requiresValue = resolvedRequires;
  // `stageDependencies` follows `requires`' TYPED-FIELD-ONLY idiom, not `provides`' fallback one:
  // the typed field is the only way to store one, and a caller-supplied `properties.stageDependencies`
  // is DROPPED (the destructure below is what drops it).
  //
  // THERE IS NO PROPERTIES FALLBACK BECAUSE IT WAS A THIRD, UNGUARDED DECLARATION DOOR. `POST
  // /changes` authorizes the TYPED field — `relationship:write` at both endpoints of every edge the
  // declaration would mint (`campaign-scope-authz.ts`) — and passes `properties` straight through.
  // A fallback preserving the same declaration verbatim therefore accepted, and the hold honoured,
  // exactly what the typed field 403s: an authority bypass, plus disclosure of another component's
  // deployment state through the Decision's `branch`/`dependencyStatus`. (No edge is minted that
  // way — `materialiseStageDependencyEdges` reads the resolved typed field only — so it is not a
  // privilege escalation, but a coupling that binds a component the declarer has no authority over
  // is not the declarer's to write either.)
  //
  // AND NO LEGITIMATE CALLER NEEDS IT, which is the same census `requires` passed: the typed field
  // covers the API, the CLI and the CI report ingress, campaign fan-out and rollback pass no
  // properties at all, and federation promotion STRIPS `stageDependencies` before it re-proposes
  // (`federation/promotion-repo.ts`, ADR-0028 — the coupling was enforced upstream at the commander
  // and evaluating it in the receiving domain would fail open under any sync scope narrower than
  // `full`). The only propose path that carries caller properties at all is `POST /changes`.
  const stageDependenciesValue =
    resolvedStageDependencies !== undefined && resolvedStageDependencies.length > 0
      ? resolvedStageDependencies
      : undefined;
  // Strip any caller-supplied `provides`/`requires`/`stageDependencies` from the raw properties so
  // the ONLY values stored are the computed ones above (the resolved typed field, or the explicit
  // properties fallback `provides` keeps).
  const {
    provides: _rawProvides,
    requires: _rawRequires,
    stageDependencies: _rawStageDependencies,
    ...restProperties
  } = input.properties ?? {};

  // PIPELINE RESOLUTION (ADR-0026, §5, D4/D15). An explicit `--topology` always wins and is outside
  // the walk; otherwise the change INHERITS one from the graph.
  //
  // This lives HERE, in `proposeChange`, and not in `webhook-processor.ts`. Several paths create
  // changes — the webhook processor, the API, campaign expansion, federation promotion replay — and
  // fixing the caller instead of the single decision point is the incomplete-call-site-census
  // mistake this repo has now paid for five times (BUILD_AND_TEST.md §4.4). Every change that gets
  // proposed at all gets resolution, by construction.
  //
  // `pipelineRung` is carried to the Decision below, not just the topology: principle 6. "Why did
  // this change get this pipeline?" has four answers — explicit, own edge, service's edge, org
  // default — and only the rung tells them apart.
  let topologyObjectId: string | undefined;
  let topologyVersion: number | undefined;
  let pipelineRung: PipelineRung | "explicit" | null = null;
  let pipelineAttachedTo: string | null = null;
  let pipelineReason: PipelineResolution["reason"] = null;
  let pipelinePerTarget: PipelineResolution["perTarget"] = [];
  if (input.topologyIdOrUrn) {
    const topology = await getObjectByIdOrUrnAnyType(tx, input.orgId, input.topologyIdOrUrn);
    if (topology.typeId !== "release-topology") {
      throw badRequest(`'${input.topologyIdOrUrn}' is not a release-topology object`);
    }
    topologyObjectId = topology.id;
    topologyVersion = topology.version;
    pipelineRung = "explicit";
  } else {
    const resolution = await resolvePipelineForTargets(tx, input.orgId, targetObjectIds);
    pipelineReason = resolution.reason;
    pipelinePerTarget = resolution.perTarget;
    if (resolution.resolved) {
      topologyObjectId = resolution.resolved.topologyObjectId;
      topologyVersion = resolution.resolved.topologyVersion;
      pipelineRung = resolution.resolved.rung;
      pipelineAttachedTo = resolution.resolved.attachedToObjectId;
    }
  }

  const object = await createObject(tx, {
    orgId: input.orgId,
    typeId: "change",
    actorObjectId: input.actorObjectId,
    requestId: input.requestId,
    id: input.id,
    urn: input.urn,
    name: input.name,
    domainId: input.domainId,
    // Type precedence (M12 P4A / ADR-0007): the typed field wins; failing that, whatever the caller's
    // own properties already say; failing that, 'configuration'.
    //
    // The `?? typeOf(input.properties)` middle rung is load-bearing, not defensive padding. This
    // spread writes `type` AFTER `...input.properties`, so a bare `input.type ?? "configuration"`
    // silently CLOBBERS a type the caller passed inside properties. Federation promotion
    // (`federation/promotion-repo.ts`) does exactly that — it replays a bundle's change properties
    // verbatim — so an `infrastructure` release promoted across domains would arrive as
    // 'configuration' and trigger the receiving domain's configuration binding. Inheriting here fixes
    // it for every such caller at once, rather than one call site at a time.
    properties: {
      ...restProperties,
      targets: targetObjectIds,
      type: input.type ?? typeOf(input.properties),
      // Only written when non-empty, so a change that couples nothing stays byte-identical to a
      // pre-P4B change (and the no-wait fast path in reconcile is a pure absence check).
      ...(providesValue.length > 0 ? { provides: providesValue } : {}),
      ...(requiresValue.length > 0 ? { requires: requiresValue } : {}),
      ...(stageDependenciesValue === undefined ? {} : { stageDependencies: stageDependenciesValue })
    },
    labels: input.labels
  });

  const now = new Date();
  const [row] = await tx
    .insert(changes)
    .values({
      objectId: object.id,
      orgId: input.orgId,
      state: "proposed",
      sourceKind: input.sourceKind ?? null,
      sourceRef: input.sourceRef ?? null,
      correlationKey: input.correlationKey ?? null,
      emergency: input.emergency ?? false,
      topologyObjectId: topologyObjectId ?? null,
      topologyVersion: topologyVersion ?? null,
      rollbackOfObjectId: input.rollbackOfObjectId ?? null,
      importedFromDomain: input.importedFromDomain ?? null,
      stateEnteredAt: now,
      lastHeartbeatAt: now,
      createdAt: now,
      updatedAt: now
    })
    .returning();
  if (!row) throw new Error("failed to insert changes projection row");

  // M6 (DESIGN §13 journal entry kinds — richer than the generic `object_upsert` `createObject`
  // above already wrote for this change's underlying graph object): a `change_status` snapshot
  // carrying the full projection-row state, for peers syncing with a `changes_only` scope and for
  // the commander cross-domain status view. Written even for an IMPORTED change (importedFromDomain
  // set) — its LOCAL lifecycle from here on is this domain's own to report, distinct from the
  // origin domain's own journal entry for the promotion itself.
  {
    const payload = {
      objectId: object.id,
      urn: object.urn,
      name: object.name,
      state: "proposed",
      sourceKind: input.sourceKind ?? null,
      sourceRef: input.sourceRef ?? null,
      emergency: input.emergency ?? false,
      importedFromDomain: input.importedFromDomain ?? null,
      rollbackOfObjectId: input.rollbackOfObjectId ?? null
    };
    await appendJournalEntry(tx, {
      orgId: input.orgId,
      entryKind: "change_status",
      contentHash: changeStatusContentHash(payload),
      payload
    });
  }

  await insertDecision(tx, {
    orgId: input.orgId,
    kind: "transition",
    subjectId: object.id,
    verdict: "allow",
    inputContext: {
      trigger: "propose",
      actorId: input.actorObjectId,
      targets: targetObjectIds,
      topologyObjectId: topologyObjectId ?? null,
      // Principle 6: the topology alone cannot explain an inheritance surprise — someone attaches a
      // pipeline to a service and every component in it silently changes how it releases. The rung
      // and the object the winning edge hangs off are what answer "why this one?".
      pipeline: {
        rung: pipelineRung,
        attachedToObjectId: pipelineAttachedTo,
        reason: pipelineReason,
        // Written only for a genuine inheritance walk (an explicit `--topology` has no per-target
        // story), and only when there is more than one target — a single-target change's per-target
        // detail is exactly the fields above, and duplicating it would grow every Decision row for
        // no information. Decision volume is a live production concern.
        ...(pipelineRung !== "explicit" && targetObjectIds.length > 1
          ? { perTarget: pipelinePerTarget }
          : {})
      },
      rollbackOfObjectId: input.rollbackOfObjectId ?? null
    },
    reasonTree: {
      summary: input.rollbackOfObjectId
        ? `rollback change proposed for ${targetObjectIds.length} target(s)`
        : `change proposed for ${targetObjectIds.length} target(s)`,
      pipeline: pipelineSummary(pipelineRung, pipelineAttachedTo, pipelineReason)
    }
  });

  // ADR-0028 decision 6/7, increment 2. Materialised from the RESOLVED TYPED FIELD only — which is
  // now also the only thing this function stores, since a caller-supplied
  // `properties.stageDependencies` is dropped above. Edges are never minted from stored entries
  // that did not go through propose-time resolution and the both-endpoint authority check: a
  // replayed peer's entries name the PEER's object ids, so writing edges from them would either
  // fabricate an edge this domain never asserted or 400 on an endpoint that was never synced here
  // and take the whole import down with it. Edges have their own federation channel
  // (`relationship_upsert`); the origin domain's materialisation is what travels.
  if (resolvedStageDependencies !== undefined) {
    await materialiseStageDependencyEdges(tx, input, targetObjectIds, resolvedStageDependencies);
  }

  return { change: toChangeShape(row, object), targetObjectIds };
}

/**
 * ADR-0028 decision 6 — a change's declared stage dependencies become `depends_on` edges,
 * component→component, so the declaration that will gate the trigger ALSO answers "what depends on
 * what". This is the "derive the dependency charts instead of guessing" half of the owner's ask, and
 * it is the only half there can be: nothing SCP observes carries inter-component dependency data
 * (ADR-0028 decision 7 — the ArgoCD resource tree models `{group,version,kind,namespace,name,
 * status,health}`, discovery proposes no dependency edges, and no scan/SBOM code writes edges), so a
 * dependency edge can only ever be DECLARED.
 *
 * IDEMPOTENT BY PRE-CHECK, NOT BY CATCHING THE 409. The same CI declaration arrives on every single
 * push, so a duplicate must be a silent no-op — but `createRelationship`'s unique-violation branch
 * throws only AFTER postgres has already aborted the surrounding transaction, and `proposeChange` is
 * mid-transaction with more edges (and its caller's own writes) still to come. Catching the conflict
 * here would fail on the very next statement. The pre-check is therefore the mechanism, and the
 * unique index stays the backstop for the one race it cannot cover — two first-ever pushes of the
 * same declaration committing at the same instant — which surfaces as a 409 on propose and is
 * retried by the ingress path. That is the identical pre-check-plus-index shape `assertCardinality`
 * already uses in `graph/relationships-repo.ts`.
 *
 * THE PRE-CHECK DELIBERATELY DOES NOT FILTER ON `deleted_at`. `relationships_org_type_from_to_key`
 * is a plain UNIQUE, not a partial index, and `deleteRelationship` is a SOFT delete — so a
 * tombstoned edge still occupies the key and NO create can ever replace it. Treating a tombstone as
 * "already materialised" is what stops an operator's one-off deletion from turning every subsequent
 * push of that microservice into a 409. THE DECLARED coupling is unaffected either way: the hold
 * reads it off `properties.stageDependencies`, which no edge deletion touches. (The edge is not
 * inert — it ALSO orders a pair that are both targets of one change, ADR-0028 decision 6 — but that
 * is the same fact arriving twice, and the declaration is the half a tombstone cannot take away.)
 *
 * NOTHING IS EVER DELETED HERE, and there is no pruning story on purpose. A declaration is ONE
 * repo's assertion about its own component; pruning "edges this push did not mention" would let A's
 * repo silently delete the dependency B's repo asserted.
 *
 * `minWeight`/`atTargets` DO NOT RIDE ON THE EDGE. Relationship `properties` are silently discarded
 * on four separate legs of the way in (rollout-step-coupling.md §0.5) and relationships have no
 * update path at all, so per-dependency semantics hung on an edge would validate, apply, and store
 * nothing. The change's own `properties.stageDependencies` stays the only source of a QUALIFIED
 * dependency; the edge carries only the FACT of one, which is all impact analysis
 * (`graph/named-queries.ts`'s `DEFAULT_IMPACT_TYPES`) consumes — and all the hold reads it for, in
 * the one case where it does (both endpoints targets of the same change, ADR-0028 decision 6, where
 * it applies the plain `succeeded` test with no qualifiers). Existing `consumes` edges are left
 * strictly alone for the same reason — impact analysis reads both, so nothing is lost by not
 * converging them, and converging them would rewrite data this feature never authored.
 */
async function materialiseStageDependencyEdges(
  tx: TenantTx,
  input: Pick<ProposeChangeInput, "orgId" | "actorObjectId" | "requestId">,
  fromObjectIds: readonly string[],
  dependencies: readonly { dependsOn: string }[]
): Promise<void> {
  for (const fromId of fromObjectIds) {
    for (const dep of dependencies) {
      const toId = dep.dependsOn;
      // A self-edge is dropped rather than refused: both compiler paths already ignore
      // `from === to` (`buildDependencyMap`, and the stage-mode edge walk), so the graph layer's
      // 400 would be the only consequence of a declaration that means nothing either way.
      if (fromId === toId) continue;
      // The pre-check runs INSIDE this transaction and so sees this loop's own uncommitted inserts.
      // That is what makes two entries naming the same dependency (differing only in
      // `minWeight`/`atTargets`, which the edge does not carry) collapse onto one edge, with no
      // separate in-memory de-dupe: the earlier iteration's row is simply already there. A
      // belt-and-braces `Set` was written here first and then removed — a mutation proved it dead,
      // because the pre-check already covered every case it claimed to.

      const existing = await tx.query.relationships.findFirst({
        where: (t, { eq: eqOp, and: andOp }) =>
          andOp(
            eqOp(t.orgId, input.orgId),
            eqOp(t.typeId, "depends_on"),
            eqOp(t.fromId, fromId),
            eqOp(t.toId, toId)
          )
      });
      if (existing) continue;

      // An endpoint that is not a service/component is refused by `createRelationship` with its own
      // specific message ("relationship type 'depends_on' does not allow '<type>' as the 'to'
      // endpoint"). That 400 is allowed to propagate, on the same principle that refuses an
      // unresolvable `dependsOn` above: a declaration naming something that cannot participate in a
      // dependency is wrong where it was authored, and discovering it later — as a coupling that
      // silently applies to nothing — is the fail-open this whole channel is built to avoid.
      await createRelationship(tx, {
        orgId: input.orgId,
        actorObjectId: input.actorObjectId,
        requestId: input.requestId,
        typeId: "depends_on",
        fromId,
        toId
      });
    }
  }
}

async function fetchChangeWithObject(
  tx: TenantTx,
  orgId: string,
  changeObjectId: string
): Promise<{ change: ChangeRow; object: ObjectRow } | undefined> {
  const rows = await tx
    .select({ change: changes, object: objects })
    .from(changes)
    .innerJoin(objects, eq(changes.objectId, objects.id))
    .where(and(eq(changes.orgId, orgId), eq(changes.objectId, changeObjectId)))
    .limit(1);
  return rows[0];
}

export async function getChange(tx: TenantTx, orgId: string, id: string): Promise<Change> {
  const found = await fetchChangeWithObject(tx, orgId, id);
  if (!found) throw notFound(`change '${id}' not found`);
  return toChangeShape(found.change, found.object);
}

export async function getChangeRow(tx: TenantTx, orgId: string, id: string): Promise<ChangeRow> {
  const found = await fetchChangeWithObject(tx, orgId, id);
  if (!found) throw notFound(`change '${id}' not found`);
  return found.change;
}

/**
 * Batch fetch for the reconciliation loop (coordination/reconcile.ts) and the watchdog: every
 * change currently sitting in one of `states`, oldest-updated first (so a sweep drains the
 * longest-waiting changes first rather than starving them behind a churny newer one), capped at
 * `limit` per tick so one org with a huge backlog can't starve every other org's sweep turn.
 *
 * MAJOR #6 fix (PR #7 review — "batch starvation"): excludes changes `markChangeReconcileBlocked`
 * has parked (an `executing` change whose active wave failed and is awaiting an operator's manual
 * cancel/rollback — see reconcile.ts's `failed` branch). `reconcile_blocked_at` is only ever set
 * while a change is `executing`, so this filter is a no-op for every other state and safe to apply
 * unconditionally rather than needing a state-specific variant of this query.
 */
export async function listChangeRowsInStates(
  tx: TenantTx,
  orgId: string,
  states: ChangeState[],
  limit: number
): Promise<{ change: ChangeRow; object: ObjectRow }[]> {
  if (states.length === 0) return [];
  return tx
    .select({ change: changes, object: objects })
    .from(changes)
    .innerJoin(objects, eq(changes.objectId, objects.id))
    .where(
      and(
        eq(changes.orgId, orgId),
        inArray(changes.state, states),
        isNull(changes.reconcileBlockedAt)
      )
    )
    .orderBy(asc(changes.updatedAt))
    .limit(limit);
}

/** Marks an `executing` change as parked awaiting operator action (MAJOR #6 fix — see
 *  `listChangeRowsInStates`'s doc comment). Idempotent: a no-op if already parked, so calling it
 *  every tick a change's active wave is still `failed` never generates redundant writes. */
export async function markChangeReconcileBlocked(
  tx: TenantTx,
  orgId: string,
  changeObjectId: string
): Promise<void> {
  await tx
    .update(changes)
    .set({ reconcileBlockedAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(changes.orgId, orgId),
        eq(changes.objectId, changeObjectId),
        isNull(changes.reconcileBlockedAt)
      )
    );
}

/**
 * M16.1 (I1) — stamps a promotion bundle's `checksum` onto a change's `sourceRef`, giving the
 * boundary segment its PER-CHANGE JOIN into the `bundle_transfers` ledger (which has no change
 * column; see `federation/boundary-bundle-ref.ts` for the full rationale).
 *
 * Additive to whatever `sourceRef` already holds; no other key is touched, and the value is a
 * deduped list because one change may be exported to several peers.
 *
 * ## Journalling — what is actually true
 *
 * The intent is that a replica of this change on another domain does NOT inherit this domain's
 * checksums (they are per-instance observational bookkeeping about THIS instance's
 * `bundle_transfers` rows; the far side stamps whatever IT observed). Two stamp sites, two
 * different stories:
 *
 * - THE EXPORT-SIDE STAMP (this function, called from `exportPromotionBundle` phase 4) genuinely
 *   is not journalled — it is a bare `UPDATE changes`, and no `change_status` entry is appended
 *   for it. Nothing leaves the instance.
 * - THE IMPORT-SIDE STAMP is NOT exempt. `applyPromotionImport` puts the checksum into the
 *   `sourceRef` it hands `proposeChange`, and `proposeChange` appends a `change_status` journal
 *   entry whose payload carries `sourceRef` verbatim (see the `change_status` block above). So the
 *   importing instance's stamp DOES ride the journal onward to any peer syncing `changes_only`.
 *
 * The consequence of that leak is nil today, and by construction rather than by luck: the
 * `change_status` import path (`federation/import-repo.ts`) records the received status for the
 * cross-domain view and never creates a local `changes` row from it, so no peer can ever grow a
 * boundary segment out of a replicated stamp — `boundarySegment` only ever reads the `changes` row
 * this instance minted itself. If a future change lets `change_status` materialize local change
 * rows, the import-side stamp must be stripped there.
 */
export async function stampBoundaryBundleChecksum(
  tx: TenantTx,
  orgId: string,
  changeObjectId: string,
  checksum: string
): Promise<void> {
  // `FOR UPDATE`. This is a read-modify-write of an opaque JSONB column, and the LIST shape exists
  // precisely because one change can be exported to SEVERAL peers — concurrently, in the ordinary
  // case (two air-gapped peers, two `exportPromotionBundle` calls). Under READ COMMITTED an
  // unlocked SELECT lets both txs read the same pre-stamp `sourceRef`; the second then blocks on
  // the row lock at UPDATE time but still writes from its STALE read, silently clobbering the
  // first peer's checksum. The segment would then show one hop where two really happened — a
  // real export erased from a read model whose whole job is to not overclaim. Locking on the read
  // serializes the two stampers so each appends onto the other's committed result.
  //
  // `exportPromotionBundle` takes no per-change advisory lock (unlike reconcile), so this row lock
  // is the only thing ordering them.
  const [row] = await tx
    .select({ sourceRef: changes.sourceRef })
    .from(changes)
    .where(and(eq(changes.orgId, orgId), eq(changes.objectId, changeObjectId)))
    .limit(1)
    .for("update");
  if (!row) return; // change vanished (cancelled/purged mid-export) — nothing to decorate.
  const next = withBoundaryBundleChecksum(row.sourceRef, checksum);
  await tx
    .update(changes)
    .set({ sourceRef: next, updatedAt: new Date() })
    .where(and(eq(changes.orgId, orgId), eq(changes.objectId, changeObjectId)));
}

/** Reads the target object ids `proposeChange` stashed under `properties.targets` at creation time. */
export function targetObjectIdsOf(
  properties: Record<string, unknown> | null | undefined
): string[] {
  const targets = properties?.targets;
  return Array.isArray(targets) ? targets.filter((t): t is string => typeof t === "string") : [];
}

/** Coupled-pipeline keys a change PROVIDES at its targets (M12 P4B), off `properties.provides`.
 *  Absent/malformed ⇒ `[]` (provides nothing). */
export function providesOf(properties: Record<string, unknown> | null | undefined): string[] {
  const provides = properties?.provides;
  return Array.isArray(provides) ? provides.filter((k): k is string => typeof k === "string") : [];
}

/** `requiresOf`'s parse result: the well-formed `{key, at}` requirements PLUS every stored entry
 *  that did NOT parse. Callers must treat any `malformed` entry as an UNSATISFIABLE requirement. */
export interface ParsedRequires {
  requirements: { key: string; at: string }[];
  /** Stored `requires` entries that do not parse as `{key, at}` — verbatim, for diagnostics. When
   *  `properties.requires` is present but not an array at all, the whole raw value is one entry. */
  malformed: unknown[];
}

/**
 * Cross-change prerequisites a change REQUIRES (M12 P4B), off `properties.requires` — each a
 * `{ key, at }` with `at` already an object id (resolved at propose time).
 *
 * FAIL-CLOSED (coupled-pipelines.md §6#14): a malformed entry is NOT silently dropped — it is
 * returned under `malformed`, and every reader (the routing guard and the waiting-sweep predicate
 * in reconcile.ts, wait-status in routes/changes.ts, the watchdog) treats a change carrying one as
 * UNSATISFIABLE: it parks in `waiting` (where the 24h SLA flags it and wait-status names the bad
 * entry) rather than proceeding as if uncoupled. Dropping used to be the behaviour, and it was
 * fail-OPEN: a version-skewed federation peer or a corrupted legacy row would execute a release
 * whose author explicitly declared a prerequisite. Deliberately returns rather than throws
 * (`purposeOf`-style) — a throw at the sweep would let ONE bad row brick `advanceWaitingChanges`
 * for every healthy waiter behind it; "unsatisfiable, skip, surface" contains the blast radius to
 * the one change that carries the junk. Propose-time typed validation (Zod + `at` resolution) is
 * unchanged — these entries can only arrive PAST the API.
 */
export function requiresOf(properties: Record<string, unknown> | null | undefined): ParsedRequires {
  const requires = properties?.requires;
  if (requires === undefined || requires === null) return { requirements: [], malformed: [] };
  if (!Array.isArray(requires)) return { requirements: [], malformed: [requires] };
  const requirements: { key: string; at: string }[] = [];
  const malformed: unknown[] = [];
  for (const r of requires) {
    if (r && typeof r === "object") {
      const { key, at } = r as { key?: unknown; at?: unknown };
      if (typeof key === "string" && key.length > 0 && typeof at === "string" && at.length > 0) {
        requirements.push({ key, at });
        continue;
      }
    }
    malformed.push(r);
  }
  return { requirements, malformed };
}

/** `stageDependenciesOf`'s parse result — the same two-field contract as `ParsedRequires`, and for
 *  the same reason: callers must treat any `malformed` entry as an UNSATISFIABLE dependency. */
export interface ParsedStageDependencies {
  stageDependencies: ResolvedStageDependency[];
  /** Stored `stageDependencies` entries that do not parse — verbatim, for diagnostics. When
   *  `properties.stageDependencies` is present but not an array at all, the whole raw value is one
   *  entry. */
  malformed: unknown[];
}

/** A stage dependency as STORED: `dependsOn` and every `atTargets` member are already object ids,
 *  resolved at propose time. The wire shape (`StageDependency`) is identical in structure but its
 *  string fields are ids-OR-URNs; the two are kept as separate types so a reader can never mistake
 *  an unresolved caller reference for a resolved one. */
export interface ResolvedStageDependency {
  dependsOn: string;
  minWeight?: number;
  atTargets?: string[];
}

/**
 * Stage-scoped component couplings a change declared (ADR-0028), off `properties.stageDependencies`
 * — each a `{ dependsOn, minWeight?, atTargets? }` whose object references are already ids
 * (resolved at propose time by `proposeChange`).
 *
 * NARROWS AND COLLECTS, exactly as `requiresOf` does above, and for the identical reason: a
 * malformed entry is NOT silently dropped, because dropping one fails OPEN — the release would
 * deploy with no hold at all, ahead of the very component its author named. It is returned under
 * `malformed` for the hold to treat as unsatisfiable and surface. Deliberately RETURNS rather than
 * throws: a throw in the per-target executing loop would let one corrupt row wedge every other
 * target in the same tick, where "unsatisfiable, hold, surface" contains the blast radius to the one
 * change carrying the junk.
 *
 * A `minWeight` outside 1..100, or a non-integer, makes the WHOLE entry malformed rather than
 * degrading it to the universal succeeded-test. The two inputs are not the same: an ABSENT
 * `minWeight` means "no weight qualifier was asked for", which has a right answer; a present but
 * nonsensical one means somebody DID ask and asked for something we cannot honour — the same
 * distinction `typeOf` draws below. Propose-time Zod validation makes these unreachable through the
 * API, and `proposeChange` no longer stores a caller's raw `properties.stageDependencies` at all —
 * so a malformed entry can only be a row written before that (or one repaired by hand). The narrower
 * stays because "unsatisfiable, hold, surface" is the only reading of such a row that is not
 * fail-open.
 *
 * ============================================================================================
 * KNOWN LIMITATION: A DECLARATION IS CHANGE-SCOPED, AND IS APPLIED TO EVERY TARGET
 * ============================================================================================
 * `properties.stageDependencies` hangs off the CHANGE. Nothing in it records WHICH of the change's
 * targets a given entry was declared for, so `reconcile.ts` parses this once per change and
 * evaluates the whole set against every one of that change's wave targets. For a change targeting
 * [A, B] where only A's CI declared `dependsOn: C`, **B is held behind C as well.**
 *
 * WHY IT IS NOT FIXED HERE. There is no data to fix it FROM. ADR-0028 decision 5 has the
 * microservice's own CI declare its own dependencies, and a webhook-born change targets exactly one
 * component (`webhook-processor.ts`) — 277 of 281 measured changes, so the declaration and the
 * target coincide and the over-application is unobservable. A multi-target change arrives through
 * the API or campaign fan-out with ONE array and several targets, and the association between an
 * entry and a target simply was never carried. `materialiseStageDependencyEdges` above takes the
 * same reading — it mints an edge from EVERY target to `dependsOn` — so the breadth is already a
 * standing graph fact for such a change, not something this parse could narrow after the event.
 *
 * WHAT THE SHAPE WOULD NEED TO BE. One optional field on `StageDependencySchema`, e.g.
 * `forComponents?: string[]` — component ids/URNs, resolved at propose time exactly as `dependsOn`
 * and `atTargets` already are, absent meaning "every target of this change" so existing declarations
 * keep their current meaning. `atTargets` cannot stand in for it: that axis is deployment-targets
 * (WHERE the coupling applies), and this one is components (WHOSE coupling it is). The hold would
 * filter on it beside the existing `atTargets` filter, and `materialiseStageDependencyEdges` would
 * mint edges only from the named components. Additive request field, so the oasdiff gate stays
 * green. Recorded in ADR-0028's Non-goals; `stage-dependency-hold.integration.test.ts` pins the
 * current breadth so a future narrowing has a red test to flip rather than a silent behaviour swap.
 */
export function stageDependenciesOf(
  properties: Record<string, unknown> | null | undefined
): ParsedStageDependencies {
  const raw = properties?.stageDependencies;
  if (raw === undefined || raw === null) return { stageDependencies: [], malformed: [] };
  if (!Array.isArray(raw)) return { stageDependencies: [], malformed: [raw] };
  const stageDependencies: ResolvedStageDependency[] = [];
  const malformed: unknown[] = [];
  for (const entry of raw) {
    if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      const { dependsOn, minWeight, atTargets } = entry as {
        dependsOn?: unknown;
        minWeight?: unknown;
        atTargets?: unknown;
      };
      const weightOk =
        minWeight === undefined ||
        (typeof minWeight === "number" &&
          Number.isInteger(minWeight) &&
          minWeight >= 1 &&
          minWeight <= 100);
      const targetsOk =
        atTargets === undefined ||
        (Array.isArray(atTargets) && atTargets.every((t) => typeof t === "string" && t.length > 0));
      if (typeof dependsOn === "string" && dependsOn.length > 0 && weightOk && targetsOk) {
        stageDependencies.push({
          dependsOn,
          ...(minWeight === undefined ? {} : { minWeight: minWeight as number }),
          ...(atTargets === undefined ? {} : { atTargets: atTargets as string[] })
        });
        continue;
      }
    }
    malformed.push(entry);
  }
  return { stageDependencies, malformed };
}

/**
 * WHICH pipeline a change rolls, read back off its persisted properties (M12 P4A / ADR-0007) — the
 * routing Type, the counterpart to `targetObjectIdsOf`, and the ONLY place that knows how the Type is
 * stored on a change.
 *
 * ABSENT reads as 'configuration' (the server default). That covers every change written without an
 * explicit Type.
 *
 * PRESENT BUT UNRECOGNISED throws, deliberately, rather than degrading to a default. The two inputs
 * look similar and are not: absent means "nobody said", which has a right answer; a value this
 * version doesn't know means somebody DID say, and said something we cannot honour. Coercing it to a
 * default would trigger the wrong pipeline for a release that explicitly declared otherwise — the
 * exact wrong-pipeline failure P4A exists to prevent, and unrecoverable in a way that refusing is
 * not. This is ALSO the version-skew safety net for the hard cutover (ADR-0007 D3): the retired
 * 'infra'/'software' values now hit this throw, so a change carrying a pre-cutover Type is refused
 * rather than silently mis-routed. It is a REACHABLE case: Types are additive by design, federation
 * is hub-and-spoke with air-gap bundles, and `federation/promotion-repo.ts` replays a peer's change
 * properties verbatim — so a version-skewed peer can hand this function a Type it has never heard of.
 *
 * Narrowed against the enum rather than cast: `properties` is free-form jsonb, so a blind `as` would
 * let junk reach `getExecutorBinding`, which matches no binding and silently falls back to the
 * default fake-executor — a "nothing happened, no error" failure.
 */
export function typeOf(properties: Record<string, unknown> | null | undefined): ExecutorType {
  const raw = properties?.type;
  if (raw === undefined || raw === null) return "configuration";
  if (ExecutorTypeSchema.options.includes(raw as ExecutorType)) return raw as ExecutorType;
  throw badRequest(
    `change carries type '${String(raw)}', which this version does not recognise — refusing to guess which pipeline to drive. ` +
      `The retired 'infra'/'software' values were replaced by the Type taxonomy (ADR-0007); if this change was promoted from another domain, that domain is likely running a different CommanderSCP.`
  );
}

export interface ListChangesQuery {
  cursor?: string | undefined;
  limit: number;
  state?: ChangeState | undefined;
}

export async function listChanges(
  tx: TenantTx,
  orgId: string,
  query: ListChangesQuery
): Promise<{ items: Change[]; nextCursor: string | null }> {
  const cursor = query.cursor ? decodeCursor(query.cursor) : null;
  const conditions = [eq(changes.orgId, orgId)];
  if (query.state) conditions.push(eq(changes.state, query.state));
  if (cursor) {
    conditions.push(keysetAfter(changes.createdAt, changes.objectId, cursor));
  }

  const rows = await tx
    .select({ change: changes, object: objects })
    .from(changes)
    .innerJoin(objects, eq(changes.objectId, objects.id))
    .where(and(...conditions))
    .orderBy(...keysetOrderBy(changes.createdAt, changes.objectId))
    .limit(query.limit + 1);

  const hasMore = rows.length > query.limit;
  const page = hasMore ? rows.slice(0, query.limit) : rows;
  const last = page[page.length - 1];
  return {
    items: page.map((r) => toChangeShape(r.change, r.object)),
    nextCursor:
      hasMore && last
        ? encodeCursor({ createdAt: last.change.createdAt, id: last.change.objectId })
        : null
  };
}
