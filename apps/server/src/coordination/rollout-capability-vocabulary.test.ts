import { describe, expect, it } from "vitest";
import type { DiscoveryProposal, RolloutAuthority, RolloutTargetClass } from "@scp/plugin-api";
import { ExecutorTypeSchema, RolloutAuthoritySchema, RolloutTargetClassSchema } from "@scp/schemas";

/**
 * D12's rollout vocabulary is declared TWICE: once as `@scp/schemas`' Zod enum (the wire contract)
 * and once as `@scp/plugin-api`'s bare string union (`RolloutTargetClass` / `RolloutAuthority`),
 * because `@scp/plugin-api` is deliberately free of a `@scp/schemas` dependency (see the doc comment
 * on `RolloutTargetClass` in `packages/plugin-api/src/index.ts`).
 *
 * THIS IS THE SAME SHAPE OF RISK `version-index.test.ts` PINS FOR `DependencyIndexEcosystem`, and
 * that file's own header names the concrete precedent: M21.4 minted a THIRD copy of the ecosystem
 * vocabulary, and the first two had already drifted — `image` in `dependency-manifests/types.ts` vs
 * `oci` in `@scp/schemas` — with BOTH sides fully green, because no test crossed the package
 * boundary. Nothing failed until ingestion tried to write a row the other side would reject.
 *
 * The fix here is the same one: a total `Record<PluginApiUnion, true>` whose KEYS the plugin-api
 * union generates. That makes a member added to one side and not the other a COMPILE error (a
 * missing or extra key fails to type-check) as well as a runtime-asserted set match — so a future
 * `image`-vs-`oci`-style drift on THIS vocabulary is caught before merge, not after a misrouted
 * rollout in production.
 */

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

/**
 * A THIRD hand-copied twin of `ExecutorType`, found by census while extending it for D13/D24 (this
 * session): `DiscoveryProposal.sourceMappings[].type` in `packages/plugin-api/src/index.ts`, kept as
 * a bare string union for the same "stay free of a `@scp/schemas` dependency" reason as
 * `RolloutTargetClass` above — but, unlike that one, it previously had NO pinning test. Closing that
 * gap here rather than in a new file: this file is already the plugin-api/schemas boundary test.
 */
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
