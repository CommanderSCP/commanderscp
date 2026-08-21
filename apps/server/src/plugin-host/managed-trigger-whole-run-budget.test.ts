import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RUNNER_LAUNCHER_DEADLINE_LABEL } from "@scp/runner-launcher";
import { SubprocessPluginHost } from "./host.js";

/**
 * ================================================================================================
 * M23.1e — THE WIRING THAT HAD NO TEST AT ANY LEVEL, ASKED THE ONE QUESTION IT WAS NEVER ASKED
 * ================================================================================================
 *
 * `managed-trigger-budget.test.ts` is this file's sibling and it closed M23.1c: a managed run
 * longer than the 10s hang detector must not be SIGKILLed. It drives a stub `docker` whose ONE slow
 * step is `start`, because that was the shape of the defect it was written for.
 *
 * THAT SHAPE IS EXACTLY WHY THE NEXT DEFECT SURVIVED IT. `@scp/runner-launcher` handed
 * `{ timeout: spec.timeoutMs }` to `create`, to EVERY `docker cp`, to `start` and to the copy-out
 * INDEPENDENTLY — four to six sequential calls, each with a fresh, full budget — so a run's wall
 * clock was k x timeoutMs and nothing bounded the sum, while the host budget derived from it was
 * `timeoutMs + a constant`. With one slow step there is nothing to sum, so a suite built around one
 * slow step is structurally blind to it. Measured with four: `timeoutMs: 20_000`, steps of
 * 18s/9s/18s/9s (every one under the inner 20s bound), budget 50000ms, elapsed 50003ms —
 * `plugin 'managed-iac-overrun' call 'trigger' timed out after 50000ms`, container still held, no
 * ledger entry, so `reconcile.ts` issues a SECOND `tofu apply` while the first is still applying.
 *
 * SO THIS FILE'S STUB IS SLOW ON EVERY STEP. That is the whole difference, and it is the reason the
 * file exists rather than another case in the sibling.
 *
 * THE HOST IS DEFAULT-CONSTRUCTED, for the sibling's reason, restated because it is the standing
 * gate: `new SubprocessPluginHost()` with no options is `host-bootstrap.ts` verbatim, and every
 * other test in the repository that builds a host passes an explicit `callTimeoutMs` and drives a
 * fast fake executor. Passing options here would delete the test.
 */

/** The tenant's whole-run budget for these runs. */
const RUN_BUDGET_MS = 7_000;
/** What each of `create` / `cp` / `start` costs. Four such steps = 12s of work in a 7s budget. */
const STEP_SECONDS = 3;
/**
 * What the teardown costs. Under `RUNNER_REMOVE_TIMEOUT_MS` (30s), and deliberately NOT free: it is
 * the post-deadline work `MANAGED_TRIGGER_GRACE_MS` has to cover, and a stub that tore down
 * instantly would make that constant untestable here.
 *
 * IT IS NOT "THE ONLY WORK THAT HAPPENS AFTER THE RUN DEADLINE", WHICH IS WHAT THIS SAID — corrected
 * by M23.5. That was true of the DOCKER adapter, which is the one this file drives, and false of the
 * Kubernetes adapter, whose `finally` is three bounded calls; a step abandoned at the deadline can
 * also cost one `RUNNER_STEP_ABANDON_GRACE_MS` before the teardown even begins. The whole term is
 * `runnerPostDeadlineMs(kind)`, and the count it derives from is checked against the code by
 * `@scp/runner-launcher`'s `teardown-model.test.ts` — this file cannot see either, because it drives
 * one adapter through a stub `docker`.
 */
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

/**
 * A stub `docker` that is SLOW ON EVERY SUBCOMMAND and models the one property this file asserts
 * about the daemon: a container exists between `create` and `rm -f`. Absolute paths are baked into
 * the script text rather than passed as env, because `host.ts` allowlists the child's environment
 * and nothing set here would survive to the plugin subprocess, let alone to its grandchild.
 *
 * IT DOES NOT NEED TO MODEL `timeout` ITSELF: the real `execFile` in the plugin subprocess is doing
 * that, which is the point of driving this end to end rather than through a seam.
 */
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
    // ENOTEMPTY IS A RACE WITH A PROCESS THIS FILE DELIBERATELY ORPHANS, NOT A TIDINESS PROBLEM.
    // The stub `docker` recreates its state directory (`mkdir -p "$STATE"`) at the top of EVERY
    // invocation, and the cases here SIGKILL a plugin subprocess mid-run precisely so a grandchild
    // outlives it. A `rm -r` that walks, empties and then `rmdir`s loses to an invocation that
    // lands between the walk and the rmdir: measured once in ~15 full `pnpm -w test` runs as
    // `Error: ENOTEMPTY: directory not empty, rmdir '/tmp/scp-fake-docker-…'`, failing a test whose
    // own assertions had already passed.
    //
    // `maxRetries` IS THE DOCUMENTED ANSWER, not a sleep in disguise: `fs.rm` retries exactly this
    // error set (EBUSY, EMFILE, ENFILE, ENOTEMPTY, EPERM) with linear backoff. Both files that
    // orphan a grandchild carry it — the property is "a temp-dir cleanup racing a process the test
    // deliberately left running", and it is two files wide.
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

describe("M23.1e: a MULTI-STEP managed run through a DEFAULT-CONSTRUCTED host cannot exceed its own budget", () => {
  it("four steps, each individually under the per-call bound, still finish within timeoutMs + one teardown", async () => {
    const fake = await makeSlowFakeDocker();
    const config = await managedIacConfig(fake, RUN_BUDGET_MS);

    // THE WHOLE POINT: no options. `host-bootstrap.ts` verbatim.
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

    // (vi) HIGH-2, END TO END: the container's own reap deadline had not passed while the run that
    //      stamped it was still going. This is the FLOOR of that property — the sharp, scale-free
    //      version (sampled continuously against a run that spends every millisecond of its budget)
    //      is `@scp/runner-launcher`'s `whole-run-budget.test.ts`, because at these wall clocks the
    //      two-minute grace hides the 18s overshoot that the defect actually produced.
    expect(stampedDeadlineMs(argv)).toBeGreaterThan(completedAt);
  }, 60_000);
});
