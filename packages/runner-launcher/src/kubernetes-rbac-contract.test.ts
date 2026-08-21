import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  LAUNCHER_OWNER_ID,
  RUNNER_LAUNCHER_DEADLINE_ANNOTATION,
  RUNNER_LAUNCHER_OWNER_LABEL,
  createKubernetesRunnerLauncher,
  kubernetesRbacKey,
  kubernetesRbacRequirement,
  kubernetesRunnerRbac
} from "./index.js";
import type {
  KubernetesApiRequest,
  KubernetesApiResponse,
  KubernetesRbacRule,
  KubernetesRunnerIo,
  RunnerSpec
} from "./index.js";

/**
 * ================================================================================================
 * M23.6 CLAUSE 5 — WHAT THE ADAPTER ASKS THE API SERVER FOR, DERIVED FROM RUNNING IT
 * ================================================================================================
 *
 * `kubernetesRunnerRbac()` is a DECLARATION, and a declaration on its own is prose with a type.
 * This file holds it to the code: it drives the adapter across every route it has, over a recording
 * io, maps each `(method, path)` that ACTUALLY REACHED THE WIRE onto the Kubernetes verb the
 * authorizer would require, and asserts the derived set EQUALS the declaration. `tools/helm-verify`
 * then asserts the RENDERED ROLE equals the same declaration. Three things agree, or the build is
 * red — and the diff fails in BOTH directions, which is the half M23.6's clause 5 was missing.
 *
 * WHY BOTH DIRECTIONS ARE THE POINT. Before this, helm-verify checked `batch/jobs` with
 * `JSON.stringify(rules).includes('"patch"')`, `events` and `secrets` with a set-equality, and
 * `pods`/`pods/log` not at all. Measured against that gate: adding four UNUSED verbs to the chart
 * (`jobs: +deletecollection,+update`; `pods,pods/log: +delete,+create`) left helm-verify green,
 * `pnpm -w test` green (72/72) and the kind suite green (21/21). A gate that only catches a MISSING
 * verb lets a privilege drift wider forever.
 *
 * AND IT HAD ALREADY DRIFTED. The shipped Role granted `watch` on `batch/jobs` and on
 * `pods,pods/log` — inherited from M8's reference shape — while `KUBERNETES_POLL_INTERVAL_MS`'s own
 * doc says "A POLL AND NOT A WATCH, deliberately" and there is no `watch=` query anywhere in the
 * adapter. It also collapsed `pods` and `pods/log` into ONE rule, which grants each the other's
 * verbs: `get` on `pods` and `list` on `pods/log`, neither ever issued.
 *
 * THE CENSUS SLOT AT THE BOTTOM is what stops this file being a test of the routes it happens to
 * know about. Every request this adapter can issue is built from a `method: "<VERB>"` literal; the
 * count and multiset of those literals is pinned, so a NEW call site — the one this matrix would
 * not drive — fails here by count before it can reach a cluster with no grant behind it.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const NAMESPACE = "scp";
const WORKSPACE_ROOT = "/scp-workspace";

/** One `(method, path)` pair, exactly as it left the adapter. */
interface Wire {
  method: string;
  path: string;
}

/**
 * A recording io over a minimal stateful cluster. Deliberately NOT a canned response list: the
 * adapter POSTs a Job and then PATCHes and DELETEs it BY NAME, and a list cannot notice being asked
 * about a name it never issued.
 */
function recorder(opts: { podAppears: boolean; foreignPastDeadline?: boolean }) {
  const wire: Wire[] = [];
  const jobs = new Map<string, Record<string, unknown>>();
  const secrets = new Set<string>();
  let uid = 0;

  const jobsRoot = `/apis/batch/v1/namespaces/${NAMESPACE}/jobs`;
  const secretsRoot = `/api/v1/namespaces/${NAMESPACE}/secrets`;
  const podsRoot = `/api/v1/namespaces/${NAMESPACE}/pods`;
  const eventsRoot = `/api/v1/namespaces/${NAMESPACE}/events`;

  /** A peer's Job, past its stamped deadline — the only thing `reap()` may destroy, and the reason
   *  the sweep's DELETE verbs appear in the derived set at all. */
  const foreign = {
    metadata: {
      name: "scp-runner-someone-elses",
      uid: "uid-foreign",
      labels: { [RUNNER_LAUNCHER_OWNER_LABEL]: "a-different-launcher" },
      annotations: { [RUNNER_LAUNCHER_DEADLINE_ANNOTATION]: new Date(Date.now() - 60_000).toISOString() }
    }
  };

  const route = (req: KubernetesApiRequest): KubernetesApiResponse => {
    const path = req.path.split("?")[0]!;
    if (req.method === "GET" && path === jobsRoot) {
      const items = [...jobs.values()];
      if (opts.foreignPastDeadline) items.push(foreign);
      return { status: 200, body: JSON.stringify({ items }) };
    }
    if (req.method === "POST" && path === jobsRoot) {
      const body = req.body as { metadata: { name: string } };
      uid += 1;
      const stamped = {
        ...(body as Record<string, unknown>),
        metadata: { ...(body.metadata as Record<string, unknown>), uid: `uid-${uid}` }
      };
      jobs.set(body.metadata.name, stamped);
      return { status: 201, body: JSON.stringify(stamped) };
    }
    if (req.method === "POST" && path === secretsRoot) {
      const body = req.body as { metadata: { name: string } };
      secrets.add(body.metadata.name);
      return { status: 201, body: JSON.stringify(body) };
    }
    if (req.method === "GET" && path.startsWith(`${jobsRoot}/`)) {
      const job = jobs.get(path.slice(jobsRoot.length + 1));
      return job
        ? { status: 200, body: JSON.stringify(job) }
        : { status: 404, body: JSON.stringify({ reason: "NotFound" }) };
    }
    if (req.method === "PATCH" && path.startsWith(`${jobsRoot}/`)) {
      return { status: 200, body: "{}" };
    }
    if (req.method === "DELETE" && path.startsWith(`${jobsRoot}/`)) {
      jobs.delete(path.slice(jobsRoot.length + 1));
      return { status: 200, body: "{}" };
    }
    if (req.method === "DELETE" && path.startsWith(`${secretsRoot}/`)) {
      secrets.delete(path.slice(secretsRoot.length + 1));
      return { status: 200, body: "{}" };
    }
    if (req.method === "GET" && path === eventsRoot) return { status: 200, body: '{"items":[]}' };
    if (req.method === "GET" && path === podsRoot) {
      const pod = opts.podAppears
        ? [
            {
              metadata: { name: "scp-runner-r1-abcde" },
              status: {
                phase: "Succeeded",
                containerStatuses: [{ name: "runner", state: { terminated: { exitCode: 0 } } }]
              }
            }
          ]
        : [];
      return { status: 200, body: JSON.stringify({ items: pod }) };
    }
    if (req.method === "GET" && path.endsWith("/log")) return { status: 200, body: "ok" };
    return { status: 404, body: JSON.stringify({ reason: "NotFound" }) };
  };

  const io: KubernetesRunnerIo = {
    request: (req) => {
      wire.push({ method: req.method, path: req.path });
      return Promise.resolve(route(req));
    },
    copyDir: () => Promise.resolve(),
    removeDir: () => Promise.resolve()
  };
  return { io, wire };
}

function launcher(
  io: KubernetesRunnerIo,
  perRunSecrets: boolean,
  over: { pollIntervalMs?: number; realSleep?: boolean } = {}
) {
  return createKubernetesRunnerLauncher({
    namespace: NAMESPACE,
    workspaceRoot: WORKSPACE_ROOT,
    workspaceVolume: { kind: "persistentVolumeClaim", claimName: "scp-runner-workspace" },
    perRunSecrets,
    runAsNonRoot: false,
    pollIntervalMs: over.pollIntervalMs ?? 1,
    // A REAL SLEEP FOR THE POLLING ROUTE, and it is not politeness. With `sleep` stubbed the poll
    // loop spins as fast as the event loop allows until the wall clock passes the deadline, which
    // issues tens of thousands of requests for a route whose whole content is "four distinct
    // shapes". The derived SET is identical either way; the cost is not.
    sleep: over.realSleep === true ? (ms) => new Promise<void>((r) => setTimeout(r, ms)) : () => Promise.resolve(),
    io
  });
}

function spec(over: Partial<RunnerSpec> = {}): RunnerSpec {
  return {
    runId: "r1",
    labels: { "scp.run-id": "r1" },
    image: "ghcr.io/commanderscp/scp-runner-iac:pinned",
    operands: ["plan"],
    networkMode: "none",
    env: ["A=1"],
    secretEnv: ["TOKEN=shhh"],
    copyIn: [{ hostDir: "/host/in", containerPath: "/work/in" }],
    copyOut: {
      containerPath: "/work/out",
      hostDir: "/host/out",
      when: "on-success",
      onFailure: "swallow"
    },
    timeoutMs: 60_000,
    maxBuffer: 8 * 1024 * 1024,
    ...over
  };
}

/** Collapse a wire log into the RBAC rules it requires, failing loudly on a path nothing maps. */
function requiredRules(wire: readonly Wire[]): KubernetesRbacRule[] {
  const byKey = new Map<string, { apiGroup: "" | "batch"; resource: string; verbs: Set<string> }>();
  const unmapped: string[] = [];
  for (const { method, path } of wire) {
    const need = kubernetesRbacRequirement(method, path);
    if (need === null) {
      unmapped.push(`${method} ${path}`);
      continue;
    }
    const key = kubernetesRbacKey(need);
    const slot = byKey.get(key) ?? { apiGroup: need.apiGroup, resource: need.resource, verbs: new Set<string>() };
    slot.verbs.add(need.verb);
    byKey.set(key, slot);
  }
  // AN UNRECOGNISED PATH IS A FAILURE, NOT AN EXCUSE. Silently skipping one would make this whole
  // derivation shrink to whatever the mapper happens to understand, which is how a set-equality gate
  // becomes decoration.
  expect(unmapped, "the requirement mapper did not recognise a path the adapter issued").toStrictEqual([]);
  return [...byKey.values()]
    .map((r) => ({ apiGroup: r.apiGroup, resource: r.resource, verbs: [...r.verbs].sort() }))
    .sort((a, b) => kubernetesRbacKey(a).localeCompare(kubernetesRbacKey(b)));
}

function sortedDeclaration(perRunSecrets: boolean): KubernetesRbacRule[] {
  return kubernetesRunnerRbac({ perRunSecrets })
    .map((r) => ({ apiGroup: r.apiGroup, resource: r.resource, verbs: [...r.verbs].sort() }))
    .sort((a, b) => kubernetesRbacKey(a).localeCompare(kubernetesRbacKey(b)));
}

/** Every route the adapter has, driven for real, with the wire logs concatenated. */
async function driveEveryRoute(perRunSecrets: boolean): Promise<Wire[]> {
  const wire: Wire[] = [];

  // ROUTE 1 — a whole successful run: the Secret POST, the Job POST, the unsuspend PATCH, the pod
  // list, the log read, and the teardown's two DELETEs.
  // `secretEnv` is populated ONLY when the deployment has the grant: with `perRunSecrets: false` the
  // adapter REFUSES the run rather than falling back to `env[].value`, which is the correct
  // behaviour and would drive no routes at all.
  const secretEnv = perRunSecrets ? ["TOKEN=shhh"] : [];
  const happy = recorder({ podAppears: true });
  const okResult = await launcher(happy.io, perRunSecrets).run(spec({ secretEnv }));
  expect(okResult.succeeded, "the happy route must actually succeed or it drove nothing").toBe(true);
  wire.push(...happy.wire);

  // ROUTE 2 — a run whose Job never produces a pod. This is the ONLY route that reads the Job's own
  // status and the Job's events, and it is the diagnosis path M23.5 added the `events` grant for.
  const noPod = recorder({ podAppears: false });
  const failed = await launcher(noPod.io, perRunSecrets, {
    pollIntervalMs: 50,
    realSleep: true
  }).run(spec({ runId: "r2", timeoutMs: 400, secretEnv }));
  expect(failed.succeeded, "the no-pod route must fail or it drove the happy path twice").toBe(false);
  wire.push(...noPod.wire);

  // ROUTE 3 — a reap pass over a peer's past-deadline Job: the labelled collection LIST, and the
  // sweep's own Job and Secret DELETEs.
  const sweep = recorder({ podAppears: true, foreignPastDeadline: true });
  const removed = await launcher(sweep.io, perRunSecrets).reap();
  expect(removed, "the sweep removed nothing, so its DELETE verbs were never derived").toContain(
    "scp-runner-someone-elses"
  );
  wire.push(...sweep.wire);

  return wire;
}

describe("M23.6 clause 5: the RBAC declaration is derived from running the adapter, not asserted", () => {
  it("the recorder is not a mock of the adapter — the owner id it compares against is this process's", () => {
    // Non-vacuity for ROUTE 3: if `LAUNCHER_OWNER_ID` ever equalled the fixture's owner label the
    // sweep would skip the Job and the DELETEs would silently leave the derived set.
    expect(LAUNCHER_OWNER_ID).not.toBe("a-different-launcher");
  });

  it("WITH per-run Secrets ON, the verbs the adapter ISSUES are exactly the ones it DECLARES", async () => {
    const derived = requiredRules(await driveEveryRoute(true));
    expect(derived).toStrictEqual(sortedDeclaration(true));
    // …and the derivation is not empty for a reason that has nothing to do with the adapter.
    expect(derived.map((r) => kubernetesRbacKey(r))).toStrictEqual([
      "batch/jobs",
      "core/events",
      "core/pods",
      "core/pods/log",
      "core/secrets"
    ]);
  });

  it("WITH per-run Secrets OFF, `secrets` leaves BOTH the declaration and the wire", async () => {
    const derived = requiredRules(await driveEveryRoute(false));
    expect(derived).toStrictEqual(sortedDeclaration(false));
    expect(derived.map((r) => kubernetesRbacKey(r))).not.toContain("core/secrets");
  });

  it("NO `watch`, ANYWHERE — the adapter polls, deliberately, and the Role used to grant it", async () => {
    // The narrowing this clause paid for, stated as its own assertion so it cannot be lost inside a
    // set comparison somebody later loosens. There is no watch stream in this adapter; a Role that
    // grants one is granting a capability nothing uses.
    for (const rule of kubernetesRunnerRbac({ perRunSecrets: true })) {
      expect(rule.verbs, `${kubernetesRbacKey(rule)} declares 'watch'`).not.toContain("watch");
    }
    const source = readFileSync(resolve(__dirname, "kubernetes-adapter.ts"), "utf8");
    expect(source.includes("watch=true"), "a watch query appeared in the adapter").toBe(false);
    const wire = await driveEveryRoute(true);
    expect(wire.filter((w) => w.path.includes("watch="))).toStrictEqual([]);
  });

  it("`pods` and `pods/log` are TWO resources — collapsing them grants each the other's verbs", async () => {
    const derived = requiredRules(await driveEveryRoute(true));
    const pods = derived.find((r) => r.resource === "pods")!;
    const log = derived.find((r) => r.resource === "pods/log")!;
    // The pod is only ever found by label selector over the collection, and the log is only ever a
    // subresource GET on one pod. One shared verb list grants `get` on pods and `list` on pods/log.
    expect(pods.verbs).toStrictEqual(["list"]);
    expect(log.verbs).toStrictEqual(["get"]);
  });

  it("the mapper distinguishes a COLLECTION read from a NAMED read — the whole basis of the split", () => {
    // The mapper decides every verb above, so its own behaviour is asserted directly rather than
    // inferred from the fact that the comparison passed.
    expect(kubernetesRbacRequirement("GET", "/api/v1/namespaces/scp/pods?labelSelector=x")).toStrictEqual({
      apiGroup: "",
      resource: "pods",
      verb: "list"
    });
    expect(kubernetesRbacRequirement("GET", "/api/v1/namespaces/scp/pods/p1/log?container=runner")).toStrictEqual({
      apiGroup: "",
      resource: "pods/log",
      verb: "get"
    });
    expect(kubernetesRbacRequirement("GET", "/apis/batch/v1/namespaces/scp/jobs")).toStrictEqual({
      apiGroup: "batch",
      resource: "jobs",
      verb: "list"
    });
    expect(kubernetesRbacRequirement("GET", "/apis/batch/v1/namespaces/scp/jobs/j1")).toStrictEqual({
      apiGroup: "batch",
      resource: "jobs",
      verb: "get"
    });
    expect(kubernetesRbacRequirement("PATCH", "/apis/batch/v1/namespaces/scp/jobs/j1")).toStrictEqual({
      apiGroup: "batch",
      resource: "jobs",
      verb: "patch"
    });
    // …and it refuses rather than guessing, which is what makes `unmapped` above meaningful.
    expect(kubernetesRbacRequirement("GET", "/apis/apps/v1/namespaces/scp/deployments")).toBeNull();
    expect(kubernetesRbacRequirement("HEAD", "/api/v1/namespaces/scp/pods")).toBeNull();
  });

  it("THE CENSUS SLOT: every request the adapter can build is one this matrix drove", () => {
    /**
     * The matrix above proves what the routes it drives require. It cannot, on its own, prove there
     * is no ELEVENTH route — the one nothing drives and no Role grants, which is exactly how a
     * managed run turns into a 403 nobody predicted. Every request in this adapter is built from a
     * `method: "<VERB>"` literal, so the multiset of those literals is the count of what can be
     * issued at all. Add a call site and this fails BY COUNT before it can reach a cluster.
     *
     * `method: req.method` (the transport, in `createFetchKubernetesIo`) and the `method` field on
     * `KubernetesApiRequest` itself are not literals and are correctly invisible here.
     */
    const source = readFileSync(resolve(__dirname, "kubernetes-adapter.ts"), "utf8");
    // The negative lookbehind excludes `KubernetesApiRequest`'s own field declaration, whose union
    // (`readonly method: "GET" | "POST" | ...`) is a TYPE and issues nothing.
    const literals = [...source.matchAll(/(?<!readonly\s)\bmethod:\s*"([A-Z]+)"/g)]
      .map((m) => m[1]!)
      .sort();
    expect(literals).toStrictEqual([
      "DELETE", // teardown: the Job
      "DELETE", // teardown: the per-run Secret
      "DELETE", // reap: a peer's past-deadline Job
      "DELETE", // reap: that Job's per-run Secret
      "GET", // start: the Job's own status
      "GET", // start: the Job's events
      "GET", // start: the pod, by label selector
      "GET", // start: the pod's log
      "GET", // reap: the labelled Job collection
      "PATCH", // start: the unsuspend
      "POST", // create: the Job
      "POST" // create: the per-run Secret
    ].sort());
  });
});
