import { SCAN_OVERRIDE_GRANT_TYPE_ID } from "@scp/schemas";
import { badRequest } from "../errors.js";

/** A grant may be raised through any door, and what that costs. See docs/governance.md §347. */

/** The five properties that constitute a DECISION on a grant. Named once so the guard, the route and
 *  any future reader cannot drift about which fields the arbitration owns. */
export const SCAN_OVERRIDE_GRANT_DECISION_PROPERTIES = [
  "status",
  "expiresAt",
  "decidedByActorId",
  "decidedAt",
  "decisionReason"
] as const;

/**
 * The internal bypass. Present on `CreateObjectInput`/`UpdateObjectInput` and set by exactly one
 * caller; it is not part of any wire schema, so it cannot arrive in a request body.
 */
export interface ScanOverrideGrantDecisionWrite {
  /** Set ONLY by `routes/scan-override-grants.ts`'s `decide` helper, after it has run the derived-tier
   *  authority check and inside the transaction that also writes the Decision and the audit event. */
  scanOverrideGrantDecision?: boolean;
}

export function assertScanOverrideGrantNotSelfDecided(args: {
  typeId: string;
  properties: Record<string, unknown>;
  /** `true` on the one path that IS the arbitration. */
  isDecisionWrite?: boolean | undefined;
}): void {
  if (args.typeId !== SCAN_OVERRIDE_GRANT_TYPE_ID) return;
  if (args.isDecisionWrite) return;

  const status = args.properties.status;
  if (status !== undefined && status !== "requested") {
    throw badRequest(
      `a scan override grant may only be written as 'requested' through this door — ` +
        `'${String(status)}' is a DECISION, and a decision is made by ` +
        `POST /api/v1/scan-override-grants/{id}/approve|deny|revoke and nowhere else. That route is ` +
        `the only path that checks 'policy:write' at the tier that SET the rule being waived ` +
        `(ADR-0033 D3), validates the expiry is in the future (D4), and writes the Decision and the ` +
        `hash-chained audit event an accepted risk is supposed to leave behind.`
    );
  }
  const offending = SCAN_OVERRIDE_GRANT_DECISION_PROPERTIES.filter(
    (key) => key !== "status" && args.properties[key] !== undefined
  );
  if (offending.length > 0) {
    throw badRequest(
      `a scan override grant written through this door must carry no decision fields — ` +
        `'${offending.join("', '")}' ${offending.length === 1 ? "is" : "are"} set by the ` +
        `approve/deny/revoke route, in the same transaction as the Decision and the audit event ` +
        `that explain it (ADR-0033 §6a). An 'expiresAt' with no approval is a window nobody opened.`
    );
  }
}
