import { sql } from "drizzle-orm";
import type {
  GraphObject,
  GraphQueryRequest,
  GraphQueryResult,
  NamedGraphQuery
} from "@scp/schemas";
import type { TenantTx } from "../db/tenant-tx.js";
import { mapRawObjectRow, type RawObjectRow } from "./raw-row-mappers.js";
import { sqlIn, sqlInOrAlways } from "./sql-helpers.js";
// M5 layering note (DESIGN.md §5/§9.5): `initiative-rollup` is the one named query whose
// implementation reaches into `coordination/` rather than staying pure graph traversal — an
// initiative's roll-up status is genuinely a coordination-engine concept (derived from campaign
// wave/member-change state, `coordination/campaign-status.ts`), not something expressible as a
// relationship/object traversal alone. Kept here (rather than a parallel dispatcher) because the
// charter's contract is "the intelligence questions become canned, parameterized API queries at
// `/graph/query/{name}`" — duplicating that surface for one query would be the worse trade.
import { toGraphObject } from "./objects-repo.js";
import { campaignsCoordinatedByInitiative } from "../coordination/initiative-repo.js";
import { getCampaignStatus } from "../coordination/campaign-repo.js";

/**
 * Named graph queries (DESIGN.md §5): depth-limited recursive CTEs over indexed adjacency, depth
 * ≤ 10. Every query here is org-scoped (the `relationships`/`objects` RLS policies apply — these
 * run inside the caller's `withTenantTx`, same as any other read) and soft-delete-aware.
 *
 * Two cycle-detection/dedup strategies coexist here, deliberately:
 *
 *  - The five REACHABILITY queries (`impact-of`/`dependents-of`/`consumers-of`/`blast-radius`/
 *    `domains-impacted` — all backed by {@link transitiveReverseClosure} below) only ever need
 *    the SET of reachable nodes, never the route taken to reach them. These dedupe at the NODE
 *    level between recursion steps (plain `UNION`, no `path` array — M9.1 fix, see that
 *    function's doc for the full "why" and the correctness argument for why this is safe).
 *  - `paths-between` (and `graph/traverse.ts`'s own generic walk, a separate capability) genuinely
 *    need the actual sequence of hops, so they keep full path-array tracking and simple-path
 *    (`NOT x = ANY(path)`) cycle detection — untouched by M9.1, and not safe to change the same
 *    way (collapsing to node-level dedup there would silently drop legitimate alternate routes).
 */

const DEFAULT_IMPACT_TYPES = ["depends_on", "consumes", "hosted_on"];

/**
 * Transitive reverse closure: "what points at `startId` (directly or transitively) via any of
 * `relTypes`" — i.e. walk edges backward from `startId`. This is DESIGN.md §5's `impact-of`
 * example, generalized over the relationship-type set so `dependents-of`/`consumers-of`/
 * `impact-of`/`blast-radius`/`domains-impacted` all share this one implementation.
 *
 * M9.1 fix (previously: PR #15's `query-timeout.ts` guardrail, adversarial review of that PR): the
 * old version tracked a full `path` array per row and only deduped with a final `SELECT DISTINCT`
 * — on a high-fan-in ("shared component") topology the same node gets re-expanded once per
 * DISTINCT PATH that reaches it, so intermediate row count grows roughly as
 * (effective fan-in)^depth before that final DISTINCT ever collapses it (measured: 7+ minutes /
 * disk exhaustion on an ~11-way fan-out — see `query-timeout.ts`'s module doc and
 * `named-queries.integration.test.ts`'s perf-regression test for the concrete repro).
 *
 * Fix: dedupe at the NODE level between recursion steps instead — drop `path` entirely and use
 * `UNION` (not `UNION ALL`), so Postgres's own recursive-CTE duplicate elimination does the work.
 * This query never needs `depth`/distance in its OUTPUT (the final `SELECT DISTINCT o.*` never
 * selects it — `depth` exists only to enforce the `maxDepth` hop-limit, i.e. it's a *control*
 * column, not a *result* column), so a bare `(id)` row would be ideal; the one thing standing in
 * the way is that `c.depth < maxDepth` still needs `depth` to enforce the hop limit, which makes
 * the recursive term's dedup key technically `(id, depth)`, not `id` alone. That's fine here,
 * deliberately, for two reasons:
 *
 *   1. It doesn't reopen the blowup: fan-in causes many DISTINCT PATHS to reconverge on the same
 *      node AT THE SAME DEPTH (that's the actual shape of the pathological topology — a uniform
 *      layered DAG puts every node at one deterministic distance from the start) — `(id, depth)`
 *      collapses all of those immediately, every iteration. The only residual duplication is a
 *      node genuinely reachable at several DIFFERENT depths, which — because `maxDepth` is
 *      schema-capped at 10 (`packages/schemas/src/graph.ts`) — bounds any one node to at most 10
 *      redundant occurrences: a constant, linear factor, nothing like the old exponential blowup.
 *   2. It's necessary for correctness, not just incidental: `maxDepth` is a real, user-facing
 *      truncation ("nodes within N hops"), not merely a runaway-query guard, so the recursion
 *      genuinely cannot drop the depth cutoff without changing which nodes come back for a given
 *      `maxDepth` input.
 *
 * `AND r.from_id != startId` in the recursive term replaces the path array's other job: the old
 * `path` was always seeded with `startId` as its first element (`ARRAY[startId, r.from_id]`), so
 * `NOT r.from_id = ANY(c.path)` implicitly ALSO forbade ever re-adding `startId` itself at any
 * depth ≥ 2, unconditionally (a node can't be its own dependent via a cycle back through itself).
 * That invariant is semantically load-bearing — dropping it would let `startId` reappear in its
 * own closure whenever it sits on a cycle within `maxDepth` — so it's kept explicitly rather than
 * as a side effect of path-tracking. (The *base* case — direct predecessors of `startId` — is
 * intentionally left unfiltered, exactly matching the old base case: a literal self-loop edge on
 * `startId` was, and still is, included at depth 1 either way.)
 *
 * For every node other than `startId`, dropping the "simple path" restriction (any node can now
 * be revisited mid-walk, not just avoided-in-this-specific-path) does not change which nodes come
 * back for a given `maxDepth`: if some walk of length ≤ maxDepth reaches node Y (Y ≠ startId) and
 * that walk revisits an earlier node, splicing out the revisited segment yields a strictly
 * SHORTER (still ≤ maxDepth) SIMPLE path to Y — so "reachable via a walk" and "reachable via a
 * simple path" agree for every Y ≠ startId, at every depth bound. Combined with the previous
 * paragraph's explicit `startId` exclusion, the returned node SET is identical to the prior
 * (path-array) implementation for every input — only the internal dedup mechanism changed.
 */
async function transitiveReverseClosure(
  tx: TenantTx,
  orgId: string,
  startId: string,
  relTypes: string[],
  maxDepth: number
): Promise<GraphObject[]> {
  const typeFilter = sqlIn("r.type_id", relTypes);
  const result = await tx.execute<RawObjectRow>(sql`
    WITH RECURSIVE closure AS (
      SELECT r.from_id AS id, 1 AS depth
      FROM relationships r
      WHERE r.to_id = ${startId}::uuid AND r.org_id = ${orgId}::uuid AND r.deleted_at IS NULL
        AND ${typeFilter}
      UNION
      SELECT r.from_id, c.depth + 1
      FROM relationships r
      JOIN closure c ON r.to_id = c.id
      WHERE r.org_id = ${orgId}::uuid AND r.deleted_at IS NULL
        AND ${typeFilter}
        AND r.from_id != ${startId}::uuid
        AND c.depth < ${maxDepth}
    )
    SELECT DISTINCT o.* FROM closure c
    JOIN objects o ON o.id = c.id
    WHERE o.org_id = ${orgId}::uuid AND o.deleted_at IS NULL
  `);
  return result.rows.map(mapRawObjectRow);
}

async function ownersOf(
  tx: TenantTx,
  orgId: string,
  startId: string,
  maxDepth: number
): Promise<GraphObject[]> {
  const result = await tx.execute<RawObjectRow>(sql`
    WITH RECURSIVE containment AS (
      SELECT ${startId}::uuid AS id, 0 AS depth
      UNION ALL
      SELECT o.domain_id, c.depth + 1
      FROM objects o
      JOIN containment c ON o.id = c.id
      WHERE o.org_id = ${orgId}::uuid AND o.domain_id IS NOT NULL AND c.depth < ${maxDepth}
    )
    SELECT DISTINCT o.* FROM relationships r
    JOIN containment c ON r.to_id = c.id
    JOIN objects o ON o.id = r.from_id
    WHERE r.type_id = 'owns' AND r.org_id = ${orgId}::uuid AND r.deleted_at IS NULL
      AND o.org_id = ${orgId}::uuid AND o.deleted_at IS NULL
  `);
  return result.rows.map(mapRawObjectRow);
}

async function pathsBetween(
  tx: TenantTx,
  orgId: string,
  startId: string,
  targetId: string,
  relTypes: string[] | null,
  maxDepth: number
): Promise<{ objects: GraphObject[]; paths: string[][] }> {
  const typeFilter = sqlInOrAlways("r.type_id", relTypes);
  const result = await tx.execute<{ id: string; path: string[]; path_len: number }>(sql`
    WITH RECURSIVE search AS (
      SELECT r.to_id AS id, 1 AS depth, ARRAY[r.from_id, r.to_id] AS path
      FROM relationships r
      WHERE r.from_id = ${startId}::uuid AND r.org_id = ${orgId}::uuid AND r.deleted_at IS NULL
        AND ${typeFilter}
      UNION ALL
      SELECT r.to_id, s.depth + 1, s.path || r.to_id
      FROM relationships r
      JOIN search s ON r.from_id = s.id
      WHERE r.org_id = ${orgId}::uuid AND r.deleted_at IS NULL
        AND ${typeFilter}
        AND NOT r.to_id = ANY(s.path)
        AND s.depth < ${maxDepth}
    )
    -- array_length(path, 1) must be in the SELECT list to ORDER BY it under SELECT DISTINCT.
    SELECT DISTINCT path, array_length(path, 1) AS path_len
    FROM search WHERE id = ${targetId}::uuid ORDER BY path_len ASC LIMIT 5
  `);

  const paths = result.rows.map((r) => r.path);
  const involvedIds = [...new Set(paths.flat())];
  if (involvedIds.length === 0) return { objects: [], paths: [] };

  const objRows = await tx.execute<RawObjectRow>(sql`
    SELECT * FROM objects WHERE org_id = ${orgId}::uuid AND ${sqlIn("id", involvedIds)} AND deleted_at IS NULL
  `);
  return { objects: objRows.rows.map(mapRawObjectRow), paths };
}

/** Nearest ancestor of type `domain` (falling back to `organization`) for each impacted object. */
async function groupByDomain(
  tx: TenantTx,
  orgId: string,
  objectIds: string[]
): Promise<Record<string, number>> {
  if (objectIds.length === 0) return {};
  const result = await tx.execute<{ domain_urn: string; count: number }>(sql`
    WITH RECURSIVE ancestry AS (
      SELECT id AS start_id, id, domain_id, type_id, 0 AS depth FROM objects
      WHERE org_id = ${orgId}::uuid AND ${sqlIn("id", objectIds)}
      UNION ALL
      SELECT a.start_id, o.id, o.domain_id, o.type_id, a.depth + 1
      FROM objects o
      JOIN ancestry a ON o.id = a.domain_id
      WHERE o.org_id = ${orgId}::uuid AND a.depth < 10 AND a.type_id NOT IN ('domain', 'organization')
    ),
    nearest AS (
      SELECT DISTINCT ON (a.start_id) a.start_id, a.id, o.urn
      FROM ancestry a
      JOIN objects o ON o.id = a.id
      WHERE a.type_id IN ('domain', 'organization')
      ORDER BY a.start_id, a.depth ASC
    )
    SELECT urn AS domain_urn, count(*)::int AS count FROM nearest GROUP BY urn
  `);
  return Object.fromEntries(result.rows.map((r) => [r.domain_urn, r.count]));
}

export async function runNamedQuery(
  tx: TenantTx,
  orgId: string,
  name: NamedGraphQuery,
  params: GraphQueryRequest
): Promise<GraphQueryResult> {
  const relTypes = params.relTypes ?? null;

  switch (name) {
    case "owners-of": {
      const objs = await ownersOf(tx, orgId, params.objectId, params.maxDepth);
      return { query: name, objects: objs };
    }
    case "dependents-of": {
      const objs = await transitiveReverseClosure(
        tx,
        orgId,
        params.objectId,
        relTypes ?? ["depends_on"],
        params.maxDepth
      );
      return { query: name, objects: objs };
    }
    case "consumers-of": {
      const objs = await transitiveReverseClosure(
        tx,
        orgId,
        params.objectId,
        relTypes ?? ["consumes"],
        params.maxDepth
      );
      return { query: name, objects: objs };
    }
    case "impact-of": {
      const objs = await transitiveReverseClosure(
        tx,
        orgId,
        params.objectId,
        relTypes ?? DEFAULT_IMPACT_TYPES,
        params.maxDepth
      );
      return { query: name, objects: objs };
    }
    case "blast-radius": {
      const objs = await transitiveReverseClosure(
        tx,
        orgId,
        params.objectId,
        relTypes ?? DEFAULT_IMPACT_TYPES,
        params.maxDepth
      );
      const counts: Record<string, number> = {};
      for (const o of objs) {
        counts[`type:${o.typeId}`] = (counts[`type:${o.typeId}`] ?? 0) + 1;
      }
      // Domain grouping MUST match `domains-impacted` (below) — both queries claim to "count by
      // domain" and must agree on what that means. Reuse `groupByDomain`, which walks each object's
      // `domain_id` ancestry to the NEAREST `domain`/`organization` ancestor and keys by its URN.
      // The old inline version here was single-hop: it keyed by the object's IMMEDIATE `domain_id`
      // (a raw uuid) and labeled it `domain:` unconditionally — so any object whose direct parent is
      // NOT a domain (the org root, a service, or a future deployment-target/region under a
      // stage-domain) was mis-keyed and mis-labeled, disagreeing with `domains-impacted`.
      const byDomain = await groupByDomain(
        tx,
        orgId,
        objs.map((o) => o.id)
      );
      for (const [urn, n] of Object.entries(byDomain)) counts[`domain:${urn}`] = n;
      return { query: name, objects: objs, counts };
    }
    case "domains-impacted": {
      const objs = await transitiveReverseClosure(
        tx,
        orgId,
        params.objectId,
        relTypes ?? DEFAULT_IMPACT_TYPES,
        params.maxDepth
      );
      const counts = await groupByDomain(
        tx,
        orgId,
        objs.map((o) => o.id)
      );
      return { query: name, objects: objs, counts };
    }
    case "paths-between": {
      if (!params.targetId) throw new Error("paths-between requires targetId");
      const { objects: objs, paths } = await pathsBetween(
        tx,
        orgId,
        params.objectId,
        params.targetId,
        relTypes,
        params.maxDepth
      );
      return { query: name, objects: objs, paths };
    }
    case "initiative-rollup": {
      // DESIGN §9.5: "roll-up status DERIVED BY TRAVERSAL... not stored/duplicated state" — walks
      // `coordinates` from the initiative to its member campaigns (org-scoped by construction,
      // same as every query in this file) and tallies each campaign's own PURE derived status
      // (coordination/campaign-status.ts) into `counts`, the same "counts by tag" shape
      // `blast-radius`/`domains-impacted` already use above.
      const campaignRows = await campaignsCoordinatedByInitiative(tx, orgId, params.objectId);
      const counts: Record<string, number> = {};
      for (const row of campaignRows) {
        const status = await getCampaignStatus(tx, orgId, row.id);
        counts[`status:${status}`] = (counts[`status:${status}`] ?? 0) + 1;
      }
      return { query: name, objects: campaignRows.map(toGraphObject), counts };
    }
  }
}
