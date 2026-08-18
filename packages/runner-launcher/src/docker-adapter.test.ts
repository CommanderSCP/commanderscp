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
 *  5. WHAT HAPPENS WHEN THE LEVERS FIRE — the four shapes `promisify(execFile)` actually rejects
 *     with (timeout-kill, maxBuffer, spawn ENOENT, exit 125), on every step that can produce them.
 *     Points 2 and 4 assert that `timeout` and `maxBuffer` are PASSED; this is the only thing here
 *     that asserts what the adapter does when one of them goes off, and the shapes are measured
 *     against the running Node rather than imagined.
 *  6. THAT TWO RUNS IN FLIGHT NEVER ADDRESS EACH OTHER'S CONTAINER — in the parameterised ordering
 *     suite rather than in this file, so the M23.2 Kubernetes adapter inherits it.
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
/**
 * CONCURRENCY ONLY: with this set, successive `create`s print `container-1`, `container-2`, … so
 * that two runs in flight are distinguishable. Off everywhere else, where the literal
 * `container-abc123` is asserted and must stay.
 */
let createIdSequence = false;
/** The (trimmed) id each `create` was ALLOCATED, in issue order — the identity that call produces. */
const createdIds: string[] = [];

/**
 * PER-STEP FAILURE INJECTION — the very object `execFile`'s callback is handed for that step, or
 * absent for a step that succeeds.
 *
 * IT IS AN ERROR OBJECT AND NOT A BOOLEAN ON PURPOSE, and that is the whole of what this knob fixed:
 * the seam used to reject `start` with `new Error("container exited non-zero")` carrying nothing but
 * `stdout`/`stderr`, so nothing in this file could tell "the runner exited non-zero" apart from "our
 * own `timeout` fired and WE killed it" or "its output blew `maxBuffer`". Two mutations of the
 * `succeeded = false` at `index.ts:227` therefore passed all thirty tests —
 *
 *     succeeded = false;  ->  succeeded = (err as { killed?: boolean }).killed === true;
 *     succeeded = false;  ->  succeeded = (err as { code?: string }).code === MAXBUFFER_CODE;
 *
 * — which is the "verify the lever, not just the signal" class CLAUDE.md names: four tests assert
 * that `timeout` and `maxBuffer` REACH the options object, and none asserted what happens when one
 * of them FIRES. {@link NODE_FAILURE_SHAPES} fires them, on every step that can produce them.
 */
const stepFails: Partial<Record<RunnerStepKind, Error>> = {};

/**
 * The ordinary `start` rejection: a non-zero exit carrying the child's own output. A builder rather
 * than a literal because the absent-property arms exercise the adapter's `?? ""` / `?? e.message`
 * falls — see the measured note on those falls in the shapes table below.
 */
function startExitFailure(payload: { stdout?: string; stderr?: string } = {}): Error {
  const err = new Error("container exited non-zero");
  if (payload.stdout !== undefined) Object.assign(err, { stdout: payload.stdout });
  if (payload.stderr !== undefined) Object.assign(err, { stderr: payload.stderr });
  return err;
}

/** Each step's ordinary failure, for the tests that care only THAT it failed and not how. */
function defaultFailure(kind: RunnerStepKind): Error {
  if (kind === "create") return new Error("docker create: no such image");
  if (kind === "copy-in") return new Error("docker cp: cannot read host directory");
  if (kind === "start") {
    return startExitFailure({ stdout: "partial output", stderr: "runner: boom" });
  }
  if (kind === "copy-out") return new Error("docker cp: no such file or directory");
  return new Error("docker rm: no such container");
}

/** Make `kind` fail — with `error` when the SHAPE of the failure is the subject, else plainly. */
function fail(kind: RunnerStepKind, error: Error = defaultFailure(kind)): void {
  stepFails[kind] = error;
}

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
  /** The outcome this step would have had, decided AT DELIVERY TIME. */
  function outcome(
    kind: RunnerStepKind,
    createOut: string,
    cb: (err: Error | null, result?: { stdout: string; stderr: string }) => void
  ): void {
    const failure = stepFails[kind];
    if (failure) {
      cb(failure);
      return;
    }
    if (kind === "create") {
      cb(null, { stdout: createOut, stderr: "" });
      return;
    }
    if (kind === "start") {
      cb(null, { stdout: "runner ok", stderr: "runner warned" });
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
      // ALLOCATED AT ISSUE TIME, not at delivery: a `create` that is being HELD OPEN still has a
      // knowable identity, and two concurrent runs are then never handed the same one whatever
      // order their creates settle in.
      let createOut = createStdout;
      if (kind === "create") {
        if (createIdSequence) createOut = `  container-${createdIds.length + 1} \n`;
        createdIds.push(createOut.trim());
      }
      const deliver = (failure?: Error): void => {
        if (failure) {
          cb(failure);
          return;
        }
        outcome(kind, createOut, cb);
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
  createIdSequence = false;
  createdIds.length = 0;
  for (const kind of Object.keys(stepFails) as RunnerStepKind[]) delete stepFails[kind];
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
    fail("start");
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
    fail("start");
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
    fail("copy-out");
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
    fail("copy-out");
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
    fail("start", startExitFailure({ stdout: "partial plan", stderr: "tofu: boom" }));

    const result = await createDockerRunnerLauncher("docker").run(spec());

    expect(result).toStrictEqual({
      succeeded: false,
      stdout: "partial plan",
      stderr: "tofu: boom"
    });
  });

  it('A REJECTED `start` WITH NO stdout/stderr FALLS BACK TO `""` AND THE ERROR MESSAGE', async () => {
    // THE `?? ""` / `?? e.message` FALLS, AND A CORRECTION. This test's comment used to say the fall
    // covers the cases where "`execFile` rejects with a bare Error … (ENOENT on the binary, or the
    // `timeout` firing)". MEASURED, that is false: `promisify(execFile)` attaches `stdout` and
    // `stderr` to EVERY rejection it produces — including ENOENT and the timeout kill, where both are
    // `""` — so in production these falls never fire and an operator gets an EMPTY `detail` for a
    // runner we killed ourselves. The four arms of `NODE_FAILURE_SHAPES` below pin that consequence
    // as it actually is; this test keeps covering the falls themselves, which remain the adapter's
    // only defence against a rejection that did not come from `promisify(execFile)` at all.
    fail("start", startExitFailure());

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
    fail("copy-in");
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
    fail("teardown");
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
    fail("create");
    await expect(createDockerRunnerLauncher("docker").run(spec())).rejects.toThrow(/no such image/);

    expect(calls.map((c) => c.args)).toStrictEqual([
      ["create", "--network", "none", "scp-runner-iac:vetted"]
    ]);
  });
});

// ==================================================================================================
// THE LEVERS, FIRED — what happens when `timeout` or `maxBuffer` actually goes off.
// ==================================================================================================
//
// Everything above asserts that `timeout` and `maxBuffer` are ON THE OPTIONS OBJECT. That is the
// signal, not the actuator, and CLAUDE.md names the gap: five tests (the three profile rows, "A
// TENANT `timeoutMs` NEVER REACHES `rm`", and `RUNNER_REMOVE_TIMEOUT_MS`) assert those numbers, and
// not one of them said what the adapter DOES when a number is exceeded. The consequence was
// measurable: with the old boolean seam, `succeeded = false` at `index.ts:227` could be replaced by
// `succeeded = (err as { killed?: boolean }).killed === true` and all thirty tests still passed —
// a build in which every runner WE killed on timeout is reported to the plugin as a SUCCESS, with a
// truncated or empty plan.json cached as evidence.
//
// MEASURED, each mutation applied to a clean tree and the whole file re-run:
//
//   succeeded = false -> `.killed === true`          CAUGHT (1/52) by the TIMEOUT-KILL `start` arm
//                                                    — and by that arm ALONE, because the measured
//                                                    maxBuffer error has no `killed` property.
//   succeeded = false -> `.code === MAXBUFFER_CODE`  CAUGHT (1/52) by the MAXBUFFER `start` arm.
//   stdout  = e.stdout ?? "" -> ""                   CAUGHT (3/52)
//   stderr  = e.stderr ?? e.message -> e.message     CAUGHT (5/52) — all four `start` arms.
//   `create` swallows a `killed` failure             CAUGHT (1/52) by the TIMEOUT-KILL `create` arm
//   copy-IN swallows an ENOENT failure               CAUGHT (1/52) by the ENOENT copy-IN arm
//   swallowed copy-OUT rethrows on ENOENT            CAUGHT (1/52) by the ENOENT copy-OUT arm
//   teardown rethrows a `killed` failure             CAUGHT (1/52) by the TIMEOUT-KILL teardown arm
//   NODE_FAILURE_SHAPES timeout row: killed -> false CAUGHT (1/52) by THE TABLE IS NOT FICTION —
//                                                    the fixture itself is mutated, because a table
//                                                    nothing checks is a fixture that never applied.
//
// WHAT THESE ARMS STILL CANNOT PROVE, STATED RATHER THAN IMPLIED.
//  - That `timeout` or `maxBuffer` ever actually fires. The options object is asserted elsewhere and
//    the CONSEQUENCE is asserted here, but nothing in this file lets a real 10-minute limit elapse;
//    only a real Docker run can join the two halves. The seam injects the shape Node WOULD produce.
//  - That the numbers are the right numbers. 16/32/8 MiB and 10/10/5 min are pinned as the callers'
//    values, and no test here says whether a real `terraform plan` output fits in 16 MiB.
//  - Anything about the runner-side truncation itself. The MAXBUFFER arms assert what the adapter
//    reports; they do not assert that a truncated `plan.json` is REJECTED downstream — nothing in
//    this package parses evidence, and `succeeded: false` is all the adapter offers a caller to go on.
//  - That an operator can tell these four apart afterwards. They cannot, today: `run()` returns the
//    same `{ succeeded: false, stdout, stderr }` shape for all of them and drops `killed`, `signal`
//    and `code` on the floor, so a runner we SIGTERM'd at the timeout is indistinguishable in the
//    Decision record from one that exited non-zero — with an EMPTY stderr, which is what the ENOENT
//    and TIMEOUT-KILL arms record. That is a behaviour question for the port, not a test gap, and it
//    is pinned here as it stands rather than quietly improved.

/** `code` on a maxBuffer overflow. Node's own constant name, spelled out so the table below reads. */
const MAXBUFFER_CODE = "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";

/**
 * THE FOUR SHAPES `promisify(execFile)` ACTUALLY REJECTS WITH — MEASURED, NOT INVENTED.
 *
 * Each was captured from a real child process (`node -e …`, plus a spawn of a binary that does not
 * exist) and its own-properties printed; the objects below reproduce what came back. Three of the
 * four are things WE did rather than things the runner did, and the adapter cannot currently tell
 * them apart from a plain non-zero exit:
 *
 *   - TIMEOUT-KILL  `killed: true, signal: "SIGTERM", code: null` — OUR `timeout` fired and Node
 *                   SIGTERM'd the runner mid-flight. `stdout`/`stderr` hold what it had printed.
 *   - MAXBUFFER     a **RangeError** with `code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"` and — measured,
 *                   and load-bearing — **no `killed` property at all**, so a mutation keyed on
 *                   `killed` is caught by the timeout arm and NOT by this one. `stdout` is the
 *                   output TRUNCATED at `maxBuffer`, which is the whole hazard: it looks like data.
 *   - SPAWN ENOENT  `code: "ENOENT"` (a string) with `stdout` and `stderr` both `""` — the docker
 *                   binary is missing. The run is reported failed with NOTHING to explain it.
 *   - EXIT 125      `code: 125` (a NUMBER), `killed: false, signal: null` — docker's own "container
 *                   failed to run", the only one of the four the runner itself caused.
 *
 * `.code` IS OVERLOADED and all three of its inhabitants are in this table on purpose: `null`, a
 * string errno, and a numeric exit status. `index.ts` READS NONE OF THEM — it derives `succeeded`
 * from the fact of the rejection alone — so today there is nothing to conflate, and these arms are
 * what keeps that true: any future refactor that starts branching on `.code` (`=== 0`,
 * `typeof === "number"`, an errno allowlist) changes the outcome of at least one row and fails BY
 * NAME rather than by a diff.
 */
interface NodeFailureShape {
  name: string;
  /** A FRESH error per use — the seam hands the object itself to the adapter, and Errors are mutable. */
  make: () => Error;
  /** What `run()` must report when this shape lands on `start`. */
  startsAs: { stdout: string; stderr: string };
  /** How to provoke the REAL thing from the running Node, for the not-fiction guard below. */
  provoke: (
    run: (file: string, args: string[], opts: object) => Promise<unknown>
  ) => Promise<unknown>;
}

const START_CMD = "docker start -a container-abc123";

const NODE_FAILURE_SHAPES: NodeFailureShape[] = [
  {
    name: "TIMEOUT-KILL (our own `timeout` fired and WE SIGTERM'd the runner)",
    make: () =>
      Object.assign(new Error(`Command failed: ${START_CMD}\n`), {
        code: null,
        killed: true,
        signal: "SIGTERM",
        cmd: START_CMD,
        stdout: '{"resource_ch',
        stderr: ""
      }),
    startsAs: { stdout: '{"resource_ch', stderr: "" },
    provoke: (run) =>
      run(process.execPath, ["-e", "process.stdout.write('half');setTimeout(()=>{},5000)"], {
        timeout: 200
      })
  },
  {
    name: "MAXBUFFER (the runner's output blew `maxBuffer` and its stdout is TRUNCATED)",
    make: () =>
      Object.assign(new RangeError("stdout maxBuffer length exceeded"), {
        code: MAXBUFFER_CODE,
        cmd: START_CMD,
        stdout: '{"resource_ch',
        stderr: ""
      }),
    startsAs: { stdout: '{"resource_ch', stderr: "" },
    provoke: (run) =>
      run(process.execPath, ["-e", "process.stdout.write('x'.repeat(5000))"], { maxBuffer: 10 })
  },
  {
    name: "SPAWN ENOENT (the docker binary is missing — nothing ran at all)",
    make: () =>
      Object.assign(new Error("spawn docker ENOENT"), {
        errno: -2,
        code: "ENOENT",
        syscall: "spawn docker",
        path: "docker",
        spawnargs: ["start", "-a", "container-abc123"],
        cmd: START_CMD,
        stdout: "",
        stderr: ""
      }),
    startsAs: { stdout: "", stderr: "" },
    provoke: (run) => run("scp-no-such-binary-8f3a2c", ["--version"], {})
  },
  {
    name: "EXIT 125 (docker's own `container failed to run` — the runner really did fail)",
    make: () =>
      Object.assign(new Error(`Command failed: ${START_CMD}\ndocker: Error response from daemon`), {
        code: 125,
        killed: false,
        signal: null,
        cmd: START_CMD,
        stdout: "",
        stderr: "docker: Error response from daemon"
      }),
    startsAs: { stdout: "", stderr: "docker: Error response from daemon" },
    provoke: (run) =>
      run(
        process.execPath,
        ["-e", "process.stderr.write('docker: Error response from daemon');process.exit(125)"],
        {}
      )
  }
];

/** The fields the table above CLAIMS. Compared between the recorded shape and the live one. */
const PINNED_ERROR_FIELDS = ["code", "killed", "signal"] as const;
const ABSENT = "<<no such own property>>";

/**
 * The claim each row makes, reduced to something comparable. `stdout`/`stderr` are compared by TYPE
 * rather than value — their contents are the child's business — because the load-bearing fact about
 * them is that they are ALWAYS PRESENT STRINGS, which is what makes the adapter's `?? e.message`
 * fall unreachable in production.
 */
function errorFingerprint(err: unknown): Record<string, unknown> {
  const e = err as Record<string, unknown>;
  const shape: Record<string, unknown> = {};
  for (const field of PINNED_ERROR_FIELDS) {
    shape[field] = Object.hasOwn(e, field) ? e[field] : ABSENT;
  }
  shape["typeof stdout"] = typeof e["stdout"];
  shape["typeof stderr"] = typeof e["stderr"];
  return shape;
}

describe("M23.1 conformance: the LEVERS FIRE — every failure shape Node itself produces, on every step", () => {
  const OUT_PATHS = { containerPath: "/work/out", hostDir: "/host/out" } as const;

  it("THE TABLE IS NOT FICTION — the RUNNING Node still rejects with exactly these shapes", async () => {
    // A recorded constant nobody re-derives goes stale in silence, and this table is a recording of
    // another program's behaviour. So it is checked against that program: `importActual` reaches
    // PAST this file's own `vi.mock` to the real `child_process`, four real children are spawned
    // (no network, no Docker — `process.execPath` is the node running this test, and one binary that
    // cannot exist), and the fields each row claims are compared. If a future Node renames
    // `ERR_CHILD_PROCESS_STDIO_MAXBUFFER`, stops setting `killed`, or starts omitting `stderr`, THIS
    // fails and names the row rather than the twenty arms below quietly testing a museum piece.
    const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    const { promisify } = await import("node:util");
    const realExecFileAsync = promisify(actual.execFile);
    const run = (file: string, args: string[], opts: object): Promise<unknown> =>
      realExecFileAsync(file, args, opts) as unknown as Promise<unknown>;

    for (const shape of NODE_FAILURE_SHAPES) {
      let live: unknown = ABSENT;
      try {
        await shape.provoke(run);
      } catch (err) {
        live = err;
      }
      expect(live, `${shape.name}: the real child did not fail at all`).not.toBe(ABSENT);
      expect(
        errorFingerprint(live),
        `${shape.name}: the running Node no longer rejects with the shape this table records`
      ).toStrictEqual(errorFingerprint(shape.make()));
    }
  }, 20_000);

  it.each(NODE_FAILURE_SHAPES)(
    "$name at `start` → a FAILED run carrying the child's own output",
    async ({ make, startsAs }) => {
      // THE ONE THE TWO SURVIVING MUTATIONS NEEDED. Nothing about the SHAPE of the failure may
      // decide the runner's exit status: a runner we killed on timeout, one whose output overflowed,
      // one that never spawned and one that exited 125 are all `succeeded: false`.
      fail("start", make());

      const result = await createDockerRunnerLauncher("docker").run(spec());

      expect(
        result,
        "a `start` that failed this way was not reported as a failed run with the child's own output"
      ).toStrictEqual({ succeeded: false, ...startsAs });
      // …and it is a CAPTURED failure, so the container is still torn down.
      expect(calls.map((c) => c.args)).toStrictEqual([
        ["create", "--network", "none", "scp-runner-iac:vetted"],
        ["start", "-a", "container-abc123"],
        ["rm", "-f", "container-abc123"]
      ]);
    }
  );

  it.each(NODE_FAILURE_SHAPES)(
    "$name at `create` → REJECTS out of run(), and issues NO teardown",
    async ({ make }) => {
      // The recorded M23.0 defect, held for every shape rather than only for "no such image" — and
      // the TIMEOUT row is the one that matters: `create` timing out is precisely the case where the
      // daemon may already have made a container, and it is precisely the case with no `rm`.
      const err = make();
      fail("create", err);

      await expect(createDockerRunnerLauncher("docker").run(spec())).rejects.toBe(err);

      expect(
        calls.map((c) => c.args),
        "a step other than `create` was issued after `create` failed"
      ).toStrictEqual([["create", "--network", "none", "scp-runner-iac:vetted"]]);
    }
  );

  it.each(NODE_FAILURE_SHAPES)(
    "$name at a copy-IN → REJECTS out of run(), and teardown STILL runs",
    async ({ make }) => {
      const err = make();
      fail("copy-in", err);

      await expect(
        createDockerRunnerLauncher("docker").run(
          spec({ copyIn: [{ hostDir: "/host/in", containerPath: "/work/in" }] })
        )
      ).rejects.toBe(err);

      expect(calls.map((c) => c.args)).toStrictEqual([
        ["create", "--network", "none", "scp-runner-iac:vetted"],
        ["cp", "/host/in/.", "container-abc123:/work/in"],
        ["rm", "-f", "container-abc123"]
      ]);
    }
  );

  it.each(NODE_FAILURE_SHAPES)(
    "$name at the copy-OUT → `swallow` still SUCCEEDS, `propagate` REJECTS, and both tear down",
    async ({ make }) => {
      // Both arms in one row, because the axis under test is `onFailure` and the point is that the
      // SHAPE does not move it: a copy-out killed by our own timeout is swallowed by managed-iac
      // exactly as a missing-file copy-out is, evidence silently absent either way.
      const swallowed = make();
      fail("copy-out", swallowed);
      const result = await createDockerRunnerLauncher("docker").run(
        spec({ copyOut: { ...OUT_PATHS, when: "always", onFailure: "swallow" } })
      );
      expect(result).toStrictEqual({
        succeeded: true,
        stdout: "runner ok",
        stderr: "runner warned"
      });
      expect(calls.map((c) => c.args)).toStrictEqual([
        ["create", "--network", "none", "scp-runner-iac:vetted"],
        ["start", "-a", "container-abc123"],
        ["cp", "container-abc123:/work/out/.", "/host/out"],
        ["rm", "-f", "container-abc123"]
      ]);

      reset();
      const propagated = make();
      fail("copy-out", propagated);
      await expect(
        createDockerRunnerLauncher("docker").run(
          spec({ copyOut: { ...OUT_PATHS, when: "always", onFailure: "propagate" } })
        )
      ).rejects.toBe(propagated);
      expect(calls.map((c) => c.args)).toStrictEqual([
        ["create", "--network", "none", "scp-runner-iac:vetted"],
        ["start", "-a", "container-abc123"],
        ["cp", "container-abc123:/work/out/.", "/host/out"],
        ["rm", "-f", "container-abc123"]
      ]);
    }
  );

  it.each(NODE_FAILURE_SHAPES)(
    "$name at teardown → SWALLOWED; the run's own result still comes back",
    async ({ make }) => {
      // `rm` carries `RUNNER_REMOVE_TIMEOUT_MS`, so it has a lever of its own to fire. A teardown we
      // killed at 30 s means the credential-carrying container may still be alive — and the caller
      // is told nothing, today, by design. Pinned so that "by design" stays a decision.
      fail("teardown", make());

      const result = await createDockerRunnerLauncher("docker").run(spec());

      expect(result).toStrictEqual({
        succeeded: true,
        stdout: "runner ok",
        stderr: "runner warned"
      });
      expect(calls.map((c) => c.args)).toStrictEqual([
        ["create", "--network", "none", "scp-runner-iac:vetted"],
        ["start", "-a", "container-abc123"],
        ["rm", "-f", "container-abc123"]
      ]);
    }
  );
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
// dropped in turn and the suite re-run. RE-MEASURED against today's 52-test file; the counts and the
// selector both moved when the LEVERS FIRE arms landed, because those arms share the "M23.1
// conformance:" prefix the old selector used. "argv-only" is now the four pre-ordering describes,
// selected with `-t "what the Docker adapter puts|the per-call timeout|copyOut.when|the failure
// paths"` (20 tests); "whole file" is all 52.
//
//   index.ts:195  create, `const { stdout } = await execFileAsync(…)`
//                 argv-only: CAUGHT (20/20)   whole file: CAUGHT (51/52)
//                 Dropping it destroys the value flow too — `createOut` becomes a Promise and
//                 `.trim()` throws — so this await cannot be dropped in an ordering-only way. The
//                 named ordering case is "`create` IS AWAITED".
//   index.ts:205  copy-in loop, `await execFileAsync(…)` -> `void`
//                 argv-only: CAUGHT (1)       whole file: CAUGHT (7)
//                 "A REJECTED COPY-IN REJECTS the run" and the four copy-IN shape arms catch the
//                 un-awaited rejection; "THE COPY-INS ARE SEQUENTIAL" catches the ORDER (two copies
//                 racing into one container, and `start` racing both), and "TWO RUNS AT ONCE"
//                 catches it as a cross-run identity error.
//   index.ts:218  start, `const r = await execFileAsync(…)`
//                 argv-only: CAUGHT (7)       whole file: CAUGHT (21)
//                 Value flow again (`r.stdout` undefined), plus "`start` IS AWAITED".
//   index.ts:242  copy-out swallow arm, `await pending.catch(…)` -> `void pending.catch(…)`
//                 argv-only: **SURVIVED**     whole file: CAUGHT (2)
//                 THE managed-iac plan.json RACE. Measured, not assumed: against the argv-only
//                 selection the run is "20 passed | 32 skipped" and exit 0. Caught only by "THE
//                 SWALLOWED COPY-OUT IS AWAITED" and "A FAILING SWALLOWED COPY-OUT IS STILL
//                 AWAITED" — the twenty LEVERS FIRE arms do NOT catch it either, because a shape
//                 changes what the failure IS and not when it is waited for.
//   index.ts:244  copy-out propagate arm, `await pending;` -> `void pending;`
//                 argv-only: CAUGHT (1)       whole file: CAUGHT (6)
//                 The argv-only catch is incidental — the rejection stops escaping `run()`.
//                 "THE PROPAGATING COPY-OUT IS AWAITED" is what names the teardown race.
//   index.ts:251  teardown, `await execFileAsync(… "rm","-f" …).catch(…)` -> `void …`
//                 argv-only: **SURVIVED**     whole file: CAUGHT (2)
//                 Also measured at exit 0 against the argv-only selection alone.
//
// AND THE MUTATION NO SINGLE-RUN TEST CAN SEE. Hoisting `const containerId` (index.ts:200) out of
// the `run()` body to module scope typechecks clean and is caught by exactly ONE case in this file,
// "TWO RUNS AT ONCE": measured at 1 failed | 51 passed, and the failure prints `container-1` having
// been addressed by ten steps and `container-2` by two.
//
// NOT OBSERVABLE HERE, STATED RATHER THAN GLOSSED. The suite proves each step is awaited BEFORE THE
// NEXT ONE IS ISSUED. It does NOT prove that the process the adapter waited on is the one that
// finished — a substrate settles a step when the test says so, not when a container really exits;
// only `managed-iac.integration.test.ts` (real Docker) can speak to that. It also says nothing
// about the plugins' own awaits AROUND `run()` (writing the workspace, reading the evidence back),
// which live in each plugin's suites, nor about `create`'s await being outside the `try` — that is
// a deliberate recorded defect with its own named test above, not an ordering property. And the
// concurrency case runs TWO runs, not N: it would not notice a limit, a pool or a lock that only
// misbehaves at higher concurrency, and it interleaves them at the points a test chooses rather
// than at the points a scheduler would.

/**
 * WHICH CONTAINER AN argv ADDRESSES — the Docker spelling of the port's per-run identity. Read off
 * the argv rather than tracked alongside it, so a step aimed at the wrong container is visible here
 * for the same reason it would be visible to the daemon. `create` addresses none, so it reports the
 * id it was ALLOCATED (`createdIds`, in issue order), which is what the run will go on to use.
 */
function stepIdentity(args: string[], createIndex: number): string | undefined {
  const sub = args[0];
  if (sub === "create") return createdIds[createIndex];
  // `start -a <id>` and `rm -f <id>`.
  if (sub === "start" || sub === "rm") return args[2];
  // `cp <id>:<path>/. <hostDir>` out, `cp <hostDir>/. <id>:<path>` in.
  if (sub === "cp") return String(isCopyOut(args) ? args[1] : args[2]).split(":")[0];
  return undefined;
}

function dockerOrderingSubstrate(): LaunchOrderingSubstrate {
  reset();
  // Every ordering case gets sequential ids, so identity is meaningful in all of them and the
  // concurrency case is not a special configuration nobody else exercises.
  createIdSequence = true;
  return {
    launcher: createDockerRunnerLauncher("docker"),
    baseSpec: () => spec(),
    issued: () => calls.map((c) => stepKind(c.args)),
    issuedIdentities: () => {
      let createIndex = 0;
      return calls.map((c) =>
        stepIdentity(c.args, c.args[0] === "create" ? createIndex++ : createIndex)
      );
    },
    hold: (kind, count = 1) => {
      holds[kind] += count;
    },
    release: (kind, failure, nth = 0) => {
      const matching = heldOpen.flatMap((held, index) => (held.kind === kind ? [index] : []));
      const index = matching[nth];
      if (index === undefined) {
        throw new Error(
          `docker-adapter.test: no held '${kind}' step at position ${nth} to release (${matching.length} held)`
        );
      }
      const [held] = heldOpen.splice(index, 1);
      held!.deliver(failure);
    }
  };
}

runLaunchOrderingConformanceSuite(
  "M23.1 conformance — the Docker adapter",
  dockerOrderingSubstrate
);
