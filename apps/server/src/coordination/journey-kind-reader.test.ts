import { describe, expect, it } from "vitest";
import { journeyKindOf, typeOf } from "./changes-repo.js";

/** READING a change's declared release path, and why it degrades where `typeOf` throws.
 *  See docs/coordination.md §285a. */
describe("journeyKindOf: total over anything `properties` can hold (§8.14)", () => {
  it("reads the two declared paths", () => {
    expect(journeyKindOf({ journeyKind: "source" })).toBe("source");
    expect(journeyKindOf({ journeyKind: "config" })).toBe("config");
  });

  it("absent, null and undefined all read as NOT DECLARED", () => {
    // Absent is the shape every pre-0112 change has, and the shape a change from an undeclared
    // mapping still has — `proposeChange` writes the key only when there is one.
    expect(journeyKindOf({})).toBeNull();
    expect(journeyKindOf({ type: "configuration" })).toBeNull();
    expect(journeyKindOf(null)).toBeNull();
    expect(journeyKindOf(undefined)).toBeNull();
    expect(journeyKindOf({ journeyKind: null })).toBeNull();
  });

  it("an unrecognised value DEGRADES to null instead of throwing — the asymmetry with `typeOf`", () => {
    // `properties` is jsonb, so unlike `source_mappings.journey_kind` no CHECK can close this set: a
    // change imported from a peer running a different CommanderSCP is the real arrival path. Costing
    // one label on one tile is the proportionate answer.
    expect(journeyKindOf({ journeyKind: "from-the-future" })).toBeNull();
    expect(journeyKindOf({ journeyKind: "chart" })).toBeNull();
    expect(journeyKindOf({ journeyKind: 7 })).toBeNull();
    expect(journeyKindOf({ journeyKind: { nested: true } })).toBeNull();
    expect(journeyKindOf({ journeyKind: ["source"] })).toBeNull();

    // THE CONTRAST, asserted rather than described: the same version skew in the ROUTING field is
    // refused loudly, because guessing which pipeline to drive would release something somewhere
    // nobody chose. The two fields are deliberately not symmetrical.
    // Asserted on `detail`, not `message`: a ProblemError's message is the bare status ("Bad
    // Request"), so matching the message would pass for any 400 from anywhere.
    let refusal: unknown;
    try {
      typeOf({ type: "from-the-future" });
    } catch (err) {
      refusal = err;
    }
    expect(refusal, "an unrecognised routing Type must be refused, not degraded").toBeDefined();
    expect((refusal as { status?: number }).status).toBe(400);
    expect((refusal as { detail?: string }).detail).toMatch(/does not recognise/);
  });

  it("is case- and whitespace-EXACT — a near-miss is not declared", () => {
    // Values arrive from a closed enum on both the wire and the column; anything else is skew, and
    // normalising it here would quietly accept a value no writer can produce.
    expect(journeyKindOf({ journeyKind: "Source" })).toBeNull();
    expect(journeyKindOf({ journeyKind: "SOURCE" })).toBeNull();
    expect(journeyKindOf({ journeyKind: " source" })).toBeNull();
    expect(journeyKindOf({ journeyKind: "source " })).toBeNull();
  });
});
