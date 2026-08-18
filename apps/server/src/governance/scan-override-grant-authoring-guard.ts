import { SCAN_OVERRIDE_GRANT_TYPE_ID } from "@scp/schemas";
import { badRequest } from "../errors.js";

/**
 * M22.6 (ADR-0033 §6a; owner decisions D3, D4) — A GRANT MAY BE *RAISED* THROUGH ANY WRITE DOOR;
 * IT MAY ONLY BE *DECIDED* THROUGH THE ONE THAT ARBITRATES IT.
 *
 * ================================================================================================
 * THE HOLE THIS CLOSES — A SECOND DOOR STRAIGHT TO THE REPO LAYER
 * ================================================================================================
 * `scan_override_grant` is in `GOVERNANCE_MANAGED_OBJECT_TYPE_IDS`, and the previous version of this
 * feature relied on that alone. The set buys exactly two things: the generic `/objects/{type}`
 * endpoint refuses the type outright, and `iac/plans-repo.ts` demands `policy:write` at the target
 * domain instead of `object:write`. The routes' own docblock then reasoned "without that, a holder of
 * plain `object:write` could write `{status: "approved", expiresAt: "2099-…"}` directly" — true, and
 * not the whole shape. A holder of `policy:write` at a CONTAINMENT DOMAIN — an ordinary scoped
 * policy-author binding — could submit an IaC manifest creating exactly that document and
 * `POST /plans/{id}/apply` it. `drizzle/0075`'s `property_schema` is typed-but-OPEN (it must be:
 * `import-repo.ts` Ajv-validates with no try/catch and one rejection aborts a peer's whole signed
 * bundle), so it accepts `status: "approved"` and a free-string `expiresAt`. The result was an
 * already-approved grant with NO tier check on the rule being waived, NO Decision, NO hash-chained
 * audit event and NO future-expiry validation — every guarantee of the override design, routed around.
 *
 * The permission mapping was never the defence. The defence is that the DECISION FIELDS are writable
 * only by the act that decides, and that has to be enforced where the data lands.
 *
 * ================================================================================================
 * WHY THE CHOKE POINT AND NOT THE ROUTE — THE STANDING LESSON IN THIS REPO
 * ================================================================================================
 * `graph/objects-repo.ts`'s `createObject`/`updateObject` are the one place every LOCAL write door
 * funnels through. A filterless census of doors reaching them with a free-form `typeId` and free-form
 * `properties` finds: the generic `/objects/{type}` routes, `POST /plans` + `/plans/{id}/apply`,
 * `POST /federation/hand-fill`, `POST /federation/overlays`, the typed registries and
 * `services/objects-service.ts`. Installing at any one of them rebuilds the same rake for the next.
 * This is the fourth guard to be installed at that choke point for exactly this reason
 * (`component-declaration-guard.ts`, `subscription-authoring-guard.ts`, `scan-rule-authoring-guard.ts`
 * are the other three), and PR #249's five recorders and PR #256's discovery/accept finding are the
 * two prior instances of the same class in this tree.
 *
 * ================================================================================================
 * WHAT IS REFUSED, AND WHY `requested` IS STILL ALLOWED THROUGH
 * ================================================================================================
 * Refused: `status` present and anything other than `requested`, and any of `expiresAt`,
 * `decidedByActorId`, `decidedAt`, `decisionReason`. Those five fields ARE the decision — the
 * resolver's live-grant window reads `status = 'approved'` AND `expiresAt > now()`, and the other
 * three are the audit attribution.
 *
 * A `requested` grant is deliberately NOT refused at any door. It authorizes nothing (the resolver
 * requires `approved`), it is exactly the record ADR-0033 wants raised early and often, and refusing
 * it would make an IaC-managed stack unable to even declare the request it wants a human to decide.
 *
 * The check is on the value about to be STORED. `updateObject` REPLACES `properties`, so a document
 * that omits `status` entirely de-approves rather than preserves — safe in the tightening direction,
 * and still refused if it carries `expiresAt`, because a decision field with no decision is a row a
 * later reader cannot explain.
 *
 * ================================================================================================
 * THE TWO EXEMPTIONS, EACH AS NARROW AS IT LOOKS
 * ================================================================================================
 *  1. `federationImport` (the choke point's existing `if (!input.federationImport)` block). NOT
 *     because imported data is trusted: `import-repo.ts`'s `object_upsert` branch has NO try/catch,
 *     so a throw aborts a peer's ENTIRE signed bundle and wedges the channel. D9 makes grants federate
 *     FULLY, so an approved grant legitimately arrives over the journal; it was decided at its
 *     AUTHORING instance, where this guard ran, and M6 single-writer authority means only that
 *     instance's domain can ever revise it. The exemption is closed at the OTHER `federationImport`
 *     supplier — `federation/handfill-repo.ts` calls this guard explicitly, because hand-fill is a
 *     LOCAL operator action wearing the import flag with no bundle to wedge.
 *  2. {@link ScanOverrideGrantDecisionWrite} — the internal flag `routes/scan-override-grants.ts`'s
 *     `decide` helper sets on its `updateObject` call. It is a TypeScript-only field on the repo
 *     input: no request body reaches it, and no other module sets it. That helper is the only code
 *     path that performs the `policy:write`-at-the-derived-tier check, the future-expiry validation,
 *     the Decision and the hash-chained audit event — which is precisely the list of things this
 *     guard exists to make unskippable.
 */

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
