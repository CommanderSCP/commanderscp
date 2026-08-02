import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import {
  categoryOfType,
  type ChangePlan,
  type ChangeWaveTarget,
  type ExecutorType
} from "@scp/schemas";
import type { TenantTx } from "../db/tenant-tx.js";
import {
  changePlans,
  changeWaveTargets,
  changeWaves,
  objects,
  relationships
} from "../db/schema.js";
import { badRequest, notFound } from "../errors.js";
import {
  compilePlan,
  type DependsOnEdge,
  type StagePlacement,
  type TopologyWaveSpec
} from "./plan-compiler.js";
import { typeOf } from "./changes-repo.js";

/** Reads `depends_on` edges among `targetIds` directly from the graph (DESIGN §9.3: "wave order
 * is computed from graph `depends_on` edges"). Both endpoints must be in `targetIds` — edges
 * pointing outside the change's target set don't constrain this plan's wave order. */
async function loadDependsOnEdges(
  tx: TenantTx,
  orgId: string,
  targetIds: string[]
): Promise<DependsOnEdge[]> {
  if (targetIds.length === 0) return [];
  const rows = await tx
    .select({ fromId: relationships.fromId, toId: relationships.toId })
    .from(relationships)
    .where(
      and(
        eq(relationships.orgId, orgId),
        eq(relationships.typeId, "depends_on"),
        inArray(relationships.fromId, targetIds),
        inArray(relationships.toId, targetIds),
        isNull(relationships.deletedAt)
      )
    );
  return rows.map((r) => ({ from: r.fromId, to: r.toId }));
}

/** Wave keys the compiler understands. Anything else is a typo or a key from a newer authority. */
const KNOWN_WAVE_KEYS = new Set(["name", "mode", "targets", "requiresFanIn"]);

/**
 * Parses a snapshotted topology document into wave specs, FAILING LOUDLY on anything malformed.
 *
 * ============================================================================================
 * WHAT THIS USED TO DO, AND WHY IT WAS A HAZARD (§1.5, §11 — one property, three instances)
 * ============================================================================================
 * This function returned `undefined` whenever `document.waves` was not an array. `compilePlan`
 * treats `undefined` as "no topology" and falls back to a bare toposort — so a MALFORMED topology
 * compiled successfully to one anonymous wave, and attaching it had no visible effect whatsoever.
 * A silently-ignored configuration is worse than a rejected one: the operator sees a topology
 * attached, a plan compiled, and a release run, with nothing anywhere saying the document was junk.
 *
 * The same property had three instances, and fixing only the named one would have left two:
 *
 *   1. `waves` not an array          -> returned `undefined`   (the instance §1.5 named)
 *   2. `waves: []`                   -> `compilePlan`'s `length === 0` branch ALSO falls back to
 *                                       toposort, so an explicitly empty topology is equally silent
 *   3. `waves as TopologyWaveSpec[]` -> an unchecked cast: no wave was ever validated, so
 *                                       `{mode: "paralel"}` or a missing `targets` reached the
 *                                       compiler as garbage
 *
 * All three now throw. `additionalProperties` on the wave is enforced HERE rather than in the
 * registered JSON Schema — see the note below.
 *
 * ============================================================================================
 * WHY UNKNOWN-KEY REJECTION IS HERE AND NOT IN THE REGISTERED SCHEMA (D16 vs migration 0043)
 * ============================================================================================
 * D16 asks for `additionalProperties: false` on the wave object in `release-topology`'s registered
 * property schema. That would work, and it would also re-create the exact hazard migration 0043
 * documented at length: `release-topology` is a GRAPH OBJECT, so it rides `object_upsert` and is
 * re-validated with Ajv on the RECEIVING side, whose branch has no try/catch — one unknown key from
 * a newer commander aborts the WHOLE SYNC BUNDLE for that outpost, not just the entry. 0043's rule
 * is "strict at the operator's door, open on the wire", and it exists because this was paid for
 * once already.
 *
 * Enforcing it here delivers D16's intent without that: an unknown wave key is refused LOUDLY, at
 * the moment it would otherwise be silently ignored, and it is refused for federated documents too
 * — at the point of USE rather than the point of receipt, so a bad document fails one change
 * instead of wedging a peer's entire sync. It also covers what the registered schema structurally
 * cannot: `topology_document` is a SNAPSHOT taken at compile time, and Ajv never re-validates it.
 *
 * This is a deliberate deviation from D16's letter, in favour of D16's purpose plus 0043's rule.
 */
function parseTopologyWaves(document: unknown): TopologyWaveSpec[] | undefined {
  if (document === null || document === undefined) return undefined;
  if (typeof document !== "object") {
    throw badRequest(`release topology document is not an object (got ${typeof document})`);
  }
  const waves = (document as { waves?: unknown }).waves;
  // A topology with NO `waves` key at all is not malformed — it simply declares no ordering, which
  // is the pre-topology behaviour and what the registered schema permits. An EMPTY one is different:
  // someone wrote `waves: []`, which can only mean a mistake, and it would silently compile to the
  // same single anonymous wave as having no topology at all.
  if (waves === undefined) return undefined;
  if (!Array.isArray(waves)) {
    throw badRequest(
      `release topology 'waves' must be an array (got ${waves === null ? "null" : typeof waves}) — a malformed topology is refused rather than silently ignored`
    );
  }
  if (waves.length === 0) {
    throw badRequest(
      "release topology declares an empty 'waves' array — that would compile to a single anonymous wave, exactly as if no topology were attached at all"
    );
  }

  return waves.map((wave, i) => {
    const where = `release topology wave ${i}`;
    if (!wave || typeof wave !== "object" || Array.isArray(wave)) {
      throw badRequest(`${where} is not an object`);
    }
    const w = wave as Record<string, unknown>;
    for (const key of Object.keys(w)) {
      if (!KNOWN_WAVE_KEYS.has(key)) {
        throw badRequest(
          `${where} carries unknown key '${key}' — a key the compiler does not read would silently do nothing`
        );
      }
    }
    if (w.mode !== "parallel" && w.mode !== "sequential") {
      throw badRequest(
        `${where} has mode '${String(w.mode)}' — expected 'parallel' or 'sequential'`
      );
    }
    if (!Array.isArray(w.targets) || w.targets.length === 0) {
      throw badRequest(`${where} must name at least one target`);
    }
    if (!w.targets.every((t) => typeof t === "string" && t.length > 0)) {
      throw badRequest(`${where} has a non-string target`);
    }
    if (w.name !== undefined && typeof w.name !== "string") {
      throw badRequest(`${where} has a non-string name`);
    }
    if (w.requiresFanIn !== undefined && typeof w.requiresFanIn !== "boolean") {
      throw badRequest(`${where} has a non-boolean requiresFanIn`);
    }
    return {
      ...(typeof w.name === "string" ? { name: w.name } : {}),
      mode: w.mode,
      targets: w.targets as string[],
      ...(typeof w.requiresFanIn === "boolean" ? { requiresFanIn: w.requiresFanIn } : {})
    };
  });
}

/**
 * Decides whether a topology is STAGE-shaped (waves name deployment-targets — ADR-0026 §5) or
 * LEGACY-shaped (waves name the change's own targets), and resolves the placements stage mode
 * needs. Returns `undefined` for legacy, which leaves `compilePlan` on its original path.
 *
 * The classification is made from what the ids ARE, not from a flag on the document, because both
 * shapes exist in real data: the estate carries one topology naming deployment-targets and one
 * naming components. A MIXED topology is refused rather than guessed at — that is not a shape
 * anything can mean.
 */
async function resolveStagePlacements(
  tx: TenantTx,
  orgId: string,
  waves: TopologyWaveSpec[],
  targetObjectIds: string[]
): Promise<StagePlacement[] | undefined> {
  const waveTargetIds = [...new Set(waves.flatMap((w) => w.targets))];
  if (waveTargetIds.length === 0) return undefined;

  const rows = await tx
    .select({ id: objects.id, typeId: objects.typeId })
    .from(objects)
    .where(
      and(eq(objects.orgId, orgId), inArray(objects.id, waveTargetIds), isNull(objects.deletedAt))
    );
  const typeById = new Map(rows.map((r) => [r.id, r.typeId]));
  const places = waveTargetIds.filter((id) => typeById.get(id) === "deployment-target");

  if (places.length === 0) return undefined; // legacy shape — nothing here names a place
  if (places.length !== waveTargetIds.length) {
    const others = waveTargetIds.filter((id) => !places.includes(id));
    throw badRequest(
      `release topology mixes deployment-targets with non-places (${others.join(", ")}) — a wave names either the places a change rolls through or the change's own targets, never both`
    );
  }

  // Every placement of this change's components. Read from the PROPERTIES, which are the source of
  // truth for a placement's pair (ADR-0026 D17) and the half the unique index covers.
  const placementRows = await tx
    .select({ id: objects.id, properties: objects.properties })
    .from(objects)
    .where(
      and(eq(objects.orgId, orgId), eq(objects.typeId, "placement"), isNull(objects.deletedAt))
    );
  const componentSet = new Set(targetObjectIds);
  const placements: StagePlacement[] = [];
  for (const row of placementRows) {
    const props = row.properties as { componentId?: unknown; deploymentTargetId?: unknown };
    const componentObjectId = props.componentId;
    const deploymentTargetObjectId = props.deploymentTargetId;
    if (typeof componentObjectId !== "string" || typeof deploymentTargetObjectId !== "string") {
      continue;
    }
    if (!componentSet.has(componentObjectId)) continue;
    placements.push({ componentObjectId, deploymentTargetObjectId, placementObjectId: row.id });
  }
  return placements;
}

/**
 * Compiles and PERSISTS a change's plan (DESIGN §9.3: `plan -> waves -> wave_targets` rows). Pure
 * compilation is `plan-compiler.ts`'s job; this function does the DB I/O around it: resolving
 * `depends_on` edges, snapshotting the release topology document (if any) so a later topology
 * edit never retroactively changes an in-flight plan, and writing the rows.
 */
export async function compileAndPersistPlan(
  tx: TenantTx,
  input: {
    orgId: string;
    changeObjectId: string;
    targetObjectIds: string[];
    topologyObjectId: string | null;
    topologyVersion: number | null;
  }
): Promise<ChangePlan> {
  const dependsOn = await loadDependsOnEdges(tx, input.orgId, input.targetObjectIds);

  // WHICH pipeline this change rolls (M12 P4A / ADR-0007) — the routing Type, read from the change
  // itself rather than threaded through every caller — compileAndPersistPlan is invoked from
  // reconcile, campaigns, rollback, promotion and the routes, and a plan is always FOR a change, so
  // the change is the honest source. Every wave target of this change inherits it: one release = one
  // source = one pipeline (owner, 2026-07-15), so the Type is a property of the change, not of each
  // target. Changes with no `properties.type` fall back to 'configuration' (the server default).
  const changeRow = await tx.query.objects.findFirst({
    where: (t, { eq: eqOp, and: andOp }) =>
      andOp(eqOp(t.id, input.changeObjectId), eqOp(t.orgId, input.orgId))
  });
  const changeType = typeOf(changeRow?.properties as Record<string, unknown> | undefined);

  let topologyDocument: Record<string, unknown> | null = null;
  if (input.topologyObjectId) {
    const topology = await tx.query.objects.findFirst({
      where: (t, { eq: eqOp, and: andOp }) =>
        andOp(eqOp(t.id, input.topologyObjectId!), eqOp(t.orgId, input.orgId))
    });
    if (!topology) throw notFound(`release-topology '${input.topologyObjectId}' not found`);
    topologyDocument = topology.properties as Record<string, unknown>;
  }

  const topologyWaves = parseTopologyWaves(topologyDocument);
  const placements = topologyWaves
    ? await resolveStagePlacements(tx, input.orgId, topologyWaves, input.targetObjectIds)
    : undefined;

  const result = compilePlan({
    targets: input.targetObjectIds,
    dependsOn,
    ...(topologyWaves ? { topologyWaves } : {}),
    ...(placements ? { placements } : {})
  });

  if (!result.ok) {
    throw badRequest(`plan compilation failed: ${result.error} — ${JSON.stringify(result)}`);
  }

  const [planRow] = await tx
    .insert(changePlans)
    .values({
      id: uuidv7(),
      orgId: input.orgId,
      changeObjectId: input.changeObjectId,
      topologyObjectId: input.topologyObjectId,
      topologyVersion: input.topologyVersion,
      topologyDocument,
      status: "active"
    })
    .returning();
  if (!planRow) throw new Error("failed to insert change plan");

  const waveRows: (typeof changeWaves.$inferSelect)[] = [];
  const targetRows: (typeof changeWaveTargets.$inferSelect)[] = [];
  for (const wave of result.waves) {
    const [waveRow] = await tx
      .insert(changeWaves)
      .values({
        id: uuidv7(),
        orgId: input.orgId,
        planId: planRow.id,
        waveIndex: wave.waveIndex,
        name: wave.name,
        requiresFanIn: wave.requiresFanIn,
        // A stage wave whose place holds none of this change's components is born `skipped`, not
        // `pending`: both reconcilers already treat `skipped` as "nothing to wait for" when picking
        // the active wave, so this needs no engine change — it just finally PRODUCES a status the
        // engine has always been able to read. Left visible in the plan so an operator can see that
        // gamma was declared and had no participants, rather than wondering where it went.
        status: wave.skipped ? "skipped" : "pending"
      })
      .returning();
    if (!waveRow) throw new Error("failed to insert change wave");
    waveRows.push(waveRow);

    for (const targetObjectId of wave.targets) {
      const [targetRow] = await tx
        .insert(changeWaveTargets)
        .values({
          id: uuidv7(),
          orgId: input.orgId,
          waveId: waveRow.id,
          targetObjectId,
          // Every wave target of this change rolls the change's pipeline (M12 P4A). Persisted per
          // target — not re-read from the change at trigger time — so a plan stays a SNAPSHOT, the
          // same discipline the topology document already follows here.
          type: changeType,
          status: "pending"
        })
        .returning();
      if (!targetRow) throw new Error("failed to insert change wave target");
      targetRows.push(targetRow);
    }
  }

  return toChangePlanShape(planRow, waveRows, targetRows);
}

function toChangeWaveTargetShape(row: typeof changeWaveTargets.$inferSelect): ChangeWaveTarget {
  const waveTargetType = (row.type as ExecutorType | null) ?? "configuration";
  return {
    id: row.id,
    waveId: row.waveId,
    targetObjectId: row.targetObjectId,
    type: waveTargetType,
    category: categoryOfType(waveTargetType),
    executorPluginId: row.executorPluginId,
    executorRef: (row.executorRef as Record<string, unknown> | null) ?? null,
    // The snapshot reconcile persisted — the per-wave version (revision + deployed images) plus the
    // OBSERVE-ONLY rollout snapshot (P4D). The raw jsonb already carries all three once merged (P4B
    // revision + P4C images + P4D rollout); no query change.
    observed:
      (row.observedState as {
        revision?: string;
        images?: string[];
        rollout?: { phase?: string; step?: number; weight?: number; message?: string };
      } | null) ?? null,
    status: row.status,
    attempt: row.attempt,
    lastObservedAt: row.lastObservedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
  };
}

function toChangePlanShape(
  plan: typeof changePlans.$inferSelect,
  waves: (typeof changeWaves.$inferSelect)[],
  targets: (typeof changeWaveTargets.$inferSelect)[]
): ChangePlan {
  return {
    id: plan.id,
    changeObjectId: plan.changeObjectId,
    topologyObjectId: plan.topologyObjectId,
    topologyVersion: plan.topologyVersion,
    status: plan.status,
    createdAt: plan.createdAt.toISOString(),
    waves: waves
      .sort((a, b) => a.waveIndex - b.waveIndex)
      .map((w) => ({
        id: w.id,
        planId: w.planId,
        waveIndex: w.waveIndex,
        name: w.name,
        requiresFanIn: w.requiresFanIn,
        status: w.status,
        createdAt: w.createdAt.toISOString(),
        startedAt: w.startedAt?.toISOString() ?? null,
        completedAt: w.completedAt?.toISOString() ?? null,
        targets: targets.filter((t) => t.waveId === w.id).map(toChangeWaveTargetShape)
      }))
  };
}

export async function getLatestPlanForChange(
  tx: TenantTx,
  orgId: string,
  changeObjectId: string
): Promise<ChangePlan | null> {
  const planRow = await tx.query.changePlans.findFirst({
    where: (t, { eq: eqOp, and: andOp }) =>
      andOp(eqOp(t.orgId, orgId), eqOp(t.changeObjectId, changeObjectId)),
    orderBy: (t, { desc }) => [desc(t.createdAt)]
  });
  if (!planRow) return null;

  const waveRows = await tx
    .select()
    .from(changeWaves)
    .where(and(eq(changeWaves.orgId, orgId), eq(changeWaves.planId, planRow.id)))
    .orderBy(asc(changeWaves.waveIndex));
  const waveIds = waveRows.map((w) => w.id);
  const targetRows =
    waveIds.length === 0
      ? []
      : await tx
          .select()
          .from(changeWaveTargets)
          .where(
            and(eq(changeWaveTargets.orgId, orgId), inArray(changeWaveTargets.waveId, waveIds))
          );

  return toChangePlanShape(planRow, waveRows, targetRows);
}
