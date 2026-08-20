import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { beforeAll, describe, expect, it } from "vitest";
import {
  LAUNCHER_OWNER_ID,
  RUNNER_LAUNCHER_DEADLINE_ANNOTATION,
  RUNNER_LAUNCHER_OWNER_LABEL,
  createFetchKubernetesIo,
  createKubernetesRunnerLauncher,
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
  namespace: string;
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

function io(): KubernetesRunnerIo {
  return createFetchKubernetesIo({
    apiBase: harness.apiBase,
    readToken: async () => harness.token,
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

function launcher(over: { perRunSecrets?: boolean; runAsNonRoot?: boolean } = {}) {
  return createKubernetesRunnerLauncher({
    namespace: harness.namespace,
    workspaceRoot: harness.workspaceHost,
    workspaceVolume: { kind: "hostPath", path: harness.nodeWorkspace },
    perRunSecrets: over.perRunSecrets === true,
    runAsNonRoot: over.runAsNonRoot === true,
    pollIntervalMs: 500,
    io: io()
  });
}

/** `kubectl` against the harness cluster, for the assertions the adapter itself must not make. */
async function kubectl(...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("kubectl", ["-n", harness.namespace, ...args], {
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

let scratch: string;

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
}, 60_000);

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
    // THE NEGATIVE CONTROL. Every assertion above is "the answer was yes", which is also what a
    // broken `canI` that always returned "yes" would produce, and what a `--as` that silently fell
    // back to the cluster-admin kubeconfig would produce too. `secrets` is the one thing the chart
    // does NOT grant unless `managedRunners.kubernetes.perRunSecrets` is set, and the harness leaves
    // it unset — so this must be "no", and its being "no" is what makes the yeses mean something.
    expect(
      await canI("create", "secrets", sa),
      "the runner Role grants `secrets: create` with perRunSecrets off — the declared-and-disabled capability is not disabled"
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
});
