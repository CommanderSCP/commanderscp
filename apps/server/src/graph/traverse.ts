import { sql } from "drizzle-orm";
import type { TraverseRequest, TraverseResult } from "@scp/schemas";
import type { TenantTx } from "../db/tenant-tx.js";
import { mapRawObjectRow, type RawObjectRow } from "./raw-row-mappers.js";
import { sqlIn, sqlInOrAlways } from "./sql-helpers.js";

// A type alias (not `interface`) — drizzle's `execute<TRow extends Record<string, unknown>>`
// constraint only structurally matches object type literals/aliases, not named interfaces.
type EdgeRow = {
  id: string;
  type_id: string;
  from_id: string;
  to_id: string;
};

/**
 * Generic bounded `/graph/traverse` (DESIGN.md §5) — direction, relationship-type set, depth ≤
 * 10, org-scoped. Backs the UI graph explorer / custom tooling where a named query doesn't fit.
 *
 * Two steps: (1) a recursive CTE walks `direction` edges from `objectId` up to `maxDepth`,
 * building the visited node set; (2) the returned edge set is the *induced subgraph* on that
 * node set (every live relationship with both endpoints visited) — richer than just the tree
 * edges used to reach each node, which is what a graph explorer actually wants to render.
 */
export async function traverse(tx: TenantTx, orgId: string, req: TraverseRequest): Promise<TraverseResult> {
  const relTypes = req.relTypes ?? null;
  const wantOut = req.direction === "out" || req.direction === "both";
  const wantIn = req.direction === "in" || req.direction === "both";
  const walkTypeFilter = sqlInOrAlways("e.type_id", relTypes);

  const walkRows = await tx.execute<{ id: string }>(sql`
    WITH RECURSIVE edges AS (
      SELECT from_id AS src, to_id AS next_id, org_id, type_id, deleted_at
      FROM relationships WHERE ${wantOut}
      UNION ALL
      SELECT to_id AS src, from_id AS next_id, org_id, type_id, deleted_at
      FROM relationships WHERE ${wantIn}
    ),
    walk AS (
      SELECT ${req.objectId}::uuid AS id, 0 AS depth, ARRAY[${req.objectId}::uuid] AS path
      UNION ALL
      SELECT e.next_id, w.depth + 1, w.path || e.next_id
      FROM walk w
      JOIN edges e ON e.src = w.id
      WHERE e.org_id = ${orgId}::uuid AND e.deleted_at IS NULL
        AND ${walkTypeFilter}
        AND w.depth < ${req.maxDepth} AND NOT e.next_id = ANY(w.path)
    )
    SELECT DISTINCT id FROM walk
  `);

  const visitedIds = walkRows.rows.map((r) => r.id);
  if (visitedIds.length === 0) visitedIds.push(req.objectId);

  const [objRows, edgeRows] = await Promise.all([
    tx.execute<RawObjectRow>(sql`
      SELECT * FROM objects WHERE org_id = ${orgId}::uuid AND ${sqlIn("id", visitedIds)} AND deleted_at IS NULL
    `),
    tx.execute<EdgeRow>(sql`
      SELECT id, type_id, from_id, to_id FROM relationships
      WHERE org_id = ${orgId}::uuid AND deleted_at IS NULL
        AND ${sqlIn("from_id", visitedIds)} AND ${sqlIn("to_id", visitedIds)}
        AND ${sqlInOrAlways("type_id", relTypes)}
    `)
  ]);

  return {
    objects: objRows.rows.map(mapRawObjectRow),
    edges: edgeRows.rows.map((e) => ({ id: e.id, typeId: e.type_id, fromId: e.from_id, toId: e.to_id }))
  };
}
