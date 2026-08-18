import { and, eq, inArray } from "drizzle-orm";
import { PartialScanThresholdSchema, ScanExclusionEffectSchema } from "@scp/schemas";
import type { TenantTx } from "../db/tenant-tx.js";
import { controlBindings } from "../db/schema.js";
import { badRequest } from "../errors.js";
import { isUuid } from "../graph/objects-repo.js";

/**
 * M22.8 (BUILD_AND_TEST.md §8 M22.8) — A SCAN RULE THAT REQUIRES NO SCAN IS REFUSED AT AUTHORING
 * TIME.
 *
 * ================================================================================================
 * THE MEASURED DEFAULT EXPERIENCE THIS ENDS
 * ================================================================================================
 * A first-time SecOps author writes the obvious document:
 *
 *     {"scope": {"objectRef": "<service>"}, "effects": [{"scanThreshold": {"maxHigh": 0}}]}
 *
 * It is accepted, it is versioned, it appears in the policy list, and it constrains NOTHING.
 *
 * BE PRECISE ABOUT WHERE, because the two gate sites differ and a guard whose stated reason is only
 * half true is the provenance-label defect this repo has already paid for:
 *
 *   - `prewarmGovernanceForChange` computes `allControlIds` from the fired set's `requireControls`
 *     and only then, INSIDE `if (allControlIds.length > 0)`, resolves the six-tier ceiling and the
 *     exclusion set at all. With no control required, neither is ever resolved on that path — the
 *     one whose run is CACHED and later read by the host-less accept edge.
 *   - `evaluateGovernanceGate` resolves both UNCONDITIONALLY (M22.0 hoisted them out of the `host`
 *     ternary on purpose), so the ceiling does reach the Decision at a wave boundary. It still
 *     constrains nothing: no scan control is required, so no scan verdict is ever produced for the
 *     ceiling to be compared against or for a clause to act on.
 *
 * Either way the rule does not bind, and the failure is FAIL-CLOSED in the narrow sense (nothing
 * passes that would otherwise have failed — with no scan control there is no scan at all), which is
 * exactly why it never surfaces as an incident. It surfaces as a rule that mysteriously does not
 * fire, with no error, no log and no way for the author to discover why. That is the same harm
 * `component-declaration-guard.ts` names for a misspelled declaration, and it gets the same remedy:
 * refuse at the door, where a 400 costs one round-trip and leaves nobody with a false belief.
 *
 * ================================================================================================
 * THE DOCUMENT MUST BE SELF-CONTAINED, AND THAT IS THE PRECISE CLAIM
 * ================================================================================================
 * The refusal does NOT claim "this ceiling can never apply". `resolveEffectiveScanThreshold` reads
 * every matched policy, not just the one carrying `requireControls`, so a bare ceiling authored
 * beside SOME OTHER policy that requires a scan control genuinely would apply. The refusal is
 * narrower and stronger than that: a scan RULE must, in its own document, require the scan it
 * constrains.
 *
 * That is not tidiness. Depending on a sibling policy makes the constraint conditional on that
 * sibling's continued existence, its scope still covering this target, and — worst — its own CEL
 * condition still firing, because a group whose condition is false contributes no `requireControls`
 * and `allControlIds` collapses to empty. The ceiling then evaporates for exactly the changes the
 * sibling's condition excluded, silently. Requiring the document to carry its own requirement is
 * what makes M22's stated invariant — "fail-closed universality survives: a missing scan still
 * refuses exactly like a failed one" — a property of the rule rather than of the estate around it.
 *
 * A LOCAL, DETERMINISTIC CHECK IS ALSO THE ONLY KIND THAT CAN LIVE AT A CHOKE POINT. A guard that
 * consulted other policies would accept a document today and refuse the identical document tomorrow
 * because an unrelated policy was deleted — and because the UPDATE half checks `nextProperties`
 * (the value about to be STORED, see `objects-repo.ts`), that would make an untouched, already-valid
 * policy un-editable as a side effect of somebody else's delete.
 *
 * ================================================================================================
 * AN `admit`-ONLY `scanExclusion` IS EXEMPT, DELIBERATELY
 * ================================================================================================
 * `{"scanExclusion": {"admit": ["no_fix_available"]}}` is an ADMISSION — one rung of ADR-0033 §1's
 * monotone AND stating that a class of loosening MAY have effect beneath it. It produces no verdict,
 * constrains no scan, and is authored at the top of the chain (platform, trust domain, org) where
 * naming a specific component's scan control would be meaningless. Refusing it would demand that
 * every org-wide admission enumerate scan controls it has no business knowing about.
 *
 * An `exclude` clause is the opposite: it is a rule about a finding in a scan, and a clause with no
 * scan required is inert for the same reason a ceiling is. Both halves can ride in one effect, so
 * the test is on `exclude`'s presence, never on the effect kind.
 *
 * ================================================================================================
 * "NAMES NO SCAN CONTROL" — AND WHY AN UNBOUND CONTROL IS NOT PROOF OF ONE
 * ================================================================================================
 * Naming any control is not enough: `requireControls: ["<a webhook control>"]` makes
 * `allControlIds` non-empty, so the ceiling resolves and lands in the Decision, and still no scan
 * ever runs for it to constrain. So the check resolves the named controls' bindings and requires at
 * least one bound to a scan-verdict module.
 *
 * BUT AN ABSENT BINDING IS REFUSED FROM BEING EVIDENCE, in the same "a miss yields nothing" spirit
 * ADR-0033 §1 applies to a matcher. A control object and its binding are two API calls; refusing a
 * policy because the binding has not been created YET would make policy authoring order-dependent,
 * and — through the `nextProperties` update rule again — would make an already-valid policy
 * un-editable the moment somebody re-pointed or dropped a binding. So the refusal fires only when
 * every named control is BOUND and none of them is bound to a scan-verdict module: exactly when the
 * document can be PROVEN inert, never when it merely cannot be proven live.
 */

/**
 * The control plugin modules that produce a SCAN VERDICT — the evidence a `scanThreshold` is
 * compared against and a `scanExclusion` clause acts on.
 *
 * CENSUS, not a guess: `plugin-host/subprocess-entry.ts`'s `loadPlugin` switch and
 * `plugin-host/contract.ts`'s `PluginHostInstanceConfig["module"]` union are the authority on which
 * modules exist, and `control-runner.ts`'s `KNOWN_CONTROL_MODULES` lists the three that are
 * ControlPlugins (`webhook-control`, `scan-result-control`, `github-check`). Exactly one of the
 * three emits `ScanEvidence`. `federation/promotion-scan-step.ts` is the OTHER verdict producer in
 * the system and is deliberately absent: it is a server-side step, not a control binding, and no
 * `requireControls` entry can ever name it.
 *
 * If a second scan-verdict ControlPlugin is ever added, it belongs here — and the failure mode of
 * forgetting is a FALSE REFUSAL (a legitimate policy rejected), which is loud, not a false accept.
 */
const SCAN_VERDICT_CONTROL_MODULES: readonly string[] = ["scan-result-control"];

interface EffectBag {
  scanThreshold?: unknown;
  scanExclusion?: unknown;
  requireControls?: unknown;
}

/** True when this effect sets a ceiling the gate would actually read — the same test
 *  `scan-requirements.ts`'s `parseScanThresholdEffect` applies, expressed against the same schema so
 *  the two cannot drift into disagreeing about what a ceiling is. A malformed or empty
 *  `scanThreshold` contributes nothing to the MIN, so it is not a rule and is not refused here (it
 *  is already inert for a reason this guard does not own). */
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
