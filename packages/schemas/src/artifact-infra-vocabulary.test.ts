import { describe, expect, it } from "vitest";
import {
  ARTIFACT_INFRA_COMPATIBILITY,
  ArtifactClassSchema,
  InfraKindSchema,
  RolloutTargetClassSchema,
  compatibleInfraKinds,
  isPlacementCompatible
} from "./pipeline-behaviors.js";
import { CATEGORY_OF_TYPE, ExecutorTypeSchema, type ExecutorType } from "./executors.js";

/**
 * D24 vocabulary: `ArtifactClassSchema`, `InfraKindSchema`, `RolloutTargetClassSchema` and the
 * artifact-class x infra-kind compatibility matrix (`pipeline-behaviors.ts`). Every test here pins a
 * PROPERTY the doc comments on those declarations state, not a mechanic — the point is that each one
 * must fail if the derivation is ever replaced by a hand-written second list (the exact failure mode
 * the provisional declarations this file replaces were written to avoid, per their own doc comments).
 */

describe("CATEGORY_OF_TYPE is a total map over ExecutorType", () => {
  it("has exactly one entry per ExecutorType member — no more, no fewer", () => {
    expect(Object.keys(CATEGORY_OF_TYPE).sort()).toEqual([...ExecutorTypeSchema.options].sort());
  });

  it("maps every member to one of the three closed Category values", () => {
    for (const type of ExecutorTypeSchema.options) {
      expect(["build", "infrastructure", "configuration"]).toContain(CATEGORY_OF_TYPE[type]);
    }
  });
});

describe("ArtifactClassSchema really is the build family of ExecutorType, not a second list", () => {
  it("equals exactly the ExecutorType members whose CATEGORY_OF_TYPE entry is 'build'", () => {
    const buildFamily = ExecutorTypeSchema.options.filter((t) => CATEGORY_OF_TYPE[t] === "build");
    expect([...ArtifactClassSchema.options].sort()).toEqual([...buildFamily].sort());
  });

  it("excludes exactly the two non-build categories, infrastructure and configuration", () => {
    expect(ArtifactClassSchema.options).not.toContain("infrastructure");
    expect(ArtifactClassSchema.options).not.toContain("configuration");
  });

  it("is a proper subset of ExecutorTypeSchema — every member parses as an ExecutorType", () => {
    for (const artifactClass of ArtifactClassSchema.options) {
      expect(ExecutorTypeSchema.safeParse(artifactClass).success).toBe(true);
    }
  });
});

describe("InfraKindSchema — D24's closed infra-kind taxonomy", () => {
  it("is exactly the five D24 kinds, spelled after the KIND not the technology", () => {
    expect([...InfraKindSchema.options].sort()).toEqual(
      ["bucket", "cluster", "database", "instanceGroup", "queue"].sort()
    );
  });
});

describe("RolloutTargetClassSchema really is the deploy-target narrowing of InfraKind, not a second list", () => {
  it("is exactly {cluster, instanceGroup} — the two kinds an artifact can be deployed onto", () => {
    expect([...RolloutTargetClassSchema.options].sort()).toEqual(["cluster", "instanceGroup"].sort());
  });

  it("is a proper subset of InfraKindSchema — every member parses as an InfraKind", () => {
    for (const targetClass of RolloutTargetClassSchema.options) {
      expect(InfraKindSchema.safeParse(targetClass).success).toBe(true);
    }
  });

  it("excludes database, bucket, queue — D24: 'never deploy targets for artifacts at all'", () => {
    expect(RolloutTargetClassSchema.options).not.toContain("database");
    expect(RolloutTargetClassSchema.options).not.toContain("bucket");
    expect(RolloutTargetClassSchema.options).not.toContain("queue");
  });
});

describe("ARTIFACT_INFRA_COMPATIBILITY is a total map over ExecutorType", () => {
  it("has exactly one row per ExecutorType member — no more, no fewer", () => {
    expect(Object.keys(ARTIFACT_INFRA_COMPATIBILITY).sort()).toEqual(
      [...ExecutorTypeSchema.options].sort()
    );
  });

  it("every row's values are legal InfraKind members", () => {
    for (const type of ExecutorTypeSchema.options) {
      for (const kind of ARTIFACT_INFRA_COMPATIBILITY[type]) {
        expect(InfraKindSchema.safeParse(kind).success).toBe(true);
      }
    }
  });

  const deployRows: Array<[ExecutorType, readonly string[]]> = [
    ["image", ["cluster"]],
    ["chart", ["cluster"]],
    ["rpm", ["instanceGroup"]],
    ["deb", ["instanceGroup"]],
    ["vm-image", ["instanceGroup"]],
    ["configuration", ["cluster", "instanceGroup"]]
  ];
  it.each(deployRows)("%s resolves to exactly %j", (type, expected) => {
    expect([...ARTIFACT_INFRA_COMPATIBILITY[type]].sort()).toEqual([...expected].sort());
  });

  const neverPlacedRows: ExecutorType[] = ["npm", "maven", "python", "go", "infrastructure"];
  it.each(neverPlacedRows)("%s (publish-only / not a placement subject) resolves to an empty set", (type) => {
    expect(ARTIFACT_INFRA_COMPATIBILITY[type]).toEqual([]);
    expect(compatibleInfraKinds(type)).toEqual([]);
  });
});

describe("compatibleInfraKinds / isPlacementCompatible", () => {
  it("resolves every ExecutorType to SOME array (never throws, never undefined)", () => {
    for (const type of ExecutorTypeSchema.options) {
      expect(Array.isArray(compatibleInfraKinds(type))).toBe(true);
    }
  });

  it("accepts a compatible pair", () => {
    expect(isPlacementCompatible("image", "cluster")).toBe(true);
    expect(isPlacementCompatible("rpm", "instanceGroup")).toBe(true);
    expect(isPlacementCompatible("configuration", "cluster")).toBe(true);
    expect(isPlacementCompatible("configuration", "instanceGroup")).toBe(true);
  });

  it("rejects an incompatible pair — an RPM aimed at a cluster is unconstructable (D24)", () => {
    expect(isPlacementCompatible("rpm", "cluster")).toBe(false);
    expect(isPlacementCompatible("image", "instanceGroup")).toBe(false);
  });

  it("rejects EVERY pair for a never-placed type", () => {
    for (const kind of InfraKindSchema.options) {
      expect(isPlacementCompatible("npm", kind)).toBe(false);
      expect(isPlacementCompatible("infrastructure", kind)).toBe(false);
    }
  });

  it("rejects placement at a never-a-deploy-target kind for every type", () => {
    for (const type of ExecutorTypeSchema.options) {
      expect(isPlacementCompatible(type, "database")).toBe(false);
      expect(isPlacementCompatible(type, "bucket")).toBe(false);
      expect(isPlacementCompatible(type, "queue")).toBe(false);
    }
  });
});
