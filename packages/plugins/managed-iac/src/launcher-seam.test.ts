import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PluginContext } from "@scp/plugin-api";
import type { RunnerLauncher, RunnerSpec } from "@scp/runner-launcher";
import { createManagedIacExecutorPlugin } from "./index.js";

/** The standing gate that the port is installed, not present. See docs/plugins.md §447. */

/** No Docker, no argv — the point is that this object is reached at all. `reap` is never called by
 *  a plugin directly (only the Docker adapter's own `run()` calls its own `reap` — see
 *  `@scp/runner-launcher`'s `reaper.integration.test.ts`), so every fake in this file stubs it to
 *  satisfy the port and nothing here exercises it. */
function throwingLauncher(): RunnerLauncher {
  return {
    run(): Promise<never> {
      throw new Error("managed-iac test: the injected RunnerLauncher was reached");
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

let workspaceRoot: string;

beforeEach(async () => {
  workspaceRoot = await mkdtemp(join(tmpdir(), "managed-iac-seam-"));
});

afterEach(async () => {
  await rm(workspaceRoot, { recursive: true, force: true });
});

function ctx(
  overrides: Record<string, unknown> = {},
  secretGet?: (key: string) => Promise<string | undefined>
): PluginContext {
  return {
    orgId: "org-1",
    scopeKey: "domain-1",
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    secrets: { get: secretGet ?? (async () => undefined) },
    http: {
      request: async () => {
        throw new Error("managed-iac: never calls ctx.http");
      }
    },
    config: {
      runnerImage: "scp-runner-iac:vetted",
      workspaceRoot,
      networkMode: "none",
      statePath: join(workspaceRoot, "dedup.json"),
      ...overrides
    }
  };
}

describe("M23.1: managed-iac launches through the injected RunnerLauncher", () => {
  it("a launcher failure is RECORDED as failed, never left pending — the plugin has no second, private launch path", async () => {
    const plugin = createManagedIacExecutorPlugin(() => throwingLauncher());
    const c = ctx();
    const ref = await plugin.trigger(c, {
      kind: "sync",
      targetRef: "t1",
      parameters: { iacAction: "plan" },
      idempotencyKey: "seam-1"
    });
    // trigger() RESOLVES (phase 2) — a plugin with a private second launch path that never touched
    // the injected launcher would resolve too, but status() would then report "succeeded" instead.
    const status = await plugin.status(c, ref);
    expect(status.phase).toBe("failed");
    expect(status.detail).toMatch(/the injected RunnerLauncher was reached/);
  });

  it("a create failure's recorded detail carries NO credential value", async () => {
    // THE COUPLING PHASE 2 NAMED. See docs/plugins.md §448.
    const SEEDED_SECRET = "zzz9-do-not-leak-zzz9";
    const leaking: RunnerLauncher = {
      run(): Promise<never> {
        throw new Error(
          `Command failed: docker create --network none -e AWS_SECRET_ACCESS_KEY=${SEEDED_SECRET} scp-runner-iac:vetted plan`
        );
      },
      reap: async () => []
    };
    const plugin = createManagedIacExecutorPlugin(() => leaking);
    const c = ctx({ infraCredsSecretKeys: { AWS_SECRET_ACCESS_KEY: "aws-secret" } }, async (key) =>
      key === "aws-secret" ? SEEDED_SECRET : undefined
    );
    const ref = await plugin.trigger(c, {
      kind: "sync",
      targetRef: "t1",
      parameters: { iacAction: "plan" },
      idempotencyKey: "seam-3"
    });

    const status = await plugin.status(c, ref);
    expect(status.phase).toBe("failed");
    expect(status.detail).not.toContain(SEEDED_SECRET);
    // The failure is still legible — redaction removed the VALUE, not the fact that it failed.
    expect(status.detail).toContain("docker create");
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

    // The whole spec compared strictly, which is the point. See docs/plugins.md §449.
    const workspaceDir = join(workspaceRoot, "org-1", "t1");
    expect(seen[0], "managed-iac's RunnerSpec changed").toStrictEqual({
      // THE RUN'S OWN IDENTITY, DERIVED FROM THE IDEMPOTENCY KEY — caller-supplied, never
      // adapter-minted, so a retry addresses the same container name and M23.3's Kubernetes arm can
      // put the same string in `metadata.name`. `toRunnerRunId("seam-2")` is a lossless slug, hence
      // the bare key; a key needing sanitisation gets a digest appended instead of colliding.
      runId: "seam-2",
      labels: { "scp.executor": "scp-managed-iac", "scp.run-id": "seam-2" },
      image: "scp-runner-iac:vetted",
      operands: ["apply"],
      // A CONFIG READ for this plugin (server-injected, default "none") — unlike managed-dep, whose
      // charter clause carries no operator qualifier and passes a literal.
      networkMode: "none",
      // No rollback extras in this intent, so nothing non-secret to pass.
      env: [],
      // No `infraCredsSecretKeys` in this ctx, so no credentials are materialised. When they ARE,
      // they go HERE and not into `env` — the Docker adapter delivers `secretEnv` through a
      // mode-0600 `--env-file` instead of `-e`, and the Kubernetes adapter must deliver it as a
      // per-run Secret. The golden owns the populated case and the env-file's contents.
      secretEnv: [],
      // The plugin's OWN state dir — `dirname(statePath)` — never the workspace (which is copied
      // INTO the container) and never `os.tmpdir()` (which is shared with every other local user).
      secretEnvDir: workspaceRoot,
      // COPIED, never bind-mounted: nothing on the host becomes a container mount.
      copyIn: [{ hostDir: workspaceDir, containerPath: "/workspace" }],
      // THE ASYMMETRY THAT IS THIS PLUGIN'S ALONE, on both axes. See docs/plugins.md §450.
      copyOut: {
        containerPath: "/workspace",
        hostDir: workspaceDir,
        when: "always",
        onFailure: "swallow"
      },
      // 10 minutes (the default; tenant-settable via config.timeoutMs) and 16 MiB — the SMALLEST
      // stdout budget of the three, and not a shared default.
      timeoutMs: 10 * 60_000,
      maxBuffer: 16 * 1024 * 1024
    });
    expect((await plugin.status(c, ref)).phase).toBe("succeeded");
  });
});
