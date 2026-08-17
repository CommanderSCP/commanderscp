import { describe, expect, it } from "vitest";
import { ProblemError } from "../errors.js";
import {
  GOVERNANCE_LABEL_PREFIX,
  assertSelectorKeysAreGovernanceLabels,
  assertSyncScopeSelectorKeysAreGovernanceLabels,
  governanceLabelDelta,
  isGovernanceLabelKey
} from "./governance-labels.js";

/**
 * The PURE halves of the reserved governance label namespace. The wiring — that every write door
 * actually reaches these — is a separate file (`governance-label-write-doors.integration.test.ts`),
 * deliberately: this repo's dominant defect is a component that is built, unit-tested green, and
 * never installed, and a unit test that calls the guard directly cannot tell the difference.
 */
describe("governanceLabelDelta", () => {
  const GOV = `${GOVERNANCE_LABEL_PREFIX}tier`;

  it("REMOVAL is a delta — the attack this whole module exists for", () => {
    // `updateObject` replaces `labels` wholesale, so "the request omitted the key" and "the request
    // deleted the key" are the same bytes. A delta computed over `after`'s keys alone — the obvious
    // implementation — is blind to exactly this case and would leave the evasion untouched behind a
    // green suite.
    expect(governanceLabelDelta({ [GOV]: "pci" }, {})).toEqual([GOV]);
    expect(governanceLabelDelta({ [GOV]: "pci" }, { team: "payments" })).toEqual([GOV]);
  });

  it("addition and value change are deltas", () => {
    expect(governanceLabelDelta({}, { [GOV]: "pci" })).toEqual([GOV]);
    expect(governanceLabelDelta({ [GOV]: "pci" }, { [GOV]: "public" })).toEqual([GOV]);
  });

  it("an unchanged governance label is NOT a delta, even when ordinary labels churn around it", () => {
    // The property that keeps this off the cost of the ordinary write path: no delta ⇒ no
    // permission lookup at all. If this went red, every PATCH in the system would resolve RBAC.
    expect(governanceLabelDelta({ [GOV]: "pci", a: "1" }, { [GOV]: "pci", b: "2" })).toEqual([]);
  });

  it("ordinary labels are never a delta, however they change", () => {
    expect(governanceLabelDelta({ tier: "pci" }, {})).toEqual([]);
    expect(governanceLabelDelta({}, { tier: "pci", env: "prod" })).toEqual([]);
  });

  it("values are compared CANONICALLY, so a jsonb round-trip is not a spurious change", () => {
    // Labels are `jsonb`. A structurally identical object read back from Postgres is a different
    // reference and its keys may be in a different order; `===` or `JSON.stringify` would report a
    // change and turn an ordinary PATCH into a 403 for nobody's benefit.
    const before = { [GOV]: { a: 1, b: 2 } } as Record<string, unknown>;
    const after = { [GOV]: { b: 2, a: 1 } } as Record<string, unknown>;
    expect(governanceLabelDelta(before, after)).toEqual([]);
    expect(governanceLabelDelta(before, { [GOV]: { a: 1, b: 3 } })).toEqual([GOV]);
  });

  it("an EXPLICIT undefined value is a removal, not a match against an absent key", () => {
    // `canonicalJson(undefined) === canonicalJson(undefined)` for both a missing key and a present
    // one, so presence is tested with `Object.hasOwn` FIRST. Without that, `{gov: undefined}` would
    // read as equal to `{}` and a caller could clear the key by setting it undefined.
    expect(governanceLabelDelta({ [GOV]: "pci" }, { [GOV]: undefined })).toEqual([GOV]);
    expect(governanceLabelDelta({}, { [GOV]: undefined })).toEqual([GOV]);
  });

  it("reports EVERY changed key, sorted — an error naming one of three is a half-refusal", () => {
    const before = { [`${GOVERNANCE_LABEL_PREFIX}b`]: "1", [`${GOVERNANCE_LABEL_PREFIX}a`]: "1" };
    const after = { [`${GOVERNANCE_LABEL_PREFIX}c`]: "1" };
    expect(governanceLabelDelta(before, after)).toEqual([
      `${GOVERNANCE_LABEL_PREFIX}a`,
      `${GOVERNANCE_LABEL_PREFIX}b`,
      `${GOVERNANCE_LABEL_PREFIX}c`
    ]);
  });
});

describe("isGovernanceLabelKey", () => {
  it("is a literal prefix test, with no normalisation", () => {
    // Both readers of the namespace compare label keys with `===` (`policy-resolve.ts`'s
    // `labelsMatch`, `federation/scope-filter.ts`'s custom arm). A key that is reserved for the
    // WRITE check under case folding but distinct at MATCH time would rebuild the evasion inside
    // the guard, so these near-misses must all be ordinary labels.
    expect(isGovernanceLabelKey(`${GOVERNANCE_LABEL_PREFIX}tier`)).toBe(true);
    expect(isGovernanceLabelKey(GOVERNANCE_LABEL_PREFIX)).toBe(true);
    expect(isGovernanceLabelKey("SCP.GOVERNANCE/tier")).toBe(false);
    expect(isGovernanceLabelKey(" scp.governance/tier")).toBe(false);
    expect(isGovernanceLabelKey("x-scp.governance/tier")).toBe(false);
    expect(isGovernanceLabelKey("scp.governance")).toBe(false);
    expect(isGovernanceLabelKey("scp:governance/tier")).toBe(false);
    expect(isGovernanceLabelKey("tier")).toBe(false);
  });
});

/** The refusal's `detail` — a `ProblemError`'s `message` is only its RFC 9457 title ("Bad
 *  Request"), so asserting on the message would pass against any 400 the module could ever throw. */
function refusalDetail(call: () => void): string {
  try {
    call();
  } catch (err) {
    expect(err).toBeInstanceOf(ProblemError);
    return (err as ProblemError).detail ?? "";
  }
  throw new Error("expected a refusal, but the call returned normally");
}

describe("assertSelectorKeysAreGovernanceLabels", () => {
  const selector = (labels: unknown) => ({
    scope: { selector: { labels } },
    enforcement: "required"
  });

  it("refuses a selector keyed on an ordinary label — the reported defect", () => {
    expect(
      refusalDetail(() =>
        assertSelectorKeysAreGovernanceLabels({
          typeId: "policy",
          properties: selector({ tier: "pci" })
        })
      )
    ).toMatch(/scope\.selector\.labels may only key on reserved governance labels/);
  });

  it("names EVERY offending key and suggests the re-keyed form", () => {
    const detail = refusalDetail(() =>
      assertSelectorKeysAreGovernanceLabels({
        typeId: "policy",
        properties: selector({ tier: "pci", env: "prod", [`${GOVERNANCE_LABEL_PREFIX}ok`]: "y" })
      })
    );
    expect(detail).toMatch(/env, tier/);
    // The compliant key must NOT be listed among the offenders — an error that blames a correct key
    // teaches the author the wrong lesson.
    expect(detail).toMatch(new RegExp(`names: env, tier\\.`));
    expect(detail).toContain(`${GOVERNANCE_LABEL_PREFIX}env`);
  });

  it("accepts a selector keyed entirely on governance labels", () => {
    expect(() =>
      assertSelectorKeysAreGovernanceLabels({
        typeId: "policy",
        properties: selector({ [`${GOVERNANCE_LABEL_PREFIX}tier`]: "pci" })
      })
    ).not.toThrow();
  });

  it("leaves `labels: {}` alone — a universal match keys on nothing and so evades nothing", () => {
    // `labelsMatch` is an `every()` over zero entries, so `{}` matches every ancestor of every
    // chain. It is org-wide by construction and already bounded by `assertPolicyScopeWithinAuthority`'s
    // org-root bar; there is no key for a subject to edit. Refusing it would refuse the one selector
    // shape that was never exposed.
    expect(() =>
      assertSelectorKeysAreGovernanceLabels({ typeId: "policy", properties: selector({}) })
    ).not.toThrow();
  });

  it("ignores documents the MATCHER would ignore — same truthiness tests, so the two cannot drift", () => {
    for (const labels of [undefined, null, "tier=pci", 7]) {
      expect(() =>
        assertSelectorKeysAreGovernanceLabels({ typeId: "policy", properties: selector(labels) })
      ).not.toThrow();
    }
    expect(() =>
      assertSelectorKeysAreGovernanceLabels({ typeId: "policy", properties: { scope: {} } })
    ).not.toThrow();
    expect(() =>
      assertSelectorKeysAreGovernanceLabels({ typeId: "policy", properties: undefined })
    ).not.toThrow();
  });

  it("applies to `policy` ONLY — no other type is ever resolved as a policy candidate", () => {
    // `listPolicyCandidates` selects `type_id = 'policy'` and nothing else, so a `scope.selector` on
    // a service is inert data. Refusing it would make this guard a general-purpose properties
    // validator, which is how a narrow guard becomes the place unrelated rules accumulate.
    for (const typeId of ["service", "component", "control", "outpost"]) {
      expect(() =>
        assertSelectorKeysAreGovernanceLabels({ typeId, properties: selector({ tier: "pci" }) })
      ).not.toThrow();
    }
  });
});

describe("assertSyncScopeSelectorKeysAreGovernanceLabels", () => {
  it("refuses a `custom` peer scope keyed on an ordinary label", () => {
    expect(
      refusalDetail(() =>
        assertSyncScopeSelectorKeysAreGovernanceLabels({
          mode: "custom",
          labelSelector: { tier: "gold" }
        })
      )
    ).toMatch(/'custom' sync scope may only key on reserved governance labels/);
  });

  it("accepts a `custom` scope keyed on governance labels", () => {
    expect(() =>
      assertSyncScopeSelectorKeysAreGovernanceLabels({
        mode: "custom",
        labelSelector: { [`${GOVERNANCE_LABEL_PREFIX}tier`]: "gold" }
      })
    ).not.toThrow();
  });

  it("leaves every NON-custom mode completely alone", () => {
    // The other four modes key on `entryKind`, which no tenant can write. Touching them would be a
    // permission regression for every ordinary peer to guard a selector they do not have.
    for (const mode of ["full", "policies_only", "changes_only", "status_only"]) {
      expect(() => assertSyncScopeSelectorKeysAreGovernanceLabels({ mode })).not.toThrow();
    }
    expect(() => assertSyncScopeSelectorKeysAreGovernanceLabels(undefined)).not.toThrow();
  });
});
