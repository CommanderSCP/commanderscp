import type { GraphObject } from "@scp/schemas";

/**
 * `tx.execute(sql\`...\`)` (used by the recursive-CTE named queries and traversal — drizzle's
 * query builder can't express those) returns *raw* pg driver rows: literal snake_case column
 * names, and `bigint` columns (`revision`, `version`) come back as strings (node-postgres's
 * default int8 handling, to avoid precision loss) rather than the numbers drizzle's query
 * builder would produce via its `bigint({ mode: 'number' })` column type. `objects-repo.ts`'s
 * `toGraphObject` assumes the query-builder shape, so raw-SQL call sites map through here
 * instead — same public `GraphObject` shape, correct field names and types either way.
 */
export type RawObjectRow = {
  id: string;
  org_id: string;
  domain_id: string | null;
  type_id: string;
  name: string;
  urn: string;
  properties: unknown;
  labels: unknown;
  origin_domain_id: string;
  revision: string | number;
  version: string | number;
  created_at: Date | string;
  updated_at: Date | string;
  deleted_at: Date | string | null;
};

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export function mapRawObjectRow(row: RawObjectRow): GraphObject {
  return {
    id: row.id,
    orgId: row.org_id,
    domainId: row.domain_id,
    typeId: row.type_id,
    name: row.name,
    urn: row.urn,
    properties: (row.properties as Record<string, unknown>) ?? {},
    labels: (row.labels as Record<string, unknown>) ?? {},
    originDomainId: row.origin_domain_id,
    revision: Number(row.revision),
    version: Number(row.version),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    deletedAt: row.deleted_at ? toIso(row.deleted_at) : null
  };
}
