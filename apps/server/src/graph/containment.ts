import { sql, type SQL } from "drizzle-orm";
import type { TenantTx } from "../db/tenant-tx.js";
import { badRequest, conflict } from "../errors.js";

/** THE containment walk. See docs/graph.md §29. */

/** ROUTES 3 AND 4, shared verbatim by BOTH containment walks. See docs/graph.md §30. */
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

/** ROUTE 3 ALONE. See docs/graph.md §31. */
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

/** ROUTES 3 + 4 AS A PREDICATE OVER A PLACEMENT ROW. See docs/graph.md §32. */
export function placementNamesObjectSql(propertiesSql: SQL, objectIdSql: SQL): SQL {
  return sql`(
        (CASE WHEN ${propertiesSql} ->> 'componentId' ~ ${UUID_TEXT_PATTERN}
              THEN (${propertiesSql} ->> 'componentId')::uuid END) = ${objectIdSql}
        OR
        (CASE WHEN ${propertiesSql} ->> 'deploymentTargetId' ~ ${UUID_TEXT_PATTERN}
              THEN (${propertiesSql} ->> 'deploymentTargetId')::uuid END) = ${objectIdSql}
      )`;
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

/** Target up to org root, walking four containment routes. See docs/graph.md §33. */
/** THE CONTAINER TYPES. See docs/graph.md §34. */
export const CONTAINER_TYPES = ["service", "assembly"] as const;

/** THE ONE DEPTH BOUND every recursive graph walk shares (ADR-0037). See docs/graph.md §35. */
export const CONTAINMENT_WALK_MAX_DEPTH = 10;
/** One past the bound: a row AT this depth proves the walk was cut, not complete. */
export const WALK_TRUNCATION_PROBE_DEPTH = CONTAINMENT_WALK_MAX_DEPTH + 1;

/** The phrase every depth refusal carries — the sentence operators (and tests) recognise it by,
 *  and the marker {@link isWalkDepthExceeded} reads. */
const WALK_DEPTH_EXCEEDED_PHRASE = "exceeds the supported containment depth";

/** The phrase every DOOR refusal carries. See docs/graph.md §36. */
export const CONTAINMENT_DEPTH_DOOR_PHRASE = "would exceed the supported containment depth";

/** The uniform refusal for a walk that hit the bound — one message shape for all six sites, so
 *  operators meet one explanation, not six dialects. */
export function walkDepthExceeded(what: string, remedy: string): Error {
  return conflict(
    `${what} ${WALK_DEPTH_EXCEEDED_PHRASE} (${CONTAINMENT_WALK_MAX_DEPTH} hops, ADR-0037). ` +
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
        -- Both are fixed in M22 (ADR-0037 section 5). If you add a third container level, grep for
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
      -- ADR-0037: expand ONE level past the shared bound. A row landing at the probe depth is the
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

/** THE DOWNWARD FRAGMENT. See docs/graph.md §37. */
export function containmentChildrenSql(orgId: string, parentIdSql: SQL): SQL {
  return sql`
    -- arm 1 (inverse of route 1): rows whose domain_id is this row
    SELECT child_o.id AS child_id
    FROM objects child_o
    WHERE child_o.domain_id = ${parentIdSql}
      AND child_o.org_id = ${orgId}
      AND child_o.deleted_at IS NULL
    UNION ALL
    -- arm 2 (inverse of route 2): contains edges FROM this row, read forwards
    SELECT child_o.id AS child_id
    FROM relationships r
    JOIN objects child_o ON child_o.id = r.to_id AND child_o.org_id = ${orgId}
      AND child_o.deleted_at IS NULL
    WHERE r.from_id = ${parentIdSql}
      AND r.org_id = ${orgId}
      AND r.type_id = 'contains'
      AND r.deleted_at IS NULL
    UNION ALL
    -- arm 3 (inverse of routes 3 + 4): live placements naming this row as component or target
    SELECT pl.id AS child_id
    FROM objects pl
    WHERE pl.org_id = ${orgId}
      AND pl.type_id = 'placement'
      AND pl.deleted_at IS NULL
      AND ${placementNamesObjectSql(sql`pl.properties`, parentIdSql)}
  `;
}

/** THE DOWNWARD WALK. See docs/graph.md §38. */
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
      SELECT child.child_id, d.depth + 1
      FROM down d
      CROSS JOIN LATERAL (${containmentChildrenSql(orgId, sql`d.id`)}) child
      WHERE d.depth < ${sql.raw(String(probeDepth))}
    )
    SELECT COALESCE(MAX(depth), 0)::int AS depth FROM down
  `);
  const deepest = Number(result.rows[0]?.depth ?? 0);
  return deepest >= probeDepth;
}

/** The parent's chain, with the hop count a door needs. See docs/graph.md §39. */
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
    // THE MESSAGE STATES THIS BRANCH'S OWN CONDITION. See docs/graph.md §40.
    throw badRequest(
      `object '${childId}' cannot be contained by '${parentId}': that container's own ` +
        `containment chain ${WALK_DEPTH_EXCEEDED_PHRASE} (${CONTAINMENT_WALK_MAX_DEPTH} hops, ` +
        `ADR-0037), so a row under it would sit past the bound on that route and every walk that ` +
        `reads it — authority, governance, gates — refuses it. Refused rather than risked. Move ` +
        `the container nearer the root first.`
    );
  }
  const hops = Math.max(0, ...chain.map((entry) => entry.depth));
  return { chain, hops };
}

/** THE DOOR INVARIANT'S ARITHMETIC, in one place. See docs/graph.md §41. */
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
      `(${CONTAINMENT_WALK_MAX_DEPTH} hops, ADR-0037). Every live row must reach the org root ` +
      `within ${CONTAINMENT_WALK_MAX_DEPTH} hops over every containment route, or the walks that ` +
      `read it — authority, governance, gates — refuse it loudly. ${remedy}`
  );
}

/** THE INVARIANT BEHIND EVERY `domain_id` WRITE. See docs/graph.md §42. */
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

/** The NEAREST ancestor of `chain` carrying `typeId`. See docs/graph.md §43. */
export function nearestAncestorOfKind(chain: ChainEntry[], typeId: string): ChainEntry | null {
  const candidates = chain.filter((c) => c.typeId === typeId);
  if (candidates.length === 0) return null;
  return candidates.reduce((best, c) =>
    c.depth > best.depth || (c.depth === best.depth && c.id < best.id) ? c : best
  );
}
