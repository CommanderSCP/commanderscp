import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PluginContext } from "@scp/plugin-api";
import type { KubernetesRunnerIo } from "@scp/runner-launcher";
import { createManagedScanExecutorPlugin } from "./index.js";

/**
 * M23.2 — THE STANDING GATE THAT ADAPTER SELECTION IS *INSTALLED*, NOT MERELY BUILT.
 *
 * `launcher-seam.test.ts` proves this plugin launches through the injected `RunnerLauncher`, and
 * every one of its cases injects a resolver. That is precisely why it CANNOT prove this: production
 * injects nothing. `apps/server/src/plugin-host/subprocess-entry.ts` constructs this plugin as
 * `createManagedScanExecutorPlugin()` — no argument — so the DEFAULT PARAMETER is the whole of the
 * production wiring, and a test that always passes its own resolver never touches it.
 *
 * That is this repository's dominant defect class, named in CLAUDE.md: a component built, tested
 * through a seam that bypasses the wiring, and installed nowhere. It has happened six times in one
 * session, including a live RCE on main. The only check that works is to delete the wiring and watch
 * a NAMED test die — so this file constructs the plugin with NO ARGUMENT and requires the Kubernetes
 * adapter to be reached. Revert the default parameter to `resolveDockerRunnerLauncher` and this dies;
 * nothing else in the repository does.
 */

/** The Kubernetes launcher's injected seam, recording what the adapter tried to send and then
 *  refusing. Reaching it AT ALL is the assertion — the Docker adapter cannot touch this object. */
function recordingIo(seen: string[]): KubernetesRunnerIo {
  return {
    request: async (req) => {
      seen.push(`${req.method} ${req.path.split("?")[0]}`);
      throw new Error("m23.2-selection: the Kubernetes io was reached");
    },
    copyDir: async () => undefined,
    removeDir: async () => undefined
  };
}

const KUBERNETES_SETTINGS = {
  runnerLauncher: "kubernetes" as const,
  kubernetes: {
    namespace: "scp",
    workspaceRoot: "/scp-workspace",
    workspaceVolume: { kind: "persistentVolumeClaim", claimName: "scp-runner-workspace" } as const
  }
};

/**
 * AND THIS PLUGIN HAS A SECOND PRODUCTION CONSTRUCTION PATH, which is the one easiest to miss:
 * `apps/server/src/federation/promotion-scan-step.ts` calls `createManagedScanExecutorPlugin()`
 * IN-PROCESS, bypassing the plugin-host boundary entirely (recorded as STILL OPEN at
 * BUILD_AND_TEST.md M23.1d). Both paths call the zero-argument factory, so this case covers both —
 * and `apps/server`'s own `managed-runner-selection.test.ts` pins that the commander's promotion
 * scan context carries the selection at all, which is the half this package cannot see.
 */

let scratch: string;
beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "managed-scan-select-"));
});
afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

function ctx(overrides: Record<string, unknown>): PluginContext {
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

const intent = (key: string) => ({
  kind: "custom" as const,
  idempotencyKey: key,
  parameters: { method: "trivy", inputDir: join(scratch, "oci"), outputDir: join(scratch, "out") }
});

describe("M23.2: managed-scan, constructed the way production constructs it, honours the selection", () => {
  it("`runnerLauncher: 'kubernetes'` REACHES THE KUBERNETES ADAPTER through the ZERO-ARGUMENT factory", async () => {
    const seen: string[] = [];
    const plugin = createManagedScanExecutorPlugin();
    const c = ctx({
      ...KUBERNETES_SETTINGS,
      kubernetes: { ...KUBERNETES_SETTINGS.kubernetes, io: recordingIo(seen) }
    });
    const ref = await plugin.trigger(c, intent("select-1"));
    expect(
      seen,
      "the Kubernetes adapter was never reached — the plugin still defaults to Docker"
    ).toContain("POST /apis/batch/v1/namespaces/scp/jobs");
    expect((await plugin.status(c, ref)).phase).toBe("failed");
  });

  it("WITH THE SELECTION ABSENT the Kubernetes io is NEVER touched — the default is unchanged", async () => {
    const seen: string[] = [];
    const plugin = createManagedScanExecutorPlugin();
    const c = ctx({ kubernetes: { ...KUBERNETES_SETTINGS.kubernetes, io: recordingIo(seen) } });
    await plugin.trigger(c, intent("select-2")).catch(() => undefined);
    expect(seen).toStrictEqual([]);
  });
});
