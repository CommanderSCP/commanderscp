import type { GraphObject } from "@scp/schemas";

/** Raw `execute` returns untyped rows, so map them here. See docs/graph.md §161. */
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
  provenance: string | null;
  /** A plain boolean, unlike the bigints above. See docs/graph.md §162. */
  domain_local: boolean;
  /** M20.7 (ADR-0031 §6c). Both nullable and written together; all four raw call sites `SELECT *`. */
  domain_local_inherited_from: string | null;
  domain_local_inherited_from_urn: string | null;
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
    provenance: row.provenance as GraphObject["provenance"],
    domainLocal: row.domain_local,
    domainLocalInheritedFrom: row.domain_local_inherited_from
      ? { id: row.domain_local_inherited_from, urn: row.domain_local_inherited_from_urn ?? "" }
      : null,
    version: Number(row.version),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    deletedAt: row.deleted_at ? toIso(row.deleted_at) : null
  };
}
