import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { KubernetesApiRequest, KubernetesRunnerIo, RunnerSpec } from "./index.js";

/**
 * ================================================================================================
 * M23.5 HIGH-1 — THE WHOLE-RUN DEADLINE IS THE PORT'S, NOT THE ADAPTER-AUTHOR'S
 * ================================================================================================
 *
 * THE DEFECT, AS THE MEASUREMENT. `KubernetesRunnerIo` carried `timeoutMs` on `request` and on
 * nothing else. `copyDir` and `removeDir` took no deadline; `createFetchKubernetesIo` implemented
 * them as a bare `cp`/`rm`. The adapter's `copy()` checked the remaining budget BEFORE the call and
 * then awaited it forever — against `dist`, `timeoutMs: 3000`, a `copyDir` that never settles:
 *
 *     after 15003ms with timeoutMs=3000: STILL RUNNING
 *     requests issued: ["GET …/jobs timeoutMs=30000", "POST …/jobs timeoutMs=2999"]
 *
 * and the volume is BY CONSTRUCTION a network filesystem — the chart names NFS, CephFS, EFS and
 * Azure Files — which is the kind that hangs rather than errors. `run()` never returns; the host
 * SIGKILLs the subprocess at `timeoutMs + MANAGED_TRIGGER_GRACE_MS`; `withRecordedOutcome` never
 * writes; managed-iac's ledger entry never lands; `reconcile.ts` retries; a SECOND `tofu apply`
 * goes at live infrastructure. Copy-in precedes `start`, so the abandoned Job is still SUSPENDED —
 * it never finishes, `ttlSecondsAfterFinished` never applies, and the per-run credential Secret
 * survives until some later run's `reap()` happens by.
 *
 * WHY THIS FILE IS NOT `kubernetes-adapter.test.ts`. That suite's fake settles every operation on
 * the next tick — deliberately, because it asks WHAT was issued and in what ORDER. It is
 * structurally unable to ask whether an operation that never settles is given up on, which is the
 * only question here. The same blindness is what let the surviving mutation the adversarial pass
 * found — DELETE `copy()`'s budget pre-check entirely — leave 328 unit tests and 11 kind tests all
 * green.
 *
 * THE HANG IS MODELLED WITH A HANDLE, AND THAT IS LOAD-BEARING. See {@link neverSettles}.
 */

// ==================================================================================================
// THE DOCKER SEAM — a child that can be made to ignore its own `timeout`, which is the whole point.
// ==================================================================================================

interface DockerCall {
  args: string[];
  opts: { timeout?: number; maxBuffer?: number };
}
const dockerCalls: DockerCall[] = [];
/** Docker subcommands whose child NEVER answers and NEVER dies — the `D`-state shape a SIGTERM
 *  cannot reach, which is exactly what a `docker cp` onto a wedged NFS mount looks like. */
let deaf: Set<string> = new Set();

/**
 * THE FILESYSTEM SEAM — the Docker adapter's secret-env staging, which is I/O the port drives too.
 *
 * `secretEnvDir` is a SERVER-INJECTED path (`SCP_MANAGED_*_WORKSPACE_ROOT`), and an operator may
 * perfectly well point it at the same shared mount the Kubernetes workspace uses. So the `mkdir` +
 * `writeFile` that stages a mode-0600 credential file is the same unbounded network-filesystem call
 * as a `copyDir` — and it happens BEFORE `create`, where a hang costs the whole run with no
 * container to show for it. The census that found HIGH-1 found this too.
 */
let hangSecretEnvWrite = false;

vi.mock("node:fs/promises", () => ({
  mkdir: async () => undefined,
  writeFile: async () => {
    if (hangSecretEnvWrite) await neverSettles<void>();
  },
  readdir: async () => [] as string[],
  stat: async () => ({ mtimeMs: Date.now() }),
  unlink: async () => undefined
}));

vi.mock("node:child_process", () => ({
  execFile: (
    file: string,
    args: string[],
    opts: { timeout?: number; maxBuffer?: number },
    cb: (err: Error | null, result?: { stdout: string; stderr: string }) => void
  ) => {
    void file;
    dockerCalls.push({ args, opts });
    const sub = String(args[0]);
    if (deaf.has(sub)) {
      // NOT EVEN THE `timeout` IS HONOURED. Node's own `timeout` kills the child and rejects; a
      // child in uninterruptible sleep takes the signal and does not exit, so `promisify(execFile)`
      // never settles. A seam that always honoured `timeout` could not express this case at all.
      hold();
      return;
    }
    setTimeout(() => cb(null, { stdout: sub === "ps" ? "" : "ok", stderr: "" }), 0);
  }
}));

const {
  RUNNER_MIN_STEP_BUDGET_MS,
  RUNNER_REMOVE_TIMEOUT_MS,
  RUNNER_STEP_ABANDON_GRACE_MS,
  RunnerLaunchError,
  RunnerStepAbandonedError,
  classifyRunnerFailure,
  createDockerRunnerLauncher,
  createKubernetesRunnerLauncher,
  createRunDeadline,
  runnerJobName,
  runnerRunBoundMs,
  whenKubernetesReapSettled,
  whenReapSettled,
  withStepBound
} = await import("./index.js");

// ==================================================================================================
// A HANG THAT KEEPS THE LOOP ALIVE — see `withStepBound`'s doc for why this is not a detail.
// ==================================================================================================

const heldHandles: ReturnType<typeof setInterval>[] = [];
/**
 * A promise that never settles AND holds a real libuv handle while it does not.
 *
 * `withStepBound`'s abandonment timer is `unref`'d on purpose: an abandonment timer must never be
 * the reason a process stays alive, because if nothing else is pending there is no in-flight I/O to
 * abandon. Real wedged I/O — `fs.cp` on an unresponsive NFS mount, a child in uninterruptible sleep
 * — holds a threadpool request or a process handle, so the loop stays alive and the `unref`'d timer
 * fires exactly when it is needed. A test that modelled the hang as a bare `new Promise(() => {})`
 * would hold NOTHING, let the loop drain, and be asking a different question than production asks.
 */
function neverSettles<T>(): Promise<T> {
  return new Promise<T>(() => {
    hold();
  });
}
function hold(): void {
  heldHandles.push(setInterval(() => undefined, 20));
}

// ==================================================================================================
// A MINIMAL CLUSTER — just enough to reach copy-in, with every operation RECORDED.
// ==================================================================================================

const NAMESPACE = "scp";
const WORKSPACE_ROOT = "/scp-workspace";

interface PortOp {
  kind: "request" | "copyDir" | "removeDir";
  step: string;
  timeoutMs: number;
  method?: string;
  path?: string;
}

function cluster(
  opts: {
    hangCopyDir?: boolean;
    hangRemoveDir?: boolean;
    slowCreateMs?: number;
  } = {}
) {
  const ops: PortOp[] = [];
  let uid = 0;

  const route = (req: KubernetesApiRequest): { status: number; body: string } => {
    const path = req.path.split("?")[0]!;
    const jobsRoot = `/apis/batch/v1/namespaces/${NAMESPACE}/jobs`;
    if (req.method === "GET" && path === jobsRoot) {
      return { status: 200, body: JSON.stringify({ items: [] }) };
    }
    if (req.method === "POST" && path === jobsRoot) {
      uid += 1;
      const body = req.body as { metadata: Record<string, unknown> };
      return {
        status: 201,
        body: JSON.stringify({ ...body, metadata: { ...body.metadata, uid: `uid-${uid}` } })
      };
    }
    // A POD THAT HAS ALREADY SUCCEEDED, so the happy path really is happy: without it the poll
    // loop runs to the deadline and every case here would be a budget exhaustion, which would make
    // the census arm below pass for the wrong reason.
    if (req.method === "GET" && path === `/api/v1/namespaces/${NAMESPACE}/pods`) {
      return {
        status: 200,
        body: JSON.stringify({
          items: [
            {
              metadata: { name: "scp-runner-port-deadline-abcde" },
              status: {
                phase: "Succeeded",
                containerStatuses: [{ name: "runner", state: { terminated: { exitCode: 0 } } }]
              }
            }
          ]
        })
      };
    }
    if (req.method === "GET" && path.endsWith("/log")) return { status: 200, body: "runner ok" };
    return { status: 200, body: "{}" };
  };

  const io: KubernetesRunnerIo = {
    request: async (req) => {
      ops.push({
        kind: "request",
        step: req.step,
        timeoutMs: req.timeoutMs,
        method: req.method,
        path: req.path
      });
      if (opts.slowCreateMs && req.method === "POST") {
        await new Promise((r) => setTimeout(r, opts.slowCreateMs));
      }
      return route(req);
    },
    copyDir: async (op) => {
      ops.push({ kind: "copyDir", step: op.step, timeoutMs: op.timeoutMs });
      if (opts.hangCopyDir) await neverSettles<void>();
    },
    removeDir: async (op) => {
      ops.push({ kind: "removeDir", step: op.step, timeoutMs: op.timeoutMs });
      if (opts.hangRemoveDir) await neverSettles<void>();
    }
  };

  return {
    ops,
    launcher: () =>
      createKubernetesRunnerLauncher({
        namespace: NAMESPACE,
        workspaceRoot: WORKSPACE_ROOT,
        workspaceVolume: { kind: "persistentVolumeClaim", claimName: "scp-runner-workspace" },
        perRunSecrets: false,
        io,
        pollIntervalMs: 5
      })
  };
}

function spec(overrides: Partial<RunnerSpec> = {}): RunnerSpec {
  return {
    runId: "port-deadline",
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
    timeoutMs: 300,
    maxBuffer: 16 * 1024 * 1024,
    ...overrides
  };
}

beforeEach(() => {
  dockerCalls.length = 0;
  deaf = new Set();
  hangSecretEnvWrite = false;
});

afterEach(async () => {
  // The reap passes both adapters schedule are `void`ed; joining them keeps a sweep from bleeding
  // into the next case's recorded operations.
  await whenKubernetesReapSettled(NAMESPACE).catch(() => undefined);
  await whenReapSettled("docker").catch(() => undefined);
  for (const h of heldHandles) clearInterval(h);
  heldHandles.length = 0;
});

// ==================================================================================================
describe("M23.5 HIGH-1: a Kubernetes `copyDir` that never settles cannot hold `run()` open", () => {
  // ================================================================================================
  it("THE HUNG COPY-IN ENDS THE RUN WITHIN THE BOUND THE PORT STATES, instead of never ending it", async () => {
    const c = cluster({ hangCopyDir: true });
    const startedAt = Date.now();
    const failed = await c
      .launcher()
      .run(spec({ timeoutMs: 300 }))
      .catch((e: unknown) => e);
    const elapsed = Date.now() - startedAt;

    // THE STATED BOUND, from the code rather than from a comment. `runnerRunBoundMs` is what the
    // three documents' sentence became; asserting against it is what stops the sentence and the
    // behaviour drifting again.
    expect(elapsed).toBeLessThanOrEqual(runnerRunBoundMs("kubernetes", 300));
    // AND THE TIGHT ONE, which is what actually catches a regression: the budget, one abandonment
    // grace, and a teardown that answers immediately. The loose bound above would be satisfied by a
    // run that hung for a minute and a half.
    expect(elapsed, `the hung copy-in held run() for ${elapsed}ms of a 300ms budget`).toBeLessThan(
      300 + RUNNER_STEP_ABANDON_GRACE_MS + 500
    );
    // NOT VACUOUS: it really did reach the copy and really did spend the budget getting there.
    expect(elapsed).toBeGreaterThanOrEqual(300);
    expect(c.ops.filter((o) => o.kind === "copyDir")).toHaveLength(1);
    expect(failed).toBeInstanceOf(RunnerLaunchError);
  });

  it("THE ABANDONED RUN IS AN HONEST `budget-exhausted` — a recordable failure, not a mystery", async () => {
    // The whole reason `run()` must RETURN is that a returned failure is one managed-iac writes to
    // its idempotency ledger, which is what stops `reconcile.ts` issuing a second `tofu apply`. A
    // failure nobody can classify is barely better than a hang.
    const c = cluster({ hangCopyDir: true });
    const err = (await c
      .launcher()
      .run(spec({ timeoutMs: 300 }))
      .catch((e: unknown) => e)) as InstanceType<typeof RunnerLaunchError>;

    expect(err).toBeInstanceOf(RunnerLaunchError);
    expect(err.step).toBe("copy-in");
    expect(err.deadlineExceeded).toBe(true);

    const failure = classifyRunnerFailure(err);
    expect(failure.kind).toBe("budget-exhausted");
    expect(failure.step).toBe("copy-in");
    // The operator-facing sentence names the budget AND says what actually happened, because
    // "abandoned, may still be in flight" is a different operational fact from "killed".
    expect(failure.detail).toContain("whole-run budget of 300ms");
    expect(failure.detail).toContain("ABANDONED");
    expect(failure.detail).toContain("may still be in flight");
  });

  it("THE JOB IS TORN DOWN ANYWAY — the abandoned copy must not leave a SUSPENDED Job behind", async () => {
    // The half of the defect that outlives the run: copy-in precedes the unsuspend PATCH, so a Job
    // abandoned here has never started, never finishes, and `ttlSecondsAfterFinished` never applies
    // to it. Its per-run Secret then lives until some later run's `reap()` happens by.
    const c = cluster({ hangCopyDir: true });
    await c
      .launcher()
      .run(spec({ timeoutMs: 300 }))
      .catch(() => undefined);

    const teardown = c.ops.filter((o) => o.step === "teardown" && o.method === "DELETE");
    expect(teardown.map((o) => o.path)).toStrictEqual([
      `/apis/batch/v1/namespaces/${NAMESPACE}/jobs/${runnerJobName("port-deadline")}?propagationPolicy=Background`
    ]);
  });

  it("A COPY REACHED WITH THE BUDGET ALREADY SPENT IS REFUSED BEFORE THE VOLUME IS TOUCHED", async () => {
    // THE SURVIVING MUTATION, NAMED. "Delete `copy()`'s budget pre-check entirely" left 328 unit
    // tests and 11 kind tests green. The pre-check now lives in `RunDeadline.spend`, shared by both
    // adapters and by every step; deleting it there reddens this arm, because `copyDir` is issued
    // when it should never have been.
    const c = cluster({ slowCreateMs: 400 });
    const failed = await c
      .launcher()
      .run(spec({ timeoutMs: 200 }))
      .catch((e: unknown) => e);

    expect(
      c.ops.filter((o) => o.kind === "copyDir"),
      "the copy was issued with a spent budget"
    ).toStrictEqual([]);
    const err = failed as InstanceType<typeof RunnerLaunchError>;
    expect(err).toBeInstanceOf(RunnerLaunchError);
    expect(err.deadlineExceeded).toBe(true);
    expect(err.message).toContain("was not issued");
  });

  it("EVERY OPERATION THIS ADAPTER ISSUES CARRIES A POSITIVE BOUND — copyDir and removeDir included", async () => {
    // THE CENSUS FORM OF THE PROPERTY, and it is what makes a FOURTH verb on this port safe: a new
    // operation cannot join `KubernetesRunnerIo` without a `timeoutMs` (the type refuses), and it
    // cannot be issued with a meaningless one without reddening here. `timeout: 0` is NO timeout at
    // all in Node, which is the value a naive `deadline - now` produces at the worst instant.
    const c = cluster();
    const result = await c.launcher().run(spec({ timeoutMs: 5_000 }));
    // NOT VACUOUS — the run SUCCEEDED, so every verb was reached on the happy path rather than on
    // a budget exhaustion that skipped most of them.
    expect(result.succeeded).toBe(true);

    const kinds = new Set(c.ops.map((o) => o.kind));
    expect(kinds, "the run did not exercise all three verbs — the census would be vacuous").toEqual(
      new Set(["request", "copyDir", "removeDir"])
    );
    for (const op of c.ops) {
      expect(
        op.timeoutMs,
        `${op.kind} '${op.step}' was issued with ${op.timeoutMs}ms`
      ).toBeGreaterThan(0);
    }
    // …and the teardown's bound is its OWN, deliberately outside the run budget, because the
    // commonest reason to reach it is that the budget is what ran out.
    for (const op of c.ops.filter((o) => o.step === "teardown")) {
      expect(op.timeoutMs).toBe(RUNNER_REMOVE_TIMEOUT_MS);
    }
  });
});

// ==================================================================================================
describe("M23.5: the SAME port bounds the Docker adapter — one mechanism, not one per adapter", () => {
  // ================================================================================================
  it("A `docker cp` WHOSE CHILD IGNORES SIGTERM DOES NOT HOLD `run()` OPEN EITHER", async () => {
    // Node's `execFile` timeout SIGTERMs the child and rejects only once the child exits. A child
    // wedged on a network mount takes the signal and does not exit, so `promisify(execFile)` never
    // settles — the Docker spelling of exactly the same hang. Before M23.5 this adapter's `exec`
    // relied entirely on Node honouring `timeout`.
    deaf = new Set(["cp"]);
    const startedAt = Date.now();
    const failed = await createDockerRunnerLauncher("docker")
      .run(spec({ timeoutMs: 300 }))
      .catch((e: unknown) => e);
    const elapsed = Date.now() - startedAt;

    expect(elapsed).toBeLessThanOrEqual(runnerRunBoundMs("docker", 300));
    expect(elapsed).toBeLessThan(300 + RUNNER_STEP_ABANDON_GRACE_MS + 500);
    const err = failed as InstanceType<typeof RunnerLaunchError>;
    expect(err).toBeInstanceOf(RunnerLaunchError);
    expect(err.step).toBe("copy-in");
    expect(classifyRunnerFailure(err).kind).toBe("budget-exhausted");
    // The teardown still ran, at its own bound — it is outside the budget, not outside a bound.
    expect(dockerCalls.some((c) => c.args[0] === "rm")).toBe(true);
  });

  it("A SECRET-ENV WRITE THAT NEVER SETTLES IS BOUNDED TOO — the step BEFORE `create` is I/O as well", async () => {
    // The census arm. `writeSecretEnvFile` is `mkdir` + `writeFile` against an operator-chosen
    // directory, and it was the one step of the run proper that reached the filesystem without
    // going through the deadline at all. A hang here is the worst version of the defect: `run()`
    // never returns and there is no container, no Job and no label for any sweep to find.
    hangSecretEnvWrite = true;
    const startedAt = Date.now();
    const failed = await createDockerRunnerLauncher("docker")
      .run(spec({ timeoutMs: 300, secretEnv: ["SCP_TOKEN=s3cr3t"], secretEnvDir: "/staging" }))
      .catch((e: unknown) => e);
    const elapsed = Date.now() - startedAt;

    expect(elapsed).toBeLessThan(300 + RUNNER_STEP_ABANDON_GRACE_MS + 500);
    const err = failed as InstanceType<typeof RunnerLaunchError>;
    expect(err).toBeInstanceOf(RunnerLaunchError);
    expect(err.step).toBe("secret-env");
    expect(classifyRunnerFailure(err).kind).toBe("budget-exhausted");
    // NOT VACUOUS: it really did fail on the staging step, before `create` was ever issued.
    expect(dockerCalls.filter((c) => c.args[0] === "create")).toStrictEqual([]);
    // AND THE CREDENTIAL IS NOT IN THE MESSAGE — the redaction set is live before the first step.
    expect(err.message).not.toContain("s3cr3t");
  });
});

// ==================================================================================================
describe("M23.5: `RunDeadline.spend` — the refusal, at a boundary the process can actually land on", () => {
  // ================================================================================================
  it("A STEP REACHED WITH LESS THAN THE MINIMUM BUDGET IS REFUSED, not issued with a doomed bound", async () => {
    // THE BOUNDARY `remaining <= 0` COULD NOT REACH, and it is the port primitive rather than an
    // adapter because the defect is in the primitive. `RunDeadline` measures the deadline with
    // `Date.now()`; the budget kill that lands on it is a libuv timer on a different clock, and the
    // two disagree by up to a millisecond — so the step BEHIND a killed one saw `remaining === 1`
    // and was issued as `docker cp … { timeout: 1 }`. Three arms of `whole-run-budget.test.ts`
    // failed on that intermittently (3 runs in 8, a different arm each time), which is the shape of
    // a boundary the process cannot land on rather than of a wrong test.
    //
    // DETERMINISTIC BY CONSTRUCTION, which the arms it replaces could not be: the budget is BORN
    // under the floor rather than whittled down to it by a race.
    const deadline = createRunDeadline({
      requestedTimeoutMs: RUNNER_MIN_STEP_BUDGET_MS - 1,
      file: "docker",
      redactions: () => []
    });
    let issued = false;
    const err = await deadline
      .spend("copy-out", ["cp", "container-abc:/work/out/.", "/host/out"], async (timeoutMs) => {
        issued = true;
        return timeoutMs;
      })
      .catch((e: unknown) => e);

    expect(issued, "a step with less than the minimum budget was handed to Node anyway").toBe(
      false
    );
    expect(err).toBeInstanceOf(RunnerLaunchError);
    const launchError = err as InstanceType<typeof RunnerLaunchError>;
    expect(launchError.deadlineExceeded).toBe(true);
    expect(launchError.message).toContain("was not issued");
  });

  it("`spent()` AND THE REFUSAL ARE THE SAME INSTANT — one question, not two expressions for it", async () => {
    // THE SECOND HALF OF THE SAME DEFECT, and the one that produced a verdict about the TENANT for
    // something the launcher did. Three sites asked "is the budget gone?" with a raw
    // `Date.now() >= deadline.at` while the kill that lands on it is a libuv timer on another clock;
    // the Docker adapter's was `e.killed === true && Date.now() >= runDeadlineAt`, and it reported
    // FALSE for a `create` its own derived timeout had just killed — `exit-nonzero` instead of
    // `budget-exhausted`. If `spent()` ever answers "no" where `spend()` refuses, they have drifted
    // apart again.
    const deadline = createRunDeadline({
      requestedTimeoutMs: RUNNER_MIN_STEP_BUDGET_MS - 1,
      file: "docker",
      redactions: () => []
    });
    expect(deadline.spent()).toBe(true);
    let issued = false;
    await deadline
      .spend("start", ["start"], async () => {
        issued = true;
      })
      .catch(() => undefined);
    expect(issued, "`spent()` said the budget was gone and `spend()` issued the step anyway").toBe(
      false
    );

    const live = createRunDeadline({
      requestedTimeoutMs: 5_000,
      file: "docker",
      redactions: () => []
    });
    expect(live.spent()).toBe(false);
  });

  it("AND A BUDGET THAT IS COMFORTABLY ABOVE THE MINIMUM IS STILL SPENT — the negative control", async () => {
    // WITHOUT THIS ARM, "refuse everything" passes the one above and no run ever issues a step. The
    // floor is a floor, not a new deadline: the bound handed down is still what remains.
    const deadline = createRunDeadline({
      requestedTimeoutMs: 5_000,
      file: "docker",
      redactions: () => []
    });
    const bound = await deadline.spend("create", ["create"], async (timeoutMs) => timeoutMs);
    expect(bound).toBeGreaterThan(RUNNER_MIN_STEP_BUDGET_MS);
    expect(bound).toBeLessThanOrEqual(5_000);
  });
});

// ==================================================================================================
describe("M23.5: `withStepBound` — the primitive both adapters are built on", () => {
  // ================================================================================================
  it("WORK THAT IGNORES ITS BOUND IS ABANDONED AFTER EXACTLY ONE GRACE, and the message names both", async () => {
    const startedAt = Date.now();
    const err = await withStepBound({
      timeoutMs: 200,
      what: "'copy-in'",
      work: () => neverSettles<void>()
    }).catch((e: unknown) => e);
    const elapsed = Date.now() - startedAt;

    expect(err).toBeInstanceOf(RunnerStepAbandonedError);
    expect((err as InstanceType<typeof RunnerStepAbandonedError>).boundMs).toBe(200);
    expect(elapsed).toBeGreaterThanOrEqual(200 + RUNNER_STEP_ABANDON_GRACE_MS - 30);
    expect(elapsed).toBeLessThan(200 + RUNNER_STEP_ABANDON_GRACE_MS + 400);
    expect((err as Error).message).toContain("200ms bound");
    expect((err as Error).message).toContain("ABANDONED");
  });

  it("THE GRACE IS NOT PADDING — a self-bounded call that settles LATE still keeps its own diagnosis", async () => {
    // WHY THE WORK REJECTS AFTER ITS BOUND RATHER THAN AT IT, and it is the whole point of the arm.
    // `execFile`'s `timeout` does not reject when it fires: it fires, SIGTERMs the child, and the
    // promise settles on the child's exit — at least one turn of the loop later, and in practice a
    // few milliseconds. Set the abandonment timer for the same instant and it wins that race, so
    // EVERY ordinary budget kill arrives as an abandonment and the `code`/`killed`/`signal` and
    // partial stdout that `classifyRunnerFailure` exists to preserve are thrown away.
    //
    // THE EXISTING SUITES CANNOT ASK THIS. `whole-run-budget.test.ts`'s seam settles a killed step
    // EXACTLY at `timeout`, and its callback timer is registered before ours, so it wins whatever
    // the grace is — which is why shrinking the grace to zero leaves those arms green. This one
    // models the settle delay, so it does not.
    const SETTLE_DELAY_MS = 25;
    const err = await withStepBound({
      timeoutMs: 100,
      what: "'start'",
      work: (bound) =>
        new Promise<never>((_resolve, reject) => {
          setTimeout(
            () =>
              reject(
                Object.assign(new Error("self-bounded"), {
                  killed: true,
                  code: null,
                  signal: "SIGTERM",
                  stdout: "a partial tofu plan"
                })
              ),
            bound + SETTLE_DELAY_MS
          );
        })
    }).catch((e: unknown) => e);

    expect(err).not.toBeInstanceOf(RunnerStepAbandonedError);
    expect((err as Error).message).toBe("self-bounded");
    // THE DIAGNOSIS IS WHAT THE GRACE BUYS — an abandonment carries none of this.
    expect(err).toMatchObject({ killed: true, signal: "SIGTERM", stdout: "a partial tofu plan" });
    // …and the margin really is what saved it: a grace smaller than the settle delay would not.
    expect(RUNNER_STEP_ABANDON_GRACE_MS).toBeGreaterThan(SETTLE_DELAY_MS);
  });

  it("WORK THAT REJECTS AFTER IT WAS ABANDONED IS NOT AN UNHANDLED REJECTION", async () => {
    // An abandoned promise that rejects at minute nine with nobody listening takes a plugin
    // subprocess down — the failure this whole mechanism exists to prevent, arriving by the back
    // door.
    //
    // AND THERE IS NO EXPLICIT GUARD IN `withStepBound` FOR IT — recorded here rather than left for
    // a reader to wonder about. `Promise.race` subscribes to every promise it is given and keeps
    // that subscription after it settles, so `pending` is handled from the moment it enters the
    // race. A first draft added `void pending.catch(() => undefined)`; mutating it away reddened
    // NOTHING across the whole suite, so it went (charter priority 1). This arm is what a rewrite
    // away from `Promise.race` — an `AbortController` and a `.then`, say — would have to keep true,
    // which is why it stays even though nothing in today's code can break it.
    const seen: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      seen.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const abandoned = await withStepBound({
        timeoutMs: 50,
        what: "'copy-out'",
        work: () =>
          new Promise<void>((_resolve, reject) => {
            // LATE ENOUGH TO BE ABANDONED FIRST — the abandonment lands at 50 + one grace, and the
            // rejection must arrive after that or this arm is testing an ordinary failure.
            setTimeout(
              () => reject(new Error("late rejection nobody is waiting for")),
              50 + RUNNER_STEP_ABANDON_GRACE_MS + 300
            );
          })
      }).catch((e: unknown) => e);
      expect(abandoned).toBeInstanceOf(RunnerStepAbandonedError);
      await new Promise((r) => setTimeout(r, RUNNER_STEP_ABANDON_GRACE_MS + 600));
      expect(seen).toStrictEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("A `work` THAT THROWS SYNCHRONOUSLY IS A REJECTION, not an escape past the timer", async () => {
    const err = await withStepBound({
      timeoutMs: 50,
      what: "'create'",
      work: () => {
        throw new Error("synchronous");
      }
    }).catch((e: unknown) => e);
    expect((err as Error).message).toBe("synchronous");
  });
});
