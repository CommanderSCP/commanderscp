import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { TenantTx } from "../db/tenant-tx.js";
import { executorBindings, objects, relationships, sourceMappings } from "../db/schema.js";
import { ensureFederationSelf } from "../federation/self-repo.js";

/** GRAPH INTEGRITY — rows that outlived the object they hang off. See docs/graph.md §53. */

export interface DanglingRelationship {
  id: string;
  typeId: string;
  /** Which end is dead — both, when a delete took out two related objects. */
  deadEnd: "from" | "to" | "both";
  fromUrn: string;
  toUrn: string;
  /** A replica edge cannot be repaired locally (single-writer authority); reported, never actioned. */
  repairable: boolean;
}

export interface OrphanProjectionRow {
  id: string;
  /** The DEAD object the row hangs off, named for the operator. */
  ownerUrn: string;
  ownerName: string;
  detail: string;
}

export interface GraphIntegrityReport {
  danglingRelationships: DanglingRelationship[];
  orphanSourceMappings: OrphanProjectionRow[];
  orphanExecutorBindings: OrphanProjectionRow[];
  /** A live placement whose component or deployment-target is dead (ADR-0026 D17 reads the pair
   *  from `properties`, so this cannot be expressed as a foreign key). */
  orphanPlacements: OrphanProjectionRow[];
}

/** Every integrity finding for one org, in one read-only pass. See docs/graph.md §54. */
export async function findGraphIntegrityIssues(
  tx: TenantTx,
  orgId: string
): Promise<GraphIntegrityReport> {
  // The REAL helper, not a duck-typed probe. An earlier draft reached for `tx.query.federationSelf`
  // with optional chaining, which yields `undefined` rather than throwing when the shape is not what
  // was assumed — and every edge would then be reported `repairable: true`, including replica edges a
  // repair run can never delete. A silently-wrong default in an integrity report is worse than none.
  const self = await ensureFederationSelf(tx, orgId);
  const selfDomainId = self.domainId;

  const fromObj = sql`from_o`;
  const toObj = sql`to_o`;
  const dangling = await tx.execute(sql`
    select r.id, r.type_id, r.origin_domain_id,
           ${fromObj}.urn as from_urn, ${toObj}.urn as to_urn,
           (${fromObj}.deleted_at is not null) as from_dead,
           (${toObj}.deleted_at is not null) as to_dead
    from ${relationships} r
    join ${objects} from_o on from_o.id = r.from_id
    join ${objects} to_o   on to_o.id   = r.to_id
    where r.org_id = ${orgId}
      and r.deleted_at is null
      and (from_o.deleted_at is not null or to_o.deleted_at is not null)
    order by r.type_id, r.id
  `);

  const danglingRelationships: DanglingRelationship[] = (
    dangling as unknown as {
      rows?: Record<string, unknown>[];
    }
  ).rows!.map((row) => {
    const fromDead = row.from_dead === true;
    const toDead = row.to_dead === true;
    return {
      id: String(row.id),
      typeId: String(row.type_id),
      deadEnd: fromDead && toDead ? "both" : fromDead ? "from" : "to",
      fromUrn: String(row.from_urn),
      toUrn: String(row.to_urn),
      // A replica edge is NOT repairable here: `deleteRelationship` refuses it, and it must not be
      // reported as actionable or a repair run would fail on rows it can never fix.
      repairable: row.origin_domain_id === selfDomainId
    };
  });

  const orphanSourceMappings = (
    await tx
      .select({
        id: sourceMappings.id,
        ownerUrn: objects.urn,
        ownerName: objects.name,
        sourceKind: sourceMappings.sourceKind,
        repoPattern: sourceMappings.repoPattern,
        pathPattern: sourceMappings.pathPattern,
        type: sourceMappings.type
      })
      .from(sourceMappings)
      .innerJoin(objects, eq(objects.id, sourceMappings.componentObjectId))
      .where(and(eq(sourceMappings.orgId, orgId), sql`${objects.deletedAt} is not null`))
  ).map((r) => ({
    id: r.id,
    ownerUrn: r.ownerUrn,
    ownerName: r.ownerName,
    detail: `${r.sourceKind}:${r.repoPattern ?? "*"}:${r.pathPattern ?? "*"} (${r.type})`
  }));

  const orphanExecutorBindings = (
    await tx
      .select({
        id: executorBindings.id,
        ownerUrn: objects.urn,
        ownerName: objects.name,
        type: executorBindings.type,
        externalRef: executorBindings.externalRef
      })
      .from(executorBindings)
      .innerJoin(objects, eq(objects.id, executorBindings.targetObjectId))
      .where(and(eq(executorBindings.orgId, orgId), sql`${objects.deletedAt} is not null`))
  ).map((r) => ({
    id: r.id,
    ownerUrn: r.ownerUrn,
    ownerName: r.ownerName,
    detail: `${r.type} -> ${r.externalRef ?? "(no external ref)"}`
  }));

  // A placement reads its pair from `properties` (ADR-0026 D17), so no foreign key can express
  // this and it has to be a join on the id text.
  const placements = await tx
    .select({
      id: objects.id,
      urn: objects.urn,
      name: objects.name,
      properties: objects.properties
    })
    .from(objects)
    .where(
      and(eq(objects.orgId, orgId), eq(objects.typeId, "placement"), isNull(objects.deletedAt))
    );
  // Every placement's pair of ends, collected up front — ONE query for the whole set's liveness
  // instead of one per placement.
  const placementEnds = placements.map((placement) => {
    const props = placement.properties as { componentId?: unknown; deploymentTargetId?: unknown };
    const ends = [props.componentId, props.deploymentTargetId].filter(
      (v): v is string => typeof v === "string"
    );
    return { placement, ends };
  });
  const allEndIds = [...new Set(placementEnds.flatMap(({ ends }) => ends))];
  const liveRows =
    allEndIds.length === 0
      ? []
      : await tx
          .select({ id: objects.id })
          .from(objects)
          .where(
            and(eq(objects.orgId, orgId), isNull(objects.deletedAt), inArray(objects.id, allEndIds))
          );
  const liveIds = new Set(liveRows.map((r) => r.id));

  const orphanPlacements: OrphanProjectionRow[] = [];
  for (const { placement, ends } of placementEnds) {
    if (ends.length !== 2) continue;
    const liveCount = ends.filter((e) => liveIds.has(e)).length;
    if (liveCount < 2) {
      orphanPlacements.push({
        id: placement.id,
        ownerUrn: placement.urn,
        ownerName: placement.name,
        detail: "component or deployment-target is deleted"
      });
    }
  }

  return {
    danglingRelationships,
    orphanSourceMappings,
    orphanExecutorBindings,
    orphanPlacements
  };
}
