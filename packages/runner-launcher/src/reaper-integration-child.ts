/**
 * NOT A TEST FILE. Standalone entry point spawned BY `reaper.integration.test.ts` — never imported,
 * never run by vitest.
 *
 * Its whole job is to launch ONE real container through the REAL Docker adapter — the same
 * `createDockerRunnerLauncher().run()` production code path a managed executor's subprocess would
 * take — and then do nothing else, so the PARENT test can SIGKILL this process while `docker start
 * -a` is attached. That reproduces exactly the scenario M23.1 phase 4 exists for: the host's own
 * hang detector (`apps/server/src/plugin-host/host.ts`, sized by `call-policy.ts`)
 * `child.kill("SIGKILL")`s a subprocess mid-`trigger()`, no `finally` runs, and the container the
 * daemon already started keeps running with nothing left supervising it.
 *
 * Nothing in this file's OWN exit path matters — the whole point of the scenario is that this
 * process never gets the chance to run one. If `run()` ever resolves or rejects on its own (the
 * happy path, useful for the parent's OTHER negative-arm container — see the test file), this just
 * reports it and exits; the parent does not wait for that under the SIGKILL scenario.
 */
import { createDockerRunnerLauncher } from "./index.js";

const [, , runId, image] = process.argv;
if (!runId || !image) {
  process.stderr.write(
    "reaper-integration-child: usage: node reaper-integration-child.ts <runId> <image>\n"
  );
  process.exit(2);
}

createDockerRunnerLauncher()
  .run({
    runId,
    labels: { "scp.test": "reaper-integration-child" },
    image,
    // A long sleep, not a fast exit: the parent needs a window to observe `docker inspect` report
    // `running` and then SIGKILL this process before the container would exit on its own.
    operands: ["sleep", "300"],
    networkMode: "none",
    env: [],
    secretEnv: [],
    copyIn: [],
    timeoutMs: 5 * 60_000,
    maxBuffer: 1024 * 1024
  })
  .then(() => {
    process.stdout.write("reaper-integration-child: run() resolved\n");
  })
  .catch((err: unknown) => {
    process.stderr.write(`reaper-integration-child: run() rejected: ${String(err)}\n`);
  });
