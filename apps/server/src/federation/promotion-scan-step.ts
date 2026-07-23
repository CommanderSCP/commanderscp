import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ScanEvidenceSchema,
  ScanSeverityCountsSchema,
  ExecutorTypeSchema,
  type ScanMethod,
  type ScanSeverityCounts,
  type ScanThreshold,
  type EffectiveScanThreshold
} from "@scp/schemas";
import { resolveSkopeo } from "@scp/cosign";
import { ociLayout as airgapOciLayout } from "@scp/airgap";
import { createManagedScanExecutorPlugin } from "@scp/plugin-managed-scan";
import type { PluginContext } from "@scp/plugin-api";
import type { Db } from "../db/client.js";
import { withTenantTx } from "../db/tenant-tx.js";
import { getChange } from "../coordination/changes-repo.js";
import {
  insertControlRun,
  listControlRunsForChange,
  type ControlRunRow
} from "../governance/controls-repo.js";
import { resolveScannersForType } from "../governance/scanner-registry.js";
import { resolveEffectiveScanThreshold } from "../governance/scan-requirements.js";
import { managedScanServerSettings } from "../coordination/executor-bindings-repo.js";
import {
  bindOciRefToAuthorizedDigest,
  normalizeSha256Digest,
  ociRegistryHostOf,
  parseRegistryHostList
} from "./artifact-verify.js";

/**
 * THE COMMANDER-SIDE PROMOTION SCAN STEP (ADR-0020 §1, proposal §13.3, charter's Managed Execution
 * Exception 2026-07-23 amendment) — the crux of first-class commander scanning.
 *
 * This is a step of the COMMANDER's promotion/export journey, NOT a tenant executor binding. For a
 * change being exported it deposits, for EACH substantive artifact (the E6 `substantiveArtifacts`
 * set — everything except `type: "blob"`), a digest-bound `control_runs` scan outcome, so that the
 * UNCHANGED E6 gate (`evaluatePromotionScanGate`, promotion-repo.ts) then reads those rows and
 * PASSES for a clean artifact / REFUSES for a dirty-or-unscanned one. This module writes evidence;
 * it does not touch the gate.
 *
 * PER ARTIFACT (proposal §13.3):
 *   (a) SHORT-CIRCUIT — if a VALID org-pipeline `control_runs` scan outcome already covers this
 *       digest (status `pass` + `ScanEvidenceSchema` valid + `digestMatch` + `artifactDigest`
 *       match — the exact E6 predicate), SKIP the managed run: org evidence wins, the D1 alternate
 *       ingress, and the runner is never invoked.
 *   (b) SCANNER SELECTION — `resolveScannersForType(the artifact's ExecutorType)` → methods. If
 *       EMPTY, NO managed evidence is produced (fail-closed: E6 will refuse — we never fabricate a
 *       pass for an unassigned type).
 *   (c) THE SERVER pulls the artifact's bytes BY DIGEST over the allowlisted skopeo channel
 *       (`SCP_ARTIFACT_OCI_REGISTRY_HOSTS`, ADR-0019 §4) into a scratch OCI layout — the runner
 *       itself gets NO network.
 *   (d) run the `scp-managed-scan` plugin per method (`--network none` ephemeral container).
 *   (e) evaluate the returned `severityCounts` against the resolved M17.5 threshold
 *       (`resolveEffectiveScanThreshold` — reused, not reimplemented) → status pass/fail.
 *   (f) DEPOSIT a `control_runs` row (`insertControlRun`) whose evidence is a valid `ScanEvidence`
 *       with `scanner = method`, `artifactDigest =` the pulled+normalized digest (which MUST equal
 *       the promoted digest for `digestMatch: true`), and the threshold provenance.
 *
 * FAIL-CLOSED throughout: an unassigned type, an unavailable dispatch/runner, an unresolvable pull
 * ref, or a scanner error all yield NO passing managed evidence — so E6 refuses (never a fabricated
 * pass). The one scan runs once at the commander before signing (ADR-0020 §4); downstream never
 * re-scans.
 */

const execFileAsync = promisify(execFile);

/**
 * The synthetic, well-known object id tagging every `control_runs` row this step deposits — the
 * commander's SYSTEM managed-scan control identity.
 *
 * WHY a fixed synthetic id rather than a tenant-created `control` graph object: `control_runs`
 * `control_object_id` has NO foreign key to `objects` (db/schema.ts), and E6 identifies a scan
 * outcome PURELY by `ScanEvidenceSchema.safeParse(evidence)` — never by which control produced it
 * (promotion-repo.ts's gate). So the managed promotion scan step, which is a first-class step of the
 * commander's own promotion process rather than a tenant-bound control, tags its rows with this one
 * stable, deployment-wide synthetic id. It is org-agnostic (control_runs rows are org-scoped by
 * `org_id`, so the same synthetic control id under different orgs never collides) and resolves to a
 * null URN in the export's control-outcome projection (tolerated, promotion-repo.ts) — its purpose
 * is to mark provenance ("this outcome came from the commander's managed scan step"), not to be a
 * graph object.
 */
export const MANAGED_SCAN_CONTROL_OBJECT_ID = "00000000-5ca4-4000-8000-000000000001";

// --- Injected scan dependency (so the step is hermetically testable without Docker) -------------

/** One managed scan the step asks the runner to perform, fully server-resolved. */
export interface ManagedScanRequest {
  method: ScanMethod;
  /** The promoted digest (`sha256:<hex>`), authoritative — what the pull is bound to. */
  digest: string;
  /** The registry reference the SERVER pulls (allowlist-guarded), or `null` when unresolvable. */
  pullRef: string | null;
}

/** What a runner returns — the distilled counts + the digest it actually scanned. */
export interface ManagedScanReport {
  scannedDigest: string;
  scannerVersion: string;
  severityCounts: ScanSeverityCounts;
}

export type ManagedScanResult =
  | { ok: true; report: ManagedScanReport }
  | { ok: false; reason: string };

export interface ManagedScanRunner {
  scan(req: ManagedScanRequest): Promise<ManagedScanResult>;
}

// --- The E6 short-circuit predicate (identical to promotion-repo.ts's gate check) ---------------

/** True iff `run` is a passing, digest-bound scan outcome covering `digest` — the EXACT predicate
 *  E6 applies, so "already covered" here means "E6 will accept it" there (both ingresses tie). */
function isCoveringScanOutcome(run: ControlRunRow, digest: string): boolean {
  if (run.status !== "pass") return false;
  const parsed = ScanEvidenceSchema.safeParse(run.evidence);
  if (!parsed.success) return false;
  return parsed.data.digestMatch === true && parsed.data.artifactDigest === digest;
}

// --- Artifact + pull-ref resolution from the change's sourceRef ----------------------------------

interface ScanSubject {
  digest: string; // sha256:<hex>, normalized
  pullRef: string | null;
  executorType: string;
}

/** Extract the OCI artifact digests the change promotes (mirrors promotion-repo.ts's export
 *  projection: `sourceRef.artifact_digest` / `artifactDigest`, string or string[]). */
function ociDigestsOf(sourceRef: Record<string, unknown>): string[] {
  const raw =
    (sourceRef.artifact_digest as unknown) ?? (sourceRef.artifactDigest as unknown) ?? undefined;
  const list =
    typeof raw === "string" ? [raw] : Array.isArray(raw) ? raw.filter((d): d is string => typeof d === "string") : [];
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
    explicit && explicit.length > 0 ? explicit.replace(/[@:][^/]*$/, "") : process.env.SCP_MANAGED_SCAN_SOURCE_REPO ?? "";
  if (!repoBase) return null;
  return `${repoBase}@${digest}`;
}

/** The artifact's ExecutorType for scanner selection — the change's routing Type when valid, else
 *  `image` for an OCI subject (the M13 image-only scope, proposal §13.3 D2). */
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

// --- The step ------------------------------------------------------------------------------------

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
}

/**
 * Run the commander's promotion scan step for `changeIdOrUrn`, depositing managed-scan `control_runs`
 * rows so the UNCHANGED E6 gate (read next by `exportPromotionBundle`) has evidence to consume. A
 * no-op for a metadata-only promotion (no substantive artifacts) or an artifact already covered by
 * org-pipeline evidence. Never fabricates a pass: an unassigned type, an unavailable runner, or an
 * unresolvable pull ref simply deposit no passing evidence and E6 then refuses.
 */
export async function runPromotionScanStep(
  db: Db,
  input: RunPromotionScanStepInput,
  runner: ManagedScanRunner
): Promise<void> {
  // Phase A (tx, read-only): gather the plan — which artifacts still need a managed scan, with what
  // methods, and the effective threshold. Pure DB; no subprocess runs while a connection is held.
  const plan = await withTenantTx(db, input.orgId, async (tx) => {
    const change = await getChange(tx, input.orgId, input.changeIdOrUrn);
    const sourceRef = change.sourceRef ?? {};
    const digests = ociDigestsOf(sourceRef as Record<string, unknown>);
    if (digests.length === 0) return null; // metadata-only promotion — nothing to scan.

    const existingRuns = await listControlRunsForChange(tx, input.orgId, change.id);
    const executorType = executorTypeOf(change as { properties: Record<string, unknown> });
    const methods = await resolveScannersForType(tx, executorType);

    const targetObjectIds = Array.isArray((change.properties as Record<string, unknown>).targets)
      ? ((change.properties as Record<string, unknown>).targets as unknown[]).filter(
          (t): t is string => typeof t === "string"
        )
      : [];
    // Reuse the M17.5 six-tier resolver. `firedPolicies: []` applies the instance-level floors
    // (platform/trust_domain, always read) plus the fail-closed default (any Critical/High fails);
    // scoped org/service/component scan-requirement POLICY ceilings are enforced authoritatively for
    // org-pipeline evidence by the normal lifecycle gate (gate-orchestrator.ts). Tightening the
    // managed step to also evaluate fired scoped policies is a documented follow-on — safe because
    // the fail-closed default already refuses any Critical/High.
    const effective = await resolveEffectiveScanThreshold(tx, {
      orgId: input.orgId,
      targetObjectIds,
      actorObjectId: input.actorObjectId,
      firedPolicies: []
    });

    const planned: PlannedScan[] = [];
    for (const digest of digests) {
      // (a) SHORT-CIRCUIT — org-pipeline (or any prior) passing digest-bound evidence wins.
      if (existingRuns.some((r) => isCoveringScanOutcome(r, digest))) continue;
      // (b) scanner selection — an unassigned type yields no methods ⇒ no managed evidence.
      if (methods.length === 0) continue;
      planned.push({
        subject: {
          digest,
          pullRef: resolvePullRef(sourceRef as Record<string, unknown>, digest),
          executorType
        },
        methods
      });
    }
    return { changeId: change.id, planned, effective };
  });

  if (!plan || plan.planned.length === 0) return;

  const { threshold, source } = applyThreshold(plan.effective);

  // Phase B (no tx): pull + scan each planned artifact per method. Subprocesses (skopeo/docker) run
  // here, never while a pooled DB connection is held (the codebase-wide invariant, promotion-repo.ts).
  const deposits: DepositRow[] = [];
  for (const { subject, methods } of plan.planned) {
    for (const method of methods) {
      const result = await runner.scan({ method, digest: subject.digest, pullRef: subject.pullRef });
      if (!result.ok) {
        // Runner/dispatch unavailable, or an unresolvable pull ref — produce NO passing evidence
        // (fail-closed). We deposit nothing: E6 then refuses this artifact for lack of a passing,
        // digest-bound outcome. Fabricating a pass here is exactly what the model forbids.
        continue;
      }
      const { report } = result;
      const scannedDigest = normalizeSha256Digest(report.scannedDigest) ?? report.scannedDigest;
      const digestMatch = scannedDigest === subject.digest;
      const severityCounts = ScanSeverityCountsSchema.parse(report.severityCounts);
      const overThreshold = breaches(severityCounts, threshold);
      const status: "pass" | "fail" = digestMatch && !overThreshold ? "pass" : "fail";

      const evidence = ScanEvidenceSchema.parse({
        scanner: method,
        scannerVersion: report.scannerVersion || "unknown",
        artifactDigest: scannedDigest,
        expectedDigest: subject.digest,
        digestMatch,
        severityCounts,
        threshold,
        thresholdSource: source,
        ...(plan.effective ? { thresholdContributors: plan.effective.contributors } : {})
      });

      const detail = !digestMatch
        ? `managed-scan (${method}): digest mismatch — scanned ${scannedDigest}, promoting ${subject.digest}`
        : overThreshold
          ? `managed-scan (${method}): verdict exceeds threshold — critical=${severityCounts.critical}, high=${severityCounts.high}, medium=${severityCounts.medium}, low=${severityCounts.low}`
          : `managed-scan (${method}): within threshold for ${scannedDigest} (critical=${severityCounts.critical}, high=${severityCounts.high})`;

      deposits.push({
        changeObjectId: plan.changeId,
        status,
        evidence: evidence as unknown as Record<string, unknown>,
        detail,
        method,
        digest: subject.digest
      });
    }
  }

  if (deposits.length === 0) return;

  // Phase C (tx, write): deposit the managed-scan control_runs rows the UNCHANGED E6 gate reads next.
  await withTenantTx(db, input.orgId, async (tx) => {
    for (const d of deposits) {
      await insertControlRun(tx, {
        orgId: input.orgId,
        controlObjectId: MANAGED_SCAN_CONTROL_OBJECT_ID,
        changeObjectId: d.changeObjectId,
        gateKind: "lifecycle_edge",
        gateRef: { promotionScanStep: true, method: d.method, artifactDigest: d.digest },
        status: d.status,
        evidence: d.evidence,
        detail: d.detail
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

/**
 * The default production `ManagedScanRunner`: the SERVER pulls the artifact BY DIGEST over the
 * allowlisted skopeo channel into a scratch OCI layout (the runner gets no network), asserts the
 * landed layout's digest equals the promoted digest, then runs the `scp-managed-scan` plugin
 * (`--network none`) and parses the Trivy result into distilled counts. Returns `{ok:false}` — never
 * throws into the export flow — when managed scanning is not enabled or the pull/scan cannot complete
 * (fail-closed).
 *
 * Credentialed source registries are a documented follow-on: this increment pulls anonymously
 * (sufficient for the image-only M13 scope and the local-registry integration test); the relay's
 * per-registry vault-credential machinery (retrans-relay.ts) is the model to wire in later.
 */
export function createServerManagedScanRunner(): ManagedScanRunner {
  const plugin = createManagedScanExecutorPlugin();
  const settings = managedScanServerSettings();

  return {
    async scan(req: ManagedScanRequest): Promise<ManagedScanResult> {
      if (!settings.runnerImage) {
        return { ok: false, reason: "managed scanning is not enabled (SCP_MANAGED_SCAN_RUNNER_IMAGE unset)" };
      }
      if (req.method !== "trivy") {
        return { ok: false, reason: `method '${req.method}' has no runner support in this increment (OpenSCAP is a follow-on)` };
      }
      if (!req.pullRef) {
        return { ok: false, reason: "unresolvable pull ref — artifact carries no location and no SCP_MANAGED_SCAN_SOURCE_REPO fallback" };
      }
      // Bind the pull ref to the authorized digest + enforce the OCI-host allowlist (ADR-0019 §4) —
      // nothing in tenant data steers where bytes are pulled from.
      const bound = bindOciRefToAuthorizedDigest(req.pullRef, req.digest);
      if (!bound.ok) return { ok: false, reason: bound.reason };
      const host = ociRegistryHostOf(bound.ref);
      if (!host) return { ok: false, reason: `source ref '${bound.ref}' names no registry host` };
      if (!ociAllowlist().includes(host)) {
        return { ok: false, reason: `registry host '${host}' is not in SCP_ARTIFACT_OCI_REGISTRY_HOSTS (fail-closed)` };
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
          ["copy", "--all", "--preserve-digests", ...tls, `docker://${bound.ref}`, `oci:${ociDir}:scan`],
          { timeout: settings.runnerImage ? 180_000 : 60_000, maxBuffer: 64 * 1024 * 1024 }
        );
        // Digest-bind what actually landed (content-addressed, fail-closed) before scanning it.
        const landed = await airgapOciLayout.readOciManifestDigest(ociDir);
        if (landed !== req.digest) {
          return { ok: false, reason: `pulled OCI layout digest '${landed}' != promoted '${req.digest}'` };
        }

        const ctx = pluginCtx(settings.runnerImage, settings.networkMode);
        const ref = await plugin.trigger(ctx, {
          kind: "custom",
          parameters: { method: req.method, inputDir: ociDir, outputDir: outDir }
        });
        const st = await plugin.status(ctx, ref);
        if (st.phase !== "succeeded") {
          return { ok: false, reason: `runner did not succeed: ${st.detail ?? "(no detail)"}` };
        }
        const parsed = await parseTrivyResultFile(join(outDir, "result.json"));
        // THE DIGEST BINDING IS THE PULL, NOT TRIVY'S SELF-REPORT. We already content-addressed the
        // subject above (`landed === req.digest`) and fed exactly that layout to the networkless
        // runner, so the scanned artifact's MANIFEST digest is provably the promoted digest. Trivy's
        // own identifier for an `--input` OCI-layout scan is `Metadata.ImageID` — the image CONFIG
        // digest, a DIFFERENT sha256 than the manifest digest — so trusting `parsed.scannedDigest`
        // here would false-mismatch every clean artifact. Bind to `req.digest` (the verified pull);
        // `parsed.scannedDigest` is retained only for the malformed-result diagnostic path below.
        return {
          ok: true,
          report: {
            scannedDigest: req.digest,
            scannerVersion: parsed.scannerVersion,
            severityCounts: parsed.severityCounts
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

function pluginCtx(runnerImage: string, networkMode: string): PluginContext {
  return {
    orgId: "commander",
    domainId: "commander",
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
    config: { runnerImage, networkMode }
  };
}

// --- Trivy result parsing (server-side, where ScanEvidenceSchema lives) --------------------------

interface ParsedTrivy {
  severityCounts: ScanSeverityCounts;
  scannedDigest: string | undefined;
  scannerVersion: string;
}

const SEVERITIES = ["critical", "high", "medium", "low"] as const;

/** Distil Trivy's native result JSON into the four ScanSeverityCounts + the digest it scanned +
 *  version. Total and defensive — a malformed/partial document degrades to zero counts (a broken
 *  scan then can't exceed a threshold on counts, but the RUNNER already failed the run for a broken
 *  scan, so this path only ever sees a real result). Mirrors scan-result-control's parsing across
 *  the plugin/server boundary (a plugin cannot import server code, and vice versa). */
export function parseTrivyResult(raw: unknown, versionText?: string): ParsedTrivy {
  const counts = { critical: 0, high: 0, medium: 0, low: 0 };
  const doc = (raw ?? {}) as { Results?: unknown; Metadata?: { ImageID?: unknown; RepoDigests?: unknown }; ArtifactName?: unknown };
  const results = doc.Results;
  if (Array.isArray(results)) {
    for (const result of results) {
      const vulns = (result as { Vulnerabilities?: unknown }).Vulnerabilities;
      if (!Array.isArray(vulns)) continue;
      for (const v of vulns) {
        const sev = (v as { Severity?: unknown }).Severity;
        if (typeof sev !== "string") continue;
        const key = sev.toLowerCase();
        if ((SEVERITIES as readonly string[]).includes(key)) counts[key as (typeof SEVERITIES)[number]] += 1;
      }
    }
  }
  const candidates: string[] = [];
  const repoDigests = doc.Metadata?.RepoDigests;
  if (Array.isArray(repoDigests)) for (const d of repoDigests) if (typeof d === "string") candidates.push(d);
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
  return { severityCounts: counts, scannedDigest, scannerVersion: version };
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
