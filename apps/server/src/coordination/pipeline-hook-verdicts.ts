import type {
  AlarmStateEvidence,
  HookFreshnessContext,
  ManifestBakeAlarmsHookSchema,
  ManifestContinuousHookSchema,
  ManifestPostDeployHookSchema,
  TestRunEvidence
} from "@scp/schemas";
import type { z } from "zod";

type ManifestContinuousHook = z.infer<typeof ManifestContinuousHookSchema>;
type ManifestBakeAlarmsHook = z.infer<typeof ManifestBakeAlarmsHookSchema>;
type ManifestPostDeployHook = z.infer<typeof ManifestPostDeployHookSchema>;

/** PURE verdict logic for the four pipeline test hooks. See docs/coordination.md §636. */

export interface ContinuousHoldVerdict {
  held: boolean;
  /** Absent when NOT held. Three distinct reasons, never collapsed: `failed` means the probe ran
   *  and the target is sick; `stale`/`no_evidence` both mean nobody is looking, which is a
   *  different operator action from "the target is sick" — see the module doc on
   *  `ManifestContinuousHookSchema`. */
  reason?: "no_evidence" | "stale" | "failed";
  /** `completedAt + maxAgeSeconds` as an ISO string, when evidence exists; else `null`. Returned
   *  as DATA for the caller to record on `ContinuousTestHoldSchema` — it is not itself the
   *  enforcement, which is the read-time comparison against `now` below. */
  staleAfter: string | null;
  lastReportedAt: string | null;
}

/** The latest test-run evidence bound to a continuous hook. See docs/coordination.md §637. */
export type LatestContinuousEvidence = Pick<TestRunEvidence, "outcome" | "completedAt"> | null;

export function evaluateContinuousHold(
  hook: Pick<ManifestContinuousHook, "maxAgeSeconds">,
  latestEvidence: LatestContinuousEvidence,
  now: Date
): ContinuousHoldVerdict {
  if (latestEvidence === null) {
    // No probe has ever reported for this (hook, target). This is not the same fact as "it
    // reported and then stopped" (stale) — an operator checking a never-reported target looks in
    // a different place than one that used to be fine — but both are ABSENCE, not a verdict about
    // the target's health, so both hold.
    return { held: true, reason: "no_evidence", staleAfter: null, lastReportedAt: null };
  }

  const completedAt = new Date(latestEvidence.completedAt);
  const staleAfter = new Date(completedAt.getTime() + hook.maxAgeSeconds * 1000);
  const staleAfterIso = staleAfter.toISOString();
  const lastReportedAt = latestEvidence.completedAt;

  if (latestEvidence.outcome === "failed") {
    // The probe ran and the target is sick. Distinct reason from staleness on purpose (see
    // module doc): "failed" says check the target, "stale"/"no_evidence" say check the prober.
    return { held: true, reason: "failed", staleAfter: staleAfterIso, lastReportedAt };
  }

  // outcome === "passed" from here. Staleness is a READ-TIME comparison against `now`, redone
  // every tick — never a status flipped once and cached (ADR-0033 §6a).
  if (staleAfter.getTime() <= now.getTime()) {
    // Stale-passed is NOT pass and NOT fail: it means nobody is looking, which is neither claim.
    // Collapsing this into "pass" makes a dead prober indistinguishable from a healthy fleet, and
    // collapsing it into "fail" would say the target is sick when nobody actually looked.
    return { held: true, reason: "stale", staleAfter: staleAfterIso, lastReportedAt };
  }

  return { held: false, staleAfter: staleAfterIso, lastReportedAt };
}

/** One alarm-state report, tagged with the server-stamped source it arrived from. `source` is
 *  never caller-supplied in the real system (see `AlarmStateEvidenceSchema`'s producer-stamping
 *  rule) — the caller resolving evidence for this function stamps it from where the row came
 *  from, not from anything in the payload. */
export interface BakeAlarmReport {
  source: "rollout_analysis" | "pushed";
  evidence: Pick<AlarmStateEvidence, "windowStart" | "windowEnd" | "alarms">;
}

export interface BakeGateVerdict {
  satisfied: boolean;
  reason: "quiet" | "alarm_firing" | "window_not_covered" | "no_source";
  /** Every alarm, from any source, that fired inside the required window. Empty when `reason` is
   *  not `alarm_firing`. */
  firingAlarms: AlarmStateEvidence["alarms"];
  /** Which sources contributed to the verdict — the sources that reported at all, so a caller can
   *  see e.g. that only `pushed` covered a quiet gate in an air-gapped domain. */
  coveredBy: Array<BakeAlarmReport["source"]>;
}

interface Interval {
  start: number;
  end: number;
}

/** Merge one source's intervals and report full coverage. See docs/coordination.md §638. */
function coversWindow(intervals: Interval[], requiredStart: number, requiredEnd: number): boolean {
  if (intervals.length === 0) return false;
  const sorted = [...intervals].sort((a, b) => a.start - b.start);

  let mergedEnd = sorted[0]!.end;
  let mergedStart = sorted[0]!.start;
  for (let i = 1; i < sorted.length; i++) {
    const next = sorted[i]!;
    if (next.start > mergedEnd) {
      // Gap: this run of merged coverage stops here. Check if it already satisfied the
      // requirement before moving on to the next run.
      if (mergedStart <= requiredStart && mergedEnd >= requiredEnd) return true;
      mergedStart = next.start;
      mergedEnd = next.end;
    } else {
      mergedEnd = Math.max(mergedEnd, next.end);
    }
  }
  return mergedStart <= requiredStart && mergedEnd >= requiredEnd;
}

export function evaluateBakeGate(
  hook: Pick<ManifestBakeAlarmsHook, "quietWindowSeconds">,
  reports: BakeAlarmReport[],
  targetDeployedAt: Date,
  /** Unused by the three clauses below. See docs/coordination.md §639. */
  _now: Date
): BakeGateVerdict {
  const requiredStart = targetDeployedAt.getTime();
  const requiredEnd = requiredStart + hook.quietWindowSeconds * 1000;

  if (reports.length === 0) {
    // No reports at all is distinguishable from "reports exist but don't cover the window" so the
    // caller can surface "declared bake gate has no evidence source" LOUDLY, not as a mystery hang.
    return { satisfied: false, reason: "no_source", firingAlarms: [], coveredBy: [] };
  }

  // (a) FAIL-SAFE ON FIRING: any report from ANY source listing an alarm that fired within the
  // required window holds the gate, with no precedence between sources. An alarm gate is a safety
  // interlock; "wrongly held" and "wrongly released" are not comparable costs, so a firing alarm
  // from either source wins outright regardless of what the other source says.
  const firingAlarms = reports.flatMap((report) =>
    report.evidence.alarms.filter((alarm) => {
      const firedAt = new Date(alarm.firedAt).getTime();
      return firedAt >= requiredStart && firedAt <= requiredEnd;
    })
  );
  if (firingAlarms.length > 0) {
    return { satisfied: false, reason: "alarm_firing", firingAlarms, coveredBy: [] };
  }

  // Satisfying needs one source covering the whole window. See docs/coordination.md §640.
  const bySource = new Map<BakeAlarmReport["source"], Interval[]>();
  for (const report of reports) {
    const intervals = bySource.get(report.source) ?? [];
    intervals.push({
      start: new Date(report.evidence.windowStart).getTime(),
      end: new Date(report.evidence.windowEnd).getTime()
    });
    bySource.set(report.source, intervals);
  }

  const coveredBy: Array<BakeAlarmReport["source"]> = [];
  for (const [source, intervals] of bySource) {
    if (coversWindow(intervals, requiredStart, requiredEnd)) coveredBy.push(source);
  }

  if (coveredBy.length > 0) {
    return { satisfied: true, reason: "quiet", firingAlarms: [], coveredBy };
  }

  return { satisfied: false, reason: "window_not_covered", firingAlarms: [], coveredBy: [] };
}

// ---------------------------------------------------------------------------------------------
// 3. postDeploy — wave-boundary gate at the next wave's entry (ManifestPostDeployHookSchema)
// ---------------------------------------------------------------------------------------------

export interface PostDeployGateVerdict {
  outcome: "pass" | "fail" | "awaiting";
}

/** The latest `testRun` evidence bound to a `postDeploy` hook's subject, or `null` when none has
 *  arrived yet. */
export type PostDeployEvidence = Pick<TestRunEvidence, "outcome"> | null;

/** NOTE FOR CALLERS. See docs/coordination.md §641. */
export function evaluatePostDeployGate(
  hook: Pick<ManifestPostDeployHook, "hookId">,
  evidence: PostDeployEvidence,
  /** Unused: postDeploy has no staleness concept (D21(a) — it gates once per wave crossing, not
   *  on a rolling clock). Kept as an explicit parameter for signature symmetry with the other
   *  verdict functions (never `Date.now()` inside any of them). */
  _now: Date
): PostDeployGateVerdict {
  void hook;
  if (evidence === null) return { outcome: "awaiting" };
  if (evidence.outcome === "passed") return { outcome: "pass" };
  return { outcome: "fail" };
}

/** The subset of a `continuous` hook's declared shape this context needs. */
export type FreshnessHookInput = Pick<ManifestContinuousHook, "hookId" | "maxAgeSeconds"> & {
  kind: "continuous";
};

/** The stored evidence row this context is built from — the fields `HookFreshnessContextSchema`
 *  carries, nothing more (in particular, no `now`). */
export type FreshnessLatestEvidence = {
  evidenceId: string;
  outcome: "passed" | "failed";
  completedAt: string;
  artifactDigest: string | null;
  commitSha: string | null;
} | null;

/** Builds the freshness context a Decision records. See docs/coordination.md §642. */
export function buildHookFreshnessContext(
  hook: FreshnessHookInput,
  latestEvidence: FreshnessLatestEvidence
): HookFreshnessContext {
  const staleAfter =
    latestEvidence === null
      ? null
      : new Date(
          new Date(latestEvidence.completedAt).getTime() + hook.maxAgeSeconds * 1000
        ).toISOString();

  return {
    hook: hook.kind,
    hookId: hook.hookId,
    maxAgeSeconds: hook.maxAgeSeconds,
    latestEvidence,
    staleAfter
  };
}
