import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PluginContext } from "@scp/plugin-api";
import {
  RUNNER_DETAIL_MAX_CHARS,
  RunnerLaunchError,
  classifyRunnerFailure,
  type RunnerLauncher
} from "@scp/runner-launcher";
import { createManagedScanExecutorPlugin } from "./index.js";

/**
 * HIGH (M23.0 verification pass 7) — FOR THIS PLUGIN THE FAILURE TAIL WAS UNREACHABLE AT EVERY
 * OUTPUT SIZE, and that is the sharpest form of the defect.
 *
 * The port appended the runner's last 2000 characters only when the output EXCEEDED 2000 (below
 * that it is already inside Node's `Command failed: <cmd>\n<stderr>` message and the append was
 * skipped as a duplicate) — and it appended them AFTER that message. This plugin then sliced
 * `runnerOutcomeDetail(result)` to 2000 characters FROM THE FRONT at capture. So the append existed
 * exactly when the message ahead of it was already longer than the slice: below 2000 there was no
 * append, above 2000 the append was past the cut. There was no size at which a Trivy failure's own
 * last words reached `status().detail`.
 *
 * Trivy is the worst case in the fleet — this plugin uses the largest `maxBuffer` of the three
 * (32 MiB) because a report is the biggest thing any managed runner prints — and an operator reading
 * a failed scan got 2000 characters of Node's preamble.
 */

const REAL_CAUSE = "FATAL: unable to initialize a scanner: DB error: failed to download vuln DB";

function failingLauncher(noiseChars: number): RunnerLauncher {
  const line = "2026-08-18T00:00:00Z INFO Vulnerability scanning is enabled, this is noise\n";
  const noise = line.repeat(Math.ceil(noiseChars / line.length)).slice(0, noiseChars);
  const stderr = `${noise}${REAL_CAUSE}\n`;
  return {
    async run() {
      const err = new RunnerLaunchError({
        step: "start",
        file: "docker",
        argv: ["start", "-a", "scp-runner-managed-scan--k"],
        cause: Object.assign(new Error(`Command failed: docker start -a c\n${stderr}`), {
          code: 1,
          killed: false,
          signal: null,
          stdout: "",
          stderr
        }),
        redactions: []
      });
      return { succeeded: false, stdout: "", stderr, failure: classifyRunnerFailure(err) };
    },
    reap: async () => []
  };
}

let scratch: string;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "managed-scan-detail-"));
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

function ctx(): PluginContext {
  return {
    orgId: "org-1",
    scopeKey: "domain-1",
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    secrets: { get: async () => undefined },
    http: {
      request: async () => {
        throw new Error("managed-scan: never calls ctx.http");
      }
    },
    config: { runnerImage: "scp-runner-scan:vetted", networkMode: "none" }
  };
}

describe("HIGH: a failed scan's own last words reach status().detail at every output size", () => {
  it.each([1_500, 5_000, 50_000])(
    "the cause survives %i characters of scanner output",
    async (noiseChars) => {
      const plugin = createManagedScanExecutorPlugin(() => failingLauncher(noiseChars));
      const c = ctx();
      const ref = await plugin.trigger(c, {
        kind: "custom",
        idempotencyKey: `scan-bound-${noiseChars}`,
        parameters: {
          method: "trivy",
          inputDir: join(scratch, "oci"),
          outputDir: join(scratch, "out")
        }
      });
      const status = await plugin.status(c, ref);
      expect(status.phase).toBe("failed");
      // The plugin's own framing survives at the FRONT and the diagnosis at the BACK — the bound
      // takes the middle, which is the noise Trivy printed on its way to the error.
      expect(status.detail).toContain("scan FAILED");
      expect(status.detail, "the tail is unreachable again").toContain(REAL_CAUSE);
      expect(status.detail!.length).toBeLessThanOrEqual(RUNNER_DETAIL_MAX_CHARS);
    }
  );

  it("THE OUTCOME CACHE ENTRY IS BOUNDED, not just the value status() returns", async () => {
    // `status()` used to be where the 4000 was applied. The cache entry behind it held the whole
    // thing — an in-memory `Map` keyed by `externalId` that nothing prunes, so the same per-key
    // growth property as managed-iac's on-disk ledger, in RAM. Reading through `status()` twice
    // cannot distinguish the two, so this asserts against a 32 MiB-scale input where the difference
    // is unmissable.
    const plugin = createManagedScanExecutorPlugin(() => failingLauncher(2_000_000));
    const c = ctx();
    const ref = await plugin.trigger(c, {
      kind: "custom",
      idempotencyKey: "scan-cache-1",
      parameters: {
        method: "trivy",
        inputDir: join(scratch, "oci"),
        outputDir: join(scratch, "out")
      }
    });
    const status = await plugin.status(c, ref);
    expect(status.detail!.length).toBeLessThanOrEqual(RUNNER_DETAIL_MAX_CHARS);
    expect(status.detail).toContain(REAL_CAUSE);
  });
});
