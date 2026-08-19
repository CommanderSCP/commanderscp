import { describe, expect, it, vi } from "vitest";
import { RUNNER_DETAIL_MAX_CHARS, RUNNER_DETAIL_TAIL_CHARS, withRecordedOutcome } from "./index.js";

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

  /**
   * FOUND BY A MUTATION, NOT BY READING (M23.0 verification pass 7). Removing the bound from
   * `withRecordedOutcome` left all 17 tests in `failure-detail-bound.test.ts` green, because none of
   * them came through this helper — and this helper is the path for EVERY throw out of a plugin's
   * `trigger()`, which is where the freeform, unbounded strings actually are: a `docker create`
   * rejection's `.message` carries the child's whole stderr, and managed-iac's `record` writes it to
   * a durable JSON file that is never pruned and from there into a `Decision`'s `inputContext`.
   */
  it("A THROWN MESSAGE IS BOUNDED BEFORE `record` EVER SEES IT — the store is never handed a megabyte", async () => {
    const recorded: string[] = [];
    const cause = `Command failed: docker create scp-runner-iac:vetted\n${"noise\n".repeat(200_000)}Error: no space left on device`;
    expect(cause.length).toBeGreaterThan(1_000_000);
    await withRecordedOutcome({ record: (_ok, d) => void recorded.push(d), redact: (t) => t }, async () => {
      throw new Error(cause);
    });
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.length).toBeLessThanOrEqual(RUNNER_DETAIL_MAX_CHARS);
    // AND IT IS THE END THAT SURVIVED. A front-slice here records "Command failed: docker create"
    // and a page of noise — the same inert diagnosis this whole fix is about.
    expect(recorded[0]!.endsWith("Error: no space left on device")).toBe(true);
    expect(recorded[0]!.endsWith(cause.slice(-RUNNER_DETAIL_TAIL_CHARS))).toBe(true);
  });

  it("the bound runs AFTER the redactor, so a secret cannot be reintroduced by lengthening", async () => {
    // Redaction is not length-preserving — a secret shorter than `***` makes the string GROW — so
    // the order matters in both directions. Redact first, bound second.
    const recorded: string[] = [];
    // `q`, not `s`: a one-character secret that also occurs in the elision marker's own wording
    // would make this test assert something about the marker rather than about the redaction.
    const secret = "q";
    await withRecordedOutcome(
      {
        record: (_ok, d) => void recorded.push(d),
        redact: (t) => t.split(secret).join("***")
      },
      async () => {
        throw new Error(`${secret.repeat(10_000)}THE END`);
      }
    );
    expect(recorded[0]).not.toContain(secret);
    expect(recorded[0]!.length).toBeLessThanOrEqual(RUNNER_DETAIL_MAX_CHARS);
    expect(recorded[0]!.endsWith("THE END")).toBe(true);
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
