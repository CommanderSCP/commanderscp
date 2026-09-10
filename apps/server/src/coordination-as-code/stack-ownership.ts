import { and, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { objects } from "../db/schema.js";
import type { TenantTx } from "../db/tenant-tx.js";

/** THE SOLE WRITER OF `managed_by_stack`. See docs/coordination-as-code.md §166. */

/** Stamps the stack onto every object, skipping owned rows. See docs/coordination-as-code.md §167. */
export async function stampObjectStackOwnership(
  tx: TenantTx,
  orgId: string,
  stackName: string,
  objectIds: readonly string[]
): Promise<void> {
  if (objectIds.length === 0) return;
  await tx
    .update(objects)
    .set({ managedByStack: stackName })
    .where(
      and(
        eq(objects.orgId, orgId),
        inArray(objects.id, [...objectIds]),
        isNull(objects.deletedAt),
        // Spelled out, because the builder has no such helper. See docs/coordination-as-code.md §168.
        or(isNull(objects.managedByStack), ne(objects.managedByStack, stackName))
      )
    );
}

/** A relationship's identity for stamping: the same `(typeId, fromId, toId)` triple the diff carries. */
export interface RelationshipOwnershipTriple {
  typeId: string;
  fromId: string;
  toId: string;
}

/** The relationship half. See docs/coordination-as-code.md §169. */
export async function stampRelationshipStackOwnership(
  tx: TenantTx,
  orgId: string,
  stackName: string,
  triples: readonly RelationshipOwnershipTriple[]
): Promise<void> {
  if (triples.length === 0) return;
  const values = sql.join(
    triples.map((t) => sql`(${t.typeId}::text, ${t.fromId}::uuid, ${t.toId}::uuid)`),
    sql`, `
  );
  await tx.execute(sql`
    UPDATE relationships AS r
       SET managed_by_stack = ${stackName}
      FROM (VALUES ${values}) AS v(type_id, from_id, to_id)
     WHERE r.org_id = ${orgId}::uuid
       AND r.deleted_at IS NULL
       AND r.type_id = v.type_id
       AND r.from_id = v.from_id
       AND r.to_id = v.to_id
       AND r.managed_by_stack IS DISTINCT FROM ${stackName}
  `);
}
