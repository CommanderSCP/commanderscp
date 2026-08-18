import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  RUNNER_LAUNCHER_DEADLINE_LABEL,
  RUNNER_LAUNCHER_OWNER_LABEL,
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

      const removeMe = `scp-runner-${uniqueRunId("past-foreign")}`;
      const spareMeFuture = `scp-runner-${uniqueRunId("future-foreign")}`;
      const spareMeNoLabel = `scp-runner-${uniqueRunId("no-label")}`;

      await craftLabelledContainer({
        name: removeMe,
        ownerLabel: foreignOwner,
        deadlineLabel: past
      });
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

      const removed = await createDockerRunnerLauncher().reap();

      expect(removed, "the past-deadline foreign container must be among the removed ids").toEqual(
        expect.arrayContaining([expect.any(String)])
      );
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

      // Only `removeMe` should have been swept out of THIS test's own three fixtures — the other
      // two are still in `ownedNames` and `afterEach` tears them down.
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
        const orphan = `scp-runner-${uniqueRunId("wiring-orphan")}`;
        await craftLabelledContainer({
          name: orphan,
          ownerLabel: foreignOwner,
          deadlineLabel: past
        });

        expect(
          await containerState(orphan),
          "the orphan must exist before the wiring is exercised"
        ).toBe("running");

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
        await whenReapSettled();

        expect(
          await containerState(orphan),
          "run()'s own top-of-function reap() must have swept this orphan as a side effect"
        ).toBeUndefined();
        ownedNames.delete(orphan);
      },
      30_000
    );
  }
);
