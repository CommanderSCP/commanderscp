import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PluginContext } from "@scp/plugin-api";
import type { RunnerLauncher, RunnerSpec } from "@scp/runner-launcher";
import { createManagedScanExecutorPlugin } from "./index.js";

/**
 * M23.1 — THE STANDING GATE THAT THE PORT IS INSTALLED, not merely present.
 *
 * See `@scp/plugin-managed-iac`'s file of the same name for why this is separate from
 * `launch-argv.golden.test.ts`: the golden proves the Docker bytes are unchanged and would keep
 * passing if this plugin retained a private copy of the launch sequence with `@scp/runner-launcher`
 * dead beside it. The only check that distinguishes the two is to delete the wiring — here, by
 * injecting a launcher that throws — and require a named test to die.
 *
 * THIS PLUGIN IS THE ONE WHERE THE SEAM'S CONFIG SURFACE HAS TEETH. `dockerBinary` decides which
 * executable runs, and managed-scan shipped a live RCE because it sat on `KNOWN_EXECUTOR_MODULES`
 * with no manifest, so `validatePluginConfig` returned early and a tenant binding could set it. The
 * second test below pins that the resolver is handed exactly that one field and nothing else has
 * been invented alongside it — M23.1 adds NO new key to the server-injected class.
 */

function throwingLauncher(): RunnerLauncher {
  return {
    run(): Promise<never> {
      throw new Error("managed-scan test: the injected RunnerLauncher was reached");
    }
  };
}

function recordingLauncher(seen: RunnerSpec[]): RunnerLauncher {
  return {
    async run(spec) {
      seen.push(spec);
      return { succeeded: true, stdout: "recorded", stderr: "" };
    }
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
  it("a launcher that throws breaks trigger() — the plugin has no second, private launch path", async () => {
    const plugin = createManagedScanExecutorPlugin(() => throwingLauncher());
    await expect(
      plugin.trigger(ctx(), {
        kind: "custom",
        idempotencyKey: "seam-1",
        parameters: {
          method: "trivy",
          inputDir: join(scratch, "oci"),
          outputDir: join(scratch, "out")
        }
      })
    ).rejects.toThrow(/the injected RunnerLauncher was reached/);
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

    // `toStrictEqual` on the WHOLE object, not a property check: the point is the ABSENCE of any
    // further adapter-selection key, because every key here joins the server-injected,
    // never-tenant-settable class and must be added to all three enforcement layers in the same
    // change. M23.2 is where that happens; M23.1 must not smuggle one in early.
    expect(resolverSaw).toStrictEqual([{ dockerBinary: "/usr/local/bin/docker" }]);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.image).toBe("scp-runner-scan:vetted");
    expect((await plugin.status(c, ref)).phase).toBe("succeeded");
  });
});
