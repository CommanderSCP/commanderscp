import { describe, expect, it } from "vitest";
import { assertNoVersionSkewOrThrow, type MemberHeartbeat } from "./member-heartbeat-repo.js";

const hb = (clusterId: string, appVersion: string): MemberHeartbeat => ({
  clusterId,
  appVersion,
  updatedAt: new Date(0)
});

/** §7.4 version-skew gate — the pure refusal the migrations Job's contract-phase gate calls. */
describe("assertNoVersionSkewOrThrow (§7.4)", () => {
  it("passes when there are no live heartbeats (first deploy)", () => {
    expect(() => assertNoVersionSkewOrThrow([], "1.2.0")).not.toThrow();
  });

  it("passes when every live member cluster is on the deploying version", () => {
    expect(() =>
      assertNoVersionSkewOrThrow([hb("a", "1.2.0"), hb("b", "1.2.0")], "1.2.0")
    ).not.toThrow();
  });

  it("REFUSES when a live member cluster reports an older version (skew)", () => {
    expect(() => assertNoVersionSkewOrThrow([hb("a", "1.2.0"), hb("b", "1.1.0")], "1.2.0")).toThrow(
      /CONTRACT-phase migration.*1\.1\.0/s
    );
  });

  it("REFUSES when a live member cluster reports a NEWER version too (any difference blocks)", () => {
    expect(() => assertNoVersionSkewOrThrow([hb("a", "1.3.0")], "1.2.0")).toThrow(/refusing/i);
  });
});
