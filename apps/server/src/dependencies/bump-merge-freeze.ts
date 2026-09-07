import type { TenantTx } from "../db/tenant-tx.js";
import { freezesByTarget, unionFreezes, type EffectiveFreeze } from "../governance/freeze-scope.js";

/** M25.8 — THE DEPENDENCY ACTUATOR'S FREEZE CHECK. See docs/dependencies.md §120. */

/** A covering freeze set, projected for a Decision. See docs/dependencies.md §121. */
export interface BumpMergeFreezeRecord {
  id: string;
  /** Which tier declared it, and therefore which surface resolves `id`: `GET /v1/freezes/{id}` for
   *  `org`, `GET /v1/instance/freezes` for `platform`. Without it a refusal names an id that 404s on
   *  the only surface a reader would try. */
  tier: "org" | "platform";
  /** NULL for a platform freeze — that tier has no object id in any org's containment chain. */
  scopeObjectId: string | null;
  name: string | null;
  /** The window boundary, ISO-8601. NEVER the clock — see the interface doc. */
  endsAt: string;
}

/** What a covering freeze set says, for a caller that is about to merge. */
export interface BumpMergeFreezeVerdict {
  /** Every covering freeze, deduped and sorted by id. Never empty: a verdict exists only when
   *  something covers the component. */
  freezes: BumpMergeFreezeRecord[];
  /** One sentence an operator can act on — names each freeze, where it was declared and when its
   *  window closes. Composed from stable facts only, so it too is dedup-safe. */
  reason: string;
}

/** Every active freeze covering the component, both tiers. See docs/dependencies.md §122. */
export async function checkBumpMergeFreeze(
  tx: TenantTx,
  orgId: string,
  componentObjectId: string,
  now: Date = new Date()
): Promise<BumpMergeFreezeVerdict | null> {
  const covering = unionFreezes(await freezesByTarget(tx, orgId, [componentObjectId], now));
  if (covering.length === 0) return null;
  const freezes = describeBumpMergeFreezes(covering);
  return {
    freezes,
    reason:
      `auto-merge is withheld: ${freezes.length} active change freeze(s) cover component ` +
      `${componentObjectId} — ` +
      freezes.map(describeOneFreeze).join("; ") +
      `. The pull request is open and stays open; merging into the default branch is what the ` +
      `freeze refuses. No further provider event is needed: a background sweep re-checks every ` +
      `withheld bump on this instance once a minute and merges this one within about that long of ` +
      `the freeze releasing — whether it expires, is lifted or is shortened`
  };
}

/** The Decision projection — sorted, and carrying the boundary rather than the clock. */
function describeBumpMergeFreezes(freezes: EffectiveFreeze[]): BumpMergeFreezeRecord[] {
  return [...freezes]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((f) => ({
      id: f.id,
      tier: f.tier,
      scopeObjectId: f.tier === "platform" ? null : f.scopeObjectId,
      name: f.name,
      endsAt: f.endsAt.toISOString()
    }));
}

/** One freeze, in one phrase — the tier is named because the two are lifted through different doors
 *  by different principals, and an operator reading the refusal needs to know which one they hold. */
function describeOneFreeze(f: BumpMergeFreezeRecord): string {
  return (
    `${f.tier} freeze '${f.name ?? f.id}' (${f.id})` +
    (f.scopeObjectId === null
      ? " declared by this deployment's operator, deployment-wide"
      : ` at scope ${f.scopeObjectId}`) +
    ` until ${f.endsAt}`
  );
}
