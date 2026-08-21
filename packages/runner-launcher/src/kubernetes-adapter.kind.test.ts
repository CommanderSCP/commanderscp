import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  LAUNCHER_OWNER_ID,
  RUNNER_LAUNCHER_DEADLINE_ANNOTATION,
  RUNNER_LAUNCHER_OWNER_LABEL,
  RUNNER_RUN_ID_LABEL,
  createFetchKubernetesIo,
  createKubernetesRunnerLauncher,
  jobManifest,
  runnerJobName
} from "./index.js";
import type { KubernetesRunnerIo, RunnerSpec } from "./index.js";

const execFileAsync = promisify(execFile);

/**
 * ================================================================================================
 * M23.2 — THE KUBERNETES ADAPTER AGAINST A REAL API SERVER (owner decision 3)
 * ================================================================================================
 *
 * "A fake Kubernetes client only proves the adapter agrees with itself" — owner decision 3,
 * BUILD_AND_TEST.md M23. `kubernetes-adapter.test.ts` drives every branch of the failure mapping
 * cheaply and cannot answer a single question about whether any of it is TRUE of Kubernetes. This
 * file answers those, and only those:
 *
 *   1. The API server ACCEPTS the Job manifest `jobManifest()` builds. A fake accepts anything;
 *      a 422 on a mistyped field is invisible until production.
 *   2. `suspend: true` then PATCH `false` really is create-then-start against a live Job controller
 *      — the decision the whole create/copy-in/start ordering rests on.
 *   3. The `subPath` layout puts the copied bytes where the runner looks for them AND brings what it
 *      wrote back out. That is the entirety of owner decision 5's byte-movement story, and nothing
 *      short of a running pod can check it.
 *   4. A duplicate `metadata.name` really is `409 AlreadyExists`, so `isKubernetesAlreadyExists`
 *      matches something real rather than a shape invented in a fixture.
 *   5. An RFC3339 deadline really is rejected as a label VALUE and accepted as an annotation. That
 *      measurement is the reason `RUNNER_LAUNCHER_DEADLINE_ANNOTATION` exists; re-measuring it in CI
 *      is what keeps it a fact rather than a remembered one.
 *   6. THE CHART'S OWN RBAC IS SUFFICIENT. `scripts/kind-runner-harness.sh` binds this token to the
 *      Role rendered by `helm template` from `deploy/helm/templates/runner-iac.yaml` — not to a
 *      hand-written copy — so every request below is authorised by exactly what a `helm install`
 *      grants. A verb the adapter needs and the chart does not grant is a 403 here.
 *
 * WHAT IT STILL DOES NOT PROVE, said plainly:
 *   - Network containment. kind's kindnet does not enforce NetworkPolicy (re-measured with a
 *     known-positive control), so this cluster cannot speak to owner decision 1 at all. That stays
 *     with `scripts/airgap-drill.sh`, which installs Calico.
 *   - The in-cluster credential path. The adapter reads a PROJECTED service-account token from
 *     `/var/run/secrets/...` and trusts the cluster CA through `NODE_EXTRA_CA_CERTS`; this test
 *     process is outside the cluster, so it supplies the token from `kubectl create token` and the
 *     CA through a `fetchImpl`. The SHIPPED `createFetchKubernetesIo` is what runs — its header
 *     construction, its `AbortSignal.timeout`, its body serialisation and its status/text handling —
 *     and only the TLS trust anchor arrives by a different route than in a pod.
 *   - RWX. A single-node cluster has no RWX class; the workspace is a host directory kind mounts
 *     into the node. That proves the subPath layout and the byte movement, not that any particular
 *     storage class is ReadWriteMany.
 *   - The real runner images. `alpine:3.20` stands in — it is already in
 *     `tools/ci-mirror/images.list` and it has a shell, which is all three classes' observable
 *     behaviour reduced to one image. `managed-iac.integration.test.ts` still owns real-runner
 *     coverage on the Docker path.
 *
 * NO SKIP PATH, DELIBERATELY. A `describe.skipIf(noCluster)` is how a gate becomes decorative: the
 * job goes green having run nothing, which is the "checks that pass without running" class CLAUDE.md
 * records. This file is run ONLY by `pnpm --filter @scp/runner-launcher test:kind`, from a CI job
 * that stands the cluster up first, and it FAILS with a readable message when the harness is absent.
 */

interface Harness {
  /** The kind cluster's name — needed to `kind load` an image into it. */
  cluster: string;
  namespace: string;
  /** The OPT-OUT namespace: the same chart rendered at `perRunSecrets=false`. See the harness script
   *  for why this pair's polarity inverted in M23.4 — `namespace` above is now the one WITH the
   *  grant, because that is what the chart's defaults produce since the owner took the decision. */
  noSecretsNamespace: string;
  noSecretsToken: string;
  /** M23.5 — a namespace with a compute ResourceQuota and NO defaulting LimitRange. The only way to
   *  produce HIGH-4's first route: the Job is accepted, and the CONTROLLER's pod CREATE is refused,
   *  so no pod ever exists for `kubernetesTermination` to read. */
  quotaNamespace: string;
  quotaToken: string;
  apiBase: string;
  token: string;
  caFile: string;
  kubeconfig: string;
  workspaceHost: string;
  nodeWorkspace: string;
  runnerImage: string;
}

let harness: Harness;
let ca: Buffer;

/**
 * A `fetch`-shaped shim over `node:https` that trusts the cluster CA.
 *
 * IT EXISTS FOR ONE REASON AND CARRIES NO LOGIC. Node's global `fetch` cannot be given a custom CA
 * without an undici Agent, which is why the two shipped in-cluster callers
 * (`bundled-argocd-autowire-bin.ts`, `bundled-gitea-autowire-bin.ts`) rely on `NODE_EXTRA_CA_CERTS`
 * being set in their Job spec — an environment variable Node reads at PROCESS START, which a test
 * inside an already-running vitest worker cannot set. Everything else about the transport —
 * authorization header, accept, content-type, timeout, JSON body, status and text — is the shipped
 * `createFetchKubernetesIo`, which is the code that must be exercised.
 */
const caFetch = ((url: string, init: RequestInit): Promise<Response> =>
  new Promise((resolve, reject) => {
    const target = new URL(url);
    const req = httpsRequest(
      {
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        method: init.method ?? "GET",
        headers: init.headers as Record<string, string>,
        ca
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            text: async () => Buffer.concat(chunks).toString("utf8")
          } as Response)
        );
      }
    );
    req.on("error", reject);
    if (init.signal) init.signal.addEventListener("abort", () => req.destroy(new Error("aborted")));
    if (init.body) req.write(init.body);
    req.end();
  })) as unknown as typeof fetch;

function io(token: string = ""): KubernetesRunnerIo {
  return createFetchKubernetesIo({
    apiBase: harness.apiBase,
    readToken: async () => token || harness.token,
    copyDir: async (fromDir, toDir) => {
      const { cp, mkdir } = await import("node:fs/promises");
      await mkdir(toDir, { recursive: true });
      await cp(fromDir, toDir, { recursive: true });
      // The runner runs as whatever uid its image declares; the harness workspace is 0777 for the
      // same reason (see the script). Slots this process creates need the same, or the container
      // cannot write its evidence and the copy-out silently returns nothing.
      const { chmod } = await import("node:fs/promises");
      await chmod(toDir, 0o777);
    },
    removeDir: async (dir) => {
      const { rm: rmDir } = await import("node:fs/promises");
      await rmDir(dir, { recursive: true, force: true });
    },
    fetchImpl: caFetch
  });
}

function launcher(
  over: {
    perRunSecrets?: boolean;
    runAsNonRoot?: boolean;
    /** M23.5 — the ResourceQuota namespace, with its own chart-rendered RBAC and its own token. */
    quota?: boolean;
    /** M23.5 — the deployment's pod conventions, which is what the quota namespace needs supplied
     *  and what HIGH-3 measured the absence of. */
    pod?: Parameters<typeof createKubernetesRunnerLauncher>[0]["pod"];
  } = {}
) {
  // EVERY CASE RUNS UNDER RBAC THE CHART RENDERED, NEVER UNDER A PERMISSION THE HARNESS HANDED
  // ITSELF — that is the whole reason owner decision 3 required a real cluster ("a fake authorises
  // everything"). The default namespace carries the chart's DEFAULT render, which since M23.4 means
  // the per-run Secret grant is present; `perRunSecrets: false` switches to the namespace rendered
  // at that value, and to that namespace's own token, so an opt-out case is exercised under exactly
  // the grant a `helm install --set managedRunners.kubernetes.perRunSecrets=false` makes.
  const optedOut = over.perRunSecrets === false;
  const namespace = over.quota
    ? harness.quotaNamespace
    : optedOut
      ? harness.noSecretsNamespace
      : harness.namespace;
  const token = over.quota ? harness.quotaToken : optedOut ? harness.noSecretsToken : harness.token;
  return createKubernetesRunnerLauncher({
    namespace,
    workspaceRoot: harness.workspaceHost,
    workspaceVolume: { kind: "hostPath", path: harness.nodeWorkspace },
    perRunSecrets: !optedOut,
    runAsNonRoot: over.runAsNonRoot === true,
    pollIntervalMs: 500,
    ...(over.pod ? { pod: over.pod } : {}),
    io: io(token)
  });
}

/** `kubectl` against the harness cluster, for the assertions the adapter itself must not make. */
async function kubectl(...args: string[]): Promise<string> {
  return kubectlIn(harness.namespace, ...args);
}

async function kubectlIn(namespace: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("kubectl", ["-n", namespace, ...args], {
    env: { ...process.env, KUBECONFIG: harness.kubeconfig },
    maxBuffer: 8 * 1024 * 1024
  });
  return stdout;
}

/** `kubectl auth can-i`, whose ANSWER is its exit status: it exits 1 for "no". Reading the status as
 *  a command failure would report "the check could not run" for the one outcome the check exists to
 *  detect, so the answer is read off stdout and the status is not consulted. */
async function canI(verb: string, resource: string, sa: string): Promise<string> {
  try {
    return (await kubectl("auth", "can-i", verb, resource, "--as", sa)).trim();
  } catch (err) {
    return String((err as { stdout?: string }).stdout ?? "").trim() || "no";
  }
}

/** The stand-in credential. Long enough that its LENGTH is a fingerprint, and never printed. */
const CREDENTIAL = "an-actual-looking-credential";

let scratch: string;

/**
 * ==================================================================================================
 * THE SELF-HEAL — M23.5 verification pass 20, LOW-13 and LOW-14, WHICH ARE ONE DEFECT
 * ==================================================================================================
 *
 * WHAT HAPPENS WHEN THIS SUITE IS INTERRUPTED. A run stopped by a SIGTERM — Ctrl-C while iterating,
 * a CI cancellation, a killed fork — leaves two things behind, and neither of the cleanups that
 * exist is reached, because both of them run at the END of a process that no longer exists:
 *
 *   1. A Job in the cluster. MEASURED: `scp-runner-quota-refused` survived, and the next run's
 *      `create` POST got the typed 409 the adapter is right to refuse on ("tearing down nothing:
 *      the Job behind this name belongs to that run" — that rule is load-bearing and stays). Four
 *      CONSECUTIVE red runs, then self-recovery, because `reap()` is SCHEDULED, NOT AWAITED (see
 *      `run()`) and therefore races the very `create` it would have unblocked. Re-measured here by
 *      seeding one leftover: ROUTE 1 red, and the leftover gone by the time the run finished — a
 *      gate red for a reason with nothing to do with the change under test, exactly while someone
 *      is iterating on it. Fresh CI clusters never see it, which is why it survived.
 *   2. A scratch directory in `os.tmpdir()`. Ten were present at the last cleanup, several
 *      non-empty, spanning two sessions — despite LOW-12's `afterAll`, which is not bypassed by
 *      anything IN this file: it is bypassed by the process ending without running it.
 *
 * SO THE CLEANUP MOVES TO THE FRONT. An `afterAll` is a promise about how this process will end; a
 * `beforeAll` sweep is a statement about the state the suite starts from, and only the second
 * survives the way the suite actually dies. The `afterAll` STAYS — it keeps the machine tidy on the
 * normal path and it is what makes the leak rare — but nothing depends on it any more.
 *
 * WHY THE SWEEP MAY DELETE WHAT `reap()` MUST NOT. `reap()` is production code against a shared
 * cluster: it is fail-closed on the deadline stamp, because deleting a foreign Job whose deadline
 * has not passed would destroy somebody's live `tofu apply`. These three namespaces belong to this
 * suite and to nothing else, the config is `singleFork` and the harness script stands them up, so
 * any launcher-labelled object here at `beforeAll` is debris from a process that is gone. That is
 * the whole difference, and it is why the fix is HERE and not in the 409 path or in `reap`.
 */
async function sweepLeftoverRunnerObjects(): Promise<void> {
  for (const ns of [harness.namespace, harness.noSecretsNamespace, harness.quotaNamespace]) {
    // WAITED, NOT `--wait=false`. The whole defect is a teardown that raced a `create`; a sweep that
    // returned before the Job was gone would reproduce it one layer up.
    await kubectlIn(ns, "delete", "job", "-l", RUNNER_LAUNCHER_OWNER_LABEL, "--ignore-not-found");
    await kubectlIn(
      ns,
      "delete",
      "secret",
      "-l",
      RUNNER_LAUNCHER_OWNER_LABEL,
      "--ignore-not-found"
    );
  }
  // AND THE THIRD OBJECT, the one `reap()` also takes: the run's workspace subtree. A leftover `out`
  // slot is worse than a leftover Job, because it does not fail — it hands the next run's copy-out
  // the PREVIOUS run's evidence, which is a green for the wrong reason.
  for (const entry of await readdir(harness.workspaceHost).catch(() => [])) {
    if (entry.startsWith("scp-runner-")) {
      await rm(join(harness.workspaceHost, entry), { recursive: true, force: true });
    }
  }
}

/** Every `scp-kind-*` scratch directory in `os.tmpdir()` except this process's own. See above: they
 *  can only be this file's, and this suite is the only thing that runs it (`singleFork`, one CI
 *  job), so there is no concurrent peer whose directory this could be. */
async function sweepStaleScratchDirs(keep: string): Promise<string[]> {
  const parent = tmpdir();
  const swept: string[] = [];
  for (const entry of await readdir(parent).catch(() => [])) {
    const path = join(parent, entry);
    if (!entry.startsWith("scp-kind-") || path === keep) continue;
    await rm(path, { recursive: true, force: true });
    swept.push(path);
  }
  return swept;
}

beforeAll(async () => {
  const path =
    process.env.SCP_KIND_HARNESS ??
    join(process.env.HOME ?? "", ".cache/scp-kind-runner-harness/harness.json");
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    // FAILS, NEVER SKIPS. See the header: a skip here turns the gate into a green job that ran
    // nothing, which is the exact failure this whole increment exists to avoid.
    throw new Error(
      `no Kubernetes harness at ${path}. Run \`scripts/kind-runner-harness.sh up\` first, or set ` +
        `SCP_KIND_HARNESS. This suite has no skip path on purpose.`
    );
  }
  harness = JSON.parse(raw) as Harness;
  ca = await readFile(harness.caFile);
  scratch = await mkdtemp(join(tmpdir(), "scp-kind-"));
  // OURS FIRST, THEN EVERYTHING ELSE — the same call the gate below makes, so the gate is testing
  // this and not a near-relative of it.
  await sweepStaleScratchDirs(scratch);
  await sweepLeftoverRunnerObjects();
}, 120_000);

// LOW-12 — `beforeAll` mkdtemp's ONCE per file and nothing removed it: 50 accumulated across repeat
// local runs of this suite. Each plugin's `runner-launcher-selection.test.ts` pairs its `mkdtemp`
// with a cleanup at the matching cardinality (`beforeEach`/`afterEach` there; `beforeAll`/`afterAll`
// here, since this file creates exactly one scratch dir for the whole suite, not one per test).
//
// AND IT IS NO LONGER THE GUARANTEE — LOW-14, pass 20. Ten dirs were present at the next cleanup
// anyway, several non-empty, spanning two sessions: nothing in this file bypasses this hook, the
// PROCESS ENDING WITHOUT RUNNING IT does, which is every Ctrl-C and every cancelled CI job. What
// makes the leak self-healing is `sweepStaleScratchDirs` in `beforeAll`; this stays because it keeps
// the normal path clean and makes the leak rare, not because anything now depends on it.
afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

function spec(over: Partial<RunnerSpec> = {}): RunnerSpec {
  return {
    runId: "probe",
    labels: { "scp.executor": "scp-managed-scan", "scp.run-id": "probe" },
    image: harness.runnerImage,
    // `alpine` declares no ENTRYPOINT, so `args` IS the command. A real runner image has one and
    // these would be its operands; what is being exercised either way is that `RunnerSpec.operands`
    // reaches the container as `args` in order.
    operands: ["/bin/sh", "-c", "echo hello-from-the-runner"],
    networkMode: "none",
    env: [],
    secretEnv: [],
    copyIn: [],
    timeoutMs: 120_000,
    maxBuffer: 4 * 1024 * 1024,
    ...over
  };
}

describe("M23.2 kind: the Kubernetes adapter against a real API server", () => {
  it("A WHOLE RUN — bytes in, a real pod, evidence out, and nothing left behind", async () => {
    const inDir = join(scratch, "in");
    const outDir = join(scratch, "out");
    await execFileAsync("mkdir", ["-p", inDir, outDir]);
    await writeFile(join(inDir, "subject.txt"), "the-payload", "utf8");

    const result = await launcher().run(
      spec({
        runId: "whole-run",
        labels: { "scp.executor": "scp-managed-scan", "scp.run-id": "whole-run" },
        // READS WHAT WAS COPIED IN AND WRITES WHAT MUST COME BACK OUT. Both directions in one
        // container, because a copy-in that lands nowhere and a copy-out that returns nothing are
        // indistinguishable from success if only one is checked.
        operands: [
          "/bin/sh",
          "-c",
          "cat /work/in/subject.txt && echo processed > /work/out/evidence.json && echo done-on-stdout"
        ],
        copyIn: [{ hostDir: inDir, containerPath: "/work/in" }],
        copyOut: {
          containerPath: "/work/out",
          hostDir: outDir,
          when: "on-success",
          onFailure: "propagate"
        }
      })
    );

    expect(result.succeeded, `the run failed: ${JSON.stringify(result.failure)}`).toBe(true);
    // THE COPY-IN LANDED: the container could read the file this process wrote on the host.
    expect(result.stdout).toContain("the-payload");
    expect(result.stdout).toContain("done-on-stdout");
    // THE COPY-OUT CAME BACK: what the container wrote inside the pod is on this process's disk.
    expect(await readFile(join(outDir, "evidence.json"), "utf8")).toBe("processed\n");

    // TEARDOWN REACHED THE REAL OBJECTS.
    const jobs = await kubectl("get", "jobs", "-o", "name");
    expect(jobs).not.toContain(runnerJobName("whole-run"));
    expect(await readdir(harness.workspaceHost)).not.toContain(runnerJobName("whole-run"));
  }, 120_000);

  it("A JOB CREATED SUSPENDED HAS NO POD UNTIL PATCHED — the live-controller semantics create/start rests on (LOW-11)", async () => {
    // "A WHOLE RUN" above proves the adapter's OWN two-step call sequence produces a successful run
    // end to end — which a single-step, always-unsuspended adapter would ALSO pass. It never queries
    // the API server between `create` and `start`, so nothing in this suite actually watched the
    // suspended Job have no pod. This test does, directly against the controller and without racing
    // the adapter's own internal timing: it builds the SAME manifest `jobManifest()` produces,
    // applies it with `kubectl` (deterministic, not a hope of catching a window `run()` closes in
    // milliseconds), and checks the controller's real behaviour at each half.
    const runId = "suspend-then-start";
    const jobName = runnerJobName(runId);
    const manifestPath = join(scratch, `${jobName}.json`);
    const manifest = jobManifest(spec({ runId, operands: ["/bin/sh", "-c", "echo hi"] }), {
      namespace: harness.namespace,
      jobName,
      secretName: `${jobName}-env`,
      reapDeadline: new Date(Date.now() + 120_000).toISOString(),
      slots: new Map(),
      workspaceVolume: { kind: "hostPath", path: harness.nodeWorkspace },
      runAsNonRoot: false,
      ttlSecondsAfterFinished: 60
    });
    await writeFile(manifestPath, JSON.stringify(manifest), "utf8");

    try {
      await kubectl("apply", "-f", manifestPath);

      // HALF ONE: SUSPENDED MEANS NO POD, MEASURED IMMEDIATELY AFTER CREATE. If the Job controller
      // created a pod anyway, `create` alone would already have started the run and `start`'s PATCH
      // would be theatre — exactly the shape this test exists to rule out.
      const suspendedField = (
        await kubectl("get", "job", jobName, "-o", `jsonpath={.spec.suspend}`)
      ).trim();
      expect(suspendedField).toBe("true");
      const podsWhileSuspended = (
        await kubectl("get", "pods", "-l", `${RUNNER_RUN_ID_LABEL}=${runId}`, "-o", "name")
      ).trim();
      expect(podsWhileSuspended).toBe("");

      // HALF TWO: THE UNSUSPEND PATCH REALLY STARTS IT. Polled rather than awaited once, because the
      // controller's reconcile loop is asynchronous even on a live API server — the claim under test
      // is "a pod eventually appears", not "a pod appears synchronously with the PATCH response".
      await kubectl("patch", "job", jobName, "--type=merge", "-p", '{"spec":{"suspend":false}}');
      let podName = "";
      for (let attempt = 0; attempt < 20; attempt++) {
        podName = (
          await kubectl("get", "pods", "-l", `${RUNNER_RUN_ID_LABEL}=${runId}`, "-o", "name")
        ).trim();
        if (podName) break;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      expect(podName).not.toBe("");
    } finally {
      await kubectl("delete", "job", jobName, "--ignore-not-found", "--wait=false");
    }
  }, 60_000);

  it("THE CHART'S RBAC AUTHORISES EVERY VERB THIS ADAPTER USES — including the unsuspend PATCH", async () => {
    // The token this suite uses is bound to the Role `helm template` rendered from
    // `deploy/helm/templates/runner-iac.yaml`. `can-i` is asked directly so that a missing verb
    // fails with the VERB'S NAME rather than as an opaque 403 inside a run — the shipped Role had no
    // `patch` on `batch/jobs` when this test was written, and the unsuspend is a PATCH.
    const sa = `system:serviceaccount:${harness.namespace}:scp-runner-harness`;
    const checks: [string, string][] = [
      ["create", "jobs.batch"],
      ["get", "jobs.batch"],
      ["list", "jobs.batch"],
      ["patch", "jobs.batch"],
      ["delete", "jobs.batch"],
      ["list", "pods"],
      ["get", "pods/log"]
    ];
    for (const [verb, resource] of checks) {
      expect(
        await canI(verb, resource, sa),
        `the chart's runner Role does not grant ${verb} on ${resource}`
      ).toBe("yes");
    }
    // AND THE OTHER DIRECTION, AGAINST THE REAL AUTHORIZER (M23.6 clause 5). Every check above is
    // "the answer was yes", and a Role granting `*` on everything answers yes to all of them. These
    // are the verbs the chart USED to grant and the adapter has never issued: `watch` on both
    // resources (this adapter POLLS — see `KUBERNETES_POLL_INTERVAL_MS`'s doc — and there is no
    // `watch=` query anywhere in it), and the two halves of the `pods`/`pods/log` collapse, which
    // gave each resource the other's verbs. `tools/helm-verify` diffs the rendered rules against
    // `kubernetesRunnerRbac()` as a set; this is the same claim asked of a real API server, which is
    // the only thing that can say what the Role MEANS rather than what it says.
    const narrowness: [string, string][] = [
      ["watch", "jobs.batch"],
      ["watch", "pods"],
      ["watch", "pods/log"],
      ["get", "pods"],
      ["list", "pods/log"],
      ["update", "jobs.batch"],
      ["deletecollection", "jobs.batch"]
    ];
    for (const [verb, resource] of narrowness) {
      expect(
        await canI(verb, resource, sa),
        `the chart's runner Role grants ${verb} on ${resource}, which this adapter never issues`
      ).toBe("no");
    }
    // THE GRANT THE OWNER TOOK, ASKED FOR BY NAME (M23.4). Two verbs, in the DEFAULT namespace,
    // because the chart's default is what an operator installs.
    for (const verb of ["create", "delete"]) {
      expect(
        await canI(verb, "secrets", sa),
        `the chart's DEFAULT render does not grant ${verb} on secrets — managed-iac cannot run on Kubernetes without it, which is the state the owner's 2026-08-20 grant exists to end`
      ).toBe("yes");
    }
    // AND THE TWO VERBS IT DID NOT. These are narrowness assertions AND the negative controls in one:
    // every assertion above is "the answer was yes", which is also what a broken `canI` that always
    // returned "yes" would produce, and what a `--as` that silently fell back to the cluster-admin
    // kubeconfig would produce too. A cluster-admin fallback answers "yes" to `list secrets`; the
    // real Role does not, so these "no"s are what make the yeses mean something.
    for (const verb of ["list", "get"]) {
      expect(
        await canI(verb, "secrets", sa),
        `the runner Role grants '${verb}' on secrets. The adapter issues one POST and two DELETEs and no GET, and a 'list' returns every Secret BODY in the namespace including the release's database password — neither is part of what was granted`
      ).toBe("no");
    }
    // THE OPT-OUT NAMESPACE STILL RENDERS NOTHING, which is the arm that catches a chart change
    // granting `secrets` unconditionally regardless of the value.
    const optedOutSa = `system:serviceaccount:${harness.noSecretsNamespace}:scp-runner-harness`;
    const optedOut = await kubectlIn(
      harness.noSecretsNamespace,
      "auth",
      "can-i",
      "create",
      "secrets",
      "--as",
      optedOutSa
    ).catch((err: { stdout?: string }) => String(err.stdout ?? "no"));
    expect(
      optedOut.trim(),
      "perRunSecrets=false still grants `secrets: create` — the opt-out grants the privilege it says it declines"
    ).toBe("no");
  }, 60_000);

  it("A NON-ZERO RUNNER IS `exit-nonzero`, with its own last words in the detail", async () => {
    const result = await launcher().run(
      spec({
        runId: "nonzero",
        labels: { "scp.run-id": "nonzero" },
        operands: ["/bin/sh", "-c", "echo the-runners-own-message >&2; exit 3"]
      })
    );
    expect(result.succeeded).toBe(false);
    expect(result.failure!.kind).toBe("exit-nonzero");
    expect(result.failure!.code).toBe(3);
    // `pods/log` MERGES the streams, so a message the container sent to stderr arrives in `stdout`
    // and reaches the diagnosis through `classifyRunnerFailure`'s `stderr`-empty fall-through. This
    // is the contract decision `KUBERNETES_MERGES_STDERR_INTO_STDOUT` names, observed end to end.
    expect(result.failure!.detail).toContain("the-runners-own-message");
    expect(result.stderr).toBe("");
  }, 120_000);

  it("`runAsNonRoot: true` AGAINST A ROOT IMAGE IS `spawn-failed` — the reference shape's own value", async () => {
    // `deploy/helm/templates/runner-iac.yaml`'s reference Job shape asserts `runAsNonRoot: true`, and
    // a filterless read of apps/runner-{iac,scan,dep}/Dockerfile finds no `USER` line in any of them.
    // This is that combination, executed: the kubelet refuses the container before the entrypoint,
    // and the adapter must call it `spawn-failed` ("nothing ran, so nothing was mutated") rather than
    // polling to the deadline and reporting `budget-exhausted` — which for managed-iac would mean
    // "a tofu apply was SIGTERMed mid-flight, so the real infrastructure state is unknown".
    const result = await launcher({ runAsNonRoot: true }).run(
      spec({ runId: "nonroot", labels: { "scp.run-id": "nonroot" }, timeoutMs: 60_000 })
    );
    expect(result.succeeded).toBe(false);
    expect(result.failure!.kind).toBe("spawn-failed");
    expect(String(result.failure!.code)).toMatch(/CreateContainerConfigError|CreateContainerError/);
  }, 120_000);

  it("A DUPLICATE runId IS A TYPED 409 `AlreadyExists`, and the peer's Job SURVIVES", async () => {
    const name = runnerJobName("conflict");
    // A peer's Job, created outside this launcher and deliberately left running.
    await kubectl(
      "create",
      "job",
      name,
      "--image",
      harness.runnerImage,
      "--",
      "/bin/sh",
      "-c",
      "sleep 300"
    );
    try {
      await expect(
        launcher().run(spec({ runId: "conflict", labels: { "scp.run-id": "conflict" } }))
      ).rejects.toThrow(/already exists — another run holds this runId/);
      // THE INVARIANT M23.1e ESTABLISHED ON DOCKER, HELD ON KUBERNETES: a run that lost the name
      // tears down nothing. The peer is still there.
      expect(await kubectl("get", "job", name, "-o", "name")).toContain(name);
    } finally {
      await kubectl("delete", "job", name, "--wait=false").catch(() => undefined);
    }
  }, 120_000);

  it("THE DEADLINE IS ACCEPTED AS AN ANNOTATION AND REJECTED AS A LABEL — re-measured, not remembered", async () => {
    await launcher().run(spec({ runId: "stamp", labels: { "scp.run-id": "stamp" } }));
    // The Job is torn down by then, so the round trip is observed through a Job this test creates
    // with the SAME two values the adapter stamps.
    const name = "scp-runner-stamp-probe";
    const deadline = new Date(Date.now() + 600_000).toISOString();
    await kubectl(
      "create",
      "job",
      name,
      "--image",
      harness.runnerImage,
      "--",
      "/bin/sh",
      "-c",
      "true"
    );
    try {
      await kubectl("annotate", "job", name, `${RUNNER_LAUNCHER_DEADLINE_ANNOTATION}=${deadline}`);
      await kubectl("label", "job", name, `${RUNNER_LAUNCHER_OWNER_LABEL}=${LAUNCHER_OWNER_ID}`);
      const read = await kubectl(
        "get",
        "job",
        name,
        "-o",
        `jsonpath={.metadata.annotations.${RUNNER_LAUNCHER_DEADLINE_ANNOTATION.replace(/\./g, "\\.")}}`
      );
      expect(read).toBe(deadline);
      // AND THE HALF THAT MAKES IT A MEASUREMENT RATHER THAN A PREFERENCE: the same string is not a
      // legal label value, so `reap()` could not have used a label for it.
      await expect(
        kubectl("label", "job", name, `scp.launcher.deadlineprobe=${deadline}`)
      ).rejects.toThrow(/invalid label value|Invalid value/);
    } finally {
      await kubectl("delete", "job", name, "--wait=false").catch(() => undefined);
    }
  }, 120_000);

  // ================================================================================================
  // M23.4 — THE IN-CLUSTER CREDENTIAL PATH, WHICH M23.2 SAID IT COULD NOT PROVE
  // ================================================================================================
  //
  // M23.2 shipped `secretEnv` as a declared, DISABLED capability and listed the in-cluster credential
  // path as one of the two things it could not prove: the grant did not exist, so the code could only
  // be exercised in a namespace the harness had opted into, and nothing showed what a real credential
  // does on the way through. With the owner's grant (2026-08-20) it is provable, so these cases prove
  // it — a real value, delivered through a per-run Secret, reaching the runner's environment, and
  // appearing in NO argv, NO log, NO API object a reader can list, and nothing left behind.
  //
  // EVERY SWEEP HERE HAS A NON-VACUITY CONTROL, and the last case in this block IS that control: the
  // same probe, run against a credential deliberately delivered the WRONG way (`env[].value`), must
  // FIND it. A sweep that cannot fail is a sweep that proves nothing, and this suite has already been
  // bitten by tests that were green for the wrong reason.

  /** Everything a reader with `get`/`list` on this namespace can see, as one string to sweep. */
  async function readableSurface(ns: string): Promise<string> {
    const parts = await Promise.all(
      [
        ["get", "jobs", "-o", "json"],
        ["get", "pods", "-o", "json"],
        ["get", "events", "-o", "json"],
        ["get", "secrets", "-o", "name"]
      ].map((args) => kubectlIn(ns, ...args).catch(() => ""))
    );
    return parts.join("\n");
  }

  /** Polls until `predicate` holds or the budget runs out. Returns whether it held. */
  async function until(predicate: () => Promise<boolean>, budgetMs = 30_000): Promise<boolean> {
    const deadline = Date.now() + budgetMs;
    while (Date.now() < deadline) {
      if (await predicate().catch(() => false)) return true;
      await new Promise((r) => setTimeout(r, 250));
    }
    return false;
  }

  it("THE CREDENTIAL REACHES THE RUNNER AND APPEARS IN NOTHING A READER CAN LIST", async () => {
    const ns = harness.namespace;
    await kubectlIn(ns, "delete", "secret", "scp-runner-secretenv-env", "--ignore-not-found");

    // SLOW ENOUGH TO BE OBSERVED. The sweep has to look at the Job and the pod WHILE THEY EXIST —
    // teardown deletes them, so a post-hoc `kubectl get` would find nothing and pass vacuously.
    const running = launcher().run(
      spec({
        runId: "secretenv",
        labels: { "scp.run-id": "secretenv" },
        // PRINTS THE LENGTH, NEVER THE VALUE. The log is read back into `result.stdout` and would
        // otherwise put the credential in this test's own output on failure — the same reason the
        // adapter redacts.
        operands: [
          "/bin/sh",
          "-c",
          'test -n "$AWS_SECRET_ACCESS_KEY" && echo "len=${#AWS_SECRET_ACCESS_KEY}" && sleep 6'
        ],
        secretEnv: [`AWS_SECRET_ACCESS_KEY=${CREDENTIAL}`]
      })
    );

    // SNAPSHOT MID-RUN, and assert the snapshot is not empty before trusting what it does not
    // contain — "the credential is not in this string" is trivially true of the empty string.
    const appeared = await until(async () =>
      (await kubectlIn(ns, "get", "jobs", "-o", "name")).includes("scp-runner-secretenv")
    );
    expect(appeared, "the Job never appeared, so the sweep below would have swept nothing").toBe(
      true
    );
    const surface = await readableSurface(ns);
    expect(surface).toContain("scp-runner-secretenv");

    // (1) NOT IN ANY API OBJECT A READER CAN LIST. The Job carries the container's `args` (this
    //     adapter's argv), its `env`, its labels and its annotations; the pod carries the resolved
    //     spec; events carry the kubelet's own messages. The credential is in exactly one object —
    //     the Secret — and a `get secrets -o name` proves the sweep saw that namespace at all
    //     without reading a single body.
    expect(surface).not.toContain(CREDENTIAL);
    expect(surface).not.toContain(Buffer.from(CREDENTIAL, "utf8").toString("base64"));

    // (2) THE SECRET IS OWNED BY THE JOB, IN A REAL CLUSTER'S OWN VIEW OF IT. This is the assertion
    //     that makes every deletion case below a consequence rather than a coincidence: the API
    //     server accepted the ownerReference, resolved it to a live Job, and did NOT collect it.
    const ownerJson = await kubectlIn(
      ns,
      "get",
      "secret",
      "scp-runner-secretenv-env",
      "-o",
      "jsonpath={.metadata.ownerReferences[0]}"
    );
    const owner = JSON.parse(ownerJson) as Record<string, unknown>;
    expect(owner.kind).toBe("Job");
    expect(owner.name).toBe("scp-runner-secretenv");
    expect(owner.blockOwnerDeletion).toBe(false);
    const jobUid = (
      await kubectlIn(ns, "get", "job", "scp-runner-secretenv", "-o", "jsonpath={.metadata.uid}")
    ).trim();
    // THE UID IS THE LIVE JOB'S, not a plausible-looking string. An ownerReference whose uid does
    // not resolve makes the collector delete the Secret out from under a running pod.
    expect(owner.uid).toBe(jobUid);

    const result = await running;

    // (3) IT ARRIVED INTACT. Derived, not counted by hand — an earlier draft hardcoded 27 for a
    //     28-character string and reddened on the arithmetic instead of on the behaviour.
    expect(result.succeeded, `the run failed: ${JSON.stringify(result.failure)}`).toBe(true);
    expect(result.stdout).toContain(`len=${CREDENTIAL.length}`);

    // (4) NOT IN THE RUN'S OWN OUTPUT, which is what reaches a Decision record and an operator's
    //     screen.
    expect(result.stdout).not.toContain(CREDENTIAL);
    expect(result.stderr).not.toContain(CREDENTIAL);

    // (5) AND NOTHING IS LEFT BEHIND — the success path of the credential's lifetime.
    expect(await kubectlIn(ns, "get", "secrets", "-o", "name")).not.toContain(
      "scp-runner-secretenv-env"
    );
    expect(await kubectlIn(ns, "get", "jobs", "-o", "name")).not.toContain("scp-runner-secretenv");
  }, 180_000);

  it("FAILURE PATH: a runner that exits non-zero leaves no Secret either", async () => {
    // THE COMMON CASE FOR managed-iac — a `tofu apply` a policy refused — so a credential lifetime
    // that only holds on success is a credential lifetime that mostly does not hold.
    const ns = harness.namespace;
    await kubectlIn(ns, "delete", "secret", "scp-runner-secretfail-env", "--ignore-not-found");
    const result = await launcher().run(
      spec({
        runId: "secretfail",
        labels: { "scp.run-id": "secretfail" },
        operands: ["/bin/sh", "-c", 'test -n "$AWS_SECRET_ACCESS_KEY" && exit 7'],
        secretEnv: [`AWS_SECRET_ACCESS_KEY=${CREDENTIAL}`]
      })
    );
    expect(result.succeeded).toBe(false);
    expect(result.failure!.kind).toBe("exit-nonzero");
    expect(result.failure!.code).toBe(7);
    // AND THE FAILURE RECORD IS CLEAN. This is the one that travels furthest — into a Decision row,
    // into an audit event, into a support ticket.
    expect(JSON.stringify(result.failure)).not.toContain(CREDENTIAL);
    expect(await kubectlIn(ns, "get", "secrets", "-o", "name")).not.toContain(
      "scp-runner-secretfail-env"
    );
  }, 180_000);

  it("THE LAUNCHER DYING MID-RUN: the API SERVER deletes the Secret, with no `finally` involved", async () => {
    // THE ONE THAT MATTERS, AND THE WHOLE REASON FOR THE ORDERING CHANGE. M23.1d's lesson is that no
    // `finally` survives a SIGKILL: the plugin host's hang detector kills a subprocess mid-`trigger()`
    // and nothing in that process runs again. Docker had no analogue for `ownerReferences`, so the
    // answer there had to be a sweep. Here the deletion is the cluster's obligation, and this case
    // proves it the only way that means anything — by taking the launcher out of the picture and
    // watching the Secret go anyway.
    //
    // THE JOB IS DELETED FROM OUTSIDE, which is what `ttlSecondsAfterFinished`, an operator's
    // `kubectl delete job`, and a SUCCESSOR process's `reap()` all reduce to. The launcher's own
    // teardown never runs against this object — its subsequent DELETE 404s, which is why the run's
    // rejection is caught and discarded.
    const ns = harness.namespace;
    await kubectlIn(ns, "delete", "secret", "scp-runner-sigkill-env", "--ignore-not-found");
    //
    // AND THE VACUITY THIS CASE HAS TO CLOSE: the launcher's OWN teardown would eventually delete
    // this Secret too, when the run ends. If the observation window overlapped that, the case would
    // pass whether or not the ownerReference existed. So the run is given a 30-SECOND budget, the
    // moment of the Job deletion is timed, and the collection must be observed in the FIRST HALF of
    // that budget — a window in which the launcher is provably still parked in its `start` poll and
    // has issued no DELETE at all. `settled` is the second half of the same guard.
    const RUN_BUDGET_MS = 30_000;
    let settled = false;
    const abandoned = launcher()
      .run(
        spec({
          runId: "sigkill",
          labels: { "scp.run-id": "sigkill" },
          operands: ["/bin/sh", "-c", 'test -n "$AWS_SECRET_ACCESS_KEY" && sleep 120'],
          secretEnv: [`AWS_SECRET_ACCESS_KEY=${CREDENTIAL}`],
          timeoutMs: RUN_BUDGET_MS
        })
      )
      .catch(() => undefined)
      .finally(() => {
        settled = true;
      });

    const live = await until(async () =>
      (await kubectlIn(ns, "get", "secrets", "-o", "name")).includes("scp-runner-sigkill-env")
    );
    expect(live, "the per-run Secret never existed, so its disappearance proves nothing").toBe(
      true
    );

    const deletedAt = Date.now();
    await kubectlIn(ns, "delete", "job", "scp-runner-sigkill", "--wait=false");

    // NOT AN IMMEDIATE READ. Garbage collection is asynchronous by design, and asserting "gone the
    // instant the Job DELETE returns" would be asserting an implementation detail of the collector
    // rather than the guarantee, which is that the credential's life is BOUNDED by the Job's.
    const collected = await until(
      async () =>
        !(await kubectlIn(ns, "get", "secrets", "-o", "name")).includes("scp-runner-sigkill-env"),
      RUN_BUDGET_MS / 2
    );
    expect(
      collected,
      "the per-run Secret outlived the Job that owned it. That is the M23.1d credential-lifetime defect, reappearing on the Kubernetes adapter and in a worse place than a mode-0600 file: etcd, and every etcd backup"
    ).toBe(true);

    // THE TWO GUARDS THAT MAKE THE DELETION THE CLUSTER'S AND NOT THE LAUNCHER'S.
    expect(
      settled,
      "the run had already finished when the Secret went, so its own teardown could have deleted it and this case proves nothing about ownerReferences"
    ).toBe(false);
    expect(
      Date.now() - deletedAt,
      `the Secret took longer than half the run's ${RUN_BUDGET_MS}ms budget to disappear, which puts the observation inside the window where the launcher's own teardown runs`
    ).toBeLessThan(RUN_BUDGET_MS / 2);

    await abandoned;
  }, 180_000);

  it("THE NON-VACUITY CONTROL: the same sweep FINDS a credential delivered the wrong way", async () => {
    // WITHOUT THIS CASE EVERY "not.toContain(CREDENTIAL)" ABOVE IS UNFALSIFIABLE. A typo in the
    // constant, a `kubectlIn` that silently returned "", a namespace with nothing in it — all three
    // produce a clean sweep. So: deliver the SAME value the way the port exists to prevent
    // (`env[].value`, which is what a fallback would do), run the identical probe, and require it to
    // HIT. If this case ever goes green-by-passing, the sweep is broken and the cases above are lies.
    const ns = harness.namespace;
    const leaky = launcher().run(
      spec({
        runId: "leakprobe",
        labels: { "scp.run-id": "leakprobe" },
        operands: ["/bin/sh", "-c", 'test -n "$AWS_SECRET_ACCESS_KEY" && sleep 6'],
        // THE WRONG DELIVERY, ON PURPOSE, AND ONLY HERE. `env` is plain `env[].value` on the pod
        // spec: readable by anyone with `get jobs`, and in etcd and every etcd backup. This is the
        // fallback the adapter REFUSES to make on its own.
        env: [`AWS_SECRET_ACCESS_KEY=${CREDENTIAL}`]
      })
    );
    const appeared = await until(async () =>
      (await kubectlIn(ns, "get", "jobs", "-o", "name")).includes("scp-runner-leakprobe")
    );
    expect(appeared, "the control run's Job never appeared").toBe(true);
    const surface = await readableSurface(ns);
    expect(
      surface,
      "the sweep did NOT find a credential that is sitting in plaintext on the pod spec. The probe is broken, and every 'the credential is nowhere' assertion in this file is therefore worthless"
    ).toContain(CREDENTIAL);
    await leaky;
  }, 180_000);

  it("`reap()` DELETES A FOREIGN, EXPIRED JOB AND LEAVES A LIVE ONE — against a real listing", async () => {
    const dead = "scp-runner-reap-dead";
    const live = "scp-runner-reap-live";
    for (const [name, deadline] of [
      [dead, new Date(Date.now() - 60_000).toISOString()],
      [live, new Date(Date.now() + 600_000).toISOString()]
    ] as const) {
      await kubectl(
        "create",
        "job",
        name,
        "--image",
        harness.runnerImage,
        "--",
        "/bin/sh",
        "-c",
        "sleep 300"
      );
      await kubectl("label", "job", name, `${RUNNER_LAUNCHER_OWNER_LABEL}=some-other-process`);
      await kubectl("annotate", "job", name, `${RUNNER_LAUNCHER_DEADLINE_ANNOTATION}=${deadline}`);
    }
    try {
      const removed = await launcher().reap();
      expect(removed).toContain(dead);
      expect(removed).not.toContain(live);
      const jobs = await kubectl("get", "jobs", "-o", "name");
      expect(jobs).not.toContain(dead);
      expect(jobs).toContain(live);
    } finally {
      await kubectl("delete", "job", live, "--wait=false").catch(() => undefined);
      await kubectl("delete", "job", dead, "--wait=false").catch(() => undefined);
      await rm(join(harness.workspaceHost, dead), { recursive: true, force: true });
    }
  }, 120_000);

  // ================================================================================================
  // M23.5 — THE POD SPEC, AND THE THREE VERDICTS A FAKE CANNOT PRODUCE
  // ================================================================================================

  it("PASS 20: THE SUITE HEALS THE DEBRIS A SIGTERM LEAVES — which `reap()` may not touch", async () => {
    /**
     * THE GATE FOR THE `beforeAll` SWEEP, and without it the sweep is a mechanism nothing pins:
     * every case in this file passes whether or not it runs, because a clean cluster has nothing to
     * sweep. So the debris is SEEDED, in the exact shape a killed run leaves it, and the two halves
     * are asserted separately.
     *
     * THE DEADLINE IS IN THE FUTURE, DELIBERATELY. `reap()` is fail-closed on the stamp — it must
     * be, because on a shared cluster a foreign Job inside its deadline is somebody's live `tofu
     * apply` — so `reap()` will never take this object, at any point, on any later run. That is the
     * arm that proves the sweep is doing work `reap()` cannot, rather than duplicating it: the
     * seeded Job is exactly what a SIGTERM at second 3 of a 120s run leaves behind.
     */
    const runId = "sigterm-debris";
    const jobName = runnerJobName(runId);
    const ns = harness.quotaNamespace;
    const stale = join(tmpdir(), "scp-kind-stale-from-a-killed-run");
    const staleWorkspace = join(harness.workspaceHost, jobName);

    await kubectlIn(
      ns,
      "create",
      "job",
      jobName,
      "--image",
      harness.runnerImage,
      "--",
      "/bin/sh",
      "-c",
      "sleep 300"
    );
    await kubectlIn(
      ns,
      "label",
      "job",
      jobName,
      `${RUNNER_LAUNCHER_OWNER_LABEL}=a-process-that-was-killed`
    );
    await kubectlIn(
      ns,
      "annotate",
      "job",
      jobName,
      `${RUNNER_LAUNCHER_DEADLINE_ANNOTATION}=${new Date(Date.now() + 3_600_000).toISOString()}`
    );
    await mkdir(join(staleWorkspace, "out"), { recursive: true });
    await writeFile(join(staleWorkspace, "out", "evidence.json"), "the PREVIOUS run's evidence");
    await mkdir(stale, { recursive: true });
    await writeFile(join(stale, "left-behind"), "x");

    try {
      // 1. `reap()` LEAVES IT — for the right reason, and forever.
      const reaped = await launcher({ quota: true }).reap();
      expect(reaped).not.toContain(jobName);
      expect(await kubectlIn(ns, "get", "jobs", "-o", "name")).toContain(jobName);

      // 2. THE SWEEP TAKES IT, and takes the workspace subtree with it.
      await sweepLeftoverRunnerObjects();
      expect(
        await kubectlIn(ns, "get", "jobs", "-o", "name"),
        "the sweep left the Job that makes the next `create` a 409"
      ).not.toContain(jobName);
      expect(await readdir(harness.workspaceHost)).not.toContain(jobName);

      // 3. AND THE PROOF THAT IT IS THE 409 THAT WAS HEALED: the name is usable again. This is the
      //    assertion the four measured red runs were failing.
      //    THE QUOTA NAMESPACE'S FULL CONVENTION SET, which is ROUTE 1b's verbatim — `limits.cpu`
      //    AND `limits.memory`. Measured the hard way: with `limits.memory` alone the admission
      //    refusal is "must specify limits.cpu", the Job creates no pod, and this arm polls its
      //    whole budget before failing for a reason that has nothing to do with the sweep.
      const result = await launcher({
        quota: true,
        pod: {
          resources: {
            requests: { cpu: "10m", memory: "16Mi" },
            limits: { cpu: "200m", memory: "64Mi" }
          }
        }
      }).run(spec({ runId, labels: { "scp.run-id": runId }, timeoutMs: 60_000 }));
      expect(
        result.succeeded,
        `the name was still held after the sweep: ${result.failure?.detail ?? ""}`
      ).toBe(true);

      // 4. THE SCRATCH SWEEP, and the one thing it must NOT take.
      const swept = await sweepStaleScratchDirs(scratch);
      expect(swept).toContain(stale);
      expect(await readdir(tmpdir())).not.toContain("scp-kind-stale-from-a-killed-run");
      expect(
        await readdir(scratch),
        "the sweep deleted the scratch directory the running suite is using"
      ).toBeDefined();
    } finally {
      await kubectlIn(ns, "delete", "job", jobName, "--ignore-not-found", "--wait=false").catch(
        () => undefined
      );
      await rm(stale, { recursive: true, force: true });
      await rm(staleWorkspace, { recursive: true, force: true });
    }
  }, 180_000);

  it("M23.5 HIGH-3: an UNSET imagePullPolicy is `Always` for `:latest` — the air-gap break, measured", async () => {
    // THE MEASUREMENT THAT STARTED THIS. The image is ALREADY ON THE NODE (the harness `kind load`s
    // it) and this cluster has no registry credentials and, for a `:latest` tag, no reason to
    // believe the local copy. Kubernetes defaults an unset `imagePullPolicy` to `Always` for
    // `:latest`, so the kubelet reaches for docker.io and the run dies before its entrypoint —
    // charter principle 5, broken in production, by an omission in a manifest builder.
    //
    // NOTHING ABOUT THIS IS VISIBLE TO A FAKE: it needs a kubelet, a node with an image on it, and a
    // registry it cannot reach.
    const latest = "scp-probe-runner:latest";
    await execFileAsync("docker", ["tag", harness.runnerImage, latest], {
      env: { ...process.env }
    });
    const archive = join(scratch, "latest.tar");
    // `--platform`, FOR THE REASON THE HARNESS SCRIPT ALREADY RECORDS AND THIS TEST RE-MEASURED:
    // `kind load image-archive` runs `ctr images import --all-platforms`, which fails on a
    // multi-arch archive with "content digest ... not found". The NODE's architecture, not the
    // shell's — the same source the harness reads, so the two cannot disagree.
    const { stdout: nodeArch } = await execFileAsync(
      "kubectl",
      ["get", "nodes", "-o", "jsonpath={.items[0].status.nodeInfo.architecture}"],
      { env: { ...process.env, KUBECONFIG: harness.kubeconfig } }
    );
    await execFileAsync("docker", [
      "save",
      "--platform",
      `linux/${nodeArch.trim()}`,
      "-o",
      archive,
      latest
    ]);
    // NOT SWALLOWED. If this load silently failed the image would genuinely be absent, arm (a) would
    // still see `ErrImagePull` — for the wrong reason — and arm (b) would fail with no explanation.
    // The whole claim is "the image IS on the node", so it is asserted, not hoped for.
    await execFileAsync("kind", ["load", "image-archive", archive, "--name", harness.cluster]);
    const { stdout: onNode } = await execFileAsync("docker", [
      "exec",
      `${harness.cluster}-control-plane`,
      "crictl",
      "images"
    ]);
    expect(
      onNode,
      "the probe image is NOT on the node, so this case would measure a missing image rather than a pull policy"
    ).toContain("scp-probe-runner");

    // (a) WITHOUT the convention: the pull is attempted and fails.
    const without = await launcher().run(
      spec({
        runId: "pullpolicy-unset",
        labels: { "scp.run-id": "pullpolicy-unset" },
        image: latest,
        timeoutMs: 60_000
      })
    );
    expect(without.succeeded).toBe(false);
    expect(without.failure!.kind).toBe("spawn-failed");
    expect(without.failure!.detail).toMatch(/ErrImagePull|ImagePullBackOff/);

    // (b) WITH the chart's own `IfNotPresent` — the value five other pods in this chart already get
    //     — the identical image on the identical node runs.
    const withPolicy = await launcher({ pod: { imagePullPolicy: "IfNotPresent" } }).run(
      spec({
        runId: "pullpolicy-set",
        labels: { "scp.run-id": "pullpolicy-set" },
        image: latest,
        timeoutMs: 60_000
      })
    );
    expect(
      withPolicy.succeeded,
      `imagePullPolicy=IfNotPresent did not make the on-node image usable: ${withPolicy.failure?.detail ?? ""}`
    ).toBe(true);
    expect(withPolicy.stdout).toContain("hello-from-the-runner");
  }, 300_000);

  it("M23.5 HIGH-3: the API SERVER ACCEPTS the conventions — pull secrets, policy and resources land on the pod", async () => {
    // A GOLDEN PROVES WHAT IS SENT; ONLY AN API SERVER PROVES IT IS ACCEPTED. A mistyped
    // `resources` or a malformed `imagePullSecrets` is a 422 that is invisible until production —
    // which is item 1 of this file's own list of what it exists for.
    const result = await launcher({
      pod: {
        // A Secret that does not exist. The kubelet WARNS and carries on when an imagePullSecret is
        // missing and the image is already present, which is exactly what makes this a safe way to
        // prove the field is ACCEPTED without standing up a registry.
        imagePullSecrets: ["not-a-real-registry-credential"],
        imagePullPolicy: "IfNotPresent",
        resources: { requests: { cpu: "10m", memory: "16Mi" }, limits: { memory: "64Mi" } }
      }
    }).run(
      spec({ runId: "conventions", labels: { "scp.run-id": "conventions" }, timeoutMs: 120_000 })
    );
    expect(
      result.succeeded,
      `the API server or the kubelet rejected the pod conventions: ${result.failure?.detail ?? ""}`
    ).toBe(true);
  }, 180_000);

  it("M23.5 HIGH-4 ROUTE 1: a ResourceQuota rejects the pod CREATE — `spawn-failed`, with the quota's own words", async () => {
    // THE ROUTE NO FAKE CAN PRODUCE AND THE WHOLE REASON THE THIRD NAMESPACE EXISTS. The Job is
    // ACCEPTED and unsuspended; the Job CONTROLLER then tries to create a pod and admission refuses
    // it, so no pod is ever created. `kubernetesTermination` reads `pod.status.containerStatuses`
    // and nothing else, so before M23.5 the adapter polled to the whole-run deadline and reported
    // `budget-exhausted` — "a `tofu apply` was SIGTERMed mid-flight, so the real infrastructure
    // state is unknown" — for a run in which NOTHING RAN. The refusal's only record is the
    // controller's `FailedCreate` Event, and teardown deletes the Job.
    const result = await launcher({ quota: true }).run(
      spec({ runId: "quota-refused", labels: { "scp.run-id": "quota-refused" }, timeoutMs: 20_000 })
    );
    expect(result.succeeded).toBe(false);
    expect(
      result.failure!.kind,
      `the quota-rejected run was classified ${result.failure!.kind}: ${result.failure!.detail}`
    ).toBe("spawn-failed");
    // AND THE BOUND IS REPORTED AS IT WAS — M23.5 verification pass 20. This run really did poll to
    // its 20s deadline, so `true` is the fact; `spawn-failed` is what the producer DECLARED about
    // the runner, and `classifyRunnerFailure` now reads that declaration ahead of the flag instead
    // of relying on the flag being suppressed. The assertion here was `false` while the run's own
    // message named the budget, which is the contradiction pass 20 removed.
    expect(result.failure!.deadlineExceeded).toBe(true);
    // THE API SERVER'S OWN SENTENCE, read off the Job's events before teardown deleted them.
    expect(result.failure!.detail).toMatch(/quota/i);
    expect(result.failure!.detail).toContain("NOTHING RAN");
  }, 180_000);

  it("M23.5 HIGH-4 ROUTE 1b: the SAME quota namespace SUCCEEDS once the deployment states its resources", async () => {
    // THE NON-VACUITY CONTROL FOR THE CASE ABOVE, and the two halves of M23.5 meeting in one
    // namespace. Without this arm the quota case proves only "this namespace is broken"; with it,
    // the quota is what it really is — a deployment that had no way to declare limits, and now has
    // one. Identical namespace, identical spec, one convention supplied.
    const result = await launcher({
      quota: true,
      pod: {
        resources: {
          requests: { cpu: "10m", memory: "16Mi" },
          limits: { cpu: "200m", memory: "64Mi" }
        }
      }
    }).run(
      spec({
        runId: "quota-satisfied",
        labels: { "scp.run-id": "quota-satisfied" },
        timeoutMs: 120_000
      })
    );
    expect(
      result.succeeded,
      `the run still failed under the quota with resources declared: ${result.failure?.detail ?? ""}`
    ).toBe(true);
    expect(result.stdout).toContain("hello-from-the-runner");
  }, 180_000);

  it("M23.5 HIGH-4 ROUTE 2: an unschedulable pod reports the SCHEDULER's reason, not a budget verdict", async () => {
    // A pod that exists, has NO `containerStatuses` at all, and cannot be placed. This is also the
    // shape of an unbound RWX claim — the failure `assertRunnerPrerequisites` refuses a render to
    // pre-empt, arriving at run time because a claim that is NAMED can still be unbindable.
    const result = await launcher({
      pod: { resources: { requests: { memory: "100000Gi" } } }
    }).run(
      spec({
        runId: "unschedulable",
        labels: { "scp.run-id": "unschedulable" },
        // POLLS TO THE DEADLINE ON PURPOSE — the verdict under test is the one produced when the
        // budget runs out and nothing ever started, so the case has to actually reach it. Kept
        // short because the wait IS the test's cost.
        timeoutMs: 20_000
      })
    );
    expect(result.succeeded).toBe(false);
    expect(
      result.failure!.kind,
      `the unschedulable run was classified ${result.failure!.kind}: ${result.failure!.detail}`
    ).toBe("spawn-failed");
    expect(result.failure!.detail).toContain("Unschedulable");
    expect(result.failure!.detail).toContain("NOTHING RAN");
  }, 180_000);

  it("M23.5 HIGH-4 ROUTE 3: the pod deleted mid-run is `signalled`, and it says it was not our budget", async () => {
    // THE ONE ROUTE WHERE SOMETHING DID RUN — a node drain, an eviction — and the reason the
    // `everStarted` flag exists rather than being re-derived from whatever is left. Reporting this
    // as `spawn-failed` would claim nothing was mutated, which is the OPPOSITE lie to the one being
    // fixed. Measured rather than assumed: with `backoffLimit: 0` a deleted pod really does make the
    // Job report `Failed`/`BackoffLimitExceeded` rather than creating a replacement.
    const runId = "drained";
    const running = launcher().run(
      spec({
        runId,
        labels: { "scp.run-id": runId },
        operands: ["/bin/sh", "-c", "echo started; sleep 300"],
        timeoutMs: 120_000
      })
    );
    // Wait for the pod to be RUNNING — the fact the verdict turns on — then delete it.
    const deadline = Date.now() + 90_000;
    for (;;) {
      const phases = await kubectl(
        "get",
        "pods",
        "-l",
        `scp.launcher.run-id=${runId}`,
        "-o",
        "jsonpath={.items[*].status.phase}"
      );
      if (phases.includes("Running")) break;
      if (Date.now() > deadline) throw new Error(`pod for ${runId} never reached Running`);
      await new Promise((r) => setTimeout(r, 1_000));
    }
    await kubectl("delete", "pods", "-l", `scp.launcher.run-id=${runId}`, "--wait=false");

    const result = await running;
    expect(result.succeeded).toBe(false);
    expect(
      result.failure!.kind,
      `the drained run was classified ${result.failure!.kind}: ${result.failure!.detail}`
    ).toBe("signalled");
    expect(result.failure!.deadlineExceeded).toBe(false);
    expect(result.failure!.detail).toContain("NOT this run's own budget");
  }, 240_000);

  it("M23.5 PASS 18: NEVER OBSERVED — a REAL container runs and mutates while the launcher is blind", async () => {
    /**
     * THE PROBE THAT FOUND THE DEFECT, KEPT AS A GATE — and only a real cluster can run it, because
     * the whole point is that the Job, the pod, the kubelet and the volume are real while the
     * LAUNCHER'S VIEW of them is not.
     *
     * WHAT IS FAKED IS EXACTLY ONE THING: the pod reads never land. That is an API-server stall or a
     * partition, and it is the shape measured in the field. Everything else is real — the unsuspend
     * PATCH reaches the real API server and succeeds, the real Job controller creates a real pod,
     * the real kubelet pulls and runs the real container, and the container writes a REAL FILE to
     * the REAL shared volume, which this test reads off the disk as ground truth.
     *
     * WHAT THE LAUNCHER USED TO RECORD FOR THIS RUN:
     *   kind=spawn-failed code=RunnerContainerNeverStarted deadlineExceeded=false
     *   spawn-failed: the container CLI could not be executed at all — nothing ran … so NOTHING RAN
     *   and nothing was mutated — the Job had not yet been observed
     * with `marker.txt` on the volume saying `THE-RUNNER-RAN-AND-MUTATED`. The clause that disproves
     * the sentence is inside the sentence.
     */
    const runId = "never-observed";
    const slotDir = join(harness.workspaceHost, runnerJobName(runId), "m0");
    const markerOnVolume = join(slotDir, "marker.txt");

    const inDir = join(scratch, "never-observed-in");
    await execFileAsync("mkdir", ["-p", inDir]);
    await writeFile(join(inDir, "seed.txt"), "seed", "utf8");

    // GROUND TRUTH, SAMPLED WHILE THE RUN IS ALIVE. Teardown removes this run's subtree from the
    // shared volume — that is correct and unconditional — so the marker is watched for rather than
    // looked for afterwards. What it proves is not affected: the bytes were on the volume, written
    // by a container, during the window in which the launcher was recording that nothing ran.
    let markerContents: string | undefined;
    let watching = true;
    const watcher = (async () => {
      while (watching) {
        try {
          markerContents = (await readFile(markerOnVolume, "utf8")).trim();
          return;
        } catch {
          await new Promise((r) => setTimeout(r, 200));
        }
      }
    })();

    const real = io();
    const blind: KubernetesRunnerIo = {
      ...real,
      request: async (req) => {
        if (
          req.method === "GET" &&
          req.path.startsWith(`/api/v1/namespaces/${harness.namespace}/pods?`)
        ) {
          // CONSUMES THE BOUND IT WAS HANDED AND THEN REJECTS — `AbortSignal.timeout` firing,
          // which is what the shipped transport does when nothing answers.
          await new Promise((r) => setTimeout(r, req.timeoutMs + 50));
          throw new Error("The operation was aborted due to timeout");
        }
        return real.request(req);
      }
    };

    const result = await createKubernetesRunnerLauncher({
      namespace: harness.namespace,
      workspaceRoot: harness.workspaceHost,
      workspaceVolume: { kind: "hostPath", path: harness.nodeWorkspace },
      perRunSecrets: true,
      runAsNonRoot: false,
      pollIntervalMs: 500,
      io: blind
    }).run(
      spec({
        runId,
        labels: { "scp.run-id": runId },
        // WRITES, THEN KEEPS RUNNING — a `tofu apply` in flight, which is the case the sentence
        // under test is read in.
        operands: [
          "/bin/sh",
          "-c",
          "echo THE-RUNNER-RAN-AND-MUTATED > /work/out/marker.txt; sleep 300"
        ],
        copyIn: [{ hostDir: inDir, containerPath: "/work/out" }],
        timeoutMs: 25_000
      })
    );
    watching = false;
    await watcher;

    // ---- GROUND TRUTH FIRST. Without this the assertions below are about a fixture. -------------
    expect(
      markerContents,
      "the runner never wrote its marker to the shared volume, so this case did not exercise the " +
        "defect at all — it must FAIL rather than pass vacuously"
    ).toBe("THE-RUNNER-RAN-AND-MUTATED");

    // ---- AND NOW THE SENTENCE THE OPERATOR READS ABOUT THAT SAME RUN. --------------------------
    expect(result.succeeded).toBe(false);
    const detail = result.failure!.detail;
    expect(
      result.failure!.kind,
      `a run that mutated was classified ${result.failure!.kind}: ${detail}`
    ).toBe("outcome-unknown");
    // THE THREE CLAIMS THE RECORD MAY NOT MAKE, measured against a container that did run.
    expect(detail).not.toContain("NOTHING RAN");
    expect(detail).not.toContain("nothing was mutated");
    expect(detail).not.toContain("could not be executed at all");
    // AND THE ONE IT MUST.
    expect(detail).toContain("is NOT KNOWN");
    expect(detail).toContain("Check the target's real state before re-running");

    // TEARDOWN STILL REACHED THE REAL OBJECTS — the verdict changed, the obligation did not.
    expect(await kubectl("get", "jobs", "-o", "name")).not.toContain(runnerJobName(runId));
  }, 180_000);

  it("PASS 19: OBSERVED ONCE, THEN BLIND — one useless read still says NOTHING RAN", async () => {
    /**
     * THE SAME DEFECT, THROUGH THE ARM PASS 18 LEFT STANDING. Pass 18 split `!everStarted` into
     * "never observed" (arm 6, `outcome-unknown`) and "observed, nothing had started" (arm 7,
     * `spawn-failed`, "NOTHING RAN and nothing was mutated"). It moved the boundary to WHETHER a
     * read landed and not to WHEN it landed or WHAT it said.
     *
     * So: let exactly ONE `GET pods` through — the one the adapter issues immediately after the
     * unsuspend, before the Job controller has created a pod — and stall every read after it. The
     * observation is real, it is 25 seconds stale by the deadline, and it says only "not yet".
     * `kubernetesStartVerdict` reaches arm 7 and the record says the run never started.
     *
     * ONLY A REAL CLUSTER CAN JUDGE IT, for the same reason as the case above: the Job, the pod, the
     * kubelet, the container and the file are real; only the launcher's view of them is not.
     */
    const runId = "observed-once";
    const slotDir = join(harness.workspaceHost, runnerJobName(runId), "m0");
    const markerOnVolume = join(slotDir, "marker.txt");

    const inDir = join(scratch, "observed-once-in");
    await execFileAsync("mkdir", ["-p", inDir]);
    await writeFile(join(inDir, "seed.txt"), "seed", "utf8");

    let markerContents: string | undefined;
    let watching = true;
    const watcher = (async () => {
      while (watching) {
        try {
          markerContents = (await readFile(markerOnVolume, "utf8")).trim();
          return;
        } catch {
          await new Promise((r) => setTimeout(r, 200));
        }
      }
    })();

    const real = io();
    /** WHAT THE ONE LANDED READ ACTUALLY SAW — recorded, so the case cannot pass vacuously by
     *  having observed a pod that was already running. */
    let firstPodRead = "";
    let through = 0;
    const blindAfterOne: KubernetesRunnerIo = {
      ...real,
      request: async (req) => {
        if (
          req.method === "GET" &&
          req.path.startsWith(`/api/v1/namespaces/${harness.namespace}/pods?`)
        ) {
          if (through > 0) {
            await new Promise((r) => setTimeout(r, req.timeoutMs + 50));
            throw new Error("The operation was aborted due to timeout");
          }
          through += 1;
          const res = await real.request(req);
          firstPodRead = res.body;
          return res;
        }
        return real.request(req);
      }
    };

    const result = await createKubernetesRunnerLauncher({
      namespace: harness.namespace,
      workspaceRoot: harness.workspaceHost,
      workspaceVolume: { kind: "hostPath", path: harness.nodeWorkspace },
      perRunSecrets: true,
      runAsNonRoot: false,
      pollIntervalMs: 500,
      io: blindAfterOne
    }).run(
      spec({
        runId,
        labels: { "scp.run-id": runId },
        operands: [
          "/bin/sh",
          "-c",
          "echo THE-RUNNER-RAN-AND-MUTATED > /work/out/marker.txt; sleep 300"
        ],
        copyIn: [{ hostDir: inDir, containerPath: "/work/out" }],
        timeoutMs: 25_000
      })
    );
    watching = false;
    await watcher;

    // ---- THE READ THAT LANDED SAID NOTHING CONCLUSIVE. -----------------------------------------
    expect(through, "the pass-through read never happened, so this case tests nothing").toBe(1);
    expect(
      firstPodRead,
      `the one landed read already showed a started container, so this case did not exercise the ` +
        `arm at all: ${firstPodRead}`
    ).not.toContain('"running"');

    // ---- GROUND TRUTH. -------------------------------------------------------------------------
    expect(
      markerContents,
      "the runner never wrote its marker to the shared volume, so this case did not exercise the " +
        "defect at all — it must FAIL rather than pass vacuously"
    ).toBe("THE-RUNNER-RAN-AND-MUTATED");

    // ---- AND THE SENTENCE THE OPERATOR READS. --------------------------------------------------
    expect(result.succeeded).toBe(false);
    const detail = result.failure!.detail;
    expect(
      result.failure!.kind,
      `a run that mutated was classified ${result.failure!.kind}: ${detail}`
    ).toBe("outcome-unknown");
    expect(detail).not.toContain("NOTHING RAN");
    expect(detail).not.toContain("nothing was mutated");
    expect(detail).toContain("is NOT KNOWN");
  }, 180_000);
});
