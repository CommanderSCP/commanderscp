import { createHash } from "node:crypto";
import { debuglog } from "node:util";
import {
  DEFAULT_DOCKER_BINARY,
  LAUNCHER_OWNER_ID,
  RUNNER_LAUNCHER_OWNER_LABEL,
  RUNNER_MAXBUFFER_CODE,
  RUNNER_REAP_BUDGET_MS,
  RUNNER_REAP_GRACE_MS,
  RUNNER_REMOVE_TIMEOUT_MS,
  RUNNER_RUN_ID_PATTERN,
  RunnerLaunchError,
  classifyRunnerFailure,
  clampRunTimeoutMs,
  createDockerRunnerLauncher,
  runnerContainerName
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

/**
 * ================================================================================================
 * THE KUBERNETES ADAPTER (M23.2) — THE SECOND IMPLEMENTATION OF THE PORT M23.1 EXTRACTED
 * ================================================================================================
 *
 * WHY IT IS A SECOND ADAPTER AND NOT A FOURTH LAUNCH SEQUENCE. M23.1's whole finding was that three
 * plugins had each hand-rolled one mechanism, so a fix or a new platform arm had to be applied three
 * times and the instance that got missed was invisible. This file is the test of that claim: it adds
 * a platform arm and touches **no plugin**. The three `launch-argv.golden.test.ts` files do not move
 * by a byte, and `launcher-seam.test.ts` — which pins each plugin's whole `RunnerSpec` with
 * `toStrictEqual` and constructs its launcher by hand — is adapter-independent by construction and
 * is likewise untouched.
 *
 * ------------------------------------------------------------------------------------------------
 * THE LIFECYCLE MAPPING, AND WHY `suspend` IS THE ONE THAT MAKES IT FAITHFUL
 * ------------------------------------------------------------------------------------------------
 * The port's five steps are `create` -> `copy-in` -> `start` -> `copy-out` -> `teardown`, and the
 * order is not decoration: `docker create` stakes the NAME before a single byte is copied, so two
 * concurrent runs of one `runId` collide on the name rather than on each other's workspace bytes
 * (`isContainerNameConflict`, M23.1e). Any Kubernetes mapping that moved the name-staking after the
 * byte movement would re-open that race in a worse form — two runs writing the same files.
 *
 *   create    POST a Job with `spec.suspend: true`. The Job object exists; no pod does. This is the
 *             precise analogue of `docker create`: the name is claimed (a duplicate is a typed 409
 *             `AlreadyExists`, which is STRICTLY better than Docker's `already in use` stderr
 *             substring match) and nothing is running yet.
 *   copy-in   A recursive filesystem copy into a per-run subtree of the SHARED workspace volume.
 *             There is no `docker cp` on Kubernetes and there cannot be: a ConfigMap fails the 1 MiB
 *             etcd limit and `pods/exec` + tar is impossible against `apps/runner-dep`'s seven-applet
 *             `FROM scratch` image, which has no tar and no shell. Owner decision 5 (2026-08-18)
 *             therefore makes RWX storage a documented deployment prerequisite, and this is where
 *             that prerequisite is spent. The copies are sequential and awaited for the same reason
 *             they are on Docker — see `ordering-conformance.ts`.
 *   start     PATCH `spec.suspend: false`, then poll the run's pod to a terminal state and read its
 *             log. This is the only step that can consume real time and it is the one the whole-run
 *             deadline mostly bounds.
 *   copy-out  A recursive filesystem copy back OUT of the same subtree, honouring `when` and
 *             `onFailure` unchanged — the two asymmetries M23.1 refused to normalise.
 *   teardown  DELETE the Job (background propagation), DELETE the per-run Secret, remove the
 *             workspace subtree. Unconditional, outside the run budget, swallowed-but-not-silent —
 *             all three exactly as the Docker adapter, and with the same ONE exception: a run that
 *             lost the name to somebody else tears down NOTHING, because none of it is its own.
 *
 * BYTES ARE COPIED, NEVER MOUNTED FROM THE HOST — the same structural property the Docker adapter
 * keeps by never passing `-v`. The Job mounts one operator-declared volume, at subpaths this adapter
 * derives from the caller's `containerPath`s; no caller-supplied host path becomes a mount.
 *
 * ------------------------------------------------------------------------------------------------
 * WHAT THE PORT COULD NOT PROMISE, SAID OUT LOUD RATHER THAN PAPERED OVER
 * ------------------------------------------------------------------------------------------------
 * 1. `networkMode` CANNOT BE HONOURED, and this adapter does not pretend otherwise (owner decision 1,
 *    BUILD_AND_TEST.md M23). No pod-spec field, annotation, `securityContext` or RuntimeClass removes
 *    a pod's network namespace. The strongest portable substitute is a deny-all-egress
 *    NetworkPolicy — traffic denial, not interface absence, and fail-open on a CNI that does not
 *    enforce (measured on kind + kindnet: a pod SELECTED by a deny-all-egress policy reached a public
 *    IP and a resolver, indistinguishable from an unselected control). So the adapter does the one
 *    honest thing available: it CARRIES the resolved value to where a policy can act on it, as the
 *    pod label {@link RUNNER_NETWORK_LABEL}, and CLAIMS NOTHING. The port's own rule is unchanged —
 *    it "takes the resolved value and never decides it".
 * 2. `pods/log` MERGES stdout AND stderr into one stream and does not preserve their interleaving
 *    (measured: a container printing STDOUT-LINE then STDERR-LINE returned them reversed). The port's
 *    {@link RunnerResult} has two fields. This adapter puts the whole merged stream in `stdout` and
 *    leaves `stderr` EMPTY — see {@link KUBERNETES_MERGES_STDERR_INTO_STDOUT} for why that direction
 *    and not the other, and for the two readers that decide it.
 * 3. `maxBuffer` IS AN `execFile` CONCEPT. Kubernetes offers `limitBytes`, which truncates at the
 *    SERVER and returns success. `output-exceeded` is kept REACHABLE anyway — see
 *    {@link logRequestPath} — because the hazard it names ("the output looks like data but is
 *    truncated") is a property of the evidence, not of Node.
 * 4. THE PER-RUN SECRET IS A DECLARED, DISABLED CAPABILITY. It is built, tested and OFF. See
 *    {@link KubernetesRunnerLauncherConfig.perRunSecrets}.
 */

// ==================================================================================================
// THE TWO CONTRACT DECISIONS THIS ADAPTER HAD TO TAKE, NAMED SO THEY ARE MUTATABLE
// ==================================================================================================

/**
 * KUBERNETES HANDS BACK ONE STREAM; THE PORT HAS TWO FIELDS. THIS IS WHICH ONE GETS IT.
 *
 * `GET pods/<pod>/log` returns the container's stdout and stderr already merged, with no marker
 * saying which line came from where and no guarantee of interleaving order (measured on a real
 * cluster: `echo STDOUT-LINE; echo STDERR-LINE >&2` came back STDERR-LINE first). There is no second
 * endpoint that splits them. So one of `RunnerResult.stdout` / `RunnerResult.stderr` gets everything
 * and the other gets `""`, and the choice is a PORT-CONTRACT decision an operator can feel — not an
 * accident of which field the adapter happened to fill.
 *
 * IT IS `stdout`, DECIDED BY THE TWO READERS THAT EXIST:
 *   - `runnerOutcomeDetail` returns `result.stdout` ON SUCCESS, and for managed-iac that string is
 *     the durable evidence a `tofu plan` wrote. Filling `stderr` instead would make every successful
 *     managed run record an empty detail — the exact `detail: ""` defect `RunnerResult`'s union was
 *     introduced to end.
 *   - `classifyRunnerFailure` reads `err.stderr.length > 0 ? err.stderr : err.stdout`, with the
 *     comment "a runner that explains itself on stdout (managed-dep's does) must not be recorded as
 *     silent". With `stderr` empty that fall-through is taken and the merged log reaches the
 *     diagnosis unchanged.
 * Filling `stderr` would have broken the first reader and merely coincidentally satisfied the second.
 */
export const KUBERNETES_MERGES_STDERR_INTO_STDOUT = true;

/**
 * THE POD LABEL THAT CARRIES THE UNHONOURABLE `networkMode`.
 *
 * Owner decision 1 accepted that `--network none` has no pod-spec equivalent. What it did NOT accept
 * is the adapter silently dropping the caller's value: managed-dep passes `RUNNER_NETWORK_MODE` as a
 * charter LITERAL (ADR-0032 §8d) precisely so no operator setting can contradict it, and a value that
 * vanishes at the adapter is a setting contradicted by omission. The value is therefore stamped on
 * the pod, where a NetworkPolicy `podSelector` can act on it and where `kubectl get pod -L` shows an
 * operator what the runner ASKED for.
 *
 * THIS IS NOT ENFORCEMENT AND MUST NEVER BE READ AS ENFORCEMENT. Whether anything denies that pod's
 * egress depends on a NetworkPolicy existing AND on the CNI enforcing it, and the repo's own
 * measurements say the default kind CNI does neither (`scripts/airgap-drill.sh:8-11`; re-measured for
 * M23.2 with a known-positive control).
 */
export const RUNNER_NETWORK_LABEL = "scp.launcher.network";

/** The pod/Job label carrying `RunnerSpec.runId` — this adapter's own selector, deliberately NOT
 *  Kubernetes' `job-name`/`batch.kubernetes.io/job-name`, whose spelling changed across versions. */
export const RUNNER_RUN_ID_LABEL = "scp.launcher.run-id";

/**
 * THE DEADLINE IS AN ANNOTATION, NOT A LABEL — MEASURED, NOT ASSUMED.
 *
 * `reap()`'s predicate is "foreign AND past its stamped deadline", and on Docker both halves are
 * labels. On Kubernetes only the first half can be: a label VALUE must match
 * `(([A-Za-z0-9][-A-Za-z0-9_.]*)?[A-Za-z0-9])?`, and an RFC3339 instant contains colons. Measured
 * against a real API server:
 *
 *     kubectl label job k1 scp.launcher.owner=abc-123          -> job.batch/k1 labeled
 *     kubectl label job k1 scp.launcher.deadline=2026-...:00Z  -> error: invalid label value
 *
 * The same value is accepted verbatim as an ANNOTATION, and one `GET jobs?labelSelector=<owner>`
 * returns both, so the predicate is preserved exactly. Storing a reformatted deadline (epoch millis,
 * colons stripped) was the alternative and is worse: `reap()` fails CLOSED on an unparsable deadline,
 * so a stamp only this package can read is a stamp an operator cannot audit, and a silently
 * reformatted one is precisely the "ambiguous must never read as safe" hazard the Docker predicate
 * guards.
 */
/**
 * A LITERAL, NOT `= RUNNER_LAUNCHER_DEADLINE_LABEL`, AND THE REASON IS A DEFECT THIS FILE SHIPPED
 * FOR ONE COMMIT.
 *
 * `index.ts` re-exports this module and this module imports `index.ts`, which is a legal ESM cycle
 * for FUNCTION bodies (nothing reads a binding until it is called) and an immediate
 * `ReferenceError` for a top-level `const` initialised from the other module's binding. Written as
 * `= RUNNER_LAUNCHER_DEADLINE_LABEL`, loading `@scp/runner-launcher` from a real Node ESM loader
 * failed with `Cannot access 'RUNNER_LAUNCHER_DEADLINE_LABEL' before initialization` — so every
 * managed-executor plugin SUBPROCESS died at import and `plugin instance … did not become ready`
 * was the only symptom.
 *
 * WHAT MAKES IT WORTH THIS MANY LINES: the unit test written to catch exactly this passed. It
 * imports `./index.js` under vitest, whose module graph resolved the cycle in the other order, so
 * "the module cycle resolves" was asserted, green, and false. Only loading the BUILT package under
 * `node` found it — `module-load.integration.test.ts` now does that permanently, and
 * `runner-launcher-selection.test.ts` in each plugin package would also have caught it had it run
 * against `dist`. The equality this line used to express is asserted there instead, where being
 * wrong is a failed assertion rather than a dead subprocess.
 */
export const RUNNER_LAUNCHER_DEADLINE_ANNOTATION = "scp.launcher.deadline";

// ==================================================================================================
// THE SEAM — one injected object, the exact analogue of `dockerBinary` + `execFile`
// ==================================================================================================

/** One request this adapter makes of the Kubernetes API server. */
export interface KubernetesApiRequest {
  /** Which port step this request belongs to. PRODUCTION-NECESSARY: every rejection out of this
   *  adapter is a {@link RunnerLaunchError} and must name the step that failed. */
  readonly step: RunnerLaunchStep;
  readonly method: "GET" | "POST" | "PATCH" | "DELETE";
  /** Path AND query, relative to the API server root. */
  readonly path: string;
  /** JSON body, already the exact object to serialise. Absent for GET/DELETE. */
  readonly body?: unknown;
  /** `application/merge-patch+json` for the unsuspend PATCH; `application/json` otherwise. */
  readonly contentType?: string;
  /** {@link LOG_ACCEPT} for a log read; `application/json` otherwise. */
  readonly accept?: string;
  /** Derived from the ONE whole-run deadline, never from `spec.timeoutMs`. */
  readonly timeoutMs: number;
}

export interface KubernetesApiResponse {
  readonly status: number;
  /** The response body as text. JSON is parsed by the adapter, never by the transport. */
  readonly body: string;
}

/**
 * EVERYTHING THIS ADAPTER TOUCHES OUTSIDE ITS OWN PROCESS, behind one injected object — the same
 * shape `dockerBinary` + `execFile` is for the Docker adapter, and for the same reason: a unit suite
 * has to be able to record and hold every effect, and a golden has to be able to pin every byte.
 *
 * TWO KINDS OF EFFECT, DELIBERATELY NOT UNIFIED. `request` talks to the API server; `copyDir` and
 * `removeDir` move bytes on the shared workspace volume. Collapsing them into one "do a thing" verb
 * would hide the fact that the byte movement is NOT an API call — which is the single most important
 * structural difference between this adapter and the Docker one, and the thing owner decision 5 is
 * about.
 */
export interface KubernetesRunnerIo {
  request(req: KubernetesApiRequest): Promise<KubernetesApiResponse>;
  /** Recursively copy the CONTENTS of `fromDir` into `toDir`, creating `toDir`. The exact semantics
   *  of `docker cp <src>/. <dst>`, which is what the port's `copyIn`/`copyOut` are specified as. */
  copyDir(op: { step: RunnerLaunchStep; fromDir: string; toDir: string }): Promise<void>;
  /** Recursively remove `dir`. Absent is not an error — teardown is unconditional. */
  removeDir(op: { step: RunnerLaunchStep; dir: string }): Promise<void>;
}

/**
 * Where the Job's shared workspace volume comes from. A CLOSED UNION, not an operator-supplied JSON
 * blob: this object lands verbatim inside a pod spec this process POSTs with its own service-account
 * token, so "whatever JSON the operator put in an env var" would be an arbitrary-volume-mount
 * primitive wearing a config field's clothes.
 */
export type KubernetesWorkspaceVolume =
  /** PRODUCTION. The RWX PersistentVolumeClaim owner decision 5 makes a deployment prerequisite. */
  | { readonly kind: "persistentVolumeClaim"; readonly claimName: string }
  /**
   * THE HARNESS ONLY, and it is here rather than in test code because the kind-based gate is the
   * whole point of this increment and it must exercise the SHIPPED adapter. A single-node cluster
   * has no RWX class; a host directory mounted into the node is the local model of one.
   */
  | { readonly kind: "hostPath"; readonly path: string };

export interface KubernetesRunnerLauncherConfig {
  /** The namespace every Job, Secret and pod read lives in. Never derived from a tenant value. */
  readonly namespace: string;
  /** Where THIS process sees the shared workspace volume. The Job sees the same bytes. */
  readonly workspaceRoot: string;
  readonly workspaceVolume: KubernetesWorkspaceVolume;
  /**
   * PER-RUN SECRETS — A DECLARED CAPABILITY THAT IS OFF, AND THIS FIELD IS THE ONLY THING THAT TURNS
   * IT ON.
   *
   * `RunnerSpec.secretEnv` exists because credentials had to leave the argv (M23.1a, ADR-0035), and
   * the port's own doc names the Kubernetes mapping as the reason the field is split at all: "a
   * per-run Secret + `envFrom.secretRef` rather than as `env[].value`". That mapping needs
   * `""/secrets: create,get,delete` on the worker ServiceAccount, and
   * `deploy/helm/templates/runner-iac.yaml`'s Role grants `batch/jobs` and `pods`/`pods/log` and
   * NOTHING ELSE — in a chart whose two other Roles do grant `secrets`, scoped to `get` only, on
   * separate hook ServiceAccounts. Widening it is an OWNER DECISION and it has not been taken.
   *
   * SO THE CAPABILITY IS WIRED AND DISABLED RATHER THAN ASSUMED OR DROPPED. With this `false`
   * (the default, and what the chart renders unless an operator opts in), a spec carrying a
   * non-empty `secretEnv` is REFUSED at step `"secret-env"` before anything is created. The two
   * alternatives were both worse and are named so nobody reaches for them later:
   *   - Fall back to `env[].value`. That is plaintext credentials in etcd and in every etcd backup,
   *     which the port's own header calls "strictly worse than the host process table this replaced".
   *   - Drop `secretEnv` silently. A managed-iac apply would then run with no AWS credentials and
   *     fail somewhere inside OpenTofu, which is a mystery instead of a refusal.
   *
   * WHAT IS INERT TODAY, EXACTLY: only `managed-iac` populates `secretEnv` (managed-scan passes
   * `[]` with the comment "NO CREDENTIAL AT ALL"; managed-dep likewise). So on Kubernetes with this
   * off, managed-scan and managed-dep run and managed-iac refuses, loudly, at the first step.
   */
  readonly perRunSecrets: boolean;
  /**
   * The pod `securityContext.runAsNonRoot`. DEFAULTS TO FALSE, AND THAT IS A FINDING RATHER THAN A
   * PREFERENCE: `deploy/helm/templates/runner-iac.yaml`'s reference Job shape asserts
   * `runAsNonRoot: true`, and NONE of the three runner images satisfies it — a filterless read of
   * `apps/runner-{iac,scan,dep}/Dockerfile` finds no `USER` line in any of them, so all three run as
   * uid 0. Shipping the reference shape's value would make every managed run on Kubernetes fail with
   * `CreateContainerConfigError` before the entrypoint ran. `kubernetes-adapter.integration.test.ts`
   * drives exactly that failure against a real cluster and asserts it lands as `spawn-failed`.
   */
  readonly runAsNonRoot?: boolean;
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

/** Default `ttlSecondsAfterFinished`, matching `runner-iac.yaml`'s reference shape. */
export const KUBERNETES_JOB_TTL_SECONDS = 3_600;

/** The one container in every runner Job. Fixed, because `pods/log?container=` needs a name and a
 *  caller-supplied one would be a second identity nothing else in the port knows about. */
export const RUNNER_CONTAINER_NAME = "runner";

/** The volume name every runner Job mounts its workspace subpaths from. */
export const RUNNER_WORKSPACE_VOLUME_NAME = "workspace";

// ==================================================================================================
// NAMES AND PATHS — derived, never invented, and every one of them bounded
// ==================================================================================================

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

/**
 * ONE WORKSPACE SLOT PER DISTINCT `containerPath`, AND THAT IS WHAT MAKES managed-iac WORK.
 *
 * managed-iac copies IN to `/workspace` and copies OUT of `/workspace` — the same directory, because
 * the runner edits in place and the evidence is what it left there. A slot allocated per copy
 * OPERATION would give the copy-out its own empty directory and silently lose every `plan.json`,
 * with the run still reporting success: the exact shape of the race `ordering-conformance.ts` exists
 * for, arrived at from the other direction. Slots are therefore keyed by `containerPath`, in
 * first-appearance order over `copyIn` then `copyOut`, so the mapping is a pure function of the spec
 * and a golden can pin it.
 */
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

/**
 * THE LOG READ, AND HOW `output-exceeded` STAYS REACHABLE WITHOUT AN `execFile`.
 *
 * `maxBuffer` is Node's `execFile` buffer and `RUNNER_MAXBUFFER_CODE` is Node's error code; neither
 * exists here. Kubernetes offers `limitBytes`, whose semantics are DIFFERENT in the way that matters:
 * `execFile` FAILS the call, `limitBytes` returns a short body successfully. Returning the short body
 * as if it were the whole thing is precisely the hazard the port names — "`stdout` holds the output
 * TRUNCATED at the limit, which is the hazard: it looks like data".
 *
 * So the request asks for `maxBuffer + 1` bytes and the adapter FAILS the run when it gets more than
 * `maxBuffer` — same verdict as Docker, same `RunnerFailureKind`, reached through the one mechanism
 * Kubernetes offers. The `+1` is the whole trick: it is the smallest read that can distinguish
 * "exactly at the limit" from "over it".
 */
/**
 * THE `Accept` HEADER FOR A LOG READ, AND `text/plain` IS THE WRONG ANSWER — MEASURED, NOT INFERRED.
 *
 * `pods/log` serves a plain-text body, so `Accept: text/plain` looks obviously right and the API
 * server answers it with **406 Not Acceptable**. Kubernetes content-negotiates every subresource
 * against its own serializer list, which offers `application/json`, `application/yaml` and
 * `application/vnd.kubernetes.protobuf` — `text/plain` is not among them, and the log body arrives
 * as an unnegotiated stream regardless.
 *
 * WHAT THAT COST BEFORE THE HARNESS RAN: every failed run reported `exit-nonzero` with
 * `code: 406`. The log read rejected, the rejection replaced the pod's real termination, and an
 * operator reading a `spawn-failed` ImagePullBackOff would have been told the runner exited 406.
 * Nothing in `kubernetes-adapter.test.ts` could see it — a fake answers whatever Accept it is given.
 */
const LOG_ACCEPT = "*/*";

function logRequestPath(ns: string, podName: string, maxBuffer: number): string {
  return `${PODS_PATH(ns)}/${podName}/log?container=${RUNNER_CONTAINER_NAME}&limitBytes=${maxBuffer + 1}`;
}

// ==================================================================================================
// KUBERNETES-SHAPED VALIDATION — the refusals the Docker adapter had no need of
// ==================================================================================================

/** A label VALUE the API server accepts. Empty is legal; 63 characters is the ceiling. */
const K8S_LABEL_VALUE = /^(([A-Za-z0-9][-A-Za-z0-9_.]*)?[A-Za-z0-9])?$/;

/**
 * IS THIS `RunnerSpec.labels` ENTRY EXPRESSIBLE AS A KUBERNETES LABEL?
 *
 * The port validates labels only against Docker's much looser rules (`[\r\n]` in the value). It says
 * so: `RunnerSpec.labels`'s doc promises "Kubernetes: `metadata.labels`" and the port makes no promise
 * the values are legal there. Today all three plugins pass `scp.executor` and `scp.run-id` with
 * values that are legal on both — but "today all three happen to comply" is exactly the property that
 * goes false when a fourth managed class arrives, and the failure mode without this check is a 422
 * from the API server mid-`create`, i.e. a launch that fails for a reason no operator can act on.
 * Refuse at step `"spec"`, before anything exists, naming the offending key.
 */
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

// ==================================================================================================
// THE POD'S TERMINAL STATE -> THE PORT'S FIVE FAILURE KINDS
// ==================================================================================================

/** The slice of a pod this adapter reads. Everything else in the object is ignored. */
interface PodView {
  metadata?: { name?: string };
  status?: {
    phase?: string;
    containerStatuses?: {
      name?: string;
      state?: {
        terminated?: { exitCode?: number; signal?: number; reason?: string };
        waiting?: { reason?: string; message?: string };
      };
    }[];
  };
}

/**
 * A pod state that is FATAL BEFORE THE ENTRYPOINT RAN — the Kubernetes spelling of `spawn-failed`
 * ("the container CLI could not be executed at all — nothing ran. Nothing ran, so nothing was
 * mutated"). Every one of these is terminal in practice and none of them will resolve by waiting;
 * polling through them to the whole-run deadline would report `budget-exhausted`, which is the single
 * worst misdiagnosis available here — for managed-iac it means "a `tofu apply` was SIGTERMed
 * mid-flight, so the real infrastructure state is unknown", when in fact nothing ran at all.
 */
const FATAL_WAITING_REASONS = new Set([
  "ErrImagePull",
  "ImagePullBackOff",
  "InvalidImageName",
  "CreateContainerConfigError",
  "CreateContainerError",
  "RunContainerError"
]);

/**
 * WHAT THE RUN'S POD SAYS HAPPENED — or `undefined` while it is still going.
 *
 * THE RETURN IS SHAPED AS AN `execFile` REJECTION ON PURPOSE, and that is the single most useful
 * thing in this file. `classifyRunnerFailure` is the port's only producer of a {@link RunnerFailure},
 * it is 30 lines of measured branch ORDER, and its five kinds are the operator-facing vocabulary the
 * whole product records. Writing a second Kubernetes classifier would have been the M23.1 defect
 * again — one mechanism, two implementations, and the one that gets missed is invisible. So this
 * function's job is translation, not classification: it produces `code`/`killed`/`signal` such that
 * the EXISTING classifier reaches the right kind, and every one of the five is exercised by a named
 * test.
 *
 *   pod Succeeded                      -> succeeded
 *   terminated, signal != 0            -> killed: true            -> `signalled`
 *   terminated, reason OOMKilled       -> killed: true            -> `signalled`
 *   waiting, a fatal image/config      -> code: "<Reason>"        -> `spawn-failed` (a STRING code)
 *   terminated, exitCode != 0          -> code: <number>          -> `exit-nonzero`
 *
 * `budget-exhausted` and `output-exceeded` are not produced here: the first is the deadline path
 * (`deadlineExceeded`) and the second is the log-size check, exactly as on Docker.
 */
export function kubernetesTermination(pod: PodView):
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

// ==================================================================================================
// THE ADAPTER
// ==================================================================================================

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

export function createKubernetesRunnerLauncher(
  config: KubernetesRunnerLauncherConfig
): RunnerLauncher {
  const { namespace, workspaceRoot, io } = config;
  const sleep = config.sleep ?? defaultSleep;
  const pollIntervalMs = config.pollIntervalMs ?? KUBERNETES_POLL_INTERVAL_MS;

  /**
   * See `RunnerLauncher.reap`. Lists every Job this package labelled (any owner) and deletes exactly
   * the ones that are BOTH foreign AND past their stamped deadline — the SAME predicate as the Docker
   * adapter's, fail-closed on a missing or unparsable deadline, because an ambiguous stamp must never
   * read as "safe to destroy".
   */
  const reapOnce = async (): Promise<string[]> => {
    const passDeadline = Date.now() + RUNNER_REAP_BUDGET_MS;
    let listing: KubernetesApiResponse;
    try {
      listing = await io.request({
        step: "teardown",
        method: "GET",
        path: `${JOBS_PATH(namespace)}?labelSelector=${encodeURIComponent(RUNNER_LAUNCHER_OWNER_LABEL)}`,
        timeoutMs: RUNNER_REMOVE_TIMEOUT_MS
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
      if (!Number.isFinite(deadlineMs) || deadlineMs > now) continue; // missing/garbled/future
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
        await io.request({
          step: "teardown",
          method: "DELETE",
          path: `${JOBS_PATH(namespace)}/${name}?propagationPolicy=Background`,
          timeoutMs: RUNNER_REMOVE_TIMEOUT_MS
        });
        // THE WORKSPACE SUBTREE GOES WITH THE JOB. A SIGKILLed predecessor's copy-in bytes are on a
        // SHARED volume with nothing else sweeping them, and for managed-dep those bytes are a
        // tenant's manifest. This is the Kubernetes form of the `--env-file` sweep MEDIUM-4 added on
        // the Docker side: ONE cleanup concept, reached through the same method.
        await io.removeDir({ step: "teardown", dir: `${workspaceRoot}/${name}` });
        if (config.perRunSecrets) {
          await io.request({
            step: "teardown",
            method: "DELETE",
            path: `${SECRETS_PATH(namespace)}/${name}-env`,
            timeoutMs: RUNNER_REMOVE_TIMEOUT_MS
          });
        }
        removed.push(name);
      } catch (cause) {
        debug("reap: deleting Job %s failed, leaving it for the next pass: %O", name, cause);
      }
    }
    return removed;
  };

  /**
   * `reapOnce`, single-flighted per NAMESPACE. `secretEnvDir` IS ACCEPTED AND IGNORED, and that is a
   * fact worth a sentence rather than a shrug: it is the Docker adapter's transient `--env-file`
   * directory, and this adapter writes no env file — the credential lives in a Secret object whose
   * lifetime is the Job's, swept above. The parameter stays in the port signature because the port
   * has ONE `reap`, and an adapter that refused the argument would make the port two.
   */
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

      const runTimeoutMs = clampRunTimeoutMs(spec.timeoutMs);
      const runDeadlineAt = Date.now() + runTimeoutMs;
      const reapDeadline = new Date(runDeadlineAt + RUNNER_REAP_GRACE_MS).toISOString();

      const jobName = runnerJobName(spec.runId);
      const secretName = runnerSecretName(spec.runId);
      const runRoot = runRootDir(workspaceRoot, spec.runId);
      const slots = workspaceSlots(spec);

      /**
       * THE REDACTION SET, AND IT IS BIGGER HERE THAN ON DOCKER BY EXACTLY ONE THING. The Docker
       * adapter redacts the secret VALUES and the `--env-file` path. This adapter puts those same
       * values into a Secret body, where the API requires them BASE64-ENCODED — and a base64 string
       * does not match its own plaintext, so a redaction set built the Docker way would let the whole
       * credential through in any echoed request or response body. Both encodings are in the set.
       */
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

      /**
       * EVERY API CALL, BOUNDED BY WHAT IS LEFT OF THE ONE BUDGET — the Docker adapter's `exec`, in
       * the Kubernetes spelling, and the three traps it records are the same three. A step reached
       * with the budget spent is REFUSED BEFORE IT IS ISSUED rather than issued with a zero or
       * negative bound; `clampRunTimeoutMs` runs inside `run()` so a second adapter cannot forget it,
       * and this is the second adapter, so it does not.
       *
       * A NON-2xx STATUS IS A REJECTION. `fetch` resolves on a 403 and a 422 alike; treating a
       * resolved promise as success is how a Job that was never created gets waited on to its
       * deadline. The RESPONSE BODY reaches the error redacted — the API server echoes the object it
       * refused, and for a Secret POST that object contains the credential.
       */
      const api = async (
        req: Omit<KubernetesApiRequest, "timeoutMs">,
        allow: (res: KubernetesApiResponse) => boolean = (res) =>
          res.status >= 200 && res.status < 300
      ): Promise<KubernetesApiResponse> => {
        const argv = [req.method, req.path];
        const remaining = runDeadlineAt - Date.now();
        if (remaining <= 0) {
          fail(
            req.step,
            argv,
            new Error(
              `whole-run budget of ${runTimeoutMs}ms (RunnerSpec.timeoutMs) was already spent ` +
                `at the run deadline ${new Date(runDeadlineAt).toISOString()} — '${req.step}' was not issued`
            ),
            true
          );
        }
        let res: KubernetesApiResponse;
        try {
          res = await io.request({ ...req, timeoutMs: Math.max(1, remaining) });
        } catch (cause) {
          const deadlineExceeded = Date.now() >= runDeadlineAt;
          fail(
            req.step,
            argv,
            deadlineExceeded
              ? new Error(
                  `whole-run budget of ${runTimeoutMs}ms (RunnerSpec.timeoutMs) ran out during ` +
                    `'${req.step}' at the run deadline ${new Date(runDeadlineAt).toISOString()}`
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

      const copy = async (
        step: RunnerLaunchStep,
        fromDir: string,
        toDir: string
      ): Promise<void> => {
        const remaining = runDeadlineAt - Date.now();
        if (remaining <= 0) {
          fail(
            step,
            ["copy-dir", fromDir, toDir],
            new Error(
              `whole-run budget of ${runTimeoutMs}ms (RunnerSpec.timeoutMs) was already spent ` +
                `at the run deadline ${new Date(runDeadlineAt).toISOString()} — '${step}' was not issued`
            ),
            true
          );
        }
        try {
          await io.copyDir({ step, fromDir, toDir });
        } catch (cause) {
          fail(step, ["copy-dir", fromDir, toDir], cause);
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

      /**
       * A RUN THAT LOST ITS NAME TO SOMEBODY ELSE TEARS DOWN NOTHING. The Docker adapter's
       * `createNameConflict`, and every word of its reasoning applies unchanged: the Job (and the
       * Secret, and the workspace subtree) behind that name belong to a run this one did not start
       * and is not supervising, and an unconditional teardown destroys a live `tofu apply`. What
       * changes is only the SIGNAL — a typed 409 `AlreadyExists` instead of a stderr substring — and
       * the STEP it can be raised at, because with a per-run Secret the Secret POST is the first
       * thing that stakes the name.
       */
      let foreignRun = false;

      // 1. THE PER-RUN SECRET (`secret-env`), OR THE REFUSAL THAT STANDS IN FOR IT. Before the `try`,
      //    exactly like the Docker adapter's `--env-file`: a failure here has created no Job.
      if (spec.secretEnv.length > 0) {
        if (!config.perRunSecrets) {
          fail(
            "secret-env",
            [],
            new Error(
              "this runner needs per-run Secrets and the Kubernetes launcher was not granted them. " +
                "RunnerSpec.secretEnv must reach the pod as a Secret + envFrom.secretRef, which needs " +
                "`secrets: create,get,delete` on the worker ServiceAccount — a grant the chart does " +
                "not make by default. Set managedRunners.kubernetes.perRunSecrets=true to render the " +
                "RBAC and enable it. REFUSING rather than falling back to env[].value, which would " +
                "put the credential in etcd and in every etcd backup."
            )
          );
        }
        const created = await api(
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
                annotations: { [RUNNER_LAUNCHER_DEADLINE_ANNOTATION]: reapDeadline }
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
        if (isKubernetesAlreadyExists(created)) {
          foreignRun = true;
          fail(
            "secret-env",
            ["POST", SECRETS_PATH(namespace)],
            new Error(
              `Secret ${secretName} already exists — another run holds this runId. Refusing, and ` +
                `tearing down nothing: everything behind this name belongs to that run.`
            )
          );
        }
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
              ttlSecondsAfterFinished: config.ttlSecondsAfterFinished ?? KUBERNETES_JOB_TTL_SECONDS
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
        try {
          await api({
            step: "start",
            method: "PATCH",
            path: `${JOBS_PATH(namespace)}/${jobName}`,
            contentType: "application/merge-patch+json",
            body: { spec: { suspend: false } }
          });

          // POLL TO A TERMINAL POD. `budget-exhausted` is reached the same way every other step
          // reaches it — `api()` refuses once the deadline is spent — so the loop needs no bound of
          // its own and cannot invent a second one that disagrees.
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
            pod = items[0];
            termination = pod ? kubernetesTermination(pod) : undefined;
            if (termination) break;
            const remaining = runDeadlineAt - Date.now();
            if (remaining <= 0) continue; // let `api()` produce the one budget refusal
            await sleep(Math.min(pollIntervalMs, remaining));
          }

          const podName = pod?.metadata?.name;
          // THE LOG IS READ EVEN FOR A FAILED RUN, and that is not optional: the runner's own last
          // words are what `classifyRunnerFailure` puts in the operator-facing `detail`.
          let log = "";
          if (podName) {
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
          }

          // OVER `maxBuffer` FAILS THE RUN — see `logRequestPath` for why, and why the request asked
          // for exactly one byte more than the limit.
          if (Buffer.byteLength(log, "utf8") > spec.maxBuffer) {
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
          const e = err as RunnerLaunchError;
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
        // 6. TEARDOWN — unconditional, OUTSIDE the run budget (the commonest reason to reach it is
        //    that the budget is what ran out), swallowed but not silent, and skipped ENTIRELY for a
        //    run that lost its name. Three objects, in the order that leaves nothing addressable if
        //    an earlier one fails: the Job (which owns the pod), then the Secret, then the bytes.
        if (foreignRun) {
          debug(
            "teardown: SKIPPED for %s — this run lost the name to a run it does not own",
            jobName
          );
        } else {
          await io
            .request({
              step: "teardown",
              method: "DELETE",
              path: `${JOBS_PATH(namespace)}/${jobName}?propagationPolicy=Background`,
              timeoutMs: RUNNER_REMOVE_TIMEOUT_MS
            })
            .catch((cause) => debug("teardown: DELETE job %s failed: %O", jobName, cause));
          if (spec.secretEnv.length > 0 && config.perRunSecrets) {
            await io
              .request({
                step: "teardown",
                method: "DELETE",
                path: `${SECRETS_PATH(namespace)}/${secretName}`,
                timeoutMs: RUNNER_REMOVE_TIMEOUT_MS
              })
              .catch((cause) => debug("teardown: DELETE secret %s failed: %O", secretName, cause));
          }
          await io
            .removeDir({ step: "teardown", dir: runRoot })
            .catch((cause) => debug("teardown: removing %s failed: %O", runRoot, cause));
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

/**
 * THE JOB MANIFEST — this adapter's `argv`, and the thing its golden pins whole.
 *
 * A PURE FUNCTION OF THE SPEC AND THE DEPLOYMENT SETTINGS, exported for exactly that reason: the
 * Docker adapter's complete statement of intent is one array of strings a test can compare, and the
 * Kubernetes equivalent has to be equally comparable or the golden degrades into "some of the fields
 * we remembered to check". `kubernetes-launch.golden.test.ts` asserts the whole object with
 * `toStrictEqual`, so a field ADDED here without a golden update is a red test rather than a silent
 * change to what every managed run does.
 */
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
      ttlSecondsAfterFinished: opts.ttlSecondsAfterFinished,
      template: {
        metadata: { labels },
        spec: {
          restartPolicy: "Never",
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
              args: spec.operands,
              env: spec.env.map((entry) => {
                const eq = entry.indexOf("=");
                return { name: entry.slice(0, eq), value: entry.slice(eq + 1) };
              }),
              ...(spec.secretEnv.length > 0
                ? { envFrom: [{ secretRef: { name: opts.secretName } }] }
                : {}),
              securityContext: {
                allowPrivilegeEscalation: false,
                readOnlyRootFilesystem: false,
                capabilities: { drop: ["ALL"] }
              },
              volumeMounts
            }
          ],
          volumes: [volume]
        }
      }
    }
  };
}

// ==================================================================================================
// THE PRODUCTION TRANSPORT — plain `fetch` + the projected service-account token (owner decision 7)
// ==================================================================================================

/** Where a projected service-account token and the cluster CA are mounted in every pod. */
export const K8S_SA_DIR = "/var/run/secrets/kubernetes.io/serviceaccount";

/**
 * NO KUBERNETES CLIENT LIBRARY (owner decision 7, and it is verified rather than asserted: a
 * filterless grep for `@kubernetes/client-node`/`kubernetes-client` over `package.json`,
 * `pnpm-lock.yaml`, `apps` and `packages` returns zero). The precedent already ships twice —
 * `bundled-argocd-autowire-bin.ts:69-95` and `bundled-gitea-autowire-bin.ts:71-97` — and both rely on
 * the SAME constraint this transport inherits: Node's global `fetch` cannot take a custom CA without
 * an undici Agent, so the cluster CA must reach it through `NODE_EXTRA_CA_CERTS`. That is a
 * DEPLOYMENT obligation, not a code one, and the chart is where it is met.
 *
 * `token` and `apiBase` are read per request rather than captured: a projected token is rotated in
 * place by the kubelet, and a launcher instance outlives one rotation only if it re-reads.
 */
export function createFetchKubernetesIo(opts: {
  apiBase?: string;
  readToken: () => Promise<string>;
  copyDir: (fromDir: string, toDir: string) => Promise<void>;
  removeDir: (dir: string) => Promise<void>;
  fetchImpl?: typeof fetch;
}): KubernetesRunnerIo {
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
    copyDir: (op) => opts.copyDir(op.fromDir, op.toDir),
    removeDir: (op) => opts.removeDir(op.dir)
  };
}

// ==================================================================================================
// ADAPTER SELECTION — the field M23.1 said would land here, and the three layers it moves through
// ==================================================================================================

/**
 * THE SELECTING RESOLVER — one switch on an EXPLICIT operator setting, never an auto-detection.
 *
 * `resolveDockerRunnerLauncher`'s own doc has said since M23.1 that this is "NEVER an auto-detection
 * of the platform (M15.4 declined to create that runtime/install-time fork, and guessing from the
 * presence of a service-account token is exactly that guess)". This function is that promise cashed:
 * the ONLY thing it reads is `config.runnerLauncher`, and an unset value is Docker — byte-identical
 * behaviour for every deployment that does not opt in, which is what makes M23.2 safe to merge.
 *
 * WHERE THE VALUE COMES FROM AND WHY IT CANNOT COME FROM A TENANT. `runnerLauncher` and the
 * `kubernetes` block below it join the server-injected/never-tenant-settable class on day one, and
 * that class is three layers, all of which move in this same change (index.ts's own note: "WHEN M23.2
 * ADDS ADAPTER SELECTION it becomes a config field, and all three layers must be updated in that same
 * change"): each plugin's manifest `configSchema` (`additionalProperties: false`, so the key is
 * refused by schema), `validatePluginConfig` at the four write doors (refused by name), and the
 * LAST-wins injection sites in `executor-bindings-repo.ts` / `managed-dep-instance.ts` /
 * `promotion-scan-step.ts` (overwritten even if the first two ever regress). Two defences that fail
 * independently, plus the injection that wins — the same posture `dockerBinary` has since the
 * managed-scan RCE.
 */
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
    io:
      k8s.io ??
      createFetchKubernetesIo({
        apiBase: k8s.apiBase,
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
      })
  });
};

/** A stable, short digest of a string — used by the harness to build in-bounds run ids. Exported
 *  from here rather than duplicated in a test, so the harness and the adapter agree by construction. */
export function shortDigest(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex").slice(0, 10);
}
