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
 * launches no scan. (Since ADR-0020, the commander's separate `scp-managed-scan` promotion scan
 * step is a genuine, charter-enumerated exception that DOES execute scans — this plugin remains
 * the org-pipeline evidence ingress and is unaffected: it still runs no scanner of any kind.)
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
import {
  EffectiveScanThresholdSchema,
  ScanEvidenceSchema,
  type EffectiveScanThreshold,
  type ScanEvidence,
  type ScanThreshold,
  type ScanThresholdSource,
  type ScanThresholdSourceMap
} from "@scp/schemas";

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

/**
 * M17.5 (ADR-0016) — the GATE-RESOLVED, most-restrictive-wins ceiling across the six scan-
 * requirement tiers (platform -> trust domain (partition) -> org -> containment domain -> service ->
 * component), threaded onto the request context by `gate-orchestrator.ts`'s `buildControlContext` —
 * the exact same conditional-context mechanism that already carries `artifactDigest`.
 *
 * Returns `undefined` when the gate threaded nothing (no tier set any ceiling — the unchanged M17.1
 * path). A PRESENT-BUT-MALFORMED value is a distinct, louder case: it means the gate produced
 * something this control cannot interpret, and silently ignoring it would apply a LOOSER threshold
 * than governance resolved. That is exactly the "silent pass" this plugin exists to prevent, so the
 * caller fails closed on it (`"malformed"`).
 */
function resolveContextThreshold(req: ControlRequest): EffectiveScanThreshold | undefined | "malformed" {
  const raw = (req.context as { scanThreshold?: unknown }).scanThreshold;
  if (raw === undefined || raw === null) return undefined;
  const parsed = EffectiveScanThresholdSchema.safeParse(raw);
  return parsed.success ? parsed.data : "malformed";
}

/**
 * The threshold this verdict is judged against.
 *
 * PREFERS the gate-resolved scoped ceiling over the flat per-binding `config.threshold` — mirroring
 * exactly how `resolveExpectedDigest` prefers `context.artifactDigest` over `config.expectedDigest`.
 * Where BOTH set a ceiling for a severity the tighter one wins (per-severity MIN), because
 * most-restrictive-wins is the whole model: a per-binding config value must never be able to LOOSEN
 * what the platform/trust-domain/org/containment-domain/service/component chain resolved. A severity
 * neither source constrains keeps its historical default — `maxCritical`/`maxHigh` = 0 (fail-closed:
 * any Critical or High fails), `maxMedium`/`maxLow` unbounded — so a binding with no scoped floor
 * behaves precisely as it did in M17.1.
 *
 * THE REPORTED SOURCE IS THE DECIDING SOURCE, PER SEVERITY. Because the merge is a per-severity MIN
 * over TWO sources, "a scoped floor was threaded" is a different claim from "the scoped floor set
 * the ceiling that blocked this change" — with `config.maxHigh = 0` against `scoped.maxHigh = 50`
 * the applied 0 came from the CONFIG. Labelling that `"scoped"` would make the Decision misdescribe
 * its own inputs (charter principle 6), so every severity carries the source that actually supplied
 * its applied value, and the summary label is `"mixed"` when both sources decided something and
 * `"default"` when NEITHER did (the applied 0/0 is the historical fail-closed default, not a config
 * value — claiming `"config"` there would misdescribe the inputs just as badly).
 */
function resolveThreshold(
  config: ScanResultControlConfig,
  scoped: EffectiveScanThreshold | undefined
): { threshold: ScanThreshold; source: "config" | "scoped" | "mixed" | "default"; sources: ScanThresholdSourceMap } {
  const fromConfig = config.threshold ?? {};
  const fromScoped = scoped?.threshold ?? {};
  /** The tighter of the two, plus WHICH one supplied it. A tie is attributed to `scoped`: the
   *  scoped chain alone yields the same ceiling, so the attribution is true either way. */
  const tightest = (
    fromConfigValue: number | undefined,
    fromScopedValue: number | undefined
  ): { value: number | undefined; source: ScanThresholdSource } => {
    if (fromConfigValue === undefined && fromScopedValue === undefined) return { value: undefined, source: "default" };
    if (fromScopedValue === undefined) return { value: fromConfigValue, source: "config" };
    if (fromConfigValue === undefined) return { value: fromScopedValue, source: "scoped" };
    return fromConfigValue < fromScopedValue
      ? { value: fromConfigValue, source: "config" }
      : { value: fromScopedValue, source: "scoped" };
  };
  const critical = tightest(fromConfig.maxCritical, fromScoped.maxCritical);
  const high = tightest(fromConfig.maxHigh, fromScoped.maxHigh);
  const medium = tightest(fromConfig.maxMedium, fromScoped.maxMedium);
  const low = tightest(fromConfig.maxLow, fromScoped.maxLow);

  const sources: ScanThresholdSourceMap = {
    maxCritical: critical.source,
    maxHigh: high.source,
    ...(medium.value !== undefined ? { maxMedium: medium.source } : {}),
    ...(low.value !== undefined ? { maxLow: low.source } : {})
  };
  const decided = new Set(Object.values(sources).filter((s) => s !== "default"));
  // NOTHING decided => the applied 0/0 came from the historical fail-closed DEFAULT, not from
  // `config`. Saying `"config"` here would misdescribe the Decision's own inputs (charter principle
  // 6) even though the per-severity `sources` map stays honest.
  const source: "config" | "scoped" | "mixed" | "default" =
    decided.size > 1 ? "mixed" : decided.size === 1 ? ([...decided][0] as "config" | "scoped") : "default";

  return {
    threshold: {
      maxCritical: critical.value ?? 0,
      maxHigh: high.value ?? 0,
      ...(medium.value !== undefined ? { maxMedium: medium.value } : {}),
      ...(low.value !== undefined ? { maxLow: low.value } : {})
    },
    source,
    sources
  };
}

/** Every severity whose count exceeds its applied ceiling — named, so the fail detail can say which
 *  ceiling was breached AND which source supplied it. */
function breachedSeverities(counts: ScanEvidence["severityCounts"], threshold: ScanThreshold): Array<keyof ScanThresholdSourceMap> {
  const breached: Array<keyof ScanThresholdSourceMap> = [];
  if (counts.critical > threshold.maxCritical) breached.push("maxCritical");
  if (counts.high > threshold.maxHigh) breached.push("maxHigh");
  if (threshold.maxMedium !== undefined && counts.medium > threshold.maxMedium) breached.push("maxMedium");
  if (threshold.maxLow !== undefined && counts.low > threshold.maxLow) breached.push("maxLow");
  return breached;
}

export function createScanResultControlPlugin(): ControlPlugin {
  return {
    async evaluate(ctx: PluginContext, req: ControlRequest): Promise<ControlOutcome> {
      const config = ctx.config as ScanResultControlConfig;
      const timeoutMs = config.timeoutMs ?? 10_000;

      if (!config.url) {
        return fail("scan-result-control: no 'url' configured on this binding");
      }

      // M17.5: read the gate-resolved scoped ceiling BEFORE any network work — a threaded value we
      // cannot interpret must fail closed, never quietly fall back to the looser per-binding config.
      const scoped = resolveContextThreshold(req);
      if (scoped === "malformed") {
        return fail(
          "scan-result-control: context.scanThreshold is present but malformed — refusing to fall back to the (looser) per-binding threshold"
        );
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
      const { threshold, source: thresholdSource, sources: thresholdSources } = resolveThreshold(config, scoped);
      const digestMatch = digestHex(scanned) === digestHex(expectedDigest);

      const evidence: ScanEvidence = ScanEvidenceSchema.parse({
        scanner: "trivy",
        scannerVersion: resolveScannerVersion(trivy, config),
        artifactDigest: scanned,
        expectedDigest,
        digestMatch,
        severityCounts: counts,
        // The RESOLVED threshold actually applied, plus WHERE it came from and WHICH tiers set it —
        // so a blocked promotion's Decision explains why it blocked, not merely that it did
        // (charter principle 6, ADR-0016 §5).
        threshold,
        thresholdSource,
        thresholdSources,
        ...(scoped ? { thresholdContributors: scoped.contributors } : {})
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

      const breached = breachedSeverities(counts, threshold);
      if (breached.length > 0) {
        // Name the breached ceilings AND the source that actually supplied each one — a block must
        // never cite "the scoped threshold" when the per-binding config set the deciding value.
        const breachDetail = breached.map((k) => `${k}=${threshold[k]} (from ${thresholdSources[k]})`).join(", ");
        return {
          status: "fail",
          detail: `scan-result-control: verdict exceeds ${thresholdSource === "scoped" || thresholdSource === "mixed" ? "the effective (most-restrictive-wins) " : ""}threshold — breached ${breachDetail}; counts critical=${counts.critical}, high=${counts.high}, medium=${counts.medium}, low=${counts.low}${
            scoped && scoped.contributors.length > 0
              ? ` [tiers: ${scoped.contributors.map((c) => `${c.tier}(${c.source})`).join(", ")}]`
              : ""
          }`,
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
