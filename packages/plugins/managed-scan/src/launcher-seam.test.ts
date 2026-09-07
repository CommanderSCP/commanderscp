import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PluginContext } from "@scp/plugin-api";
import type { RunnerLauncher, RunnerSpec } from "@scp/runner-launcher";
import { createManagedScanExecutorPlugin } from "./index.js";

/** The standing gate that the port is installed, not present. See docs/plugins.md §489. */

// `reap` is stubbed on every fake below to satisfy the port — it is never called by a plugin
// directly, only by the Docker adapter's own `run()` (see `@scp/runner-launcher`'s
// `reaper.integration.test.ts`), so nothing here exercises it.
function throwingLauncher(): RunnerLauncher {
  return {
    run(): Promise<never> {
      throw new Error("managed-scan test: the injected RunnerLauncher was reached");
    },
    reap: async () => []
  };
}

function recordingLauncher(seen: RunnerSpec[]): RunnerLauncher {
  return {
    async run(spec) {
      seen.push(spec);
      return { succeeded: true, stdout: "recorded", stderr: "" };
    },
    reap: async () => []
  };
}

let scratch: string;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "managed-scan-seam-"));
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

function ctx(overrides: Record<string, unknown> = {}): PluginContext {
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
    config: { runnerImage: "scp-runner-scan:vetted", networkMode: "none", ...overrides }
  };
}

describe("M23.1: managed-scan launches through the injected RunnerLauncher", () => {
  it("a launcher failure is RECORDED as failed, never left pending — the plugin has no second, private launch path", async () => {
    const plugin = createManagedScanExecutorPlugin(() => throwingLauncher());
    const c = ctx();
    const ref = await plugin.trigger(c, {
      kind: "custom",
      idempotencyKey: "seam-1",
      parameters: {
        method: "trivy",
        inputDir: join(scratch, "oci"),
        outputDir: join(scratch, "out")
      }
    });
    // trigger() RESOLVES (phase 2) — if the plugin still had a private, second launch path that
    // never touched the injected launcher, it would resolve too, but status() below would report
    // `succeeded`. Only reaching THIS injected launcher and RECORDING what it threw makes both
    // assertions pass together.
    const status = await plugin.status(c, ref);
    expect(status.phase).toBe("failed");
    expect(status.detail).toMatch(/the injected RunnerLauncher was reached/);
  });

  it("the resolver is handed the server-injected dockerBinary and NOTHING else", async () => {
    const seen: RunnerSpec[] = [];
    const resolverSaw: Record<string, unknown>[] = [];
    const plugin = createManagedScanExecutorPlugin((config) => {
      resolverSaw.push({ ...config });
      return recordingLauncher(seen);
    });

    const c = ctx({ dockerBinary: "/usr/local/bin/docker" });
    const ref = await plugin.trigger(c, {
      kind: "custom",
      idempotencyKey: "seam-2",
      parameters: {
        method: "trivy",
        inputDir: join(scratch, "oci"),
        outputDir: join(scratch, "out")
      }
    });

    // `toStrictEqual` on the WHOLE object, not a property check. See docs/plugins.md §490.
    expect(resolverSaw).toStrictEqual([
      { dockerBinary: "/usr/local/bin/docker", runnerLauncher: undefined, kubernetes: undefined }
    ]);
    expect(seen).toHaveLength(1);

    // THE WHOLE SPEC, `toStrictEqual`. See docs/plugins.md §491.
    expect(seen[0], "managed-scan's RunnerSpec changed").toStrictEqual({
      // Derived from the same key `externalId` is built from, so an orphaned container is traceable
      // to the run the commander is waiting on. Caller-supplied, never adapter-minted.
      runId: "seam-2",
      labels: { "scp.executor": "scp-managed-scan", "scp.run-id": "seam-2" },
      image: "scp-runner-scan:vetted",
      // trivy takes no extra run.sh args; only `openscap` appends the two positional ones (and
      // appends them EVEN WHEN EMPTY, which is the golden's business).
      operands: ["trivy"],
      // A CONFIG READ (server-injected, default "none") — this class's charter clause is qualified
      // ("excepting operator-allowlisted registry pulls"), so the operator setting is legitimate.
      networkMode: "none",
      // No preload dirs in this intent, so NEITHER `-e` pair fires. See docs/plugins.md §492.
      env: [],
      // NO CREDENTIAL AT ALL. A scan reads bytes the server already pulled; the runner holds
      // nothing, so no `--env-file` is ever written for this plugin.
      secretEnv: [],
      // The server-pulled OCI layout, always, and alone when no cache is preloaded.
      copyIn: [{ hostDir: join(scratch, "oci"), containerPath: "/work/image" }],
      // THE OPPOSITE OF managed-iac ON BOTH AXES, and fail-closed on purpose: a failed scan must
      // produce NO evidence (the commander writes none and E6 then refuses), and a failed copy-out
      // PROPAGATES out of the launcher rather than being swallowed there — `trigger()`'s outer
      // catch is what turns it into a recorded `failed`, which the last case in this file measures.
      copyOut: {
        containerPath: "/work/out",
        hostDir: join(scratch, "out"),
        when: "on-success",
        onFailure: "propagate"
      },
      // 10 minutes, and 32 MiB — the LARGEST of the three, because a Trivy report is the biggest
      // thing any of these runners writes to stdout.
      timeoutMs: 10 * 60_000,
      maxBuffer: 32 * 1024 * 1024
    });
    expect((await plugin.status(c, ref)).phase).toBe("succeeded");
  });
});
