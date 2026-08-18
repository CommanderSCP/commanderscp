import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@scp/plugin-api";
import { RUNNER_LAUNCHER_DEADLINE_LABEL, RUNNER_LAUNCHER_OWNER_LABEL } from "@scp/runner-launcher";

/**
 * ================================================================================================
 * M23.0 — THE GOLDEN DOCKER ARGV FOR `scp-managed-iac`, RECORDED BEFORE ANYTHING MOVES
 * ================================================================================================
 *
 * WHY THIS FILE EXISTS, AND WHY M23.1 DID NOT RETIRE IT.
 * M23 extracts a `RunnerLauncher` port so the three managed executors can also launch their runners
 * as Kubernetes Jobs. That refactor's central promise is that **the Docker path is byte-for-byte
 * unchanged**. A promise like that is only checkable if the current bytes were written down FIRST,
 * by a test that existed BEFORE the refactor — otherwise the "unchanged" baseline is whatever the
 * refactor happens to emit, and the assertion is a tautology.
 *
 * THE PARAGRAPH THAT USED TO SIT HERE WAS WRONG, AND THIS ONE REPLACES IT. It said that until
 * M23.1 landed the port this file was the definition of "unchanged", and that when the port landed
 * these tests were "to be **deleted or superseded** by the port's own conformance suite". M23.1 HAS
 * LANDED. It did NOT retire this file, and that standing instruction is withdrawn — because the
 * port's conformance suite (`packages/runner-launcher/src/docker-adapter.test.ts`) and this file
 * prove DIFFERENT things, and neither implies the other:
 *   - THE CONFORMANCE SUITE drives `createDockerRunnerLauncher` DIRECTLY. Its subject is what the
 *     adapter emits FOR A GIVEN `RunnerSpec` — argv, per-call `timeout`/`maxBuffer`, both copy-out
 *     axes, the failure paths. A `RunnerSpec` is its INPUT.
 *   - THIS FILE drives `plugin.trigger()`. Its subject is THE OTHER HALF, which the conformance
 *     suite structurally cannot reach: that this plugin still hands the port THE SAME SPEC it used
 *     to build by hand. A spec field changed here — a `when: "always"` that became `"on-success"`,
 *     or a `maxBuffer` that picked up a neighbour's 32 MiB — produces a perfectly CONFORMANT
 *     launch of the WRONG container, and the conformance suite is blind to it, because that spec
 *     is what it is handed rather than what it checks.
 * Deleting this file on the strength of the old sentence would take the plugin→port boundary to
 * ZERO coverage while every task stayed green — the vacuous-green class BUILD_AND_TEST.md §4.4
 * names, and the same reason `@scp/runner-launcher` no longer runs with `--passWithNoTests`.
 * RETIRE THIS FILE ONLY ALONGSIDE SOMETHING THAT COVERS THAT BOUNDARY, never merely alongside
 * something that covers the adapter.
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

/**
 * WHAT THE TRANSIENT `--env-file` HELD WHILE `create` WAS IN FLIGHT, read by the seam because that
 * is the only moment it can be read — the adapter unlinks it as soon as `create` returns.
 *
 * WITHOUT THIS THE GOLDEN WOULD BE SATISFIED BY A PLUGIN THAT STOPPED PASSING CREDENTIALS AT ALL.
 * "No `-e AWS_*` on the command line" is exactly what a plugin that dropped `infraCredsSecretKeys`
 * on the floor also produces, and every assertion here would go green while `tofu apply` silently
 * lost its provider auth. The positive half — these two values, in this order, actually reached the
 * runner — has to be measured somewhere, and this is the only place standing at the right moment.
 */
const envFiles: { path: string; content: string; mode: number }[] = [];

/** `start` outcome — the failure arm is a rejection carrying stdout/stderr, as `execFile` does. */
let startOk = true;
/** Copy-OUT outcome. Only managed-iac swallows a failure here; that is what test 4 measures. */
let cpOutOk = true;
/** `create` outcome — the two tests below are the ONLY failure-injection arms for this step; every
 *  other test in this file leaves it `true`.
 *
 *  IT IS AN ERROR OBJECT AND NOT A BOOLEAN SINCE M23.1e, and the change is the point. The fixture
 *  used to reject with `name already in use` — a NAME CONFLICT — while asserting that the run then
 *  tears the name down, which is the one create failure for which tearing down is WRONG: by
 *  definition of the conflict, the container behind that name belongs to somebody else and is
 *  still running. Reachable here for two concurrent triggers of one `idempotencyKey`, whose
 *  container names are equal by design. The default is therefore an ORDINARY create failure, and
 *  the conflict is its own arm with the opposite expectation. */
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

/**
 * M23.1 PHASE 4 — the reaper. `reap()` now runs at the top of every `run()`, issuing a `docker ps -a
 * --filter label=...` before `create` and stamping two more `--label` pairs onto every `create` it
 * issues. Neither is this file's subject (its own dedicated coverage is
 * `@scp/runner-launcher`'s `docker-adapter.test.ts` and `reaper.integration.test.ts`), so both are
 * kept out of the golden entirely: the `ps` call is answered with an empty listing and never
 * recorded, and the two labels are stripped off `create`'s argv before it reaches `calls` — the same
 * "divert what this file isn't about" technique already used for the transient `--env-file` path.
 */
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

/**
 * ================================================================================================
 * THE OPTIONS — `maxBuffer` AS A LITERAL, `timeout` AS THE BOUND IT MUST NOW LIE IN (M23.1e)
 * ================================================================================================
 * Deliberately NOT imported from `index.ts`: a golden that re-derives its expectation from the code
 * it is guarding cannot detect a change to that code. 16 MiB is written here because that is what the plugin does TODAY.
 *
 * WHY `timeout` STOPPED BEING AN EQUALITY. `RunnerSpec.timeoutMs` is the WHOLE-RUN budget since
 * M23.1e, so each step is issued with what is LEFT of it (`deadline - now`, off one clock read at
 * the top of `run()`). Handing every step the full `timeoutMs` was the defect this golden used to
 * pin: four sequential calls, each individually under the bound, made a run of four x
 * timeoutMs, which the host's own budget — sized `timeoutMs + grace` — then SIGKILLed, orphaning
 * the container and leaving the idempotency ledger unwritten.
 *
 * So the assertion is the PROPERTY: never ABOVE the caller's budget (that is the old behaviour
 * back), and never more than {@link BUDGET_SLACK_MS} below it in this seam, where every step
 * settles on the next tick — which is what stops a degenerate "always 1ms" from passing. The strict
 * decrease across a run and the refusal once nothing is left are proven where they can be measured:
 * `@scp/runner-launcher`'s `whole-run-budget.test.ts`.
 *
 * `toStrictEqual` KEEPS ITS TEETH — the matcher stands in for the `timeout` VALUE only, so the
 * ABSENCE of `maxBuffer` on `rm` and of every other key everywhere is still pinned exactly.
 */
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

/**
 * The ONE argv element here that cannot be a literal: the transient `--env-file` carries a fresh
 * UUID per run. Its SHAPE is asserted — inside the plugin's own state dir (`dirname(statePath)`,
 * which is `workspaceRoot` for these contexts), named for the run — and only then is it substituted,
 * so every other byte of the argv stays a literal. Same technique, and the same reason, as
 * `@scp/plugin-managed-dep`'s `normalise()` for its per-run `mkdtemp`.
 */
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
    // The maximal shape: a server-injected `dockerBinary` and `networkMode`, a tenant `timeoutMs`,
    // two resolved infra credentials, and the `PRIOR_STATE_FILE` a rollback appends.
    //
    // THE TWO `-e AWS_*` PAIRS THIS GOLDEN USED TO RECORD ARE GONE, AND THAT IS THE POINT. M23.0
    // recorded them as defect 3: resolved credentials on the `create` argv, readable from the host
    // process table by any local process, and — worse, because it crosses a machine boundary —
    // reproduced verbatim in `err.message` when `create` fails, which `subprocess-entry.ts` ships
    // across the plugin-host RPC boundary into a server log. They now travel as `secretEnv`, which
    // the Docker adapter delivers through a mode-0600 `--env-file` unlinked the instant `create`
    // returns.
    //
    // `PRIOR_STATE_FILE` STAYS ON THE COMMAND LINE, and the difference is the whole design: it is a
    // path inside the container, not a secret. The split is along the SECRECY axis because that is
    // the axis the Kubernetes adapter must branch on (Secret + `envFrom` vs `env[].value`) — not a
    // reflex to hide every environment variable.
    //
    // WHAT IS STILL PINNED: the env-file's CONTENTS and their ORDER (the config's own key order),
    // asserted below from a snapshot the seam takes while `create` is in flight. Without that, this
    // test would be equally green for a plugin that stopped resolving credentials altogether.
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
      args: ["rm", "-f", "scp-runner-k4"],
      opts: RM_OPTS
    });
    expect((await plugin.status(ctx(), ref)).phase).toBe("succeeded");
  });

  it("FAILURE — `create` itself rejects: no cp/start/cp-out at all, only `rm` follows, and the run is recorded FAILED, never left pending (M23.1 phase 2)", async () => {
    // A NEW TEST, not an edit of an existing one — none of the four cases above inject a `create`
    // failure, only a `start` failure, so there is no existing golden line for this arm to move.
    //
    // BEFORE M23.1 PHASE 2, this would have been unobservable through `status()` at all: `create`
    // rejecting propagated straight out of `trigger()` as a rejection (managed-iac's `trigger()` had
    // no outer catch), nothing was ever written to the dedup cache, and `status()` reported
    // "pending" forever — indistinguishable from "still running". `trigger()` now RESOLVES and the
    // failure is recorded via `withRecordedOutcome`.
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
    // THE OTHER ARM OF THE TEST ABOVE, AND THE REASON THAT ONE'S FIXTURE HAD TO CHANGE. Teardown is
    // unconditional and addresses the NAME, so for the one create failure that MEANS the name is
    // somebody else's, the teardown destroys a container this run did not create and is not
    // supervising. For managed-iac that is two concurrent triggers of a single `idempotencyKey` —
    // `toRunnerRunId(intent.idempotencyKey)` makes their container names equal ON PURPOSE, because
    // retry-stable naming is what makes a retry address the same container instead of starting a
    // second `tofu apply`. The name is the feature; the unconditional teardown was the bug.
    //
    // BOTH ARMS OR NOTHING: without the test above, "skip teardown on any create failure" passes
    // here and re-opens M23.0 defect 1 (a `create` that timed out leaves a committed container with
    // nothing addressing it). Without this one, the old unconditional teardown passes there.
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
