import { describe, expect, it } from "vitest";
import type { DiscoveryProposal, RolloutAuthority, RolloutTargetClass } from "@scp/plugin-api";
import { ExecutorTypeSchema, RolloutAuthoritySchema, RolloutTargetClassSchema } from "@scp/schemas";

/** D12's rollout vocabulary is declared TWICE. See docs/coordination.md §845. */

// `Record<RolloutTargetClass, true>` fails to compile if `@scp/plugin-api`'s union gains or loses a
// member relative to what is written out here: a missing key fails TypeScript's required-keys
// check on `Record`, and a key that is not a member of the union is not a valid index at all. Same
// technique `INDEX_MODULE_BY_ECOSYSTEM` uses in `version-index.ts` to pin `DependencyIndexEcosystem`.
const PLUGIN_API_ROLLOUT_TARGET_CLASSES: Record<RolloutTargetClass, true> = {
  cluster: true,
  instanceGroup: true
};

const PLUGIN_API_ROLLOUT_AUTHORITIES: Record<RolloutAuthority, true> = {
  authoritative: true,
  triggerParams: true,
  verified: true
};

/** A third hand-copied twin, found by census. See docs/coordination.md §846. */
type DiscoveryProposalSourceMappingType = Exclude<
  NonNullable<DiscoveryProposal["sourceMappings"]>[number]["type"],
  undefined
>;

const PLUGIN_API_SOURCE_MAPPING_TYPES: Record<DiscoveryProposalSourceMappingType, true> = {
  image: true,
  rpm: true,
  deb: true,
  npm: true,
  maven: true,
  python: true,
  go: true,
  chart: true,
  "vm-image": true,
  infrastructure: true,
  configuration: true
};

describe("rollout vocabulary is the same set on both sides of the plugin-api / schemas boundary", () => {
  it("RolloutTargetClass (plugin-api) matches RolloutTargetClassSchema (schemas) at RUNTIME", () => {
    expect(Object.keys(PLUGIN_API_ROLLOUT_TARGET_CLASSES).sort()).toEqual(
      [...RolloutTargetClassSchema.options].sort()
    );
  });

  it("RolloutAuthority (plugin-api) matches RolloutAuthoritySchema (schemas) at RUNTIME", () => {
    expect(Object.keys(PLUGIN_API_ROLLOUT_AUTHORITIES).sort()).toEqual(
      [...RolloutAuthoritySchema.options].sort()
    );
  });

  it("DiscoveryProposal.sourceMappings[].type (plugin-api) matches ExecutorTypeSchema (schemas) at RUNTIME", () => {
    expect(Object.keys(PLUGIN_API_SOURCE_MAPPING_TYPES).sort()).toEqual(
      [...ExecutorTypeSchema.options].sort()
    );
  });
});
