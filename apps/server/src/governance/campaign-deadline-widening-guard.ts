import type { CampaignDeadlineOverride } from "@scp/schemas";
import type { TenantTx } from "../db/tenant-tx.js";
import { forbidden } from "../errors.js";
import { hasPermission } from "../authz/resolve.js";
import { resolveCampaignDeadline } from "../coordination/campaign-deadline-lock.js";

/** Widening a campaign's deadline, and the ruling behind it. See docs/governance.md §19. */
/** How far each named target is excused, as an instant. See docs/governance.md §20. */
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

/** The targets this write adds or extends a waiver for. See docs/governance.md §21. */
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
    // At the campaign, matching the route it guards. See docs/governance.md §22.
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
