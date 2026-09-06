import { describe, expect, it } from "vitest";
import { vendorLatestPackageKey, type ScanVendorLatestFacts } from "@scp/schemas";
import {
  VENDOR_LATEST_STALENESS_POLL_CYCLES,
  evaluateVendorLineAtHead,
  foldVendorLatestFacts,
  intersectVendorLatestFacts,
  vendorLatestStalenessBoundMs,
  type VendorInventoryRow
} from "./scan-vendor-latest.js";

/**
 * M22.4 (ADR-0033, owner decision D1) — THE VENDOR RULE'S ARITHMETIC, pure.
 *
 * Everything here is about the direction of a MISSING fact. A vendor-pass removes a finding before
 * it is counted, so an absence read the wrong way does not produce an error, it produces a PASS —
 * and the pass looks exactly like a component that really is current. Each `it` below is one of the
 * absences ADR-0033 and the M22 definition of done enumerate, and each asserts the refusal by its
 * NAME rather than by "not at head", so a future edit that collapses two refusals into one has to
 * say so out loud.
 *
 * MUTATIONS RUN — measured, each reverted by an exact inverse edit; recorded in the increment report.
 */

const NOW = new Date("2026-08-17T12:00:00.000Z");
/** The default poll interval is daily, so the default bound is three days. Computed, never spelled,
 *  for the same reason the production code computes it. */
const BOUND = vendorLatestStalenessBoundMs({});
const FRESH = new Date(NOW.getTime() - 1000);
const OPTS = { now: NOW, stalenessBoundMs: BOUND };

const npmLine = (over: Partial<VendorInventoryRow> = {}): VendorInventoryRow => ({
  lineId: "line-npm",
  ecosystem: "npm",
  coordinate: "lodash",
  major: "4",
  tagPattern: null,
  latestVersion: "4.17.21",
  latestDigest: null,
  latestObservedAt: FRESH,
  resolvedVersion: "4.17.21",
  resolvedDigest: null,
  ...over
});

const ociLine = (over: Partial<VendorInventoryRow> = {}): VendorInventoryRow => ({
  lineId: "line-oci",
  ecosystem: "oci",
  coordinate: "docker.io/library/alpine",
  major: "3",
  tagPattern: null,
  latestVersion: "3.19.1",
  latestDigest: "sha256:aaaa",
  latestObservedAt: FRESH,
  resolvedVersion: "3.19.1",
  resolvedDigest: "sha256:aaaa",
  ...over
});

// ===========================================================================================
// The freshness bound is DERIVED, never spelled
// ===========================================================================================

describe("the staleness bound is derived from the poll interval, never hardcoded", () => {
  it("moves with SCP_DEPENDENCY_VERSION_POLL_INTERVAL_SECONDS", () => {
    // If somebody replaces this with a literal duration the two configurations disagree the first
    // time anyone changes the poll cadence — and the gate silently starts refusing (or accepting)
    // observations the poll considers current.
    const hourly = vendorLatestStalenessBoundMs({
      SCP_DEPENDENCY_VERSION_POLL_INTERVAL_SECONDS: "3600"
    });
    const daily = vendorLatestStalenessBoundMs({
      SCP_DEPENDENCY_VERSION_POLL_INTERVAL_SECONDS: "86400"
    });
    expect(hourly).toBe(3600 * 1000 * VENDOR_LATEST_STALENESS_POLL_CYCLES);
    expect(daily).toBe(86_400 * 1000 * VENDOR_LATEST_STALENESS_POLL_CYCLES);
    expect(daily).toBeGreaterThan(hourly);
  });

  it("inherits the poll's own 5-minute FLOOR rather than re-deriving one", () => {
    // A misconfigured `0` cannot turn the bound into "every observation is stale", because the
    // interval function it is built on refuses to go below 300s.
    expect(
      vendorLatestStalenessBoundMs({ SCP_DEPENDENCY_VERSION_POLL_INTERVAL_SECONDS: "0" })
    ).toBe(300 * 1000 * VENDOR_LATEST_STALENESS_POLL_CYCLES);
  });
});

describe("evaluateVendorLineAtHead — every absence fails closed, by name", () => {
  it("A NULL latest_version DOES NOT QUALIFY — 'not observed' is never 'up to date'", () => {
    expect(evaluateVendorLineAtHead(npmLine({ latestVersion: null }), npmLine(), OPTS)).toEqual({
      atHead: false,
      reason: "head_not_observed"
    });
  });

  it("is the SAME shape an outpost is always in — the poll never ran, so nothing was observed", () => {
    // `dependencyVersionPollRoleGuard` (ADR-0032 §7c clause 3) refuses to poll unless
    // SCP_FEDERATION_ROLE is explicitly `commander`, and `dependency_lines` is a per-domain
    // projection that does not federate. So on an outpost the trio is NULL and the vendor rule
    // refuses by data, not by a second role predicate in the gate.
    const outpost = npmLine({ latestVersion: null, latestDigest: null, latestObservedAt: null });
    expect(evaluateVendorLineAtHead(outpost, outpost, OPTS)).toEqual({
      atHead: false,
      reason: "head_not_observed"
    });
  });

  it("a head observed longer ago than the bound is STALE", () => {
    const stale = npmLine({ latestObservedAt: new Date(NOW.getTime() - BOUND - 1) });
    expect(evaluateVendorLineAtHead(stale, stale, OPTS)).toEqual({
      atHead: false,
      reason: "head_stale"
    });
    // Exactly on the bound is still fresh — the boundary is inclusive and stated.
    const edge = npmLine({ latestObservedAt: new Date(NOW.getTime() - BOUND) });
    expect(evaluateVendorLineAtHead(edge, edge, OPTS)).toEqual({ atHead: true });
  });

  it("a NULL latest_observed_at is stale, not 'always fresh'", () => {
    const row = npmLine({ latestObservedAt: null });
    expect(evaluateVendorLineAtHead(row, row, OPTS)).toEqual({
      atHead: false,
      reason: "head_stale"
    });
  });

  it("a language declaration that pins NO version does not qualify", () => {
    const row = npmLine({ resolvedVersion: null });
    expect(evaluateVendorLineAtHead(row, row, OPTS)).toEqual({
      atHead: false,
      reason: "declaration_not_pinned"
    });
  });

  it("a language declaration BEHIND the head does not qualify; equal and ahead do", () => {
    expect(
      evaluateVendorLineAtHead(npmLine(), { ...npmLine(), resolvedVersion: "4.17.20" }, OPTS)
    ).toEqual({ atHead: false, reason: "behind_head" });
    expect(
      evaluateVendorLineAtHead(npmLine(), { ...npmLine(), resolvedVersion: "4.17.21" }, OPTS)
    ).toEqual({ atHead: true });
    // AHEAD is accepted: the component is not behind, the poll simply has not caught up. Refusing
    // here would fail a component for its own currency.
    expect(
      evaluateVendorLineAtHead(npmLine(), { ...npmLine(), resolvedVersion: "4.17.22" }, OPTS)
    ).toEqual({ atHead: true });
  });

  it("a version on a DIFFERENT major line is not comparable, not 'behind'", () => {
    // Reuses `lineAcceptsVersion` — the same door both inventory ingresses use — so "is 3.0.0 on
    // the 4 line" means one thing in this tree rather than one thing per caller.
    expect(
      evaluateVendorLineAtHead(npmLine(), { ...npmLine(), resolvedVersion: "3.0.0" }, OPTS)
    ).toEqual({ atHead: false, reason: "version_not_comparable" });
  });

  it("OCI COMPARES THE DIGEST, NEVER THE TAG — two images agreeing on the tag and differing by digest do NOT both qualify", () => {
    // The headline rule of the oci arm. An index reports TAGS; a tag is mutable, so `3.19.1` names
    // one set of bytes today and another next week. If this ever starts comparing `resolvedVersion`
    // to `latestVersion`, a component sitting on a stale `3.19.1` the registry has since repointed
    // gets a vendor-pass for every OS package in it.
    const sameTagOtherBytes = { ...ociLine(), resolvedDigest: "sha256:bbbb" };
    expect(sameTagOtherBytes.resolvedVersion).toBe(ociLine().latestVersion);
    expect(evaluateVendorLineAtHead(ociLine(), sameTagOtherBytes, OPTS)).toEqual({
      atHead: false,
      reason: "digest_mismatch"
    });
  });

  it("a matching digest qualifies EVEN WHEN THE TAGS DIFFER — the digest is the identity", () => {
    const otherTagSameBytes = { ...ociLine(), resolvedVersion: "3.19.0" };
    expect(evaluateVendorLineAtHead(ociLine(), otherTagSameBytes, OPTS)).toEqual({ atHead: true });
  });

  it("a line whose head has NO recorded digest does not qualify", () => {
    const line = ociLine({ latestDigest: null });
    expect(evaluateVendorLineAtHead(line, ociLine(), OPTS)).toEqual({
      atHead: false,
      reason: "head_digest_unknown"
    });
  });

  it("a FROM that resolves to no digest does not qualify — the ordinary tag-only Dockerfile", () => {
    expect(
      evaluateVendorLineAtHead(ociLine(), { ...ociLine(), resolvedDigest: null }, OPTS)
    ).toEqual({ atHead: false, reason: "declaration_digest_unknown" });
  });

  it("the NULL/STALE checks run BEFORE the oci digest comparison", () => {
    // Ordering matters: a row with matching digests and an unobserved head must refuse on the head,
    // not pass on the digests.
    const line = ociLine({ latestVersion: null });
    expect(evaluateVendorLineAtHead(line, ociLine(), OPTS)).toEqual({
      atHead: false,
      reason: "head_not_observed"
    });
  });
});

describe("foldVendorLatestFacts — ALL, never ANY", () => {
  it("NO declared oci line at all means NO base-image credit", () => {
    // An `unresolved`/`unpinned`/digest-only `FROM` never becomes a line (no comparable version, so
    // `placeDeclarationOnLine` refuses), and a component with no dependency automation declares
    // nothing at all. Both arrive here as "no oci rows", and both must yield false — not the vacuous
    // truth of "every one of zero lines is at head".
    expect(foldVendorLatestFacts([npmLine()], OPTS).baseImageAtLatest).toBe(false);
    expect(foldVendorLatestFacts([], OPTS)).toEqual({
      baseImageAtLatest: false,
      packageKeys: []
    });
  });

  it("EVERY declared base image must be at head — a multi-stage build with one stale stage fails", () => {
    const rows = [
      ociLine(),
      ociLine({ lineId: "line-oci-2", coordinate: "docker.io/library/node", major: "20" })
    ];
    expect(foldVendorLatestFacts(rows, OPTS).baseImageAtLatest).toBe(true);
    const oneStale = [
      rows[0]!,
      { ...rows[1]!, latestObservedAt: new Date(NOW.getTime() - BOUND - 1) }
    ];
    expect(foldVendorLatestFacts(oneStale, OPTS).baseImageAtLatest).toBe(false);
  });

  it("a line declared from TWO manifests emits its key only if BOTH declarations are at head", () => {
    // `component_dependencies` is keyed by manifest path on purpose, so one line legitimately has
    // several rows. One stale declaration is a real exposure and must not be voted away by a current
    // sibling.
    const current = npmLine();
    const behind = { ...npmLine(), resolvedVersion: "4.17.20" };
    expect(foldVendorLatestFacts([current], OPTS).packageKeys).toEqual([
      // The KEY NOW CARRIES THE VERSION (M22.4 review round). Without it the fact answered "the
      // MANIFEST declares this package at head", not "the ARTIFACT being scanned contains it at
      // head" — and a sibling line on a DIFFERENT major voted a stale one clean.
      vendorLatestPackageKey("npm", "lodash", "4.17.21")
    ]);
    expect(foldVendorLatestFacts([current, behind], OPTS).packageKeys).toEqual([]);
    expect(foldVendorLatestFacts([behind, current], OPTS).packageKeys).toEqual([]);
  });

  it("emits SORTED, de-duplicated keys — the array reaches a Decision's inputContext", () => {
    // An unstable order defeats `insertDecisionIfChanged` (which canonicalises key order but
    // PRESERVES array order) and re-opens the measured 1.44 GB/day write amplification.
    const rows = [
      npmLine({ lineId: "l-z", coordinate: "zod" }),
      npmLine({ lineId: "l-a", coordinate: "axios" }),
      npmLine({ lineId: "l-p1", ecosystem: "python", coordinate: "zope.interface" }),
      npmLine({ lineId: "l-p2", ecosystem: "python", coordinate: "zope_interface" })
    ];
    const keys = foldVendorLatestFacts(rows, OPTS).packageKeys;
    expect(keys).toEqual([...keys].sort());
    expect(keys).toEqual(["npm|axios|4.17.21", "npm|zod|4.17.21", "python|zope-interface|4.17.21"]);
  });
});

describe("intersectVendorLatestFacts — an intersection, never a union", () => {
  const a: ScanVendorLatestFacts = {
    baseImageAtLatest: true,
    packageKeys: ["npm|lodash", "npm|zod"]
  };
  const b: ScanVendorLatestFacts = { baseImageAtLatest: true, packageKeys: ["npm|zod"] };

  it("keeps only what EVERY target is current on", () => {
    // A fact is as much a loosening as a clause is (ADR-0033 §3). One target's currency must never
    // excuse a sibling component's findings, and a union here would do exactly that.
    expect(intersectVendorLatestFacts([a, b])).toEqual({
      baseImageAtLatest: true,
      packageKeys: ["npm|zod"]
    });
  });

  it("ANDs the base image — one target on a stale base sinks it for the change", () => {
    expect(
      intersectVendorLatestFacts([a, { ...b, baseImageAtLatest: false }])?.baseImageAtLatest
    ).toBe(false);
  });

  it("NO targets yields undefined, not 'everything'", () => {
    // An intersection over an empty family is conventionally the universe, which here would be a
    // vendor-pass for a change with nothing to be current about.
    expect(intersectVendorLatestFacts([])).toBeUndefined();
  });

  it("a single target passes through unchanged — the common shape is unaffected", () => {
    expect(intersectVendorLatestFacts([a])).toEqual(a);
  });
});
