import { describe, expect, it } from "vitest";
import type { Decision } from "@scp/schemas";
import { restatesDecision, type InsertDecisionInput } from "./decisions-repo.js";

/**
 * `restatesDecision` is the entire safety property of `insertDecisionIfChanged` — the persist-on-
 * change guard that stopped `decisions` growing 1.44 GB/day (see that function's doc comment for
 * the production measurement). Both of its failure directions are silent, which is why they are
 * unit-tested directly rather than only through the reconcile loop:
 *
 *  - TOO EAGER (says "restates" when content differs) loses a real verdict change — a gate that
 *    newly passes, a different policy firing — and that is an EXPLAINABILITY bug (charter
 *    principle 6), the worse of the two.
 *  - NEVER EQUAL (a normalization slip — most plausibly key ORDER, since the stored side comes back
 *    out of `jsonb` in Postgres's own key order while the candidate side is a source-ordered object
 *    literal) silently restores the unbounded write with no visible symptom at all: the fix would
 *    look applied, `pnpm test` would stay green, and the table would keep growing.
 */

function storedDecision(over: Partial<Decision> = {}): Decision {
  return {
    id: "0198c0ff-ee00-7000-8000-000000000001",
    orgId: "org-1",
    kind: "gate",
    subjectId: "change-1",
    verdict: "block",
    inputContext: { matchedPolicyCount: 1, waveIndex: 0, waveId: "wave-1" },
    reasonTree: {
      summary: "blocked by prod-gate",
      policies: [{ name: "prod-gate", satisfied: false }]
    },
    createdAt: "2026-07-30T00:00:00.000Z",
    ...over
  };
}

function candidate(over: Partial<InsertDecisionInput> = {}): InsertDecisionInput {
  return {
    orgId: "org-1",
    kind: "gate",
    subjectId: "change-1",
    verdict: "block",
    inputContext: { matchedPolicyCount: 1, waveIndex: 0, waveId: "wave-1" },
    reasonTree: {
      summary: "blocked by prod-gate",
      policies: [{ name: "prod-gate", satisfied: false }]
    },
    ...over
  };
}

describe("restatesDecision (the persist-on-change content key)", () => {
  it("an identical verdict over identical inputs restates the stored one", () => {
    expect(restatesDecision(storedDecision(), candidate())).toBe(true);
  });

  it("KEY ORDER never defeats suppression — jsonb does not preserve the author's key order", () => {
    // The stored side as Postgres hands it back: same content, different key order, at BOTH levels.
    const stored = storedDecision({
      inputContext: { waveId: "wave-1", matchedPolicyCount: 1, waveIndex: 0 },
      reasonTree: {
        policies: [{ satisfied: false, name: "prod-gate" }],
        summary: "blocked by prod-gate"
      }
    });
    expect(restatesDecision(stored, candidate())).toBe(true);
  });

  it("a CHANGED VERDICT is never a restatement (the gate newly passing must write a row)", () => {
    expect(restatesDecision(storedDecision(), candidate({ verdict: "allow" }))).toBe(false);
  });

  it("a changed INPUT SET is never a restatement (a different policy firing, a new wave)", () => {
    expect(
      restatesDecision(
        storedDecision(),
        candidate({ inputContext: { matchedPolicyCount: 2, waveIndex: 0, waveId: "wave-1" } })
      )
    ).toBe(false);
    expect(
      restatesDecision(
        storedDecision(),
        candidate({ inputContext: { matchedPolicyCount: 1, waveIndex: 1, waveId: "wave-2" } })
      )
    ).toBe(false);
  });

  it("a changed REASON TREE is never a restatement (same verdict, different explanation)", () => {
    expect(
      restatesDecision(
        storedDecision(),
        candidate({
          reasonTree: {
            summary: "blocked by prod-gate",
            policies: [{ name: "other-gate", satisfied: false }]
          }
        })
      )
    ).toBe(false);
  });

  it("a MISSING or EXTRA key is a difference, not a match", () => {
    expect(
      restatesDecision(
        storedDecision(),
        candidate({ inputContext: { matchedPolicyCount: 1, waveIndex: 0 } })
      )
    ).toBe(false);
    expect(
      restatesDecision(
        storedDecision(),
        candidate({
          inputContext: {
            matchedPolicyCount: 1,
            waveIndex: 0,
            waveId: "wave-1",
            emergency: "override"
          }
        })
      )
    ).toBe(false);
  });

  it("ARRAY ORDER is meaningful — a reordered failing/override list is a different input set", () => {
    const stored = storedDecision({ inputContext: { failing: ["a", "b"] } });
    expect(restatesDecision(stored, candidate({ inputContext: { failing: ["a", "b"] } }))).toBe(
      true
    );
    expect(restatesDecision(stored, candidate({ inputContext: { failing: ["b", "a"] } }))).toBe(
      false
    );
  });

  it("`undefined`-valued keys and nulls compare as they are STORED, not as they were written", () => {
    // An `undefined` value is dropped by the insert, so the stored row simply lacks the key — the
    // candidate must still be recognized as a restatement of it.
    const stored = storedDecision({ inputContext: { detail: null } });
    expect(
      restatesDecision(stored, candidate({ inputContext: { detail: null, dropped: undefined } }))
    ).toBe(true);
    // null vs absent, however, IS a difference in jsonb and is treated as one.
    expect(
      restatesDecision(
        storedDecision({ inputContext: {} }),
        candidate({ inputContext: { detail: null } })
      )
    ).toBe(false);
  });

  it("nested objects are compared by content at every depth", () => {
    const stored = storedDecision({
      reasonTree: {
        summary: "s",
        policies: [{ effects: { requireApprovals: { count: 1, satisfied: false } } }]
      }
    });
    expect(
      restatesDecision(
        stored,
        candidate({
          reasonTree: {
            policies: [{ effects: { requireApprovals: { satisfied: false, count: 1 } } }],
            summary: "s"
          }
        })
      )
    ).toBe(true);
    expect(
      restatesDecision(
        stored,
        candidate({
          reasonTree: {
            policies: [{ effects: { requireApprovals: { satisfied: true, count: 1 } } }],
            summary: "s"
          }
        })
      )
    ).toBe(false);
  });
});
