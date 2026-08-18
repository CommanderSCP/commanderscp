import { sql, type SQL } from "drizzle-orm";
import type { TenantTx } from "../db/tenant-tx.js";
import { badRequest, conflict } from "../errors.js";

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

/**
 * THE ONE DEPTH BOUND every recursive graph walk shares (ADR-0035) — and the reason it is loud.
 *
 * Six sites recurse with this bound (filterless census, 2026-08-13): this file's
 * `containmentChain`, `named-queries.ts`'s `groupByDomain`, `policy-resolve.ts`'s `isMemberOf`,
 * and `authz/resolve.ts`'s three walks (two `member_of` expansions + `scopeExpandCte`, the
 * hand-synced copy this file's header warns about). Before ADR-0035 each carried a literal `10`
 * and STOPPED EXPANDING silently at it — and `containmentChain`'s depth inversion then presented
 * the outermost SURVIVOR as the org root, so an over-deep chain didn't look broken, it looked
 * like a shallower org whose root was a mid-level domain. Org-scoped required policies silently
 * stopped matching: the ADR-0026 failure shape, measured as reachable through the public API
 * once nested domains landed (~10 domain levels + one component).
 *
 * The fix is not a bigger number — it is that hitting the bound is now an ERROR, detected by
 * walking ONE level past it (`WALK_TRUNCATION_PROBE_DEPTH`) and refusing if anything is found
 * there. Raising capacity later is a one-line change HERE, and only here; a raise that edits any
 * single call site instead is the six-copies bug this constant exists to end.
 *
 * It is a real ceiling, not a formality, and the WRITE DOORS are what keep every live row under it
 * (owner ruling 2026-08-18, ADR-0035 Consequences): `assertRootedContainmentParent`,
 * `relationships-repo.ts`'s `contains` door and `placements-repo.ts`'s pair door all refuse any
 * LOCAL write that would leave a live row past the bound — see {@link assertContainmentDepthAdmits}
 * for the arithmetic. The federation-import paths are CARVED OUT (ADR-0035 Consequences: the
 * receiver does not referee a peer-authored containment, and one refusal there is a per-CHANNEL
 * failure for a per-row fault), so a replica can still land past the bound; the doors convert the
 * walk's loud refusal into their own 400 for a local write UNDER such a row (legacy or imported)
 * rather than ever seeing a shortened ancestry — {@link containmentParentChainForDoor}.
 */
export const CONTAINMENT_WALK_MAX_DEPTH = 10;
/** One past the bound: a row AT this depth proves the walk was cut, not complete. */
export const WALK_TRUNCATION_PROBE_DEPTH = CONTAINMENT_WALK_MAX_DEPTH + 1;

/** The phrase every depth refusal carries — the sentence operators (and tests) recognise it by,
 *  and the marker {@link isWalkDepthExceeded} reads. */
const WALK_DEPTH_EXCEEDED_PHRASE = "exceeds the supported containment depth";

/**
 * The phrase every DOOR refusal carries — a write that WOULD put a live row past the bound. It is
 * deliberately NOT a substring match for {@link WALK_DEPTH_EXCEEDED_PHRASE} ("would exceed" vs
 * "exceeds"): {@link isWalkDepthExceeded} reads the walk's phrase, and a door 400 must never be
 * mistaken for a walk 409 by that marker or by an operator. The bound and the ADR are still named,
 * so both refusals tell one story.
 */
export const CONTAINMENT_DEPTH_DOOR_PHRASE = "would exceed the supported containment depth";

/** The uniform refusal for a walk that hit the bound — one message shape for all six sites, so
 *  operators meet one explanation, not six dialects. */
export function walkDepthExceeded(what: string, remedy: string): Error {
  return conflict(
    `${what} ${WALK_DEPTH_EXCEEDED_PHRASE} (${CONTAINMENT_WALK_MAX_DEPTH} hops, ADR-0035). ` +
      `Rather than answer from a silently truncated walk — which is how org-scoped policies stop ` +
      `matching with no error — this operation refuses. ${remedy}`
  );
}

/** True iff `error` is a {@link walkDepthExceeded} refusal — read off the one phrase every such
 *  refusal carries, so a caller that must answer with its OWN status (the containment-parent door's
 *  400, M22) can recognise the walk's refusal without a second error class. */
export function isWalkDepthExceeded(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const detail = (error as unknown as { detail?: unknown }).detail;
  return (
    (typeof detail === "string" && detail.includes(WALK_DEPTH_EXCEEDED_PHRASE)) ||
    error.message.includes(WALK_DEPTH_EXCEEDED_PHRASE)
  );
}

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
        -- 2. containing CONTAINER, via the contains edge walked BACKWARDS (to_id = c.id, from_id).
        -- Generic on the edge, never on the parent's type, so the ASSEMBLY level added by migration
        -- 0055 is walked here with no change: component -> assembly -> service yields BOTH rungs, and
        -- every consumer of this walk (policy resolution, RBAC scope expansion, freeze scoping)
        -- inherits the new tier for free. That is why 0055 shipped no edit here.
        -- CORRECTED 2026-08-17: this list used to include APPROVAL SCOPE, and that was wrong in a
        -- way worth stating, because it is the trap a future third container level will hit too.
        -- WALKING a rung is edge-generic and free; NAMING one is not. Two consumers keep their own
        -- HARDCODED rung lists that this walk does not feed, so 0055 silently missed both:
        --   * gate-orchestrator.ts APPROVAL_SCOPE_KEYWORDS has no assembly case, so
        --     requireApprovals {scope: assembly} resolves to null and becomes a PERMANENTLY
        --     unsatisfiable required approval -- fail-closed, but silently inexpressible.
        --   * governance/scan-requirements.ts tierForObjectType falls assembly through to
        --     component, so an assembly-anchored scan ceiling ENFORCES correctly (the merge is an
        --     order-independent MIN that ignores labels) and MISREPORTS its tier, breaking
        --     ADR-0016 section 5's promise that a block can name the tier that bound it.
        -- Both are fixed in M22 (ADR-0035 section 5). If you add a third container level, grep for
        -- every hardcoded list of rungs before trusting this comment's "for free".
        -- The alias stays svc because renaming it is churn, not because the parent must be a service.
        -- (No backticks in this comment: it lives inside a JS template literal.)
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
      -- ADR-0035: expand ONE level past the shared bound. A row landing at the probe depth is the
      -- truncation detector — it can only exist if a row at the bound still had a live parent,
      -- i.e. the chain was about to be cut rather than complete. The throw below is what keeps
      -- the "index 0 = org root" inversion honest: a truncated chain would otherwise present a
      -- mid-level ancestor at the root position with no error anywhere.
      WHERE c.depth < ${WALK_TRUNCATION_PROBE_DEPTH}
    )
    -- Max walk depth per id (see the doc comment): preserves service-beats-domain precedence.
    SELECT DISTINCT ON (id) id, type_id, depth, labels FROM chain ORDER BY id, depth DESC
  `);
  if (result.rows.some((r) => r.depth >= WALK_TRUNCATION_PROBE_DEPTH)) {
    throw walkDepthExceeded(
      `the containment chain of object '${objectId}'`,
      `Flatten the nesting above it (typically stacked subdomains) before governance can scope it.`
    );
  }
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
 * THE DOWNWARD WALK — "how deep is the subtree under this row?" — the exact INVERSE of the four
 * routes `containmentChain` walks up, bounded, live rows only.
 *
 * Exists for ONE caller, {@link assertContainmentDepthAdmits}: a MOVE takes the moved row's whole
 * subtree with it, so the door has to know how far below the row the deepest live descendant sits.
 * The routes are the same three writes read backwards, and they MUST stay the mirror of the upward
 * walk — a route present in one and not the other is exactly how routes 1 and 2 drifted apart in
 * this module's history:
 *
 *   inverse of route 1 — rows whose `domain_id` is this row (any type: `objects.domain_id` carries
 *                        no type constraint, so a component or a placement can have `domain_id`
 *                        children too, and this arm is not optional for any type);
 *   inverse of route 2 — `contains` edges FROM this row, read FORWARDS (the edge is registered
 *                        container -> member, so the child is `to_id`);
 *   inverse of routes 3+4 — live placements NAMING this row as their component or their
 *                        deployment-target, read from the PROPERTIES exactly as
 *                        `placementParentsSql` does, with the SAME CASE guard, so a malformed value
 *                        matches nothing here just as it yields no parent there and the two walks
 *                        agree on which values count.
 *
 * Every CHILD is filtered `deleted_at IS NULL` (as every PARENT is upward): a tombstoned descendant
 * is on no walk and costs no depth. The seed is filtered live too — the callers pass a row they
 * have just loaded live, and a deleted seed has no subtree worth counting.
 *
 * BOUNDED at `budget + 1` levels and answers a yes/no question, on purpose: the caller only needs to
 * know whether the subtree is TALLER than the budget it has left, and a row found at depth
 * `budget + 1` proves that without walking the rest. The bound literal is `sql.raw` for the reason
 * `authz/resolve.ts` gives at its own walk (an untyped `$n` against a recursive CTE's depth column).
 * `UNION` (not `UNION ALL`) because the subtree is a DAG — a component reachable via its domain AND
 * its service is one node — and `MAX(depth)` keeps the LONGEST route per row, which is what the
 * invariant counts. `budget` is never negative here: the ONE caller, {@link assertContainmentDepthAdmits},
 * refuses `rowDepth > MAX` BEFORE computing `budget = MAX - rowDepth`, so a parent at the bound
 * never reaches this walk (a "negative budget" branch used to sit here as a `return true` — dead
 * by that ordering, and a verifier measured that inverting it left the whole suite green; a claim
 * no test can hold to is not kept as behaviour).
 *
 * Index note, so nobody "fixes" the CASE form for speed: migration 0051's pair index is on the TEXT
 * expression `(properties ->> 'componentId')`, which the cast form cannot use; a text comparison
 * could, but would be a STRICTER match than the upward walk (upper-case hex would be a parent going
 * up and not a child coming down). The mirror is worth more than the index — the placement
 * population is small (61 on the live estate, per this module's header) and the walk is bounded.
 */
export async function containmentSubtreeExceeds(
  tx: TenantTx,
  orgId: string,
  rootId: string,
  budget: number
): Promise<boolean> {
  const probeDepth = budget + 1;
  const result = await tx.execute<{ depth: number }>(sql`
    WITH RECURSIVE down AS (
      SELECT o.id, 0 AS depth
      FROM objects o
      WHERE o.id = ${rootId}::uuid AND o.org_id = ${orgId} AND o.deleted_at IS NULL
      UNION
      SELECT child.id, d.depth + 1
      FROM down d
      CROSS JOIN LATERAL (
        -- inverse of route 1: rows whose domain_id is this row
        SELECT child_o.id
        FROM objects child_o
        WHERE child_o.domain_id = d.id
          AND child_o.org_id = ${orgId}
          AND child_o.deleted_at IS NULL
        UNION ALL
        -- inverse of route 2: contains edges FROM this row, read forwards
        SELECT child_o.id
        FROM relationships r
        JOIN objects child_o ON child_o.id = r.to_id AND child_o.org_id = ${orgId}
          AND child_o.deleted_at IS NULL
        WHERE r.from_id = d.id
          AND r.org_id = ${orgId}
          AND r.type_id = 'contains'
          AND r.deleted_at IS NULL
        UNION ALL
        -- inverse of routes 3 + 4: live placements naming this row as component or target
        SELECT pl.id
        FROM objects pl
        WHERE pl.org_id = ${orgId}
          AND pl.type_id = 'placement'
          AND pl.deleted_at IS NULL
          AND (
            (CASE WHEN pl.properties ->> 'componentId' ~ ${UUID_TEXT_PATTERN}
                  THEN (pl.properties ->> 'componentId')::uuid END) = d.id
            OR
            (CASE WHEN pl.properties ->> 'deploymentTargetId' ~ ${UUID_TEXT_PATTERN}
                  THEN (pl.properties ->> 'deploymentTargetId')::uuid END) = d.id
          )
      ) child
      WHERE d.depth < ${sql.raw(String(probeDepth))}
    )
    SELECT COALESCE(MAX(depth), 0)::int AS depth FROM down
  `);
  const deepest = Number(result.rows[0]?.depth ?? 0);
  return deepest >= probeDepth;
}

/**
 * The parent's chain, AS A DOOR NEEDS IT: the walk plus the number of hops the parent sits from the
 * org root, with the walk's own ADR-0035 refusal converted into the door's 400.
 *
 * `containmentChain` INVERTS depth on the way out (0 = topmost ancestor found, max = the target
 * itself, which the recursive walk reached at raw depth 0), so the largest returned depth is exactly
 * how many hops the walk took — the LONGEST route to the root when the chain is a DAG, which is the
 * route the invariant counts.
 *
 * THE CONVERSION BRANCH: since ADR-0035 the walk REFUSES past the bound instead of returning a
 * truncated chain. A parent whose own chain is already past it is a row that was planted below the
 * doors (legacy, or imported under the `federationImport` carve-out); the door answers with its own
 * 400 that names the container and what a row under it would cost, rather than let the walk's 409
 * speak for a write it does not know about. The depth bound and the ADR are still named, so an
 * operator meets one story from either side. This message keeps the WALK's phrase on purpose — it is
 * the one door refusal that IS the walk refusing — where every other door refusal carries
 * {@link CONTAINMENT_DEPTH_DOOR_PHRASE}.
 */
export async function containmentParentChainForDoor(
  tx: TenantTx,
  orgId: string,
  childId: string,
  parentId: string
): Promise<{ chain: ChainEntry[]; hops: number }> {
  let chain: ChainEntry[];
  try {
    chain = await containmentChain(tx, orgId, parentId);
  } catch (error) {
    if (!isWalkDepthExceeded(error)) throw error;
    // THE MESSAGE STATES THIS BRANCH'S OWN CONDITION — the container is ALREADY past the bound (a
    // legacy or imported row the doors never saw), so a row under it would be past the bound on
    // that route and every walk that reads it refuses. It does NOT talk about cycles (this helper
    // now serves the CREATE doors too, where the cycle question is deliberately not asked) and it
    // does not claim the org root is missing (refusal 3's condition, not this one's) — an earlier
    // wording did both, lifted verbatim from the move-only era.
    throw badRequest(
      `object '${childId}' cannot be contained by '${parentId}': that container's own ` +
        `containment chain ${WALK_DEPTH_EXCEEDED_PHRASE} (${CONTAINMENT_WALK_MAX_DEPTH} hops, ` +
        `ADR-0035), so a row under it would sit past the bound on that route and every walk that ` +
        `reads it — authority, governance, gates — refuses it. Refused rather than risked. Move ` +
        `the container nearer the root first.`
    );
  }
  const hops = Math.max(0, ...chain.map((entry) => entry.depth));
  return { chain, hops };
}

/**
 * THE DOOR INVARIANT'S ARITHMETIC, in one place (owner ruling 2026-08-18; ADR-0035 Consequences):
 *
 *     hops(parent) + 1 + height(child) > CONTAINMENT_WALK_MAX_DEPTH   =>   refuse (400)
 *
 * The child would sit at `hops(parent) + 1`; its deepest live descendant (over the inverse of the
 * same routes, {@link containmentSubtreeExceeds}) at `hops(parent) + 1 + height(child)`. Every live
 * row must reach the org root within the bound over its LONGEST route, or the walks that read it
 * refuse loudly (ADR-0035) — so a write that would leave any row past it is refused at the door,
 * where it is one 400 with a remedy, instead of later, where it is an ungovernable row.
 *
 * Called by all three doors that add a containment hop — `assertRootedContainmentParent` (route 1,
 * create and move), `relationships-repo.ts`'s `contains` door (route 2) and `placements-repo.ts`'s
 * pair door (routes 3 and 4) — so the rule and the message cannot drift between them.
 *
 * COST, in the order the ruling asked for it: no query at all when the parent is the org root
 * (`createObject`'s existing shortcut never calls this); the row's own depth is decided from the
 * chain the door already walked, so `hops + 1 > bound` refuses before any downward walk; the
 * downward walk is skipped for a CREATE (height 0 by definition) and, on a move, runs bounded at
 * `budget + 1` levels where `budget = bound - hops - 1` is the room left under the parent.
 *
 * ONE message shape: names the child, the parent, the depth the row would sit at, the subtree when
 * the subtree is the reason, the bound and the ADR, and the remedy.
 */
export async function assertContainmentDepthAdmits(
  tx: TenantTx,
  input: {
    orgId: string;
    childId: string;
    parentId: string;
    /** `hops(parent)` as {@link containmentParentChainForDoor} returns it. */
    hops: number;
    /** True for a row that does not exist yet: height is 0 and no downward walk is issued. */
    childIsNew: boolean;
  }
): Promise<void> {
  const rowDepth = input.hops + 1;
  if (rowDepth > CONTAINMENT_WALK_MAX_DEPTH) {
    throw containmentDepthRefusal({ ...input, rowDepth });
  }
  if (input.childIsNew) return;
  const budget = CONTAINMENT_WALK_MAX_DEPTH - rowDepth;
  if (await containmentSubtreeExceeds(tx, input.orgId, input.childId, budget)) {
    throw containmentDepthRefusal({ ...input, rowDepth, subtreeAtLeast: budget + 1 });
  }
}

function containmentDepthRefusal(input: {
  childId: string;
  parentId: string;
  rowDepth: number;
  /** Set when the SUBTREE is the reason: the walk found a live descendant this many levels down
   *  (bounded, so "at least"). */
  subtreeAtLeast?: number;
}): Error {
  const subtree =
    input.subtreeAtLeast === undefined
      ? ""
      : ` and its own subtree is at least ${input.subtreeAtLeast} deep, so its deepest ` +
        `descendant would sit at depth ${input.rowDepth + input.subtreeAtLeast} or below`;
  const remedy =
    input.subtreeAtLeast === undefined
      ? `Flatten the nesting above the container, or move it nearer the root first.`
      : `Flatten the nesting above the container, move it nearer the root first, or flatten the ` +
        `subtree being moved.`;
  return badRequest(
    `object '${input.childId}' cannot be contained by '${input.parentId}': it would sit at depth ` +
      `${input.rowDepth}${subtree}, which ${CONTAINMENT_DEPTH_DOOR_PHRASE} ` +
      `(${CONTAINMENT_WALK_MAX_DEPTH} hops, ADR-0035). Every live row must reach the org root ` +
      `within ${CONTAINMENT_WALK_MAX_DEPTH} hops over every containment route, or the walks that ` +
      `read it — authority, governance, gates — refuse it loudly. ${remedy}`
  );
}

/**
 * THE INVARIANT BEHIND EVERY `domain_id` WRITE: after it, the row must still reach the org root.
 *
 * `graph/containment-parent-authz.ts` documents at length why a row whose scope expansion cannot
 * reach the org root is unrecoverable — authority, governance and audit all terminate there, so
 * NOTHING, not even the org Owner's binding, can read, edit, move back or delete it. That module
 * closed the two values then known to produce that state (a wire `null`, and a soft-deleted parent).
 * A CYCLE is a third, and it needs no `null` at all: `X -> C -> X` terminates inside itself.
 *
 * Measured before this existed, on the real HTTP doors: create C under X, then
 * `PATCH /services/X {domainId: C}` answered **200**, and the org-root admin's own next
 * `GET`/`PATCH`/`DELETE` of BOTH rows answered **403 — permanently**. The refusal it was supposed to
 * hit tested `destination === current.id`, a depth-1 self-parent, and a two-hop loop walks straight
 * past it.
 *
 * Three refusals, all of them the same property reached through different values:
 *
 *  1. **the child is already an ancestor of the parent** — the move closes a loop. Checked over the
 *     WHOLE walk, every route, not just `domain_id`: a `contains` edge is a containment route too
 *     (route 2), so `service -> component -> service` is a cycle even though only one hop is a
 *     `domain_id`. Authority expands along exactly these routes, so a loop in any of them is a loop.
 *  2. **the write would put a live row PAST `CONTAINMENT_WALK_MAX_DEPTH`** — the DOOR INVARIANT
 *     (owner ruling 2026-08-18, ADR-0035 Consequences): after every write, every live row's LONGEST
 *     containment route to the org root — over all four routes, the pair counted — is at most
 *     `CONTAINMENT_WALK_MAX_DEPTH` hops. The row being parented sits at `hops(parent) + 1`; if it
 *     already has a subtree, that subtree comes with it, so the deepest row after the write sits at
 *     `hops(parent) + 1 + height(child)`. Refused when that exceeds the bound —
 *     {@link assertContainmentDepthAdmits} is the one place the arithmetic lives, and
 *     `relationships-repo.ts` (a `contains` edge) and `placements-repo.ts` (a placement's pair) call
 *     the same function, so the three ways a hop is added share one rule and one message.
 *     Why it is an invariant and not caution: since ADR-0035 EVERY walk of a row past the bound
 *     refuses loudly (RBAC when no grant is found before the bound, policy matching, freeze and gate
 *     scoping, ADR-0032 enablement), so a row planted at hop eleven is a row nobody can govern and —
 *     when the eleven-hop route is its only one — nobody can read, rename or move back, the org
 *     Owner included. Measured on the real doors before this refusal existed: `POST /domains
 *     {domainId: <a domain at hop ten>}` answered 201, and the org-root admin's own next GET of the
 *     new row and the PATCH that would have moved it back both answered **409**.
 *  3. **the org root is not on the parent's chain** — the parent is ALREADY detached (a legacy row,
 *     or one planted before the doors were closed), so parenting under it detaches the child too.
 *     This is the soft-deleted-ancestor case one level up: `containmentChain` refuses to walk
 *     through a tombstone, exactly as `scopeExpandCte` does, so a live parent under a dead one has
 *     no route to the root and cannot lend one.
 *
 * ## `childIsNew` — which of the three a CREATE gets
 *
 * Refusal 1 asks about the CHILD's id — "is it already on the parent's chain?" — and on a CREATE that
 * question is unaskable: the child is not in the graph yet, so it is on no chain, and the id cannot
 * secretly belong to an existing row either (the insert's primary key would conflict). So a create
 * skips 1. Refusals 2 and 3 are properties of the PARENT's chain and of the row about to be written,
 * and a create gets BOTH: for 2 the child's height is zero by definition (a fresh row has no
 * subtree), so the rule collapses to `hops(parent) + 1 <= bound`, and no downward walk is issued.
 *
 * RETIRED REASONING, kept so nobody reinstalls it: an earlier version of this block skipped refusal
 * 2 on a create too, arguing that it "exists solely because a truncated walk leaves 1's answer
 * unproven" and that running it would "move the documented nesting ceiling from ten levels to
 * nine". Both halves were written against the PRE-ADR-0035 walk, which silently truncated at the
 * bound; under the loud walk a parent at exactly ten hops has a COMPLETE chain, and the create that
 * skip admitted was precisely the one that planted an ungovernable row at hop eleven. Ten hops
 * remains the ceiling — the org root within ten hops of EVERY live row — the door simply has to
 * count the row it is about to write. The pinned shape that used to argue for the skip
 * (`routes/containment-move-cycle-and-source-authz.integration.test.ts`'s past-the-bound case) is now
 * planted below the doors in that test, because it can no longer be built through one; the door
 * cases live in `graph/containment-depth-doors.integration.test.ts`.
 *
 * It DEFAULTS to false, so a caller that says nothing gets the strict, move-path behaviour.
 *
 * `orgId` IS the org root object's id — `auth/local-auth.ts`'s `ensureOrgRootObject` creates it with
 * `id: orgId` ("stable, predictable id for the org root object"), which is the same identity every
 * door already relies on when it writes `scopeObjectId ?? orgId`.
 *
 * Deliberately subject-free, so it can live at the REPO (see `federation/domain-local.ts`'s
 * "authorization at the door, invariant at the repo"): the federation importer and IaC apply reach
 * `updateObject` with synthetic or drained-list actors, and an invariant that needed a subject would
 * have to be re-implemented at each of them — which is how the apply path came to carry its own,
 * weaker, copy of the destination check in the first place.
 */
export async function assertRootedContainmentParent(
  tx: TenantTx,
  input: {
    orgId: string;
    childId: string;
    parentId: string;
    /** True when `childId` names a row that does not exist yet (a CREATE): refusal 1 is skipped as
     *  unaskable, refusal 2 runs with height 0 (no downward walk), refusal 3 runs. See the
     *  `childIsNew` section above. */
    childIsNew?: boolean;
  }
): Promise<void> {
  const { chain, hops } = await containmentParentChainForDoor(
    tx,
    input.orgId,
    input.childId,
    input.parentId
  );
  const ids = new Set(chain.map((entry) => entry.id));

  if (!input.childIsNew && ids.has(input.childId)) {
    throw badRequest(
      `object '${input.childId}' cannot be contained by '${input.parentId}': '${input.childId}' ` +
        `already contains '${input.parentId}', so this would close a containment cycle. A cycle has ` +
        `no org-root ancestor, and authority, governance and audit all terminate at the org root — ` +
        `every object in the loop becomes unreadable, uneditable, unmovable and undeletable by ` +
        `every principal, the org Owner included.`
    );
  }
  await assertContainmentDepthAdmits(tx, {
    orgId: input.orgId,
    childId: input.childId,
    parentId: input.parentId,
    hops,
    childIsNew: input.childIsNew ?? false
  });
  if (!ids.has(input.orgId)) {
    throw badRequest(
      `object '${input.childId}' cannot be contained by '${input.parentId}': that container does ` +
        `not itself reach the org root (its own containment chain is broken — most often an ` +
        `ancestor was soft-deleted), so anything placed inside it would be unreachable too.`
    );
  }
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
