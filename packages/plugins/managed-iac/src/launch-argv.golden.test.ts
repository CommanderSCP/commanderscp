import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@scp/plugin-api";

/**
 * ================================================================================================
 * M23.0 — THE GOLDEN DOCKER ARGV FOR `scp-managed-iac`, RECORDED BEFORE ANYTHING MOVES
 * ================================================================================================
 *
 * WHY THIS FILE EXISTS AND WHEN IT SHOULD STOP EXISTING.
 * M23 extracts a `RunnerLauncher` port so the three managed executors can also launch their runners
 * as Kubernetes Jobs. That refactor's central promise is that **the Docker path is byte-for-byte
 * unchanged**. A promise like that is only checkable if the current bytes were written down FIRST,
 * by a test that existed BEFORE the refactor — otherwise the "unchanged" baseline is whatever the
 * refactor happens to emit, and the assertion is a tautology.
 *
 * Until M23.1 lands the port, THIS FILE IS THE DEFINITION OF "UNCHANGED" for this plugin. When the
 * port lands, these tests are to be **deleted or superseded** by the port's own conformance suite —
 * they are a snapshot of an implementation detail, deliberately, and keeping them alongside a port
 * that has its own contract test would be duplicate coupling to the same bytes.
 *
 * WHAT IS PINNED, AND WHY EACH PART IS PART OF THE PROMISE.
 *  1. THE FULL argv ARRAY of every `execFile`, in order — `create`, `cp` in, `start`, `cp` out,
 *     `rm`. Asserted as an array against a literal, never as "contains" or as a call count: a
 *     renamed binary, a reordered flag or a dropped operand must fail, and must fail by PRINTING
 *     the actual argv next to the expected one.
 *  2. THE OPTIONS OBJECT alongside each argv. These differ per plugin (managed-iac: 10 min /
 *     16 MiB; managed-scan: 10 min / 32 MiB; managed-dep: 5 min / 8 MiB) and `rm` alone carries a
 *     30 s timeout AND NO `maxBuffer` AT ALL. A port that unified those into one shared default
 *     would be a behaviour change wearing a refactor's clothes, and nothing else in the build would
 *     notice. `toStrictEqual` is what makes the ABSENCE of `maxBuffer` on `rm` — and the absence of
 *     any `cwd`/`env` anywhere — part of the record rather than merely untested.
 *  3. THE ASYMMETRY THAT IS SPECIFIC TO THIS PLUGIN: managed-iac copies the workspace back OUT
 *     **unconditionally** (even after a failed `start`) and **catch-guarded** (a failed copy-out
 *     does not fail the run). managed-scan and managed-dep do the opposite on BOTH axes — copy out
 *     only on success, and let a failed copy-out propagate. That difference is real, load-bearing
 *     (a failed `apply` may still have produced a partial plan worth persisting) and exactly the
 *     kind of thing a "unify the three launchers" refactor normalises away by accident. It is
 *     pinned here as behaviour, not left as a comment.
 *  4. THE FAILURE PATH: what the argv and the cleanup look like when `start` rejects.
 *
 * THE RECORDING SEAM is the one this package already uses — `vi.mock("node:child_process")` with a
 * hand-written `execFile`, the same shape as `index.test.ts` here and `runner-containment.test.ts`
 * in `@scp/plugin-managed-dep`. The only widening is that the options object (which those files
 * discard as `_opts`) is now recorded too, because point 2 above is half the promise. No Docker is
 * required, so these run on every PR under `pnpm test`.
 */

interface ExecFileCall {
  file: string;
  args: string[];
  opts: unknown;
}

/** Every `execFile` of the run, in the order the plugin issued them. */
const calls: ExecFileCall[] = [];

/** `start` outcome — the failure arm is a rejection carrying stdout/stderr, as `execFile` does. */
let startOk = true;
/** Copy-OUT outcome. Only managed-iac swallows a failure here; that is what test 4 measures. */
let cpOutOk = true;

vi.mock("node:child_process", () => {
  return {
    execFile: (
      file: string,
      args: string[],
      opts: unknown,
      cb: (err: Error | null, result?: { stdout: string; stderr: string }) => void
    ) => {
      calls.push({ file, args, opts });
      const sub = args[0];
      if (sub === "create") {
        cb(null, { stdout: "container-abc123\n", stderr: "" });
        return;
      }
      if (sub === "start") {
        if (startOk) {
          cb(null, { stdout: "tofu ok", stderr: "" });
        } else {
          cb(
            Object.assign(new Error("container exited non-zero"), {
              stdout: "partial plan",
              stderr: "tofu: boom"
            })
          );
        }
        return;
      }
      if (sub === "cp" && String(args[1]).includes(":/workspace/.") && !cpOutOk) {
        cb(new Error("docker cp: no such file or directory"));
        return;
      }
      cb(null, { stdout: "", stderr: "" }); // cp in / cp out / rm
    }
  };
});

const { createManagedIacExecutorPlugin } = await import("./index.js");

/**
 * THE OPTIONS, AS LITERALS. Deliberately NOT imported from `index.ts`: a golden that re-derives its
 * expectation from the code it is guarding cannot detect a change to that code. 10 minutes and
 * 16 MiB are written here because that is what the plugin does TODAY.
 */
const RUN_OPTS = { timeout: 10 * 60_000, maxBuffer: 16 * 1024 * 1024 };
/** The teardown call's own options — a shorter timeout and, notably, NO `maxBuffer`. */
const RM_OPTS = { timeout: 30_000 };

let workspaceRoot: string;

beforeEach(async () => {
  calls.length = 0;
  startOk = true;
  cpOutOk = true;
  workspaceRoot = await mkdtemp(join(tmpdir(), "managed-iac-golden-"));
});

afterEach(async () => {
  await rm(workspaceRoot, { recursive: true, force: true });
});

function ctx(
  overrides: Record<string, unknown> = {},
  secretGet?: (k: string) => Promise<string | undefined>
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

/** `workspaceDirFor`'s output for the contexts below — `<root>/<safe orgId>/<safe targetRef>`. */
function workspaceDir(targetRef = "t1"): string {
  return join(workspaceRoot, "org-1", targetRef);
}

describe("M23.0 golden: the `scp-managed-iac` runner launch, byte for byte", () => {
  it("DEFAULT — plan, no credentials: create / cp in / start / cp out / rm", async () => {
    const plugin = createManagedIacExecutorPlugin();
    const ref = await plugin.trigger(ctx(), {
      kind: "sync",
      targetRef: "t1",
      parameters: { iacAction: "plan", sourceFiles: { "main.tf": "# tf" } },
      idempotencyKey: "k1"
    });

    const w = workspaceDir();
    expect(calls, "the managed-iac Docker launch argv changed").toStrictEqual([
      {
        file: "docker",
        args: ["create", "--network", "none", "scp-runner-iac:vetted", "plan"],
        opts: RUN_OPTS
      },
      {
        file: "docker",
        args: ["cp", `${w}/.`, "container-abc123:/workspace"],
        opts: RUN_OPTS
      },
      { file: "docker", args: ["start", "-a", "container-abc123"], opts: RUN_OPTS },
      {
        file: "docker",
        args: ["cp", "container-abc123:/workspace/.", w],
        opts: RUN_OPTS
      },
      { file: "docker", args: ["rm", "-f", "container-abc123"], opts: RM_OPTS }
    ]);

    // ...and the run really completed, so none of the above passed by nothing having happened.
    expect((await plugin.status(ctx(), ref)).phase).toBe("succeeded");
  });

  it("EVERY OPTIONAL INPUT PRESENT — custom binary, network, timeout, two creds, and a rollback env", async () => {
    // The maximal shape: a server-injected `dockerBinary` and `networkMode`, a tenant `timeoutMs`,
    // two resolved infra credentials, and the `PRIOR_STATE_FILE` a rollback appends. The ORDER of
    // the `-e` pairs is `Object.entries({...infraCreds, ...extraEnv})` — the config's own key order
    // first, the rollback's env last — and that order is part of the record.
    const plugin = createManagedIacExecutorPlugin();
    const secrets: Record<string, string> = {
      "aws/id": "AKIAEXAMPLE",
      "aws/secret": "s3cr3t-value"
    };
    const c = ctx(
      {
        dockerBinary: "/usr/local/bin/docker",
        networkMode: "bridge",
        timeoutMs: 123_456,
        infraCredsSecretKeys: {
          AWS_ACCESS_KEY_ID: "aws/id",
          AWS_SECRET_ACCESS_KEY: "aws/secret"
        }
      },
      async (k) => secrets[k]
    );
    const ref = await plugin.trigger(c, {
      kind: "rollback",
      targetRef: "prod/eu-west-1",
      priorStateRef: "state-history/2026-08-17.tfstate",
      idempotencyKey: "k2"
    });

    // `workspaceDirFor` replaces every character outside [A-Za-z0-9._-] with `_`.
    const w = workspaceDir("prod_eu-west-1");
    const opts = { timeout: 123_456, maxBuffer: 16 * 1024 * 1024 };
    expect(calls, "the managed-iac maximal Docker launch argv changed").toStrictEqual([
      {
        file: "/usr/local/bin/docker",
        args: [
          "create",
          "--network",
          "bridge",
          "-e",
          "AWS_ACCESS_KEY_ID=AKIAEXAMPLE",
          "-e",
          "AWS_SECRET_ACCESS_KEY=s3cr3t-value",
          "-e",
          "PRIOR_STATE_FILE=state-history/2026-08-17.tfstate",
          "scp-runner-iac:vetted",
          "rollback"
        ],
        opts
      },
      {
        file: "/usr/local/bin/docker",
        args: ["cp", `${w}/.`, "container-abc123:/workspace"],
        opts
      },
      { file: "/usr/local/bin/docker", args: ["start", "-a", "container-abc123"], opts },
      { file: "/usr/local/bin/docker", args: ["cp", "container-abc123:/workspace/.", w], opts },
      // THE TEARDOWN TIMEOUT IS NOT THE RUN TIMEOUT. A tenant `timeoutMs` of 123456 does not reach
      // `rm`, which keeps its own literal 30 s and still carries no `maxBuffer`.
      { file: "/usr/local/bin/docker", args: ["rm", "-f", "container-abc123"], opts: RM_OPTS }
    ]);

    expect((await plugin.status(c, ref)).phase).toBe("succeeded");
  });

  it("FAILURE — `start` rejects, and the evidence is STILL copied out before `rm`", async () => {
    // THE ASYMMETRY, MEASURED. managed-iac's copy-out is UNCONDITIONAL: a failed `apply` may have
    // produced a partial `plan.json` worth persisting. managed-scan and managed-dep skip their
    // copy-out entirely on a failed `start` — a refactor that gives all three one shared sequence
    // must break this test, or it has silently changed what evidence survives a failed run.
    startOk = false;
    const plugin = createManagedIacExecutorPlugin();
    const ref = await plugin.trigger(ctx(), {
      kind: "sync",
      targetRef: "t1",
      parameters: { iacAction: "apply" },
      idempotencyKey: "k3"
    });

    const w = workspaceDir();
    expect(calls, "the managed-iac FAILED-run Docker sequence changed").toStrictEqual([
      {
        file: "docker",
        args: ["create", "--network", "none", "scp-runner-iac:vetted", "apply"],
        opts: RUN_OPTS
      },
      { file: "docker", args: ["cp", `${w}/.`, "container-abc123:/workspace"], opts: RUN_OPTS },
      { file: "docker", args: ["start", "-a", "container-abc123"], opts: RUN_OPTS },
      { file: "docker", args: ["cp", "container-abc123:/workspace/.", w], opts: RUN_OPTS },
      { file: "docker", args: ["rm", "-f", "container-abc123"], opts: RM_OPTS }
    ]);

    const status = await plugin.status(ctx(), ref);
    expect(status.phase).toBe("failed");
    expect(status.detail).toContain("tofu: boom");
  });

  it("A FAILED COPY-OUT IS SWALLOWED — the run still succeeds and the container is still removed", async () => {
    // The second half of the asymmetry: managed-iac's copy-out is `.catch(() => undefined)`, so a
    // `docker cp` that cannot read the container's workspace is not a failed run. (managed-scan and
    // managed-dep leave theirs unguarded, so the same failure escapes their `trigger()`.) Pinned
    // here because "best-effort" is a property of the call site, and a port that awaits all five
    // steps uniformly would change a succeeded apply into a failed one.
    cpOutOk = false;
    const plugin = createManagedIacExecutorPlugin();
    const ref = await plugin.trigger(ctx(), {
      kind: "sync",
      targetRef: "t1",
      parameters: { iacAction: "plan" },
      idempotencyKey: "k4"
    });

    expect(calls.map((c) => c.args[0])).toStrictEqual(["create", "cp", "start", "cp", "rm"]);
    expect(calls.at(-1)).toStrictEqual({
      file: "docker",
      args: ["rm", "-f", "container-abc123"],
      opts: RM_OPTS
    });
    expect((await plugin.status(ctx(), ref)).phase).toBe("succeeded");
  });
});
