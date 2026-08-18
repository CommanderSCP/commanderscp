import { describe, expect, it, vi } from "vitest";
import { withRecordedOutcome } from "./index.js";

/**
 * `withRecordedOutcome` in isolation — the plugin-level tests (`managed-iac`/`managed-scan`'s
 * `launcher-seam.test.ts`) prove it is actually WIRED into `trigger()`; this file proves the
 * primitive itself does what its doc claims, independent of any plugin.
 */
describe("withRecordedOutcome", () => {
  it("a resolved fn() records nothing — success recording stays the caller's own job", async () => {
    const record = vi.fn();
    const result = await withRecordedOutcome(
      { record, redact: (t) => t },
      async () => "the plugin's own success value"
    );
    expect(result).toBe("the plugin's own success value");
    expect(record).not.toHaveBeenCalled();
  });

  it("a THROWN fn() is recorded as failed — the whole point: no path escapes unrecorded", async () => {
    const record = vi.fn();
    const result = await withRecordedOutcome({ record, redact: (t) => t }, async () => {
      throw new Error("boom");
    });
    expect(result).toBeUndefined();
    expect(record).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith(false, "boom");
  });

  it("the redactor runs on the thrown message BEFORE record ever sees it", async () => {
    const record = vi.fn();
    await withRecordedOutcome(
      { record, redact: (t) => t.split("SEEDED_SECRET").join("***") },
      async () => {
        throw new Error("Command failed: docker create -e KEY=SEEDED_SECRET");
      }
    );
    expect(record).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith(false, "Command failed: docker create -e KEY=***");
  });

  it("record() is AWAITED — an async store write completes before withRecordedOutcome resolves", async () => {
    let written = false;
    const record = async (): Promise<void> => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      written = true;
    };
    await withRecordedOutcome({ record, redact: (t) => t }, async () => {
      throw new Error("boom");
    });
    expect(written).toBe(true);
  });

  it("a non-Error throw is stringified rather than dropped", async () => {
    const record = vi.fn();
    await withRecordedOutcome({ record, redact: (t) => t }, async () => {
      throw "a plain string rejection" as unknown as Error;
    });
    expect(record).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith(false, "a plain string rejection");
  });
});
