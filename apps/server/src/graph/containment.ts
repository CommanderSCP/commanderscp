import { sql } from "drizzle-orm";
import type { TenantTx } from "../db/tenant-tx.js";

/**
 * THE containment walk — "what contains this object?" — in ONE place.
 *
 * There used to be three row-returning copies of this concept (policy-resolve.ts's
 * `containmentChain`, and gate-orchestrator.ts's freeze-scope and approval-scope walks). Migration
 * 0021 added the `contains` edge; the follow-up taught only the policy copy to walk it, and the two
 * gate-orchestrator copies silently kept their old domain_id-only walk. The result was a
 * service-scoped freeze that failed OPEN and a `requireApprovals: {scope:"service"}` that failed
 * CLOSED — opposite symptoms, one root cause: divergent copies of one idea. Hence one function.
 *
 * `authz/resolve.ts`'s `scopeExpandCte` deliberately stays separate and MUST be kept in sync by
 * hand: it is a SQL FRAGMENT composed into a single larger query that joins `role_bindings`/`roles`,
 * so the deny-override decision happens in one round-trip. It cannot consume row output from here
 * without splitting that query in two. It walks the same two routes with the same depth bound — if
 * you change the routes here, change them there too.
 */

export interface ChainEntry {
  id: string;
  /** The `object_types.id` this ancestor carries — how a scope-KIND keyword ("service") finds the
   *  nearest ancestor of that kind. */
  typeId: string;
  /** 0 = org root, increasing toward the target. See the DEPTH section below before relying on it. */
  depth: number;
  labels: Record<string, unknown>;
}

/**
 * Target -> ... -> org root, with depth 0 = org root, increasing toward the target.
 *
 * Walks TWO routes up:
 *
 *  1. `objects.domain_id` — up to the org root (graph/objects-repo.ts defaults `domainId` to the org
 *     root object at creation time, so every chain terminates there and this walk never needs NULL
 *     special-casing beyond the root itself).
 *  2. the `contains` edge from a component to its SERVICE (migration 0021). The edge is registered
 *     service -> component, so it is walked BACKWARDS (`r.to_id` = the child, `r.from_id` = its
 *     service). That asymmetry is a security property: a scope at a SERVICE reaches its components,
 *     but a scope at a COMPONENT never reaches its service or its sibling components.
 *
 * Until 0021 this walked domain_id only, so a service-scoped policy/freeze/role governed nothing —
 * even though DESIGN §7 and §10 have always described the chain as `org -> domain -> service ->
 * component`.
 *
 * Both routes live in ONE recursive term via LATERAL: PostgreSQL permits the CTE self-reference
 * exactly ONCE, so two recursive branches would error ("recursive reference ... more than once").
 * `UNION` (not `UNION ALL`) dedupes — with two routes the chain is a DAG, not a line.
 *
 * DEPTH, and what it does and does NOT guarantee — read this before relying on it.
 *
 * With two routes an ancestor can be reached at more than one walk depth. We keep the MAXIMUM per id
 * (`DISTINCT ON (id) ... ORDER BY id, depth DESC`) — the longest path from the target, i.e. the
 * least-specific reading — which the `maxDepth - depth` inversion below turns into "higher = more
 * specific".
 *
 * That reconciles the case where the SAME node is reachable by both routes (a component's own domain,
 * reachable directly AND via its service's domain): the domain settles at the deeper walk depth, so it
 * ranks BELOW the service. In the common shape — component and service sharing a domain — this does
 * yield org < domain < service < component.
 *
 * It does NOT, however, make a service strictly outrank a component's own domain in general. If a
 * component's `domain_id` differs from its service's (C in domain Dx, S in domain Dy, S contains C —
 * reachable via the organize-after-import flow), then Dx and S are each exactly ONE hop from C and
 * TIE. They are structurally equidistant; max-depth cannot separate them, and no ordering of these
 * two routes is obviously "correct" — a component genuinely sits in both. DO NOT write code that
 * assumes a strict org < domain < service < component ordering across DIFFERENT kinds.
 *
 * `nearestAncestorOfKind` is safe under that tie because it compares only ancestors of the SAME kind.
 * The tie is otherwise INERT: `matchedAt.depth`'s only consumer is policy-model.ts, which groups by
 * policy NAME and merges order-independently (max severity, union of effects), using depth solely to
 * order a display-only `contributors` array. It WOULD become a real precedence bug the moment any
 * code compares depth across differently-named policies to pick a single "most specific" winner — if
 * you are about to write that, fix this first.
 */
export async function containmentChain(tx: TenantTx, orgId: string, objectId: string): Promise<ChainEntry[]> {
  const result = await tx.execute<{
    id: string;
    type_id: string;
    depth: number;
    labels: Record<string, unknown>;
  }>(sql`
    WITH RECURSIVE chain AS (
      SELECT o.id, o.type_id, o.labels, 0 AS depth
      FROM objects o
      WHERE o.id = ${objectId}::uuid AND o.org_id = ${orgId}
      UNION
      -- One recursive term (PostgreSQL allows the self-reference exactly once); the two routes are a
      -- LATERAL union of parents.
      SELECT parent.id, parent.type_id, parent.labels, c.depth + 1
      FROM chain c
      CROSS JOIN LATERAL (
        -- 1. containing domain, via the child's domain_id
        SELECT parent_o.id, parent_o.type_id, parent_o.labels
        FROM objects child_o
        JOIN objects parent_o ON parent_o.id = child_o.domain_id
        WHERE child_o.id = c.id AND child_o.org_id = ${orgId} AND parent_o.org_id = ${orgId}
        UNION ALL
        -- 2. containing service, via the contains edge walked BACKWARDS (to_id = c.id, from_id = svc)
        SELECT svc.id, svc.type_id, svc.labels
        FROM relationships r
        JOIN objects svc ON svc.id = r.from_id AND svc.org_id = ${orgId}
        WHERE r.to_id = c.id
          AND r.org_id = ${orgId}
          AND r.type_id = 'contains'
          AND r.deleted_at IS NULL
      ) parent
      WHERE c.depth < 10
    )
    -- Max walk depth per id (see the doc comment): preserves service-beats-domain precedence.
    SELECT DISTINCT ON (id) id, type_id, depth, labels FROM chain ORDER BY id, depth DESC
  `);
  // Reverse so index 0 = org root (max depth in the recursive walk) — matches policy-model.ts's
  // "0 = org root, increasing toward the target" depth convention.
  const rows = result.rows;
  const maxDepth = Math.max(0, ...rows.map((r) => r.depth));
  return rows
    .map((r) => ({ id: r.id, typeId: r.type_id, depth: maxDepth - r.depth, labels: r.labels ?? {} }))
    .sort((a, b) => a.depth - b.depth);
}

/** Every object id that contains `objectId` (plus `objectId` itself) — the flat set, for callers
 *  that only need membership and not depth/labels (e.g. freeze scoping). */
export async function containmentScopeIds(tx: TenantTx, orgId: string, objectIds: string[]): Promise<string[]> {
  const ids = new Set<string>();
  for (const objectId of objectIds) {
    for (const entry of await containmentChain(tx, orgId, objectId)) {
      ids.add(entry.id);
    }
  }
  return [...ids];
}

/**
 * The NEAREST ancestor of `chain` carrying `typeId` (the target itself counts), or null.
 *
 * "Nearest" = greatest `depth` (most specific). Comparing depth is only sound here because every
 * candidate has the SAME kind — the documented domain/service tie is a cross-KIND phenomenon and
 * cannot arise between two ancestors of one kind. Ties among same-kind candidates (not reachable
 * today: `contains` is one_to_many, so a component has at most one service, and `domain_id` is a
 * single column) break deterministically by id so the answer is never order-dependent.
 */
export function nearestAncestorOfKind(chain: ChainEntry[], typeId: string): ChainEntry | null {
  const candidates = chain.filter((c) => c.typeId === typeId);
  if (candidates.length === 0) return null;
  return candidates.reduce((best, c) =>
    c.depth > best.depth || (c.depth === best.depth && c.id < best.id) ? c : best
  );
}
