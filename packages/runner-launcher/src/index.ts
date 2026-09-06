import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { debuglog, promisify } from "node:util";
import type {
  KubernetesRunnerIo,
  KubernetesRunnerPodConventions,
  KubernetesWorkspaceVolume
} from "./kubernetes-adapter.js";

const execFileAsync = promisify(execFile);

// THE ONE PROCESS SPAWNER, AND THE LEDGER THAT MAKES "NOTHING WAS SPAWNED" AN ASSERTION
/** M23.6 CLAUSE 1. See docs/runner-launcher/index.md §1. */
export interface RunnerSpawnRecord {
  /** The binary as it was passed to `execFile` — a rename shows up here and nowhere else. */
  readonly file: string;
  /** `argv[0]`: a container-CLI subcommand for every call this package makes. */
  readonly verb: string;
  readonly argvLength: number;
}

/** How many records the ledger keeps. Ring-bounded; {@link runnerSpawnCount} is exact regardless. */
export const RUNNER_SPAWN_LEDGER_MAX = 200;

const spawnLedger: RunnerSpawnRecord[] = [];
let spawnTotal = 0;

/** Every process this package has spawned, most recent last, capped at {@link RUNNER_SPAWN_LEDGER_MAX}. */
export function runnerSpawns(): readonly RunnerSpawnRecord[] {
  return spawnLedger;
}

/** Total spawns since process start — exact, and unaffected by the ledger's cap. */
export function runnerSpawnCount(): number {
  return spawnTotal;
}

/** Clears the ledger (not the total). For a test that wants a clean window; harmless in production. */
export function clearRunnerSpawns(): void {
  spawnLedger.length = 0;
}

/** THE ONLY PLACE THIS PACKAGE STARTS A PROCESS. See docs/runner-launcher/index.md §2. */
function spawnRunnerProcess(
  file: string,
  argv: readonly string[],
  options: { timeout?: number; maxBuffer?: number }
): Promise<{ stdout: string; stderr: string }> {
  spawnTotal += 1;
  spawnLedger.push({ file, verb: argv[0] ?? "", argvLength: argv.length });
  if (spawnLedger.length > RUNNER_SPAWN_LEDGER_MAX) spawnLedger.shift();
  return execFileAsync(file, [...argv], options);
}

/** `NODE_DEBUG=scp-runner-launcher` to see swallowed teardown/reap failures. Both are best-effort
 *  by design (see {@link RunnerLauncher.reap} and the teardown `.catch`), so this is the only trace
 *  of them that exists — a swallow with nowhere for the reason to go is invisible, not handled. */
const debug = debuglog("scp-runner-launcher");

/**
 * `@scp/runner-launcher` — THE ONE PLACE A MANAGED RUNNER IS LAUNCHED (BUILD_AND_TEST.md §8 M23.1).
 *
 * WHY THIS PACKAGE EXISTS. Three managed executors — `scp-managed-iac`, `scp-managed-scan` and
 * `scp-managed-dep` — each hand-rolled the identical five-step sequence against a Docker CLI:
 * `create` -> `cp` in -> `start -a` -> `cp` out -> `rm -f`. Three independent implementations of one
 * mechanism is exactly the incomplete-call-site-census property CLAUDE.md and BUILD_AND_TEST.md §4.4
 * name: a fix, a hardening or a new platform arm has to be applied three times, and the instance
 * that gets missed is invisible because the other two are green. A fourth managed class would make
 * it four. THE SEAM IS THE DELIVERABLE.
 *
 * WHAT THIS PACKAGE IS NOT. It is not a normalisation. The three call sites disagree about real
 * things — whether evidence is copied out after a failed run, whether a failed copy-out fails the
 * run, how big a stdout buffer to allow, whether the network mode is a config read or a charter
 * literal — and every one of those disagreements is load-bearing and pinned by a golden
 * (`launch-argv.golden.test.ts` in each plugin). They are therefore expressed as FIELDS OF THE SPEC
 * the caller supplies ({@link RunnerCopyOut.when}, {@link RunnerCopyOut.onFailure},
 * {@link RunnerSpec.maxBuffer}, {@link RunnerSpec.networkMode}), never as a shared default this
 * package chose. A port that made the three uniform would be a behaviour change wearing a
 * refactor's clothes.
 *
 * THE THREE DEFECTS M23.0 RECORDED, AND WHERE EACH STANDS NOW (M23.0 deliberately shipped all
 * three unfixed, because fixing one means knowingly breaking a golden and "byte-identical" then
 * becomes untestable; M23.0's promise has been kept and cashed, so two of them are fixed HERE):
 *   1. FIXED (M23.0 defect 1). `docker create` failing used to clean nothing: the `finally { rm -f }`
 *      only began after `create` RESOLVED, and no `--name`/`--label` was passed, so a container the
 *      daemon made for a call that then timed out was left behind with no attribution. Now the
 *      container's NAME is computed from the caller's {@link RunnerSpec.runId} BEFORE `create` is
 *      issued, `create` is inside the `try`, and teardown addresses that NAME. See
 *      {@link runnerContainerName} for why the obvious "just move the await inside the try" is NOT
 *      the fix.
 *   2. FIXED (M23.0 defect 2), by the PLUGINS rather than by this port, and this entry said "STILL
 *      OPEN" for a release after it stopped being true. A managed-scan run whose copy-out fails used
 *      to end stuck in `pending`, because the {@link RunnerCopyOut.onFailure} `"propagate"` rejection
 *      escaped `trigger()` with no outcome ever recorded. M23.1 phase 2 wrapped every managed
 *      plugin's `trigger()` body in {@link withRecordedOutcome}, which catches that rejection and
 *      records `failed`. MEASURED, not reasoned: `@scp/plugin-managed-scan`'s
 *      `launch-argv.golden.test.ts` ("A FAILED COPY-OUT IS NOT SWALLOWED") fails the second
 *      `docker cp` and asserts `status()` reports `failed`. managed-iac's create/copy-in failures
 *      take the same catch.
 *   3. FIXED (M23.0 defect 3) for the host process table, PARTIALLY. Resolved credentials used to
 *      ride the `create` argv as `-e KEY=VALUE`, readable by any local process. They now travel as
 *      {@link RunnerSpec.secretEnv} and reach Docker through a mode-0600 `--env-file` that is
 *      unlinked the instant `create` returns. NAMED AS THE PARTIAL FIX IT IS: the value is out of
 *      the process table, but it is still in `docker inspect` for the container's life and it is
 *      still on a disk for the duration of one `create`. What the split really buys is the
 *      Kubernetes arm (M23.2): `env` maps to `env[].value` and `secretEnv` to a per-run Secret with
 *      `envFrom.secretRef`, and under one undifferentiated list "port env to Kubernetes" reads as
 *      `env[].value` for everything — plaintext credentials in etcd and in every etcd backup, which
 *      is strictly worse than the host process table this replaced.
 *
 * AND THE DEFECT NEITHER M23.0 NOR THIS FILE HAD A NAME FOR: a rejected `execFile` carries the FULL
 * argv in `err.message` (`Command failed: docker create --network none -e AWS_SECRET_ACCESS_KEY=… …`),
 * and that message crosses the plugin-host RPC boundary (`subprocess-entry.ts` serialises `err.message`
 * and nothing else) and reaches `console.error`. Every rejection out of this adapter is therefore
 * wrapped in a {@link RunnerLaunchError} built from a REDACTED argv. This is the one place in the
 * product that can do that exactly rather than heuristically, because it is the only place that knows
 * both the argv it built and which of those entries came from `secretEnv`.
 *
 * NO NEW CONFIG SURFACE, ON PURPOSE. The server-injected/never-tenant-settable class
 * (`dockerBinary`, `runnerImage`, `networkMode`, `workspaceRoot`, `statePath`) is enforced in three
 * layers that must move together: each plugin's manifest `configSchema`
 * (`additionalProperties: false`), `validatePluginConfig` at the four write doors
 * (`routes/executors.ts` x3 and `iac/plans-repo.ts`), and the LAST-wins injection sites
 * (`coordination/executor-bindings-repo.ts`, `dependencies/managed-dep-instance.ts`,
 * `federation/promotion-scan-step.ts`). M23.1 adds NO field to that class: the adapter is chosen in
 * CODE (there is only one), and the seam a test drives is a factory parameter, not configuration.
 * WHEN M23.2 ADDS ADAPTER SELECTION it becomes a config field, and all three layers must be updated
 * in that same change — {@link RunnerLauncherConfig} is where the field will land.
 */

// ==================================================================================================
// THE TENANT-SETTABLE RUN BUDGET — its floor, its default-bearing ceiling, and why a ceiling exists.
// ==================================================================================================

/**
 * The bounds every managed executor's tenant-settable `timeoutMs` must lie within, declared ONCE
 * here because all three managed plugins depend on this package and each publishes the same
 * `configSchema` property.
 *
 * WHY A MAXIMUM IS NOT HYGIENE. All three plugins run their container SYNCHRONOUSLY inside
 * `trigger()`, and `apps/server/src/plugin-host/host.ts` sizes that RPC's budget from this very
 * number (`managed-call-budget.ts`). A `timeoutMs` with `{ minimum: 1000 }` and no maximum — which
 * is what all three manifests shipped — therefore had two distinct consequences, and the second is
 * the one that made this a defect rather than a smell:
 *
 *   1. The runner itself becomes unkillable BY ITS OWN TIMEOUT. `execFile`'s `timeout` is the only
 *      thing that stops a wedged `docker start -a`, and a tenant with plain `object:write` on a
 *      Component could set 2^31 ms (24.9 days) and remove it.
 *   2. The plugin-host budget derived from it becomes unbounded too, which would replace one bad
 *      failure mode (a 10s SIGKILL through a live `tofu apply`) with another (an RPC that never
 *      returns and an executor instance whose single-threaded `subprocess-entry.ts` head-of-line
 *      blocks every `status()`/`observe()`/`abort()` for weeks).
 *
 * The ceiling is what makes the budget COMPUTABLE — an upper bound on how long a managed run may
 * legitimately still be in flight is the predicate an orphan sweep needs, and there is no such
 * predicate while a run may claim any duration it likes.
 *
 * ONE HOUR is chosen against the defaults it must not squeeze: managed-iac and managed-scan default
 * to 10 minutes and managed-dep to 5, so the ceiling is 6x the largest default — room for a genuinely
 * slow `tofu apply` or a full-filesystem Trivy scan, and still a bound.
 */
export const MANAGED_RUN_TIMEOUT_MIN_MS = 1_000;
/** See {@link MANAGED_RUN_TIMEOUT_MIN_MS}. One hour. */
export const MANAGED_RUN_TIMEOUT_MAX_MS = 60 * 60_000;

/**
 * THE CEILING, APPLIED WHERE EVERY CONSUMER OF IT CONVERGES — MEDIUM (verification pass 5).
 *
 * WHAT WAS ACTUALLY TRUE BEFORE THIS FUNCTION EXISTED. {@link MANAGED_RUN_TIMEOUT_MAX_MS} appeared
 * in exactly two kinds of place: the three manifests' `configSchema.properties.timeoutMs.maximum`
 * (the WRITE door, which a row stored before the ceiling existed never passes through again) and
 * `apps/server/src/plugin-host/call-policy.ts`, whose `resolveCallPolicy` clamps — and clamps ONLY
 * ITS OWN RETURN VALUE, the host's RPC budget. All three plugins passed
 * `config.timeoutMs ?? DEFAULT_TIMEOUT_MS` STRAIGHT into {@link RunnerSpec.timeoutMs}, and nothing
 * between there and `execFile` looked at the ceiling again. Measured for a stored `timeoutMs` of
 * 14_400_000 (4h), which the old `{ minimum: 1000 }` schema admitted and which is still in the
 * database:
 *
 *     host budgetMs (call-policy, CLAMPED)          3_660_000   (3_600_000 + the 60s grace)
 *     RunnerSpec.timeoutMs, iac and scan           14_400_000   (UNCLAMPED)
 *     -> the host SIGKILLs the subprocess at t+3_660_000ms, and that SIGKILL is the event that
 *        CREATES the orphan; the container it leaves behind is stamped t+14_520_000ms, so it is
 *        UNREAPABLE for a further 10_860_000ms — 181 minutes of a `tofu apply` with nobody
 *        supervising it and its credentials readable via `docker inspect`.
 *
 * SO THE CLAMP DEFEATED ITSELF ON EXACTLY THE ROWS IT EXISTS FOR. {@link RunnerLauncher.reap}'s
 * predicate is "foreign AND past its stamp", and the stamp was
 * `unclamped timeoutMs + RUNNER_REAP_GRACE_MS`. At the 2^31 the call-policy comment names, that is
 * ~24.9 days.
 *
 * WHY HERE AND NOT A THIRD CLAMP IN EACH PLUGIN. Three plugins build a spec, the Docker adapter
 * consumes it, and M23.2's Kubernetes adapter will consume the same one; this port is the single
 * place all of them pass through. A per-plugin clamp is three copies of one rule, which is the
 * shape that leaves the fourth managed executor unbounded on the day it lands. `run()` calls this
 * ONCE, at the top, and derives the deadline, the container's reap stamp and every step's `timeout`
 * from the clamped value — so the ceiling is a property of the RUNNING SYSTEM rather than only of
 * future writes. ANY FUTURE ADAPTER MUST CALL IT TOO; it is exported for that reason.
 *
 * THE FLOOR IS DELIBERATELY NOT APPLIED HERE, and the asymmetry is the point rather than an
 * omission. {@link MANAGED_RUN_TIMEOUT_MIN_MS} is a USABILITY bound — a `timeoutMs` of 1 makes every
 * run of that binding fail fast and harms nothing outside it — and it belongs at the write door,
 * where it already is. The MAXIMUM is a CONTAINMENT bound: it is the sole term that makes the orphan
 * stamp and {@link RUNNER_SECRET_ENV_MAX_AGE_MS} computable, and both of those are about what a run
 * can do to OTHER runs and to the host after nobody is watching. Only the containment half has to be
 * true of a value read back out of the database, so only the containment half is enforced here.
 * Raising a too-small budget at this port would also silently rewrite the caller's spec on the one
 * axis the three `launch-argv.golden.test.ts` files pin.
 *
 * A NON-FINITE `timeoutMs` (`NaN`, `Infinity`) COLLAPSES TO THE CEILING rather than propagating.
 * `NaN` is the dangerous one: `now + NaN` is `NaN`, the `remaining <= 0` refusal below is then
 * FALSE, and `Math.max(1, NaN)` is `NaN` — a `docker start -a` with no bound at all, arrived at
 * through the one branch that exists to prevent exactly that. The ceiling is the fail-closed answer
 * for both.
 */
export function clampRunTimeoutMs(requested: number): number {
  if (!Number.isFinite(requested)) return MANAGED_RUN_TIMEOUT_MAX_MS;
  return Math.min(requested, MANAGED_RUN_TIMEOUT_MAX_MS);
}

/** One `docker cp` of a host directory's CONTENTS into the container (the trailing `/.`). */
export interface RunnerCopyIn {
  /** HOST directory. Its contents are copied, not the directory itself. */
  hostDir: string;
  containerPath: string;
}

/**
 * Whether the evidence copy-out runs after a FAILED start.
 *  - `"always"` — managed-iac: a failed `apply` may still have produced a partial `plan.json`.
 *  - `"on-success"` — managed-scan (a failed scan must produce NO evidence, so E6 refuses) and
 *    managed-dep (a partial manifest must never reach the verifiers).
 */
export type RunnerCopyOutWhen = "always" | "on-success";

/** Where a FAILED copy-out lands. See docs/runner-launcher/index.md §3. */
export type RunnerCopyOutOnFailure = "swallow" | "propagate";

/** One `docker cp` of a container directory's CONTENTS back out to the host. */
export interface RunnerCopyOut {
  /** Absolute source path INSIDE the container. Its contents are copied (the trailing `/.`). */
  containerPath: string;
  hostDir: string;
  when: RunnerCopyOutWhen;
  onFailure: RunnerCopyOutOnFailure;
}

/** One runner launch, described completely — nothing about it is defaulted by the adapter. */
export interface RunnerSpec {
  /** THE CALLER'S OWN NAME FOR THIS RUN. See docs/runner-launcher/index.md §4. */
  runId: string;
  /**
   * Attribution labels, emitted in INSERTION ORDER as one `--label k=v` each (Kubernetes:
   * `metadata.labels`). This is the other half of M23.0's defect 1 — an orphaned container that
   * carries no label cannot be found, attributed or reaped by an operator, and `docker ps
   * --filter label=…` is the only thing that makes a fleet-wide sweep possible.
   */
  labels: Record<string, string>;
  /** The vetted, pinned runner image. SERVER-GOVERNED at every caller; never tenant-suppliable. */
  image: string;
  /** The runner's own entrypoint operands, in order, AFTER the image on the command line. */
  operands: string[];
  /** The network the runner gets. See docs/runner-launcher/index.md §5. */
  networkMode: string;
  /**
   * Ordered `KEY=VALUE` environment entries THAT ARE NOT SECRET. The Docker adapter emits each as
   * its own `-e` pair before the image, exactly as it always has, so these stay visible in the host
   * process table — which is correct for what they are: container paths and run parameters.
   * Empty for managed-dep, which passes no environment at all.
   */
  env: string[];
  /**
   * Ordered `KEY=VALUE` environment entries THAT CARRY A SECRET. The split is along the SECRECY
   * axis because that is the axis both adapters must branch on, and neither could infer it: Docker
   * delivers these through a mode-0600 `--env-file` instead of `-e`, and Kubernetes must deliver
   * them as a per-run Secret + `envFrom.secretRef` rather than as `env[].value`.
   *
   * It is also what makes redaction EXACT. {@link RunnerLaunchError} is built by removing these
   * VALUES from the argv and from the child's output — no substring heuristic over unknown text,
   * no allowlist of key names that goes stale, because the caller has already told the port which
   * strings are secret.
   *
   * managed-iac puts `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` here and leaves
   * `PRIOR_STATE_FILE` in {@link RunnerSpec.env}; managed-scan's `SCP_SCAN_*_DIR` are container
   * paths and stay in `env`; managed-dep holds no credential and passes both empty.
   *
   * THE REAL BOUND ON THE `--env-file` (MEDIUM-4, corrected — it used to claim less than it now
   * guarantees). ON THE ORDINARY PATH the file lives for the duration of one `create` and no
   * longer: it is unlinked from the SAME process, in the `finally` right after `create` settles,
   * on the success path and the failure path alike. THAT PROMISE IS ONLY AS GOOD AS THE PROCESS
   * KEEPING IT, and a SIGKILL between {@link writeSecretEnvFile} and that `finally` — the exact
   * shape `plugin-host/host.ts`'s hang detector produces — leaves the file behind with nothing
   * left to unlink it: no `finally` runs, no signal handler fires. Measured: a killed create leaves
   * a mode-0600 file carrying the plaintext credential in the caller's own durable, governed
   * `secretEnvDir` indefinitely, with nothing sweeping it.
   *
   * SWEPT BY THE SAME MECHANISM THAT SWEEPS AN ORPHANED CONTAINER, on purpose — ONE cleanup concept
   * rather than two. {@link RunnerLauncher.reap} removes any `scp-secret-env-*` file under the
   * CURRENT run's `secretEnvDir` whose age exceeds {@link RUNNER_SECRET_ENV_MAX_AGE_MS} — a bound
   * no run still inside its own budget can reach, so a live run's file is never a candidate. THE
   * ACTUAL BOUND ON EXPOSURE IS THEREFORE: instantly, on the ordinary path; otherwise, at most
   * {@link RUNNER_SECRET_ENV_MAX_AGE_MS} after the run that wrote it, once ANY later run against
   * the same `secretEnvDir` (this process's successor after a respawn, in production) schedules a
   * pass — never "for the duration of one `create`" unconditionally, which was true only when
   * nothing killed the process mid-flight.
   */
  secretEnv: string[];
  /**
   * Where the Docker adapter may stage the transient `--env-file`. REQUIRED when
   * {@link RunnerSpec.secretEnv} is non-empty and ignored otherwise; the adapter refuses rather
   * than choosing a directory of its own, because "which directory is the plugin's own governed
   * state dir" is caller knowledge and `os.tmpdir()` is shared with every other local user.
   */
  secretEnvDir?: string;
  /** Copy-INs, in the order they must be issued (managed-scan issues one to three). */
  copyIn: RunnerCopyIn[];
  /** The single evidence copy-OUT, if this runner produces one. */
  copyOut?: RunnerCopyOut;
  /** THE WHOLE-RUN BUDGET. See docs/runner-launcher/index.md §6. */
  timeoutMs: number;
  /** Per-call `maxBuffer`. 16 MiB / 32 MiB / 8 MiB respectively — NOT one shared default. */
  maxBuffer: number;
}

/** What a runner run produced. See docs/runner-launcher/index.md §7. */
export type RunnerResult =
  | { succeeded: true; stdout: string; stderr: string; failure?: undefined }
  | { succeeded: false; stdout: string; stderr: string; failure: RunnerFailure };

/**
 * THE PORT. One verb, because a managed runner has exactly one lifecycle: run it to completion and
 * hand back what it printed. Adapters: Docker (below, for compose/VM) and — M23.2, not before —
 * Kubernetes Jobs.
 */
export interface RunnerLauncher {
  run(spec: RunnerSpec): Promise<RunnerResult>;
  /** M23.1 PHASE 4. See docs/runner-launcher/index.md §8. */
  reap(secretEnvDir?: string): Promise<string[]>;
}

/**
 * The adapter-selecting slice of a plugin's (server-injected) config.
 *
 * `dockerBinary` is the only field today, and it is already in the server-injected,
 * never-tenant-settable class: absent from all three manifests' `additionalProperties: false`
 * schemas, refused by `validatePluginConfig` at the four write doors, and injected LAST from
 * `SCP_MANAGED_RUNNER_DOCKER_BINARY`. `managed-scan` shipped a live RCE precisely because that chain
 * had a hole in it (it sat on `KNOWN_EXECUTOR_MODULES` with no manifest, so `validatePluginConfig`
 * returned early); `assertEveryModuleHasManifest` closes that at boot now. ANY FIELD ADDED HERE
 * JOINS THAT CLASS ON DAY ONE — all three layers, in the same change.
 */
export interface RunnerLauncherConfig {
  /** SERVER-INJECTED (never tenant): the container CLI to exec. Defaults to `"docker"`. */
  dockerBinary?: string;
  /**
   * WHICH ADAPTER (M23.2) — SERVER-INJECTED, never tenant, and EXPLICIT rather than detected.
   *
   * This is the field the note above predicted, and it arrives under the rule that note set: it
   * joins the server-injected class on day one, in all three layers, in this same change. Absent or
   * anything other than `"kubernetes"` means the Docker adapter — so every deployment that does not
   * opt in behaves byte-identically, which is what makes a second adapter safe to merge at all.
   *
   * NEVER AUTO-DETECTED. Guessing the platform from the presence of a service-account token is the
   * runtime/install-time fork M15.4 declined to create, and it guesses wrong in both directions: a
   * compose deployment inside a pod (the eval stack) would be switched to Jobs it has no RBAC for,
   * and a Kubernetes deployment with `automountServiceAccountToken: false` — which is this chart's
   * hardened default — would silently keep shelling out to a `docker` binary the image does not
   * ship.
   */
  runnerLauncher?: "docker" | "kubernetes";
  /** The Kubernetes adapter's deployment settings. See docs/runner-launcher/index.md §9. */
  kubernetes?: KubernetesLauncherSettings;
}

/** The Kubernetes adapter's server-injected settings. See docs/runner-launcher/index.md §10. */
export interface KubernetesLauncherSettings {
  /** The namespace every Job, Secret and pod read lives in. */
  namespace: string;
  /** Where THIS process sees the shared RWX workspace volume the Job also mounts. */
  workspaceRoot: string;
  /** The volume the Job mounts. A CLOSED UNION — see `KubernetesWorkspaceVolume`. */
  workspaceVolume: KubernetesWorkspaceVolume;
  /** THE PER-RUN SECRET CAPABILITY — declared, and OFF until the RBAC grant is an owner decision.
   *  See `KubernetesRunnerLauncherConfig.perRunSecrets` for what is inert and what turns it on. */
  perRunSecrets?: boolean;
  /** Pod `securityContext.runAsNonRoot`. Off by default — none of the three runner images has a
   *  `USER` line, so `true` makes every managed run fail before its entrypoint. */
  runAsNonRoot?: boolean;
  /** THE DEPLOYMENT'S POD CONVENTIONS (M23.5) — the block that carries what every OTHER pod this
   *  chart creates inherits from `.Values` and this one, built at runtime rather than rendered by
   *  Helm, inherited nothing of. See {@link KubernetesRunnerPodConventions}. */
  pod?: KubernetesRunnerPodConventions;
  apiBase?: string;
  /** THE HARNESS's SEAM, and it is `undefined` in production by construction: nothing injects it
   *  from config, so a deployment cannot supply one. The kind-based integration test builds a real
   *  `fetch`-backed io against a real API server and passes it here rather than reaching around the
   *  resolver — which is what makes that test exercise the SHIPPED selection path. */
  io?: KubernetesRunnerIo;
}

/** How a plugin obtains the launcher for one run. See docs/runner-launcher/index.md §11. */
export type ResolveRunnerLauncher = (config: RunnerLauncherConfig) => RunnerLauncher;

// PER-RUN IDENTITY — the caller's name for the run, and the container name derived from it.

/**
 * What a {@link RunnerSpec.runId} must look like: lowercase RFC-1123-ish, so the SAME string can be
 * a Docker container name suffix and a Kubernetes `metadata.name`. Bounded at 40 so
 * `scp-runner-<runId>` stays inside Kubernetes' 63-character label/name budget.
 */
export const RUNNER_RUN_ID_PATTERN = /^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$/;

/** The container-name prefix every managed runner carries, on every adapter. */
export const RUNNER_CONTAINER_NAME_PREFIX = "scp-runner-";

/**
 * Turn a caller's own run key (an `idempotencyKey`, a scratch-dir name, a UUID) into a
 * {@link RunnerSpec.runId}.
 *
 * INJECTIVE ON PURPOSE, and this is the part that is easy to get wrong. A plain
 * "lowercase and replace the bad characters" is NOT injective — `prod/eu-west-1` and
 * `prod-eu-west-1` collapse to one string, and two different runs then fight over one container
 * name, one of them losing its `create` to a name conflict and the other losing its container to
 * the loser's teardown. So the slug is used verbatim ONLY when it is a byte-identical, in-bounds
 * rendering of the input; anything else keeps a readable prefix and appends a digest of the ORIGINAL
 * input. Deterministic either way, so managed-iac's retry with the same `idempotencyKey` still
 * lands on the same container name.
 */
export function toRunnerRunId(raw: string): string {
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (slug === raw && slug.length > 0 && slug.length <= 40) return slug;
  const digest = createHash("sha256").update(raw, "utf8").digest("hex").slice(0, 10);
  return slug.length > 0 ? `${slug.slice(0, 29).replace(/-+$/, "")}-${digest}` : digest;
}

/**
 * The container's name — computed from the runId BEFORE `create` is issued, which is the entire
 * mechanism behind M23.0's defect 1.
 *
 * WHY "MOVE THE `await` INSIDE THE `try`" IS NOT THE FIX, MEASURED RATHER THAN ASSERTED. That was
 * this repository's own recorded advice (`docker-adapter.test.ts` used to say it in so many words)
 * and it is wrong: if `create` rejects, there is no id to tear down, so the `finally` issues
 * `rm -f undefined`. Run against a real daemon (Docker 29.5.2), `docker rm -f` on a name that does
 * not exist EXITS ZERO — so the extra call is not even an error that surfaces; it silently does
 * nothing, the actual orphan is still there, and the only thing that changed is that a golden broke.
 * Addressing the NAME is what makes the teardown reach a container the daemon committed for a
 * `create` we never got an answer from.
 *
 * THE HAZARD THIS USED TO INTRODUCE — CLOSED IN M23.1e, and the closing is worth reading, because
 * the note that stood here for one milestone is a specimen of the failure CLAUDE.md names. It said:
 * teardown is unconditional and addresses a name the caller chose, so a `create` that failed
 * BECAUSE THE NAME WAS ALREADY TAKEN tears down the run that legitimately holds it; reachable for
 * two concurrent triggers of one `idempotencyKey`; "retry-stable naming is what makes the fix work
 * at all, so the two cannot both be had; the documented cost of the trade, not an oversight."
 *
 * THE REACHABILITY WAS RIGHT AND THE TRADE WAS FALSE. Nothing was being traded: the alternatives on
 * offer were "stable names" and "no teardown after a lost name", and those are not in tension. The
 * conflict is DISTINGUISHABLE from every other create failure ({@link isContainerNameConflict}), so
 * the destructive step is skipped for exactly that one case and every other create failure still
 * tears down by name. A well-written comment naming a hazard is a signal to sweep, not evidence it
 * was handled — this one read as handled for a milestone.
 */
export function runnerContainerName(runId: string): string {
  return `${RUNNER_CONTAINER_NAME_PREFIX}${runId}`;
}

// THE ERROR — nothing leaves this package carrying a secret or a raw argv.

/** Which part of the launch failed. A superset of the five lifecycle steps; see `RunnerStepKind`. */
export type RunnerLaunchStep =
  "spec" | "secret-env" | "create" | "copy-in" | "start" | "copy-out" | "teardown";

/** The marker a redacted value is replaced with — the same one managed-iac's evidence redaction uses. */
export const RUNNER_REDACTION = "***";

/** Plain split/join, never a regex: a secret value may contain regex metacharacters. */
function redactAll(text: string, needles: readonly string[]): string {
  let out = text;
  for (const needle of needles) {
    if (needle.length === 0) continue;
    out = out.split(needle).join(RUNNER_REDACTION);
  }
  return out;
}

/** The VALUE half of a `KEY=VALUE` entry — what has to disappear from any text we hand upward. */
function valueOf(entry: string): string {
  const eq = entry.indexOf("=");
  return eq === -1 ? "" : entry.slice(eq + 1);
}

/**
 * EVERY REJECTION OUT OF A MANAGED RUNNER LAUNCH, with the argv it came from — redacted.
 *
 * WHAT IT DELIBERATELY DOES NOT CARRY: the original error. Not as `cause`, not as a property. A
 * `cause` survives `console.error(err)` (Node prints the cause's own stack, argv and all) even
 * though `JSON.stringify` drops it, and the whole point of this class is that there is no channel
 * left. Everything worth keeping — the exit `code`, `killed`, `signal`, and the child's own output
 * — is copied across REDACTED, so the diagnosis survives and the credential does not.
 *
 * Every own property below is enumerable, so `JSON.stringify(err)` sees exactly this redacted set;
 * `message` is non-enumerable on `Error`, as always, and is built from the redacted argv.
 */
export class RunnerLaunchError extends Error {
  readonly step: RunnerLaunchStep;
  /** The container CLI that was exec'd (`""` when the failure is not an exec). */
  readonly file: string;
  /** The argv, REDACTED — secret values and the `--env-file` path replaced. */
  readonly argv: readonly string[];
  /** `err.code` as Node produced it: `null`, an errno string, or a numeric exit status. */
  readonly code: string | number | null | undefined;
  readonly killed: boolean | undefined;
  readonly signal: string | null | undefined;
  /** The child's stdout, REDACTED (`""` when it produced none). */
  readonly stdout: string;
  /** The child's stderr, REDACTED — falling back to the original error's message. */
  readonly stderr: string;
  /**
   * TRUE when this rejection is the WHOLE-RUN budget ({@link RunnerSpec.timeoutMs}) running out,
   * rather than the step itself going wrong — either the step was refused before it was issued
   * because nothing was left to issue it with, or it was killed by a `timeout` derived from what
   * remained.
   *
   * WHO READS IT, AND WHY THE ANSWER THIS DOC USED TO GIVE WAS WRONG (MEDIUM, verification pass 5).
   * It said "callers that retry need to tell them apart: a run that exhausted its budget will
   * exhaust it again at the same setting", and a census for `deadlineExceeded` over `apps` and
   * `packages` found exactly ONE reader in the whole repository: an assertion in
   * `whole-run-budget.test.ts`. Nothing in the product read it. Worse, the named caller does not
   * retry a failed run at all — `reconcile.ts` terminalises a `failed` status
   * (`updateWaveTargetObserved(..., "failed")` plus a `block` Decision); its backoff/`attempt` path
   * governs a trigger that REJECTED, and since M23.1 phase 2 all three managed plugins catch and
   * record instead of rejecting. So the justification named a consumer that could not exist, which
   * is this repository's dominant defect wearing a doc comment.
   *
   * THE REAL READER IS {@link classifyRunnerFailure}, and it is a reader nothing else can replace:
   * `killed === true` alone cannot distinguish "OUR deadline killed it" from "something else killed
   * it", because only `run()` knows what the deadline was. That classification is what reaches
   * `RunnerResult.failure.detail`, the plugins' recorded outcome, `status().detail` and finally
   * reconcile's `inputContext` — so the audience that actually needs the distinction is the OPERATOR
   * reading a failed run, not a retry loop.
   */
  readonly deadlineExceeded: boolean;

  constructor(args: {
    step: RunnerLaunchStep;
    file: string;
    argv: readonly string[];
    cause: unknown;
    redactions: readonly string[];
    deadlineExceeded?: boolean;
  }) {
    const e = (args.cause ?? {}) as {
      message?: string;
      code?: string | number | null;
      killed?: boolean;
      signal?: string | null;
      stdout?: string;
      stderr?: string;
    };
    const redact = (text: string): string => redactAll(text, args.redactions);
    const argv = args.argv.map(redact);
    const causeMessage = redact(typeof e.message === "string" ? e.message : String(args.cause));
    super(
      `managed runner ${args.step} failed: ${redact(args.file)} ${argv.join(" ")} — ${causeMessage}`
    );
    this.name = "RunnerLaunchError";
    this.step = args.step;
    this.file = redact(args.file);
    this.argv = argv;
    this.code = e.code;
    this.killed = e.killed;
    this.signal = e.signal;
    // THE `?? ""` / `?? message` FALLS, MOVED HERE UNCHANGED. `promisify(execFile)` attaches both to
    // every rejection it produces, so in production these never fire; they remain the adapter's only
    // defence against a rejection that did not come from `promisify(execFile)` at all.
    this.stdout = redact(typeof e.stdout === "string" ? e.stdout : "");
    this.stderr = redact(
      typeof e.stderr === "string" ? e.stderr : typeof e.message === "string" ? e.message : ""
    );
    this.deadlineExceeded = args.deadlineExceeded === true;
  }
}

// THE DIAGNOSIS AN OPERATOR READS — four ways to fail that used to be one empty string.

/** `code` on a maxBuffer overflow. See docs/runner-launcher/index.md §12. */
export const RUNNER_MAXBUFFER_CODE = "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";

/**
 * HOW A RUN FAILED, at the granularity an operator has to act on. Not a restatement of Node's
 * `code`: the four inhabitants of `code` (`null`, a string errno, a numeric exit status, and
 * `ERR_CHILD_PROCESS_STDIO_MAXBUFFER`) do not line up with the four questions a person reading a
 * failed `tofu apply` actually asks, and one of the distinctions — did OUR budget kill it? — is not
 * in `code` at all.
 *
 *  - `budget-exhausted`  {@link RunnerSpec.timeoutMs} ran out. Either the step was refused before it
 *                        was issued or it was killed by a `timeout` derived from what remained. THE
 *                        ONE AN OPERATOR MUST NOT MISREAD AS A RUNNER BUG: for managed-iac it means
 *                        a `tofu apply` was SIGTERMed mid-flight, so the real infrastructure state
 *                        is unknown, and re-running at the same setting will do it again.
 *  - `output-exceeded`   the runner printed more than `maxBuffer`. `stdout` holds the output
 *                        TRUNCATED at the limit, which is the hazard — it looks like data.
 *  - `signalled`         something killed the child that was not our own budget.
 *  - `spawn-failed`      an errno-coded failure: the container CLI could not be executed at all
 *                        (`ENOENT` — `dockerBinary` is not on PATH; `EACCES` — not executable).
 *                        Nothing ran, so nothing was mutated.
 *  - `exit-nonzero`      the runner itself exited non-zero. The only one the RUNNER caused.
 *  - `outcome-unknown`   the launcher never learned what became of the runner. NOT a sixth way to
 *                        fail — it is the ABSENCE of a verdict, recorded as one. See below.
 *
 * WHY THERE IS A SIXTH, AND WHAT IT COSTS — M23.5 verification pass 18.
 *
 * THE FIVE ABOVE ARE ALL CLAIMS ABOUT THE RUNNER, and every one of them was reachable for a run
 * about which this launcher had learned NOTHING. Measured against a real cluster: the unsuspend
 * PATCH reaches the API server and succeeds, every `GET pods` after it stalls past the budget, and
 * the real Job, the real pod and the real kubelet do the work anyway. The launcher recorded
 * `spawn-failed` — "the container CLI could not be executed at all — nothing ran … so NOTHING RAN
 * and nothing was mutated" — while a real container had written a real file to the real volume. The
 * evidence that the claim was unfounded sat IN THE SAME SENTENCE ("the Job had not yet been
 * observed") and the classification ignored it.
 *
 * THE TWO EXISTING CANDIDATES ARE BOTH LIES, IN OPPOSITE DIRECTIONS, so choosing between them is
 * choosing which one to tell. `spawn-failed` asserts nothing was mutated; `budget-exhausted` asserts
 * the runner "was stopped mid-flight", which is equally unfounded when the Job never produced a pod
 * at all. Reusing either with a franker `detail` leaves the KIND — the machine-readable word that
 * heads every recorded string and every audit row — saying something the launcher cannot know.
 * Charter principle 6 is that a Decision persists its inputs; an input that is a guess is worse than
 * one that says it is missing.
 *
 * AND THE ACTION IS DIFFERENT, which is this type's own test for a new inhabitant ("at the
 * granularity an operator has to act on"). `budget-exhausted` -> raise the budget and re-run.
 * `spawn-failed` -> fix the image or the quota and re-run freely, nothing was touched.
 * `outcome-unknown` -> DO NOT re-run yet: look at the real infrastructure first, because a `tofu
 * apply` may be half-applied and the teardown that follows this verdict DELETEs the Job, which kills
 * whatever it was doing.
 *
 * WHAT IT COSTS. `RunnerFailureKind` is exported, so this is a contract change every consumer sees.
 * A filterless census over `apps`, `packages`, `docs` and `deploy` found NO exhaustive switch on it
 * anywhere and NO schema that carries it: the plugins and `reconcile.ts` read `detail` (whose first
 * word is the kind) and `deadlineExceeded`, never the kind itself. Inside this package
 * {@link FAILURE_WORDING} is a `Record<RunnerFailureKind, string>`, so the compiler refuses a
 * missing arm — that is the mechanism, and the census is only what says the blast radius is small.
 * What changes for a reader is that the routes where this launcher was BLIND no longer borrow the
 * vocabulary of the routes where it could see.
 */
export type RunnerFailureKind =
  | "budget-exhausted"
  | "output-exceeded"
  | "signalled"
  | "spawn-failed"
  | "exit-nonzero"
  | "outcome-unknown";

/**
 * THE `code` THAT MAKES A FAILURE {@link RunnerFailureKind} `outcome-unknown`.
 *
 * A STRING, like {@link RUNNER_NEVER_STARTED_CODE}, and read by {@link classifyRunnerFailure} BEFORE
 * `deadlineExceeded` — because the runs this describes usually end AT the deadline, and
 * `budget-exhausted` would otherwise win and assert the runner "was stopped mid-flight".
 * {@link RunnerFailure.deadlineExceeded} still reports which bound ended the run, honestly: WHICH
 * CLOCK RAN OUT and WHAT IS KNOWN ABOUT THE RUNNER are different questions, and conflating them is
 * the defect this constant exists to end.
 */
export const RUNNER_OUTCOME_UNKNOWN_CODE = "ERR_SCP_RUNNER_OUTCOME_UNKNOWN";

/**
 * THE `code` A RUN CARRIES WHEN NOTHING EVER STARTED — the producer's own statement that the runner
 * container does not exist and never did, so nothing it could have touched was touched.
 *
 * READ BY {@link classifyRunnerFailure} BEFORE `deadlineExceeded`, exactly like
 * {@link RUNNER_OUTCOME_UNKNOWN_CODE} and for the same reason: it is a DECLARATION, and a
 * declaration may not be overwritten by an inference. Nearly every run that carries it ends AT the
 * whole-run deadline (the poll loop is what discovers the deadline), so `budget-exhausted` — "a
 * `tofu apply` was SIGTERMed mid-flight, so the real infrastructure state is unknown" — would
 * otherwise win and assert the exact opposite of what the producer just said.
 *
 * IT USED TO REACH `spawn-failed` THROUGH THE ERRNO TEST, i.e. by being a string, and that was
 * load-bearing by accident: the classification only came out right because the producer ALSO forced
 * `deadlineExceeded: false` on the way past — a boolean that then contradicted its own message
 * ("the whole-run budget … was already spent", with `deadlineExceeded: false`). M23.5 verification
 * pass 20 separated the two: the code decides the KIND, the boolean reports WHICH CLOCK RAN OUT, and
 * neither has to lie to protect the other. `classifyRunnerFailure`'s ordering is what makes that
 * safe, and `A DECLARED "NOTHING STARTED" SURVIVES A TRUE deadlineExceeded` is the test that pins it.
 *
 * IT LIVES HERE, NEXT TO THE OTHER DECLARED CODE, RATHER THAN IN THE KUBERNETES ADAPTER — where it
 * was defined and where it is still produced. `classifyRunnerFailure` now reads it, and the module
 * cycle only resolves while `kubernetes-adapter.ts` imports from this file and never the reverse
 * (see the re-export block at the bottom of this file).
 */
export const RUNNER_NEVER_STARTED_CODE = "RunnerContainerNeverStarted";

// THE ONE BOUND, CHOSEN ONCE, HERE — and it keeps BOTH ENDS.

/**
 * THE TOTAL BUDGET FOR ANY OPERATOR-FACING `detail` THIS PACKAGE PRODUCES OR ACCEPTS (MEDIUM, M23.0
 * verification pass 7). It lives here because THE PORT IS THE ONLY PLACE THAT KNOWS WHAT THE STRING
 * IS MADE OF — the classification, the replaced message and the child's own output — and the defect
 * this fixes is precisely three consumers each truncating a string none of them composed.
 *
 * WHAT WENT WRONG, MEASURED. {@link classifyRunnerFailure} capped the child's output it appended but
 * placed it AFTER `err.message`, which is uncapped: Node formats a non-zero exit as
 * `Command failed: <cmd>\n<the ENTIRE stderr>`, so for 200 KB of stderr the message alone is
 * ~200 KB and the 2000-character tail sat behind all of it. Every consumer then sliced from the
 * FRONT — managed-scan and managed-dep at 2000 on capture, managed-iac at 4000 on read — so the tail
 * the append exists to preserve was unreachable at EVERY output size for two of the three plugins
 * and inside a ~1.8 KB window for the third. With 5 KB of runner output the real cause reached no
 * operator at all. The four tests that covered this path all pinned the budget-kill arm, whose
 * message is REPLACED with a short string, which is why the whole mechanism could be inert.
 *
 * WHY 4 000. It is managed-iac's existing read slice, i.e. the largest bound any consumer already
 * imposed, so nothing that reached an operator before is smaller now. It is also the ceiling on a
 * row: `detail` is copied into `reconcile.ts`'s `insertDecision` `inputContext` and, for managed-iac,
 * into a durable on-disk ledger keyed by `idempotencyKey` that is never pruned — the same family as
 * this repository's 1.44 GB/day Decision incident, where an unbounded write per key was the whole
 * mechanism.
 */
export const RUNNER_DETAIL_MAX_CHARS = 4_000;

/** HOW MUCH OF A BOUNDED DETAIL'S END IS SACRED. See docs/runner-launcher/index.md §13. */
export const RUNNER_DETAIL_TAIL_CHARS = 2_000;

/**
 * A `detail` that is PROVABLY within {@link RUNNER_DETAIL_MAX_CHARS}, because the only way to obtain
 * one is {@link boundDetail}. This is the "a caller should not be able to receive an unbounded
 * `detail` at all" property expressed where the compiler can enforce it rather than as a comment
 * three consumers each read differently: the plugins' own outcome stores declare their `detail`
 * field as this type, so composing `` `my prefix — ${detail}` `` and storing it does not typecheck
 * until it is bounded again. Assignable TO `string` (so `ExecutionStatus.detail` needs no change);
 * not assignable FROM one.
 */
declare const BOUNDED_DETAIL: unique symbol;
export type BoundedDetail = string & { readonly [BOUNDED_DETAIL]: "bounded" };

/** Marks where characters were removed, and says how many rather than leaving a reader to wonder
 *  whether the runner simply stopped there. */
function elisionMarker(dropped: number): string {
  return ` …[${dropped} characters elided]… `;
}

/** Written as an escape, deliberately, here and in the pattern below. A LITERAL NUL byte in a
 *  tracked source file is invisible to every recursive search this repository runs (CLAUDE.md:
 *  `grep -rna`, `pnpm nul-census`) — a sanitiser nobody can grep for is the next place a census
 *  misses. `REPLACEMENT` is U+FFFD. */
const REPLACEMENT = "\uFFFD";

/**
 * THE TWO CODE POINTS POSTGRES REFUSES TO STORE, AND WHAT WE PUT THERE INSTEAD (HIGH regression,
 * M23.0 verification pass 8). Measured against a real `postgres:16`, inserting into a `jsonb`
 * column and into a `text` column:
 *
 * | input                       | jsonb                                    | text                                        |
 * |-----------------------------|------------------------------------------|---------------------------------------------|
 * | `"a\u{1F600}b"` (astral)    | OK                                       | OK                                          |
 * | lone HIGH surrogate `\uD83D`| FAIL `invalid input syntax for type json`| OK                                          |
 * | lone LOW surrogate `\uDE00` | FAIL `invalid input syntax for type json`| OK                                          |
 * | `U+0000`                    | FAIL `unsupported Unicode escape sequence`| FAIL `invalid byte sequence for encoding "UTF8": 0x00` |
 * | `U+FFFD`, `U+FFFF`, C0, DEL | OK                                       | OK                                          |
 *
 * So the predicate a persisted detail must satisfy is NOT "well-formed UTF-16" — `isWellFormed()`
 * returns TRUE for a string carrying `U+0000`, which `jsonb` still refuses. It is well-formed AND
 * NUL-free, and both halves were measured against the database rather than modelled, because the
 * database is the authority on what the database accepts.
 *
 * WHY U+FFFD FOR BOTH. It is the standard "there was a character here and it could not be
 * represented" mark, so an operator reading the detail sees that something was dropped instead of
 * silently reading a shortened string. It is also a ONE-code-unit replacement for a one-code-unit
 * input, which is why the elision arithmetic below stays exact: sanitising never changes `.length`.
 */
const NOT_PERSISTABLE = new RegExp(
  [
    // U+0000. `jsonb` refuses it outright; `text` refuses the byte. See the table above.
    "\\u0000",
    // A high surrogate with no low surrogate after it — what a HEAD cut leaves behind.
    "[\\uD800-\\uDBFF](?![\\uDC00-\\uDFFF])",
    // A low surrogate with no high surrogate before it — what a TAIL cut leaves behind.
    "(?<![\\uD800-\\uDBFF])[\\uDC00-\\uDFFF]"
  ].join("|"),
  "g"
);

function persistableText(text: string): string {
  // Every alternative above matches EXACTLY ONE code unit (the lookarounds are zero-width), so this
  // replacement preserves `.length`. The elision arithmetic in `boundDetail` depends on that.
  return text.replace(NOT_PERSISTABLE, REPLACEMENT);
}

/** BOUND A DETAIL, KEEPING BOTH ENDS. See docs/runner-launcher/index.md §14. */
export function boundDetail(text: string): BoundedDetail {
  return boundText(text, RUNNER_DETAIL_MAX_CHARS, RUNNER_DETAIL_TAIL_CHARS) as BoundedDetail;
}

/** THE SAME BOUND AT AN ARBITRARY WIDTH. See docs/runner-launcher/index.md §15. */
export function boundText(text: string, max: number, tailChars: number): string {
  return boundTextWithLoss(text, max, tailChars).text;
}

/**
 * {@link boundText}, PLUS HOW MANY OF THE ORIGINAL'S CHARACTERS IT REMOVED — M23.1g.
 *
 * WHY THE COUNT IS RETURNED RATHER THAN READ BACK OFF THE RESULT. The obvious way to recover it is
 * to match {@link elisionMarker} in the returned string. That is exactly the mistake M23.1g exists
 * to stop being made one layer up: the marker is CONTENT-SHAPED, a plugin can put the same
 * characters in a revision on purpose (`observed-state-gate-critical-leaf.integration.test.ts`
 * drives precisely that fixture), and a reader that pattern-matches it cannot tell our cut from
 * their string. Worse, the NARROW branch below — a `max` too small to carry both ends and an honest
 * count — emits NO marker at all, so a matcher reports "not truncated" for the case that lost the
 * most. The function that did the cutting is the only place the number is known for free.
 *
 * `dropped` is in ORIGINAL characters (UTF-16 code units), and `keptHead + dropped + keptTail ===
 * text.length` holds through sanitising because {@link persistableText} is length-preserving.
 */
function boundTextWithLoss(
  text: string,
  max: number,
  tailChars: number
): { text: string; dropped: number } {
  if (max <= 0) return { text: "", dropped: text.length };
  if (text.length <= max) return { text: persistableText(text), dropped: 0 };
  // `elisionMarker(text.length)` is the longest the marker can be (the count only shrinks), so
  // sizing the head against it guarantees the result fits even before the real count is known.
  const widest = elisionMarker(text.length);
  if (max <= widest.length + 2) {
    // Too narrow to carry both ends AND an honest count. Keep the END: for a runner failure, a
    // provider refusal or an exception message, the diagnosis is what the last characters hold.
    return { text: persistableText(text.slice(text.length - max)), dropped: text.length - max };
  }
  const tail = Math.min(tailChars, max - widest.length - 1);
  const headShare = Math.max(0, max - tail - widest.length);
  const dropped = text.length - headShare - tail;
  // The elision count stays arithmetically honest through sanitising precisely because
  // `persistableText` is length-preserving: `keptHead + dropped + keptTail === text.length` still.
  return {
    text: persistableText(
      text.slice(0, headShare) + elisionMarker(dropped) + text.slice(text.length - tail)
    ),
    dropped
  };
}

/**
 * THE TOTAL BUDGET FOR ONE PLUGIN-SUPPLIED STRUCTURE ENTERING A `jsonb` COLUMN — MEDIUM/HIGH, M23.0
 * verification pass 7 finding M2, and the reason it is a BUDGET rather than another per-field cap.
 *
 * WHAT WENT WRONG, MEASURED. The previous round bounded ONE field of `ExecutionStatus` — `detail` —
 * and missed its siblings three lines away in the same function. `observedStateFrom` reads
 * `stateRef` and `observed.images` off the SAME free-form object the round declares untrusted, and
 * `updateWaveTargetObserved` writes them into `change_wave_targets.observed_state` on the
 * `succeeded`, `failed`/`aborted` AND `observing` branches — i.e. EVERY tick, not only on failure.
 * Through the pre-existing `imagesByTarget` seam, with no product code modified:
 *
 *   OBSERVED-PROBE imageChars=500017 persistedImageChars=500017 rowJsonBytes={"b":500093,...}
 *
 * 500 093 bytes of plugin-chosen text, verbatim, in a row rewritten every second. And `stateRef`
 * reaches persistence a SECOND time, on a different write — `markWaveTargetTriggered`'s
 * `prior_state_ref` — as does `trigger()`'s whole `ExternalRunRef` in `executor_ref`. Three unbounded
 * plugin-supplied `jsonb` columns on one table.
 *
 * SO THE BOUND IS NOT A LIST OF FIELDS. A per-field patch list that happens to cover today's fields
 * is exactly what produced this finding: `ExecutionStatus.observed` is documented as "optional and
 * additive", so the next field an executor contributes arrives unbounded by default and nothing
 * goes red. This walks a whole VALUE against ONE budget, so a field nobody has written yet is
 * covered on the day it is added, and the guarantee is a fact about the ROW rather than about a
 * field: `JSON.stringify(boundPersistedJson(v).value).length <= PERSISTED_JSON_MAX_CHARS`, always,
 * checked exactly before returning. The `truncation` half of that return value is NOT inside this
 * number — it is a separate value with a separate bound
 * ({@link PERSISTED_JSON_TRUNCATION_MAX_CHARS}), so that a store which chooses to persist it
 * reserves for it out of its own column policy and no reading loses a character to a report it did
 * not need. `wave-targets-repo.ts` is the one store that does.
 *
 * WHY 8 000. Two `RUNNER_DETAIL_MAX_CHARS` worth of room, i.e. an `observed_state` may carry an
 * operator-readable revision, a realistic image list and a rollout message and still be about a
 * tenth the size of the smallest row in the 1.44 GB/day incident. It is a CEILING and not a target:
 * a real Argo CD reading is a few hundred bytes and is untouched by this.
 */
export const PERSISTED_JSON_MAX_CHARS = 8_000;

/**
 * How deep a plugin-supplied structure may nest before the rest is replaced by a marker. Also the
 * cycle guard: a self-referential object would otherwise recurse until the stack gave out, and the
 * values this walks are `unknown` from a subprocess whose serialiser we do not control.
 */
export const PERSISTED_JSON_MAX_DEPTH = 8;

/** A CEILING ON WHAT AN OBJECT KEY MAY RENDER TO. Keys are plugin-chosen too, and a key is not a
 *  place a reader looks for content, so it gets a much smaller share than a value.
 *
 *  IN RENDERED CHARACTERS, WHICH IS TWO MORE THAN THE KEY ITSELF — this comment used to say "no
 *  object KEY may be longer than this", and that is measurably false. {@link boundStringToCost}
 *  bounds the RENDERED cost, and `JSON.stringify` adds two quotes, so the widest key that survives
 *  a walk is 126 characters: measured, a 126-character key comes back verbatim at L + 96 and a
 *  127-character one comes back at NO budget, replaced by a head/marker/tail form. Recorded rather
 *  than "fixed" by adding 2, because the number that has to be a ceiling is the one the column is
 *  measured in; pinned as a boundary by `persisted-json-bound.test.ts` -> "THE LAW'S DOMAIN". */
const PERSISTED_JSON_MAX_KEY_CHARS = 128;

/** Never start a new element/field with less than this much budget left: enough for a short marker
 *  and its punctuation.
 *
 *  THIS COMMENT USED TO GO ON: "…so the elision itself can never be what pushes the row over."
 *  Measured false, M23.0 verification pass 11 — a guard on STARTING an element says nothing about
 *  what that element then spends, and the one it admits may take all of it. The marker's own money
 *  is {@link tailMarkerCost}, reserved before the elements are offered anything; this constant is
 *  only "the least a new element is worth starting".
 *
 *  AND IT IS A CEILING ON WHAT A REFUSAL HOLDS BACK, NOT A FLAT PRICE — M23.0 verification pass 12.
 *  Spelled as a flat 96 at the two places that REFUSE content, it reserved ninety-six characters
 *  for a value of `60` and elided the next key to pay for it; a reading of 2 495 characters came
 *  back damaged, and larger, at a budget of 8 000. Both sites now ask {@link admissionCost}, which
 *  is this number OR the value's own cost, whichever is smaller. Nothing else may spell it. */
const PERSISTED_JSON_MIN_LEAF = 96;

/** The key an over-budget object carries instead of the fields that did not fit. Exported so a
 *  test — or an operator's query — can find rows that were elided, rather than having to guess
 *  from a suspiciously short value. */
export const PERSISTED_JSON_ELIDED_KEY = "__scpElided";

/** THE ONE KEY THIS FILE REFUSES TO WRITE. See docs/runner-launcher/index.md §16. */
function isUnsafePersistedKey(key: string): boolean {
  return key === "__proto__";
}

/** WHAT THE BOUND REMOVED, AS DATA. See docs/runner-launcher/index.md §17. */
export interface PersistedJsonFieldTruncation {
  /**
   * The field is NOT IN THE STORED VALUE AT ALL and that is our doing, not the executor's. This is
   * the bit the wrong-cause defect turned on: without it, "absent" and "we cut it" are the same
   * bytes on the wire.
   */
  dropped: boolean;
  /** Characters removed from strings anywhere inside this field's subtree. */
  droppedCharacters?: number;
  /** Array entries removed from arrays anywhere inside this field's subtree. */
  droppedEntries?: number;
  /** Object fields removed from objects anywhere inside this field's subtree — including the field
   *  itself when `dropped` is true's siblings did the same. Their NAMES are gone below the root:
   *  the walk replaces them with {@link PERSISTED_JSON_ELIDED_KEY} and a count. */
  droppedFields?: number;
}

/** Keyed by the ROOT FIELD of the bounded value. See docs/runner-launcher/index.md §18. */
export type PersistedJsonTruncation = Record<string, PersistedJsonFieldTruncation>;

/** {@link boundPersistedJson}'s result: what will be stored, and what storing it cost. */
export interface BoundedPersistedJson {
  value: unknown;
  /** Undefined when the value came back with everything it arrived with. */
  truncation?: PersistedJsonTruncation;
}

/** HOW WIDE THE REPORT ITSELF MAY BE. See docs/runner-launcher/index.md §19. */
export const PERSISTED_JSON_TRUNCATION_MAX_CHARS = 288;

/**
 * WHAT `null` COSTS — MEDIUM, M23.0 verification pass 11, and the reason it is a NAMED CONSTANT
 * used by all three branches rather than a `4` typed in one of them.
 *
 * THE PROPERTY: every leaf branch of {@link walk} must charge what its return value RENDERS to.
 * Four of the leaf branches did. Three returned something that `JSON.stringify` writes as the four
 * characters `null` and, of those three, only the non-finite-number branch charged for it:
 *
 *     value                      renders   charged (before)   charged (now)
 *     NaN / Infinity             null           4                  4
 *     null / undefined           null           0   <- bug         4
 *     function / symbol          null           0   <- bug         4
 *
 * The comment on the non-finite branch even names the reason ("a non-finite number is `null` to
 * `JSON.stringify` anyway; making that explicit means the accounting below is the truth") — a
 * well-written comment naming a hazard, handled in ONE of the three places that have it
 * (CLAUDE.md, "census by property, not by symptom"). Both misses are on the branches a reader
 * skims past because they look like they do nothing.
 *
 * WHY IT WAS NOT MERELY UNTIDY. Free elements DEFEAT THE ARRAY GUARD. An array element is admitted
 * while `budget.left >= PERSISTED_JSON_MIN_LEAF`, so the guard can only stop a list whose elements
 * actually spend; a `null` charged 0 spends 1 (its comma) and renders 5 (`,null`). Measured at the
 * production 8 000 budget, with NOTHING else in the value:
 *
 *     {a: [ ...1 598 nulls ]}   row 7 997             stored
 *     {a: [ ...1 599 nulls ]}   walk rendered 8 004   FALLBACK — the whole value is discarded
 *
 * and the fallback is the worst possible loss: not a truncated list a reader can recognise with
 * {@link isPersistedJsonEntriesElision}, but `observed_state` replaced WHOLESALE by a diagnostic
 * string, so `revision`, `images` and `rollout.weight` are all simultaneously gone, silently, on
 * every tick. It is the exact failure this file was written to prevent, arriving through the one
 * leaf nobody costed.
 *
 * WHY THE SUITE WAS GREEN. `persisted-json-bound.test.ts` has a 19-arm adversarial corpus and an
 * arm asserting THE INTERNAL OVERFLOW FALLBACK NEVER FIRES — but every array in that corpus holds
 * strings or integers, both of which are charged exactly. A fixture cannot witness a defect in a
 * branch it never reaches; the corpus now carries `null`, `undefined` and a function.
 *
 * PRE-EXISTING, NOT THIS FAMILY OF ROUNDS'. Verified against the walk as it stood at passes 7, 8
 * and 9: all three render 10 007 characters for `{a: [2 000 nulls]}` and all three fall back.
 */
const NULL_RENDERED_CHARS = 4;

/** WHAT AN ARRAY HOLDS BACK FOR ITS OWN TAIL MARKER. See docs/runner-launcher/index.md §20. */
/** The entry an over-budget ARRAY carries in place of its dropped tail. One function, so the marker
 *  and its recogniser below cannot drift apart. */
function entriesElisionMarker(dropped: number): string {
  return `[elided: ${dropped} more entries]`;
}

function tailMarkerCost(length: number): number {
  // `entriesElisionMarker(length)` is the WIDEST this marker can be — the count only shrinks as
  // entries are kept — so the reserve is exact before the real count is known. Same idiom, and the
  // same reason, as {@link boundText} sizing its head against `elisionMarker(text.length)`.
  return jsonCost(entriesElisionMarker(length)) + 1; // + the comma that separates it from the tail
}

/** The value an over-budget OBJECT stores under {@link PERSISTED_JSON_ELIDED_KEY} in place of the
 *  fields that did not fit. One function, beside the array's, so the two markers and the two
 *  reserves that pay for them cannot drift apart. */
function fieldsElisionMarker(dropped: number): string {
  return `${dropped} more fields`;
}

/**
 * WHAT AN OBJECT HOLDS BACK FOR ITS OWN ELISION ENTRY — HIGH, M23.0 verification pass 14, and the
 * defect pass 11's array fix left standing one branch away.
 *
 * Pass 11 found that a cut ARRAY charged its tail marker against a budget it had already spent, and
 * bought the marker first. The OBJECT does the identical thing with the identical consequence and
 * was not swept: phase 1 subtracts `jsonCost(marker) + jsonCost(__scpElided) + 2` with no check
 * that it can be afforded. A well-written comment naming a hazard is a signal to sweep, not
 * evidence it was handled (CLAUDE.md) — the array's fix names the hazard in full and fixes one of
 * the two places that have it.
 *
 * WHY IT IS WORSE HERE THAN IT WAS FOR THE ARRAY. An array's overspend is one marker on one list.
 * An object's is one marker PER ELIDING OBJECT, and an eliding object is the normal state of every
 * level of a nested reading at a tight budget — so the overspends multiply by the tree's width and
 * depth rather than adding up over a handful of lists. Measured on `{d5f0..d5f2: {...}}`, five
 * levels of three fields, 4 483 characters of ordinary content, at the DENSE BUDGET SWEEP this pass
 * is built around:
 *
 *     budget 1200   walk given 1104   rendered 1189   budget.left  -85
 *     budget 3000   walk given 2904   rendered 2917   budget.left  -13
 *     budget 4000   walk given 3904   rendered 3916   budget.left  -12
 *
 * and four levels of three fields — 1 486 characters — rendered 1 297 against a budget of 1 200,
 * i.e. 193 over, past the single {@link PERSISTED_JSON_MIN_LEAF} the row reserves, so THE BACKSTOP
 * DISCARDED THE WHOLE VALUE. It did so at EVERY budget from 4 to 1 296, and the five-level shape at
 * every budget up to 3 915: `revision`, `images` and `rollout.weight` replaced together by a
 * 145-character apology, silently, on every tick. 15 982 backstop firings over 145 048
 * (shape, budget) pairs.
 *
 * THE FIX IS THE ARRAY'S, APPLIED TO THE BRANCH THAT WAS MISSED. The object asks first whether it
 * fits whole; if it does not, it buys the widest elision entry it could need BEFORE phase 1 seats
 * anything, and hands the reserve back at exactly one of two places — to the marker, or to the pool
 * if every key seated. So a complete object costs exactly what it cost before (the reserve is zero
 * for it, which is what keeps "L + 96 IS THE WHOLE LAW" true), and an eliding one has already paid.
 *
 * AND IT MAKES THE OVERSPEND A THEOREM RATHER THAN A HOPE. Every container is walked with at least
 * {@link admissionCost} — the value's exact cost when that is under 96, and 96 otherwise. A
 * container whose exact cost fits keeps everything and needs no marker; one admitted at 96 can
 * afford any marker this file emits, because 96 exceeds all of them (the widest object entry is 47
 * rendered characters at 2^53 fields, the widest array tail 37, the depth marker 60). So the ONLY
 * container that can overspend is the ROOT, which `boundPersistedJson` hands `maxChars - 96` — and
 * the 96 it held back is larger than the one marker the root can fail to afford. Zero backstop
 * firings and zero over-budget rows over the sweep is the measurement of that.
 */
function fieldsElisionCost(fields: number): number {
  // The widest it can be: the count only shrinks as keys are seated. `+ 2` is the `:` and the comma
  // that attach the entry to the object — the two characters phase 1 charged and never reserved.
  return jsonCost(fieldsElisionMarker(fields)) + jsonCost(PERSISTED_JSON_ELIDED_KEY) + 2;
}

/**
 * DOES THIS ARRAY ENTRY MEAN "THE LIST WAS CUT HERE"? — the difference between "the executor never
 * deployed that image" and "we stopped writing the list down". Those are different facts and
 * reporting one as the other is the provenance-label defect this repository has already shipped once
 * (a Decision whose label named the branch that matched rather than what was true; charter
 * principle 6).
 *
 * A reader that pulls a SPECIFIC entry out of a bounded array needs this, because after a cut a MISS
 * is not evidence of absence. `internal-release-version.ts` is the live case: it scans
 * `observed_state.images` for the ref whose repository equals a dependency line's coordinate, and
 * without this a miss caused by the bound is reported as `no_matching_image_ref` — which blames the
 * executor for something this file did.
 *
 * A PLUGIN CAN SPOOF IT by returning this exact string as an entry, and that is deliberately not
 * defended against. The consequence of a false positive is a reader refusing to determine something
 * it could have determined — the safe direction. The reverse, a real cut going unrecognised, is the
 * one that produces a confident wrong answer.
 */
export function isPersistedJsonEntriesElision(value: string): boolean {
  return /^\[elided: \d+ more entries\]$/.test(value);
}

/**
 * WHAT THE WALK WOULD ACTUALLY SPEND ON `value`, MEASURED UP TO `cap` — HIGH, M23.0 verification
 * pass 12, and the reason {@link PERSISTED_JSON_MIN_LEAF} may no longer be spelled as a flat
 * number anywhere content is REFUSED.
 *
 * WHAT WENT WRONG, MEASURED. {@link PERSISTED_JSON_MIN_LEAF} is 96, and both places that decide
 * whether to keep the next thing held back 96 characters for it WITHOUT ASKING WHAT IT COSTS. For
 * a field whose whole value is `60`, that reserves 96 characters for two — and the reservation is
 * what elides the NEXT key. The losses are silent, they are worst on the small uniform readings a
 * controller actually reports, and they are not visible in the row's length, because the row comes
 * out THOUSANDS OF CHARACTERS SHORT of the budget while content is being thrown away:
 *
 *   {resources: {30 x {status, health, version}}}   input 2 495   budget 8 000
 *       stored 2 825 characters, LOSSY — a value that fits three times over came back damaged
 *       AND LARGER, because `__scpElided: "1 more fields"` (30 chars) replaced `"version":"v1.4.2"`
 *   the same reading at 80 resources                input 6 645   budget 8 000
 *       stored 3 684 — 4 316 characters, 54 % of the column, abandoned while entries were cut
 *   {svc-i: {c-k: {ready, restarts, image}}}, 8 x 4  input 1 553 -> stored 2 097, every leaf's
 *       `image` replaced by a marker saying a field was dropped
 *
 * The 8 000-character budget was never the constraint in any of those: 96 x (keys at that level)
 * was, at EVERY level, multiplying down the tree. And the redistribution rounds cannot give it
 * back — when every sibling is clipped for the same reason, `stillPending.length ===
 * pending.length` and the loop breaks at round 0 with the pool untouched.
 *
 * IT IS ALSO WHY RETENTION WAS NOT MONOTONE IN THE BUDGET. Measured over budgets 4 to 8 200, one
 * character MORE of budget stored strictly less: `{revision, images(40), rollout}` at 417 kept two
 * whole image refs and rendered 300; at 418 it seated a third key, every field's share fell to 96,
 * `images` could no longer afford a single entry, and the row fell to 148 of the 418 available.
 * Pinned as a property (`persisted-json-bound.test.ts` -> "RETENTION IS MONOTONE IN THE BUDGET"),
 * because "more budget stores less" is the shape of a rule that is measuring the wrong thing.
 *
 * WHAT THIS RETURNS. The EXACT rendered cost of `value` when that is at most `cap`, and any number
 * greater than `cap` once the walk is known to spend more. Callers take
 * `min(PERSISTED_JSON_MIN_LEAF, thisCost)`, so an over-`cap` answer reproduces the old flat
 * reservation EXACTLY — the change can only ever admit content the old rule refused, never the
 * reverse, which is what keeps it from becoming a new way to overspend.
 *
 * WHY IT IS SAFE TO CALL IN THE HOT LOOP. It never reads more than `cap` characters' worth: every
 * accumulation is followed by a `> cap` test, a string longer than `cap` is rejected on its
 * `.length` before `JSON.stringify` is called on it, and the recursion is bounded by
 * {@link PERSISTED_JSON_MAX_DEPTH} as well as by `cap`. That second bound is not redundant — it is
 * the cycle guard, and the values this walks are `unknown` from a subprocess whose serialiser we do
 * not control.
 *
 * IT MIRRORS `walk`, BRANCH FOR BRANCH, AND THAT IS A COUPLING. A leaf `walk` charges more for than
 * this predicts is a leaf that can be admitted for less than it costs. The two are pinned against
 * each other over millions of small shapes at every budget by `persisted-json-bound.test.ts` ->
 * "WHAT THE WALK CHARGES IS WHAT THE ESTIMATE PREDICTED", so a new branch in one that is missing
 * from the other reddens rather than silently overspending.
 */
function renderedCostAtMost(value: unknown, cap: number, depth: number): number {
  const over = cap + 1;
  // A NEGATIVE CAP IS REACHABLE AND ITS ANSWER IS NOT OBSERVABLE — M23.0 verification pass 14,
  // recorded because pass 13 listed `return over` -> `return 0` as a mutation that survived and
  // asked for a corpus or a measured argument. This is the measured argument.
  //
  // Recursion never passes a negative cap (every `cap - total` is guarded by a `total > cap` test
  // immediately above it), so the only callers that can are the two that ask "does this container
  // fit whole in what I have left" — `walk`'s array branch and its object branch — and
  // `budget.left` can be negative there. Instrumented over the 145 048-pair budget sweep:
  //
  //     renderedCostAtMost calls                       33 785 292
  //     entered with cap < 0                               11 960   (most negative: -92)
  //     where `over` and `0` would compare differently          0
  //
  // Both callers use the result ONLY as `wholeCost <= room`, where `room === cap`. For cap < 0,
  // `cap + 1 <= cap` is false and `0 <= cap` is false, so the two answers are the same decision at
  // every negative cap there is. The branch is a FAST PATH, not a correctness requirement — delete
  // it and the string branch's `value.length > cap` and the container branches' `total > cap` each
  // return `over` anyway. It is kept because it says at the top what the reader would otherwise
  // have to derive from three later comparisons.
  if (cap < 0) return over;
  // `walk` charges these BEFORE its depth check, so this must too.
  if (value === null || value === undefined) return NULL_RENDERED_CHARS;
  switch (typeof value) {
    case "string":
      // `.length` first: rendering is never cheaper than one character per code unit, so this
      // rejects a 500 000-character plugin string without `JSON.stringify` ever touching it.
      // `persistableText` is length-preserving but NOT cost-preserving — a NUL becomes U+FFFD,
      // which renders as one character where the NUL rendered as six.
      return value.length > cap ? over : jsonCost(persistableText(value));
    case "number":
      return Number.isFinite(value) ? String(value).length : NULL_RENDERED_CHARS;
    case "boolean":
      return value ? 4 : 5;
    case "object":
      break;
    default:
      // `bigint` goes through the STRING path in `walk` and is not worth predicting; a function or
      // a symbol renders as `null` in both positions it can occupy — {@link NULL_RENDERED_CHARS}.
      return typeof value === "bigint" ? over : NULL_RENDERED_CHARS;
  }
  // At the depth limit `walk` stores a marker instead of the subtree, whatever the subtree costs.
  // Reporting "more than `cap`" makes the caller fall back to the flat reservation, which is the
  // conservative direction; predicting the marker's own width here would be an under-estimate for
  // any subtree cheaper than it.
  if (depth >= PERSISTED_JSON_MAX_DEPTH) return over;

  if (Array.isArray(value)) {
    let total = 2;
    for (let i = 0; i < value.length; i++) {
      if (i > 0) total += 1;
      if (total > cap) return over;
      total += renderedCostAtMost(value[i], cap - total, depth + 1);
      if (total > cap) return over;
    }
    return total;
  }

  let total = 2;
  let first = true;
  for (const [rawKey, entryValue] of Object.entries(value as Record<string, unknown>)) {
    if (entryValue === undefined) continue;
    // AND SO DOES `walk` FOR THIS ONE, for a different reason — see {@link isUnsafePersistedKey}.
    // The estimate mirrors the walk branch for branch or a field is admitted for less than it
    // costs; here the drift would be the other way (an over-estimate), but "the other way" is how
    // a mirror stops being checkable.
    if (isUnsafePersistedKey(rawKey)) continue;
    // A key past the cap is bounded rather than stored whole, so its cost is not predictable from
    // the key itself; fall back rather than guess.
    if (rawKey.length > PERSISTED_JSON_MAX_KEY_CHARS) return over;
    total += jsonCost(persistableText(rawKey)) + 1 + (first ? 0 : 1);
    first = false;
    if (total > cap) return over;
    total += renderedCostAtMost(entryValue, cap - total, depth + 1);
    if (total > cap) return over;
  }
  return total;
}

/**
 * THE LEAST BUDGET THAT ADMITTING `value` CAN REQUIRE: {@link PERSISTED_JSON_MIN_LEAF}, unless the
 * whole value is cheaper than that, in which case it is what the value actually costs. One
 * function, called from both places a flat 96 used to be spelled — the object's key seating and the
 * array's element admission — because they are the same fact, and a census that fixed one of them
 * would have left the other (CLAUDE.md: census by property, not by symptom).
 */
function admissionCost(value: unknown, depth: number): number {
  return Math.min(
    PERSISTED_JSON_MIN_LEAF,
    renderedCostAtMost(value, PERSISTED_JSON_MIN_LEAF, depth)
  );
}

/** WHAT ONE FIELD OF AN OBJECT MAY SPEND. See docs/runner-launcher/index.md §21. */
const PERSISTED_JSON_SHARE_ROUNDS = 5;

/**
 * Walk an object's fields under the water-filling rule documented on
 * {@link PERSISTED_JSON_SHARE_ROUNDS}. Split out of `walk` because phase 2 needs the raw value of
 * every field it may re-walk, which a single in-place loop cannot keep.
 */
/** AND PHASE 2 MUST HONOUR WHAT PHASE 1 RESERVED. See docs/runner-launcher/index.md §22. */
function walkObjectFields(
  entries: [string, unknown][],
  budget: WalkBudget,
  depth: number,
  /** Whether `walk` already measured this object as fitting whole in the budget it was handed. An
   *  object that fits cannot elide, so it must not be charged for an elision entry — the same
   *  question, asked for the same reason, as the array's `wholeCost <= room`. */
  fitsWhole: boolean
): Record<string, unknown> {
  /** Seated fields in insertion order. `raw` is kept because phase 2 walks each field more than
   *  once — at a larger share each time — and needs the original to walk. */
  const seated: {
    key: string;
    raw: unknown;
    value: unknown;
    spent: number;
    need: number;
    /** What bounding the KEY cost. Charged once, before any value is walked, and therefore kept
     *  separately from the value's loss — which is REPLACED on every re-walk. */
    keyDropped: number;
    /** WHAT THIS FIELD LOST, replaced (never accumulated) on every re-walk — phase 2 walks a field
     *  more than once and only the LAST walk's value is stored, so only the last walk's loss is
     *  true. Accumulating instead would report a field cut two or three times over, and a re-walk
     *  is the NORMAL case here: the water-filling loop exists to run it. */
    loss: WalkLoss;
  }[] = [];
  let elidedMarker: string | undefined;
  /** Root-level attribution only — see {@link WalkBudget.fields}. Below the root the names are not
   *  addressable from the API and the losses roll up into the root field that contains them. */
  const collector = depth === 0 ? budget.fields : undefined;
  /** Root fields phase 1 refused outright. Their names are the ONLY place "we cut `rollout`" and
   *  "the executor reported no rollout" stop being the same bytes, and the stored value cannot
   *  carry them: `__scpElided` is a COUNT, deliberately, because the names would be plugin-chosen
   *  text competing with the reading for the column. */
  let refusedKeys: string[] | undefined;
  /** The sum of what the already-seated fields need — {@link admissionCost} each, NOT a flat
   *  {@link PERSISTED_JSON_MIN_LEAF} each. A field whose whole value is `60` reserves two
   *  characters, and the difference is a key that stays. */
  let reserved = 0;
  // THE ELISION ENTRY IS BOUGHT BEFORE A KEY IS SEATED — see {@link fieldsElisionCost}. Held for
  // the whole of phase 1 and handed back at exactly one of two places: to the marker, or to the
  // pool if every key seated. Clamped at what there is, which matters only for a root handed less
  // than the marker costs — the one container `boundPersistedJson`'s own reserve covers.
  const elisionReserve = fitsWhole
    ? 0
    : Math.min(Math.max(0, budget.left), fieldsElisionCost(entries.length));
  budget.left -= elisionReserve;

  // ---- PHASE 1: SEAT THE KEYS. Charge the keys and NOTHING ELSE, so the pool phase 2 divides is
  // a number that does not depend on the order the fields arrived in.
  for (let i = 0; i < entries.length; i++) {
    const [rawKey, entryValue] = entries[i]!;
    if (entryValue === undefined) continue;
    const boundedKey = boundStringToCost(
      rawKey,
      Math.min(budget.left, PERSISTED_JSON_MAX_KEY_CHARS)
    );
    const key = boundedKey.text;
    if (isUnsafePersistedKey(key)) {
      // REFUSED FOR SAFETY, NOT FOR ROOM. See docs/runner-launcher/index.md §23.
      budget.loss.fields += 1;
      collector?.set(key, { dropped: true });
      continue;
    }
    const keyCost = jsonCost(key) + 1 + (seated.length > 0 ? 1 : 0);
    // EVERY seated field must still be able to get what IT needs, not just this one: the guarantee
    // has to hold for the fields already seated, whose values are not walked until phase 2. What a
    // field needs is {@link admissionCost} — capped at {@link PERSISTED_JSON_MIN_LEAF} for anything
    // large, and the value's exact cost for anything small. `entries.length - i` counts THIS field
    // plus the ones behind it; a later `undefined` value makes that an over-count, which only makes
    // the marker's number too big — and the marker is a count of fields the reader cannot see
    // either way.
    const need = admissionCost(entryValue, depth + 1);
    if (budget.left - keyCost < reserved + need) {
      elidedMarker = fieldsElisionMarker(entries.length - i);
      // THE RESERVE, SPENT ON WHAT IT WAS BOUGHT FOR. `fieldsElisionCost(entries.length)` is the
      // widest this can be, so what is charged here is never more than what was held back — and
      // the difference (the digits the real count did not need) returns to the pool.
      // ONE function prices both, deliberately: this line used to spell the arithmetic out a
      // second time, and two spellings of one price is how a reserve stops covering the charge it
      // was bought for.
      budget.left += elisionReserve;
      budget.left -= fieldsElisionCost(entries.length - i);
      // THE SAME NUMBER THE MARKER CARRIES, for the same reason the array's does.
      budget.loss.fields += entries.length - i;
      if (collector) {
        // Bounded like any other plugin-chosen string that becomes a row — this one lands in the
        // report rather than in the value, but it is the same untrusted text.
        refusedKeys = entries
          .slice(i)
          .filter(([, refusedValue]) => refusedValue !== undefined)
          .map(([refusedKey]) => boundText(refusedKey, PERSISTED_JSON_MAX_KEY_CHARS, 0));
      }
      break;
    }
    budget.left -= keyCost;
    reserved += need;
    seated.push({
      key,
      raw: entryValue,
      value: undefined,
      spent: 0,
      need,
      keyDropped: boundedKey.dropped,
      loss: { characters: boundedKey.dropped, entries: 0, fields: 0 }
    });
  }

  // No cut: the reserve was never needed, and it goes to the fields rather than being burned — the
  // array's `budget.left += tailReserve` on the same branch, for the same reason.
  if (elidedMarker === undefined) budget.left += elisionReserve;

  // ---- PHASE 2: WATER-FILL THE VALUES. `pool` is what the fields in `pending` have to divide;
  // a field that finishes under its share is taken out and only its ACTUAL spend leaves the pool.
  let pool = budget.left;
  let pending = seated.map((_, index) => index);
  for (let round = 0; round < PERSISTED_JSON_SHARE_ROUNDS && pending.length > 0; round++) {
    // Never negative in round 0: phase 1 seats a key only while `admissionCost` per seated field
    // still fits. A later round can drive it to 0 for a pathological object, and 0 is a legal
    // share — the field stores a marker rather than nothing at all.
    const share = Math.max(0, Math.floor(pool / pending.length));
    const stillPending: number[] = [];
    let satisfiedSpend = 0;
    for (const index of pending) {
      const field = seated[index]!;
      // AT LEAST WHAT PHASE 1 RESERVED FOR IT — HIGH, M23.0 verification pass 13, and the
      // half of pass 12's fix that pass 12 did not carry through. See the block above
      // {@link walkObjectFields} under "AND PHASE 2 MUST HONOUR WHAT PHASE 1 RESERVED".
      const offered = Math.max(share, field.need);
      // A FRESH LOSS ACCUMULATOR PER ATTEMPT, at every depth. Sharing the parent's would double
      // count a field re-walked at a larger share — and a re-walk is the NORMAL case here, not a
      // pathological one: the water-filling loop exists to run it. The winning attempt's loss
      // replaces the previous one below.
      const sub: WalkBudget = { left: offered, loss: emptyLoss() };
      field.value = walk(field.raw, sub, depth + 1);
      field.loss = { characters: field.keyDropped, entries: 0, fields: 0 };
      addLoss(field.loss, sub.loss);
      // Charge what was ACTUALLY spent, not the share. `sub.left` may go slightly negative when a
      // leaf overshoots its own share; the difference keeps the accounting exact either way, which
      // is what the measured check in `boundPersistedJson` is the backstop for.
      field.spent = offered - sub.left;
      if (sub.clipped === true) stillPending.push(index);
      else satisfiedSpend += field.spent;
    }
    // Everyone still wants more: an equal split of everything there is IS the end state, and
    // another round would hand out the same shares again.
    if (stillPending.length === pending.length) break;
    pool -= satisfiedSpend;
    pending = stillPending;
  }
  // Whatever is still pending holds its last share's spend; everything else is already out of the
  // pool. What remains is genuinely unspent and goes back to the parent.
  for (const index of pending) pool -= seated[index]!.spent;
  budget.left = pool;

  // TELL THE PARENT whether this subtree would use more budget, AFTER redistribution rather than
  // during phase 1 — a field that phase 2 satisfied is not a reason for the parent to re-walk us.
  if (pending.length > 0 || elidedMarker !== undefined) budget.clipped = true;

  // ROLL THE FIELDS' LOSSES UP so an ancestor's accumulator (and, at the root, the "was anything
  // cut at all" test) sees them. The key-bounding loss seeded above rides along.
  for (const field of seated) addLoss(budget.loss, field.loss);
  if (collector) {
    for (const field of seated) {
      if (isLossy(field.loss)) collector.set(field.key, truncationOf(field.loss, false));
    }
    for (const refused of refusedKeys ?? []) collector.set(refused, { dropped: true });
  }

  const out: Record<string, unknown> = {};
  // `out[key] = value` AND `Object.assign(out, {[key]: value})` ARE THE SAME HERE, and both passes
  // 14 and 15 record that as a measured no-op rather than as a caught mutation: zero differing
  // pairs over 145 048 (pass 14) and over 700 536 (pass 15, a family with a ladder in it).
  //
  // PASS 14'S STATED REASON WAS WRONG AND IS CORRECTED HERE, because a false reason is worse than
  // none — a reader would conclude the guard below is what makes `Object.assign` safe. It is not.
  // `Object.assign` copies with `[[Set]]`, exactly as `out[key] = value` does, so the two are
  // identical for EVERY key INCLUDING `__proto__` — measured: both leave `Object.getPrototypeOf`
  // changed and `polluted` readable, and rebuilding with `isUnsafePersistedKey` DELETED still gives
  // zero differing pairs between them. What actually differs from `out[key] = value` is a SPREAD or
  // `Object.defineProperty`, both of which create an own data property instead of calling the
  // setter — which is why `wave-targets-repo.ts` spreading `...bounded.value` is safe and an
  // `Object.assign({}, observed)` in a consumer is not (see {@link isUnsafePersistedKey}).
  //
  // So this substitution is an unconditional no-op, not a no-op contingent on the guard. Pass 13
  // listed it as a surviving mutation and read its SIGNIFICANCE correctly — it was a proxy for the
  // prototype-pollution hole — but the hole is closed by the refusal in phase 1 above, not by the
  // choice of write form here. Neither form would be safe without it.
  for (const field of seated) out[field.key] = field.value;
  if (elidedMarker !== undefined) out[PERSISTED_JSON_ELIDED_KEY] = elidedMarker;
  return out;
}

/** Exactly what `JSON.stringify` will spend on this leaf, escapes included — the accounting has to
 *  be in RENDERED characters, because that is the unit the column is measured in. A string of
 *  backslashes doubles; a C0 control sextuples. */
function jsonCost(value: string | number | boolean): number {
  return JSON.stringify(value).length;
}

/** BOUND `text` SO ITS RENDERED COST FITS `left`. See docs/runner-launcher/index.md §24. */
function boundStringToCost(text: string, left: number): { text: string; dropped: number } {
  const widest = Math.min(RUNNER_DETAIL_MAX_CHARS, left);
  if (widest <= 0) return { text: "", dropped: text.length };
  const whole = boundTextWithLoss(text, widest, Math.floor(widest / 2));
  if (jsonCost(whole.text) <= left) return whole;

  // Bisect [0, widest) for the largest width whose RENDERED cost fits. `best` stays "" only when
  // not even the empty string fits — `left < 2` — which the row-level measurement in
  // `boundPersistedJson` is the backstop for. Its `dropped` is the WHOLE string, which is the truth
  // in that case and is what the truncation report must say.
  let best = { text: "", dropped: text.length };
  let lo = 0;
  let hi = widest - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const candidate = boundTextWithLoss(text, mid, Math.floor(mid / 2));
    if (jsonCost(candidate.text) <= left) {
      best = candidate;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

/**
 * THE WALK'S BUDGET, PLUS THE ONE BIT THAT MAKES REDISTRIBUTION POSSIBLE.
 *
 * `clipped` means "this sub-walk lost content it would have kept had its budget been larger" — a
 * truncated string, an array whose tail became a marker, an object whose fields became
 * `__scpElided`. It is what {@link walkObjectFields}'s pass 2 selects on, so it is deliberately NOT
 * set by the two losses more budget cannot fix: the depth-limit marker, and a non-finite number
 * rendering as `null`. Setting it for those would spend a redistribution round producing byte-identical
 * output.
 */
type WalkBudget = {
  left: number;
  clipped?: boolean;
  /**
   * WHAT THIS SUB-WALK REMOVED, in the units a reader can act on. Separate from `clipped`, which is
   * a scheduling bit ("offer me more budget and I will keep more") that the redistribution loop
   * consumes and then forgets. `loss` is the DURABLE fact — it is what
   * {@link boundPersistedJson} turns into {@link PersistedJsonTruncation}, and the reason a
   * consumer can tell `rollout: undefined` because the executor reported no rollout from
   * `rollout: undefined` because we cut it.
   *
   * NOT SET BY SANITISING. {@link persistableText} replaces U+0000 and lone surrogates with U+FFFD
   * one code unit for one; nothing is removed, the value stays readable, and calling that
   * "truncation" would make the signal fire on readings that lost nothing.
   */
  loss: WalkLoss;
  /**
   * ROOT-LEVEL ATTRIBUTION, and only the root budget carries it. `loss` alone answers "was anything
   * cut"; this answers "cut from WHICH field", which is the whole difference between an operator
   * told "no rollout" and an operator told "we truncated the rollout". Populated by
   * {@link walkObjectFields} at depth 0 only — below the root the field names are not addressable
   * from the API, and a path-shaped key would be plugin-chosen text in a governed row.
   */
  fields?: Map<string, PersistedJsonFieldTruncation>;
};

/** What one sub-walk removed. Three units because they are three different facts to a reader: a
 *  shortened string, a cut list, and a key that is not there at all. */
type WalkLoss = { characters: number; entries: number; fields: number };

function emptyLoss(): WalkLoss {
  return { characters: 0, entries: 0, fields: 0 };
}

function addLoss(into: WalkLoss, from: WalkLoss): void {
  into.characters += from.characters;
  into.entries += from.entries;
  into.fields += from.fields;
}

function isLossy(loss: WalkLoss): boolean {
  return loss.characters > 0 || loss.entries > 0 || loss.fields > 0;
}

function truncationOf(loss: WalkLoss, dropped: boolean): PersistedJsonFieldTruncation {
  const entry: PersistedJsonFieldTruncation = { dropped };
  if (loss.characters > 0) entry.droppedCharacters = loss.characters;
  if (loss.entries > 0) entry.droppedEntries = loss.entries;
  if (loss.fields > 0) entry.droppedFields = loss.fields;
  return entry;
}

function walk(value: unknown, budget: WalkBudget, depth: number): unknown {
  if (value === null || value === undefined) {
    // FOUR CHARACTERS, CHARGED — see {@link NULL_RENDERED_CHARS}. Reached only from an ARRAY
    // element (an object's `undefined` field is dropped by `walkObjectFields` phase 1 before it
    // gets here, and a top-level one is short-circuited by `boundPersistedJson`), and
    // `JSON.stringify` renders an `undefined` array element as `null` exactly like a real one.
    budget.left -= NULL_RENDERED_CHARS;
    return value;
  }

  switch (typeof value) {
    case "string": {
      const bounded = boundStringToCost(value, budget.left);
      // `clipped` and `loss` are set on DIFFERENT conditions and that is deliberate. Sanitising a
      // NUL changes the text without removing anything (`bounded.text !== value`, `dropped === 0`),
      // and more budget would not bring it back — so it must not schedule a redistribution round
      // and must not be reported as truncation. See {@link WalkBudget}.
      if (bounded.text !== value) budget.clipped = true;
      budget.loss.characters += bounded.dropped;
      budget.left -= jsonCost(bounded.text);
      return bounded.text;
    }
    case "number": {
      // A non-finite number is `null` to `JSON.stringify` anyway; making that explicit means the
      // accounting below is the truth rather than an approximation of it.
      if (!Number.isFinite(value)) {
        budget.left -= NULL_RENDERED_CHARS;
        return null;
      }
      budget.left -= String(value).length;
      return value;
    }
    case "boolean":
      budget.left -= value ? 4 : 5;
      return value;
    case "bigint": {
      // `JSON.stringify` THROWS on a bigint. A plugin's JSON-RPC response cannot carry one today,
      // but this function's contract is "any value", and a throw here is the stall this whole file
      // exists to prevent.
      const rendered = String(value);
      const bounded = boundStringToCost(rendered, budget.left);
      if (bounded.text !== rendered) budget.clipped = true;
      budget.loss.characters += bounded.dropped;
      budget.left -= jsonCost(bounded.text);
      return bounded.text;
    }
    case "object":
      break;
    default:
      // function / symbol — `JSON.stringify` drops these; be explicit rather than lucky. The
      // explicit `null` is four rendered characters in BOTH positions this can occupy (an array
      // element, and an object field this function has already returned a value for), so it is
      // charged like one — see {@link NULL_RENDERED_CHARS}.
      budget.left -= NULL_RENDERED_CHARS;
      return null;
  }

  if (depth >= PERSISTED_JSON_MAX_DEPTH) {
    // NOT a budget clip — see {@link WalkBudget}. No amount of extra budget brings this subtree
    // back, so marking it would only cost a redistribution round.
    const marker = "[elided: nesting deeper than the persisted-JSON depth limit]";
    budget.left -= jsonCost(marker);
    // REPORTED EVEN THOUGH IT IS NOT A BUDGET CLIP. `clipped` says "more budget would keep more"
    // and this one is false for it; the truncation report answers a different question — "is what
    // the reader sees the whole of what the executor said" — and here it is not. Counted in the
    // unit of whatever was replaced, so a reader is told 40 entries and not "a subtree".
    if (Array.isArray(value)) budget.loss.entries += value.length;
    else budget.loss.fields += Object.keys(value as Record<string, unknown>).length;
    return marker;
  }

  if (Array.isArray(value)) {
    // A LIST THAT FITS WHOLE IS NOT CHARGED FOR A MARKER IT CANNOT NEED — HIGH, M23.0 verification
    // pass 12, and the half of the tail reserve its own author flagged as unreviewed ("an array
    // whose reserve is released on one path and not the other").
    //
    // The reserve below is real money taken out of what the ELEMENTS may spend, and pass 11 took it
    // unconditionally. So a list whose every entry fits was cut anyway, and the marker it stored is
    // WIDER than the entries it replaced. Measured, `{a: ["a"]}` — eleven rendered characters:
    //
    //     budget 107..133   stored {"a":["[elided: 1 more entries]"]}   <- 26 characters of
    //                       apology for one character of content, on a list that fits
    //
    // and the same at every scale: `{a: [40 short entries]}` (237 characters) needed 361, not 333.
    // Asking first costs one bounded pass over the elements — the same order as walking them, and
    // it stops the moment the answer is "no" — and it makes the law uniform: a value of L rendered
    // characters comes back BYTE-IDENTICAL at every budget of L + PERSISTED_JSON_MIN_LEAF or more,
    // for arrays exactly as for scalars and objects. Pinned as
    // `persisted-json-bound.test.ts` -> "L + 96 IS THE WHOLE LAW".
    const room = budget.left;
    const wholeCost = renderedCostAtMost(value, room, depth);
    budget.left -= 2;
    // THE TAIL MARKER IS PAID FOR BEFORE THE ELEMENTS ARE OFFERED ANYTHING — see
    // {@link PERSISTED_JSON_TAIL_RESERVE}. Held back for the whole element loop and handed back
    // either to the marker or, if the list ran to the end, to the parent.
    const tailReserve =
      wholeCost <= room ? 0 : Math.min(Math.max(0, budget.left), tailMarkerCost(value.length));
    budget.left -= tailReserve;
    const out: unknown[] = [];
    for (let i = 0; i < value.length; i++) {
      // WHAT THIS ELEMENT NEEDS, NOT A FLAT 96 — see {@link renderedCostAtMost}. An element that
      // fits WHOLE is admitted for what it costs, so a list of short entries is not cut with
      // ninety-six characters still unspent; an element too big to price is admitted on exactly the
      // old terms. The comma is part of the price here, which the flat guard never charged for.
      const need = (i > 0 ? 1 : 0) + admissionCost(value[i], depth + 1);
      if (budget.left < need) {
        // Spend-in-order and truncate the TAIL — see {@link PERSISTED_JSON_SHARE_ROUNDS} for why
        // an array is not fair-shared. The marker is recognisable (`isPersistedJsonEntriesElision`)
        // so a reader looking for a specific entry can tell a cut from an absence.
        budget.left += tailReserve;
        const marker = entriesElisionMarker(value.length - i);
        budget.left -= jsonCost(marker) + 1;
        out.push(marker);
        budget.clipped = true;
        // THE SAME NUMBER THE MARKER CARRIES. A reader that has the marker and a reader that has
        // the report must not be told two different things about one cut.
        budget.loss.entries += value.length - i;
        return out;
      }
      if (i > 0) budget.left -= 1;
      out.push(walk(value[i], budget, depth + 1));
    }
    budget.left += tailReserve; // no cut: the reserve was never needed
    return out;
  }

  // AN OBJECT THAT FITS WHOLE IS NOT CHARGED FOR AN ELISION ENTRY IT CANNOT NEED — the array's
  // question, asked one branch over, where pass 11 did not sweep. See {@link fieldsElisionCost}
  // for the measurement and for why an object's overspend compounds where an array's adds.
  const objectRoom = budget.left;
  const objectWholeCost = renderedCostAtMost(value, objectRoom, depth);
  budget.left -= 2;
  // EVERY FIELD AGAINST AN EQUAL SHARE, AND WHAT THE SATISFIED ONES DO NOT WANT RE-OFFERED TO THE
  // REST. With a single budget spent in insertion order, the first large field took the row and
  // every later key became `__scpElided` — so which leaf a gate could read was decided by
  // source-line order in whatever function composed the value. With a share that was only a
  // CEILING, half the budget was thrown away instead. With a share computed from the budget
  // REMAINING mid-loop, how much of each field survived still varied with order. See
  // {@link PERSISTED_JSON_SHARE_ROUNDS}.
  return walkObjectFields(
    Object.entries(value as Record<string, unknown>),
    budget,
    depth,
    objectWholeCost <= objectRoom
  );
}

/**
 * BOUND A WHOLE PLUGIN-SUPPLIED VALUE FOR PERSISTENCE. Every string inside it comes back through
 * the same both-ends bound `boundDetail` applies (so it is persistable — see
 * {@link boundDetail} for what Postgres actually refuses), and the RENDERED size of the whole is at
 * most `maxChars`.
 *
 * THE GUARANTEE IS CHECKED, NOT ARGUED. The walk's accounting is exact, but "exact" is a claim
 * about code that will be edited; so the rendered result is measured before returning and, if it
 * somehow does not fit, a small diagnostic object is returned in its place. The fallback losing the
 * payload is strictly better than the alternative — the row is what a coordination loop stalls on,
 * and a stall is invisible.
 *
 * AND THE FALLBACK IS CHECKED TOO — M23.0 verification pass 9. It used to be returned unmeasured,
 * which broke the guarantee in the one direction nobody looks: at `maxChars = 0` the diagnostic
 * itself rendered to 140 characters. Latent (`boundPluginJson` always passes 8 000), but "checked,
 * not argued" is the whole point of this function, and an unmeasured escape hatch out of a measured
 * check is the shape of the next defect. Each candidate below is measured, shortest last.
 *
 * THE ONE PRECONDITION, STATED RATHER THAN ASSUMED: `maxChars >= 4`. `null` is the shortest thing
 * `JSON.stringify` can produce, so no value at all satisfies a budget under four characters and the
 * function returns `null` regardless. Callers pass a column bound; a column that cannot hold `null`
 * does not exist.
 *
 * WHERE IT BELONGS: at the STORE, not at the composition sites. The write function is the one place
 * that sees every value that becomes a row, including the ones a future field adds, and it cannot
 * be forgotten the way a call at a composition site can. See `wave-targets-repo.ts`.
 *
 * AND IT RETURNS WHAT IT REMOVED — M23.1g. Not a courtesy: a bound that shortens a value and says
 * nothing hands every reader downstream a value that is indistinguishable from an honest one, and
 * the reader then reports a cause that is false. See {@link PersistedJsonFieldTruncation} for the
 * defect, the three ways a reader could have been told, and why this is the only one that works.
 * The pair is the whole return value precisely so the two cannot be separated by accident.
 */
export function boundPersistedJson(
  value: unknown,
  maxChars: number = PERSISTED_JSON_MAX_CHARS
): BoundedPersistedJson {
  if (value === null || value === undefined) return { value };
  const fields = new Map<string, PersistedJsonFieldTruncation>();
  const budget: WalkBudget = {
    left: Math.max(0, maxChars) - PERSISTED_JSON_MIN_LEAF,
    loss: emptyLoss(),
    fields
  };
  const bounded = walk(value, budget, 0);
  const rendered = JSON.stringify(bounded);
  if (rendered === undefined || rendered.length <= maxChars) {
    return { value: bounded, truncation: truncationReport(fields, budget.loss) };
  }
  const fallbacks = [
    {
      [PERSISTED_JSON_ELIDED_KEY]: boundDetail(
        `a plugin-supplied value rendered to ${rendered.length} characters after bounding, over the ${maxChars}-character budget, and was not stored verbatim`
      )
    },
    { [PERSISTED_JSON_ELIDED_KEY]: true },
    null
  ];
  for (const fallback of fallbacks) {
    const fallbackRendered = JSON.stringify(fallback);
    if (fallbackRendered !== undefined && fallbackRendered.length <= maxChars) {
      return { value: fallback, truncation: wholesaleTruncation(value) };
    }
  }
  return { value: null, truncation: wholesaleTruncation(value) };
}

/** THE BACKSTOP'S OWN REPORT. See docs/runner-launcher/index.md §25. */
function wholesaleTruncation(input: unknown): PersistedJsonTruncation {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { "": { dropped: true } };
  }
  const entries: [string, PersistedJsonFieldTruncation][] = Object.entries(
    input as Record<string, unknown>
  )
    .filter(([, fieldValue]) => fieldValue !== undefined)
    .map(([key]) => [boundText(key, PERSISTED_JSON_MAX_KEY_CHARS, 0), { dropped: true }]);
  return entries.length === 0 ? { "": { dropped: true } } : boundTruncationReport(entries);
}

/**
 * Turn the walk's accounting into the report, or `undefined` when there is nothing to report.
 *
 * `rootLoss` is the fallback for a value whose root is not an object — a bare over-long string, an
 * array of image refs handed in directly. {@link walkObjectFields} is the only thing that fills
 * `fields`, so without this clause the ONE shape that has no field names would report nothing at
 * all while losing content, which is precisely the silence M23.1g exists to end.
 */
function truncationReport(
  fields: Map<string, PersistedJsonFieldTruncation>,
  rootLoss: WalkLoss
): PersistedJsonTruncation | undefined {
  if (fields.size > 0) return boundTruncationReport([...fields.entries()]);
  if (isLossy(rootLoss)) return { "": truncationOf(rootLoss, false) };
  return undefined;
}

/** MEASURED, NOT ARGUED. See docs/runner-launcher/index.md §26. */
function boundTruncationReport(
  all: [string, PersistedJsonFieldTruncation][]
): PersistedJsonTruncation {
  const out: PersistedJsonTruncation = {};
  // A KEY THAT IS NOT SAFE TO WRITE AS A COMPUTED PROPERTY NEVER ENTERS THE REPORT'S KEY SPACE —
  // see {@link isUnsafePersistedKey}. `out[key] = entry` below is the same call to the same setter
  // the walk's own write loop was making, so the report needs its own guard rather than trusting a
  // filter one function away; and the report is the one place a refused `__proto__` would be named
  // OUT LOUD in a record we serialise, which would put the gadget back in the very field that
  // exists to explain its absence. Such a field is counted in the elision bucket, which already
  // means exactly this: fields were removed and their names are not recoverable.
  const named = all.filter(([key]) => !isUnsafePersistedKey(key));
  let unnamed = all.length - named.length;
  // The widest the elision entry can be: the count only shrinks as entries are kept, so the reserve
  // is exact before the real count is known — the same idiom as {@link tailMarkerCost}.
  const reserve =
    1 +
    jsonCost(PERSISTED_JSON_ELIDED_KEY) +
    1 +
    JSON.stringify({ dropped: true, droppedFields: all.length }).length;
  let cost = 2;
  for (let i = 0; i < named.length; i++) {
    const [key, entry] = named[i]!;
    const price = (i > 0 ? 1 : 0) + jsonCost(key) + 1 + JSON.stringify(entry).length;
    if (cost + price > PERSISTED_JSON_TRUNCATION_MAX_CHARS - reserve) {
      unnamed += named.length - i;
      break;
    }
    out[key] = entry;
    cost += price;
  }
  if (unnamed > 0) out[PERSISTED_JSON_ELIDED_KEY] = { dropped: true, droppedFields: unnamed };
  return out;
}

/** HOW MANY RUN OUTCOMES A PLUGIN'S CACHE MAY HOLD. See docs/runner-launcher/index.md §27. */
export const RUN_OUTCOME_CACHE_MAX_DURABLE = 200;

/** See {@link RUN_OUTCOME_CACHE_MAX_DURABLE}. In-memory caches pay O(1) per lookup rather than
 *  re-parsing, and are lost on restart anyway, so they can afford far more history. */
export const RUN_OUTCOME_CACHE_MAX_IN_MEMORY = 1_000;

/**
 * Drop the OLDEST entries of an insertion-ordered outcome cache until at most `max` remain. Returns
 * how many went, so a caller can log a prune rather than have history vanish silently.
 *
 * ORDER: a `Map` iterates in insertion order by specification, and deleting an entry the iterator
 * has already visited is explicitly safe. This is the in-memory form; {@link pruneOutcomeRecord} is
 * the JSON-object form the durable ledger needs.
 */
export function pruneOutcomeMap<V>(store: Map<string, V>, max: number): number {
  if (max < 0 || store.size <= max) return 0;
  const target = store.size - max;
  let dropped = 0;
  for (const key of store.keys()) {
    if (dropped >= target) break;
    store.delete(key);
    dropped++;
  }
  return dropped;
}

/**
 * The same rule for a plain object — the shape a durable JSON ledger round-trips through.
 *
 * THE ORDERING CAVEAT, STATED RATHER THAN ASSUMED. `Object.keys` returns INTEGER-LIKE keys first, in
 * ascending numeric order, and only then string keys in insertion order. Every key these caches use
 * is an `idempotencyKey` (a UUID) or a `randomUUID()`, none of which is integer-like, so insertion
 * order holds. If that ever stopped being true the COUNT would still be bounded — which is the
 * property that matters here — and only the choice of which entry to drop would degrade.
 */
export function pruneOutcomeRecord<V>(store: Record<string, V>, max: number): number {
  const keys = Object.keys(store);
  if (max < 0 || keys.length <= max) return 0;
  const doomed = keys.slice(0, keys.length - max);
  for (const key of doomed) delete store[key];
  return doomed.length;
}

/** The classified failure a caller records. See {@link classifyRunnerFailure}. */
export interface RunnerFailure {
  readonly kind: RunnerFailureKind;
  /**
   * ONE REDACTED LINE, NEVER EMPTY AND NEVER UNBOUNDED — the string a plugin puts in its outcome
   * store and `status()` hands to `reconcile.ts`. Never-empty is the property, not a nicety: the
   * whole defect this fixed first was that `""` was the recorded reason for the two shapes that most
   * need explaining. NEVER-UNBOUNDED is the second half of the same property and was missing for a
   * release: see {@link RUNNER_DETAIL_MAX_CHARS}. The type is {@link BoundedDetail} so a consumer
   * cannot be handed a megabyte, and — the point — so no consumer has any reason to slice it.
   */
  readonly detail: BoundedDetail;
  /** Which step failed, so the detail is not the only place the answer lives. */
  readonly step: RunnerLaunchStep;
  /** Node's own `code`, carried across so a caller can branch without re-parsing `detail`. */
  readonly code: string | number | null | undefined;
  readonly signal: string | null | undefined;
  /**
   * {@link RunnerLaunchError.deadlineExceeded} — WHICH BOUND ENDED THE RUN, which is not the same
   * question as `kind`. Kept as its own field because it is the one fact a caller is most likely to
   * want as a boolean.
   *
   * THIS DOC USED TO SAY "i.e. `kind === 'budget-exhausted'`" AND THAT EQUIVALENCE IS GONE (M23.5
   * verification pass 18). `outcome-unknown` is normally reached AT the whole-run deadline and
   * carries `deadlineExceeded: true`, because the budget really did run out; what it declines to say
   * is what became of the runner. A caller deciding whether it is safe to re-run must branch on
   * `kind`, never on this boolean — `true` covers both "we stopped it, so it is stopped" and "we
   * stopped LOOKING, and it may still have finished".
   */
  readonly deadlineExceeded: boolean;
}

/** Human wording per kind. Separate from the enum so the machine-readable name never has to be a
 *  sentence and the sentence never has to be stable. */
const FAILURE_WORDING: Record<RunnerFailureKind, string> = {
  "budget-exhausted": "the whole-run budget ran out and the runner was stopped mid-flight",
  "output-exceeded": "the runner printed more than maxBuffer allows, so its output is TRUNCATED",
  signalled: "the runner was killed by a signal that was not this run's own budget",
  "spawn-failed": "the container CLI could not be executed at all — nothing ran",
  "exit-nonzero": "the runner itself exited non-zero",
  // THE ONE SENTENCE HERE THAT CLAIMS NOTHING ABOUT THE RUNNER, which is its entire job. It is
  // phrased as an INSTRUCTION as well as a statement because the safe next step is the opposite of
  // the one every other kind implies: the other five all end "…so re-run it".
  "outcome-unknown":
    "the launcher never learned what became of the runner — whether it ran, and whether anything " +
    "was mutated, is NOT KNOWN; check the target's real state before re-running"
};

/**
 * TURN A {@link RunnerLaunchError} INTO SOMETHING AN OPERATOR CAN ACT ON — MEDIUM (verification
 * pass 5), and the fix is for the CLASS, not for one flag.
 *
 * WHAT WAS WRONG. `run()`'s `start` catch kept `e.stdout`/`e.stderr` and threw the rest away — the
 * replaced message, `code`, `killed`, `signal` and `deadlineExceeded` all of it. Because
 * `promisify(execFile)` always attaches `stderr` as a string, {@link RunnerLaunchError}'s
 * `?? message` fallback never fires, so a budget-kill with no output and a silent non-zero exit were
 * BYTE-IDENTICAL at the port and reached the durable ledger as `detail: ""`. `index.ts` said "THE
 * MESSAGE IS REPLACED, THE DIAGNOSIS IS NOT" about the thrown path; on the captured one the message
 * was replaced and then dropped.
 *
 * THE ORDER OF THE TESTS IS LOAD-BEARING and every step of it is a measured Node shape (the table in
 * `docker-adapter.test.ts`, which spawns real children to keep itself honest):
 *   0. {@link RUNNER_OUTCOME_UNKNOWN_CODE} BEFORE ANYTHING (M23.5 verification pass 18). A producer
 *      that has declared it does not know what became of the runner must not have that declaration
 *      overwritten by a test that infers one: `deadlineExceeded` would call it `budget-exhausted`
 *      ("stopped mid-flight") and the errno test would call it `spawn-failed` ("nothing ran"), and
 *      those are the two opposite claims it exists to refuse.
 *   0b. {@link RUNNER_NEVER_STARTED_CODE} NEXT, and it is the SAME RULE as step 0 rather than a
 *      second special case (M23.5 verification pass 20): a producer that has declared what became of
 *      the runner outranks a test that infers it. This step is what lets the Kubernetes verdict
 *      report `deadlineExceeded` HONESTLY — before it, the only thing keeping "the budget was
 *      already spent when this run reached `start`" out of `budget-exhausted` was that same verdict
 *      forcing the boolean to `false`, so the durable record said the budget ran out in words and
 *      denied it in the field beside them.
 *   1. `deadlineExceeded` next, because a budget kill also sets `killed: true` and would otherwise
 *      read as `signalled` — and it is the distinction with the largest consequence.
 *   2. maxBuffer BEFORE the errno test, because its `code` IS a string
 *      (`ERR_CHILD_PROCESS_STDIO_MAXBUFFER`) and `typeof code === "string"` would otherwise call a
 *      TRUNCATED-output run a spawn failure — the opposite diagnosis, since the runner ran fine.
 *   3. `killed` BEFORE the errno test, because a signalled child's `code` is `null`.
 *   4. A STRING `code` is an errno (the CLI could not be run); anything else — a number, or `null`
 *      with no kill — is the runner's own exit status.
 *
 * ONE ORDERING HERE IS DEFENSIVE RATHER THAN LOAD-BEARING TODAY, AND IT IS SAID PLAINLY because a
 * reader who takes it for live code will look for the test that kills it. Swapping steps 2 and 3 —
 * testing `killed` before maxBuffer — reddens NOTHING against the shape the running Node actually
 * produces, MEASURED: that RangeError carries no `killed` property at all (pinned by
 * `docker-adapter.test.ts`'s NODE_FAILURE_SHAPES, which spawns a real child to keep itself honest),
 * so it reaches the maxBuffer test either way. The order is kept because Node DOES kill the child on
 * a maxBuffer overflow and adding `killed: true` to that rejection would be an unremarkable change
 * on Node's side — after which the swapped order silently reclassifies a run whose evidence is
 * TRUNCATED as a plain signal. `A maxBuffer OVERFLOW THAT ALSO REPORTS killed` below is the arm that
 * makes the order matter; it is explicitly a FORWARD guard against a shape today's Node does not
 * emit, not a recording of one that it does.
 *
 * THE DETAIL CARRIES `err.message` VERBATIM rather than re-deriving one. That message is already
 * redacted, already names the step and the argv, and on the budget path is already the REPLACEMENT
 * text naming the budget and the deadline — re-deriving it here is how the two drift. What is added
 * is exactly what the message cannot say: the kind, `code`/`signal` (Node's `Command failed:` text
 * omits the exit status), and an explicit marker when the child printed nothing at all, so "no
 * output" is a recorded fact rather than an absence a reader has to interpret.
 *
 * AND THE CHILD'S OWN LAST WORDS ARE APPENDED WHEN THE MESSAGE DOES NOT ALREADY CARRY THEM, which is
 * the part that must not be left to luck. Today's Node formats a non-zero exit as
 * `Command failed: <cmd>\n<stderr>`, so for that ONE shape the message happens to contain the
 * runner's own error — and nothing pins that. `docker-adapter.test.ts`'s live-Node check compares
 * `code`/`killed`/`signal` and the TYPES of `stdout`/`stderr`; it says nothing about the message's
 * wording, and the whole subject of this fix is a diagnosis that survived only by accident. So the
 * output is appended explicitly, skipped only when it is provably already present.
 *
 * THE TAIL, NOT THE WHOLE THING, AND THE WHOLE `detail` IS BUDGETED AROUND IT (MEDIUM, M23.0
 * verification pass 7 — the correction of a claim this doc used to make falsely). `maxBuffer` is up
 * to 32 MiB and the useful end of a `tofu apply` or a Trivy failure is the LAST lines, so the tail
 * is what is carried. THE CLAIM THAT WAS FALSE was the next clause: it said a front-slice "would
 * discard" those lines, while the code placed the capped tail AFTER an UNCAPPED `err.message` — and
 * Node's message for a non-zero exit is `Command failed: <cmd>\n<the ENTIRE stderr>`. So the
 * front-slice every consumer then applied discarded the tail instead, at every output size for
 * managed-scan and managed-dep and above ~1.8 KB for managed-iac. The mechanism was inert in exactly
 * the case its own doc named as its reason to exist.
 *
 * SO THE ORDER IS THE FIX, AND IT IS ONE MECHANISM RATHER THAN TWO. The composition still puts
 * `err.message` in whole — nothing is re-derived, which is what kept the budget-kill path's
 * REPLACEMENT text intact — but the child's last words now come AFTER it and the whole string is
 * closed by {@link boundDetail}, which keeps the last {@link RUNNER_DETAIL_TAIL_CHARS} characters
 * and elides the MIDDLE. So the reader gets the classification and the argv at the front, the
 * diagnosis at the back, and the noise the tool printed on its way there is what goes.
 *
 * THE APPENDED REGION IS SIZED TO THE RESERVE EXACTLY — tail plus its longest introducer is
 * {@link RUNNER_DETAIL_TAIL_CHARS} — so a CALLER that prefixes its own text and bounds again cannot
 * push the diagnosis out either. That is arithmetic, not luck, and `failure-detail-bound.test.ts`
 * pins it.
 *
 * WHY NOT ALSO PRE-ELIDE THE MESSAGE against a computed budget: the first draft did, and a mutation
 * run showed the two mechanisms covered each other — EITHER could be deleted with all 17 tests still
 * green, which is the definition of a mechanism nothing pins. Simplicity (charter priority 1) picks
 * the single bound. The `includes` search is still skipped above the tail cap, because a substring
 * search over 32 MiB to save an append is the wrong trade.
 */
/**
 * The longer of the two introducers, and its LENGTH IS LOAD-BEARING rather than decorative: the
 * appended output is sized so that introducer + tail is exactly {@link RUNNER_DETAIL_TAIL_CHARS},
 * the span {@link boundDetail} keeps at the end. That is what makes "the marker and the whole tail
 * both survive a caller's own prefix" arithmetic instead of luck. Pinned by
 * `failure-detail-bound.test.ts`.
 */
const OUTPUT_TAIL_MARKER = " :: runner output (tail): ";

/** How much of the child's own output {@link classifyRunnerFailure} appends. See its doc. */
const FAILURE_OUTPUT_TAIL_CHARS = RUNNER_DETAIL_TAIL_CHARS - OUTPUT_TAIL_MARKER.length;
export function classifyRunnerFailure(err: RunnerLaunchError): RunnerFailure {
  const kind: RunnerFailureKind =
    err.code === RUNNER_OUTCOME_UNKNOWN_CODE
      ? // FIRST, AND BEFORE `deadlineExceeded` — see {@link RUNNER_OUTCOME_UNKNOWN_CODE}. The runs
        // this describes normally end AT the whole-run deadline, so every later test would reach
        // `budget-exhausted` and re-assert the very claim ("stopped mid-flight") the producer has
        // just declared it cannot make. It is also before the errno test, which would otherwise call
        // a STRING code `spawn-failed` — the opposite lie, and the one measured in the field.
        "outcome-unknown"
      : err.code === RUNNER_NEVER_STARTED_CODE
        ? // SECOND, AND FOR THE SAME REASON — see {@link RUNNER_NEVER_STARTED_CODE}. A producer that
          // has declared NOTHING RAN normally ends at the deadline too, so `budget-exhausted` was
          // one test away from asserting "SIGTERMed mid-flight" about a container that never
          // existed. It used to be kept out of that branch by the PRODUCER forcing
          // `deadlineExceeded: false`, which made the record's own boolean contradict its own
          // sentence; the ordering does it here instead, once, for every producer.
          "spawn-failed"
        : err.deadlineExceeded
          ? "budget-exhausted"
          : err.code === RUNNER_MAXBUFFER_CODE
            ? "output-exceeded"
            : err.killed === true
              ? "signalled"
              : typeof err.code === "string"
                ? "spawn-failed"
                : "exit-nonzero";

  const facts = [`code=${err.code === undefined ? "undefined" : String(err.code)}`];
  if (err.signal) facts.push(`signal=${err.signal}`);
  if (err.killed === true) facts.push("killed");

  const head = `${kind}: ${FAILURE_WORDING[kind]} during '${err.step}' (${facts.join(", ")}) — `;

  // stderr when there is any, else stdout: a runner that explains itself on stdout (managed-dep's
  // does) must not be recorded as silent just because it kept stderr clean.
  const output = err.stderr.length > 0 ? err.stderr : err.stdout;
  let suffix: string;
  if (output.length === 0) {
    suffix = " [the runner printed nothing on stdout or stderr]";
  } else if (output.length <= FAILURE_OUTPUT_TAIL_CHARS && err.message.includes(output)) {
    suffix = ""; // already in the message (Node's `Command failed:` format) — do not say it twice
  } else {
    const tail = output.slice(-FAILURE_OUTPUT_TAIL_CHARS);
    suffix =
      tail.length < output.length ? `${OUTPUT_TAIL_MARKER}${tail}` : ` :: runner output: ${tail}`;
  }

  return {
    kind,
    step: err.step,
    code: err.code,
    signal: err.signal,
    deadlineExceeded: err.deadlineExceeded,
    // THE TAIL IS LAST AND THE BOUND KEEPS THE LAST RUNNER_DETAIL_TAIL_CHARS, which is the whole
    // inversion: the old code let an unbounded `err.message` sit between the reader and the
    // diagnosis. ONE mechanism, not two — an earlier draft also pre-elided the message against a
    // computed budget, and a mutation run showed the two covered each other, so either could be
    // deleted with 17 tests still green. Simplicity (charter priority 1) picks the one that is
    // visible to a mutation: delete `boundDetail` here and this stops being bounded at all.
    detail: boundDetail(`${head}${err.message}${suffix}`)
  };
}

/**
 * THE ONE STRING A CALLER RECORDS FOR A RUN, whatever became of it — success or any of the six
 * failure kinds. Exported because all three plugins need the same answer and each of them used to
 * spell it `result.succeeded ? result.stdout : result.stderr`, which is precisely the expression
 * that produced `""`.
 *
 * On SUCCESS this is the runner's own stdout — the evidence (`tofu plan` output, a scan summary) the
 * previous behaviour correctly recorded — BOUNDED, which it was not.
 *
 * THE SUCCESS ARM WAS THE WORSE HALF OF THE UNBOUNDED-LEDGER DEFECT and the measurement that found
 * the failure arm did not reach it. managed-iac records this string into `saveState`, a durable JSON
 * file keyed by `idempotencyKey` that is never pruned, and only `status()` sliced it — on READ, at
 * 4000. A `tofu plan` over a large estate can print megabytes within the 16 MiB `maxBuffer`, so a
 * successful apply wrote megabytes to disk per key, forever, to serve 4000 characters. Bounding here
 * rather than at the three call sites is the whole point of the fix: {@link boundDetail} keeps the
 * END, which for a plan is `Plan: 3 to add, 0 to change, 1 to destroy` — the line a front-slice at
 * either 2000 or 4000 was the first thing to lose.
 */
export function runnerOutcomeDetail(result: RunnerResult): BoundedDetail {
  return result.succeeded ? boundDetail(result.stdout) : result.failure.detail;
}

// THE ONE FAILURE A TEARDOWN MUST NEVER ANSWER — a `create` that lost the NAME to somebody else.

/**
 * Does this `create` rejection mean THE NAME WAS ALREADY TAKEN?
 *
 * WHY IT HAS TO BE ASKED AT ALL. {@link runnerContainerName} named the hazard when it landed and
 * left it open: teardown is unconditional and addresses the NAME, so a `create` that failed
 * BECAUSE THE NAME IS IN USE goes on to `rm -f` that name — which by the definition of the
 * conflict is a container this run did not create and is not supervising. For managed-iac that is
 * two concurrent triggers of one `idempotencyKey`, and the loser destroys the winner's live
 * `tofu apply`. It is the same family as the reaper's own cardinal rule: never destroy a container
 * you do not own.
 *
 * WHY NOT "GIVE EACH ATTEMPT A UNIQUE NAME". That would trade this bug for a worse one. Retry-stable
 * naming is exactly what makes a retry address the SAME container instead of starting a second run
 * of the same apply, and it is what lets the Kubernetes arm (M23.2) rely on `create` being
 * idempotent on `metadata.name`. The name is the feature; the unconditional teardown was the bug.
 *
 * MEASURED, NOT GUESSED (Docker 29.5.2, via `promisify(execFile)`): a second
 * `docker create --name X` rejects with `code: 1`, `killed: false`, and
 * `stderr: 'Error response from daemon: Conflict. The container name "/X" is already in use by
 * container "<id>". You have to remove (or rename) that container to be able to reuse that name.'`
 * The `Conflict.` token is Docker's own; `already in use by container` is the part every
 * OCI CLI in this class shares, and `dockerBinary` is server-injected precisely so an operator MAY
 * point it at podman or nerdctl (whose wording differs and is NOT measured here). The match is
 * therefore the broad one, and DELIBERATELY so: the two ways to be wrong are not symmetric. A false
 * POSITIVE skips one teardown and leaves a container that `reap()` collects on its deadline; a
 * false NEGATIVE `rm -f`s live infrastructure somebody else is running.
 */
export function isContainerNameConflict(err: unknown): boolean {
  const e = (err ?? {}) as { stderr?: unknown; message?: unknown };
  const text = `${typeof e.stderr === "string" ? e.stderr : ""}\n${
    typeof e.message === "string" ? e.message : ""
  }`;
  return /already in use/i.test(text);
}

/**
 * Every `--env-file` this package ever writes carries this prefix and nothing else does — it is
 * what lets {@link RunnerLauncher.reap}'s sweep (MEDIUM-4) recognise its own leftovers in a
 * directory it does not otherwise own without touching a single byte it did not create.
 */
const SECRET_ENV_FILE_PREFIX = "scp-secret-env-";

/** The transient `--env-file`. See docs/runner-launcher/index.md §28. */
async function writeSecretEnvFile(
  dir: string,
  runId: string,
  entries: readonly string[]
): Promise<string> {
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${SECRET_ENV_FILE_PREFIX}${runId}-${randomUUID()}`);
  await writeFile(path, `${entries.join("\n")}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  return path;
}

/**
 * The teardown call's own timeout, and it is NOT the run timeout — a tenant `timeoutMs` never
 * reaches `rm`. It also carries NO `maxBuffer`; both absences are pinned by all three goldens.
 *
 * IT IS THE UNIT THE TEARDOWN MODEL IS BUILT FROM, NOT THE WHOLE OF IT (M23.5). This doc used to
 * call it "the ONLY work that happens after the whole-run deadline" and to state the bound as
 * `run()` returns within `timeoutMs + RUNNER_REMOVE_TIMEOUT_MS`. That was a sentence about the
 * DOCKER adapter's one-call `finally`, written when there was one adapter. The Kubernetes adapter's
 * teardown is THREE bounded calls, so what an outer budget must carry is their SUM — see
 * {@link runnerPostDeadlineCallsMs} and {@link runnerRunBoundMs}, which DERIVE it from
 * {@link RUNNER_POST_DEADLINE_CALLS} instead of restating a number in a comment nothing can check.
 */
export const RUNNER_REMOVE_TIMEOUT_MS = 30_000;

// THE PORT'S OWN DEADLINE — M23.5. THE ENFORCEMENT IS HERE, NOT IN WHOEVER IMPLEMENTS THE ADAPTER.

/**
 * WHY THIS SECTION EXISTS, stated as the measurement rather than as a principle.
 *
 * {@link clampRunTimeoutMs}'s own doc already argued the shape: the clamp runs INSIDE `run()` "so a
 * caller cannot skip it and a SECOND ADAPTER CANNOT FORGET IT". That reasoning was applied to the
 * clamp and to nothing else. The per-step deadline stayed hand-rolled in each adapter — three copies
 * of `remaining = deadline - now; refuse if spent; pass what is left down` — and the second adapter
 * promptly forgot one of the three.
 *
 * MEASURED, against `dist`, on `KubernetesRunnerIo`: `timeoutMs` is a field of
 * `KubernetesApiRequest` and of NOTHING else. `copyDir` and `removeDir` carried no deadline at all,
 * and `createFetchKubernetesIo` implemented them as a bare `cp`/`rm`. The adapter's `copy()` checked
 * the remaining budget BEFORE the call and then awaited it forever:
 *
 *     after 15003ms with timeoutMs=3000: STILL RUNNING
 *     requests issued: ["GET …/jobs timeoutMs=30000", "POST …/jobs timeoutMs=2999"]
 *
 * and the volume is BY CONSTRUCTION a network filesystem — the chart names NFS, CephFS, EFS and
 * Azure Files — which is the kind that hangs rather than errors. The chain from there is M23.1c
 * verbatim: `run()` never returns, the host SIGKILLs the subprocess, `withRecordedOutcome` never
 * writes, managed-iac's ledger entry never lands, `reconcile.ts` retries, and a SECOND `tofu apply`
 * goes at live infrastructure. Worse than M23.1c, in fact: copy-in precedes `start`, so the
 * abandoned Job is still SUSPENDED — it never finishes, `ttlSecondsAfterFinished` never applies, and
 * the per-run credential Secret survives until some later run's `reap()` happens by.
 *
 * THE PROPERTY, NAMED: *the whole-run deadline was enforced by whoever happened to implement the
 * adapter.* The fix is not "give `copyDir` a `timeoutMs` too" — that is the same property with one
 * more instance patched, and a third adapter forgets it again. A field on an interface obliges the
 * CALLER to supply a number; nothing whatsoever obliges the IMPLEMENTATION to honour it. So the
 * enforcement is hoisted to the port: {@link withStepBound} is the only way any adapter in this
 * package awaits anything, and it gives up on work that did not honour the bound it was handed.
 */

/**
 * HOW LONG PAST A STEP'S OWN STATED BOUND THE LAUNCHER WAITS BEFORE ABANDONING IT.
 *
 * IT IS NOT PADDING, AND IT MAY NOT BE ZERO. The mechanisms that DO honour a bound —
 * `execFile`'s `timeout`, `AbortSignal.timeout` — express it as a timer of their own, and a timer of
 * ours set for the same instant would win the race essentially always: `execFile` fires its timer,
 * SIGTERMs the child, and rejects only after the child actually exits. Abandoning at the same
 * instant would therefore convert every ordinary budget kill into an abandonment, throwing away the
 * `code`/`signal`/partial-stdout diagnosis that {@link classifyRunnerFailure} exists to preserve —
 * a regression in operator-facing detail bought by a mechanism aimed at a different failure.
 *
 * So the inner mechanism gets first refusal, by this margin, and abandonment is what happens ONLY
 * when the inner mechanism did not exist (a bare `cp`) or did not work (a `SIGTERM` a process in
 * uninterruptible disk sleep will never take — the exact NFS/CephFS shape this whole section is
 * about). One second is far longer than any honest self-bounded call needs to settle after its own
 * timer fires and far shorter than anything an operator would notice.
 *
 * AT MOST ONE ABANDONMENT PER RUN, so this is an additive term and not a multiplied one: the first
 * abandonment spends the budget, after which every later step is REFUSED before it is issued.
 */
export const RUNNER_STEP_ABANDON_GRACE_MS = 1_000;

/**
 * THE SMALLEST REMAINING BUDGET A STEP MAY BE ISSUED WITH — and the reason the refusal's old
 * boundary was unreachable exactly where it mattered most.
 *
 * THE REFUSAL USED TO READ `remaining <= 0`, and for the step that FOLLOWS a budget kill that
 * condition is essentially never true. `RunDeadline` measures the deadline with `Date.now()`, while
 * the kill that lands on it is a libuv timer read off a different clock; the two disagree by up to a
 * millisecond. MEASURED, in `whole-run-budget.test.ts` under the full suite's load: a `start` killed
 * by its own derived timeout reported `Date.now()` ONE MILLISECOND BEFORE the deadline that timeout
 * was derived from, so the copy-out behind it saw `remaining === 1` and was ISSUED —
 * `docker cp … { timeout: 1 }`. Three arms of that file failed intermittently on it, 3 runs in 8,
 * a different arm each time, which is the signature of a boundary the process cannot land on rather
 * than of a test that is wrong.
 *
 * AND A 1ms `docker cp` IS NOT A CALL, IT IS A SPAWN AND A SIGTERM. `whole-run-budget.test.ts`'s own
 * comment said so before any of this was measured — "issuing a doomed `docker cp` at the deadline is
 * a call whose only possible outcome is another SIGTERM". Spawning a process costs several
 * milliseconds before the image is even resolved, so a bound below that is a promise to kill the
 * work rather than a budget to do it in: it burns a spawn, produces a `killed`/`SIGTERM` diagnosis
 * about our own impatience rather than about the step, and arrives at the same `deadlineExceeded`
 * verdict the refusal would have given for free.
 *
 * TEN MILLISECONDS: an order of magnitude above the clock disagreement that makes `<= 0`
 * unreachable, below the cost of the cheapest thing any step here does, and 1% of the smallest whole
 * run budget the product will accept (`call-policy.ts` floors a stored timeout at one second). It is
 * NOT padding on the budget — the deadline does not move — it is the point below which "what is
 * left" stops being budget at all.
 */
export const RUNNER_MIN_STEP_BUDGET_MS = 10;

/** `code` on an abandoned step, so a reader can branch without parsing the message. */
export const RUNNER_ABANDONED_CODE = "ERR_SCP_RUNNER_STEP_ABANDONED";

/**
 * WHAT {@link withStepBound} THROWS WHEN THE WORK DID NOT HONOUR ITS BOUND. Never leaves this
 * package: `run()` turns it into a {@link RunnerLaunchError} with `deadlineExceeded`, which is what
 * makes {@link classifyRunnerFailure} call it `budget-exhausted` — the honest answer, since the
 * whole-run budget is precisely what ran out.
 *
 * THE WORK IS ABANDONED, NOT CANCELLED, and the message says so. `fs.cp` and `fs.rm` take no
 * `AbortSignal`; there is no way to stop a copy that is wedged on a network mount. What the launcher
 * can guarantee is that `run()` RETURNS — which is the whole difference between a failed run the
 * ledger records and a SIGKILLed subprocess that retries into a second `tofu apply`.
 */
export class RunnerStepAbandonedError extends Error {
  readonly code = RUNNER_ABANDONED_CODE;
  /** The bound the work was handed and did not honour. */
  readonly boundMs: number;
  constructor(what: string, boundMs: number) {
    super(
      `${what} did not honour its ${boundMs}ms bound and was ABANDONED after a further ` +
        `${RUNNER_STEP_ABANDON_GRACE_MS}ms — the launcher stopped waiting; the underlying I/O may ` +
        `still be in flight`
    );
    this.name = "RunnerStepAbandonedError";
    this.boundMs = boundMs;
  }
}

/**
 * THE ONLY WAY THIS PACKAGE AWAITS ANYTHING THAT LEAVES THE PROCESS — one call, one bound, and a
 * return that is guaranteed whether or not the work cooperates.
 *
 * `work` RECEIVES THE BOUND so that a mechanism which CAN self-limit does (that is strictly better:
 * it cancels rather than abandons, and it keeps its own diagnosis). The race is what makes the bound
 * true for the mechanisms that cannot.
 *
 * THE TIMER IS `unref`'d, DELIBERATELY. An abandonment timer must never be the reason a process
 * stays alive: if nothing else is pending there is no in-flight I/O to abandon. A genuinely wedged
 * `fs.cp` holds a libuv threadpool request, which keeps the loop alive, so the timer fires exactly
 * when it is needed. (A test that models a hang as a promise which simply never settles must
 * therefore hold a handle of its own — `port-deadline.test.ts` does, and says why.)
 *
 * WORK THAT REJECTS AFTER IT WAS ABANDONED IS NOT AN UNHANDLED REJECTION, AND THERE IS NO EXPLICIT
 * GUARD FOR THAT — said plainly, because the obvious guard is exactly what a reader will look for.
 * A rejection nobody is listening to takes a plugin subprocess down, which is the failure this
 * function exists to prevent arriving by the back door, so the property matters. It is already
 * true: `Promise.race` SUBSCRIBES to every promise it is given and keeps that subscription after it
 * has settled, so `pending` is handled from the moment it enters the race, forever. A first draft
 * added `void pending.catch(() => undefined)` in a `finally` for this; mutating it away reddened
 * NOTHING across the whole suite, measured — the definition of a mechanism nothing pins — so
 * Simplicity (charter priority 1) removed it. The PROPERTY is still gated
 * (`port-deadline.test.ts`: "WORK THAT REJECTS AFTER IT WAS ABANDONED IS NOT AN UNHANDLED
 * REJECTION"), which is what a rewrite away from `Promise.race` — an `AbortController` and a
 * `.then`, say — would have to keep true.
 */
export async function withStepBound<T>(args: {
  /** The bound handed to `work`, in ms. Clamped to >= 1: `timeout: 0` is NO timeout in Node. */
  timeoutMs: number;
  /** How the step is named in an abandonment message, e.g. `'copy-in'` or `DELETE job`. */
  what: string;
  work: (timeoutMs: number) => Promise<T>;
}): Promise<T> {
  const bound = Math.max(1, Math.trunc(args.timeoutMs));
  // `async` wrapper so a `work` that throws SYNCHRONOUSLY is a rejection like any other rather than
  // an exception that escapes past the `finally` and leaves the timer armed.
  const pending = (async () => args.work(bound))();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new RunnerStepAbandonedError(args.what, bound)),
          bound + RUNNER_STEP_ABANDON_GRACE_MS
        );
        timer.unref?.();
      })
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * THE ONE CLOCK A RUN IS HELD TO, and the only thing either adapter may spend it through.
 *
 * Created once at the top of `run()` from `clampRunTimeoutMs(spec.timeoutMs)` — the same
 * "inside `run()` so nobody can forget it" placement the clamp already had, now extended to the
 * thing the clamp's own doc claimed for it.
 */
export interface RunDeadline {
  /** `clampRunTimeoutMs(spec.timeoutMs)` — the budget the run is actually held to. */
  readonly runTimeoutMs: number;
  /** Epoch ms. `Date.now() + runTimeoutMs`, read ONCE. */
  readonly at: number;
  remainingMs(): number;
  /** IS THE BUDGET GONE? See docs/runner-launcher/index.md §29. */
  spent(): boolean;
  /** REFUSE, BOUND, OR ABANDON. See docs/runner-launcher/index.md §30. */
  spend<T>(
    step: RunnerLaunchStep,
    argv: readonly string[],
    work: (timeoutMs: number) => Promise<T>
  ): Promise<T>;
}

export function createRunDeadline(args: {
  /** Raw `spec.timeoutMs`; {@link clampRunTimeoutMs} is applied HERE and nowhere else. */
  requestedTimeoutMs: number;
  /** {@link RunnerLaunchError.file} for the refusals this object raises. */
  file: string;
  /** Read late: the Docker adapter's redaction set grows an `--env-file` path mid-run. */
  redactions: () => readonly string[];
}): RunDeadline {
  const runTimeoutMs = clampRunTimeoutMs(args.requestedTimeoutMs);
  const at = Date.now() + runTimeoutMs;
  const iso = new Date(at).toISOString();
  return {
    runTimeoutMs,
    at,
    remainingMs: () => at - Date.now(),
    spent: () => at - Date.now() < RUNNER_MIN_STEP_BUDGET_MS,
    async spend(step, argv, work) {
      const remaining = at - Date.now();
      // BELOW {@link RUNNER_MIN_STEP_BUDGET_MS} IS SPENT, and that is not a rounding convenience —
      // read that constant for why `<= 0` is a boundary this process cannot reliably land on.
      if (remaining < RUNNER_MIN_STEP_BUDGET_MS) {
        throw new RunnerLaunchError({
          step,
          file: args.file,
          argv,
          deadlineExceeded: true,
          cause: new Error(
            `whole-run budget of ${runTimeoutMs}ms (RunnerSpec.timeoutMs) was already spent ` +
              `at the run deadline ${iso} — '${step}' was not issued` +
              (remaining > 0
                ? ` (${remaining}ms left, under the ${RUNNER_MIN_STEP_BUDGET_MS}ms below which a ` +
                  `step is a spawn and a SIGTERM rather than a call)`
                : "")
          ),
          redactions: args.redactions()
        });
      }
      try {
        return await withStepBound({ timeoutMs: remaining, what: `'${step}'`, work });
      } catch (cause) {
        if (cause instanceof RunnerStepAbandonedError) {
          throw new RunnerLaunchError({
            step,
            file: args.file,
            argv,
            deadlineExceeded: true,
            cause: new Error(
              `whole-run budget of ${runTimeoutMs}ms (RunnerSpec.timeoutMs) ran out during ` +
                `'${step}' at the run deadline ${iso} — ${cause.message}`
            ),
            redactions: args.redactions()
          });
        }
        throw cause;
      }
    }
  };
}

// THE TEARDOWN MODEL — M23.5 HIGH-2. What happens after the deadline, per adapter, as a NUMBER.

/** The adapters this package ships. Also the key of every per-adapter quantity below. */
export type RunnerLauncherKind = "docker" | "kubernetes";

/**
 * EVERY BOUNDED CALL AN ADAPTER MAY ISSUE AFTER THE RUN DEADLINE, BY NAME — the model, and the
 * question its first version asked wrongly.
 *
 * THIS NUMBER IS THE MODEL, AND THE MODEL IS WHAT WAS MISSING. `MANAGED_TRIGGER_GRACE_MS` was 60s
 * chosen as "two worst-case teardowns", written when a teardown was one `docker rm -f`. The
 * Kubernetes adapter's teardown is THREE calls — DELETE the Job, DELETE the Secret, remove the
 * workspace subtree — so sixty seconds of bounded work consumed the entire grace and left nothing
 * for the outcome write the grace exists to protect. That is precisely what `call-policy.ts`'s own
 * comment calls "WRONG BY CONSTRUCTION" about the 30s it replaced: the number was gated
 * (`grace > RUNNER_REMOVE_TIMEOUT_MS`, one teardown) and the MODEL was not, so nothing anywhere knew
 * the teardown had grown.
 *
 * AND THEN THE CENSUS THAT BUILT IT ASKED THE WRONG QUESTION. It asked *what does the teardown
 * `finally` issue?* — a right answer to a question one narrower than the property, which is *what
 * bounded call can be issued after the run deadline?* The very same round added one that is not in
 * any teardown `finally`: the secret-env `unlink` in the Docker adapter's `create` `finally`, whose
 * own comment says "BOUNDED LIKE A TEARDOWN, NOT SPENT FROM THE BUDGET … the commonest way to reach
 * it with nothing left is that `create` is what spent the budget". The words were written; the
 * number was not moved. MEASURED, with `secretEnv` set and `create`, `unlink` and `rm -f` all
 * wedged: `run()` returned after 64004ms against a stated bound of 33000ms — exactly one extra
 * {@link RUNNER_BOUNDED_CALL_WORST_CASE_MS}, which lands 1004ms PAST the host's SIGKILL, so
 * `withRecordedOutcome` never writes, managed-iac's ledger entry never lands, `reconcile.ts`
 * retries, and a second `tofu apply` goes at live infrastructure. M23.1c verbatim.
 *
 * SO THE MODEL IS A LIST OF NAMES AND THE COUNT IS DERIVED FROM IT, in both directions:
 *
 *  - FORWARD, at compile time. {@link withPostDeadlineBound} is the only way either adapter issues
 *    one of these, and its `call` parameter is typed as a member of THIS list, so a new
 *    post-deadline call does not compile until it is declared here — and declaring it moves
 *    {@link runnerPostDeadlineCallsMs}, the reap stamp and `MANAGED_TRIGGER_GRACE_MS` together.
 *  - BACKWARD, at test time. `teardown-model.test.ts` drives each adapter to a run whose budget is
 *    ALREADY SPENT and counts every effect issued at or after the deadline, whatever its SHAPE.
 *    That last word is the fix: the old Docker counter filtered `args[0] === "rm"`, so an
 *    `fs.unlink` was structurally invisible to it, and it drove a spec with no `secretEnv`, so the
 *    worst case was unreachable even in principle. The Kubernetes counter beside it passed
 *    `secretEnv` deliberately and said why — the reasoning was applied to one adapter and not the
 *    other.
 *
 * A DECLARED COUNT PINNED BY ONE ASSERTION IS A CONSTANT WITH A COMMENT, NOT A MODEL. Editing the
 * old `RUNNER_TEARDOWN_STEPS.docker` from 1 to 2 reddened exactly one test, because every consumer
 * derived its expected value from the same constant. Nothing here is written twice.
 */
export const RUNNER_POST_DEADLINE_CALLS = {
  /** `unlink` of the staged env-file in `create`'s `finally`, then `docker rm -f <name>`. */
  docker: ["secret-env unlink", "teardown rm -f"],
  kubernetes: ["teardown DELETE job", "teardown DELETE secret", "teardown removeDir"]
} as const satisfies Readonly<Record<RunnerLauncherKind, readonly string[]>>;

/** The names `kind` may hand {@link withPostDeadlineBound} — anything else is a compile error, which
 *  is what makes a new post-deadline call impossible to add without moving the model. */
export type RunnerPostDeadlineCall<K extends RunnerLauncherKind> =
  (typeof RUNNER_POST_DEADLINE_CALLS)[K][number];

/** HOW MANY of them, per adapter. DERIVED from {@link RUNNER_POST_DEADLINE_CALLS} and written down
 *  nowhere — the number and the list cannot disagree because there is only the list. */
export const RUNNER_POST_DEADLINE_CALL_COUNT: Readonly<Record<RunnerLauncherKind, number>> =
  Object.freeze(
    Object.fromEntries(
      Object.entries(RUNNER_POST_DEADLINE_CALLS).map(([kind, calls]) => [kind, calls.length])
    ) as Record<RunnerLauncherKind, number>
  );

/** The worst case of ONE bounded call made outside the run budget: its own timeout, plus the margin
 *  {@link withStepBound} waits before giving up on work that ignored it. */
export const RUNNER_BOUNDED_CALL_WORST_CASE_MS =
  RUNNER_REMOVE_TIMEOUT_MS + RUNNER_STEP_ABANDON_GRACE_MS;

/** The worst-case wall clock of every bounded call `kind` may issue after the run deadline. */
export function runnerPostDeadlineCallsMs(kind: RunnerLauncherKind): number {
  return RUNNER_POST_DEADLINE_CALL_COUNT[kind] * RUNNER_BOUNDED_CALL_WORST_CASE_MS;
}

/**
 * WHAT A SUM OF TIMERS COSTS THAT THE ARITHMETIC DOES NOT SAY.
 *
 * Every term in the bound below is a `setTimeout`, and a `setTimeout` NEVER FIRES EARLY AND ALWAYS
 * FIRES LATE — by however long the event loop takes to come back to it. A bound stated as the exact
 * sum is therefore exceeded by that latency once per timer, every time, on a perfectly healthy
 * process. MEASURED on the four-timer worst case (the abandonment of the step in flight at the
 * deadline, plus both of Docker's post-deadline calls): `run()` returned at 64009ms against an exact
 * sum of 64000ms.
 *
 * NINE MILLISECONDS IS NOT A DEFECT, AND AN UNSTATED SLOP IS. This is a flat allowance of ~100x the
 * measurement rather than a per-timer one because its purpose is not to be tight: it is so that
 * {@link runnerRunBoundMs}'s "THE BOUND `run()` IS HELD TO" is a sentence that is TRUE, instead of
 * one that is true to within a margin every reader has to rediscover by measuring. It is noise
 * against the 30s outcome tail every consumer already carries on top.
 */
export const RUNNER_TIMER_LATENCY_ALLOWANCE_MS = 1_000;

/**
 * EVERYTHING `run()` MAY STILL DO AFTER ITS WHOLE-RUN DEADLINE — one possible abandonment of the
 * step that was in flight when the deadline passed, then every post-deadline call, plus the
 * allowance for the fact that all of those are timers. This is the term every outer budget has to
 * carry on top of {@link RunnerSpec.timeoutMs}.
 */
export function runnerPostDeadlineMs(kind: RunnerLauncherKind): number {
  return (
    RUNNER_STEP_ABANDON_GRACE_MS +
    runnerPostDeadlineCallsMs(kind) +
    RUNNER_TIMER_LATENCY_ALLOWANCE_MS
  );
}

/**
 * THE ONLY WAY EITHER ADAPTER ISSUES A BOUNDED CALL THAT IS NOT SPENT FROM THE RUN BUDGET.
 *
 * NOT A CONVENIENCE WRAPPER — IT IS THE DECLARATION SITE. Every call routed through it names itself
 * from {@link RUNNER_POST_DEADLINE_CALLS}, so the set of things that can happen after the deadline
 * is a list the type checker holds the code to rather than a census someone runs and writes down.
 * The bound is {@link RUNNER_REMOVE_TIMEOUT_MS} for all of them, which is the unit
 * {@link runnerPostDeadlineCallsMs} multiplies; handing the caller a choice of bound would put the
 * arithmetic back where it drifted from.
 */
export async function withPostDeadlineBound<K extends RunnerLauncherKind, T>(args: {
  kind: K;
  /** Which declared call this is. A name not in the list for `kind` does not type-check. */
  call: RunnerPostDeadlineCall<K>;
  /** What it addresses, appended to the abandonment message — a container name, a path. */
  what?: string;
  work: (timeoutMs: number) => Promise<T>;
}): Promise<T> {
  return withStepBound({
    timeoutMs: RUNNER_REMOVE_TIMEOUT_MS,
    what: args.what ? `${args.call} ${args.what}` : args.call,
    work: args.work
  });
}

/**
 * THE BOUND `run()` IS HELD TO on `kind`, for a requested `timeoutMs`. The sentence three documents
 * used to state as `timeoutMs + RUNNER_REMOVE_TIMEOUT_MS`, now computable rather than asserted —
 * and true of the Kubernetes adapter, of which the old sentence was false.
 */
export function runnerRunBoundMs(kind: RunnerLauncherKind, requestedTimeoutMs: number): number {
  return clampRunTimeoutMs(requestedTimeoutMs) + runnerPostDeadlineMs(kind);
}

/**
 * HOW FAR CLEAR OF ITS OWN POST-DEADLINE WORK A RUN STAMPS ITS REAP DEADLINE.
 *
 * The stamp must stay in the future for as long as the owning PROCESS may be alive, and the process
 * outlives `run()` by the host's own grace (`MANAGED_TRIGGER_GRACE_MS`, which this package may not
 * import — the dependency only goes one way). This headroom is what covers that, and
 * `call-policy.test.ts` gates the relationship from the side that CAN import, for every adapter
 * kind rather than for the one that happened to exist when the constant was written.
 */
export const RUNNER_REAP_HEADROOM_MS = 90_000;

/** The Docker adapter's default CLI. Server-injected in production; this is the unit-test fallback. */
export const DEFAULT_DOCKER_BINARY = "docker";

// THE REAPER'S LABELS AND IDENTITY — M23.1 PHASE 4. See {@link RunnerLauncher.reap} for the defect.

/** Presence of this label is what `reap()` filters `docker ps -a` on — every container this
 *  package ever creates carries it, so a container with no `scp.launcher.*` labels at all (created
 *  by something else entirely — a stray `docker run`, a Testcontainers fixture, an operator's own
 *  manual container) is excluded at the DAEMON'S OWN filter, before a single byte of its state
 *  reaches this process. Reap is a targeted sweep of what this package made, never `docker
 *  container prune`. */
export const RUNNER_LAUNCHER_OWNER_LABEL = "scp.launcher.owner";
/** RFC3339. See {@link RUNNER_REAP_GRACE_MS} for how the value is computed. */
export const RUNNER_LAUNCHER_DEADLINE_LABEL = "scp.launcher.deadline";

/**
 * How far past a run's own WHOLE-RUN DEADLINE its container's {@link RUNNER_LAUNCHER_DEADLINE_LABEL}
 * is stamped — the label's value is `runDeadline + this`, and `runDeadline` is the single
 * `now + clampRunTimeoutMs(spec.timeoutMs)` computed once at the top of `run()`.
 *
 * THE INVARIANT IT BUYS, AND WHY IT IS NOW STRUCTURAL. `reap()` removes containers that are foreign
 * AND past their stamped deadline, so the one thing that must never be true is a container being
 * past its own stamp while the run that made it is still in flight — a peer's `rm -f` then lands on
 * a live `tofu apply`, which {@link RunnerLauncher.reap}'s own contract names as the thing it must
 * never do.
 *
 * IT USED TO BE FALSE, MEASURED. The stamp was `Date.now() + spec.timeoutMs + this` while
 * `timeoutMs` was a PER-CALL bound, so a run's wall clock was k x timeoutMs and nothing tied the two
 * together. Real managed-scan shape (3 copy-ins, `timeoutMs: 30_000`, steps of 28s): the container
 * was stamped for ~t0+150000ms and `run()` returned after 168354ms — 18s spent `foreign AND past
 * deadline` to any peer launcher. The threshold was ~24s of `timeoutMs`; all three shipped defaults
 * are far above it.
 *
 * NOW IT IS ARITHMETIC, AND SINCE M23.5 IT IS ARITHMETIC PER ADAPTER. `run()` cannot outlive
 * `runDeadline` by more than {@link runnerPostDeadlineMs} — one possible abandonment plus that
 * adapter's whole teardown — so THAT is the term this has to cover, plus
 * {@link RUNNER_REAP_HEADROOM_MS} for the window in which the run is over but the owning process is
 * still finishing (the host's `MANAGED_TRIGGER_GRACE_MS`, which this package may not import).
 *
 * IT WAS A FLAT `2 * 60_000` AND THAT WAS THE SAME DEFECT AS THE GRACE'S. Two minutes was "four
 * worst-case teardowns" when a teardown was one `docker rm -f`; on the Kubernetes adapter a teardown
 * is three bounded calls and the host's own grace grows with it, so a flat two minutes could put the
 * stamp in the PAST while the owning process was still alive — HIGH-2 through the other door, on the
 * adapter nobody re-derived the number for.
 */
export function runnerReapGraceMs(kind: RunnerLauncherKind): number {
  return runnerPostDeadlineMs(kind) + RUNNER_REAP_HEADROOM_MS;
}

/** {@link runnerReapGraceMs} for the DOCKER adapter — the value the Docker stamp and
 *  {@link RUNNER_SECRET_ENV_MAX_AGE_MS} (an `--env-file` is a Docker-only artefact) are built from. */
export const RUNNER_REAP_GRACE_MS = runnerReapGraceMs("docker");

/**
 * THE HARD BOUND ON ONE `reap()` PASS — see {@link RunnerLauncher.reap} for the measurement.
 *
 * A pass is `docker ps` plus one `docker rm -f` per expired orphan, and the orphan count is
 * unbounded (it grows with every crash the fleet has had). Bounding only the individual calls, as
 * phase 4 did, bounds nothing: n orphans at {@link RUNNER_REMOVE_TIMEOUT_MS} each is
 * n x 30s. The pass therefore has its own deadline and simply STOPS issuing removals when it
 * passes; whatever is left is still expired, still labelled, and still there for the next pass —
 * a sweep is idempotent, so finishing it late costs nothing and finishing it inside an unbounded
 * loop costs a run.
 *
 * Two minutes: room for four worst-case removals, which is far more than a healthy fleet ever has
 * to do, and short enough that a wedged daemon does not leave a background pass running for the
 * life of the process.
 */
export const RUNNER_REAP_BUDGET_MS = 2 * 60_000;

/**
 * THE HARD BOUND ON A `--env-file`'s AGE BEFORE `reap()` TREATS IT AS ORPHANED (MEDIUM-4). Purely
 * mtime-based — see {@link RunnerLauncher.reap} for why a registry cannot do this job: it lives in
 * the same process memory a SIGKILL erases, so the one process that could tell reap() "this file is
 * still mine" is exactly the one that is gone.
 *
 * SIZED SO NO LIVE RUN CAN EVER LOOK STALE, the same direction every other bound in this file leans.
 * A run's `--env-file` is written once, at the very top of {@link RunnerLauncher.run}, before a
 * single `execFile` is issued — so the OLDEST a live run's file can legitimately be, at any later
 * instant of that same run, is bounded by that run's OWN whole-run budget. Add
 * {@link RUNNER_REAP_GRACE_MS} — the same margin the container's own deadline label carries, for the
 * same reason (a run that is past its deadline but still inside one teardown is not yet fair game)
 * — and a file cannot be BOTH this old AND still belong to a run inside its own budget. A false
 * positive would delete a live run's credential mid-`create`; this bound is chosen so that never
 * happens, at the cost of a leaked file surviving for a while rather than being swept the instant it
 * could safely be.
 *
 * WHAT ENFORCES THE BOUND THAT ARGUMENT RESTS ON, because the answer this doc used to give was
 * FALSE (MEDIUM, verification pass 5). It said a run's budget is "at most
 * {@link MANAGED_RUN_TIMEOUT_MAX_MS}, the ceiling every tenant-settable `timeoutMs` in the product
 * is clamped to." It was not clamped to it. `apps/server/src/plugin-host/call-policy.ts` clamped the
 * HOST's RPC budget and nothing else; all three plugins passed the stored `timeoutMs` into
 * {@link RunnerSpec.timeoutMs} untouched. What ACTUALLY bounded a live run at that point was the
 * host SIGKILLing the plugin subprocess at `budget + MANAGED_TRIGGER_GRACE_MS` — a margin supplied
 * by a constant in a package this one may not import, whose own doc did not mention this dependency,
 * and which is absent entirely on the ONE in-process caller (`promotion-scan-step.ts` calls
 * `plugin.trigger()` with no host and therefore no SIGKILL at all). An age bound resting on a
 * ceiling nobody applied and on a killer that is not always present is not a bound.
 *
 * {@link clampRunTimeoutMs} IS THE ENFORCEMENT, and it is in this package, called by `run()` on the
 * same line that computes the deadline the `--env-file` is written under. The bound is therefore now
 * arithmetic inside one file — the same repair {@link RUNNER_REAP_GRACE_MS} records for the
 * container stamp — rather than a claim about what some other package's write door and some third
 * package's grace period jointly happen to guarantee.
 */
export const RUNNER_SECRET_ENV_MAX_AGE_MS = MANAGED_RUN_TIMEOUT_MAX_MS + RUNNER_REAP_GRACE_MS;

/**
 * This PROCESS's own identity, for the lifetime of the process — minted ONCE, at module load, and
 * NOT inside {@link createDockerRunnerLauncher}. That distinction is the whole mechanism: a plugin
 * resolves a fresh launcher on every `trigger()` ({@link ResolveRunnerLauncher}'s own doc explains
 * why), so if the id were minted inside the factory, this SAME long-lived subprocess would mint a
 * new "owner" for every run and could never recognise its own prior container as its own. One id
 * per Node process — which is exactly one id per managed-executor plugin INSTANCE, since
 * `plugin-host/host.ts` spawns one subprocess per configured instance and keeps it alive (with
 * respawn-on-crash) across every call — is what makes "owned by me" mean the same thing for every
 * run this process ever performs, and mean something DIFFERENT the moment a respawn happens: the
 * successor process mints its own id, so it correctly treats its dead predecessor's leftover
 * container as foreign and reapable once that container's deadline has passed.
 */
/** EXPORTED FOR THE SECOND ADAPTER (M23.2), not widened for convenience. `reap()`'s cardinal rule is
 *  "never destroy a container you do not own", and ownership is THIS PROCESS's identity — so the
 *  Kubernetes adapter must stamp and compare the SAME id, not a second one. Two ids in one process
 *  would make each adapter treat the other's live objects as foreign and reapable. */
export const LAUNCHER_OWNER_ID = randomUUID();

/**
 * THE SINGLE-FLIGHT SLOT FOR THE BACKGROUND SWEEP, one per container CLI — module scope for exactly
 * the reason {@link LAUNCHER_OWNER_ID} is: a launcher instance lives for ONE run, so a guard held in
 * the factory's closure would guard nothing at all.
 *
 * WHAT IT IS FOR. `run()` no longer awaits its sweep, so without this, k concurrent triggers start k
 * concurrent passes, all listing the same containers and all racing to `rm -f` the same ids — and
 * the losers' rejections are swallowed, so the waste is invisible. Every pass is idempotent, so a
 * caller arriving while one is in flight has nothing to add and simply joins it.
 *
 * KEYED BY BINARY because `dockerBinary` is server-injected and a test (or a future operator with
 * two runtimes) may drive two different CLIs from one process; a shared slot would let one CLI's
 * pass satisfy the other's.
 */
const reapInFlight = new Map<string, Promise<string[]>>();

/**
 * The background sweep currently in flight for `dockerBinary`, or a resolved promise when there is
 * none. Nothing in production awaits it — that is the entire point of the change (see
 * {@link RunnerLauncher.reap}) — and it exists so a shutdown path, or a test that needs the sweep to
 * have SETTLED before it asserts on what was removed, has something to await instead of a sleep.
 *
 * AWAITING IT DOES DRAIN THE SLOT: {@link reapInFlight}'s entry is deleted by the pass's own
 * `.finally`, which runs BEFORE the promise this returns resolves, so a `reap()` issued after this
 * settles always starts a FRESH enumeration rather than joining the drained one.
 *
 * IT KNOWS ONLY ABOUT THIS PROCESS. The single-flight map is module state, so this says nothing
 * about a pass running in a PEER process against the same daemon — and such a peer is entitled to
 * remove exactly the containers this process's next pass would have (property 2 in
 * {@link RunnerLauncher.reap}'s doc). A test that needs its own pass to be the one that collects a
 * fixture must handle losing that race, not assume this call prevents it.
 */
export function whenReapSettled(
  dockerBinary: string = DEFAULT_DOCKER_BINARY
): Promise<readonly string[]> {
  return reapInFlight.get(dockerBinary) ?? Promise.resolve([]);
}

/** THE DOCKER ADAPTER. See docs/runner-launcher/index.md §31. */
export function createDockerRunnerLauncher(
  dockerBinary: string = DEFAULT_DOCKER_BINARY
): RunnerLauncher {
  /** See {@link RunnerLauncher.reap}. See docs/runner-launcher/index.md §32. */
  const reapOnce = async (): Promise<string[]> => {
    /** THE PASS's OWN DEADLINE — see {@link RUNNER_REAP_BUDGET_MS}. Bounding the individual calls
     *  bounds nothing when the number of calls is the unbounded term. */
    const passDeadline = Date.now() + RUNNER_REAP_BUDGET_MS;
    let listing: string;
    try {
      // BOUNDED THROUGH THE PORT, like every other call this package makes (M23.5). A `docker ps`
      // against a wedged daemon socket is exactly the shape whose SIGTERM never lands, and a reap
      // pass that never settles is a background promise that never settles — invisible, and it
      // holds the single-flight slot against every later run.
      listing = (
        await withStepBound({
          timeoutMs: RUNNER_REMOVE_TIMEOUT_MS,
          what: "reap `docker ps`",
          work: (timeout) =>
            spawnRunnerProcess(
              dockerBinary,
              [
                "ps",
                "-a",
                "--filter",
                `label=${RUNNER_LAUNCHER_OWNER_LABEL}`,
                "--format",
                `{{.ID}}\t{{.Label "${RUNNER_LAUNCHER_OWNER_LABEL}"}}\t{{.Label "${RUNNER_LAUNCHER_DEADLINE_LABEL}"}}`
              ],
              { timeout }
            )
        })
      ).stdout;
    } catch (cause) {
      debug("reap: listing launcher-owned containers failed, skipping this pass: %O", cause);
      return [];
    }

    const now = Date.now();
    const targets: string[] = [];
    for (const line of listing.split("\n")) {
      if (line.trim().length === 0) continue;
      const [id, owner, deadline] = line.split("\t");
      if (!id || owner === LAUNCHER_OWNER_ID) continue; // never my own — live or not yet torn down
      const deadlineMs = deadline ? Date.parse(deadline) : NaN;
      if (!Number.isFinite(deadlineMs) || deadlineMs > now) continue;
      targets.push(id);
    }

    const removed: string[] = [];
    for (const id of targets) {
      // STOP, DO NOT TRUNCATE THE TIMEOUT. What is left is still expired, still labelled and still
      // findable, so the next pass collects it; a pass that kept going with a 1ms `timeout` would
      // turn every remaining orphan into a kill-and-retry instead of leaving it alone.
      if (Date.now() >= passDeadline) {
        debug(
          "reap: pass budget spent with %d target(s) left, leaving them for the next pass",
          targets.length - removed.length
        );
        break;
      }
      try {
        await withStepBound({
          timeoutMs: RUNNER_REMOVE_TIMEOUT_MS,
          what: `reap \`docker rm -f ${id}\``,
          work: (timeout) => spawnRunnerProcess(dockerBinary, ["rm", "-f", id], { timeout })
        });
        removed.push(id);
      } catch (cause) {
        debug("reap: rm -f %s failed, leaving it for the next pass: %O", id, cause);
      }
    }
    return removed;
  };

  /**
   * MEDIUM-4 — the half of `reap()` that sweeps a leaked `--env-file` rather than an orphaned
   * container. See {@link RunnerLauncher.reap} and {@link RUNNER_SECRET_ENV_MAX_AGE_MS} for the
   * mechanism and the age bound; this function is the sweep itself.
   *
   * NEVER TOUCHES A FILE THIS PACKAGE DID NOT NAME — the `SECRET_ENV_FILE_PREFIX` check is not an
   * optimisation, it is the entire safety argument for being handed an arbitrary directory: a
   * plugin's `secretEnvDir` is its OWN governed state dir, and for managed-iac that is the very
   * directory the dedup-cache `statePath` lives in. A sweep that matched on age alone would delete
   * that file the moment it happened to be old enough.
   *
   * BEST-EFFORT, exactly like the container half: a `readdir`/`stat`/`unlink` failure here is
   * logged and swallowed rather than thrown, because a sweep that cannot even list a directory
   * must not block the run it precedes, and a file that is merely a little late to be swept costs
   * nothing — the same idempotent-sweep argument {@link RUNNER_REAP_BUDGET_MS} makes.
   */
  const sweepStaleSecretEnvFiles = async (dir: string): Promise<void> => {
    let entries: string[];
    try {
      // BOUNDED, LIKE THE CONTAINER HALF OF THE SAME SWEEP (M23.5 census). A `readdir` of a wedged
      // mount never settles, and this pass is `void`ed — so it would hold its promise open forever,
      // invisibly, with nothing ever sweeping a leaked credential file again.
      entries = await withStepBound({
        timeoutMs: RUNNER_REMOVE_TIMEOUT_MS,
        what: `reap \`readdir ${dir}\``,
        work: () => readdir(dir)
      });
    } catch (cause) {
      debug("reap: listing secret-env dir %s failed, skipping this pass: %O", dir, cause);
      return;
    }
    const now = Date.now();
    for (const name of entries) {
      if (!name.startsWith(SECRET_ENV_FILE_PREFIX)) continue; // not ours — never a candidate
      const path = join(dir, name);
      try {
        const info = await withStepBound({
          timeoutMs: RUNNER_REMOVE_TIMEOUT_MS,
          what: `reap \`stat ${path}\``,
          work: () => stat(path)
        });
        // A LIVE run's file is NEVER this old — see {@link RUNNER_SECRET_ENV_MAX_AGE_MS}. An
        // ambiguous or just-created file is left alone, the same fail-closed direction as a
        // missing/garbled container deadline label.
        if (now - info.mtimeMs < RUNNER_SECRET_ENV_MAX_AGE_MS) continue;
        await withStepBound({
          timeoutMs: RUNNER_REMOVE_TIMEOUT_MS,
          what: `reap \`unlink ${path}\``,
          work: () => unlink(path)
        });
        debug("reap: swept stale secret-env file %s (age %dms)", path, now - info.mtimeMs);
      } catch (cause) {
        debug("reap: could not sweep secret-env file %s: %O", path, cause);
      }
    }
  };

  /** {@link reapOnce}, single-flighted per binary through {@link reapInFlight} — see that map's
   *  own doc for why a per-launcher guard would guard nothing. The `--env-file` sweep
   *  ({@link sweepStaleSecretEnvFiles}, MEDIUM-4) is DELIBERATELY OUTSIDE that single-flight: it
   *  touches no daemon, is keyed by DIRECTORY rather than by `dockerBinary`, and joining a peer's
   *  in-flight container pass must never silently skip sweeping THIS run's own `secretEnvDir`. */
  const reap = async (secretEnvDir?: string): Promise<string[]> => {
    const fileSweep = secretEnvDir
      ? sweepStaleSecretEnvFiles(secretEnvDir).catch((cause) =>
          debug("reap: secret-env sweep of %s rejected: %O", secretEnvDir, cause)
        )
      : undefined;

    const joined = reapInFlight.get(dockerBinary);
    if (joined) {
      if (fileSweep) await fileSweep;
      return joined;
    }
    const pass = (async () => {
      const removed = await reapOnce();
      if (fileSweep) await fileSweep;
      return removed;
    })().finally(() => {
      if (reapInFlight.get(dockerBinary) === pass) reapInFlight.delete(dockerBinary);
    });
    reapInFlight.set(dockerBinary, pass);
    return pass;
  };

  return {
    reap,
    async run(spec: RunnerSpec): Promise<RunnerResult> {
      // SCHEDULED AT THE TOP, BEFORE `create`, AND NOT AWAITED — M23.1 phase 4's placement, M23.1e's
      // coupling. The placement is still right: one place, reached before the next container this
      // process makes and — because the host respawns a SIGKILLed subprocess with backoff — within
      // one retry of the very event that orphans a container. The `await` was not: reap's `ps` and
      // every `rm -f` were spent out of the run's own budget, and with four stale orphans a run
      // could exhaust it with `create` never issued (measurement in {@link RunnerLauncher.reap}).
      // `void`, not `await`: the sweep is idempotent, single-flighted and hard-bounded, and it can
      // now delay `create` by no ticks at all. `reap()` never rejects; the `.catch` is for the case
      // where some future edit makes it able to, so an unhandled rejection can never take the
      // subprocess down over a cleanup pass.
      //
      // `spec.secretEnvDir` PASSED THROUGH (MEDIUM-4): this is the CURRENT run's own governed
      // directory, so a stale `--env-file` a SIGKILLed predecessor left here — the one place this
      // run is about to write its own — is swept before this run adds another. See
      // {@link RunnerLauncher.reap}.
      void reap(spec.secretEnvDir).catch((cause) =>
        debug("reap: background pass rejected: %O", cause)
      );

      /** THE WHOLE-RUN DEADLINE. See docs/runner-launcher/index.md §33. */
      const runDeadline = createRunDeadline({
        requestedTimeoutMs: spec.timeoutMs,
        file: dockerBinary,
        redactions: () => redactions()
      });
      /**
       * `spec.timeoutMs` WITH THE PRODUCT CEILING APPLIED. See {@link clampRunTimeoutMs}: the
       * ceiling used to be enforced on the host's RPC budget and on NEITHER of the two numbers this
       * function derives, so a stored `timeoutMs` above it produced a container stamped hours past
       * the SIGKILL that orphaned it. It is read off the deadline object rather than recomputed,
       * because two clamps of one number is how the two drift.
       */
      const runTimeoutMs = runDeadline.runTimeoutMs;
      const runDeadlineAt = runDeadline.at;
      const maxBuffer = spec.maxBuffer;
      const envArgs = spec.env.flatMap((entry) => ["-e", entry]);

      // THE NAME IS KNOWN BEFORE ANYTHING IS ISSUED. Everything about M23.0's defect 1 turns on this
      // line being ABOVE the `try`: the teardown needs an identity that exists even when `create`
      // never answered. See {@link runnerContainerName} for why "move the await inside the try" —
      // this file's own former advice — repairs nothing.
      const containerName = runnerContainerName(spec.runId);
      /**
       * {@link RUNNER_LAUNCHER_DEADLINE_LABEL}'s value for the container THIS run is about to
       * create — {@link runDeadlineAt} plus {@link RUNNER_REAP_GRACE_MS}, off the SAME clock read
       * the run itself is bounded by.
       *
       * THAT SHARED READ IS THE FIX FOR HIGH-2. It used to be its own `Date.now() + spec.timeoutMs
       * + grace` while the run's real duration was k x `timeoutMs`, so a run routinely outlived the
       * deadline it had stamped on its own container and spent that window looking, to every peer
       * launcher, exactly like an orphan to be `rm -f`'d. Now the run cannot pass `runDeadlineAt`
       * except by one teardown, and the grace is four of those.
       */
      const reapDeadline = new Date(runDeadlineAt + RUNNER_REAP_GRACE_MS).toISOString();

      // THE REDACTION SET, and it is complete by construction rather than by inspection: the secret
      // VALUES the caller declared, plus the `--env-file` path once there is one. Read through a
      // closure, so the path joins the set the moment it exists and every later error inherits it.
      const secretValues = spec.secretEnv.map(valueOf).filter((v) => v.length > 0);
      let envFilePath: string | undefined;
      const redactions = (): string[] => [...secretValues, ...(envFilePath ? [envFilePath] : [])];
      const redact = (text: string): string => redactAll(text, redactions());

      /**
       * THE ONLY `execFile` IN THE PRODUCT, AND THE ONLY PLACE A RAW REJECTION CAN ESCAPE — the
       * redaction wrapper, with the `timeout` supplied by the caller.
       *
       * EXACTLY ONE STEP MAY USE IT DIRECTLY, AND ONLY BECAUSE IT IS OUTSIDE THE RUN BUDGET: the
       * `finally` teardown, which has to work when the budget is precisely what ran out. Every
       * other step goes through {@link exec}, which derives its bound from the run's one deadline.
       */
      const execFixed = async (
        step: RunnerLaunchStep,
        argv: string[],
        call: RunnerPostDeadlineCall<"docker">,
        options: { maxBuffer?: number } = {}
      ): Promise<{ stdout: string; stderr: string }> => {
        try {
          // OUTSIDE THE RUN BUDGET IS NOT OUTSIDE A BOUND (M23.5). `RUNNER_REMOVE_TIMEOUT_MS` is
          // still what reaches `execFile` — every golden pins it — and {@link withStepBound} is what
          // makes it TRUE when the child cannot take a SIGTERM. A teardown that never returns is the
          // same unreturned `run()` as a copy-in that never returns.
          //
          // AND IT NAMES ITSELF FROM THE MODEL. The bound and the timeout both come from
          // {@link withPostDeadlineBound}, so this call cannot be issued without appearing in
          // {@link RUNNER_POST_DEADLINE_CALLS} — which is what the count every outer grace is built
          // from is derived from.
          return await withPostDeadlineBound({
            kind: "docker",
            call,
            what: `'${step}' (${argv[0] ?? ""})`,
            work: (timeout) => spawnRunnerProcess(dockerBinary, argv, { ...options, timeout })
          });
        } catch (cause) {
          throw new RunnerLaunchError({
            step,
            file: dockerBinary,
            argv,
            cause,
            redactions: redactions()
          });
        }
      };

      /**
       * EVERY STEP OF THE RUN PROPER, BOUNDED BY WHAT IS LEFT OF THE ONE BUDGET — the whole of
       * M23.1e's HIGH-1 fix. `options` carries NO `timeout`: each caller below used to hand in
       * `spec.timeoutMs` and get a fresh, FULL budget of its own, so k sequential steps meant a
       * k x timeoutMs run and no bound on the sum.
       *
       * THE ARITHMETIC IS NO LONGER HERE, AND THAT MOVE IS M23.5's WHOLE POINT. The refusal at
       * exhaustion, the `Math.max(1, …)` that keeps Node in range, and the abandonment of work that
       * ignores its bound all live in {@link RunDeadline.spend} — read that doc for the three Node
       * traps this used to spell out, because they are properties of the PORT and not of this
       * adapter. What survives here is the only part that genuinely differs between adapters: how a
       * step's OWN failure is shaped into a {@link RunnerLaunchError}.
       */
      const exec = async (
        step: RunnerLaunchStep,
        argv: string[],
        options: { maxBuffer?: number }
      ): Promise<{ stdout: string; stderr: string }> => {
        try {
          return await runDeadline.spend(step, argv, (timeout) =>
            spawnRunnerProcess(dockerBinary, argv, { ...options, timeout })
          );
        } catch (cause) {
          // ALREADY THE PORT'S OWN VERDICT — a refusal before the step was issued, or an
          // abandonment of work that ignored its bound. Re-wrapping it here would restate the step
          // and lose the message the port built.
          if (cause instanceof RunnerLaunchError) throw cause;
          // OUR OWN DEADLINE, NOT THE STEP'S FAULT — distinguishable because `promisify(execFile)`
          // sets `killed` only when IT did the killing, and because the clock has by then reached
          // the deadline the `timeout` was derived from.
          const e = cause as {
            message?: string;
            code?: string | number | null;
            killed?: boolean;
            signal?: string | null;
            stdout?: string;
            stderr?: string;
          };
          // THROUGH THE DEADLINE OBJECT, NOT A SECOND EXPRESSION FOR THE SAME INSTANT — see
          // {@link RunDeadline.spent}. `Date.now() >= runDeadlineAt` here reported FALSE for a
          // `create` this adapter's own derived timeout had just killed, because the killing timer
          // and this comparison read different clocks.
          const deadlineExceeded = e.killed === true && runDeadline.spent();
          throw new RunnerLaunchError({
            step,
            file: dockerBinary,
            argv,
            // THE MESSAGE IS REPLACED, THE DIAGNOSIS IS NOT. `code`/`killed`/`signal` and whatever
            // the child managed to print before we killed it are carried across unchanged — a
            // partial `tofu plan` on stdout is exactly what an operator needs from a run that ran
            // out of budget — while the text says WHY it died instead of `Command failed: docker
            // start -a …`, which is indistinguishable from the runner having crashed on its own.
            cause: deadlineExceeded
              ? {
                  ...e,
                  message:
                    `whole-run budget of ${runTimeoutMs}ms (RunnerSpec.timeoutMs) ran out during ` +
                    `'${step}' at the run deadline ${new Date(runDeadlineAt).toISOString()}`
                }
              : cause,
            redactions: redactions(),
            deadlineExceeded
          });
        }
      };

      // 0. REFUSE A SPEC THAT WOULD PRODUCE AN AMBIGUOUS COMMAND LINE, before a container exists.
      //    Never sanitise: a silently-corrected runId is how two runs come to share one container,
      //    and a newline inside an `--env-file` value is how one entry becomes two.
      const refuse = (why: string): never => {
        throw new RunnerLaunchError({
          step: "spec",
          file: "",
          argv: [],
          cause: new Error(why),
          redactions: redactions()
        });
      };
      if (!RUNNER_RUN_ID_PATTERN.test(spec.runId)) {
        refuse(
          `runId '${spec.runId}' is not DNS-safe (${String(RUNNER_RUN_ID_PATTERN)}) — build it with toRunnerRunId()`
        );
      }
      for (const [key, value] of Object.entries(spec.labels)) {
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(key) || /[\r\n]/.test(value)) {
          refuse(`label '${key}' is not a usable Docker/Kubernetes label`);
        }
      }
      for (const entry of spec.secretEnv) {
        // A `\n` in an env-file value silently DEFINES ANOTHER VARIABLE, which is an injection into
        // the runner's environment from whatever produced the secret.
        if (!/^[A-Za-z_][A-Za-z0-9_]*=/.test(entry) || /[\r\n]/.test(entry)) {
          refuse(
            `secretEnv entry '${entry.split("=")[0] ?? ""}=…' is not a single-line KEY=VALUE pair`
          );
        }
      }
      for (const entry of spec.env) {
        // `env` is as caller-shaped as `secretEnv` and had no check at all. Docker reads a bare
        // `-e KEY` (no `=`) as "inherit KEY from THIS process's environment" — so a malformed entry
        // imports the SERVER's own variable into the runner instead of failing — and the Kubernetes
        // adapter's `indexOf("=")` split turns the same entry into a name missing its last
        // character. Two different silent wrong answers from one unvalidated string. Newlines are
        // NOT refused here (unlike `secretEnv`): these travel as argv / `env[].value`, where a
        // multi-line value is exactly one variable, not two.
        if (!/^[A-Za-z_][A-Za-z0-9_]*=/.test(entry)) {
          refuse(`env entry '${entry.split("=")[0] ?? ""}=…' is not a KEY=VALUE pair`);
        }
      }

      // 1. STAGE THE SECRETS OFF THE COMMAND LINE (M23.0 defect 3). Before the `try`, so a failure
      //    here tears nothing down — no container has been asked for yet.
      if (spec.secretEnv.length > 0) {
        if (!spec.secretEnvDir) {
          refuse("secretEnv was supplied without secretEnvDir — refusing to choose a directory");
        }
        try {
          // THROUGH THE ONE DEADLINE, LIKE EVERY OTHER STEP (M23.5 census). `secretEnvDir` is a
          // server-injected path — `SCP_MANAGED_*_WORKSPACE_ROOT`, which an operator may perfectly
          // well point at the same shared mount the Kubernetes workspace uses — so an `mkdir` +
          // `writeFile` here is the same unbounded network-filesystem call as a `copyDir`, and it
          // sits BEFORE `create`, where a hang costs the whole run with no container to show for it.
          envFilePath = await runDeadline.spend("secret-env", [], () =>
            writeSecretEnvFile(spec.secretEnvDir!, spec.runId, spec.secretEnv)
          );
        } catch (cause) {
          if (cause instanceof RunnerLaunchError) throw cause;
          throw new RunnerLaunchError({
            step: "secret-env",
            file: "",
            argv: [],
            cause,
            redactions: redactions()
          });
        }
      }

      /**
       * DID `create` LOSE THE NAME TO SOMEBODY ELSE? Declared out here because it is read in the
       * `finally` and written in the `try`, and it is the ONE thing that makes the unconditional
       * teardown conditional. Anything else that goes wrong with `create` — a timeout, a missing
       * image, a dead daemon — still tears down, because the daemon may have committed a container
       * for a call we never got an answer from (M23.0 defect 1, and the reason the name is computed
       * before `create` is issued at all).
       */
      let createNameConflict = false;

      try {
        // 2. CREATE (not run). The container exists but has not started; `docker cp` requires
        //    exactly that state.
        //
        //    INSIDE THE `try`, WITH THE NAME ALREADY DECIDED — the two halves of the fix, and
        //    neither works alone.
        let createOut: string;
        try {
          createOut = (
            await exec(
              "create",
              [
                "create",
                "--network",
                spec.networkMode,
                "--name",
                containerName,
                ...Object.entries(spec.labels).flatMap(([k, v]) => ["--label", `${k}=${v}`]),
                // THE REAPER'S OWN TWO LABELS (M23.1 phase 4) — always present, on every container
                // this adapter ever creates, never conditional on the caller's own `spec.labels`.
                "--label",
                `${RUNNER_LAUNCHER_OWNER_LABEL}=${LAUNCHER_OWNER_ID}`,
                "--label",
                `${RUNNER_LAUNCHER_DEADLINE_LABEL}=${reapDeadline}`,
                ...(envFilePath ? ["--env-file", envFilePath] : []),
                ...envArgs,
                spec.image,
                ...spec.operands
              ],
              { maxBuffer }
            )
          ).stdout;
        } catch (cause) {
          // THE ONE CREATE FAILURE THAT MUST NOT BE FOLLOWED BY A TEARDOWN. Recorded, then
          // rethrown unchanged — the caller's error is the same `RunnerLaunchError` it always was;
          // only what the `finally` does about it changes.
          createNameConflict = isContainerNameConflict(cause);
          throw cause;
        } finally {
          // UNLINKED THE INSTANT `create` RETURNS, on the failure path too. Docker has read the file
          // by then; nothing later in the run needs it. The window is one `create`.
          //
          // BOUNDED LIKE A TEARDOWN, NOT SPENT FROM THE BUDGET (M23.5 census). This is CLEANUP of a
          // mode-0600 credential file, and the commonest way to reach it with nothing left is that
          // `create` is what spent the budget — so refusing it would leave the credential on disk
          // for `reap()` to find later, which is the wrong direction. It still may not hang: an
          // unbounded `unlink` on a wedged mount holds `run()` open exactly like an unbounded copy.
          //
          // AND IT IS IN THE MODEL, WHICH IS THE PART THE ROUND THAT WROTE THIS COMMENT MISSED. The
          // sentence above says "bounded like a teardown"; the census that built
          // {@link RUNNER_POST_DEADLINE_CALLS} asked what the TEARDOWN `finally` issues and never
          // saw this line, so `run()` overran its own stated bound by one whole
          // {@link RUNNER_BOUNDED_CALL_WORST_CASE_MS} — past the host's SIGKILL, which is a second
          // `tofu apply`. {@link withPostDeadlineBound} is now the only way to reach here.
          if (envFilePath) {
            const doomed = envFilePath;
            await withPostDeadlineBound({
              kind: "docker",
              call: "secret-env unlink",
              work: () => unlink(doomed)
            }).catch(() => undefined);
          }
        }
        // TWO IDENTITIES, ON PURPOSE. The steps that only run AFTER a successful `create` address
        // the id the daemon returned — the precise handle, and what every golden records. Teardown
        // addresses the NAME, because it is the only identity that exists on the path where `create`
        // is the thing that failed.
        const containerId = createOut.trim();

        // 3. COPY IN — the caller's directories' CONTENTS, in the caller's order.
        for (const copy of spec.copyIn) {
          await exec(
            "copy-in",
            ["cp", `${copy.hostDir}/.`, `${containerId}:${copy.containerPath}`],
            { maxBuffer }
          );
        }

        // 4. START attached — blocks until the container exits and propagates its exit code, so a
        //    non-zero runner rejects here and is CAPTURED rather than thrown.
        let succeeded: boolean;
        let stdout: string;
        let stderr: string;
        /** Set exactly when `succeeded` is false — see {@link RunnerResult} for why that is a type
         *  invariant here rather than a convention. */
        let failure: RunnerFailure | undefined;
        try {
          const r = await exec("start", ["start", "-a", containerId], { maxBuffer });
          succeeded = true;
          stdout = redact(r.stdout);
          stderr = redact(r.stderr);
        } catch (err) {
          // ALREADY REDACTED, and the `?? ""` / `?? message` falls already applied — they moved into
          // {@link RunnerLaunchError} so that a captured failure and a thrown one cannot drift apart.
          //
          // AND THE DIAGNOSIS IS NOW KEPT — MEDIUM (verification pass 5). This is the ONLY step whose
          // failure is captured instead of thrown, and it is the step that spends essentially all of
          // a real run's budget, so everything this catch dropped was dropped on the commonest
          // failure path in the product. It kept `stdout`/`stderr` alone; `promisify(execFile)`
          // always supplies `stderr` as a string, so a budget-kill with no output and a silent
          // non-zero exit both arrived here as two empty strings and left as the same
          // `{ succeeded: false, stdout: "", stderr: "" }` — `detail: ""` in managed-iac's durable
          // ledger, in every `status()`, and in reconcile's Decision `inputContext`.
          const e = err as RunnerLaunchError;
          succeeded = false;
          stdout = e.stdout;
          stderr = e.stderr;
          failure = classifyRunnerFailure(e);
        }

        // 5. COPY OUT — conditionally, and guarded or not, exactly as the caller asked. Both axes
        //    differ between the three callers and both are load-bearing.
        const copyOut = spec.copyOut;
        if (copyOut && (copyOut.when === "always" || succeeded)) {
          const pending = exec(
            "copy-out",
            ["cp", `${containerId}:${copyOut.containerPath}/.`, copyOut.hostDir],
            { maxBuffer }
          );
          if (copyOut.onFailure === "swallow") {
            await pending.catch(() => undefined);
          } else {
            await pending;
          }
        }

        // THE UNION IS REBUILT EXPLICITLY rather than spread from the three locals: `failure` is
        // present exactly when `succeeded` is false, and writing that out is what lets the compiler
        // hold callers to it (see {@link RunnerResult}).
        return succeeded
          ? { succeeded: true, stdout, stderr }
          : { succeeded: false, stdout, stderr, failure: failure! };
      } finally {
        // 6. Destroy the container unconditionally — BY NAME, which is the identity that exists even
        //    when `create` is what failed. `docker rm -f` on a name that never existed exits ZERO
        //    (measured, Docker 29.5.2), so the no-container case costs one harmless daemon call.
        // SWALLOWED, but not SILENT: a failed teardown here means a container may be about to
        // orphan — `reap()` is the backstop, but the reason THIS teardown failed had nowhere to go
        // before this line, which is a defect the same shape as the one this whole phase exists to
        // close (a hazard with no reader). `NODE_DEBUG=scp-runner-launcher` surfaces it.
        //
        // AND EXACTLY ONE THING IT MUST NOT DO — M23.1e. `create` failing BECAUSE THE NAME IS
        // ALREADY TAKEN means the container behind that name is SOMEBODY ELSE'S, still running,
        // and an unconditional `rm -f` here destroys it. That is not the orphan case this teardown
        // exists for; it is the exact opposite of it. See {@link isContainerNameConflict} for the
        // measured signal and for why the answer is not per-attempt unique names.
        //
        // `execFixed`, NOT `exec`: the teardown is deliberately OUTSIDE the whole-run budget, since
        // the commonest reason to reach it is that the budget is what ran out. Its own
        // `RUNNER_REMOVE_TIMEOUT_MS` is what every golden records, and what `RUNNER_REAP_GRACE_MS`
        // is sized against.
        if (createNameConflict) {
          debug(
            "teardown: SKIPPED for %s — create lost the name to a container this run does not own",
            containerName
          );
        } else {
          await execFixed("teardown", ["rm", "-f", containerName], "teardown rm -f").catch(
            (cause) => {
              debug("teardown: rm -f %s failed: %O", containerName, cause);
            }
          );
        }
      }
    }
  };
}

/**
 * The default resolver every managed executor uses today: one adapter, Docker, built from the
 * server-injected `dockerBinary`. M23.2 replaces this with a switch on an explicit operator setting
 * — NEVER an auto-detection of the platform (M15.4 declined to create that runtime/install-time
 * fork, and guessing from the presence of a service-account token is exactly that guess).
 */
export const resolveDockerRunnerLauncher: ResolveRunnerLauncher = (config) =>
  createDockerRunnerLauncher(config.dockerBinary ?? DEFAULT_DOCKER_BINARY);

// ==================================================================================================
// RECORDED OUTCOMES — every path out of a plugin's `trigger()` records something, redacted (M23.1
// phase 2). NOT a port concept: this holds no state and knows nothing about Docker. It exists here
// only because three plugins would otherwise duplicate it three times.
// ==================================================================================================

/**
 * How a plugin writes ONE terminal outcome to whatever store it already keeps — an in-memory `Map`
 * for managed-scan/managed-dep, a durable JSON file for managed-iac. May be async (a file write);
 * {@link withRecordedOutcome} awaits it either way.
 */
export type RecordOutcome = (succeeded: boolean, detail: BoundedDetail) => void | Promise<void>;

/**
 * THE FIX FOR "A PATH OUT OF `trigger()` THAT RECORDS NO OUTCOME" (BUILD_AND_TEST.md §4.4, CLAUDE.md
 * incomplete-call-site-census). Before this, managed-scan and managed-iac each had a `trigger()`
 * whose success path recorded an outcome but whose THROW path did not — a launcher failure, a
 * `writeSourceFiles` refusal, a disk error, anything — escaped `trigger()` as a rejection instead,
 * and left the run's own store with nothing keyed to it. `status()` then reports `pending` forever,
 * indistinguishable from "still running". managed-dep's `trigger()` never had this hole (its whole
 * body already sits in one big try/catch); this helper is that same shape, factored out so the other
 * two stop being three hand-written copies of "wrap it in try/catch" that a fourth plugin would make
 * four.
 *
 * SUCCESS RECORDING IS UNCHANGED, DELIBERATELY. This only catches what `fn` THROWS. Each plugin
 * still records its own success outcome from inside `fn`, in its own shape (managed-iac's carries a
 * `stateRef`, managed-dep's a `result`/`merge`) — a shape this package has no business inventing a
 * common ancestor for.
 *
 * THE RECORDED DETAIL IS BOUNDED HERE, not by the plugin. `record`'s parameter is
 * {@link BoundedDetail} precisely so a plugin cannot store the raw message: managed-iac's `record`
 * writes to a durable, never-pruned JSON file and from there into a `Decision`'s `inputContext`, and
 * the message of a `docker create` rejection contains the child's entire stderr. See
 * {@link RUNNER_DETAIL_MAX_CHARS}.
 *
 * `redact` IS NOT OPTIONAL AND IS NOT COSMETIC. A thrown `Error`'s `.message` is freeform text a
 * plugin did not construct and cannot trust — for managed-iac specifically, a `docker create`
 * rejection's message is `Command failed: docker create … -e AWS_SECRET_ACCESS_KEY=<value> …` before
 * anything strips it, and whatever `record` does with the resulting `detail` (managed-iac's goes to
 * a durable, replicated, backed-up JSON file and from there into a `Decision`'s `inputContext`) is
 * exactly the channel CLAUDE.md's "a claim about a tool cannot be verified with that tool" warns
 * about: {@link RunnerLaunchError} already redacts what IT knows to redact, but a plugin whose
 * injected launcher throws something else entirely — a stub in a test, a future adapter, a bug —
 * must not depend on that already having happened. `redact` is the plugin's OWN, independent
 * knowledge of which values in its world are secret; managed-scan and managed-dep hold no
 * credential, so theirs is the identity function, and that is a fact about THEM, not a default this
 * package chose for them.
 */
export async function withRecordedOutcome<T>(
  opts: { record: RecordOutcome; redact: (text: string) => string },
  fn: () => Promise<T>
): Promise<T | undefined> {
  try {
    return await fn();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // M23.5 MEDIUM-8 — `.message` ALONE IS COMPLETE FOR DOCKER AND EMPTY OF THE REASON FOR
    // KUBERNETES, and this used to read only `.message`. `RunnerLaunchError.message` is built from
    // its CAUSE's `.message` (see the class doc, `causeMessage`): for the Docker adapter that cause
    // is `promisify(execFile)`'s own rejection, whose `.message` already IS `Command failed: ...`
    // plus the whole of stderr — nothing was ever missing there. The Kubernetes adapter's `api()`
    // fails with a cause `{ message: "kubernetes POST /path -> HTTP 403", stderr: res.body }` — a
    // deliberately short `.message` — and puts the API SERVER'S OWN RESPONSE BODY in `.stderr`
    // instead: the quota text, the RBAC sentence, a 422's field path, an admission webhook's policy
    // name. `RunnerLaunchError.stderr` carries it (see the class doc), already redacted the same way
    // `.message` is — `causeMessage` and `this.stderr` both run through the same `redact` closure in
    // the constructor — so appending it here adds no new redaction obligation. `create`,
    // `secret-env` and `copy-in` failures reject `run()` directly (no `classifyRunnerFailure` runs
    // for them — that only happens for `start`), so this was the ONLY place those three steps'
    // failures were ever turned into a recorded detail, and it was dropping the one field the
    // rejection existed to carry.
    const stderr = err instanceof RunnerLaunchError ? err.stderr : "";
    const detail =
      stderr.length > 0 && !message.includes(stderr) ? `${message} :: ${stderr}` : message;
    // BOUNDED BEFORE `record` EVER SEES IT. See docs/runner-launcher/index.md §34.
    await opts.record(false, boundDetail(opts.redact(detail)));
    return undefined;
  }
}

// THE SECOND ADAPTER. See docs/runner-launcher/index.md §35.
export {
  ADVERSARIAL_ALL,
  ADVERSARIAL_ALPHABETS,
  ADVERSARIAL_PERSISTED_JSON
} from "./adversarial-corpus.js";
export {
  KUBERNETES_JOB_TTL_SECONDS,
  KUBERNETES_MERGES_STDERR_INTO_STDOUT,
  KUBERNETES_POLL_INTERVAL_MS,
  K8S_SA_DIR,
  RUNNER_CONTAINER_NAME,
  RUNNER_LAUNCHER_DEADLINE_ANNOTATION,
  RUNNER_NETWORK_LABEL,
  RUNNER_RUN_ID_LABEL,
  RUNNER_WORKSPACE_VOLUME_NAME,
  createDefaultKubernetesIo,
  createFetchKubernetesIo,
  createKubernetesRunnerLauncher,
  isKubernetesAlreadyExists,
  isKubernetesLabelValue,
  jobManifest,
  kubernetesContainerStarted,
  kubernetesConstructionCount,
  kubernetesJobTermination,
  kubernetesRbacKey,
  kubernetesRbacRequirement,
  kubernetesRunnerRbac,
  kubernetesStartVerdict,
  kubernetesTermination,
  kubernetesWaitingEvidence,
  resolveRunnerLauncher,
  runnerJobName,
  runnerSecretName,
  shortDigest,
  whenKubernetesReapSettled,
  workspaceSlots
} from "./kubernetes-adapter.js";
export type {
  KubernetesApiRequest,
  KubernetesRbacRule,
  KubernetesApiResponse,
  KubernetesStartFacts,
  KubernetesRunnerIo,
  KubernetesRunnerLauncherConfig,
  KubernetesRunnerPodConventions,
  KubernetesWorkspaceVolume
} from "./kubernetes-adapter.js";
