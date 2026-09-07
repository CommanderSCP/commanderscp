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

/** REAL-DOCKER PROOF OF THE REAPER. See docs/runner-launcher.md §396. */

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
          await new Promise((r) => setTimeout(r, 300));

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

          // THE PARENT calls reap(). See docs/runner-launcher.md §397.
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

      // The two negative arms are race-free, so crafted once. See docs/runner-launcher.md §398.
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

      /** Two races can hand this case an empty result. See docs/runner-launcher.md §399. */
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

        // CRAFT A STEALABLE ORPHAN AND OBSERVE IT STANDING. See docs/runner-launcher.md §400.
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
        // THE SWEEP IS NOT AWAITED BY `run()` SINCE M23.1e. See docs/runner-launcher.md §401.
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

// A real kill mid-create genuinely leaves the env file. See docs/runner-launcher.md §402.

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

  /** Polls for a file whose content equals the expected. See docs/runner-launcher.md §403. */
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
        await new Promise((r) => setTimeout(r, 300));

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
