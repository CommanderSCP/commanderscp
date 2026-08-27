import { describe, expect, it } from "vitest";
import { Duration } from "./duration.js";

describe("@scp/iac: Duration (D16(3))", () => {
  it("each unit factory converts to the correct millisecond count", () => {
    expect(Duration.millis(500).toMilliseconds()).toBe(500);
    expect(Duration.seconds(5).toMilliseconds()).toBe(5_000);
    expect(Duration.minutes(5).toMilliseconds()).toBe(300_000);
    expect(Duration.hours(2).toMilliseconds()).toBe(7_200_000);
    expect(Duration.days(1).toMilliseconds()).toBe(86_400_000);
  });

  it("conversion accessors round-trip through the canonical millisecond form", () => {
    const d = Duration.hours(2);
    expect(d.toSeconds()).toBe(7_200);
    expect(d.toMinutes()).toBe(120);
    expect(d.toHours()).toBe(2);
    expect(d.toDays()).toBe(2 / 24);
  });

  it("two durations built from DIFFERENT units but the same real span are canonically identical", () => {
    // This is the whole point of the canonical-milliseconds form (module doc): an author who
    // writes `Duration.minutes(5)` and one who writes `Duration.seconds(300)` must produce the
    // byte-identical serialized value, or an embedded duration would not be synth-deterministic.
    const fromMinutes = Duration.minutes(5);
    const fromSeconds = Duration.seconds(300);
    expect(fromMinutes.toMilliseconds()).toBe(fromSeconds.toMilliseconds());
    expect(fromMinutes.equals(fromSeconds)).toBe(true);
    expect(JSON.stringify(fromMinutes)).toBe(JSON.stringify(fromSeconds));
  });

  it("toJSON is the canonical serialization: a plain number of milliseconds", () => {
    expect(JSON.stringify(Duration.minutes(5))).toBe("300000");
    expect(JSON.stringify({ quiet: Duration.minutes(30) })).toBe('{"quiet":1800000}');
  });

  it("REJECTS a negative amount, loudly, at construction — never a silently-clamped duration", () => {
    expect(() => Duration.seconds(-1)).toThrow(/non-negative integer/);
    expect(() => Duration.minutes(-5)).toThrow();
    expect(() => Duration.hours(-1)).toThrow();
    expect(() => Duration.days(-1)).toThrow();
    expect(() => Duration.millis(-1)).toThrow();
  });

  it("REJECTS a non-integer amount, loudly, at construction — never a silently-truncated duration", () => {
    expect(() => Duration.seconds(1.5)).toThrow(/non-negative integer/);
    expect(() => Duration.minutes(0.1)).toThrow();
    expect(() => Duration.hours(2.5)).toThrow();
    expect(() => Duration.days(1.1)).toThrow();
  });

  it("accepts zero — an immediate/no-op duration is a legal value, not a rejected one", () => {
    expect(() => Duration.seconds(0)).not.toThrow();
    expect(Duration.seconds(0).toMilliseconds()).toBe(0);
  });

  it("toString is a readable, non-empty description (never the bare object)", () => {
    expect(Duration.minutes(5).toString()).toBe("300000ms");
  });
});
