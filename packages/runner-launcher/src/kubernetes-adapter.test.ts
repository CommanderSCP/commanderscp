import { beforeEach, describe, expect, it } from "vitest";
import {
  LAUNCHER_OWNER_ID,
  RUNNER_LAUNCHER_DEADLINE_ANNOTATION,
  RUNNER_LAUNCHER_OWNER_LABEL,
  RUNNER_NETWORK_LABEL,
  RUNNER_RUN_ID_LABEL,
  createKubernetesRunnerLauncher,
  isKubernetesLabelValue,
  kubernetesTermination,
  resolveRunnerLauncher,
  runnerJobName,
  runnerSecretName,
  whenKubernetesReapSettled,
  workspaceSlots
} from "./index.js";
import type {
  KubernetesApiRequest,
  KubernetesApiResponse,
  KubernetesRunnerIo,
  KubernetesWorkspaceVolume,
  RunnerCopyIn,
  RunnerCopyOut,
  RunnerSpec
} from "./index.js";
import { runLaunchOrderingConformanceSuite } from "./ordering-conformance.js";
import type { LaunchOrderingSubstrate, RunnerStepKind } from "./ordering-conformance.js";

/**
 * ================================================================================================
 * M23.2 — THE KUBERNETES ADAPTER, AT THE SEAM THAT CAN RECORD AND HOLD EVERY EFFECT
 * ================================================================================================
 *
 * WHAT THIS FILE IS AND IS NOT. It is the Kubernetes counterpart of `docker-adapter.test.ts`: it
 * proves WHAT the adapter sends and, through `ordering-conformance.ts`, WHEN. It cannot prove that
 * an API server accepts any of it, that a Job actually runs, that a `subPath` mount lands the bytes
 * where the runner looks for them, or that a pod's log is readable — a fake agrees with itself by
 * construction, and owner decision 3 says so in those words ("a fake Kubernetes client only proves
 * the adapter agrees with itself"). `kubernetes-adapter.integration.test.ts` drives a REAL kind
 * cluster for exactly that, and the two are complementary rather than redundant: the real cluster is
 * the only thing that can speak to acceptance, and this file is the only thing that can drive every
 * branch of the failure mapping cheaply on every PR.
 *
 * THE DOCKER PATH IS UNTOUCHED BY EVERYTHING HERE. No file in `packages/plugins/*` moves, and the
 * three `launch-argv.golden.test.ts` files do not move by a byte — the whole point of M23.1's port.
 */

const NAMESPACE = "scp";
const WORKSPACE_ROOT = "/scp-workspace";
const WORKSPACE_VOLUME: KubernetesWorkspaceVolume = {
  kind: "persistentVolumeClaim",
  claimName: "scp-runner-workspace"
};

/** One effect the adapter had on the outside world, in issue order. */
interface RecordedOp {
  kind: "request" | "copyDir" | "removeDir";
  step: string;
  method?: string;
  path?: string;
  body?: unknown;
  contentType?: string;
  accept?: string;
  timeoutMs?: number;
  fromDir?: string;
  toDir?: string;
  dir?: string;
}

/** A held op: ISSUED (recorded) but not SETTLED until `deliver` is called. */
interface HeldOp {
  kind: RunnerStepKind;
  deliver(failure?: Error): void;
}

/**
 * A FAKE API SERVER AND A FAKE SHARED VOLUME.
 *
 * Deliberately STATEFUL rather than a canned response list: the adapter POSTs a Job and then PATCHes
 * and DELETEs it BY NAME, and a response list cannot notice that the name it is asked about is not
 * the name it was given. The fake stores what it was sent and answers from it, so a step aimed at the
 * wrong object 404s here for the same reason it would against a real API server.
 */
function cluster(opts: { perRunSecrets?: boolean; runAsNonRoot?: boolean } = {}) {
  const ops: RecordedOp[] = [];
  const jobs = new Map<string, Record<string, unknown>>();
  const secrets = new Map<string, Record<string, unknown>>();
  const dirs = new Set<string>();
  /** Jobs that already exist before this process starts — the peers `reap()` and the 409 arms need. */
  const foreignJobs: Record<string, unknown>[] = [];

  let pod: unknown = {
    metadata: { name: "scp-runner-r1-abcde" },
    status: {
      phase: "Succeeded",
      containerStatuses: [{ name: "runner", state: { terminated: { exitCode: 0 } } }]
    }
  };
  let log = "runner said this";
  /** Overrides the routed answer for the first request whose path matches. */
  const overrides: { match: (req: KubernetesApiRequest) => boolean; res: KubernetesApiResponse }[] =
    [];

  const holds: Record<RunnerStepKind, number> = {
    create: 0,
    "copy-in": 0,
    start: 0,
    "copy-out": 0,
    teardown: 0
  };
  const heldOpen: HeldOp[] = [];

  /**
   * WHICH PORT STEP AN OP MARKS — the Kubernetes spelling of `docker-adapter.test.ts`'s
   * `stepKind(args)`, and derived the same way: from what was SENT, not from a flag the adapter set
   * for the test's benefit.
   *
   * ONLY THE FIRST OP OF EACH STEP MARKS IT, and the rule is structural rather than a de-duplication
   * hack: `start` is one PATCH followed by N status GETs and one log GET, and `teardown` is a Job
   * DELETE followed by a Secret DELETE and a directory removal. The op that MARKS the step is the one
   * that cannot happen twice — the PATCH, the Job DELETE, the Job POST — so a step is recorded
   * exactly once no matter how long its tail is. Everything else returns `undefined` and is invisible
   * to `issued()`, including the `reap()` listing GET that every `run()` schedules.
   */
  const orderingStepOf = (op: RecordedOp): RunnerStepKind | undefined => {
    if (op.kind === "copyDir") return op.step === "copy-in" ? "copy-in" : "copy-out";
    if (op.kind === "removeDir") return undefined;
    if (op.method === "POST" && op.path === `/apis/batch/v1/namespaces/${NAMESPACE}/jobs`) {
      return "create";
    }
    if (op.method === "PATCH") return "start";
    if (
      op.method === "DELETE" &&
      op.path?.startsWith(`/apis/batch/v1/namespaces/${NAMESPACE}/jobs/`)
    ) {
      return "teardown";
    }
    return undefined;
  };

  /** The Job name an op ADDRESSED. Read out of the path/dir for the same reason the Docker substrate
   *  reads it out of the argv: a step aimed at another run's object is visible here exactly as it
   *  would be to the API server. */
  const identityOf = (op: RecordedOp): string | undefined => {
    // A `create` ADDRESSES no object — it POSTs to a collection — so it reports the identity it
    // PRODUCES, read out of the body it sent. Exactly the Docker substrate's rule ("`create`
    // addresses none, so it reports the id it was ALLOCATED"), spelled for a REST create.
    const fromBody = (op.body as { metadata?: { name?: string } } | undefined)?.metadata?.name;
    if (fromBody) return fromBody;
    // BOTH ENDS OF A COPY, not the first one that happens to be defined: a copy-IN's run-scoped end
    // is its DESTINATION and a copy-OUT's is its SOURCE, and reading only one of them made the
    // copy-out report the plugin's host directory (no identity at all) instead of the run's slot.
    const text = [op.path, op.toDir, op.fromDir, op.dir].filter(Boolean).join(" ");
    return /scp-runner-[a-z0-9-]+/.exec(text)?.[0];
  };

  const route = (req: KubernetesApiRequest): KubernetesApiResponse => {
    const overrideIndex = overrides.findIndex((o) => o.match(req));
    if (overrideIndex !== -1) return overrides.splice(overrideIndex, 1)[0]!.res;

    const path = req.path.split("?")[0]!;
    const jobsRoot = `/apis/batch/v1/namespaces/${NAMESPACE}/jobs`;
    const secretsRoot = `/api/v1/namespaces/${NAMESPACE}/secrets`;
    const podsRoot = `/api/v1/namespaces/${NAMESPACE}/pods`;

    if (req.method === "GET" && path === jobsRoot) {
      return { status: 200, body: JSON.stringify({ items: [...jobs.values(), ...foreignJobs] }) };
    }
    if (req.method === "POST" && path === jobsRoot) {
      const body = req.body as { metadata: { name: string } };
      const clash = [...foreignJobs, ...jobs.values()].some(
        (j) => (j as { metadata: { name: string } }).metadata.name === body.metadata.name
      );
      if (clash) {
        return { status: 409, body: JSON.stringify({ kind: "Status", reason: "AlreadyExists" }) };
      }
      jobs.set(body.metadata.name, body as Record<string, unknown>);
      return { status: 201, body: JSON.stringify(body) };
    }
    if (req.method === "POST" && path === secretsRoot) {
      const body = req.body as { metadata: { name: string } };
      if (secrets.has(body.metadata.name)) {
        return { status: 409, body: JSON.stringify({ kind: "Status", reason: "AlreadyExists" }) };
      }
      secrets.set(body.metadata.name, body as Record<string, unknown>);
      return { status: 201, body: JSON.stringify(body) };
    }
    if (req.method === "PATCH" && path.startsWith(`${jobsRoot}/`)) {
      const name = path.slice(jobsRoot.length + 1);
      if (!jobs.has(name)) return { status: 404, body: JSON.stringify({ reason: "NotFound" }) };
      return { status: 200, body: JSON.stringify(jobs.get(name)) };
    }
    if (req.method === "DELETE" && path.startsWith(`${jobsRoot}/`)) {
      const name = path.slice(jobsRoot.length + 1);
      jobs.delete(name);
      const foreign = foreignJobs.findIndex(
        (j) => (j as { metadata: { name: string } }).metadata.name === name
      );
      if (foreign !== -1) foreignJobs.splice(foreign, 1);
      return { status: 200, body: "{}" };
    }
    if (req.method === "DELETE" && path.startsWith(`${secretsRoot}/`)) {
      secrets.delete(path.slice(secretsRoot.length + 1));
      return { status: 200, body: "{}" };
    }
    if (req.method === "GET" && path === podsRoot) {
      return { status: 200, body: JSON.stringify({ items: pod ? [pod] : [] }) };
    }
    if (req.method === "GET" && path.endsWith("/log")) return { status: 200, body: log };
    return { status: 404, body: JSON.stringify({ reason: "NotFound" }) };
  };

  /** Records the op, then either settles it immediately or parks it as HELD. */
  const perform = <T>(op: RecordedOp, produce: () => T): Promise<T> => {
    ops.push(op);
    const kind = orderingStepOf(op);
    if (kind && holds[kind] > 0) {
      holds[kind] -= 1;
      return new Promise<T>((resolve, reject) => {
        heldOpen.push({
          kind,
          deliver: (failure) => (failure ? reject(failure) : resolve(produce()))
        });
      });
    }
    return Promise.resolve().then(produce);
  };

  const io: KubernetesRunnerIo = {
    request: (req) =>
      perform(
        {
          kind: "request",
          step: req.step,
          method: req.method,
          path: req.path,
          body: req.body,
          contentType: req.contentType,
          accept: req.accept,
          timeoutMs: req.timeoutMs
        },
        () => route(req)
      ),
    copyDir: (op) =>
      perform({ kind: "copyDir", step: op.step, fromDir: op.fromDir, toDir: op.toDir }, () => {
        // ONLY THE SHARED VOLUME IS MODELLED. A copy-OUT's destination is a host directory the
        // plugin owns; tracking it here would make `dirs` answer a question this fake cannot.
        if (op.toDir.startsWith(`${WORKSPACE_ROOT}/`)) dirs.add(op.toDir);
      }),
    removeDir: (op) =>
      perform({ kind: "removeDir", step: op.step, dir: op.dir }, () => {
        // RECURSIVE, like `rm -rf`. A `delete` of the exact string would leave every slot behind and
        // let a teardown that removes nothing useful pass.
        for (const d of [...dirs]) {
          if (d === op.dir || d.startsWith(`${op.dir}/`)) dirs.delete(d);
        }
      })
  };

  return {
    io,
    ops,
    jobs,
    secrets,
    dirs,
    foreignJobs,
    overrides,
    orderingStepOf,
    identityOf,
    setPod: (next: unknown) => {
      pod = next;
    },
    setLog: (next: string) => {
      log = next;
    },
    hold: (kind: RunnerStepKind, count = 1) => {
      holds[kind] += count;
    },
    release: (kind: RunnerStepKind, failure?: Error) => {
      const index = heldOpen.findIndex((h) => h.kind === kind);
      if (index === -1) throw new Error(`kubernetes-adapter.test: no held '${kind}' op to release`);
      heldOpen.splice(index, 1)[0]!.deliver(failure);
    },
    launcher: (over: Partial<Parameters<typeof createKubernetesRunnerLauncher>[0]> = {}) =>
      createKubernetesRunnerLauncher({
        namespace: NAMESPACE,
        workspaceRoot: WORKSPACE_ROOT,
        workspaceVolume: WORKSPACE_VOLUME,
        perRunSecrets: opts.perRunSecrets === true,
        runAsNonRoot: opts.runAsNonRoot === true,
        pollIntervalMs: 1,
        sleep: () => Promise.resolve(),
        io,
        ...over
      })
  };
}

const IN_A: RunnerCopyIn = { hostDir: "/host/in-a", containerPath: "/work/in" };
const OUT: RunnerCopyOut = {
  containerPath: "/work/out",
  hostDir: "/host/out",
  when: "on-success",
  onFailure: "propagate"
};

function spec(over: Partial<RunnerSpec> = {}): RunnerSpec {
  return {
    runId: "r1",
    labels: { "scp.executor": "scp-managed-scan", "scp.run-id": "r1" },
    image: "ghcr.io/commanderscp/scp-runner-scan:pinned",
    operands: ["trivy"],
    networkMode: "none",
    env: ["SCP_SCAN_DB_DIR=/work/db"],
    secretEnv: [],
    copyIn: [IN_A],
    copyOut: OUT,
    timeoutMs: 600_000,
    maxBuffer: 32 * 1024 * 1024,
    ...over
  };
}

const requestsOf = (ops: RecordedOp[]) => ops.filter((o) => o.kind === "request");
const sequenceOf = (ops: RecordedOp[]) =>
  ops.map((o) =>
    o.kind === "request" ? `${o.step} ${o.method} ${o.path!.split("?")[0]}` : `${o.step} ${o.kind}`
  );

// ==================================================================================================
// SELECTION — the field that decides which adapter runs, and the module cycle it rides through
// ==================================================================================================

describe("M23.2 adapter selection: explicit operator config, never detection", () => {
  it("AN UNSET `runnerLauncher` IS DOCKER — every deployment that does not opt in is unchanged", () => {
    // THIS IS NOT THE MODULE-CYCLE PROOF, AND IT SAID IT WAS. The sentence here used to read: "if
    // any binding of this file's imports were read at module-evaluation time rather than at call
    // time, THIS line would throw a TDZ ReferenceError before the assertion." It was measured false
    // one commit later — `kubernetes-adapter.ts` had exactly such a top-level read
    // (`RUNNER_LAUNCHER_DEADLINE_ANNOTATION = RUNNER_LAUNCHER_DEADLINE_LABEL`), this case stayed
    // GREEN, and the built package could not be imported by Node at all: every managed plugin
    // subprocess died at load. Vitest resolves the cycle through its own module graph in the other
    // order, so a claim about Node's loader cannot be checked here at all.
    // `module-load.integration.test.ts` builds the package and loads it with `node`, which is the
    // only instrument that can settle it. What THIS case still proves is the ordinary thing its
    // name says: an unset `runnerLauncher` yields a working Docker launcher.
    const launcher = resolveRunnerLauncher({ dockerBinary: "/opt/bin/podman" });
    expect(typeof launcher.run).toBe("function");
    expect(typeof launcher.reap).toBe("function");
  });

  it("`runnerLauncher: 'kubernetes'` SELECTS THE KUBERNETES ADAPTER, and the io reaches it", async () => {
    const c = cluster();
    const launcher = resolveRunnerLauncher({
      runnerLauncher: "kubernetes",
      kubernetes: {
        namespace: NAMESPACE,
        workspaceRoot: WORKSPACE_ROOT,
        workspaceVolume: WORKSPACE_VOLUME,
        io: c.io
      }
    });
    await launcher.run(spec({ copyOut: undefined, copyIn: [] }));
    // The proof it is not the Docker adapter wearing a new name: a Job was POSTed.
    expect(requestsOf(c.ops).some((o) => o.method === "POST" && o.path?.endsWith("/jobs"))).toBe(
      true
    );
  });

  it("`runnerLauncher: 'kubernetes'` WITH NO SETTINGS REFUSES BY NAME, not with a TypeError", () => {
    expect(() => resolveRunnerLauncher({ runnerLauncher: "kubernetes" })).toThrow(
      /no kubernetes settings were injected/
    );
  });
});

// ==================================================================================================
// THE SHAPE OF ONE RUN
// ==================================================================================================

describe("M23.2: the five port steps, in order, against the API server and the shared volume", () => {
  it("THE FULL SEQUENCE — create(suspended) / copy-in / unsuspend+poll+log / copy-out / teardown", async () => {
    const c = cluster();
    const result = await c.launcher().run(spec());
    expect(result.succeeded).toBe(true);
    expect(sequenceOf(c.ops)).toStrictEqual([
      // The reaper's listing GET, scheduled at the top of every run and NOT awaited by the run.
      "teardown GET /apis/batch/v1/namespaces/scp/jobs",
      "create POST /apis/batch/v1/namespaces/scp/jobs",
      "copy-in copyDir",
      "start PATCH /apis/batch/v1/namespaces/scp/jobs/scp-runner-r1",
      "start GET /api/v1/namespaces/scp/pods",
      "start GET /api/v1/namespaces/scp/pods/scp-runner-r1-abcde/log",
      "copy-out copyDir",
      "teardown DELETE /apis/batch/v1/namespaces/scp/jobs/scp-runner-r1",
      "teardown removeDir"
    ]);
  });

  it("THE JOB IS CREATED SUSPENDED — the name is staked before a single byte is copied", async () => {
    const c = cluster();
    await c.launcher().run(spec());
    const post = requestsOf(c.ops).find((o) => o.method === "POST")!;
    const body = post.body as { spec: { suspend: boolean } };
    expect(body.spec.suspend).toBe(true);
    // And the unsuspend is a merge patch, not a replace: a replace would race the Job controller's
    // own status writes.
    const patch = requestsOf(c.ops).find((o) => o.method === "PATCH")!;
    expect(patch.contentType).toBe("application/merge-patch+json");
    expect(patch.body).toStrictEqual({ spec: { suspend: false } });
  });

  it("THE COPY-INS ARE SEQUENTIAL AND EACH LANDS IN ITS OWN SLOT", async () => {
    const c = cluster();
    await c.launcher().run(
      spec({
        copyIn: [
          { hostDir: "/host/image", containerPath: "/work/image" },
          { hostDir: "/host/db", containerPath: "/work/db" }
        ],
        copyOut: undefined
      })
    );
    const copies = c.ops.filter((o) => o.kind === "copyDir");
    expect(copies.map((o) => [o.fromDir, o.toDir])).toStrictEqual([
      ["/host/image", "/scp-workspace/scp-runner-r1/m0"],
      ["/host/db", "/scp-workspace/scp-runner-r1/m1"]
    ]);
  });

  it("A COPY-IN AND A COPY-OUT AT THE SAME `containerPath` SHARE ONE SLOT — managed-iac's shape", async () => {
    // THE DEFECT THIS CATCHES. managed-iac copies IN to /workspace and OUT of /workspace, because the
    // runner edits in place and the evidence is what it left there. A slot per copy OPERATION gives
    // the copy-out its own empty directory: `plan.json` silently never comes back and the run still
    // reports success — the same class as the copy-out race `ordering-conformance.ts` exists for.
    const iacIn: RunnerCopyIn = { hostDir: "/host/ws", containerPath: "/workspace" };
    const iacOut: RunnerCopyOut = {
      containerPath: "/workspace",
      hostDir: "/host/ws",
      when: "always",
      onFailure: "swallow"
    };
    expect([...workspaceSlots(spec({ copyIn: [iacIn], copyOut: iacOut }))]).toStrictEqual([
      ["/workspace", "m0"]
    ]);

    const c = cluster();
    await c.launcher().run(spec({ copyIn: [iacIn], copyOut: iacOut }));
    const copies = c.ops.filter((o) => o.kind === "copyDir");
    expect(copies[0]!.toDir).toBe("/scp-workspace/scp-runner-r1/m0");
    expect(copies[1]!.fromDir).toBe("/scp-workspace/scp-runner-r1/m0");
    // And the Job mounts that ONE slot at the ONE path, not two mounts fighting over /workspace.
    const post = requestsOf(c.ops).find((o) => o.method === "POST")!;
    const mounts = (
      post.body as {
        spec: { template: { spec: { containers: { volumeMounts: unknown[] }[] } } };
      }
    ).spec.template.spec.containers[0]!.volumeMounts;
    expect(mounts).toStrictEqual([
      { name: "workspace", mountPath: "/workspace", subPath: "scp-runner-r1/m0" }
    ]);
  });

  it("TEARDOWN DELETES THE JOB AND THE RUN'S BYTES — and the Secret only when there was one", async () => {
    const c = cluster();
    await c.launcher().run(spec());
    expect(c.jobs.size).toBe(0);
    expect(c.dirs.size).toBe(0);
    expect(
      requestsOf(c.ops).filter((o) => o.method === "DELETE" && o.path?.includes("/secrets/"))
    ).toStrictEqual([]);
  });

  it("TEARDOWN RUNS OUTSIDE THE BUDGET — its own timeout, never the tenant's `timeoutMs`", async () => {
    const c = cluster();
    await c.launcher().run(spec({ timeoutMs: 1_000 }));
    const del = requestsOf(c.ops).find((o) => o.method === "DELETE" && o.path?.includes("/jobs/"))!;
    expect(del.timeoutMs).toBe(30_000);
  });
});

// ==================================================================================================
// WHAT THE JOB CARRIES
// ==================================================================================================

describe("M23.2: identity, attribution and the value that cannot be honoured", () => {
  it("THE JOB NAME IS THE DOCKER CONTAINER NAME — the same string, as `RunnerSpec.runId` promised", () => {
    expect(runnerJobName("abc-123")).toBe("scp-runner-abc-123");
    expect(runnerSecretName("abc-123")).toBe("scp-runner-abc-123-env");
    // 40 is `RUNNER_RUN_ID_PATTERN`'s ceiling and it is chosen so BOTH stay inside 63.
    const longest = "a".repeat(40);
    expect(runnerJobName(longest).length).toBeLessThanOrEqual(63);
    expect(runnerSecretName(longest).length).toBeLessThanOrEqual(63);
  });

  it("THE DEADLINE IS AN ANNOTATION AND THE OWNER IS A LABEL — measured, not preferred", async () => {
    const c = cluster();
    const before = Date.now();
    await c.launcher().run(spec({ timeoutMs: 123_000 }));
    const after = Date.now();
    const post = requestsOf(c.ops).find((o) => o.method === "POST")!;
    const meta = (
      post.body as {
        metadata: { labels: Record<string, string>; annotations: Record<string, string> };
      }
    ).metadata;
    expect(meta.labels[RUNNER_LAUNCHER_OWNER_LABEL]).toBe(LAUNCHER_OWNER_ID);
    const stamped = Date.parse(meta.annotations[RUNNER_LAUNCHER_DEADLINE_ANNOTATION]!);
    expect(stamped).toBeGreaterThanOrEqual(before + 123_000 + 120_000);
    expect(stamped).toBeLessThanOrEqual(after + 123_000 + 120_000);
    // AND THE REASON IT IS NOT A LABEL: the API server rejects the value outright.
    expect(isKubernetesLabelValue(meta.annotations[RUNNER_LAUNCHER_DEADLINE_ANNOTATION]!)).toBe(
      false
    );
    expect(isKubernetesLabelValue(LAUNCHER_OWNER_ID)).toBe(true);
  });

  it("`networkMode` IS CARRIED AS A LABEL AND CLAIMED AS NOTHING — owner decision 1", async () => {
    const c = cluster();
    await c.launcher().run(spec({ networkMode: "none" }));
    const post = requestsOf(c.ops).find((o) => o.method === "POST")!;
    const body = post.body as {
      metadata: { labels: Record<string, string> };
      spec: { template: { metadata: { labels: Record<string, string> } } };
    };
    // On the POD, because a NetworkPolicy selects pods — a label only on the Job would select nothing.
    expect(body.spec.template.metadata.labels[RUNNER_NETWORK_LABEL]).toBe("none");
    expect(body.metadata.labels[RUNNER_NETWORK_LABEL]).toBe("none");
  });

  it("A `networkMode` THAT IS NOT A LEGAL LABEL VALUE BECOMES `unexpressible`, never absent", async () => {
    // An absent label makes a NetworkPolicy written against `scp.launcher.network=none` select
    // nothing — silently, and in the fail-OPEN direction. A recorded `unexpressible` is visible.
    const c = cluster();
    await c.launcher().run(spec({ networkMode: "container:some/other-thing" }));
    const post = requestsOf(c.ops).find((o) => o.method === "POST")!;
    const labels = (post.body as { metadata: { labels: Record<string, string> } }).metadata.labels;
    expect(labels[RUNNER_NETWORK_LABEL]).toBe("unexpressible");
  });

  it("THE POD READ SELECTS ON THIS ADAPTER'S OWN RUN-ID LABEL, not Kubernetes' `job-name`", async () => {
    const c = cluster();
    await c.launcher().run(spec());
    const list = requestsOf(c.ops).find((o) => o.path?.startsWith("/api/v1/namespaces/scp/pods?"))!;
    expect(list.path).toContain(encodeURIComponent(`${RUNNER_RUN_ID_LABEL}=r1`));
    // `job-name` was renamed to `batch.kubernetes.io/job-name` in 1.27; selecting on our own label
    // means the adapter does not have to know which cluster it is talking to.
    expect(list.path).not.toContain("job-name");
  });

  it("A LABEL VALUE KUBERNETES WOULD REJECT IS REFUSED AT `spec`, before anything exists", async () => {
    const c = cluster();
    const result = c.launcher().run(spec({ labels: { "scp.run-id": "not a label value" } }));
    await expect(result).rejects.toThrow(/not a usable Kubernetes label/);
    // NOTHING WAS CREATED. The only op is the reaper's listing GET, which `run()` schedules before
    // anything else and deliberately does not await — see `RunnerLauncher.reap`.
    expect(c.ops.filter((o) => o.method !== "GET")).toStrictEqual([]);
  });
});

// ==================================================================================================
// THE FIVE FAILURE KINDS — through the PORT's one classifier, not a second one
// ==================================================================================================

describe("M23.2: a pod's terminal state maps onto the port's five failure kinds", () => {
  const terminatedPod = (state: unknown) => ({
    metadata: { name: "p1" },
    status: { phase: "Failed", containerStatuses: [{ name: "runner", state }] }
  });

  it("`exit-nonzero` — the runner itself exited non-zero", async () => {
    const c = cluster();
    c.setPod(terminatedPod({ terminated: { exitCode: 3, reason: "Error" } }));
    c.setLog("tofu: something went wrong");
    const result = await c.launcher().run(spec({ copyOut: undefined }));
    expect(result.succeeded).toBe(false);
    expect(result.failure!.kind).toBe("exit-nonzero");
    expect(result.failure!.code).toBe(3);
    // THE NEVER-EMPTY PROPERTY, INHERITED WHOLE. The defect `RunnerResult`'s union closed was a
    // failed run reaching the durable ledger as `detail: ""`.
    expect(result.failure!.detail).toContain("tofu: something went wrong");
  });

  it("`signalled` — the kubelet killed the container", async () => {
    const c = cluster();
    c.setPod(terminatedPod({ terminated: { exitCode: 137, signal: 9, reason: "Error" } }));
    const result = await c.launcher().run(spec({ copyOut: undefined }));
    expect(result.failure!.kind).toBe("signalled");
    expect(result.failure!.signal).toBe("SIG9");
  });

  it("`signalled` — OOMKilled, which carries no signal number", async () => {
    const c = cluster();
    c.setPod(terminatedPod({ terminated: { exitCode: 137, reason: "OOMKilled" } }));
    const result = await c.launcher().run(spec({ copyOut: undefined }));
    // NOT `exit-nonzero`. An operator reading "the runner exited 137" looks for a bug in the runner;
    // "killed by a signal that was not this run's own budget" points at the memory limit.
    expect(result.failure!.kind).toBe("signalled");
  });

  it("`spawn-failed` — the image could not be pulled, so NOTHING RAN", async () => {
    const c = cluster();
    c.setPod({
      metadata: { name: "p1" },
      status: {
        phase: "Pending",
        containerStatuses: [
          {
            name: "runner",
            state: { waiting: { reason: "ImagePullBackOff", message: "no such tag" } }
          }
        ]
      }
    });
    const result = await c.launcher().run(spec({ copyOut: undefined }));
    // THE DISTINCTION WITH THE LARGEST CONSEQUENCE after `budget-exhausted`: `spawn-failed` means
    // "nothing ran, so nothing was mutated". Polling an ImagePullBackOff to the deadline instead
    // would report `budget-exhausted`, which for managed-iac means "a `tofu apply` was SIGTERMed
    // mid-flight, so the real infrastructure state is unknown" — the opposite of the truth.
    expect(result.failure!.kind).toBe("spawn-failed");
    expect(result.failure!.detail).toContain("ImagePullBackOff");
  });

  it("`spawn-failed` — `runAsNonRoot: true` against a root image, which is all three of ours", async () => {
    // NOT A HYPOTHETICAL. `deploy/helm/templates/runner-iac.yaml`'s reference Job shape asserts
    // `runAsNonRoot: true`, and a filterless read of apps/runner-{iac,scan,dep}/Dockerfile finds no
    // `USER` line in any of them. The kubelet refuses such a pod with CreateContainerConfigError.
    const c = cluster();
    c.setPod({
      metadata: { name: "p1" },
      status: {
        phase: "Pending",
        containerStatuses: [
          {
            name: "runner",
            state: {
              waiting: {
                reason: "CreateContainerConfigError",
                message: "container has runAsNonRoot and image will run as root"
              }
            }
          }
        ]
      }
    });
    const result = await c.launcher({ runAsNonRoot: true }).run(spec({ copyOut: undefined }));
    expect(result.failure!.kind).toBe("spawn-failed");
  });

  it("`output-exceeded` — over `maxBuffer`, and the request asked for exactly one byte more", async () => {
    const c = cluster();
    c.setLog("x".repeat(101));
    const result = await c.launcher().run(spec({ maxBuffer: 100, copyOut: undefined }));
    expect(result.failure!.kind).toBe("output-exceeded");
    const logGet = requestsOf(c.ops).find((o) => o.path?.includes("/log"))!;
    // `limitBytes=maxBuffer+1` is the smallest read that can tell "exactly at the limit" from "over
    // it". Asking for exactly `maxBuffer` makes the two indistinguishable and `output-exceeded`
    // unreachable — the API server truncates and returns 200.
    expect(logGet.path).toContain("limitBytes=101");
  });

  it("EXACTLY AT `maxBuffer` IS NOT AN OVERFLOW — the boundary, in the safe direction", async () => {
    const c = cluster();
    c.setLog("x".repeat(100));
    const result = await c.launcher().run(spec({ maxBuffer: 100, copyOut: undefined }));
    expect(result.succeeded).toBe(true);
  });

  it("`budget-exhausted` — a step reached with the budget spent is REFUSED, not issued", async () => {
    const c = cluster();
    // Never terminal: the poll loop spins until the deadline, exactly as a wedged runner would.
    c.setPod({ metadata: { name: "p1" }, status: { phase: "Running", containerStatuses: [] } });
    const result = await c.launcher().run(spec({ timeoutMs: 1_000, copyOut: undefined }));
    expect(result.failure!.kind).toBe("budget-exhausted");
    expect(result.failure!.deadlineExceeded).toBe(true);
    // AND THE TEARDOWN STILL HAPPENED — it is deliberately outside the budget, because the commonest
    // reason to reach it is that the budget is what ran out.
    expect(c.jobs.size).toBe(0);
  });

  it("THE BUDGET IS A WHOLE-RUN DEADLINE — every request's timeout shrinks, none is `timeoutMs`", async () => {
    const c = cluster();
    await c.launcher().run(spec({ timeoutMs: 60_000 }));
    // Teardown is outside the budget and keeps its own 30s; every other request derives from what is
    // LEFT of the one deadline, so none may equal the full budget and none may be <= 0.
    const budgeted = requestsOf(c.ops).filter((o) => o.step !== "teardown");
    expect(budgeted.length).toBeGreaterThan(0);
    for (const req of budgeted) {
      expect(req.timeoutMs).toBeGreaterThan(0);
      expect(req.timeoutMs).toBeLessThanOrEqual(60_000);
    }
    expect(budgeted.map((r) => r.timeoutMs)).toStrictEqual(
      [...budgeted.map((r) => r.timeoutMs)].sort((a, b) => b! - a!)
    );
  });

  it("`kubernetesTermination` RETURNS `undefined` WHILE THE POD IS STILL GOING", () => {
    expect(kubernetesTermination({ status: { phase: "Pending" } })).toBeUndefined();
    expect(
      kubernetesTermination({
        status: { phase: "Running", containerStatuses: [{ name: "runner", state: {} }] }
      })
    ).toBeUndefined();
    // A container name that is not ours must never be read as this run's outcome.
    expect(
      kubernetesTermination({
        status: {
          phase: "Running",
          containerStatuses: [{ name: "istio-proxy", state: { terminated: { exitCode: 1 } } }]
        }
      })
    ).toBeUndefined();
  });
});

// ==================================================================================================
// STDOUT / STDERR — the port has two fields and Kubernetes has one stream
// ==================================================================================================

describe("M23.2: the merged log lands in `stdout`, and that is a decision", () => {
  it("ON SUCCESS the whole merged log is `stdout` — which is what `runnerOutcomeDetail` records", async () => {
    const c = cluster();
    c.setLog("Plan: 3 to add, 0 to change, 1 to destroy");
    const result = await c.launcher().run(spec({ copyOut: undefined }));
    expect(result.stdout).toBe("Plan: 3 to add, 0 to change, 1 to destroy");
    // FILLING `stderr` INSTEAD would make every successful managed run record an empty detail:
    // `runnerOutcomeDetail` returns `result.stdout` on success, and for managed-iac that string IS
    // the durable evidence.
    expect(result.stderr).toBe("");
  });

  it("ON FAILURE the merged log still reaches the diagnosis, through the `stderr`-empty fall-through", async () => {
    const c = cluster();
    c.setPod({
      metadata: { name: "p1" },
      status: {
        phase: "Failed",
        containerStatuses: [{ name: "runner", state: { terminated: { exitCode: 1 } } }]
      }
    });
    c.setLog("npm ERR! nothing to bump");
    const result = await c.launcher().run(spec({ copyOut: undefined }));
    // `classifyRunnerFailure` reads `stderr.length > 0 ? stderr : stdout`, with the comment "a
    // runner that explains itself on stdout must not be recorded as silent". Empty `stderr` takes
    // that branch on purpose.
    expect(result.failure!.detail).toContain("npm ERR! nothing to bump");
  });
});

// ==================================================================================================
// THE PER-RUN SECRET — a declared capability that is OFF
// ==================================================================================================

describe("M23.2: `secretEnv` is a wired, disabled capability until the RBAC grant is decided", () => {
  const withSecret = spec({
    secretEnv: ["AWS_SECRET_ACCESS_KEY=super-secret-value"],
    copyOut: undefined
  });

  it("WITH THE CAPABILITY OFF THE RUN IS REFUSED AT `secret-env` — nothing is created", async () => {
    const c = cluster({ perRunSecrets: false });
    await expect(c.launcher().run(withSecret)).rejects.toThrow(
      /needs per-run Secrets and the Kubernetes launcher was not granted them/
    );
    // NOT a fallback to `env[].value` (plaintext in etcd and in every etcd backup) and NOT a silent
    // drop (a `tofu apply` with no credentials, failing somewhere inside OpenTofu).
    expect(requestsOf(c.ops).filter((o) => o.method !== "GET")).toStrictEqual([]);
  });

  it("THE REFUSAL CARRIES NO CREDENTIAL — the whole reason this class exists", async () => {
    const c = cluster({ perRunSecrets: false });
    const err = (await c
      .launcher()
      .run(withSecret)
      .then(() => new Error("the run was expected to be refused, and resolved instead"))
      .catch((e: Error) => e)) as Error;
    for (const text of [err.message, String(err), err.stack ?? "", JSON.stringify(err)]) {
      expect(text).not.toContain("super-secret-value");
    }
  });

  it("WITH THE CAPABILITY ON, the value travels as a Secret + envFrom, never as `env[].value`", async () => {
    const c = cluster({ perRunSecrets: true });
    await c.launcher().run(withSecret);
    const secretPost = requestsOf(c.ops).find((o) => o.path?.endsWith("/secrets"))!;
    expect(secretPost.step).toBe("secret-env");
    expect((secretPost.body as { data: Record<string, string> }).data).toStrictEqual({
      AWS_SECRET_ACCESS_KEY: Buffer.from("super-secret-value").toString("base64")
    });
    const jobPost = requestsOf(c.ops).find(
      (o) => o.path?.endsWith("/jobs") && o.method === "POST"
    )!;
    const container = (
      jobPost.body as {
        spec: {
          template: {
            spec: { containers: { env: unknown[]; envFrom?: unknown[] }[] };
          };
        };
      }
    ).spec.template.spec.containers[0]!;
    expect(container.envFrom).toStrictEqual([{ secretRef: { name: "scp-runner-r1-env" } }]);
    expect(JSON.stringify(container.env)).not.toContain("super-secret-value");
  });

  it("THE SECRET IS DELETED AT TEARDOWN — its lifetime is the run's, not `ttlSecondsAfterFinished`", async () => {
    const c = cluster({ perRunSecrets: true });
    await c.launcher().run(withSecret);
    expect(c.secrets.size).toBe(0);
    const deletes = requestsOf(c.ops).filter((o) => o.method === "DELETE");
    // Job first, then Secret: the Job owns the pod, and deleting the Secret while a pod can still be
    // scheduled against it turns a credential delivery into a CreateContainerConfigError.
    expect(deletes.map((d) => d.path!.split("?")[0])).toStrictEqual([
      "/apis/batch/v1/namespaces/scp/jobs/scp-runner-r1",
      "/api/v1/namespaces/scp/secrets/scp-runner-r1-env"
    ]);
  });

  it("A FAILURE MID-RUN REDACTS THE BASE64 ENCODING TOO, not only the plaintext", async () => {
    // THE ONE REDACTION THE DOCKER ADAPTER NEVER NEEDED. A Secret body carries the credential
    // base64-encoded, and a base64 string does not match its own plaintext — so a redaction set
    // built the Docker way (values + the env-file path) lets the whole credential through in any
    // echoed request or response body.
    const c = cluster({ perRunSecrets: true });
    const encoded = Buffer.from("super-secret-value").toString("base64");
    c.overrides.push({
      match: (r) => r.method === "PATCH",
      // A real API server echoes the object it refused. This is that, with the credential in it.
      res: { status: 422, body: `rejected: {"data":{"AWS_SECRET_ACCESS_KEY":"${encoded}"}}` }
    });
    const result = await c.launcher().run(withSecret);
    expect(result.succeeded).toBe(false);
    expect(result.failure!.detail).not.toContain(encoded);
    expect(result.failure!.detail).not.toContain("super-secret-value");
    expect(result.failure!.detail).toContain("***");
  });
});

// ==================================================================================================
// THE NAME CONFLICT — a typed 409 where Docker had a stderr substring
// ==================================================================================================

describe("M23.2: a run that lost its name tears down NOTHING", () => {
  it("A 409 ON THE JOB POST IS `AlreadyExists`, and no DELETE follows it", async () => {
    const c = cluster();
    c.foreignJobs.push({ metadata: { name: "scp-runner-r1" } });
    await expect(c.launcher().run(spec())).rejects.toThrow(/already exists — another run holds/);
    // THE INVARIANT, unchanged from M23.1e: everything behind that name belongs to a run this one
    // did not start. An unconditional teardown destroys a live `tofu apply`.
    expect(requestsOf(c.ops).some((o) => o.method === "DELETE")).toBe(false);
    expect(c.foreignJobs).toHaveLength(1);
    // ...AND NOT ITS BYTES EITHER. The Kubernetes half the Docker adapter had no equivalent of: the
    // workspace subtree is named after the same runId, so it is the other run's too.
    expect(c.ops.some((o) => o.kind === "removeDir")).toBe(false);
  });

  it("A 409 ON THE SECRET POST STOPS THE RUN BEFORE THE JOB IS EVEN ATTEMPTED", async () => {
    const c = cluster({ perRunSecrets: true });
    const launcher = c.launcher();
    // A REALISTIC VALUE, and the reason is a real property of the port's redaction: it is a plain
    // split/join over the declared secret VALUES, so a one-character secret ("A=1") redacts every
    // "1" in every message the adapter produces, including the run id. True of the Docker adapter
    // too; worth knowing, and not what this case is about.
    const secretEnv = ["AWS_SECRET_ACCESS_KEY=an-actual-looking-credential"];
    await launcher.run(spec({ secretEnv, copyOut: undefined }));
    // Re-create the Secret behind the scenes to model a peer that holds it.
    c.secrets.set("scp-runner-r1-env", { metadata: { name: "scp-runner-r1-env" } });
    c.ops.length = 0;
    await expect(launcher.run(spec({ secretEnv, copyOut: undefined }))).rejects.toThrow(
      /Secret scp-runner-r1-env already exists/
    );
    expect(requestsOf(c.ops).some((o) => o.method === "POST" && o.path?.endsWith("/jobs"))).toBe(
      false
    );
    expect(requestsOf(c.ops).some((o) => o.method === "DELETE")).toBe(false);
  });

  it("EVERY OTHER CREATE FAILURE STILL TEARS DOWN — without this arm, 'skip on any failure' passes", async () => {
    const c = cluster();
    c.overrides.push({
      match: (r) => r.method === "POST" && r.path.endsWith("/jobs"),
      res: { status: 500, body: '{"reason":"InternalError"}' }
    });
    await expect(c.launcher().run(spec())).rejects.toThrow(/HTTP 500/);
    expect(requestsOf(c.ops).some((o) => o.method === "DELETE" && o.path?.includes("/jobs/"))).toBe(
      true
    );
  });
});

// ==================================================================================================
// COPY-OUT — the two asymmetries M23.1 refused to normalise
// ==================================================================================================

describe("M23.2: `copyOut.when` and `copyOut.onFailure` are the caller's, unchanged", () => {
  it("`when: 'on-success'` SKIPS the copy-out after a failed run", async () => {
    const c = cluster();
    c.setPod({
      metadata: { name: "p1" },
      status: {
        phase: "Failed",
        containerStatuses: [{ name: "runner", state: { terminated: { exitCode: 1 } } }]
      }
    });
    await c.launcher().run(spec({ copyOut: OUT }));
    expect(c.ops.filter((o) => o.step === "copy-out")).toStrictEqual([]);
  });

  it("`when: 'always'` COPIES OUT AFTER A FAILED RUN — managed-iac's partial plan.json", async () => {
    const c = cluster();
    c.setPod({
      metadata: { name: "p1" },
      status: {
        phase: "Failed",
        containerStatuses: [{ name: "runner", state: { terminated: { exitCode: 1 } } }]
      }
    });
    await c.launcher().run(
      spec({
        copyIn: [{ hostDir: "/host/ws", containerPath: "/workspace" }],
        copyOut: {
          containerPath: "/workspace",
          hostDir: "/host/ws",
          when: "always",
          onFailure: "swallow"
        }
      })
    );
    expect(c.ops.filter((o) => o.step === "copy-out")).toHaveLength(1);
  });

  it("`onFailure: 'propagate'` LETS THE COPY-OUT'S OWN FAILURE ESCAPE `run()`", async () => {
    const c = cluster();
    const io: KubernetesRunnerIo = {
      ...c.io,
      copyDir: (op) =>
        op.step === "copy-out"
          ? Promise.reject(new Error("copy-out: no such file or directory"))
          : c.io.copyDir(op)
    };
    await expect(c.launcher({ io }).run(spec())).rejects.toThrow(/no such file or directory/);
  });

  it("`onFailure: 'swallow'` KEEPS THE RUN SUCCEEDED", async () => {
    const c = cluster();
    const io: KubernetesRunnerIo = {
      ...c.io,
      copyDir: (op) =>
        op.step === "copy-out"
          ? Promise.reject(new Error("copy-out: no such file or directory"))
          : c.io.copyDir(op)
    };
    const result = await c.launcher({ io }).run(
      spec({
        copyIn: [{ hostDir: "/host/ws", containerPath: "/workspace" }],
        copyOut: {
          containerPath: "/workspace",
          hostDir: "/host/ws",
          when: "always",
          onFailure: "swallow"
        }
      })
    );
    expect(result.succeeded).toBe(true);
  });
});

// ==================================================================================================
// THE REAPER
// ==================================================================================================

describe("M23.2: `reap()` removes foreign, expired Jobs and nothing else", () => {
  const past = new Date(Date.now() - 60_000).toISOString();
  const future = new Date(Date.now() + 600_000).toISOString();

  const foreign = (name: string, deadline: string | undefined) => ({
    metadata: {
      name,
      labels: { [RUNNER_LAUNCHER_OWNER_LABEL]: "some-other-process" },
      ...(deadline ? { annotations: { [RUNNER_LAUNCHER_DEADLINE_ANNOTATION]: deadline } } : {})
    }
  });

  it("FOREIGN AND EXPIRED IS REMOVED; FOREIGN AND LIVE IS NOT", async () => {
    const c = cluster();
    c.foreignJobs.push(foreign("scp-runner-dead", past), foreign("scp-runner-live", future));
    const removed = await c.launcher().reap();
    expect(removed).toStrictEqual(["scp-runner-dead"]);
  });

  it("MY OWN JOB IS NEVER TOUCHED — checked by owner, not by whether it looks idle", async () => {
    const c = cluster();
    c.foreignJobs.push({
      metadata: {
        name: "scp-runner-mine",
        labels: { [RUNNER_LAUNCHER_OWNER_LABEL]: LAUNCHER_OWNER_ID },
        annotations: { [RUNNER_LAUNCHER_DEADLINE_ANNOTATION]: past }
      }
    });
    expect(await c.launcher().reap()).toStrictEqual([]);
  });

  it("A MISSING OR GARBLED DEADLINE FAILS CLOSED — ambiguous must never read as safe", async () => {
    const c = cluster();
    c.foreignJobs.push(
      foreign("scp-runner-nodeadline", undefined),
      foreign("scp-runner-junk", "yesterday")
    );
    expect(await c.launcher().reap()).toStrictEqual([]);
  });

  it("THE RUN'S BYTES GO WITH THE JOB — a shared volume has nothing else sweeping it", async () => {
    const c = cluster();
    c.foreignJobs.push(foreign("scp-runner-dead", past));
    await c.launcher().reap();
    const removals = c.ops.filter((o) => o.kind === "removeDir");
    expect(removals.map((r) => r.dir)).toStrictEqual(["/scp-workspace/scp-runner-dead"]);
  });

  it("A LEFTOVER SECRET IS SWEPT ONLY WHERE THE GRANT EXISTS", async () => {
    const off = cluster({ perRunSecrets: false });
    off.foreignJobs.push(foreign("scp-runner-dead", past));
    await off.launcher().reap();
    expect(requestsOf(off.ops).some((o) => o.path?.includes("/secrets/"))).toBe(false);

    const on = cluster({ perRunSecrets: true });
    on.foreignJobs.push(foreign("scp-runner-dead", past));
    await on.launcher({ perRunSecrets: true }).reap();
    expect(
      requestsOf(on.ops).some(
        (o) =>
          o.method === "DELETE" && o.path === "/api/v1/namespaces/scp/secrets/scp-runner-dead-env"
      )
    ).toBe(true);
  });

  it("`secretEnvDir` IS ACCEPTED AND IS A NO-OP — this adapter writes no env file", async () => {
    const c = cluster();
    expect(await c.launcher().reap("/some/plugin/state")).toStrictEqual([]);
    expect(c.ops.filter((o) => o.kind === "removeDir")).toStrictEqual([]);
  });

  it("PASSES ARE SINGLE-FLIGHTED PER NAMESPACE — k concurrent runs do not start k sweeps", async () => {
    const c = cluster();
    c.foreignJobs.push(foreign("scp-runner-dead", past));
    const launcher = c.launcher();
    const [a, b] = await Promise.all([launcher.reap(), launcher.reap()]);
    expect(a).toStrictEqual(b);
    // One listing GET, not two.
    expect(
      requestsOf(c.ops).filter(
        (o) => o.method === "GET" && o.path?.includes("labelSelector=scp.launcher.owner")
      )
    ).toHaveLength(1);
    await whenKubernetesReapSettled(NAMESPACE);
  });

  it("A LISTING FAILURE IS SWALLOWED — a sweep that cannot list must not block the run it precedes", async () => {
    const c = cluster();
    c.overrides.push({
      match: (r) => r.method === "GET" && r.path.includes("labelSelector=scp.launcher.owner"),
      res: { status: 403, body: '{"reason":"Forbidden"}' }
    });
    expect(await c.launcher().reap()).toStrictEqual([]);
  });
});

// ==================================================================================================
// THE ORDERING CONFORMANCE SUITE — inherited, not re-derived
// ==================================================================================================

/**
 * THE KUBERNETES SUBSTRATE.
 *
 * `ordering-conformance.ts` was written for this moment and says so: "M23.2 adds a Kubernetes-Job
 * adapter... The Kubernetes adapter inherits every case below by writing a substrate, not by
 * re-deriving the race." This is that substrate, and every one of the ten cases is MEANINGFUL for a
 * Job-based launcher — none is skipped. Two are worth naming because their premise changes shape:
 *
 *   THE COPY-INS ARE SEQUENTIAL. On Docker the hazard is two `docker cp`s racing into one container
 *   and racing `start`. Here the copies are ordinary filesystem writes into a shared volume, and the
 *   race they would lose is worse rather than milder: an unawaited copy-in lets the PATCH that
 *   unsuspends the Job fire while bytes are still landing, so the runner starts against a partial
 *   workspace. Same case, same assertion, a hazard that is if anything sharper.
 *
 *   WITH NO COPY-OUT, TEARDOWN STILL WAITS ON `start`. Its `issued()` expectation is
 *   `["create","start","teardown"]`, i.e. it requires `create` and `start` to be TWO issued steps. A
 *   Job is created running, and an adapter that collapsed them would fail this case. `suspend: true`
 *   is what keeps them two, and it is the right answer for an independent reason (the name must be
 *   staked before the bytes move) — so this case is not merely satisfied, it is the check that the
 *   design decision stayed made.
 *
 * WHAT IT STILL CANNOT SEE, inherited verbatim from the Docker substrate's own caveat: it proves each
 * step is awaited before the next is ISSUED; it does not prove the process the adapter waited on is
 * the one that finished. Here that gap is wider than on Docker — a held PATCH is not a running pod —
 * and `kubernetes-adapter.integration.test.ts` against a real kind cluster is the only thing that can
 * close it.
 */
function kubernetesOrderingSubstrate(): LaunchOrderingSubstrate {
  const c = cluster();
  let runIdSequence = 0;
  return {
    launcher: c.launcher(),
    baseSpec: () => {
      const runId = `r${++runIdSequence}`;
      // A DISTINCT POD PER RUN, named after the run, so the concurrency case can tell them apart
      // through the log read exactly as it tells the Job DELETEs apart.
      return spec({
        runId,
        labels: { "scp.executor": "scp-managed-scan", "scp.run-id": runId },
        copyOut: undefined
      });
    },
    issued: () =>
      c.ops.map((o) => c.orderingStepOf(o)).filter((k): k is RunnerStepKind => k !== undefined),
    issuedIdentities: () =>
      c.ops.filter((o) => c.orderingStepOf(o) !== undefined).map((o) => c.identityOf(o)),
    hold: (kind, count = 1) => c.hold(kind, count),
    release: (kind, failure) => c.release(kind, failure)
  };
}

runLaunchOrderingConformanceSuite(
  "M23.2 conformance — the Kubernetes adapter",
  kubernetesOrderingSubstrate
);

// ==================================================================================================
// NON-VACUITY OF THE SUBSTRATE ITSELF
// ==================================================================================================

describe("M23.2: the substrate is not vacuous", () => {
  let substrate: LaunchOrderingSubstrate;
  beforeEach(() => {
    substrate = kubernetesOrderingSubstrate();
  });

  it("A HELD STEP IS ISSUED AND DOES NOT SETTLE — the one property that makes the suite honest", async () => {
    // If `hold` delayed the ISSUE rather than the SETTLE, every held case above would pass while
    // proving nothing. `ordering-conformance.ts` records the measurement that this protection lives
    // in the held cases' own pre-release assertions; this is that property stated directly against
    // the Kubernetes substrate, so a substrate regression fails HERE with a readable message rather
    // than as nine confusing failures.
    substrate.hold("start");
    let settled = false;
    const run = substrate.launcher
      .run({ ...substrate.baseSpec(), copyIn: [IN_A], copyOut: undefined })
      .then(() => {
        settled = true;
      });
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
    expect(substrate.issued()).toStrictEqual(["create", "copy-in", "start"]);
    expect(settled).toBe(false);
    substrate.release("start");
    await run;
    expect(substrate.issued()).toStrictEqual(["create", "copy-in", "start", "teardown"]);
  });

  it("EVERY ISSUED STEP REPORTS AN IDENTITY — an all-`undefined` substrate passes the concurrency case vacuously", async () => {
    await substrate.launcher.run({
      ...substrate.baseSpec(),
      copyIn: [IN_A],
      copyOut: undefined
    });
    const identities = substrate.issuedIdentities();
    expect(identities.length).toBe(substrate.issued().length);
    expect(identities.every((id) => typeof id === "string" && id.length > 0)).toBe(true);
  });
});
