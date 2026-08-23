/**
 * NOT A TEST FILE. Standalone entry point spawned BY `reaper.integration.test.ts` — never imported,
 * never run by vitest. Sibling of `reaper-integration-child.ts`, same technique, different hazard.
 *
 * Its whole job is to launch ONE real run through the REAL Docker adapter — `createDockerRunnerLauncher`,
 * the same production code path a managed executor's subprocess takes — with a `secretEnv` credential
 * and a `dockerBinary` pointed at a STUB (argv[1], a slow `create`), so the PARENT test can observe the
 * transient `--env-file` genuinely existing on disk and SIGKILL this process while `create` is still in
 * flight. That reproduces MEDIUM-4 exactly: the host's own hang detector
 * (`apps/server/src/plugin-host/host.ts`) `child.kill("SIGKILL")`s a subprocess mid-`trigger()`, no
 * `finally` runs anywhere in this process, and the mode-0600 credential file the adapter wrote is left
 * behind with nothing left to unlink it.
 *
 * THE STUB, NOT A REAL DAEMON, ON PURPOSE. What is under test here is the ADAPTER's own file lifecycle
 * — write, then unlink in a `finally` — not Docker's. A stub gives the parent a wide, deterministic
 * window (a `sleep` the parent knows the length of) instead of racing a real `docker create`'s
 * sub-hundred-millisecond duration, which is exactly the technique `managed-trigger-budget.test.ts`
 * already uses for a different budget-shaped hazard.
 *
 * Nothing in this file's OWN exit path matters — the whole point of the scenario is that this process
 * never gets the chance to run one.
 */
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
