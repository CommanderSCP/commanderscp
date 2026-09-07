import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@scp/plugin-api";
import { RUNNER_LAUNCHER_DEADLINE_LABEL, RUNNER_LAUNCHER_OWNER_LABEL } from "@scp/runner-launcher";

/** The golden Docker argv, recorded before anything moves. See docs/plugins.md §437. */

interface ExecFileCall {
  file: string;
  args: string[];
  opts: unknown;
}

/** Every `execFile` of the run, in the order the plugin issued them. */
const calls: ExecFileCall[] = [];

/** What the transient env file held while create was in flight. See docs/plugins.md §438. */
const envFiles: { path: string; content: string; mode: number }[] = [];

/** `start` outcome — the failure arm is a rejection carrying stdout/stderr, as `execFile` does. */
let startOk = true;
/** Copy-OUT outcome. Only managed-iac swallows a failure here; that is what test 4 measures. */
let cpOutOk = true;
/** The only failure-injection arms for the create step. See docs/plugins.md §439. */
let createFailure: Error | undefined;
/** An ordinary `create` failure: the daemon answered, and it was not about the name. */
function ordinaryCreateFailure(): Error {
  return Object.assign(new Error("docker: Error response from daemon: no such image"), {
    stdout: "",
    stderr: "create: no such image: scp-runner-iac:vetted"
  });
}
/** MEASURED against Docker 29.5.2 — the exact wording a second `docker create --name X` produces. */
function nameConflictCreateFailure(): Error {
  const stderr =
    'Error response from daemon: Conflict. The container name "/scp-runner-k7" is already in use ' +
    'by container "fd602b921ac608a0f33551acba7943abbf2816160d30e09e3a33d8f86f1873c5". You have to ' +
    "remove (or rename) that container to be able to reuse that name.";
  return Object.assign(new Error(`Command failed: docker create …\n${stderr}`), {
    code: 1,
    killed: false,
    stdout: "",
    stderr
  });
}

/** M23.1 PHASE 4 — the reaper. See docs/plugins.md §440. */
function stripLauncherLabel(args: string[], key: string): string[] {
  const flagIndex = args.findIndex(
    (a, i) => a === "--label" && (args[i + 1] ?? "").startsWith(`${key}=`)
  );
  return flagIndex === -1 ? args : [...args.slice(0, flagIndex), ...args.slice(flagIndex + 2)];
}
function stripLauncherLabels(args: string[]): string[] {
  return stripLauncherLabel(
    stripLauncherLabel(args, RUNNER_LAUNCHER_OWNER_LABEL),
    RUNNER_LAUNCHER_DEADLINE_LABEL
  );
}

vi.mock("node:child_process", () => {
  return {
    execFile: (
      file: string,
      args: string[],
      opts: unknown,
      cb: (err: Error | null, result?: { stdout: string; stderr: string }) => void
    ) => {
      if (args[0] === "ps") {
        setImmediate(() => cb(null, { stdout: "", stderr: "" }));
        return;
      }
      calls.push({ file, args: args[0] === "create" ? stripLauncherLabels(args) : args, opts });
      const envFileIndex = args.indexOf("--env-file");
      if (envFileIndex !== -1) {
        const path = String(args[envFileIndex + 1]);
        envFiles.push({
          path,
          content: readFileSync(path, "utf8"),
          mode: statSync(path).mode & 0o777
        });
      }
      const sub = args[0];
      if (sub === "create") {
        if (createFailure) {
          cb(createFailure);
        } else {
          cb(null, { stdout: "container-abc123\n", stderr: "" });
        }
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

/** The options: the buffer as a literal, the timeout as a bound. See docs/plugins.md §441. */
const BUDGET_SLACK_MS = 5_000;
function runOpts(budgetMs: number, maxBuffer: number): unknown {
  return {
    timeout: {
      asymmetricMatch: (actual: unknown): boolean =>
        typeof actual === "number" && actual > budgetMs - BUDGET_SLACK_MS && actual <= budgetMs,
      toAsymmetricMatcher: (): string =>
        `RemainingBudget(>${budgetMs - BUDGET_SLACK_MS}, <=${budgetMs})`,
      toString: (): string => "RemainingBudget"
    },
    maxBuffer
  };
}
const RUN_OPTS = runOpts(10 * 60_000, 16 * 1024 * 1024);
/** The teardown call's own options — a shorter timeout and, notably, NO `maxBuffer`. */
const RM_OPTS = { timeout: 30_000 };

let workspaceRoot: string;

beforeEach(async () => {
  calls.length = 0;
  envFiles.length = 0;
  startOk = true;
  cpOutOk = true;
  createFailure = undefined;
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

/** The ONE argv element here that cannot be a literal. See docs/plugins.md §442. */
function normaliseEnvFile(recorded: ExecFileCall[], runId: string): ExecFileCall[] {
  const create = recorded.find((c) => c.args[0] === "create");
  const index = create?.args.indexOf("--env-file") ?? -1;
  if (index === -1) return recorded;
  const path = String(create!.args[index + 1]);
  expect(dirname(path), "the credential file was staged outside the plugin's own state dir").toBe(
    workspaceRoot
  );
  expect(basename(path), `the credential file's name: ${basename(path)}`).toMatch(
    new RegExp(`^scp-secret-env-${runId}-[0-9a-f-]{36}$`)
  );
  return recorded.map((c) => ({ ...c, args: c.args.map((a) => (a === path ? "<ENV-FILE>" : a)) }));
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
        args: [
          "create",
          "--network",
          "none",
          // THE NAME AND THE LABELS (M23.0 defect 1). The name is derived from the idempotency key,
          // so a retry of `k1` addresses the same container; the labels are what makes an orphan
          // findable with `docker ps -a --filter label=scp.executor=scp-managed-iac`.
          "--name",
          "scp-runner-k1",
          "--label",
          "scp.executor=scp-managed-iac",
          "--label",
          "scp.run-id=k1",
          "scp-runner-iac:vetted",
          "plan"
        ],
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
      // TEARDOWN ADDRESSES THE NAME, not the id `create` printed — the only identity that also
      // exists on the path where `create` is the thing that failed.
      { file: "docker", args: ["rm", "-f", "scp-runner-k1"], opts: RM_OPTS }
    ]);
    // No credentials in this context, so no `--env-file` was written at all.
    expect(envFiles).toStrictEqual([]);

    // ...and the run really completed, so none of the above passed by nothing having happened.
    expect((await plugin.status(ctx(), ref)).phase).toBe("succeeded");
  });

  it("EVERY OPTIONAL INPUT PRESENT — custom binary, network, timeout, two creds, and a rollback env", async () => {
    // The maximal shape. See docs/plugins.md §443.
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

    const w = workspaceDir("prod_eu-west-1");
    const opts = runOpts(123_456, 16 * 1024 * 1024);
    expect(
      normaliseEnvFile(calls, "k2"),
      "the managed-iac maximal Docker launch argv changed"
    ).toStrictEqual([
      {
        file: "/usr/local/bin/docker",
        args: [
          "create",
          "--network",
          "bridge",
          "--name",
          "scp-runner-k2",
          "--label",
          "scp.executor=scp-managed-iac",
          "--label",
          "scp.run-id=k2",
          // WHERE THE TWO `-e AWS_*` PAIRS USED TO BE — and before the surviving non-secret `-e`, so
          // an explicit `-e` still wins over an env-file entry of the same name (docker's own
          // precedence rule).
          "--env-file",
          "<ENV-FILE>",
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
      { file: "/usr/local/bin/docker", args: ["rm", "-f", "scp-runner-k2"], opts: RM_OPTS }
    ]);

    // THE CREDENTIALS REALLY REACHED THE RUNNER — the positive half, which "no `-e AWS_*`" alone
    // cannot distinguish from "the plugin stopped passing credentials".
    expect(envFiles, "the resolved credentials did not reach the runner at all").toHaveLength(1);
    expect(envFiles[0]!.content).toBe(
      "AWS_ACCESS_KEY_ID=AKIAEXAMPLE\nAWS_SECRET_ACCESS_KEY=s3cr3t-value\n"
    );
    // Owner-only while it existed, and gone by the time `create` had returned.
    expect(envFiles[0]!.mode, "the credential file was readable by other local users").toBe(0o600);
    expect(existsSync(envFiles[0]!.path), "the credential file outlived its `create`").toBe(false);

    // AND NOT ON ANY COMMAND LINE, ANYWHERE — asserted over every element of every call, so a step
    // other than `create` that started echoing the spec is caught here too.
    for (const call of calls) {
      for (const arg of call.args) {
        expect(arg, `a docker argv carried a credential VALUE: ${arg}`).not.toContain(
          "s3cr3t-value"
        );
        expect(arg, `a docker argv carried a credential VALUE: ${arg}`).not.toContain(
          "AKIAEXAMPLE"
        );
      }
    }

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
        args: [
          "create",
          "--network",
          "none",
          "--name",
          "scp-runner-k3",
          "--label",
          "scp.executor=scp-managed-iac",
          "--label",
          "scp.run-id=k3",
          "scp-runner-iac:vetted",
          "apply"
        ],
        opts: RUN_OPTS
      },
      { file: "docker", args: ["cp", `${w}/.`, "container-abc123:/workspace"], opts: RUN_OPTS },
      { file: "docker", args: ["start", "-a", "container-abc123"], opts: RUN_OPTS },
      { file: "docker", args: ["cp", "container-abc123:/workspace/.", w], opts: RUN_OPTS },
      { file: "docker", args: ["rm", "-f", "scp-runner-k3"], opts: RM_OPTS }
    ]);

    const status = await plugin.status(ctx(), ref);
    expect(status.phase).toBe("failed");
    expect(status.detail).toContain("tofu: boom");
  });

  it("A FAILED COPY-OUT IS SWALLOWED — the run still succeeds and the container is still removed", async () => {
    // The second half of the asymmetry. See docs/plugins.md §444.
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
      args: ["rm", "-f", "scp-runner-k4"],
      opts: RM_OPTS
    });
    expect((await plugin.status(ctx(), ref)).phase).toBe("succeeded");
  });

  it("FAILURE — `create` itself rejects: no cp/start/cp-out at all, only `rm` follows, and the run is recorded FAILED, never left pending (M23.1 phase 2)", async () => {
    // A NEW TEST, not an edit of an existing one. See docs/plugins.md §445.
    createFailure = ordinaryCreateFailure();
    const plugin = createManagedIacExecutorPlugin();
    const ref = await plugin.trigger(ctx(), {
      kind: "sync",
      targetRef: "t1",
      parameters: { iacAction: "plan" },
      idempotencyKey: "k6"
    });

    // No cp-in, no start, no cp-out — `create` is what failed. Teardown STILL runs, unconditionally,
    // BY NAME — the identity that exists even when `create` itself never answered (M23.0 defect 1).
    expect(
      calls.map((c) => c.args[0]),
      "the managed-iac create-failure Docker sequence changed"
    ).toStrictEqual(["create", "rm"]);
    expect(calls.at(-1)).toStrictEqual({
      file: "docker",
      args: ["rm", "-f", "scp-runner-k6"],
      opts: RM_OPTS
    });

    const status = await plugin.status(ctx(), ref);
    expect(status.phase).toBe("failed");
    expect(status.detail).toContain("docker: Error response from daemon: no such image");
  });

  it("FAILURE — a `create` that lost the NAME to another run issues NO `rm`: this run never owned that container (M23.1e)", async () => {
    // The other arm, and why that one's fixture had to change. See docs/plugins.md §446.
    createFailure = nameConflictCreateFailure();
    const plugin = createManagedIacExecutorPlugin();
    const ref = await plugin.trigger(ctx(), {
      kind: "sync",
      targetRef: "t1",
      parameters: { iacAction: "plan" },
      idempotencyKey: "k7"
    });

    expect(
      calls.map((c) => c.args[0]),
      "a create that lost the name must not tear that name down"
    ).toStrictEqual(["create"]);

    // The run still FAILS, and still records its outcome — only the destructive step is skipped.
    const status = await plugin.status(ctx(), ref);
    expect(status.phase).toBe("failed");
    expect(status.detail).toContain("already in use");
  });
});
