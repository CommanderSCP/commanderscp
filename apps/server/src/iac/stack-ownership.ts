import { and, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { objects } from "../db/schema.js";
import type { TenantTx } from "../db/tenant-tx.js";

/**
 * ================================================================================================
 * THE SOLE WRITER OF `managed_by_stack` — "a description is not an assertion" (drizzle/0068)
 * ================================================================================================
 *
 * ## What this closes
 *
 * The IaC prune pool — which live objects and relationships an apply DELETES — used to be read out
 * of `objects.labels` / `relationships.labels`, from the pair `scp:managed-by=iac` + `scp:stack=X`.
 * `labels` is writable at plain `object:write` AT THE OBJECT, validated by nothing. So the SUBJECT
 * of the decision wrote its own match key, at a strictly weaker permission than the one that
 * authored the desired state. Both directions are reproduced through real HTTP doors in
 * `iac-stack-ownership.integration.test.ts`:
 *
 *  - **Enrolment.** An Operator bound at ONE object, with no IaC authority at all, PATCHes the two
 *    keys onto it. The stack's UNCHANGED manifest then proposes deleting it — over the reason
 *    "previously managed by this stack", which is false — and the apply executes that delete under
 *    the applier's authority, taking the object's `source_mappings`, `placements` and
 *    `executor_bindings` with it.
 *  - **Escape.** The object's owner strips the two keys. The object leaves the pool, so when its
 *    stack later drops it from the manifest to decommission it, NO delete is proposed. It survives
 *    its own decommission silently.
 *
 * ## Why a column and not a reserved label namespace
 *
 * PR #247 reserved `scp.governance/` for keys a governance constraint may match on, and said in its
 * own census that this instance was "not fixable with this namespace". That is right, and the reason
 * is worth stating precisely rather than inherited: a `scp.governance/` key is written by an
 * AUTHORITY — an operator holding org-root `policy:write` — so the namespace's rule is a permission
 * bar. Stack ownership has no such principal. It is stamped by an apply, as a consequence of what a
 * manifest declares, and there is no permission that should let anyone type it directly. The honest
 * encoding of "not tenant data" in this schema is a column, which is what `origin_domain_id`,
 * `provenance`, `revision` and `domain_local` already are.
 *
 * A namespace would also have cost what a column gets for free: `labels` FEDERATE. A peer's object
 * carrying `scp:stack=X` arrived here as a replica still carrying it and joined a local stack named
 * X's prune pool — where `deleteObject` refuses a replica with a 409 and wedges the entire apply.
 * `managed_by_stack` is absent from the journal payload, so a replica arrives owned by nobody.
 *
 * ## The one rule
 *
 * **A stack owns exactly the rows its manifest declares, plus the rows it already owned.** Nothing
 * else can put a row in a stack's prune pool, and nothing a request can send takes one out.
 *
 * Ownership is therefore stamped for every NON-DELETE entry in the diff — `create`, `update` and
 * `noop` alike. `noop` is not an optimisation to skip: a declared row that happens to be
 * byte-identical to what is stored is still a row this stack declares, and leaving it unstamped
 * would make it undeletable by the stack that owns it (the escape direction, arrived at by
 * accident). Both statements below are written as ONE bulk UPDATE with `IS DISTINCT FROM`, so an
 * apply that changes no ownership writes no rows — this must not become per-object write
 * amplification on the hottest path IaC has.
 *
 * Ownership is never CLEARED here. A row leaves a stack by being pruned (which deletes it), and the
 * only other way out would be another stack declaring it — which is a `create`/`update`/`noop` in
 * that stack's diff, i.e. a re-stamp by this same function.
 */

/**
 * Stamps `stackName` onto every object id given, skipping rows that already carry it.
 *
 * The caller passes the ids of every non-delete object entry in the applied diff. Rows outside that
 * list are untouched, including rows this stack owned before — an object that dropped out of the
 * manifest is handled by the PRUNE, which deletes it; silently disowning it instead would leave an
 * orphan no stack could ever clean up.
 */
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
        // `IS DISTINCT FROM` rather than `<> OR IS NULL`: the column is nullable, and a plain `<>`
        // is NULL (not TRUE) for an unowned row, so it would skip exactly the rows that need
        // stamping most — the ones being adopted.
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

/**
 * The relationship half. One statement over a VALUES list rather than N lookups: the diff already
 * knows every triple (both endpoint ids are resolved before any mutation runs), so re-reading each
 * edge to find its id would be a round trip per declared edge for no extra information.
 *
 * THIS ALSO CLOSES A PRE-EXISTING ASYMMETRY, not just the label hole. Under the label scheme, only
 * relationship CREATES were stamped (`createRelationship` set the labels; nothing rewrote an edge
 * that already existed). So an edge a manifest declared but that some other door had already created
 * — `POST /components` writes a `contains` edge, for instance — was declared-but-unowned forever,
 * and could never be pruned by the stack that declared it. Objects never had that gap, because
 * adopting one rewrote its labels. Stamping every non-delete entry makes the two agree.
 */
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
