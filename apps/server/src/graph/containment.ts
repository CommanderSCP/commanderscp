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
 * you change the routes here, change them there too. Routes 3 and 4 below do NOT have to be
 * hand-synced: they are exported as ONE SQL fragment composed into both walks, because a route added
 * twice by hand is exactly how routes 1 and 2 drifted in the first place. Route 4 arriving after
 * route 3 is the proof it was worth doing — adding it touched the fragment, not the two walks.
 */

/**
 * ROUTES 3 AND 4, shared verbatim by BOTH containment walks: **a `placement` is contained by the
 * component it places AND by the deployment-target it names** (ADR-0026). Both endpoints of the pair
 * are containing scopes, which is what makes a placement a pair rather than a component in disguise.
 *
 * ============================================================================================
 * ROUTE 4 (the deployment-target) IS AN OWNER DECISION, NOT A BUG FIX — 2026-08-02
 * ============================================================================================
 * It was found the same way as route 3 and deliberately NOT shipped with it, because unlike route 3
 * it does not restore lost gating — it starts gating something that never was. The estate holds 12
 * `required` `prod-gate*` policies; eleven are component-scoped, and the twelfth is scoped to the
 * `prod (DOKS hosted)` deployment-target and had NEVER matched anything. That target is nobody's
 * `domain_id` (0 rows) and its only incoming edges are `placed_at`/`hosted_on`, neither a containment
 * route — so a `required` prod gate sat inert, looking exactly like a gate that worked.
 *
 * Landing this route makes it fire: every stage-shaped release to prod now waits on that policy's
 * approval. A change that newly BLOCKS cannot be slipped in under a fix, so it was escalated and
 * approved on its own terms. Deliberately NOT extended to `hosted_on` from a legacy component-shaped
 * wave target, which would change behaviour on the estate exactly as it runs today.
 *
 * What it also buys: "freeze prod" becomes expressible for the first time — `containmentScopeIds`
 * now puts the deployment-target on every placement's chain, so a freeze scoped at a stage catches
 * everything deploying there. Before this there was no way to say it at all.
 *
 * Authority follows the same chain (`authz/resolve.ts` composes this identical fragment), so a role
 * bound at a deployment-target now reaches the placements there. Measured blast radius on the live
 * estate: 0 of 1 role bindings are scoped to a deployment-target, and no deployment-target has an
 * incoming `contains` edge, so this route cannot drag a service in behind it.
 *
 * ============================================================================================
 * WHY ROUTE 3 (the component) EXISTS — WHAT SILENTLY STOPPED WORKING WITHOUT IT
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
 * placement edges point the other way (`placement -places-> component`), so these routes read
 * FORWARDS — and the asymmetry route 2 relies on is preserved: a scope at a component reaches its
 * placements, a scope at a placement never reaches its component's siblings or its service directly
 * (it reaches them only by continuing up through the component, which is the whole point).
 *
 * They read the PROPERTIES, not the `places`/`placed_at` edges, because ADR-0026 D17 makes the
 * properties the source of truth for the pair and the edges derived — the same half
 * `binding-resolution.ts`, `plan-service.ts` and `regional-executors.ts` read. They also survive a
 * federation bundle whose `object_upsert` lands before its `relationship_upsert` siblings, where the
 * edges do not exist yet.
 *
 * The CASE guard is not decoration. `createObject` is called directly by journal replay, which does
 * not go through the typed `/placements` route, so a corrupt or hostile peer could ship a placement
 * whose `componentId` is not a UUID. A bare `::uuid` cast would then throw inside EVERY containment
 * walk in that org — one bad row taking out all governance evaluation, fail-open by way of a crash.
 * `CASE` guarantees the ordering a WHERE-clause guard does not, so a malformed value yields no
 * ancestor instead of an error. Route 4 needs it for the SAME reason and gets it the same way: one
 * fragment emitting both parents, so neither the guard nor the route can be added to one walk and
 * forgotten in the other.
 *
 * Both parents sit at the SAME walk depth from the placement. That is the documented cross-KIND
 * depth tie (see `containmentChain` below), not a new hazard: it is inert for every current consumer,
 * and `nearestAncestorOfKind` is unaffected because it only ever compares ancestors of one kind.
 */
const UUID_TEXT_PATTERN =
  "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";

/** ONE endpoint of the pair, as a single `parent_id` row. A malformed value yields a NULL row,
 *  never an error — every caller already discards NULL parents. */
function placementEndpointParentSql(orgId: string, childIdSql: SQL, property: string): SQL {
  return sql`
    SELECT CASE
             WHEN pl.properties ->> ${property} ~ ${UUID_TEXT_PATTERN}
             THEN (pl.properties ->> ${property})::uuid
           END AS parent_id
    FROM objects pl
    WHERE pl.id = ${childIdSql}
      AND pl.org_id = ${orgId}
      AND pl.type_id = 'placement'
      AND pl.deleted_at IS NULL
  `;
}

/**
 * ROUTE 3 ALONE — a placement's COMPONENT, exactly one row.
 *
 * `coordination/service-board.ts` wants this and NOT the pair: it LEFT JOINs LATERAL to map a
 * placement wave target back to the component whose column it fills, so a second row carrying a
 * DEPLOYMENT-TARGET id would be a wrong-kind answer in a `component_id` column.
 *
 * Measured, not assumed: swapping that call site to the pair fragment leaves its tests GREEN. The
 * extra row really is produced — arm 1's `IN (componentIds)` filter then discards it (a
 * deployment-target id is never in that list) and `DISTINCT ON (component_id)` collapses the rest.
 * So the two fragments are kept distinct for the honest reason rather than the dramatic one: the
 * board asks a narrower question, and answering it correctly should not depend on a downstream
 * filter happening to throw the wrong row away. That accident holds only while `componentIds`
 * contains components exclusively.
 *
 * The pair fragment below is BUILT from this one, so the component route keeps a single definition
 * and cannot drift across the three call sites.
 */
export function placementComponentParentSql(orgId: string, childIdSql: SQL): SQL {
  return placementEndpointParentSql(orgId, childIdSql, "componentId");
}

/** ROUTES 3 AND 4 — one `parent_id` row per endpoint of the pair: the component, then the
 *  deployment-target. This is what the two CONTAINMENT walks compose. */
export function placementParentsSql(orgId: string, childIdSql: SQL): SQL {
  return sql`
    ${placementComponentParentSql(orgId, childIdSql)}
    UNION ALL
    ${placementEndpointParentSql(orgId, childIdSql, "deploymentTargetId")}
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
 * Walks FOUR routes up:
 *
 *  1. `objects.domain_id` — up to the org root (graph/objects-repo.ts defaults `domainId` to the org
 *     root object at creation time, so every chain terminates there and this walk never needs NULL
 *     special-casing beyond the root itself).
 *  2. the `contains` edge from a component to its SERVICE (migration 0021). The edge is registered
 *     service -> component, so it is walked BACKWARDS (`r.to_id` = the child, `r.from_id` = its
 *     service). That asymmetry is a security property: a scope at a SERVICE reaches its components,
 *     but a scope at a COMPONENT never reaches its service or its sibling components.
 *  3. the COMPONENT a `placement` places, and
 *  4. the DEPLOYMENT-TARGET it places it at — both read from its properties (ADR-0026), see
 *     `placementParentsSql` above for why each route exists, what stopped working without route 3
 *     and what route 4 newly blocks. Together they extend the chain to
 *     `org -> domain -> service -> component -> placement` AND `org -> ... -> target -> placement`,
 *     which is why a placement's chain is a DAG and `UNION` (not `UNION ALL`) matters below.
 *
 * Until 0021 this walked domain_id only, so a service-scoped policy/freeze/role governed nothing —
 * even though DESIGN §7 and §10 have always described the chain as `org -> domain -> service ->
 * component`.
 *
 * A DELETED ancestor is skipped by every route (`parent.deleted_at IS NULL`), while the TARGET
 * itself is not filtered — governance may legitimately be evaluated over a deleted object, but a
 * deleted object must not go on GOVERNING live ones.
 *
 * That filter is load-bearing rather than defensive. `deleteObject` now tombstones the edges of the
 * object it deletes, but that cascade cannot be complete: it refuses REPLICA edges (single-writer
 * authority belongs to another domain) and it cannot retroactively fix rows already in a database.
 * For those, this filter is the only thing standing between a deleted service and a policy or role
 * binding scoped at it still reaching live components.
 *
 * All four routes live in ONE recursive term via LATERAL: PostgreSQL permits the CTE self-reference
 * exactly ONCE, so several recursive branches would error ("recursive reference ... more than once").
 * `UNION` (not `UNION ALL`) dedupes — with several routes the chain is a DAG, not a line.
 *
 * DEPTH, and what it does and does NOT guarantee — read this before relying on it.
 *
 * With several routes an ancestor can be reached at more than one walk depth. We keep the MAXIMUM per id
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
/**
 * THE CONTAINER TYPES — object types that may hold components (and each other, subject to the
 * pairwise refusal below).
 *
 * ONE constant, and every "is this a container?" question routes through it. The alternative —
 * comparing `typeId === "service"` at each site — is how a level gets added to the model and applied
 * at only some of the places that care, which is the failure mode this repo has been bitten by
 * repeatedly (`bindings[0]`, the `currents` collapse, ADR-0027's rung at one of two exits). A single
 * constant makes the census a definition rather than a search.
 *
 * Note what this does NOT license: membership here says a type may CONTAIN, not that any pair is
 * legal. `assembly -> assembly` is refused at write time (`relationships-repo.ts`), because
 * `relationship_types` holds flat from/to arrays and cannot express a pairwise rule — see migration
 * 0054's header.
 */
export const CONTAINER_TYPES = ["service", "assembly"] as const;

export function isContainerType(typeId: string): boolean {
  return (CONTAINER_TYPES as readonly string[]).includes(typeId);
}

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
      -- One recursive term (PostgreSQL allows the self-reference exactly once); the routes are a
      -- LATERAL union of parents.
      SELECT parent.id, parent.type_id, parent.labels, c.depth + 1
      FROM chain c
      CROSS JOIN LATERAL (
        -- 1. containing domain, via the child's domain_id
        SELECT parent_o.id, parent_o.type_id, parent_o.labels
        FROM objects child_o
        JOIN objects parent_o ON parent_o.id = child_o.domain_id
        WHERE child_o.id = c.id AND child_o.org_id = ${orgId} AND parent_o.org_id = ${orgId}
          AND parent_o.deleted_at IS NULL
        UNION ALL
        -- 2. containing service, via the contains edge walked BACKWARDS (to_id = c.id, from_id = svc)
        SELECT svc.id, svc.type_id, svc.labels
        FROM relationships r
        JOIN objects svc ON svc.id = r.from_id AND svc.org_id = ${orgId}
          AND svc.deleted_at IS NULL
        WHERE r.to_id = c.id
          AND r.org_id = ${orgId}
          AND r.type_id = 'contains'
          AND r.deleted_at IS NULL
        UNION ALL
        -- 3 + 4. BOTH endpoints of the pair a placement names — the COMPONENT it places and the
        -- DEPLOYMENT-TARGET it places it at (ADR-0026) — see placementParentsSql. The walk continues
        -- from each, so a placement inherits its component's service and domain too.
        SELECT parent_o.id, parent_o.type_id, parent_o.labels
        FROM (${placementParentsSql(orgId, sql`c.id`)}) pp
        JOIN objects parent_o ON parent_o.id = pp.parent_id AND parent_o.org_id = ${orgId}
          AND parent_o.deleted_at IS NULL
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
