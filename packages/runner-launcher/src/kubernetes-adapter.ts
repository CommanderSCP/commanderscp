import { createHash } from "node:crypto";
import { debuglog } from "node:util";
import {
  DEFAULT_DOCKER_BINARY,
  LAUNCHER_OWNER_ID,
  RUNNER_LAUNCHER_OWNER_LABEL,
  RUNNER_MAXBUFFER_CODE,
  RUNNER_MIN_STEP_BUDGET_MS,
  RUNNER_NEVER_STARTED_CODE,
  RUNNER_OUTCOME_UNKNOWN_CODE,
  RUNNER_REAP_BUDGET_MS,
  RUNNER_REMOVE_TIMEOUT_MS,
  RUNNER_RUN_ID_PATTERN,
  RunnerLaunchError,
  classifyRunnerFailure,
  createDockerRunnerLauncher,
  createRunDeadline,
  runnerContainerName,
  runnerReapGraceMs,
  runnerRunBoundMs,
  withPostDeadlineBound,
  withStepBound
} from "./index.js";
import type {
  ResolveRunnerLauncher,
  RunnerFailure,
  RunnerLaunchStep,
  RunnerLauncher,
  RunnerLauncherConfig,
  RunnerResult,
  RunnerSpec
} from "./index.js";

const debug = debuglog("scp-runner-launcher");

/** THE KUBERNETES ADAPTER. See docs/runner-launcher.md §235. */

// THE TWO CONTRACT DECISIONS THIS ADAPTER HAD TO TAKE, NAMED SO THEY ARE MUTATABLE

/** Kubernetes hands back one stream; this picks the field. See docs/runner-launcher.md §236. */
export const KUBERNETES_MERGES_STDERR_INTO_STDOUT = true;

/** The pod label carrying the unhonourable network mode. See docs/runner-launcher.md §237. */
export const RUNNER_NETWORK_LABEL = "scp.launcher.network";

/** The pod/Job label carrying `RunnerSpec.runId` — this adapter's own selector, deliberately NOT
 *  Kubernetes' `job-name`/`batch.kubernetes.io/job-name`, whose spelling changed across versions. */
export const RUNNER_RUN_ID_LABEL = "scp.launcher.run-id";

/** THE DEADLINE IS AN ANNOTATION, NOT A LABEL. See docs/runner-launcher.md §238. */
/** A literal rather than the constant, and the defect why. See docs/runner-launcher.md §239. */
export const RUNNER_LAUNCHER_DEADLINE_ANNOTATION = "scp.launcher.deadline";

// THE SEAM — one injected object, the exact analogue of `dockerBinary` + `execFile`

/** One request this adapter makes of the Kubernetes API server. Its `step` and `timeoutMs` are
 *  {@link KubernetesIoOp}'s — the same two fields every verb on this port carries. */
export interface KubernetesApiRequest extends KubernetesIoOp {
  readonly method: "GET" | "POST" | "PATCH" | "DELETE";
  /** Path AND query, relative to the API server root. */
  readonly path: string;
  /** JSON body, already the exact object to serialise. Absent for GET/DELETE. */
  readonly body?: unknown;
  /** `application/merge-patch+json` for the unsuspend PATCH; `application/json` otherwise. */
  readonly contentType?: string;
  /** {@link LOG_ACCEPT} for a log read; `application/json` otherwise. */
  readonly accept?: string;
}

export interface KubernetesApiResponse {
  readonly status: number;
  /** The response body as text. JSON is parsed by the adapter, never by the transport. */
  readonly body: string;
}

/** WHAT EVERY OPERATION ON THIS PORT CARRIES. See docs/runner-launcher.md §240. */
export interface KubernetesIoOp {
  /** Which port step this operation belongs to. PRODUCTION-NECESSARY: every rejection out of this
   *  adapter is a {@link RunnerLaunchError} and must name the step that failed. */
  readonly step: RunnerLaunchStep;
  /** Derived from the ONE whole-run deadline, never from `spec.timeoutMs`; for teardown and reap,
   *  {@link RUNNER_REMOVE_TIMEOUT_MS}. Honour it if you can — you will be given up on either way. */
  readonly timeoutMs: number;
}

/** Everything this adapter touches outside its process. See docs/runner-launcher.md §241. */
export interface KubernetesRunnerIo {
  request(req: KubernetesApiRequest): Promise<KubernetesApiResponse>;
  /** Recursively copy the CONTENTS of `fromDir` into `toDir`, creating `toDir`. The exact semantics
   *  of `docker cp <src>/. <dst>`, which is what the port's `copyIn`/`copyOut` are specified as. */
  copyDir(op: KubernetesIoOp & { fromDir: string; toDir: string }): Promise<void>;
  /** Recursively remove `dir`. Absent is not an error — teardown is unconditional. */
  removeDir(op: KubernetesIoOp & { dir: string }): Promise<void>;
}

/** Where the Job's shared workspace volume comes from. See docs/runner-launcher.md §242. */
export type KubernetesWorkspaceVolume =
  /** PRODUCTION. The RWX PersistentVolumeClaim owner decision 5 makes a deployment prerequisite. */
  | { readonly kind: "persistentVolumeClaim"; readonly claimName: string }
  /**
   * THE HARNESS ONLY, and it is here rather than in test code because the kind-based gate is the
   * whole point of this increment and it must exercise the SHIPPED adapter. A single-node cluster
   * has no RWX class; a host directory mounted into the node is the local model of one.
   */
  | { readonly kind: "hostPath"; readonly path: string };

/** The pod conventions this deployment applies elsewhere. See docs/runner-launcher.md §243. */
export interface KubernetesRunnerPodConventions {
  readonly imagePullSecrets?: readonly string[];
  /** The runner container's `imagePullPolicy`. The chart inherits `.Values.image.pullPolicy`
   *  (`IfNotPresent`), which is the value that keeps an air-gapped node from reaching a registry. */
  readonly imagePullPolicy?: "Always" | "IfNotPresent" | "Never";
  /** The runner container's `resources`. NO CHART DEFAULT — see `values.yaml` for why guessing a
   *  memory limit for `tofu`/Trivy is worse than having none — but a namespace with a compute
   *  ResourceQuota and no defaulting LimitRange REJECTS a pod that omits it, and a dedicated runner
   *  namespace (which this chart recommends) is exactly where a platform team puts one. */
  readonly resources?: {
    readonly requests?: Readonly<Record<string, string>>;
    readonly limits?: Readonly<Record<string, string>>;
  };
}

export interface KubernetesRunnerLauncherConfig {
  /** The namespace every Job, Secret and pod read lives in. Never derived from a tenant value. */
  readonly namespace: string;
  /** Where THIS process sees the shared workspace volume. The Job sees the same bytes. */
  readonly workspaceRoot: string;
  readonly workspaceVolume: KubernetesWorkspaceVolume;
  /** Per-run secrets are granted; this field opts out. See docs/runner-launcher.md §244. */
  readonly perRunSecrets: boolean;
  /** The pod `securityContext.runAsNonRoot`. See docs/runner-launcher.md §245. */
  readonly runAsNonRoot?: boolean;
  /** THE DEPLOYMENT'S POD CONVENTIONS — see {@link KubernetesRunnerPodConventions}. Absent means
   *  "this deployment stated none", which is byte-identical to every launch before M23.5. */
  readonly pod?: KubernetesRunnerPodConventions;
  /** `ttlSecondsAfterFinished` on the Job. A BACKSTOP, never the cleanup: teardown deletes the Job. */
  readonly ttlSecondsAfterFinished?: number;
  /** How often `start` asks whether the pod is terminal. */
  readonly pollIntervalMs?: number;
  readonly io: KubernetesRunnerIo;
  /** Injected so a test can drive the poll loop without real time. Defaults to `setTimeout`. */
  readonly sleep?: (ms: number) => Promise<void>;
}

/** Default poll cadence for `start`. A POLL AND NOT A WATCH, deliberately: a watch stream that ends
 *  silently (an API-server restart, an idle timeout, a proxy) looks exactly like "nothing has
 *  happened yet", and the failure is a run that hangs to its deadline for no reason. A run is bounded
 *  minutes; 300 GETs against an API server is not a cost worth a whole failure class. */
export const KUBERNETES_POLL_INTERVAL_MS = 2_000;

export const KUBERNETES_JOB_TTL_SECONDS = 3_600;

/** The one container in every runner Job. Fixed, because `pods/log?container=` needs a name and a
 *  caller-supplied one would be a second identity nothing else in the port knows about. */
export const RUNNER_CONTAINER_NAME = "runner";

/** The volume name every runner Job mounts its workspace subpaths from. */
export const RUNNER_WORKSPACE_VOLUME_NAME = "workspace";

// NAMES AND PATHS — derived, never invented, and every one of them bounded

/** The Job's `metadata.name`. THE SAME STRING the Docker adapter uses for `--name`, which is exactly
 *  what `RunnerSpec.runId`'s doc promised: "the Kubernetes adapter (M23.2) puts the same string in
 *  `metadata.name`". `RUNNER_RUN_ID_PATTERN` is bounded at 40 so this stays inside 63. */
export function runnerJobName(runId: string): string {
  return runnerContainerName(runId);
}

/** The per-run Secret's name. `scp-runner-` (11) + runId (<=40) + `-env` (4) = 55 <= 63. */
export function runnerSecretName(runId: string): string {
  return `${runnerJobName(runId)}-env`;
}

/** One workspace slot per distinct container path. See docs/runner-launcher.md §246. */
export function workspaceSlots(spec: RunnerSpec): Map<string, string> {
  const slots = new Map<string, string>();
  const paths = [...spec.copyIn.map((c) => c.containerPath)];
  if (spec.copyOut) paths.push(spec.copyOut.containerPath);
  for (const path of paths) {
    if (!slots.has(path)) slots.set(path, `m${slots.size}`);
  }
  return slots;
}

/** THIS run's subtree of the shared volume, as THIS process sees it. */
function runRootDir(workspaceRoot: string, runId: string): string {
  return `${workspaceRoot}/${runnerJobName(runId)}`;
}

/** Where a slot's bytes live on the shared volume, as THIS process sees it. */
function slotDir(workspaceRoot: string, runId: string, slot: string): string {
  return `${runRootDir(workspaceRoot, runId)}/${slot}`;
}

/** The `subPath` the Job mounts for a slot — relative to the volume root, so it is the run subtree
 *  path with `workspaceRoot` removed. Derived from the same two pieces, so the two cannot drift. */
function slotSubPath(runId: string, slot: string): string {
  return `${runnerJobName(runId)}/${slot}`;
}

const JOBS_PATH = (ns: string): string => `/apis/batch/v1/namespaces/${ns}/jobs`;
const SECRETS_PATH = (ns: string): string => `/api/v1/namespaces/${ns}/secrets`;
const PODS_PATH = (ns: string): string => `/api/v1/namespaces/${ns}/pods`;
/** THE JOB'S OWN EVENTS — the only place a pod-creation refusal is ever written down. See
 *  {@link kubernetesJobTermination}: when a Job cannot create a pod, no pod exists to carry a
 *  status, the Job's own `status` says nothing, and the controller's `FailedCreate` event carries
 *  the API server's verbatim message. `deploy/helm/templates/runner-iac.yaml` grants the read. */
const EVENTS_PATH = (ns: string, jobName: string): string =>
  `/api/v1/namespaces/${ns}/events?fieldSelector=${encodeURIComponent(
    `involvedObject.kind=Job,involvedObject.name=${jobName}`
  )}`;

/** The log read, and how output-exceeded stays reachable. See docs/runner-launcher.md §247. */
/** The accept header for a log read, measured not guessed. See docs/runner-launcher.md §248. */
const LOG_ACCEPT = "*/*";

function logRequestPath(ns: string, podName: string, maxBuffer: number): string {
  return `${PODS_PATH(ns)}/${podName}/log?container=${RUNNER_CONTAINER_NAME}&limitBytes=${maxBuffer + 1}`;
}

// THE RBAC CONTRACT — WHAT THIS ADAPTER ASKS FOR, AS DATA, SO THE CHART CAN BE DIFFED AGAINST IT
/** The chart grants exactly what the adapter calls. See docs/runner-launcher.md §249. */
export interface KubernetesRbacRule {
  /** `""` for the core group, `"batch"` for Jobs — spelled as the Role's `apiGroups` entry is. */
  readonly apiGroup: "" | "batch";
  /** The resource, subresources included and NAMED SEPARATELY: `pods` and `pods/log` are two
   *  distinct RBAC resources and collapsing them into one rule grants each the other's verbs. */
  readonly resource: string;
  /** Sorted, so a set comparison is a value comparison. */
  readonly verbs: readonly string[];
}

/** Rendered as `apiGroup/resource`, the key both the derivation and the chart diff group on. */
export function kubernetesRbacKey(rule: { apiGroup: string; resource: string }): string {
  return `${rule.apiGroup === "" ? "core" : rule.apiGroup}/${rule.resource}`;
}

/** Every rule this adapter's requests require. See docs/runner-launcher.md §250. */
export function kubernetesRunnerRbac(opts: {
  perRunSecrets: boolean;
}): readonly KubernetesRbacRule[] {
  const rules: KubernetesRbacRule[] = [
    // create (POST), get (GET one), list (GET the collection, for the reap sweep), patch (the
    // unsuspend), delete (teardown and reap). NO `watch`: see the module note above.
    { apiGroup: "batch", resource: "jobs", verbs: ["create", "delete", "get", "list", "patch"] },
    // The pod is only ever found by label selector over the COLLECTION — never fetched by name.
    { apiGroup: "", resource: "pods", verbs: ["list"] },
    // …and the log is a subresource GET on one pod.
    { apiGroup: "", resource: "pods/log", verbs: ["get"] },
    // The Job's own events, by field selector: a collection read, so `list`.
    { apiGroup: "", resource: "events", verbs: ["list"] }
  ];
  if (opts.perRunSecrets) {
    // One POST and two DELETEs. `get` is unused and `list` returns every Secret BODY in the
    // namespace — see this file's `perRunSecrets` doc for why that one is a refusal, not an omission.
    rules.push({ apiGroup: "", resource: "secrets", verbs: ["create", "delete"] });
  }
  return rules;
}

/** The Kubernetes verb an HTTP request requires. See docs/runner-launcher.md §251. */
export function kubernetesRbacRequirement(
  method: string,
  rawPath: string
): { apiGroup: "" | "batch"; resource: string; verb: string } | null {
  const path = rawPath.split("?")[0] ?? "";
  // `/apis/batch/v1/namespaces/{ns}/jobs[/{name}]` and `/api/v1/namespaces/{ns}/{res}[/{name}[/{sub}]]`
  const batch = /^\/apis\/batch\/v1\/namespaces\/[^/]+\/([^/]+)(?:\/([^/]+))?$/.exec(path);
  const core = /^\/api\/v1\/namespaces\/[^/]+\/([^/]+)(?:\/([^/]+))?(?:\/([^/]+))?$/.exec(path);
  const m = batch ?? core;
  if (!m) return null;
  const apiGroup: "" | "batch" = batch ? "batch" : "";
  const collection = m[1]!;
  const name = m[2];
  const subresource = m[3];
  const resource = subresource === undefined ? collection : `${collection}/${subresource}`;
  // A GET is `list` against a collection and `get` against a named object. That distinction is the
  // whole reason `pods` needs only `list` while `pods/log` needs only `get`.
  const verb =
    method === "GET"
      ? name === undefined
        ? "list"
        : "get"
      : method === "POST"
        ? "create"
        : method === "PATCH"
          ? "patch"
          : method === "PUT"
            ? "update"
            : method === "DELETE"
              ? "delete"
              : null;
  return verb === null ? null : { apiGroup, resource, verb };
}

// KUBERNETES-SHAPED VALIDATION — the refusals the Docker adapter had no need of

/** A label VALUE the API server accepts. Empty is legal; 63 characters is the ceiling. */
const K8S_LABEL_VALUE = /^(([A-Za-z0-9][-A-Za-z0-9_.]*)?[A-Za-z0-9])?$/;

/** Is this label entry expressible as a Kubernetes label. See docs/runner-launcher.md §252. */
export function isKubernetesLabelValue(value: string): boolean {
  return value.length <= 63 && K8S_LABEL_VALUE.test(value);
}

/** Is this API response a name collision — the typed 409 that replaces Docker's stderr substring? */
export function isKubernetesAlreadyExists(res: KubernetesApiResponse): boolean {
  if (res.status !== 409) return false;
  // `Conflict` is also 409 for an optimistic-concurrency failure on an UPDATE. This adapter only ever
  // POSTs new objects, so a 409 here can only be AlreadyExists — but the reason is checked anyway,
  // for the same asymmetry `isContainerNameConflict` records: a false positive leaves an object the
  // reaper collects on its deadline; a false negative DELETES somebody else's live run.
  try {
    const body = JSON.parse(res.body) as { reason?: unknown };
    return body.reason === "AlreadyExists";
  } catch {
    return false;
  }
}

/** The uid of an object the API server just created. See docs/runner-launcher.md §253. */
export function kubernetesObjectUid(res: KubernetesApiResponse): string | undefined {
  try {
    const body = JSON.parse(res.body) as { metadata?: { uid?: unknown } };
    const uid = body.metadata?.uid;
    return typeof uid === "string" && uid.length > 0 ? uid : undefined;
  } catch {
    return undefined;
  }
}

// THE POD'S TERMINAL STATE -> THE PORT'S FAILURE KINDS

/** The slice of a pod this adapter reads. Everything else in the object is ignored. */
interface PodView {
  metadata?: {
    name?: string;
    /** M23.5 — SET THE INSTANT A DELETION IS REQUESTED, 31 seconds before the SIGKILL that follows
     *  it produces an exit code. The one fact that distinguishes "the platform destroyed this pod"
     *  from "the tenant's runner exited 137"; see {@link kubernetesTermination} for the measurement. */
    deletionTimestamp?: string;
  };
  status?: {
    phase?: string;
    /** M23.5 — WHY THE POD IS NOT RUNNING YET, and the only place `Unschedulable` is written down.
     *  A pod that cannot be scheduled has NO `containerStatuses` at all, so every field below was
     *  empty for it and the adapter polled to its deadline reporting an exhausted budget. */
    conditions?: { type?: string; status?: string; reason?: string; message?: string }[];
    containerStatuses?: {
      name?: string;
      state?: {
        running?: { startedAt?: string };
        terminated?: { exitCode?: number; signal?: number; reason?: string };
        waiting?: { reason?: string; message?: string };
      };
    }[];
  };
}

/** The slice of a Job this adapter reads. Everything else in the object is ignored. */
interface JobView {
  status?: {
    conditions?: { type?: string; status?: string; reason?: string; message?: string }[];
  };
}

interface EventView {
  type?: string;
  reason?: string;
  message?: string;
  count?: number;
}

/** A pod state that is FATAL BEFORE THE ENTRYPOINT RAN. See docs/runner-launcher.md §254. */
const FATAL_WAITING_REASONS = new Set([
  "ErrImagePull",
  "ImagePullBackOff",
  "InvalidImageName",
  "CreateContainerConfigError",
  "CreateContainerError",
  "RunContainerError"
]);

/** WHAT THE RUN'S POD SAYS HAPPENED. See docs/runner-launcher.md §255. */
export function kubernetesTermination(
  pod: PodView,
  /** Sticky, from the run's own polling. Defaults to what THIS pod says for the pure-function
   *  callers; the loop passes its remembered value, which survives a pod whose status is pruned. */
  everStarted: boolean = kubernetesContainerStarted(pod)
):
  | {
      succeeded: boolean;
      message: string;
      code: string | number | null;
      killed: boolean;
      signal: string | null;
    }
  | undefined {
  const status = pod.status ?? {};
  const container = (status.containerStatuses ?? []).find((c) => c.name === RUNNER_CONTAINER_NAME);

  const waiting = container?.state?.waiting;
  if (waiting?.reason && FATAL_WAITING_REASONS.has(waiting.reason)) {
    return {
      succeeded: false,
      message: `the runner container never started: ${waiting.reason}${
        waiting.message ? ` — ${waiting.message}` : ""
      }`,
      // A STRING `code` is what `classifyRunnerFailure` reads as an errno, i.e. `spawn-failed`.
      code: waiting.reason,
      killed: false,
      signal: null
    };
  }

  const terminated = container?.state?.terminated;

  /** The platform deleted this pod, and that outranks. See docs/runner-launcher.md §256. */
  const deletedAt = pod.metadata?.deletionTimestamp;
  const exitedCleanly =
    terminated !== undefined &&
    (terminated.exitCode ?? 0) === 0 &&
    !terminated.signal &&
    terminated.reason !== "OOMKilled";
  if (deletedAt && !exitedCleanly) {
    const sigkilled = terminated
      ? ` (the runner was then SIGKILLed when the termination grace expired: exitCode ${
          terminated.exitCode ?? 0
        }${terminated.reason ? ` (${terminated.reason})` : ""})`
      : "";
    if (everStarted) {
      return {
        succeeded: false,
        message:
          `the runner's pod was DELETED at ${deletedAt} — a node drain, an eviction or an ` +
          `explicit deletion destroyed it while it was running${sigkilled}. This is NOT this ` +
          `run's own budget`,
        code: null,
        killed: true,
        signal: "SIGKILL"
      };
    }
    return {
      succeeded: false,
      message:
        `the runner's pod was DELETED at ${deletedAt} before any runner container started, so ` +
        `NOTHING RAN and nothing was mutated${sigkilled}`,
      // A STRING `code` is what `classifyRunnerFailure` reads as an errno, i.e. `spawn-failed`.
      code: "PodDeleted",
      killed: false,
      signal: null
    };
  }

  if (terminated) {
    if (terminated.signal && terminated.signal !== 0) {
      return {
        succeeded: false,
        message: `the runner was killed by signal ${terminated.signal}${
          terminated.reason ? ` (${terminated.reason})` : ""
        }`,
        code: null,
        killed: true,
        signal: `SIG${terminated.signal}`
      };
    }
    if (terminated.reason === "OOMKilled") {
      return {
        succeeded: false,
        message: "the runner was OOMKilled by the kubelet",
        code: null,
        killed: true,
        signal: "SIGKILL"
      };
    }
    const exitCode = terminated.exitCode ?? 0;
    if (exitCode === 0) {
      return { succeeded: true, message: "", code: 0, killed: false, signal: null };
    }
    return {
      succeeded: false,
      message: `the runner exited ${exitCode}${terminated.reason ? ` (${terminated.reason})` : ""}`,
      code: exitCode,
      killed: false,
      signal: null
    };
  }

  // NO CONTAINER STATUS AT ALL, but the pod is already terminal. Reachable when the pod is rejected
  // before the kubelet ever writes a container status (a scheduling refusal, an admission webhook, an
  // evicted node). `phase` is the only fact there is; treat it as a start failure rather than waiting
  // for a deadline that would misreport it as a budget exhaustion.
  if (status.phase === "Failed") {
    return {
      succeeded: false,
      message: "the pod reached phase Failed with no container status",
      code: "PodFailed",
      killed: false,
      signal: null
    };
  }
  if (status.phase === "Succeeded") {
    return { succeeded: true, message: "", code: 0, killed: false, signal: null };
  }
  return undefined;
}

/** DID THE RUNNER CONTAINER EVER START? See docs/runner-launcher.md §257. */
export function kubernetesContainerStarted(pod: PodView | undefined): boolean {
  if (!pod) return false;
  const container = (pod.status?.containerStatuses ?? []).find(
    (c) => c.name === RUNNER_CONTAINER_NAME
  );
  if (container?.state?.running || container?.state?.terminated) return true;
  // AND THE PHASE ALONE IS ENOUGH FOR THREE OF THE FIVE. See docs/runner-launcher.md §258.
  const phase = pod.status?.phase;
  return phase === "Running" || phase === "Succeeded" || phase === "Failed";
}

/** WHY THIS RUN IS STILL WAITING. See docs/runner-launcher.md §259. */
export function kubernetesWaitingEvidence(
  pod: PodView | undefined,
  events: readonly EventView[]
): string {
  if (pod) {
    const blocked = (pod.status?.conditions ?? []).find(
      (c) => c.status === "False" && (c.reason || c.message)
    );
    if (blocked) {
      return `the pod is ${pod.status?.phase ?? "Pending"} and ${blocked.type ?? "a condition"} is False: ${
        blocked.reason ?? "?"
      }${blocked.message ? ` — ${blocked.message}` : ""}`;
    }
    const container = (pod.status?.containerStatuses ?? []).find(
      (c) => c.name === RUNNER_CONTAINER_NAME
    );
    const waiting = container?.state?.waiting;
    if (waiting?.reason) {
      return `the runner container is waiting: ${waiting.reason}${
        waiting.message ? ` — ${waiting.message}` : ""
      }`;
    }
    return `the pod is ${pod.status?.phase ?? "Pending"} with no container status yet`;
  }

  // NO POD AT ALL. The Job was unsuspended and the controller could not create one; the only record
  // is its own event stream, and teardown deletes the Job, taking that with it. So it is read HERE,
  // while the run is still alive, and carried into the failure.
  const warning = events.find((e) => e.type === "Warning" && e.message);
  if (warning) {
    return `the Job could not create a pod — ${warning.reason ?? "Warning"}: ${warning.message}${
      warning.count && warning.count > 1 ? ` (x${warning.count})` : ""
    }`;
  }
  return (
    "the Job was started but no pod has been created for it, and the Job reported no event " +
    "explaining why (`kubectl describe job` in the runner namespace is the next place to look)"
  );
}

/** WHAT THE JOB ITSELF SAYS HAPPENED. See docs/runner-launcher.md §260. */
export function kubernetesJobTermination(
  job: JobView,
  everStarted: boolean,
  waiting: string
):
  | {
      succeeded: boolean;
      message: string;
      code: string | number | null;
      killed: boolean;
      signal: string | null;
    }
  | undefined {
  // The failure target is read alongside the failure itself. See docs/runner-launcher.md §261.
  const failed = (job.status?.conditions ?? []).find(
    (c) => c.status === "True" && (c.type === "Failed" || c.type === "FailureTarget")
  );
  if (!failed) return undefined;
  const reason = failed.reason ?? "Failed";
  const detail = `${reason}${failed.message ? `: ${failed.message}` : ""}`;
  if (everStarted) {
    return {
      succeeded: false,
      message:
        `the runner's pod was destroyed before it reported a result — the Job failed with ` +
        `${detail}. This is a node drain, an eviction or a deletion, NOT this run's own budget`,
      code: null,
      killed: true,
      signal: "SIGKILL"
    };
  }
  return {
    succeeded: false,
    message: `the Job failed before any runner container started (${detail}) — ${waiting}`,
    // A STRING `code` is what `classifyRunnerFailure` reads as an errno, i.e. `spawn-failed`:
    // "nothing ran, so nothing was mutated". Which is the truth here, and the whole point.
    code: `Job${reason}`,
    killed: false,
    signal: null
  };
}

/** WHAT THIS RUN OBSERVED. See docs/runner-launcher.md §262. */
export interface KubernetesStartFacts {
  /** The failure carries the cluster's own statement. See docs/runner-launcher.md §263. */
  runnerVerdict: boolean;
  /** What the API server said about the unsuspend. See docs/runner-launcher.md §264. */
  unsuspend: "accepted" | "refused" | "not-issued" | "unanswered";
  /** At least one read completed after the unsuspend. See docs/runner-launcher.md §265. */
  observed: boolean;
  /** Sticky, from {@link kubernetesContainerStarted}: a runner container was SEEN running or
   *  terminated at some poll, whatever the cluster says now. */
  everStarted: boolean;
  /** HOW LONG THIS RUN WAS BLIND BEFORE IT ENDED. See docs/runner-launcher.md §266. */
  unwatchedMs: number;
  /** {@link KUBERNETES_POLL_INTERVAL_MS}, or the adapter's configured value — the most a landed
   *  observation can speak for, since the next one is a poll away. */
  pollIntervalMs: number;
  /** The whole-run budget is what ended the run, as opposed to a failure of this launcher's own
   *  transport with budget still left. */
  deadlineExceeded: boolean;
  /** The last operator-facing clause {@link kubernetesWaitingEvidence} produced, or — when nothing
   *  was ever observed — the sentence that says so. */
  waiting: string;
  runTimeoutMs: number;
}

/**
 * WHAT A LAUNCHER THAT COULD NOT SEE IS ALLOWED TO SAY. See docs/runner-launcher.md §267.
 * @returns `undefined` to leave the failure exactly as it was thrown, or the `code` and `message`
 * the run should be RE-RAISED with.
 */
export function kubernetesStartVerdict(
  f: KubernetesStartFacts
): { code: string; message: string } | undefined {
  // 1. THE CLUSTER ANSWERED THE QUESTION. A terminal pod, a failed Job, an over-`maxBuffer` log:
  //    these are statements about the runner made by something that could see it. Nothing here is
  //    better informed, and overriding them is how M23.5's D2 negative control fails.
  if (f.runnerVerdict) return undefined;

  // 2. THE UNSUSPEND WAS NEVER SENT. See docs/runner-launcher.md §268.
  if (f.unsuspend === "not-issued") {
    return {
      code: RUNNER_NEVER_STARTED_CODE,
      message:
        `the whole-run budget of ${f.runTimeoutMs}ms (RunnerSpec.timeoutMs) was already spent when ` +
        `this run reached 'start', so the unsuspend was NEVER ISSUED and the Job never left ` +
        `'suspend: true' — NOTHING RAN and nothing was mutated`
    };
  }

  // The API server refused to start the job, and said so. See docs/runner-launcher.md §269.
  if (f.unsuspend === "refused") {
    return {
      code: RUNNER_NEVER_STARTED_CODE,
      message:
        `the API server REFUSED to unsuspend this run's Job, so it never left 'suspend: true' and ` +
        `no pod was ever created for it — NOTHING RAN and nothing was mutated`
    };
  }

  // 4. NOBODY ANSWERED, AND NOTHING PROVES IT WAS NOT SENT. Everything the two arms above can
  //    settle is settled; what is left is a request that may have reached the API server and been
  //    applied while its response was lost. A merge-patch is not a question, it is an instruction.
  if (f.unsuspend !== "accepted") {
    return {
      code: RUNNER_OUTCOME_UNKNOWN_CODE,
      message:
        `this run never learned whether its Job was started: the unsuspend went unanswered, so ` +
        `whether a pod was created — and if it was, whether the runner ran and what it mutated — ` +
        `is NOT KNOWN. The teardown that follows DELETEs the Job, which stops anything that was ` +
        `running. Check the target's real state before re-running`
    };
  }

  // 5. A CONTAINER WAS SEEN RUNNING. If the whole-run budget is what ended us, `budget-exhausted`
  //    is exactly right and says so ("stopped mid-flight, the real state is unknown") — that is
  //    M23.5's negative control and it must keep passing. If something else ended us with budget
  //    still left, we stopped WATCHING a run that was still going, which is a different sentence.
  if (f.everStarted) {
    if (f.deadlineExceeded) return undefined;
    return {
      code: RUNNER_OUTCOME_UNKNOWN_CODE,
      message:
        `a runner container WAS running and this launcher's own read of the cluster then failed ` +
        `with budget still left, so it stopped watching before the run was over — how the run ` +
        `ended, and what it mutated, is NOT KNOWN. The teardown that follows DELETEs the Job, ` +
        `which kills a 'tofu apply' mid-flight. Check the target's real state before re-running`
    };
  }

  // 6. THE DEFECT. The unsuspend was ACCEPTED and nothing was ever observed after it. The Job was
  //    live in the cluster from that instant and the kubelet does not need this process to be
  //    watching; `!everStarted` here means "we never looked", not "nothing started", and the two
  //    were one flag.
  if (!f.observed) {
    return {
      code: RUNNER_OUTCOME_UNKNOWN_CODE,
      message:
        `the API server ACCEPTED the unsuspend of this run's Job and NOTHING WAS EVER OBSERVED ` +
        `AFTER IT — no read of the pod, the Job or its events completed before the whole-run ` +
        `budget of ${f.runTimeoutMs}ms (RunnerSpec.timeoutMs) ran out (${f.waiting}). The Job was ` +
        `live in the cluster and the kubelet does not need this launcher to be watching, so ` +
        `whether the runner ran, and whether anything was mutated, is NOT KNOWN. The teardown that ` +
        `follows DELETEs the Job, which kills a 'tofu apply' mid-flight. Check the target's real ` +
        `state before re-running`
    };
  }

  // Observed, nothing had started, and the budget ended it. See docs/runner-launcher.md §270.
  if (f.deadlineExceeded) {
    // Two poll intervals, both earned rather than chosen. See docs/runner-launcher.md §271.
    if (f.unwatchedMs <= 2 * f.pollIntervalMs + RUNNER_MIN_STEP_BUDGET_MS) {
      return {
        code: RUNNER_NEVER_STARTED_CODE,
        message:
          `the runner container never started within the whole-run budget of ${f.runTimeoutMs}ms ` +
          `(RunnerSpec.timeoutMs), so NOTHING RAN and nothing was mutated — ${f.waiting}`
      };
    }
    // 7b. THE READ IS TOO OLD TO SPEAK FOR THE BUDGET IT IS BEING QUOTED ABOUT. The Job stayed live
    //     in the cluster for the whole of the window below and the kubelet does not need this
    //     process to be watching.
    return {
      code: RUNNER_OUTCOME_UNKNOWN_CODE,
      message:
        `no runner container had started when this launcher last saw the cluster (${f.waiting}), ` +
        `and it then saw NOTHING FOR THE LAST ${f.unwatchedMs}ms of the whole-run budget of ` +
        `${f.runTimeoutMs}ms (RunnerSpec.timeoutMs) — a landed read speaks for the ${f.pollIntervalMs}ms ` +
        `interval it sits in, plus one more for the read that finds the deadline, and no longer. ` +
        `Whether the Job started a pod in the window that ` +
        `followed, and if it did whether the runner ran and what it changed, is NOT KNOWN. The ` +
        `teardown that follows DELETEs the Job, which kills a 'tofu apply' mid-flight. Check the ` +
        `target's real state before re-running`
    };
  }

  // 8. OBSERVED, NOTHING HAD STARTED, AND OUR OWN READ FAILED WITH BUDGET LEFT. The Job is still
  //    live and still able to start a pod; this run simply stopped being able to look. Arm 7's
  //    claim is not available here, because the budget it is made "within" has not run out.
  return {
    code: RUNNER_OUTCOME_UNKNOWN_CODE,
    message:
      `no runner container had started when this launcher last saw the cluster (${f.waiting}), and ` +
      `its own next read then failed with budget still left — so it stopped watching a Job that ` +
      `was still able to start one, and whether the runner ran is NOT KNOWN. The teardown that ` +
      `follows DELETEs the Job. Check the target's real state before re-running`
  };
}

/** Single-flight slot for the background sweep, ONE PER NAMESPACE — the exact analogue of the Docker
 *  adapter's per-`dockerBinary` map, and separate from it on purpose: a Docker pass must never
 *  satisfy a Kubernetes caller's sweep, which is what a shared slot would do. */
const reapInFlightByNamespace = new Map<string, Promise<string[]>>();

/** The Kubernetes sweep currently in flight for `namespace`, or a resolved promise. Same role as
 *  `whenReapSettled` on the Docker side: something a test can await instead of sleeping. */
export function whenKubernetesReapSettled(namespace: string): Promise<readonly string[]> {
  return reapInFlightByNamespace.get(namespace) ?? Promise.resolve([]);
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

// ==================================================================================================
// THE CONSTRUCTION LEDGER — M23.6 CLAUSE 7's "NEVER CONSTRUCTED", WHICH IS A STRONGER CLAIM THAN
// "NEVER CALLED"
// ==================================================================================================
/** With Docker selected, this adapter is never built. See docs/runner-launcher.md §272. */
let kubernetesConstructions = 0;

/** How many Kubernetes launchers or API clients this process has built. See the block above. */
export function kubernetesConstructionCount(): number {
  return kubernetesConstructions;
}

export function createKubernetesRunnerLauncher(
  config: KubernetesRunnerLauncherConfig
): RunnerLauncher {
  kubernetesConstructions += 1;
  const { namespace, workspaceRoot, io } = config;
  const sleep = config.sleep ?? defaultSleep;
  const pollIntervalMs = config.pollIntervalMs ?? KUBERNETES_POLL_INTERVAL_MS;

  /** Lists every Job this package labelled, and deletes. See docs/runner-launcher.md §273. */
  const reapOnce = async (): Promise<string[]> => {
    const passDeadline = Date.now() + RUNNER_REAP_BUDGET_MS;
    let listing: KubernetesApiResponse;
    try {
      // BOUNDED THROUGH THE PORT (M23.5), like every other call this package makes. A reap pass
      // that never settles holds the single-flight slot against every later run in this process.
      listing = await withStepBound({
        timeoutMs: RUNNER_REMOVE_TIMEOUT_MS,
        what: "reap `GET jobs`",
        work: (timeoutMs) =>
          io.request({
            step: "teardown",
            method: "GET",
            path: `${JOBS_PATH(namespace)}?labelSelector=${encodeURIComponent(RUNNER_LAUNCHER_OWNER_LABEL)}`,
            timeoutMs
          })
      });
    } catch (cause) {
      debug("reap: listing launcher-owned Jobs failed, skipping this pass: %O", cause);
      return [];
    }
    if (listing.status < 200 || listing.status >= 300) {
      debug(
        "reap: listing launcher-owned Jobs returned HTTP %d, skipping this pass",
        listing.status
      );
      return [];
    }

    let items: {
      metadata?: {
        name?: string;
        labels?: Record<string, string>;
        annotations?: Record<string, string>;
      };
    }[];
    try {
      items = (JSON.parse(listing.body) as { items?: typeof items }).items ?? [];
    } catch (cause) {
      debug("reap: Job listing was not JSON, skipping this pass: %O", cause);
      return [];
    }

    const now = Date.now();
    const targets: string[] = [];
    for (const item of items) {
      const name = item.metadata?.name;
      const owner = item.metadata?.labels?.[RUNNER_LAUNCHER_OWNER_LABEL];
      const deadline = item.metadata?.annotations?.[RUNNER_LAUNCHER_DEADLINE_ANNOTATION];
      if (!name || owner === LAUNCHER_OWNER_ID) continue; // never my own
      const deadlineMs = deadline ? Date.parse(deadline) : NaN;
      if (!Number.isFinite(deadlineMs) || deadlineMs > now) continue;
      targets.push(name);
    }

    const removed: string[] = [];
    for (const name of targets) {
      // STOP, DO NOT TRUNCATE THE TIMEOUT — the same rule and the same reason as the Docker pass:
      // whatever is left is still expired, still labelled and still findable next pass.
      if (Date.now() >= passDeadline) {
        debug(
          "reap: pass budget spent with %d Job(s) left, leaving them for the next pass",
          targets.length - removed.length
        );
        break;
      }
      try {
        await withStepBound({
          timeoutMs: RUNNER_REMOVE_TIMEOUT_MS,
          what: `reap \`DELETE job ${name}\``,
          work: (timeoutMs) =>
            io.request({
              step: "teardown",
              method: "DELETE",
              path: `${JOBS_PATH(namespace)}/${name}?propagationPolicy=Background`,
              timeoutMs
            })
        });
        // THE WORKSPACE SUBTREE GOES WITH THE JOB. See docs/runner-launcher.md §274.
        await withStepBound({
          timeoutMs: RUNNER_REMOVE_TIMEOUT_MS,
          what: `reap \`removeDir ${workspaceRoot}/${name}\``,
          work: (timeoutMs) =>
            io.removeDir({ step: "teardown", dir: `${workspaceRoot}/${name}`, timeoutMs })
        });
        if (config.perRunSecrets) {
          await withStepBound({
            timeoutMs: RUNNER_REMOVE_TIMEOUT_MS,
            what: `reap \`DELETE secret ${name}-env\``,
            work: (timeoutMs) =>
              io.request({
                step: "teardown",
                method: "DELETE",
                path: `${SECRETS_PATH(namespace)}/${name}-env`,
                timeoutMs
              })
          });
        }
        removed.push(name);
      } catch (cause) {
        debug("reap: deleting Job %s failed, leaving it for the next pass: %O", name, cause);
      }
    }
    return removed;
  };

  /** `reapOnce`, single-flighted per NAMESPACE. See docs/runner-launcher.md §275. */
  const reap = async (_secretEnvDir?: string): Promise<string[]> => {
    void _secretEnvDir;
    const joined = reapInFlightByNamespace.get(namespace);
    if (joined) return joined;
    const pass = reapOnce().finally(() => {
      if (reapInFlightByNamespace.get(namespace) === pass) {
        reapInFlightByNamespace.delete(namespace);
      }
    });
    reapInFlightByNamespace.set(namespace, pass);
    return pass;
  };

  return {
    reap,
    async run(spec: RunnerSpec): Promise<RunnerResult> {
      // SCHEDULED, NOT AWAITED — M23.1e's finding, inherited whole. A sweep that can delay `create`
      // can spend the budget of the run it precedes, and every timeout it causes respawns the owner
      // process and makes MORE Jobs foreign, so the cost grows with each failure it produces.
      void reap().catch((cause) => debug("reap: background pass rejected: %O", cause));

      /** The one clock, and it is the port's object. See docs/runner-launcher.md §276. */
      const runDeadline = createRunDeadline({
        requestedTimeoutMs: spec.timeoutMs,
        file: `kubernetes://${namespace}`,
        redactions: () => redactions
      });
      const runTimeoutMs = runDeadline.runTimeoutMs;
      const runDeadlineAt = runDeadline.at;
      // PER-ADAPTER, NOT A FLAT TWO MINUTES (M23.5 HIGH-2). This adapter's post-deadline work is
      // three bounded teardown calls, not one, so the stamp has to clear three — see
      // {@link runnerReapGraceMs}.
      const reapDeadline = new Date(runDeadlineAt + runnerReapGraceMs("kubernetes")).toISOString();

      const jobName = runnerJobName(spec.runId);
      const secretName = runnerSecretName(spec.runId);
      const runRoot = runRootDir(workspaceRoot, spec.runId);
      const slots = workspaceSlots(spec);

      /** The redaction set, bigger here by exactly one. See docs/runner-launcher.md §277. */
      const secretValues = spec.secretEnv
        .map((entry) => entry.slice(entry.indexOf("=") + 1))
        .filter((v) => v.length > 0);
      const redactions = [
        ...secretValues,
        ...secretValues.map((v) => Buffer.from(v, "utf8").toString("base64"))
      ];

      const fail = (
        step: RunnerLaunchStep,
        argv: string[],
        cause: unknown,
        deadlineExceeded = false
      ): never => {
        throw new RunnerLaunchError({
          step,
          file: `kubernetes://${namespace}`,
          argv,
          cause,
          redactions,
          deadlineExceeded
        });
      };

      /** Every API call, bounded by the one budget. See docs/runner-launcher.md §278. */
      const api = async (
        req: Omit<KubernetesApiRequest, "timeoutMs">,
        allow: (res: KubernetesApiResponse) => boolean = (res) =>
          res.status >= 200 && res.status < 300
      ): Promise<KubernetesApiResponse> => {
        const argv = [req.method, req.path];
        let res: KubernetesApiResponse;
        // WHAT THIS REQUEST WAS ACTUALLY HANDED, AND WHEN — the two numbers the `catch` needs to ask
        // a question about THIS REQUEST rather than about the wall clock. `0` means the work
        // callback was never entered, i.e. `spend` refused before issuing; that path throws a
        // `RunnerLaunchError` and is handled first below.
        let issuedAt = 0;
        let boundGiven = 0;
        try {
          res = await runDeadline.spend(req.step, argv, (timeoutMs) => {
            issuedAt = Date.now();
            boundGiven = timeoutMs;
            return io.request({ ...req, timeoutMs });
          });
        } catch (cause) {
          // ALREADY THE PORT'S OWN VERDICT — a refusal before the request was issued, or an
          // abandonment of a transport that ignored its bound. Both already name the step and the
          // budget; re-wrapping would restate them worse.
          if (cause instanceof RunnerLaunchError) throw cause;
          /** The transport rejected of its own accord. See docs/runner-launcher.md §279. */
          const deadlineExceeded =
            boundGiven > 0 && Date.now() - issuedAt >= boundGiven - RUNNER_MIN_STEP_BUDGET_MS;
          fail(
            req.step,
            argv,
            deadlineExceeded
              ? new Error(
                  `whole-run budget of ${runTimeoutMs}ms (RunnerSpec.timeoutMs) ran out during ` +
                    `'${req.step}' at the run deadline ${new Date(runDeadlineAt).toISOString()} ` +
                    // THE TRANSPORT'S OWN LAST WORDS, KEPT. The replacement used to discard them
                    // entirely, so a reset, a TLS failure or a DNS failure that happened to land at
                    // the deadline reached the operator as a sentence about the budget and nothing
                    // else. The classification is ours to make; the evidence is not ours to delete.
                    `(the transport's own rejection: ${
                      cause instanceof Error ? cause.message : String(cause)
                    })`
                )
              : cause,
            deadlineExceeded
          );
          throw cause; // unreachable; `fail` is `never`
        }
        if (!allow(res)) {
          fail(req.step, argv, {
            message: `kubernetes ${req.method} ${req.path} -> HTTP ${res.status}`,
            code: res.status,
            stderr: res.body
          });
        }
        return res;
      };

      /** The byte movement, through the same deadline. See docs/runner-launcher.md §280. */
      const copy = async (
        step: RunnerLaunchStep,
        fromDir: string,
        toDir: string
      ): Promise<void> => {
        const argv = ["copy-dir", fromDir, toDir];
        try {
          await runDeadline.spend(step, argv, (timeoutMs) =>
            io.copyDir({ step, fromDir, toDir, timeoutMs })
          );
        } catch (cause) {
          if (cause instanceof RunnerLaunchError) throw cause;
          fail(step, argv, cause);
        }
      };

      // 0. REFUSE A SPEC THIS ADAPTER CANNOT EXPRESS, before anything exists. Same discipline as the
      //    Docker adapter — never sanitise — plus the two refusals Kubernetes needs and Docker did
      //    not: a label value the API server would reject, and a `secretEnv` with the per-run Secret
      //    capability disabled.
      if (!RUNNER_RUN_ID_PATTERN.test(spec.runId)) {
        fail(
          "spec",
          [],
          new Error(
            `runId '${spec.runId}' is not DNS-safe (${String(RUNNER_RUN_ID_PATTERN)}) — build it with toRunnerRunId()`
          )
        );
      }
      for (const [key, value] of Object.entries(spec.labels)) {
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(key) || !isKubernetesLabelValue(value)) {
          fail(
            "spec",
            [],
            new Error(
              `label '${key}' is not a usable Kubernetes label (key must be alphanumeric-dotted, value must match ${String(K8S_LABEL_VALUE)} and be <=63 chars)`
            )
          );
        }
      }
      for (const entry of spec.secretEnv) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*=/.test(entry) || /[\r\n]/.test(entry)) {
          fail(
            "spec",
            [],
            new Error(
              `secretEnv entry '${entry.split("=")[0] ?? ""}=…' is not a single-line KEY=VALUE pair`
            )
          );
        }
      }
      for (const entry of spec.env) {
        // The same refusal the Docker adapter now makes, for the same reason. Without it this
        // adapter's `indexOf("=")` split (see the container's `env` mapping) turns an entry with no
        // `=` into `{ name: entry.slice(0, -1), value: entry }` — a variable named after the entry
        // minus its last character. Silently wrong beats loudly wrong in no way at all.
        if (!/^[A-Za-z_][A-Za-z0-9_]*=/.test(entry)) {
          fail(
            "spec",
            [],
            new Error(`env entry '${entry.split("=")[0] ?? ""}=…' is not a KEY=VALUE pair`)
          );
        }
      }

      /** A run that lost its name tears down nothing. See docs/runner-launcher.md §281. */
      let foreignRun = false;

      /** A second, narrower ownership flag. See docs/runner-launcher.md §282. */
      let secretIsOurs = false;

      // The refusal standing in when no grant was made. See docs/runner-launcher.md §283.
      if (spec.secretEnv.length > 0 && !config.perRunSecrets) {
        fail(
          "secret-env",
          [],
          new Error(
            "this runner needs per-run Secrets and the Kubernetes launcher was not granted them. " +
              "RunnerSpec.secretEnv must reach the pod as a Secret + envFrom.secretRef, which needs " +
              "`secrets: create,delete` on the worker ServiceAccount. The chart grants that by " +
              "default; this deployment has managedRunners.kubernetes.perRunSecrets=false, which " +
              "renders no such rule AND sets this flag. Set it back to true to enable the class. " +
              "REFUSING rather than falling back to env[].value, which would put the credential in " +
              "etcd and in every etcd backup."
          )
        );
      }

      try {
        // 2. CREATE — the Job object, SUSPENDED. The name is now staked and nothing is running.
        const created = await api(
          {
            step: "create",
            method: "POST",
            path: JOBS_PATH(namespace),
            contentType: "application/json",
            body: jobManifest(spec, {
              namespace,
              jobName,
              secretName,
              reapDeadline,
              slots,
              workspaceVolume: config.workspaceVolume,
              runAsNonRoot: config.runAsNonRoot === true,
              ttlSecondsAfterFinished: config.ttlSecondsAfterFinished ?? KUBERNETES_JOB_TTL_SECONDS,
              ...(config.pod ? { pod: config.pod } : {})
            })
          },
          (res) => (res.status >= 200 && res.status < 300) || res.status === 409
        );
        if (isKubernetesAlreadyExists(created)) {
          foreignRun = true;
          fail(
            "create",
            ["POST", JOBS_PATH(namespace)],
            new Error(
              `Job ${jobName} already exists — another run holds this runId. Refusing, and tearing ` +
                `down nothing: the Job behind this name belongs to that run.`
            )
          );
        }

        // 2b. THE PER-RUN SECRET (`secret-env`). See docs/runner-launcher.md §284.
        if (spec.secretEnv.length > 0) {
          const ownerUid = kubernetesObjectUid(created);
          if (!ownerUid) {
            // FAIL, NEVER FALL BACK TO AN UNOWNED SECRET. An unowned Secret is exactly the object
            // this ordering exists to make impossible, and a create response with no `metadata.uid`
            // means something is answering that is not an API server. The `finally` below still
            // deletes the Job.
            fail(
              "secret-env",
              ["POST", JOBS_PATH(namespace)],
              new Error(
                `the Job create response carried no metadata.uid, so the per-run Secret could not be ` +
                  `owned by it. Refusing rather than creating a Secret whose deletion would depend ` +
                  `on this process surviving.`
              )
            );
          }
          const secretCreated = await api(
            {
              step: "secret-env",
              method: "POST",
              path: SECRETS_PATH(namespace),
              contentType: "application/json",
              body: {
                apiVersion: "v1",
                kind: "Secret",
                metadata: {
                  name: secretName,
                  namespace,
                  labels: {
                    [RUNNER_LAUNCHER_OWNER_LABEL]: LAUNCHER_OWNER_ID,
                    [RUNNER_RUN_ID_LABEL]: spec.runId
                  },
                  annotations: { [RUNNER_LAUNCHER_DEADLINE_ANNOTATION]: reapDeadline },
                  ownerReferences: [
                    {
                      apiVersion: "batch/v1",
                      kind: "Job",
                      name: jobName,
                      uid: ownerUid,
                      controller: false,
                      blockOwnerDeletion: false
                    }
                  ]
                },
                type: "Opaque",
                data: Object.fromEntries(
                  spec.secretEnv.map((entry) => {
                    const eq = entry.indexOf("=");
                    return [
                      entry.slice(0, eq),
                      Buffer.from(entry.slice(eq + 1), "utf8").toString("base64")
                    ];
                  })
                )
              }
            },
            (res) => (res.status >= 200 && res.status < 300) || res.status === 409
          );
          if (isKubernetesAlreadyExists(secretCreated)) {
            // Not a foreign run: the create did not conflict. See docs/runner-launcher.md §285.
            fail(
              "secret-env",
              ["POST", SECRETS_PATH(namespace)],
              new Error(
                `Secret ${secretName} already exists without the Job that owned it — orphan debris ` +
                  `from an earlier run of this runId. Refusing rather than reusing or deleting a ` +
                  `Secret this run did not create; Kubernetes garbage-collects it because its ` +
                  `ownerReference no longer resolves, and a retry then succeeds.`
              )
            );
          }
          secretIsOurs = true;
        }

        // 3. COPY IN — sequential and awaited, into this run's own subtree of the shared volume.
        for (const one of spec.copyIn) {
          await copy(
            "copy-in",
            one.hostDir,
            slotDir(workspaceRoot, spec.runId, slots.get(one.containerPath)!)
          );
        }

        // 4. START — unsuspend, then wait for the pod to reach a terminal state and read its log.
        let succeeded: boolean;
        let stdout: string;
        let stderr: string;
        let failure: RunnerFailure | undefined;
        /** Outside the try, because the catch decides. See docs/runner-launcher.md §286. */
        let everStarted = false;
        /** The initial value is a fact, not a placeholder. See docs/runner-launcher.md §287. */
        let waiting = "the Job had not yet been observed";
        /** Did anything describe this run's world after. See docs/runner-launcher.md §288. */
        let observed = false;
        /**
         * WHEN THAT LAST READ LANDED — the half of `observed` pass 18 did not carry, and the fact
         * arm 7's claim is measured against. `0` means never; every landed read moves it.
         */
        let lastObservedAt = 0;
        /** WHAT THE API SERVER SAID ABOUT THE UNSUSPEND. See docs/runner-launcher.md §289. */
        let unsuspend: KubernetesStartFacts["unsuspend"] = "unanswered";
        /** IS THE BUDGET ALREADY GONE? See docs/runner-launcher.md §290. */
        const nothingLeftForStart = runDeadline.spent();
        /** The failure being thrown already states what became of the RUNNER — see
         *  {@link KubernetesStartFacts.runnerVerdict}. Set immediately before the two `fail`s that
         *  carry one, so a `fail` added later is NOT one until somebody says it is. */
        let runnerVerdict = false;
        try {
          try {
            await api({
              step: "start",
              method: "PATCH",
              path: `${JOBS_PATH(namespace)}/${jobName}`,
              contentType: "application/merge-patch+json",
              body: { spec: { suspend: false } }
            });
            unsuspend = "accepted";
          } catch (cause) {
            // A NUMERIC `code` IS AN HTTP STATUS — `api()` builds exactly that shape for a
            // non-2xx, and nothing else here produces one. It is the API server's own answer, so
            // the patch did not apply. Every other rejection (a refusal before the request was
            // issued, an abandoned transport, a socket that never came back) leaves `unanswered`.
            if (cause instanceof RunnerLaunchError && typeof cause.code === "number") {
              unsuspend = "refused";
            } else if (nothingLeftForStart) {
              unsuspend = "not-issued";
            }
            throw cause;
          }

          // POLL TO A TERMINAL POD. See docs/runner-launcher.md §291.
          let pod: PodView | undefined;
          let termination: ReturnType<typeof kubernetesTermination>;
          for (;;) {
            const listed = await api({
              step: "start",
              method: "GET",
              path: `${PODS_PATH(namespace)}?labelSelector=${encodeURIComponent(
                `${RUNNER_RUN_ID_LABEL}=${spec.runId}`
              )}`
            });
            const items = (JSON.parse(listed.body) as { items?: PodView[] }).items ?? [];
            // THE READ COMPLETED, SO THIS RUN HAS SEEN SOMETHING — and an EMPTY list is a sighting,
            // not an absence of one: "the controller has created no pod" is precisely what ROUTE 1's
            // verdict rests on. It is set from the parsed body rather than from entering the loop,
            // because a `GET` that was refused, abandoned or rejected describes nothing.
            observed = true;
            lastObservedAt = Date.now();
            pod = items[0];
            if (kubernetesContainerStarted(pod)) everStarted = true;
            // THE REMEMBERED FLAG, NOT A FRESH READING. A pod carrying a `deletionTimestamp` may
            // already have had its container status pruned, and "did anything ever run?" is exactly
            // what decides whether that deletion is `signalled` or `spawn-failed`.
            termination = pod ? kubernetesTermination(pod, everStarted) : undefined;
            if (termination) break;

            // NO TERMINAL POD. See docs/runner-launcher.md §292.
            let jobVerdict: ReturnType<typeof kubernetesJobTermination>;
            try {
              let events: EventView[] = [];
              if (!pod) {
                // A Job with no pod is the shape a rejected CREATE leaves behind — a ResourceQuota
                // requiring compute limits, a PodSecurity admission refusal. The pod list can say
                // nothing about it because there is nothing in it; the Job's event stream can.
                const eventsRes = await api(
                  { step: "start", method: "GET", path: EVENTS_PATH(namespace, jobName) },
                  (r) => (r.status >= 200 && r.status < 300) || r.status === 403
                );
                if (eventsRes.status >= 200 && eventsRes.status < 300) {
                  events = (JSON.parse(eventsRes.body) as { items?: EventView[] }).items ?? [];
                }
              }
              waiting = kubernetesWaitingEvidence(pod, events);
              if (!pod) {
                const jobRes = await api({
                  step: "start",
                  method: "GET",
                  path: `${JOBS_PATH(namespace)}/${jobName}`
                });
                jobVerdict = kubernetesJobTermination(
                  JSON.parse(jobRes.body) as JobView,
                  everStarted,
                  waiting
                );
              }
            } catch (cause) {
              debug("start: diagnosis read for %s failed: %O", jobName, cause);
            }
            if (jobVerdict) {
              termination = jobVerdict;
              break;
            }

            // SAME QUESTION, SAME ANSWER. Sleeping out a remainder too small to issue anything with
            // only delays the refusal `api()` is about to give.
            if (runDeadline.spent()) continue;
            await sleep(Math.min(pollIntervalMs, runDeadline.remainingMs()));
          }

          const podName = pod?.metadata?.name;
          // THE LOG IS READ EVEN FOR A FAILED RUN, and that is not optional: the runner's own last
          // words are what `classifyRunnerFailure` puts in the operator-facing `detail`.
          let log = "";
          if (podName) {
            try {
              const res = await api(
                {
                  step: "start",
                  method: "GET",
                  accept: LOG_ACCEPT,
                  path: logRequestPath(namespace, podName, spec.maxBuffer)
                },
                // A log read can legitimately 400 ("container is waiting to start") for a pod that
                // never ran. That is not a launch failure — the termination above already says what
                // happened — so it degrades to no output rather than replacing the real diagnosis.
                (r) => (r.status >= 200 && r.status < 300) || r.status === 400 || r.status === 404
              );
              log = res.status >= 200 && res.status < 300 ? res.body : "";
            } catch (cause) {
              /** Every failure of it degrades too. See docs/runner-launcher.md §293. */
              debug("start: the log read for %s failed; continuing without it: %O", podName, cause);
            }
          }

          // OVER `maxBuffer` FAILS THE RUN — see `logRequestPath` for why, and why the request asked
          // for exactly one byte more than the limit.
          if (Buffer.byteLength(log, "utf8") > spec.maxBuffer) {
            // A STATEMENT ABOUT THE RUNNER: it printed this, so it ran. See
            // {@link KubernetesStartFacts.runnerVerdict}.
            runnerVerdict = true;
            fail("start", ["GET", "pods/log"], {
              message: `the runner printed more than maxBuffer (${spec.maxBuffer} bytes) allows`,
              code: RUNNER_MAXBUFFER_CODE,
              stdout: log,
              stderr: ""
            });
          }

          if (termination!.succeeded) {
            succeeded = true;
            stdout = redactAllValues(log, redactions);
            stderr = "";
          } else {
            // THE CLUSTER'S OWN VERDICT ABOUT THE RUNNER — a terminal pod, or a Job that said it
            // failed. See {@link KubernetesStartFacts.runnerVerdict}: nothing in the `catch` is
            // better informed than this, and overriding it is how the negative controls fail.
            runnerVerdict = true;
            fail("start", ["GET", `${PODS_PATH(namespace)}/${podName ?? "?"}`], {
              message: termination!.message,
              code: termination!.code,
              killed: termination!.killed,
              signal: termination!.signal,
              stdout: log,
              stderr: ""
            });
            throw new Error("unreachable");
          }
        } catch (err) {
          // CAPTURED, NOT THROWN — `start` is the one step whose failure becomes a RESULT, exactly
          // as on Docker, so a non-zero runner is an outcome the plugin records rather than a
          // rejection it has to interpret.
          let e = err as RunnerLaunchError;

          /** The one place saying what the failure meant. See docs/runner-launcher.md §294. */
          const verdict = kubernetesStartVerdict({
            runnerVerdict,
            unsuspend,
            observed,
            everStarted,
            // MEASURED AT THE MOMENT THE RUN ENDED, which is where this `catch` runs — teardown has
            // not happened yet, so nothing has moved the clock on this run's behalf.
            unwatchedMs: lastObservedAt > 0 ? Date.now() - lastObservedAt : 0,
            pollIntervalMs,
            deadlineExceeded: e.deadlineExceeded,
            waiting,
            runTimeoutMs
          });
          if (verdict) {
            e = new RunnerLaunchError({
              step: e.step,
              file: `kubernetes://${namespace}`,
              // THE ARGV OF THE CALL THAT DISCOVERED THE FAILURE IS KEPT — it is useful diagnosis,
              // and it is now the only thing that discovery decides.
              argv: [...e.argv],
              cause: {
                // The failure that ended the run is carried. See docs/runner-launcher.md §295.
                message: `${verdict.message} — the failure that ended the run: ${e.message}`,
                // A string code, read by the classifier. See docs/runner-launcher.md §296.
                code: verdict.code,
                // The evidence the original carried is kept. See docs/runner-launcher.md §297.
                stdout: e.stdout,
                stderr: e.stderr
              },
              // The bound is reported as it was, every arm. See docs/runner-launcher.md §298.
              deadlineExceeded: e.deadlineExceeded,
              redactions
            });
          }
          succeeded = false;
          stdout = e.stdout;
          stderr = e.stderr;
          failure = classifyRunnerFailure(e);
        }

        // 5. COPY OUT — conditionally and guarded exactly as the caller asked. Both axes are the
        //    caller's, unchanged; a port that normalised them would break three goldens.
        const copyOut = spec.copyOut;
        if (copyOut && (copyOut.when === "always" || succeeded)) {
          const pending = copy(
            "copy-out",
            slotDir(workspaceRoot, spec.runId, slots.get(copyOut.containerPath)!),
            copyOut.hostDir
          );
          if (copyOut.onFailure === "swallow") {
            await pending.catch(() => undefined);
          } else {
            await pending;
          }
        }

        return succeeded
          ? { succeeded: true, stdout, stderr }
          : { succeeded: false, stdout, stderr, failure: failure! };
      } finally {
        // Teardown: unconditional, outside the run budget. See docs/runner-launcher.md §299.
        if (foreignRun) {
          debug(
            "teardown: SKIPPED for %s — this run lost the name to a run it does not own",
            jobName
          );
        } else {
          // THREE BOUNDED CALLS, AND THE NAMES ARE THE MODEL. See docs/runner-launcher.md §300.
          await withPostDeadlineBound({
            kind: "kubernetes",
            call: "teardown DELETE job",
            what: jobName,
            work: (timeoutMs) =>
              io.request({
                step: "teardown",
                method: "DELETE",
                path: `${JOBS_PATH(namespace)}/${jobName}?propagationPolicy=Background`,
                timeoutMs
              })
          }).catch((cause) => debug("teardown: DELETE job %s failed: %O", jobName, cause));
          if (secretIsOurs) {
            await withPostDeadlineBound({
              kind: "kubernetes",
              call: "teardown DELETE secret",
              what: secretName,
              work: (timeoutMs) =>
                io.request({
                  step: "teardown",
                  method: "DELETE",
                  path: `${SECRETS_PATH(namespace)}/${secretName}`,
                  timeoutMs
                })
            }).catch((cause) => debug("teardown: DELETE secret %s failed: %O", secretName, cause));
          }
          await withPostDeadlineBound({
            kind: "kubernetes",
            call: "teardown removeDir",
            what: runRoot,
            work: (timeoutMs) => io.removeDir({ step: "teardown", dir: runRoot, timeoutMs })
          }).catch((cause) => debug("teardown: removing %s failed: %O", runRoot, cause));
        }
      }
    }
  };
}

/** Plain split/join, never a regex — a secret value may contain regex metacharacters. The Docker
 *  adapter's `redactAll` is module-private to `index.ts`; this is the same three lines rather than a
 *  widening of that file's export surface for one caller. */
function redactAllValues(text: string, needles: readonly string[]): string {
  let out = text;
  for (const needle of needles) {
    if (needle.length === 0) continue;
    out = out.split(needle).join("***");
  }
  return out;
}

/** Escapes the operands and values for variable expansion. See docs/runner-launcher.md §301. */
export function escapeKubernetesVarExpansion(text: string): string {
  return text.replaceAll("$", "$$$$");
}

/** THE JOB MANIFEST. See docs/runner-launcher.md §302. */
export function jobManifest(
  spec: RunnerSpec,
  opts: {
    namespace: string;
    jobName: string;
    secretName: string;
    reapDeadline: string;
    slots: Map<string, string>;
    workspaceVolume: KubernetesWorkspaceVolume;
    runAsNonRoot: boolean;
    ttlSecondsAfterFinished: number;
    /** THE DEPLOYMENT'S POD CONVENTIONS (M23.5). Every field is optional and an absent one emits
     *  nothing, so the golden for a deployment that states none is unchanged. */
    pod?: KubernetesRunnerPodConventions;
  }
): Record<string, unknown> {
  const labels: Record<string, string> = {
    ...spec.labels,
    [RUNNER_LAUNCHER_OWNER_LABEL]: LAUNCHER_OWNER_ID,
    [RUNNER_RUN_ID_LABEL]: spec.runId,
    // CARRIED, NOT ENFORCED — see `RUNNER_NETWORK_LABEL`. `networkMode` is an arbitrary caller string
    // ("none", "bridge", an operator's network name); only a legal label value can be stamped, and a
    // value that cannot be is recorded as `unexpressible` rather than dropped, so a NetworkPolicy
    // written against `scp.launcher.network=none` never silently selects nothing.
    [RUNNER_NETWORK_LABEL]: isKubernetesLabelValue(spec.networkMode)
      ? spec.networkMode
      : "unexpressible"
  };

  const volumeMounts = [...opts.slots].map(([containerPath, slot]) => ({
    name: RUNNER_WORKSPACE_VOLUME_NAME,
    mountPath: containerPath,
    subPath: slotSubPath(spec.runId, slot)
  }));

  const volume: Record<string, unknown> =
    opts.workspaceVolume.kind === "persistentVolumeClaim"
      ? {
          name: RUNNER_WORKSPACE_VOLUME_NAME,
          persistentVolumeClaim: { claimName: opts.workspaceVolume.claimName }
        }
      : {
          name: RUNNER_WORKSPACE_VOLUME_NAME,
          hostPath: { path: opts.workspaceVolume.path, type: "DirectoryOrCreate" }
        };

  const pod = opts.pod ?? {};

  return {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: {
      name: opts.jobName,
      namespace: opts.namespace,
      labels,
      annotations: { [RUNNER_LAUNCHER_DEADLINE_ANNOTATION]: opts.reapDeadline }
    },
    spec: {
      // CREATED SUSPENDED. This is what makes `create` and `start` two steps rather than one, which
      // is what makes the name-staking happen before the byte movement. See the module header.
      suspend: true,
      backoffLimit: 0,
      completions: 1,
      parallelism: 1,
      // A backstop for the budget, enforced by the controller. See docs/runner-launcher.md §303.
      activeDeadlineSeconds: Math.ceil(runnerRunBoundMs("kubernetes", spec.timeoutMs) / 1000),
      ttlSecondsAfterFinished: opts.ttlSecondsAfterFinished,
      template: {
        metadata: { labels },
        spec: {
          restartPolicy: "Never",
          // THE DEPLOYMENT'S OWN PULL SECRETS. See docs/runner-launcher.md §304.
          ...(pod.imagePullSecrets && pod.imagePullSecrets.length > 0
            ? { imagePullSecrets: pod.imagePullSecrets.map((name) => ({ name })) }
            : {}),
          // THE RUNNER NEVER TALKS TO THE API SERVER. The orchestrator does; the runner is handed
          // bytes and an argv. Same posture as the reference shape in `runner-iac.yaml`.
          automountServiceAccountToken: false,
          securityContext: {
            ...(opts.runAsNonRoot ? { runAsNonRoot: true } : {}),
            seccompProfile: { type: "RuntimeDefault" }
          },
          containers: [
            {
              name: RUNNER_CONTAINER_NAME,
              image: spec.image,
              // An unset pull policy means always for latest. See docs/runner-launcher.md §305.
              ...(pod.imagePullPolicy ? { imagePullPolicy: pod.imagePullPolicy } : {}),
              args: spec.operands.map(escapeKubernetesVarExpansion),
              env: spec.env.map((entry) => {
                const eq = entry.indexOf("=");
                return {
                  name: entry.slice(0, eq),
                  value: escapeKubernetesVarExpansion(entry.slice(eq + 1))
                };
              }),
              ...(spec.secretEnv.length > 0
                ? { envFrom: [{ secretRef: { name: opts.secretName } }] }
                : {}),
              securityContext: {
                allowPrivilegeEscalation: false,
                readOnlyRootFilesystem: false,
                capabilities: { drop: ["ALL"] }
              },
              // A ResourceQuota REQUIRING compute limits REJECTS a pod that declares none — no pod
              // is ever created, so there is nothing for `kubernetesTermination` to read. See
              // `values.yaml` for why the chart ships no default here and the honest failure mode.
              ...(pod.resources ? { resources: pod.resources } : {}),
              volumeMounts
            }
          ],
          volumes: [volume]
        }
      }
    }
  };
}

// THE PRODUCTION TRANSPORT — plain `fetch` + the projected service-account token (owner decision 7)

/** Where a projected service-account token and the cluster CA are mounted in every pod. */
export const K8S_SA_DIR = "/var/run/secrets/kubernetes.io/serviceaccount";

/** NO KUBERNETES CLIENT LIBRARY. See docs/runner-launcher.md §306. */
export function createFetchKubernetesIo(opts: {
  apiBase?: string;
  readToken: () => Promise<string>;
  /** The timeout is handed down as a best effort. See docs/runner-launcher.md §307. */
  copyDir: (fromDir: string, toDir: string, timeoutMs: number) => Promise<void>;
  removeDir: (dir: string, timeoutMs: number) => Promise<void>;
  fetchImpl?: typeof fetch;
}): KubernetesRunnerIo {
  kubernetesConstructions += 1;
  const apiBase = opts.apiBase ?? "https://kubernetes.default.svc";
  const doFetch = opts.fetchImpl ?? fetch;
  return {
    async request(req: KubernetesApiRequest): Promise<KubernetesApiResponse> {
      const token = await opts.readToken();
      const headers: Record<string, string> = {
        authorization: `Bearer ${token.trim()}`,
        accept: req.accept ?? "application/json"
      };
      if (req.body !== undefined) headers["content-type"] = req.contentType ?? "application/json";
      const res = await doFetch(`${apiBase}${req.path}`, {
        method: req.method,
        headers,
        ...(req.body === undefined ? {} : { body: JSON.stringify(req.body) }),
        signal: AbortSignal.timeout(req.timeoutMs)
      });
      return { status: res.status, body: await res.text() };
    },
    copyDir: (op) => opts.copyDir(op.fromDir, op.toDir, op.timeoutMs),
    removeDir: (op) => opts.removeDir(op.dir, op.timeoutMs)
  };
}

// ADAPTER SELECTION — the field M23.1 said would land here, and the three layers it moves through

/** THE SELECTING RESOLVER. See docs/runner-launcher.md §308. */
export const resolveRunnerLauncher: ResolveRunnerLauncher = (config: RunnerLauncherConfig) => {
  if (config.runnerLauncher !== "kubernetes") {
    return createDockerRunnerLauncher(config.dockerBinary ?? DEFAULT_DOCKER_BINARY);
  }
  const k8s = config.kubernetes;
  if (!k8s) {
    // FAIL CLOSED AND NAME THE MISSING PIECE. An operator who selected the Kubernetes launcher and
    // whose deployment did not supply its settings gets one sentence here instead of a `TypeError`
    // deep inside a Job manifest — the same direction every refusal in this package leans.
    throw new Error(
      "runnerLauncher='kubernetes' was selected but no kubernetes settings were injected " +
        "(namespace, workspaceRoot and a workspace volume are required — see managedRunnerSettings())"
    );
  }
  return createKubernetesRunnerLauncher({
    namespace: k8s.namespace,
    workspaceRoot: k8s.workspaceRoot,
    workspaceVolume: k8s.workspaceVolume,
    perRunSecrets: k8s.perRunSecrets === true,
    runAsNonRoot: k8s.runAsNonRoot === true,
    // M23.5 — THE DEPLOYMENT'S POD CONVENTIONS. Carried through the resolver like every other
    // setting, so the ONE selection path (which `promotion-scan-step.ts` and all three bindings
    // share) is also the one place a convention can be dropped.
    ...(k8s.pod ? { pod: k8s.pod } : {}),
    io: k8s.io ?? createDefaultKubernetesIo(k8s.apiBase)
  });
};

/** The production adapter object, as a named export. See docs/runner-launcher.md §309. */
export function createDefaultKubernetesIo(apiBase?: string): KubernetesRunnerIo {
  return createFetchKubernetesIo({
    apiBase,
    readToken: async () => {
      const { readFile } = await import("node:fs/promises");
      return readFile(`${K8S_SA_DIR}/token`, "utf8");
    },
    copyDir: async (fromDir, toDir) => {
      const { cp, mkdir } = await import("node:fs/promises");
      await mkdir(toDir, { recursive: true });
      await cp(fromDir, toDir, { recursive: true });
    },
    removeDir: async (dir) => {
      const { rm } = await import("node:fs/promises");
      await rm(dir, { recursive: true, force: true });
    }
  });
}

/** A stable, short digest of a string — used by the harness to build in-bounds run ids. Exported
 *  from here rather than duplicated in a test, so the harness and the adapter agree by construction. */
export function shortDigest(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex").slice(0, 10);
}
