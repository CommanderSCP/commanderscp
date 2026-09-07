import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RUNNER_LAUNCHER_DEADLINE_LABEL } from "@scp/runner-launcher";
import { SubprocessPluginHost } from "./host.js";

/** The wiring that had no test at any level, asked directly. See docs/plugin-host.md §71. */

const RUN_BUDGET_MS = 7_000;
/** What each of `create` / `cp` / `start` costs. Four such steps = 12s of work in a 7s budget. */
const STEP_SECONDS = 3;
/** What the teardown costs. See docs/plugin-host.md §72. */
const TEARDOWN_SECONDS = 6;
/**
 * What the run may take: the budget, plus one teardown, plus room for subprocess spawn and the RPC.
 * The OLD behaviour is 4 x STEP_SECONDS + TEARDOWN_SECONDS = 18s and fails this by 2.5s.
 */
const MAX_ELAPSED_MS = RUN_BUDGET_MS + TEARDOWN_SECONDS * 1_000 + 2_500;

interface FakeDocker {
  binary: string;
  containersDir: string;
  logPath: string;
}

const tempDirs: string[] = [];
let host: SubprocessPluginHost | undefined;

/** A stub that is slow on every subcommand, modelling one. See docs/plugin-host.md §73. */
async function makeSlowFakeDocker(): Promise<FakeDocker> {
  const dir = await mkdtemp(join(tmpdir(), "scp-slow-docker-"));
  tempDirs.push(dir);
  const containersDir = join(dir, "containers");
  const logPath = join(dir, "argv.log");
  const binary = join(dir, "docker");
  const script = [
    "#!/bin/sh",
    `LOG='${logPath}'`,
    `STATE='${containersDir}'`,
    'mkdir -p "$STATE"',
    'printf \'%s\\n\' "$*" >> "$LOG"',
    'sub="$1"',
    "shift",
    'case "$sub" in',
    // `ps` is reap()'s listing. Answered instantly and emptily: reap is not this file's subject,
    // and a slow one here would be measuring the sibling defect (HIGH-3) instead.
    "  ps)",
    "    ;;",
    "  create)",
    `    sleep ${STEP_SECONDS}`,
    "    name=''",
    "    prev=''",
    '    for a in "$@"; do',
    '      if [ "$prev" = \'--name\' ]; then name="$a"; fi',
    '      prev="$a"',
    "    done",
    '    : > "$STATE/$name"',
    "    printf 'container-%s\\n' \"$name\"",
    "    ;;",
    "  cp)",
    `    sleep ${STEP_SECONDS}`,
    "    ;;",
    "  start)",
    `    sleep ${STEP_SECONDS}`,
    "    printf 'fake runner finished\\n'",
    "    ;;",
    "  rm)",
    `    sleep ${TEARDOWN_SECONDS}`,
    '    for a in "$@"; do',
    '      if [ "$a" != \'-f\' ]; then rm -f "$STATE/$a"; fi',
    "    done",
    "    ;;",
    "esac",
    "exit 0",
    ""
  ].join("\n");
  await writeFile(binary, script, "utf8");
  await chmod(binary, 0o755);
  return { binary, containersDir, logPath };
}

/** The server-injected config `executor-bindings-repo.ts` builds in production, minus the parts
 *  that need a database. `timeoutMs` is the tenant's, and since M23.1e it is the WHOLE-RUN budget. */
async function managedIacConfig(
  fake: FakeDocker,
  timeoutMs: number
): Promise<Record<string, unknown>> {
  const root = await mkdtemp(join(tmpdir(), "scp-managed-iac-whole-run-"));
  tempDirs.push(root);
  return {
    runnerImage: "scp-runner-iac:whole-run-test",
    workspaceRoot: join(root, "workspaces"),
    networkMode: "none",
    statePath: join(root, "state.json"),
    dockerBinary: fake.binary,
    timeoutMs
  };
}

async function containersHeld(fake: FakeDocker): Promise<string[]> {
  return readdir(fake.containersDir).catch(() => [] as string[]);
}

/** The `scp.launcher.deadline` the adapter stamped on the container, read out of the stub's log. */
function stampedDeadlineMs(argvLog: string): number {
  const match = new RegExp(`${RUNNER_LAUNCHER_DEADLINE_LABEL}=(\\S+)`).exec(argvLog);
  if (!match) throw new Error("no scp.launcher.deadline label was ever stamped");
  return Date.parse(match[1]!);
}

afterEach(async () => {
  await host?.stop();
  host = undefined;
  for (const dir of tempDirs.splice(0)) {
    // That error is a race with a process this file orphans. See docs/plugin-host.md §74.
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

describe("M23.1e: a MULTI-STEP managed run through a DEFAULT-CONSTRUCTED host cannot exceed its own budget", () => {
  it("four steps, each individually under the per-call bound, still finish within timeoutMs + one teardown", async () => {
    const fake = await makeSlowFakeDocker();
    const config = await managedIacConfig(fake, RUN_BUDGET_MS);

    host = new SubprocessPluginHost();
    await host.start([
      {
        id: "managed-iac-whole-run",
        module: "managed-iac",
        orgId: "org-whole-run",
        scopeKey: "domain-whole-run",
        config
      }
    ]);

    // SAMPLED WHILE THE RUN IS IN FLIGHT, so the empty directory asserted at the end is a TEARDOWN
    // and not an observation channel that never sees anything.
    let sawContainerMidRun = false;
    const poller = setInterval(() => {
      void containersHeld(fake).then((held) => {
        if (held.length > 0) sawContainerMidRun = true;
      });
    }, 250);

    const startedAt = Date.now();
    const ref = await host
      .executor("managed-iac-whole-run")
      .trigger({
        kind: "sync",
        targetRef: "target-whole-run",
        idempotencyKey: "whole-run-probe-1",
        parameters: { iacAction: "plan", sourceFiles: { "main.tf": "# fixture\n" } }
      })
      .finally(() => clearInterval(poller));
    const elapsed = Date.now() - startedAt;
    const completedAt = Date.now();

    // (i) IT RESOLVED. Under the defect it did not: the host's own budget expired mid-run and
    //     SIGKILLed the subprocess, so this rejected with "timed out after …ms".
    expect(ref.externalId).toBe("managed-iac::whole-run-probe-1");

    // (ii) THE WHOLE-RUN BOUND — the assertion this entire file exists for. Four steps of
    //      STEP_SECONDS each, every one of them under the per-call bound the old code handed out
    //      afresh, must NOT sum past the budget. Old behaviour: 4 x 3s + 6s teardown = 18s.
    expect(
      elapsed,
      `the run took ${elapsed}ms — a per-call bound is being used as a whole-run bound again`
    ).toBeLessThan(MAX_ELAPSED_MS);

    // (iii) IT REALLY DID DO MULTI-STEP WORK. Without this the bound above is satisfiable by a run
    //       that failed instantly, which is the vacuous-green shape this repo keeps meeting.
    const argv = await readFile(fake.logPath, "utf8");
    expect(argv).toContain("create --network none --name scp-runner-whole-run-probe-1");
    expect(argv).toMatch(/\ncp \S+\/\. container-scp-runner-whole-run-probe-1:/);
    expect(elapsed).toBeGreaterThan(2 * STEP_SECONDS * 1_000);

    // (iv) A TERMINAL STATUS. Under the old SIGKILL the outcome cache had no entry at all and this
    //      read `pending` forever, indistinguishable from "still running". The run's `start` is cut
    //      off by the budget, so the terminal phase is `failed` — which is the honest answer, and
    //      the one `reconcile.ts` needs in order not to double-apply.
    const status = await host.executor("managed-iac-whole-run").status(ref);
    expect(["failed", "succeeded"]).toContain(status.phase);

    // (v) NO CONTAINER LEFT BEHIND, and the stub genuinely held one while the run was in flight.
    expect(sawContainerMidRun).toBe(true);
    expect(await containersHeld(fake)).toEqual([]);
    expect(argv).toContain("rm -f scp-runner-whole-run-probe-1");

    // (vi) HIGH-2, END TO END. See docs/plugin-host.md §75.
    expect(stampedDeadlineMs(argv)).toBeGreaterThan(completedAt);
  }, 60_000);
});
