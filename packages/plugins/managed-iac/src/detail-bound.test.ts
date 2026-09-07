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

/** HIGH (M23.0 verification pass 7). See docs/plugins.md §406. */

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
  /** THE ARM THE SURVIVING MUTATION MUST REDDEN. See docs/plugins.md §407. */
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
    // The plugin's own bound, and why it is not belt-and-braces. See docs/plugins.md §408.
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

/** MEDIUM (M23.0 verification pass 7, finding M1). See docs/plugins.md §409. */
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
