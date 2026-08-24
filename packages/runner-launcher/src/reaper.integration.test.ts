import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  RUNNER_LAUNCHER_DEADLINE_LABEL,
  RUNNER_LAUNCHER_OWNER_LABEL,
  RUNNER_SECRET_ENV_MAX_AGE_MS,
  createDockerRunnerLauncher,
  runnerContainerName,
  whenReapSettled
} from "./index.js";

/**
 * ================================================================================================
 * REAL-DOCKER PROOF OF THE REAPER (M23.1 phase 4) — WHAT THE MOCK SEAM STRUCTURALLY CANNOT SHOW
 * ================================================================================================
 * `docker-adapter.test.ts` settles argv shape and the predicate's LOGIC against a hand-written
 * `execFile`. It cannot prove any of the three things that actually matter here, because a mock
 * has no daemon behind it to be wrong about:
 *   1. that a process SIGKILLed mid-`run()` really does leave a container behind, `state=running`;
 *   2. that the two labels `create` stamped on it really do survive that kill, on disk, in the
 *      daemon's own store — not just in an in-memory recorder;
 *   3. that a REAL `docker ps -a --filter label=...` really does find it, and that a REAL `docker
 *      rm -f` really does remove it — Docker's own filter/label semantics, not this package's
 *      idea of them.
 * This file drives all three against a live daemon. Needs Docker — excluded from `pnpm test`
 * (`vitest.config.ts`), run via `pnpm test:integration` in the CI integration-shard job
 * (GitHub-hosted `ubuntu-latest`, native Docker daemon), or locally.
 *
 * THE IMAGE: `alpine:3.20`, chosen because it is one of the images `tools/ci-mirror/images.list`
 * pre-mirrors into every CI runner under this EXACT literal tag — the integration-shard job's
 * "deny the mirrored upstream registries for the rest of the job" step (`ci.yml`) would otherwise
 * block a fresh pull of anything else. Locally it is whatever is already pulled or gets pulled
 * once.
 *
 * WHY A PAST DEADLINE IS CRAFTED DIRECTLY RATHER THAN WAITED FOR. `RUNNER_REAP_GRACE_MS` is sized
 * in real minutes (see its own doc in `index.ts`) precisely so a legitimate peer's container is
 * never touched early — which is exactly why this suite cannot afford to wait for one to elapse.
 * The two containers that need a PAST deadline are therefore created with `docker create --label`
 * directly (bypassing the port, not `reap()` — `reap()` itself is real code, driven exactly as
 * production drives it), the same "fabricate an already-expired record" technique any TTL sweep is
 * tested with. The one container that needs to be REAL end-to-end (killed process, daemon-assigned
 * state, adapter-computed deadline) is built the other way — see the first test below — and its
 * naturally-future deadline is what makes it double as the FUTURE-deadline negative case.
 *
 * A REAL, PRE-EXISTING ORPHAN ALREADY LIVES ON THIS MACHINE (`scp-runner-scan:m13-3b-integration-
 * test`, `state=created`, no `scp.launcher.*` labels — left in place deliberately as evidence, per
 * this milestone's own instructions). It carries none of this package's labels, so it is excluded
 * at `reap()`'s own `docker ps -a --filter label=scp.launcher.owner` — before a single byte of its
 * state reaches this process — on EVERY test below, not only the one that checks it explicitly.
 */

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const CHILD_ENTRY = resolve(__dirname, "reaper-integration-child.ts");
const SECRET_ENV_CHILD_ENTRY = resolve(__dirname, "secret-env-leak-integration-child.ts");

const TEST_IMAGE = "alpine:3.20";
/** The known pre-existing orphan this milestone's instructions say to verify, not touch. */
const PRE_EXISTING_EVIDENCE_CONTAINER = "7dcf43ffe4e8";

async function dockerAvailable(): Promise<boolean> {
  try {
    await execFileAsync("docker", ["info"], { timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

/** Every container NAME this file has created, across every test — swept in `afterEach` so a
 *  failing assertion never leaves a container behind for the next run to trip over. */
const ownedNames = new Set<string>();

function uniqueRunId(label: string): string {
  // RUNNER_RUN_ID_PATTERN-safe: lowercase, hyphenated, short. The random suffix is what makes
  // repeated local runs of this file never collide with a container a PRIOR run failed to clean up.
  return `${label}-${randomUUID().slice(0, 8)}`;
}

/** `docker create` a container directly — bypassing the port entirely — with an EXPLICIT,
 *  caller-chosen `scp.launcher.*` label pair. This is the "fabricate an expired record" fixture
 *  builder; see the module doc for why `reap()`'s own predicate cannot otherwise be tested without
 *  a multi-minute real wait. */
async function craftLabelledContainer(args: {
  name: string;
  ownerLabel?: string;
  deadlineLabel?: string;
  extraLabels?: Record<string, string>;
}): Promise<string> {
  const labelArgs = [
    ...(args.ownerLabel !== undefined
      ? ["--label", `${RUNNER_LAUNCHER_OWNER_LABEL}=${args.ownerLabel}`]
      : []),
    ...(args.deadlineLabel !== undefined
      ? ["--label", `${RUNNER_LAUNCHER_DEADLINE_LABEL}=${args.deadlineLabel}`]
      : []),
    ...Object.entries(args.extraLabels ?? {}).flatMap(([k, v]) => ["--label", `${k}=${v}`])
  ];
  const { stdout } = await execFileAsync("docker", [
    "create",
    "--network",
    "none",
    "--name",
    args.name,
    ...labelArgs,
    TEST_IMAGE,
    "sleep",
    "300"
  ]);
  ownedNames.add(args.name);
  // No `-a`: this fixture builder does not need to observe the runner's output, only to put the
  // container into a REAL `running` state (Docker detaches by default) — matching the state a
  // SIGKILLed run leaves.
  await execFileAsync("docker", ["start", args.name]);
  return stdout.trim();
}

async function inspectField(nameOrId: string, format: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("docker", ["inspect", "-f", format, nameOrId]);
    return stdout.trim();
  } catch {
    return undefined;
  }
}

async function containerState(nameOrId: string): Promise<string | undefined> {
  return inspectField(nameOrId, "{{.State.Status}}");
}

async function containerLabels(nameOrId: string): Promise<Record<string, string>> {
  const raw = await inspectField(nameOrId, "{{json .Config.Labels}}");
  return raw ? (JSON.parse(raw) as Record<string, string>) : {};
}

async function waitUntil(predicate: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() >= deadline) throw new Error("waitUntil: condition was never met in time");
    await new Promise((r) => setTimeout(r, 150));
  }
}

describe.runIf(await dockerAvailable())(
  "M23.1 phase 4: RunnerLauncher.reap() against a real Docker daemon",
  () => {
    beforeAll(async () => {
      // Pull once, up front, rather than letting the first `docker create` pay for it — and so a
      // pull failure reports as a clear setup error rather than an opaque test timeout.
      await execFileAsync("docker", ["image", "inspect", TEST_IMAGE]).catch(() =>
        execFileAsync("docker", ["pull", TEST_IMAGE], { timeout: 120_000 })
      );
    });

    afterEach(async () => {
      for (const name of ownedNames) {
        await execFileAsync("docker", ["rm", "-f", name]).catch(() => undefined);
      }
      ownedNames.clear();
    });

    it(
      "a process SIGKILLed mid-run leaves a REAL container running, real, and labelled — and its " +
        "naturally-future deadline means reap() must NOT remove it",
      async () => {
        const runId = uniqueRunId("sigkill");
        const containerName = runnerContainerName(runId);
        ownedNames.add(containerName);

        const child = spawn(process.execPath, ["--import", "tsx", CHILD_ENTRY, runId, TEST_IMAGE], {
          stdio: "ignore"
        });

        try {
          // Wait for the REAL adapter, in the REAL child process, to have actually issued `docker
          // create` + `docker start -a` and reached `running` — not merely for the process to have
          // started. Polling `docker inspect` is the only observation point: `run()` exposes no
          // progress hook, deliberately (see its own doc).
          await waitUntil(async () => (await containerState(containerName)) === "running", 15_000);

          // THE KILL. No SIGTERM, no grace — the exact signal `plugin-host/host.ts`'s hang detector
          // sends, and the reason nothing downstream of it ever gets to run.
          child.kill("SIGKILL");
          await new Promise((r) => setTimeout(r, 300)); // let the kill land before asserting

          expect(
            await containerState(containerName),
            "the container the killed process started must still be running — nothing was left to stop it"
          ).toBe("running");

          const labels = await containerLabels(containerName);
          expect(
            labels[RUNNER_LAUNCHER_OWNER_LABEL],
            "the owner label must have survived the kill"
          ).toMatch(/^[0-9a-f-]{36}$/i);
          const deadline = labels[RUNNER_LAUNCHER_DEADLINE_LABEL];
          expect(deadline, "the deadline label must have survived the kill").toMatch(
            /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
          );
          // NATURALLY future: the child created this container SECONDS ago with a multi-minute
          // grace on top of its own timeoutMs. This is what makes it double as the "spare a
          // FUTURE-deadline foreign container" negative case in the predicate test below, rather
          // than needing a fourth container to prove the same thing.
          expect(Date.parse(deadline!)).toBeGreaterThan(Date.now());

          // THE PARENT calls reap() — a DIFFERENT process from the one that created this
          // container (the child minted its own `LAUNCHER_OWNER_ID` at its own module load), so
          // this container is FOREIGN from the parent's point of view. Its deadline is minutes in
          // the future (the child only just created it), so reap() must spare it. If "foreign" and
          // "future" were not both being evaluated for real — if, say, the predicate only checked
          // one of them, or a stale identity happened to collide — this is where that would show.
          await createDockerRunnerLauncher().reap();
          expect(
            await containerState(containerName),
            "a foreign but FUTURE-deadline container must survive a real reap() call, not just a mocked one"
          ).toBe("running");
        } finally {
          child.kill("SIGKILL"); // idempotent if already dead — belt and braces
        }
      },
      30_000
    );

    it("reap() removes a PAST-deadline foreign container, spares a FUTURE-deadline one, and spares one with no scp.launcher.* labels at all", async () => {
      const foreignOwner = randomUUID();
      const past = new Date(Date.now() - 60_000).toISOString();
      const future = new Date(Date.now() + 10 * 60_000).toISOString();

      const spareMeFuture = `scp-runner-${uniqueRunId("future-foreign")}`;
      const spareMeNoLabel = `scp-runner-${uniqueRunId("no-label")}`;

      // THE TWO NEGATIVE ARMS ARE RACE-FREE, so they are crafted ONCE, up front, and left standing
      // across every attempt below: a FUTURE deadline is spared by every reaper that exists (this
      // process's or any other's), and a container carrying no `scp.launcher.owner` label at all is
      // excluded by `reap()`'s own `--filter` before a predicate runs. Only the POSITIVE arm is
      // something another process is entitled to take, so only it is crafted inside the loop.
      await craftLabelledContainer({
        name: spareMeFuture,
        ownerLabel: foreignOwner,
        deadlineLabel: future
      });
      // NO scp.launcher.* labels at all — the same shape as the pre-existing evidence container,
      // and the case that proves this is a targeted sweep, not `docker container prune`.
      await craftLabelledContainer({
        name: spareMeNoLabel,
        extraLabels: { "scp.test": "no-label" }
      });

      /**
       * TWO RACES CAN HAND THIS CASE AN EMPTY `removed`, AND ONLY THE FIRST IS IN THIS PROCESS.
       *
       * (1) IN-PROCESS, closed by `whenReapSettled()` (PR #266). `reap()` is single-flighted per
       *     binary (`reapInFlight`): a caller arriving while a pass is running is handed THAT pass's
       *     promise, and that pass's `docker ps` can predate the fixture. Awaiting `whenReapSettled`
       *     drains the slot (its `.finally` deletes the entry before the promise resolves), so the
       *     `reap()` below always starts a FRESH enumeration.
       *
       * (2) CROSS-PROCESS, which nothing in this process can see — and this is what STILL red'd the
       *     assertion with #266's fix in tree (`main` run 32668830570, and PR #267/#268 runs).
       *     `reap()` is a shared-daemon janitor and ownership is per-PROCESS: the fixture below is
       *     FOREIGN to everyone (its owner label is a fresh random UUID) and 60s past its deadline,
       *     which is precisely what EVERY process running this package is entitled to collect. CI's
       *     `pnpm test:integration` is `turbo run test:integration`, which runs
       *     `@scp/plugin-managed-{iac,scan,dep}` in parallel with this package, in their own Node
       *     processes, against the SAME daemon — and each `plugin.trigger()` there reaches
       *     `RunnerLauncher.run()`, whose first act is `void reap()`. If one of those passes lands in
       *     the window between the `docker create` below and this pass's `docker ps`, the fixture is
       *     ALREADY GONE, this pass correctly reports `[]`, and the container-state assertions below
       *     would all still have passed. (#266's own commit message records `scp-managed-scan-plugin-
       *     it-*` containers leaking in the very CI run it was diagnosing — that suite was live on
       *     that daemon at that moment.) MEASURED HERE, deterministically: a second Node process's
       *     `reap()` returned `["e121f6511911"]` and this process's next pass then returned `[]`,
       *     with the container gone — the reported failure, exactly.
       *
       * SO: SHRINK THE WINDOW, THEN RE-RUN THE EXPERIMENT WHEN IT IS STOLEN — AND ONLY THEN. Drain
       * first and craft the stealable fixture LAST (window: one `create`+`start`, ~220ms measured,
       * against ~660ms when all three were crafted before the drain). A pass that reports none of
       * OUR ids has exactly two possible causes, and the container itself tells them apart: still
       * running = the predicate under test failed, and that fails HERE, by name, on attempt 1;
       * already gone = a peer's pass took it, which is the library working as designed and is worth
       * another attempt rather than a red main.
       */
      const REAP_RACE_ATTEMPTS = 5;
      let removeMe = "";
      let removed: string[] = [];
      let reportedByOurPass = false;
      let stolen = 0;

      for (let attempt = 1; attempt <= REAP_RACE_ATTEMPTS; attempt++) {
        await whenReapSettled(); // drain BEFORE crafting, so the window starts at `create`
        removeMe = `scp-runner-${uniqueRunId("past-foreign")}`;
        let removeMeId: string;
        try {
          removeMeId = await craftLabelledContainer({
            name: removeMe,
            ownerLabel: foreignOwner,
            deadlineLabel: past
          });
        } catch {
          // The steal this loop already tolerates, one window EARLIER: the fixture is a legitimate
          // reap candidate from the instant `create` returns, so a peer's `rm -f` landing before
          // the builder's own `docker start` makes that start throw "No such container". Same
          // cause, same response — recraft.
          ownedNames.delete(removeMe);
          stolen++;
          continue;
        }
        removed = await createDockerRunnerLauncher().reap();

        // BY ID, NOT BY `expect.any(String)`. The old assertion was satisfied by removing ANY
        // container — a peer's leaked orphan would have passed it while this fixture was untouched.
        // `docker ps --format {{.ID}}` prints the 12-char short id and `docker create` printed the
        // full 64, hence the prefix test rather than equality.
        reportedByOurPass = removed.some((id) => id.length > 0 && removeMeId.startsWith(id));
        if (reportedByOurPass) break;

        expect(
          await containerState(removeMe),
          "reap() reported removing none of this fixture AND the past-deadline foreign container is " +
            "STILL RUNNING — that is the predicate under test failing. The cross-process race this " +
            "loop tolerates leaves the container GONE (or mid-`rm`, state 'removing' — an rm only a " +
            "reap pass issues, and ours settled and reported nothing), never running, so it cannot " +
            "be the cause here"
        ).not.toBe("running");
        ownedNames.delete(removeMe); // a peer's pass took it (or is mid-`rm`); nothing left to tear down
        stolen++;
      }

      expect(
        reportedByOurPass,
        `the past-deadline foreign container must be among the ids THIS pass reports removing, and ` +
          `it was not on any of ${REAP_RACE_ATTEMPTS} attempts (${stolen} of them removed by a reap ` +
          `pass in ANOTHER process against this daemon before this one's \`docker ps\` ran; last ` +
          `report: ${JSON.stringify(removed)}). The predicate itself held every time — the container ` +
          `was gone on every attempt — but this daemon is too busy for this case to ever observe its ` +
          `OWN pass's report`
      ).toBe(true);

      expect(
        await containerState(removeMe),
        "past-deadline + foreign must be GONE"
      ).toBeUndefined();
      expect(await containerState(spareMeFuture), "future-deadline + foreign must be SPARED").toBe(
        "running"
      );
      expect(
        await containerState(spareMeNoLabel),
        "no scp.launcher.* labels at all must be SPARED — reap() is not docker container prune"
      ).toBe("running");

      // Only `removeMe` should have been swept out of THIS test's own fixtures — the other two are
      // still in `ownedNames` and `afterEach` tears them down.
      ownedNames.delete(removeMe);
    }, 30_000);

    it("removes only the containers it is entitled to remove — the pre-existing evidence container is verified untouched, not silently spared by coincidence", async () => {
      // Re-verify the absence this milestone's instructions asserted, rather than trust it: a
      // `docker ps -a` with NO grep filter, so a renamed or relabelled evidence container would
      // still be found.
      const { stdout } = await execFileAsync("docker", [
        "ps",
        "-a",
        "--format",
        "{{.ID}}\t{{.Image}}\t{{.State}}"
      ]);
      const evidenceLine = stdout
        .split("\n")
        .find((line) => line.startsWith(PRE_EXISTING_EVIDENCE_CONTAINER));
      if (!evidenceLine) {
        // The machine this suite runs on may not be the one carrying the evidence container (CI,
        // a clean dev box). That is not a failure of THIS test — the label-presence argument
        // below holds regardless of whether the specific container exists here.
        return;
      }
      const labels = await containerLabels(PRE_EXISTING_EVIDENCE_CONTAINER);
      expect(
        labels[RUNNER_LAUNCHER_OWNER_LABEL],
        "the pre-existing evidence container carries NO scp.launcher.owner label, so reap()'s own " +
          "`docker ps -a --filter label=scp.launcher.owner` excludes it before a single byte of " +
          "its state reaches this process — it is untouched by construction, not by luck"
      ).toBeUndefined();

      const stateBefore = await containerState(PRE_EXISTING_EVIDENCE_CONTAINER);
      await createDockerRunnerLauncher().reap();
      const stateAfter = await containerState(PRE_EXISTING_EVIDENCE_CONTAINER);
      expect(stateAfter, "reap() must not have changed the evidence container's state").toBe(
        stateBefore
      );
    }, 30_000);

    it(
      "THE DELETE-THE-WIRING GATE — run() schedules reap() at its own top: a past-deadline orphan " +
        "disappears as a SIDE EFFECT of an ordinary run(), with reap() never called directly",
      async () => {
        const foreignOwner = randomUUID();
        const past = new Date(Date.now() - 60_000).toISOString();

        // CRAFT A STEALABLE ORPHAN AND OBSERVE IT STANDING — recraft on a peer's steal, bounded.
        // The orphan is a legitimate reap candidate for EVERY process on this daemon from the
        // instant `docker create` returns (foreign owner, past deadline), so a concurrent
        // `@scp/plugin-managed-*` suite's pass can take it before this case's precondition looks
        // at it: mid-`rm` reads `removing`, a completed steal reads undefined, and a steal inside
        // the builder itself makes its `docker start` throw. All three are the library working as
        // designed in ANOTHER process — recraft and try again; only a bounded run of steals is a
        // failure, and it names the cause. (Observed for real: PR #272 run 32755551605 red exactly
        // here with `expected 'removing' to be 'running'`.)
        const WIRING_CRAFT_ATTEMPTS = 5;
        let orphan = "";
        let orphanStanding = false;
        let stolenMidCraft = 0;
        let lastCraftError: unknown;
        for (let attempt = 1; attempt <= WIRING_CRAFT_ATTEMPTS; attempt++) {
          orphan = `scp-runner-${uniqueRunId("wiring-orphan")}`;
          try {
            await craftLabelledContainer({
              name: orphan,
              ownerLabel: foreignOwner,
              deadlineLabel: past
            });
          } catch (cause) {
            ownedNames.delete(orphan);
            stolenMidCraft++;
            lastCraftError = cause;
            continue;
          }
          if ((await containerState(orphan)) === "running") {
            orphanStanding = true;
            break;
          }
          ownedNames.delete(orphan); // `removing` or already gone — a peer's pass took it
          stolenMidCraft++;
        }
        expect(
          orphanStanding,
          `the orphan must exist before the wiring is exercised, and no craft survived to the ` +
            `precondition on any of ${WIRING_CRAFT_ATTEMPTS} attempts (${stolenMidCraft} taken by ` +
            `a reap pass in ANOTHER process against this daemon` +
            (lastCraftError ? `; last craft error: ${String(lastCraftError)}` : "") +
            `)`
        ).toBe(true);

        // An ORDINARY, fast, real run — nothing about this spec asks for a reap. If the reap
        // scheduling is ever removed from the top of `RunnerLauncher.run()` (index.ts), this orphan
        // survives this call and the assertion below goes red BY NAME.
        const runId = uniqueRunId("wiring-run");
        ownedNames.add(runnerContainerName(runId));
        await createDockerRunnerLauncher().run({
          runId,
          labels: {},
          image: TEST_IMAGE,
          operands: ["true"],
          networkMode: "none",
          env: [],
          secretEnv: [],
          copyIn: [],
          timeoutMs: 10_000,
          maxBuffer: 1024
        });
        // THE SWEEP IS NOT AWAITED BY `run()` SINCE M23.1e — that is the fix for HIGH-3 (a reap that
        // spends the run's budget can stop `create` being issued at all), so this test has to await
        // it explicitly instead of racing it. THE GATE KEEPS ITS TEETH: with the scheduling deleted
        // there is no pass in flight, `whenReapSettled()` resolves immediately, and the orphan is
        // still there below.
        //
        // THE SAME CROSS-PROCESS PROPERTY THE PREDICATE CASE ABOVE LOOPS OVER APPLIES HERE, in two
        // windows with opposite consequences. BEFORE the precondition, a peer's steal CAN red this
        // case — that window is what the craft loop above absorbs (it did red, once: see the loop's
        // comment). AFTER the precondition, a steal landing inside this one run() can only mask a
        // genuinely deleted wiring for that narrow window — provided the final assertion reads the
        // container's state as the TRI-STATE it is (running / mid-`rm` 'removing' / gone), which is
        // why it asserts not-"running" rather than gone: a peer's rm still in flight at read time is
        // a collected orphan, not a standing one. Left as an assertion on the container rather than
        // on `whenReapSettled()`'s id list deliberately: keying the gate on THIS process's report
        // would trade that rare vacuous pass for a rare flaky red on the one test whose whole job
        // is to go red when the wiring is gone.
        await whenReapSettled();

        const orphanFinalState = await containerState(orphan);
        expect(
          orphanFinalState,
          "run()'s own top-of-function reap() must have swept this orphan as a side effect — gone " +
            "(undefined) or mid-`rm` ('removing', which only a reap pass issues; ours settled, so a " +
            "peer's — either way it was collected, never left standing). 'running' here means the " +
            "wiring is deleted, the one thing this gate exists to red on"
        ).not.toBe("running");
        ownedNames.delete(orphan);
      },
      30_000
    );
  }
);

// ====================================================================================================
// MEDIUM-4 — A REAL SIGKILL MID-`create` GENUINELY LEAVES THE `--env-file`, AND `reap()` SWEEPS IT.
// ====================================================================================================
// Deliberately its own top-level `describe`, NOT nested inside `describe.runIf(dockerAvailable())`
// above: what is under test is `@scp/runner-launcher`'s OWN file lifecycle (write, then unlink in a
// `finally`), not Docker's, so a real daemon buys nothing here and would only make the suite
// Docker-dependent for no reason. The `dockerBinary` this block hands the adapter is a stub shell
// script that sleeps on `create` — the same "give the parent a wide, deterministic window instead of
// racing a real sub-hundred-millisecond call" technique `apps/server/src/plugin-host/managed-trigger-
// budget.test.ts` already uses for a different budget-shaped hazard. See
// `secret-env-leak-integration-child.ts` for what the killed process actually runs.
// ====================================================================================================

describe("MEDIUM-4: a real SIGKILL mid-`create` leaks the `--env-file`, and reap() sweeps it", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  /** A `docker` stub whose `create` sleeps for `sleepSeconds` before printing a fake id — every
   *  other subcommand exits 0 immediately. Long enough that a poll-for-the-file loop reliably wins
   *  the race against the kill, short enough to keep the suite fast. */
  async function makeSleepyDockerStub(sleepSeconds: number): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "scp-secret-env-leak-stub-docker-"));
    tempDirs.push(dir);
    const binary = join(dir, "docker");
    const script = [
      "#!/bin/sh",
      'sub="$1"',
      'case "$sub" in',
      "  create)",
      `    sleep ${sleepSeconds}`,
      "    echo fake-container-id",
      "    ;;",
      "  *)",
      "    exit 0",
      "    ;;",
      "esac"
    ].join("\n");
    await writeFile(binary, script, "utf8");
    await chmod(binary, 0o755);
    return binary;
  }

  /** Polls `dir` for a file carrying `prefix` WHOSE CONTENT equals `expected` — the same "observe
   *  the real adapter's real state" technique `reaper.integration.test.ts`'s own `waitUntil` uses
   *  for a container's `docker inspect` state, applied to a file instead.
   *
   *  NAME-VISIBILITY IS NOT CONTENT-VISIBILITY. `writeSecretEnvFile` writes with a single
   *  `writeFile(path, …, { flag: "wx" })` — open, then write, then close, three separate syscalls —
   *  so the name is in `readdir` before the bytes are in the file. A waiter that returns on the
   *  name and reads once caught the gap on a loaded CI runner (2026-08-24, PR #271 shard 1:
   *  `expected '' to be 'AWS_SECRET_ACCESS_KEY=…'` — an EMPTY read, not ENOENT, which is this
   *  race's exact signature and rules out anything sweeping the file). Waiting for the CONTENT
   *  collapses both causes of emptiness (mid-write vs never-written) into one loud timeout. */
  async function waitForFileContent(
    dir: string,
    prefix: string,
    expected: string,
    timeoutMs: number
  ): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    let lastSeen: string | undefined;
    for (;;) {
      const found = (await readdir(dir).catch(() => [])).find((name) => name.startsWith(prefix));
      if (found) {
        // ENOENT here would mean the file vanished between readdir and readFile — keep polling;
        // the deadline, not this read, is the arbiter of "never appeared".
        const content = await readFile(join(dir, found), "utf8").catch(() => undefined);
        if (content === expected) return join(dir, found);
        lastSeen = content;
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `waitForFileContent: no '${prefix}*' in ${dir} ever carried the expected content — ` +
            (lastSeen === undefined
              ? "no such file ever appeared"
              : `last read was ${JSON.stringify(lastSeen)}`)
        );
      }
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  it(
    "MEASURED: the credential file exists while `create` is in flight, SURVIVES a real SIGKILL, " +
      "and a later reap() sweeps it — while sparing a concurrent LIVE run's file in the SAME directory",
    async () => {
      const secretEnvDir = await mkdtemp(join(tmpdir(), "scp-secret-env-leak-dir-"));
      tempDirs.push(secretEnvDir);
      const stubDocker = await makeSleepyDockerStub(3);
      const runId = `leak-${randomUUID().slice(0, 8)}`;

      const child = spawn(
        process.execPath,
        ["--import", "tsx", SECRET_ENV_CHILD_ENTRY, stubDocker, runId, secretEnvDir],
        { stdio: "ignore" }
      );

      let leakedPath: string;
      try {
        // WAIT FOR THE REAL ADAPTER, IN THE REAL CHILD PROCESS, TO HAVE ACTUALLY WRITTEN THE FILE'S
        // CONTENT — not merely for the process to have started, and not merely for the NAME to be in
        // readdir (see waitForFileContent's doc for the CI red that distinction cost). `create`'s
        // stub sleeps 3s, so this window is wide open the entire time the file legitimately exists.
        leakedPath = await waitForFileContent(
          secretEnvDir,
          "scp-secret-env-",
          "AWS_SECRET_ACCESS_KEY=CANARY-LEAKED-ON-DISK-7X\n",
          5_000
        );

        // MEASURED, not assumed: the file really does carry the credential, unredacted, on disk.
        // Race-free now — the wait above already saw this exact content, and nothing rewrites it.
        const content = await readFile(leakedPath, "utf8");
        expect(content).toBe("AWS_SECRET_ACCESS_KEY=CANARY-LEAKED-ON-DISK-7X\n");

        // THE KILL. No SIGTERM, no grace — `plugin-host/host.ts`'s own hang-detector signal, mid the
        // ONE `execFile` (`create`) that had a `finally { unlink }` waiting for it to settle.
        child.kill("SIGKILL");
        await new Promise((r) => setTimeout(r, 300)); // let the kill land before asserting

        expect(
          existsSync(leakedPath),
          "the credential file must still exist — nothing was left to unlink it"
        ).toBe(true);
      } finally {
        child.kill("SIGKILL"); // idempotent if already dead — belt and braces
      }

      // A CONCURRENT LIVE RUN'S FILE, IN THE SAME DIRECTORY — crafted directly (bypassing the
      // port), the same "fabricate the case a real wait cannot afford" technique the container
      // suite above uses for a future deadline. Its mtime is `now`, well inside
      // RUNNER_SECRET_ENV_MAX_AGE_MS, so the sweep below must NOT touch it — the negative arm.
      const livePath = join(
        secretEnvDir,
        `scp-secret-env-${runId}-live-00000000-0000-4000-8000-000000000000`
      );
      await writeFile(livePath, "AWS_SECRET_ACCESS_KEY=STILL-IN-FLIGHT\n", { mode: 0o600 });

      // BACKDATE THE LEAKED FILE'S mtime, THE SAME "craft an already-expired record" technique the
      // module doc above explains for the container deadline — waiting RUNNER_SECRET_ENV_MAX_AGE_MS
      // (over an hour) in real time is not a suite this repository can afford to run.
      const ancient = new Date(Date.now() - (RUNNER_SECRET_ENV_MAX_AGE_MS + 60_000));
      await utimes(leakedPath, ancient, ancient);

      // A FRESH LAUNCHER — a different in-process instance, same stub binary — calls reap()
      // DIRECTLY against this run's own secretEnvDir, exactly as `run()` does at its own top.
      await createDockerRunnerLauncher(stubDocker).reap(secretEnvDir);

      expect(
        existsSync(leakedPath),
        "the stale leaked credential file must be gone after reap()"
      ).toBe(false);
      expect(
        existsSync(livePath),
        "a concurrent LIVE run's file, well inside its safety window, must survive the same reap() call"
      ).toBe(true);
    },
    15_000
  );
});
