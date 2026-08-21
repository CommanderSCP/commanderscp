import { beforeEach, describe, expect, it, vi } from "vitest";
import type { KubernetesApiRequest, KubernetesRunnerIo, RunnerSpec } from "./index.js";

/**
 * ================================================================================================
 * M23.5 HIGH-2 — THE TEARDOWN MODEL IS DECLARED AND THEN CHECKED AGAINST THE CODE
 * ================================================================================================
 *
 * THE DEFECT WAS NOT THE NUMBER. `call-policy.ts` writes the arithmetic out and chooses 60s as "two
 * worst-case teardowns" of `RUNNER_REMOVE_TIMEOUT_MS`. That was true when a teardown was one
 * `docker rm -f`. The Kubernetes `finally` is THREE bounded calls — DELETE the Job, DELETE the
 * Secret, remove the workspace subtree — so sixty seconds of bounded work consumes the entire grace
 * and leaves nothing for the outcome write the grace exists to protect. That is precisely what that
 * file's own comment calls "WRONG BY CONSTRUCTION" about the 30s it replaced.
 *
 * AND THE GATE COULD NOT SEE IT. `call-policy.test.ts` asserted
 * `MANAGED_TRIGGER_GRACE_MS > RUNNER_REMOVE_TIMEOUT_MS` — ONE teardown. The NUMBER was gated; the
 * MODEL was not, and nothing anywhere knew the teardown had grown. A comment naming a hazard is a
 * signal to sweep, not evidence it was handled (CLAUDE.md).
 *
 * SO: `RUNNER_TEARDOWN_STEPS` declares the count per adapter, every grace downstream is DERIVED
 * from it, and this file counts what each adapter's `finally` actually issues. Adding a fourth
 * teardown step to either adapter reddens an arm here by name; correcting the count then moves the
 * reap stamp, the host's trigger grace and the stated `run()` bound together.
 */

interface DockerCall {
  args: string[];
  opts: { timeout?: number; maxBuffer?: number };
}
const dockerCalls: DockerCall[] = [];

vi.mock("node:child_process", () => ({
  execFile: (
    file: string,
    args: string[],
    opts: { timeout?: number; maxBuffer?: number },
    cb: (err: Error | null, result?: { stdout: string; stderr: string }) => void
  ) => {
    void file;
    dockerCalls.push({ args, opts });
    // `ps` ANSWERS EMPTY, so `reap()` removes nothing and its `rm -f`s cannot be mistaken for the
    // teardown's. The count below would otherwise be a count of two different mechanisms.
    setTimeout(() => cb(null, { stdout: String(args[0]) === "ps" ? "" : "ok", stderr: "" }), 0);
  }
}));

const {
  RUNNER_BOUNDED_CALL_WORST_CASE_MS,
  RUNNER_REMOVE_TIMEOUT_MS,
  RUNNER_STEP_ABANDON_GRACE_MS,
  RUNNER_TEARDOWN_STEPS,
  createDockerRunnerLauncher,
  createKubernetesRunnerLauncher,
  runnerPostDeadlineMs,
  runnerReapGraceMs,
  runnerRunBoundMs,
  runnerTeardownWorstCaseMs,
  whenKubernetesReapSettled,
  whenReapSettled
} = await import("./index.js");

const NAMESPACE = "scp";
const WORKSPACE_ROOT = "/scp-workspace";

function spec(overrides: Partial<RunnerSpec> = {}): RunnerSpec {
  return {
    runId: "teardown-model",
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
    timeoutMs: 10_000,
    maxBuffer: 16 * 1024 * 1024,
    ...overrides
  };
}

/** One effect, with just enough to tell a teardown call from a reap listing. */
interface Op {
  kind: "request" | "copyDir" | "removeDir";
  step: string;
  method?: string;
  timeoutMs: number;
}

// ==================================================================================================
// THE COUNTERS — one per adapter kind, driven to the WORST CASE its `finally` can reach.
// ==================================================================================================

/**
 * COUNTING RULE, AND IT IS THE SAME ON BOTH ADAPTERS: an operation whose step is `teardown` and
 * which is not a reap LISTING. `reap()` shares the `teardown` step (it is the same cleanup concept)
 * but is not post-deadline work of THIS run; both fixtures answer its listing with nothing to
 * remove, so the only reap operation either issues is the listing itself.
 */
async function countDockerTeardown(): Promise<number> {
  dockerCalls.length = 0;
  await createDockerRunnerLauncher("docker").run(spec());
  await whenReapSettled("docker").catch(() => undefined);
  return dockerCalls.filter(
    (c) => c.args[0] === "rm" && String(c.args[2] ?? "").startsWith("scp-runner-")
  ).length;
}

async function countKubernetesTeardown(): Promise<number> {
  const ops: Op[] = [];
  let uid = 0;
  const io: KubernetesRunnerIo = {
    request: async (req: KubernetesApiRequest) => {
      ops.push({
        kind: "request",
        step: req.step,
        method: req.method,
        timeoutMs: req.timeoutMs
      });
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
      if (req.method === "GET" && path === `/api/v1/namespaces/${NAMESPACE}/pods`) {
        return {
          status: 200,
          body: JSON.stringify({
            items: [
              {
                metadata: { name: "scp-runner-teardown-model-abcde" },
                status: {
                  phase: "Succeeded",
                  containerStatuses: [{ name: "runner", state: { terminated: { exitCode: 0 } } }]
                }
              }
            ]
          })
        };
      }
      if (req.method === "GET" && path.endsWith("/log")) return { status: 200, body: "ok" };
      return { status: 201, body: "{}" };
    },
    copyDir: async (op) => {
      ops.push({ kind: "copyDir", step: op.step, timeoutMs: op.timeoutMs });
    },
    removeDir: async (op) => {
      ops.push({ kind: "removeDir", step: op.step, timeoutMs: op.timeoutMs });
    }
  };

  // THE WORST CASE, DELIBERATELY: the Secret DELETE only happens for a run that MINTED one, so a
  // spec without `secretEnv` would count two and agree with a model that is wrong by a third.
  const result = await createKubernetesRunnerLauncher({
    namespace: NAMESPACE,
    workspaceRoot: WORKSPACE_ROOT,
    workspaceVolume: { kind: "persistentVolumeClaim", claimName: "scp-runner-workspace" },
    perRunSecrets: true,
    io,
    pollIntervalMs: 5
  }).run(spec({ secretEnv: ["SCP_TOKEN=s3cr3t"] }));
  await whenKubernetesReapSettled(NAMESPACE).catch(() => undefined);

  // NOT VACUOUS: the run reached its end normally, so the `finally` ran on the ordinary path rather
  // than on a short-circuit that skipped most of it.
  expect(result.succeeded).toBe(true);
  const teardown = ops.filter((o) => o.step === "teardown" && o.method !== "GET");
  // Every teardown call is bounded, and by its OWN bound — outside the run budget, never outside a
  // bound. This is the unit `runnerTeardownWorstCaseMs` multiplies.
  for (const o of teardown) expect(o.timeoutMs).toBe(RUNNER_REMOVE_TIMEOUT_MS);
  return teardown.length;
}

/**
 * THE CENSUS SLOT. Every kind in {@link RUNNER_TEARDOWN_STEPS} must have a counter here, and the
 * arm below asserts the two key sets are EQUAL — so a third adapter cannot join the model with its
 * declared count checked by nothing.
 */
const COUNTERS: Record<keyof typeof RUNNER_TEARDOWN_STEPS, () => Promise<number>> = {
  docker: countDockerTeardown,
  kubernetes: countKubernetesTeardown
};

beforeEach(() => {
  dockerCalls.length = 0;
});

// ==================================================================================================
describe("M23.5 HIGH-2: what teardown COSTS is counted from the code, not asserted in a comment", () => {
  // ================================================================================================
  it("EVERY ADAPTER KIND IN THE MODEL HAS A COUNTER — a declared count checked by nothing is the defect", () => {
    expect(Object.keys(COUNTERS).sort()).toStrictEqual(Object.keys(RUNNER_TEARDOWN_STEPS).sort());
  });

  it.each(Object.keys(COUNTERS) as (keyof typeof RUNNER_TEARDOWN_STEPS)[])(
    "%s: the teardown `finally` issues exactly RUNNER_TEARDOWN_STEPS bounded calls",
    async (kind) => {
      // THE ARM A FOURTH TEARDOWN STEP REDDENS. Add one to either adapter and the observed count no
      // longer matches the declared one; correcting the declaration is what then moves
      // `runnerTeardownWorstCaseMs`, the reap stamp and `MANAGED_TRIGGER_GRACE_MS` together.
      await expect(COUNTERS[kind]()).resolves.toBe(RUNNER_TEARDOWN_STEPS[kind]);
    },
    20_000
  );

  it("KUBERNETES COSTS MORE THAN DOCKER, AND EVERY DERIVED QUANTITY SAYS SO", () => {
    // The whole failure was one number standing for both adapters. If these are ever equal again,
    // the model has collapsed back into a constant.
    expect(RUNNER_TEARDOWN_STEPS.kubernetes).toBeGreaterThan(RUNNER_TEARDOWN_STEPS.docker);
    expect(runnerTeardownWorstCaseMs("kubernetes")).toBeGreaterThan(
      runnerTeardownWorstCaseMs("docker")
    );
    expect(runnerPostDeadlineMs("kubernetes")).toBeGreaterThan(runnerPostDeadlineMs("docker"));
    expect(runnerRunBoundMs("kubernetes", 1_000)).toBeGreaterThan(
      runnerRunBoundMs("docker", 1_000)
    );
    expect(runnerReapGraceMs("kubernetes")).toBeGreaterThan(runnerReapGraceMs("docker"));
  });

  it("THE UNIT IS ONE BOUNDED CALL — its own timeout PLUS the margin the port waits before abandoning", () => {
    // A teardown call that ignores its bound is abandoned like any other, so the worst case of one
    // call is `RUNNER_REMOVE_TIMEOUT_MS + RUNNER_STEP_ABANDON_GRACE_MS`. Sizing the model on the
    // timeout alone would understate every grace by one abandonment per step.
    expect(RUNNER_BOUNDED_CALL_WORST_CASE_MS).toBe(
      RUNNER_REMOVE_TIMEOUT_MS + RUNNER_STEP_ABANDON_GRACE_MS
    );
    for (const kind of Object.keys(
      RUNNER_TEARDOWN_STEPS
    ) as (keyof typeof RUNNER_TEARDOWN_STEPS)[]) {
      expect(runnerTeardownWorstCaseMs(kind)).toBe(
        RUNNER_TEARDOWN_STEPS[kind] * RUNNER_BOUNDED_CALL_WORST_CASE_MS
      );
      // `run()` may still abandon the step that was in flight when the deadline passed, THEN tear
      // down — so the post-deadline term is one grace plus the whole teardown, and the stated bound
      // is the budget plus that.
      expect(runnerPostDeadlineMs(kind)).toBe(
        RUNNER_STEP_ABANDON_GRACE_MS + runnerTeardownWorstCaseMs(kind)
      );
      expect(runnerRunBoundMs(kind, 30_000)).toBe(30_000 + runnerPostDeadlineMs(kind));
      // And the reap stamp clears everything `run()` may still do, on THIS adapter.
      expect(runnerReapGraceMs(kind)).toBeGreaterThan(runnerPostDeadlineMs(kind));
    }
  });
});
