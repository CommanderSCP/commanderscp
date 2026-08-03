import { and, eq, isNull, sql } from "drizzle-orm";
import type { ComponentPipelineResponse, ComponentPipelineStage } from "@scp/schemas";
import type { TenantTx } from "../db/tenant-tx.js";
import { changes, changeWaveTargets, changeWaves, changePlans, objects } from "../db/schema.js";
import { listExecutorBindingsForTarget } from "./executor-bindings-repo.js";
import { resolvePipelineForTarget } from "./pipeline-resolution.js";
import { ensureFederationSelf } from "../federation/self-repo.js";

/**
 * A COMPONENT'S PIPELINE — its stages, derived from durable graph state.
 *
 * ============================================================================================
 * WHY THIS EXISTS, AND WHAT IT REPLACES
 * ============================================================================================
 * The pipeline surface used to be keyed on a CHANGE (`/changes/{id}/pipeline`), so a component with
 * nothing in flight had no pipeline at all — the service board's link renders only when the row has a
 * `latestChangeId`. That is a RUN view wearing a pipeline's name, and it inverted the model: a
 * pipeline is a durable property of a component, and artifacts move THROUGH it.
 *
 * Everything here is read from state that exists whether or not anything is releasing:
 *   - the STAGES are the component's `placement`s (ADR-0026) — this component at each place;
 *   - what EXECUTES at a stage is that placement's executor binding;
 *   - the pipeline DEFINITION and the rung it was inherited from come from `pipeline-resolution.ts`.
 * Only `current` reads change rows, and it is legitimately null for a stage nothing has released to.
 *
 * ============================================================================================
 * WHAT IS DELIBERATELY NOT OBSERVED
 * ============================================================================================
 * Per-stage VERSION (the design's "version staircase") needs an `observe()`-captured version/digest
 * — coordination-ui-views.md Phase 4a, unbuilt. Every stage therefore carries `version: null` AND
 * lists `"version"` in its `unknownFields`, so a client renders "not observed" rather than a blank
 * that reads as "no version". Same rule the service board and the graph health surfaces follow.
 */

/** The most recent wave target for each placement — "what last happened at this stage". */
async function currentByPlacement(
  tx: TenantTx,
  orgId: string,
  placementIds: string[]
): Promise<Map<string, ComponentPipelineStage["current"]>> {
  const out = new Map<string, ComponentPipelineStage["current"]>();
  if (placementIds.length === 0) return out;
  // DISTINCT ON the placement, newest change first — one row per stage, the latest to touch it.
  // Ordered by the change's `created_at` then id (UUIDv7, time-ordered) so two changes created in
  // the same transaction still order deterministically, the same tiebreak `getLatestCampaignPlan`
  // documents.
  const rows = await tx.execute<{
    target_object_id: string;
    change_id: string;
    change_name: string | null;
    change_state: string | null;
    wave_name: string | null;
    target_status: string | null;
  }>(sql`
    SELECT DISTINCT ON (t.target_object_id)
      t.target_object_id,
      o.id     AS change_id,
      o.name   AS change_name,
      c.state  AS change_state,
      w.name   AS wave_name,
      t.status AS target_status
    FROM ${changeWaveTargets} t
    JOIN ${changeWaves} w  ON w.id = t.wave_id AND w.org_id = t.org_id
    JOIN ${changePlans} p  ON p.id = w.plan_id AND p.org_id = w.org_id
    JOIN ${changes} c      ON c.object_id = p.change_object_id AND c.org_id = p.org_id
    JOIN ${objects} o      ON o.id = c.object_id AND o.org_id = c.org_id
    WHERE t.org_id = ${orgId}::uuid
      AND o.deleted_at IS NULL
      AND t.target_object_id IN (${sql.join(
        placementIds.map((id) => sql`${id}::uuid`),
        sql`, `
      )})
    ORDER BY t.target_object_id, c.created_at DESC, c.object_id DESC
  `);
  for (const r of rows.rows) {
    out.set(r.target_object_id, {
      changeId: r.change_id,
      changeName: r.change_name,
      changeState: r.change_state,
      waveName: r.wave_name,
      targetStatus: r.target_status
    });
  }
  return out;
}

export async function getComponentPipeline(
  tx: TenantTx,
  orgId: string,
  component: { id: string; urn: string; name: string }
): Promise<ComponentPipelineResponse> {
  // STAGES = placements, read from `properties` — the source of truth for the pair (ADR-0026 D17),
  // and the same half `binding-resolution.ts` and `plan-service.ts` read.
  const placementRows = await tx
    .select({ id: objects.id, urn: objects.urn, properties: objects.properties })
    .from(objects)
    .where(
      and(
        eq(objects.orgId, orgId),
        eq(objects.typeId, "placement"),
        isNull(objects.deletedAt),
        sql`${objects.properties} ->> 'componentId' = ${component.id}`
      )
    );

  const current = await currentByPlacement(
    tx,
    orgId,
    placementRows.map((p) => p.id)
  );
  const self = await ensureFederationSelf(tx, orgId);

  const stages: ComponentPipelineStage[] = [];
  for (const p of placementRows) {
    const props = p.properties as { deploymentTargetId?: unknown };
    const targetId = typeof props.deploymentTargetId === "string" ? props.deploymentTargetId : null;
    const target = targetId
      ? await tx.query.objects.findFirst({
          where: (t, { eq: eqOp, and: andOp }) => andOp(eqOp(t.id, targetId), eqOp(t.orgId, orgId))
        })
      : undefined;
    const tProps = (target?.properties ?? {}) as { environment?: unknown; region?: unknown };
    const environment = typeof tProps.environment === "string" ? tProps.environment : null;
    const region = typeof tProps.region === "string" ? tProps.region : null;

    // ADR-0026 D1: `<origin domain>-[<region>-]<environment>`, and ONLY for a target carrying an
    // `environment`. The domain segment comes from the target's OWN `origin_domain_id`, never from
    // this instance — otherwise a replicated target derives one name at the commander and another at
    // an outpost, which D1 rules out explicitly.
    const domainLabel = target?.originDomainId === self.domainId ? self.name : null;
    const stageName =
      environment && domainLabel
        ? [domainLabel, region, environment].filter(Boolean).join("-")
        : null;

    const bindings = await listExecutorBindingsForTarget(tx, orgId, p.id);
    const binding = bindings[0];
    let executionSystemName: string | null = null;
    if (binding?.executionSystemId) {
      const sys = await tx.query.objects.findFirst({
        where: (t, { eq: eqOp, and: andOp }) =>
          andOp(eqOp(t.id, binding.executionSystemId!), eqOp(t.orgId, orgId))
      });
      executionSystemName = sys?.name ?? null;
    }

    stages.push({
      placement: { id: p.id, urn: p.urn },
      deploymentTarget: {
        id: target?.id ?? targetId ?? "",
        name: target?.name ?? "(unresolved)",
        environment,
        region
      },
      stageName,
      binding: binding
        ? {
            externalRef: binding.externalRef ?? null,
            type: binding.type,
            executionSystemId: binding.executionSystemId ?? null,
            executionSystemName
          }
        : null,
      current: current.get(p.id) ?? null,
      version: null,
      // See the module header: always unknown until Phase 4a, and said so explicitly rather than
      // shipped as a confident blank.
      unknownFields: ["version"]
    });
  }

  // Order stages by the topology's wave order where one names these targets, so they read
  // left-to-right in RELEASE order. Falls back to target name, which is at least stable.
  const resolved = await resolvePipelineForTarget(tx, orgId, component.id);
  let waveOrder: string[] = [];
  if (resolved) {
    const topo = await tx.query.objects.findFirst({
      where: (t, { eq: eqOp, and: andOp }) =>
        andOp(eqOp(t.id, resolved.topologyObjectId), eqOp(t.orgId, orgId))
    });
    const doc = (topo?.properties ?? {}) as { waves?: { targets?: unknown }[] };
    waveOrder = (doc.waves ?? []).flatMap((w) =>
      Array.isArray(w.targets) ? w.targets.filter((t): t is string => typeof t === "string") : []
    );
  }
  stages.sort((a, b) => {
    const ai = waveOrder.indexOf(a.deploymentTarget.id);
    const bi = waveOrder.indexOf(b.deploymentTarget.id);
    if (ai !== bi)
      return (
        (ai === -1 ? Number.MAX_SAFE_INTEGER : ai) - (bi === -1 ? Number.MAX_SAFE_INTEGER : bi)
      );
    return a.deploymentTarget.name.localeCompare(b.deploymentTarget.name);
  });

  let pipeline: ComponentPipelineResponse["pipeline"] = null;
  if (resolved) {
    const attachedTo = await tx.query.objects.findFirst({
      where: (t, { eq: eqOp, and: andOp }) =>
        andOp(eqOp(t.id, resolved.attachedToObjectId), eqOp(t.orgId, orgId))
    });
    const topo = await tx.query.objects.findFirst({
      where: (t, { eq: eqOp, and: andOp }) =>
        andOp(eqOp(t.id, resolved.topologyObjectId), eqOp(t.orgId, orgId))
    });
    pipeline = {
      topologyObjectId: resolved.topologyObjectId,
      topologyName: topo?.name ?? null,
      topologyVersion: resolved.topologyVersion ?? null,
      rung: resolved.rung,
      attachedToObjectId: resolved.attachedToObjectId,
      attachedToName: attachedTo?.name ?? null
    };
  }

  return {
    component: { id: component.id, urn: component.urn, name: component.name },
    pipeline,
    stages,
    unknownFields: []
  };
}
