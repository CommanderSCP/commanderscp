import {
  scanFindingRetentionClass,
  scanFindingsRecordFor,
  type CappedScanFindings,
  type ScanFindingsRecord,
  type ScanMethod
} from "@scp/schemas";
import { scanFindings } from "../db/schema.js";
import type { TenantTx } from "../db/tenant-tx.js";

/**
 * M22.1b (ADR-0033 §7) — THE ONE WRITER of `scan_findings` (migration 0065).
 *
 * A scan verdict was four integers until M22.1a; every rule in ADR-0033 is a rule about a FINDING,
 * so this is what makes the rest of M22 expressible. Both verdict producers funnel through here:
 *
 *   - `federation/promotion-scan-step.ts` — the commander's own managed scan. It runs server-side
 *     and already has the parsed findings in hand, so it passes them straight through.
 *   - `governance/control-runner.ts` — the `scan-result-control` ControlPlugin. That plugin runs in
 *     the subprocess plugin host with NO `DATABASE_URL` and cannot write anything; it transports its
 *     capped findings out on `ControlOutcome.evidence` and the SERVER persists them here, stripping
 *     the transport key on the way (`takeScanFindingsFromTransport`) so nothing lands on the
 *     `control_runs.evidence` column that federation copies verbatim into a promotion bundle.
 *
 * WHAT THIS FUNCTION REFUSES, and why the refusal lives here rather than at each caller:
 *
 *   1. A method whose verdicts STRUCTURALLY CANNOT decompose into findings (OpenSCAP — XCCDF
 *      rule-results have no package, no purl, no `FixedVersion`, no `Class`, and XCCDF emits no
 *      `critical` at all). It writes NOTHING and reports `unsupported`, decided from the METHOD
 *      before the payload is examined. ADR-0033's consequences list is explicit that this must be
 *      "explicit and tested, not left to 'there were no findings to exclude'" — so the refusal
 *      survives even when a caller hands it a non-empty array.
 *   2. A producer that transported no findings at all (a pre-M22.1b plugin, a malformed payload).
 *      Reports `undefined` — an ABSENT marker, indistinguishable from every scan recorded before
 *      this increment, which consumers must refuse exclusions for exactly as they do a truncated
 *      set.
 *
 * THE RETURNED MARKER IS NOT THIS FUNCTION'S OPINION. It comes from the pure
 * `scanFindingsRecordFor`, which each caller ALSO calls to stamp `evidence.findingsRecord` before
 * inserting the control run — because the marker has to be on the row at INSERT time while the rows
 * here need the control run's id, which only exists after it. One pure function decides both, in one
 * transaction, so "the evidence says full, the table says otherwise" is not a reachable state.
 *
 * M22.2 OWES THE READER, and it owes it a specific shape: whatever loads these rows must hand back
 * the marker WITH them, never the rows alone. Every marker state except `full` — `truncated`,
 * `unsupported`, and ABSENT — refuses every exclusion for that scan ("you cannot except what you
 * did not record"), and a loader that returns a bare array is one a caller can use without ever
 * learning that.
 */
export interface PersistScanFindingsInput {
  orgId: string;
  /** The `control_runs` row this verdict was deposited as — the unit an exclusion resolves for. */
  controlRunId: string;
  /** WHAT SCANNED. Decides the `unsupported` refusal before the payload is looked at. */
  method: ScanMethod;
  /** The producer's findings, already capped at `SCAN_FINDINGS_PERSIST_CAP` with truncation
   *  recorded. `undefined` when the producer transported none. */
  capped: CappedScanFindings | undefined;
  /**
   * M22.2 (ADR-0033 D10, ADR-0024 §D1) — the positions an admitted exclusion clause EXCLUDED.
   *
   * These rows are written at retention class `E` instead of `O`, and the split is the whole point
   * of assigning a class per row: an excluded finding is ACCEPTED-RISK EVIDENCE that explains a live
   * verdict and records what an operator chose to tolerate, so it must outlive the short telemetry
   * window an ordinary finding gets. Collapsing the two classes would either keep every finding
   * forever (this is the highest-cardinality table in the system) or discard the only per-finding
   * record of why a promotion was allowed.
   *
   * The DECIDER is upstream, never here: the plugin (or the promotion scan step) applied the clauses
   * against a gate context this transaction no longer holds, so re-deriving the set here is not
   * possible and guessing it would be worse.
   */
  excludedOrdinals?: readonly number[];
}

export async function persistScanFindings(
  tx: TenantTx,
  input: PersistScanFindingsInput
): Promise<ScanFindingsRecord | undefined> {
  const record = scanFindingsRecordFor(input.method, input.capped);
  // `unsupported` and ABSENT both write nothing. Note this is NOT `capped.findings.length === 0`:
  // a trivy scan that genuinely found nothing is a `full` record of an empty set, which is a
  // materially different claim from "this scanner cannot have findings", and only the marker
  // distinguishes them.
  if (record !== "full" && record !== "truncated") return record;
  const findings = input.capped?.findings ?? [];
  if (findings.length === 0) return record;

  const excluded = new Set(input.excludedOrdinals ?? []);
  await tx.insert(scanFindings).values(
    findings.map((f, ordinal) => ({
      orgId: input.orgId,
      controlRunId: input.controlRunId,
      // Position in the producing parser's order IS the identity — a finding has no other one (the
      // same CVE recurs once per affected package, and an entry with no `VulnerabilityID` is still
      // counted, so requiring one would drop it and move an operator's numbers).
      ordinal,
      severity: f.severity,
      vulnerabilityId: f.vulnerabilityId ?? null,
      pkgName: f.pkgName ?? null,
      installedVersion: f.installedVersion ?? null,
      fixedVersion: f.fixedVersion ?? null,
      class: f.class ?? null,
      target: f.target ?? null,
      purl: f.purl ?? null,
      // ADR-0024 §D1 class, assigned PER ROW at write time (ADR-0033 D10). `E` for a finding an
      // admitted exclusion clause tolerated — accepted-risk evidence explaining a LIVE verdict — and
      // `O` for every other, which is telemetry about what a scanner saw. Assigned at INSERT rather
      // than by a later UPDATE, because the exclusion decision is made in the same call that
      // produced these rows and a two-step would leave a window where the row's class contradicts
      // the evidence beside it.
      retentionClass: scanFindingRetentionClass(excluded.has(ordinal))
    }))
  );
  return record;
}
