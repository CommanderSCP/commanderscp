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

// --------------------------------------------------------------------------------------------
// THE ONE BOUND, CHOSEN ONCE, HERE — and it keeps BOTH ENDS.
// --------------------------------------------------------------------------------------------

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

/**
 * HOW MUCH OF A BOUNDED DETAIL'S END IS SACRED. The useful end of a `tofu apply`, a Trivy run or an
 * `npm` failure is its LAST lines; a front-slice discards exactly the diagnosis. So this many
 * characters at the END survive every bound this module applies, and anything that has to go goes
 * from the MIDDLE.
 */
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

/**
 * BOUND A DETAIL, KEEPING BOTH ENDS — the head (who failed, doing what, with which argv) and the
 * last {@link RUNNER_DETAIL_TAIL_CHARS} characters (the diagnosis). What is dropped is the middle,
 * which for a runner failure is the noise the tool printed on its way to the error.
 *
 * IDEMPOTENT BY CONSTRUCTION: the result is never longer than the cap, so a second application is
 * the identity. That is what makes it safe to apply at every trust boundary — the port, each
 * plugin's store, the server's Decision write — WITHOUT recreating the defect this fixes, because
 * they are the same bound and not three different slices.
 *
 * PERSISTABLE BY CONSTRUCTION TOO, and that half is a HIGH regression fix, not a nicety. The bound
 * slices at UTF-16 CODE-UNIT offsets, so both cuts — head and tail — can land in the middle of a
 * surrogate pair. Four emoji in 8 KB of `tofu` output is enough. The product was an ill-formed
 * string, which `jsonb` refuses, which threw inside `reconcileExecutingChange`'s `withTenantTx` —
 * rolling back the `updateWaveTargetObserved` in the same transaction. Measured end to end: the
 * wave target NEVER terminalised, the poll re-threw every tick forever, and the only trace was a
 * `console.error` behind a green health check. That is this repository's own worked example
 * (BUILD_AND_TEST.md §4.4a) — a coordination loop stopped for 13 days behind passing checks.
 *
 * Sanitising is applied to the RESULT, not the input, for three reasons: it is at most
 * {@link RUNNER_DETAIL_MAX_CHARS} long so the scan is bounded even for an 8 MB input; it catches
 * the damage this function itself does at the two cuts; and it catches an input that was ALREADY
 * ill-formed or NUL-carrying, including one short enough to skip the slice entirely — a plugin can
 * hand us a detail decoded from a binary stream, and `text.length <= MAX` was previously a straight
 * pass-through for it.
 */
export function boundDetail(text: string): BoundedDetail {
  return boundText(text, RUNNER_DETAIL_MAX_CHARS, RUNNER_DETAIL_TAIL_CHARS) as BoundedDetail;
}

/**
 * THE SAME BOUND AT AN ARBITRARY WIDTH — ONE implementation serving the operator-facing `detail`
 * ({@link boundDetail}), the per-string share of a whole persisted structure
 * ({@link boundPersistedJson}), and any other place that needs to cut a string short before storing
 * it. `boundDetail` is this function at
 * ({@link RUNNER_DETAIL_MAX_CHARS}, {@link RUNNER_DETAIL_TAIL_CHARS}).
 *
 * EXPORTED BECAUSE THE ALTERNATIVE IS ANOTHER BARE `.slice`, and a bare slice at a UTF-16 CODE-UNIT
 * offset is the defect this whole family of fixes is about: it cuts surrogate pairs, `jsonb`
 * refuses the row, and the write throws inside whatever transaction it was in. A filterless census
 * of "slice a string at a code-unit offset, then persist it" found a second live instance in
 * `apps/server/src/dependencies/version-index-feed.ts`, so the primitive is offered rather than
 * left private for each caller to re-invent.
 *
 * `tailChars` of 0 gives a HEAD-ONLY bound with an honest elision count — the right shape for a
 * short diagnostic preview, where a reserved tail would leave almost no head.
 */
export function boundText(text: string, max: number, tailChars: number): string {
  if (max <= 0) return "";
  if (text.length <= max) return persistableText(text);
  // `elisionMarker(text.length)` is the longest the marker can be (the count only shrinks), so
  // sizing the head against it guarantees the result fits even before the real count is known.
  const widest = elisionMarker(text.length);
  if (max <= widest.length + 2) {
    // Too narrow to carry both ends AND an honest count. Keep the END: for a runner failure, a
    // provider refusal or an exception message, the diagnosis is what the last characters hold.
    return persistableText(text.slice(text.length - max));
  }
  const tail = Math.min(tailChars, max - widest.length - 1);
  const headShare = Math.max(0, max - tail - widest.length);
  const dropped = text.length - headShare - tail;
  // The elision count stays arithmetically honest through sanitising precisely because
  // `persistableText` is length-preserving: `keptHead + dropped + keptTail === text.length` still.
  return persistableText(
    text.slice(0, headShare) + elisionMarker(dropped) + text.slice(text.length - tail)
  );
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
 * field: `JSON.stringify(boundPersistedJson(v)).length <= PERSISTED_JSON_MAX_CHARS`, always,
 * checked exactly before returning.
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

/** No object KEY may be longer than this. Keys are plugin-chosen too, and a key is not a place a
 *  reader looks for content, so it gets a much smaller share than a value. */
const PERSISTED_JSON_MAX_KEY_CHARS = 128;

/** Never start a new element/field with less than this much budget left: enough for a short marker
 *  and its punctuation, so the elision itself can never be what pushes the row over. */
const PERSISTED_JSON_MIN_LEAF = 96;

/** The key an over-budget object carries instead of the fields that did not fit. Exported so a
 *  test — or an operator's query — can find rows that were elided, rather than having to guess
 *  from a suspiciously short value. */
export const PERSISTED_JSON_ELIDED_KEY = "__scpElided";

/** The entry an over-budget ARRAY carries in place of its dropped tail. One function, so the marker
 *  and its recogniser below cannot drift apart. */
function entriesElisionMarker(dropped: number): string {
  return `[elided: ${dropped} more entries]`;
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
 * WHAT ONE FIELD OF AN OBJECT MAY SPEND — MEDIUM, M23.0 verification passes 8, 9 and 10, and the
 * reason this is a SHARE rather than "whatever is left".
 *
 * WHAT WENT WRONG, MEASURED. The walk used to spend one budget in INSERTION ORDER: each field took
 * as much as it wanted and, once the remainder fell under {@link PERSISTED_JSON_MIN_LEAF}, every
 * field still unwalked was replaced wholesale by {@link PERSISTED_JSON_ELIDED_KEY}. `observedStateFrom`
 * builds `{revision, images, rollout}` in that order, so `rollout` was always the first thing
 * dropped — and `rollout.weight` is the leaf ADR-0028's `minWeight` gate reads. End to end through
 * the fake-executor seam against real Postgres, 80 image refs of ordinary shape
 * (`ghcr.io/acme/platform/service-N@sha256:<64>`) plus a canary at weight 60:
 *
 *   before  images, rollout, revision, observedAt   weight 60     min_weight         satisfied TRUE
 *   after   images, revision, observedAt, __scpElided  undefined  weight_unreadable  satisfied FALSE
 *
 * Threshold: 73 refs. Not hostile input — `status.summary.images` on an Argo CD Application is the
 * uncapped image list across every managed resource, and an umbrella app with 73+ images containing
 * a Rollout is ordinary. A long `revision` does NOT reach it (each string is separately capped at
 * {@link RUNNER_DETAIL_MAX_CHARS}), so an array is the only route in, which is why READING the code
 * did not surface it.
 *
 * ============================================================================================
 * THE RULE — WATER-FILLING IN TWO PHASES (arrived at over three corrections; pass 10 is this one)
 * ============================================================================================
 *   PHASE 1 SEATS THE KEYS AND CHARGES NOTHING ELSE. A key is seated only while
 *   {@link PERSISTED_JSON_MIN_LEAF} of budget remains available for it AND for every key already
 *   seated. The first key that fails that test turns itself and everything after it into
 *   {@link PERSISTED_JSON_ELIDED_KEY}.
 *
 *   PHASE 2 DIVIDES WHAT IS LEFT EQUALLY BETWEEN THE SEATED FIELDS, walks all of them, and then
 *   RE-DIVIDES what the satisfied ones did not want between the ones that are still short,
 *   repeating while somebody finishes. That is max-min fairness: at the end every field is either
 *   SATISFIED (it took less than its share and kept everything) or holds an EQUAL share of what the
 *   satisfied fields left behind. Neither outcome can be influenced by where a field sits.
 *
 * WHY PASS 2 EXISTS, MEASURED (pass 9). Pass 8 shipped phase 1 alone, as a CEILING with no way
 * back, and a ceiling throws away whatever the small fields do not want. `observedStateFrom` puts
 * `images` in the MIDDLE of `{revision, images, rollout}`: `images` was capped at ~1/2 the budget
 * while `revision` + `rollout` spent ~110 of the ~3 950 they were handed, and those ~3 840
 * characters were never returned. End to end through the fake-executor seam against real Postgres,
 * 40 refs — a case that had NEVER been broken, because at 40 refs the pass-8 defect did not bite:
 *
 *   pass 7 (one budget)        40/40 images kept   row 4 659   resolveReleasedVersion  determined
 *   pass 8 (share as ceiling)  34/40 images kept   row 4 063   resolveReleasedVersion  REFUSED
 *   pass 9 (redistribution)    40/40 images kept   row 4 659   resolveReleasedVersion  determined
 *
 * For every n in 35…69 that was a strict loss with no compensating benefit, and the loss is the
 * fail-SILENT one: a coordinate whose ref fell past the cut yields `observed_images_elided`,
 * `latest_version` is never determined and dependants are never bumped.
 *
 * ============================================================================================
 * WHY THE KEYS ARE CHARGED FIRST — HIGH, PASS 10. IT IS THE WHOLE OF PROPERTY (2).
 * ============================================================================================
 * Passes 8 and 9 walked field `i` against `floor(left / n)` where `left` was the budget REMAINING
 * at that point in a single in-order loop. Two order-dependent consequences followed, and neither
 * is visible in the row's LENGTH: a field that underspent raised every LATER field's share, and the
 * LAST field was handed the entire remainder rather than a share at all. Measured on
 * `{a: 4 000-char string, b: 4 000-char string, phase, step}` over all 24 permutations, on pass 9
 * plus this round's {@link boundStringToCost} correction:
 *
 *   a 3 858 / b 4 000    4 orders                        row 7 904
 *   a 3 929 / b 3 929   16 orders   <- the fair answer    row 7 904
 *   a 4 000 / b 3 858    4 orders                        row 7 904
 *
 * The ROW IS THE SAME SIZE in all three, so no length or utilisation assertion can see it, and each
 * is a different answer to "how much of `a` survived". The reorder alternative below is rejected
 * BECAUSE it makes source-line order a load-bearing contract — a rejection this design has to earn
 * rather than assert. Charging the keys up front is what earns it: the sum of the key costs is the
 * same in every permutation, so the pool phase 2 divides is a FIXED number, and phase 2 never reads
 * `budget.left` again. All 24 permutations are now byte-identical, pinned by
 * `persisted-json-bound.test.ts` -> "ORDER-INDEPENDENT RETENTION ... TWO TRUNCATED STRINGS".
 *
 * ============================================================================================
 * A {@link PERSISTED_JSON_MIN_LEAF} FLOOR, WHICH PASS 9 DELIBERATELY DID NOT HAVE. REVERSED, WITH
 * THE MEASUREMENT THAT REVERSED IT.
 * ============================================================================================
 * Pass 9 argued that an equal SLIVER is order-independent at every budget while a floor re-creates
 * insertion-order starvation at a tighter budget. The first half is true and the second half is
 * what phase 1 now owns; what the argument missed is what a sliver actually stores. Charging the
 * keys first makes it visible — 5 000 fields of `"v".repeat(50)` at the 8 000 budget:
 *
 *   sliver (pass 9)   793 keys seated, 792 of them the EMPTY STRING, row 7 844
 *   floor  (pass 10)   77 keys seated, every one of them its whole 50-character value
 *
 * `"k123": ""` in a governed row does not read as "this was cut". It reads as an observation — the
 * executor reported an empty value — which is the provenance-label defect this repository has
 * already shipped once (charter principle 6). `__scpElided: "4924 more fields"` says what actually
 * happened. A floor is therefore the honest rule, and phase 1 applies it to the KEY SEATING rather
 * than to the share, which is what keeps it from being insertion-order starvation: the decision
 * reads key costs ONLY and never looks at a value, so property (1) is now strictly true — a key is
 * never elided because a SIBLING'S VALUE was large, at any budget.
 *
 * ITS RESIDUE, STATED. The seated set is a PREFIX in insertion order, so when keys differ wildly in
 * LENGTH (the 5 000-character-key case) which ones are seated still varies with order. Values never
 * influence it. Pinned as a bound rather than left to be discovered:
 * `persisted-json-bound.test.ts` -> "KEY LENGTH, NOT VALUE SIZE".
 *
 * ============================================================================================
 * THE PROPERTIES, STATED SO A REVIEWER CAN FALSIFY THEM.
 * ============================================================================================
 *   (1) NO OBJECT KEY IS ELIDED BECAUSE A SIBLING WAS LARGE. A key can still be elided when an
 *       object has more keys than the budget can seat at {@link PERSISTED_JSON_MIN_LEAF} each —
 *       8 000 chars will not hold 200 fields however it is divided — but that is a different fact,
 *       it is decided by the KEYS alone, and it is visible in the row as `__scpElided`.
 *   (2) RETENTION DOES NOT DEPEND ON INSERTION ORDER — not just which keys survive, but how much of
 *       each survives, byte for byte. Pass 8 failed this on array contents (the same three fields
 *       kept 26, 39 or 77 of 80 image refs depending only on where `images` sat); pass 9 failed it
 *       on string contents (the 24-permutation table above). Pinned over all six permutations of a
 *       3-field object AND all 24 of a 4-field one, with an ARRAY-shaped large field and with
 *       STRING-shaped ones, by `persisted-json-bound.test.ts`. The one carve-out is the key-length
 *       residue named above.
 *   (3) BUDGET UTILISATION. A value that overflows BECAUSE A FIELD WANTED MORE THAN ITS SHARE
 *       leaves at most one field's worth of the budget unspent, rather than a fixed fraction of it.
 *       Measured at the 8 000 budget: 400 image refs beside a revision and a rollout spend 7 870;
 *       two 4 000-character strings beside two small fields spend 7 904; a single string field at
 *       budget B spends exactly `B - PERSISTED_JSON_MIN_LEAF`.
 *
 *       NARROWED, BECAUSE MEASUREMENT FALSIFIES THE UNQUALIFIED FORM. In the ELISION regime —
 *       phase 1 could not seat every key — phase 1 has reserved {@link PERSISTED_JSON_MIN_LEAF} for
 *       each key it DID seat, and a field that turns out to want less than that leaves the
 *       difference unspent. The residue is bounded by `MIN_LEAF x seated`, and the worst shape for
 *       it is many long keys with tiny values: 50 keys of 5 000 characters with one-character
 *       values seats 35 of them and spends 4 554 of 8 000 (57 %), against 6 651 (83 %) under pass
 *       9's sliver rule. That is the price of the floor, it is paid only where the row already says
 *       `__scpElided`, and it is pinned as a FLOOR ON UTILISATION by
 *       `persisted-json-bound.test.ts` -> "THE ELISION REGIME'S UTILISATION RESIDUE", so it cannot
 *       silently grow. Recovering it needs a second seat-and-fill sweep, which is a mutable cursor
 *       through the most safety-critical loop in this file for a shape no `observed_state`,
 *       `executor_ref` or `prior_state_ref` has ever had.
 *
 * THE TWO ALTERNATIVES AND HOW THEY FAIL. (a) ORDER `rollout` BEFORE `images` in `observedStateFrom`:
 * makes source-line order in an unrelated function a load-bearing contract, which the next person
 * reorders innocently, and it fixes only the one pair we happen to know about today. Property (2) is
 * what earns this rejection — pass 8 and pass 9 each rejected the alternative on a disease their own
 * design still had, which is why (2) is now pinned byte-for-byte by tests rather than asserted in a
 * comment. (b) RESERVE A SHARE FOR NAMED CRITICAL LEAVES: explicit, but the list of names is exactly
 * the per-field census that finding M2 replaced this walk with — `ExecutionStatus.observed` is
 * documented as "optional and additive", so the list goes stale on the day an executor contributes
 * the next signal a gate reads. A share is a property of the WALK: it protects a field nobody has
 * written yet.
 *
 * WHAT IT STILL COSTS, STATED. A very large array can keep slightly fewer entries than a
 * single-budget walk kept, because the guaranteed shares of its siblings are spent before it is
 * offered the remainder. The gap is bounded by what the siblings actually spend (~110 characters for
 * `observedStateFrom`'s reading), not by their share. Readers can now tell a cut from an absence
 * ({@link isPersistedJsonEntriesElision}), rather than a whole sibling key vanishing silently.
 *
 * ARRAYS ARE NOT FAIR-SHARED, and that is the point rather than an omission. An object's keys are
 * different facts for different readers; an array's entries are instances of ONE kind, and cutting
 * the tail off a list is an honest degradation while cutting each ELEMENT in half is corruption —
 * a half-written `ghcr.io/acme/api@sha256:…` still parses, into a repository and a digest that name
 * bytes nobody deployed. So arrays keep spending in order and truncating the tail.
 *
 * HOW MANY TIMES THE UNSPENT REMAINDER IS RE-OFFERED. Each round finalises every field that no
 * longer clips at the bigger share and re-walks only the rest, so the useful work is done in one or
 * two rounds for any shape this file actually sees; the cap exists so a pathological object (5 000
 * fields of geometrically increasing size) cannot turn a per-row bound into O(n²) walks. Reaching
 * the cap is not a correctness failure — it leaves budget unspent, which is the direction that only
 * costs retention.
 */
const PERSISTED_JSON_SHARE_ROUNDS = 4;

/**
 * Walk an object's fields under the water-filling rule documented on
 * {@link PERSISTED_JSON_SHARE_ROUNDS}. Split out of `walk` because phase 2 needs the raw value of
 * every field it may re-walk, which a single in-place loop cannot keep.
 */
function walkObjectFields(
  entries: [string, unknown][],
  budget: WalkBudget,
  depth: number
): Record<string, unknown> {
  /** Seated fields in insertion order. `raw` is kept because phase 2 walks each field more than
   *  once — at a larger share each time — and needs the original to walk. */
  const seated: { key: string; raw: unknown; value: unknown; spent: number }[] = [];
  let elidedMarker: string | undefined;

  // ---- PHASE 1: SEAT THE KEYS. Charge the keys and NOTHING ELSE, so the pool phase 2 divides is
  // a number that does not depend on the order the fields arrived in.
  for (let i = 0; i < entries.length; i++) {
    const [rawKey, entryValue] = entries[i]!;
    if (entryValue === undefined) continue; // `JSON.stringify` omits these; charge nothing
    const key = boundStringToCost(rawKey, Math.min(budget.left, PERSISTED_JSON_MAX_KEY_CHARS));
    const keyCost = jsonCost(key) + 1 + (seated.length > 0 ? 1 : 0); // "key": plus the comma
    // EVERY seated field must still be able to get {@link PERSISTED_JSON_MIN_LEAF}, not just this
    // one: the guarantee has to hold for the fields already seated, whose values are not walked
    // until phase 2. `entries.length - i` counts THIS field plus the ones behind it; a later
    // `undefined` value makes that an over-count, which only makes the marker's number too big —
    // and the marker is a count of fields the reader cannot see either way.
    if (budget.left - keyCost < PERSISTED_JSON_MIN_LEAF * (seated.length + 1)) {
      elidedMarker = `${entries.length - i} more fields`;
      budget.left -= jsonCost(elidedMarker) + jsonCost(PERSISTED_JSON_ELIDED_KEY) + 2;
      break;
    }
    budget.left -= keyCost;
    seated.push({ key, raw: entryValue, value: undefined, spent: 0 });
  }

  // ---- PHASE 2: WATER-FILL THE VALUES. `pool` is what the fields in `pending` have to divide;
  // a field that finishes under its share is taken out and only its ACTUAL spend leaves the pool.
  let pool = budget.left;
  let pending = seated.map((_, index) => index);
  for (let round = 0; round < PERSISTED_JSON_SHARE_ROUNDS && pending.length > 0; round++) {
    // Never negative in round 0: phase 1 seats a key only while MIN_LEAF per seated field still
    // fits. A later round can drive it to 0 for a pathological object, and 0 is a legal share —
    // the field stores a marker rather than nothing at all.
    const share = Math.max(0, Math.floor(pool / pending.length));
    const stillPending: number[] = [];
    let satisfiedSpend = 0;
    for (const index of pending) {
      const field = seated[index]!;
      const sub: WalkBudget = { left: share };
      field.value = walk(field.raw, sub, depth + 1);
      // Charge what was ACTUALLY spent, not the share. `sub.left` may go slightly negative when a
      // leaf overshoots its own share; the difference keeps the accounting exact either way, which
      // is what the measured check in `boundPersistedJson` is the backstop for.
      field.spent = share - sub.left;
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

  const out: Record<string, unknown> = {};
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

/**
 * BOUND `text` SO ITS RENDERED COST FITS `left`. {@link boundText} bounds the CHARACTER count;
 * `left` is measured in RENDERED characters, and the difference is the two quotes
 * `JSON.stringify` always adds plus whatever the escapes cost. So the widest attempt overshoots by
 * construction, and the width that fits has to be found by MEASURING rather than by guessing.
 *
 * SEARCH FOR THE WIDEST WIDTH THAT FITS; DO NOT HALVE — MEDIUM, M23.0 verification pass 10. This
 * function used to shrink the width by HALF on every miss, and said of itself that it "halves until
 * the ESCAPES fit ... the worst escape expansion is 6x". That is not the case it fires on. For ANY
 * unescaped string — every image ref, digest, revision, URL and branch name a real executor
 * reports — the first attempt overshoots by exactly TWO characters, the quotes, and halving then
 * threw away half the budget to recover them. Measured, against a text longer than the budget:
 *
 *     left    halving stores/renders    search stores/renders    utilisation
 *      400          200 / 202                 398 / 400            50.5 %  ->  100.0 %
 *     1000          500 / 502                 998 / 1000           50.2 %  ->  100.0 %
 *     2634         1317 / 1319               2632 / 2634           50.1 %  ->  100.0 %
 *     3900         1950 / 1952               3898 / 3900           50.1 %  ->  100.0 %
 *
 * A WELL-WRITTEN COMMENT NAMING A HAZARD IS A SIGNAL TO SWEEP, NOT EVIDENCE IT WAS HANDLED
 * (CLAUDE.md). The escape hazard the old comment named is real — a backslash doubles, a C0 control
 * sextuples — and halving was not serving THAT case either, because a power of two is not where the
 * boundary sits for any particular escape density:
 *
 *     backslashes, left 3900   halving 1950 / 3873    search 1963 / 3899
 *     C0 controls, left 3900   halving  487 / 2779    search  673 / 3895   <- 71 % -> 99.9 %
 *
 * IT IS THIS FAMILY OF ROUNDS' OWN DEFECT, not a pre-existing one. While a field could take the
 * whole budget the loop ran once and returned (`min(4000, 7902)` renders to 4 002 <= 7 902), so the
 * shrink never fired. It went live the moment {@link walkObjectFields} started handing each field a
 * SHARE — a share is exactly the regime where the first attempt misses. And nothing recovers it
 * downstream: the field is still `clipped`, so the water-filling loop re-offers it a larger share
 * and the same halving throws away half of THAT too.
 *
 * WHY A SEARCH AND NOT A CORRECTION TERM. Correcting the width by the measured overshoot collapses
 * to nothing on a 6x string (the overshoot exceeds the whole width); correcting it by the measured
 * RATIO converges in two steps but is not monotone, and a 20 000-case differential fuzz found 625
 * inputs where it stored LESS than halving and one where it ran out of attempts and stored nothing.
 * A bisection has none of those failure modes: it terminates in at most `log2(4000)` ~ 12 steps, and
 * every value it returns has been MEASURED to fit — which is the same discipline
 * `boundPersistedJson` applies to the whole row. The same fuzz over the same 20 000 inputs (ASCII,
 * backslash, quote, C0-control and astral alphabets, budgets 0…5 000): zero over budget, zero worse
 * than halving, zero cases where halving found something and the search did not.
 *
 * The first call is the FAST PATH and is the only one a string that already fits ever makes.
 */
function boundStringToCost(text: string, left: number): string {
  const widest = Math.min(RUNNER_DETAIL_MAX_CHARS, left);
  if (widest <= 0) return "";
  const whole = boundText(text, widest, Math.floor(widest / 2));
  if (jsonCost(whole) <= left) return whole;

  // Bisect [0, widest) for the largest width whose RENDERED cost fits. `best` stays "" only when
  // not even the empty string fits — `left < 2` — which the row-level measurement in
  // `boundPersistedJson` is the backstop for.
  let best = "";
  let lo = 0;
  let hi = widest - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const candidate = boundText(text, mid, Math.floor(mid / 2));
    if (jsonCost(candidate) <= left) {
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
type WalkBudget = { left: number; clipped?: boolean };

function walk(value: unknown, budget: WalkBudget, depth: number): unknown {
  if (value === null || value === undefined) return value;

  switch (typeof value) {
    case "string": {
      const bounded = boundStringToCost(value, budget.left);
      if (bounded !== value) budget.clipped = true;
      budget.left -= jsonCost(bounded);
      return bounded;
    }
    case "number": {
      // A non-finite number is `null` to `JSON.stringify` anyway; making that explicit means the
      // accounting below is the truth rather than an approximation of it.
      if (!Number.isFinite(value)) {
        budget.left -= 4;
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
      if (bounded !== rendered) budget.clipped = true;
      budget.left -= jsonCost(bounded);
      return bounded;
    }
    case "object":
      break;
    default:
      // function / symbol — `JSON.stringify` drops these; be explicit rather than lucky.
      return null;
  }

  if (depth >= PERSISTED_JSON_MAX_DEPTH) {
    // NOT a budget clip — see {@link WalkBudget}. No amount of extra budget brings this subtree
    // back, so marking it would only cost a redistribution round.
    const marker = "[elided: nesting deeper than the persisted-JSON depth limit]";
    budget.left -= jsonCost(marker);
    return marker;
  }

  if (Array.isArray(value)) {
    budget.left -= 2; // []
    const out: unknown[] = [];
    for (let i = 0; i < value.length; i++) {
      if (budget.left < PERSISTED_JSON_MIN_LEAF) {
        // Spend-in-order and truncate the TAIL — see {@link PERSISTED_JSON_SHARE_ROUNDS} for why
        // an array is not fair-shared. The marker is recognisable (`isPersistedJsonEntriesElision`)
        // so a reader looking for a specific entry can tell a cut from an absence.
        const marker = entriesElisionMarker(value.length - i);
        budget.left -= jsonCost(marker) + 1;
        out.push(marker);
        budget.clipped = true;
        break;
      }
      if (i > 0) budget.left -= 1; // ,
      out.push(walk(value[i], budget, depth + 1));
    }
    return out;
  }

  budget.left -= 2; // {}
  // EVERY FIELD AGAINST AN EQUAL SHARE, AND WHAT THE SATISFIED ONES DO NOT WANT RE-OFFERED TO THE
  // REST. With a single budget spent in insertion order, the first large field took the row and
  // every later key became `__scpElided` — so which leaf a gate could read was decided by
  // source-line order in whatever function composed the value. With a share that was only a
  // CEILING, half the budget was thrown away instead. With a share computed from the budget
  // REMAINING mid-loop, how much of each field survived still varied with order. See
  // {@link PERSISTED_JSON_SHARE_ROUNDS}.
  return walkObjectFields(Object.entries(value as Record<string, unknown>), budget, depth);
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
 */
export function boundPersistedJson(
  value: unknown,
  maxChars: number = PERSISTED_JSON_MAX_CHARS
): unknown {
  if (value === null || value === undefined) return value;
  const budget: WalkBudget = { left: Math.max(0, maxChars) - PERSISTED_JSON_MIN_LEAF };
  const bounded = walk(value, budget, 0);
  const rendered = JSON.stringify(bounded);
  if (rendered === undefined || rendered.length <= maxChars) return bounded;
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
    if (fallbackRendered !== undefined && fallbackRendered.length <= maxChars) return fallback;
  }
  return null;
}

/**
 * HOW MANY RUN OUTCOMES A PLUGIN'S CACHE MAY HOLD — MEDIUM, M23.0 verification pass 7 finding M1,
 * and the half of the 1.44 GB/day class the previous round did NOT fix.
 *
 * BOUNDING ONE ENTRY DID NOT BOUND THE MAP. Every managed executor caches `{succeeded, detail}` per
 * `idempotencyKey` so a re-`trigger()` cannot re-run a completed job, and NONE of the three pruned
 * anything, ever. Measured on managed-iac at 500 keys: `bytes=2074290  bytesPerKey=4149`, i.e. the
 * per-entry bound is doing its job and the map is still unbounded because the map is a different
 * quantity. Worse for the DURABLE one: `loadState` `JSON.parse`s the whole file on EVERY `status()`
 * poll and `saveState` rewrites it whole on every `trigger()` — O(total history ever) per poll,
 * forever, on a loop that ticks every second.
 *
 * THE RETENTION RULE, AND WHY IT IS SAFE. Oldest-first, keeping the most recent `max` entries. What
 * an entry has to outlive is short and knowable: `trigger()` in all three plugins runs the job
 * SYNCHRONOUSLY to completion before writing the entry, so by the time an entry exists the work is
 * already done and the only remaining reader is `reconcile.ts`'s next `status()` poll — under two
 * seconds away — plus a crash-and-retry window in which reconcile re-issues the SAME
 * `idempotencyKey`. Dropping an entry that a retry then asks for is the one real hazard (it means a
 * second run of a job that already ran), so the caps below are set orders of magnitude above the
 * number of runs that can physically be in flight, not at the smallest value that would "work".
 *
 * AND THE DURABLE CACHE GETS A SMALLER CAP THAN THE IN-MEMORY ONES, which is the whole reason this
 * is a parameter rather than a constant: managed-iac re-reads and re-parses its entire file on every
 * poll, so its size is a per-poll CPU cost as well as a disk cost, while managed-scan's and
 * managed-dep's `Map.get` is O(1) and their size is only memory. The two are not the same tradeoff
 * and pretending they were would either waste memory or re-introduce the parse cost.
 */
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
 * THE ONE STRING A CALLER RECORDS FOR A RUN, whatever became of it — success or any of the five
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
    // BOUNDED BEFORE `record` EVER SEES IT. A thrown `Error`'s `.message` is freeform text this
    // package did not compose — a `docker create` rejection carries the whole of stderr in it — and
    // `record` writes to a store that is never pruned. Redact, then bound; both are the plugin's
    // store's problem and neither is optional. `boundDetail` keeps the END, so the reason the throw
    // happened survives the bound.
    await opts.record(false, boundDetail(opts.redact(message)));
    return undefined;
  }
}
