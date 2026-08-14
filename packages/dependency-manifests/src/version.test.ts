import { describe, expect, it } from "vitest";
import { compareVersions, parseComparableVersion, parseImageTagVersion } from "./version.js";

describe("parseComparableVersion", () => {
  it("extracts the numeric core and records how much precision was actually declared", () => {
    expect(parseComparableVersion("1.2.3")).toMatchObject({
      major: 1,
      minor: 2,
      patch: 3,
      precision: 3
    });
    expect(parseComparableVersion("1.2")).toMatchObject({
      major: 1,
      minor: 2,
      patch: 0,
      precision: 2
    });
    expect(parseComparableVersion("3")).toMatchObject({
      major: 3,
      minor: 0,
      patch: 0,
      precision: 1
    });
  });

  it("tolerates the leading v that go.mod and image tags both use", () => {
    expect(parseComparableVersion("v1.22.5")).toMatchObject({ major: 1, minor: 22, patch: 5 });
  });

  it("keeps the suffix verbatim and does NOT interpret it as a semver prerelease", () => {
    // `-alpine` is an image VARIANT. Semver would sort 1.2.3-alpine before 1.2.3; that ordering is
    // wrong for OCI tags, so the suffix is recorded and left uninterpreted.
    expect(parseComparableVersion("1.2.3-alpine")).toMatchObject({
      major: 1,
      minor: 2,
      patch: 3,
      suffix: "-alpine"
    });
    expect(parseComparableVersion("1.2.3+build.5")?.suffix).toBe("+build.5");
    // Maven's fourth component survives as a suffix rather than being silently dropped.
    expect(parseComparableVersion("1.2.3.4")?.suffix).toBe(".4");
  });

  it("returns undefined — never a guess — for strings with no numeric core", () => {
    for (const tag of ["latest", "stable", "edge", "alpine", "main", "", "   ", "sha256:abc"]) {
      expect(parseComparableVersion(tag), tag).toBeUndefined();
    }
  });

  it("refuses shapes it does not model rather than truncating them to a wrong number", () => {
    // PEP 440 epochs and space-separated junk would both truncate to `1` under a lenient parser.
    expect(parseComparableVersion("1!2.0")).toBeUndefined();
    expect(parseComparableVersion("1 2")).toBeUndefined();
    expect(parseComparableVersion("1/2")).toBeUndefined();
    // Regression: a permissive remainder swallowed `.8 <4` here and reported 3.23.0 — a silently
    // wrong version rather than an honest refusal. A compound range is not a version.
    expect(parseComparableVersion("3.23.8 <4")).toBeUndefined();
    expect(parseComparableVersion(">=2.0,<3")).toBeUndefined();
  });
});

describe("parseImageTagVersion", () => {
  // This is the ADR-0032 §7 rule as a test: unparseable tags are SKIPPED, never string-ordered.
  it("skips tags with no version, and single-component tags such as date stamps", () => {
    expect(parseImageTagVersion("latest")).toBeUndefined();
    expect(parseImageTagVersion("20240115")).toBeUndefined();
  });

  it("NEGATIVE CONTROL: well-formed tags on the same call path DO parse", () => {
    // Without this, every assertion above would still pass if the function simply returned
    // undefined unconditionally.
    expect(parseImageTagVersion("1.2")).toMatchObject({ major: 1, minor: 2, precision: 2 });
    expect(parseImageTagVersion("1.2.3-alpine")).toMatchObject({ major: 1, minor: 2, patch: 3 });
    expect(parseImageTagVersion("3.19.1")).toMatchObject({ major: 3, minor: 19, patch: 1 });
  });

  it("admits a single-component tag only when the caller explicitly declares that line", () => {
    expect(parseImageTagVersion("20240115", { minPrecision: 1 })).toMatchObject({
      major: 20240115,
      precision: 1
    });
  });
});

describe("compareVersions", () => {
  it("orders numerically, which is precisely what string ordering gets wrong", () => {
    const nine = parseComparableVersion("1.9.0");
    const ten = parseComparableVersion("1.10.0");
    expect(nine && ten && compareVersions(nine, ten)).toBe(-1);
    // The mutation guard: "1.10.0" < "1.9.0" as strings, so a string-ordering implementation
    // returns 1 here and fails.
    expect(nine && ten && compareVersions(ten, nine)).toBe(1);
  });

  it("refuses to order across differing suffixes, because variants are not an upgrade path", () => {
    const alpine = parseComparableVersion("3.19-alpine");
    const slim = parseComparableVersion("3.19-slim");
    expect(alpine && slim && compareVersions(alpine, slim)).toBeUndefined();
  });

  it("NEGATIVE CONTROL: the same suffix on both sides IS ordered", () => {
    const a = parseComparableVersion("3.18-alpine");
    const b = parseComparableVersion("3.19-alpine");
    expect(a && b && compareVersions(a, b)).toBe(-1);
    expect(a && compareVersions(a, a)).toBe(0);
  });
});
