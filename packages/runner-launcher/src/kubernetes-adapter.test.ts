import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  KUBERNETES_POLL_INTERVAL_MS,
  LAUNCHER_OWNER_ID,
  RUNNER_MIN_STEP_BUDGET_MS,
  RUNNER_OUTCOME_UNKNOWN_CODE,
  RUNNER_LAUNCHER_DEADLINE_ANNOTATION,
  RUNNER_LAUNCHER_OWNER_LABEL,
  RUNNER_NETWORK_LABEL,
  RUNNER_RUN_ID_LABEL,
  createKubernetesRunnerLauncher,
  isKubernetesLabelValue,
  kubernetesContainerStarted,
  kubernetesJobTermination,
  kubernetesStartVerdict,
  kubernetesTermination,
  kubernetesWaitingEvidence,
  resolveRunnerLauncher,
  runnerJobName,
  runnerReapGraceMs,
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
  /** Monotonic `metadata.uid` source — see the Job POST route. */
  let uidCounter = 0;

  /** Deletes every Secret whose `ownerReferences` names `uid`, which is what a real cluster's
   *  garbage collector does when the owner goes. Also the collector's OTHER rule, and it is the one
   *  that matters for orphan debris: an owner reference that resolves to nothing at all is collected
   *  too, so a Secret left behind by a SIGKILLed run does not survive its Job. */
  const collectOrphanedSecrets = (deletedUid?: string) => {
    const liveUids = new Set(
      [...jobs.values(), ...foreignJobs].map(
        (j) => (j as { metadata?: { uid?: string } }).metadata?.uid
      )
    );
    for (const [name, obj] of [...secrets]) {
      const owners =
        (obj as { metadata?: { ownerReferences?: { uid?: string }[] } }).metadata
          ?.ownerReferences ?? [];
      if (owners.length === 0) continue; // unowned objects are nobody's garbage
      const collected = owners.some(
        (o) => o.uid === deletedUid || (o.uid !== undefined && !liveUids.has(o.uid))
      );
      if (collected) secrets.delete(name);
    }
  };
  const dirs = new Set<string>();
  /** Jobs that already exist before this process starts — the peers `reap()` and the 409 arms need. */
  const foreignJobs: Record<string, unknown>[] = [];

  /** M23.5 — what a `GET jobs/<name>` reports as the Job's OWN status, and what its event stream
   *  says. Both are `undefined`/empty for every existing case, so nothing changes for them; the
   *  three routes HIGH-4 measured are the ones that need a Job to speak for itself. */
  let jobStatus: unknown = undefined;
  let jobEvents: unknown[] = [];

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
      // THE API SERVER STAMPS `metadata.uid` ON CREATE, AND THIS FAKE HAS TO TOO — not for realism's
      // sake but because the adapter READS it: the per-run Secret's `ownerReference` needs the Job's
      // uid, and a fake that echoed the POSTed body unchanged would make every `secretEnv` run
      // refuse with "the Job create response carried no metadata.uid". Monotonic rather than random
      // so a RECREATED Job of the same name gets a DIFFERENT uid, which is the property the
      // stale-owner arm below turns on.
      uidCounter += 1;
      const stamped = {
        ...(body as Record<string, unknown>),
        metadata: { ...(body.metadata as Record<string, unknown>), uid: `uid-${uidCounter}` }
      };
      jobs.set(body.metadata.name, stamped);
      return { status: 201, body: JSON.stringify(stamped) };
    }
    if (req.method === "POST" && path === secretsRoot) {
      const body = req.body as { metadata: { name: string } };
      if (secrets.has(body.metadata.name)) {
        return { status: 409, body: JSON.stringify({ kind: "Status", reason: "AlreadyExists" }) };
      }
      secrets.set(body.metadata.name, body as Record<string, unknown>);
      return { status: 201, body: JSON.stringify(body) };
    }
    if (req.method === "GET" && path.startsWith(`${jobsRoot}/`)) {
      const name = path.slice(jobsRoot.length + 1);
      const job = jobs.get(name);
      if (!job) return { status: 404, body: JSON.stringify({ reason: "NotFound" }) };
      return {
        status: 200,
        body: JSON.stringify(jobStatus === undefined ? job : { ...job, status: jobStatus })
      };
    }
    if (req.method === "GET" && path === `/api/v1/namespaces/${NAMESPACE}/events`) {
      return { status: 200, body: JSON.stringify({ items: jobEvents }) };
    }
    if (req.method === "PATCH" && path.startsWith(`${jobsRoot}/`)) {
      const name = path.slice(jobsRoot.length + 1);
      if (!jobs.has(name)) return { status: 404, body: JSON.stringify({ reason: "NotFound" }) };
      return { status: 200, body: JSON.stringify(jobs.get(name)) };
    }
    if (req.method === "DELETE" && path.startsWith(`${jobsRoot}/`)) {
      const name = path.slice(jobsRoot.length + 1);
      const gone = jobs.get(name) as { metadata?: { uid?: string } } | undefined;
      jobs.delete(name);
      const foreign = foreignJobs.findIndex(
        (j) => (j as { metadata: { name: string } }).metadata.name === name
      );
      if (foreign !== -1) foreignJobs.splice(foreign, 1);
      // KUBERNETES' GARBAGE COLLECTOR, MODELLED — and it is modelled because the adapter DEPENDS on
      // it. `ownerReferences` is what makes the per-run Secret's deletion survive a SIGKILL of this
      // process, and a fake in which deleting a Job left its owned Secret behind would let a
      // regression that dropped the `ownerReference` pass every unit test in this file. The real
      // behaviour is proved against a real API server in `kubernetes-adapter.kind.test.ts`; this is
      // the model that keeps the unit suite from being wrong in the same direction.
      collectOrphanedSecrets(gone?.metadata?.uid);
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
    setJobStatus: (next: unknown) => {
      jobStatus = next;
    },
    setEvents: (next: unknown[]) => {
      jobEvents = next;
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
        // THE ADAPTER'S OWN DEFAULT, NOT `1` — M23.5 verification pass 19. `sleep` is stubbed to
        // resolve immediately below, so this number is NEVER A DELAY here: it costs the suite
        // nothing, and it is read as a FACT by `kubernetesStartVerdict` ("how old may a landed
        // observation be and still speak for the budget?"). At `1` every fixture's blind window was
        // a hundred poll intervals wide and the arm that reasons about staleness could not be
        // exercised honestly.
        pollIntervalMs: KUBERNETES_POLL_INTERVAL_MS,
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

  it("M23.5: THE DEPLOYMENT'S POD CONVENTIONS SURVIVE THE WHOLE CHAIN — settings -> resolver -> adapter -> Job", async () => {
    // THIS TEST EXISTS BECAUSE THE MUTATION TABLE FOUND TWO LINKS NOTHING GATED, and both are the
    // component-built-never-installed shape. `kubernetes-launch.golden.test.ts` calls `jobManifest`
    // DIRECTLY, so it stays green when the block never reaches it; `managed-runner-selection.test.ts`
    // reads `managedRunnerSettings()`, so it stays green when nothing consumes what that returns.
    // Deleting `...(k8s.pod ? { pod: k8s.pod } : {})` from `resolveRunnerLauncher`, or
    // `...(config.pod ? { pod: config.pod } : {})` from the `create` step, reddened NOTHING across
    // all three suites: a channel built end to end and connected in the middle by nobody.
    //
    // So this drives the SHIPPED selection path and reads the bytes that were actually POSTed.
    const c = cluster();
    const launcher = resolveRunnerLauncher({
      runnerLauncher: "kubernetes",
      kubernetes: {
        namespace: NAMESPACE,
        workspaceRoot: WORKSPACE_ROOT,
        workspaceVolume: WORKSPACE_VOLUME,
        pod: {
          imagePullSecrets: ["harbor-creds"],
          imagePullPolicy: "IfNotPresent",
          resources: { limits: { memory: "4Gi" } }
        },
        io: c.io
      }
    });
    await launcher.run(spec({ copyOut: undefined, copyIn: [] }));
    const created = requestsOf(c.ops).find((o) => o.method === "POST" && o.path?.endsWith("/jobs"))
      ?.body as {
      spec: {
        template: {
          spec: {
            imagePullSecrets?: { name: string }[];
            containers: { imagePullPolicy?: string; resources?: unknown }[];
          };
        };
      };
    };
    expect(created.spec.template.spec.imagePullSecrets).toStrictEqual([{ name: "harbor-creds" }]);
    expect(created.spec.template.spec.containers[0]!.imagePullPolicy).toBe("IfNotPresent");
    expect(created.spec.template.spec.containers[0]!.resources).toStrictEqual({
      limits: { memory: "4Gi" }
    });
  });

  it("M23.5: AND A DEPLOYMENT THAT STATES NONE POSTS A JOB WITH NONE OF THE THREE", async () => {
    // The negative control for the case above. Without it, "always emit them" passes — and every
    // existing deployment's launch changes shape, which is exactly what the golden promises it does
    // not. Read off the POSTed bytes rather than off `jobManifest`, for the same reason.
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
    const created = requestsOf(c.ops).find((o) => o.method === "POST" && o.path?.endsWith("/jobs"))
      ?.body as { spec: { template: { spec: Record<string, unknown> } } };
    expect(created.spec.template.spec).not.toHaveProperty("imagePullSecrets");
    const container = (created.spec.template.spec.containers as Record<string, unknown>[])[0]!;
    expect(container).not.toHaveProperty("imagePullPolicy");
    expect(container).not.toHaveProperty("resources");
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
    // THE GRACE IS THIS ADAPTER'S, NOT THE DOCKER ONE'S (M23.5 HIGH-2). It was a flat 120_000 here
    // — `RUNNER_REAP_GRACE_MS`, sized against a ONE-call teardown — while this adapter's teardown is
    // three calls and the host's own grace grows with it. A stamp that expires before the owning
    // process is dead is precisely what `reap()` must never see.
    const grace = runnerReapGraceMs("kubernetes");
    expect(stamped).toBeGreaterThanOrEqual(before + 123_000 + grace);
    expect(stamped).toBeLessThanOrEqual(after + 123_000 + grace);
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
// THE FAILURE KINDS — through the PORT's one classifier, not a second one
// ==================================================================================================

describe("M23.2: a pod's terminal state maps onto the port's failure kinds", () => {
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
    //
    // THE FIXTURE WAS NOT WHAT ITS COMMENT SAID, and M23.5 is where that mattered. `containerStatuses:
    // []` on a `Running` pod is a shape no kubelet produces — a pod is `Running` only once every
    // container has been created — and the distinction was invisible while every non-terminal poll
    // had the same verdict. It does not any more: a run where the container never started is
    // `spawn-failed` ("nothing ran"), not `budget-exhausted` ("SIGTERMed mid-flight, state unknown").
    // So the wedged runner is now described as a wedged runner: RUNNING, and never finishing.
    c.setPod({
      metadata: { name: "p1" },
      status: {
        phase: "Running",
        containerStatuses: [
          { name: "runner", state: { running: { startedAt: "2026-08-20T00:00:00Z" } } }
        ]
      }
    });
    const result = await c.launcher().run(spec({ timeoutMs: 1_000, copyOut: undefined }));
    expect(result.failure!.kind).toBe("budget-exhausted");
    expect(result.failure!.deadlineExceeded).toBe(true);
    // AND THE TEARDOWN STILL HAPPENED — it is deliberately outside the budget, because the commonest
    // reason to reach it is that the budget is what ran out.
    expect(c.jobs.size).toBe(0);
  });

  // ================================================================================================
  // M23.5 — THE THREE ROUTES THAT ALL REPORTED `budget-exhausted` AFTER BURNING THE WHOLE BUDGET
  // ================================================================================================
  //
  // `kubernetesTermination` reads `pod.status.containerStatuses` AND NOTHING ELSE. Every route below
  // was measured on a real cluster, and every one produced the identical verdict — "the whole-run
  // budget ran out and the runner was stopped mid-flight" — which for managed-iac means "a `tofu
  // apply` was SIGTERMed mid-flight, so the real infrastructure state is unknown". Two of the three
  // ran NOTHING. `FATAL_WAITING_REASONS`' own doc calls that "the single worst misdiagnosis available
  // here", about a set that catches a container the kubelet refused; these are the routes where no
  // container was ever asked for, and nothing looked at them.
  //
  // AND THE EVIDENCE WAS BEING DELETED. Nothing read `job.status.conditions` or the Job's events, and
  // teardown deletes the Job — so the only record of a `FailedCreate` went with it. It is read here
  // while the run is still alive.

  it("M23.5 ROUTE 1 — a ResourceQuota rejects the pod CREATE: `spawn-failed`, carrying the API server's own words", async () => {
    const c = cluster();
    // NO POD EVER EXISTS. That is the whole shape: the Job is unsuspended, the controller tries to
    // create a pod, admission refuses, and the pod list stays empty forever.
    c.setPod(undefined);
    c.setEvents([
      {
        type: "Warning",
        reason: "FailedCreate",
        count: 7,
        message:
          'Error creating: pods "scp-runner-r1-xxxxx" is forbidden: failed quota: runner-quota: must specify limits.memory for: runner'
      }
    ]);
    const result = await c.launcher().run(spec({ timeoutMs: 1_000, copyOut: undefined }));

    // NOT `budget-exhausted`. Nothing ran, so nothing was mutated — which is `spawn-failed`'s
    // wording, verbatim, and the only honest thing to tell an operator holding a `tofu apply`.
    expect(result.failure!.kind).toBe("spawn-failed");
    // AND THE BOUND THAT ENDED IT IS REPORTED, NOT SUPPRESSED (M23.5 verification pass 20). This
    // asserted `false` while the run had polled to the deadline and the message said so, because the
    // producer forced the flag down to keep `budget-exhausted` from winning the classification.
    // `classifyRunnerFailure` now tests {@link RUNNER_NEVER_STARTED_CODE} itself, ahead of the flag,
    // so the KIND is settled by what the producer declared and the FLAG is free to say which clock
    // ran out. The two answer different questions; they were one field.
    expect(result.failure!.deadlineExceeded).toBe(true);
    expect(result.failure!.code).toBe("RunnerContainerNeverStarted");
    // THE DIAGNOSIS THAT USED TO BE DELETED WITH THE JOB.
    expect(result.failure!.detail).toContain("must specify limits.memory for: runner");
    expect(result.failure!.detail).toContain("FailedCreate");
    expect(result.failure!.detail).toContain("NOTHING RAN");
    // And teardown still ran — the Job has to go whatever the verdict was.
    expect(c.jobs.size).toBe(0);
  });

  it("M23.5 ROUTE 2 — an unschedulable pod: the scheduler's message, not a budget verdict", async () => {
    const c = cluster();
    // A POD THAT EXISTS AND HAS NO `containerStatuses` AT ALL. This is also the shape of an unbound
    // RWX claim — the failure `assertRunnerPrerequisites` exists to pre-empt at render time, arriving
    // at run time because a claim that is NAMED can still be unbindable.
    c.setPod({
      metadata: { name: "p1" },
      status: {
        phase: "Pending",
        conditions: [
          {
            type: "PodScheduled",
            status: "False",
            reason: "Unschedulable",
            message: "0/3 nodes are available: 3 Insufficient memory."
          }
        ]
      }
    });
    const result = await c.launcher().run(spec({ timeoutMs: 1_000, copyOut: undefined }));
    expect(result.failure!.kind).toBe("spawn-failed");
    expect(result.failure!.detail).toContain("Unschedulable");
    expect(result.failure!.detail).toContain("Insufficient memory");
  });

  it("M23.5 ROUTE 3 — the pod is deleted mid-run: `signalled`, and it says it was not our budget", async () => {
    const c = cluster();
    // THE ONE ROUTE WHERE SOMETHING DID RUN, and it is the reason `everStarted` is threaded through
    // rather than re-derived. A node drain removes the pod; the Job (backoffLimit 0) then fails. If
    // this were reported as `spawn-failed` it would claim nothing was mutated, which is the OPPOSITE
    // lie to the one being fixed — a `tofu apply` really was interrupted.
    let polls = 0;
    c.setPod({
      metadata: { name: "p1" },
      status: {
        phase: "Running",
        containerStatuses: [
          { name: "runner", state: { running: { startedAt: "2026-08-20T00:00:00Z" } } }
        ]
      }
    });
    c.setJobStatus({
      conditions: [
        {
          type: "Failed",
          status: "True",
          reason: "BackoffLimitExceeded",
          message: "Job has reached the specified backoff limit"
        }
      ]
    });
    // The pod vanishes after the first poll — which is what a drain looks like from here.
    c.overrides.push({
      match: (req) => {
        if (!(req.method === "GET" && req.path.startsWith(`/api/v1/namespaces/${NAMESPACE}/pods?`)))
          return false;
        polls += 1;
        return polls > 1;
      },
      res: { status: 200, body: JSON.stringify({ items: [] }) }
    });

    const result = await c.launcher().run(spec({ timeoutMs: 10_000, copyOut: undefined }));
    expect(result.failure!.kind).toBe("signalled");
    expect(result.failure!.deadlineExceeded).toBe(false);
    expect(result.failure!.detail).toContain("BackoffLimitExceeded");
    expect(result.failure!.detail).toContain("NOT this run's own budget");
  });

  // ================================================================================================
  // M23.5 D2 + D3 — THE VERDICT IS A FUNCTION OF OBSERVED FACTS, NOT OF WHERE THE CLOCK WAS NOTICED
  // ================================================================================================
  //
  // TWO DEFECTS, ONE PROPERTY. `budget-exhausted` beat `spawn-failed` 6 runs in 20 (D2) and
  // `exit-nonzero` beat `signalled` 6 runs in 10 against a real cluster (D3), and both are the same
  // thing: a verdict decided by WHICH LINE of the control flow happened to observe the state, rather
  // than by what the state WAS.

  /** MODELS `AbortSignal.timeout(req.timeoutMs)` FIRING — the way a real transport discovers the
   *  deadline. The request is ISSUED with what little was left of the budget (the deadline had not
   *  passed when `spend` checked), the clock crosses while it is in flight, and it rejects. This is
   *  the shape a guard placed before the call cannot cover, because the guard and the call are not
   *  atomic — which is why moving the guard to the top of the loop fixed nothing. */
  function abortingPodGetIo(inner: KubernetesRunnerIo, thresholdMs = 100): KubernetesRunnerIo {
    return {
      ...inner,
      request: async (req: KubernetesApiRequest) => {
        if (
          req.method === "GET" &&
          req.path.startsWith(`/api/v1/namespaces/${NAMESPACE}/pods?`) &&
          req.timeoutMs < thresholdMs
        ) {
          await new Promise((r) => setTimeout(r, req.timeoutMs + 5));
          throw new Error("The operation was aborted due to timeout");
        }
        return inner.request(req);
      }
    };
  }

  it("M23.5 D2 — THE DEADLINE DISCOVERED BY THE TRANSPORT, NOT BY A GUARD, IS STILL `spawn-failed`", async () => {
    // THE ARM THE PREVIOUS ROUND'S FIX COULD NOT PASS. A check at the top of the poll loop reads the
    // clock and then issues `GET pods`; the clock can cross in between, and then the REQUEST reports
    // the deadline instead. The same is true of `GET events`, `GET job` and `GET log` — four places
    // to discover it, every one of which used to yield "a `tofu apply` was SIGTERMed mid-flight, so
    // the real infrastructure state is unknown" for a run in which NOTHING EVER STARTED.
    const c = cluster();
    c.setPod(undefined);
    const result = await c
      .launcher({ io: abortingPodGetIo(c.io) })
      .run(spec({ timeoutMs: 1_000, copyOut: undefined }));
    expect(result.succeeded).toBe(false);
    expect(
      result.failure!.kind,
      `discovering the deadline at the transport produced ${result.failure!.kind}: ${result.failure!.detail}`
    ).toBe("spawn-failed");
    expect(result.failure!.code).toBe("RunnerContainerNeverStarted");
    // TRUE, AND THE KIND IS STILL `spawn-failed` — pass 20. The deadline really is what ended this
    // run; what it did NOT do is start a container, and that is the `code`'s job to say.
    expect(result.failure!.deadlineExceeded).toBe(true);
    expect(result.failure!.detail).toContain("NOTHING RAN");
  });

  it("M23.5 D2 — THE NEGATIVE CONTROL: the SAME transport abort with a pod that RAN is `budget-exhausted`", async () => {
    // WITHOUT THIS ARM, "convert every deadline into spawn-failed" passes the one above — and every
    // genuinely interrupted `tofu apply` would then be recorded as having changed nothing, which is
    // the more dangerous of the two lies. `everStarted` is the fact that separates them, and it is
    // observed, not inferred from where the failure surfaced.
    const c = cluster();
    c.setPod({
      metadata: { name: "p1" },
      status: {
        phase: "Running",
        containerStatuses: [
          { name: "runner", state: { running: { startedAt: "2026-08-20T00:00:00Z" } } }
        ]
      }
    });
    const result = await c
      .launcher({ io: abortingPodGetIo(c.io) })
      .run(spec({ timeoutMs: 1_000, copyOut: undefined }));
    expect(result.failure!.kind).toBe("budget-exhausted");
    expect(result.failure!.deadlineExceeded).toBe(true);
  });

  it("M23.5 D2 — THE LOG READ IS THE FOURTH DISCOVERY POINT, and it may not overwrite a decided verdict", async () => {
    // THE ONE PLACE THE DEADLINE CAN FIRE WITH THE ANSWER ALREADY KNOWN. `termination` says the
    // runner exited 3; the log is DIAGNOSIS, read afterwards. Letting a refused log read throw
    // replaces "the runner exited 3" with "a `tofu apply` was SIGTERMed mid-flight, so the real
    // infrastructure state is unknown" — discarding a known outcome for the worst sentence this
    // package produces, at the last possible moment.
    const c = cluster();
    c.setPod({
      metadata: { name: "p1" },
      status: {
        phase: "Failed",
        containerStatuses: [
          { name: "runner", state: { terminated: { exitCode: 3, reason: "Error" } } }
        ]
      }
    });
    const io: KubernetesRunnerIo = {
      ...c.io,
      request: async (req: KubernetesApiRequest) => {
        if (req.method === "GET" && req.path.includes("/log")) {
          // The log request is ISSUED inside the budget and the clock crosses while it is in flight.
          await new Promise((r) => setTimeout(r, req.timeoutMs + 5));
          throw new Error("The operation was aborted due to timeout");
        }
        return c.io.request(req);
      }
    };
    const result = await c.launcher({ io }).run(spec({ timeoutMs: 300, copyOut: undefined }));
    expect(
      result.failure!.kind,
      `the decided verdict was overwritten by the log read: ${result.failure!.detail}`
    ).toBe("exit-nonzero");
    expect(result.failure!.code).toBe(3);
    expect(result.failure!.deadlineExceeded).toBe(false);
  });

  it("M23.5 D3 — A POD THE PLATFORM DELETED IS `signalled`, never the tenant's own exit 137", async () => {
    // MEASURED against a real cluster after `kubectl delete pod`: the container is SIGKILLed when
    // the termination grace expires and the kubelet writes `terminated{exitCode:137,reason:"Error"}`
    // with NO `signal` field — indistinguishable, downstream of here, from a runner that really
    // exited 137. Reporting that as `exit-nonzero` blames the TENANT for a platform kill.
    const c = cluster();
    c.setPod({
      metadata: { name: "p1", deletionTimestamp: "2026-08-20T00:00:00Z" },
      status: {
        phase: "Running",
        containerStatuses: [
          { name: "runner", state: { terminated: { exitCode: 137, reason: "Error" } } }
        ]
      }
    });
    const result = await c.launcher().run(spec({ timeoutMs: 10_000, copyOut: undefined }));
    expect(
      result.failure!.kind,
      `the deleted pod was classified ${result.failure!.kind}: ${result.failure!.detail}`
    ).toBe("signalled");
    expect(result.failure!.deadlineExceeded).toBe(false);
    expect(result.failure!.detail).toContain("DELETED");
    expect(result.failure!.detail).toContain("NOT this run's own budget");
  });

  it("M23.5 D3 — THE VERDICT LANDS WHEN THE DELETION IS REQUESTED, 31s before any exit code exists", async () => {
    // `deletionTimestamp` is set at t+0; the SIGKILL that produces an exit code lands at t+31s and
    // the pod object is collected at t+32s. Waiting for either is 31 seconds of polling in which any
    // of four reads can discover the deadline — the D2 defect, reached through the D3 one. A pod
    // that is STILL RUNNING but marked for deletion is already a decided run.
    const c = cluster();
    c.setPod({
      metadata: { name: "p1", deletionTimestamp: "2026-08-20T00:00:00Z" },
      status: {
        phase: "Running",
        containerStatuses: [
          { name: "runner", state: { running: { startedAt: "2026-08-20T00:00:00Z" } } }
        ]
      }
    });
    const started = Date.now();
    const result = await c.launcher().run(spec({ timeoutMs: 60_000, copyOut: undefined }));
    expect(result.failure!.kind).toBe("signalled");
    // TERMINAL. A 60s budget with an immediate `sleep` stub would spin here for the full minute if
    // the deletion were not itself the verdict.
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("M23.5 D3 — A POD DELETED BEFORE ANYTHING STARTED IS `spawn-failed`, not `signalled`", async () => {
    // THE OPPOSITE LIE, GUARDED. `signalled` on a run where nothing ran would claim a `tofu apply`
    // was interrupted; `everStarted` is what separates them here exactly as it does on the deadline
    // path, and it is the same remembered fact rather than a second reading.
    const c = cluster();
    c.setPod({
      metadata: { name: "p1", deletionTimestamp: "2026-08-20T00:00:00Z" },
      status: { phase: "Pending" }
    });
    const result = await c.launcher().run(spec({ timeoutMs: 10_000, copyOut: undefined }));
    expect(result.failure!.kind).toBe("spawn-failed");
    expect(result.failure!.code).toBe("PodDeleted");
    expect(result.failure!.detail).toContain("NOTHING RAN");
  });

  it("M23.5 D3 — A POD DELETED AFTER ITS RUNNER EXITED 0 IS STILL A SUCCESS", async () => {
    // Deletion of a pod whose runner FINISHED is ordinary garbage collection. Calling it a kill
    // would be the same class of lie in the other direction, and it is the one an unconditional
    // "deletionTimestamp means signalled" would tell on every fast, successful run that got tidied.
    const c = cluster();
    c.setPod({
      metadata: { name: "p1", deletionTimestamp: "2026-08-20T00:00:00Z" },
      status: {
        phase: "Succeeded",
        containerStatuses: [{ name: "runner", state: { terminated: { exitCode: 0 } } }]
      }
    });
    c.setLog("all done");
    const result = await c.launcher().run(spec({ timeoutMs: 10_000, copyOut: undefined }));
    expect(result.succeeded).toBe(true);
    expect(result.stdout).toContain("all done");
  });

  it("M23.5 D3 — THE JOB'S `FailureTarget` IS A VERDICT, 32 SECONDS BEFORE `Failed` IS", async () => {
    // Measured on the drained pod: FailureTarget=True(BackoffLimitExceeded) at t+2s, Failed=True at
    // t+34s. Reading only `Failed` leaves half a minute with the pod gone and no verdict — which is
    // half a minute of chances for the deadline to answer instead.
    const c = cluster();
    c.setPod(undefined);
    c.setJobStatus({
      conditions: [
        {
          type: "FailureTarget",
          status: "True",
          reason: "BackoffLimitExceeded",
          message: "Job has reached the specified backoff limit"
        }
      ]
    });
    const started = Date.now();
    const result = await c.launcher().run(spec({ timeoutMs: 60_000, copyOut: undefined }));
    expect(result.failure!.kind).toBe("spawn-failed");
    expect(result.failure!.code).toBe("JobBackoffLimitExceeded");
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("M23.5 — A JOB FAILURE WITH NOTHING EVER STARTED IS STILL `spawn-failed`, and it is TERMINAL: the budget is not burned", async () => {
    // The half route 3 cannot show: the SAME Job condition with `everStarted` false must not be
    // called `signalled`, and — the property that costs real minutes — the run must END there rather
    // than poll on to a deadline it can no longer reach usefully.
    const c = cluster();
    c.setPod(undefined);
    c.setJobStatus({
      conditions: [
        {
          type: "Failed",
          status: "True",
          reason: "BackoffLimitExceeded",
          message: "Job has reached the specified backoff limit"
        }
      ]
    });
    const started = Date.now();
    const result = await c.launcher().run(spec({ timeoutMs: 60_000, copyOut: undefined }));
    expect(result.failure!.kind).toBe("spawn-failed");
    expect(result.failure!.code).toBe("JobBackoffLimitExceeded");
    // TERMINAL. A 60s budget with a poll interval of 1ms would take 60 real seconds to exhaust; this
    // has to come back at once. (`sleep` is stubbed, but `Date.now()` is not, and the loop's exit is
    // the deadline — so a non-terminal reading of the condition would spin here for the full minute.)
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("M23.5 — A RUN THAT ACTUALLY STARTED AND WEDGED IS STILL `budget-exhausted`: the negative control", async () => {
    // WITHOUT THIS ARM, "always say spawn-failed" passes every case above — and every genuinely
    // interrupted `tofu apply` would then be reported as having changed nothing, which is the more
    // dangerous of the two lies. A pod whose container is RUNNING and never terminates is the one
    // shape that must still exhaust the budget.
    const c = cluster();
    c.setPod({
      metadata: { name: "p1" },
      status: {
        phase: "Running",
        containerStatuses: [
          { name: "runner", state: { running: { startedAt: "2026-08-20T00:00:00Z" } } }
        ]
      }
    });
    const result = await c.launcher().run(spec({ timeoutMs: 1_000, copyOut: undefined }));
    expect(result.failure!.kind).toBe("budget-exhausted");
    expect(result.failure!.deadlineExceeded).toBe(true);
  });

  it("M23.5 — A 403 ON THE EVENT READ DEGRADES, never replaces the diagnosis", async () => {
    // A deployment whose runner Role predates M23.5 has no `events` grant. Diagnosis must not become
    // the failure: the run reports what it would have reported anyway, with a less specific reason,
    // rather than an authorisation error standing in for the real cause.
    const c = cluster();
    c.setPod(undefined);
    c.overrides.push({
      match: (req) => req.path.startsWith(`/api/v1/namespaces/${NAMESPACE}/events`),
      res: { status: 403, body: JSON.stringify({ reason: "Forbidden" }) }
    });
    const result = await c.launcher().run(spec({ timeoutMs: 1_000, copyOut: undefined }));
    expect(result.failure!.kind).toBe("spawn-failed");
    expect(result.failure!.detail).toContain("no pod has been created for it");
  });

  it("M23.5 — the three readers, as pure functions", () => {
    expect(kubernetesContainerStarted(undefined)).toBe(false);
    expect(kubernetesContainerStarted({ status: { phase: "Pending" } })).toBe(false);
    // A pod blocked on an image pull or an admission refusal is Pending, never Running — so the
    // phase alone is a sound "it started", and it is the reading that must not be wrong downward.
    expect(kubernetesContainerStarted({ status: { phase: "Running" } })).toBe(true);
    expect(
      kubernetesContainerStarted({
        status: {
          phase: "Pending",
          containerStatuses: [{ name: "runner", state: { running: {} } }]
        }
      })
    ).toBe(true);
    // A SIDECAR IS NOT THE RUNNER. Same rule `kubernetesTermination` already applies.
    expect(
      kubernetesContainerStarted({
        status: {
          phase: "Pending",
          containerStatuses: [{ name: "istio-proxy", state: { running: {} } }]
        }
      })
    ).toBe(false);

    expect(kubernetesJobTermination({}, false, "why")).toBeUndefined();
    // A `Failed` condition with `status: "False"` is a Job that is NOT failed. Reading only `type`
    // would call every healthy Job a failure.
    expect(
      kubernetesJobTermination(
        { status: { conditions: [{ type: "Failed", status: "False" }] } },
        false,
        "why"
      )
    ).toBeUndefined();
    expect(
      kubernetesJobTermination(
        { status: { conditions: [{ type: "Complete", status: "True" }] } },
        false,
        "why"
      )
    ).toBeUndefined();

    expect(kubernetesWaitingEvidence(undefined, [])).toContain("no pod has been created");
    expect(
      kubernetesWaitingEvidence(undefined, [
        { type: "Normal", reason: "SuccessfulCreate", message: "created pod" },
        { type: "Warning", reason: "FailedCreate", message: "exceeded quota", count: 3 }
      ])
      // A `Normal` event is not a reason anything is stuck; the Warning is.
    ).toContain("FailedCreate: exceeded quota (x3)");
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
// M23.5 VERIFICATION PASS 18 — WHAT A LAUNCHER THAT COULD NOT SEE IS ALLOWED TO SAY
// ==================================================================================================
//
// `!everStarted` MEANT TWO THINGS AT ONE SITE. "Observed, and nothing had started" — the fact D2's
// fix rests on — and "never observed at all", which is not a fact about the run at all. The second
// was unguarded, and MEASURED against a real cluster it is the one that happens: the unsuspend PATCH
// reaches the API server and succeeds, every `GET pods` after it stalls past the budget, the real
// Job and the real kubelet do the work, a real container writes a real file to the real volume — and
// the durable record says `spawn-failed: … so NOTHING RAN and nothing was mutated — the Job had not
// yet been observed`. THE EVIDENCE THAT THE CLAIM IS UNFOUNDED IS IN THE SAME SENTENCE AS THE CLAIM.
//
// TWO MUTATIONS SURVIVED THE WHOLE SUITE BEFORE THESE CASES EXISTED, and each has its arm below:
//   S1  `let waiting = "the Job had not yet been observed"` -> "the pod was observed and no
//       container had started": a lie about what was observed, in the operator-facing detail.
//       377/377 green. Nothing pinned the never-observed case at all.
//   S2  `api()`'s `const deadlineExceeded = runDeadline.spent()` -> `= true`: 377/377 unit AND
//       18/18 kind green. Nothing pinned that a transport failure with budget LEFT is not a budget
//       exhaustion, in either adapter's spelling.

/**
 * A TRANSPORT THAT ANSWERS NOTHING — `AbortSignal.timeout` firing on every `GET pods`, which is what
 * an API-server stall or a partition looks like from inside this adapter. Unconditional, unlike D2's
 * `abortingPodGetIo`, which only fires near the deadline and therefore always leaves the run an
 * observation to reason from: the WHOLE point here is a run that never gets one.
 *
 * `letThrough` reads succeed first, so the same fixture produces the negative control — one landed
 * observation, and the verdict is entitled to say nothing started again.
 */
function stallingPodGetIo(inner: KubernetesRunnerIo, letThrough = 0): KubernetesRunnerIo {
  let through = 0;
  return {
    ...inner,
    request: async (req: KubernetesApiRequest) => {
      if (req.method === "GET" && req.path.startsWith(`/api/v1/namespaces/${NAMESPACE}/pods?`)) {
        if (through >= letThrough) {
          await new Promise((r) => setTimeout(r, req.timeoutMs + 5));
          throw new Error("The operation was aborted due to timeout");
        }
        through += 1;
      }
      return inner.request(req);
    }
  };
}

/** A transport that BREAKS rather than runs out of time — a reset, a TLS failure, a DNS failure.
 *  It rejects IMMEDIATELY, so the run still has almost all of its budget, which is the fact S2's
 *  mutation erases. */
function resettingPodGetIo(inner: KubernetesRunnerIo, letThrough = 0): KubernetesRunnerIo {
  let through = 0;
  return {
    ...inner,
    request: async (req: KubernetesApiRequest) => {
      if (req.method === "GET" && req.path.startsWith(`/api/v1/namespaces/${NAMESPACE}/pods?`)) {
        if (through >= letThrough) throw new Error("read ECONNRESET");
        through += 1;
      }
      return inner.request(req);
    }
  };
}

describe("M23.5 pass 18: the verdict may not assert what this run did not observe", () => {
  it("NEVER OBSERVED AFTER AN ACCEPTED UNSUSPEND IS `outcome-unknown` — not `spawn-failed`", async () => {
    // THE DEFECT, at the seam. The PATCH succeeds; nothing after it ever lands. The Job is live in
    // the cluster from that instant and the kubelet does not need this process to be watching.
    const c = cluster();
    const result = await c
      .launcher({ io: stallingPodGetIo(c.io) })
      .run(spec({ timeoutMs: 1_000, copyOut: undefined }));

    expect(result.succeeded).toBe(false);
    expect(
      result.failure!.kind,
      `a run this launcher never observed was classified ${result.failure!.kind}: ${result.failure!.detail}`
    ).toBe("outcome-unknown");
    expect(result.failure!.code).toBe(RUNNER_OUTCOME_UNKNOWN_CODE);
    // THE TWO SENTENCES IT MAY NOT SAY, both of which were reachable here, in opposite directions.
    expect(result.failure!.detail).not.toContain("NOTHING RAN");
    expect(result.failure!.detail).not.toContain("nothing was mutated");
    expect(result.failure!.detail).not.toContain("stopped mid-flight");
    // AND THE ONE IT MUST. `NOT KNOWN` is the claim; the rest is what an operator has to do about it.
    expect(result.failure!.detail).toContain("NOTHING WAS EVER OBSERVED");
    expect(result.failure!.detail).toContain("is NOT KNOWN");
    expect(result.failure!.detail).toContain("Check the target's real state before re-running");
    // S1's MUTATION DIES HERE. The initial value of `waiting` is the only thing in this record that
    // says WHAT was observed, and it is now load-bearing rather than a placeholder: replacing it
    // with "the pod was observed and no container had started" makes this record claim an
    // observation the run never made.
    expect(result.failure!.detail).toContain("the Job had not yet been observed");
    expect(result.failure!.detail).not.toContain("was observed and no container had started");
    // The teardown is unconditional whatever the verdict was.
    expect(c.jobs.size).toBe(0);
  });

  it("THE NEGATIVE CONTROL: a landed observation, still current, is enough to say nothing started", async () => {
    // WITHOUT THIS ARM, "call every deadline `outcome-unknown`" passes the case above — and ROUTE 1
    // and ROUTE 2, where the cluster SAID why it could not start the pod, would stop telling an
    // operator that nothing was touched. The distinguishing fact is a read that COMPLETED, AND that
    // is no older than one poll interval when the budget runs out (pass 19: the second half was
    // missing, and the title of this case used to claim ONE landed read was enough on its own).
    const c = cluster();
    c.setPod(undefined);
    c.setEvents([
      {
        type: "Warning",
        reason: "FailedCreate",
        count: 4,
        message: 'Error creating: pods "x" is forbidden: failed quota: must specify limits.memory'
      }
    ]);
    // EVERY READ LANDS, RIGHT UP TO THE DEADLINE — which is what ROUTE 1 and ROUTE 2 actually do
    // against the real cluster, and what this control is for. It used to stall after the first read
    // and pass anyway, which is how the missing half stayed invisible.
    const result = await c.launcher().run(spec({ timeoutMs: 1_000, copyOut: undefined }));

    expect(result.failure!.kind).toBe("spawn-failed");
    expect(result.failure!.code).toBe("RunnerContainerNeverStarted");
    expect(result.failure!.detail).toContain("NOTHING RAN");
    expect(result.failure!.detail).toContain("must specify limits.memory");
  });

  it("PASS 19: A LANDED READ THAT WENT STALE CANNOT SAY THE RUN NEVER STARTED", async () => {
    /**
     * THE DEFECT PASS 18 LEFT STANDING, at the seam. Its fix moved the boundary to WHETHER a read
     * landed — not to WHEN. Let exactly ONE `GET pods` through, the one issued immediately after
     * the unsuspend and before any pod exists, then stall every read after it: `observed` is true,
     * arm 6 is skipped, and arm 7 said "NOTHING RAN and nothing was mutated" about the 990ms of the
     * budget that nothing in this process could see.
     *
     * `kubernetes-adapter.kind.test.ts` runs the same shape against a REAL cluster, where the pod,
     * the container and the file it writes are real. This arm is the cheap gate for the same
     * property; that one is the proof that the property matters.
     */
    const c = cluster();
    c.setPod(undefined);
    // ONE READ LANDS, AND THEN THE REST OF THE BUDGET PASSES UNSEEN. `pollIntervalMs` is what says
    // how long a landed read speaks for, so it is stated here rather than inherited: 100ms is a
    // legitimate setting, and it makes the ~900ms blind window nine intervals wide.
    const result = await c
      .launcher({ io: stallingPodGetIo(c.io, 1), pollIntervalMs: 100 })
      .run(spec({ timeoutMs: 1_000, copyOut: undefined }));

    expect(
      result.failure!.kind,
      `a run this launcher stopped watching was classified ${result.failure!.kind}: ${result.failure!.detail}`
    ).toBe("outcome-unknown");
    expect(result.failure!.code).toBe(RUNNER_OUTCOME_UNKNOWN_CODE);
    expect(result.failure!.detail).not.toContain("NOTHING RAN");
    expect(result.failure!.detail).not.toContain("nothing was mutated");
    expect(result.failure!.detail).toContain("is NOT KNOWN");
    // AND IT NAMES THE WINDOW, because "we could not see" without "for how long" is not evidence.
    expect(result.failure!.detail).toMatch(/saw NOTHING FOR THE LAST \d+ms/);
  });

  /**
   * A TRANSPORT THAT CONSUMES ALL BUT `shortfallMs` OF THE BOUND IT WAS HANDED, AND THEN REJECTS —
   * M23.5 verification pass 20, and the ONE fixture in this file that does not let real time decide
   * how much of the bound was used.
   *
   * WHY IT HAS TO MOVE THE CLOCK ITSELF. Every other fixture here waits `req.timeoutMs + 5` on a
   * real `setTimeout`, so it always OVERSHOOTS the bound — and `Date.now() - issuedAt >= boundGiven`
   * is true for an overshoot with or without the slack `api()` subtracts. That is exactly why
   * removing the slack survived 392 unit and 20 kind cases. The case that separates them is an
   * UNDERSHOOT of less than a millisecond, which is what a real `AbortSignal.timeout` produces: it
   * fires on a libuv timer and `issuedAt`/`Date.now()` come from the wall clock, the sub-millisecond
   * disagreement D4 already measured turning a budget kill into a verdict about the tenant's runner.
   * A real `setTimeout` cannot be asked to fire early, so the clock is faked and stepped by an exact
   * amount instead — `toFake: ["Date"]` only, so every `setTimeout` in the adapter (the poll sleep,
   * `withStepBound`'s abandon timer) is still a real one.
   */
  function boundConsumingPodGetIo(
    inner: KubernetesRunnerIo,
    opts: { letThrough: number; shortfallMs: number }
  ): KubernetesRunnerIo {
    let through = 0;
    return {
      ...inner,
      request: async (req: KubernetesApiRequest) => {
        if (req.method === "GET" && req.path.startsWith(`/api/v1/namespaces/${NAMESPACE}/pods?`)) {
          if (through >= opts.letThrough) {
            // THE WHOLE POINT, IN ONE LINE: the clock lands STRICTLY SHORT of the bound.
            vi.setSystemTime(Date.now() + req.timeoutMs - opts.shortfallMs);
            const err = new Error("The operation was aborted due to timeout");
            err.name = "TimeoutError";
            throw err;
          }
          through += 1;
        }
        return inner.request(req);
      }
    };
  }

  /** Both arms below run under a frozen clock that only `boundConsumingPodGetIo` moves. */
  async function withFrozenClock<T>(body: () => Promise<T>): Promise<T> {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      return await body();
    } finally {
      vi.useRealTimers();
    }
  }

  it("PASS 20: A REQUEST THAT MISSED ITS BOUND BY LESS THAN A MILLISECOND STILL RAN OUT OF BUDGET", async () => {
    /**
     * THE MUTATION THAT SURVIVED EVERYTHING. `api()` asks whether the request consumed the bound it
     * was handed:
     *
     *     Date.now() - issuedAt >= boundGiven - RUNNER_MIN_STEP_BUDGET_MS
     *
     * and dropping the `- RUNNER_MIN_STEP_BUDGET_MS` passed 392/392 unit and 20/20 kind, because
     * every fixture in both suites overshoots its bound on a real timer. A real transport does not:
     * an `AbortSignal.timeout` fires on a libuv timer while `issuedAt` and `Date.now()` are wall
     * clock, so the measured elapsed can land a hair SHORT of the bound that ended the request.
     *
     * WITHOUT THE SLACK THAT MISS BECOMES `deadlineExceeded: false`, the verdict falls out of arm 7
     * into arm 8, and the record turns from "the runner container never started within the whole-run
     * budget … NOTHING RAN" into `outcome-unknown` — "check the target's real state before
     * re-running". A FALSE UNKNOWN sends an operator to inspect infrastructure after a transient,
     * which is the same family of defect as a verdict that depended on WHERE the deadline was
     * discovered, one order of magnitude smaller.
     *
     * ONE MILLISECOND SHORT, DELIBERATELY: inside `RUNNER_MIN_STEP_BUDGET_MS`, so the slack is what
     * decides the answer and nothing else is.
     */
    const shortfallMs = 1;
    expect(
      shortfallMs > 0 && shortfallMs < RUNNER_MIN_STEP_BUDGET_MS,
      "this case is only about the slack while the shortfall lies strictly inside it"
    ).toBe(true);

    const result = await withFrozenClock(async () => {
      const c = cluster();
      c.setPod(undefined);
      // ONE READ LANDS, SO THE VERDICT IS ARM 7's TO MAKE (`observed`), and `pollIntervalMs` is
      // large enough that the run is still WATCHING when the budget goes — otherwise arm 7b answers
      // and this case would be measuring the staleness window instead of the slack.
      return c
        .launcher({
          io: boundConsumingPodGetIo(c.io, { letThrough: 1, shortfallMs }),
          pollIntervalMs: 500
        })
        .run(spec({ timeoutMs: 200, copyOut: undefined }));
    });

    expect(
      result.failure!.kind,
      `a request that missed its bound by ${shortfallMs}ms was classified ${result.failure!.kind}: ${result.failure!.detail}`
    ).toBe("spawn-failed");
    expect(result.failure!.code).toBe("RunnerContainerNeverStarted");
    expect(result.failure!.deadlineExceeded).toBe(true);
    expect(result.failure!.detail).toContain("NOTHING RAN");
    // AND IT IS NOT THE SENTENCE THE MUTATION PRODUCES.
    expect(result.failure!.detail).not.toContain("is NOT KNOWN");
  });

  it("PASS 20: THE NEGATIVE CONTROL — a request that broke well inside its bound did NOT run out", async () => {
    // WITHOUT THIS ARM, `deadlineExceeded = true` passes the case above — and S2's whole finding
    // (a reset with budget left is not a budget exhaustion) would stop being pinned at the one site
    // that can now tell the two apart by a measured margin rather than by which fixture was used.
    // 60ms of a 200ms bound is six times `RUNNER_MIN_STEP_BUDGET_MS`, so 60ms of budget really is
    // left: this transport broke, it did not run out of time.
    const result = await withFrozenClock(async () => {
      const c = cluster();
      c.setPod(undefined);
      return c
        .launcher({
          io: boundConsumingPodGetIo(c.io, { letThrough: 1, shortfallMs: 60 }),
          pollIntervalMs: 500
        })
        .run(spec({ timeoutMs: 200, copyOut: undefined }));
    });

    expect(result.failure!.kind).toBe("outcome-unknown");
    expect(result.failure!.deadlineExceeded).toBe(false);
    expect(result.failure!.detail).toContain("still able to start one");
  });

  it("S2 — A TRANSPORT FAILURE WITH BUDGET LEFT IS NOT A BUDGET EXHAUSTION", async () => {
    // THE GATE THE BRANCH DID NOT HAVE. `api()`'s `deadlineExceeded` was asked of the clock and
    // nothing anywhere required the answer to be FALSE, so `= true` survived 377 unit and 18 kind
    // cases. A reset on the first poll leaves 10 seconds of budget: this run did not run out of
    // time, its transport broke.
    const c = cluster();
    const result = await c
      .launcher({ io: resettingPodGetIo(c.io) })
      .run(spec({ timeoutMs: 10_000, copyOut: undefined }));

    expect(
      result.failure!.deadlineExceeded,
      `a reset with 10s of budget left was recorded as a budget exhaustion: ${result.failure!.detail}`
    ).toBe(false);
    expect(result.failure!.kind).toBe("outcome-unknown");
    // AND THE TRANSPORT'S OWN WORDS REACH THE OPERATOR. The classification is this adapter's to
    // make; the evidence is not its to delete.
    expect(result.failure!.detail).toContain("read ECONNRESET");
  });

  it("S2 — AND THE SAME RESET AFTER AN OBSERVATION MUST NOT BECOME `NOTHING RAN`", async () => {
    // THE ARM WHERE S2'S MUTATION CHANGES THE SENTENCE AND NOT ONLY THE FLAG. One `GET pods` lands
    // (the pod is Pending, nothing started), the next resets, and 10 seconds of budget remain — so
    // the Job is still perfectly able to start a pod after this run stops looking. With
    // `deadlineExceeded` forced true this becomes `spawn-failed`: "NOTHING RAN and nothing was
    // mutated", asserted about a Job that is still live.
    const c = cluster();
    c.setPod({ metadata: { name: "p1" }, status: { phase: "Pending" } });
    const result = await c
      .launcher({ io: resettingPodGetIo(c.io, 1) })
      .run(spec({ timeoutMs: 10_000, copyOut: undefined }));

    expect(result.failure!.kind).toBe("outcome-unknown");
    expect(result.failure!.deadlineExceeded).toBe(false);
    expect(result.failure!.detail).not.toContain("NOTHING RAN");
    expect(result.failure!.detail).toContain("still able to start one");
  });

  it("A RUNNING CONTAINER PLUS A BROKEN READ IS `outcome-unknown`, never a verdict about the runner", async () => {
    // THE MOST DANGEROUS DIRECTION. A container IS running; this launcher's own read then breaks
    // with budget left. Before this, the reset reached `classifyRunnerFailure` with no `code` at all
    // and was recorded as `exit-nonzero` — "the runner itself exited non-zero" — about a runner that
    // was still running, and the teardown below then DELETEd the Job under it.
    const c = cluster();
    c.setPod({
      metadata: { name: "p1" },
      status: {
        phase: "Running",
        containerStatuses: [
          { name: "runner", state: { running: { startedAt: "2026-08-20T00:00:00Z" } } }
        ]
      }
    });
    const result = await c
      .launcher({ io: resettingPodGetIo(c.io, 1) })
      .run(spec({ timeoutMs: 10_000, copyOut: undefined }));

    expect(result.failure!.kind).toBe("outcome-unknown");
    expect(result.failure!.detail).toContain("a runner container WAS running");
    expect(result.failure!.detail).not.toContain("the runner itself exited non-zero");
  });

  it("AND THE NEGATIVE CONTROL FOR THAT: a RUNNING container plus the BUDGET is still `budget-exhausted`", async () => {
    // The arm M23.5 measured, unchanged and it must stay unchanged: something ran, our budget ran
    // out, the teardown kills it. "SIGTERMed mid-flight, the real state is unknown" is TRUE here,
    // and downgrading it to `outcome-unknown` would lose the fact that a `tofu apply` was
    // interrupted.
    const c = cluster();
    c.setPod({
      metadata: { name: "p1" },
      status: {
        phase: "Running",
        containerStatuses: [
          { name: "runner", state: { running: { startedAt: "2026-08-20T00:00:00Z" } } }
        ]
      }
    });
    const result = await c.launcher().run(spec({ timeoutMs: 1_000, copyOut: undefined }));
    expect(result.failure!.kind).toBe("budget-exhausted");
    expect(result.failure!.deadlineExceeded).toBe(true);
  });

  it("A REFUSED UNSUSPEND IS `spawn-failed`, never `exit-nonzero` — the chart shipped without `patch`", async () => {
    // THE SAME CLASS FROM THE RBAC SIDE, and it was live for a release: the chart's Role granted
    // `create,get,list,watch,delete` on `batch/jobs` and NO `patch`, so `start` was a 403 on every
    // managed run. A numeric `code` is what `classifyRunnerFailure` reads as an exit status, so an
    // operator was told "the runner itself exited non-zero" — code 403 — about a Job that never left
    // `suspend: true`.
    const c = cluster();
    c.overrides.push({
      match: (r) => r.method === "PATCH",
      res: { status: 403, body: 'jobs.batch "scp-runner-r1" is forbidden: cannot patch' }
    });
    const result = await c.launcher().run(spec({ copyOut: undefined }));

    expect(result.failure!.kind).toBe("spawn-failed");
    expect(result.failure!.detail).toContain("REFUSED to unsuspend");
    expect(result.failure!.detail).toContain("NOTHING RAN");
    // The API server's own words survive the rewrite.
    expect(result.failure!.detail).toContain("cannot patch");
  });

  it("THE LOG READ MAY NOT OVERWRITE A DECIDED VERDICT — for ANY reason, not only the deadline", async () => {
    // THE THIRD INSTANCE THE CENSUS TURNED UP. M23.5 made a log read REFUSED BY THE DEADLINE
    // degrade, and left every other way it can fail — a Role without `pods/log`, a 500, a reset —
    // able to replace the verdict exactly as before. A 403 is a NUMERIC `code`, so the operator was
    // told "the runner itself exited non-zero" with 403 as the exit status, about a runner whose
    // real exit code (3) this process was holding at that moment.
    const c = cluster();
    c.setPod({
      metadata: { name: "p1" },
      status: {
        phase: "Failed",
        containerStatuses: [
          { name: "runner", state: { terminated: { exitCode: 3, reason: "Error" } } }
        ]
      }
    });
    c.overrides.push({
      match: (r) => r.method === "GET" && r.path.includes("/log"),
      res: { status: 403, body: 'pods "p1" is forbidden: cannot get resource "pods/log"' }
    });
    const result = await c.launcher().run(spec({ copyOut: undefined }));
    expect(
      result.failure!.kind,
      `the decided verdict was overwritten by the log read: ${result.failure!.detail}`
    ).toBe("exit-nonzero");
    expect(result.failure!.code).toBe(3);
    expect(result.failure!.detail).toContain("the runner exited 3");
  });

  it("AN UNSUSPEND THAT WAS NEVER ISSUED SAYS SO — and no PATCH is on the wire to contradict it", async () => {
    // THE KNOWABLE HALF OF "NOBODY ANSWERED". A copy-in on a slow network filesystem finishes
    // legitimately, inside its own bound, with nothing left for the step after it; `spend` then
    // refuses the unsuspend BEFORE issuing it, so the Job is exactly as `create` left it. Sweeping
    // this into `outcome-unknown` would tell an operator to go and inspect infrastructure that was
    // never touched — a weaker claim than the truth is still the wrong claim.
    const c = cluster();
    const io: KubernetesRunnerIo = {
      ...c.io,
      // `timeoutMs` IS what remains of the run budget, so leaving 6ms of it leaves less than
      // RUNNER_MIN_STEP_BUDGET_MS. A `setTimeout` never fires early, so the remainder can only be
      // smaller than that — the direction that keeps this deterministic.
      copyDir: async (op) => {
        await new Promise((r) => setTimeout(r, op.timeoutMs - 6));
        return c.io.copyDir(op);
      }
    };
    const result = await c.launcher({ io }).run(spec({ timeoutMs: 300, copyOut: undefined }));

    expect(result.failure!.kind).toBe("spawn-failed");
    expect(result.failure!.detail).toContain("NEVER ISSUED");
    expect(result.failure!.detail).toContain("NOTHING RAN");
    /**
     * AND THE BOOLEAN AGREES WITH THE SENTENCE — M23.5 verification pass 20, MEDIUM.
     *
     * This record used to read `deadlineExceeded: false` under a message that begins "the whole-run
     * budget of 300ms (RunnerSpec.timeoutMs) was already spent when this run reached 'start'". The
     * budget PROVABLY ended this run — that is the entire reason the unsuspend was never issued, and
     * the remedy an operator needs is to raise `timeoutMs` — and the one field a caller is told to
     * read as "which bound ended the run" denied it. Nothing pinned either half, so the flip is
     * pinned in BOTH directions here: the flag is true, and the kind stays `spawn-failed` rather
     * than becoming `budget-exhausted` ("SIGTERMed mid-flight") about a Job still sitting at
     * `suspend: true`.
     */
    expect(
      result.failure!.deadlineExceeded,
      `a run the budget stopped before 'start' was recorded as not a budget failure: ${result.failure!.detail}`
    ).toBe(true);
    expect(result.failure!.detail).toContain("was already spent");
    expect(result.failure!.detail).not.toContain("SIGTERMed mid-flight");
    // THE SENTENCE, CHECKED AGAINST THE RECORDED EFFECTS RATHER THAN AGAINST ITSELF. "Never issued"
    // is a claim about the wire; this is the wire.
    expect(requestsOf(c.ops).some((o) => o.method === "PATCH")).toBe(false);
  });

  it("`kubernetesStartVerdict` — every arm, as a pure function", () => {
    const base = {
      runnerVerdict: false,
      unsuspend: "accepted" as const,
      observed: true,
      everStarted: false,
      // STILL WATCHING WHEN THE BUDGET RAN OUT — the state ROUTE 1 and ROUTE 2 are actually in
      // against a real cluster, and the only one arm 7's claim is warranted from (pass 19).
      unwatchedMs: 0,
      pollIntervalMs: 2_000,
      deadlineExceeded: true,
      waiting: "the pod is Pending and PodScheduled is False: Unschedulable",
      runTimeoutMs: 5_000
    };

    // 1. THE CLUSTER ANSWERED. Nothing here is better informed.
    expect(kubernetesStartVerdict({ ...base, runnerVerdict: true })).toBeUndefined();
    expect(
      kubernetesStartVerdict({ ...base, runnerVerdict: true, observed: false, everStarted: true })
    ).toBeUndefined();

    // 5. A CONTAINER RAN AND OUR BUDGET ENDED IT — `budget-exhausted` stands.
    expect(kubernetesStartVerdict({ ...base, everStarted: true })).toBeUndefined();

    // 2. NEVER SENT. Knowledge, and it must not be swept into arm 4's "we do not know".
    const notIssued = kubernetesStartVerdict({ ...base, unsuspend: "not-issued" })!;
    expect(notIssued.code).toBe("RunnerContainerNeverStarted");
    expect(notIssued.message).toContain("NEVER ISSUED");
    expect(notIssued.message).toContain("NOTHING RAN");
    // AND IT OUTRANKS A STALE `everStarted` for the same reason `refused` does.
    expect(
      kubernetesStartVerdict({ ...base, unsuspend: "not-issued", everStarted: true })?.code
    ).toBe("RunnerContainerNeverStarted");

    // 3. THE API SERVER SAID NO. Knowledge, not inference.
    expect(kubernetesStartVerdict({ ...base, unsuspend: "refused" })?.code).toBe(
      "RunnerContainerNeverStarted"
    );
    // AND IT OUTRANKS EVERYTHING BELOW IT — a Job that never left `suspend: true` has no pod, so a
    // stale `everStarted` cannot make it a kill.
    expect(
      kubernetesStartVerdict({ ...base, unsuspend: "refused", everStarted: true })?.message
    ).toContain("NOTHING RAN");

    // 4. NOBODY ANSWERED AND NOTHING PROVES IT WAS NOT SENT — the patch may have applied.
    expect(kubernetesStartVerdict({ ...base, unsuspend: "unanswered" })?.code).toBe(
      RUNNER_OUTCOME_UNKNOWN_CODE
    );

    // 6. THE DEFECT: accepted, and nothing was ever observed.
    const blind = kubernetesStartVerdict({ ...base, observed: false, waiting: "W" })!;
    expect(blind.code).toBe(RUNNER_OUTCOME_UNKNOWN_CODE);
    expect(blind.message).toContain("NOTHING WAS EVER OBSERVED");
    // THE `waiting` CLAUSE IS CARRIED, which is what makes S1's mutation visible in the record.
    expect(blind.message).toContain("(W)");
    expect(blind.message).not.toContain("NOTHING RAN");

    // 7. OBSERVED, NOTHING STARTED, THE BUDGET ENDED US — D2's verdict, unchanged.
    const never = kubernetesStartVerdict(base)!;
    expect(never.code).toBe("RunnerContainerNeverStarted");
    expect(never.message).toContain("NOTHING RAN and nothing was mutated");
    expect(never.message).toContain("Unschedulable");
    expect(never.message).toContain("5000ms");

    // 8. OBSERVED, NOTHING STARTED, AND OUR OWN READ BROKE WITH BUDGET LEFT.
    const early = kubernetesStartVerdict({ ...base, deadlineExceeded: false })!;
    expect(early.code).toBe(RUNNER_OUTCOME_UNKNOWN_CODE);
    expect(early.message).not.toContain("NOTHING RAN");

    // 5b. A CONTAINER RAN AND SOMETHING ELSE ENDED US.
    const lostSight = kubernetesStartVerdict({
      ...base,
      everStarted: true,
      deadlineExceeded: false
    })!;
    expect(lostSight.code).toBe(RUNNER_OUTCOME_UNKNOWN_CODE);
    expect(lostSight.message).toContain("WAS running");
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

describe("M23.4: `secretEnv` is a GRANTED capability — the credential travels as a Secret the Job owns", () => {
  const withSecret = spec({
    secretEnv: ["AWS_SECRET_ACCESS_KEY=super-secret-value"],
    copyOut: undefined
  });

  // THE OPT-OUT ARM COMES FIRST BECAUSE IT IS THE ONE THAT INVERTED. Until M23.4 `perRunSecrets`
  // defaulted to false and this was the shipped behaviour of every Kubernetes deployment; the owner
  // granted the RBAC on 2026-08-20, so the chart now renders the rule by default and this is what an
  // operator who deliberately turns it back off gets. It has to stay a loud refusal either way — the
  // failure it replaces is a 403 from inside a promotion, minutes in.
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

  // ================================================================================================
  // M23.4 — THE CREDENTIAL'S LIFETIME IS THE JOB'S, ENFORCED BY THE CLUSTER AND NOT BY A `finally`
  // ================================================================================================
  //
  // WHY THIS BLOCK EXISTS AT ALL. M23.1a moved the credential out of the `docker create` argv; M23.1d
  // then found that the mode-0600 `--env-file` it moved into was left on disk whenever the plugin
  // host SIGKILLed the subprocess mid-`trigger()`, because no `finally` survives a SIGKILL. That
  // defect is now reachable on the OTHER adapter, in a worse place: a Kubernetes Secret does not sit
  // on one machine's disk, it sits in etcd and in every etcd backup, replicated across the control
  // plane. The answer is not a better `finally`. It is `ownerReferences` — the cluster deleting the
  // Secret because the Job it belongs to is gone, whether or not this process still exists.

  it("THE SECRET IS OWNED BY THE JOB — with the Job's REAL uid, not its name", async () => {
    const c = cluster({ perRunSecrets: true });
    await c.launcher().run(withSecret);
    const jobPost = requestsOf(c.ops).find(
      (o) => o.method === "POST" && o.path?.endsWith("/jobs")
    )!;
    const secretPost = requestsOf(c.ops).find(
      (o) => o.method === "POST" && o.path?.endsWith("/secrets")
    )!;
    // ORDER FIRST, because it is what makes ownership POSSIBLE: a Secret cannot reference a uid that
    // does not exist yet. M23.2 POSTed the Secret first and could not have owned it to anything.
    expect(c.ops.indexOf(jobPost)).toBeLessThan(c.ops.indexOf(secretPost));
    const owners = (
      secretPost.body as { metadata: { ownerReferences?: Record<string, unknown>[] } }
    ).metadata.ownerReferences;
    // THE UID COMES FROM THE CREATE RESPONSE, and this is the assertion that a `uid: jobName` or a
    // `uid: ""` regression fails: the fake stamps `uid-N` on create, so a uid derived from anything
    // the adapter already knew would not match. An ownerReference with a WRONG uid is worse than
    // none — the collector treats the owner as already deleted and removes the Secret out from under
    // a live run, which is a `CreateContainerConfigError` on a pod that has not started yet.
    expect(owners).toStrictEqual([
      {
        apiVersion: "batch/v1",
        kind: "Job",
        name: "scp-runner-r1",
        uid: "uid-1",
        controller: false,
        blockOwnerDeletion: false
      }
    ]);
  });

  it("SUCCESS PATH: the Secret is gone when run() resolves", async () => {
    const c = cluster({ perRunSecrets: true });
    const result = await c.launcher().run(withSecret);
    expect(result.succeeded).toBe(true);
    expect(c.secrets.size).toBe(0);
  });

  it("FAILURE PATH: a non-zero runner deletes the Secret exactly as a successful one does", async () => {
    // THE ARM THAT A `finally` PLACED INSIDE THE SUCCESS BRANCH WOULD FAIL. A managed-iac apply that
    // exits non-zero is the COMMON case (a `tofu apply` that a policy refused), so a credential
    // lifetime that only holds on success is a credential lifetime that mostly does not hold.
    const c = cluster({ perRunSecrets: true });
    c.setPod({
      metadata: { name: "p1" },
      status: {
        phase: "Failed",
        containerStatuses: [{ name: "runner", state: { terminated: { exitCode: 5 } } }]
      }
    });
    const result = await c.launcher().run(withSecret);
    expect(result.succeeded).toBe(false);
    expect(result.failure!.kind).toBe("exit-nonzero");
    expect(c.secrets.size).toBe(0);
    expect(
      requestsOf(c.ops).some((o) => o.method === "DELETE" && o.path?.includes("/secrets/"))
    ).toBe(true);
  });

  it("THE LAUNCHER DYING MID-RUN: the cluster deletes the Secret, because NOTHING in this process can", async () => {
    // THE ONE THAT MATTERS, AND THE ONE NO `finally` CAN PASS. The plugin host's hang detector
    // (`apps/server/src/plugin-host/host.ts`) SIGKILLs a subprocess mid-`trigger()`. Modelled here
    // the only way a single process can model its own death: the run is PARKED at `start` and then
    // never touched again — no teardown, no `finally`, not one further op from the launcher — and
    // the Secret's disappearance is caused entirely by the Job going away.
    const c = cluster({ perRunSecrets: true });
    c.hold("start");
    const abandoned = c.launcher().run(withSecret);
    await new Promise((r) => setImmediate(r));

    // THE CREDENTIAL IS LIVE IN THE CLUSTER at the instant of death — the precondition without which
    // everything below passes vacuously.
    expect(c.secrets.has("scp-runner-r1-env")).toBe(true);
    const opsAtDeath = c.ops.length;

    // NOW THE CLUSTER ACTS ALONE. `io.request` rather than the launcher, because the launcher is
    // conceptually dead: this is `ttlSecondsAfterFinished` firing, or an operator's `kubectl delete
    // job`, or a SUCCESSOR process's `reap()` — three routes, one deletion, and the Secret follows
    // the Job through every one of them because of the ownerReference and not because of who asked.
    await c.io.request({
      step: "teardown",
      method: "DELETE",
      path: "/apis/batch/v1/namespaces/scp/jobs/scp-runner-r1?propagationPolicy=Background",
      timeoutMs: 1_000
    });
    expect(c.secrets.has("scp-runner-r1-env")).toBe(false);

    // AND THE LAUNCHER ISSUED NOTHING IN BETWEEN. Without this the case proves only "something
    // deleted it", which a teardown that quietly ran would also satisfy.
    expect(c.ops.length).toBe(opsAtDeath + 1);

    c.release("start", new Error("the launcher process is gone"));
    await abandoned.catch(() => undefined);
  });

  it("A SUCCESSOR PROCESS'S `reap()` COLLECTS THE SECRET TOO — the same sweep, on the same deadline", async () => {
    // BELT AND BRACES, AND DELIBERATELY SO: the ownerReference is the guarantee, but it is a
    // guarantee that only fires once something deletes the Job. `reap()` is what deletes the Job of
    // a run whose owner is gone, so the two mechanisms compose — and this is the arm that proves the
    // sweep addresses the Secret by NAME rather than relying on collection it cannot observe.
    const c = cluster({ perRunSecrets: true });
    c.foreignJobs.push({
      metadata: {
        name: "scp-runner-dead",
        labels: { "scp.launcher.owner": "some-other-process" },
        annotations: { "scp.launcher.deadline": new Date(Date.now() - 60_000).toISOString() }
      }
    });
    c.secrets.set("scp-runner-dead-env", { metadata: { name: "scp-runner-dead-env" } });
    const removed = await c.launcher().reap();
    expect(removed).toContain("scp-runner-dead");
    expect(
      requestsOf(c.ops).some(
        (o) =>
          o.method === "DELETE" && o.path === "/api/v1/namespaces/scp/secrets/scp-runner-dead-env"
      )
    ).toBe(true);
    expect(c.secrets.has("scp-runner-dead-env")).toBe(false);
  });

  it("A CREATE RESPONSE WITH NO uid REFUSES — an UNOWNED Secret is never created", async () => {
    // THE NEGATIVE CONTROL FOR THE WHOLE MECHANISM. If the adapter fell back to an ownerReference-less
    // Secret when the uid was missing, every assertion above would still pass and the SIGKILL
    // guarantee would silently not exist on whatever cluster answered that way.
    const c = cluster({ perRunSecrets: true });
    c.overrides.push({
      match: (r) => r.method === "POST" && r.path.endsWith("/jobs"),
      res: { status: 201, body: JSON.stringify({ metadata: { name: "scp-runner-r1" } }) }
    });
    await expect(c.launcher().run(withSecret)).rejects.toThrow(
      /carried no metadata\.uid, so the per-run Secret could not be owned/
    );
    expect(requestsOf(c.ops).some((o) => o.method === "POST" && o.path?.endsWith("/secrets"))).toBe(
      false
    );
    expect(c.secrets.size).toBe(0);
    // AND THE JOB THAT WAS CREATED IS TORN DOWN — a refusal that leaked a Job per attempt would be a
    // second defect wearing the first one's clothes.
    expect(requestsOf(c.ops).some((o) => o.method === "DELETE" && o.path?.includes("/jobs/"))).toBe(
      true
    );
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

  it("A 409 ON THE SECRET POST IS ORPHAN DEBRIS — this run's OWN Job is torn down, the debris is NOT", async () => {
    // M23.4 INVERTED THIS CASE, AND THE INVERSION IS THE POINT. Until M23.4 the Secret POST came
    // FIRST, so a 409 there meant "another run holds this runId" and the correct response was to
    // touch nothing at all. Now the JOB POST stakes the name (which is what lets the Secret carry an
    // `ownerReference` to it), so a Secret 409 is only reachable AFTER a Job POST that did NOT 409 —
    // i.e. this run owns the name, and what is behind it is a Secret whose owning Job is gone. Two
    // different objects, two different owners, two different answers:
    //   - the Job this run just created is ITS OWN, so teardown deletes it;
    //   - the Secret is not, so nothing here deletes it. The collector will, because its
    //     `ownerReference` no longer resolves.
    const c = cluster({ perRunSecrets: true });
    const launcher = c.launcher();
    // A REALISTIC VALUE, and the reason is a real property of the port's redaction: it is a plain
    // split/join over the declared secret VALUES, so a one-character secret ("A=1") redacts every
    // "1" in every message the adapter produces, including the run id. True of the Docker adapter
    // too; worth knowing, and not what this case is about.
    const secretEnv = ["AWS_SECRET_ACCESS_KEY=an-actual-looking-credential"];
    await launcher.run(spec({ secretEnv, copyOut: undefined }));
    // THE DEBRIS: a Secret bearing the run's name whose owner uid names a Job that no longer exists.
    // That is exactly what a SIGKILLed predecessor leaves behind for the instant before the
    // collector takes it, and `uid-gone-forever` is unreachable by the fake's monotonic counter.
    const debris = {
      metadata: {
        name: "scp-runner-r1-env",
        ownerReferences: [{ kind: "Job", name: "scp-runner-r1", uid: "uid-gone-forever" }]
      }
    };
    c.secrets.set("scp-runner-r1-env", debris);
    c.ops.length = 0;
    const refusal = (await launcher
      .run(spec({ secretEnv, copyOut: undefined }))
      .then(() => new Error("the run was expected to be refused, and resolved instead"))
      .catch((e: Error) => e)) as Error;
    expect(refusal.message).toMatch(/already exists without the Job that owned it — orphan debris/);
    // AND THE REFUSAL CARRIES NO CREDENTIAL, even though the message is about a Secret.
    for (const text of [
      refusal.message,
      String(refusal),
      refusal.stack ?? "",
      JSON.stringify(refusal)
    ]) {
      expect(text).not.toContain("an-actual-looking-credential");
    }
    // THE JOB WAS ATTEMPTED — it has to be, or the Secret could never be owned by anything.
    expect(requestsOf(c.ops).some((o) => o.method === "POST" && o.path?.endsWith("/jobs"))).toBe(
      true
    );
    // AND IT WAS TORN DOWN. This is the arm that separates "the name is someone else's" from "the
    // Secret is someone else's": leaving the Job would leak a Job per retry, forever.
    expect(requestsOf(c.ops).some((o) => o.method === "DELETE" && o.path?.includes("/jobs/"))).toBe(
      true
    );
    // THE DEBRIS IS NOT DELETED BY THIS PROCESS. Never delete an object you cannot prove you made.
    expect(
      requestsOf(c.ops).some((o) => o.method === "DELETE" && o.path?.includes("/secrets/"))
    ).toBe(false);
    // AND YET THE DEBRIS IS GONE BY THE END OF THE RUN — collected, not deleted. The assertion
    // directly above is what makes this one mean something: no `DELETE .../secrets/...` was issued
    // by the adapter at all, so the only thing that could have removed it is the garbage collector
    // reacting to the Job teardown, which is precisely the mechanism the whole ordering exists to
    // buy. A retry therefore succeeds rather than looping on the same 409 forever.
    expect(c.secrets.has("scp-runner-r1-env")).toBe(false);
    await expect(launcher.run(spec({ secretEnv, copyOut: undefined }))).resolves.toMatchObject({
      succeeded: true
    });
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
