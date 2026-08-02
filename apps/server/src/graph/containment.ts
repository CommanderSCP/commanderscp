import { sql, type SQL } from "drizzle-orm";
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
 * you change the routes here, change them there too. Route 3 below is the FIRST one that does not
 * have to be hand-synced: it is exported as a SQL fragment and composed into both walks, because a
 * route added twice by hand is exactly how routes 1 and 2 drifted in the first place.
 */

/**
 * ROUTE 3, shared verbatim by BOTH containment walks: **a `placement` is contained by the component
 * it places** (ADR-0026).
 *
 * ============================================================================================
 * WHY THIS ROUTE EXISTS — WHAT SILENTLY STOPPED WORKING WITHOUT IT
 * ============================================================================================
 * Under stage-shaped plan compilation a `change_wave_targets.target_object_id` is a PLACEMENT, not a
 * component (`plan-service.ts`'s `resolveStagePlacements`). Every wave-boundary governance decision
 * is derived from that id's containment chain — `matchPoliciesForTargets`, `containmentScopeIds` for
 * freezes, `resolveApprovalScope`, and `resolveEffectiveScanThreshold`'s tier labels all walk it.
 *
 * A placement's chain without this route is `[org root, placement]` and nothing else: its `domain_id`
 * is the org root, and it has NO incoming `contains` edge (measured on the live estate — 61
 * placements, 0 incoming `contains`). So the moment a wave target became a placement, every
 * component-scoped and service-scoped policy stopped matching at the wave boundary and every
 * service-scoped freeze failed OPEN. On the live estate that is 11 `required` component-scoped
 * prod-gate policies that would have quietly stopped gating prod — the same failure mode, in the
 * same file, that this module's header records being paid for once already.
 *
 * ============================================================================================
 * DIRECTION, AND WHY IT IS SAFE
 * ============================================================================================
 * Route 2 walks `contains` BACKWARDS because that edge is registered service -> component. The
 * placement edges point the other way (`placement -places-> component`), so this route reads
 * FORWARDS — and the asymmetry route 2 relies on is preserved: a scope at a component reaches its
 * placements, a scope at a placement never reaches its component's siblings or its service directly
 * (it reaches them only by continuing up through the component, which is the whole point).
 *
 * It reads the PROPERTY, not the `places` edge, because ADR-0026 D17 makes the properties the source
 * of truth for the pair and the edges derived — the same half `binding-resolution.ts`,
 * `plan-service.ts` and `regional-executors.ts` read. It also survives a federation bundle whose
 * `object_upsert` lands before its `relationship_upsert` siblings, where the edge does not exist yet.
 *
 * The CASE guard is not decoration. `createObject` is called directly by journal replay, which does
 * not go through the typed `/placements` route, so a corrupt or hostile peer could ship a placement
 * whose `componentId` is not a UUID. A bare `::uuid` cast would then throw inside EVERY containment
 * walk in that org — one bad row taking out all governance evaluation, fail-open by way of a crash.
 * `CASE` guarantees the ordering a WHERE-clause guard does not, so a malformed value yields no
 * ancestor instead of an error.
 */
const UUID_TEXT_PATTERN =
  "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";

export function placementComponentParentSql(orgId: string, childIdSql: SQL): SQL {
  return sql`
    SELECT CASE
             WHEN pl.properties ->> 'componentId' ~ ${UUID_TEXT_PATTERN}
             THEN (pl.properties ->> 'componentId')::uuid
           END AS parent_id
    FROM objects pl
    WHERE pl.id = ${childIdSql}
      AND pl.org_id = ${orgId}
      AND pl.type_id = 'placement'
      AND pl.deleted_at IS NULL
  `;
}

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
 * Walks THREE routes up:
 *
 *  1. `objects.domain_id` — up to the org root (graph/objects-repo.ts defaults `domainId` to the org
 *     root object at creation time, so every chain terminates there and this walk never needs NULL
 *     special-casing beyond the root itself).
 *  2. the `contains` edge from a component to its SERVICE (migration 0021). The edge is registered
 *     service -> component, so it is walked BACKWARDS (`r.to_id` = the child, `r.from_id` = its
 *     service). That asymmetry is a security property: a scope at a SERVICE reaches its components,
 *     but a scope at a COMPONENT never reaches its service or its sibling components.
 *  3. the COMPONENT a `placement` places, read from its properties (ADR-0026) — see
 *     `placementComponentParentSql` above for why this route exists and what stopped working
 *     without it. It extends the chain to `org -> domain -> service -> component -> placement`.
 *
 * Until 0021 this walked domain_id only, so a service-scoped policy/freeze/role governed nothing —
 * even though DESIGN §7 and §10 have always described the chain as `org -> domain -> service ->
 * component`.
 *
 * All three routes live in ONE recursive term via LATERAL: PostgreSQL permits the CTE self-reference
 * exactly ONCE, so several recursive branches would error ("recursive reference ... more than once").
 * `UNION` (not `UNION ALL`) dedupes — with several routes the chain is a DAG, not a line.
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
export async function containmentChain(
  tx: TenantTx,
  orgId: string,
  objectId: string
): Promise<ChainEntry[]> {
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
        UNION ALL
        -- 3. the COMPONENT a placement places (ADR-0026) — see placementComponentParentSql. The
        -- walk continues from there, so a placement inherits its component's service and domain too.
        SELECT comp.id, comp.type_id, comp.labels
        FROM (${placementComponentParentSql(orgId, sql`c.id`)}) pc
        JOIN objects comp ON comp.id = pc.parent_id AND comp.org_id = ${orgId}
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
    .map((r) => ({
      id: r.id,
      typeId: r.type_id,
      depth: maxDepth - r.depth,
      labels: r.labels ?? {}
    }))
    .sort((a, b) => a.depth - b.depth);
}

/** Every object id that contains `objectId` (plus `objectId` itself) — the flat set, for callers
 *  that only need membership and not depth/labels (e.g. freeze scoping). */
export async function containmentScopeIds(
  tx: TenantTx,
  orgId: string,
  objectIds: string[]
): Promise<string[]> {
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
