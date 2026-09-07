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

/** The one writer of the scan findings table. See docs/governance.md §335. */
export interface PersistScanFindingsInput {
  orgId: string;
  /** The `control_runs` row this verdict was deposited as — the unit an exclusion resolves for. */
  controlRunId: string;
  /** WHAT SCANNED. Decides the `unsupported` refusal before the payload is looked at. */
  method: ScanMethod;
  /** The producer's findings, already capped at `SCAN_FINDINGS_PERSIST_CAP` with truncation
   *  recorded. `undefined` when the producer transported none. */
  capped: CappedScanFindings | undefined;
  /** The positions an admitted exclusion clause excuses. See docs/governance.md §336. */
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
      // ADR-0024 §D1 class, assigned PER ROW at write time. See docs/governance.md §337.
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

/** Reading the rows this file writes, as the writer promises. See docs/governance.md §338. */
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
