import { and, eq, isNull } from "drizzle-orm";
import {
  COMPONENT_SECURITY_PROPERTY_KEY,
  ComponentSecurityPropertySchema,
  type ScanDeclaredFacts
} from "@scp/schemas";
import type { TenantTx } from "../db/tenant-tx.js";
import { objects } from "../db/schema.js";

/**
 * M22.5 (ADR-0033 §6, owner decision D2) — WHAT THE COMPONENT DECLARED, read once at gate time and
 * handed to the pure matcher as data.
 *
 * ===========================================================================================
 * THE DECISION THIS IMPLEMENTS, AND THE SEAM IT ACCEPTS
 * ===========================================================================================
 * The owner chose that component info encodes the override DIRECTLY; a SecOps-authored mapping from
 * declaration to exemption was recommended and DECLINED. The consequence was raised before the
 * decision and is real: `component.properties` are writable at plain `object:write` SCOPED AT THAT
 * COMPONENT, so the beneficiary of a declaration is also its author, at a weaker permission than the
 * `policy:write` that authored the constraint.
 *
 * That is settled. What bounds it is NOT this file's permission model — it is the ADMISSION algebra
 * one layer up. The component authors the override; it does NOT author its own admission. A
 * `declared_fact` clause has effect only if every tier from `platform` down admits that class AND a
 * tier holding `policy:write` authored the clause that names the fact and the value. A component can
 * write `egress: none` all day and change nothing until someone with real authority says that
 * assertion means something.
 *
 * ===========================================================================================
 * THE RESIDUAL HAZARD, ACCEPTED AND MADE VISIBLE
 * ===========================================================================================
 * The declaration is read LIVE at gate time from a tenant-writable bag and is NOT pinned to the
 * artifact, so it can be flipped for the duration of one gate and flipped back. ADR-0033 §6 records
 * this as accepted and not removable under D2. What this increment does about it is the only thing
 * available: the resolved value is pinned VERBATIM into the gate Decision's `inputContext` and into
 * `control_runs.evidence`, so the flip is visible AFTER THE FACT to anyone reading either. Visible,
 * not prevented — and stated here rather than discovered.
 *
 * ===========================================================================================
 * WHY ONLY A `component` MAY DECLARE
 * ===========================================================================================
 * There is no registered `property_schema` for `security.declarations` on ANY type — drizzle/0075's
 * §2a records why the `component` fragment was written and then deleted (typing a key on a heavily
 * federated type is the same bundle-abort hazard as closing a key set). So nothing at the database
 * stops a `service` object — or a `component` — from carrying an unvalidated `security` bag. The type filter below is therefore load-bearing rather than
 * decorative: without it, a facts read for a service-targeted change would honour a bag that passed
 * through no validation at all. A non-component target contributes NO declarations, which after the
 * intersection means no `declared_fact` exclusion for the whole change — the fail-closed direction,
 * and the same shape `scan-vendor-latest.ts` has for the same reason.
 */

/** One target's declarations, or an empty set. NEVER throws: a malformed bag contributes nothing,
 *  because an unparseable declaration must not turn a gate into a 500 and must not be read as a
 *  declaration either. */
export function parseDeclaredFacts(properties: unknown): ScanDeclaredFacts {
  const bag = (properties as Record<string, unknown> | null | undefined)?.[
    COMPONENT_SECURITY_PROPERTY_KEY
  ];
  if (!bag || typeof bag !== "object") return { declarations: [] };
  // PARSED THROUGH THE SAME `z.strictObject` THE WRITE DOOR USES, not a looser reader.
  //
  // A row can predate the write door (a pre-0067 object, an IaC apply, a federation import from a
  // peer with a newer vocabulary), so this is a genuine second validation and not belt-and-braces.
  // Re-using the write door's schema means a bag the API would refuse is also one the GATE refuses —
  // if the two readers disagreed, the looser one would be the one that decides verdicts.
  const parsed = ComponentSecurityPropertySchema.safeParse(bag);
  // ALL OR NOTHING, and that is the deliberate choice rather than a consequence of using `safeParse`.
  // A per-entry filter was written first and then removed: it was unreachable through the write door
  // (which refuses the whole bag) and reachable only through federation import, where the two live
  // readings of a bag containing an unrecognised entry are "the peer has a newer vocabulary" and
  // "somebody wrote something we cannot interpret". For a LOOSENING both of those must resolve the
  // same way — contribute nothing — because partially interpreting a document we do not fully
  // understand is how a loosening acquires a meaning nobody authored.
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

/**
 * PURE — compose several targets' declarations into the ONE set that describes the change.
 *
 * AN INTERSECTION ON THE WHOLE PAIR, never a union and never a key-only intersection. One verdict is
 * produced for one artifact across a change's whole target set (ADR-0033 §3), so a fact declared by
 * one target that leaked onto a sibling would excuse findings on a component nobody made an assertion
 * about. And intersecting on the KEY alone would be worse than a union: `egress: none` and
 * `egress: internet` would agree on the key and the surviving value would be whichever target was
 * read first — a loosening decided by row order.
 *
 * NO TARGETS yields no declarations, not "everything": an intersection over an empty family is
 * conventionally the universe, which here would be a declared-fact pass for a change with nobody
 * declaring anything.
 */
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
