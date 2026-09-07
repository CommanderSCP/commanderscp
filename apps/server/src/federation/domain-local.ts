import { authorize } from "../authz/resolve.js";
import type { TenantTx } from "../db/tenant-tx.js";

/** The rule for declaring that an object never federates. See docs/federation.md §113. */
export async function assertMayDeclareDomainLocal(
  tx: TenantTx,
  input: {
    orgId: string;
    subjectObjectId: string;
    scopeObjectId: string;
    /** The request body's `domainLocal`, verbatim — `undefined` and `false` both no-op. */
    requested: boolean | undefined;
  }
): Promise<void> {
  if (input.requested !== true) return;
  await authorize(tx, {
    orgId: input.orgId,
    subjectObjectId: input.subjectObjectId,
    permission: "federation:write",
    scopeObjectId: input.scopeObjectId
  });
}
