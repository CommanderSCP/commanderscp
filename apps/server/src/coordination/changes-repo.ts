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
import {
  withBoundaryBundleChecksum,
  withPromotionExport,
  type PromotionExportStamp
} from "../federation/boundary-bundle-ref.js";

/** `change_status` journal entries aren't tied to a graph object's own `content_hash` (that one
 *  covers the change's static metadata; this covers the lifecycle-state snapshot) — hashed
 *  independently so a state-only change (e.g. a transition) still produces a distinct, verifiable
 *  content_hash on its journal entry. */
export function changeStatusContentHash(payload: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

export type ChangeRow = typeof changes.$inferSelect;
type ObjectRow = typeof objects.$inferSelect;
/** The minimal object shape `toChangeShape` actually reads. See docs/coordination.md §262. */
type ObjectLike = Pick<ObjectRow, "id" | "urn" | "name"> & {
  properties: unknown;
  originDomainId: string;
  // M20-A3 (ADR-0031 §5) — the change's locality lives on the underlying graph OBJECT's own
  // `domain_local` column (stamped there by `createObject`, inherited from the change's targets at
  // `proposeChange` above), not on the `changes` projection row — mirroring `originDomainId` right
  // above, which reads off the same object for the same reason.
  domainLocal: boolean;
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
    originDomainId: object.originDomainId,
    // M20-A3 (ADR-0031 §5) — read straight off the underlying object, exactly like `originDomainId`
    // just above: `proposeChange` already computed this once (`changeIsDomainLocal`, inherited from
    // targets) and stamped it onto the object at create; this is not a second computation.
    domainLocal: object.domainLocal
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
  /** WHICH pipeline of its targets this change rolls. See docs/coordination.md §263. */
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
  /** Who declared these, when not who the change is from. See docs/coordination.md §264. */
  declarationActorObjectId?: string;
  /** Set only when this Change IS a rollback of another change (coordination/rollback.ts). */
  rollbackOfObjectId?: string;
  /** Set when this change came from a promotion bundle. See docs/coordination.md §265. */
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
      // NOT "the owning service". See docs/coordination.md §266.
      return `pipeline inherited from the nearest containing service or assembly ${attachedToObjectId}`;
    case "organization":
      return `pipeline inherited from the org default on ${attachedToObjectId}`;
    default:
      return reason === "targets_disagree"
        ? "no pipeline: the change's targets resolve to different pipelines, so none is inherited"
        : "no pipeline: no releases_via edge on the target, its containing service or assembly, or the org root";
  }
}

/** Creates a Change. See docs/coordination.md §267. */
export async function proposeChange(
  tx: TenantTx,
  input: ProposeChangeInput
): Promise<{ change: Change; targetObjectIds: string[] }> {
  if (input.targets.length === 0) throw badRequest("a change must target at least one object");

  const targetObjectIds: string[] = [];
  // M20.3 (ADR-0031 §5) — a change INHERITS locality from its targets, resolved in the loop that
  // already reads every one of them.
  const targetLocality: { urn: string; domainLocal: boolean }[] = [];
  for (const idOrUrn of input.targets) {
    const target = await getObjectByIdOrUrnAnyType(tx, input.orgId, idOrUrn);
    targetObjectIds.push(target.id);
    targetLocality.push({ urn: target.urn, domainLocal: target.domainLocal });
  }

  // A CHANGE MAY NOT SPAN A LOCALITY BOUNDARY. See docs/coordination.md §268.
  const localTargets = targetLocality.filter((t) => t.domainLocal);
  if (localTargets.length > 0 && localTargets.length !== targetLocality.length) {
    const shared = targetLocality.filter((t) => !t.domainLocal).map((t) => t.urn);
    throw badRequest(
      `a change cannot span a locality boundary: domain-local target(s) ` +
        `${localTargets.map((t) => t.urn).join(", ")} cannot be released together with ` +
        `non-domain-local target(s) ${shared.join(", ")}. A domain-local object never leaves its ` +
        `security domain, so a change covering both could neither be reported upward without ` +
        `leaking nor withheld without hiding the shared release (ADR-0031 §5). Propose them as ` +
        `separate changes.`
    );
  }
  const changeIsDomainLocal = localTargets.length > 0;

  // Resolve each requirement now, so a typo 404s at propose. See docs/coordination.md §269.
  const resolvedRequires =
    input.requires === undefined
      ? []
      : await Promise.all(
          input.requires.map(async (req) => ({
            key: req.key,
            at: (await getObjectByIdOrUrnAnyType(tx, input.orgId, req.at)).id
          }))
        );
  // ADR-0028: resolve every stage dependency's `dependsOn`. See docs/coordination.md §270.
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
  // Stage dependencies follow the typed-field-only idiom. See docs/coordination.md §271.
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

  // PIPELINE RESOLUTION (ADR-0026, §5, D4/D15). See docs/coordination.md §272.
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
    // Type precedence (M12 P4A / ADR-0007). See docs/coordination.md §273.
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
    labels: input.labels,
    // M20.3 (ADR-0031 §5) — the change object inherits its targets' locality, so releasing a
    // domain-local component produces a change that is itself invisible to every peer. Every
    // downstream withholding follows from this one field: `createObject` skips the change's own
    // journal entry and its audit segment, and the `change_status` entries below read it back.
    domainLocal: changeIsDomainLocal
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

  // Journal entry kinds richer than the generic upsert. See docs/coordination.md §274.
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
    // A domain-local change's status gets no journal sequence. See docs/coordination.md §275.
    if (!changeIsDomainLocal) {
      await appendJournalEntry(tx, {
        orgId: input.orgId,
        entryKind: "change_status",
        contentHash: changeStatusContentHash(payload),
        payload
      });
    }
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

  // Materialised from the resolved typed field only. See docs/coordination.md §276.
  if (resolvedStageDependencies !== undefined) {
    await materialiseStageDependencyEdges(tx, input, targetObjectIds, resolvedStageDependencies);
  }

  return { change: toChangeShape(row, object), targetObjectIds };
}

/** Declared stage dependencies become `depends_on` edges. See docs/coordination.md §277. */
async function materialiseStageDependencyEdges(
  tx: TenantTx,
  input: Pick<
    ProposeChangeInput,
    "orgId" | "actorObjectId" | "requestId" | "declarationActorObjectId"
  >,
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
      // The pre-check sees this loop's own uncommitted inserts. See docs/coordination.md §278.

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

      // An unusable endpoint is already refused before here. See docs/coordination.md §279.
      await createRelationship(tx, {
        orgId: input.orgId,
        actorObjectId: input.declarationActorObjectId ?? input.actorObjectId,
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

/** Batch fetch for the reconciliation loop. See docs/coordination.md §280. */
export async function listChangeRowsInStates(
  tx: TenantTx,
  orgId: string,
  states: ChangeState[],
  limit: number,
  selfDomainId: TrustDomainId
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
        isNull(changes.reconcileBlockedAt),
        eq(objects.originDomainId, selfDomainId)
      )
    )
    .orderBy(asc(changes.reconcileCursorAt))
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

/** Stamps a bundle's checksum onto the change's source ref. See docs/coordination.md §281. */
export async function stampBoundaryBundleChecksum(
  tx: TenantTx,
  orgId: string,
  changeObjectId: string,
  checksum: string,
  promotionExport?: PromotionExportStamp
): Promise<void> {
  // `FOR UPDATE`: this is a read-modify-write of a JSONB list. See docs/coordination.md §282.
  const [row] = await tx
    .select({ sourceRef: changes.sourceRef })
    .from(changes)
    .where(and(eq(changes.orgId, orgId), eq(changes.objectId, changeObjectId)))
    .limit(1)
    .for("update");
  if (!row) return;
  const stamped = withBoundaryBundleChecksum(row.sourceRef, checksum);
  const next = promotionExport ? withPromotionExport(stamped, promotionExport) : stamped;
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

/** Cross-change prerequisites a change REQUIRES. See docs/coordination.md §283. */
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

/** Stage-scoped component couplings a change declared. See docs/coordination.md §284. */
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

/** Which pipeline a change rolls, read back off properties. See docs/coordination.md §285. */
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
