import { and, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { objects, relationships } from "../db/schema.js";
import type { TenantTx } from "../db/tenant-tx.js";

/** THE ONE MODULE THAT WRITES `managed_by_stack` on objects and relationships, and it has exactly two
 *  writers: STAMP (an apply claims what its manifest declares) and RELEASE (the audited
 *  `POST /stacks/{stackName}/release` door clears what a stack owns). See docs/coordination-as-code.md §166, §328. */

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

/** RELEASE: clears `stackName`'s ownership from these object ids, and from no row it does not own.
 *  Returns how many rows it released. See docs/coordination-as-code.md §329. */
export async function releaseObjectStackOwnership(
  tx: TenantTx,
  orgId: string,
  stackName: string,
  objectIds: readonly string[]
): Promise<number> {
  if (objectIds.length === 0) return 0;
  const released = await tx
    .update(objects)
    .set({ managedByStack: null })
    .where(
      and(
        eq(objects.orgId, orgId),
        inArray(objects.id, [...objectIds]),
        isNull(objects.deletedAt),
        eq(objects.managedByStack, stackName)
      )
    )
    .returning({ id: objects.id });
  return released.length;
}

/** The relationship half of RELEASE, by edge id — same predicate, same count. */
export async function releaseRelationshipStackOwnership(
  tx: TenantTx,
  orgId: string,
  stackName: string,
  relationshipIds: readonly string[]
): Promise<number> {
  if (relationshipIds.length === 0) return 0;
  const released = await tx
    .update(relationships)
    .set({ managedByStack: null })
    .where(
      and(
        eq(relationships.orgId, orgId),
        inArray(relationships.id, [...relationshipIds]),
        isNull(relationships.deletedAt),
        eq(relationships.managedByStack, stackName)
      )
    )
    .returning({ id: relationships.id });
  return released.length;
}
