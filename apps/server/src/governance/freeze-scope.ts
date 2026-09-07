import type { TenantTx } from "../db/tenant-tx.js";
import { containmentChain } from "../graph/containment.js";
import { readStageCoordinate } from "../coordination/regional-executors.js";
import { activeFreezesInWindow, filterFreezesByScopes, type FreezeRow } from "./freezes-repo.js";
import {
  activeInstanceFreezesInWindow,
  instanceFreezeCovers,
  type InstanceFreezeRow
} from "./instance-freezes-repo.js";

/** PER-TARGET FREEZE RESOLUTION. See docs/governance.md §78. */

/** ONE FREEZE IN FORCE, FROM EITHER TIER. See docs/governance.md §79. */
export type EffectiveFreeze =
  ({ tier: "org" } & FreezeRow) | ({ tier: "platform" } & InstanceFreezeRow);

/** One wave target and every ACTIVE freeze covering it, at the instant asked about, from BOTH
 *  tiers. `freezes` is empty for a target nothing covers — an entry is always present for every id
 *  passed in, so a caller can index the result without deciding what a missing key means. */
export interface TargetFreezes {
  targetObjectId: string;
  freezes: EffectiveFreeze[];
}

/** Every target's covering freezes, in the order given. See docs/governance.md §80. */
export async function freezesByTarget(
  tx: TenantTx,
  orgId: string,
  targetObjectIds: string[],
  now: Date
): Promise<TargetFreezes[]> {
  // PROPERTY 1 — INERTNESS. See docs/governance.md §81.
  const orgActive = await activeFreezesInWindow(tx, orgId, now);
  const instanceActive = await activeInstanceFreezesInWindow(tx, now);
  if (orgActive.length === 0 && instanceActive.length === 0)
    return targetObjectIds.map((id) => ({ targetObjectId: id, freezes: [] }));

  // The stage coordinate is read PER TARGET and only when some live instance freeze is actually
  // addressed by one. A deployment-wide freeze (`matchAllEnvironments`) covers every target
  // regardless of coordinate, so asking the graph where each target runs would be two reads per
  // target per tick answering a question the matcher does not consult.
  const coordinateAddressed = instanceActive.some((f) => !f.matchAllEnvironments);

  const byTarget: TargetFreezes[] = [];
  for (const targetObjectId of targetObjectIds) {
    const freezes: EffectiveFreeze[] = [];

    // THE INSTANCE TIER FIRST. See docs/governance.md §82.
    if (instanceActive.length > 0) {
      // `readStageCoordinate` performs the placement -> deployment-target hop itself; without it a
      // stage-shaped wave target (ADR-0026) declares nothing and an environment-addressed platform
      // freeze silently matches NOTHING, indistinguishable from a freeze that was never declared.
      const coordinate = coordinateAddressed
        ? await readStageCoordinate(tx, orgId, targetObjectId)
        : null;
      for (const f of instanceActive) {
        if (instanceFreezeCovers(f, coordinate)) freezes.push({ tier: "platform", ...f });
      }
    }

    // THE ORG TIER. See docs/governance.md §83.
    if (orgActive.length > 0) {
      const chain = await containmentChain(tx, orgId, targetObjectId);
      for (const f of filterFreezesByScopes(
        orgActive,
        chain.map((entry) => entry.id)
      )) {
        freezes.push({ tier: "org", ...f });
      }
    }

    byTarget.push({ targetObjectId, freezes });
  }
  return byTarget;
}

/** The union across targets. See docs/governance.md §84. */
export function unionFreezes(byTarget: TargetFreezes[]): EffectiveFreeze[] {
  const seen = new Set<string>();
  const union: EffectiveFreeze[] = [];
  for (const entry of byTarget) {
    for (const freeze of entry.freezes) {
      if (seen.has(freeze.id)) continue;
      seen.add(freeze.id);
      union.push(freeze);
    }
  }
  return union;
}

/** IS THIS COVERING SET ELIGIBLE FOR THE D7 ROLLBACK EXEMPTION? See docs/governance.md §85. */
export function rollbackExemptible(freezes: readonly { tier: "org" | "platform" }[]): boolean {
  return freezes.every((f) => f.tier !== "platform");
}
