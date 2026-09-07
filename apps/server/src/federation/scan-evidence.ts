import {
  ScanEvidenceSchema,
  type ScanEvidence,
  type ScanThresholdContribution
} from "@scp/schemas";

/** What counts as a scan outcome at the export boundary. See docs/federation.md §502. */

/** The well-known object id every such row carries. See docs/federation.md §503. */
export const MANAGED_SCAN_CONTROL_OBJECT_ID = "00000000-5ca4-4000-8000-000000000001";

/** The ControlPlugin modules whose verdict IS a scan verdict. See docs/federation.md §504. */
export const SCAN_EVIDENCE_PLUGIN_MODULES: readonly string[] = ["scan-result-control"];

/** The subset of a `control_runs` row the boundary rules read. Structurally satisfied by
 *  `governance/controls-repo.ts`'s `ControlRunRow`, without depending on that module's type. */
export interface ScanRunLike {
  id: string;
  controlObjectId: string;
  pluginModule: string | null;
  status: string;
  evidence: Record<string, unknown>;
  createdAt: Date;
}

/** A per-severity ceiling, every severity optional — ABSENT NEVER MEANS ZERO (the rule
 *  `governance/scan-requirements.ts` states: reading "no floor" as 0 would make it the tightest
 *  possible ceiling and block everything). */
export interface SeverityCeiling {
  maxCritical?: number;
  maxHigh?: number;
  maxMedium?: number;
  maxLow?: number;
}

const SEVERITY_KEYS = ["maxCritical", "maxHigh", "maxMedium", "maxLow"] as const;
const COUNT_KEYS = {
  maxCritical: "critical",
  maxHigh: "high",
  maxMedium: "medium",
  maxLow: "low"
} as const;

/** The per-severity minimum across the instance floors. See docs/federation.md §505. */
export function mergeInstanceFloor(
  contributions: readonly ScanThresholdContribution[]
): SeverityCeiling {
  const merged: SeverityCeiling = {};
  for (const contribution of contributions) {
    for (const key of SEVERITY_KEYS) {
      const value = contribution.threshold[key];
      if (value === undefined) continue;
      const current = merged[key];
      if (current === undefined || value < current) merged[key] = value;
    }
  }
  return merged;
}

/** True iff this run came from one of the two ADR-0020 §1 scan-evidence ingresses. */
export function isScanEvidenceProducer(run: ScanRunLike): boolean {
  if (run.controlObjectId === MANAGED_SCAN_CONTROL_OBJECT_ID) {
    // The commander's own step deposits under a synthetic control id with NO binding, so a NULL
    // module is what an authentic managed deposit looks like. A row under this id that DOES name a
    // module did not come from the step (nothing else may claim the commander's identity).
    return run.pluginModule === null;
  }
  // A bound control. NULL here means the row predates migration 0064, or `ensureControlRun` wrote a
  // `fail` because the binding was missing — in both cases what produced it is unrecorded, and an
  // unattributable row is not evidence about anything. Fail-closed, as `bump-actuator.ts` treats the
  // same NULL: it costs a re-scan, never an unearned crossing.
  return run.pluginModule !== null && SCAN_EVIDENCE_PLUGIN_MODULES.includes(run.pluginModule);
}

/** Which question this run answers, the supersession key. See docs/federation.md §506. */
function questionKey(run: ScanRunLike): string {
  if (run.controlObjectId === MANAGED_SCAN_CONTROL_OBJECT_ID) {
    const scanner = typeof run.evidence.scanner === "string" ? run.evidence.scanner : "";
    return `${run.controlObjectId}::${scanner}`;
  }
  return run.controlObjectId;
}

/** WHICH PROMOTED DIGEST THIS RUN IS ABOUT. See docs/federation.md §507. */
function subjectDigestOf(run: ScanRunLike): string | null {
  const value = run.evidence.expectedDigest;
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Newest first. `createdAt` decides; ties break on `id`, which is a uuidv7 and therefore monotone
 *  within a millisecond — so "the latest run" is total and deterministic rather than dependent on
 *  the order Postgres happened to return equal-timestamped rows in. */
function isNewer(a: ScanRunLike, b: ScanRunLike): boolean {
  const ta = a.createdAt.getTime();
  const tb = b.createdAt.getTime();
  if (ta !== tb) return ta > tb;
  return a.id > b.id;
}

/** Every severity whose reported count exceeds the instance floor for it. */
function breachesInstanceFloor(
  counts: ScanEvidence["severityCounts"],
  floor: SeverityCeiling
): Array<{ severity: string; count: number; ceiling: number }> {
  const breached: Array<{ severity: string; count: number; ceiling: number }> = [];
  for (const key of SEVERITY_KEYS) {
    const ceiling = floor[key];
    if (ceiling === undefined) continue;
    const count = counts[COUNT_KEYS[key]];
    if (count > ceiling) breached.push({ severity: key, count, ceiling });
  }
  return breached;
}

/** ADDITIVE ONLY. This union is a server-internal type. See docs/federation.md §508. */
export type ScanCoverageRefusalCode =
  | "no_scan_outcome"
  | "not_passing"
  | "malformed_evidence"
  | "not_digest_bound"
  | "stale_exclusion_set"
  | "below_instance_floor";

export type ScanCoverage =
  | { covered: true; run: ScanRunLike; evidence: ScanEvidence }
  | {
      covered: false;
      code: ScanCoverageRefusalCode;
      reason: string;
      detail: Record<string, unknown>;
    };

/** Does this digest carry a current, floor-satisfying outcome. See docs/federation.md §509. */
export function evaluateScanCoverage(args: {
  digest: string;
  runs: readonly ScanRunLike[];
  instanceFloor: SeverityCeiling;
  /** The hash of the exclusion set the caller resolved. See docs/federation.md §510. */
  expectedExclusionSetHash?: string;
}): ScanCoverage {
  const { digest, runs, instanceFloor, expectedExclusionSetHash } = args;

  const admitted = runs.filter(isScanEvidenceProducer);
  const aboutThisArtifact = admitted.filter((run) => subjectDigestOf(run) === digest);

  if (aboutThisArtifact.length === 0) {
    return {
      covered: false,
      code: "no_scan_outcome",
      reason:
        `no scan outcome for ${digest} from an admitted scan-evidence producer — the commander's ` +
        `promotion scan step or a bound '${SCAN_EVIDENCE_PLUGIN_MODULES.join("'/'")}' control. ` +
        `A control run is a scan outcome because of WHAT PRODUCED IT, never because its evidence ` +
        `is shaped like one`,
      detail: {
        // What WAS on the change, so an operator reading the Decision can tell "nothing ran" apart
        // from "something ran and was not admitted" — two very different things to go and fix.
        controlRunsOnChange: runs.length,
        admittedProducerRuns: admitted.length,
        producersSeen: [...new Set(runs.map((r) => r.pluginModule ?? "<no binding>"))].sort()
      }
    };
  }

  // Newest run per question. Every question that has ever been asked about this artifact must have a
  // CURRENT answer of `pass` — an older pass can never outvote a newer failure.
  const latestPerQuestion = new Map<string, ScanRunLike>();
  for (const run of aboutThisArtifact) {
    const key = questionKey(run);
    const incumbent = latestPerQuestion.get(key);
    if (!incumbent || isNewer(run, incumbent)) latestPerQuestion.set(key, run);
  }

  let witness: { run: ScanRunLike; evidence: ScanEvidence } | undefined;
  for (const [key, run] of latestPerQuestion) {
    if (run.status !== "pass") {
      return {
        covered: false,
        code: "not_passing",
        reason:
          `the CURRENT scan outcome for ${digest} from control ${run.controlObjectId} ` +
          `(${run.pluginModule ?? "commander promotion scan step"}) is '${run.status}', not 'pass' ` +
          `— a later verdict supersedes an earlier one, so a historical pass does not authorize this ` +
          `crossing`,
        detail: { question: key, controlRunId: run.id, status: run.status }
      };
    }
    const parsed = ScanEvidenceSchema.safeParse(run.evidence);
    if (!parsed.success) {
      return {
        covered: false,
        code: "malformed_evidence",
        reason:
          `the current scan outcome for ${digest} from control ${run.controlObjectId} reports 'pass' ` +
          `but its evidence is not a readable scan verdict — a verdict this gate cannot read cannot ` +
          `authorize a crossing (fail-closed)`,
        detail: { question: key, controlRunId: run.id }
      };
    }
    const evidence = parsed.data;
    if (evidence.digestMatch !== true || evidence.artifactDigest !== digest) {
      return {
        covered: false,
        code: "not_digest_bound",
        reason:
          `the current scan outcome for ${digest} from control ${run.controlObjectId} is not bound to ` +
          `that artifact — it scanned ${evidence.artifactDigest} (digestMatch=${evidence.digestMatch}) ` +
          `(M17.1 digest binding, fail-closed)`,
        detail: {
          question: key,
          controlRunId: run.id,
          scannedDigest: evidence.artifactDigest,
          digestMatch: evidence.digestMatch
        }
      };
    }
    // Is this verdict still judged under the set in force now. See docs/federation.md §511.
    if (evidence.exclusionSetHash !== expectedExclusionSetHash) {
      return {
        covered: false,
        code: "stale_exclusion_set",
        reason:
          `the current scan outcome for ${digest} from control ${run.controlObjectId} was produced ` +
          `under a DIFFERENT scan-exclusion set than the one in force now — an override grant that ` +
          `has since expired, been revoked or been edited cannot authorize this crossing ` +
          `(ADR-0033 §10, fail-closed). Re-evaluating the change re-scans it under the current set`,
        detail: {
          question: key,
          controlRunId: run.id,
          // Both sides, so an operator reading the Decision can tell "the set moved" from "this run
          // predates stamping entirely" without going to the row.
          recordedExclusionSetHash: evidence.exclusionSetHash ?? null,
          expectedExclusionSetHash: expectedExclusionSetHash ?? null
        }
      };
    }
    // Compatibility: what the compared number must become. See docs/federation.md §512.
    const breached = breachesInstanceFloor(evidence.severityCounts, instanceFloor);
    if (breached.length > 0) {
      return {
        covered: false,
        code: "below_instance_floor",
        reason:
          `the scan outcome for ${digest} passed its own control, but its findings exceed the ` +
          `operator-set instance floor (ADR-0016 §3) at the boundary: ` +
          breached.map((b) => `${b.severity}=${b.count} > ${b.ceiling}`).join(", ") +
          ` — an instance floor is operator-write/tenant-read precisely so no tenant-authored ` +
          `threshold can loosen it`,
        detail: {
          question: key,
          controlRunId: run.id,
          breached,
          appliedThreshold: evidence.threshold,
          thresholdSource: evidence.thresholdSource ?? null,
          instanceFloor
        }
      };
    }
    if (!witness || isNewer(run, witness.run)) witness = { run, evidence };
  }

  // Unreachable while `aboutThisArtifact` is non-empty (every entry seeds a question), but returning
  // a refusal rather than asserting keeps the function total in the safe direction.
  if (!witness) {
    return {
      covered: false,
      code: "no_scan_outcome",
      reason: `no scan outcome for ${digest}`,
      detail: {}
    };
  }
  return { covered: true, run: witness.run, evidence: witness.evidence };
}
