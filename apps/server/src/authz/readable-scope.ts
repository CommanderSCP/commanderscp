import { sql, type SQL } from "drizzle-orm";
import type { TenantTx } from "../db/tenant-tx.js";
import { CONTAINMENT_WALK_MAX_DEPTH, containmentChildrenSql } from "../graph/containment.js";
import type { Permission } from "./resolve.js";

/**
 * ================================================================================================
 * THE READ SURFACE'S OTHER HALF — "which objects does this subject's authority REACH?"
 * ================================================================================================
 *
 * `authz/resolve.ts` answers ONE question: "may this subject do P at THIS object?", by expanding the
 * object's containment chain UPWARD and looking for a binding on it. That is the right shape for a
 * get-by-id door and the wrong shape for a LIST door, which has no single object to ask about.
 *
 * Increment 2.5a re-scoped the get-by-id doors off `scopeObjectId: auth.orgId`. LIST doors are the
 * other half (docs/proposals/role-model.md §8.2, §8.7): they run one org-root `object:read` check
 * and then return every row in the org, so a ComponentAdmin cannot list at all. This module is the
 * query-side intersection that fixes it — the containment walk run DOWNWARD from the subject's
 * bindings, composed INTO the repo query so it applies BEFORE the `LIMIT`.
 *
 * ------------------------------------------------------------------------------------------------
 * WHY IT IS A QUERY FILTER AND NOT A POST-FILTER — measured, not aesthetic
 * ------------------------------------------------------------------------------------------------
 * Every list repo is keyset-paginated with `.limit(query.limit + 1)` and derives `nextCursor` from
 * the last UNFILTERED row, so filtering rows in the handler shrinks the page AFTER the LIMIT. On a
 * 20,910-object estate an assembly-bound principal's 5 readable components sit at cursor ranks 97,
 * 140, 254, 339 and 440 of 18,500: one readable row on page 1, one each on pages 2–5, and ZERO on
 * pages 6 through 185 — each with a valid `nextCursor` — while 27 of 30 `apps/web` list call sites
 * fetch exactly one page. A post-filter is therefore not a slower version of this; it is a silently
 * wrong one. (role-model.md §8.2.)
 *
 * ------------------------------------------------------------------------------------------------
 * THREE OUTCOMES, AND `null` IS THE DANGEROUS ONE TO MISREAD
 * ------------------------------------------------------------------------------------------------
 * {@link readableObjectFilterSql} returns:
 *
 *   - `null`            — NO FILTER. The subject holds an allow binding at the ORG ROOT, so today's
 *                         query runs verbatim. Callers MUST treat null as "add nothing to the
 *                         WHERE clause"; treating it as "matches nothing" empties every org
 *                         admin's lists.
 *   - an EMPTY id set   — matches NOTHING. The subject holds no allow binding at all for this
 *                         permission. This is the OPPOSITE of `null` and must never collapse into
 *                         it.
 *
 *                         ⚠️ NO PRODUCTION CALLER CAN OBSERVE IT TODAY, and saying so is the point.
 *                         The one production entry point, `list-door-scope.ts`'s
 *                         `readableScopeForListDoor`, returns a 403 on exactly that condition
 *                         (`if (roots.allowRoots.length === 0) return refuseAtOrgRoot(...)`) before
 *                         calling this, and its other two calls pass a single hint id. So this
 *                         branch is a DEFENCE ON THE PURE FUNCTION, not a shape any list door
 *                         renders: it exists so that a future caller which reaches this function
 *                         without that gate — or a refactor that drops the gate — fails CLOSED
 *                         instead of returning `null` and handing the whole org to a subject with
 *                         no grant. `routes/list-readable-scope.integration.test.ts` mutation-proves
 *                         the gate; `readable-scope.integration.test.ts` mutation-proves this
 *                         branch, calling it directly for that reason.
 *   - a descend         — the recursive walk below the subject's allow roots, minus the walk below
 *                         its deny roots.
 *
 * ------------------------------------------------------------------------------------------------
 * HOW A REPO COMPOSES IT (the whole integration surface)
 * ------------------------------------------------------------------------------------------------
 * The returned `SQL` is a parenthesised subquery yielding one `id` column, so a repo adds exactly
 * one condition, before its LIMIT, using ITS OWN id expression (aliases differ per repo):
 *
 * ```ts
 * const filter = await readableScopeForListDoor(tx, { orgId, subjectObjectId, permission, ... });
 * if (filter) conditions.push(sql`${objects.id} IN ${filter}`);   // null => no condition at all
 * ```
 *
 * The value comes from `authz/list-door-scope.ts`, never from {@link readableObjectFilterFor}: a
 * list door must run the org-root arm FIRST and must refuse a subject with no allow root, and this
 * module knows nothing about either. See {@link readableObjectFilterFor} for what that function is
 * actually for.
 *
 * The subquery is UNCORRELATED — it names no column of the outer query, only bound parameters — so
 * the recursive walk is not re-run per row. Measured plan (`EXPLAIN ANALYZE`, PostgreSQL 16, small
 * fixture): the descend plans as one `CTE Scan` under a `Nested Loop Semi Join`, i.e. materialised
 * once and semi-joined against, 0.46 ms planning / 0.09 ms execution. The join strategy is the
 * planner's and was not tuned here; what the composition GUARANTEES is the property the pagination
 * argument above needs — the filter is part of the same statement, so it applies BEFORE the LIMIT.
 *
 * For the OPTIONAL `?scopeObjectId=` narrowing (role-model.md §8.2 step 6) a route authorizes at the
 * hint and then calls `readableObjectFilterSql(orgId, [hint], denyRoots)` — the allow roots are
 * replaced, the deny roots are NOT, because a deny below the hint still subtracts.
 *
 * ------------------------------------------------------------------------------------------------
 * THE PURE-WIDENING INVARIANT THIS MODULE MUST NOT BREAK
 * ------------------------------------------------------------------------------------------------
 * The org-root `authorize()` at the top of each list door STAYS. A subject with no allow binding
 * anywhere still gets today's 403, and a subject with an org-root allow still gets today's rows —
 * which is exactly what the `null` short-circuit guarantees, byte for byte.
 *
 * That short-circuit is also what keeps the DOOR-LEVEL inverse invariant true for an org-root
 * holder who ALSO carries a deny lower down. `authz/org-root-arm.ts`'s org-root arm is evaluated
 * first and never consults such a deny (that is deliberate: "a deny bound below the org root, which
 * the org-root pin never consulted and which this increment therefore must not start honouring"),
 * so the LIST doors show those objects via `null`. **get-by-id does NOT admit them** — an earlier
 * version of this paragraph claimed it did, and that was measured false (org-root allow + a deny at
 * the object: `GET /objects/user/{id}` -> 403, while the list returns the row). Do not "repair" the
 * LIST door to match get-by-id on the strength of a comment: `docs/authz/role-binding-door.md` §2d's projection
 * bar is stated against the LIST behaviour, and that repair would silently make the grant preview the
 * only door showing the row. No test pins this parity today — it is named in §8's open list.
 * `hasPermission()` called in ISOLATION at that object returns false, so the drift test below
 * deliberately measures scoped subjects, and pins the org-root-with-deny case as its own named
 * short-circuit assertion rather than folding it into the sample.
 */

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

/**
 * Every scope at which this subject holds a binding whose role grants `permission` — one query.
 *
 * THE SUBJECT EXPANSION IS `hasPermission`'S, VERBATIM: the subject plus every group/team it
 * transitively belongs to via `member_of`, walked from `from_id` to `to_id`, live edges only, at the
 * same {@link CONTAINMENT_WALK_MAX_DEPTH} bound. It has to be identical, because the roots this
 * returns are fed to a DOWNWARD walk that must reproduce `hasPermission`'s verdict object by object;
 * a subject reachable there and not here shows up as rows missing from a list with no error
 * anywhere.
 *
 * ⚠️ THIS IS A HAND-SYNCED COPY of that expansion — the FOURTH in the tree (`hasPermission`,
 * `hasRoleAtScope` and `assertDenyNotTruncated` already each carry one; `graph/containment.ts`'s
 * header records what hand-synced copies of the CONTAINMENT walk cost when they drifted). The right
 * fix is to export a `subjectExpandCte` fragment from `resolve.ts` and compose it in all four, the
 * way `placementParentsSql` and {@link containmentChildrenSql} are composed; that edit belongs to
 * `resolve.ts`, which is outside this increment's file set, and is filed as a follow-up. Until then
 * the drift detector is real rather than notional: `readable-scope.integration.test.ts` routes one
 * subject's binding through a NESTED `member_of` chain and asserts `hasPermission` and the readable
 * set agree object by object, so a divergence between the two expansions fails a named test.
 *
 * DELIBERATELY NOT DEPTH-PROBED. `hasPermission` converts a nothing-found verdict into a loud
 * `walkDepthExceeded` when either walk was truncated (ADR-0037). Here there is nothing to convert:
 * the list door's own org-root `authorize()` runs `hasPermission` FIRST, so a subject nested past
 * the bound has already met that 409 before this function is reached. Re-probing would pay for the
 * same answer twice.
 *
 * Measured at 0.3–0.5 ms on the existing `role_bindings_subject (org_id, subject_id)` index over a
 * 20,910-object estate (role-model.md §8.2).
 */
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

/**
 * Split {@link readableRootsFor}'s rows into the allow roots and the deny roots — by EXACT string
 * equality, which is the whole point of this function existing.
 *
 * ⚠️ A `role_bindings.effect` THAT IS NEITHER STRING IS STILL REACHABLE, and `hasPermission`
 * classifies it in JS: `effects.includes('deny')` then `effects.includes('allow')`. So a row
 * spelled `'ALLOW'` matches NEITHER branch and grants NOTHING — it falls through to the default
 * deny. Any classification here that is looser than that is a SILENT WIDENING of authority relative
 * to the function it mirrors: written `effect !== 'deny'`, an `'ALLOW'` row that grants nothing on
 * a get-by-id door would grant a whole subtree on every list door. Hence `=== "allow"` exactly, and
 * `=== "deny"` exactly, and a row that is neither lands in neither set.
 *
 * `role_bindings_effect_check` (drizzle/0096) makes the database refuse such a row on INSERT and
 * UPDATE, and 0096 deletes the ones it finds. That is an OUTER layer, not a replacement for this
 * one: a CHECK cannot un-write a row that pre-dates it, so any deployment restored from a pre-0096
 * dump — or touched by a superuser path that is not `scp_app` — can still present one here. This
 * function is what makes that row harmless. (Mutation-proven: `readable-scope.integration.test.ts`
 * and `inverse-walk-drift.integration.test.ts` both build such a row deliberately, via
 * `test-support/harness.ts`'s `insertMalformedEffectRoleBinding`, and both go red the moment this
 * is relaxed.)
 *
 * The classification lives in JS rather than in the SQL above for one reason: `hasPermission`'s
 * lives in JS, and two comparisons written in two languages are two things to keep in step.
 */
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

/**
 * The readable-object id set, as a subquery to intersect a list query with — or `null` for "no
 * filter at all" (see the module doc's three outcomes).
 *
 * ------------------------------------------------------------------------------------------------
 * DENY IS A SUBTRACTION, NOT AN ABSENCE — hence a SECOND descend and an `EXCEPT`
 * ------------------------------------------------------------------------------------------------
 * `resolve.ts` gives a deny binding priority at ANY matching scope on the object's upward chain:
 * `hasPermission(o)` is false iff some deny binding sits at an ancestor-or-self of `o`. Read
 * downward, that is exactly `o ∈ descend(denyRoots)`. So the readable set is
 * `descend(allowRoots) EXCEPT descend(denyRoots)` — two walks, not one walk with a filtered seed.
 * Omitting the second descend does not make deny approximate; it makes deny INERT on every list
 * door while it still works on get-by-id — a deny that fails OPEN. (Mutation-proven: dropping the
 * `EXCEPT` fails `readable-scope.integration.test.ts`'s named deny case.)
 *
 * ------------------------------------------------------------------------------------------------
 * THE SEEDS ARE FILTERED LIVE — a tombstoned scope grants (and denies) nothing
 * ------------------------------------------------------------------------------------------------
 * Upward, `scopeExpandCte` joins every ANCESTOR `deleted_at IS NULL`, so a binding at a soft-deleted
 * service stops reaching that service's live components. The downward mirror of that is the seed
 * JOIN below: a deleted root contributes neither itself nor a subtree. It applies to the DENY seed
 * for the same reason and in the same direction — upward, a tombstoned deny ancestor is off the
 * chain and does not refuse, so downward it must not subtract.
 *
 * ------------------------------------------------------------------------------------------------
 * THE BOUND, AND WHAT HAPPENS PAST IT (role-model.md §8.3's truncation hazard, decided)
 * ------------------------------------------------------------------------------------------------
 * The descend is bounded at {@link CONTAINMENT_WALK_MAX_DEPTH} — the SAME constant, with the same
 * `depth < bound` shape, that `scopeExpandCte` bounds the upward walk with. That is what makes the
 * two directions exact inverses rather than approximately so: the paths are literally the same
 * sequences read backwards, so `o ∈ descend(r)` iff `r ∈ scopeExpand(o)`, truncation included.
 *
 * Downward there is no `walkDepthExceeded` conversion, and that is a deliberate choice, not an
 * oversight:
 *
 *  1. It cannot fire on a legally-built estate. Every live locally-written row reaches the org root
 *     within the bound — the three write doors refuse anything else (ADR-0037 Consequences,
 *     `assertContainmentDepthAdmits`) — and a non-org-root allow root sits at depth ≥ 1, so nothing
 *     below it can be more than `bound - 1` hops away. An org-root allow root short-circuits to
 *     `null` and never walks at all.
 *  2. Where it CAN fire — a row planted past the bound by the federation-import carve-out or by
 *     legacy data — the row is already ungovernable in both directions: every UPWARD walk of it
 *     refuses loudly, so its get-by-id door answers 409 rather than 200. The list omitting it is
 *     not hiding something the API would otherwise hand over; membership still agrees, and only
 *     loudness differs.
 *  3. Converting it would turn a per-ROW fault into a whole-PAGE 409 for the scoped principal —
 *     the exact trade ADR-0037's own federation carve-out rejects ("a per-CHANNEL failure for a
 *     per-row fault"). Meanwhile the principal who can actually repair such a row, the org-root
 *     admin, gets `null` here and still sees it in the list, exactly as today.
 *
 * ------------------------------------------------------------------------------------------------
 * WHY `(VALUES ...)` AND NOT `unnest($1::uuid[])`
 * ------------------------------------------------------------------------------------------------
 * drizzle-orm's `sql` tag expands a JS array interpolation into a parenthesised parameter LIST, so
 * `${roots}::uuid[]` receives a bare scalar or an anonymous record and fails to cast — measured and
 * written down at `graph/sql-helpers.ts`. The in-tree idiom for a caller-sized set of typed
 * parameters is `(VALUES (${id}::uuid), ...)` (`iac/stack-ownership.ts`, `coordination/service-board.ts`),
 * and it binds each id as its own parameter, so no id is ever concatenated into SQL text.
 */
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

/**
 * One named `WITH RECURSIVE` term: the live seed roots, then {@link containmentChildrenSql} recursed
 * to the shared bound.
 *
 * `UNION` (not `UNION ALL`), and the reason is narrower than the one that used to be written here —
 * MEASURED on PostgreSQL 16, because the plausible version is wrong. The recursive term emits
 * `(id, depth)` PAIRS, so `UNION` can only collapse an id reached by two routes AT THE SAME DEPTH:
 * two services that both `contains` one component, arriving at depth 2 twice. It does NOT collapse
 * the case the old comment offered as its example — a component reachable via its domain at depth 1
 * AND via its service at depth 2 — which is two rows under `UNION` exactly as under `UNION ALL`,
 * with its whole subtree walked from each. (Probed both ways: identical output, identical row
 * counts.) So `UNION` buys same-depth fan-in, not DAG collapse, and it is not what terminates the
 * walk either — the `depth <` guard below is.
 *
 * That duplication is harmless HERE in a way it is not in `containmentSubtreeExceeds`: this term is
 * consumed as `SELECT id FROM …` inside an `IN`/`EXCEPT`, where a repeated id is a no-op, whereas
 * that walk reads `MAX(depth)` and needs the longest route per row. Membership is what this
 * computes, so both readings agree; keep `UNION` anyway, because the same-depth fan-in it collapses
 * is the common shape in a wide estate.
 */
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

/**
 * THE UNGATED READABLE SET — resolve the subject's roots, classify them, build the filter.
 *
 * ⚠️ NOT THE PRODUCTION PATH, and deliberately not wired to one. Every list door goes through
 * `authz/list-door-scope.ts`'s `readableScopeForListDoor`, which does three things this does not and
 * must not: it runs the org-root arm FIRST, it 403s a subject with no allow root instead of handing
 * back a match-nothing set, and it refuses an org-root allow that an org-root DENY outranked. A repo
 * that called this instead would answer 200-with-an-empty-page where the door owes a 403.
 *
 * What it IS for: the drift detector. `readable-scope.integration.test.ts` and
 * `inverse-walk-drift.integration.test.ts` need "the set the DOWNWARD walk produces for this
 * subject" with no gate in front of it, so they can assert `hasPermission(o)` iff
 * `o ∈ readableSet(subject)` over every live object — including the subjects the gate would have
 * refused, which are precisely the interesting ones for that invariant. Exported for that, and kept
 * here rather than in the test files so the two suites cannot each grow their own partition call and
 * drift the `effect` classification back to `!== 'deny'`.
 *
 * Returns exactly what {@link readableObjectFilterSql} returns, with the same three outcomes; `null`
 * means NO FILTER.
 */
export async function readableObjectFilterFor(
  tx: TenantTx,
  input: ReadableRootsInput
): Promise<SQL | null> {
  const { allowRoots, denyRoots } = partitionReadableRoots(await readableRootsFor(tx, input));
  return readableObjectFilterSql(input.orgId, allowRoots, denyRoots);
}
