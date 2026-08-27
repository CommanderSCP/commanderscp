import type { SQL } from "drizzle-orm";
import type { TenantTx } from "../db/tenant-tx.js";
import type { PermissionCheck } from "./resolve.js";
import { readableScopeForListDoor } from "./list-door-scope.js";

/**
 * ================================================================================================
 * THE `listObjects` LIST DOORS' ADAPTER onto the one list-door gate — NOT a second gate
 * ================================================================================================
 *
 * `authz/list-door-scope.ts`'s {@link readableScopeForListDoor} is THE definition of a list door's
 * gate: the org-root arm first and unchanged, then the subject's own allow roots, then today's 403
 * if neither grants, plus the optional `?scopeObjectId=` narrowing. This file contains NO
 * authorization logic of its own and must not grow any — `graph/containment.ts`'s header records
 * what two hand-synced copies of a walk cost this codebase (a service-scoped freeze failing OPEN
 * and a service-scoped approval failing CLOSED, from one root cause), and a second copy of the GATE
 * would be that mistake one layer up. An earlier draft of this module WAS that second copy: it and
 * `list-door-scope.ts` were written in parallel by two agents in the same worktree, independently
 * reaching the same two-arm design and the same org-root-deny fix. It was deleted in favour of this
 * adapter as soon as that was found.
 *
 * What this adds is one thing only: the shape the four `listObjects` callers need.
 *
 * ------------------------------------------------------------------------------------------------
 * WHY AN ADAPTER EXISTS AT ALL — the hint parameter these four doors do not have
 * ------------------------------------------------------------------------------------------------
 * {@link readableScopeForListDoor} takes `scopeObjectRef` (the raw `?scopeObjectId=` value) and a
 * `resolveScopeObject` callback to turn it into an id. That callback is REQUIRED by its interface
 * and is documented there as "unused when `scopeObjectRef` is `undefined`".
 *
 * `?scopeObjectId=` exists today on `PlacementListQuerySchema` and `CampaignListQuerySchema` — the
 * two schemas increment 2.5b gave the hint to. `ObjectListQuerySchema` — the querystring of all four
 * doors here (`/objects/{type}`, `/components`, `/objects/service`, and every typed registry) — does
 * NOT carry it, so `scopeObjectRef` is ALWAYS `undefined` on this path and the resolver can never be
 * called. Rather than hand-write that dead callback at four call sites, where four copies of an
 * unreachable `throw` would be four things to get wrong and four places for someone to later wire a
 * resolver that is never consulted, it is written ONCE, here, as a refusal.
 *
 * (That list is a fact about the schemas and goes stale the moment a fifth door takes the hint. The
 * load-bearing half is `ObjectListQuerySchema`, and it is checked rather than trusted: the resolver
 * below THROWS, so wiring the hint into these four doors without also writing a real resolver is a
 * loud 500 on the first request that uses it, not a silently ignored parameter.)
 *
 * ------------------------------------------------------------------------------------------------
 * WHY IT TAKES A `PermissionCheck` AND NOT THE GATE'S OWN INPUT SHAPE
 * ------------------------------------------------------------------------------------------------
 * Each door builds ONE `PermissionCheck` literal and uses it for nothing else — it is what the
 * gate's wide arm runs. Keeping the `permission` and the org-root `scopeObjectId` in a single
 * literal at the door is deliberate on two counts:
 *
 *   - the permission the door authorizes with and the permission its row filter is computed from
 *     are then the SAME expression, not two that must be edited together. The typed-registry
 *     factory's per-resource `readPermission` makes that a live concern, not a hypothetical one;
 *   - `routes/org-root-scope-census.test.ts` anchors on a `scopeObjectId` ASSIGNMENT and resolves
 *     the permission out of the enclosing object literal. Keeping the literal in the route keeps
 *     each of these four doors individually listed and individually justified in that census
 *     instead of collapsing them into the shared entry — including
 *     `services/objects-service.ts`'s, the one a `routes/*.ts` census cannot see at all (§8.1).
 *
 * The `scopeObjectId` on that literal MUST be the org root, and this refuses otherwise rather than
 * trusting it, because the failure would be silent: the gate's `null` return means "no filter, list
 * the whole org", and that is only a sound conclusion when the arm which licensed it was checked at
 * the org root.
 */
export async function authorizeListAndScope(
  tx: TenantTx,
  orgRootCheck: PermissionCheck
): Promise<SQL | null> {
  if (orgRootCheck.scopeObjectId !== orgRootCheck.orgId) {
    throw new Error(
      `authorizeListAndScope requires an ORG-ROOT check; got scopeObjectId '${orgRootCheck.scopeObjectId}' for org '${orgRootCheck.orgId}'`
    );
  }

  return readableScopeForListDoor(tx, {
    orgId: orgRootCheck.orgId,
    subjectObjectId: orgRootCheck.subjectObjectId,
    permission: orgRootCheck.permission,
    scopeObjectRef: undefined,
    // Unreachable by construction: `scopeObjectRef` is `undefined` immediately above, and
    // `readableScopeForListDoor` consults this only after finding a defined one. A bug report, not
    // a fallback — and if these four doors ever DO accept `?scopeObjectId=`, this must become a
    // real resolver that 404s an id naming nothing, never a raw pass-through: authorizing at an
    // unresolved uuid turns every 404 on the route into a 403 for everybody, org-root Owner
    // included (role-model.md §8.7).
    resolveScopeObject: () => {
      throw new Error(
        "unreachable: the listObjects list doors accept no ?scopeObjectId= — ObjectListQuerySchema does not carry it"
      );
    }
  });
}
