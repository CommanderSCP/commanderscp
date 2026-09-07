import { hasPermission } from "../authz/resolve.js";
import type { TenantTx } from "../db/tenant-tx.js";
import { forbidden } from "../errors.js";

/** Un-declaring a region is an authority act. See docs/coordination.md §826. */

/** The two properties the M15.6 gate reads to decide whether it applies. Kept as one exported list
 *  so this guard and `regional-executors.ts` can never key on different names — a key that is
 *  reserved for the WRITE check and a different key for the MATCH would be the evasion, rebuilt
 *  inside the guard. */
export const REGION_MEMBERSHIP_KEYS = ["environment", "region"] as const;

/** Read one property exactly as PostgreSQL's operator does. See docs/coordination.md §827. */
function jsonTextValue(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return typeof value === "string" ? value : JSON.stringify(value);
}

/**
 * Does this properties bag DECLARE multi-region membership — the exact predicate
 * `readDeclaredRegionMembership` applies (both keys present and non-blank after trimming)?
 */
export function declaresRegionMembership(properties: Record<string, unknown> | null): boolean {
  if (!properties) return false;
  return REGION_MEMBERSHIP_KEYS.every(
    (key) => (jsonTextValue(properties[key]) ?? "").trim().length > 0
  );
}

/** Which of the two keys this write blanks or removes, sorted — the operator-facing half of the
 *  refusal, so the message names the property that was actually withdrawn rather than the pair. */
function withdrawnKeys(
  before: Record<string, unknown>,
  after: Record<string, unknown> | null
): string[] {
  if (after === null) return [...REGION_MEMBERSHIP_KEYS];
  return REGION_MEMBERSHIP_KEYS.filter((key) => {
    const had = (jsonTextValue(before[key]) ?? "").trim().length > 0;
    const has = (jsonTextValue(after[key]) ?? "").trim().length > 0;
    return had && !has;
  });
}

export interface UndeclareRegionCheck {
  orgId: string;
  actorObjectId: string;
  typeId: string;
  objectId: string;
  before: Record<string, unknown> | null;
  /** The properties about to be stored, or `null` when the row is being (soft-)deleted. */
  after: Record<string, unknown> | null;
}

/** Refuse a write that takes a target out of the region set. See docs/coordination.md §828. */
export async function assertMayUndeclareRegionMembership(
  tx: TenantTx,
  check: UndeclareRegionCheck
): Promise<void> {
  if (check.typeId !== "deployment-target") return;
  // Nothing to withdraw: the row is not currently a declared region target. Note the direction —
  // this reads BEFORE, so ADDING a declaration is free, and only losing one is gated.
  if (!declaresRegionMembership(check.before)) return;
  // Still a declared region target afterwards (a rename, a property added beside them, a `PATCH`
  // that touched only `name`) — the gate still applies to it, so there is nothing to authorize.
  if (check.after !== null && declaresRegionMembership(check.after)) return;

  const allowed = await hasPermission(tx, {
    orgId: check.orgId,
    subjectObjectId: check.actorObjectId,
    permission: "object:write",
    // The ORG ROOT object's id IS the org id (`auth/local-auth.ts`'s `ensureOrgRootObject` creates it
    // with `id: orgId`), which is the same scope `getRegionalExecutors` reads the set at.
    scopeObjectId: check.orgId
  });
  if (allowed) return;

  const withdrawn = withdrawnKeys(check.before ?? {}, check.after);
  const act =
    check.after === null
      ? `deleting deployment-target '${check.objectId}'`
      : `removing ${withdrawn.map((k) => `'properties.${k}'`).join(" and ")} from deployment-target '${check.objectId}'`;
  throw forbidden(
    `${act} would withdraw it from its multi-region environment, which turns OFF the M15.6 ` +
      `no-silent-deploy gate for it (ADR-0017 §3): an unbound region target that stops declaring ` +
      `its region is dispatched against the shared default executor instead of being refused. ` +
      `Un-declaring a region requires 'object:write' at the org root — the same org-root bar ` +
      `GET /environments/{environment}/regional-executors takes to read the set. Declaring a ` +
      `region, and every other write on this target, is unchanged.`
  );
}
