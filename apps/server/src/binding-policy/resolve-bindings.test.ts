import { describe, expect, it } from "vitest";
import {
  resolveExecutorBindings,
  type BindingContribution,
  type PlacementBindingNeed
} from "./resolve-bindings.js";

/**
 * THE DOMAIN RECONCILER'S DECISION (ADR-0046 section 4).
 *
 * Every case here is about a REFUSAL TO GUESS. The happy path - one policy, one target, one
 * binding - is the least interesting property in the file, because it is the one a wrong
 * implementation also gets right.
 *
 * MUTATION LOG - each applied, watched fail, reverted, watched pass (MEASURED)
 * | Mutation | Result (MEASURED) |
 * |---|---|
 * | a same-depth tie picks the lowest policy id instead of reporting ambiguity | 2 FAIL - (3) and (5c). A binding appears where none should, and the operator never learns they wrote two policies. |
 * | `resolveLane` takes the MAX depth instead of the MIN | (2) FAILS - the domain-wide default beats the per-target override, i.e. the ladder inverts. |
 * | the test lane falls back on AMBIGUOUS as well as on absent | (5c) FAILS - the conflict is silently resolved in favour of a declaration nobody made for that lane. |
 * | `laneOf` returns "test" for an absent lane | 8 FAIL - every pre-lane document changes meaning, which is the blast radius that makes this one line worth a case of its own. |
 *
 * Case (1) - no policy means UNBOUND - has no mutation because its failure mode is an ADDITION: an
 * org-tier default would have to be written in, not removed. It is pinned as an exact-equality
 * assertion on both `bindings` and `gaps` so a default appearing anywhere fails it.
 */
describe("binding policy: the reconciler's decision", () => {
  const TARGET = "target-1";
  const COMPONENT = "component-1";

  function need(over: Partial<PlacementBindingNeed> = {}): PlacementBindingNeed {
    return {
      targetObjectId: TARGET,
      componentObjectId: COMPONENT,
      types: ["configuration"],
      lanes: ["build"],
      ...over
    };
  }

  function contribution(over: Partial<BindingContribution> = {}): BindingContribution {
    return {
      policyObjectId: "policy-a",
      policyVersion: 1,
      policyName: "domain HOW",
      depth: 0,
      effect: { executionSystemUrn: "urn:scp:d:execution-system:argocd", type: "configuration" },
      ...over
    };
  }

  it("(1) no policy means UNBOUND and reported - there is no org-tier default", () => {
    const { bindings, gaps } = resolveExecutorBindings([need()], new Map());
    expect(bindings).toEqual([]);
    expect(gaps).toEqual([
      {
        reason: "unbound",
        targetObjectId: TARGET,
        componentObjectId: COMPONENT,
        type: "configuration",
        lane: "build"
      }
    ]);
  });

  it("(2) nearest rung wins - a target-level policy beats a domain-level one", () => {
    const { bindings, gaps } = resolveExecutorBindings(
      [need()],
      new Map([
        [
          TARGET,
          [
            contribution({
              policyObjectId: "domain-wide",
              depth: 3,
              effect: {
                executionSystemUrn: "urn:scp:d:execution-system:shared",
                type: "configuration"
              }
            }),
            contribution({
              policyObjectId: "target-specific",
              depth: 0,
              effect: {
                executionSystemUrn: "urn:scp:d:execution-system:dedicated",
                type: "configuration"
              }
            })
          ]
        ]
      ])
    );
    expect(gaps).toEqual([]);
    expect(bindings).toHaveLength(1);
    expect(bindings[0]).toMatchObject({
      executionSystemUrn: "urn:scp:d:execution-system:dedicated",
      policyObjectId: "target-specific",
      viaLaneFallback: false
    });
  });

  it("(3) a same-depth tie naming two systems is AMBIGUOUS - nothing is bound, both are named", () => {
    const { bindings, gaps } = resolveExecutorBindings(
      [need()],
      new Map([
        [
          TARGET,
          [
            contribution({
              policyObjectId: "policy-b",
              effect: { executionSystemUrn: "urn:scp:d:execution-system:b", type: "configuration" }
            }),
            contribution({
              policyObjectId: "policy-a",
              effect: { executionSystemUrn: "urn:scp:d:execution-system:a", type: "configuration" }
            })
          ]
        ]
      ])
    );
    // FAILS CLOSED. A tiebreak would have been reproducible and still wrong, and the operator would
    // never have learned they wrote two.
    expect(bindings).toEqual([]);
    expect(gaps).toEqual([
      {
        reason: "ambiguous",
        targetObjectId: TARGET,
        componentObjectId: COMPONENT,
        type: "configuration",
        lane: "build",
        depth: 0,
        executionSystemUrns: ["urn:scp:d:execution-system:a", "urn:scp:d:execution-system:b"],
        policyObjectIds: ["policy-a", "policy-b"]
      }
    ]);
  });

  it("(3b) two policies at one depth naming the SAME system agree - that is not a tie", () => {
    const { bindings, gaps } = resolveExecutorBindings(
      [need()],
      new Map([
        [
          TARGET,
          [
            contribution({ policyObjectId: "policy-b" }),
            contribution({ policyObjectId: "policy-a" })
          ]
        ]
      ])
    );
    expect(gaps).toEqual([]);
    // Deterministic by policy id, so recorded provenance does not flap between ticks.
    expect(bindings[0]?.policyObjectId).toBe("policy-a");
  });

  it("(4) an absent lane means BUILD - a pre-lane document keeps its meaning", () => {
    const { bindings } = resolveExecutorBindings(
      [need({ lanes: ["build"] })],
      new Map([[TARGET, [contribution()]]])
    );
    expect(bindings[0]?.lane).toBe("build");
  });

  it("(5) the test lane FALLS BACK to build when undeclared, and says so", () => {
    const { bindings, gaps } = resolveExecutorBindings(
      [need({ lanes: ["build", "test"] })],
      new Map([[TARGET, [contribution()]]])
    );
    expect(gaps).toEqual([]);
    const test = bindings.find((b) => b.lane === "test");
    expect(test).toMatchObject({
      executionSystemUrn: "urn:scp:d:execution-system:argocd",
      viaLaneFallback: true
    });
    // The build lane's own answer is NOT marked as a fallback - only the lane that borrowed it.
    expect(bindings.find((b) => b.lane === "build")?.viaLaneFallback).toBe(false);
  });

  it("(5b) a declared test lane wins over the build lane, and is not marked as a fallback", () => {
    const { bindings } = resolveExecutorBindings(
      [need({ lanes: ["build", "test"] })],
      new Map([
        [
          TARGET,
          [
            contribution(),
            contribution({
              policyObjectId: "test-lane",
              effect: {
                executionSystemUrn: "urn:scp:d:execution-system:argo-workflows",
                type: "configuration",
                lane: "test"
              }
            })
          ]
        ]
      ])
    );
    expect(bindings.find((b) => b.lane === "test")).toMatchObject({
      executionSystemUrn: "urn:scp:d:execution-system:argo-workflows",
      viaLaneFallback: false
    });
  });

  it("(5c) an AMBIGUOUS test lane does NOT fall back - the conflict is the operator's to resolve", () => {
    const { bindings, gaps } = resolveExecutorBindings(
      [need({ lanes: ["test"] })],
      new Map([
        [
          TARGET,
          [
            contribution(),
            contribution({
              policyObjectId: "t1",
              effect: { executionSystemUrn: "urn:x:1", type: "configuration", lane: "test" }
            }),
            contribution({
              policyObjectId: "t2",
              effect: { executionSystemUrn: "urn:x:2", type: "configuration", lane: "test" }
            })
          ]
        ]
      ])
    );
    // Substituting the build lane here would resolve the conflict FOR them, in favour of a
    // declaration they did not make for this lane.
    expect(bindings).toEqual([]);
    expect(gaps[0]).toMatchObject({ reason: "ambiguous", lane: "test" });
  });

  it("(6) a build-lane gap makes the test lane a gap too - fallback cannot invent an answer", () => {
    const { bindings, gaps } = resolveExecutorBindings(
      [need({ lanes: ["build", "test"] })],
      new Map()
    );
    expect(bindings).toEqual([]);
    expect(gaps.map((g) => g.lane).sort()).toEqual(["build", "test"]);
  });

  it("(7) Types are resolved independently - one bound Type does not cover an unbound one", () => {
    const { bindings, gaps } = resolveExecutorBindings(
      [need({ types: ["configuration", "image"] })],
      new Map([[TARGET, [contribution()]]])
    );
    expect(bindings.map((b) => b.type)).toEqual(["configuration"]);
    expect(gaps).toEqual([
      {
        reason: "unbound",
        targetObjectId: TARGET,
        componentObjectId: COMPONENT,
        type: "image",
        lane: "build"
      }
    ]);
  });

  it("(8) output is sorted, so two runs over one state diff stably against the stored rows", () => {
    const needs = [
      need({ targetObjectId: "t-b", types: ["image"] }),
      need({ targetObjectId: "t-a", types: ["configuration"] })
    ];
    const contributions = new Map([
      ["t-a", [contribution()]],
      ["t-b", [contribution({ effect: { executionSystemUrn: "urn:x:img", type: "image" } })]]
    ]);
    const first = resolveExecutorBindings(needs, contributions);
    const second = resolveExecutorBindings([...needs].reverse(), contributions);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first.bindings.map((b) => b.targetObjectId)).toEqual(["t-a", "t-b"]);
  });
});
