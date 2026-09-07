import { sql } from "drizzle-orm";
import type {
  GraphObject,
  GraphQueryRequest,
  GraphQueryResult,
  NamedGraphQuery
} from "@scp/schemas";
import type { TenantTx } from "../db/tenant-tx.js";
import { WALK_TRUNCATION_PROBE_DEPTH, walkDepthExceeded } from "./containment.js";
import { mapRawObjectRow, type RawObjectRow } from "./raw-row-mappers.js";
import { sqlIn, sqlInOrAlways } from "./sql-helpers.js";

/** Named graph queries (DESIGN.md §5). See docs/graph.md §64. */

const DEFAULT_IMPACT_TYPES = ["depends_on", "consumes", "hosted_on"];

/** Transitive reverse closure. See docs/graph.md §65. */
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
      SELECT r.from_id AS id, 1 AS depth
      FROM relationships r
      WHERE r.to_id = ${startId}::uuid AND r.org_id = ${orgId}::uuid AND r.deleted_at IS NULL
        AND ${typeFilter}
      UNION
      SELECT r.from_id, c.depth + 1
      FROM relationships r
      JOIN closure c ON r.to_id = c.id
      WHERE r.org_id = ${orgId}::uuid AND r.deleted_at IS NULL
        AND ${typeFilter}
        AND r.from_id != ${startId}::uuid
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
  const result = await tx.execute<{ domain_urn: string; count: number; truncated: boolean }>(sql`
    WITH RECURSIVE ancestry AS (
      SELECT id AS start_id, id, domain_id, type_id, 0 AS depth FROM objects
      WHERE org_id = ${orgId}::uuid AND ${sqlIn("id", objectIds)}
      UNION ALL
      SELECT a.start_id, o.id, o.domain_id, o.type_id, a.depth + 1
      FROM objects o
      JOIN ancestry a ON o.id = a.domain_id
      -- ADR-0037 probe: one past the shared bound. This walk has NO branching (domain_id is a
      -- single column), and expansion stops AT the first domain/organization row — so a row
      -- landing at the probe depth proves that start object found no domain within the bound,
      -- not that some second path kept going. Before this, such an object silently VANISHED from
      -- the grouping (absent from 'nearest' = absent from the counts).
      WHERE o.org_id = ${orgId}::uuid AND a.depth < ${WALK_TRUNCATION_PROBE_DEPTH}
        AND a.type_id NOT IN ('domain', 'organization')
    ),
    nearest AS (
      SELECT DISTINCT ON (a.start_id) a.start_id, a.id, o.urn
      FROM ancestry a
      JOIN objects o ON o.id = a.id
      WHERE a.type_id IN ('domain', 'organization')
      ORDER BY a.start_id, a.depth ASC
    )
    SELECT urn AS domain_urn, count(*)::int AS count, false AS truncated FROM nearest GROUP BY urn
    UNION ALL
    SELECT o.urn AS domain_urn, 0 AS count, true AS truncated
    FROM ancestry a JOIN objects o ON o.id = a.start_id
    WHERE a.depth >= ${WALK_TRUNCATION_PROBE_DEPTH}
  `);
  const cut = result.rows.filter((r) => r.truncated).map((r) => r.domain_urn);
  if (cut.length > 0) {
    throw walkDepthExceeded(
      `the domain ancestry of ${cut.slice(0, 3).join(", ")}${cut.length > 3 ? ", …" : ""}`,
      `Grouping by domain would silently drop such objects from the counts.`
    );
  }
  return Object.fromEntries(result.rows.map((r) => [r.domain_urn, r.count]));
}

/** Keep only the objects the caller may read (`object:read` scope). `null` = org-root reader, no
 *  filter — see routes/graph.ts / traverse.ts for why this is applied on TOP of the `graph:query`
 *  authorization the route already did. */
function filterReadable(
  objs: GraphObject[],
  readableIds: ReadonlySet<string> | null
): GraphObject[] {
  return readableIds === null ? objs : objs.filter((o) => readableIds.has(o.id));
}

export async function runNamedQuery(
  tx: TenantTx,
  orgId: string,
  name: NamedGraphQuery,
  params: GraphQueryRequest,
  /** The caller's readable object-id set. See docs/graph.md §66. */
  readableIds: ReadonlySet<string> | null
): Promise<GraphQueryResult> {
  const relTypes = params.relTypes ?? null;

  switch (name) {
    case "owners-of": {
      const objs = filterReadable(
        await ownersOf(tx, orgId, params.objectId, params.maxDepth),
        readableIds
      );
      return { query: name, objects: objs };
    }
    case "dependents-of": {
      const objs = filterReadable(
        await transitiveReverseClosure(
          tx,
          orgId,
          params.objectId,
          relTypes ?? ["depends_on"],
          params.maxDepth
        ),
        readableIds
      );
      return { query: name, objects: objs };
    }
    case "consumers-of": {
      const objs = filterReadable(
        await transitiveReverseClosure(
          tx,
          orgId,
          params.objectId,
          relTypes ?? ["consumes"],
          params.maxDepth
        ),
        readableIds
      );
      return { query: name, objects: objs };
    }
    case "impact-of": {
      const objs = filterReadable(
        await transitiveReverseClosure(
          tx,
          orgId,
          params.objectId,
          relTypes ?? DEFAULT_IMPACT_TYPES,
          params.maxDepth
        ),
        readableIds
      );
      return { query: name, objects: objs };
    }
    case "blast-radius": {
      const objs = filterReadable(
        await transitiveReverseClosure(
          tx,
          orgId,
          params.objectId,
          relTypes ?? DEFAULT_IMPACT_TYPES,
          params.maxDepth
        ),
        readableIds
      );
      const counts: Record<string, number> = {};
      for (const o of objs) {
        counts[`type:${o.typeId}`] = (counts[`type:${o.typeId}`] ?? 0) + 1;
      }
      // Domain grouping MUST match `domains-impacted` (below). See docs/graph.md §67.
      const byDomain = await groupByDomain(
        tx,
        orgId,
        objs.map((o) => o.id)
      );
      for (const [urn, n] of Object.entries(byDomain)) counts[`domain:${urn}`] = n;
      return { query: name, objects: objs, counts };
    }
    case "domains-impacted": {
      const objs = filterReadable(
        await transitiveReverseClosure(
          tx,
          orgId,
          params.objectId,
          relTypes ?? DEFAULT_IMPACT_TYPES,
          params.maxDepth
        ),
        readableIds
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
      if (readableIds === null) return { query: name, objects: objs, paths };
      // A path is returned ONLY if EVERY node on it is readable — otherwise the path array would leak
      // the ids of non-readable intermediate hops. Objects are then narrowed to the surviving paths.
      const survivingPaths = paths.filter((p) => p.every((id) => readableIds.has(id)));
      const involved = new Set(survivingPaths.flat());
      return {
        query: name,
        objects: objs.filter((o) => involved.has(o.id)),
        paths: survivingPaths
      };
    }
  }
}
