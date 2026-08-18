import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RunnerSpec } from "./index.js";

/**
 * ================================================================================================
 * M23.3 — THE WHOLE-RUN BUDGET, THE REAP STAMP IT MAKES TRUE, AND THE TEARDOWN THAT MUST NOT FIRE
 * ================================================================================================
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM `docker-adapter.test.ts`. That suite's seam settles every
 * step on the NEXT TICK, deliberately — it is about WHAT goes on the command line and in what
 * ORDER, and a step that takes no time is the cleanest way to ask those questions. It is therefore
 * structurally unable to ask the only question M23.3 is about: HOW LONG. Every one of the four
 * defects below was invisible to eighty green tests for exactly that reason.
 *
 * THE SEAM HERE MODELS DURATION AND MODELS `timeout`, and the second half is not decoration:
 *   - a step takes {@link durations}[sub] milliseconds before its callback fires;
 *   - if the `timeout` the adapter passed is a POSITIVE number smaller than that, the callback
 *     fires at the timeout instead, with `killed: true, signal: "SIGTERM"` — the shape
 *     `promisify(execFile)` really produces (pinned against the running Node by
 *     `docker-adapter.test.ts`'s NODE_FAILURE_SHAPES table);
 *   - if `timeout` is `0` or absent, THE STEP IS NOT INTERRUPTED. That is not a simplification, it
 *     is Node's actual behaviour and the trap this change had to avoid: measured on the running
 *     Node, `execFile(…, { timeout: 0 })` let a 1.5s child run to completion. Modelling it here is
 *     what makes a regression to a naive `deadline - now` (which reaches 0 at exactly the moment a
 *     bound matters most) fail LOUDLY rather than pass.
 * A seam that ignored `timeout` would make every assertion below vacuous: the adapter's bound would
 * never be exercised and the run would simply take as long as the steps took.
 *
 * WHAT EACH DESCRIBE BLOCK IS THE STANDING GATE FOR:
 *   1. HIGH-1 — k steps, each individually under the bound, may not sum past the budget.
 *   2. HIGH-2 — the container's own `scp.launcher.deadline` may never be in the past while `run()`
 *      is still in flight. This is the one where being wrong destroys live infrastructure: to any
 *      peer launcher that container is then `foreign AND past deadline`, which is precisely and
 *      only what `reap()` removes.
 *   3. HIGH-3 — `reap()` may not spend the run's budget, may not delay `create`, and may not fail
 *      the run.
 *   4. The fourth defect — a `create` that lost the NAME must not tear that name down, while every
 *      other create failure still must.
 */

interface Rec {
  file: string;
  args: string[];
  opts: { timeout?: number; maxBuffer?: number };
  /** When the call was ISSUED, relative to {@link runStartedAt}. */
  issuedAt: number;
}

const calls: Rec[] = [];
/** Milliseconds each docker subcommand takes before it answers. Absent -> answers immediately. */
let durations: Record<string, number> = {};
/** Subcommands that reject (before their duration elapses is not modelled — they reject AT it). */
let failures: Record<string, Error> = {};
/** Subcommands that NEVER answer at all: no callback, ever. The `ps` arm of the reap tests. */
let neverAnswers: Set<string> = new Set();
/** What `reap()`'s `docker ps -a` reports. */
let psStdout = "";
/** Set by the first line of each test so `issuedAt` is a run-relative offset a human can read. */
let runStartedAt = 0;

vi.mock("node:child_process", () => ({
  execFile: (
    file: string,
    args: string[],
    opts: { timeout?: number; maxBuffer?: number },
    cb: (err: Error | null, result?: { stdout: string; stderr: string }) => void
  ) => {
    const sub = String(args[0]);
    calls.push({ file, args, opts, issuedAt: Date.now() - runStartedAt });
    if (neverAnswers.has(sub)) return;

    const duration = durations[sub] ?? 0;
    const timeout = opts?.timeout;
    // NODE'S OWN RULE, INCLUDING THE `0` TRAP — see this file's header.
    if (typeof timeout === "number" && timeout > 0 && timeout < duration) {
      setTimeout(() => {
        cb(
          Object.assign(new Error(`Command failed: ${file} ${args.join(" ")}`), {
            code: null,
            killed: true,
            signal: "SIGTERM",
            stdout: "",
            stderr: ""
          })
        );
      }, timeout);
      return;
    }
    setTimeout(() => {
      const failure = failures[sub];
      if (failure) {
        cb(failure);
        return;
      }
      if (sub === "create") {
        cb(null, { stdout: "container-abc\n", stderr: "" });
        return;
      }
      if (sub === "ps") {
        cb(null, { stdout: psStdout, stderr: "" });
        return;
      }
      cb(null, { stdout: "runner ok", stderr: "" });
    }, duration);
  }
}));

const {
  RUNNER_LAUNCHER_DEADLINE_LABEL,
  RUNNER_REAP_GRACE_MS,
  RUNNER_REMOVE_TIMEOUT_MS,
  RunnerLaunchError,
  createDockerRunnerLauncher,
  isContainerNameConflict,
  whenReapSettled
} = await import("./index.js");

/** managed-iac's shape: one copy-in, one copy-out — four calls inside the budget, plus teardown. */
function spec(overrides: Partial<RunnerSpec> = {}): RunnerSpec {
  return {
    runId: "budget-probe",
    labels: {},
    image: "scp-runner-iac:vetted",
    operands: [],
    networkMode: "none",
    env: [],
    secretEnv: [],
    copyIn: [{ hostDir: "/host/in", containerPath: "/work/in" }],
    copyOut: {
      containerPath: "/work/out",
      hostDir: "/host/out",
      when: "always",
      onFailure: "swallow"
    },
    timeoutMs: 1_000,
    maxBuffer: 16 * 1024 * 1024,
    ...overrides
  };
}

/** The steps of the RUN PROPER, in issue order — teardown and reap's own calls excluded. Both
 *  copies are `cp`; the copy-OUT is the one whose destination carries no `<id>:` prefix. */
function runSteps(): Rec[] {
  return calls.filter(
    (c) => c.args[0] === "create" || c.args[0] === "cp" || c.args[0] === "start"
  );
}
function teardownCalls(): Rec[] {
  return calls.filter((c) => c.args[0] === "rm" && String(c.args[2]).startsWith("scp-runner-"));
}
function createdDeadlineLabel(): number {
  const create = calls.find((c) => c.args[0] === "create");
  if (!create) throw new Error("whole-run-budget.test: no `create` was issued");
  const idx = create.args.findIndex(
    (a, i) =>
      a === "--label" &&
      String(create.args[i + 1] ?? "").startsWith(`${RUNNER_LAUNCHER_DEADLINE_LABEL}=`)
  );
  if (idx === -1) throw new Error("whole-run-budget.test: `create` carried no deadline label");
  return Date.parse(String(create.args[idx + 1]).slice(RUNNER_LAUNCHER_DEADLINE_LABEL.length + 1));
}

beforeEach(() => {
  calls.length = 0;
  durations = {};
  failures = {};
  neverAnswers = new Set();
  psStdout = "";
  runStartedAt = Date.now();
});

// ==================================================================================================
describe("M23.3 HIGH-1: `timeoutMs` bounds the RUN, not each execFile of it", () => {
  // ================================================================================================
  it("FOUR STEPS, EACH WELL UNDER THE PER-CALL BOUND, STILL CANNOT EXCEED THE WHOLE-RUN BUDGET", async () => {
    // THE NUMBERS ARE CHOSEN SO THAT THE ONLY THING THAT CAN FAIL IS THE PROPERTY. Every step —
    // 800ms, 800ms, 1800ms — is comfortably inside the 2000ms bound the old code handed out AFRESH
    // to each of them, so "no single call exceeded its timeout" is true either way and cannot be
    // what distinguishes the two. Their SUM (3400ms) is what the budget has to cut off, and it cuts
    // it off mid-`start`: the run ends at 2000ms.
    durations = { create: 800, cp: 800, start: 1_800 };
    const startedAt = Date.now();
    await createDockerRunnerLauncher("docker").run(spec({ timeoutMs: 2_000 }));
    const elapsed = Date.now() - startedAt;

    expect(
      elapsed,
      `the run took ${Date.now() - startedAt}ms of a 2000ms budget — the steps' timeouts are being refreshed`
    ).toBeLessThan(2_000 + 600);
    // AND IT REALLY DID SPEND THE BUDGET, rather than failing out early: the lower bound is what
    // stops a launcher that refused everything from passing the upper one.
    expect(elapsed).toBeGreaterThanOrEqual(2_000 - 100);
    // NOT VACUOUS: it really did do multi-step work rather than short-circuiting at step one.
    expect(runSteps().map((c) => c.args[0])).toStrictEqual(["create", "cp", "start"]);
  });

  it("EACH STEP IS ISSUED WITH WHAT IS LEFT — strictly decreasing, never above the budget, never 0", async () => {
    durations = { create: 150, cp: 150, start: 150 };
    await createDockerRunnerLauncher("docker").run(spec({ timeoutMs: 5_000 }));

    const timeouts = runSteps().map((c) => c.opts.timeout ?? 0);
    // create, copy-in, start, copy-out — the four calls managed-iac's shape issues in-budget.
    expect(timeouts).toHaveLength(4);
    for (const t of timeouts) {
      // `timeout: 0` IS NO TIMEOUT AT ALL in Node — the one value the derivation must never produce.
      expect(t).toBeGreaterThan(0);
      expect(t).toBeLessThanOrEqual(5_000);
    }
    // STRICTLY decreasing: a step that got its budget refreshed is the defect, and equality is what
    // "each call gets spec.timeoutMs" looks like.
    for (let i = 1; i < timeouts.length; i += 1) {
      expect(timeouts[i], `step ${i} did not inherit the spent budget`).toBeLessThan(
        timeouts[i - 1]!
      );
    }
    // And it really is the SPENT time that came off, not an arbitrary decrement.
    expect(timeouts[1]!).toBeLessThanOrEqual(5_000 - 150);
    expect(timeouts[2]!).toBeLessThanOrEqual(5_000 - 300);
    expect(timeouts[3]!).toBeLessThanOrEqual(5_000 - 450);
  });

  it("A STEP REACHED WITH THE BUDGET GONE IS REFUSED BEFORE IT IS ISSUED, naming the deadline", async () => {
    // `create` alone eats the whole budget, so `copy-in` is reached with nothing left. It must not
    // be issued at all — and it must not be issued with `timeout: 0`, which would be unbounded.
    durations = { create: 900 };
    const launcher = createDockerRunnerLauncher("docker");
    const failed = await launcher.run(spec({ timeoutMs: 300 })).catch((e: unknown) => e);

    expect(failed).toBeInstanceOf(RunnerLaunchError);
    const err = failed as InstanceType<typeof RunnerLaunchError>;
    expect(err.step).toBe("create");
    expect(err.deadlineExceeded, "the rejection must name itself as a budget exhaustion").toBe(true);
    expect(err.message).toContain("whole-run budget of 300ms");
    expect(err.message).toContain("RunnerSpec.timeoutMs");
    // The steps after it were never issued, and the teardown still was.
    expect(calls.map((c) => c.args[0])).toStrictEqual(["ps", "create", "rm"]);
  });

  it("THE REFUSAL PATH TOO: a step reached at exactly zero remaining is never handed to Node", async () => {
    // `start` is killed by the derived timeout, which lands the clock exactly on the deadline; the
    // copy-out that follows (managed-iac's `when: "always"`) therefore has nothing left. It must be
    // REFUSED rather than issued — `Math.max(1, …)` keeps Node in range, but issuing a doomed
    // `docker cp` at the deadline is a call whose only possible outcome is another SIGTERM.
    durations = { create: 50, cp: 50, start: 5_000 };
    await createDockerRunnerLauncher("docker").run(spec({ timeoutMs: 400 }));

    const copyOuts = calls.filter(
      (c) => c.args[0] === "cp" && !String(c.args[2]).includes(":")
    );
    expect(copyOuts, "the copy-out was issued with a spent budget").toStrictEqual([]);
    // Every timeout that DID reach Node was a legal, non-zero value.
    for (const c of runSteps()) expect(c.opts.timeout).toBeGreaterThan(0);
  });

  it("THE TEARDOWN IS DELIBERATELY OUTSIDE THE BUDGET — it still runs, at its own 30s", async () => {
    // If the teardown inherited the run's deadline it would be refused on exactly the path it exists
    // for: the one where the budget is what ran out. That would orphan a container every time.
    durations = { create: 5_000 };
    await createDockerRunnerLauncher("docker")
      .run(spec({ timeoutMs: 200 }))
      .catch(() => undefined);

    expect(teardownCalls().map((c) => c.opts)).toStrictEqual([
      { timeout: RUNNER_REMOVE_TIMEOUT_MS }
    ]);
  });
});

// ==================================================================================================
describe("M23.3 HIGH-2: the container's stamped deadline is never in the past while run() is in flight", () => {
  // ================================================================================================
  it("SAMPLED THROUGHOUT A RUN THAT SPENDS ITS WHOLE BUDGET, the stamp is always in the future", async () => {
    // The measured defect: managed-scan's real shape (3 copy-ins, timeoutMs 30_000, steps of 28s)
    // stamped ~t0+150000ms and returned at 168354ms — 18s in which the container was, to every peer
    // launcher, foreign AND past deadline, i.e. exactly what `reap()` removes. Here the run spends
    // its entire budget and overruns every individual step, which is the worst case.
    durations = { create: 300, cp: 300, start: 5_000 };
    const launcher = createDockerRunnerLauncher("docker");

    let worstMarginMs = Number.POSITIVE_INFINITY;
    let samples = 0;
    const sampler = setInterval(() => {
      if (!calls.some((c) => c.args[0] === "create")) return;
      samples += 1;
      worstMarginMs = Math.min(worstMarginMs, createdDeadlineLabel() - Date.now());
    }, 25);
    await launcher.run(spec({ timeoutMs: 900 })).finally(() => clearInterval(sampler));
    // One last sample at the instant `run()` returned — the moment the old code was 18s past.
    worstMarginMs = Math.min(worstMarginMs, createdDeadlineLabel() - Date.now());

    expect(samples, "the sampler never observed a created container — vacuous").toBeGreaterThan(3);
    expect(
      worstMarginMs,
      "the run was past the deadline it stamped on its own container; a peer's reap() would rm -f a live apply"
    ).toBeGreaterThan(0);
  });

  it("THE STAMP IS THE RUN DEADLINE PLUS THE GRACE, off the SAME clock read the run is bounded by", async () => {
    // The formula, so that "always in the future" cannot be satisfied by an absurdly distant stamp
    // (which would make `reap()` never collect a real orphan) nor by one derived from a second,
    // later `Date.now()` — the second read is how the two drifted apart in the first place.
    const before = Date.now();
    durations = { create: 50, cp: 50, start: 50 };
    await createDockerRunnerLauncher("docker").run(spec({ timeoutMs: 30_000 }));
    const after = Date.now();

    expect(createdDeadlineLabel()).toBeGreaterThanOrEqual(before + 30_000 + RUNNER_REAP_GRACE_MS);
    expect(createdDeadlineLabel()).toBeLessThanOrEqual(after + 30_000 + RUNNER_REAP_GRACE_MS);
  });

  it("THE GRACE COVERS THE ONLY WORK THAT HAPPENS AFTER THE DEADLINE — one teardown", async () => {
    // The whole re-derivation, as an executable relationship rather than a comment. `run()` cannot
    // pass its deadline by more than one `docker rm -f`, so this is the single term the grace has
    // to carry; the old doc derived it across a package boundary from a constant this package is
    // forbidden to import, and nothing checked the arithmetic.
    expect(RUNNER_REAP_GRACE_MS).toBeGreaterThan(RUNNER_REMOVE_TIMEOUT_MS);
  });
});

// ==================================================================================================
describe("M23.3 HIGH-3: reap() cannot spend the run's budget, delay `create`, or fail the run", () => {
  // ================================================================================================
  const FOREIGN = "22222222-2222-4222-8222-222222222222";
  const expired = (): string => new Date(Date.now() - 60_000).toISOString();

  it("FOUR SLOW ORPHANS DO NOT DELAY `create` BY SO MUCH AS A TICK", async () => {
    // HIGH-3's measurement: `timeoutMs: 1_000` and four stale orphans at 9s each meant the budget
    // (31s) expired at 31.2s with `create` NEVER ISSUED. Scaled down 10x, and asserted on the thing
    // that actually matters — WHEN `create` went out — rather than on the run merely succeeding.
    psStdout = [1, 2, 3, 4].map((n) => `orphan-${n}\t${FOREIGN}\t${expired()}`).join("\n");
    durations = { rm: 900, create: 20, cp: 20, start: 20 };

    runStartedAt = Date.now();
    const result = await createDockerRunnerLauncher("docker").run(spec({ timeoutMs: 1_000 }));

    const create = calls.find((c) => c.args[0] === "create");
    expect(create, "create was never issued at all").toBeDefined();
    expect(
      create!.issuedAt,
      "create waited on the reaper — the sweep is back inside the run's critical path"
    ).toBeLessThan(100);
    expect(result.succeeded).toBe(true);
    await whenReapSettled();
  });

  it("A REAP THAT NEVER ANSWERS AT ALL LETS THE RUN COMPLETE NORMALLY", async () => {
    // A wedged daemon answering `docker ps` never is the unbounded case. Awaited, it is an RPC that
    // never returns; scheduled, it is nothing at all. A DEDICATED BINARY NAME, because the
    // single-flight slot is keyed by binary and this pass is deliberately left hanging forever.
    neverAnswers = new Set(["ps"]);
    durations = { create: 20, cp: 20, start: 20 };

    const result = await createDockerRunnerLauncher("docker-wedged").run(spec({ timeoutMs: 1_000 }));

    expect(result.succeeded).toBe(true);
    expect(calls.filter((c) => c.args[0] === "ps")).toHaveLength(1);
    expect(runSteps().map((c) => c.args[0])).toStrictEqual(["create", "cp", "start", "cp"]);
  });

  it("A REAP WHOSE LISTING FAILS NEVER FAILS THE RUN", async () => {
    failures = { ps: new Error("docker: Cannot connect to the Docker daemon") };
    const result = await createDockerRunnerLauncher("docker").run(spec({ timeoutMs: 1_000 }));
    expect(result.succeeded).toBe(true);
    await whenReapSettled();
  });

  it("A REAP WHOSE REMOVALS ALL FAIL NEVER FAILS THE RUN", async () => {
    psStdout = `orphan-1\t${FOREIGN}\t${expired()}`;
    failures = { rm: new Error("docker: no such container") };
    // `rm` failing also fails this run's own teardown, which is swallowed by design.
    const result = await createDockerRunnerLauncher("docker").run(spec({ timeoutMs: 1_000 }));
    expect(result.succeeded).toBe(true);
    await whenReapSettled();
  });

  it("ONE PASS IS HARD-BOUNDED: it stops removing at its own deadline and leaves the rest for the next", async () => {
    // BOUNDING THE INDIVIDUAL CALLS BOUNDS NOTHING when the number of calls is the unbounded term:
    // n orphans at RUNNER_REMOVE_TIMEOUT_MS each is n x 30s, and n grows with every crash the fleet
    // has had — including the crashes an over-long reap causes, which is HIGH-3's amplification.
    // A pass therefore has its own deadline and simply STOPS; what is left is still expired, still
    // labelled and still there next time, because a sweep is idempotent.
    //
    // FAKE TIMERS, BECAUSE THE BUDGET IS TWO REAL MINUTES. Vitest's fake clock drives `Date.now()`
    // as well as `setTimeout`, so the adapter's own deadline arithmetic runs against it — the
    // alternative is either a two-minute test or a budget shrunk to suit the test, and the second
    // is how a constant stops meaning what it says.
    vi.useFakeTimers();
    try {
      psStdout = Array.from(
        { length: 10 },
        (_, n) => `slow-orphan-${n + 1}\t${FOREIGN}\t${expired()}`
      ).join("\n");
      durations = { rm: 25_000 };

      const pass = createDockerRunnerLauncher("docker-bounded").reap();
      await vi.advanceTimersByTimeAsync(10 * 25_000 + 60_000);
      const removed = await pass;

      // 25s each into a RUNNER_REAP_BUDGET_MS pass: the loop keeps starting removals while the
      // deadline is still ahead, so it gets through some and abandons the rest — the exact number
      // is arithmetic, not a target, but it must be BOTH more than zero and fewer than all ten.
      expect(removed.length).toBeGreaterThan(0);
      expect(
        removed.length,
        "the pass ran the whole unbounded list — its own budget is not enforced"
      ).toBeLessThan(10);
      // Every removal it DID attempt succeeded, so the shortfall is the budget and nothing else.
      expect(removed.length).toBe(calls.filter((c) => c.args[0] === "rm").length);
    } finally {
      vi.useRealTimers();
    }
  });

  it("CONCURRENT RUNS SHARE ONE SWEEP — k runs do not start k passes over the same containers", async () => {
    // Self-amplification's other half: the sweep is idempotent, so a caller arriving while one is
    // in flight has nothing to add. Without the single-flight slot, three concurrent triggers list
    // the same containers three times and race to `rm -f` the same ids, and every loser's rejection
    // is swallowed — waste that is invisible by construction.
    durations = { ps: 200, create: 10, cp: 10, start: 10 };
    const launcher = createDockerRunnerLauncher("docker-shared");
    await Promise.all([
      launcher.run(spec({ runId: "conc-a", timeoutMs: 2_000 })),
      launcher.run(spec({ runId: "conc-b", timeoutMs: 2_000 })),
      launcher.run(spec({ runId: "conc-c", timeoutMs: 2_000 }))
    ]);
    await whenReapSettled("docker-shared");

    expect(calls.filter((c) => c.args[0] === "ps")).toHaveLength(1);
    expect(calls.filter((c) => c.args[0] === "create")).toHaveLength(3);
  });
});

// ==================================================================================================
describe("M23.3: a `create` that lost the NAME tears nothing down; every other create failure still does", () => {
  // ================================================================================================
  /** MEASURED, Docker 29.5.2, through `promisify(execFile)`. */
  const CONFLICT_STDERR =
    'Error response from daemon: Conflict. The container name "/scp-runner-budget-probe" is ' +
    'already in use by container "fd602b921ac608a0f33551acba7943abbf2816160d30e09e3a33d8f86f1873c5". ' +
    "You have to remove (or rename) that container to be able to reuse that name.";

  it("NAME CONFLICT — NO teardown at all: the container behind that name is somebody else's", async () => {
    failures = {
      create: Object.assign(new Error(`Command failed: docker create …\n${CONFLICT_STDERR}`), {
        code: 1,
        killed: false,
        stdout: "",
        stderr: CONFLICT_STDERR
      })
    };
    await createDockerRunnerLauncher("docker")
      .run(spec())
      .catch(() => undefined);

    expect(
      teardownCalls(),
      "the losing run destroyed the container that legitimately holds the name"
    ).toStrictEqual([]);
    expect(calls.map((c) => c.args[0])).toStrictEqual(["ps", "create"]);
  });

  it("EVERY OTHER CREATE FAILURE STILL TEARS DOWN BY NAME — M23.0 defect 1 must not regress", async () => {
    // THE OTHER ARM, AND WITHOUT IT "skip teardown on any create failure" passes the case above.
    // A `create` that timed out or hit a dead daemon may still have had a container committed for
    // it, and the NAME is the only identity that exists on that path.
    failures = {
      create: Object.assign(new Error("Command failed: docker create …"), {
        code: 125,
        killed: false,
        stdout: "",
        stderr: "docker: Error response from daemon: no such image: scp-runner-iac:vetted"
      })
    };
    await createDockerRunnerLauncher("docker")
      .run(spec())
      .catch(() => undefined);

    expect(teardownCalls().map((c) => c.args)).toStrictEqual([
      ["rm", "-f", "scp-runner-budget-probe"]
    ]);
  });

  it("A create KILLED BY THE RUN'S OWN DEADLINE still tears down — a timeout is not a conflict", async () => {
    durations = { create: 5_000 };
    await createDockerRunnerLauncher("docker")
      .run(spec({ timeoutMs: 200 }))
      .catch(() => undefined);

    expect(teardownCalls().map((c) => c.args)).toStrictEqual([
      ["rm", "-f", "scp-runner-budget-probe"]
    ]);
  });

  it("THE PREDICATE ITSELF — what it matches, and what it must never match", () => {
    // Read off a real daemon rather than imagined; see `isContainerNameConflict`'s own doc.
    expect(isContainerNameConflict({ stderr: CONFLICT_STDERR })).toBe(true);
    expect(isContainerNameConflict(new Error(`Command failed: …\n${CONFLICT_STDERR}`))).toBe(true);
    // podman's wording differs from Docker's and is NOT measured here; the shared substring is what
    // the match is deliberately broad enough to cover.
    expect(
      isContainerNameConflict({
        stderr: 'Error: creating container storage: the container name "x" is already in use'
      })
    ).toBe(true);

    // THE FALSE-NEGATIVE DIRECTION IS THE DANGEROUS ONE, so these must stay false: each of them
    // MUST be followed by a teardown, because the daemon may have committed a container.
    expect(isContainerNameConflict({ stderr: "no such image: scp-runner-iac:vetted" })).toBe(false);
    expect(isContainerNameConflict({ killed: true, signal: "SIGTERM" })).toBe(false);
    expect(isContainerNameConflict(undefined)).toBe(false);
    expect(isContainerNameConflict(new Error("Cannot connect to the Docker daemon"))).toBe(false);
  });
});
