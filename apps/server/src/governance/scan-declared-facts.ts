import { and, eq, isNull } from "drizzle-orm";
import {
  COMPONENT_SECURITY_PROPERTY_KEY,
  ComponentSecurityPropertySchema,
  type ScanDeclaredFacts
} from "@scp/schemas";
import type { TenantTx } from "../db/tenant-tx.js";
import { objects } from "../db/schema.js";

/** What the component declared, read once at the gate. See docs/governance.md §289. */

/** One target's declarations, or an empty set. NEVER throws: a malformed bag contributes nothing,
 *  because an unparseable declaration must not turn a gate into a 500 and must not be read as a
 *  declaration either. */
export function parseDeclaredFacts(properties: unknown): ScanDeclaredFacts {
  const bag = (properties as Record<string, unknown> | null | undefined)?.[
    COMPONENT_SECURITY_PROPERTY_KEY
  ];
  if (!bag || typeof bag !== "object") return { declarations: [] };
  // Parsed through the same strict schema the write door uses. See docs/governance.md §290.
  const parsed = ComponentSecurityPropertySchema.safeParse(bag);
  // All or nothing, and that is the deliberate choice. See docs/governance.md §291.
  if (!parsed.success) return { declarations: [] };
  const declarations = Object.entries(parsed.data.declarations)
    // Sorted by key so two identical resolutions serialize identically — the array reaches the gate
    // Decision's `inputContext`, where an unstable order defeats `insertDecisionIfChanged` and
    // re-opens the measured 1.44 GB/day Decision write amplification (M22.0).
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => ({ key, value }));
  return { declarations };
}

/** Read one target's declarations. A target that is not a live `component` yields none — see the
 *  module doc on why the type filter is the guard and not a tidiness. */
export async function resolveDeclaredFactsForTarget(
  tx: TenantTx,
  orgId: string,
  targetObjectId: string
): Promise<ScanDeclaredFacts> {
  const rows = await tx
    .select({ properties: objects.properties })
    .from(objects)
    .where(
      and(
        eq(objects.orgId, orgId),
        eq(objects.id, targetObjectId),
        eq(objects.typeId, "component"),
        // A SOFT-DELETED component declares nothing. Same filter `scopeExpandCte` and
        // `containmentChain` apply to ancestors, for the same reason: a deleted row must stop
        // granting anything the instant it is deleted.
        isNull(objects.deletedAt)
      )
    )
    .limit(1);
  return parseDeclaredFacts(rows[0]?.properties);
}

/** Pure: composes several targets' declarations into one. See docs/governance.md §292. */
export function intersectDeclaredFacts(
  perTarget: readonly ScanDeclaredFacts[]
): ScanDeclaredFacts | undefined {
  if (perTarget.length === 0) return undefined;
  let surviving: Map<string, string> | undefined;
  for (const facts of perTarget) {
    const here = new Map(facts.declarations.map((d) => [d.key, d.value]));
    if (surviving === undefined) {
      surviving = here;
      continue;
    }
    for (const [key, value] of [...surviving]) {
      if (here.get(key) !== value) surviving.delete(key);
    }
  }
  const declarations = [...(surviving ?? new Map<string, string>())]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => ({ key, value }));
  return { declarations };
}
