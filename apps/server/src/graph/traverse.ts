import { sql } from "drizzle-orm";
import type {
  SubgraphRequest,
  SubgraphResult,
  TraverseRequest,
  TraverseResult
} from "@scp/schemas";
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

/** Generic bounded `/graph/traverse` (DESIGN.md §5). See docs/graph.md §194. */
export async function traverse(
  tx: TenantTx,
  orgId: string,
  req: TraverseRequest,
  /** The caller's readable object-id set. See docs/graph.md §195. */
  readableIds: ReadonlySet<string> | null
): Promise<TraverseResult> {
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

  const objects = objRows.rows.map(mapRawObjectRow);
  const edges = edgeRows.rows.map((e) => ({
    id: e.id,
    typeId: e.type_id,
    fromId: e.from_id,
    toId: e.to_id
  }));
  if (readableIds === null) return { objects, edges };
  // Intersect with the caller's readable set: an object only if readable, an edge only if BOTH
  // endpoints are readable (so no edge reveals a non-readable neighbour).
  return {
    objects: objects.filter((o) => readableIds.has(o.id)),
    edges: edges.filter((e) => readableIds.has(e.fromId) && readableIds.has(e.toId))
  };
}

/** Induced-subgraph edges over an explicit object-id set. See docs/graph.md §196. */
export async function subgraph(
  tx: TenantTx,
  orgId: string,
  req: SubgraphRequest,
  /** The caller's readable object-id set, or `null` for an org-root reader — see {@link traverse}.
   *  An edge is returned only when BOTH endpoints are readable, so a caller cannot use a
   *  caller-supplied `ids` set to discover edges among objects it lacks `object:read` on. */
  readableIds: ReadonlySet<string> | null
): Promise<SubgraphResult> {
  const edgeRows = await tx.execute<EdgeRow>(sql`
    SELECT id, type_id, from_id, to_id FROM relationships
    WHERE org_id = ${orgId}::uuid AND deleted_at IS NULL
      AND ${sqlIn("from_id", req.ids)} AND ${sqlIn("to_id", req.ids)}
  `);
  const edges = edgeRows.rows.map((e) => ({
    id: e.id,
    typeId: e.type_id,
    fromId: e.from_id,
    toId: e.to_id
  }));
  return {
    edges:
      readableIds === null
        ? edges
        : edges.filter((e) => readableIds.has(e.fromId) && readableIds.has(e.toId))
  };
}
