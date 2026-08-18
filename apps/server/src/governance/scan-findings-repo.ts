import { and, asc, eq, gt } from "drizzle-orm";
import {
  ScanEvidenceSchema,
  scanFindingRetentionClass,
  scanFindingsRecordFor,
  type CappedScanFindings,
  type ScanFinding,
  type ScanFindingRetentionClass,
  type ScanFindingsRecord,
  type ScanMethod
} from "@scp/schemas";
import { controlRuns, scanFindings } from "../db/schema.js";
import type { TenantTx } from "../db/tenant-tx.js";

/**
 * M22.1b (ADR-0033 §7) — THE ONE WRITER of `scan_findings` (migration 0073).
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
 * THE READER THIS DEMANDED IS `loadScanFindings` BELOW, and it has the shape demanded: it hands back
 * the marker WITH the rows, never the rows alone. Every marker state except `full` — `truncated`,
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

/** One persisted row on the way back out. `ScanFinding` is what the PARSER produced; `ordinal` and
 *  `retentionClass` are what the WRITE decided, so they exist nowhere but the table. */
export interface PersistedScanFinding extends ScanFinding {
  ordinal: number;
  retentionClass: ScanFindingRetentionClass;
}

export interface LoadedScanFindings {
  /** The control run's own `evidence.findingsRecord`. `undefined` is the ABSENT state — a REFUSAL,
   *  not a missing value. See `loadScanFindings`. */
  record: ScanFindingsRecord | undefined;
  findings: PersistedScanFinding[];
  nextCursor: string | null;
}

/**
 * M22.9 — READING the rows this file writes, and the reader the writer's docblock demanded.
 *
 * WHAT WAS TRUE BEFORE THIS FUNCTION, stated plainly because the conclusion it invites is nearly the
 * wrong one: `persistScanFindings` had two call sites, both discarded its return, and the only reads
 * of `scan_findings` anywhere in the tree were integration tests. Both producers resolve exclusions
 * against the IN-MEMORY array, so deleting the writer would have left production behaviour
 * byte-identical — and "therefore it is dead code, hold it out of the merge" is wrong.
 * `SCAN_EXCLUSION_EVIDENCE_CAP` (100) bounds the per-clause enumeration on `evidence.exclusions`
 * while `appliedCount` stays EXACT, so past 100 exclusions these class-`E` rows are the only
 * per-finding record of what an operator chose to tolerate — the accepted-risk evidence ADR-0033 D10
 * requires under charter principle 6. Removing the writer would have deleted an audit record. What
 * was actually missing was this.
 *
 * It is also NOT the `decisions` write-amplification shape, which is what a write-only
 * activity-proportional table looks like from a distance. That was ONE byte-identical row rewritten
 * every reconcile tick on an IDLE system (99.94% duplicates, ADR-0024 §Context); these rows are
 * distinct per finding and are written once per real gate crossing. The retention story is still
 * owed, and migration 0073's header says exactly what bounds the table until ADR-0024's generic
 * prune lands — deliberately no bespoke sweeper here (charter priority 7, Simplicity first).
 *
 * THE MARKER COMES BACK WITH THE ROWS AND CANNOT BE OMITTED, because every state except `full` —
 * `truncated`, `unsupported`, ABSENT — refuses every exclusion for that scan, and a caller handed a
 * bare array can never learn that. `record: undefined` covers two situations that a consumer must
 * treat identically and does not need to distinguish: no marker was written (every pre-M22.1b
 * verdict), or the run's evidence does not parse as scan evidence at all (any non-scan control). The
 * parse is `ScanEvidenceSchema`, the same whole-document parse the E6 export gate already applies to
 * this column, so a document those two would read differently is not reachable.
 *
 * `undefined` for the whole result means NO SUCH CONTROL RUN is visible in this org — distinct from
 * a run with zero findings, which is `{ record, findings: [], nextCursor: null }`.
 *
 * PAGING IS NOT OPTIONAL. `SCAN_FINDINGS_PERSIST_CAP` is 2000 rows per run and M22.0a made several
 * runs per change the norm, so an unbounded load is a footgun on the only surface that has this
 * data; the caller must pass a limit.
 */
export async function loadScanFindings(
  tx: TenantTx,
  orgId: string,
  controlRunId: string,
  page: { cursor?: string | undefined; limit: number }
): Promise<LoadedScanFindings | undefined> {
  const [run] = await tx
    .select({ evidence: controlRuns.evidence })
    .from(controlRuns)
    .where(and(eq(controlRuns.orgId, orgId), eq(controlRuns.id, controlRunId)))
    .limit(1);
  if (!run) return undefined;
  const evidence = ScanEvidenceSchema.safeParse(run.evidence);
  const record = evidence.success ? evidence.data.findingsRecord : undefined;

  // A malformed cursor pages from the START rather than throwing — same choice `decodeSeqCursor`
  // makes in audit-repo.ts. It cannot loop an SDK `listAll*` iterator, because `ordinal` is a total
  // order with no ties and the keyset is strictly `>`.
  const after = page.cursor ? decodeOrdinalCursor(page.cursor) : null;
  const conditions = [eq(scanFindings.orgId, orgId), eq(scanFindings.controlRunId, controlRunId)];
  if (after !== null) conditions.push(gt(scanFindings.ordinal, after));

  const rows = await tx
    .select()
    .from(scanFindings)
    .where(and(...conditions))
    // ORDINAL, not `created_at`: every row of one scan is inserted in a single statement and shares
    // a timestamp to the microsecond, so the shared `(created_at, id)` keyset codec would tie on
    // every row. Ordinal is the identity here (0073), and it is already the primary key's own tail.
    .orderBy(asc(scanFindings.ordinal))
    .limit(page.limit + 1);

  const hasMore = rows.length > page.limit;
  const items = hasMore ? rows.slice(0, page.limit) : rows;
  const last = items[items.length - 1];
  return {
    record,
    findings: items.map(toPersistedScanFinding),
    nextCursor: hasMore && last ? encodeOrdinalCursor(last.ordinal) : null
  };
}

/** NULL columns are DROPPED, not forwarded as `null`. `ScanFindingSchema`'s attribution fields are
 *  `.optional()` and never nullable — the column is nullable because a finding is retained on
 *  `Severity` alone — so a `null` on the wire would fail the response schema this feeds. */
function toPersistedScanFinding(row: typeof scanFindings.$inferSelect): PersistedScanFinding {
  return {
    ordinal: row.ordinal,
    // Cast, not parse: the DB CHECK constraints on both columns are what constrain these values, the
    // same reasoning `ControlRunRow` records for its own loosely-typed `gate_kind`.
    severity: row.severity as ScanFinding["severity"],
    retentionClass: row.retentionClass as ScanFindingRetentionClass,
    ...(row.vulnerabilityId !== null ? { vulnerabilityId: row.vulnerabilityId } : {}),
    ...(row.pkgName !== null ? { pkgName: row.pkgName } : {}),
    ...(row.installedVersion !== null ? { installedVersion: row.installedVersion } : {}),
    ...(row.fixedVersion !== null ? { fixedVersion: row.fixedVersion } : {}),
    ...(row.class !== null ? { class: row.class } : {}),
    ...(row.target !== null ? { target: row.target } : {}),
    ...(row.purl !== null ? { purl: row.purl } : {})
  };
}

function encodeOrdinalCursor(ordinal: number): string {
  return Buffer.from(JSON.stringify({ ordinal })).toString("base64url");
}

function decodeOrdinalCursor(cursor: string): number | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (typeof parsed === "object" && parsed !== null && "ordinal" in parsed) {
      const ordinal = (parsed as { ordinal: unknown }).ordinal;
      if (typeof ordinal === "number" && Number.isInteger(ordinal) && ordinal >= 0) return ordinal;
    }
    return null;
  } catch {
    return null;
  }
}
