/**
 * @scp/plugin-scan-result-control — turns a coordinated **Trivy scan verdict** into GATE EVIDENCE
 * (DESIGN §10.2 ControlPlugin, ADR-0013 "scan as a boundary-authorization gate",
 * BUILD_AND_TEST.md §8 M17). A sibling of `@scp/plugin-webhook-control`: same `ControlPlugin`
 * contract, same subprocess plugin host, same PULL intake pattern (fetch a result from a
 * per-binding operator-configured `url` via the host-mediated `ctx.http`, map it into a
 * `ControlOutcome`). Bound to a `control` graph object via a `control_binding`, exactly like
 * webhook-control — no execution-system involved.
 *
 * CHARTER — coordinate, NOT execute (principle 1): this plugin NEVER runs Trivy. Trivy runs inside
 * an execution system SCP merely coordinates (the Argo Workflows Trivy step, ADR-0012); this plugin
 * only *consumes* the resulting verdict JSON as evidence. It holds no scanner credentials and
 * launches no scan.
 *
 * SCOPE (ADR-0013) — this is a BOUNDARY-CROSSING AUTHORIZATION gate, not a universal code-quality
 * gate. It fires ONLY where an operator binds a scan control into a policy's `requireControls` (or a
 * raw `gate_binding`) for a commander-tracked, boundary-crossing artifact — never unconditionally on
 * every change. The engine wiring (governance/control-runner.ts, coordination/gates.ts) already
 * enforces "runs only where bound"; nothing here fires on its own.
 *
 * FAIL-CLOSED: an unreachable/unparseable source, a non-2xx response, a timeout, a
 * digest mismatch, or a verdict over the configured severity threshold ALL yield `fail` (never a
 * silent pass) — a broken or absent scan can never authorize a boundary crossing.
 *
 * DIGEST BINDING ("nothing slipped in", ADR-0013): the verdict is bound to the digest Trivy
 * actually scanned AND to the digest the change is promoting. A verdict for a DIFFERENT digest —
 * a stale or substituted scan — returns `fail` (mismatch), so it can never authorize a different
 * artifact.
 */
import type { ControlOutcome, ControlPlugin, ControlRequest, PluginContext } from "@scp/plugin-api";
import { ScanEvidenceSchema, type ScanEvidence, type ScanThreshold } from "@scp/schemas";

export interface ScanResultControlConfig {
  /** Operator-configured source of the Trivy result JSON for this change's artifact — fetched with
   *  a GET (a scan verdict is a resource to READ, not a context to POST). Same trust tier as
   *  webhook-control's control-server url (set behind `policy:write`). */
  url: string;
  headers?: Record<string, string>;
  /** Wall-clock budget for the source to respond. Default 10s. Enforced HERE (a `Promise.race`),
   *  mirroring webhook-control, so a hang produces a `fail` outcome rather than the host's raw RPC
   *  timeout — a scan source that never answers must fail closed, not stall the gate. */
  timeoutMs?: number;
  /** The digest the change is promoting, if not supplied on the request `context` (see
   *  `resolveExpectedDigest`). Operator-pinned on the binding — a scan whose scanned digest doesn't
   *  match this cannot authorize the change. */
  expectedDigest?: string;
  /** Severity threshold (default: any Critical OR any High fails). Medium/Low are unbounded unless
   *  set. */
  threshold?: Partial<ScanThreshold>;
  /** Optional scanner-version hint when the Trivy result JSON itself doesn't carry one (standard
   *  Trivy output does not) — recorded verbatim into evidence for the audit trail. */
  scannerVersion?: string;
}

/** Minimal shape of the Trivy container-image result JSON this control reads (real Trivy schema —
 *  `Results[].Vulnerabilities[].Severity`, plus `Metadata` for the scanned digest). Everything is
 *  optional/defensive: a malformed or partial document degrades to a fail-closed verdict, never a
 *  throw. */
interface TrivyResultJson {
  ArtifactName?: unknown;
  Metadata?: { ImageID?: unknown; RepoDigests?: unknown };
  Results?: unknown;
  // Non-standard passthrough fields some CI wrappers add — read best-effort for the scanner version.
  Version?: unknown;
  trivyVersion?: unknown;
}

const SEVERITIES = ["critical", "high", "medium", "low"] as const;

function timeout(ms: number): Promise<"timeout"> {
  return new Promise((resolve) => setTimeout(() => resolve("timeout"), ms));
}

function fail(detail: string, evidence?: Record<string, unknown>): ControlOutcome {
  return { status: "fail", detail, evidence: evidence ?? {} };
}

/** Reduce any digest reference to its bare lowercase sha256 hex — from `…@sha256:<hex>`,
 *  `sha256:<hex>`, or a bare 64-hex string. Returns `undefined` for anything without a sha256
 *  digest (a bare tag), which the caller treats as "cannot bind" → fail closed. */
function digestHex(ref: string): string | undefined {
  const prefixed = /sha256:([a-f0-9]{64})/i.exec(ref);
  if (prefixed?.[1]) return prefixed[1].toLowerCase();
  const bare = /^[a-f0-9]{64}$/i.exec(ref.trim());
  return bare ? bare[0].toLowerCase() : undefined;
}

/** The digest the change is promoting: prefer the request `context.artifactDigest` (the forward-wired
 *  path once the gate threads the change's tracked artifact digest through) and fall back to the
 *  operator-pinned `config.expectedDigest`. Neither present ⇒ the control cannot bind the verdict to
 *  anything ⇒ fail closed (handled by the caller). */
function resolveExpectedDigest(ctx: PluginContext, req: ControlRequest): string | undefined {
  const fromContext = (req.context as { artifactDigest?: unknown }).artifactDigest;
  if (typeof fromContext === "string" && fromContext.length > 0) return fromContext;
  const config = ctx.config as ScanResultControlConfig;
  if (typeof config.expectedDigest === "string" && config.expectedDigest.length > 0) return config.expectedDigest;
  return undefined;
}

/** The digest Trivy actually scanned, from the result's `Metadata.RepoDigests[]` (a
 *  `repo@sha256:…` list), then `Metadata.ImageID`, then `ArtifactName`. Returns the first
 *  sha256-bearing reference found (normalized to `sha256:<hex>`), or `undefined` if the result
 *  carries no digest at all. */
function scannedDigest(raw: TrivyResultJson): string | undefined {
  const candidates: string[] = [];
  const repoDigests = raw.Metadata?.RepoDigests;
  if (Array.isArray(repoDigests)) {
    for (const d of repoDigests) if (typeof d === "string") candidates.push(d);
  }
  if (typeof raw.Metadata?.ImageID === "string") candidates.push(raw.Metadata.ImageID);
  if (typeof raw.ArtifactName === "string") candidates.push(raw.ArtifactName);
  for (const c of candidates) {
    const hex = digestHex(c);
    if (hex) return `sha256:${hex}`;
  }
  return undefined;
}

function countSeverities(raw: TrivyResultJson): ScanEvidence["severityCounts"] {
  const counts = { critical: 0, high: 0, medium: 0, low: 0 };
  const results = raw.Results;
  if (!Array.isArray(results)) return counts;
  for (const result of results) {
    const vulns = (result as { Vulnerabilities?: unknown }).Vulnerabilities;
    if (!Array.isArray(vulns)) continue;
    for (const v of vulns) {
      const sev = (v as { Severity?: unknown }).Severity;
      if (typeof sev !== "string") continue;
      const key = sev.toLowerCase();
      if ((SEVERITIES as readonly string[]).includes(key)) {
        counts[key as (typeof SEVERITIES)[number]] += 1;
      }
    }
  }
  return counts;
}

function resolveScannerVersion(raw: TrivyResultJson, config: ScanResultControlConfig): string {
  if (typeof raw.trivyVersion === "string" && raw.trivyVersion.length > 0) return raw.trivyVersion;
  if (typeof raw.Version === "string" && raw.Version.length > 0) return raw.Version;
  if (typeof config.scannerVersion === "string" && config.scannerVersion.length > 0) return config.scannerVersion;
  return "unknown";
}

function resolveThreshold(config: ScanResultControlConfig): ScanThreshold {
  const t = config.threshold ?? {};
  return {
    maxCritical: t.maxCritical ?? 0,
    maxHigh: t.maxHigh ?? 0,
    ...(t.maxMedium !== undefined ? { maxMedium: t.maxMedium } : {}),
    ...(t.maxLow !== undefined ? { maxLow: t.maxLow } : {})
  };
}

function overThreshold(counts: ScanEvidence["severityCounts"], threshold: ScanThreshold): boolean {
  if (counts.critical > threshold.maxCritical) return true;
  if (counts.high > threshold.maxHigh) return true;
  if (threshold.maxMedium !== undefined && counts.medium > threshold.maxMedium) return true;
  if (threshold.maxLow !== undefined && counts.low > threshold.maxLow) return true;
  return false;
}

export function createScanResultControlPlugin(): ControlPlugin {
  return {
    async evaluate(ctx: PluginContext, req: ControlRequest): Promise<ControlOutcome> {
      const config = ctx.config as ScanResultControlConfig;
      const timeoutMs = config.timeoutMs ?? 10_000;

      if (!config.url) {
        return fail("scan-result-control: no 'url' configured on this binding");
      }

      const expectedDigest = resolveExpectedDigest(ctx, req);
      if (!expectedDigest) {
        // No digest to bind against — a scan we can't tie to the change's artifact must never
        // authorize it (ADR-0013 "nothing slipped in").
        return fail(
          "scan-result-control: no expected artifact digest (neither context.artifactDigest nor config.expectedDigest) — cannot bind the verdict to the change's artifact"
        );
      }

      const call = ctx.http
        .request({
          method: "GET",
          url: config.url,
          headers: { accept: "application/json", ...(config.headers ?? {}) }
        })
        .then((response) => ({ kind: "response" as const, response }))
        .catch((err: unknown) => ({ kind: "error" as const, message: err instanceof Error ? err.message : String(err) }));

      const result = await Promise.race([call, timeout(timeoutMs)]);

      if (result === "timeout") {
        return fail(`scan-result-control: no scan result within ${timeoutMs}ms`, { url: config.url, timeoutMs });
      }
      if (result.kind === "error") {
        return fail(`scan-result-control: fetch failed — ${result.message}`, { url: config.url });
      }

      const { response } = result;
      if (response.status < 200 || response.status >= 300) {
        return fail(`scan-result-control: scan source returned HTTP ${response.status}`, {
          url: config.url,
          httpStatus: response.status
        });
      }

      const raw = response.body;
      if (!raw || typeof raw !== "object") {
        return fail("scan-result-control: scan source did not return a JSON object (unparseable Trivy result)", {
          url: config.url
        });
      }

      const trivy = raw as TrivyResultJson;
      const scanned = scannedDigest(trivy);
      if (!scanned) {
        return fail("scan-result-control: Trivy result carries no artifact digest — cannot verify the digest binding", {
          url: config.url,
          expectedDigest
        });
      }

      const counts = countSeverities(trivy);
      const threshold = resolveThreshold(config);
      const digestMatch = digestHex(scanned) === digestHex(expectedDigest);

      const evidence: ScanEvidence = ScanEvidenceSchema.parse({
        scanner: "trivy",
        scannerVersion: resolveScannerVersion(trivy, config),
        artifactDigest: scanned,
        expectedDigest,
        digestMatch,
        severityCounts: counts,
        threshold
      });

      if (!digestMatch) {
        // The verdict is for a DIFFERENT artifact than the one the change is promoting — a stale or
        // substituted scan. It does not authorize this change.
        return {
          status: "fail",
          detail: `scan-result-control: digest mismatch — scanned ${scanned}, change is promoting ${expectedDigest}`,
          evidence
        };
      }

      if (overThreshold(counts, threshold)) {
        return {
          status: "fail",
          detail: `scan-result-control: verdict exceeds threshold — critical=${counts.critical}, high=${counts.high}, medium=${counts.medium}, low=${counts.low}`,
          evidence
        };
      }

      return {
        status: "pass",
        detail: `scan-result-control: trivy verdict within threshold for ${scanned} (critical=${counts.critical}, high=${counts.high})`,
        evidence
      };
    }
  };
}
