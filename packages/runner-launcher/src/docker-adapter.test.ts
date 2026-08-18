import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
 * It drives {@link createDockerRunnerLauncher} **directly**, over the same spec shapes the fifteen
 * plugin goldens cover (4 iac + 6 scan + 5 dep — this file and BUILD_AND_TEST.md both said
 * "fourteen", and both were stale), and asserts the **recorded argv ARRAY** of every `execFile` — never a call
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
 *     rejected `rm` (swallowed), and — since M23.0's defect 1 was fixed — that a rejected `create`
 *     STILL tears down the NAME the caller chose. That last one was the opposite assertion until
 *     this milestone; it is INVERTED and renamed rather than deleted, so the invariant cannot
 *     regress in either direction unnoticed.
 *  5. WHAT HAPPENS WHEN THE LEVERS FIRE — the four shapes `promisify(execFile)` actually rejects
 *     with (timeout-kill, maxBuffer, spawn ENOENT, exit 125), on every step that can produce them.
 *     Points 2 and 4 assert that `timeout` and `maxBuffer` are PASSED; this is the only thing here
 *     that asserts what the adapter does when one of them goes off, and the shapes are measured
 *     against the running Node rather than imagined.
 *  6. THAT TWO RUNS IN FLIGHT NEVER ADDRESS EACH OTHER'S CONTAINER — in the parameterised ordering
 *     suite rather than in this file, so the M23.2 Kubernetes adapter inherits it.
 *  7. THAT NOTHING CARRYING A `secretEnv` VALUE LEAVES THIS PACKAGE — not on an argv, not in a
 *     returned `RunnerResult`, and not through any channel of a thrown `RunnerLaunchError`
 *     (`.message`, `String(err)`, `.stack`, `JSON.stringify`). The port is the only place that can
 *     assert this exactly rather than heuristically: it knows both the argv it built and which of
 *     those entries the caller declared secret.
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

/**
 * WHAT THE `--env-file` LOOKED LIKE WHILE `create` WAS IN FLIGHT.
 *
 * Read by the seam, synchronously, at the moment `create` is issued — which is the only moment it
 * can be read, because the adapter unlinks the file as soon as `create` returns. Asserting on it
 * afterwards would be asserting on nothing; asserting only that it is GONE afterwards would pass for
 * an adapter that never wrote it and never passed a credential at all. Both halves are needed and
 * only the seam is standing in the right place for the first one.
 *
 * `node:fs` is NOT mocked here — only `node:child_process` is — so these are real files in a real
 * temp directory.
 */
interface EnvFileSnapshot {
  path: string;
  content: string;
  /** The permission bits, masked to the low 9 — 0o600 means owner-only. */
  mode: number;
}
const envFileSnapshots: EnvFileSnapshot[] = [];

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
 * `--name` -> the id that `create` allocated for it. Recorded by the seam because only the seam sees
 * both, and read by {@link stepIdentity} so a teardown-by-name is comparable with a step-by-id.
 */
const nameToId = new Map<string, string>();

// ==================================================================================================
// M23.1 PHASE 4 — THE REAPER'S OWN SIDE CHANNEL.
// ==================================================================================================
// `reap()` now runs at the top of every `run()`, which means every test in this file that calls
// `run()` ALSO issues one more `execFile` — `docker ps -a --filter label=scp.launcher.owner` — and
// `create` now always carries two more `--label` pairs. Every existing assertion in this file pins
// `calls` as the LITERAL create/cp/start/rm sequence, so both of those would break every one of them
// for a reason unrelated to what each test is actually about. Both are therefore diverted into their
// OWN side channels here, verified by their OWN dedicated describe block below, and kept out of
// `calls` entirely — the same reasoning as `envFileSnapshots` above for the transient `--env-file`
// path: asserting on the stripped-out value in place would be asserting on nothing, so it is
// captured where it can still be seen and checked on its own terms.

/** `docker ps -a --filter label=...` calls issued by `reap()` — one per `run()`, none of them in
 *  `calls`. */
const reapListCalls: { args: string[]; opts: unknown }[] = [];
/** EVERY `execFile` subcommand issued, `ps` included, in ISSUE order — unlike `calls`/`reapListCalls`
 *  which each drop the other's kind, this is the one place that can show `reap()`'s `ps` truly
 *  precedes `create` rather than merely having happened at some point. */
const issueOrder: string[] = [];
/** What `docker ps -a` reports back to `reap()`. Empty by default (nothing to reap), so an ordinary
 *  test's `run()` triggers zero follow-on `rm` calls from `reap()` and `calls` stays exactly what it
 *  always was. One `id\towner\tdeadline` line per container, matching the `--format` string `reap()`
 *  actually requests — set this to drive the predicate tests below. */
let reapPsStdout = "";
/** When set, `reap()`'s OWN `docker ps -a` call rejects with this instead of succeeding — the
 *  failure-injection arm for `reap()`'s listing step, undefined (succeeds) everywhere else. */
let reapPsFailure: Error | undefined;
/** `create`'s two `scp.launcher.*` labels, popped off the recorded argv before it reaches `calls` —
 *  one entry per `create` call, in issue order. */
const createLauncherLabels: { owner?: string; deadline?: string }[] = [];

/** Finds one `--label key=value` pair and returns its value plus the argv with that pair removed —
 *  or `undefined` if `key` is not present, leaving `args` untouched. */
function extractLabel(args: string[], key: string): { value: string; rest: string[] } | undefined {
  const flagIndex = args.findIndex(
    (a, i) => a === "--label" && (args[i + 1] ?? "").startsWith(`${key}=`)
  );
  if (flagIndex === -1) return undefined;
  const value = (args[flagIndex + 1] ?? "").slice(key.length + 1);
  return { value, rest: [...args.slice(0, flagIndex), ...args.slice(flagIndex + 2)] };
}

/** Pops both `scp.launcher.*` labels off a `create` call's argv, recording what was popped into
 *  {@link createLauncherLabels}, and returns the argv every OTHER test in this file still expects. */
function popLauncherLabelsForRecording(rawArgs: string[]): string[] {
  let rest = rawArgs;
  const owner = extractLabel(rest, RUNNER_LAUNCHER_OWNER_LABEL);
  if (owner) rest = owner.rest;
  const deadline = extractLabel(rest, RUNNER_LAUNCHER_DEADLINE_LABEL);
  if (deadline) rest = deadline.rest;
  if (owner || deadline) {
    createLauncherLabels.push({ owner: owner?.value, deadline: deadline?.value });
  }
  return rest;
}

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
 * What a SUCCESSFUL `start` prints, when a case cares. Default `undefined` keeps the literal
 * `runner ok`/`runner warned` every other assertion in this file pins.
 */
let startBehaviourOk: { stdout: string; stderr: string } | undefined;

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
      cb(null, startBehaviourOk ?? { stdout: "runner ok", stderr: "runner warned" });
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
      // `reap()`'s own list call — diverted to its side channel, never `calls`. See the block
      // comment above `reapListCalls`.
      issueOrder.push(String(args[0]));
      if (args[0] === "ps") {
        reapListCalls.push({ args, opts });
        const failure = reapPsFailure;
        setImmediate(() =>
          failure ? cb(failure) : cb(null, { stdout: reapPsStdout, stderr: "" })
        );
        return;
      }

      calls.push({
        file,
        args: args[0] === "create" ? popLauncherLabelsForRecording(args) : args,
        opts
      });
      const envFileIndex = args.indexOf("--env-file");
      if (envFileIndex !== -1) {
        const path = String(args[envFileIndex + 1]);
        envFileSnapshots.push({
          path,
          content: readFileSync(path, "utf8"),
          mode: statSync(path).mode & 0o777
        });
      }
      const kind = stepKind(args);
      // ALLOCATED AT ISSUE TIME, not at delivery: a `create` that is being HELD OPEN still has a
      // knowable identity, and two concurrent runs are then never handed the same one whatever
      // order their creates settle in.
      let createOut = createStdout;
      if (kind === "create") {
        if (createIdSequence) createOut = `  container-${createdIds.length + 1} \n`;
        createdIds.push(createOut.trim());
        const named = args[args.indexOf("--name") + 1];
        if (named !== undefined) nameToId.set(named, createOut.trim());
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
  RUNNER_CONTAINER_NAME_PREFIX,
  RUNNER_LAUNCHER_DEADLINE_LABEL,
  RUNNER_LAUNCHER_OWNER_LABEL,
  RUNNER_REAP_GRACE_MS,
  RUNNER_REMOVE_TIMEOUT_MS,
  RUNNER_RUN_ID_PATTERN,
  RunnerLaunchError,
  createDockerRunnerLauncher,
  resolveDockerRunnerLauncher,
  runnerContainerName,
  toRunnerRunId
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

/**
 * A minimal, entirely explicit spec. Every test below overrides only what it is about.
 *
 * `runId` IS A FIXED LITERAL, and `labels` EMPTY, so that the argv assertions stay readable and so
 * that a spurious label is a visible extra pair rather than noise. The ordering substrate at the
 * bottom overrides `runId` per run — two concurrent runs must not share a container NAME any more
 * than they may share a container id, and the case that proves it needs distinct ones.
 */
function spec(overrides: Partial<RunnerSpec> = {}): RunnerSpec {
  return {
    runId: "r1",
    labels: {},
    image: "scp-runner-iac:vetted",
    operands: [],
    networkMode: "none",
    env: [],
    secretEnv: [],
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
  nameToId.clear();
  envFileSnapshots.length = 0;
  startBehaviourOk = undefined;
  for (const kind of Object.keys(stepFails) as RunnerStepKind[]) delete stepFails[kind];
  reapListCalls.length = 0;
  reapPsStdout = "";
  reapPsFailure = undefined;
  createLauncherLabels.length = 0;
  issueOrder.length = 0;
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
          "--name",
          "scp-runner-r1",
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
        args: ["rm", "-f", "scp-runner-r1"],
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
        args: [
          "create",
          "--network",
          "none",
          "--name",
          "scp-runner-r1",
          "scp-runner-dep:vetted",
          "npm"
        ],
        opts: IAC_OPTS
      },
      { file: "docker", args: ["start", "-a", "container-abc123"], opts: IAC_OPTS },
      { file: "docker", args: ["rm", "-f", "scp-runner-r1"], opts: RM_OPTS }
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
      ["create", "--network", "none", "--name", "scp-runner-r1", "scp-runner-iac:vetted"],
      ["cp", "/host/in/.", "container-xyz:/work/in"],
      ["start", "-a", "container-xyz"],
      ["cp", "container-xyz:/work/out/.", "/host/out"],
      ["rm", "-f", "scp-runner-r1"]
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
    // The tenant-suppliable field on two of the three callers. 123456 is the value the goldens use
    // for their maximal case; `rm` must still be the 30 s constant.
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
      ["create", "--network", "none", "--name", "scp-runner-r1", "scp-runner-iac:vetted"],
      ["start", "-a", "container-abc123"],
      ["cp", "container-abc123:/work/out/.", "/host/out"],
      ["rm", "-f", "scp-runner-r1"]
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
      ["create", "--network", "none", "--name", "scp-runner-r1", "scp-runner-iac:vetted"],
      ["start", "-a", "container-abc123"],
      ["cp", "container-abc123:/work/out/.", "/host/out"],
      ["rm", "-f", "scp-runner-r1"]
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
      ["create", "--network", "none", "--name", "scp-runner-r1", "scp-runner-iac:vetted"],
      ["start", "-a", "container-abc123"],
      ["rm", "-f", "scp-runner-r1"]
    ]);
    expect(result.succeeded).toBe(false);
  });

  it("`when: on-success` + a SUCCESSFUL start — the copy-out IS issued", async () => {
    // Without this arm, an adapter that never copied out under `on-success` would pass the one above.
    await createDockerRunnerLauncher("docker").run(
      spec({ copyOut: { ...OUT_PATHS, when: "on-success", onFailure: "propagate" } })
    );
    expect(calls.map((c) => c.args)).toStrictEqual([
      ["create", "--network", "none", "--name", "scp-runner-r1", "scp-runner-iac:vetted"],
      ["start", "-a", "container-abc123"],
      ["cp", "container-abc123:/work/out/.", "/host/out"],
      ["rm", "-f", "scp-runner-r1"]
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
      ["create", "--network", "none", "--name", "scp-runner-r1", "scp-runner-iac:vetted"],
      ["start", "-a", "container-abc123"],
      ["cp", "container-abc123:/work/out/.", "/host/out"],
      ["rm", "-f", "scp-runner-r1"]
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
      ["create", "--network", "none", "--name", "scp-runner-r1", "scp-runner-iac:vetted"],
      ["start", "-a", "container-abc123"],
      ["cp", "container-abc123:/work/out/.", "/host/out"],
      ["rm", "-f", "scp-runner-r1"]
    ]);
  });
});

describe("M23.1 conformance: the failure paths, and the identity every one of them tears down", () => {
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
      ["create", "--network", "none", "--name", "scp-runner-r1", "scp-runner-iac:vetted"],
      ["cp", "/host/in/.", "container-abc123:/work/in"],
      ["rm", "-f", "scp-runner-r1"]
    ]);
  });

  it("A REJECTED `rm` IS SWALLOWED — the run's own result still comes back", async () => {
    // Teardown is best-effort by design: a container the daemon already reaped must not turn a
    // succeeded run into a failed one.
    fail("teardown");
    const result = await createDockerRunnerLauncher("docker").run(spec());

    expect(result).toStrictEqual({ succeeded: true, stdout: "runner ok", stderr: "runner warned" });
    expect(calls.map((c) => c.args)).toStrictEqual([
      ["create", "--network", "none", "--name", "scp-runner-r1", "scp-runner-iac:vetted"],
      ["start", "-a", "container-abc123"],
      ["rm", "-f", "scp-runner-r1"]
    ]);
  });

  it("a create that REJECTS after the daemon committed still issues rm -f for the NAME the caller chose", async () => {
    // ================================================================================================
    // M23.0's DEFECT 1, FIXED — AND THIS TEST IS THE INVERSION OF THE ONE THAT PINNED IT.
    // ================================================================================================
    // It used to be named "THE RECORDED DEFECT — a REJECTED `create` issues NO `rm`, because its
    // await is outside the `try`", and it asserted that the ONLY call was the `create`. That was the
    // honest record of a real bug: a `create` that times out after the daemon already made the
    // container leaves it behind, unattributed and un-reaped. It is INVERTED rather than deleted,
    // because the invariant it now states is the one that must not silently regress in either
    // direction.
    //
    // AND IT DOES NOT INHERIT THE OLD FILE'S ADVICE. That test's comment said the right fix was to
    // "move that `await` inside the `try`". IT IS NOT, and this file was wrong about its own subject:
    // moving the await alone leaves `containerId` unbound when `create` rejects, so the `finally`
    // issues `rm -f undefined` — measured against a real daemon (Docker 29.5.2), `docker rm -f` on a
    // name that does not exist EXITS ZERO, so that call is not even a visible failure. It repairs
    // nothing, it reaches no orphan, and it breaks this test. The fix needs BOTH halves: a name
    // computed BEFORE `create` is issued, and `create` inside the `try`.
    //
    // THE DELETE-THE-WIRING CHECK FOR THAT FIX, MEASURED (each mutation applied alone, whole file
    // re-run):
    //   teardown addresses `containerId` again        -> RED here (a `rm -f undefined` is recorded)
    //   `create`'s await moves back outside the `try` -> RED here (no `rm` at all is recorded)
    fail("create");
    await expect(createDockerRunnerLauncher("docker").run(spec())).rejects.toThrow(/no such image/);

    expect(
      calls.map((c) => c.args),
      "a create that failed left no teardown for the container the daemon may already have made"
    ).toStrictEqual([
      ["create", "--network", "none", "--name", "scp-runner-r1", "scp-runner-iac:vetted"],
      ["rm", "-f", "scp-runner-r1"]
    ]);
  });

  it("THE NAME IS THE CALLER'S runId, NOT ANYTHING THE ADAPTER MINTED", async () => {
    // The half of 1a a `--name` assertion alone cannot show: the string comes from the SPEC. An
    // adapter that minted its own (a UUID, the image name, a counter) passes every argv assertion
    // above that hard-codes `scp-runner-r1` only because `spec()` happens to say `r1`.
    await createDockerRunnerLauncher("docker").run(spec({ runId: "iac-prod-eu-west-1" }));

    expect(runnerContainerName("iac-prod-eu-west-1")).toBe("scp-runner-iac-prod-eu-west-1");
    expect(RUNNER_CONTAINER_NAME_PREFIX).toBe("scp-runner-");
    expect(calls.map((c) => c.args)).toStrictEqual([
      [
        "create",
        "--network",
        "none",
        "--name",
        "scp-runner-iac-prod-eu-west-1",
        "scp-runner-iac:vetted"
      ],
      ["start", "-a", "container-abc123"],
      ["rm", "-f", "scp-runner-iac-prod-eu-west-1"]
    ]);
  });

  it("A runId THAT IS NOT DNS-SAFE IS REFUSED BEFORE ANY CONTAINER EXISTS — never sanitised", async () => {
    // Sanitising here is the trap: `prod/eu-west-1` and `prod-eu-west-1` would become one name, and
    // two runs would then fight over one container — one losing its `create` to a name conflict and
    // the other losing its container to the loser's teardown. The refusal is fail-closed and issues
    // NOTHING, so there is no container and no teardown to get wrong.
    await expect(
      createDockerRunnerLauncher("docker").run(spec({ runId: "prod/eu-west-1" }))
    ).rejects.toThrow(/not DNS-safe/);
    expect(calls, "a refused spec still reached the daemon").toStrictEqual([]);

    // ...and the helper the callers are told to use produces something the pattern accepts, for the
    // same input, WITHOUT collapsing two distinct keys onto one name.
    expect(toRunnerRunId("prod/eu-west-1")).toMatch(RUNNER_RUN_ID_PATTERN);
    expect(toRunnerRunId("prod/eu-west-1")).not.toBe(toRunnerRunId("prod-eu-west-1"));
    // Deterministic, which is what makes managed-iac's retry land on the same container name.
    expect(toRunnerRunId("prod/eu-west-1")).toBe(toRunnerRunId("prod/eu-west-1"));
    expect(toRunnerRunId("k1")).toBe("k1");
    expect(toRunnerRunId("x".repeat(300))).toMatch(RUNNER_RUN_ID_PATTERN);
    expect(toRunnerRunId("///")).toMatch(RUNNER_RUN_ID_PATTERN);
  });

  it("LABELS ARE EMITTED IN INSERTION ORDER, one `--label k=v` each, after `--name` and before `-e`", async () => {
    // The attribution half of M23.0's defect 1: an orphan with no label cannot be swept for. ORDER is
    // asserted because the Kubernetes arm (M23.2) must put the same pairs in `metadata.labels`, and
    // because an adapter that sorted them would make the goldens depend on key spelling.
    await createDockerRunnerLauncher("docker").run(
      spec({
        labels: { "scp.executor": "scp-managed-iac", "scp.run-id": "r1" },
        env: ["PRIOR_STATE_FILE=state-history/x.tfstate"]
      })
    );

    expect(calls[0]!.args).toStrictEqual([
      "create",
      "--network",
      "none",
      "--name",
      "scp-runner-r1",
      "--label",
      "scp.executor=scp-managed-iac",
      "--label",
      "scp.run-id=r1",
      "-e",
      "PRIOR_STATE_FILE=state-history/x.tfstate",
      "scp-runner-iac:vetted"
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

/**
 * WHAT SURVIVES THE WRAP. Since the argv-leak fix these arms can no longer assert
 * `rejects.toBe(err)` — the adapter never rethrows the original, precisely so `err.message`'s
 * `Command failed: docker create … -e AWS_SECRET_ACCESS_KEY=…` cannot cross the plugin-host RPC
 * boundary. That makes it possible to LOSE the diagnosis while looking correct, so this asserts the
 * opposite direction: the wrapper is a `RunnerLaunchError` for the right STEP, and Node's own
 * `code`/`killed`/`signal` and the original's own words all came across. A wrapper that dropped them
 * would turn "our own timeout SIGTERM'd it" into an indistinguishable blank, which is the whole
 * reason the shapes table exists.
 */
function expectWrapped(err: unknown, step: string, original: Error): true {
  expect(err, "the adapter rethrew a raw execFile error, argv and all").toBeInstanceOf(
    RunnerLaunchError
  );
  const e = err as InstanceType<typeof RunnerLaunchError>;
  expect(e.step, "the failure was attributed to the wrong step").toBe(step);
  const o = original as unknown as { code?: unknown; killed?: unknown; signal?: unknown };
  expect(
    { code: e.code, killed: e.killed, signal: e.signal },
    "the wrapper dropped the diagnosis Node produced"
  ).toStrictEqual({ code: o.code, killed: o.killed, signal: o.signal });
  expect(e.message, "the wrapper lost the original failure's own words").toContain(
    original.message
  );
  return true;
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
        ["create", "--network", "none", "--name", "scp-runner-r1", "scp-runner-iac:vetted"],
        ["start", "-a", "container-abc123"],
        ["rm", "-f", "scp-runner-r1"]
      ]);
    }
  );

  it.each(NODE_FAILURE_SHAPES)(
    "$name at `create` → REJECTS out of run(), and STILL tears the NAME down",
    async ({ make }) => {
      // M23.0's defect 1, held for every shape rather than only for "no such image" — and the
      // TIMEOUT row is the one that matters: `create` timing out is precisely the case where the
      // daemon may already have made a container, and it used to be precisely the case with no `rm`.
      const err = make();
      fail("create", err);

      await expect(createDockerRunnerLauncher("docker").run(spec())).rejects.toSatisfy(
        (thrown: unknown) => expectWrapped(thrown, "create", err)
      );

      expect(
        calls.map((c) => c.args),
        "a create that failed this way left no teardown for the container the daemon may already have made"
      ).toStrictEqual([
        ["create", "--network", "none", "--name", "scp-runner-r1", "scp-runner-iac:vetted"],
        ["rm", "-f", "scp-runner-r1"]
      ]);
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
      ).rejects.toSatisfy((thrown: unknown) => expectWrapped(thrown, "copy-in", err));

      expect(calls.map((c) => c.args)).toStrictEqual([
        ["create", "--network", "none", "--name", "scp-runner-r1", "scp-runner-iac:vetted"],
        ["cp", "/host/in/.", "container-abc123:/work/in"],
        ["rm", "-f", "scp-runner-r1"]
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
        ["create", "--network", "none", "--name", "scp-runner-r1", "scp-runner-iac:vetted"],
        ["start", "-a", "container-abc123"],
        ["cp", "container-abc123:/work/out/.", "/host/out"],
        ["rm", "-f", "scp-runner-r1"]
      ]);

      reset();
      const propagated = make();
      fail("copy-out", propagated);
      await expect(
        createDockerRunnerLauncher("docker").run(
          spec({ copyOut: { ...OUT_PATHS, when: "always", onFailure: "propagate" } })
        )
      ).rejects.toSatisfy((thrown: unknown) => expectWrapped(thrown, "copy-out", propagated));
      expect(calls.map((c) => c.args)).toStrictEqual([
        ["create", "--network", "none", "--name", "scp-runner-r1", "scp-runner-iac:vetted"],
        ["start", "-a", "container-abc123"],
        ["cp", "container-abc123:/work/out/.", "/host/out"],
        ["rm", "-f", "scp-runner-r1"]
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
        ["create", "--network", "none", "--name", "scp-runner-r1", "scp-runner-iac:vetted"],
        ["start", "-a", "container-abc123"],
        ["rm", "-f", "scp-runner-r1"]
      ]);
    }
  );
});

// ==================================================================================================
// SECRETS — the `secretEnv` split, and the promise that nothing carrying one ever leaves this file.
// ==================================================================================================
//
// WHAT THESE PROVE, AND THE MUTATION EACH ONE ANSWERS (every mutation applied alone to a clean tree,
// the whole file re-run):
//
//   secretEnv goes back through `flatMap(e => ["-e", e])`   -> RED: "no value from secretEnv appears
//                                                              anywhere in any recorded argv"
//   the create catch rethrows the original error            -> RED: "a rejected create throws a
//                                                              RunnerLaunchError whose message
//                                                              contains no secret value"
//   the wrapper keeps the original as `cause`               -> RED: the same test's `err.stack` arm
//   the `--env-file` is never unlinked                      -> RED: "the env-file is gone by the time
//                                                              `create` has returned"
//   the env-file is written 0o644 instead of 0o600          -> RED: the same test's mode arm
//   `env` is routed through `--env-file` too                -> RED: "a spec with NO secretEnv emits
//                                                              NO --env-file"
//
// WHAT THEY CANNOT PROVE is stated with the rest at the bottom of this file.

describe("M23.1 conformance: secretEnv never reaches the command line, and never leaves in an error", () => {
  const SECRET = "AKIAEXAMPLE/s3cr3t+value";
  const OTHER_SECRET = "wJalrXUtnFEMI-K7MDENG-bPxRfiCYEXAMPLEKEY";
  let stateDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "runner-launcher-secret-env-"));
  });

  function secretSpec(overrides: Partial<RunnerSpec> = {}): RunnerSpec {
    return spec({
      env: ["PRIOR_STATE_FILE=state-history/2026-08-17.tfstate"],
      secretEnv: [`AWS_ACCESS_KEY_ID=${SECRET}`, `AWS_SECRET_ACCESS_KEY=${OTHER_SECRET}`],
      secretEnvDir: stateDir,
      ...overrides
    });
  }

  /** Every string the adapter put on any command line, flattened — argv elements AND the binary. */
  function everyRecordedString(): string[] {
    return calls.flatMap((c) => [c.file, ...c.args]);
  }

  it("no value from secretEnv appears anywhere in any recorded argv", async () => {
    // THE CENTRAL CLAIM OF 1c, asserted over EVERY element of EVERY call rather than over the create
    // line — a future step that started echoing the spec would be caught here and nowhere else.
    await createDockerRunnerLauncher("docker").run(
      secretSpec({
        copyIn: [{ hostDir: "/host/in", containerPath: "/workspace" }],
        copyOut: {
          containerPath: "/workspace",
          hostDir: "/host/out",
          when: "always",
          onFailure: "swallow"
        }
      })
    );

    for (const element of everyRecordedString()) {
      expect(element, `a docker argv carried a secret VALUE: ${element}`).not.toContain(SECRET);
      expect(element, `a docker argv carried a secret VALUE: ${element}`).not.toContain(
        OTHER_SECRET
      );
    }
    // ...and it is NOT vacuous: the run really happened, the non-secret env really is still `-e`,
    // and the secrets really were delivered — through the env-file, whose contents the seam read.
    expect(calls.map((c) => c.args[0])).toStrictEqual(["create", "cp", "start", "cp", "rm"]);
    expect(calls[0]!.args).toContain("-e");
    expect(calls[0]!.args).toContain("PRIOR_STATE_FILE=state-history/2026-08-17.tfstate");
    expect(envFileSnapshots).toHaveLength(1);
    expect(envFileSnapshots[0]!.content).toBe(
      `AWS_ACCESS_KEY_ID=${SECRET}\nAWS_SECRET_ACCESS_KEY=${OTHER_SECRET}\n`
    );
  });

  it("THE create LINE — `--env-file` sits where the `-e` secret pairs used to, before the non-secret ones", async () => {
    await createDockerRunnerLauncher("docker").run(
      secretSpec({ labels: { "scp.executor": "scp-managed-iac" }, operands: ["rollback"] })
    );

    const path = envFileSnapshots[0]!.path;
    expect(calls[0]!.args).toStrictEqual([
      "create",
      "--network",
      "none",
      "--name",
      "scp-runner-r1",
      "--label",
      "scp.executor=scp-managed-iac",
      // WHERE THE TWO `-e AWS_*` PAIRS USED TO BE, and BEFORE the surviving non-secret `-e`, so that
      // an explicit `-e` still wins over an env-file entry of the same name (docker's own precedence).
      "--env-file",
      path,
      "-e",
      "PRIOR_STATE_FILE=state-history/2026-08-17.tfstate",
      "scp-runner-iac:vetted",
      "rollback"
    ]);
  });

  it("the env-file is 0600 while `create` runs and GONE by the time `create` has returned", async () => {
    // THE PARTIAL FIX, MEASURED AS PARTIAL. This does not claim the credential is unreachable — it is
    // in `docker inspect` for the container's life, and it is on a disk for the duration of one
    // `create`. It claims exactly the two things that ARE true: owner-only while it exists, and it
    // does not outlive the call.
    await createDockerRunnerLauncher("docker").run(secretSpec());

    expect(envFileSnapshots, "no env-file was ever written").toHaveLength(1);
    expect(envFileSnapshots[0]!.mode, "the env-file was readable by other local users").toBe(0o600);
    expect(
      existsSync(envFileSnapshots[0]!.path),
      "the env-file outlived the `create` that needed it"
    ).toBe(false);
  });

  it("the env-file is unlinked ON THE FAILURE PATH TOO — a create that rejects leaves no credential on disk", async () => {
    // The arm that a `finally` and a trailing `await unlink(...)` differ on, and the one an operator
    // only discovers by finding the file months later.
    fail("create");
    await expect(createDockerRunnerLauncher("docker").run(secretSpec())).rejects.toThrow(
      RunnerLaunchError
    );

    expect(envFileSnapshots).toHaveLength(1);
    expect(
      existsSync(envFileSnapshots[0]!.path),
      "a failed create left the credential file behind"
    ).toBe(false);
  });

  it("a rejected create throws a RunnerLaunchError whose message contains no secret value", async () => {
    // ================================================================================================
    // 1d — THE HIGHER-VALUE HALF, AND THE ONE THE PRODUCT ACTUALLY LEAKED THROUGH.
    // ================================================================================================
    // `promisify(execFile)` rejects with `Command failed: docker create --network none -e
    // AWS_SECRET_ACCESS_KEY=… …` as its MESSAGE. That message is what `subprocess-entry.ts` serialises
    // across the plugin-host RPC boundary — it serialises `err.message` and nothing else — and what
    // reaches `console.error`. So every channel that can carry it is checked, not just the one that is
    // convenient: `.message`, `String(err)`, `.stack` (which embeds the message, and which would embed
    // a `cause`'s stack too), and `JSON.stringify` (which sees own ENUMERABLE properties, so the
    // wrapper's `argv`, `stdout` and `stderr` are all in scope).
    const shape = Object.assign(
      new Error(
        `Command failed: docker create --network none -e AWS_SECRET_ACCESS_KEY=${OTHER_SECRET} scp-runner-iac:vetted plan\n`
      ),
      { code: 125, killed: false, signal: null, stdout: SECRET, stderr: OTHER_SECRET }
    );
    fail("create", shape);

    let thrown: unknown;
    try {
      await createDockerRunnerLauncher("docker").run(secretSpec());
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(RunnerLaunchError);
    const err = thrown as InstanceType<typeof RunnerLaunchError>;
    const channels: Record<string, string> = {
      "err.message": err.message,
      "String(err)": String(err),
      "err.stack": err.stack ?? "",
      "JSON.stringify(err)": JSON.stringify(err),
      "err.argv.join": err.argv.join(" "),
      "err.stdout": err.stdout,
      "err.stderr": err.stderr
    };
    for (const [name, text] of Object.entries(channels)) {
      expect(text, `${name} carried a secret VALUE`).not.toContain(SECRET);
      expect(text, `${name} carried a secret VALUE`).not.toContain(OTHER_SECRET);
      // The `--env-file` PATH is redacted too: it is the one argv element that points AT the
      // credential, and a path is exactly the kind of thing that gets pasted into a shell.
      expect(text, `${name} carried the env-file path`).not.toContain(envFileSnapshots[0]!.path);
    }

    // NOT VACUOUS — the redaction marker is present, the diagnosis survived, and the message still
    // says what failed. A wrapper that replaced everything with "an error occurred" would satisfy
    // every `not.toContain` above.
    expect(err.message).toContain("***");
    expect(err.message).toContain("managed runner create failed");
    expect(err.message).toContain("Command failed: docker create");
    expect({ code: err.code, killed: err.killed, signal: err.signal }).toStrictEqual({
      code: 125,
      killed: false,
      signal: null
    });
  });

  it("A FAILED `start` IS CAPTURED WITH ITS SECRETS REDACTED — the run's own result is a channel too", async () => {
    // `run()` RETURNS this one rather than throwing it, and the plugins put it straight into a
    // Decision's `detail` (charter principle 6). managed-iac redacts it again on its own way out;
    // that is belt-and-braces, not the control — a fourth managed plugin would inherit nothing.
    fail(
      "start",
      startExitFailure({ stdout: `plan wrote ${SECRET}`, stderr: `tofu: ${OTHER_SECRET} rejected` })
    );

    const result = await createDockerRunnerLauncher("docker").run(secretSpec());

    expect(result).toStrictEqual({
      succeeded: false,
      stdout: "plan wrote ***",
      stderr: "tofu: *** rejected"
    });
  });

  it("A SUCCEEDED run's stdout and stderr are redacted TOO — success is not a safe channel", async () => {
    // FOUND BY MUTATION, NOT BY READING. Dropping `redact()` from the SUCCESS arm of `start` survived
    // the whole suite: every secret case above drove a FAILURE, so the one path a real `tofu plan`
    // takes every day was the one path with no assertion on it. A provider that echoes its own
    // credential into a plan summary — or a runner that prints its environment on `--debug` — lands
    // in `RunnerResult.stdout`, which the plugins put straight into a Decision (charter principle 6).
    startBehaviourOk = { stdout: `applied with ${SECRET}`, stderr: `warning: ${OTHER_SECRET}` };

    const result = await createDockerRunnerLauncher("docker").run(secretSpec());

    expect(result).toStrictEqual({
      succeeded: true,
      stdout: "applied with ***",
      stderr: "warning: ***"
    });
  });

  it("a spec with NO secretEnv emits NO `--env-file` — managed-scan's five golden create lines cannot move", async () => {
    // THE NEGATIVE THAT KEEPS 1c HONEST. managed-scan's `SCP_SCAN_DB_DIR`/`SCP_SCAN_SCAP_DIR` are
    // container PATHS, not secrets, so they stay in `env` and its goldens must not change by a byte
    // beyond the name/label. An adapter that routed `env` through the env-file too would break every
    // one of them — and would ALSO put a file on disk for a run that needs none.
    await createDockerRunnerLauncher("docker").run(
      spec({
        image: "scp-runner-scan:vetted",
        operands: ["trivy-vm"],
        env: ["SCP_SCAN_DB_DIR=/work/db"],
        secretEnv: [],
        secretEnvDir: stateDir
      })
    );

    expect(calls[0]!.args).toStrictEqual([
      "create",
      "--network",
      "none",
      "--name",
      "scp-runner-r1",
      "-e",
      "SCP_SCAN_DB_DIR=/work/db",
      "scp-runner-scan:vetted",
      "trivy-vm"
    ]);
    expect(envFileSnapshots, "an env-file was written for a run with no secrets").toStrictEqual([]);
    expect(calls.flatMap((c) => c.args)).not.toContain("--env-file");
  });

  it("secretEnv WITHOUT secretEnvDir IS REFUSED — the adapter never picks a directory of its own", async () => {
    // `os.tmpdir()` is shared with every other local user; "somewhere sensible" is not a decision an
    // adapter gets to make about where a credential lands. Fail-closed, before any container.
    await expect(
      createDockerRunnerLauncher("docker").run(
        spec({ secretEnv: ["AWS_SECRET_ACCESS_KEY=x"], secretEnvDir: undefined })
      )
    ).rejects.toThrow(/secretEnv was supplied without secretEnvDir/);
    expect(calls).toStrictEqual([]);
  });

  it("A NEWLINE IN A secretEnv VALUE IS REFUSED — one entry must never become two variables", async () => {
    // An env-file line is `KEY=VALUE` to end of line, unquoted. A `\n` inside a value silently
    // DEFINES ANOTHER VARIABLE in the runner's environment, which is an injection from whatever
    // produced the secret — a secret store, or a tenant who got to write one.
    await expect(
      createDockerRunnerLauncher("docker").run(
        secretSpec({ secretEnv: ["AWS_SECRET_ACCESS_KEY=x\nLD_PRELOAD=/tmp/evil.so"] })
      )
    ).rejects.toThrow(/single-line KEY=VALUE/);
    expect(calls).toStrictEqual([]);
    expect(envFileSnapshots).toStrictEqual([]);
  });

  it("THE REFUSAL MESSAGES CARRY NO SECRET — a fail-closed path is a channel like any other", async () => {
    // The refusal above names the offending entry. It must name the KEY and not the VALUE, or the
    // fail-closed path becomes the leak the success path no longer is.
    let thrown: unknown;
    try {
      await createDockerRunnerLauncher("docker").run(
        secretSpec({ secretEnv: [`AWS_SECRET_ACCESS_KEY=${OTHER_SECRET}\nLD_PRELOAD=x`] })
      );
    } catch (err) {
      thrown = err;
    }
    const err = thrown as Error;
    expect(err.message).toContain("AWS_SECRET_ACCESS_KEY");
    expect(err.message).not.toContain(OTHER_SECRET);
    expect(JSON.stringify(err)).not.toContain(OTHER_SECRET);
  });

  it("SECRETS SURVIVE A RETRY BY NAME — the same runId is the same container name, twice", async () => {
    // managed-iac derives `runId` from `intent.idempotencyKey` exactly so a retry addresses the same
    // container. Two runs of the same spec must therefore produce the same `--name` and the same
    // teardown target — and a DIFFERENT env-file path each time, because the first was unlinked.
    await createDockerRunnerLauncher("docker").run(secretSpec());
    const firstPath = envFileSnapshots[0]!.path;
    await createDockerRunnerLauncher("docker").run(secretSpec());

    const names = calls
      .filter((c) => c.args[0] === "create")
      .map((c) => c.args[c.args.indexOf("--name") + 1]);
    expect(names).toStrictEqual(["scp-runner-r1", "scp-runner-r1"]);
    expect(calls.filter((c) => c.args[0] === "rm").map((c) => c.args)).toStrictEqual([
      ["rm", "-f", "scp-runner-r1"],
      ["rm", "-f", "scp-runner-r1"]
    ]);
    expect(envFileSnapshots[1]!.path).not.toBe(firstPath);
  });

  it("CLEANUP: the state dir holds nothing after every case above", () => {
    // A guard on this describe's own housekeeping. If a case leaked a file, the assertion that the
    // adapter unlinks would be the only thing standing between a credential and a stale disk.
    rmSync(stateDir, { recursive: true, force: true });
    expect(existsSync(stateDir)).toBe(false);
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
// which live in each plugin's suites, nor about WHERE `create`'s await sits relative to the `try` —
// that has its own named test above ("a create that REJECTS after the daemon committed…"), and it is
// a teardown-reachability property rather than an ordering one. And the
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
  // TEARDOWN ADDRESSES THE NAME, every other step the id (index.ts, "TWO IDENTITIES, ON PURPOSE").
  // Translated back to the id here rather than left as a second identity, because the property the
  // ordering suite tests is "each run tore down ITS OWN container" — and a teardown aimed at the
  // WRONG run's name now maps to the wrong id and fails, which is exactly what should happen.
  if (sub === "rm") return nameToId.get(String(args[2])) ?? String(args[2]);
  // `start -a <id>`.
  if (sub === "start") return args[2];
  // `cp <id>:<path>/. <hostDir>` out, `cp <hostDir>/. <id>:<path>` in.
  if (sub === "cp") return String(isCopyOut(args) ? args[1] : args[2]).split(":")[0];
  return undefined;
}

function dockerOrderingSubstrate(): LaunchOrderingSubstrate {
  reset();
  // Every ordering case gets sequential ids AND a distinct runId per run, so identity is meaningful
  // in all of them and the concurrency case is not a special configuration nobody else exercises.
  createIdSequence = true;
  let runIdSequence = 0;
  return {
    launcher: createDockerRunnerLauncher("docker"),
    baseSpec: () => spec({ runId: `r${++runIdSequence}` }),
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

// ====================================================================================================
// M23.1 PHASE 4 — THE REAPER. See `RunnerLauncher.reap`'s own doc in index.ts for the defect this
// closes, and `reaper.integration.test.ts` for why THIS suite (mocked `execFile`, no real Docker
// daemon) cannot be the proof: it cannot show that a killed process leaves a container behind, that a
// label survives on it, or that a real `docker ps --filter` actually finds it. What it CAN prove,
// cheaply and on every PR, is the shape of what `reap()` sends and the LOGIC of its predicate —
// exactly the two things a real-Docker test would be slow and awkward to drive through every branch
// of.
// ====================================================================================================

describe("M23.1 phase 4: every `create` stamps the reaper's own two labels", () => {
  it("the owner is a UUID; the deadline is RFC3339 `now + timeoutMs + RUNNER_REAP_GRACE_MS`", async () => {
    const before = Date.now();
    await createDockerRunnerLauncher("docker").run(spec({ timeoutMs: 123_000 }));
    const after = Date.now();

    expect(createLauncherLabels).toHaveLength(1);
    const { owner, deadline } = createLauncherLabels[0]!;
    expect(owner).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(deadline).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    const deadlineMs = Date.parse(deadline!);
    expect(deadlineMs).toBeGreaterThanOrEqual(before + 123_000 + RUNNER_REAP_GRACE_MS);
    expect(deadlineMs).toBeLessThanOrEqual(after + 123_000 + RUNNER_REAP_GRACE_MS);
  });

  it("THE SAME owner id is used across every run this PROCESS performs, from a fresh factory call each time", async () => {
    // `resolveDockerRunnerLauncher` — and therefore `createDockerRunnerLauncher` — is called AFRESH
    // per `trigger()` (see `ResolveRunnerLauncher`'s own doc). If the owner id were minted inside the
    // factory rather than once at module load, this one long-lived subprocess would mint a new
    // "owner" per run and could never recognise a run of its own that outlived a respawn as its own.
    await createDockerRunnerLauncher("docker").run(spec({ runId: "owner-check-1" }));
    await createDockerRunnerLauncher("docker").run(spec({ runId: "owner-check-2" }));

    expect(createLauncherLabels).toHaveLength(2);
    expect(createLauncherLabels[0]!.owner).toBeTruthy();
    expect(createLauncherLabels[1]!.owner).toBe(createLauncherLabels[0]!.owner);
  });
});

describe("M23.1 phase 4: `run()` calls `reap()` at its own top, before `create`", () => {
  it("issues exactly one `docker ps -a --filter label=scp.launcher.owner`, before `create`", async () => {
    await createDockerRunnerLauncher("docker").run(spec());

    expect(reapListCalls).toStrictEqual([
      {
        args: [
          "ps",
          "-a",
          "--filter",
          `label=${RUNNER_LAUNCHER_OWNER_LABEL}`,
          "--format",
          `{{.ID}}\t{{.Label "${RUNNER_LAUNCHER_OWNER_LABEL}"}}\t{{.Label "${RUNNER_LAUNCHER_DEADLINE_LABEL}"}}`
        ],
        opts: { timeout: RUNNER_REMOVE_TIMEOUT_MS }
      }
    ]);
    // THE DELETE-THE-WIRING CHECK THIS UNIT CAN DO: `issueOrder` sees every subcommand, `ps`
    // included, in true issue order. Remove `await reap()` from the top of `run()` and this list
    // loses its leading `"ps"` — the ONLY thing in this file that would notice.
    expect(issueOrder[0], "reap's own list call must be issued before anything else").toBe("ps");
    expect(issueOrder.slice(1)).toStrictEqual(["create", "start", "rm"]);
  });

  it("a run that finds NOTHING to reap issues no `rm` beyond its own teardown", async () => {
    reapPsStdout = "";
    await createDockerRunnerLauncher("docker").run(spec());
    expect(calls.map((c) => c.args[0])).toStrictEqual(["create", "start", "rm"]);
  });
});

describe("M23.1 phase 4: `reap()`'s predicate — never a peer, never the future, never a guess", () => {
  const FOREIGN_OWNER = "22222222-2222-4222-8222-222222222222";
  const PAST = new Date(Date.now() - 60_000).toISOString();
  const FUTURE = new Date(Date.now() + 60_000).toISOString();

  it("removes a container owned by SOMEONE ELSE whose deadline has PASSED", async () => {
    reapPsStdout = `abc123\t${FOREIGN_OWNER}\t${PAST}\n`;
    const removed = await createDockerRunnerLauncher("docker").reap();

    expect(removed).toStrictEqual(["abc123"]);
    expect(calls).toStrictEqual([
      { file: "docker", args: ["rm", "-f", "abc123"], opts: { timeout: RUNNER_REMOVE_TIMEOUT_MS } }
    ]);
  });

  it("SPARES a container owned by SOMEONE ELSE whose deadline is still in the FUTURE", async () => {
    // Without this arm a reaper that ignored the deadline entirely — `docker container prune`
    // wearing a filter's name — would pass the case above.
    reapPsStdout = `future1\t${FOREIGN_OWNER}\t${FUTURE}\n`;
    const removed = await createDockerRunnerLauncher("docker").reap();

    expect(removed).toStrictEqual([]);
    expect(calls).toStrictEqual([]);
  });

  it("SPARES its OWN container even PAST deadline — never touches what this process itself owns", async () => {
    // First: a real `create` from THIS launcher, to learn the real owner id rather than guess it.
    await createDockerRunnerLauncher("docker").run(spec({ runId: "own-past" }));
    const myOwner = createLauncherLabels[0]!.owner!;
    reset();

    reapPsStdout = `own1\t${myOwner}\t${PAST}\n`;
    const removed = await createDockerRunnerLauncher("docker").reap();

    expect(removed).toStrictEqual([]);
    expect(calls).toStrictEqual([]);
  });

  it("SPARES a container with NO deadline label at all (malformed/absent -> never read as safe)", async () => {
    reapPsStdout = `nolabel1\t${FOREIGN_OWNER}\t\n`;
    const removed = await createDockerRunnerLauncher("docker").reap();

    expect(removed).toStrictEqual([]);
    expect(calls).toStrictEqual([]);
  });

  it("SPARES a container whose deadline label is GARBLED (unparsable -> never read as safe)", async () => {
    reapPsStdout = `garbled1\t${FOREIGN_OWNER}\tnot-a-date\n`;
    const removed = await createDockerRunnerLauncher("docker").reap();

    expect(removed).toStrictEqual([]);
    expect(calls).toStrictEqual([]);
  });

  it("removes only the matching rows out of a mixed listing, in the order `docker ps` returned them", async () => {
    reapPsStdout = [
      `remove-1\t${FOREIGN_OWNER}\t${PAST}`,
      `keep-future\t${FOREIGN_OWNER}\t${FUTURE}`,
      `keep-nolabel\t${FOREIGN_OWNER}\t`,
      `remove-2\t${FOREIGN_OWNER}\t${PAST}`
    ].join("\n");
    const removed = await createDockerRunnerLauncher("docker").reap();

    expect(removed).toStrictEqual(["remove-1", "remove-2"]);
  });

  it("a `docker ps` failure is swallowed — reap() resolves to [] rather than blocking the run it precedes", async () => {
    reapPsFailure = new Error("docker: Cannot connect to the Docker daemon");
    const removed = await createDockerRunnerLauncher("docker").reap();

    expect(removed).toStrictEqual([]);
    expect(calls, "no rm was even attempted — the listing itself is what failed").toStrictEqual([]);
  });

  it("a `docker rm -f` failure for ONE target is swallowed and does not stop the others", async () => {
    reapPsStdout = [
      `fails-to-remove\t${FOREIGN_OWNER}\t${PAST}`,
      `removes-fine\t${FOREIGN_OWNER}\t${PAST}`
    ].join("\n");
    fail("teardown", new Error("docker: no such container"));
    const removed = await createDockerRunnerLauncher("docker").reap();

    // `fail("teardown", …)` makes EVERY `rm` in this test fail (the seam has no per-id failure
    // knob), which is still the case that matters: reap() must not let one rejection abort the loop
    // and skip trying the rest.
    expect(removed).toStrictEqual([]);
    expect(calls.map((c) => c.args)).toStrictEqual([
      ["rm", "-f", "fails-to-remove"],
      ["rm", "-f", "removes-fine"]
    ]);
  });
});
