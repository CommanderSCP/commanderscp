import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RunnerSpec } from "./index.js";

/**
 * ================================================================================================
 * M23.1e — THE WHOLE-RUN BUDGET, THE REAP STAMP IT MAKES TRUE, AND THE TEARDOWN THAT MUST NOT FIRE
 * ================================================================================================
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM `docker-adapter.test.ts`. That suite's seam settles every
 * step on the NEXT TICK, deliberately — it is about WHAT goes on the command line and in what
 * ORDER, and a step that takes no time is the cleanest way to ask those questions. It is therefore
 * structurally unable to ask the only question M23.1e is about: HOW LONG. Every one of the four
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
  MANAGED_RUN_TIMEOUT_MAX_MS,
  classifyRunnerFailure,
  RUNNER_LAUNCHER_DEADLINE_LABEL,
  RUNNER_REAP_GRACE_MS,
  RUNNER_REMOVE_TIMEOUT_MS,
  RUNNER_SECRET_ENV_MAX_AGE_MS,
  RunnerLaunchError,
  clampRunTimeoutMs,
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
  return calls.filter((c) => c.args[0] === "create" || c.args[0] === "cp" || c.args[0] === "start");
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
describe("M23.1e HIGH-1: `timeoutMs` bounds the RUN, not each execFile of it", () => {
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
    //
    // THE PER-STEP MILLISECOND IS THE CLOCK DISAGREEMENT THIS PACKAGE HAS ALREADY MEASURED AND
    // WRITTEN DOWN — not a fudge factor bolted on to make a red test green. `RunDeadline` reads
    // `Date.now()`; each fake step here completes on a libuv timer; the two clocks disagree by up
    // to a millisecond, so `setTimeout(150)` can hand control back with `Date.now()` having
    // advanced only 149. `index.ts`'s `isExhausted()` docblock records exactly this mechanism,
    // measured on three OTHER arms of this same file — "3 runs in 8, a different arm each time,
    // which is the signature of a boundary the process cannot land on rather than of a test that
    // is wrong". That fix hardened the production refusal and left this arm's arithmetic still
    // assuming a step always spends at least its NOMINAL duration. CI then caught it at exactly
    // one millisecond: `expected 4851 to be less than or equal to 4850`.
    //
    // IT ACCUMULATES, so the allowance is per-step rather than a single constant: step N has N
    // completed sleeps behind it and can therefore under-report by up to N ms.
    //
    // AND IT STAYS NON-VACUOUS BY TWO ORDERS OF MAGNITUDE. The hypothesis these three lines exist
    // to refute is "the budget was decremented by an arbitrary constant rather than by the time
    // actually spent". A fixed per-step decrement would leave `timeouts[1]` up around 4990 against
    // a bound of 4851 — a ~140ms gap. Three milliseconds of clock slop does not reach across it,
    // so every one of these lines still fails against the defect it was written for.
    const CLOCK_SLOP_MS = 1; // per completed step; see above
    expect(timeouts[1]!).toBeLessThanOrEqual(5_000 - 150 + 1 * CLOCK_SLOP_MS);
    expect(timeouts[2]!).toBeLessThanOrEqual(5_000 - 300 + 2 * CLOCK_SLOP_MS);
    expect(timeouts[3]!).toBeLessThanOrEqual(5_000 - 450 + 3 * CLOCK_SLOP_MS);
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
    expect(err.deadlineExceeded, "the rejection must name itself as a budget exhaustion").toBe(
      true
    );
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

    const copyOuts = calls.filter((c) => c.args[0] === "cp" && !String(c.args[2]).includes(":"));
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
describe("M23.1e HIGH-2: the container's stamped deadline is never in the past while run() is in flight", () => {
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
    // The formula, so that "always in the future" cannot be satisfied by an absurdly distant stamp,
    // which would make `reap()` never collect a real orphan.
    //
    // CORRECTED CLAIM (this comment used to say the bracket also caught a stamp "derived from a
    // second, later `Date.now()`" — measured false). `before`/`after` bracket the WHOLE `run()`
    // call, so ANY clock read taken during that call satisfies both bounds, including a second read
    // taken at the reapDeadline call site itself: `new Date(runDeadlineAt + RUNNER_REAP_GRACE_MS)`
    // mutated to `new Date(Date.now() + runTimeoutMs + RUNNER_REAP_GRACE_MS)`, at the same line,
    // survives the whole file (117/117) and the managed-iac/scan/dep and plugin-host sibling suites
    // — no time elapses between the two reads at that point in `run()`, so the two stamps are
    // indistinguishable in practice. The mutation is SAFE, not undetected-and-dangerous: a later
    // read only ever makes the stamp later (the conservative direction), and the actually dangerous
    // direction — dropping the grace entirely — IS caught, here and by the siblings. The real HIGH-2
    // regression this file guards against was a stamp read much LATER in `run()`, after real async
    // work had elapsed; "SAMPLED THROUGHOUT A RUN THAT SPENDS ITS WHOLE BUDGET" above is what
    // actually catches that.
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
describe("M23.1e HIGH-3: reap() cannot spend the run's budget, delay `create`, or fail the run", () => {
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

    const result = await createDockerRunnerLauncher("docker-wedged").run(
      spec({ timeoutMs: 1_000 })
    );

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
describe("M23.1e: a `create` that lost the NAME tears nothing down; every other create failure still does", () => {
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

// ==================================================================================================
describe("MEDIUM (verification pass 5): the product CEILING binds the run, not only the host budget", () => {
  // ================================================================================================
  /**
   * WHAT WAS WRONG. `MANAGED_RUN_TIMEOUT_MAX_MS` was enforced in exactly two places — the three
   * manifests' `configSchema` (the write door, which a row stored before the ceiling existed never
   * passes through again) and `resolveCallPolicy`, which clamps only its OWN return value, the
   * host's RPC budget. All three plugins passed the STORED `timeoutMs` into `RunnerSpec.timeoutMs`
   * untouched and this adapter derived its deadline, its step timeouts and its container's reap
   * stamp from that unclamped number. Measured for a stored 4h:
   *
   *     host budgetMs                 3_660_000   (clamped: 3_600_000 + the 60s trigger grace)
   *     RunnerSpec.timeoutMs         14_400_000   (UNCLAMPED)
   *     the host SIGKILLs at t+3_660_000ms and the container it orphans is stamped t+14_520_000ms
   *     -> UNREAPABLE for a further 181 minutes, with `docker inspect` still holding its credentials
   *
   * THE ARMS BELOW DRIVE THE THREE PLACES THE UNCLAMPED NUMBER REACHED, one each, so that removing
   * the clamp reddens them BY NAME rather than reddening one composite assertion.
   *
   * THE STORED VALUE USED THROUGHOUT is 4 hours — a real inhabitant of the pre-ceiling schema
   * (`{ minimum: 1000 }` admitted up to 2^31), large enough that every bound below is unambiguous,
   * and small enough that its arithmetic is readable next to a one-hour ceiling.
   */
  const STORED_4H = 4 * 60 * 60_000;
  /** What the ceiling makes of it. Not a literal, so a change to the ceiling moves the whole block. */
  const CLAMPED = clampRunTimeoutMs(STORED_4H);

  it("clampRunTimeoutMs: above the ceiling collapses to it, below it passes through, non-finite fails CLOSED", () => {
    expect(CLAMPED).toBe(MANAGED_RUN_TIMEOUT_MAX_MS);
    expect(clampRunTimeoutMs(2 ** 31)).toBe(MANAGED_RUN_TIMEOUT_MAX_MS);
    // Below the ceiling the caller's own number survives — the port must not rewrite a legitimate
    // spec, and the three `launch-argv.golden.test.ts` files pin these very numbers.
    expect(clampRunTimeoutMs(600_000)).toBe(600_000);
    expect(clampRunTimeoutMs(1)).toBe(1);
    // `NaN` is the dangerous one: `now + NaN` is NaN, the `remaining <= 0` refusal is then FALSE and
    // `Math.max(1, NaN)` is NaN — `docker start -a` with no bound at all, reached through the one
    // branch that exists to prevent that.
    expect(clampRunTimeoutMs(Number.NaN)).toBe(MANAGED_RUN_TIMEOUT_MAX_MS);
    expect(clampRunTimeoutMs(Number.POSITIVE_INFINITY)).toBe(MANAGED_RUN_TIMEOUT_MAX_MS);
  });

  it("A STORED timeoutMs ABOVE THE CEILING IS CLAMPED BEFORE IT REACHES THE DEADLINE", async () => {
    // Every step's `timeout` is `runDeadlineAt - now`, so the deadline is observable through them:
    // if the clamp is missing, `create` goes out with 14_400_000 and this fails on the first step.
    durations = { create: 20, cp: 20, start: 20 };
    await createDockerRunnerLauncher("docker").run(spec({ timeoutMs: STORED_4H }));

    const timeouts = runSteps().map((c) => c.opts.timeout ?? 0);
    expect(timeouts, "the run issued no steps at all — vacuous").toHaveLength(4);
    for (const t of timeouts) {
      expect(
        t,
        `a step was issued with ${t}ms — above the ${CLAMPED}ms ceiling`
      ).toBeLessThanOrEqual(CLAMPED);
      expect(t).toBeGreaterThan(0);
    }
    // And it really is the CEILING that bound it, not some smaller accident: the first step gets
    // essentially the whole clamped budget.
    expect(timeouts[0]!).toBeGreaterThan(CLAMPED - 1_000);
  });

  it("A STORED timeoutMs ABOVE THE CEILING IS CLAMPED BEFORE IT REACHES THE REAP STAMP", async () => {
    // THE ONE THAT DEFEATS THE REAPER. `reap()` removes containers that are foreign AND past their
    // stamp, so an over-ceiling stamp is an orphan nothing collects — for the 4h here, 181 minutes
    // past the SIGKILL that created it.
    const before = Date.now();
    durations = { create: 20, cp: 20, start: 20 };
    await createDockerRunnerLauncher("docker").run(spec({ timeoutMs: STORED_4H }));
    const after = Date.now();

    // BRACKETED, NOT COMPARED TO A SINGLE PRE-RUN READ — verification pass 6. The stamp is
    // `t_run + BOUND`, where `t_run` is run()'s OWN single clock read and `before <= t_run <= after`
    // by construction. The previous form asserted `stamp - before <= BOUND`, which expands to
    // `(t_run - before) + BOUND <= BOUND` and is therefore satisfiable ONLY when `t_run === before`
    // — i.e. only when zero milliseconds elapsed between this test's clock read and run()'s own.
    // It failed whenever the setup between them crossed a millisecond boundary: measured at 5/10 in
    // isolation, 3/8 at package scope and 1/4 on a full `turbo test --force`, on an UNMUTATED tree,
    // with the excess always exactly the elapsed setup time (probed by injecting a 50ms sleep: the
    // overshoot became 51ms). Bracketing needs no slack constant and is exact in both directions.
    const BOUND = CLAMPED + RUNNER_REAP_GRACE_MS;
    expect(
      createdDeadlineLabel(),
      "the container was stamped past the ceiling — a peer's reap() will not collect this orphan"
    ).toBeLessThanOrEqual(after + BOUND);
    // NOT VACUOUS in the other direction: the stamp is still the clamped budget plus the grace, not
    // some tiny value that would make a LIVE run reapable (HIGH-2's hazard, in reverse).
    expect(
      createdDeadlineLabel(),
      "the stamp is BELOW the clamped budget plus the grace — a LIVE run would look reapable"
    ).toBeGreaterThanOrEqual(before + BOUND);
  });

  it("A STORED timeoutMs ABOVE THE CEILING IS CLAMPED BEFORE IT REACHES THE FILE-AGE BOUND", async () => {
    // `RUNNER_SECRET_ENV_MAX_AGE_MS` is `MANAGED_RUN_TIMEOUT_MAX_MS + RUNNER_REAP_GRACE_MS`, and its
    // safety argument is "no run still inside its own budget can make its own `--env-file` look this
    // old". The `--env-file` is written at the top of `run()`, off the same clock the stamp is; so
    // the argument is true exactly when the stamp is never further out than that age. That is the
    // arithmetic this asserts, against the SAME emitted stamp the reaper reads — the doc used to
    // rest instead on a ceiling nothing applied plus a SIGKILL from a package this one may not
    // import (and which the one in-process caller does not have at all).
    const writtenAt = Date.now();
    durations = { create: 20, cp: 20, start: 20 };
    await createDockerRunnerLauncher("docker").run(spec({ timeoutMs: STORED_4H }));
    const after = Date.now();

    // BRACKETED for the same reason as the REAP STAMP arm above (verification pass 6) — and the
    // reference point matters here in a way it did not there. The `--env-file` is written INSIDE
    // `run()`, so its mtime is at or after run()'s clock read; `writtenAt` is read BEFORE the call
    // and is therefore an upper bound on the file's age that is strictly LARGER than the real one.
    // Comparing that proxy against the bound could only pass when the two reads landed in the same
    // millisecond. `after` brackets run()'s read from above, which is the true comparison.
    expect(
      createdDeadlineLabel(),
      "a live run can outlive RUNNER_SECRET_ENV_MAX_AGE_MS — reap() may unlink a credential mid-run"
    ).toBeLessThanOrEqual(after + RUNNER_SECRET_ENV_MAX_AGE_MS);
    expect(
      createdDeadlineLabel(),
      "the stamp is below the age bound — the bound would no longer cover a live run's own file"
    ).toBeGreaterThanOrEqual(writtenAt + RUNNER_SECRET_ENV_MAX_AGE_MS);
  });

  it("AN ORPHAN A KILLED RUN LEAVES IS REAPABLE WITHIN A BOUNDED TIME, whatever the stored value", async () => {
    // THE COMPOSITION, DRIVEN RATHER THAN ASSERTED IN PROSE. The stamp is read back from the
    // launcher's own `create` argv (never a literal), shifted back by the bound, and fed to a REAL
    // `reap()` pass as a FOREIGN container. If the bound holds, a peer that started `bound` ago is
    // past its stamp NOW and is removed; without the clamp that same shifted stamp is ~3 hours in
    // the FUTURE and `reap()` correctly leaves it — which is precisely the defect.
    const FOREIGN_OWNER = "33333333-3333-4333-8333-333333333333";
    const bound = MANAGED_RUN_TIMEOUT_MAX_MS + RUNNER_REAP_GRACE_MS;
    durations = { create: 20, cp: 20, start: 20 };

    const launcher = createDockerRunnerLauncher("docker-ceiling");
    await launcher.run(spec({ timeoutMs: STORED_4H }));
    await whenReapSettled("docker-ceiling"); // the run scheduled its own pass; let it settle first

    const stampOfAPeerThatStartedABoundAgo = new Date(createdDeadlineLabel() - bound).toISOString();
    psStdout = `killed-peer-orphan	${FOREIGN_OWNER}	${stampOfAPeerThatStartedABoundAgo}`;

    expect(
      await launcher.reap(),
      "an orphan stamped by an over-ceiling run is still unreapable a full bound later"
    ).toStrictEqual(["killed-peer-orphan"]);
  });
});

// ==================================================================================================
describe("MEDIUM (verification pass 5): a budget kill and a silent non-zero exit are DIFFERENT records", () => {
  // ================================================================================================
  /**
   * THE DEFECT. `start` is the only step whose failure is CAPTURED rather than thrown, and the step
   * that spends essentially all of a real run's budget. Its catch kept `e.stdout`/`e.stderr` and
   * nothing else — and `promisify(execFile)` ALWAYS attaches `stderr` as a string, so
   * `RunnerLaunchError`'s `?? message` fall never fires. Measured through the real adapter:
   *
   *     budget-killed `start`, no output   ->  {"succeeded":false,"stdout":"","stderr":""}
   *     runner exits 3 silently            ->  {"succeeded":false,"stdout":"","stderr":""}
   *
   * Byte-identical, and through the real plugins that became `phase:"failed", detail:""` in the
   * durable ledger, in `status()` and in reconcile's Decision `inputContext`. `index.ts` said "THE
   * MESSAGE IS REPLACED, THE DIAGNOSIS IS NOT" about the thrown path; on the captured one the
   * message was replaced and then dropped.
   *
   * THIS FILE OWNS THE BUDGET ARM because it is the only seam that models DURATION. The other four
   * shapes are classified in `docker-adapter.test.ts`, whose steps settle on the next tick and can
   * therefore never reach a run deadline at all.
   */
  /** A runner that exits non-zero having printed NOTHING — the shape a budget kill was identical to. */
  const silentExit3 = (): Error =>
    Object.assign(new Error("Command failed: docker start -a container-abc\n"), {
      code: 3,
      killed: false,
      signal: null,
      stdout: "",
      stderr: ""
    });

  it("A BUDGET-KILLED `start` AND A SILENT NON-ZERO EXIT NO LONGER PRODUCE THE SAME RECORD", async () => {
    // 1. The budget runs out DURING `start`: the step is killed by a `timeout` derived from what was
    //    left, and the child printed nothing before it died.
    durations = { create: 20, cp: 20, start: 5_000 };
    const killed = await createDockerRunnerLauncher("docker").run(spec({ timeoutMs: 300 }));

    // 2. The same visible outcome from the runner's own doing.
    calls.length = 0;
    durations = { create: 20, cp: 20, start: 20 };
    failures = { start: silentExit3() };
    const exited = await createDockerRunnerLauncher("docker").run(spec({ timeoutMs: 30_000 }));

    // THE OLD RECORD, AS IT WAS: both failed, and the child's own output is identical and empty.
    // Kept as an assertion rather than as prose, so the arm below cannot be satisfied by the two
    // simply having become different runs.
    expect([killed.succeeded, exited.succeeded]).toStrictEqual([false, false]);
    expect({ stdout: killed.stdout, stderr: killed.stderr }).toStrictEqual({
      stdout: "",
      stderr: ""
    });
    expect({ stdout: exited.stdout, stderr: exited.stderr }).toStrictEqual({
      stdout: "",
      stderr: ""
    });

    // THE PROPERTY.
    expect(killed.failure?.kind).toBe("budget-exhausted");
    expect(exited.failure?.kind).toBe("exit-nonzero");
    expect(
      killed.failure?.detail,
      "a SIGTERMed `tofu apply` and a runner that exited quietly still read the same"
    ).not.toBe(exited.failure?.detail);

    // AND NEITHER IS EMPTY — the actual regression to guard, since `""` !== `""` is false but `""`
    // is what both used to be.
    expect(killed.failure!.detail.length).toBeGreaterThan(0);
    expect(exited.failure!.detail.length).toBeGreaterThan(0);

    // AND EACH SAYS THE RIGHT THING. The budget one names the budget and the deadline — the two
    // facts that tell an operator "re-running at this setting will do it again" — and reports the
    // signal that stopped a possibly-half-applied run.
    expect(killed.failure!.detail).toContain("whole-run budget of 300ms");
    expect(killed.failure!.detail).toContain("RunnerSpec.timeoutMs");
    expect(killed.failure!.detail).toContain("signal=SIGTERM");
    expect(killed.failure!.deadlineExceeded).toBe(true);
    // The exit one names the exit status, which Node's own `Command failed:` text omits entirely.
    expect(exited.failure!.detail).toContain("code=3");
    expect(exited.failure!.deadlineExceeded).toBe(false);
    // Both record that the runner printed nothing, so "no output" is a stated fact rather than an
    // absence the reader has to infer from an empty string.
    expect(killed.failure!.detail).toContain("printed nothing");
    expect(exited.failure!.detail).toContain("printed nothing");
  });

  it("A maxBuffer OVERFLOW THAT ALSO REPORTS killed IS STILL `output-exceeded` — a FORWARD guard", () => {
    // EXPLICITLY NOT A RECORDING OF TODAY'S NODE. The measured RangeError carries no `killed`
    // property at all (NODE_FAILURE_SHAPES pins that against a real child), so with today's shapes
    // the maxBuffer test could sit on either side of the `killed` test and nothing would change —
    // stated in `classifyRunnerFailure`'s own doc rather than implied. Node DOES kill the child on
    // an overflow, though, so gaining `killed: true` there is an unremarkable future change, and
    // after it the wrong order reclassifies a run whose evidence is TRUNCATED as a plain signal.
    // That is a diagnosis an operator acts on differently: truncated output means the recorded
    // `plan.json` is not the whole plan.
    const overflow = Object.assign(new RangeError("stdout maxBuffer length exceeded"), {
      code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
      killed: true,
      signal: "SIGTERM",
      stdout: '{"resource_ch',
      stderr: ""
    });
    const err = new RunnerLaunchError({
      step: "start",
      file: "docker",
      argv: ["start", "-a", "container-abc"],
      cause: overflow,
      redactions: []
    });

    expect(classifyRunnerFailure(err).kind).toBe("output-exceeded");
    // And the truncation is NAMED in the detail, since that is the fact the evidence depends on.
    expect(classifyRunnerFailure(err).detail).toContain("TRUNCATED");
  });

  it("A STEP REFUSED BEFORE IT IS ISSUED IS A BUDGET EXHAUSTION TOO, not a mystery", async () => {
    // The OTHER budget path — the step never reaches Node at all, so there is no child, no `code`
    // and no output of any kind. It rejects out of `run()` rather than being captured, and
    // `classifyRunnerFailure` must give it the same kind: to an operator "we ran out mid-`start`"
    // and "we ran out before `copy-in`" are one diagnosis with one remedy.
    // `start` is killed by the derived timeout, which lands the clock ON the deadline; the copy-out
    // that follows is therefore REFUSED rather than issued. `propagate` so it escapes `run()`
    // (managed-scan's and managed-dep's axis) instead of being swallowed.
    durations = { create: 50, cp: 50, start: 5_000 };
    const failed = await createDockerRunnerLauncher("docker")
      .run(
        spec({
          timeoutMs: 400,
          copyOut: {
            containerPath: "/work/out",
            hostDir: "/host/out",
            when: "always",
            onFailure: "propagate"
          }
        })
      )
      .catch((e: unknown) => e);

    expect(failed).toBeInstanceOf(RunnerLaunchError);
    const classified = classifyRunnerFailure(failed as InstanceType<typeof RunnerLaunchError>);
    expect(classified.kind).toBe("budget-exhausted");
    expect(classified.step).toBe("copy-out");
    expect(classified.detail).toContain("was not issued");
    expect(classified.detail).toContain("whole-run budget of 400ms");
    // NO CHILD EVER EXISTED, so there is no `code` and no `signal`, and this is the ONE path where
    // `RunnerLaunchError`'s `?? message` fall does fire (the cause is a synthesised `Error`, not a
    // `promisify(execFile)` rejection) — so `stderr` carries the refusal text rather than being
    // empty. The record is complete either way, which is the property; the ABSENT `code` is asserted
    // because a classifier that read a missing `code` as an errno would call this `spawn-failed`.
    expect(classified.code).toBeUndefined();
    expect(classified.detail).toContain("code=undefined");
  });
});
