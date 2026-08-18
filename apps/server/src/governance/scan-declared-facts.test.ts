import { describe, expect, it } from "vitest";
import { intersectDeclaredFacts, parseDeclaredFacts } from "./scan-declared-facts.js";
import { intersectApprovedOverrides, projectScanOverrideGrant } from "./scan-override-grants.js";
import type { ScanApprovedOverrides } from "@scp/schemas";

/**
 * M22.5 / M22.6 — THE TWO SERVER-SIDE FACT FOLDS, pure.
 *
 * Everything here is a function that takes rows (or a properties bag) and returns the fact the gate
 * hands to the matcher. The DATABASE reads and the WIRING are proven at the real gate in
 * `scan-declared-override-exclusions.integration.test.ts`; nothing in this file can say anything
 * about either, and it does not pretend to.
 *
 * MUTATIONS RUN (2026-08-17), measured against a baseline of 17 passed and reverted by an exact
 * inverse edit:
 *   U-1  UNION the per-target declarations instead of intersecting them  -> 3 failed.
 *   U-2  UNION the per-target grants instead of intersecting them        -> 2 failed.
 * A third, "read an unparseable status as `approved`", is covered by the projection cases below and
 * was not run separately.
 *
 * The property that makes these worth pinning separately is the INTERSECTION. ADR-0033 §3 forbids
 * unioning across a change's targets, and a union here is not a hypothetical mistake — it is the
 * shape a reader reaches for first, because "gather every fact about the change" is the obvious
 * phrasing and it is the wrong one. A single-target change (the overwhelmingly common shape) is
 * unaffected either way, so nothing but a deliberate multi-target test can tell the two apart.
 */

describe("M22.5 — parseDeclaredFacts reads the strict shape and nothing else", () => {
  it("reads a well-formed bag, sorted by key", () => {
    expect(
      parseDeclaredFacts({
        security: { declarations: { egress: "none", "data.classification": "public" } }
      })
    ).toEqual({
      declarations: [
        { key: "data.classification", value: "public" },
        { key: "egress", value: "none" }
      ]
    });
  });

  it("is SORTED, not insertion-ordered — the array reaches the gate Decision's inputContext", () => {
    // `restatesDecision` canonicalises object key order but PRESERVES array order, so an unsorted
    // array here would defeat `insertDecisionIfChanged` and re-open the measured 1.44 GB/day
    // Decision write amplification. Two bags with the same content in different insertion order must
    // serialize identically.
    const a = parseDeclaredFacts({ security: { declarations: { b: "2", a: "1" } } });
    const b = parseDeclaredFacts({ security: { declarations: { a: "1", b: "2" } } });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("a MISSPELLED wrapper key yields NO declarations — the same reading the write door refuses", () => {
    expect(parseDeclaredFacts({ security: { declarationz: { egress: "none" } } })).toEqual({
      declarations: []
    });
  });

  it("an EXTRA sibling key inside `security` yields no declarations — strict, like the write door", () => {
    // A row can predate the write door (a pre-0067 object, an IaC apply, a federated row from a peer
    // with a newer vocabulary), so this is a genuine second validation. If the two readers disagreed,
    // the LOOSER one would be the one that decides verdicts.
    expect(
      parseDeclaredFacts({ security: { declarations: { egress: "none" }, egress: "none" } })
    ).toEqual({ declarations: [] });
  });

  it("never reads `labels` — not a key, not a fallback", () => {
    expect(parseDeclaredFacts({ labels: { egress: "none" } })).toEqual({ declarations: [] });
  });

  it("an absent, null or non-object bag is empty rather than an exception", () => {
    for (const props of [undefined, null, {}, { security: null }, { security: "none" }, 7]) {
      expect(parseDeclaredFacts(props).declarations).toEqual([]);
    }
  });

  it("ONE unrecognised entry discards the WHOLE bag — all or nothing, for a loosening", () => {
    // MEASURED, and the opposite of what was written first. A per-entry filter is unreachable
    // through the write door (which refuses the whole bag) and reachable only through federation
    // import, where an unrecognised entry means either "the peer has a newer vocabulary" or
    // "somebody wrote something we cannot interpret". For a LOOSENING both must resolve the same
    // way: partially interpreting a document we do not fully understand is how a loosening acquires
    // a meaning nobody authored.
    expect(
      parseDeclaredFacts({ security: { declarations: { egress: "none", BAD: "x" } } })
    ).toEqual({ declarations: [] });
  });
});

describe("M22.5 — declared facts INTERSECT across targets, on the whole pair", () => {
  const facts = (...pairs: Array<[string, string]>) => ({
    declarations: pairs.map(([key, value]) => ({ key, value }))
  });

  it("a declaration only one target made does not excuse the change", () => {
    expect(intersectDeclaredFacts([facts(["egress", "none"]), facts(["other", "x"])])).toEqual({
      declarations: []
    });
  });

  it("the SAME KEY with DIFFERENT VALUES survives NEITHER — never whichever was read first", () => {
    // Intersecting on the key alone would be worse than a union: `egress: none` and
    // `egress: internet` agree on the key, and the surviving value would be decided by row order.
    expect(
      intersectDeclaredFacts([facts(["egress", "none"]), facts(["egress", "internet"])])
    ).toEqual({ declarations: [] });
  });

  it("a pair every target declared survives", () => {
    expect(
      intersectDeclaredFacts([
        facts(["egress", "none"], ["a", "1"]),
        facts(["egress", "none"], ["b", "2"])
      ])
    ).toEqual({ declarations: [{ key: "egress", value: "none" }] });
  });

  it("NO targets yields undefined, never `everything`", () => {
    // An intersection over an empty family is conventionally the universe, which here would be a
    // declared-fact pass for a change with nobody declaring anything.
    expect(intersectDeclaredFacts([])).toBeUndefined();
  });
});

describe("M22.6 — grants INTERSECT across targets on what they EXCUSE", () => {
  const g = (over: Partial<ScanApprovedOverrides["grants"][number]> = {}) => ({
    grantObjectId: "aaaaaaaa-0000-0000-0000-000000000000",
    vulnerabilityId: "CVE-2026-1000",
    tierObjectId: "tier",
    // M22.6 (D3) — the derived tier. `intersectApprovedOverrides` keys on (vulnerabilityId, pkgName)
    // and never on the tier, which is exactly what these cases pin.
    tier: "service" as const,
    expiresAt: "2099-01-01T00:00:00.000Z",
    ...over
  });

  it("a grant approved for only one target does not excuse the change", () => {
    expect(intersectApprovedOverrides([{ grants: [g()] }, { grants: [] }])?.grants).toEqual([]);
  });

  it("intersects on (vulnerabilityId, pkgName), NOT on grantObjectId", () => {
    // Every grant is per-component by construction, so intersecting on the grant's own id would make
    // EVERY multi-target intersection empty — a loosening that silently never applies to a
    // two-component change is indistinguishable from one that is broken.
    const surviving = intersectApprovedOverrides([
      { grants: [g({ grantObjectId: "aaaaaaaa-0000-0000-0000-000000000000" })] },
      { grants: [g({ grantObjectId: "bbbbbbbb-0000-0000-0000-000000000000" })] }
    ]);
    expect(surviving?.grants).toHaveLength(1);
    expect(surviving?.grants[0]?.vulnerabilityId).toBe("CVE-2026-1000");
  });

  it("a pkgName-narrowed grant and a bare one are DIFFERENT excuses and do not intersect", () => {
    expect(
      intersectApprovedOverrides([{ grants: [g({ pkgName: "openssl" })] }, { grants: [g()] }])
        ?.grants
    ).toEqual([]);
  });

  it("NO targets yields undefined", () => {
    expect(intersectApprovedOverrides([])).toBeUndefined();
  });
});

describe("M22.6 — the grant projection never reads an unparseable status as authorization", () => {
  const row = (properties: Record<string, unknown>) => ({
    id: "id",
    urn: "urn:scp:o:scan_override_grant:x",
    name: "x",
    properties,
    createdAt: new Date("2026-08-17T00:00:00.000Z")
  });

  it("an UNRECOGNISED status renders as `requested` — the state that grants nothing", () => {
    // A federated row from a peer with a newer vocabulary is exactly this shape. Rendering it as
    // `approved` would be a loosening decided by version skew.
    expect(projectScanOverrideGrant(row({ status: "auto-approved" })).status).toBe("requested");
    expect(projectScanOverrideGrant(row({})).status).toBe("requested");
  });

  it("carries the fields an auditor resolves the act by", () => {
    const projected = projectScanOverrideGrant(
      row({
        status: "approved",
        componentId: "c",
        vulnerabilityId: "CVE-2026-1",
        tierObjectId: "t",
        reason: "no upstream fix until Q4",
        expiresAt: "2099-01-01T00:00:00.000Z",
        decidedByActorId: "a",
        requestedByActorId: "r"
      })
    );
    expect(projected).toMatchObject({
      status: "approved",
      componentId: "c",
      vulnerabilityId: "CVE-2026-1",
      tierObjectId: "t",
      reason: "no upstream fix until Q4",
      expiresAt: "2099-01-01T00:00:00.000Z",
      decidedByActorId: "a",
      requestedByActorId: "r",
      pkgName: null
    });
  });
});
