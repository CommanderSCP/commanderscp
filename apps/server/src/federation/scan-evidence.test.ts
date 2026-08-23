import { describe, it, expect } from "vitest";
import {
  MANAGED_SCAN_CONTROL_OBJECT_ID,
  evaluateScanCoverage,
  isScanEvidenceProducer,
  mergeInstanceFloor,
  type ScanRunLike,
  type SeverityCeiling
} from "./scan-evidence.js";

/**
 * THE BOUNDARY SCAN-EVIDENCE RULE — the algebra, in isolation from Postgres.
 *
 * Every case here is an authorization case: `evaluateScanCoverage` is what decides whether an
 * artifact may cross a security-domain boundary, and it is the SHARED core of the M17.3 E6 export
 * gate and the ADR-0020 promotion scan step's short-circuit. The end-to-end proofs (a real
 * `webhook-control` row refused at a real export, a real superseding failure) live in
 * `federation.integration.test.ts`; this file pins the rule's edges cheaply and exhaustively.
 */

const DIGEST = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const OTHER = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const NO_FLOOR: SeverityCeiling = {};

let seq = 0;
/** uuidv7-like: lexicographically increasing, so `id` is a valid same-millisecond tie-break. */
function nextId(): string {
  seq += 1;
  return `0189${String(seq).padStart(8, "0")}-0000-7000-8000-000000000000`;
}

function run(over: Partial<ScanRunLike> & { evidence?: Record<string, unknown> }): ScanRunLike {
  return {
    id: over.id ?? nextId(),
    controlObjectId: over.controlObjectId ?? "c0000000-0000-4000-8000-000000000001",
    pluginModule: over.pluginModule === undefined ? "scan-result-control" : over.pluginModule,
    status: over.status ?? "pass",
    createdAt: over.createdAt ?? new Date(1_700_000_000_000 + seq * 1000),
    evidence: over.evidence ?? passingEvidence()
  };
}

function passingEvidence(
  over: Record<string, unknown> = {},
  counts: { critical?: number; high?: number; medium?: number; low?: number } = {}
): Record<string, unknown> {
  return {
    scanner: "trivy",
    scannerVersion: "0.50.0",
    artifactDigest: DIGEST,
    expectedDigest: DIGEST,
    digestMatch: true,
    severityCounts: {
      critical: counts.critical ?? 0,
      high: counts.high ?? 0,
      medium: counts.medium ?? 0,
      low: counts.low ?? 0
    },
    threshold: { maxCritical: 0, maxHigh: 0 },
    ...over
  };
}

function covers(runs: ScanRunLike[], floor: SeverityCeiling = NO_FLOOR) {
  return evaluateScanCoverage({ digest: DIGEST, runs, instanceFloor: floor });
}

describe("producer admission — a scan outcome is WHAT PRODUCED IT, never the shape of its evidence", () => {
  it("admits the org-pipeline ingress (`scan-result-control`) and the commander's own step", () => {
    expect(isScanEvidenceProducer(run({ pluginModule: "scan-result-control" }))).toBe(true);
    expect(
      isScanEvidenceProducer(
        run({ controlObjectId: MANAGED_SCAN_CONTROL_OBJECT_ID, pluginModule: null })
      )
    ).toBe(true);
  });

  it("REFUSES a webhook-control row carrying byte-perfect ScanEvidence — THE bypass this rule closes", () => {
    // `@scp/plugin-webhook-control` returns `body.status` and `body.evidence` VERBATIM from an
    // operator-configured URL, and `control-runner.ts` persists `outcome.evidence` verbatim. So this
    // row is exactly what a binding pointed at an attacker-chosen endpoint produces, and under
    // shape-identification it satisfied E6 in full.
    const forged = run({ pluginModule: "webhook-control", evidence: passingEvidence() });
    expect(isScanEvidenceProducer(forged)).toBe(false);

    const verdict = covers([forged]);
    expect(verdict.covered).toBe(false);
    if (verdict.covered) throw new Error("unreachable");
    expect(verdict.code).toBe("no_scan_outcome");
    // And the Decision can say what WAS there, so an operator is not left guessing.
    expect(verdict.detail.producersSeen).toEqual(["webhook-control"]);
  });

  it("REFUSES github-check, and an unattributable NULL-module row under a real control id", () => {
    expect(covers([run({ pluginModule: "github-check" })]).covered).toBe(false);
    // NULL under a REAL control id = a pre-0064 row, or `ensureControlRun`'s missing-binding `fail`.
    // What produced it is unrecorded, and an unattributable row is not evidence about anything.
    expect(covers([run({ pluginModule: null })]).covered).toBe(false);
  });

  it("REFUSES a row that CLAIMS the commander's synthetic control id but names a module", () => {
    // Nothing but the step itself may wear the commander's identity, and the step deposits with no
    // binding — so a module here means something else wrote it.
    expect(
      covers([
        run({ controlObjectId: MANAGED_SCAN_CONTROL_OBJECT_ID, pluginModule: "webhook-control" })
      ]).covered
    ).toBe(false);
  });

  it("ADMITS the genuine article, both ingresses", () => {
    expect(covers([run({ pluginModule: "scan-result-control" })]).covered).toBe(true);
    expect(
      covers([run({ controlObjectId: MANAGED_SCAN_CONTROL_OBJECT_ID, pluginModule: null })]).covered
    ).toBe(true);
  });
});

describe("recency — the LATEST answer to each question wins", () => {
  const control = "c0000000-0000-4000-8000-0000000000aa";

  it("a later FAIL from the same control supersedes an earlier pass", () => {
    const earlierPass = run({ controlObjectId: control, createdAt: new Date(1000) });
    const laterFail = run({
      controlObjectId: control,
      createdAt: new Date(2000),
      status: "fail",
      // A real `scan-result-control` failure often emits a PARTIAL bag, not a full ScanEvidence —
      // which is why the artifact attribution reads `expectedDigest` off the raw evidence rather
      // than off a successful parse. Attribution has to survive the failure.
      evidence: { url: "https://ci.example/scan.json", expectedDigest: DIGEST }
    });
    const verdict = covers([earlierPass, laterFail]);
    expect(verdict.covered).toBe(false);
    if (verdict.covered) throw new Error("unreachable");
    expect(verdict.code).toBe("not_passing");
  });

  it("a later PASS clears an earlier fail — the direction ADR-0033's re-evaluation depends on", () => {
    // An exclusion grant, or a fixed scanner DB, produces a NEW passing run. If supersession only
    // worked in the objecting direction, every grant would be inert at this boundary forever.
    const earlierFail = run({
      controlObjectId: control,
      createdAt: new Date(1000),
      status: "fail",
      evidence: { url: "https://ci.example/scan.json", expectedDigest: DIGEST }
    });
    const laterPass = run({ controlObjectId: control, createdAt: new Date(2000) });
    expect(covers([earlierFail, laterPass]).covered).toBe(true);
  });

  it("ties on createdAt break on the uuidv7 id, so 'latest' is total and not row-order dependent", () => {
    const at = new Date(5000);
    const pass = run({ controlObjectId: control, createdAt: at, id: nextId() });
    const fail = run({
      controlObjectId: control,
      createdAt: at,
      id: nextId(), // minted after `pass`, therefore lexicographically greater
      status: "fail",
      evidence: { expectedDigest: DIGEST }
    });
    expect(covers([pass, fail]).covered).toBe(false);
    expect(covers([fail, pass]).covered).toBe(false); // and independent of the array order
  });

  it("a failing run about a DIFFERENT artifact does not block this one", () => {
    const otherFail = run({
      controlObjectId: control,
      createdAt: new Date(9000),
      status: "fail",
      evidence: { expectedDigest: OTHER }
    });
    const pass = run({ controlObjectId: "c0000000-0000-4000-8000-0000000000bb" });
    expect(covers([pass, otherFail]).covered).toBe(true);
  });
});

describe("the commander's step multiplexes methods, so its question key carries the scanner", () => {
  const managed = (
    scanner: string,
    status: string,
    createdAt: Date,
    evidence?: Record<string, unknown>
  ) =>
    run({
      controlObjectId: MANAGED_SCAN_CONTROL_OBJECT_ID,
      pluginModule: null,
      status,
      createdAt,
      evidence: evidence ?? passingEvidence({ scanner })
    });

  it("EVERY assigned method must pass — a trivy pass does not carry a failing openscap", () => {
    const trivyPass = managed("trivy", "pass", new Date(1000));
    const oscapFail = managed("openscap", "fail", new Date(1001), {
      ...passingEvidence({ scanner: "openscap" }),
      severityCounts: { critical: 0, high: 3, medium: 0, low: 0 }
    });
    expect(covers([trivyPass, oscapFail]).covered).toBe(false);
  });

  it("...and the verdict does not depend on WHICH method the deposit loop happened to write last", () => {
    // Keying supersession on the control id alone would make this order-dependent: the two rows are
    // written milliseconds apart under the SAME synthetic id, so whichever landed second would
    // decide a cross-boundary crossing.
    const oscapFailFirst = managed("openscap", "fail", new Date(1000), {
      ...passingEvidence({ scanner: "openscap" }),
      severityCounts: { critical: 0, high: 3, medium: 0, low: 0 }
    });
    const trivyPassSecond = managed("trivy", "pass", new Date(1001));
    expect(covers([oscapFailFirst, trivyPassSecond]).covered).toBe(false);
  });

  it("all methods passing covers the artifact", () => {
    expect(
      covers([
        managed("trivy", "pass", new Date(1000)),
        managed("openscap", "pass", new Date(1001))
      ]).covered
    ).toBe(true);
  });
});

describe("digest binding is re-verified at the boundary, unchanged", () => {
  it("refuses a pass whose scanned digest is not the promoted one", () => {
    const v = covers([run({ evidence: passingEvidence({ artifactDigest: OTHER }) })]);
    expect(v.covered).toBe(false);
    if (v.covered) throw new Error("unreachable");
    expect(v.code).toBe("not_digest_bound");
  });

  it("refuses a pass whose digestMatch is false", () => {
    const v = covers([run({ evidence: passingEvidence({ digestMatch: false }) })]);
    expect(v.covered).toBe(false);
    if (v.covered) throw new Error("unreachable");
    expect(v.code).toBe("not_digest_bound");
  });

  it("refuses an admitted producer's PASS whose evidence is not a readable verdict", () => {
    const v = covers([run({ evidence: { expectedDigest: DIGEST, note: "not a scan verdict" } })]);
    expect(v.covered).toBe(false);
    if (v.covered) throw new Error("unreachable");
    expect(v.code).toBe("malformed_evidence");
  });

  it("a run with no expectedDigest is about no artifact — it neither satisfies nor blocks", () => {
    expect(
      covers([run({ evidence: passingEvidence({ expectedDigest: undefined }) })]).covered
    ).toBe(false);
  });
});

describe("the operator's instance floor binds at the boundary (ADR-0016 §3)", () => {
  it("with NO floor authored the check constrains nothing — byte-identical to before it existed", () => {
    const dirty = run({ evidence: passingEvidence({}, { critical: 9, high: 9 }) });
    expect(covers([dirty], NO_FLOOR).covered).toBe(true);
  });

  it("refuses a control-level PASS whose findings exceed the operator floor", () => {
    // The scenario: a tenant-authored per-binding `config.threshold` decided this verdict (which
    // `scan-result-control` permits when the gate threads no scoped ceiling), so the control said
    // pass. The floor is not the tenant's to set, and this is the operator's boundary.
    const dirty = run({
      evidence: passingEvidence({ threshold: { maxCritical: 50, maxHigh: 50 } }, { high: 4 })
    });
    const v = covers([dirty], { maxHigh: 0 });
    expect(v.covered).toBe(false);
    if (v.covered) throw new Error("unreachable");
    expect(v.code).toBe("below_instance_floor");
    expect(v.detail.breached).toEqual([{ severity: "maxHigh", count: 4, ceiling: 0 }]);
  });

  it("admits findings AT the floor — a ceiling is a maximum, not a strict inequality", () => {
    expect(
      covers([run({ evidence: passingEvidence({}, { high: 2 }) })], { maxHigh: 2 }).covered
    ).toBe(true);
  });

  it("merges floors per-severity by MIN, order-independently", () => {
    const a = {
      tier: "platform" as const,
      source: "instance:platform:local",
      threshold: { maxHigh: 5 }
    };
    const b = {
      tier: "trust_domain" as const,
      source: "instance:trust_domain:local",
      threshold: { maxHigh: 1, maxCritical: 0 }
    };
    expect(mergeInstanceFloor([a, b])).toEqual({ maxHigh: 1, maxCritical: 0 });
    expect(mergeInstanceFloor([b, a])).toEqual({ maxHigh: 1, maxCritical: 0 });
  });

  it("ABSENT NEVER MEANS ZERO — a severity no floor constrains is unconstrained, not capped at 0", () => {
    expect(mergeInstanceFloor([]).maxHigh).toBeUndefined();
    expect(
      covers([run({ evidence: passingEvidence({}, { medium: 99 }) })], { maxHigh: 0 }).covered
    ).toBe(true);
  });
});

describe("M22.9 — a verdict is only current while the exclusion set it was judged under is", () => {
  const H1 = "1111111111111111111111111111111111111111111111111111111111111111";
  const H2 = "2222222222222222222222222222222222222222222222222222222222222222";

  /** The gate call WITH the M22.9 argument. `covers()` above deliberately omits it, so every other
   *  test in this file is also a standing check that a caller which never opts in is unaffected. */
  function coversUnder(runs: ScanRunLike[], expected: string | undefined, floor = NO_FLOOR) {
    return evaluateScanCoverage({
      digest: DIGEST,
      runs,
      instanceFloor: floor,
      expectedExclusionSetHash: expected
    });
  }

  it("NOTHING RESOLVED, NOTHING RECORDED — byte-identical to before this check existed", () => {
    // M22.2's promise to every deployment that has authored no exclusion, which is nearly all of
    // them. `undefined !== undefined` is false, so the check cannot fire.
    const plain = run({});
    expect(covers([plain]).covered).toBe(true);
    // ...and passing the argument explicitly as `undefined` is the SAME call, by construction: the
    // comparison is a value test, not a key-presence test, so no caller can half-opt-in.
    expect(coversUnder([plain], undefined).covered).toBe(true);
  });

  it("the set has not moved — the verdict stands", () => {
    expect(
      coversUnder([run({ evidence: passingEvidence({ exclusionSetHash: H1 }) })], H1).covered
    ).toBe(true);
  });

  it("REFUSES a pass judged under a set that has since moved — THE defect this closes", () => {
    // The scenario end to end: an override grant was live, the scan passed under it, the grant
    // expired. NOTHING about the row changes on expiry — it is a read-time window in the resolver,
    // ADR-0033 having rejected a status-flipping sweeper — so without this the same row keeps
    // authorizing crossings and `promotion-repo.ts` signs a bundle on a waiver that is gone.
    const v = coversUnder([run({ evidence: passingEvidence({ exclusionSetHash: H1 }) })], H2);
    expect(v.covered).toBe(false);
    if (v.covered) throw new Error("unreachable");
    expect(v.code).toBe("stale_exclusion_set");
    // Both sides in the Decision: "the set moved" and "this run predates stamping" are different
    // things to go and fix.
    expect(v.detail.recordedExclusionSetHash).toBe(H1);
    expect(v.detail.expectedExclusionSetHash).toBe(H2);
  });

  it("REFUSES an UNSTAMPED (pre-M22.7) run when clauses ARE in force — fail-closed", () => {
    // The honest reading of a missing stamp is "unknown", never "fine". It costs a re-scan on the
    // short-circuit's side of this rule and a re-export on the gate's; it never costs a crossing.
    const v = coversUnder([run({ evidence: passingEvidence() })], H1);
    expect(v.covered).toBe(false);
    if (v.covered) throw new Error("unreachable");
    expect(v.code).toBe("stale_exclusion_set");
    expect(v.detail.recordedExclusionSetHash).toBe(null);
  });

  it("REFUSES a stamped run once EVERY clause has been withdrawn", () => {
    // The other direction of the same asymmetry, and the one an operator reaches by deleting the
    // policy rather than by waiting: the verdict was judged under a strictly looser set than the
    // (empty) one now in force.
    const v = coversUnder(
      [run({ evidence: passingEvidence({ exclusionSetHash: H1 }) })],
      undefined
    );
    expect(v.covered).toBe(false);
    if (v.covered) throw new Error("unreachable");
    expect(v.code).toBe("stale_exclusion_set");
  });

  it("is checked BEFORE the instance floor — the counts are a product of the set", () => {
    // Order is load-bearing rather than incidental: the number the floor compares is derived from
    // the exclusion set (literally so once `effectiveSeverityCounts` is what gets compared —
    // ADR-0033 §2), so "which set was this judged under" has to be settled first. If the floor check
    // ran first this would report `below_instance_floor` and an operator would go and edit a floor.
    const v = coversUnder(
      [run({ evidence: passingEvidence({ exclusionSetHash: H1 }, { high: 4 }) })],
      H2,
      { maxHigh: 0 }
    );
    expect(v.covered).toBe(false);
    if (v.covered) throw new Error("unreachable");
    expect(v.code).toBe("stale_exclusion_set");
  });

  it("is checked AFTER the digest binding — a verdict about another artifact is not a stale answer", () => {
    const v = coversUnder(
      [run({ evidence: passingEvidence({ artifactDigest: OTHER, exclusionSetHash: H1 }) })],
      H2
    );
    expect(v.covered).toBe(false);
    if (v.covered) throw new Error("unreachable");
    expect(v.code).toBe("not_digest_bound");
  });

  it("a stale hash does not mask a newer FAILURE — supersession still decides first", () => {
    const control = "c0000000-0000-4000-8000-0000000000cc";
    const pass = run({
      controlObjectId: control,
      createdAt: new Date(1000),
      evidence: passingEvidence({ exclusionSetHash: H1 })
    });
    const laterFail = run({
      controlObjectId: control,
      createdAt: new Date(2000),
      status: "fail",
      evidence: { expectedDigest: DIGEST }
    });
    const v = coversUnder([pass, laterFail], H2);
    expect(v.covered).toBe(false);
    if (v.covered) throw new Error("unreachable");
    expect(v.code).toBe("not_passing");
  });
});

describe("fail-closed on nothing at all", () => {
  it("no runs whatsoever refuses, and says so as `no_scan_outcome`", () => {
    const v = covers([]);
    expect(v.covered).toBe(false);
    if (v.covered) throw new Error("unreachable");
    expect(v.code).toBe("no_scan_outcome");
    expect(v.detail.controlRunsOnChange).toBe(0);
  });
});
