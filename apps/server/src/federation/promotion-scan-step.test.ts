import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ScanMethodSchema } from "@scp/schemas";
import { SUPPORTED_SCAN_METHODS } from "@scp/plugin-managed-scan";
import {
  createServerManagedScanRunner,
  parseOscapResult,
  RUNNER_SUPPORTED_METHODS
} from "./promotion-scan-step.js";

/**
 * M13.3b — parseOscapResult unit tests (ADR-0020 §2, proposal §13.3). The server-side distillation of
 * an OpenSCAP XCCDF/ARF result into the four ScanSeverityCounts. Pure, no Docker — runs in the fast
 * `pnpm test` layer. The end-to-end "real oscap → E6" proof lives in the integration suite.
 *
 * The MAPPING under test (decided, ADR-0020 §2): XCCDF high→high, medium→medium, low→low; XCCDF has
 * NO `critical` severity so `critical` stays 0 (the no-critical property); `unknown`/`info`/unset fold
 * away. Only `fail` rule-results count. A malformed/empty document FAILS CLOSED (throws) rather than
 * silently reporting zero findings.
 */

/** A compact XCCDF TestResult carrying the given rule-results (severity, result). */
function xccdf(rows: Array<{ sev?: string; result: string; prefix?: string }>): string {
  const body = rows
    .map(({ sev, result, prefix = "" }) => {
      const sevAttr = sev !== undefined ? ` severity="${sev}"` : "";
      return `<${prefix}rule-result idref="xccdf_test_rule_x"${sevAttr}><${prefix}result>${result}</${prefix}result></${prefix}rule-result>`;
    })
    .join("");
  return `<?xml version="1.0"?><Benchmark><TestResult id="xccdf_test">${body}</TestResult></Benchmark>`;
}

describe("parseOscapResult — severity mapping", () => {
  it("counts FAILED rules by severity: high→high, medium→medium, low→low", () => {
    const xml = xccdf([
      { sev: "high", result: "fail" },
      { sev: "high", result: "fail" },
      { sev: "medium", result: "fail" },
      { sev: "low", result: "fail" },
      { sev: "low", result: "fail" },
      { sev: "low", result: "fail" }
    ]);
    const { severityCounts } = parseOscapResult(xml);
    expect(severityCounts).toEqual({ critical: 0, high: 2, medium: 1, low: 3 });
  });

  it("the NO-CRITICAL property: XCCDF has no `critical`, so critical is always 0", () => {
    // Even a high-heavy result never yields a critical count — operators gate OpenSCAP on `high`.
    const xml = xccdf([
      { sev: "high", result: "fail" },
      { sev: "high", result: "fail" },
      { sev: "high", result: "fail" }
    ]);
    expect(parseOscapResult(xml).severityCounts.critical).toBe(0);
  });

  it("folds `unknown`/`info`/unset-severity fails away (like trivy's UNKNOWN)", () => {
    const xml = xccdf([
      { sev: "unknown", result: "fail" },
      { sev: "info", result: "fail" },
      { result: "fail" }, // no severity attribute at all
      { sev: "high", result: "fail" }
    ]);
    expect(parseOscapResult(xml).severityCounts).toEqual({
      critical: 0,
      high: 1,
      medium: 0,
      low: 0
    });
  });

  it("only `fail` counts — pass/notapplicable/notchecked/notselected/error are NOT findings", () => {
    const xml = xccdf([
      { sev: "high", result: "pass" },
      { sev: "high", result: "notapplicable" },
      { sev: "high", result: "notchecked" },
      { sev: "high", result: "notselected" },
      { sev: "high", result: "error" },
      { sev: "high", result: "fail" }
    ]);
    expect(parseOscapResult(xml).severityCounts).toEqual({
      critical: 0,
      high: 1,
      medium: 0,
      low: 0
    });
  });

  it("a genuinely clean scan (rule-results present, zero fails) reports all-zero counts (NOT a throw)", () => {
    const xml = xccdf([
      { sev: "high", result: "pass" },
      { sev: "low", result: "notapplicable" }
    ]);
    expect(parseOscapResult(xml).severityCounts).toEqual({
      critical: 0,
      high: 0,
      medium: 0,
      low: 0
    });
  });

  it("handles namespace-prefixed elements (e.g. cdf:rule-result / cdf:result)", () => {
    const xml = xccdf([
      { sev: "high", result: "fail", prefix: "cdf:" },
      { sev: "medium", result: "fail", prefix: "cdf:" }
    ]);
    expect(parseOscapResult(xml).severityCounts).toEqual({
      critical: 0,
      high: 1,
      medium: 1,
      low: 0
    });
  });

  it("scannedDigest is always undefined (an ARF carries no image digest — binding is the pull)", () => {
    expect(parseOscapResult(xccdf([{ sev: "low", result: "fail" }])).scannedDigest).toBeUndefined();
  });

  it("parses the oscap version from the version header, else `unknown`", () => {
    const xml = xccdf([{ sev: "low", result: "pass" }]);
    expect(parseOscapResult(xml, "OpenSCAP command line tool (oscap) 1.4.2\n").scannerVersion).toBe(
      "1.4.2"
    );
    expect(parseOscapResult(xml).scannerVersion).toBe("unknown");
  });
});

describe("parseOscapResult — fail-closed on malformed input", () => {
  it("throws on empty/blank input (never silently zero)", () => {
    expect(() => parseOscapResult("")).toThrow(/empty/i);
    expect(() => parseOscapResult("   \n ")).toThrow(/empty/i);
    expect(() => parseOscapResult(undefined)).toThrow();
    expect(() => parseOscapResult(null)).toThrow();
  });

  it("throws on non-XCCDF content (no TestResult / no rule-result) — not zero findings", () => {
    expect(() => parseOscapResult("<html><body>gateway timeout</body></html>")).toThrow(
      /XCCDF|ARF/i
    );
    expect(() => parseOscapResult('{"Results":[]}')).toThrow(/XCCDF|ARF/i);
  });

  it("throws when a TestResult is present but carries ZERO rule-results (malformed/empty scan)", () => {
    const xml = `<?xml version="1.0"?><Benchmark><TestResult id="xccdf_test"></TestResult></Benchmark>`;
    expect(() => parseOscapResult(xml)).toThrow(/no rule-results/i);
  });

  it("truncated XML mid-rule-result does not throw parser internals but never fabricates a pass", () => {
    // A dangling opening tag with no closing rule-result: the regex simply matches nothing, and with
    // a TestResult present but zero COMPLETE rule-results it fails closed.
    const xml = `<?xml version="1.0"?><Benchmark><TestResult><rule-result severity="high"><result>fa`;
    expect(() => parseOscapResult(xml)).toThrow(/no rule-results/i);
  });
});

// =================================================================================================
// 13.3a — THE MACHINE-IMAGE ARM (`trivy-vm`): the two seams a new scan method can silently escape.
// =================================================================================================

/**
 * SEAM 1 — DISPATCH CONTAINMENT. The server decides WHICH method to hand the orchestrator; the
 * orchestrator decides which methods it will RUN. They are separate lists in separate packages (the
 * plugin does not depend on `@scp/schemas`), so a method added to only one of them either never runs
 * or is dispatched into a container that exits 2. This pins the direction that matters.
 */
describe("runner-supported methods ⊆ orchestrator-dispatchable methods", () => {
  it("every method the server dispatches is one the managed-scan plugin will run", () => {
    for (const method of RUNNER_SUPPORTED_METHODS) {
      expect(
        SUPPORTED_SCAN_METHODS,
        `server dispatches '${method}' but @scp/plugin-managed-scan would refuse it`
      ).toContain(method);
    }
  });

  it("every runner-supported method is a valid ScanMethod (no invented value)", () => {
    for (const method of RUNNER_SUPPORTED_METHODS) {
      expect(ScanMethodSchema.safeParse(method).success).toBe(true);
    }
  });

  it("the machine-image arm is actually dispatchable (not merely enumerated in the schema)", () => {
    expect(RUNNER_SUPPORTED_METHODS.has("trivy-vm")).toBe(true);
  });
});

/**
 * SEAM 2 — THE SCANNER-DB STALENESS GATE. `trivy vm` reads the SAME vulnerability DB as
 * `trivy image`, so the M13.3b-ii staleness gate MUST fire for it. The bug this test exists to catch
 * is precise and was live in the code before this increment: the gate was written as
 * `method === "trivy"`, so a machine-image scan would sail past a missing/corrupt/hard-stale DB
 * cache, scan against whatever the image happened to bake, and still deposit PASSING evidence.
 *
 * Behavioural, not textual: a CONFIGURED-but-EMPTY cache dir must make the runner refuse BEFORE it
 * pulls anything, for every Trivy-family method — and must NOT do so for OpenSCAP, which evaluates
 * baked SSG content and has no Trivy DB to be stale.
 */
describe("the Trivy-DB staleness gate covers the machine-image arm", () => {
  const digest = `sha256:${"b".repeat(64)}`;
  let emptyCache: string;
  const saved: Record<string, string | undefined> = {};

  beforeEach(async () => {
    emptyCache = await mkdtemp(join(tmpdir(), "scp-scan-db-gate-"));
    for (const k of [
      "SCP_MANAGED_SCAN_RUNNER_IMAGE",
      "SCP_MANAGED_SCAN_DB_CACHE",
      "SCP_ARTIFACT_OCI_REGISTRY_HOSTS"
    ]) {
      saved[k] = process.env[k];
    }
    process.env.SCP_MANAGED_SCAN_RUNNER_IMAGE = "scp-runner-scan:unit-test";
    process.env.SCP_MANAGED_SCAN_DB_CACHE = emptyCache; // configured, but carries no db/trivy.db
    process.env.SCP_ARTIFACT_OCI_REGISTRY_HOSTS = "registry.example.test";
  });

  afterEach(async () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await rm(emptyCache, { recursive: true, force: true });
  });

  it.each(["trivy", "trivy-vm"] as const)(
    "%s refuses on a configured-but-empty DB cache (fail-closed, no evidence)",
    async (method) => {
      const runner = createServerManagedScanRunner();
      const result = await runner.scan({
        method,
        digest,
        pullRef: `registry.example.test/scp/subject@${digest}`
      });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected a fail-closed refusal");
      // The refusal is the DB classification, not an incidental downstream failure — i.e. the gate
      // fired, rather than the scan getting far enough to fail for some other reason.
      expect(result.reason).toMatch(/DB|database|cache/i);
    }
  );

  it("openscap is NOT gated on the Trivy DB (it evaluates baked SSG content)", async () => {
    const runner = createServerManagedScanRunner();
    const result = await runner.scan({
      method: "openscap",
      digest,
      // Deliberately a host OUTSIDE the allowlist: openscap must get PAST the DB gate and be stopped
      // by the egress allowlist instead. If the DB gate wrongly covered openscap, the reason below
      // would name the DB and this assertion would fail.
      pullRef: `not-allowlisted.example.test/scp/subject@${digest}`
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a fail-closed refusal");
    expect(result.reason).toMatch(/SCP_ARTIFACT_OCI_REGISTRY_HOSTS|not in/i);
    expect(result.reason).not.toMatch(/trivy\.db|DB cache/i);
  });
});
