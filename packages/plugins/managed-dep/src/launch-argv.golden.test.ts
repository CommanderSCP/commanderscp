import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BUMP_SPEC,
  DECLARED_MANIFEST_PATHS,
  PACKAGE_JSON_BUMPED,
  VALUES_BUMP_SPEC,
  VALUES_YAML_BASE,
  VALUES_YAML_PATH,
  githubHandler,
  recordingCtx
} from "./write-test-support.js";
import { RUNNER_LAUNCHER_DEADLINE_LABEL, RUNNER_LAUNCHER_OWNER_LABEL } from "@scp/runner-launcher";

/**
 * ================================================================================================
 * M23.0 — THE GOLDEN DOCKER ARGV FOR `scp-managed-dep`, RECORDED BEFORE ANYTHING MOVES
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
 *     to build by hand. A spec field changed here — `networkMode` switched from this plugin's
 *     charter literal `"none"` to a read of `config.networkMode` — produces a perfectly
 *     CONFORMANT launch of the WRONG container, and the conformance suite is blind to it, because
 *     that spec is what it is handed rather than what it checks.
 * Deleting this file on the strength of the old sentence would take the plugin→port boundary to
 * ZERO coverage while every task stayed green — the vacuous-green class BUILD_AND_TEST.md §4.4
 * names, and the same reason `@scp/runner-launcher` no longer runs with `--passWithNoTests`.
 * RETIRE THIS FILE ONLY ALONGSIDE SOMETHING THAT COVERS THAT BOUNDARY, never merely alongside
 * something that covers the adapter.
 *
 * HOW THIS DIFFERS FROM `runner-containment.test.ts`, WHICH IT SITS BESIDE.
 * That file asserts a CHARTER PROPERTY — no network, no credential, no host — and is meant to
 * survive forever, in whatever launcher the plugin grows. It says "the argv contains no `-e`". This
 * file says "the argv is exactly THESE strings in THIS order, with THESE options", which is a much
 * stronger and much more perishable claim. They use the same recording seam and are deliberately
 * separate — but "perishable" means it must be CONSCIOUSLY re-recorded when the launch
 * legitimately changes, NOT that M23 consumes it. M23.1 came and went and both are still here.
 *
 * WHAT IS PINNED, AND WHY EACH PART IS PART OF THE PROMISE.
 *  1. THE FULL argv ARRAY of every `execFile`, in order — `create`, `cp` in, `start`, `cp` out,
 *     `rm` — including BOTH operand shapes: the **5-operand** contiguous form and the **7-operand**
 *     anchored form M21.7 added for split declarations.
 *  2. THE OPTIONS OBJECT alongside each argv. managed-dep runs **5 min / 8 MiB** — the shortest and
 *     smallest of the three (managed-iac 10 min / 16 MiB, managed-scan 10 min / 32 MiB), because
 *     this runner edits one manifest and prints nothing. `rm` alone carries a 30 s timeout AND NO
 *     `maxBuffer` AT ALL. `toStrictEqual` is what makes those absences part of the record rather
 *     than merely untested — a port that unified the three into one shared default would be a
 *     behaviour change wearing a refactor's clothes.
 *  3. THE NETWORK MODE IS A LITERAL, NOT A CONFIG READ, in this plugin alone (the 2026-08-15 charter
 *     amendment carries no operator qualifier, unlike managed-scan's). A context naming another mode
 *     must still produce `--network none`, and a port that plumbs `config.networkMode` through
 *     uniformly for all three must fail here.
 *  4. THE FAILURE PATH: on a rejected `start` there is **no copy-out at all** — like managed-scan,
 *     unlike managed-iac, which copies out unconditionally. This plugin's copy-out is also not
 *     catch-guarded, but its `trigger()` has an outer `try/catch`, so a failed copy-out lands as a
 *     FAILED run rather than a rejection (managed-scan's escapes `trigger()`; managed-iac's is
 *     swallowed entirely). Three call sites, three different answers — all three are measured.
 *
 * THE RECORDING SEAM is the one this package already uses in `runner-containment.test.ts` —
 * `vi.mock("node:child_process")` with a hand-written `execFile` and a stand-in runner that writes
 * real edited bytes on the copy-out, so the run reaches a real `succeeded` and no assertion above
 * can pass by nothing having happened. The only widening is that the options object (which that
 * file discards as `_opts`) is now recorded too, because point 2 is half the promise. No Docker is
 * required, so these run on every PR under `pnpm test`.
 */

interface ExecFileCall {
  file: string;
  args: string[];
  opts: unknown;
}

/** Every `execFile` of the run, in the order the plugin issued them. */
const calls: ExecFileCall[] = [];

/** The bytes the stand-in runner "produces" — written by the copy-OUT mock into `outDir`. */
let producedOutput: string = PACKAGE_JSON_BUMPED;
let startOk = true;
/** Copy-OUT outcome. managed-dep does NOT guard it; the last test measures where the failure lands. */
let cpOutOk = true;

/**
 * M23.1 PHASE 4 — the reaper. `reap()` now runs at the top of every `run()`, issuing a `docker ps -a
 * --filter label=...` before `create` and stamping two more `--label` pairs onto every `create` it
 * issues. Neither is this file's subject (its own dedicated coverage is `@scp/runner-launcher`'s
 * `docker-adapter.test.ts` and `reaper.integration.test.ts`), so both are kept out of the golden
 * entirely: the `ps` call is answered with an empty listing and never recorded, and the two labels
 * are stripped off `create`'s argv before it reaches `calls`.
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
      const sub = args[0];
      if (sub === "create") {
        cb(null, { stdout: "dep-container-abc\n", stderr: "" });
        return;
      }
      if (sub === "start") {
        if (startOk) {
          cb(null, { stdout: "", stderr: "" });
        } else {
          cb(
            Object.assign(new Error("container exited non-zero"), {
              stdout: "",
              stderr: "scp-runner-dep: boom"
            })
          );
        }
        return;
      }
      if (sub === "cp" && String(args[1]).includes(":/work/out")) {
        if (!cpOutOk) {
          cb(new Error("docker cp: no such file or directory"));
          return;
        }
        // The stand-in RUNNER's product. Writing real bytes here is what lets the orchestrator's
        // verifiers run and the run reach `succeeded`, so the argv goldens below cannot be green
        // because the launch never got past `create`.
        void writeFile(join(String(args[2]), "manifest"), producedOutput, "utf8").then(
          () => cb(null, { stdout: "", stderr: "" }),
          (err: Error) => cb(err)
        );
        return;
      }
      cb(null, { stdout: "", stderr: "" }); // cp in / rm
    }
  };
});

const { createManagedDepExecutorPlugin, __resetManagedDepOutcomes } = await import("./index.js");

/**
 * THE OPTIONS, AS LITERALS. Deliberately NOT imported from `index.ts`: a golden that re-derives its
 * expectation from the code it is guarding cannot detect a change to that code. 5 minutes and 8 MiB
 * are written here because that is what the plugin does TODAY.
 */
const RUN_OPTS = { timeout: 5 * 60_000, maxBuffer: 8 * 1024 * 1024 };
/** The teardown call's own options — a shorter timeout and, notably, NO `maxBuffer`. */
const RM_OPTS = { timeout: 30_000 };

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const privateKeyPem = privateKey.export({ type: "pkcs1", format: "pem" }).toString();

let workspaceRoot: string;

beforeEach(async () => {
  calls.length = 0;
  startOk = true;
  cpOutOk = true;
  producedOutput = PACKAGE_JSON_BUMPED;
  __resetManagedDepOutcomes();
  workspaceRoot = await mkdtemp(join(tmpdir(), "managed-dep-golden-"));
});

afterEach(async () => {
  await rm(workspaceRoot, { recursive: true, force: true });
});

function depCtx(configOverrides: Record<string, unknown> = {}, base?: string) {
  const { ctx, calls: httpCalls } = recordingCtx(githubHandler({}, {}, base));
  return {
    httpCalls,
    ctx: {
      ...ctx,
      config: {
        runnerImage: "scp-runner-dep:vetted",
        workspaceRoot,
        appId: "12345",
        installationId: "67890",
        privateKeyPem,
        ...configOverrides
      }
    }
  };
}

/**
 * THE KEYS ARE FIXED NOW, AND THEY HAVE TO BE. They used to be `golden-npm-${Math.random()}` — free,
 * because nothing on the command line depended on them. Since the run's `--name` is derived from the
 * idempotency key, a random key would put a random string in the argv this file exists to record
 * literally. `__resetManagedDepOutcomes()` in `beforeEach` is what makes fixed keys safe: the outcome
 * cache that dedup reads is cleared between cases, so a repeated key is a fresh run.
 */
function npmIntent(key: string, overrides: Record<string, unknown> = {}) {
  return {
    kind: "custom" as const,
    idempotencyKey: key,
    parameters: {
      ecosystem: BUMP_SPEC.ecosystem,
      coordinate: BUMP_SPEC.coordinate,
      manifestPath: BUMP_SPEC.manifestPath,
      declaredManifestPaths: DECLARED_MANIFEST_PATHS,
      fromVersion: BUMP_SPEC.fromVersion,
      toVersion: BUMP_SPEC.toVersion,
      repo: "acme/widget",
      baseBranch: "main",
      changeObjectId: "0198f3c1-1111-7000-8000-000000000001",
      delivery: "pull_request",
      ...overrides
    }
  };
}

function valuesIntent(key: string) {
  return {
    kind: "custom" as const,
    idempotencyKey: key,
    parameters: {
      ecosystem: VALUES_BUMP_SPEC.ecosystem,
      coordinate: VALUES_BUMP_SPEC.coordinate,
      manifestPath: VALUES_YAML_PATH,
      declaredManifestPaths: [VALUES_YAML_PATH],
      fromVersion: VALUES_BUMP_SPEC.fromVersion,
      toVersion: VALUES_BUMP_SPEC.toVersion,
      repo: "acme/widget",
      baseBranch: "main",
      changeObjectId: "0198f3c1-1111-7000-8000-000000000002",
      delivery: "pull_request"
    }
  };
}

/**
 * The two host paths on this plugin's command line are a PER-RUN `mkdtemp` under the server-given
 * `workspaceRoot`, so they cannot be written as literals the way managed-iac's derived workspace or
 * managed-scan's server-supplied dirs can. Their SHAPE is asserted here — a `scp-dep-*` run
 * directory immediately under `workspaceRoot`, with `in`/`out` inside it — and only then are they
 * substituted, so every other byte of the argv stays a literal in the goldens below.
 */
function normalise(recorded: ExecFileCall[]): ExecFileCall[] {
  const cpIn = recorded.find((c) => c.args[0] === "cp" && String(c.args[2]).endsWith(":/work/in"));
  expect(cpIn, "no copy-IN was recorded; the run never reached the runner").toBeDefined();
  const inDir = String(cpIn!.args[1]).replace(/\/\.$/, "");
  const runDir = dirname(inDir);
  expect(basename(inDir), "the copy-IN source is the run directory's `in`").toBe("in");
  expect(dirname(runDir), "the run directory is a mkdtemp directly under workspaceRoot").toBe(
    workspaceRoot
  );
  expect(basename(runDir), `the run directory's mkdtemp prefix: ${basename(runDir)}`).toMatch(
    /^scp-dep-/
  );
  const outDir = join(runDir, "out");
  return recorded.map((c) => ({
    ...c,
    args: c.args.map((a) => a.split(inDir).join("<IN>").split(outDir).join("<OUT>"))
  }));
}

describe("M23.0 golden: the `scp-managed-dep` runner launch, byte for byte", () => {
  it("DEFAULT — the FIVE-operand contiguous form: create / cp in / start / cp out / rm", async () => {
    // A contiguous npm bump: the coordinate rule finds its own line, no anchor is derived, and the
    // command line is the five descriptor strings every previously-shipped image understands.
    const plugin = createManagedDepExecutorPlugin();
    const { ctx } = depCtx();
    const ref = await plugin.trigger(ctx, npmIntent("g1"));

    expect(normalise(calls), "the managed-dep Docker launch argv changed").toStrictEqual([
      {
        file: "docker",
        args: [
          "create",
          "--network",
          "none",
          "--name",
          "scp-runner-g1",
          "--label",
          "scp.executor=scp-managed-dep",
          "--label",
          "scp.run-id=g1",

          "scp-runner-dep:vetted",
          "npm",
          "package.json",
          "@acme/lib",
          "^1.2.3",
          "^1.4.0"
        ],
        opts: RUN_OPTS
      },
      { file: "docker", args: ["cp", "<IN>/.", "dep-container-abc:/work/in"], opts: RUN_OPTS },
      { file: "docker", args: ["start", "-a", "dep-container-abc"], opts: RUN_OPTS },
      { file: "docker", args: ["cp", "dep-container-abc:/work/out/.", "<OUT>"], opts: RUN_OPTS },
      { file: "docker", args: ["rm", "-f", "scp-runner-g1"], opts: RM_OPTS }
    ]);

    // ...and the run really completed, so none of the above passed by nothing having happened.
    expect((await plugin.status(ctx, ref)).phase).toBe("succeeded");
  });

  it("THE SEVEN-OPERAND ANCHORED FORM — a split-shape values.yaml appends line and line text", async () => {
    // M21.7. `tag: 1.2.3` is on line 6 of the fixture, and the anchor's second operand is that
    // line's own bytes INCLUDING its leading indentation. Both are on the command line as plain
    // operands after the five — never as a mount, an env var or a file body.
    producedOutput = VALUES_YAML_BASE.replace("    tag: 1.2.3", "    tag: 1.2.4");
    const plugin = createManagedDepExecutorPlugin();
    const { ctx } = depCtx({}, VALUES_YAML_BASE);
    const ref = await plugin.trigger(ctx, valuesIntent("g2"));

    expect(normalise(calls), "the managed-dep anchored Docker launch argv changed").toStrictEqual([
      {
        file: "docker",
        args: [
          "create",
          "--network",
          "none",
          "--name",
          "scp-runner-g2",
          "--label",
          "scp.executor=scp-managed-dep",
          "--label",
          "scp.run-id=g2",

          "scp-runner-dep:vetted",
          "oci",
          "chart/values.yaml",
          "acme/api",
          "1.2.3",
          "1.2.4",
          "6",
          "    tag: 1.2.3"
        ],
        opts: RUN_OPTS
      },
      { file: "docker", args: ["cp", "<IN>/.", "dep-container-abc:/work/in"], opts: RUN_OPTS },
      { file: "docker", args: ["start", "-a", "dep-container-abc"], opts: RUN_OPTS },
      { file: "docker", args: ["cp", "dep-container-abc:/work/out/.", "<OUT>"], opts: RUN_OPTS },
      { file: "docker", args: ["rm", "-f", "scp-runner-g2"], opts: RM_OPTS }
    ]);

    expect((await plugin.status(ctx, ref)).phase).toBe("succeeded");
  });

  it("EVERY OPTIONAL INPUT PRESENT — custom binary and timeout, anchored form, and `--network none` STILL a literal", async () => {
    // The maximal shape this plugin has. Note what is NOT here: no `-e`, no `-v`, no image-pull
    // flag, and no way for `config.networkMode` to reach the command line — the context below names
    // `bridge-for-test` and the argv still says `none` (RUNNER_NETWORK_MODE, charter 2026-08-15).
    producedOutput = VALUES_YAML_BASE.replace("    tag: 1.2.3", "    tag: 1.2.4");
    const plugin = createManagedDepExecutorPlugin();
    const { ctx } = depCtx(
      {
        dockerBinary: "/usr/local/bin/docker",
        timeoutMs: 123_456,
        networkMode: "bridge-for-test"
      },
      VALUES_YAML_BASE
    );
    const ref = await plugin.trigger(ctx, valuesIntent("g3"));

    const opts = { timeout: 123_456, maxBuffer: 8 * 1024 * 1024 };
    expect(normalise(calls), "the managed-dep maximal Docker launch argv changed").toStrictEqual([
      {
        file: "/usr/local/bin/docker",
        args: [
          "create",
          "--network",
          "none",
          "--name",
          "scp-runner-g3",
          "--label",
          "scp.executor=scp-managed-dep",
          "--label",
          "scp.run-id=g3",

          "scp-runner-dep:vetted",
          "oci",
          "chart/values.yaml",
          "acme/api",
          "1.2.3",
          "1.2.4",
          "6",
          "    tag: 1.2.3"
        ],
        opts
      },
      { file: "/usr/local/bin/docker", args: ["cp", "<IN>/.", "dep-container-abc:/work/in"], opts },
      { file: "/usr/local/bin/docker", args: ["start", "-a", "dep-container-abc"], opts },
      {
        file: "/usr/local/bin/docker",
        args: ["cp", "dep-container-abc:/work/out/.", "<OUT>"],
        opts
      },
      // THE TEARDOWN TIMEOUT IS NOT THE RUN TIMEOUT. A `timeoutMs` of 123456 does not reach `rm`,
      // which keeps its own literal 30 s and still carries no `maxBuffer`.
      { file: "/usr/local/bin/docker", args: ["rm", "-f", "scp-runner-g3"], opts: RM_OPTS }
    ]);

    expect((await plugin.status(ctx, ref)).phase).toBe("succeeded");
  });

  it("FAILURE — `start` rejects, and NO edited manifest is copied out; only `rm` follows", async () => {
    // THE ASYMMETRY, MEASURED. managed-iac copies its workspace out even after a failed `start`;
    // managed-dep does not, because there is nothing to salvage from a runner that did not finish
    // the edit — and copying out a partial manifest would put unverified bytes where the verifiers
    // read from. A refactor that gives all three launchers one shared sequence must break either
    // this test or managed-iac's mirror of it.
    startOk = false;
    const plugin = createManagedDepExecutorPlugin();
    const { ctx, httpCalls } = depCtx();
    const ref = await plugin.trigger(ctx, npmIntent("g4"));

    expect(normalise(calls), "the managed-dep FAILED-run Docker sequence changed").toStrictEqual([
      {
        file: "docker",
        args: [
          "create",
          "--network",
          "none",
          "--name",
          "scp-runner-g4",
          "--label",
          "scp.executor=scp-managed-dep",
          "--label",
          "scp.run-id=g4",

          "scp-runner-dep:vetted",
          "npm",
          "package.json",
          "@acme/lib",
          "^1.2.3",
          "^1.4.0"
        ],
        opts: RUN_OPTS
      },
      { file: "docker", args: ["cp", "<IN>/.", "dep-container-abc:/work/in"], opts: RUN_OPTS },
      { file: "docker", args: ["start", "-a", "dep-container-abc"], opts: RUN_OPTS },
      { file: "docker", args: ["rm", "-f", "scp-runner-g4"], opts: RM_OPTS }
    ]);

    const status = await plugin.status(ctx, ref);
    expect(status.phase).toBe("failed");
    expect(status.detail).toContain("scp-runner-dep: boom");
    // Nothing was written to the repository, and the run credential was still revoked.
    expect(httpCalls.some((c) => c.method === "PUT" && c.url.includes("/contents/"))).toBe(false);
    expect(
      httpCalls.some((c) => c.method === "DELETE" && c.url.endsWith("/installation/token"))
    ).toBe(true);
  });

  it("A FAILED COPY-OUT LANDS AS A FAILED RUN — not swallowed, not a rejection; `rm` still runs", async () => {
    // The third of three answers to the same Docker failure. managed-iac's copy-out is
    // `.catch(() => undefined)`, so the run stays succeeded. managed-scan's is unguarded and its
    // `trigger()` has no outer catch, so the error escapes `trigger()`. managed-dep's is unguarded
    // too, but `trigger()` wraps everything, so the error becomes a failed outcome. Recorded as
    // behaviour, without judgement — but it must not change silently while the refactor is called
    // byte-for-byte identical.
    cpOutOk = false;
    const plugin = createManagedDepExecutorPlugin();
    const { ctx } = depCtx();
    const ref = await plugin.trigger(ctx, npmIntent("g5"));

    expect(calls.map((c) => c.args[0])).toStrictEqual(["create", "cp", "start", "cp", "rm"]);
    expect(calls.at(-1)).toStrictEqual({
      file: "docker",
      // BY NAME, not by the id `create` printed — the only identity that also exists on the path
      // where `create` itself is what failed (M23.0 defect 1).
      args: ["rm", "-f", "scp-runner-g5"],
      opts: RM_OPTS
    });
    const status = await plugin.status(ctx, ref);
    expect(status.phase).toBe("failed");
    expect(status.detail).toContain("docker cp");
  });
});
