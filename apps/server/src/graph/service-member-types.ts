/**
 * Object types that MUST belong to a service (M12 P5a) — a `component` is created only through the
 * strict `POST /components` route (which requires a service and writes the `contains` edge atomically),
 * never through a generic/side-door path. The single source of truth so every guard agrees: the
 * generic `/objects/{type}` route (`routes/objects-generic.ts`) and the federation overlay route
 * (`federation/overlay-repo.ts`, M12 P5 follow-up) both refuse these types.
 *
 * Imports stay permissive by a DIFFERENT mechanism: `discovery/accept` and federation-journal replay
 * call `createObject` directly (server-side, never these routes), so an imported component may be an
 * orphan until organized. Overlay is NOT such an import path — it's a user-facing create surface — so
 * it is guarded here too.
 */
export const SERVICE_MEMBER_OBJECT_TYPE_IDS: ReadonlySet<string> = new Set(["component"]);

export function isServiceMemberObjectType(type: string): boolean {
  return SERVICE_MEMBER_OBJECT_TYPE_IDS.has(type);
}
