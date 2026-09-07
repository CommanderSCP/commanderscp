/** NOT A TEST FILE. See docs/runner-launcher.md §395. */
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
