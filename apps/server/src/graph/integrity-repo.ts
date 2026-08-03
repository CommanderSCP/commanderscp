import { and, eq, isNull, sql } from "drizzle-orm";
import type { TenantTx } from "../db/tenant-tx.js";
import { executorBindings, objects, relationships, sourceMappings } from "../db/schema.js";
import { ensureFederationSelf } from "../federation/self-repo.js";

/**
 * GRAPH INTEGRITY — rows that outlived the object they hang off.
 *
 * ============================================================================================
 * WHY THIS EXISTS AS A REPORT RATHER THAN A GUARD
 * ============================================================================================
 * `deleteObject` now cascades: it tombstones every edge touching the object, through
 * `deleteRelationship`, so each gets its own audit event and journal entry. That closes the
 * SOURCE. It cannot close the BACKLOG, and by design it never will close two cases:
 *
 *   - rows stranded by a delete that ran BEFORE the cascade shipped. On the live homelab that is
 *     the ADR-0026 §6 pair merges: five components soft-deleted on 2026-08-02/03, leaving 52
 *     dangling edges, 12 source mappings and 1 executor binding behind.
 *   - REPLICA edges (`origin_domain_id != self`). The cascade skips them deliberately — single-writer
 *     authority means only the authoring domain may tombstone them — so such an edge legitimately
 *     outlives a locally-deleted object until its own authority catches up.
 *
 * A guard that only stops NEW strandings leaves both. Hence a report: it is the only thing that can
 * see rows already in the database, and it stays useful after the cascade is doing its job.
 *
 * ============================================================================================
 * THESE ARE INERT, AND SAYING SO IS PART OF THE REPORT'S HONESTY
 * ============================================================================================
 * Every read path already filters them: `containment.ts` skips deleted ancestors (so no policy or
 * role binding governs through a dead node), `correlation.ts`'s `componentIsLive()` drops events
 * correlated to a dead component, and `targetObjectIsLive` hides a stranded binding. This is
 * hygiene, not an outage — the report must not imply otherwise, or it becomes an alarm that gets
 * muted.
 */

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
  /** `source_mappings.id` / `executor_bindings.id`. */
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

/**
 * Every integrity finding for one org, in one read-only pass.
 *
 * Scoped by `orgId` and run inside `withTenantTx` like every other repo function — this is a
 * TENANT report, not an instance-wide one, so an operator in one org can never enumerate another's
 * object names through it.
 */
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
  const orphanPlacements: OrphanProjectionRow[] = [];
  for (const placement of placements) {
    const props = placement.properties as { componentId?: unknown; deploymentTargetId?: unknown };
    const ends = [props.componentId, props.deploymentTargetId].filter(
      (v): v is string => typeof v === "string"
    );
    if (ends.length !== 2) continue;
    const live = await tx
      .select({ id: objects.id })
      .from(objects)
      .where(
        and(
          eq(objects.orgId, orgId),
          isNull(objects.deletedAt),
          sql`${objects.id} in (${sql.join(
            ends.map((e) => sql`${e}::uuid`),
            sql`, `
          )})`
        )
      );
    if (live.length < 2) {
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
