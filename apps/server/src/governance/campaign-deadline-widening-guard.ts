import type { CampaignDeadlineOverride } from "@scp/schemas";
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
 * THAT HOLDS FOR `overrides[]` TOO, and it is worth spelling out because the create door IS
 * free-form on the IaC path and CAN therefore plant a waiver: a campaign being created never
 * withheld anything from anybody, so a `deadline` authored WITH waivers releases exactly the same
 * set as no deadline at all — which that same actor could author at that same permission by simply
 * omitting the key. It is not an escalation, so it is not refused. What it can do is plant a waiver
 * attributed to someone who never granted it, which is the attribution residue named below, not a
 * release.
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
 * So on the INSTANT this asks the narrower question — *does this write release targets that were
 * actually being withheld right now?* — which makes it, on that key alone, a strict subset of the
 * route's rule.
 *
 * ON `overrides[]` IT IS NOT A SUBSET OF ANYTHING THAT ROUTE DOES, and the two must not be conflated
 * (round 3): `SetCampaignDeadlineRequestSchema` is strict and omits the key, so `POST
 * /campaigns/{id}/deadline` cannot express a waiver at all and has no rule about one — the delta
 * below is this function's own, covering a free-form door that route has no view of.
 *
 * WHAT HOLDS ACROSS BOTH KEYS is the property that actually matters: THIS CAN NEVER REFUSE A REQUEST
 * A ROUTE ADMITS. `POST /campaigns/{id}/deadline` cannot carry `overrides` (400) and
 * `setCampaignDeadline` carries the stored ones forward verbatim, so its delta is empty; and `POST
 * /campaigns/{id}/deadline-override`, whose delta is non-empty by construction, resolved this exact
 * permission at this exact campaign one frame earlier. The routes' own checks stay in place as the
 * doors that produce the Decision, the audit events and the better errors. Belt and braces, in that
 * order.
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
 *  * `overrides[]` ARE READ, AS A DELTA — and this bullet is the correction of a claim this block
 *    used to make in exactly the opposite direction. It said a per-target waiver could only be
 *    minted by `POST /campaigns/{id}/deadline-override`, which already demands this exact permission
 *    at this exact scope, so there was nothing here to decide.
 *
 *    THAT WAS FALSE AT THE VERY DOOR THIS FUNCTION EXISTS TO CLOSE, and the refutation was MEASURED
 *    through the HTTP API rather than reasoned about. The `campaign` type's `property_schema` is
 *    `{"type":"object"}` (`drizzle/0002_rls_rbac_seed.sql`), so `validateProperties` accepts an
 *    arbitrary `deadline` document out of a manifest; `iac/plan-diff.ts` diffs `properties`
 *    WHOLESALE and `executePlanDiff` replaces it wholesale. So an Operator who keeps `at`
 *    BYTE-IDENTICAL — the instant test above therefore sees no widening whatever and returns —
 *    while adding a fully-formed `overrides` entry naming their own component gets a 200, and
 *    `findEffectiveDeadlineOverride` excuses that target on the next tick. Enumerating every target
 *    reproduces a CLEAR exactly, at exactly the permission this ruling raised the act above. The
 *    census that missed it looked for the SYMPTOM (`deadline.at`) rather than for the PROPERTY:
 *    *any edit to the stored deadline document that releases a withheld target*.
 *
 *    A DELTA, and NOT a flat "an IaC write may not carry `overrides`", for the two reasons that
 *    shape every other guard at this choke point. A round-tripping re-apply restates the waivers the
 *    row already holds, so its delta is EMPTY and it stays free — IaC re-applies an unchanged
 *    manifest constantly, and a flat refusal would take IaC-managed campaigns away from everyone
 *    below Owner the moment one waiver existed. And `/deadline-override`'s OWN write reaches this
 *    function, through `updateObject`, with a delta that is non-empty BY CONSTRUCTION: it must be
 *    admitted by HOLDING the permission rather than by being excused from the question — and it is,
 *    because `routes/campaigns.ts` resolved the same permission at the same campaign object one
 *    frame earlier. The whole cost of that route not being special-cased here is one redundant
 *    `hasPermission` per minted waiver, on a route driven by a human pressing a button.
 *
 *  * REMOVING A WAIVER, or SHORTENING its `until`, IS NOT A WIDENING — the opposite of
 *    `governanceLabelDelta`, where removal is the whole attack, and the divergence is stated here
 *    because the two guards sit four lines apart in `updateObject` and a reader who assumes they
 *    agree will read this one as a bug. A governance label is a MATCH KEY: deleting it makes a
 *    constraint stop applying. A waiver is a RELEASE: deleting it puts the target back under the
 *    deadline, which withholds strictly MORE. Silently re-locking a target an Owner excused has its
 *    own hazard — it is why `setCampaignDeadline` carries waivers forward across a move — but it is
 *    a tightening, not this ruling's act, and pricing it here would demand an Owner for the routine
 *    re-apply that follows a waiver's deliberate removal.
 *
 *  * REWRITING `reason`, `actorId` or `at` ON AN EXISTING ENTRY, leaving its reach unchanged, is
 *    likewise not priced here, and that residue is named rather than left to be discovered: it
 *    releases nobody (the same target stays excused for the same window), so it is outside this
 *    ruling, but it does let a free-form-`properties` door falsify WHO excused WHOM in a permanent
 *    record. That is an attribution defect against the `campaign.deadline.override` audit event,
 *    not an authority bypass, and it wants its own decision rather than a silent widening of this
 *    one.
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
/**
 * HOW FAR EACH NAMED TARGET IS EXCUSED BY `overrides[]`, as a millisecond instant per target.
 *
 *  * `+Infinity` — an entry with NO `until`. `findEffectiveDeadlineOverride` treats that as "until
 *    the deadline is cleared or the target adopts", which is the common case and the widest reach
 *    there is.
 *  * `-Infinity` — an entry whose `until` no clock can hold. It waives nothing, so it must not read
 *    as an addition. SECOND BAR, UNREACHABLE TODAY, and said so rather than left implying it catches
 *    something: `until` is `z.string().datetime()`, so a value `Date.parse` cannot read makes
 *    `resolveCampaignDeadline` report the WHOLE document `malformed`, which the instant test above
 *    already prices as a widening. It is written this way because it falls out on the fail-closed
 *    side if that schema is ever loosened — exactly as `findEffectiveDeadlineOverride` writes its own
 *    comparison as `>= now` rather than `!(< now)` so that `NaN` lands as NOT effective.
 *
 * THE MAXIMUM ACROSS ENTRIES FOR A TARGET, never the first one. `findEffectiveDeadlineOverride` —
 * the only reader of this array — is a `.find()` whose predicate tests the target AND the expiry
 * together, so with two entries for one target it excuses that target if ANY of them is live.
 * "How far is this target excused?" is therefore the max, not the head of the list.
 * `overrideCampaignDeadline` stores at most one entry per target and sorts them, but this array also
 * arrives through IaC apply and federation import, where nothing dedupes it and
 * `CampaignDeadlineSchema` puts no uniqueness constraint on it.
 */
function waiverReachByTarget(
  overrides: CampaignDeadlineOverride[] | undefined
): Map<string, number> {
  const reach = new Map<string, number>();
  for (const override of overrides ?? []) {
    const until =
      override.until === undefined ? Number.POSITIVE_INFINITY : Date.parse(override.until);
    const value = Number.isNaN(until) ? Number.NEGATIVE_INFINITY : until;
    const prior = reach.get(override.targetObjectId);
    if (prior === undefined || value > prior) reach.set(override.targetObjectId, value);
  }
  return reach;
}

/**
 * The targets this write ADDS a waiver for, or EXTENDS an existing waiver's reach for, sorted.
 * Empty means no target is excused any further than the stored document already excused it — the
 * round-tripping re-apply, and every removal or shortening.
 *
 * ONE COMPARISON, DOCUMENT AGAINST DOCUMENT, AND NEVER AGAINST THE CLOCK. There is deliberately no
 * `now` here even though `findEffectiveDeadlineOverride` has one, because a permission verdict that
 * consults the wall clock is a verdict that changes without a write: the same manifest would be
 * refused this morning and admitted this afternoon, and an operator could not reproduce either
 * answer. The price is one over-refusal — moving an ALREADY-EXPIRED `until` to a later instant that
 * is still in the past excuses nobody, yet reads as an extension — which costs an Owner for an edit
 * on the trajectory of extending a waiver, and never admits one that releases a target.
 */
function widenedWaiverTargets(
  before: CampaignDeadlineOverride[] | undefined,
  after: CampaignDeadlineOverride[] | undefined
): string[] {
  const stored = waiverReachByTarget(before);
  const widened: string[] = [];
  for (const [targetObjectId, reach] of waiverReachByTarget(after)) {
    if (reach > (stored.get(targetObjectId) ?? Number.NEGATIVE_INFINITY)) {
      widened.push(targetObjectId);
    }
  }
  return widened.sort();
}

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

  // THE INSTANT — the WHOLE-CAMPAIGN release. `none` and `malformed` both land here: see the two
  // bullets above for why an unreadable document is priced exactly like a clear.
  const slipped = incoming.outcome !== "deadline" || incoming.at.getTime() > stored.at.getTime();

  // THE WAIVERS — the PER-TARGET release, beside the instant rather than after it, because the
  // vector this closes keeps `at` byte-identical precisely so the test above returns. Readable only
  // when the incoming document parses; when it does not, `slipped` is already true and its
  // `overrides` are unreadable to every reader there is, this one included.
  const waived =
    incoming.outcome === "deadline"
      ? widenedWaiverTargets(stored.deadline.overrides, incoming.deadline.overrides)
      : [];

  if (!slipped && waived.length === 0) return;

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

  // BOTH ACTS CAN RIDE ONE WRITE — `properties` is replaced wholesale, so a single manifest may move
  // the instant AND mint a waiver — and naming only the first would send an operator to fix the date
  // and get the same 403 back. Joined rather than collapsed to whichever was found first.
  const acts: string[] = [];
  if (incoming.outcome === "none") {
    acts.push("removes the deadline");
  } else if (incoming.outcome === "malformed") {
    acts.push(
      `replaces the deadline with a document no reader can parse (${incoming.detail}), which withholds nothing`
    );
  } else if (slipped) {
    acts.push(
      `moves the deadline later, from '${stored.deadline.at}' to '${incoming.deadline.at}'`
    );
  }
  if (waived.length > 0) {
    // NAMED, BUT BOUNDED. A waiver per target is the shape `/deadline-override` produces when
    // `targets` is omitted, so this list is as long as the campaign — and a 403 body carrying five
    // hundred uuids is not a better error than one carrying five and a count.
    const named = waived.slice(0, 5).join(", ");
    const rest = waived.length - Math.min(waived.length, 5);
    acts.push(
      `adds or extends a per-target deadline waiver for ${waived.length} ` +
        `target${waived.length === 1 ? "" : "s"} (${named}${rest > 0 ? `, +${rest} more` : ""})`
    );
  }

  throw forbidden(
    `this write ${acts.join(", and ")} — releasing targets this campaign was withholding its ` +
      `changes from. That requires 'campaign:deadline-override' at the campaign (Owner-only, ` +
      `drizzle/0088) on top of the write permission this door already required. Clearing a ` +
      `deadline is a strict superset of waiving it for one target, and waiving one target takes ` +
      `that permission, so clearing it cannot cost less — and writing the waivers straight into ` +
      `'properties.deadline.overrides' is that same waiver with the door taken off. Setting a ` +
      `first deadline, SHORTENING an existing one, and removing or shortening a waiver are all ` +
      `unaffected. To move or clear the deadline with a recorded reason and the previous value on ` +
      `the audit chain, use POST /api/v1/campaigns/{id}/deadline; to excuse named targets without ` +
      `releasing the rest — with a reason, one audit event per target and 'object:write' checked ` +
      `at each of them — use POST /api/v1/campaigns/{id}/deadline-override.`
  );
}
