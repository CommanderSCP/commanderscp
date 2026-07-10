import { sql } from "drizzle-orm";
import type {
  GraphObject,
  GraphQueryRequest,
  GraphQueryResult,
  NamedGraphQuery
} from "@scp/schemas";
import type { TenantTx } from "../db/tenant-tx.js";
import { mapRawObjectRow, type RawObjectRow } from "./raw-row-mappers.js";
import { sqlIn, sqlInOrAlways } from "./sql-helpers.js";
// M5 layering note (DESIGN.md §5/§9.5): `initiative-rollup` is the one named query whose
// implementation reaches into `coordination/` rather than staying pure graph traversal — an
// initiative's roll-up status is genuinely a coordination-engine concept (derived from campaign
// wave/member-change state, `coordination/campaign-status.ts`), not something expressible as a
// relationship/object traversal alone. Kept here (rather than a parallel dispatcher) because the
// charter's contract is "the intelligence questions become canned, parameterized API queries at
// `/graph/query/{name}`" — duplicating that surface for one query would be the worse trade.
import { toGraphObject } from "./objects-repo.js";
import { campaignsCoordinatedByInitiative } from "../coordination/initiative-repo.js";
import { getCampaignStatus } from "../coordination/campaign-repo.js";

/**
 * Named graph queries (DESIGN.md §5): depth-limited recursive CTEs over indexed adjacency,
 * cycle-detected via a path array, depth ≤ 10. Every query here is org-scoped (the `relationships`/
 * `objects` RLS policies apply — these run inside the caller's `withTenantTx`, same as any other
 * read) and soft-delete-aware.
 */

const DEFAULT_IMPACT_TYPES = ["depends_on", "consumes", "hosted_on"];

/**
 * Transitive reverse closure: "what points at `startId` (directly or transitively) via any of
 * `relTypes`" — i.e. walk edges backward from `startId`. This is DESIGN.md §5's `impact-of`
 * example, generalized over the relationship-type set so `dependents-of`/`consumers-of`/
 * `impact-of` share one implementation.
 */
async function transitiveReverseClosure(
  tx: TenantTx,
  orgId: string,
  startId: string,
  relTypes: string[],
  maxDepth: number
): Promise<GraphObject[]> {
  const typeFilter = sqlIn("r.type_id", relTypes);
  const result = await tx.execute<RawObjectRow>(sql`
    WITH RECURSIVE closure AS (
      SELECT r.from_id AS id, 1 AS depth, ARRAY[${startId}::uuid, r.from_id] AS path
      FROM relationships r
      WHERE r.to_id = ${startId}::uuid AND r.org_id = ${orgId}::uuid AND r.deleted_at IS NULL
        AND ${typeFilter}
      UNION ALL
      SELECT r.from_id, c.depth + 1, c.path || r.from_id
      FROM relationships r
      JOIN closure c ON r.to_id = c.id
      WHERE r.org_id = ${orgId}::uuid AND r.deleted_at IS NULL
        AND ${typeFilter}
        AND NOT r.from_id = ANY(c.path)
        AND c.depth < ${maxDepth}
    )
    SELECT DISTINCT o.* FROM closure c
    JOIN objects o ON o.id = c.id
    WHERE o.org_id = ${orgId}::uuid AND o.deleted_at IS NULL
  `);
  return result.rows.map(mapRawObjectRow);
}

async function ownersOf(
  tx: TenantTx,
  orgId: string,
  startId: string,
  maxDepth: number
): Promise<GraphObject[]> {
  const result = await tx.execute<RawObjectRow>(sql`
    WITH RECURSIVE containment AS (
      SELECT ${startId}::uuid AS id, 0 AS depth
      UNION ALL
      SELECT o.domain_id, c.depth + 1
      FROM objects o
      JOIN containment c ON o.id = c.id
      WHERE o.org_id = ${orgId}::uuid AND o.domain_id IS NOT NULL AND c.depth < ${maxDepth}
    )
    SELECT DISTINCT o.* FROM relationships r
    JOIN containment c ON r.to_id = c.id
    JOIN objects o ON o.id = r.from_id
    WHERE r.type_id = 'owns' AND r.org_id = ${orgId}::uuid AND r.deleted_at IS NULL
      AND o.org_id = ${orgId}::uuid AND o.deleted_at IS NULL
  `);
  return result.rows.map(mapRawObjectRow);
}

async function pathsBetween(
  tx: TenantTx,
  orgId: string,
  startId: string,
  targetId: string,
  relTypes: string[] | null,
  maxDepth: number
): Promise<{ objects: GraphObject[]; paths: string[][] }> {
  const typeFilter = sqlInOrAlways("r.type_id", relTypes);
  const result = await tx.execute<{ id: string; path: string[]; path_len: number }>(sql`
    WITH RECURSIVE search AS (
      SELECT r.to_id AS id, 1 AS depth, ARRAY[r.from_id, r.to_id] AS path
      FROM relationships r
      WHERE r.from_id = ${startId}::uuid AND r.org_id = ${orgId}::uuid AND r.deleted_at IS NULL
        AND ${typeFilter}
      UNION ALL
      SELECT r.to_id, s.depth + 1, s.path || r.to_id
      FROM relationships r
      JOIN search s ON r.from_id = s.id
      WHERE r.org_id = ${orgId}::uuid AND r.deleted_at IS NULL
        AND ${typeFilter}
        AND NOT r.to_id = ANY(s.path)
        AND s.depth < ${maxDepth}
    )
    -- array_length(path, 1) must be in the SELECT list to ORDER BY it under SELECT DISTINCT.
    SELECT DISTINCT path, array_length(path, 1) AS path_len
    FROM search WHERE id = ${targetId}::uuid ORDER BY path_len ASC LIMIT 5
  `);

  const paths = result.rows.map((r) => r.path);
  const involvedIds = [...new Set(paths.flat())];
  if (involvedIds.length === 0) return { objects: [], paths: [] };

  const objRows = await tx.execute<RawObjectRow>(sql`
    SELECT * FROM objects WHERE org_id = ${orgId}::uuid AND ${sqlIn("id", involvedIds)} AND deleted_at IS NULL
  `);
  return { objects: objRows.rows.map(mapRawObjectRow), paths };
}

/** Nearest ancestor of type `domain` (falling back to `organization`) for each impacted object. */
async function groupByDomain(
  tx: TenantTx,
  orgId: string,
  objectIds: string[]
): Promise<Record<string, number>> {
  if (objectIds.length === 0) return {};
  const result = await tx.execute<{ domain_urn: string; count: number }>(sql`
    WITH RECURSIVE ancestry AS (
      SELECT id AS start_id, id, domain_id, type_id, 0 AS depth FROM objects
      WHERE org_id = ${orgId}::uuid AND ${sqlIn("id", objectIds)}
      UNION ALL
      SELECT a.start_id, o.id, o.domain_id, o.type_id, a.depth + 1
      FROM objects o
      JOIN ancestry a ON o.id = a.domain_id
      WHERE o.org_id = ${orgId}::uuid AND a.depth < 10 AND a.type_id NOT IN ('domain', 'organization')
    ),
    nearest AS (
      SELECT DISTINCT ON (a.start_id) a.start_id, a.id, o.urn
      FROM ancestry a
      JOIN objects o ON o.id = a.id
      WHERE a.type_id IN ('domain', 'organization')
      ORDER BY a.start_id, a.depth ASC
    )
    SELECT urn AS domain_urn, count(*)::int AS count FROM nearest GROUP BY urn
  `);
  return Object.fromEntries(result.rows.map((r) => [r.domain_urn, r.count]));
}

export async function runNamedQuery(
  tx: TenantTx,
  orgId: string,
  name: NamedGraphQuery,
  params: GraphQueryRequest
): Promise<GraphQueryResult> {
  const relTypes = params.relTypes ?? null;

  switch (name) {
    case "owners-of": {
      const objs = await ownersOf(tx, orgId, params.objectId, params.maxDepth);
      return { query: name, objects: objs };
    }
    case "dependents-of": {
      const objs = await transitiveReverseClosure(
        tx,
        orgId,
        params.objectId,
        relTypes ?? ["depends_on"],
        params.maxDepth
      );
      return { query: name, objects: objs };
    }
    case "consumers-of": {
      const objs = await transitiveReverseClosure(
        tx,
        orgId,
        params.objectId,
        relTypes ?? ["consumes"],
        params.maxDepth
      );
      return { query: name, objects: objs };
    }
    case "impact-of": {
      const objs = await transitiveReverseClosure(
        tx,
        orgId,
        params.objectId,
        relTypes ?? DEFAULT_IMPACT_TYPES,
        params.maxDepth
      );
      return { query: name, objects: objs };
    }
    case "blast-radius": {
      const objs = await transitiveReverseClosure(
        tx,
        orgId,
        params.objectId,
        relTypes ?? DEFAULT_IMPACT_TYPES,
        params.maxDepth
      );
      const counts: Record<string, number> = {};
      for (const o of objs) {
        counts[`type:${o.typeId}`] = (counts[`type:${o.typeId}`] ?? 0) + 1;
        if (o.domainId) counts[`domain:${o.domainId}`] = (counts[`domain:${o.domainId}`] ?? 0) + 1;
      }
      return { query: name, objects: objs, counts };
    }
    case "domains-impacted": {
      const objs = await transitiveReverseClosure(
        tx,
        orgId,
        params.objectId,
        relTypes ?? DEFAULT_IMPACT_TYPES,
        params.maxDepth
      );
      const counts = await groupByDomain(
        tx,
        orgId,
        objs.map((o) => o.id)
      );
      return { query: name, objects: objs, counts };
    }
    case "paths-between": {
      if (!params.targetId) throw new Error("paths-between requires targetId");
      const { objects: objs, paths } = await pathsBetween(
        tx,
        orgId,
        params.objectId,
        params.targetId,
        relTypes,
        params.maxDepth
      );
      return { query: name, objects: objs, paths };
    }
    case "initiative-rollup": {
      // DESIGN §9.5: "roll-up status DERIVED BY TRAVERSAL... not stored/duplicated state" — walks
      // `coordinates` from the initiative to its member campaigns (org-scoped by construction,
      // same as every query in this file) and tallies each campaign's own PURE derived status
      // (coordination/campaign-status.ts) into `counts`, the same "counts by tag" shape
      // `blast-radius`/`domains-impacted` already use above.
      const campaignRows = await campaignsCoordinatedByInitiative(tx, orgId, params.objectId);
      const counts: Record<string, number> = {};
      for (const row of campaignRows) {
        const status = await getCampaignStatus(tx, orgId, row.id);
        counts[`status:${status}`] = (counts[`status:${status}`] ?? 0) + 1;
      }
      return { query: name, objects: campaignRows.map(toGraphObject), counts };
    }
  }
}
