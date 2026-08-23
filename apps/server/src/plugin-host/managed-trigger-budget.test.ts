import { mkdtemp, chmod, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SubprocessPluginHost } from "./host.js";

/**
 * M23.1c — THE ONE TEST SHAPE THAT DID NOT EXIST AT ANY LEVEL, and the reason a ten-second SIGKILL
 * through every managed run shipped and stayed shipped.
 *
 * WHAT WAS ALREADY COVERED, AND WHY IT COVERED NOTHING. `managed-iac.integration.test.ts`'s own
 * header says it plainly: "it calls the plugin, not the server" — the real managed executor is
 * driven DIRECTLY, with no plugin host anywhere in the picture. And every test in the repository
 * that does construct a `SubprocessPluginHost` (four files, twenty-one constructions) passes an
 * explicit `callTimeoutMs` of 5–20s AND drives `fake-executor`, which answers instantly. So the
 * product's real configuration — `host-bootstrap.ts`'s `new SubprocessPluginHost()` with NO
 * options, i.e. the 10s default, in front of a plugin that runs a container for minutes — was the
 * one combination nothing exercised. Component correct, wiring untested, suite green: CLAUDE.md's
 * dominant defect class, and this file is the standing gate against it.
 *
 * THE HOST IS THEREFORE DEFAULT-CONSTRUCTED HERE. `new SubprocessPluginHost()`, no options, on
 * purpose — passing `callTimeoutMs` would reproduce exactly the blind spot being closed. If a
 * future edit adds an option to these constructions to "make the test faster", it has deleted the
 * test.
 *
 * NO REAL DOCKER, AND THAT IS NOT A COMPROMISE. What is under test is the RPC BUDGET, not the
 * runner: the seam is `config.dockerBinary` — the server-injected, tenant-refused field the plugin
 * `execFile`s — pointed at a stub `sh` script that sleeps past the old budget and keeps a
 * directory of "containers" that `create` adds to and `rm -f` removes from. That directory is what
 * makes "no container is left behind" an assertion with teeth rather than a hope, and the second
 * test below proves it has them by showing the stub DOES report an orphan under the old budget.
 */

const oldBudgetMs = 10_000;
/** Comfortably past the 10s default, short enough to keep the suite tolerable. */
const RUNNER_SLEEP_SECONDS = 12;

interface FakeDocker {
  /** Absolute path to hand the plugin as the server-injected `dockerBinary`. */
  binary: string;
  /** One file per container the daemon currently holds. Empty ⇒ nothing was left behind. */
  containersDir: string;
  /** Every argv the stub was invoked with, one line each. */
  logPath: string;
}

const tempDirs: string[] = [];
let host: SubprocessPluginHost | undefined;

/**
 * A stub `docker` that models the ONE property this test asserts about the daemon: a container
 * exists between `create` and `rm -f`. Absolute paths are baked into the script text rather than
 * passed as env, because `host.ts` allowlists the child's environment (CRITICAL #3) and nothing
 * this file sets would survive to the plugin subprocess, let alone to its own grandchild.
 */
async function makeFakeDocker(sleepSeconds: number): Promise<FakeDocker> {
  const dir = await mkdtemp(join(tmpdir(), "scp-fake-docker-"));
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
    "  create)",
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
    "    ;;",
    "  start)",
    `    sleep ${sleepSeconds}`,
    "    printf 'fake runner finished\\n'",
    "    ;;",
    "  rm)",
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
 *  that need a database — `runnerImage`/`workspaceRoot`/`networkMode`/`statePath`/`dockerBinary`
 *  are exactly the never-tenant-settable keys it injects, and `timeoutMs` is the tenant's. */
async function managedIacConfig(
  fake: FakeDocker,
  timeoutMs: number
): Promise<Record<string, unknown>> {
  const root = await mkdtemp(join(tmpdir(), "scp-managed-iac-budget-"));
  tempDirs.push(root);
  return {
    runnerImage: "scp-runner-iac:budget-test",
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

describe("managed executor trigger through a DEFAULT-CONSTRUCTED plugin host (M23.1c)", () => {
  it("a managed-iac run longer than the 10s hang detector completes, reports a terminal status, and leaves no container behind", async () => {
    const fake = await makeFakeDocker(RUNNER_SLEEP_SECONDS);
    // A tenant timeout well past the runner's own duration: the point is that the HOST no longer
    // interrupts, not that the plugin's inner timeout is generous.
    const config = await managedIacConfig(fake, 120_000);

    // THE WHOLE POINT: no options. This is `host-bootstrap.ts:75` verbatim.
    host = new SubprocessPluginHost();
    await host.start([
      {
        id: "managed-iac-budget",
        module: "managed-iac",
        orgId: "org-budget",
        scopeKey: "domain-budget",
        config
      }
    ]);

    // SAMPLED WHILE THE RUN IS IN FLIGHT, so the empty directory asserted at the end is a
    // TEARDOWN and not an observation channel that never sees anything (MEMORY: "vacuous tests —
    // green for the wrong reason"; a fixture that silently never applied is the classic shape).
    let sawContainerMidRun = false;
    const poller = setInterval(() => {
      void containersHeld(fake).then((held) => {
        if (held.length > 0) sawContainerMidRun = true;
      });
    }, 250);

    const startedAt = Date.now();
    const ref = await host
      .executor("managed-iac-budget")
      .trigger({
        kind: "sync",
        targetRef: "target-budget",
        idempotencyKey: "budget-probe-1",
        parameters: { iacAction: "plan", sourceFiles: { "main.tf": "# fixture\n" } }
      })
      .finally(() => clearInterval(poller));
    const elapsed = Date.now() - startedAt;

    // (i) trigger() RESOLVED — and genuinely outlived the old budget rather than short-circuiting.
    expect(ref.externalId).toBe("managed-iac::budget-probe-1");
    expect(elapsed).toBeGreaterThan(oldBudgetMs);

    // (ii) status() reports a TERMINAL phase. Under the old budget the subprocess was SIGKILLed
    //      before `saveState`, so the outcome cache had no entry and this read `pending` forever.
    const status = await host.executor("managed-iac-budget").status(ref);
    expect(status.phase).toBe("succeeded");

    // (iii) NO CONTAINER LEFT BEHIND. The adapter's `finally { rm -f <name> }` only runs if the
    //       subprocess is still alive to run it — and the stub genuinely held one while the run
    //       was in flight, so this is a teardown rather than a blind spot.
    expect(sawContainerMidRun).toBe(true);
    expect(await containersHeld(fake)).toEqual([]);
    const argv = await readFile(fake.logPath, "utf8");
    expect(argv).toContain("rm -f scp-runner-budget-probe-1");
  }, 60_000);

  /**
   * THE OTHER HALF OF DECISION (a), and a second guard against a vacuous first test.
   *
   * A managed `trigger` no longer gets the host's transparent crash-retry. `host.call()` normally
   * re-issues a request once per crash while budget remains — correct for an idempotent read, and
   * actively dangerous here now that the budget is minutes rather than seconds: the retry re-enters
   * a `trigger()` whose ledger entry is by construction not yet written, and its container name
   * (derived from the same `idempotencyKey`) collides with the first run's, whose unconditional
   * teardown then `rm -f`s the container that legitimately holds it.
   *
   * `killInstanceForTest` is the SAME `child.kill("SIGKILL")` the old uniform timeout performed, so
   * this also records what that timeout actually did to a run in flight — the container orphans and
   * the ledger stays empty — which is what makes the first test's assertions measurements rather
   * than hopes.
   */
  it("a crash mid-trigger is NOT transparently retried, and records the orphan the old SIGKILL left", async () => {
    const fake = await makeFakeDocker(6);
    const config = await managedIacConfig(fake, 120_000);

    host = new SubprocessPluginHost();
    await host.start([
      {
        id: "managed-iac-crash",
        module: "managed-iac",
        orgId: "org-budget",
        scopeKey: "domain-budget",
        config
      }
    ]);

    const pending = host.executor("managed-iac-crash").trigger({
      kind: "sync",
      targetRef: "target-crash",
      idempotencyKey: "crash-probe-1",
      parameters: { iacAction: "plan", sourceFiles: { "main.tf": "# fixture\n" } }
    });

    // Wait until the stub has actually created the container, then kill the subprocess under it.
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && (await containersHeld(fake)).length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(await containersHeld(fake)).toEqual(["scp-runner-crash-probe-1"]);
    host.killInstanceForTest("managed-iac-crash");

    // NOT retried. Were the transparent retry still in force, this would resolve — with a second
    // run of the same apply behind it.
    await expect(pending).rejects.toThrow(/exited while this call was in flight/);

    // The container is STILL HELD: the process that would have run `rm -f` is gone. This is the
    // orphan the ten-second budget produced on every managed run.
    expect(await containersHeld(fake)).toEqual(["scp-runner-crash-probe-1"]);

    // And the durable idempotency ledger has NO entry. Read off disk rather than through
    // `status()`, because that file is the artefact `reconcile.ts`'s retry consults: with nothing
    // written, its next attempt issues a SECOND apply while the first container is still running.
    const ledger = await readFile(config.statePath as string, "utf8").catch(() => "");
    expect(ledger).not.toContain("crash-probe-1");
  }, 60_000);
});
