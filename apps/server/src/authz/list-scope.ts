import type { SQL } from "drizzle-orm";
import type { TenantTx } from "../db/tenant-tx.js";
import type { PermissionCheck } from "./resolve.js";
import { readableScopeForListDoor } from "./list-door-scope.js";

/** THE `listObjects` LIST DOORS' ADAPTER onto the one list-door gate. See docs/authz.md §22. */
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
    // Unreachable by construction. See docs/authz.md §23.
    resolveScopeObject: () => {
      throw new Error(
        "unreachable: the listObjects list doors accept no ?scopeObjectId= — ObjectListQuerySchema does not carry it"
      );
    }
  });
}
