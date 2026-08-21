import { describe, expect, it, vi } from "vitest";
import {
  RUNNER_DETAIL_MAX_CHARS,
  RUNNER_DETAIL_TAIL_CHARS,
  RunnerLaunchError,
  withRecordedOutcome
} from "./index.js";

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
    await withRecordedOutcome(
      { record: (_ok, d) => void recorded.push(d), redact: (t) => t },
      async () => {
        throw new Error(cause);
      }
    );
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

  // ================================================================================================
  // M23.5 MEDIUM-8 — A `create`/`secret-env`/`copy-in` REJECTION'S `.stderr` REACHES THE RECORD TOO
  // ================================================================================================
  //
  // `create`, `secret-env` and `copy-in` failures reject `run()` directly — `classifyRunnerFailure`
  // never runs for them, so `withRecordedOutcome` is the ONLY place their rejection becomes a
  // recorded `detail`. The Kubernetes adapter's `api()` builds a deliberately SHORT `.message`
  // ("kubernetes POST /path -> HTTP 403") and puts the API server's own response body — the reason —
  // in `.stderr` instead. Before this fix, only `.message` was read.

  it("A RunnerLaunchError'S `.stderr` — THE API SERVER'S OWN REASON — REACHES THE RECORDED DETAIL", async () => {
    const recorded: string[] = [];
    const err = new RunnerLaunchError({
      step: "create",
      file: "kubernetes://scp",
      argv: ["POST", "/apis/batch/v1/namespaces/scp/jobs"],
      redactions: [],
      cause: {
        message: "kubernetes POST /apis/batch/v1/namespaces/scp/jobs -> HTTP 403",
        code: 403,
        // A REALISTIC RBAC BODY (measured shape) — the sentence naming exactly which rule was
        // missing, which `.message` above never carries.
        stderr:
          '{"kind":"Status","status":"Failure","message":"jobs.batch is forbidden: User ' +
          '\\"system:serviceaccount:scp:scp-worker\\" cannot create resource \\"jobs\\" in API ' +
          'group \\"batch\\" in the namespace \\"scp\\"","reason":"Forbidden","code":403}'
      }
    });
    await withRecordedOutcome({ record: (_ok, d) => void recorded.push(d), redact: (t) => t }, async () => {
      throw err;
    });
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toContain("HTTP 403"); // the short message is still there
    expect(recorded[0]).toContain('cannot create resource \\"jobs\\"'); // and now so is the reason
  });

  it("NO DOUBLE-PRINT — a Docker rejection whose `.message` ALREADY carries the reason is not repeated", async () => {
    // The Docker adapter's cause IS `promisify(execFile)`'s own rejection, whose `.message` is
    // Node's own `Command failed: ... \n<stderr>` format — the reason is already in `.message`, and
    // `RunnerLaunchError`'s constructor falls `.stderr` back to that SAME `.message` when the cause
    // carries no `stderr` of its own (see the class doc's "THE `?? \"\" / ?? message` FALLS"). If
    // `withRecordedOutcome` concatenated unconditionally, every Docker failure would print its
    // reason twice.
    const recorded: string[] = [];
    const causeMessage =
      "Command failed: docker create scp-runner-iac:vetted\nError: no space left on device";
    const err = new RunnerLaunchError({
      step: "create",
      file: "/usr/bin/docker",
      argv: ["create", "scp-runner-iac:vetted"],
      redactions: [],
      cause: { message: causeMessage } // no `.stderr` on the cause — the Docker shape
    });
    await withRecordedOutcome({ record: (_ok, d) => void recorded.push(d), redact: (t) => t }, async () => {
      throw err;
    });
    expect(recorded).toHaveLength(1);
    // Exactly one occurrence — not the message, a separator, and the same text again.
    expect(recorded[0]!.split("no space left on device")).toHaveLength(2);
  });

  it("THE APPENDED `.stderr` STILL GOES THROUGH `opts.redact` — not spliced in raw", async () => {
    const recorded: string[] = [];
    // DELIBERATELY NO `redactions` ON THE ERROR ITSELF, so `err.stderr` carries the secret RAW —
    // isolating whether `withRecordedOutcome`'s OWN `opts.redact` (the plugin's independent
    // redaction, per this function's own doc) runs on the appended text or only on `.message`.
    const err = new RunnerLaunchError({
      step: "secret-env",
      file: "kubernetes://scp",
      argv: ["POST", "/api/v1/namespaces/scp/secrets"],
      redactions: [],
      cause: {
        message: "kubernetes POST /api/v1/namespaces/scp/secrets -> HTTP 422",
        stderr: 'field "data.AWS_SECRET_ACCESS_KEY" rejected: SEEDED_SECRET is not valid base64'
      }
    });
    await withRecordedOutcome(
      { record: (_ok, d) => void recorded.push(d), redact: (t) => t.split("SEEDED_SECRET").join("***") },
      async () => {
        throw err;
      }
    );
    expect(recorded[0]).not.toContain("SEEDED_SECRET");
    expect(recorded[0]).toContain("***");
  });
});
