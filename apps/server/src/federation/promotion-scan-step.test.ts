import { describe, expect, it } from "vitest";
import { parseOscapResult } from "./promotion-scan-step.js";

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
    expect(parseOscapResult(xml).severityCounts).toEqual({ critical: 0, high: 1, medium: 0, low: 0 });
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
    expect(parseOscapResult(xml).severityCounts).toEqual({ critical: 0, high: 1, medium: 0, low: 0 });
  });

  it("a genuinely clean scan (rule-results present, zero fails) reports all-zero counts (NOT a throw)", () => {
    const xml = xccdf([
      { sev: "high", result: "pass" },
      { sev: "low", result: "notapplicable" }
    ]);
    expect(parseOscapResult(xml).severityCounts).toEqual({ critical: 0, high: 0, medium: 0, low: 0 });
  });

  it("handles namespace-prefixed elements (e.g. cdf:rule-result / cdf:result)", () => {
    const xml = xccdf([
      { sev: "high", result: "fail", prefix: "cdf:" },
      { sev: "medium", result: "fail", prefix: "cdf:" }
    ]);
    expect(parseOscapResult(xml).severityCounts).toEqual({ critical: 0, high: 1, medium: 1, low: 0 });
  });

  it("scannedDigest is always undefined (an ARF carries no image digest — binding is the pull)", () => {
    expect(parseOscapResult(xccdf([{ sev: "low", result: "fail" }])).scannedDigest).toBeUndefined();
  });

  it("parses the oscap version from the version header, else `unknown`", () => {
    const xml = xccdf([{ sev: "low", result: "pass" }]);
    expect(parseOscapResult(xml, "OpenSCAP command line tool (oscap) 1.4.2\n").scannerVersion).toBe("1.4.2");
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
    expect(() => parseOscapResult("<html><body>gateway timeout</body></html>")).toThrow(/XCCDF|ARF/i);
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
