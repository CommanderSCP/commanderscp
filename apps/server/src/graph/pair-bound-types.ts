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
 * This mirrors `service-member-types.ts` exactly, including which surfaces consult it: the generic
 * `/objects/{type}` route (`routes/objects-generic.ts`) and the federation overlay route
 * (`federation/overlay-repo.ts`) — both user-facing create surfaces. It is a SEPARATE set from
 * `SERVICE_MEMBER_OBJECT_TYPE_IDS` on purpose: that set's reason is service MEMBERSHIP, this one's
 * is pair IDENTITY, and merging them would produce a guard whose comment lies about why it fires.
 *
 * TRUE import paths stay permissive by the same mechanism as everything else — `discovery/accept`
 * and federation-journal replay call `createObject` directly and never touch a create ROUTE. A
 * journal replica arrives with its edges as their own `relationship_upsert` entries, so replication
 * reproduces both halves without going through the typed route.
 */
export const PAIR_BOUND_OBJECT_TYPE_IDS: ReadonlySet<string> = new Set(["placement"]);

export function isPairBoundObjectType(type: string): boolean {
  return PAIR_BOUND_OBJECT_TYPE_IDS.has(type);
}
