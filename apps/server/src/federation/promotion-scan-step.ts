import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ScanEvidenceSchema,
  ScanSeverityCountsSchema,
  applyScanExclusions,
  capScanFindings,
  effectiveSeverityCountsAfterExclusions,
  parseTrivyFindings,
  scanFindingsRecordFor,
  severityCountsFromFindings,
  ExecutorTypeSchema,
  usesTrivyDb,
  type CappedScanFindings,
  type ScanFinding,
  type ScanMethod,
  type ScanSeverityCounts,
  type ScanThreshold,
  type EffectiveScanThreshold,
  type ScanDbSource,
  type ScanDbStalenessClass,
  type ScanDbThresholdFired,
  type EffectiveScanExclusions
} from "@scp/schemas";
import { resolveSkopeo } from "@scp/cosign";
import { ociLayout as airgapOciLayout } from "@scp/airgap";
import { createManagedScanExecutorPlugin } from "@scp/plugin-managed-scan";
import type { PluginContext } from "@scp/plugin-api";
import type { Db } from "../db/client.js";
import { withTenantTx, type TenantTx } from "../db/tenant-tx.js";
import { getChange } from "../coordination/changes-repo.js";
import { ociDigestsOfSourceRef } from "../coordination/artifact-facts.js";
import { appendAuditEvent } from "../audit/audit-repo.js";
import {
  insertControlRun,
  listControlRunsForChange,
  type ControlRunRow
} from "../governance/controls-repo.js";
import { persistScanFindings } from "../governance/scan-findings-repo.js";
import { resolveScannersForType } from "../governance/scanner-registry.js";
import {
  resolveEffectiveScanExclusionsForTargets,
  resolveEffectiveScanThreshold,
  readInstanceScanFloors
} from "../governance/scan-requirements.js";
import {
  evaluateScanCoverage,
  mergeInstanceFloor,
  MANAGED_SCAN_CONTROL_OBJECT_ID,
  type SeverityCeiling
} from "./scan-evidence.js";
import { resolveFiredPoliciesForTargets } from "../governance/gate-orchestrator.js";
import type { MatchedPolicy } from "../governance/policy-model.js";
import type { FiredPolicy } from "../governance/evaluate.js";
import { getSharedCelSandbox, type CelSandbox } from "../governance/cel-sandbox.js";
import { readScanDbStatus } from "../governance/scan-db.js";
import { scanExclusionSetHash } from "../governance/scan-exclusion-actuator.js";
import {
  managedRunnerSettings,
  managedScanServerSettings
} from "../coordination/executor-bindings-repo.js";
import {
  bindOciRefToAuthorizedDigest,
  normalizeSha256Digest,
  ociRegistryHostOf,
  parseRegistryHostList
} from "./artifact-verify.js";

/** THE COMMANDER-SIDE PROMOTION SCAN STEP. See docs/federation.md §429. */

const execFileAsync = promisify(execFile);

/** The well-known object id tagging every row this step writes. See docs/federation.md §430. */
export { MANAGED_SCAN_CONTROL_OBJECT_ID };

/** The scan methods the runner image can actually run. See docs/federation.md §431. */
export const RUNNER_SUPPORTED_METHODS: ReadonlySet<ScanMethod> = new Set<ScanMethod>([
  "trivy",
  "trivy-vm",
  "openscap"
]);

// --- Injected scan dependency (so the step is hermetically testable without Docker) -------------

/** One managed scan the step asks the runner to perform, fully server-resolved. */
export interface ManagedScanRequest {
  method: ScanMethod;
  /** The promoted digest (`sha256:<hex>`), authoritative — what the pull is bound to. */
  digest: string;
  /** The registry reference the SERVER pulls (allowlist-guarded), or `null` when unresolvable. */
  pullRef: string | null;
  /** OpenSCAP only — the XCCDF profile id to evaluate (server-resolved; see `resolveOscapProfile`).
   *  Ignored for trivy. */
  profile?: string;
  /** OpenSCAP only — the absolute path (inside the runner image) of the SSG datastream to evaluate
   *  against (server-resolved; see `resolveOscapDatastream`). Ignored for trivy. */
  datastream?: string;
}

/** What a runner returns — the distilled counts + the digest it actually scanned. */
export interface ManagedScanReport {
  scannedDigest: string;
  scannerVersion: string;
  severityCounts: ScanSeverityCounts;
  /** The per-finding detail the counts were derived from. See docs/federation.md §432. */
  findings?: readonly ScanFinding[];
  /** M13.3b-ii — the scanner DB this verdict was produced against (trivy only; OpenSCAP uses baked
   *  SSG). Surfaced into the ScanEvidence so a Decision can explain the DB's provenance + freshness.
   *  Only a scannable DB (`fresh`/`warn`) yields a report at all — a hard-fail/missing/corrupt DB
   *  fails the scan closed upstream. */
  scanDb?: {
    source: ScanDbSource;
    ageHours?: number;
    staleness: ScanDbStalenessClass;
    thresholdFired: ScanDbThresholdFired;
  };
}

export type ManagedScanResult =
  { ok: true; report: ManagedScanReport } | { ok: false; reason: string };

export interface ManagedScanRunner {
  scan(req: ManagedScanRequest): Promise<ManagedScanResult>;
}

// --- The E6 short-circuit predicate (THE SAME CODE as promotion-repo.ts's gate check) ------------

/** True when the digest already carries an acceptable outcome. See docs/federation.md §433. */
function isCoveringScanOutcome(
  runs: readonly ControlRunRow[],
  digest: string,
  instanceFloor: SeverityCeiling,
  /** M22.9 — the exclusion set in force on THIS pass; a covering pass judged under any other one is
   *  not covering. Passed unconditionally (never conditionally spread): `undefined` here is the
   *  meaningful value "no clause is in force now", and a run stamped with a hash must not survive
   *  the withdrawal of every clause that produced it. */
  expectedExclusionSetHash: string | undefined
): boolean {
  return evaluateScanCoverage({ digest, runs, instanceFloor, expectedExclusionSetHash }).covered;
}

// --- Artifact + pull-ref resolution from the change's sourceRef ----------------------------------

interface ScanSubject {
  digest: string;
  pullRef: string | null;
  executorType: string;
  /** OpenSCAP profile+datastream resolved for this artifact (only used when a method is `openscap`). */
  oscapProfile: string;
  oscapDatastream: string;
}

// --- OpenSCAP profile/datastream resolution. See docs/federation.md §434.

const DEFAULT_OSCAP_PROFILE = "xccdf_org.ssgproject.content_profile_standard";
const DEFAULT_OSCAP_DATASTREAM = "/usr/share/xml/scap/ssg/content/ssg-fedora-ds.xml";

function resolveOscapProfile(sourceRef: Record<string, unknown>): string {
  const env = process.env.SCP_MANAGED_SCAN_OPENSCAP_PROFILE;
  if (env && env.trim().length > 0) return env.trim();
  const hint = sourceRef.scanProfile;
  if (typeof hint === "string" && hint.trim().length > 0) return hint.trim();
  return DEFAULT_OSCAP_PROFILE;
}

function resolveOscapDatastream(sourceRef: Record<string, unknown>): string {
  const env = process.env.SCP_MANAGED_SCAN_OPENSCAP_DATASTREAM;
  if (env && env.trim().length > 0) return env.trim();
  const hint = sourceRef.scanDatastream;
  if (typeof hint === "string" && hint.trim().length > 0) return hint.trim();
  return DEFAULT_OSCAP_DATASTREAM;
}

/** Extract the OCI artifact digests the change promotes — the SHARED reader (`ociDigestsOfSourceRef`,
 *  `coordination/artifact-facts.ts`: `sourceRef.artifact_digest` / `artifactDigest` / the importer's
 *  `artifactDigests[]`, the same keys the export projection and the pipeline tile read), then
 *  NORMALIZED to `sha256:<hex>` because this step must build a pull ref from each. */
function ociDigestsOf(sourceRef: Record<string, unknown>): string[] {
  const list = ociDigestsOfSourceRef(sourceRef);
  const out: string[] = [];
  for (const d of list) {
    const norm = normalizeSha256Digest(d);
    if (norm) out.push(norm);
  }
  return out;
}

/** Resolve the registry reference to pull a promoted digest from — the artifact's own recorded
 *  `location`/`image` (source-of-truth), else the operator fallback repo `SCP_MANAGED_SCAN_SOURCE_REPO`,
 *  else `null` (unresolvable ⇒ no managed evidence ⇒ E6 refuses, fail-closed). */
function resolvePullRef(sourceRef: Record<string, unknown>, digest: string): string | null {
  const explicit =
    (typeof sourceRef.artifactLocation === "string" && sourceRef.artifactLocation) ||
    (typeof sourceRef.image === "string" && sourceRef.image) ||
    (typeof sourceRef.artifactRepo === "string" && sourceRef.artifactRepo) ||
    "";
  const repoBase =
    explicit && explicit.length > 0
      ? explicit.replace(/[@:][^/]*$/, "")
      : (process.env.SCP_MANAGED_SCAN_SOURCE_REPO ?? "");
  if (!repoBase) return null;
  return `${repoBase}@${digest}`;
}

/** The artifact's ExecutorType for scanner selection. See docs/federation.md §435. */
function executorTypeOf(change: { properties: Record<string, unknown> }): string {
  const parsed = ExecutorTypeSchema.safeParse(change.properties.type);
  return parsed.success ? parsed.data : "image";
}

// --- Threshold → applied ScanThreshold (fail-closed default 0/0) ---------------------------------

function applyThreshold(effective: EffectiveScanThreshold | undefined): {
  threshold: ScanThreshold;
  source: "scoped" | "default";
} {
  const t = effective?.threshold ?? {};
  const threshold: ScanThreshold = {
    maxCritical: t.maxCritical ?? 0,
    maxHigh: t.maxHigh ?? 0,
    ...(t.maxMedium !== undefined ? { maxMedium: t.maxMedium } : {}),
    ...(t.maxLow !== undefined ? { maxLow: t.maxLow } : {})
  };
  return { threshold, source: effective ? "scoped" : "default" };
}

function breaches(counts: ScanSeverityCounts, threshold: ScanThreshold): boolean {
  if (counts.critical > threshold.maxCritical) return true;
  if (counts.high > threshold.maxHigh) return true;
  if (threshold.maxMedium !== undefined && counts.medium > threshold.maxMedium) return true;
  if (threshold.maxLow !== undefined && counts.low > threshold.maxLow) return true;
  return false;
}

export interface RunPromotionScanStepInput {
  orgId: string;
  changeIdOrUrn: string;
  actorObjectId: string;
}

interface PlannedScan {
  subject: ScanSubject;
  methods: ScanMethod[];
}

interface DepositRow {
  changeObjectId: string;
  status: "pass" | "fail";
  evidence: Record<string, unknown>;
  detail: string;
  method: ScanMethod;
  digest: string;
  /** M22.1b — the findings to project into `scan_findings` once this deposit has a control-run id.
   *  Carried on the deposit rather than re-derived in phase C, because phase B is where the scan
   *  actually happened. */
  capped: CappedScanFindings | undefined;
  /** M22.2 — which of them an admitted clause excluded, so phase C writes those rows at ADR-0024
   *  retention class `E` (accepted-risk evidence) rather than `O` (telemetry). */
  excludedOrdinals: number[];
}

/** THE EXCLUSION SET IN FORCE FOR A CHANGE. See docs/federation.md §436. */
export async function resolveScanExclusionsForChange(
  tx: TenantTx,
  input: {
    orgId: string;
    change: { id: string; properties: Record<string, unknown>; emergency: boolean };
    actorObjectId: string;
  },
  /** Test seam ONLY — see `runPromotionScanStep`. */
  sandbox?: Pick<CelSandbox, "evaluate">
): Promise<{
  targetObjectIds: string[];
  matches: MatchedPolicy[];
  fired: FiredPolicy[];
  exclusions: EffectiveScanExclusions | undefined;
  /** `undefined` when nothing was admitted — the value that keeps a deployment with no authored
   *  exclusion byte-identical to pre-M22 at both consumers. */
  exclusionSetHash: string | undefined;
}> {
  const targetObjectIds = Array.isArray(input.change.properties.targets)
    ? (input.change.properties.targets as unknown[]).filter(
        (t): t is string => typeof t === "string"
      )
    : [];
  const lazySandbox: Pick<CelSandbox, "evaluate"> = {
    evaluate: (expression, context) =>
      (sandbox ?? getSharedCelSandbox()).evaluate(expression, context)
  };
  const { matches, fired } = await resolveFiredPoliciesForTargets(tx, lazySandbox, {
    orgId: input.orgId,
    changeObjectId: input.change.id,
    targetObjectIds,
    actorObjectId: input.actorObjectId,
    emergency: input.change.emergency,
    now: new Date()
  });
  // Resolved server-side rather than threaded through a plugin context: the managed producer has no
  // plugin to thread one to — it parses the Trivy result itself in phase B.
  const exclusions = await resolveEffectiveScanExclusionsForTargets(tx, {
    orgId: input.orgId,
    targetObjectIds,
    actorObjectId: input.actorObjectId,
    matches,
    firedPolicies: fired
  });
  return {
    targetObjectIds,
    matches,
    fired,
    exclusions,
    exclusionSetHash: scanExclusionSetHash(exclusions)
  };
}

/** A `runner.scan()` call that itself never produced a report. See docs/federation.md §437. */
interface RunnerFailure {
  method: ScanMethod;
  digest: string;
  reason: string;
}

/** Runs the commander's promotion scan step for one change. See docs/federation.md §438. */
export async function runPromotionScanStep(
  db: Db,
  input: RunPromotionScanStepInput,
  runner: ManagedScanRunner,
  /** Test seam ONLY. Production passes nothing and the shared sandbox is constructed on first use
   *  (and only if a policy contributor actually carries a CEL `condition`). */
  sandbox?: Pick<CelSandbox, "evaluate">
): Promise<void> {
  // Phase A (tx, read-only): gather the plan — which artifacts still need a managed scan, with what
  // methods, and the effective threshold. Pure DB; no subprocess runs while a connection is held.
  const plan = await withTenantTx(db, input.orgId, async (tx) => {
    const change = await getChange(tx, input.orgId, input.changeIdOrUrn);
    const sourceRef = change.sourceRef ?? {};
    const digests = ociDigestsOf(sourceRef as Record<string, unknown>);
    if (digests.length === 0) return null; // metadata-only promotion — nothing to scan.

    const existingRuns = await listControlRunsForChange(tx, input.orgId, change.id);
    // The same operator floor E6 will apply — read here so the short-circuit and the gate reach the
    // same verdict on the same rows (see `isCoveringScanOutcome`).
    const instanceFloor = mergeInstanceFloor(await readInstanceScanFloors(tx));
    const executorType = executorTypeOf(change as { properties: Record<string, unknown> });
    const methods = await resolveScannersForType(tx, executorType);

    // M22.2 + M22.9 — the firing set and the exclusion dimension, resolved through the function the
    // E6 gate now calls too, so the set this step APPLIES and the set that gate CHECKS against are
    // built from one assembly of inputs (see `resolveScanExclusionsForChange`).
    const { targetObjectIds, matches, fired, exclusions, exclusionSetHash } =
      await resolveScanExclusionsForChange(
        tx,
        { orgId: input.orgId, change, actorObjectId: input.actorObjectId },
        sandbox
      );

    const effective = await resolveEffectiveScanThreshold(tx, {
      orgId: input.orgId,
      targetObjectIds,
      actorObjectId: input.actorObjectId,
      matches,
      firedPolicies: fired
    });

    const planned: PlannedScan[] = [];
    for (const digest of digests) {
      // (a) SHORT-CIRCUIT — CURRENT org-pipeline. See docs/federation.md §439.
      if (isCoveringScanOutcome(existingRuns, digest, instanceFloor, exclusionSetHash)) continue;
      // (b) scanner selection — an unassigned type yields no methods ⇒ no managed evidence.
      if (methods.length === 0) continue;
      planned.push({
        subject: {
          digest,
          pullRef: resolvePullRef(sourceRef as Record<string, unknown>, digest),
          executorType,
          oscapProfile: resolveOscapProfile(sourceRef as Record<string, unknown>),
          oscapDatastream: resolveOscapDatastream(sourceRef as Record<string, unknown>)
        },
        methods
      });
    }
    return { changeId: change.id, planned, effective, exclusions, exclusionSetHash };
  });

  if (!plan || plan.planned.length === 0) return;

  const { threshold, source } = applyThreshold(plan.effective);
  // M22.7 — hashed ONCE for the whole step: every deposit below was produced under the one set phase
  // A resolved, so a per-deposit recomputation could only ever introduce a way for them to differ.
  // M22.9 moved the hashing itself INTO phase A (the short-circuit needs it); this reads that one
  // value rather than re-deriving it, for the same reason.
  const exclusionSetHash = plan.exclusionSetHash;

  // Phase B (no tx): pull + scan each planned artifact per method. Subprocesses (skopeo/docker) run
  // here, never while a pooled DB connection is held (the codebase-wide invariant, promotion-repo.ts).
  const deposits: DepositRow[] = [];
  const runnerFailures: RunnerFailure[] = [];
  for (const { subject, methods } of plan.planned) {
    for (const method of methods) {
      const result = await runner.scan({
        method,
        digest: subject.digest,
        pullRef: subject.pullRef,
        ...(method === "openscap"
          ? { profile: subject.oscapProfile, datastream: subject.oscapDatastream }
          : {})
      });
      if (!result.ok) {
        // Runner/dispatch unavailable, or an unresolvable pull ref. See docs/federation.md §440.
        runnerFailures.push({ method, digest: subject.digest, reason: result.reason });
        continue;
      }
      const { report } = result;
      const scannedDigest = normalizeSha256Digest(report.scannedDigest) ?? report.scannedDigest;
      const digestMatch = scannedDigest === subject.digest;
      // WHAT THE SCANNER FOUND — unchanged, and it keeps that meaning (operators author CEL
      // conditions against `evidence.severityCounts.*`).
      const severityCounts = ScanSeverityCountsSchema.parse(report.severityCounts);

      // Caps the set to persist, one function deciding the marker. See docs/federation.md §441.
      const capped = report.findings ? capScanFindings(report.findings) : undefined;
      const findingsRecord = scanFindingsRecordFor(method, capped);

      // M22.2 — EXCLUDE BEFORE COUNTING. See docs/federation.md §442.
      const applied = applyScanExclusions(capped?.findings ?? [], plan.exclusions, findingsRecord);
      const effectiveCounts = effectiveSeverityCountsAfterExclusions(
        severityCounts,
        applied,
        capped?.findings ?? []
      );
      // ONLY the threshold comparison reads the post-exclusion number.
      const overThreshold = breaches(effectiveCounts, threshold);
      const status: "pass" | "fail" = digestMatch && !overThreshold ? "pass" : "fail";

      const evidence = ScanEvidenceSchema.parse({
        scanner: method,
        scannerVersion: report.scannerVersion || "unknown",
        artifactDigest: scannedDigest,
        expectedDigest: subject.digest,
        digestMatch,
        severityCounts,
        ...(findingsRecord ? { findingsRecord } : {}),
        // Written ONLY when the gate resolved at least one admitted clause, so a deployment with
        // nothing authored deposits a byte-identical evidence document to pre-M22.2.
        ...(applied.evidence
          ? { effectiveSeverityCounts: effectiveCounts, exclusions: applied.evidence }
          : {}),
        // The same stamp a plugin-produced verdict gets. See docs/federation.md §443.
        ...(exclusionSetHash ? { exclusionSetHash } : {}),
        threshold,
        thresholdSource: source,
        ...(plan.effective ? { thresholdContributors: plan.effective.contributors } : {}),
        ...(report.scanDb
          ? {
              scanDbSource: report.scanDb.source,
              ...(report.scanDb.ageHours !== undefined
                ? { scanDbAgeHours: report.scanDb.ageHours }
                : {}),
              scanDbStaleness: report.scanDb.staleness,
              scanDbThresholdFired: report.scanDb.thresholdFired
            }
          : {})
      });

      // Surface a soft-stale (WARN) DB in the deposited detail so the Decision reads it (owner
      // 2026-07-24: a warn scans but is never silent).
      // Name the exclusions in the deposited detail — a verdict that reads "within threshold" while
      // a loosening decided it is exactly the coarse, unexplained waiver ADR-0033 §2 rejected.
      const exclusionNote = applied.evidence
        ? applied.evidence.refused
          ? ` [exclusions REFUSED: ${applied.evidence.refused}]`
          : applied.evidence.appliedCount > 0
            ? ` [${applied.evidence.appliedCount} exclusion(s) applied; scanner found critical=${severityCounts.critical}, high=${severityCounts.high}, medium=${severityCounts.medium}, low=${severityCounts.low}]`
            : ""
        : "";
      const dbWarn =
        report.scanDb && report.scanDb.staleness === "warn"
          ? ` [scan DB WARN: ${report.scanDb.source}, ${report.scanDb.ageHours?.toFixed(1) ?? "?"}h old, past soft max]`
          : "";
      const detail = !digestMatch
        ? `managed-scan (${method}): digest mismatch — scanned ${scannedDigest}, promoting ${subject.digest}${dbWarn}`
        : overThreshold
          ? `managed-scan (${method}): verdict exceeds threshold — critical=${effectiveCounts.critical}, high=${effectiveCounts.high}, medium=${effectiveCounts.medium}, low=${effectiveCounts.low}${exclusionNote}${dbWarn}`
          : `managed-scan (${method}): within threshold for ${scannedDigest} (critical=${effectiveCounts.critical}, high=${effectiveCounts.high})${exclusionNote}${dbWarn}`;

      deposits.push({
        changeObjectId: plan.changeId,
        status,
        evidence: evidence as unknown as Record<string, unknown>,
        detail,
        method,
        digest: subject.digest,
        capped,
        excludedOrdinals: applied.excludedOrdinals
      });
    }
  }

  if (deposits.length === 0 && runnerFailures.length === 0) return;

  // Phase C (tx, write): deposit the managed-scan control_runs rows the UNCHANGED E6 gate reads
  // next, AND record any runner failure as an audit event — same tx, same "written where the
  // action happened" discipline as every other audited action in this codebase (DESIGN.md §4.3).
  await withTenantTx(db, input.orgId, async (tx) => {
    for (const d of deposits) {
      const run = await insertControlRun(tx, {
        orgId: input.orgId,
        controlObjectId: MANAGED_SCAN_CONTROL_OBJECT_ID,
        changeObjectId: d.changeObjectId,
        gateKind: "lifecycle_edge",
        gateRef: { promotionScanStep: true, method: d.method, artifactDigest: d.digest },
        status: d.status,
        evidence: d.evidence,
        detail: d.detail
        // NO `pluginModule` (0063), deliberately: these rows are deposited under a SYNTHETIC control
        // id with no `control_bindings` row, so there is no module that produced them. NULL is the
        // honest answer and is what keeps a caller asking "what kind of evidence is this?" able to
        // tell a commander scan deposit apart from a bound plugin's verdict.
      });
      // Projects the findings, in the same transaction. See docs/federation.md §444.
      await persistScanFindings(tx, {
        orgId: input.orgId,
        controlRunId: run.id,
        method: d.method,
        capped: d.capped,
        excludedOrdinals: d.excludedOrdinals
      });
    }
    // NOT control_runs — a runner failure is not scan EVIDENCE (see RunnerFailure's doc); it is an
    // audit trail of WHY no evidence exists for this (method, digest), so a later "no passing
    // digest-bound evidence" E6 refusal is diagnosable instead of a bare fail-closed dead end.
    for (const f of runnerFailures) {
      await appendAuditEvent(tx, {
        orgId: input.orgId,
        actorId: input.actorObjectId,
        action: "federation.promotion.scan.runner_failed",
        subjectId: plan.changeId,
        reason: `managed-scan (${f.method}) for ${f.digest}: ${f.reason}`,
        requestId: `federation-promotion-scan:${plan.changeId}:${f.method}:${f.digest}`
      });
    }
  });
}

// --- The production runner: server-side skopeo pull (allowlisted, by digest) + managed-scan plugin -

function skopeoBin(): string {
  const resolved = resolveSkopeo();
  if (resolved.source === "missing") {
    throw new Error(
      "managed-scan: skopeo not available — the promotion scan step's server-side artifact pull " +
        "requires the vendored pinned skopeo (SCP_SKOPEO_BIN / PATH for dev)"
    );
  }
  return resolved.bin;
}

/** The operator OCI-registry allowlist (ADR-0019 §4). Empty ⇒ NO pull is permitted (fail-closed). */
function ociAllowlist(): string[] {
  return parseRegistryHostList(process.env.SCP_ARTIFACT_OCI_REGISTRY_HOSTS);
}

function insecureHosts(): Set<string> {
  return new Set(
    (process.env.SCP_ARTIFACT_INSECURE_HOSTS ?? "")
      .split(",")
      .map((h) => h.trim().toLowerCase())
      .filter((h) => h.length > 0)
  );
}

/** The default production `ManagedScanRunner`. See docs/federation.md §445. */
export function createServerManagedScanRunner(db?: Db): ManagedScanRunner {
  const plugin = createManagedScanExecutorPlugin();
  const settings = managedScanServerSettings();

  return {
    async scan(req: ManagedScanRequest): Promise<ManagedScanResult> {
      if (!settings.runnerImage) {
        return {
          ok: false,
          reason: "managed scanning is not enabled (SCP_MANAGED_SCAN_RUNNER_IMAGE unset)"
        };
      }
      if (!RUNNER_SUPPORTED_METHODS.has(req.method)) {
        return { ok: false, reason: `method '${req.method}' has no runner support` };
      }
      if (!req.pullRef) {
        return {
          ok: false,
          reason:
            "unresolvable pull ref — artifact carries no location and no SCP_MANAGED_SCAN_SOURCE_REPO fallback"
        };
      }

      // M13.3b-ii — OFFLINE DB PRE-LOAD + STALENESS GATE. See docs/federation.md §446.
      let scanDbDir: string | undefined;
      let scanDbInfo: ManagedScanReport["scanDb"];
      if (usesTrivyDb(req.method)) {
        if (settings.dbCacheDir) {
          const status = await readScanDbStatus(db, settings.dbCacheDir);
          const scannable = status.staleness === "fresh" || status.staleness === "warn";
          if (!scannable) {
            return { ok: false, reason: status.detail };
          }
          scanDbDir = settings.dbCacheDir;
          scanDbInfo = {
            source: status.source,
            ...(status.ageHours !== null ? { ageHours: status.ageHours } : {}),
            staleness: status.staleness,
            thresholdFired: status.thresholdFired
          };
        } else {
          scanDbInfo = { source: "baked", staleness: "fresh", thresholdFired: "none" };
        }
      }
      // Bind the pull ref to the authorized digest + enforce the OCI-host allowlist (ADR-0019 §4) —
      // nothing in tenant data steers where bytes are pulled from.
      const bound = bindOciRefToAuthorizedDigest(req.pullRef, req.digest);
      if (!bound.ok) return { ok: false, reason: bound.reason };
      const host = ociRegistryHostOf(bound.ref);
      if (!host) return { ok: false, reason: `source ref '${bound.ref}' names no registry host` };
      if (!ociAllowlist().includes(host)) {
        return {
          ok: false,
          reason: `registry host '${host}' is not in SCP_ARTIFACT_OCI_REGISTRY_HOSTS (fail-closed)`
        };
      }

      const root = settings.workspaceRoot || tmpdir();
      await mkdir(root, { recursive: true });
      const scratch = await mkdtemp(join(root, "scp-scan-"));
      const ociDir = join(scratch, "oci");
      const outDir = join(scratch, "out");
      try {
        const tls = insecureHosts().has(host.toLowerCase()) ? ["--src-tls-verify=false"] : [];
        await execFileAsync(
          skopeoBin(),
          [
            "copy",
            "--all",
            "--preserve-digests",
            ...tls,
            `docker://${bound.ref}`,
            `oci:${ociDir}:scan`
          ],
          // `settings.runnerImage` is always truthy here — the guard at this function's top
          // already returned when it wasn't, and `settings` is captured once at factory creation,
          // so there is no "no runner" mode left to size a shorter timeout for.
          { timeout: 180_000, maxBuffer: 64 * 1024 * 1024 }
        );
        // Digest-bind what actually landed (content-addressed, fail-closed) before scanning it.
        const landed = await airgapOciLayout.readOciManifestDigest(ociDir);
        if (landed !== req.digest) {
          return {
            ok: false,
            reason: `pulled OCI layout digest '${landed}' != promoted '${req.digest}'`
          };
        }

        const ctx = pluginCtx(settings.runnerImage, settings.networkMode);
        const ref = await plugin.trigger(ctx, {
          kind: "custom",
          parameters: {
            method: req.method,
            inputDir: ociDir,
            outputDir: outDir,
            ...(scanDbDir ? { scanDbDir } : {}),
            ...(req.method === "openscap"
              ? { profile: req.profile, datastream: req.datastream }
              : {})
          }
        });
        const st = await plugin.status(ctx, ref);
        if (st.phase !== "succeeded") {
          return { ok: false, reason: `runner did not succeed: ${st.detail ?? "(no detail)"}` };
        }
        // Method-select the parser. See docs/federation.md §447.
        const parsed =
          req.method === "openscap"
            ? await parseOscapResultFile(join(outDir, "arf.xml"))
            : await parseTrivyResultFile(join(outDir, "result.json"));
        // The digest binding is the pull, not a self-report. See docs/federation.md §448.
        return {
          ok: true,
          report: {
            scannedDigest: req.digest,
            scannerVersion: parsed.scannerVersion,
            severityCounts: parsed.severityCounts,
            // M22.1b — the per-finding detail travels with the counts it produced. Present for every
            // trivy-family method; structurally absent for openscap (see `ParsedOscap.findings`).
            ...(parsed.findings ? { findings: parsed.findings } : {}),
            ...(scanDbInfo ? { scanDb: scanDbInfo } : {})
          }
        };
      } catch (err) {
        return { ok: false, reason: err instanceof Error ? err.message : String(err) };
      } finally {
        await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  };
}

/** The one in-process caller of a managed executor's trigger. See docs/federation.md §449. */
export function pluginCtx(runnerImage: string, networkMode: string): PluginContext {
  return {
    orgId: "commander",
    scopeKey: "commander",
    logger: {
      debug() {},
      info() {},
      warn() {},
      error() {}
    },
    secrets: { get: async () => undefined },
    http: {
      request: async () => {
        throw new Error("managed-scan: the runner never calls ctx.http");
      }
    },
    // `dockerBinary` from the SAME operator knob the binding path injects. This context is built
    // server-side with no tenant input, so it is not a trust boundary — but a docker-vs-podman
    // setting that applied to bound managed-scan runs and not to the commander's own promotion
    // scans would be a knob that works half the time.
    config: { runnerImage, networkMode, ...managedRunnerSettings() }
  };
}

// --- Trivy result parsing (server-side, where ScanEvidenceSchema lives) --------------------------

interface ParsedTrivy {
  severityCounts: ScanSeverityCounts;
  /** M22.1b — the entries the counts were derived from, retained so `scan_findings` can persist
   *  them. `severityCounts` stays exactly `severityCountsFromFindings(findings)`, so the two can
   *  never disagree and no operator-visible number moves. */
  findings: ScanFinding[];
  scannedDigest: string | undefined;
  scannerVersion: string;
}

/** Distils the scanner's result JSON into counts and a digest. See docs/federation.md §450. */
export function parseTrivyResult(raw: unknown, versionText?: string): ParsedTrivy {
  const doc = (raw ?? {}) as {
    Results?: unknown;
    Metadata?: { ImageID?: unknown; RepoDigests?: unknown };
    ArtifactName?: unknown;
  };
  // The counting loop that used to live here, and what it read. See docs/federation.md §451.
  const findings = parseTrivyFindings(doc);
  const counts = severityCountsFromFindings(findings);
  const candidates: string[] = [];
  const repoDigests = doc.Metadata?.RepoDigests;
  if (Array.isArray(repoDigests))
    for (const d of repoDigests) if (typeof d === "string") candidates.push(d);
  if (typeof doc.Metadata?.ImageID === "string") candidates.push(doc.Metadata.ImageID);
  if (typeof doc.ArtifactName === "string") candidates.push(doc.ArtifactName);
  let scannedDigest: string | undefined;
  for (const c of candidates) {
    const norm = normalizeSha256Digest(c);
    if (norm) {
      scannedDigest = norm;
      break;
    }
  }
  const version = (() => {
    if (versionText) {
      const m = /Version:\s*(\S+)/i.exec(versionText);
      if (m?.[1]) return m[1];
    }
    return "unknown";
  })();
  return { severityCounts: counts, findings, scannedDigest, scannerVersion: version };
}

async function parseTrivyResultFile(path: string): Promise<ParsedTrivy> {
  const { readFile } = await import("node:fs/promises");
  const raw = JSON.parse(await readFile(path, "utf8")) as unknown;
  let versionText: string | undefined;
  try {
    versionText = await readFile(path.replace(/result\.json$/, "scanner-version.txt"), "utf8");
  } catch {
    versionText = undefined;
  }
  return parseTrivyResult(raw, versionText);
}

// --- OpenSCAP result parsing. See docs/federation.md §452.

interface ParsedOscap {
  severityCounts: ScanSeverityCounts;
  /** M22.1b — `never`, not "empty". See docs/federation.md §453. */
  findings?: never;
  /** An ARF carries no image digest (the runner scanned an extracted rootfs), so always undefined —
   *  the digest binding is the server-verified PULL, not the scanner's self-report (see the runner). */
  scannedDigest: undefined;
  scannerVersion: string;
}

const XCCDF_SEVERITY_TO_COUNT: Record<string, keyof ScanSeverityCounts | undefined> = {
  critical: "critical", // XCCDF emits no `critical` in practice; mapped for completeness only.
  high: "high",
  medium: "medium",
  low: "low"
  // info / unknown / unset / other -> undefined (folded away, like trivy's UNKNOWN).
};

export function parseOscapResult(rawXml: unknown, versionText?: string): ParsedOscap {
  const counts = { critical: 0, high: 0, medium: 0, low: 0 };
  if (typeof rawXml !== "string" || rawXml.trim().length === 0) {
    throw new Error("parseOscapResult: empty OpenSCAP result (fail-closed)");
  }
  // A real oscap scan always emits an XCCDF TestResult with rule-results. If neither element is
  // present the document is not a scan result — fail closed rather than report zero findings.
  const looksLikeXccdf =
    /<[A-Za-z0-9]*:?TestResult[\s>]/.test(rawXml) || /<[A-Za-z0-9]*:?rule-result[\s>]/.test(rawXml);
  if (!looksLikeXccdf) {
    throw new Error(
      "parseOscapResult: not an XCCDF/ARF document (no TestResult/rule-result) — fail-closed"
    );
  }

  const ruleResultRe =
    /<[A-Za-z0-9]*:?rule-result\b([^>]*)>([\s\S]*?)<\/[A-Za-z0-9]*:?rule-result>/g;
  let seen = 0;
  let m: RegExpExecArray | null;
  while ((m = ruleResultRe.exec(rawXml)) !== null) {
    seen += 1;
    const attrs = m[1] ?? "";
    const body = m[2] ?? "";
    const resM = /<[A-Za-z0-9]*:?result>\s*([A-Za-z]+)\s*<\/[A-Za-z0-9]*:?result>/i.exec(body);
    if (!resM || resM[1]!.toLowerCase() !== "fail") continue;
    const sevM = /\bseverity="([^"]*)"/i.exec(attrs);
    const key = XCCDF_SEVERITY_TO_COUNT[(sevM?.[1] ?? "").toLowerCase()];
    if (key) counts[key] += 1;
  }
  if (seen === 0) {
    throw new Error(
      "parseOscapResult: no rule-results in document — fail-closed (malformed/empty scan)"
    );
  }

  const version = (() => {
    if (versionText) {
      // `oscap --version` header: "OpenSCAP command line tool (oscap) 1.4.2".
      const m2 =
        /oscap\)?\s*v?(\d+\.\d+(?:\.\d+)?)/i.exec(versionText) ??
        /(\d+\.\d+\.\d+)/.exec(versionText);
      if (m2?.[1]) return m2[1];
    }
    return "unknown";
  })();

  return { severityCounts: counts, scannedDigest: undefined, scannerVersion: version };
}

async function parseOscapResultFile(path: string): Promise<ParsedOscap> {
  const { readFile } = await import("node:fs/promises");
  const raw = await readFile(path, "utf8");
  let versionText: string | undefined;
  try {
    versionText = await readFile(path.replace(/arf\.xml$/, "scanner-version.txt"), "utf8");
  } catch {
    versionText = undefined;
  }
  return parseOscapResult(raw, versionText);
}
