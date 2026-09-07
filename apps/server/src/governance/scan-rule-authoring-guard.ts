import { and, eq, inArray } from "drizzle-orm";
import {
  PartialScanThresholdSchema,
  ScanExclusionEffectSchema,
  scanExclusionClauseIsNarrowed
} from "@scp/schemas";
import type { TenantTx } from "../db/tenant-tx.js";
import { controlBindings } from "../db/schema.js";
import { badRequest } from "../errors.js";
import { isUuid } from "../graph/objects-repo.js";

/** M22.8 (BUILD_AND_TEST.md §8 M22.8). See docs/governance.md §391. */

/** The control plugin modules that produce a SCAN VERDICT. See docs/governance.md §392. */
const SCAN_VERDICT_CONTROL_MODULES: readonly string[] = ["scan-result-control"];

interface EffectBag {
  scanThreshold?: unknown;
  scanExclusion?: unknown;
  requireControls?: unknown;
}

/** True when this effect sets a ceiling the gate would read. See docs/governance.md §393. */
function carriesCeiling(effect: EffectBag): boolean {
  const raw = effect.scanThreshold;
  if (!raw || typeof raw !== "object") return false;
  const parsed = PartialScanThresholdSchema.safeParse(raw);
  if (!parsed.success) return false;
  const v = parsed.data;
  return (
    v.maxCritical !== undefined ||
    v.maxHigh !== undefined ||
    v.maxMedium !== undefined ||
    v.maxLow !== undefined
  );
}

/** True when this effect contributes an exclusion CLAUSE. An `admit`-only effect is an admission,
 *  not a rule about a finding — see the module doc. */
function carriesExclusionClause(effect: EffectBag): boolean {
  const raw = effect.scanExclusion;
  if (!raw || typeof raw !== "object") return false;
  const parsed = ScanExclusionEffectSchema.safeParse(raw);
  return parsed.success && parsed.data.exclude !== undefined;
}

/** A `declared_fact` CLAUSE THAT NARROWS NOTHING IS REFUSED. See docs/governance.md §394. */
export function assertDeclaredFactClauseIsNarrowed(args: {
  typeId: string;
  properties: Record<string, unknown>;
}): void {
  if (args.typeId !== "policy") return;
  const effects = args.properties.effects;
  if (!Array.isArray(effects)) return;

  for (const effect of effects) {
    if (typeof effect !== "object" || effect === null) continue;
    const raw = (effect as EffectBag).scanExclusion;
    if (!raw || typeof raw !== "object") continue;
    const parsed = ScanExclusionEffectSchema.safeParse(raw);
    // A MALFORMED effect is left alone here, deliberately: it contributes no clause at all
    // (`parseScanExclusionEffect` drops it), so refusing it would be this guard inventing a second,
    // weaker schema validator — the same reading `assertScanRuleRequiresScanControl` gives a
    // malformed `scanThreshold` two functions up.
    if (!parsed.success) continue;
    const clause = parsed.data.exclude;
    if (!clause || clause.class !== "declared_fact") continue;
    if (scanExclusionClauseIsNarrowed(clause)) continue;
    throw badRequest(
      `policy carries a 'declared_fact' exclusion clause with no narrowing matcher — such a clause ` +
        `excludes EVERY finding at EVERY severity for any component declaring ` +
        `'${clause.declaredFact ?? "<unset>"}', which is the scan gate turned off rather than an ` +
        `exception. Admission is per CLASS, so no tier above can see this clause's reach. Add at ` +
        `least one of vulnerabilityId, pkgName, purl or findingClass to bound which findings the ` +
        `declaration is allowed to excuse.`
    );
  }
}

export async function assertScanRuleRequiresScanControl(
  tx: TenantTx,
  args: { orgId: string; typeId: string; properties: Record<string, unknown> }
): Promise<void> {
  if (args.typeId !== "policy") return;
  const effects = args.properties.effects;
  if (!Array.isArray(effects)) return;

  const bags = effects.filter(
    (e): e is EffectBag => typeof e === "object" && e !== null
  ) as EffectBag[];

  const ceiling = bags.some(carriesCeiling);
  const clause = bags.some(carriesExclusionClause);
  if (!ceiling && !clause) return;

  const kind =
    ceiling && clause
      ? "scanThreshold + scanExclusion"
      : ceiling
        ? "scanThreshold"
        : "scanExclusion";

  const named = [
    ...new Set(
      bags.flatMap((e) =>
        Array.isArray(e.requireControls)
          ? e.requireControls.filter((c): c is string => typeof c === "string")
          : []
      )
    )
  ];

  if (named.length === 0) {
    throw badRequest(
      `policy carries a '${kind}' effect but requires no control — such a rule constrains nothing. ` +
        `With no scan control required, no scan verdict is ever produced for the ceiling to be ` +
        `compared against or for an exclusion clause to act on, and the reconcile prewarm never ` +
        `resolves either dimension at all. Add a requireControls effect naming a control bound to a ` +
        `scan-verdict plugin (${SCAN_VERDICT_CONTROL_MODULES.join(", ")}) to THIS document — relying ` +
        `on a sibling policy to require the scan makes the rule evaporate whenever that sibling's ` +
        `own condition is false.`
    );
  }

  // Only well-formed object ids can name a control: `ensureControlRun` refuses anything else before
  // it reaches the database, so a non-uuid entry can never correspond to a binding. Treated here as
  // UNRESOLVED rather than as "not a scan control" — the same "cannot prove inert" reading an
  // unbound control gets, so this guard never becomes a second, weaker uuid validator.
  const ids = named.filter((c) => isUuid(c));
  if (ids.length !== named.length) return;

  const bindings = await tx
    .select({
      controlObjectId: controlBindings.controlObjectId,
      pluginModule: controlBindings.pluginModule
    })
    .from(controlBindings)
    .where(
      and(eq(controlBindings.orgId, args.orgId), inArray(controlBindings.controlObjectId, ids))
    );

  const boundIds = new Set(bindings.map((b) => b.controlObjectId));
  // ANY named control that is not bound yet ⇒ the document cannot be PROVEN inert. Pass.
  if (ids.some((id) => !boundIds.has(id))) return;
  if (bindings.some((b) => SCAN_VERDICT_CONTROL_MODULES.includes(b.pluginModule))) return;

  throw badRequest(
    `policy carries a '${kind}' effect and requires only non-scan controls ` +
      `(${[...new Set(bindings.map((b) => b.pluginModule))].sort().join(", ")}) — such a rule is ` +
      `silently inert: no scan verdict is ever produced for the ceiling to be compared against or ` +
      `for an exclusion clause to act on. Add a control bound to a scan-verdict plugin ` +
      `(${SCAN_VERDICT_CONTROL_MODULES.join(", ")}) to this document's requireControls.`
  );
}
