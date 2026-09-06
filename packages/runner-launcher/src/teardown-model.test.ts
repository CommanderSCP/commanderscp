import { beforeEach, describe, expect, it, vi } from "vitest";
import type { KubernetesApiRequest, KubernetesRunnerIo, RunnerSpec } from "./index.js";

/**
 * ================================================================================================
 * M23.5 HIGH-2 — WHAT MAY HAPPEN AFTER THE RUN DEADLINE IS COUNTED FROM THE CODE
 * ================================================================================================
 *
 * THE DEFECT WAS NOT THE NUMBER. `call-policy.ts` writes the arithmetic out and chose 60s as "two
 * worst-case teardowns" of `RUNNER_REMOVE_TIMEOUT_MS`. That was true when a teardown was one
 * `docker rm -f`. The Kubernetes `finally` is THREE bounded calls, so sixty seconds of bounded work
 * consumed the entire grace and left nothing for the outcome write the grace exists to protect.
 *
 * AND THEN THIS FILE ASKED THE WRONG QUESTION. Its first version asked *what does the teardown
 * `finally` issue?* — one question narrower than the property, which is *what bounded call can be
 * issued after the run deadline?* The same round that wrote it added one that is in no teardown
 * `finally`: the Docker adapter's secret-env `unlink`, in `create`'s own `finally`, whose comment
 * says outright "BOUNDED LIKE A TEARDOWN, NOT SPENT FROM THE BUDGET". Two things hid it:
 *
 *   1. THE COUNTER FILTERED ON SHAPE. `dockerCalls.filter((c) => c.args[0] === "rm")` can only ever
 *      count a `docker rm`; an `fs.unlink` was structurally invisible to it. A filter is where the
 *      next instance hides (CLAUDE.md).
 *   2. THE FIXTURE COULD NOT REACH THE CASE. It drove a bare `spec()` with no `secretEnv`, so no
 *      env-file was ever staged and no `unlink` was ever possible. The KUBERNETES counter beside it
 *      passed `secretEnv` deliberately and said why — "a spec without `secretEnv` would count two
 *      and agree with a model that is wrong by a third". The reasoning was applied to one adapter
 *      and not the other.
 *
 * Measured cost: `run()` returned 64004ms into a run whose stated bound (`runnerRunBoundMs("docker",
 * 1000)`, whose own doc calls itself "THE BOUND `run()` IS HELD TO") was 33000ms — 1004ms past the
 * host's SIGKILL, so `withRecordedOutcome` never writes and `reconcile.ts` retries into a second
 * `tofu apply`.
 *
 * SO THE COUNTING RULE IS TIME, NOT SHAPE: drive each adapter to a run whose budget is ALREADY
 * SPENT, record EVERY effect it issues — `execFile`, `fs`, `io.request`, `io.removeDir`, whatever
 * later arrives — and count the ones at or after the deadline. Nothing is filtered by what a call
 * looks like, so a fifth kind of post-deadline call reddens this the same way a fourth `DELETE`
 * would. The other direction is the type checker: `withPostDeadlineBound` accepts only a name
 * declared in `RUNNER_POST_DEADLINE_CALLS`, and `RUNNER_POST_DEADLINE_CALL_COUNT` is that list's
 * length rather than a second copy of it — so no number anywhere has to be remembered.
 */

/** One effect an adapter had on the outside world, and WHEN. The name is for diagnosis only —
 *  nothing counts or excludes on it, which is the whole point. */
interface Effect {
  name: string;
  at: number;
}
const effects: Effect[] = [];
function record(name: string): void {
  effects.push({ name, at: Date.now() });
}

/** Handles held so that a promise which never settles cannot let the loop drain — `withStepBound`'s
 *  abandonment timer is `unref`'d on purpose (see its doc), so a modelled hang must hold its own. */
const held: ReturnType<typeof setInterval>[] = [];
function hangForever<T>(): Promise<T> {
  return new Promise<T>(() => {
    held.push(setInterval(() => undefined, 20));
  });
}

/** Which `docker` subcommand never answers. Wedging `create` is how the budget gets spent, which is
 *  what puts everything after it in the window this file counts. */
let wedgedDockerSubcommand = "";

vi.mock("node:child_process", () => ({
  execFile: (
    file: string,
    args: string[],
    opts: unknown,
    cb: (err: Error | null, result?: { stdout: string; stderr: string }) => void
  ) => {
    void file;
    void opts;
    const sub = String(args[0]);
    record(`docker ${sub}`);
    if (sub === wedgedDockerSubcommand) {
      held.push(setInterval(() => undefined, 20));
      return;
    }
    // `ps` ANSWERS EMPTY, so the background `reap()` removes nothing: its only effect is the
    // listing, and the control below asserts that landed before the window.
    setTimeout(() => cb(null, { stdout: sub === "ps" ? "" : "ok", stderr: "" }), 0);
  }
}));

vi.mock("node:fs/promises", () => ({
  mkdir: async () => {
    record("fs mkdir");
  },
  writeFile: async () => {
    record("fs writeFile");
  },
  readdir: async () => {
    record("fs readdir");
    return [] as string[];
  },
  stat: async () => {
    record("fs stat");
    return { mtimeMs: Date.now() };
  },
  unlink: async () => {
    record("fs unlink");
  }
}));

const {
  RUNNER_BOUNDED_CALL_WORST_CASE_MS,
  RUNNER_POST_DEADLINE_CALLS,
  RUNNER_POST_DEADLINE_CALL_COUNT,
  RUNNER_REMOVE_TIMEOUT_MS,
  RUNNER_STEP_ABANDON_GRACE_MS,
  RUNNER_TIMER_LATENCY_ALLOWANCE_MS,
  clampRunTimeoutMs,
  createDockerRunnerLauncher,
  createKubernetesRunnerLauncher,
  runnerPostDeadlineCallsMs,
  runnerPostDeadlineMs,
  runnerReapGraceMs,
  runnerRunBoundMs,
  whenKubernetesReapSettled,
  whenReapSettled
} = await import("./index.js");

const NAMESPACE = "scp";
const WORKSPACE_ROOT = "/scp-workspace";
/** Short: the run must actually reach its deadline, and that wait IS this file's cost. */
const TIMEOUT_MS = 1_000;

function spec(overrides: Partial<RunnerSpec> = {}): RunnerSpec {
  return {
    runId: "teardown-model",
    labels: {},
    image: "scp-runner-iac:vetted",
    operands: [],
    networkMode: "none",
    env: [],
    // THE WORST CASE, ON BOTH ADAPTERS. A run with no `secretEnv` stages no env-file (so Docker
    // cannot reach its `unlink`) and mints no Secret (so Kubernetes cannot reach its `DELETE`) —
    // which is exactly how the model came to be wrong by one on each adapter for different reasons.
    secretEnv: ["SCP_TOKEN=s3cr3t"],
    secretEnvDir: "/staging",
    copyIn: [{ hostDir: "/host/in", containerPath: "/work/in" }],
    copyOut: {
      containerPath: "/work/out",
      hostDir: "/host/out",
      when: "always",
      onFailure: "swallow"
    },
    timeoutMs: TIMEOUT_MS,
    maxBuffer: 16 * 1024 * 1024,
    ...overrides
  };
}

/**
 * THE COUNT, AND THE ONLY RULE IN IT: an effect issued at or after the run deadline. No shape, no
 * step name, no argv — those are what let an `fs.unlink` pass unseen.
 */
function countAfter(deadlineAt: number): number {
  return effects.filter((e) => e.at >= deadlineAt).length;
}

/** NON-VACUITY, AND THE ONE THING THAT COULD POLLUTE THE WINDOW. `reap()` is `void`-scheduled at
 *  the top of `run()` and is NOT post-deadline work of this run; both fixtures answer its listing
 *  with nothing to remove, so its only effects are the listing itself and (on Docker) the
 *  `readdir` of `secretEnvDir`. If either ever drifted into the window the count would be wrong,
 *  so it is asserted out rather than filtered out. */
function expectSweepSettledBeforeTheWindow(deadlineAt: number): void {
  const late = effects.filter(
    (e) => e.at >= deadlineAt && (e.name === "docker ps" || e.name === "fs readdir")
  );
  expect(
    late,
    `the background reap sweep landed inside the counted window: ${JSON.stringify(late)}`
  ).toStrictEqual([]);
}

// ==================================================================================================
// THE COUNTERS — one per adapter kind, each driven to a run whose budget is ALREADY SPENT.
// ==================================================================================================

async function countDockerPostDeadline(): Promise<number> {
  effects.length = 0;
  // `create` NEVER ANSWERS, which is how the budget gets spent — and it is also the commonest real
  // way to reach the `unlink` with nothing left, named in that line's own comment.
  wedgedDockerSubcommand = "create";
  const t0 = Date.now();
  const deadlineAt = t0 + clampRunTimeoutMs(TIMEOUT_MS);
  const outcome = await createDockerRunnerLauncher("docker")
    .run(spec())
    .then(
      () => "resolved",
      () => "rejected"
    );
  await whenReapSettled("docker").catch(() => undefined);
  // NOT VACUOUS: the run really did end at its deadline rather than sailing past the wedge.
  expect(outcome).toBe("rejected");
  expect(Date.now()).toBeGreaterThanOrEqual(deadlineAt);
  expectSweepSettledBeforeTheWindow(deadlineAt);
  return countAfter(deadlineAt);
}

async function countKubernetesPostDeadline(): Promise<number> {
  effects.length = 0;
  let podPolls = 0;
  const io: KubernetesRunnerIo = {
    request: async (req: KubernetesApiRequest) => {
      record(`k8s ${req.method} ${req.step}`);
      const path = req.path.split("?")[0]!;
      const jobsRoot = `/apis/batch/v1/namespaces/${NAMESPACE}/jobs`;
      if (req.method === "GET" && path === jobsRoot) {
        return { status: 200, body: JSON.stringify({ items: [] }) };
      }
      if (req.method === "POST" && path === jobsRoot) {
        const body = req.body as { metadata: Record<string, unknown> };
        return {
          status: 201,
          body: JSON.stringify({ ...body, metadata: { ...body.metadata, uid: "uid-1" } })
        };
      }
      if (req.method === "GET" && path === `/api/v1/namespaces/${NAMESPACE}/pods`) {
        podPolls += 1;
        // THE SAME WEDGE AS `create` ON DOCKER, one step later: the poll that is in flight when the
        // deadline passes never answers, so it is abandoned and there is a clean gap between the
        // last call issued inside the budget and the first one issued outside it.
        if (podPolls >= 3) return hangForever<never>();
        return { status: 200, body: JSON.stringify({ items: [] }) };
      }
      if (req.method === "GET" && path.endsWith("/log")) return { status: 200, body: "ok" };
      return { status: 201, body: "{}" };
    },
    copyDir: async (op) => {
      record(`k8s copyDir ${op.step}`);
    },
    removeDir: async (op) => {
      record(`k8s removeDir ${op.step}`);
    }
  };

  const t0 = Date.now();
  const deadlineAt = t0 + clampRunTimeoutMs(TIMEOUT_MS);
  const result = await createKubernetesRunnerLauncher({
    namespace: NAMESPACE,
    workspaceRoot: WORKSPACE_ROOT,
    workspaceVolume: { kind: "persistentVolumeClaim", claimName: "scp-runner-workspace" },
    perRunSecrets: true,
    io,
    pollIntervalMs: 5
  }).run(spec());
  await whenKubernetesReapSettled(NAMESPACE).catch(() => undefined);
  // NOT VACUOUS: the run reached its deadline and failed there, so the `finally` ran on the path
  // this file is about rather than on a fast success where teardown precedes the deadline entirely.
  expect(result.succeeded).toBe(false);
  expect(Date.now()).toBeGreaterThanOrEqual(deadlineAt);
  expectSweepSettledBeforeTheWindow(deadlineAt);
  return countAfter(deadlineAt);
}

/**
 * THE CENSUS SLOT. Every kind in {@link RUNNER_POST_DEADLINE_CALLS} must have a counter here, and
 * the arm below asserts the two key sets are EQUAL — so a third adapter cannot join the model with
 * its declared calls checked by nothing.
 */
const COUNTERS: Record<keyof typeof RUNNER_POST_DEADLINE_CALLS, () => Promise<number>> = {
  docker: countDockerPostDeadline,
  kubernetes: countKubernetesPostDeadline
};

const KINDS = Object.keys(COUNTERS) as (keyof typeof RUNNER_POST_DEADLINE_CALLS)[];

beforeEach(() => {
  effects.length = 0;
  wedgedDockerSubcommand = "";
  for (const h of held) clearInterval(h);
  held.length = 0;
});

describe("M23.5 HIGH-2: what may happen AFTER the deadline is counted from the code, not asserted in a comment", () => {
  it("EVERY ADAPTER KIND IN THE MODEL HAS A COUNTER — a declared list checked by nothing is the defect", () => {
    expect(KINDS.slice().sort()).toStrictEqual(Object.keys(RUNNER_POST_DEADLINE_CALLS).sort());
  });

  it.each(KINDS)(
    "%s: every effect issued at or after the deadline is one RUNNER_POST_DEADLINE_CALLS names",
    async (kind) => {
      // THE ARM AN EXTRA POST-DEADLINE CALL REDDENS, whatever its shape. It reddens on the way IN
      // (the observed count grows) and on the way OUT (declaring the new name in
      // `RUNNER_POST_DEADLINE_CALLS` is what moves `runnerPostDeadlineMs`, the reap stamp and
      // `MANAGED_TRIGGER_GRACE_MS` together). Neither direction requires anyone to remember a number.
      await expect(COUNTERS[kind]()).resolves.toBe(RUNNER_POST_DEADLINE_CALL_COUNT[kind]);
    },
    30_000
  );

  it("THE COUNT IS THE LIST'S LENGTH — there is no second copy of it to drift", () => {
    for (const kind of KINDS) {
      const names = RUNNER_POST_DEADLINE_CALLS[kind];
      expect(RUNNER_POST_DEADLINE_CALL_COUNT[kind]).toBe(names.length);
      // Two call sites sharing one declared name would count as one and understate every grace.
      expect(new Set(names).size).toBe(names.length);
    }
  });

  it("DOCKER'S SECRET-ENV `unlink` IS IN THE MODEL — the call the first census could not see", () => {
    // NAMED, because the defect was that this specific call existed, was correctly described in
    // prose as "bounded like a teardown", and was in no model. `run()` overran its own stated bound
    // by exactly one `RUNNER_BOUNDED_CALL_WORST_CASE_MS` for the whole of M23.5.
    expect(RUNNER_POST_DEADLINE_CALLS.docker).toContain("secret-env unlink");
    expect(RUNNER_POST_DEADLINE_CALL_COUNT.docker).toBeGreaterThan(1);
    // AND THE STATED BOUND MOVED WITH IT. This is the sum `MANAGED_TRIGGER_GRACE_MS` is built on;
    // if it ever drops back to one call's worth, the 64004ms-into-a-33000ms-bound measurement is
    // live again.
    expect(runnerRunBoundMs("docker", TIMEOUT_MS)).toBe(
      TIMEOUT_MS +
        RUNNER_STEP_ABANDON_GRACE_MS +
        2 * RUNNER_BOUNDED_CALL_WORST_CASE_MS +
        RUNNER_TIMER_LATENCY_ALLOWANCE_MS
    );
  });

  it("KUBERNETES COSTS MORE THAN DOCKER, AND EVERY DERIVED QUANTITY SAYS SO", () => {
    // The whole failure was one number standing for both adapters. If these are ever equal again,
    // the model has collapsed back into a constant.
    expect(RUNNER_POST_DEADLINE_CALL_COUNT.kubernetes).toBeGreaterThan(
      RUNNER_POST_DEADLINE_CALL_COUNT.docker
    );
    expect(runnerPostDeadlineCallsMs("kubernetes")).toBeGreaterThan(
      runnerPostDeadlineCallsMs("docker")
    );
    expect(runnerPostDeadlineMs("kubernetes")).toBeGreaterThan(runnerPostDeadlineMs("docker"));
    expect(runnerRunBoundMs("kubernetes", 1_000)).toBeGreaterThan(
      runnerRunBoundMs("docker", 1_000)
    );
    expect(runnerReapGraceMs("kubernetes")).toBeGreaterThan(runnerReapGraceMs("docker"));
  });

  it("THE UNIT IS ONE BOUNDED CALL — its own timeout PLUS the margin the port waits before abandoning", () => {
    // A post-deadline call that ignores its bound is abandoned like any other, so the worst case of
    // one call is `RUNNER_REMOVE_TIMEOUT_MS + RUNNER_STEP_ABANDON_GRACE_MS`. Sizing the model on the
    // timeout alone would understate every grace by one abandonment per call.
    expect(RUNNER_BOUNDED_CALL_WORST_CASE_MS).toBe(
      RUNNER_REMOVE_TIMEOUT_MS + RUNNER_STEP_ABANDON_GRACE_MS
    );
    for (const kind of KINDS) {
      expect(runnerPostDeadlineCallsMs(kind)).toBe(
        RUNNER_POST_DEADLINE_CALL_COUNT[kind] * RUNNER_BOUNDED_CALL_WORST_CASE_MS
      );
      // `run()` may still abandon the step that was in flight when the deadline passed, THEN issue
      // every post-deadline call — so the post-deadline term is one grace plus all of them, and the
      // stated bound is the budget plus that.
      expect(runnerPostDeadlineMs(kind)).toBe(
        RUNNER_STEP_ABANDON_GRACE_MS +
          runnerPostDeadlineCallsMs(kind) +
          RUNNER_TIMER_LATENCY_ALLOWANCE_MS
      );
      expect(runnerRunBoundMs(kind, 30_000)).toBe(30_000 + runnerPostDeadlineMs(kind));
      // And the reap stamp clears everything `run()` may still do, on THIS adapter.
      expect(runnerReapGraceMs(kind)).toBeGreaterThan(runnerPostDeadlineMs(kind));
    }
  });
});
