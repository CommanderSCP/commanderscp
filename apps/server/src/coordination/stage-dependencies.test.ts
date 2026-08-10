import { describe, expect, it } from "vitest";
import { stageDependenciesOf } from "./changes-repo.js";

/**
 * ADR-0028 increment 1 — the read-back narrower for `properties.stageDependencies`.
 *
 * The contract under test is `requiresOf`'s, deliberately: NARROW AND COLLECT. A malformed entry is
 * returned under `malformed` rather than dropped, because dropping one fails OPEN — the release
 * would deploy with no hold at all, ahead of the very component its author named — and it is
 * RETURNED rather than thrown, because a throw in the per-target executing loop would let one
 * corrupt row wedge every other target in the same tick.
 *
 * Every malformed shape below is unreachable through the API (propose-time Zod validation plus
 * `dependsOn`/`atTargets` resolution). They can only arrive PAST it: a version-skewed federation
 * peer replaying properties verbatim, or a legacy row. That is exactly why the narrower, and not the
 * request schema, is the thing that has to be right here.
 */
describe("stageDependenciesOf — narrow and collect (ADR-0028)", () => {
  it("absent, null, and an empty array all read as 'no stage dependencies'", () => {
    expect(stageDependenciesOf(undefined)).toEqual({ stageDependencies: [], malformed: [] });
    expect(stageDependenciesOf(null)).toEqual({ stageDependencies: [], malformed: [] });
    expect(stageDependenciesOf({})).toEqual({ stageDependencies: [], malformed: [] });
    expect(stageDependenciesOf({ stageDependencies: null })).toEqual({
      stageDependencies: [],
      malformed: []
    });
    expect(stageDependenciesOf({ stageDependencies: [] })).toEqual({
      stageDependencies: [],
      malformed: []
    });
  });

  it("reads a bare dependency, and one carrying both optional qualifiers", () => {
    expect(
      stageDependenciesOf({
        stageDependencies: [
          { dependsOn: "comp-b" },
          { dependsOn: "comp-c", minWeight: 10, atTargets: ["dt-1", "dt-2"] }
        ]
      })
    ).toEqual({
      stageDependencies: [
        { dependsOn: "comp-b" },
        { dependsOn: "comp-c", minWeight: 10, atTargets: ["dt-1", "dt-2"] }
      ],
      malformed: []
    });
  });

  it("keeps `minWeight` and `atTargets` ABSENT rather than defaulting them", () => {
    // Absent means "no weight qualifier was asked for" — the universal succeeded-test applies — and
    // "every stage the two components share". Materialising a default here would silently answer a
    // question the author never asked.
    const parsed = stageDependenciesOf({ stageDependencies: [{ dependsOn: "comp-b" }] });
    expect(parsed.stageDependencies[0]).not.toHaveProperty("minWeight");
    expect(parsed.stageDependencies[0]).not.toHaveProperty("atTargets");
  });

  it("a non-array `stageDependencies` is ONE malformed entry carrying the whole raw value", () => {
    expect(stageDependenciesOf({ stageDependencies: "comp-b" })).toEqual({
      stageDependencies: [],
      malformed: ["comp-b"]
    });
    expect(stageDependenciesOf({ stageDependencies: { dependsOn: "comp-b" } })).toEqual({
      stageDependencies: [],
      malformed: [{ dependsOn: "comp-b" }]
    });
  });

  it("collects a malformed entry and keeps the well-formed ones beside it", () => {
    const parsed = stageDependenciesOf({
      stageDependencies: [{ dependsOn: "good-1" }, { minWeight: 10 }, { dependsOn: "good-2" }]
    });
    expect(parsed.stageDependencies).toEqual([{ dependsOn: "good-1" }, { dependsOn: "good-2" }]);
    expect(parsed.malformed).toEqual([{ minWeight: 10 }]);
  });

  it("a missing, empty, or non-string `dependsOn` is malformed — never silently dropped", () => {
    const parsed = stageDependenciesOf({
      stageDependencies: [{}, { dependsOn: "" }, { dependsOn: 42 }, { dependsOn: null }]
    });
    expect(parsed.stageDependencies).toEqual([]);
    expect(parsed.malformed).toEqual([
      {},
      { dependsOn: "" },
      { dependsOn: 42 },
      { dependsOn: null }
    ]);
  });

  it("a non-object entry (string, number, null, array) is malformed", () => {
    const parsed = stageDependenciesOf({
      stageDependencies: ["comp-b", 7, null, ["comp-b"]]
    });
    expect(parsed.stageDependencies).toEqual([]);
    expect(parsed.malformed).toEqual(["comp-b", 7, null, ["comp-b"]]);
  });

  it("a present-but-nonsensical `minWeight` makes the WHOLE entry malformed, never a silent degrade", () => {
    // The distinction is load-bearing: ABSENT means "nobody asked for a weight qualifier", which has
    // a right answer (the universal succeeded-test). PRESENT-but-out-of-range means somebody DID ask
    // and asked for something we cannot honour — degrading that to "no qualifier" would quietly
    // WIDEN the hold the author declared.
    const parsed = stageDependenciesOf({
      stageDependencies: [
        { dependsOn: "a", minWeight: 0 },
        { dependsOn: "b", minWeight: 101 },
        { dependsOn: "c", minWeight: 10.5 },
        { dependsOn: "d", minWeight: "10" },
        { dependsOn: "e", minWeight: Number.NaN },
        { dependsOn: "f", minWeight: null }
      ]
    });
    expect(parsed.stageDependencies).toEqual([]);
    expect(parsed.malformed).toHaveLength(6);
    // The boundaries themselves are legal.
    expect(
      stageDependenciesOf({
        stageDependencies: [
          { dependsOn: "a", minWeight: 1 },
          { dependsOn: "b", minWeight: 100 }
        ]
      })
    ).toEqual({
      stageDependencies: [
        { dependsOn: "a", minWeight: 1 },
        { dependsOn: "b", minWeight: 100 }
      ],
      malformed: []
    });
  });

  it("a non-array or non-string-member `atTargets` makes the whole entry malformed", () => {
    // Scoping is what decides WHERE a hold applies. A half-read `atTargets` would scope the coupling
    // to the wrong set of places, which reads as "applies nowhere" — a silent fail-open.
    const parsed = stageDependenciesOf({
      stageDependencies: [
        { dependsOn: "a", atTargets: "dt-1" },
        { dependsOn: "b", atTargets: ["dt-1", 7] },
        { dependsOn: "c", atTargets: ["dt-1", ""] },
        { dependsOn: "d", atTargets: null }
      ]
    });
    expect(parsed.stageDependencies).toEqual([]);
    expect(parsed.malformed).toHaveLength(4);
    // An EMPTY `atTargets` array is well-formed (it is a caller saying "no places"), not malformed.
    expect(stageDependenciesOf({ stageDependencies: [{ dependsOn: "a", atTargets: [] }] })).toEqual(
      {
        stageDependencies: [{ dependsOn: "a", atTargets: [] }],
        malformed: []
      }
    );
  });

  it("ignores unknown sibling keys on an otherwise well-formed entry rather than rejecting it", () => {
    // A forward-compatible field added by a newer peer must not turn its whole dependency into an
    // unsatisfiable one on an older instance — the entry's load-bearing parts still read.
    const parsed = stageDependenciesOf({
      stageDependencies: [{ dependsOn: "a", minWeight: 25, somethingNewer: true }]
    });
    expect(parsed.stageDependencies).toEqual([{ dependsOn: "a", minWeight: 25 }]);
    expect(parsed.malformed).toEqual([]);
  });
});
