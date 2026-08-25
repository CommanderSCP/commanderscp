import type { TenantTx } from "../db/tenant-tx.js";
import { forbidden } from "../errors.js";
import { hasPermission } from "../authz/resolve.js";
import { resolveCampaignDeadline } from "../coordination/campaign-deadline-lock.js";

/**
 * ================================================================================================
 * OWNER RULING 2026-08-25 (decision D1, option b-i) — WIDENING A CAMPAIGN'S DEADLINE, AT THE REPO
 * ================================================================================================
 * A write that RELEASES targets a campaign's deadline was withholding fan-out from costs the
 * Owner-only `campaign:deadline-override` (drizzle/0088) ON TOP OF the `object:write` the writing
 * door already demanded. Setting a first deadline and shortening an existing one are TIGHTENINGS and
 * stay where they were.
 *
 * ================================================================================================
 * WHY THIS IS INSTALLED AT `graph/objects-repo.ts` AND NOT ONLY AT `routes/campaigns.ts`
 * ================================================================================================
 * The ruling was first implemented at `POST /api/v1/campaigns/{id}/deadline` and nowhere else, and
 * `governance/campaign-recipe-guard.ts`'s own census — written for the SAME property, one milestone
 * earlier — says in as many words why that is not enough: `campaign.properties` has THREE write
 * doors and a route-level guard is invisible to two of them.
 *
 *   1. `POST /api/v1/campaigns/{id}/deadline` -> `coordination/campaign-repo.ts::setCampaignDeadline`
 *      -> `updateObject`. The one door the route-level check can see.
 *   2. **IaC apply** -> `iac/plans-repo.ts`'s `executePlanDiff` -> `updateObject` DIRECTLY, with a
 *      free-form `typeId` and free-form `properties`. `iac/plan-diff.ts` diffs `properties`
 *      WHOLESALE and `executePlanDiff` replaces it wholesale, so a manifest naming the campaign's
 *      urn with `typeId: "campaign"` and `deadline` omitted (or moved to 2099) produced EXACTLY the
 *      effect the route now refuses, at EXACTLY the permission it was raised above —
 *      `writePermissionFor("campaign")` is plain `object:write`, and the update branch's only other
 *      campaign check is `assertCampaignTargetsWithinAuthority`, which never reads `deadline`.
 *      MEASURED on the pre-guard tree through the HTTP API, not reasoned about:
 *      `iac/iac-campaign-deadline-widening.integration.test.ts` is the case, and deleting the call
 *      to this function turns it back into a 200 with the deadline gone.
 *   3. **Federation import** -> `federation/import-repo.ts` and its operator-facing twin
 *      `federation/handfill-repo.ts`. EXEMPT — see below.
 *
 * The generic `/objects/{type}` route is NOT a fourth door: `coordination/campaign-scope-authz.ts`
 * refuses `campaign` on every write verb there. `upsertObjectByUrn` reaches `updateObject` for every
 * ordinary update, so it is covered by the same call.
 *
 * ================================================================================================
 * THE `federationImport` EXEMPTION — TAKEN THE SAME WAY ITS NEIGHBOURS TAKE IT
 * ================================================================================================
 * This function is called from inside `updateObject`'s existing `if (!input.federationImport)`
 * block, so the exemption is the block's, not a private one. That is deliberate:
 * `federation/import-repo.ts`'s `object_upsert` branch has NO try/catch, so ONE throw on that path
 * aborts a whole signed bundle and wedges the channel until an operator intervenes. A permission
 * refusal is the worst possible thing to put there — the importing instance has no role bindings for
 * the EXPORTING domain's operator, so every imported campaign whose deadline moved later would wedge.
 * A receiving domain also has no standing to referee an authority decision the AUTHORING instance
 * already made; this is an authoring-time refusal by construction.
 *
 * HAND-FILL (`federation/handfill-repo.ts`) IS THE OTHER `federationImport` SUPPLIER, and unlike the
 * recipe/label guards it needs no separate closing call here. Checked rather than assumed:
 * `handFillObject` passes `federationImport: { originDomainId: peer.id, ... }` — a FOREIGN domain's
 * id — so `updateObject`'s single-writer check refuses outright (409) any attempt to hand-fill over a
 * LOCALLY authored campaign, which is every campaign this instance's own operators can create or
 * whose deadline this instance's reconciler enforces. What hand-fill CAN write is a shadow replica of
 * a peer-authored campaign, and a replica's deadline is the authoring domain's business and is not
 * locally mutable at all. So door 3 carries no local-actor bypass of this ruling.
 *
 * ================================================================================================
 * THE UPDATE HALF ONLY, AND THAT IS THE WHOLE RULING
 * ================================================================================================
 * There is no create-side call, because a create is ALWAYS a first set — the ruling's own words —
 * and there is no stored instant for a create to widen. `POST /campaigns` may therefore author a
 * deadlined campaign at `object:write`, exactly as `packages/schemas/src/campaigns.ts`'s
 * `CreateCampaignRequestSchema` says it may.
 *
 * DELETING THE CAMPAIGN IS NOT WIDENING AND IS NOT COVERED. Removing the campaign removes its
 * targets, its member changes and the record along with the deadline; it is a different act with a
 * different blast radius, governed by the delete door's own `object:write`, and folding it in here
 * would make "clear the deadline" more expensive than "destroy the whole governance record", which
 * is the inversion this ruling exists to remove rather than a new instance of it.
 *
 * ================================================================================================
 * THIS IS A DELTA OVER THE STORED ROW, NOT THE ROUTE'S FLAT RULE — AND THE DIFFERENCE IS DELIBERATE
 * ================================================================================================
 * `routes/campaigns.ts`'s `widensCampaignDeadline` treats a CLEAR as escalated unconditionally, even
 * over a campaign with no readable deadline, so that the status code cannot leak what is currently
 * stored and so an operator has one rule to remember. That flat rule is wrong HERE and would be a
 * catastrophe: an IaC manifest for a campaign that never had a deadline omits the key on EVERY
 * apply, so a flat rule would demand an Owner for every routine re-apply of every deadline-less
 * campaign in the estate.
 *
 * So this asks the narrower question — *does this write release targets that were actually being
 * withheld right now?* — which makes it a STRICT SUBSET of the route's rule. It can therefore never
 * refuse a request the route admits, and the route's own check stays in place as the door that
 * produces the Decision, the audit event and the better error. Belt and braces, in that order.
 *
 * ================================================================================================
 * WHAT COUNTS AS A WIDENING HERE
 * ================================================================================================
 *  * Nothing readable was stored (`none` or `malformed`) => NOT a widening, whatever arrives.
 *    Nothing was being withheld, so nothing can be released. `campaign-reconcile.ts` fails OPEN on a
 *    document it cannot parse, so replacing a malformed bag excuses nobody.
 *  * A readable deadline is REMOVED => widening. This is the IaC bypass in its plainest form.
 *  * A readable deadline is replaced by an UNREADABLE document => widening, and this is the half a
 *    naive "is the key still there?" test misses. `resolveCampaignDeadline` reports `malformed`, the
 *    reconciler fails open on it, and the lock stops — indistinguishable in effect from a clear, so
 *    it is priced like one. Fail-closed in the one direction where the read-time predicate is
 *    deliberately fail-open.
 *  * A readable deadline MOVES LATER => widening. Gating only the removal would leave the move as the
 *    next bypass: "drop the key" becomes "set it to 2099".
 *  * EQUAL OR EARLIER => not a widening. Compared on parsed INSTANTS, never on the ISO strings: the
 *    two renderings that actually occur differ in their milliseconds (`...T00:00:00Z` vs
 *    `...T00:00:00.000Z`, both accepted by `z.string().datetime()`) and they sort the WRONG WAY as
 *    strings, so a string compare would read an unchanged deadline as a slip and demand an Owner for
 *    a no-op re-apply.
 *  * `overrides[]` ARE NOT READ. A per-target waiver is minted by
 *    `POST /campaigns/{id}/deadline-override`, which already demands this exact permission at this
 *    exact scope; re-deciding it from the stored delta would double-charge that route and, worse,
 *    would make an IaC re-apply that merely round-trips existing waivers an escalated act.
 *
 * ================================================================================================
 * NO DECISION AND NO AUDIT EVENT FROM HERE — STATED RATHER THAN LEFT TO BE DISCOVERED
 * ================================================================================================
 * A refusal here is a bare 403, like every other refusal at this choke point. The explainable record
 * — Decision with the previous value, `loosening` label, `campaign.deadline.set` audit event — is the
 * ROUTE's, and it is written only on the route's own successful writes. That is the same division of
 * labour `assertMayWriteGovernanceLabels` and `assertPolicyScopeWithinAuthority` already use: the
 * choke point makes the state unreachable, the door explains it.
 */
export async function assertMayWidenCampaignDeadline(
  tx: TenantTx,
  args: {
    orgId: string;
    actorObjectId: string;
    typeId: string;
    /** The campaign row's own id — the scope the permission is resolved at, matching the route. */
    subjectObjectId: string;
    /** The STORED properties (`existing.properties`), i.e. what is being enforced right now. */
    before: Record<string, unknown> | null | undefined;
    /** The properties about to be STORED (`nextProperties`), never `input.properties` — a PATCH
     *  that omits the key must be judged on the document that will exist, not on the request. */
    after: Record<string, unknown>;
  }
): Promise<void> {
  // Only a `campaign` carries a deadline this ruling is about. A `deadline` key on any other type is
  // read by nothing (`campaign-reconcile.ts` resolves it off the campaign object alone), so refusing
  // it here would reject documents that mean nothing rather than documents that mean the wrong thing
  // — `campaign-recipe-guard.ts`'s reasoning, verbatim, for the same reason.
  if (args.typeId !== "campaign") return;

  const stored = resolveCampaignDeadline(args.before);
  // NOTHING IS BEING WITHHELD, so nothing can be released. Also the overwhelmingly common case — a
  // campaign without a deadline — and the reason this returns before resolving any permission.
  if (stored.outcome !== "deadline") return;

  const incoming = resolveCampaignDeadline(args.after);
  if (incoming.outcome === "deadline" && incoming.at.getTime() <= stored.at.getTime()) return;

  const ok = await hasPermission(tx, {
    orgId: args.orgId,
    subjectObjectId: args.actorObjectId,
    permission: "campaign:deadline-override",
    // AT THE CAMPAIGN, matching the route and `POST /campaigns/{id}/deadline-override`. Not the org
    // root: `hasPermission` expands the checked scope UPWARD anyway, so this admits everyone an
    // org-root check would AND an Owner bound at the campaign's own containment domain. Not the
    // targets: a target-scoped check would hand one laggard's owner the power to release the whole
    // campaign.
    scopeObjectId: args.subjectObjectId
  });
  if (ok) return;

  const what =
    incoming.outcome === "none"
      ? "removes the deadline"
      : incoming.outcome === "malformed"
        ? `replaces the deadline with a document no reader can parse (${incoming.detail}), which withholds nothing`
        : `moves the deadline later, from '${stored.deadline.at}' to '${incoming.deadline.at}'`;

  throw forbidden(
    `this write ${what}, which releases every target this campaign was withholding its changes ` +
      `from — that requires 'campaign:deadline-override' at the campaign (Owner-only, ` +
      `drizzle/0088) on top of the write permission this door already required. Clearing a ` +
      `deadline is a strict superset of waiving it for one target, and waiving one target takes ` +
      `that permission, so clearing it cannot cost less. Setting a first deadline and SHORTENING ` +
      `an existing one are unaffected. To move or clear it with a recorded reason and the previous ` +
      `value on the audit chain, use POST /api/v1/campaigns/{id}/deadline; to excuse named targets ` +
      `without releasing the rest, use POST /api/v1/campaigns/{id}/deadline-override.`
  );
}
