/** NOT A TEST FILE. See docs/runner-launcher.md §408. */
import { createDockerRunnerLauncher } from "./index.js";

const [, , dockerBinary, runId, secretEnvDir] = process.argv;
if (!dockerBinary || !runId || !secretEnvDir) {
  process.stderr.write(
    "secret-env-leak-integration-child: usage: node secret-env-leak-integration-child.ts <dockerBinary> <runId> <secretEnvDir>\n"
  );
  process.exit(2);
}

createDockerRunnerLauncher(dockerBinary)
  .run({
    runId,
    labels: { "scp.test": "secret-env-leak-integration-child" },
    image: "unused:image",
    operands: ["true"],
    networkMode: "none",
    env: [],
    secretEnv: ["AWS_SECRET_ACCESS_KEY=CANARY-LEAKED-ON-DISK-7X"],
    secretEnvDir,
    copyIn: [],
    timeoutMs: 5 * 60_000,
    maxBuffer: 1024 * 1024
  })
  .then(() => {
    process.stdout.write("secret-env-leak-integration-child: run() resolved\n");
  })
  .catch((err: unknown) => {
    process.stderr.write(`secret-env-leak-integration-child: run() rejected: ${String(err)}\n`);
  });
