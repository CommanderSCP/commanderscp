import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PluginContext } from "@scp/plugin-api";
import {
  RUNNER_DETAIL_MAX_CHARS,
  RUN_OUTCOME_CACHE_MAX_DURABLE,
  RunnerLaunchError,
  classifyRunnerFailure,
  type RunnerLauncher
} from "@scp/runner-launcher";
import { createManagedIacExecutorPlugin } from "./index.js";

/**
 * HIGH (M23.0 verification pass 7) — THE DIAGNOSIS MUST SURVIVE ALL THE WAY TO `status().detail`,
 * AND THE DURABLE LEDGER MUST NOT GROW WITHOUT BOUND. This is the END-TO-END half of the fix; the
 * mechanism itself is pinned in `@scp/runner-launcher`'s `failure-detail-bound.test.ts`.
 *
 * WHAT WAS MEASURED BEFORE THE FIX, through this exact path with 200 KB of runner stderr:
 *
 *     stderr written : 200068      ledger file on disk : 211985
 *     status().detail length : 4000
 *     detail contains the tail marker : false
 *     detail contains the REAL CAUSE  : false
 *     last 90 chars of detail : "line, repeated\nnoise line, repeated\nnoise line, repeated\n..."
 *
 * Two defects in one measurement and they had to be fixed together. (1) The port appended the
 * runner's last 2000 characters AFTER an UNCAPPED `err.message`, so this plugin's `.slice(0, 4000)`
 * on READ returned 4000 characters of the noise the tool printed on its way to the error. (2) The
 * ledger — a durable, replicated JSON file keyed by `idempotencyKey`, in a `Record` that is never
 * pruned — was written UNSLICED; the 4000 was applied on read only. This repository has a
 * production incident in exactly that family (unbounded `Decision` growth at 1.44 GB/day), so
 * per-key growth of an on-disk ledger is treated as the same class.
 *
 * THE SUCCESS PATH WAS WORSE AND THE ORIGINAL MEASUREMENT DID NOT REACH IT: `runnerOutcomeDetail`
 * returned a successful run's `stdout` verbatim, up to the 16 MiB `maxBuffer`, and that too went to
 * disk per key, forever, to serve 4000 characters. Its arm is below.
 */

const REAL_CAUSE =
  "Error: creating EC2 Instance: InvalidAMIID.NotFound: The image id does not exist";

/** A launcher that fails the way the real Docker adapter does: `RunnerLaunchError` -> the port's own
 *  `classifyRunnerFailure`. Building the failure any other way would test this file's fixture. */
function failingLauncher(noiseChars: number): RunnerLauncher {
  const line = "module.tf: refreshing state, this is noise the tool printed\n";
  const noise = line.repeat(Math.ceil(noiseChars / line.length)).slice(0, noiseChars);
  const stderr = `${noise}${REAL_CAUSE}\n`;
  return {
    async run() {
      const err = new RunnerLaunchError({
        step: "start",
        file: "docker",
        argv: ["start", "-a", "scp-runner-managed-iac--k"],
        cause: Object.assign(
          new Error(`Command failed: docker start -a scp-runner-managed-iac--k\n${stderr}`),
          { code: 1, killed: false, signal: null, stdout: "", stderr }
        ),
        redactions: []
      });
      return { succeeded: false, stdout: "", stderr, failure: classifyRunnerFailure(err) };
    },
    reap: async () => []
  };
}

let workspaceRoot: string;
let statePath: string;

beforeEach(async () => {
  workspaceRoot = await mkdtemp(join(tmpdir(), "managed-iac-detail-"));
  statePath = join(workspaceRoot, "dedup.json");
});

afterEach(async () => {
  await rm(workspaceRoot, { recursive: true, force: true });
});

function ctx(): PluginContext {
  return {
    orgId: "org-1",
    scopeKey: "domain-1",
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    secrets: { get: async () => undefined },
    http: {
      request: async () => {
        throw new Error("managed-iac: never calls ctx.http");
      }
    },
    config: {
      runnerImage: "scp-runner-iac:vetted",
      workspaceRoot,
      networkMode: "none",
      statePath
    }
  };
}

async function runAndRead(launcher: RunnerLauncher, key: string) {
  const plugin = createManagedIacExecutorPlugin(() => launcher);
  const c = ctx();
  const ref = await plugin.trigger(c, {
    kind: "sync",
    targetRef: "t1",
    parameters: { iacAction: "apply" },
    idempotencyKey: key
  });
  return { status: await plugin.status(c, ref), ledgerBytes: (await stat(statePath)).size };
}

describe("HIGH: the REAL CAUSE survives to status().detail, and the ledger stays bounded", () => {
  /**
   * THE ARM THE SURVIVING MUTATION MUST REDDEN. `output.slice(-FAILURE_OUTPUT_TAIL_CHARS)` ->
   * `output.slice(0, ...)` in `@scp/runner-launcher` survived 1542 tests; measured through this
   * plugin it means an operator reading a failed `tofu apply` is shown the noise the tool printed
   * FIRST and never the error it ended on.
   */
  it.each([1_500, 5_000, 50_000])(
    "an operator reading a failed apply sees the cause, not the noise, at %i characters of stderr",
    async (noiseChars) => {
      const { status } = await runAndRead(failingLauncher(noiseChars), `bound-${noiseChars}`);
      expect(status.phase).toBe("failed");
      expect(status.detail, "the diagnosis was pushed out by the runner's own noise").toContain(
        REAL_CAUSE
      );
      expect(status.detail!.length).toBeLessThanOrEqual(RUNNER_DETAIL_MAX_CHARS);
    }
  );

  it("THE DURABLE LEDGER ITSELF IS BOUNDED — the slice used to be on READ only", async () => {
    // 200 KB of stderr, the size in the original measurement, where the file on disk came to
    // 211985 bytes for ONE key. The ledger is a `Record` keyed by `idempotencyKey` and nothing
    // prunes it, so that was per-key growth with no ceiling.
    const { status, ledgerBytes } = await runAndRead(failingLauncher(200_000), "ledger-1");
    expect(status.phase).toBe("failed");

    // READ THE FILE, not the plugin's in-memory view: the defect was precisely that the two
    // disagreed. A `status()` assertion alone passes on the unfixed code.
    const onDisk = JSON.parse(await readFile(statePath, "utf8")) as {
      keys: Record<string, { detail: string }>;
    };
    const stored = Object.values(onDisk.keys)[0]!.detail;
    expect(stored.length).toBeLessThanOrEqual(RUNNER_DETAIL_MAX_CHARS);
    expect(ledgerBytes).toBeLessThan(10_000);
    // ...and it is still USEFUL. A bound that kept the wrong 4000 characters is the defect, not the
    // fix, so the durable record must carry the cause too.
    expect(stored).toContain(REAL_CAUSE);
  });

  it("A SUCCESSFUL RUN'S EVIDENCE IS BOUNDED TOO — the half the original measurement missed", async () => {
    // `runnerOutcomeDetail`'s success arm returned `stdout` verbatim, so a `tofu plan` over a large
    // estate wrote megabytes to this file per key to serve 4000 characters on read.
    const plan = `${"  # aws_instance.node will be created\n".repeat(150_000)}Plan: 3 to add, 0 to change, 1 to destroy.`;
    expect(plan.length).toBeGreaterThan(5_000_000);
    const { status, ledgerBytes } = await runAndRead(
      {
        async run() {
          return { succeeded: true, stdout: plan, stderr: "" };
        },
        reap: async () => []
      },
      "success-1"
    );
    expect(status.phase).toBe("succeeded");
    expect(ledgerBytes).toBeLessThan(10_000);
    // THE LINE A PLAN IS READ FOR IS ITS LAST ONE, which every front-slice lost first.
    expect(status.detail!.endsWith("Plan: 3 to add, 0 to change, 1 to destroy.")).toBe(true);
  });

  it("A DETAIL THAT ARRIVES UNBOUNDED IS BOUNDED BEFORE IT REACHES THE LEDGER", async () => {
    // THE PLUGIN'S OWN BOUND, and it exists for a reason that is not belt-and-braces: this plugin
    // applies a SECOND, independent redaction over `failure.detail` (its own knowledge of which
    // values are secret, which it may not assume the adapter already stripped), and redaction is
    // NOT LENGTH-PRESERVING — a secret value shorter than `***` makes the string grow. So the
    // re-bind after redacting is load-bearing, and `RunnerFailure.detail`'s branded type is what
    // makes the compiler insist on it.
    //
    // WHAT THIS ARM MEASURES is that the plugin does not depend on its input already being bounded:
    // an injected launcher hands it a 200 KB `detail` that the port's return type forbids (hence
    // the cast), and the durable, never-pruned JSON file still receives a bounded string.
    const huge = `${"x".repeat(200_000)}${REAL_CAUSE}`;
    const unbounded: RunnerLauncher = {
      async run() {
        return {
          succeeded: false,
          stdout: "",
          stderr: huge,
          failure: {
            kind: "exit-nonzero" as const,
            step: "start" as const,
            code: 1,
            signal: null,
            deadlineExceeded: false,
            // The cast is the point: this is what the port's return type forbids.
            detail: huge as never
          }
        };
      },
      reap: async () => []
    };
    const { status, ledgerBytes } = await runAndRead(unbounded, "unwired-1");
    expect(status.detail!.length).toBeLessThanOrEqual(RUNNER_DETAIL_MAX_CHARS);
    expect(ledgerBytes).toBeLessThan(10_000);
    expect(status.detail).toContain(REAL_CAUSE);
  });
});

/**
 * MEDIUM (M23.0 verification pass 7, finding M1) — BOUNDING ONE ENTRY DID NOT BOUND THE LEDGER, AND
 * THIS PLUGIN IS THE ONE WHERE THAT COSTS CPU AS WELL AS DISK.
 *
 * `state.keys` is a `Record` keyed by `idempotencyKey` and nothing pruned it, ever. Measured at 500
 * keys: `bytes=2074290  bytesPerKey=4149` — the per-entry bound the previous round added working
 * exactly as designed while the map grew without limit, because the map is a different quantity.
 * And `loadState` `JSON.parse`s the WHOLE file on every `status()` poll while `saveState` rewrites
 * it whole on every `trigger()`, so the ledger's size is O(total history ever) of parsing on a loop
 * that ticks once a second — the 1.44 GB/day family properly stated.
 *
 * THE ASSERTION IS ON THE FILE, not on the plugin's in-memory view, for the same reason the arm
 * above is: the defect the previous round fixed was precisely the two disagreeing.
 */
describe("MEDIUM: the durable ledger is bounded by ENTRY COUNT, not only by entry size", () => {
  it("250 runs leave exactly RUN_OUTCOME_CACHE_MAX_DURABLE keys, the newest ones", async () => {
    const plugin = createManagedIacExecutorPlugin(() => failingLauncher(500));
    const c = ctx();
    const runs = RUN_OUTCOME_CACHE_MAX_DURABLE + 50;
    const keys = Array.from(
      { length: runs },
      (_, i) => `0199ab${String(i).padStart(6, "0")}-7f00-7000-8000-000000000000`
    );
    for (const key of keys) {
      await plugin.trigger(c, {
        kind: "sync",
        targetRef: "t1",
        parameters: { iacAction: "apply" },
        idempotencyKey: key
      });
    }

    const onDisk = JSON.parse(await readFile(statePath, "utf8")) as {
      keys: Record<string, unknown>;
    };
    const stored = Object.keys(onDisk.keys);
    expect(stored.length).toBe(RUN_OUTCOME_CACHE_MAX_DURABLE);
    // Stated against a literal too — an assertion against the constant that defines the bound
    // cannot notice the constant moving.
    expect(stored.length).toBe(200);
    // THE NEWEST SURVIVED AND THE OLDEST WENT, which is the direction that matters: an entry has to
    // outlive reconcile's next `status()` poll, and that poll is about the run just recorded.
    expect(stored).toContain(keys[runs - 1]);
    expect(stored).not.toContain(keys[0]);

    // AND THE FILE HAS A CEILING, which is the fact an operator cares about. 250 unbounded entries
    // at the measured ~4.1 KB each would be over a megabyte and would keep going.
    const bytes = (await stat(statePath)).size;
    expect(bytes).toBeLessThanOrEqual(RUN_OUTCOME_CACHE_MAX_DURABLE * 4_500);
  }, 60_000);

  it("NON-VACUITY: the run that was just recorded is still readable through status()", async () => {
    // Without this, a prune that emptied the cache outright would satisfy the arm above. What an
    // entry must outlive is the poll that immediately follows its own trigger.
    const plugin = createManagedIacExecutorPlugin(() => failingLauncher(500));
    const c = ctx();
    let ref = { externalId: "" };
    for (let i = 0; i < RUN_OUTCOME_CACHE_MAX_DURABLE + 10; i++) {
      ref = await plugin.trigger(c, {
        kind: "sync",
        targetRef: "t1",
        parameters: { iacAction: "apply" },
        idempotencyKey: `0199ac${String(i).padStart(6, "0")}-7f00-7000-8000-000000000000`
      });
    }
    const status = await plugin.status(c, ref);
    expect(status.phase).toBe("failed");
    expect(status.detail).toContain(REAL_CAUSE);
  }, 60_000);
});
