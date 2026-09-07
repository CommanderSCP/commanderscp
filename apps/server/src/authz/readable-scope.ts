import { sql, type SQL } from "drizzle-orm";
import type { TenantTx } from "../db/tenant-tx.js";
import { CONTAINMENT_WALK_MAX_DEPTH, containmentChildrenSql } from "../graph/containment.js";
import type { Permission } from "./resolve.js";

/** THE READ SURFACE'S OTHER HALF. See docs/authz.md §43. */

/** One `role_bindings` row that could bear on the permission: its scope, and its RAW effect text. */
export interface ReadableRoot {
  /** `role_bindings.scope_object_id` — the object the binding is anchored at. */
  rootId: string;
  /** RAW `role_bindings.effect` — whatever the row holds, not a narrowed union. `text` constrained
   *  to 'allow'|'deny' by `role_bindings_effect_check` (drizzle/0096) SINCE that migration, and by
   *  nothing at all before it; a database restored from a pre-0096 dump still carries whatever was
   *  written. Classified in {@link partitionReadableRoots}. */
  effect: string;
}

export interface ReadableRootsInput {
  orgId: string;
  subjectObjectId: string;
  permission: Permission;
}

/** Every scope where this subject's roles grant the permission. See docs/authz.md §44. */
export async function readableRootsFor(
  tx: TenantTx,
  input: ReadableRootsInput
): Promise<ReadableRoot[]> {
  const result = await tx.execute<{ root_id: string; effect: string }>(sql`
    WITH RECURSIVE subject_expand AS (
      SELECT ${input.subjectObjectId}::uuid AS subject_id, 0 AS depth
      UNION
      SELECT r.to_id, se.depth + 1
      FROM relationships r
      JOIN subject_expand se ON r.from_id = se.subject_id
      WHERE r.org_id = ${input.orgId} AND r.type_id = 'member_of' AND r.deleted_at IS NULL
        AND se.depth < ${CONTAINMENT_WALK_MAX_DEPTH}
    )
    SELECT DISTINCT rb.scope_object_id AS root_id, rb.effect AS effect
    FROM role_bindings rb
    JOIN roles rl ON rl.id = rb.role_id
    WHERE rb.org_id = ${input.orgId}
      AND rb.subject_id IN (SELECT subject_id FROM subject_expand)
      AND ${input.permission} = ANY(rl.permissions)
  `);
  return result.rows.map((row) => ({ rootId: row.root_id, effect: row.effect }));
}

/** Split the roots into allow and deny by exact equality. See docs/authz.md §45. */
export function partitionReadableRoots(roots: readonly ReadableRoot[]): {
  allowRoots: string[];
  denyRoots: string[];
} {
  const allowRoots = new Set<string>();
  const denyRoots = new Set<string>();
  for (const root of roots) {
    if (root.effect === "allow") allowRoots.add(root.rootId);
    else if (root.effect === "deny") denyRoots.add(root.rootId);
  }
  return { allowRoots: [...allowRoots], denyRoots: [...denyRoots] };
}

/** `x IN (this)` is always false — the "no allow binding at all" answer. Deliberately NOT `null`,
 *  which means the opposite (no filter). */
const MATCHES_NOTHING = sql`(SELECT NULL::uuid AS id WHERE false)`;

/** The readable id set as a subquery; deny is a subtraction. See docs/authz.md §46. */
export function readableObjectFilterSql(
  orgId: string,
  allowRoots: readonly string[],
  denyRoots: readonly string[]
): SQL | null {
  // THE ORG-ROOT SHORT-CIRCUIT — `orgId` IS the org root object's id (`ensureOrgRootObject` creates
  // it with `id: orgId`). An allow binding there already reaches every rooted object, so the descend
  // could only differ from today's answer by LOSING rows whose chain is broken. Returning today's
  // query verbatim is what makes this increment a pure widening.
  if (allowRoots.includes(orgId)) return null;
  if (allowRoots.length === 0) return MATCHES_NOTHING;

  const allow = descendSql(orgId, "readable_allow", allowRoots);
  if (denyRoots.length === 0) {
    return sql`(WITH RECURSIVE ${allow} SELECT id FROM readable_allow)`;
  }
  const deny = descendSql(orgId, "readable_deny", denyRoots);
  return sql`(
    WITH RECURSIVE ${allow}, ${deny}
    SELECT id FROM readable_allow
    EXCEPT
    SELECT id FROM readable_deny
  )`;
}

/** One named `WITH RECURSIVE` term. See docs/authz.md §47. */
function descendSql(orgId: string, cteName: string, roots: readonly string[]): SQL {
  const seeds = sql.join(
    roots.map((id) => sql`(${id}::uuid)`),
    sql`, `
  );
  return sql`${sql.raw(cteName)} AS (
      SELECT seed.id AS id, 0 AS depth
      FROM (VALUES ${seeds}) AS seed(id)
      JOIN objects root_o
        ON root_o.id = seed.id AND root_o.org_id = ${orgId} AND root_o.deleted_at IS NULL
      UNION
      SELECT c.child_id, d.depth + 1
      FROM ${sql.raw(cteName)} d
      CROSS JOIN LATERAL (${containmentChildrenSql(orgId, sql`d.id`)}) c
      -- sql.raw, not a bound parameter, for the reason authz/resolve.ts gives at its own walk: an
      -- untyped $n compared against a recursive CTE's derived depth column is where PostgreSQL
      -- cannot infer a type. It is a module constant either way, never caller input.
      -- (No backticks in this comment: it lives inside a JS template literal.)
      WHERE d.depth < ${sql.raw(String(CONTAINMENT_WALK_MAX_DEPTH))}
    )`;
}

/** THE UNGATED READABLE SET. See docs/authz.md §48. */
export async function readableObjectFilterFor(
  tx: TenantTx,
  input: ReadableRootsInput
): Promise<SQL | null> {
  const { allowRoots, denyRoots } = partitionReadableRoots(await readableRootsFor(tx, input));
  return readableObjectFilterSql(input.orgId, allowRoots, denyRoots);
}
