import { describe, expect, it } from "vitest";
import { resolutionProvenance } from "./binding-resolution.js";
import type { BindingResolution } from "./binding-resolution.js";

/**
 * THE PROVENANCE LABEL IS READ, NOT INFERRED.
 *
 * `reconcile.ts` built this label as `outcome === "via_placement" ? "placement" : "service"`. The
 * `via_service` branch covers THREE levels — service, assembly (migration 0055) and the org root —
 * so that expression wrote `resolvedVia: "service"` plus `serviceObjectId: <an assembly's id>` into
 * an audit record. It was already wrong for the org rung on the day that rung shipped, before
 * `assembly` existed: the bug is not "we forgot assembly", it is NAMING A LEVEL AFTER THE CODE PATH
 * THAT FOUND IT. Principle 6 — a Decision that misnames its own provenance reads as an answer, which
 * is worse than no Decision.
 *
 * These are pure-unit because the mapping is the defect. Whether the resolver reports the right
 * `viaObjectTypeId` in the first place is a DATABASE question, pinned separately in
 * `binding-resolution.integration.test.ts` against real objects of each type.
 *
 * MUTATION LOG (each applied alone to `resolutionProvenance`, then reverted):
 *
 * | Mutation | Result |
 * |---|---|
 * | `via: resolution.viaObjectTypeId` -> `via: "service"` (the original expression) | the assembly and org cases FAIL — this is the defect itself |
 * | return a provenance for `outcome: "direct"` | "a direct resolution has NO provenance" fails, and reconcile would write a Decision per trigger |
 * | drop `hops` from the via_service branch | "carries how remote the inheritance was" fails |
 */
const binding = { id: "b1", externalRef: "ref" } as unknown as BindingResolution extends {
  binding: infer B;
}
  ? B
  : never;

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
