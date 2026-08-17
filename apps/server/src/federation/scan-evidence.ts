import { ScanEvidenceSchema, type ScanEvidence, type ScanThresholdContribution } from "@scp/schemas";

/**
 * WHAT COUNTS AS A SCAN OUTCOME AT THE FEDERATION EXPORT BOUNDARY — the single rule the M17.3 (E6)
 * export gate (`promotion-repo.ts`) and the ADR-0020 promotion scan step's short-circuit
 * (`promotion-scan-step.ts`) both apply.
 *
 * ONE MODULE, TWO CALL SITES, ON PURPOSE. Those two predicates were written as separate copies of
 * "status pass + `ScanEvidenceSchema` parses + digest matches", each documented as being the exact
 * twin of the other. They were — and a rule maintained in two places with a comment promising they
 * agree is a rule that will eventually disagree. Worse, they must agree for a *safety* reason and not
 * merely a tidiness one: the short-circuit decides whether a managed scan RUNS, and the gate decides
 * whether the export CROSSES. A short-circuit that is looser than the gate suppresses the scan that
 * would have satisfied the gate; a short-circuit that is tighter re-scans an artifact that is already
 * covered. Both call `evaluateScanCoverage`.
 *
 * ============================================================================================
 * THREE PROPERTIES THIS FIXES, ALL OF THEM AT A CROSS-BOUNDARY AUTHORIZATION GATE
 * ============================================================================================
 *
 * **1. A SCAN OUTCOME IS IDENTIFIED BY ITS PRODUCER, NEVER BY THE SHAPE OF ITS EVIDENCE.** The gate
 * used to accept ANY `control_runs` row whose jsonb evidence happened to parse as
 * `ScanEvidenceSchema`. `control_runs.evidence` is stored VERBATIM from whatever a bound
 * ControlPlugin returns (`governance/control-runner.ts`: `evidence = outcome.evidence ?? {}`), and
 * `@scp/plugin-webhook-control` returns `body.evidence` verbatim from an operator-configured URL
 * along with `body.status`. So a `webhook-control` binding pointed at a URL that answers
 * `{"status":"pass","evidence":{…ScanEvidence-shaped…,"digestMatch":true,"artifactDigest":"<the
 * promoted digest>"}}` manufactured a row that satisfied E6 exactly. That is a complete bypass of
 * the boundary scan gate, authored at `policy:write` **scoped at a control object** — strictly
 * weaker than the operator authority that sets the instance floors (ADR-0016 §3 makes
 * `scan_requirement_floors` operator-write / tenant-read precisely so a tenant cannot loosen them).
 *
 * The fix is not a stricter shape test — no shape test can work, because the shape is the payload.
 * `control_runs.plugin_module` (migration 0064) records WHICH KIND OF CONTROL produced a run, stamped
 * at insert from the binding that actually ran, and `MANAGED_SCAN_CONTROL_OBJECT_ID` identifies the
 * commander's own step. Those are the two ADR-0020 §1 ingresses — the managed promotion scan step and
 * the org-pipeline `scan-result-control` alternate — and they are the only two producers admitted
 * here. This is the same move `dependencies/bump-actuator.ts` already made for the auto-merge grant,
 * for the same reason, one migration earlier.
 *
 * **2. THE LATEST ANSWER WINS.** The gate used to accept any HISTORICAL passing row, forever: a later
 * failing scan of the same artifact by the same control did not supersede it. Runs are grouped by the
 * QUESTION they answer ({@link questionKey}) and only the newest run of each question is consulted —
 * every one of which must pass. An older pass therefore cannot outvote a newer fail, and (the
 * direction that matters for ADR-0033) a newer pass DOES clear an older fail, so a re-evaluation can
 * still unblock an export.
 *
 * **3. THE OPERATOR'S FLOOR BINDS AT THE BOUNDARY.** The gate applied no threshold of its own — it
 * accepted the producer's `status` and never looked at what that verdict was judged against. Evidence
 * can be judged against a per-binding `config.threshold` (`scan-result-control`'s `resolveThreshold`
 * falls back to it when the gate threads no scoped ceiling), which is tenant-authored. So the
 * `severityCounts` of the satisfying evidence are re-checked HERE against the INSTANCE-SCOPED FLOORS
 * (`scan_requirement_floors`, ADR-0016 §3) — and only those.
 *
 * WHY ONLY THE INSTANCE FLOORS, AND NOT THE SIX-TIER RESOLUTION. The four org-and-below tiers are
 * tenant-authored policy data: re-resolving them here would add no authority a tenant does not
 * already hold, while paying exactly the cost ADR-0016 §4 rejected design (B) for — a second
 * evaluation of the same criterion, producing a second, possibly-divergent verdict. The two above-org
 * tiers are different in kind: they are the operator's statement about the deployment, unwritable by
 * any tenant, and E6 is the operator's boundary. Checking those and stopping is the whole of the
 * defence-in-depth this gate's own doc comment already claimed to be.
 *
 * **With no floor authored — the default on every deployment — this check constrains nothing and the
 * gate's behaviour is byte-identical to before it existed.**
 *
 * ============================================================================================
 * WHAT THIS IS STILL NOT
 * ============================================================================================
 * It NEVER runs a scan (charter principle 1) and it never re-counts findings: it re-verifies the
 * existence, provenance, currency and digest-binding of an outcome an execution system already
 * produced. And it is not a *replacement* for the lifecycle gate — it is the boundary re-check.
 */

/**
 * The synthetic, well-known object id every `control_runs` row the commander's promotion scan step
 * deposits is tagged with. Lives HERE rather than in `promotion-scan-step.ts` (which re-exports it,
 * so every existing import still resolves) because it is now part of the ADMISSION RULE, and the
 * admission rule must not import the module whose short-circuit it defines.
 */
export const MANAGED_SCAN_CONTROL_OBJECT_ID = "00000000-5ca4-4000-8000-000000000001";

/**
 * The ControlPlugin modules whose verdict IS a scan verdict — ADR-0020 §1's "org-pipeline scan
 * evidence remains a supported alternate ingress".
 *
 * `scan-result-control` and nothing else. The other two modules a control binding can name
 * (`control-runner.ts`'s `KNOWN_CONTROL_MODULES`) are deliberately absent and neither absence is an
 * oversight:
 *   * `webhook-control` — "POST to an operator-configured arbitrary URL and return whatever it
 *     says". Its evidence is an unvalidated remote payload; admitting it here is the bypass this
 *     module exists to close.
 *   * `github-check` — reports a commit's Check Runs. A green CI run is not a scan verdict, carries
 *     no digest binding, and says nothing about an artifact's vulnerabilities.
 *
 * Adding a module here GRANTS IT THE POWER TO AUTHORIZE A CROSS-BOUNDARY CROSSING. The bar is that
 * the module's evidence is produced by a scanner it controls, not echoed from a caller.
 */
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

/**
 * Per-severity MIN across the instance-scoped floor contributions (`readInstanceScanFloors`) — the
 * `platform` and `trust_domain` rungs of ADR-0016's chain, and ONLY those. Commutative and
 * associative like the resolver's own merge, so this is order-independent for the same reason
 * (ADR-0016 §4).
 */
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

/**
 * WHICH QUESTION THIS RUN IS AN ANSWER TO — the key supersession is computed over.
 *
 * For a BOUND control the question is the control: one binding fetches one verdict, so its newest
 * run is its current answer. That is the same identity `latestControlRun` uses everywhere else in
 * the system, which is why a re-run genuinely supersedes rather than accumulating.
 *
 * For the COMMANDER'S STEP the control id is synthetic and MULTIPLEXES methods — one export deposits
 * a `trivy` row and an `openscap` row under the same id — so the question is (step, method). Keying
 * on the control alone there would make the gate ORDER-DEPENDENT in the worst possible direction: a
 * `trivy` pass and an `openscap` fail for the same digest are written milliseconds apart, and
 * whichever the loop happened to write second would decide the crossing. With the method in the key,
 * both are consulted and both must pass.
 *
 * A managed row always carries `evidence.scanner` (the step `ScanEvidenceSchema.parse`s before
 * depositing, and deposits nothing when a runner fails), so the `""` fallback is unreachable for an
 * authentic deposit and merely keeps this total.
 */
function questionKey(run: ScanRunLike): string {
  if (run.controlObjectId === MANAGED_SCAN_CONTROL_OBJECT_ID) {
    const scanner = typeof run.evidence.scanner === "string" ? run.evidence.scanner : "";
    return `${run.controlObjectId}::${scanner}`;
  }
  return run.controlObjectId;
}

/**
 * WHICH PROMOTED DIGEST THIS RUN IS ABOUT — read from `evidence.expectedDigest`, the field whose
 * documented meaning is exactly "the digest the change is promoting, the value `artifactDigest` was
 * bound against".
 *
 * Read off the RAW evidence bag rather than a parsed `ScanEvidence`, deliberately: a FAILING run is
 * frequently unparseable (`scan-result-control`'s `fail()` emits `{url, expectedDigest}` and similar
 * partial bags), and a failure that cannot be attributed to the artifact it is about cannot supersede
 * the stale pass it should be superseding. Attribution has to survive the failure, or property 2 only
 * works for the runs that succeeded.
 */
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

export type ScanCoverageRefusalCode =
  | "no_scan_outcome"
  | "not_passing"
  | "malformed_evidence"
  | "not_digest_bound"
  | "below_instance_floor";

export type ScanCoverage =
  | { covered: true; run: ScanRunLike; evidence: ScanEvidence }
  | {
      covered: false;
      code: ScanCoverageRefusalCode;
      reason: string;
      detail: Record<string, unknown>;
    };

/**
 * Does `digest` carry a current, digest-bound, floor-satisfying scan outcome from an admitted
 * producer? THE rule — see the module doc for why each of the four narrowings exists.
 *
 * FAIL-CLOSED IN EVERY DIRECTION: no admitted producer, a producer whose newest answer is anything
 * but `pass`, evidence that no longer parses, a verdict bound to a different artifact, or counts
 * above the operator's floor all refuse. "Absent never means passed."
 */
export function evaluateScanCoverage(args: {
  digest: string;
  runs: readonly ScanRunLike[];
  instanceFloor: SeverityCeiling;
}): ScanCoverage {
  const { digest, runs, instanceFloor } = args;

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
    // ADR-0033 §2 COMPATIBILITY — when per-finding exclusions land, the number compared here must
    // become the POST-exclusion `effectiveSeverityCounts`, not `severityCounts` (which ADR-0033
    // deliberately keeps meaning "what the scanner found"). Reading the raw count then would make
    // every admitted exclusion invisible at this boundary and refuse crossings the grant authorized —
    // the mirror image of the invisibility ADR-0033 §2 rejected a verdict-level waiver for. This is
    // the one line that changes.
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
