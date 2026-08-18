import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RunnerSpec } from "./index.js";
import {
  runLaunchOrderingConformanceSuite,
  type LaunchOrderingSubstrate,
  type RunnerStepKind
} from "./ordering-conformance.js";

/**
 * ================================================================================================
 * M23.1 — THE DOCKER ADAPTER'S OWN CONFORMANCE SUITE
 * ================================================================================================
 *
 * WHY THIS FILE EXISTS. `packages/runner-launcher` is, since M23.1, THE ONLY PLACE IN THE PRODUCT
 * THAT SPAWNS A PROCESS. Before this file it had **no tests of its own**: every byte of its
 * behaviour was borrowed from the three plugins' `launch-argv.golden.test.ts`, and its
 * `package.json` said `vitest run --passWithNoTests`, so `turbo run test
 * --filter=@scp/runner-launcher --force` printed "No test files found" and reported SUCCESS. Those
 * two facts together were a primed time bomb: the goldens still carried M23.0's own instruction
 * that they be "deleted or superseded by the port's own conformance suite" once the port landed, so
 * a later increment could follow that instruction to the letter and take coverage of the only
 * process-spawning code in the product to zero **in one commit, with every task still green**. That
 * is exactly the vacuous-green class BUILD_AND_TEST.md §4.4 and CLAUDE.md name. This file is the
 * conformance suite that sentence promised; `--passWithNoTests` is gone from this package in the
 * same change, so an empty package now FAILS instead of reporting success.
 *
 * WHAT IT PROVES, AND WHAT IT DELIBERATELY DOES NOT.
 * It drives {@link createDockerRunnerLauncher} **directly**, over the same spec shapes the fourteen
 * plugin goldens cover, and asserts the **recorded argv ARRAY** of every `execFile` — never a call
 * count, never `expect.arrayContaining`. A renamed binary, a reordered flag, a dropped operand or a
 * `cp` that lost its trailing `/.` must fail here, and must fail by printing the actual argv next to
 * the expected one.
 *
 * It does NOT prove that any plugin still hands this adapter the right `RunnerSpec` — a spec is this
 * suite's INPUT, not its subject, so a plugin that silently started passing `when: "on-success"`
 * where it used to pass `"always"` would produce a perfectly conformant launch of the wrong shape
 * and nothing here would notice. That other half is the three goldens' job, which is why M23.1 did
 * not retire them and why their headers now say so.
 *
 * WHAT IS PINNED:
 *  1. THE FULL FIVE-STEP argv — `create` (with `--network`, each `-e` pair, the image, the
 *     operands), each `cp` IN in the caller's order, `start -a`, the `cp` OUT, and `rm -f`.
 *  2. THE OPTIONS OBJECT alongside each argv, asserted with `toStrictEqual` so that the ABSENCE of
 *     `maxBuffer` on `rm` — and the absence of any `cwd`/`env` anywhere — is part of the record
 *     rather than merely untested. The three callers' pairs (10 min/16 MiB, 10 min/32 MiB,
 *     5 min/8 MiB) are driven as data: a port that collapsed them into one shared default would be
 *     a behaviour change wearing a refactor's clothes, and this is where that is caught.
 *  3. BOTH AXES OF THE COPY-OUT, independently: `when` (`always` vs `on-success`) and `onFailure`
 *     (`swallow` vs `propagate`). All four combinations the three callers span are exercised.
 *  4. THE FAILURE PATHS — a rejected `start` (captured, not rethrown), a rejected `cp` in, a
 *     rejected `rm` (swallowed), and the RECORDED PRE-EXISTING DEFECT that a rejected `create`
 *     issues no `rm` at all because its `await` sits outside the `try`.
 *
 * THE RECORDING SEAM is the one the three goldens use — `vi.mock("node:child_process")` with a
 * hand-written `execFile`. No Docker is required, so this runs on every PR under `pnpm test`.
 */

interface ExecFileCall {
  file: string;
  args: string[];
  opts: unknown;
}

/** Every `execFile` of the run, in the order the adapter issued them. */
const calls: ExecFileCall[] = [];

/** What `docker create` prints. Deliberately padded — the adapter must `.trim()` it. */
let createStdout = "  container-abc123 \n";
/** Per-step outcomes. Each arm below is a named test; none of them is a default. */
let createOk = true;
let cpInOk = true;
let startOk = true;
let cpOutOk = true;
let rmOk = true;
/** The `start` rejection's payload. The `undefined` arms exercise the `?? ""` / `?? message` falls. */
let startFailure: { stdout?: string; stderr?: string } = {
  stdout: "partial output",
  stderr: "runner: boom"
};

/**
 * A copy-OUT is distinguishable from a copy-IN without knowing the container id: the copy-IN's
 * DESTINATION is `<id>:<path>` and the copy-OUT's destination is a bare host directory. Every host
 * path in this file is colon-free, so this stays unambiguous.
 */
function isCopyOut(args: string[]): boolean {
  return args[0] === "cp" && !String(args[2]).includes(":");
}

/**
 * WHICH LIFECYCLE STEP AN argv IS. The ordering suite speaks in the port's five steps; this is the
 * only place that translates them into Docker subcommands.
 */
function stepKind(args: string[]): RunnerStepKind {
  const sub = args[0];
  if (sub === "create") return "create";
  if (sub === "start") return "start";
  if (sub === "rm") return "teardown";
  if (sub === "cp") return isCopyOut(args) ? "copy-out" : "copy-in";
  throw new Error(`docker-adapter.test: unclassifiable docker subcommand '${String(sub)}'`);
}

/** How many of the NEXT occurrences of each step are to be held open (issued, never settling). */
const holds: Record<RunnerStepKind, number> = {
  create: 0,
  "copy-in": 0,
  start: 0,
  "copy-out": 0,
  teardown: 0
};
/** The steps currently held open, oldest first, each with the callback that will settle it. */
const heldOpen: { kind: RunnerStepKind; deliver: (failure?: Error) => void }[] = [];

vi.mock("node:child_process", () => {
  /** The outcome this step would have had, decided by the flags AT DELIVERY TIME. */
  function outcome(
    args: string[],
    cb: (err: Error | null, result?: { stdout: string; stderr: string }) => void
  ): void {
    const sub = args[0];
    if (sub === "create") {
      if (!createOk) {
        cb(new Error("docker create: no such image"));
        return;
      }
      cb(null, { stdout: createStdout, stderr: "" });
      return;
    }
    if (sub === "start") {
      if (startOk) {
        cb(null, { stdout: "runner ok", stderr: "runner warned" });
        return;
      }
      const err = new Error("container exited non-zero");
      if (startFailure.stdout !== undefined) Object.assign(err, { stdout: startFailure.stdout });
      if (startFailure.stderr !== undefined) Object.assign(err, { stderr: startFailure.stderr });
      cb(err);
      return;
    }
    if (sub === "rm") {
      if (!rmOk) {
        cb(new Error("docker rm: no such container"));
        return;
      }
      cb(null, { stdout: "", stderr: "" });
      return;
    }
    if (isCopyOut(args)) {
      if (!cpOutOk) {
        cb(new Error("docker cp: no such file or directory"));
        return;
      }
      cb(null, { stdout: "", stderr: "" });
      return;
    }
    if (!cpInOk) {
      cb(new Error("docker cp: cannot read host directory"));
      return;
    }
    cb(null, { stdout: "", stderr: "" });
  }

  return {
    execFile: (
      file: string,
      args: string[],
      opts: unknown,
      cb: (err: Error | null, result?: { stdout: string; stderr: string }) => void
    ) => {
      calls.push({ file, args, opts });
      const kind = stepKind(args);
      const deliver = (failure?: Error): void => {
        if (failure) {
          cb(failure);
          return;
        }
        outcome(args, cb);
      };
      // HELD: issued and recorded, but it will not settle until `release()` says so. This is the
      // only thing that makes an un-awaited step distinguishable from an awaited one.
      if (holds[kind] > 0) {
        holds[kind] -= 1;
        heldOpen.push({ kind, deliver });
        return;
      }
      // NEVER SYNCHRONOUSLY, even unheld. A real `execFile` callback lands on a later turn of the
      // loop; a seam that resolved inline made every step complete before the adapter's next line
      // ran, which is precisely how the two dropped awaits above survived twenty green tests.
      setImmediate(() => deliver());
    }
  };
});

const {
  DEFAULT_DOCKER_BINARY,
  RUNNER_REMOVE_TIMEOUT_MS,
  createDockerRunnerLauncher,
  resolveDockerRunnerLauncher
} = await import("./index.js");

/**
 * THE OPTIONS, AS LITERALS. Deliberately NOT imported from `index.ts` — an expectation re-derived
 * from the code it guards cannot detect a change to that code. These three pairs are what the three
 * callers pass TODAY (managed-iac / managed-scan / managed-dep).
 */
const IAC_OPTS = { timeout: 10 * 60_000, maxBuffer: 16 * 1024 * 1024 };
const SCAN_OPTS = { timeout: 10 * 60_000, maxBuffer: 32 * 1024 * 1024 };
const DEP_OPTS = { timeout: 5 * 60_000, maxBuffer: 8 * 1024 * 1024 };
/** The teardown call's own options — a shorter timeout and, notably, NO `maxBuffer`. */
const RM_OPTS = { timeout: 30_000 };

/** A minimal, entirely explicit spec. Every test below overrides only what it is about. */
function spec(overrides: Partial<RunnerSpec> = {}): RunnerSpec {
  return {
    image: "scp-runner-iac:vetted",
    operands: [],
    networkMode: "none",
    env: [],
    copyIn: [],
    timeoutMs: IAC_OPTS.timeout,
    maxBuffer: IAC_OPTS.maxBuffer,
    ...overrides
  };
}

function reset(): void {
  calls.length = 0;
  heldOpen.length = 0;
  for (const kind of Object.keys(holds) as RunnerStepKind[]) holds[kind] = 0;
  createStdout = "  container-abc123 \n";
  createOk = true;
  cpInOk = true;
  startOk = true;
  cpOutOk = true;
  rmOk = true;
  startFailure = { stdout: "partial output", stderr: "runner: boom" };
}

beforeEach(reset);

describe("M23.1 conformance: what the Docker adapter puts on the command line", () => {
  it("THE FULL FIVE-STEP SEQUENCE — create / three cp in / start / cp out / rm, argv and options", async () => {
    // The maximal shape: a non-default binary, a non-default network, two `-e` pairs, three operands
    // after the image, THREE copy-INs in the caller's order, and one copy-OUT. Every string below is
    // asserted as an array element, so a reordered flag or a dropped `/.` fails and PRINTS.
    const result = await createDockerRunnerLauncher("/usr/local/bin/docker").run(
      spec({
        image: "scp-runner-scan:vetted",
        operands: ["openscap", "profile-x", "/ssg/ds.xml"],
        networkMode: "scp-scan-egress",
        env: ["SCP_SCAN_DB_DIR=/work/db", "SCP_SCAN_SCAP_DIR=/work/scap"],
        copyIn: [
          { hostDir: "/host/oci", containerPath: "/work/image" },
          { hostDir: "/host/trivy-db", containerPath: "/work/db" },
          { hostDir: "/host/ssg", containerPath: "/work/scap" }
        ],
        copyOut: {
          containerPath: "/work/out",
          hostDir: "/host/out",
          when: "on-success",
          onFailure: "propagate"
        },
        timeoutMs: SCAN_OPTS.timeout,
        maxBuffer: SCAN_OPTS.maxBuffer
      })
    );

    expect(calls, "the Docker adapter's launch argv changed").toStrictEqual([
      {
        file: "/usr/local/bin/docker",
        args: [
          "create",
          "--network",
          "scp-scan-egress",
          "-e",
          "SCP_SCAN_DB_DIR=/work/db",
          "-e",
          "SCP_SCAN_SCAP_DIR=/work/scap",
          "scp-runner-scan:vetted",
          "openscap",
          "profile-x",
          "/ssg/ds.xml"
        ],
        opts: SCAN_OPTS
      },
      {
        file: "/usr/local/bin/docker",
        args: ["cp", "/host/oci/.", "container-abc123:/work/image"],
        opts: SCAN_OPTS
      },
      {
        file: "/usr/local/bin/docker",
        args: ["cp", "/host/trivy-db/.", "container-abc123:/work/db"],
        opts: SCAN_OPTS
      },
      {
        file: "/usr/local/bin/docker",
        args: ["cp", "/host/ssg/.", "container-abc123:/work/scap"],
        opts: SCAN_OPTS
      },
      {
        file: "/usr/local/bin/docker",
        args: ["start", "-a", "container-abc123"],
        opts: SCAN_OPTS
      },
      {
        file: "/usr/local/bin/docker",
        args: ["cp", "container-abc123:/work/out/.", "/host/out"],
        opts: SCAN_OPTS
      },
      // THE TEARDOWN TIMEOUT IS NOT THE RUN TIMEOUT, and `rm` carries no `maxBuffer` at all.
      {
        file: "/usr/local/bin/docker",
        args: ["rm", "-f", "container-abc123"],
        opts: RM_OPTS
      }
    ]);

    // ...and the runner's own output came back, so none of the above passed by nothing happening.
    expect(result).toStrictEqual({
      succeeded: true,
      stdout: "runner ok",
      stderr: "runner warned"
    });
  });

  it("THE MINIMAL SEQUENCE — no env, no copy-in, no copy-out: create / start / rm and NOTHING else", async () => {
    // The other endpoint. An empty `env` must produce NO `-e` at all (not an empty pair), an empty
    // `copyIn` no `cp`, and an absent `copyOut` no `cp` back. Asserted as the whole array, so a
    // spurious extra call is a failure rather than something a "contains" assertion would tolerate.
    const result = await createDockerRunnerLauncher("docker").run(
      spec({ image: "scp-runner-dep:vetted", operands: ["npm"] })
    );

    expect(calls, "the Docker adapter's minimal launch argv changed").toStrictEqual([
      {
        file: "docker",
        args: ["create", "--network", "none", "scp-runner-dep:vetted", "npm"],
        opts: IAC_OPTS
      },
      { file: "docker", args: ["start", "-a", "container-abc123"], opts: IAC_OPTS },
      { file: "docker", args: ["rm", "-f", "container-abc123"], opts: RM_OPTS }
    ]);
    expect(result.succeeded).toBe(true);
  });

  it("THE CONTAINER ID IS `create`'s STDOUT, TRIMMED — every later argv carries the trimmed id", async () => {
    // `docker create` prints the id with a trailing newline. If the trim were dropped, `cp`, `start`
    // and `rm` would all address `"container-xyz\n"` and only an end-to-end Docker run would notice.
    createStdout = "\tcontainer-xyz\r\n";
    await createDockerRunnerLauncher("docker").run(
      spec({
        copyIn: [{ hostDir: "/host/in", containerPath: "/work/in" }],
        copyOut: {
          containerPath: "/work/out",
          hostDir: "/host/out",
          when: "always",
          onFailure: "swallow"
        }
      })
    );

    expect(calls.map((c) => c.args)).toStrictEqual([
      ["create", "--network", "none", "scp-runner-iac:vetted"],
      ["cp", "/host/in/.", "container-xyz:/work/in"],
      ["start", "-a", "container-xyz"],
      ["cp", "container-xyz:/work/out/.", "/host/out"],
      ["rm", "-f", "container-xyz"]
    ]);
  });

  it("THE DEFAULT BINARY IS `docker`, AND IT IS THE FILE OF EVERY CALL", async () => {
    // `createDockerRunnerLauncher()` with no argument. A renamed or partially-substituted binary
    // must fail: the assertion is the `file` of all three calls, not just the first.
    expect(DEFAULT_DOCKER_BINARY).toBe("docker");
    await createDockerRunnerLauncher().run(spec());
    expect(calls.map((c) => c.file)).toStrictEqual(["docker", "docker", "docker"]);
  });

  it("`resolveDockerRunnerLauncher` USES config.dockerBinary, AND FALLS BACK TO `docker`", async () => {
    // The default resolver every managed executor is wired with. Both arms, both asserted on the
    // recorded `file` rather than on the resolver returning something truthy.
    await resolveDockerRunnerLauncher({ dockerBinary: "/opt/bin/podman" }).run(spec());
    expect(calls.map((c) => c.file)).toStrictEqual([
      "/opt/bin/podman",
      "/opt/bin/podman",
      "/opt/bin/podman"
    ]);

    reset();
    await resolveDockerRunnerLauncher({}).run(spec());
    expect(calls.map((c) => c.file)).toStrictEqual(["docker", "docker", "docker"]);
  });
});

describe("M23.1 conformance: the per-call timeout and maxBuffer are the CALLER's, never a shared default", () => {
  // The three callers disagree, and the disagreement is load-bearing (BUILD_AND_TEST.md §8 M23.1;
  // `RunnerSpec.maxBuffer`'s doc comment). Driven as data so that "managed-dep quietly got
  // managed-scan's 32 MiB" is a named, printing failure rather than a diff nobody reads.
  const profiles = [
    { name: "managed-iac — 10 min / 16 MiB", opts: IAC_OPTS },
    { name: "managed-scan — 10 min / 32 MiB", opts: SCAN_OPTS },
    { name: "managed-dep — 5 min / 8 MiB", opts: DEP_OPTS }
  ];

  it.each(profiles)(
    "$name is carried by create, cp in, start and cp out — but NOT by rm",
    async ({ opts }) => {
      reset();
      await createDockerRunnerLauncher("docker").run(
        spec({
          copyIn: [{ hostDir: "/host/in", containerPath: "/work/in" }],
          copyOut: {
            containerPath: "/work/out",
            hostDir: "/host/out",
            when: "always",
            onFailure: "swallow"
          },
          timeoutMs: opts.timeout,
          maxBuffer: opts.maxBuffer
        })
      );

      expect(calls.map((c) => ({ sub: c.args[0], opts: c.opts }))).toStrictEqual([
        { sub: "create", opts },
        { sub: "cp", opts },
        { sub: "start", opts },
        { sub: "cp", opts },
        // NOT `opts`: `rm` keeps its own literal 30 s and carries NO `maxBuffer` key at all, which is
        // only observable because this is `toStrictEqual` against an object with one property.
        { sub: "rm", opts: RM_OPTS }
      ]);
    }
  );

  it("A TENANT `timeoutMs` NEVER REACHES `rm`", async () => {
    // The tenant-suppliable field on two of the three callers. 123456 is the value all fourteen
    // goldens use for their maximal case; `rm` must still be the 30 s constant.
    await createDockerRunnerLauncher("docker").run(spec({ timeoutMs: 123_456, maxBuffer: 999 }));

    expect(RUNNER_REMOVE_TIMEOUT_MS).toBe(30_000);
    expect(calls.map((c) => ({ sub: c.args[0], opts: c.opts }))).toStrictEqual([
      { sub: "create", opts: { timeout: 123_456, maxBuffer: 999 } },
      { sub: "start", opts: { timeout: 123_456, maxBuffer: 999 } },
      { sub: "rm", opts: { timeout: RUNNER_REMOVE_TIMEOUT_MS } }
    ]);
  });
});

describe("M23.1 conformance: copyOut.when and copyOut.onFailure are independent, and all four arms differ", () => {
  const OUT_PATHS = { containerPath: "/work/out", hostDir: "/host/out" } as const;

  it("`when: always` + a SUCCESSFUL start — the copy-out is issued", async () => {
    await createDockerRunnerLauncher("docker").run(
      spec({ copyOut: { ...OUT_PATHS, when: "always", onFailure: "swallow" } })
    );
    expect(calls.map((c) => c.args)).toStrictEqual([
      ["create", "--network", "none", "scp-runner-iac:vetted"],
      ["start", "-a", "container-abc123"],
      ["cp", "container-abc123:/work/out/.", "/host/out"],
      ["rm", "-f", "container-abc123"]
    ]);
  });

  it("`when: always` + a FAILED start — the copy-out is STILL issued, before `rm`", async () => {
    // managed-iac's arm: a failed `apply` may still have produced a partial `plan.json` worth
    // persisting. This is the half of the asymmetry a "unify the three" refactor deletes by accident.
    startOk = false;
    const result = await createDockerRunnerLauncher("docker").run(
      spec({ copyOut: { ...OUT_PATHS, when: "always", onFailure: "swallow" } })
    );

    expect(calls.map((c) => c.args)).toStrictEqual([
      ["create", "--network", "none", "scp-runner-iac:vetted"],
      ["start", "-a", "container-abc123"],
      ["cp", "container-abc123:/work/out/.", "/host/out"],
      ["rm", "-f", "container-abc123"]
    ]);
    expect(result.succeeded).toBe(false);
  });

  it("`when: on-success` + a FAILED start — NO copy-out at all; only `rm` follows", async () => {
    // managed-scan's and managed-dep's arm: a failed run must produce no evidence (fail-closed).
    startOk = false;
    const result = await createDockerRunnerLauncher("docker").run(
      spec({ copyOut: { ...OUT_PATHS, when: "on-success", onFailure: "propagate" } })
    );

    expect(calls.map((c) => c.args)).toStrictEqual([
      ["create", "--network", "none", "scp-runner-iac:vetted"],
      ["start", "-a", "container-abc123"],
      ["rm", "-f", "container-abc123"]
    ]);
    expect(result.succeeded).toBe(false);
  });

  it("`when: on-success` + a SUCCESSFUL start — the copy-out IS issued", async () => {
    // Without this arm, an adapter that never copied out under `on-success` would pass the one above.
    await createDockerRunnerLauncher("docker").run(
      spec({ copyOut: { ...OUT_PATHS, when: "on-success", onFailure: "propagate" } })
    );
    expect(calls.map((c) => c.args)).toStrictEqual([
      ["create", "--network", "none", "scp-runner-iac:vetted"],
      ["start", "-a", "container-abc123"],
      ["cp", "container-abc123:/work/out/.", "/host/out"],
      ["rm", "-f", "container-abc123"]
    ]);
  });

  it("`onFailure: swallow` — a FAILED copy-out leaves the run SUCCEEDED, and `rm` still runs", async () => {
    // managed-iac's `.catch(() => undefined)`. A port that awaited all five steps uniformly would
    // turn a succeeded apply into a failed one, and only this test would say so.
    cpOutOk = false;
    const result = await createDockerRunnerLauncher("docker").run(
      spec({ copyOut: { ...OUT_PATHS, when: "always", onFailure: "swallow" } })
    );

    expect(result).toStrictEqual({ succeeded: true, stdout: "runner ok", stderr: "runner warned" });
    expect(calls.map((c) => c.args)).toStrictEqual([
      ["create", "--network", "none", "scp-runner-iac:vetted"],
      ["start", "-a", "container-abc123"],
      ["cp", "container-abc123:/work/out/.", "/host/out"],
      ["rm", "-f", "container-abc123"]
    ]);
  });

  it("`onFailure: propagate` — a FAILED copy-out REJECTS out of `run()`, and `rm` still runs", async () => {
    // managed-scan's and managed-dep's arm. The rejection is the adapter's contract; where it LANDS
    // differs per plugin (scan lets it escape `trigger()`, dep's outer catch turns it into `failed`)
    // and is the plugins' business, pinned in their goldens rather than here.
    cpOutOk = false;
    await expect(
      createDockerRunnerLauncher("docker").run(
        spec({ copyOut: { ...OUT_PATHS, when: "always", onFailure: "propagate" } })
      )
    ).rejects.toThrow(/docker cp/);

    // The `finally` still tore the container down — the credential-carrying env does not survive.
    expect(calls.map((c) => c.args)).toStrictEqual([
      ["create", "--network", "none", "scp-runner-iac:vetted"],
      ["start", "-a", "container-abc123"],
      ["cp", "container-abc123:/work/out/.", "/host/out"],
      ["rm", "-f", "container-abc123"]
    ]);
  });
});

describe("M23.1 conformance: the failure paths, including the defect M23.0 recorded and kept", () => {
  it("A REJECTED `start` IS CAPTURED, NOT RETHROWN — succeeded:false with the child's stdout/stderr", async () => {
    startOk = false;
    startFailure = { stdout: "partial plan", stderr: "tofu: boom" };

    const result = await createDockerRunnerLauncher("docker").run(spec());

    expect(result).toStrictEqual({
      succeeded: false,
      stdout: "partial plan",
      stderr: "tofu: boom"
    });
  });

  it('A REJECTED `start` WITH NO stdout/stderr FALLS BACK TO `""` AND THE ERROR MESSAGE', async () => {
    // `execFile` rejects with a bare Error when it cannot spawn at all (ENOENT on the binary, or the
    // `timeout` firing). Without the `?? e.message` fall the operator would get an empty `detail`.
    startOk = false;
    startFailure = {};

    const result = await createDockerRunnerLauncher("docker").run(spec());

    expect(result).toStrictEqual({
      succeeded: false,
      stdout: "",
      stderr: "container exited non-zero"
    });
  });

  it("A REJECTED COPY-IN REJECTS the run — and `rm` still runs, so nothing is orphaned", async () => {
    // The copy-INs are inside the `try`, unlike `create`. There is no `onFailure` axis for them:
    // a subject that did not reach the container must never be scanned or applied.
    cpInOk = false;
    await expect(
      createDockerRunnerLauncher("docker").run(
        spec({ copyIn: [{ hostDir: "/host/in", containerPath: "/work/in" }] })
      )
    ).rejects.toThrow(/cannot read host directory/);

    expect(calls.map((c) => c.args)).toStrictEqual([
      ["create", "--network", "none", "scp-runner-iac:vetted"],
      ["cp", "/host/in/.", "container-abc123:/work/in"],
      ["rm", "-f", "container-abc123"]
    ]);
  });

  it("A REJECTED `rm` IS SWALLOWED — the run's own result still comes back", async () => {
    // Teardown is best-effort by design: a container the daemon already reaped must not turn a
    // succeeded run into a failed one.
    rmOk = false;
    const result = await createDockerRunnerLauncher("docker").run(spec());

    expect(result).toStrictEqual({ succeeded: true, stdout: "runner ok", stderr: "runner warned" });
    expect(calls.map((c) => c.args)).toStrictEqual([
      ["create", "--network", "none", "scp-runner-iac:vetted"],
      ["start", "-a", "container-abc123"],
      ["rm", "-f", "container-abc123"]
    ]);
  });

  it("THE RECORDED DEFECT — a REJECTED `create` issues NO `rm`, because its await is outside the `try`", async () => {
    // M23.0 found this and deliberately did not fix it: a `create` that times out AFTER the daemon
    // made the container leaves it behind, and no `--name`/`--label` is passed, so it carries no
    // attribution. It is pinned here so the day someone moves that `await` inside the `try` — the
    // right fix, now in ONE place instead of three — this test fails and is updated ON PURPOSE
    // rather than the behaviour changing silently in either direction.
    createOk = false;
    await expect(createDockerRunnerLauncher("docker").run(spec())).rejects.toThrow(/no such image/);

    expect(calls.map((c) => c.args)).toStrictEqual([
      ["create", "--network", "none", "scp-runner-iac:vetted"]
    ]);
  });
});

// ==================================================================================================
// AWAIT ORDERING — the half of the contract the argv assertions above are structurally blind to.
// ==================================================================================================
//
// Everything above records ISSUE order. Issue order is identical whether a step was awaited or
// fired and forgotten, so two real mutations of `index.ts` used to survive all twenty of those
// tests: `await pending.catch(() => undefined)` -> `void pending.catch(() => undefined)` (the
// evidence copy-out), and `await execFileAsync(docker, ["rm","-f",id], …)` -> `void …` (teardown).
// The cases below hold one step OPEN and assert that the next one has not been issued, which is the
// only formulation that can tell the two apart. They are parameterised so the M23.2 Kubernetes
// adapter inherits them by supplying a substrate rather than by re-deriving the race.
//
// THE MEASURED TABLE — EVERY `await` in `packages/runner-launcher/src/index.ts` (there are six),
// dropped in turn and the suite re-run. "pre-existing" = the 20 tests above, selected with
// `vitest run -t "M23.1 conformance:"`; "with ordering" = the whole file.
//
//   index.ts:195  create, `const { stdout } = await execFileAsync(…)`
//                 pre-existing: CAUGHT (all 20)   with ordering: CAUGHT (30)
//                 Dropping it destroys the value flow too — `createOut` becomes a Promise and
//                 `.trim()` throws — so this await cannot be dropped in an ordering-only way. The
//                 named ordering case is "`create` IS AWAITED".
//   index.ts:205  copy-in loop, `await execFileAsync(…)` -> `void`
//                 pre-existing: CAUGHT (1)        with ordering: CAUGHT (2)
//                 "A REJECTED COPY-IN REJECTS the run" catches the un-awaited rejection; only
//                 "THE COPY-INS ARE SEQUENTIAL" catches the ORDER (two copies racing into one
//                 container, and `start` racing both).
//   index.ts:218  start, `const r = await execFileAsync(…)`
//                 pre-existing: CAUGHT (8)        with ordering: CAUGHT (9)
//                 Value flow again (`r.stdout` undefined), plus "`start` IS AWAITED".
//   index.ts:242  copy-out swallow arm, `await pending.catch(…)` -> `void pending.catch(…)`
//                 pre-existing: **SURVIVED**      with ordering: CAUGHT (2)
//                 THE managed-iac plan.json RACE. Measured, not assumed: with `-t "M23.1
//                 conformance:"` the run is "20 passed | 10 skipped" and exit 0.
//   index.ts:244  copy-out propagate arm, `await pending;` -> `void pending;`
//                 pre-existing: CAUGHT (1)        with ordering: CAUGHT (2)
//                 The pre-existing catch is incidental — the rejection stops escaping `run()`.
//                 "THE PROPAGATING COPY-OUT IS AWAITED" is what names the teardown race.
//   index.ts:251  teardown, `await execFileAsync(… "rm","-f" …).catch(…)` -> `void …`
//                 pre-existing: **SURVIVED**      with ordering: CAUGHT (2)
//                 Also measured at exit 0 against the pre-existing tests alone.
//
// NOT OBSERVABLE HERE, STATED RATHER THAN GLOSSED. The suite proves each step is awaited BEFORE THE
// NEXT ONE IS ISSUED. It does NOT prove that the process the adapter waited on is the one that
// finished — a substrate settles a step when the test says so, not when a container really exits;
// only `managed-iac.integration.test.ts` (real Docker) can speak to that. It also says nothing
// about the plugins' own awaits AROUND `run()` (writing the workspace, reading the evidence back),
// which live in each plugin's suites, nor about `create`'s await being outside the `try` — that is
// a deliberate recorded defect with its own named test above, not an ordering property.

function dockerOrderingSubstrate(): LaunchOrderingSubstrate {
  reset();
  return {
    launcher: createDockerRunnerLauncher("docker"),
    baseSpec: () => spec(),
    issued: () => calls.map((c) => stepKind(c.args)),
    hold: (kind, count = 1) => {
      holds[kind] += count;
    },
    release: (kind, failure) => {
      const index = heldOpen.findIndex((held) => held.kind === kind);
      if (index === -1) throw new Error(`docker-adapter.test: no held '${kind}' step to release`);
      const [held] = heldOpen.splice(index, 1);
      held!.deliver(failure);
    }
  };
}

runLaunchOrderingConformanceSuite(
  "M23.1 conformance — the Docker adapter",
  dockerOrderingSubstrate
);
