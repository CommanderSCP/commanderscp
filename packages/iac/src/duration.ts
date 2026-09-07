/** CDK-exact duration value class (team-pipeline-iac.md D16(3)). See docs/iac.md §253. */
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
