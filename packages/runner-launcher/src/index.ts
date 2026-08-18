import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { debuglog, promisify } from "node:util";

const execFileAsync = promisify(execFile);

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
 *   2. STILL OPEN, and not this port's to fix. A managed-scan run whose copy-out fails ends stuck in
 *      `pending`; that is the plugin's outer error handling —
 *      {@link RunnerCopyOut.onFailure} `"propagate"` reproduces the rejection that causes it, and
 *      managed-iac has the same shape for a create or copy-in failure.
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

/** One `docker cp` of a host directory's CONTENTS into the container (the trailing `/.`). */
export interface RunnerCopyIn {
  /** HOST directory. Its contents are copied, not the directory itself. */
  hostDir: string;
  /** Absolute destination path INSIDE the container. */
  containerPath: string;
}

/**
 * Whether the evidence copy-out runs after a FAILED start.
 *  - `"always"` — managed-iac: a failed `apply` may still have produced a partial `plan.json`.
 *  - `"on-success"` — managed-scan (a failed scan must produce NO evidence, so E6 refuses) and
 *    managed-dep (a partial manifest must never reach the verifiers).
 */
export type RunnerCopyOutWhen = "always" | "on-success";

/**
 * Where a FAILED copy-out lands.
 *  - `"swallow"` — managed-iac: `.catch(() => undefined)`, the run stays `succeeded`.
 *  - `"propagate"` — managed-scan and managed-dep: the rejection escapes {@link RunnerLauncher.run}.
 *    The two plugins then answer it differently (scan lets it escape `trigger()`; dep's outer catch
 *    turns it into a `failed` outcome), which is the plugins' business, not this port's.
 */
export type RunnerCopyOutOnFailure = "swallow" | "propagate";

/** One `docker cp` of a container directory's CONTENTS back out to the host. */
export interface RunnerCopyOut {
  /** Absolute source path INSIDE the container. Its contents are copied (the trailing `/.`). */
  containerPath: string;
  /** HOST destination directory. */
  hostDir: string;
  when: RunnerCopyOutWhen;
  onFailure: RunnerCopyOutOnFailure;
}

/** One runner launch, described completely — nothing about it is defaulted by the adapter. */
export interface RunnerSpec {
  /**
   * THE CALLER'S OWN NAME FOR THIS RUN — unique per run, DNS-safe, and matching
   * {@link RUNNER_RUN_ID_PATTERN}. The Docker adapter turns it into
   * `--name scp-runner-<runId>`; the Kubernetes adapter (M23.2) puts the same string in
   * `metadata.name`.
   *
   * CALLER-SUPPLIED, NOT ADAPTER-MINTED, and that is the whole point. Only the caller knows what a
   * run IS — managed-iac derives this from `intent.idempotencyKey` precisely so a retry addresses
   * the same container name, which no adapter could know to do. An adapter that minted its own name
   * would force the Kubernetes arm to invent a second naming scheme and recreate exactly the
   * three-implementations-of-one-mechanism divergence M23.1 removed.
   *
   * Build it with {@link toRunnerRunId}; the adapter REFUSES a runId that does not match the
   * pattern rather than sanitising one silently, because a silently-sanitised name is how two runs
   * come to share one container.
   */
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
  /**
   * The network the runner gets. SERVER-GOVERNED where it is a config read (managed-iac,
   * managed-scan) and a CHARTER LITERAL where it is not (managed-dep's `RUNNER_NETWORK_MODE`, ADR-0032
   * §8d) — this port takes the resolved value and never decides it, precisely so the difference
   * between "an operator may change this" and "an operator may not" stays at the call site where the
   * charter clause is quoted.
   */
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
  /**
   * THE WHOLE-RUN BUDGET — the maximum wall clock {@link RunnerLauncher.run} may spend on this run,
   * from the moment it is called to the moment it returns, teardown excepted. 10 min for
   * managed-iac and managed-scan, 5 min for managed-dep.
   *
   * IT USED TO BE A PER-CALL BOUND, AND THAT IS THE DEFECT M23.3 EXISTS TO CLOSE. Every `execFile`
   * this adapter issues — `create`, each `cp` in, `start -a`, the `cp` out — was handed
   * `{ timeout: spec.timeoutMs }` INDEPENDENTLY, so a run of k sequential calls had a wall clock of
   * k x timeoutMs and nothing bounded the sum. Measured: managed-iac (4 calls) with
   * `timeoutMs: 20_000` and steps of 18s/9s/18s/9s — every one of them comfortably UNDER the inner
   * 20s timeout — ran 50s and was SIGKILLed by the host budget that had been sized as
   * `timeoutMs + 30s`, leaving an orphaned container mid-`tofu apply` and an unwritten idempotency
   * ledger, so `reconcile.ts` issued a SECOND apply on top of the first. Reachable at the shipped
   * 10-minute defaults, because `docker create` PULLS THE IMAGE when it is absent: a cold pull plus
   * an ordinary apply clears 630s without any single call reaching 600s.
   *
   * SO IT IS A DEADLINE, NOT A PER-CALL CAP. {@link createDockerRunnerLauncher} computes
   * `deadline = now + timeoutMs` ONCE, at the top of `run()`, and every `execFile` it issues gets
   * `timeout: deadline - now` — never `spec.timeoutMs`, and never `0`, which Node reads as NO
   * TIMEOUT AT ALL (measured on the running Node 26.7.0: `{ timeout: 0 }` let a 1.5s child run to
   * completion). A step reached with the budget already spent is REFUSED before it is issued, with
   * a {@link RunnerLaunchError} carrying {@link RunnerLaunchError.deadlineExceeded}. The two
   * numbers derived from this one — the host's RPC budget (`call-policy.ts`) and the container's
   * own {@link RUNNER_LAUNCHER_DEADLINE_LABEL} — are therefore correct BY CONSTRUCTION rather than
   * because a padding constant happened to be big enough.
   *
   * WHAT IS DELIBERATELY OUTSIDE IT: the `finally` teardown (`docker rm -f`), which must still run
   * after the budget is gone and keeps its own {@link RUNNER_REMOVE_TIMEOUT_MS}; and `reap()`,
   * which is not awaited at all (see {@link RunnerLauncher.reap}). `run()` therefore returns within
   * `timeoutMs + RUNNER_REMOVE_TIMEOUT_MS`, and that sum is what every outer budget must cover.
   */
  timeoutMs: number;
  /** Per-call `maxBuffer`. 16 MiB / 32 MiB / 8 MiB respectively — NOT one shared default. */
  maxBuffer: number;
}

/** What a runner run produced. `succeeded` is the runner's own exit status, not the launch's. */
export interface RunnerResult {
  succeeded: boolean;
  stdout: string;
  stderr: string;
}

/**
 * THE PORT. One verb, because a managed runner has exactly one lifecycle: run it to completion and
 * hand back what it printed. Adapters: Docker (below, for compose/VM) and — M23.2, not before —
 * Kubernetes Jobs.
 */
export interface RunnerLauncher {
  run(spec: RunnerSpec): Promise<RunnerResult>;
  /**
   * M23.1 PHASE 4 — CONTAINMENT HYGIENE FOR THE WINDOW PHASES 1–3 CANNOT CLOSE. When the JS
   * process that owns a run is SIGKILLed (or dies for any other reason) mid-`run()`, NO `finally`
   * executes — not the adapter's own teardown, nothing. The container the daemon already started
   * keeps running, `state=running`, doing whatever its workload does (for managed-iac, a `tofu
   * apply` still mutating live infrastructure) with nothing left supervising it. Phases 1–3 made
   * every container NAMED and LABELLED and made the SIGKILL itself rarer (the host's own hang
   * detector no longer fires at 10s against a legitimate multi-minute run) — neither closes this
   * window, because a label nobody reads is not a cleanup mechanism.
   *
   * Removes every OTHER launcher's container whose {@link RUNNER_LAUNCHER_DEADLINE_LABEL} has
   * passed. Two things this must NEVER do, and both are the actual hard part:
   *   - touch a container this SAME process is still supervising (it is not orphaned — checked by
   *     {@link RUNNER_LAUNCHER_OWNER_LABEL}, not by the container's state);
   *   - touch a LIVE PEER's container before that peer's own run has had a chance to finish and
   *     tear it down itself (checked by the deadline, not by "does it look idle").
   *
   * Best-effort: a `docker ps`/`docker rm` failure here is logged (`NODE_DEBUG=scp-runner-launcher`)
   * and swallowed rather than thrown, because a reap that cannot even list containers must not
   * block the run it precedes.
   *
   * NOT ON THE RUN'S CRITICAL PATH, AND NOT INSIDE ITS BUDGET — M23.3. Phase 4 prepended
   * `await reap()` to `run()` AFTER phase 3 had sized the trigger budget as
   * `timeoutMs + MANAGED_TRIGGER_GRACE_MS`, and no phase re-checked the sum. Reap's `ps` and every
   * `rm -f` were then spent out of the run's own budget: measured with `timeoutMs: 1_000` and four
   * stale orphans taking 9s each to remove, the budget (31s) expired at 31.2s with `create` NEVER
   * ISSUED. That failure MANUFACTURES ITS OWN WORKLOAD — the host's expiry SIGKILLs the subprocess,
   * the respawned successor mints a new {@link LAUNCHER_OWNER_ID}, and every container the dead
   * process had created is now FOREIGN, so it joins the next pass: the reaper's cost grows with
   * each timeout it causes. A cleanup mechanism that can prevent the thing it cleans up after from
   * starting is not a backstop, it is the failure.
   *
   * So `run()` SCHEDULES a pass and does not await it, and each pass is itself hard-bounded by
   * {@link RUNNER_REAP_BUDGET_MS} and single-flighted process-wide ({@link whenReapSettled}), which
   * is what stops the amplification: an arbitrarily slow or wedged sweep can no longer delay
   * `create` by so much as a tick, cannot consume a run's budget, and cannot stack up one pass per
   * concurrent run. This method itself stays awaitable and keeps returning the ids it removed —
   * that is what the tests and any future operator-facing sweep drive.
   *
   * Scheduled by the Docker adapter at the top of every {@link RunnerLauncher.run}, before `create`
   * — see `reaper.integration.test.ts` for why the mock recording seam (`docker-adapter.test.ts`)
   * cannot prove any of this: it cannot show that a killed process leaves a container, that a label
   * survives on it, or that a real `docker ps --filter` finds it. Returns the ids actually removed.
   */
  reap(): Promise<string[]>;
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
}

/**
 * How a plugin obtains the launcher for one run. A FUNCTION rather than a launcher instance because
 * a plugin object is constructed once (`createManagedIacExecutorPlugin()`) while its config arrives
 * per `trigger()` on `ctx.config` — the adapter therefore has to be resolved per run.
 *
 * This is also the injection seam the wiring tests drive: passing a resolver that throws must make a
 * NAMED test fail, which is the only check that distinguishes "the port is wired" from "the port
 * exists and the plugin still does it the old way" (CLAUDE.md's component-built-never-installed).
 */
export type ResolveRunnerLauncher = (config: RunnerLauncherConfig) => RunnerLauncher;

// ==================================================================================================
// PER-RUN IDENTITY — the caller's name for the run, and the container name derived from it.
// ==================================================================================================

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
 * THE HAZARD THIS INTRODUCES, NAMED RATHER THAN DISCOVERED LATER: because teardown is unconditional
 * and addresses a name the caller chose, a `create` that failed BECAUSE THE NAME WAS ALREADY TAKEN
 * will tear down the run that legitimately holds it. That is reachable only for two runs in flight
 * with the same `runId` — for managed-iac, two concurrent triggers with one `idempotencyKey` that
 * both miss the dedup cache. Retry-stable naming is what makes the fix work at all, so the two
 * cannot both be had; this is the documented cost of the trade, not an oversight.
 */
export function runnerContainerName(runId: string): string {
  return `${RUNNER_CONTAINER_NAME_PREFIX}${runId}`;
}

// ==================================================================================================
// THE ERROR — nothing leaves this package carrying a secret or a raw argv.
// ==================================================================================================

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
  /** Which step rejected. */
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
   * remained. It is a distinct fact from `killed`, which is also true when a single step blew a
   * per-call cap, and callers that retry need to tell them apart: a run that exhausted its budget
   * will exhaust it again at the same setting.
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

// ==================================================================================================
// THE ONE FAILURE A TEARDOWN MUST NEVER ANSWER — a `create` that lost the NAME to somebody else.
// ==================================================================================================

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
 * The transient `--env-file`. Mode 0600, under the CALLER's own governed state dir, and unlinked the
 * instant `create` returns — see {@link RunnerSpec.secretEnv} for exactly how partial a fix this is.
 *
 * `wx` refuses an existing file rather than truncating one: the path carries a fresh UUID, so an
 * existing file at it means something is very wrong and writing a credential into it is the last
 * thing to do.
 */
async function writeSecretEnvFile(
  dir: string,
  runId: string,
  entries: readonly string[]
): Promise<string> {
  await mkdir(dir, { recursive: true });
  const path = join(dir, `scp-secret-env-${runId}-${randomUUID()}`);
  await writeFile(path, `${entries.join("\n")}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  return path;
}

/**
 * The teardown call's own timeout, and it is NOT the run timeout — a tenant `timeoutMs` never
 * reaches `rm`. It also carries NO `maxBuffer`; both absences are pinned by all three goldens.
 *
 * IT IS ALSO THE ONLY WORK THAT HAPPENS AFTER THE WHOLE-RUN DEADLINE, which makes it the term every
 * outer budget has to carry on top of {@link RunnerSpec.timeoutMs}: `run()` returns within
 * `timeoutMs + RUNNER_REMOVE_TIMEOUT_MS`. Both {@link RUNNER_REAP_GRACE_MS} here and
 * `MANAGED_TRIGGER_GRACE_MS` in `apps/server/src/plugin-host/call-policy.ts` are derived from this
 * number, and the latter is gated against it by a test rather than by a comment.
 */
export const RUNNER_REMOVE_TIMEOUT_MS = 30_000;

/** The Docker adapter's default CLI. Server-injected in production; this is the unit-test fallback. */
export const DEFAULT_DOCKER_BINARY = "docker";

// ==================================================================================================
// THE REAPER'S LABELS AND IDENTITY — M23.1 PHASE 4. See {@link RunnerLauncher.reap} for the defect.
// ==================================================================================================

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
 * `now + spec.timeoutMs` computed once at the top of `run()`.
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
 * NOW IT IS ARITHMETIC INSIDE THIS ONE FILE. `run()` cannot outlive `runDeadline` by more than one
 * teardown, so the only term this has to cover is {@link RUNNER_REMOVE_TIMEOUT_MS} — 30s, declared
 * forty lines up rather than re-derived across a package boundary from a constant this package is
 * forbidden to import. Two minutes is four times that, and it also stays clear of
 * `MANAGED_TRIGGER_GRACE_MS` (the point at which the host gives up and SIGKILLs the subprocess,
 * `apps/server/src/plugin-host/call-policy.ts`), so a container is never reapable while the process
 * that owns it may still be alive. That second relationship is the one nothing here CAN enforce —
 * the import only goes the other way — so `call-policy.test.ts` gates it from the side that can.
 */
export const RUNNER_REAP_GRACE_MS = 2 * 60_000;

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
const LAUNCHER_OWNER_ID = randomUUID();

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
 */
export function whenReapSettled(
  dockerBinary: string = DEFAULT_DOCKER_BINARY
): Promise<readonly string[]> {
  return reapInFlight.get(dockerBinary) ?? Promise.resolve([]);
}

/**
 * THE DOCKER ADAPTER — `create` / `cp` in / `start -a` / `cp` out / `rm -f`, reproducing what the
 * three plugins each did, byte for byte. Every argv string and every options object below is what
 * the three `launch-argv.golden.test.ts` files recorded BEFORE this package existed; those goldens
 * are the proof, and they were not edited to make this pass.
 *
 * Never a `-v` bind mount, never a docker socket, always the caller's resolved `--network`: a
 * host-path escape stays structurally impossible because nothing is mounted, only copied.
 */
export function createDockerRunnerLauncher(
  dockerBinary: string = DEFAULT_DOCKER_BINARY
): RunnerLauncher {
  /**
   * See {@link RunnerLauncher.reap}. Lists every container THIS PACKAGE labelled (any owner), then
   * removes exactly the ones that are BOTH foreign (owner != {@link LAUNCHER_OWNER_ID}) AND past
   * their deadline. A container with a missing or unparsable deadline is left alone — the same
   * fail-closed direction as everything else in this file: an ambiguous label must never read as
   * "safe to destroy".
   */
  const reapOnce = async (): Promise<string[]> => {
    /** THE PASS's OWN DEADLINE — see {@link RUNNER_REAP_BUDGET_MS}. Bounding the individual calls
     *  bounds nothing when the number of calls is the unbounded term. */
    const passDeadline = Date.now() + RUNNER_REAP_BUDGET_MS;
    let listing: string;
    try {
      listing = (
        await execFileAsync(
          dockerBinary,
          [
            "ps",
            "-a",
            "--filter",
            `label=${RUNNER_LAUNCHER_OWNER_LABEL}`,
            "--format",
            `{{.ID}}\t{{.Label "${RUNNER_LAUNCHER_OWNER_LABEL}"}}\t{{.Label "${RUNNER_LAUNCHER_DEADLINE_LABEL}"}}`
          ],
          { timeout: RUNNER_REMOVE_TIMEOUT_MS }
        )
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
      if (!Number.isFinite(deadlineMs) || deadlineMs > now) continue; // missing/garbled/future -> leave it
      targets.push(id);
    }

    const removed: string[] = [];
    for (const id of targets) {
      // STOP, DO NOT TRUNCATE THE TIMEOUT. What is left is still expired, still labelled and still
      // findable, so the next pass collects it; a pass that kept going with a 1ms `timeout` would
      // turn every remaining orphan into a kill-and-retry instead of leaving it alone.
      if (Date.now() >= passDeadline) {
        debug("reap: pass budget spent with %d target(s) left, leaving them for the next pass",
          targets.length - removed.length);
        break;
      }
      try {
        await execFileAsync(dockerBinary, ["rm", "-f", id], { timeout: RUNNER_REMOVE_TIMEOUT_MS });
        removed.push(id);
      } catch (cause) {
        debug("reap: rm -f %s failed, leaving it for the next pass: %O", id, cause);
      }
    }
    return removed;
  };

  /** {@link reapOnce}, single-flighted per binary through {@link reapInFlight} — see that map's
   *  own doc for why a per-launcher guard would guard nothing. */
  const reap = async (): Promise<string[]> => {
    const joined = reapInFlight.get(dockerBinary);
    if (joined) return joined;
    const pass = reapOnce().finally(() => {
      if (reapInFlight.get(dockerBinary) === pass) reapInFlight.delete(dockerBinary);
    });
    reapInFlight.set(dockerBinary, pass);
    return pass;
  };

  return {
    reap,
    async run(spec: RunnerSpec): Promise<RunnerResult> {
      // SCHEDULED AT THE TOP, BEFORE `create`, AND NOT AWAITED — M23.1 phase 4's placement, M23.3's
      // coupling. The placement is still right: one place, reached before the next container this
      // process makes and — because the host respawns a SIGKILLed subprocess with backoff — within
      // one retry of the very event that orphans a container. The `await` was not: reap's `ps` and
      // every `rm -f` were spent out of the run's own budget, and with four stale orphans a run
      // could exhaust it with `create` never issued (measurement in {@link RunnerLauncher.reap}).
      // `void`, not `await`: the sweep is idempotent, single-flighted and hard-bounded, and it can
      // now delay `create` by no ticks at all. `reap()` never rejects; the `.catch` is for the case
      // where some future edit makes it able to, so an unhandled rejection can never take the
      // subprocess down over a cleanup pass.
      void reap().catch((cause) => debug("reap: background pass rejected: %O", cause));

      /**
       * THE WHOLE-RUN DEADLINE — the one clock in this function, read once and never recomputed.
       * See {@link RunnerSpec.timeoutMs}: `timeoutMs` is the budget for the RUN, not for each of
       * the four-to-six `execFile`s a run issues, and the ONLY reason the host's RPC budget and the
       * container's own reap stamp are now correct is that this line makes them derivable.
       */
      const runDeadlineAt = Date.now() + spec.timeoutMs;
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
        options: { timeout: number; maxBuffer?: number }
      ): Promise<{ stdout: string; stderr: string }> => {
        try {
          return await execFileAsync(dockerBinary, argv, options);
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
       * M23.3's HIGH-1 fix. `options` carries NO `timeout`: each caller below used to hand in
       * `spec.timeoutMs` and get a fresh, FULL budget of its own, so k sequential steps meant a
       * k x timeoutMs run and no bound on the sum.
       *
       * THREE THINGS AT EXHAUSTION, and the first two are traps rather than taste:
       *   - `timeout: 0` IS NOT "no time left", IT IS NO TIMEOUT AT ALL. Measured on the running
       *     Node: `execFile(…, { timeout: 0 })` let a 1.5s child run to completion. A naive
       *     `deadline - now` therefore turns the instant the budget runs out into an UNBOUNDED call
       *     — the precise defect, restored, at the one moment it does the most damage.
       *   - A NEGATIVE `timeout` THROWS SYNCHRONOUSLY (`ERR_OUT_OF_RANGE`), outside the try below,
       *     as a raw error carrying an unredacted argv in its message.
       *   - So a step reached with nothing left is REFUSED BEFORE IT IS ISSUED, with a message that
       *     names the budget and the deadline rather than a bare `Command failed: docker cp …`.
       *     Between the two, `Math.max(1, …)` guarantees what Node is handed is in range, never 0.
       */
      const exec = async (
        step: RunnerLaunchStep,
        argv: string[],
        options: { maxBuffer?: number }
      ): Promise<{ stdout: string; stderr: string }> => {
        const remaining = runDeadlineAt - Date.now();
        if (remaining <= 0) {
          throw new RunnerLaunchError({
            step,
            file: dockerBinary,
            argv,
            deadlineExceeded: true,
            cause: new Error(
              `whole-run budget of ${spec.timeoutMs}ms (RunnerSpec.timeoutMs) was already spent ` +
                `at the run deadline ${new Date(runDeadlineAt).toISOString()} — '${step}' was not issued`
            ),
            redactions: redactions()
          });
        }
        try {
          return await execFileAsync(dockerBinary, argv, {
            ...options,
            timeout: Math.max(1, remaining)
          });
        } catch (cause) {
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
          const deadlineExceeded = e.killed === true && Date.now() >= runDeadlineAt;
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
                    `whole-run budget of ${spec.timeoutMs}ms (RunnerSpec.timeoutMs) ran out during ` +
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

      // 1. STAGE THE SECRETS OFF THE COMMAND LINE (M23.0 defect 3). Before the `try`, so a failure
      //    here tears nothing down — no container has been asked for yet.
      if (spec.secretEnv.length > 0) {
        if (!spec.secretEnvDir) {
          refuse("secretEnv was supplied without secretEnvDir — refusing to choose a directory");
        }
        try {
          envFilePath = await writeSecretEnvFile(spec.secretEnvDir!, spec.runId, spec.secretEnv);
        } catch (cause) {
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
          if (envFilePath) await unlink(envFilePath).catch(() => undefined);
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
        //    non-zero runner rejects here and is captured as `succeeded: false` with its stderr.
        let succeeded: boolean;
        let stdout: string;
        let stderr: string;
        try {
          const r = await exec("start", ["start", "-a", containerId], { maxBuffer });
          succeeded = true;
          stdout = redact(r.stdout);
          stderr = redact(r.stderr);
        } catch (err) {
          // ALREADY REDACTED, and the `?? ""` / `?? message` falls already applied — they moved into
          // {@link RunnerLaunchError} so that a captured failure and a thrown one cannot drift apart.
          const e = err as RunnerLaunchError;
          succeeded = false;
          stdout = e.stdout;
          stderr = e.stderr;
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

        return { succeeded, stdout, stderr };
      } finally {
        // 6. Destroy the container unconditionally — BY NAME, which is the identity that exists even
        //    when `create` is what failed. `docker rm -f` on a name that never existed exits ZERO
        //    (measured, Docker 29.5.2), so the no-container case costs one harmless daemon call.
        // SWALLOWED, but not SILENT: a failed teardown here means a container may be about to
        // orphan — `reap()` is the backstop, but the reason THIS teardown failed had nowhere to go
        // before this line, which is a defect the same shape as the one this whole phase exists to
        // close (a hazard with no reader). `NODE_DEBUG=scp-runner-launcher` surfaces it.
        //
        // AND EXACTLY ONE THING IT MUST NOT DO — M23.3. `create` failing BECAUSE THE NAME IS
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
          await execFixed("teardown", ["rm", "-f", containerName], {
            timeout: RUNNER_REMOVE_TIMEOUT_MS
          }).catch((cause) => {
            debug("teardown: rm -f %s failed: %O", containerName, cause);
          });
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
export type RecordOutcome = (succeeded: boolean, detail: string) => void | Promise<void>;

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
    await opts.record(false, opts.redact(message));
    return undefined;
  }
}
