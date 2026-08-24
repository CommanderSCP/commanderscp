import { describe, expect, it } from "vitest";
import { instanceFreezeCovers } from "./instance-freezes-repo.js";

/**
 * `instanceFreezeCovers` — the matching rule of the instance-scoped freeze tier (drizzle/0086,
 * campaigns-rework §2), measured without a database.
 *
 * IT IS PURE FOR EXACTLY THIS REASON. The integration suite proves the rule reaches a real wave
 * through a real graph; what it CANNOT cheaply enumerate is the cross product of three freeze
 * shapes against four coordinate shapes, and the two combinations a reviewer guesses wrong live in
 * that cross product:
 *
 *   * an `environment`-only freeze covers a stage that declares NO region (it is still that
 *     environment — "freeze prod" means prod, not "the parts of prod that named themselves"), and
 *   * a REGION-NARROWED freeze does NOT (that stage has not said it is that region).
 *
 * The two pull in opposite directions from the same null, which is why both are here.
 */

const coordinate = (environment: string, region: string | null = null) => ({
  environment,
  region
});

const wide = { matchAllEnvironments: false, matchEnvironment: "prod", matchRegion: null };
const narrow = { matchAllEnvironments: false, matchEnvironment: "prod", matchRegion: "amer" };
const everything = {
  matchAllEnvironments: true,
  matchEnvironment: null,
  matchRegion: null
};

describe("instanceFreezeCovers: environment-only", () => {
  it("covers every region of that environment", () => {
    expect(instanceFreezeCovers(wide, coordinate("prod", "amer"))).toBe(true);
    expect(instanceFreezeCovers(wide, coordinate("prod", "emea"))).toBe(true);
  });

  it("covers a stage of that environment that declares NO region", () => {
    // The first of the two opposite readings of a null region. A stage with `environment: prod`
    // and no region label IS prod; an operator freezing prod means it.
    expect(instanceFreezeCovers(wide, coordinate("prod"))).toBe(true);
  });

  it("does not cover another environment, whatever its region", () => {
    expect(instanceFreezeCovers(wide, coordinate("staging", "amer"))).toBe(false);
  });

  it("does not cover a target that declares no coordinate at all", () => {
    // A legacy component-shaped wave target, or a placement whose deployment-target sets no
    // `environment` — `readStageCoordinate`'s three null cases. ADR-0031: locality is DECLARED,
    // never inferred, so an environment-addressed freeze cannot reach a target that never said
    // where it runs. Only the explicit deployment-wide form does (below).
    expect(instanceFreezeCovers(wide, null)).toBe(false);
  });

  it("is case-SENSITIVE, deliberately", () => {
    // `properties.environment` is an opaque operator-chosen label everywhere else in this repo —
    // `listRegionTargets` compares it with a plain SQL `=`. One matcher folding case while the
    // region view does not is exactly the two-copies-of-one-idea drift this tier is careful about.
    expect(instanceFreezeCovers(wide, coordinate("PROD", "amer"))).toBe(false);
  });
});

describe("instanceFreezeCovers: environment + region", () => {
  it("covers exactly that stage", () => {
    expect(instanceFreezeCovers(narrow, coordinate("prod", "amer"))).toBe(true);
    expect(instanceFreezeCovers(narrow, coordinate("prod", "emea"))).toBe(false);
    expect(instanceFreezeCovers(narrow, coordinate("staging", "amer"))).toBe(false);
  });

  it("does NOT cover a stage of that environment that declares no region", () => {
    // The OPPOSITE reading of the same null from the environment-only case above, and the reason
    // both are pinned: a target that has not said it is `amer` is not `amer`. Collapsing the two
    // into one rule silently widens or narrows one of them.
    expect(instanceFreezeCovers(narrow, coordinate("prod"))).toBe(false);
  });
});

describe("instanceFreezeCovers: the explicit deployment-wide form", () => {
  it("covers everything, INCLUDING a target that declares no coordinate", () => {
    expect(instanceFreezeCovers(everything, coordinate("prod", "amer"))).toBe(true);
    expect(instanceFreezeCovers(everything, coordinate("anything-at-all"))).toBe(true);
    // The one case an environment-addressed freeze cannot reach. An operator freezing the whole
    // deployment has said so explicitly and means everything, coordinate or not.
    expect(instanceFreezeCovers(everything, null)).toBe(true);
  });

  it("is reachable ONLY by saying so — a freeze with no environment and no flag covers nothing", () => {
    // The shape the DB CHECK and the request schema both refuse, asserted here as the MATCHER's
    // answer too, because a rule that fails open on an impossible row is one migration away from
    // being a rule that fails open on a possible one. The proposal read an absent environment as
    // deployment-wide; this is the departure, at the layer that decides.
    const malformed = {
      matchAllEnvironments: false,
      matchEnvironment: null,
      matchRegion: null
    };
    expect(instanceFreezeCovers(malformed, coordinate("prod", "amer"))).toBe(false);
    expect(instanceFreezeCovers(malformed, null)).toBe(false);
  });
});
