/** Object types the governance subsystem owns end to end. See docs/governance.md §152. */
export const GOVERNANCE_MANAGED_OBJECT_TYPE_IDS: ReadonlySet<string> = new Set([
  "policy",
  "control",
  /** A grant is a standing, expiring authorization. See docs/governance.md §153. */
  "scan_override_grant",
  /** A freeze object is the wire form of a freeze row. See docs/governance.md §154. */
  "freeze"
]);

export function isGovernanceManagedObjectType(typeId: string): boolean {
  return GOVERNANCE_MANAGED_OBJECT_TYPE_IDS.has(typeId);
}

/** TYPES WHOSE GRAPH OBJECT IS ONLY HALF THE RECORD. See docs/governance.md §155. */
export const PROJECTION_BOUND_OBJECT_TYPE_IDS: ReadonlySet<string> = new Set(["freeze"]);

export function isProjectionBoundObjectType(typeId: string): boolean {
  return PROJECTION_BOUND_OBJECT_TYPE_IDS.has(typeId);
}

/** The one sentence every door's refusal says, so three doors cannot drift into three different
 *  explanations of one rule. `door` names the caller's own route so the message routes them
 *  somewhere real. */
export function projectionBoundRefusalDetail(typeId: string, door: string): string {
  return (
    `object type '${typeId}' is projection-backed: its graph object is only the WIRE half of the ` +
    `record, and ${door} cannot write the enforcement row that goes with it — a '${typeId}' minted ` +
    `here would federate and block at every peer while not existing at this instance, and could ` +
    `then be lifted at neither end. Use /api/v1/${typeId}s, which writes both halves in one ` +
    `transaction and enforces '${typeId}:write' at the declared scope plus 'federation:write' to ` +
    `federate it.`
  );
}
