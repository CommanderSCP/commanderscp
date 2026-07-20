import { describe, expect, it } from "vitest";
import type { PluginContext, ScopedHttpRequest, ScopedHttpResponse } from "@scp/plugin-api";
import { ScanEvidenceSchema } from "@scp/schemas";
import { createScanResultControlPlugin, type ScanResultControlConfig } from "./index.js";

const DIGEST_A = "sha256:1111111111111111111111111111111111111111111111111111111111111111";
const DIGEST_B = "sha256:2222222222222222222222222222222222222222222222222222222222222222";

/** A real-Trivy-shaped container-image result JSON. `digest` becomes the scanned artifact's
 *  RepoDigest; `severities` seeds `Results[].Vulnerabilities[].Severity`. */
function trivyResult(opts: {
  digest: string;
  severities?: Array<"CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "UNKNOWN">;
}): unknown {
  return {
    SchemaVersion: 2,
    ArtifactName: `registry.example/app:1.2.3`,
    ArtifactType: "container_image",
    Metadata: {
      ImageID: DIGEST_A,
      RepoTags: ["registry.example/app:1.2.3"],
      RepoDigests: [`registry.example/app@${opts.digest}`]
    },
    Results: [
      {
        Target: "registry.example/app:1.2.3 (alpine 3.19)",
        Class: "os-pkgs",
        Type: "alpine",
        Vulnerabilities: (opts.severities ?? []).map((sev, i) => ({
          VulnerabilityID: `CVE-2026-${1000 + i}`,
          PkgName: `pkg${i}`,
          Severity: sev
        }))
      }
    ]
  };
}

function testCtx(
  config: unknown,
  requestImpl?: (req: ScopedHttpRequest) => Promise<ScopedHttpResponse>
): PluginContext {
  return {
    orgId: "org-1",
    domainId: "domain-1",
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    secrets: { get: async () => undefined },
    http: {
      request: requestImpl ?? (async () => ({ status: 200, headers: {}, body: trivyResult({ digest: DIGEST_A }) }))
    },
    config
  };
}

const baseConfig: ScanResultControlConfig = { url: "https://scan.invalid/result.json", expectedDigest: DIGEST_A };

describe("scan-result-control plugin", () => {
  it("PASSES a clean verdict whose scanned digest matches the change's artifact digest, and emits typed evidence", async () => {
    const plugin = createScanResultControlPlugin();
    let seen: ScopedHttpRequest | undefined;
    const ctx = testCtx(baseConfig, async (req) => {
      seen = req;
      return { status: 200, headers: {}, body: trivyResult({ digest: DIGEST_A, severities: ["MEDIUM", "LOW"] }) };
    });

    const outcome = await plugin.evaluate(ctx, { changeId: "c1", controlId: "ctl1", context: {} });

    expect(outcome.status).toBe("pass");
    // PULL intake: fetched the operator-configured source (GET), never ran a scan itself.
    expect(seen?.method).toBe("GET");
    expect(seen?.url).toBe(baseConfig.url);
    // Evidence conforms to the typed supply-chain schema and carries the digest binding.
    const evidence = ScanEvidenceSchema.parse(outcome.evidence);
    expect(evidence.scanner).toBe("trivy");
    expect(evidence.digestMatch).toBe(true);
    expect(evidence.artifactDigest).toBe(DIGEST_A);
    expect(evidence.severityCounts).toEqual({ critical: 0, high: 0, medium: 1, low: 1 });
    expect(evidence.threshold).toMatchObject({ maxCritical: 0, maxHigh: 0 });
  });

  it("FAILS a verdict over threshold (any Critical by default) — fails closed on a real vulnerability", async () => {
    const plugin = createScanResultControlPlugin();
    const ctx = testCtx(baseConfig, async () => ({
      status: 200,
      headers: {},
      body: trivyResult({ digest: DIGEST_A, severities: ["CRITICAL", "HIGH", "LOW"] })
    }));
    const outcome = await plugin.evaluate(ctx, { changeId: "c1", controlId: "ctl1", context: {} });
    expect(outcome.status).toBe("fail");
    expect(outcome.detail).toMatch(/exceeds threshold/);
    const evidence = ScanEvidenceSchema.parse(outcome.evidence);
    expect(evidence.digestMatch).toBe(true); // digest is fine; it's the vuln count that blocks
    expect(evidence.severityCounts.critical).toBe(1);
  });

  it("honors a configurable threshold — HIGH under maxHigh passes, over maxHigh fails", async () => {
    const plugin = createScanResultControlPlugin();
    const config: ScanResultControlConfig = { ...baseConfig, threshold: { maxCritical: 0, maxHigh: 2 } };
    const twoHighs = testCtx(config, async () => ({
      status: 200,
      headers: {},
      body: trivyResult({ digest: DIGEST_A, severities: ["HIGH", "HIGH"] })
    }));
    expect((await plugin.evaluate(twoHighs, { changeId: "c1", controlId: "ctl1", context: {} })).status).toBe("pass");

    const threeHighs = testCtx(config, async () => ({
      status: 200,
      headers: {},
      body: trivyResult({ digest: DIGEST_A, severities: ["HIGH", "HIGH", "HIGH"] })
    }));
    expect((await plugin.evaluate(threeHighs, { changeId: "c1", controlId: "ctl1", context: {} })).status).toBe("fail");
  });

  it("FAILS on a DIGEST MISMATCH — a clean scan of a DIFFERENT artifact must NOT authorize the change", async () => {
    const plugin = createScanResultControlPlugin();
    // Scan is clean (no vulns) but it scanned DIGEST_B while the change is promoting DIGEST_A.
    const ctx = testCtx(baseConfig, async () => ({
      status: 200,
      headers: {},
      body: trivyResult({ digest: DIGEST_B, severities: [] })
    }));
    const outcome = await plugin.evaluate(ctx, { changeId: "c1", controlId: "ctl1", context: {} });
    expect(outcome.status).toBe("fail");
    expect(outcome.detail).toMatch(/digest mismatch/i);
    const evidence = ScanEvidenceSchema.parse(outcome.evidence);
    expect(evidence.digestMatch).toBe(false);
  });

  it("prefers context.artifactDigest over config.expectedDigest for the binding", async () => {
    const plugin = createScanResultControlPlugin();
    // config pins DIGEST_A, but the change's context says the artifact is DIGEST_B; the scan is of B.
    const ctx = testCtx({ url: baseConfig.url, expectedDigest: DIGEST_A }, async () => ({
      status: 200,
      headers: {},
      body: trivyResult({ digest: DIGEST_B, severities: [] })
    }));
    const outcome = await plugin.evaluate(ctx, {
      changeId: "c1",
      controlId: "ctl1",
      context: { artifactDigest: DIGEST_B }
    });
    expect(outcome.status).toBe("pass");
    expect(ScanEvidenceSchema.parse(outcome.evidence).expectedDigest).toBe(DIGEST_B);
  });

  it("FAILS CLOSED when the scan source is unreachable (rejected fetch), never an uncaught rejection", async () => {
    const plugin = createScanResultControlPlugin();
    const ctx = testCtx(baseConfig, async () => {
      throw new Error("ECONNREFUSED");
    });
    const outcome = await plugin.evaluate(ctx, { changeId: "c1", controlId: "ctl1", context: {} });
    expect(outcome.status).toBe("fail");
    expect(outcome.detail).toContain("ECONNREFUSED");
  });

  it("FAILS CLOSED on a timeout (source never responds within timeoutMs)", async () => {
    const plugin = createScanResultControlPlugin();
    const ctx = testCtx({ ...baseConfig, timeoutMs: 20 }, () => new Promise(() => {}));
    const outcome = await plugin.evaluate(ctx, { changeId: "c1", controlId: "ctl1", context: {} });
    expect(outcome.status).toBe("fail");
    expect(outcome.detail).toMatch(/no scan result within/);
  });

  it("FAILS CLOSED on a non-2xx response", async () => {
    const plugin = createScanResultControlPlugin();
    const ctx = testCtx(baseConfig, async () => ({ status: 404, headers: {}, body: "not found" }));
    const outcome = await plugin.evaluate(ctx, { changeId: "c1", controlId: "ctl1", context: {} });
    expect(outcome.status).toBe("fail");
    expect(outcome.evidence).toMatchObject({ httpStatus: 404 });
  });

  it("FAILS CLOSED on an unparseable / non-object body", async () => {
    const plugin = createScanResultControlPlugin();
    const ctx = testCtx(baseConfig, async () => ({ status: 200, headers: {}, body: "this is not trivy json" }));
    const outcome = await plugin.evaluate(ctx, { changeId: "c1", controlId: "ctl1", context: {} });
    expect(outcome.status).toBe("fail");
    expect(outcome.detail).toMatch(/unparseable/);
  });

  it("FAILS CLOSED when the Trivy result carries no artifact digest (can't verify the binding)", async () => {
    const plugin = createScanResultControlPlugin();
    const ctx = testCtx(baseConfig, async () => ({
      status: 200,
      headers: {},
      body: { SchemaVersion: 2, Results: [{ Vulnerabilities: [] }] } // no Metadata/ArtifactName
    }));
    const outcome = await plugin.evaluate(ctx, { changeId: "c1", controlId: "ctl1", context: {} });
    expect(outcome.status).toBe("fail");
    expect(outcome.detail).toMatch(/no artifact digest/);
  });

  it("FAILS CLOSED when no expected digest is available at all (can't bind the verdict)", async () => {
    const plugin = createScanResultControlPlugin();
    const ctx = testCtx({ url: baseConfig.url }, async () => ({
      status: 200,
      headers: {},
      body: trivyResult({ digest: DIGEST_A })
    }));
    const outcome = await plugin.evaluate(ctx, { changeId: "c1", controlId: "ctl1", context: {} });
    expect(outcome.status).toBe("fail");
    expect(outcome.detail).toMatch(/no expected artifact digest/);
  });

  it("missing 'url' config fails closed rather than throwing", async () => {
    const plugin = createScanResultControlPlugin();
    const ctx = testCtx({ expectedDigest: DIGEST_A });
    const outcome = await plugin.evaluate(ctx, { changeId: "c1", controlId: "ctl1", context: {} });
    expect(outcome.status).toBe("fail");
  });

  // -----------------------------------------------------------------------------------------
  // M17.5 (ADR-0016) — the gate-resolved, most-restrictive-wins scoped threshold on the request
  // context, preferred over the flat per-binding `config.threshold` exactly as `artifactDigest`
  // is preferred over `config.expectedDigest`.
  // -----------------------------------------------------------------------------------------

  const scopedContext = (threshold: Record<string, number>) => ({
    scanThreshold: {
      threshold,
      contributors: [{ tier: "platform" as const, source: "instance:platform:local", threshold }]
    }
  });

  it("M17.5: context.scanThreshold TIGHTENS a looser per-binding config.threshold (the scoped floor wins)", async () => {
    const plugin = createScanResultControlPlugin();
    const ctx = testCtx({ ...baseConfig, threshold: { maxCritical: 99, maxHigh: 99 } }, async () => ({
      status: 200,
      headers: {},
      body: trivyResult({ digest: DIGEST_A, severities: ["HIGH"] })
    }));
    const outcome = await plugin.evaluate(ctx, {
      changeId: "c1",
      controlId: "ctl1",
      context: scopedContext({ maxHigh: 0 })
    });
    expect(outcome.status).toBe("fail");
    const evidence = ScanEvidenceSchema.parse(outcome.evidence);
    expect(evidence.threshold.maxHigh).toBe(0);
    expect(evidence.thresholdSource).toBe("scoped");
    expect(evidence.thresholdContributors?.[0]?.tier).toBe("platform");
  });

  it("M17.5: a per-binding config.threshold can still TIGHTEN below the scoped floor — most-restrictive-wins is symmetric, never a loosening", async () => {
    const plugin = createScanResultControlPlugin();
    const ctx = testCtx({ ...baseConfig, threshold: { maxCritical: 0, maxHigh: 0 } }, async () => ({
      status: 200,
      headers: {},
      body: trivyResult({ digest: DIGEST_A, severities: ["HIGH"] })
    }));
    const outcome = await plugin.evaluate(ctx, {
      changeId: "c1",
      controlId: "ctl1",
      context: scopedContext({ maxHigh: 50 })
    });
    expect(outcome.status).toBe("fail");
    expect(ScanEvidenceSchema.parse(outcome.evidence).threshold.maxHigh).toBe(0);
  });

  it("M17.5: a severity the scoped floor sets but config does not is applied verbatim (no phantom 0 default)", async () => {
    const plugin = createScanResultControlPlugin();
    const ctx = testCtx(baseConfig, async () => ({
      status: 200,
      headers: {},
      body: trivyResult({ digest: DIGEST_A, severities: ["MEDIUM", "MEDIUM"] })
    }));
    const outcome = await plugin.evaluate(ctx, {
      changeId: "c1",
      controlId: "ctl1",
      context: scopedContext({ maxMedium: 5 })
    });
    expect(outcome.status).toBe("pass");
    expect(ScanEvidenceSchema.parse(outcome.evidence).threshold.maxMedium).toBe(5);
  });

  it("M17.5: a PRESENT-but-malformed context.scanThreshold FAILS CLOSED rather than silently using the looser per-binding threshold", async () => {
    const plugin = createScanResultControlPlugin();
    const ctx = testCtx({ ...baseConfig, threshold: { maxCritical: 99, maxHigh: 99 } }, async () => ({
      status: 200,
      headers: {},
      body: trivyResult({ digest: DIGEST_A })
    }));
    const outcome = await plugin.evaluate(ctx, {
      changeId: "c1",
      controlId: "ctl1",
      context: { scanThreshold: { threshold: { maxHigh: "zero" } } }
    });
    expect(outcome.status).toBe("fail");
    expect(outcome.detail).toMatch(/malformed/);
  });
});
