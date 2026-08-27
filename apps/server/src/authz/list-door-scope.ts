import type { SQL } from "drizzle-orm";
import type { TenantTx } from "../db/tenant-tx.js";
import { forbidden } from "../errors.js";
import { authorize, hasPermission, type Permission } from "./resolve.js";
import {
  partitionReadableRoots,
  readableObjectFilterSql,
  readableRootsFor
} from "./readable-scope.js";

/**
 * ================================================================================================
 * THE LIST DOOR'S GATE — "may you list at all, and which rows?" — in ONE place
 * ================================================================================================
 *
 * `authz/readable-scope.ts` builds the row FILTER (the containment walk run downward from a
 * subject's bindings, composed into the repo query so it applies before the `LIMIT`). It does not
 * decide whether the door opens. This module is the other half: the check a LIST handler runs where
 * it used to run `authorize({ scopeObjectId: auth.orgId })`, plus the optional `?scopeObjectId=`
 * narrowing, in the ONE order that is safe.
 *
 * It exists as a module rather than as a paragraph in each route because the tree has a list door
 * per family — `/campaigns`, `/placements`, `/changes`, `/components`, `/objects/{type}`, every
 * typed registry, `/relationships`, `/change-sources/{kind}/mappings`, and `/objects/service`,
 * whose check lives one directory away in `services/objects-service.ts` where a `routes/*.ts`
 * census cannot see it (§8.1) — and the four things this does are only correct in one sequence.
 * One idea hand-copied per call site is what `graph/containment.ts`'s header records costing a
 * service-scoped freeze that failed OPEN and a service-scoped approval that failed CLOSED.
 *
 * ------------------------------------------------------------------------------------------------
 * WHAT REPLACED WHAT, AND WHY THAT IS STILL A PURE WIDENING
 * ------------------------------------------------------------------------------------------------
 * Before: `authorize({ permission, scopeObjectId: auth.orgId })`, then every row in the org.
 * After: the SAME check, first and unchanged, as the WIDE arm — and when it passes, the filter is
 * `null` and the repo query is today's, verbatim (`readableObjectFilterSql`'s org-root
 * short-circuit). Only when the wide arm REFUSES does anything new happen: instead of a 403, the
 * subject's own allow roots are resolved, and the door opens onto exactly their subtrees.
 *
 * So: everything that worked before works identically, and a subject with **no allow binding
 * anywhere** still gets today's 403 — thrown by re-running today's check, so its wording cannot
 * drift from `authorize()`'s. That is role-model.md §8.2 step 5's invariant, and it is what makes
 * the change safe to ship without the behavioural tests §8.5 measured as absent.
 *
 * > ⚠️ §8.2 step 5 says "keep the org-root `authorize()` **unchanged**", and read as "leave the
 * > `authorize()` CALL exactly where it is and change nothing else" that is measurably inert:
 * > `scope_expand` from the org root is the org root alone, so the only subject that clears it is
 * > one holding an org-root allow — and that is precisely the subject for whom
 * > `readableObjectFilterSql` returns `null`. The filter could then never apply to anybody. What is
 * > kept unchanged here is the org-root ARM: the same check, same permission, same scope, run
 * > FIRST, with the same 403 on the path where nothing else grants. §8.2's own step-5 sentence
 * > ("a subject with no allow binding **anywhere** still gets today's 403") is the one that pins
 * > the intent, and it is the one implemented.
 *
 * ------------------------------------------------------------------------------------------------
 * THE ORDER, WHICH IS THE WHOLE POINT OF THE `resolveScopeObject` CALLBACK
 * ------------------------------------------------------------------------------------------------
 *   1. GATE — the permission at the org root, or an allow binding SOMEWHERE for it. Refuse here if
 *      neither, with the same 403 as before, and refuse *whether or not* a hint was supplied.
 *   2. ONLY THEN resolve `?scopeObjectId=` — an id naming nothing is a 404, and resolving it before
 *      step 1 would make "does this id exist?" answerable by a caller who holds nothing at all: 403
 *      for a real id, 404 for a ghost. That is the pre-authorization existence oracle
 *      `routes/campaigns.ts`'s `resolveCampaignForScope` was written to close, and the first draft
 *      of this module reintroduced it exactly — the hint path authorized at the hint and never
 *      consulted the subject's own roots, so the gate effectively ran second. `no
 *      pre-authorization existence oracle` is the case that caught it.
 *   3. AUTHORIZE at the RESOLVED id. Scoping at the raw query parameter instead would turn every
 *      404 on this route into a 403 for everybody, org-root Owner included, because
 *      `scopeExpandCte` seeds its CTE with the raw uuid and never checks existence (§8.7's trap).
 *   4. Seed the descend from the hint.
 *
 * The caller supplies the resolver instead of this module importing one, so the ordering lives here
 * (where it cannot be got wrong per route) while `authz/` keeps no dependency on `graph/`.
 *
 * ------------------------------------------------------------------------------------------------
 * THE HINT IS A NARROWING OF *YOUR OWN* RESULTS, NEVER A WIDENING — WITH ONE MEASURED EXCEPTION
 * ------------------------------------------------------------------------------------------------
 * `descend(hint)` is a subset of what the caller could already read:
 *
 *   - admitted by the WIDE arm — the caller reads the whole org, so any subtree of it is a subset.
 *     Unconditional: the unhinted answer is `null`, i.e. every row;
 *   - admitted by the NARROW arm — `hasPermission(hint)` was true, so some allow root of theirs is
 *     an ancestor-or-self of the hint and no deny sits on the hint's own chain. Every row below the
 *     hint is therefore below that allow root too, minus the denies subtracted below.
 *
 * > ⚠️ THE NARROW-ARM BULLET IS FALSE PAST THE WALK BOUND, and it is the one truncation case the
 * > three past-the-bound tests did not cover. Both descends are bounded at
 * > `CONTAINMENT_WALK_MAX_DEPTH` FROM THEIR OWN SEED. Re-seeding at a hint `k` hops below the allow
 * > root therefore moves the horizon `k` hops DEEPER: a row at `bound + 1 .. bound + k` hops below
 * > the allow root is absent from the unhinted answer and PRESENT in the hinted one. So the hint can
 * > add rows — never rows outside the subtree the caller's own binding reaches (the hint is itself
 * > under that binding, so the descend can only go down from it), only rows FURTHER DOWN it than
 * > the unhinted walk sees.
 * >
 * > It cannot fire on a legally-built estate — the three write doors keep every live row within the
 * > bound of the org root (`assertContainmentDepthAdmits`), so nothing sits more than `bound - 1`
 * > hops below a non-root allow root. Where it CAN fire (federation-import carve-out, legacy rows)
 * > the rows it adds are rows whose get-by-id answers **409**, not 200 — they are ungovernable in
 * > both directions and belong to the caller's own subtree — which is the same trade
 * > `readable-scope.ts`'s decision block already takes for downward truncation: a per-ROW fault is
 * > not converted into a whole-PAGE refusal. Tolerated deliberately, and pinned rather than left as
 * > prose: `authz/inverse-walk-drift.integration.test.ts`'s "a hint re-seeds the bound" case builds
 * > the illegal estate and asserts the extra row, so narrowing this later is a red test rather than
 * > a silent change.
 *
 * ------------------------------------------------------------------------------------------------
 * WHICH DENY ROOTS SUBTRACT, AND WHY IT DEPENDS ON THE ARM THAT ADMITTED
 * ------------------------------------------------------------------------------------------------
 * `authz/org-root-arm.ts` states the doctrine this must not break: the org-root arm is evaluated
 * first and "a deny bound below the org root, which the org-root pin never consulted, [...] this
 * increment therefore must not start honouring". A get-by-id door admits an org-root holder at
 * every object regardless of a deny lower down. So when the WIDE arm admitted, the hinted filter
 * subtracts NOTHING — otherwise a hinted list would hide rows the get-by-id door hands over, which
 * is exactly the §8.3 disagreement this increment exists to prevent.
 *
 * When the NARROW arm admitted, the subject's deny roots DO subtract, because those are the denies
 * `hasPermission` itself honours for that subject.
 *
 * (This is why the hint path does not simply call `checkAtOrgRootOrScopes`: its
 * {@link import("./org-root-arm.js").OrgRootOrScopedVerdict} deliberately reports only ok/not-ok
 * and the single refused scope, never WHICH arm admitted, and the deny set depends on that. The
 * wide arm is still evaluated first, with the same call, for the same reason. If that verdict ever
 * grows an arm discriminator, collapse this into it.)
 */

export interface ListDoorScopeInput {
  orgId: string;
  subjectObjectId: string;
  /** The permission the door demands — `object:read` on every current caller, but the typed
   *  registries carry a per-resource `readPermission`, so it is a parameter. */
  permission: Permission;
  /** The raw `?scopeObjectId=` value, or `undefined` when the caller did not narrow. */
  scopeObjectRef?: string | undefined;
  /**
   * Resolves {@link scopeObjectRef} to an object id, throwing 404 when it names nothing in this
   * org. Called ONLY after the gate has admitted the caller — see the order above. Unused when
   * `scopeObjectRef` is `undefined`.
   */
  resolveScopeObject: (ref: string) => Promise<string>;
}

/**
 * The row filter a list repo should apply — or `null` for "no filter, run today's query verbatim".
 *
 * Throws 403 when the subject may not list at all, and 404 when `?scopeObjectId=` names nothing.
 *
 * ⚠️ `null` AND an empty set are opposites. `null` means NO CONDITION; the filter that matches
 * nothing is a real `SQL` value. Callers must write `if (filter) conditions.push(...)` and must
 * never map `null` onto an empty id list — that would empty every org admin's lists.
 */
export async function readableScopeForListDoor(
  tx: TenantTx,
  input: ListDoorScopeInput
): Promise<SQL | null> {
  const { orgId, subjectObjectId, permission } = input;

  // ---- 1. THE WIDE ARM: today's check, unchanged, first --------------------------------------
  const atOrgRoot = await hasPermission(tx, {
    orgId,
    subjectObjectId,
    permission,
    scopeObjectId: orgId
  });

  // ---- 2. THE GATE, for everyone the wide arm refused ----------------------------------------
  // Runs BEFORE the hint is resolved, and refuses with today's message either way, so that a
  // caller holding nothing cannot tell a real `?scopeObjectId=` from a ghost one. Both are 403.
  let unhintedFilter: SQL | null = null;
  let denyRoots: string[] = [];
  if (!atOrgRoot) {
    const roots = partitionReadableRoots(
      await readableRootsFor(tx, { orgId, subjectObjectId, permission })
    );
    denyRoots = roots.denyRoots;
    // No allow binding anywhere for this permission — the subject this door refused before 2.5b,
    // and still refuses.
    if (roots.allowRoots.length === 0) return refuseAtOrgRoot(tx, input);
    unhintedFilter = readableObjectFilterSql(orgId, roots.allowRoots, roots.denyRoots);
    if (unhintedFilter === null) {
      // The allow roots contained the ORG ROOT and yet the wide arm above refused — which can only
      // mean a deny binding at the org root outranked it (`scope_expand` from the org root is the
      // org root alone, so there is nowhere else that verdict could come from). `null` means NO
      // FILTER, so returning it would hand the entire org to the one subject the org root
      // explicitly denies. A deny at the root reaches everything under it: refuse.
      return refuseAtOrgRoot(tx, input);
    }
  }

  if (input.scopeObjectRef === undefined) return atOrgRoot ? null : unhintedFilter;

  // ---- 3. resolve the hint, AFTER the gate ---------------------------------------------------
  const hintId = await input.resolveScopeObject(input.scopeObjectRef);

  // ---- 4. authorize at the RESOLVED hint, then seed the descend from it -----------------------
  if (atOrgRoot) {
    // Admitted by the wide arm: the hint narrows, and nothing subtracts (see the doctrine above).
    // `hintId === orgId` falls through the short-circuit to `null`, i.e. "narrow to the whole org"
    // is the un-narrowed query — the honest answer, not a special case.
    return readableObjectFilterSql(orgId, [hintId], []);
  }
  const atHint = await hasPermission(tx, {
    orgId,
    subjectObjectId,
    permission,
    scopeObjectId: hintId
  });
  if (!atHint) {
    throw forbidden(
      `subject '${subjectObjectId}' lacks '${permission}' at the org root and at scope '${hintId}'`
    );
  }
  return readableObjectFilterSql(orgId, [hintId], denyRoots);
}

/**
 * Today's 403, produced by re-running today's check so its wording can never drift from
 * `authorize()`'s. `hasPermission` already answered false for this exact triple, in this
 * transaction, so `authorize` always throws; the line after it exists only because TypeScript
 * cannot know that, and it is a bug report rather than a fallback.
 */
async function refuseAtOrgRoot(tx: TenantTx, input: ListDoorScopeInput): Promise<never> {
  await authorize(tx, {
    orgId: input.orgId,
    subjectObjectId: input.subjectObjectId,
    permission: input.permission,
    scopeObjectId: input.orgId
  });
  throw new Error(
    "unreachable: authorize() must refuse where hasPermission() has already returned false"
  );
}
