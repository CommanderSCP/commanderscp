/**
 * Object types whose identity IS a pair of other objects, and which therefore cannot be created
 * through any door that takes free-form `properties` (ADR-0026 D2/D3, owner decision D17).
 *
 * A `placement` is one component at one deployment-target. Three things must happen together for it
 * to be well-formed, and only a typed route that takes both endpoints can do them:
 *
 *   1. each ref is resolved and TYPE-CHECKED (a placement whose "component" is a service is
 *      meaningless, and the generic route would happily store the UUID);
 *   2. the two DERIVED edges (`places`, `placed_at`) are written in the SAME transaction, without
 *      which the placement is an island invisible to every traversal and impact query;
 *   3. the URN is built from both endpoints rather than from a single free-text name.
 *
 * Migration 0051's `required: [componentId, deploymentTargetId]` catches (1)'s absence at every
 * write door, but it cannot catch a well-formed-looking pair of UUIDs pointing at the wrong types,
 * and it cannot write edges. Hence the refusal.
 *
 * This mirrors `service-member-types.ts` exactly. FOUR surfaces consult it, and the list is the
 * point — it was wrong twice, in the same way, and both misses were user-facing write doors that
 * reach `createObject` WITHOUT passing through a create route:
 *
 *   - the generic `/objects/{type}` route (`routes/objects-generic.ts`)
 *   - the federation overlay route (`federation/overlay-repo.ts`)
 *   - IaC plan/apply (`iac/plans-repo.ts`) — added 2026-08-03 after a manifest declaring
 *     `typeId: "placement"` was PROVEN to apply cleanly and write an edgeless island
 *   - discovery accept (`routes/executors.ts`) — added at the same time; see the note below
 *
 * BEFORE ADDING A FIFTH DOOR, RE-RUN THE CENSUS: `grep -rn "createObject(" apps/server/src` and ask
 * of each caller whether its `typeId` is FIXED (safe — it cannot name a pair-bound type) or
 * CALLER-SUPPLIED (must guard). That question, not the list, is what makes the set complete. It is a SEPARATE set from
 * `SERVICE_MEMBER_OBJECT_TYPE_IDS` on purpose: that set's reason is service MEMBERSHIP, this one's
 * is pair IDENTITY, and merging them would produce a guard whose comment lies about why it fires.
 *
 * TRUE import paths stay permissive: federation-journal replay calls `createObject` directly and
 * never touches a create ROUTE, and a replica arrives with its edges as their own
 * `relationship_upsert` entries, so replication reproduces both halves.
 *
 * `discovery/accept` USED TO BE CLASSED HERE AND SHOULD NOT HAVE BEEN. It takes its proposal from
 * the REQUEST BODY, so a client can hand-write one that never came from a plugin run — which makes
 * it a user-facing create door wearing an import path's clothes. Measured 2026-08-03: a hand-written
 * proposal returned 201 and created a placement with no derived edges. It now refuses. The
 * distinction that matters is not "is it called an import path" but "can a caller choose the
 * typeId, and can this path write the derived edges?" — accept fails the second test either way.
 */
export const PAIR_BOUND_OBJECT_TYPE_IDS: ReadonlySet<string> = new Set(["placement"]);

export function isPairBoundObjectType(type: string): boolean {
  return PAIR_BOUND_OBJECT_TYPE_IDS.has(type);
}
