import { describe, expect, it } from "vitest";
import { resolutionProvenance } from "./binding-resolution.js";
import type { BindingResolution } from "./binding-resolution.js";
import type { ExecutorBindingRow } from "./executor-bindings-repo.js";

/** THE PROVENANCE LABEL IS READ, NOT INFERRED. See docs/coordination.md §842. */
/** A stand-in row: `resolutionProvenance` never looks inside the binding, only at the outcome. */
const binding = { id: "b1", externalRef: "ref" } as unknown as ExecutorBindingRow;

describe("resolutionProvenance: the level is read from the object, never from the branch", () => {
  const viaAncestor = (typeId: string, hops: number): BindingResolution =>
    ({
      outcome: "via_service",
      binding,
      viaPlacementObjectId: null,
      viaServiceObjectId: `obj-${typeId}`,
      viaObjectTypeId: typeId,
      hops
    }) as BindingResolution;

  it("names an ASSEMBLY ancestor an assembly, not a service", () => {
    expect(resolutionProvenance(viaAncestor("assembly", 1))).toEqual({
      via: "assembly",
      viaObjectId: "obj-assembly",
      hops: 1
    });
  });

  it("names the ORG rung an organization — the case that was wrong before assembly existed", () => {
    expect(resolutionProvenance(viaAncestor("organization", 0))?.via).toBe("organization");
  });

  it("still names a service a service, so the historical Decision key stays truthful", () => {
    expect(resolutionProvenance(viaAncestor("service", 2))?.via).toBe("service");
  });

  it("carries how remote the inheritance was, so a surprising rung is visible in the record", () => {
    expect(resolutionProvenance(viaAncestor("assembly", 3))?.hops).toBe(3);
  });

  it("labels a placement resolution from the placement, with no hop count to claim", () => {
    expect(
      resolutionProvenance({
        outcome: "via_placement",
        binding,
        viaPlacementObjectId: "pl-1"
      } as BindingResolution)
    ).toEqual({ via: "placement", viaObjectId: "pl-1", hops: null });
  });

  it("a DIRECT resolution has NO provenance — reconcile must write no Decision for it", () => {
    // Not cosmetic: a Decision per direct trigger doubles Decision volume, which is a live
    // production concern on this instance (see the unbounded-growth incident).
    expect(
      resolutionProvenance({
        outcome: "direct",
        binding,
        viaPlacementObjectId: null
      } as BindingResolution)
    ).toBeNull();
  });

  it("a FAILED resolution has none either", () => {
    expect(
      resolutionProvenance({
        outcome: "none",
        binding: null,
        viaPlacementObjectId: null
      } as BindingResolution)
    ).toBeNull();
  });
});
