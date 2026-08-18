import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PluginContext } from "@scp/plugin-api";
import type { RunnerLauncher, RunnerSpec } from "@scp/runner-launcher";
import { createManagedIacExecutorPlugin } from "./index.js";

/**
 * M23.1 — THE STANDING GATE THAT THE PORT IS INSTALLED, not merely present.
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM THE GOLDEN. `launch-argv.golden.test.ts` proves the Docker
 * BYTES are unchanged; it would go on passing if this plugin kept its own private copy of the
 * launch sequence and `@scp/runner-launcher` were dead code nobody called. The recurring failure
 * that costs the most here is a component that is built, wired nowhere, and covered by tests that
 * reach it directly (CLAUDE.md; six instances in one M21 session, one of them a live RCE on main).
 * The only check that catches it is to REMOVE the wiring and watch a named test die — so this file
 * removes it deliberately, by injecting a launcher that throws, and requires the failure to surface
 * through `trigger()`.
 *
 * A grep for `resolveLauncher(` would not do: a commented-out call still matches the raw text, and a
 * call inside dead code still matches the stripped text.
 *
 * IT ALSO PINS WHERE THE FAILURE LANDS, which differs across the three managed executors and is the
 * asymmetry M23.0 recorded: managed-iac's `trigger()` has no outer catch, so a launcher failure
 * REJECTS out of `trigger()` and nothing is cached — `status()` then reports `pending`, not `failed`.
 */

/** No Docker, no argv — the point is that this object is reached at all. */
function throwingLauncher(): RunnerLauncher {
  return {
    run(): Promise<never> {
      throw new Error("managed-iac test: the injected RunnerLauncher was reached");
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

let workspaceRoot: string;

beforeEach(async () => {
  workspaceRoot = await mkdtemp(join(tmpdir(), "managed-iac-seam-"));
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
      statePath: join(workspaceRoot, "dedup.json")
    }
  };
}

describe("M23.1: managed-iac launches through the injected RunnerLauncher", () => {
  it("a launcher that throws breaks trigger() — the plugin has no second, private launch path", async () => {
    const plugin = createManagedIacExecutorPlugin(() => throwingLauncher());
    await expect(
      plugin.trigger(ctx(), {
        kind: "sync",
        targetRef: "t1",
        parameters: { iacAction: "plan" },
        idempotencyKey: "seam-1"
      })
    ).rejects.toThrow(/the injected RunnerLauncher was reached/);
  });

  it("the resolver receives the server-injected dockerBinary, and the run reaches the port once", async () => {
    const seen: RunnerSpec[] = [];
    const resolverSaw: (string | undefined)[] = [];
    const plugin = createManagedIacExecutorPlugin((config) => {
      resolverSaw.push(config.dockerBinary);
      return recordingLauncher(seen);
    });

    const c = ctx();
    (c.config as Record<string, unknown>).dockerBinary = "/usr/local/bin/docker";
    const ref = await plugin.trigger(c, {
      kind: "sync",
      targetRef: "t1",
      parameters: { iacAction: "apply" },
      idempotencyKey: "seam-2"
    });

    expect(resolverSaw).toStrictEqual(["/usr/local/bin/docker"]);
    expect(seen).toHaveLength(1);
    // Not a re-assertion of the golden's full argv — just enough that a launcher wired to the wrong
    // plugin, or handed an empty spec, cannot pass.
    expect(seen[0]!.image).toBe("scp-runner-iac:vetted");
    expect(seen[0]!.operands).toStrictEqual(["apply"]);
    expect((await plugin.status(c, ref)).phase).toBe("succeeded");
  });
});
