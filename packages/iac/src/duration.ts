/**
 * CDK-exact duration value class (team-pipeline-iac.md D16(3)) — `Duration.seconds(n)`,
 * `.minutes(n)`, `.hours(n)`, `.days(n)`. Every duration prop in this grammar (`every:`, `maxAge:`,
 * `pauseBetween:`, a `BakeAlarms` quiet window, …) takes one of these, never a `"5m"` string and
 * never a bespoke ad hoc wrapper. Percentages stay plain numbers on self-describing props
 * (`batchPercent: 25`, CDK's `minHealthyPercent` pattern) — there is deliberately no `Percent`
 * class alongside this one; a number already says what it is when the prop name does.
 *
 * ## Canonical form
 *
 * Every `Duration`, regardless of which factory built it, normalizes to a total-milliseconds count
 * internally — `Duration.minutes(5)` and `Duration.seconds(300)` are indistinguishable once built,
 * which is exactly what makes an embedded duration byte-stable in a synthesized manifest (the goal
 * statement's determinism requirement) no matter which unit an author happened to write.
 * `toJSON()` returns that count, so `JSON.stringify` (and anything that calls it, including
 * `JSON.stringify`-based equality checks in tests) serializes a `Duration` as one canonical number.
 *
 * `canonicalJson`'s `canonicalizeDeep` (`@scp/schemas/canonical-json`, re-exported from
 * `./canonical.js`) walks own enumerable object keys and does **not** call `toJSON()` — it is not
 * `JSON.stringify`, it is the recursive key-sorter `Stack.synth()` runs the ASSEMBLED manifest
 * through. A raw `Duration` instance left inside a manifest's `properties` would therefore NOT
 * canonicalize through this class's `toJSON()`; a construct that embeds one must resolve it to a
 * plain value first (`duration.toMilliseconds()`), exactly the same discipline `resolveUrn()`
 * already imposes on construct references before they reach `properties`. No construct in this
 * package embeds a `Duration` into a manifest yet (the constructs that will — `Workflow`,
 * `ContinuousTest`, `BakeAlarms`, the rollout classes — ship in a later increment against this
 * class); this doc note is here so that increment does not rediscover the hazard.
 *
 * ## Validation
 *
 * Every factory rejects a non-integer or negative amount at CONSTRUCTION time, loudly — never a
 * silently-clamped or silently-truncated duration reaching synth.
 */
export class Duration {
  private constructor(private readonly millis: number) {}

  static millis(amount: number): Duration {
    return new Duration(validateAmount("millis", amount));
  }

  static seconds(amount: number): Duration {
    return new Duration(validateAmount("seconds", amount) * 1_000);
  }

  static minutes(amount: number): Duration {
    return new Duration(validateAmount("minutes", amount) * 60_000);
  }

  static hours(amount: number): Duration {
    return new Duration(validateAmount("hours", amount) * 3_600_000);
  }

  static days(amount: number): Duration {
    return new Duration(validateAmount("days", amount) * 86_400_000);
  }

  toMilliseconds(): number {
    return this.millis;
  }

  toSeconds(): number {
    return this.millis / 1_000;
  }

  toMinutes(): number {
    return this.millis / 60_000;
  }

  toHours(): number {
    return this.millis / 3_600_000;
  }

  toDays(): number {
    return this.millis / 86_400_000;
  }

  /** Canonical serialization (see module doc): total milliseconds, as a plain number. What
   *  `JSON.stringify` produces for a `Duration` reached through a JSON-aware path. */
  toJSON(): number {
    return this.millis;
  }

  toString(): string {
    return `${this.millis}ms`;
  }

  /** Value equality — two `Duration`s built from different units but the same real span compare
   *  equal (`Duration.minutes(5).equals(Duration.seconds(300))` is `true`). */
  equals(other: Duration): boolean {
    return this.millis === other.millis;
  }
}

function validateAmount(unit: string, amount: number): number {
  if (!Number.isInteger(amount) || amount < 0) {
    throw new Error(
      `Duration.${unit}(${amount}): amount must be a non-negative integer, got ${amount}`
    );
  }
  return amount;
}
