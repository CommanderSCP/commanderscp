import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, stat, unlink, writeFile } from "node:fs/promises";
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
  /**
   * THE WHOLE-RUN BUDGET — the maximum wall clock {@link RunnerLauncher.run} may spend on this run,
   * from the moment it is called to the moment it returns, teardown excepted. 10 min for
   * managed-iac and managed-scan, 5 min for managed-dep.
   *
   * IT USED TO BE A PER-CALL BOUND, AND THAT IS THE DEFECT M23.1e EXISTS TO CLOSE. Every `execFile`
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
   * `deadline = now + clampRunTimeoutMs(timeoutMs)` ONCE, at the top of `run()`, and every
   * `execFile` it issues gets `timeout: deadline - now` — never `spec.timeoutMs`, and never `0`,
   * which Node reads as NO TIMEOUT AT ALL (measured on the running Node 26.7.0: `{ timeout: 0 }`
   * let a 1.5s child run to completion). A step reached with the budget already spent is REFUSED
   * before it is issued, with a {@link RunnerLaunchError} carrying
   * {@link RunnerLaunchError.deadlineExceeded}.
   *
   * THE TWO NUMBERS DERIVED FROM THIS ONE — the host's RPC budget (`call-policy.ts`) and the
   * container's own {@link RUNNER_LAUNCHER_DEADLINE_LABEL} — ARE CORRECT BY CONSTRUCTION UP TO A
   * CEILING, AND {@link clampRunTimeoutMs} IS WHAT MAKES THE CEILING TRUE. The sentence that used to
   * end this paragraph said the two were "correct BY CONSTRUCTION rather than because a padding
   * constant happened to be big enough". The construction was sound for every value BELOW
   * {@link MANAGED_RUN_TIMEOUT_MAX_MS}, which is not the same as every value in the database:
   * `call-policy.ts` clamped its OWN return value and the three plugins handed the STORED number to
   * this field untouched, so above the ceiling the two derived numbers diverged by hours rather than
   * by a padding constant. The clamp now runs inside `run()`, so a caller cannot skip it and a
   * second adapter cannot forget it.
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

/**
 * What a runner run produced. `succeeded` is the runner's own exit status, not the launch's.
 *
 * A UNION, NOT A FLAG PLUS AN OPTIONAL FIELD — MEDIUM (verification pass 5). `start` is the only
 * step whose failure is CAPTURED rather than thrown, and it is the step that consumes essentially
 * all of a real run's budget; it used to be captured as `{ succeeded: false, stdout, stderr }` and
 * nothing else. `promisify(execFile)` ALWAYS attaches `stderr` as a string, so for the two shapes an
 * operator most needs explained — our own budget killing the runner, and a spawn that never happened
 * — that string is `""`. Measured through the real adapter:
 *
 *     budget-killed `start`, no output   -> {"succeeded":false,"stdout":"","stderr":""}
 *     runner exits 3 silently            -> {"succeeded":false,"stdout":"","stderr":""}
 *
 * Byte-identical, and through the real plugins that becomes `phase:"failed", detail:""` in the
 * durable ledger, in `status()`, and from there in `reconcile.ts`'s `insertDecision` `inputContext`
 * — the record charter principle 6 exists for, reading as if nothing went wrong at all.
 *
 * Making {@link RunnerFailure} a member of the FAILED arm rather than an optional property is what
 * stops that recurring: a caller cannot reach a failed result without also having the diagnosis in
 * hand, and a future adapter cannot construct a failure without producing one. `stdout`/`stderr`
 * stay exactly what the child printed (still possibly `""` — that is a true fact about the child);
 * the never-empty explanation is {@link RunnerFailure.detail}.
 */
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
   * NOT ON THE RUN'S CRITICAL PATH, AND NOT INSIDE ITS BUDGET — M23.1e. Phase 4 prepended
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
   *
   * ALSO SWEEPS THE TRANSIENT `--env-file` (MEDIUM-4) — the SAME hazard, one level down. A SIGKILL
   * between {@link writeSecretEnvFile} and the `finally` that unlinks it leaves a plaintext
   * credential on disk with nothing left to remove it, for exactly the reason a killed `run()`
   * leaves an orphaned container: no `finally` executes. ONE cleanup concept, not two — this is the
   * SAME method, not a second one, because a reaper that only knew about containers would leave the
   * higher-value target (a live credential, not a stopped process) uncovered.
   *
   * `secretEnvDir`, WHEN GIVEN, is swept for `scp-secret-env-*` files older than
   * {@link RUNNER_SECRET_ENV_MAX_AGE_MS} — mtime-based, deliberately, rather than a registry: a
   * registry lives in the SAME process memory a SIGKILL erases, so it could never identify what a
   * DEAD process left behind. mtime survives the kill because it is a property of the file itself.
   * The age bound is conservative in the same direction the container deadline is: no run still
   * inside its own budget can make its own file look stale, so a live run's file is never a
   * candidate — the same "ambiguous must never read as safe" rule as a missing/garbled container
   * deadline label. That budget is bounded by {@link MANAGED_RUN_TIMEOUT_MAX_MS} because `run()`
   * applies {@link clampRunTimeoutMs} to `spec.timeoutMs` itself; see
   * {@link RUNNER_SECRET_ENV_MAX_AGE_MS} for what this used to rest on instead and why that was
   * false.
   *
   * Called by the Docker adapter with the CURRENT run's own `spec.secretEnvDir` every time — never
   * a directory this method chooses, for the same reason `writeSecretEnvFile` refuses to choose
   * one. Absent (the caller's own `reap()` calls in tests, and any run whose spec carries no
   * `secretEnvDir`) simply skips the file sweep; the container sweep is unaffected either way.
   */
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

// ==================================================================================================
// THE DIAGNOSIS AN OPERATOR READS — four ways to fail that used to be one empty string.
// ==================================================================================================

/**
 * `code` on a maxBuffer overflow. Node's own constant name, and the PRODUCT's copy of it: the table
 * in `docker-adapter.test.ts` imports this rather than restating it, so "THE TABLE IS NOT FICTION"
 * (which spawns a real child and compares `code` against the live Node) checks the string this
 * classifier actually branches on. A second copy in the test would have made that check verify the
 * fixture instead of the product.
 */
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
 */
export type RunnerFailureKind =
  "budget-exhausted" | "output-exceeded" | "signalled" | "spawn-failed" | "exit-nonzero";

/** The classified failure a caller records. See {@link classifyRunnerFailure}. */
export interface RunnerFailure {
  readonly kind: RunnerFailureKind;
  /**
   * ONE REDACTED LINE, NEVER EMPTY — the string a plugin puts in its outcome store and `status()`
   * hands to `reconcile.ts`. Never-empty is the property, not a nicety: the whole defect is that
   * `""` was the recorded reason for the two shapes that most need explaining.
   */
  readonly detail: string;
  /** Which step failed, so the detail is not the only place the answer lives. */
  readonly step: RunnerLaunchStep;
  /** Node's own `code`, carried across so a caller can branch without re-parsing `detail`. */
  readonly code: string | number | null | undefined;
  readonly signal: string | null | undefined;
  /** {@link RunnerLaunchError.deadlineExceeded}, i.e. `kind === "budget-exhausted"`. Kept as its own
   *  field because it is the one fact a caller is most likely to want as a boolean. */
  readonly deadlineExceeded: boolean;
}

/** Human wording per kind. Separate from the enum so the machine-readable name never has to be a
 *  sentence and the sentence never has to be stable. */
const FAILURE_WORDING: Record<RunnerFailureKind, string> = {
  "budget-exhausted": "the whole-run budget ran out and the runner was stopped mid-flight",
  "output-exceeded": "the runner printed more than maxBuffer allows, so its output is TRUNCATED",
  signalled: "the runner was killed by a signal that was not this run's own budget",
  "spawn-failed": "the container CLI could not be executed at all — nothing ran",
  "exit-nonzero": "the runner itself exited non-zero"
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
 *   1. `deadlineExceeded` FIRST, because a budget kill also sets `killed: true` and would otherwise
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
 * THE TAIL, NOT THE WHOLE THING: `maxBuffer` is up to 32 MiB and every consumer slices this to
 * 2000-4000 characters from the FRONT, so carrying megabytes would cost memory to produce something
 * that is then thrown away — and the useful end of a `tofu apply` or a Trivy failure is the LAST
 * lines, which a front-slice would discard. The `includes` check is itself skipped above the cap,
 * because a substring search over 32 MiB to save an append is the wrong trade.
 */
/** How much of the child's own output {@link classifyRunnerFailure} appends. See its doc. */
const FAILURE_OUTPUT_TAIL_CHARS = 2_000;
export function classifyRunnerFailure(err: RunnerLaunchError): RunnerFailure {
  const kind: RunnerFailureKind = err.deadlineExceeded
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
    suffix = ` :: runner output${tail.length < output.length ? " (tail)" : ""}: ${tail}`;
  }

  return {
    kind,
    step: err.step,
    code: err.code,
    signal: err.signal,
    deadlineExceeded: err.deadlineExceeded,
    detail:
      `${kind}: ${FAILURE_WORDING[kind]} during '${err.step}' (${facts.join(", ")}) — ` +
      `${err.message}${suffix}`
  };
}

/**
 * THE ONE STRING A CALLER RECORDS FOR A RUN, whatever became of it — success or any of the five
 * failure kinds. Exported because all three plugins need the same answer and each of them used to
 * spell it `result.succeeded ? result.stdout : result.stderr`, which is precisely the expression
 * that produced `""`.
 *
 * On SUCCESS this is the runner's own stdout, unchanged, because that is the evidence
 * (`tofu plan` output, a scan summary) the previous behaviour correctly recorded.
 */
export function runnerOutcomeDetail(result: RunnerResult): string {
  return result.succeeded ? result.stdout : result.failure.detail;
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
 * Every `--env-file` this package ever writes carries this prefix and nothing else does — it is
 * what lets {@link RunnerLauncher.reap}'s sweep (MEDIUM-4) recognise its own leftovers in a
 * directory it does not otherwise own without touching a single byte it did not create.
 */
const SECRET_ENV_FILE_PREFIX = "scp-secret-env-";

/**
 * The transient `--env-file`. Mode 0600, under the CALLER's own governed state dir, and unlinked the
 * instant `create` returns — see {@link RunnerSpec.secretEnv} for exactly how partial a fix this is,
 * and for what happens when the process is killed before that unlink runs.
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
  const path = join(dir, `${SECRET_ENV_FILE_PREFIX}${runId}-${randomUUID()}`);
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
        debug(
          "reap: pass budget spent with %d target(s) left, leaving them for the next pass",
          targets.length - removed.length
        );
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
      entries = await readdir(dir);
    } catch (cause) {
      debug("reap: listing secret-env dir %s failed, skipping this pass: %O", dir, cause);
      return;
    }
    const now = Date.now();
    for (const name of entries) {
      if (!name.startsWith(SECRET_ENV_FILE_PREFIX)) continue; // not ours — never a candidate
      const path = join(dir, name);
      try {
        const info = await stat(path);
        // A LIVE run's file is NEVER this old — see {@link RUNNER_SECRET_ENV_MAX_AGE_MS}. An
        // ambiguous or just-created file is left alone, the same fail-closed direction as a
        // missing/garbled container deadline label.
        if (now - info.mtimeMs < RUNNER_SECRET_ENV_MAX_AGE_MS) continue;
        await unlink(path);
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

      /**
       * THE BUDGET THIS RUN IS ACTUALLY HELD TO — `spec.timeoutMs` with the product ceiling applied,
       * read ONCE so that every number derived below derives from the same one. See
       * {@link clampRunTimeoutMs} for the measurement: the ceiling used to be enforced on the host's
       * RPC budget and on NEITHER of the two numbers this function derives, so a stored `timeoutMs`
       * above it produced a container stamped hours past the SIGKILL that orphaned it.
       */
      const runTimeoutMs = clampRunTimeoutMs(spec.timeoutMs);
      /**
       * THE WHOLE-RUN DEADLINE — the one clock in this function, read once and never recomputed.
       * See {@link RunnerSpec.timeoutMs}: the budget is for the RUN, not for each of the four-to-six
       * `execFile`s a run issues, and the ONLY reason the host's RPC budget and the container's own
       * reap stamp are now correct is that this line makes them derivable.
       */
      const runDeadlineAt = Date.now() + runTimeoutMs;
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
       * M23.1e's HIGH-1 fix. `options` carries NO `timeout`: each caller below used to hand in
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
       *
       * THE `Math.max(1, …)` BELOW IS UNREACHABLE, AND IS KEPT ANYWAY — said plainly, because a
       * reader who takes it for live code will look for the test that covers it and find none, and
       * because mutating it away changes no behaviour whatsoever. `Date.now()` is integral, so past
       * the refusal above `remaining` is an integer >= 1 and the clamp is the identity function.
       * What it buys is the one boundary no test can reach: move the refusal by a single character
       * (`<= 0` to `< 0`) and `remaining === 0` — one instant of the clock, unhittable on purpose
       * and perfectly hittable by accident — becomes `timeout: 0`, i.e. NO BOUND AT ALL, on a
       * `docker start -a` that is running `tofu apply`. The clamp costs nothing and makes that
       * instant harmless. The refusal is the part with the teeth, and the part the tests drive.
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
              `whole-run budget of ${runTimeoutMs}ms (RunnerSpec.timeoutMs) was already spent ` +
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
