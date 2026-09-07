import { and, eq, isNull } from "drizzle-orm";
import type { TenantTx } from "../db/tenant-tx.js";
import { objects, relationships } from "../db/schema.js";
import { getOrgRootObjectId } from "../graph/objects-repo.js";

/** Which release topology a change inherits, and from where. See docs/coordination.md §661. */

/** Which rung of the walk supplied the topology. `explicit` never reaches this module. */
export type PipelineRung = "component" | "service" | "organization";

export interface ResolvedRung {
  rung: PipelineRung;
  /** The object the winning `releases_via` edge hangs off — the rung's subject, for the Decision. */
  attachedToObjectId: string;
  topologyObjectId: string;
  topologyVersion: number;
}

export interface PipelineResolution {
  /** `null` when nothing resolved, or when the targets disagreed. */
  resolved: ResolvedRung | null;
  /**
   * Why `resolved` is null, or `null` when it is not.
   * `no_pipeline` — no rung had an edge. `targets_disagree` — see `resolvePipelineForTargets`.
   */
  reason: "no_pipeline" | "targets_disagree" | null;
  /** Per-target outcome, for the Decision. One entry per target, in the order given. */
  perTarget: {
    targetObjectId: string;
    rung: PipelineRung | null;
    topologyObjectId: string | null;
  }[];
}

/** The live attachment edge and its version, or null. See docs/coordination.md §662. */
async function attachedTopology(
  tx: TenantTx,
  orgId: string,
  fromId: string
): Promise<{ topologyObjectId: string; topologyVersion: number } | null> {
  const rows = await tx
    .select({ id: objects.id, version: objects.version })
    .from(relationships)
    .innerJoin(objects, eq(objects.id, relationships.toId))
    .where(
      and(
        eq(relationships.orgId, orgId),
        eq(relationships.typeId, "releases_via"),
        eq(relationships.fromId, fromId),
        isNull(relationships.deletedAt),
        eq(objects.orgId, orgId),
        eq(objects.typeId, "release-topology"),
        isNull(objects.deletedAt)
      )
    );
  const row = rows[0];
  if (!row || rows.length !== 1) return null;
  return { topologyObjectId: row.id, topologyVersion: row.version };
}

/** The component's owning service, via the `contains` edge walked INBOUND (`to_id` = component). */
/** The CONTAINER ANCESTORS of a component, nearest first. See docs/coordination.md §663. */
async function containerAncestorIds(
  tx: TenantTx,
  orgId: string,
  componentObjectId: string
): Promise<string[]> {
  const ancestors: string[] = [];
  const seen = new Set<string>([componentObjectId]);
  let current = componentObjectId;
  for (let hop = 0; hop < MAX_CONTAINER_HOPS; hop += 1) {
    const row = await tx.query.relationships.findFirst({
      where: (t, { eq: eqOp, and: andOp, isNull: isNullOp }) =>
        andOp(
          eqOp(t.orgId, orgId),
          eqOp(t.typeId, "contains"),
          eqOp(t.toId, current),
          isNullOp(t.deletedAt)
        )
    });
    if (!row || seen.has(row.fromId)) break;
    ancestors.push(row.fromId);
    seen.add(row.fromId);
    current = row.fromId;
  }
  return ancestors;
}

/** `intermediate-grouping.md` D2 — the depth cap, in `contains` hops. */
const MAX_CONTAINER_HOPS = 3;

/** Resolves one target's pipeline, nearest rung first. See docs/coordination.md §664. */
export async function resolvePipelineForTarget(
  tx: TenantTx,
  orgId: string,
  targetObjectId: string
): Promise<ResolvedRung | null> {
  const own = await attachedTopology(tx, orgId, targetObjectId);
  if (own) {
    return { rung: "component", attachedToObjectId: targetObjectId, ...own };
  }

  // RUNG 2, now a LADDER (migration 0055 / intermediate-grouping D1): the component's assembly is
  // consulted before its service, so the nearest declaration wins. The rung is still reported as
  // `service` — it is the wire enum and widening it would be an oasdiff break for a distinction the
  // `attachedToObjectId` already carries, since that names the exact object the edge hangs off.
  for (const ancestorId of await containerAncestorIds(tx, orgId, targetObjectId)) {
    const viaAncestor = await attachedTopology(tx, orgId, ancestorId);
    if (viaAncestor) {
      return { rung: "service", attachedToObjectId: ancestorId, ...viaAncestor };
    }
  }

  const orgRootId = await getOrgRootObjectId(tx, orgId);
  const viaOrg = await attachedTopology(tx, orgId, orgRootId);
  if (viaOrg) {
    return { rung: "organization", attachedToObjectId: orgRootId, ...viaOrg };
  }

  return null;
}

/** Resolves the pipeline for a change's whole target set. See docs/coordination.md §665. */
export async function resolvePipelineForTargets(
  tx: TenantTx,
  orgId: string,
  targetObjectIds: string[]
): Promise<PipelineResolution> {
  const perTarget: PipelineResolution["perTarget"] = [];
  const resolvedPerTarget: (ResolvedRung | null)[] = [];

  for (const targetObjectId of targetObjectIds) {
    const hit = await resolvePipelineForTarget(tx, orgId, targetObjectId);
    resolvedPerTarget.push(hit);
    perTarget.push({
      targetObjectId,
      rung: hit?.rung ?? null,
      topologyObjectId: hit?.topologyObjectId ?? null
    });
  }

  const first = resolvedPerTarget[0];
  if (!first) {
    // Nothing on the first target. If NO target resolved, that is the ordinary "no pipeline
    // configured" case; if some did, the set disagrees.
    const anyResolved = resolvedPerTarget.some((r) => r !== null);
    return { resolved: null, reason: anyResolved ? "targets_disagree" : "no_pipeline", perTarget };
  }

  const uniform = resolvedPerTarget.every(
    (r) => r !== null && r.topologyObjectId === first.topologyObjectId
  );
  if (!uniform) return { resolved: null, reason: "targets_disagree", perTarget };

  return { resolved: first, reason: null, perTarget };
}
