import type { SQL } from "drizzle-orm";
import type { TenantTx } from "../db/tenant-tx.js";
import { forbidden } from "../errors.js";
import { authorize, hasPermission, type Permission } from "./resolve.js";
import {
  partitionReadableRoots,
  readableObjectFilterSql,
  readableRootsFor
} from "./readable-scope.js";

/** THE LIST DOOR'S GATE. See docs/authz.md §17. */

export interface ListDoorScopeInput {
  orgId: string;
  subjectObjectId: string;
  /** The permission the door demands — `object:read` on every current caller, but the typed
   *  registries carry a per-resource `readPermission`, so it is a parameter. */
  permission: Permission;
  /** The raw `?scopeObjectId=` value, or `undefined` when the caller did not narrow. */
  scopeObjectRef?: string | undefined;
  /** Resolves the scope ref to an id, 404 when it names nothing. See docs/authz.md §18. */
  resolveScopeObject: (ref: string) => Promise<string>;
}

/** The row filter a list repo should apply. See docs/authz.md §19. */
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
      // Org root allowed yet refused can only mean a deny outranked. See docs/authz.md §20.
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

/** Today's 403, re-run so its wording can never drift. See docs/authz.md §21. */
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
