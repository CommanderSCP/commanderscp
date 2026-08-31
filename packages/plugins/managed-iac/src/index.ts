import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createFileBackedJsonCache } from "@scp/plugin-api";
import type {
  AbortResult,
  Cursor,
  ExecutionStatus,
  ExecutorCapabilities,
  ExecutorEvent,
  ExecutorPlugin,
  ExternalRunRef,
  PluginContext,
  PluginManifest,
  TriggerIntent
} from "@scp/plugin-api";
import {
  MANAGED_RUN_TIMEOUT_MAX_MS,
  RUN_OUTCOME_CACHE_MAX_DURABLE,
  boundDetail,
  MANAGED_RUN_TIMEOUT_MIN_MS,
  resolveRunnerLauncher,
  runnerOutcomeDetail,
  toRunnerRunId,
  withRecordedOutcome,
  pruneOutcomeRecord,
  type BoundedDetail,
  type KubernetesLauncherSettings,
  type ResolveRunnerLauncher,
  type RunnerResult
} from "@scp/runner-launcher";

/**
 * `@scp/plugin-managed-iac` — the `scp-managed-iac` executor (DESIGN.md §12 Mode 2, charter's
 * Managed Execution Exception, BUILD_AND_TEST.md §8 M7 item 3): "a thin orchestrator inside
 * scpd; each run launches an ephemeral runner container from [the `scp-runner-iac`] image... Org-
 * supplied credentials are held scoped and encrypted in SCP's secret store and injected only into
 * the ephemeral runner for the duration of the run. The plan output is persisted as the change's
 * evidence; apply proceeds only when the change's gates pass."
 *
 * SECURITY MODEL (adversarial-review CRITICAL #1 — the reason this file's config shape is what it
 * is): the fields that decide WHAT image runs, on WHICH network, and against WHICH host directory
 * are **operator/server-governed, NEVER tenant-suppliable**. A tenant (any org member with plain
 * `object:write` on a Component) configures ONLY `infraCredsSecretKeys` + `timeoutMs` (the
 * manifest's `configSchema` below is `additionalProperties: false` and does NOT list runnerImage/
 * networkMode/workspace — so a binding that tries to set them is rejected at create/update by
 * `routes/executors.ts`'s config validation). The server injects `runnerImage`/`networkMode`/
 * `workspaceRoot`/`statePath` into this plugin's config when it provisions the instance
 * (`coordination/executor-bindings-repo.ts`'s `resolveExecutorPluginInstance`), so by the time
 * this code reads `ctx.config`, those values are the vetted server settings, not anything a tenant
 * chose. Two further hardening measures below: (1) the runner workspace is **copied into the
 * container** (`docker cp`), never bind-mounted — there is no tenant- OR server-path that becomes
 * a host mount, so `workspaceDir: "/"`-style host-root escapes are structurally impossible; the
 * host workspace directory itself is derived server-side from `orgId`+`targetRef` under the
 * operator's `workspaceRoot`, so it can't be steered outside that root. (2) the container is
 * launched with NO docker socket mount and the server-fixed `--network` (default `none`).
 *
 * COORDINATION-NOT-EXECUTION, PRESERVED AT THE TYPE LEVEL EVEN HERE: this is the one scoped
 * exception where `trigger()`'s body performs real infrastructure work — but it still does so
 * behind the unchanged `ExecutorPlugin` verb (no new `execute()`/`deploy()` method), and it holds
 * credentials ONLY for THIS org's infrastructure, ONLY for the duration of one ephemeral
 * container, injected via `docker create -e`, redacted out of any returned evidence, and never
 * reachable from this plugin's own subprocess environment.
 *
 * SYNCHRONOUS TRIGGER (deliberate v1 simplification — "trivial-to-moderate IaC deployments" is
 * DESIGN's own scoping for Mode 2): `trigger()` runs the container to completion. Idempotency is
 * enforced BEFORE any container ever launches (the dedup cache below, backed by a server-provided
 * durable `statePath` — the strongest idempotency guarantee of any M7 executor, because
 * double-applying live infrastructure is the highest-stakes failure mode).
 */

export interface ManagedIacConfig {
  /** SERVER-INJECTED (never tenant): the vetted, pinned `scp-runner-iac` image reference. */
  runnerImage: string;
  /** SERVER-INJECTED (never tenant): the operator's root directory under which this plugin
   *  derives a per-(org, target) workspace. The tenant cannot influence the path. */
  workspaceRoot: string;
  /** SERVER-INJECTED (never tenant): `docker create --network <value>`, default `"none"`. */
  networkMode: string;
  /** SERVER-INJECTED (never tenant): durable dedup-cache path (MAJOR #4 — survives a subprocess
   *  restart, so a crash/resume retry can never double-apply). */
  statePath?: string;
  /** Env-var-name -> `SecretsAccessor` key map (TENANT config) — resolved and injected ONLY into
   *  the runner container's env, redacted out of returned evidence, never this plugin's own env. */
  infraCredsSecretKeys?: Record<string, string>;
  /** ms before the container run is killed as hung (TENANT config). Default 10 minutes. */
  timeoutMs?: number;
  /** SERVER-INJECTED (never tenant): the container CLI to exec. Refused by the manifest schema and
   *  injected by `resolveExecutorPluginInstance` from `SCP_MANAGED_RUNNER_DOCKER_BINARY`, so the
   *  `?? "docker"` fallback below is for this package's own unit tests, not a tenant hook. */
  dockerBinary?: string;
  /**
   * SERVER-INJECTED (never tenant) — WHICH LAUNCHER ADAPTER RUNS THIS PLUGIN'S RUNNER (M23.2).
   *
   * Absent, or anything other than `"kubernetes"`, means the Docker adapter — so a deployment that
   * does not opt in behaves byte-identically, which is what makes a second adapter safe to merge.
   * The same TWO INDEPENDENT DEFENCES `dockerBinary` has apply here from day one: this plugin's
   * manifest is `additionalProperties: false` with these keys absent, so a binding carrying either
   * is rejected at the write door (`plugin-manifests-runner-launcher.test.ts` pins the refusal by
   * name), and the server injects them LAST so a regression in the write door downgrades from a
   * launcher swap to an accepted-but-overwritten key.
   */
  runnerLauncher?: "docker" | "kubernetes";
  /** SERVER-INJECTED (never tenant): the Kubernetes launcher's deployment settings. Required when
   *  {@link runnerLauncher} is `"kubernetes"` — the resolver refuses BY NAME when it is missing,
   *  rather than producing a TypeError inside a half-built Job manifest. */
  kubernetes?: KubernetesLauncherSettings;
}

const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_NETWORK_MODE = "none";
/** Filenames a tenant may supply via `intent.parameters.sourceFiles` — no path separators, no
 *  `..`, no leading-dot traversal; just plain tofu source/tfvars filenames. */
const SAFE_FILENAME = /^[A-Za-z0-9._-]+$/;

function asConfig(config: unknown): ManagedIacConfig {
  const c = config as Partial<ManagedIacConfig> | undefined;
  if (!c?.runnerImage) {
    throw new Error(
      "managed-iac: runnerImage is not configured (server-governed — is Mode 2 enabled?)"
    );
  }
  if (!c.workspaceRoot) {
    throw new Error("managed-iac: workspaceRoot is not configured (server-governed)");
  }
  return {
    runnerImage: c.runnerImage,
    workspaceRoot: c.workspaceRoot,
    networkMode: c.networkMode ?? DEFAULT_NETWORK_MODE,
    statePath: c.statePath,
    infraCredsSecretKeys: c.infraCredsSecretKeys,
    timeoutMs: c.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    dockerBinary: c.dockerBinary ?? "docker",
    // CARRIED THROUGH THE NORMALISER, and its absence would have been silent: `asConfig` REBUILDS
    // the object field by field, so a server-injected key it does not name is dropped before the
    // resolver ever sees it — the launcher selection would have been accepted at every layer and
    // then discarded here.
    runnerLauncher: c.runnerLauncher,
    kubernetes: c.kubernetes
  };
}

/** Server-controlled per-(org, target) workspace — sanitized so neither `orgId` nor `targetRef`
 *  can ever escape `workspaceRoot` (no separators/`..` survive the replace). Persists across
 *  plan -> apply -> rollback for the same target (the tofu state/plan lifecycle needs that). */
function workspaceDirFor(
  config: ManagedIacConfig,
  orgId: string,
  targetRef: string | undefined
): string {
  const safe = (s: string): string => s.replace(/[^A-Za-z0-9._-]/g, "_");
  return join(config.workspaceRoot, safe(orgId), safe(targetRef ?? "default"));
}

/**
 * WHERE THE TRANSIENT `--env-file` IS STAGED — the plugin's OWN server-governed state dir, which is
 * `dirname(statePath)`: `resolveExecutorPluginInstance` always injects a durable per-instance
 * `statePath` under `pluginStateDir()` (executor-bindings-repo.ts, "always set"), so in production
 * this is the same directory the dedup cache already lives in.
 *
 * NOT the workspace: the workspace is `docker cp`'d INTO the container, and a credential file must
 * never be a candidate for that. NOT `os.tmpdir()` either — the port refuses to choose, precisely
 * because a shared temp dir is not a place a credential belongs. The fallback is for this package's
 * own unit tests, which are the only callers that leave `statePath` unset.
 */
function secretEnvDirFor(config: ManagedIacConfig): string {
  return config.statePath
    ? dirname(config.statePath)
    : join(config.workspaceRoot, ".scp-runner-secret-env");
}

/** Replaces every occurrence of each resolved secret VALUE with `***` (MINOR — never leak a
 *  credential back to a tenant via `plan.json`/stdout evidence surfaced through `status()`).
 *  Plain split/join, not regex, since secret values may contain regex metacharacters. */
function redactSecrets(text: string, secretValues: string[]): string {
  let out = text;
  for (const value of secretValues) {
    if (value.length === 0) continue;
    out = out.split(value).join("***");
  }
  return out;
}

// -----------------------------------------------------------------------------------------
// Dedup cache — see module doc. Backed by the server-provided durable `statePath` (MAJOR #4).
// -----------------------------------------------------------------------------------------

interface RunOutcome {
  externalId: string;
  succeeded: boolean;
  /** {@link BoundedDetail}, NOT `string`, and that is the fix rather than a decoration: this record
   *  is written to a DURABLE, replicated, never-pruned JSON file keyed by `idempotencyKey`, and
   *  `reconcile.ts` copies it from there into a `Decision`'s `inputContext`. The type is what makes
   *  "you cannot store an unbounded reason here" a compile error at all fourteen write sites in this
   *  file instead of a comment on one of them. See `@scp/runner-launcher`'s
   *  {@link RUNNER_DETAIL_MAX_CHARS}. */
  detail: BoundedDetail;
  stateRef?: string;
}

interface DedupState {
  keys: Record<string, RunOutcome>;
}

/**
 * BOUNDING ONE ENTRY DID NOT BOUND THE LEDGER (MEDIUM, M23.0 verification pass 7 finding M1). The
 * previous round capped each `detail` and left `state.keys` — a `Record` keyed by `idempotencyKey`
 * with no pruning anywhere — to grow forever. Measured at 500 keys: `bytes=2074290`,
 * `bytesPerKey=4149`. The per-entry cap was working; the map was a different quantity.
 *
 * AND THE SIZE IS A PER-POLL COST HERE, not just a disk cost, which is what makes this the worse of
 * the three: `loadState` `JSON.parse`s the WHOLE file on every `status()` call and `saveState`
 * rewrites it whole on every `trigger()`, so an unbounded ledger is O(total history ever) of parsing
 * on a loop that ticks once a second. That is the 1.44 GB/day family properly stated — an unbounded
 * write per key, re-read forever.
 *
 * THE RULE: keep the most recent {@link RUN_OUTCOME_CACHE_MAX_DURABLE} outcomes, drop the oldest.
 * What an entry must outlive is `trigger()` (which runs the container synchronously to completion
 * BEFORE writing the entry) plus reconcile's next `status()` poll a second later, plus a
 * crash-and-retry window in which reconcile re-issues the same `idempotencyKey`. Dropping an entry a
 * retry then asks for would mean re-running an `apply` that already ran — the one hazard worth
 * naming — so 200 is set far above anything that can be in flight rather than at the smallest
 * workable number. Ceiling on the file: 200 x ~4.2 KB, about 840 KB, and that is the WORST case;
 * a typical `detail` is a few hundred bytes.
 */
function pruneDedupState(state: DedupState): number {
  return pruneOutcomeRecord(state.keys, RUN_OUTCOME_CACHE_MAX_DURABLE);
}

/**
 * WHAT THIS FILE COMPOSES — a `detail` that is a plain `string` (MEDIUM, M23.0 verification pass 7
 * finding M3). `RunOutcome.detail` is still {@link BoundedDetail}, so no READER of the ledger can be
 * handed a megabyte; what changed is WHERE the conversion happens. A brand on a FIELD forces one at
 * every literal that constructs the record, which is how one concept came to have 26 manual call
 * sites across four packages — most of them, on a delete-the-wiring sweep, pinned by no failing
 * test. Three sites of one concept means the boundary is wrong; the answer is not 23 more tests.
 */
type PendingOutcome = Omit<RunOutcome, "detail"> & { detail: string };

/** THE ONLY WAY AN OUTCOME ENTERS THE LEDGER. One bound, at the store. */
function storeOutcome(state: DedupState, cacheKey: string, outcome: PendingOutcome): void {
  state.keys[cacheKey] = { ...outcome, detail: boundDetail(outcome.detail) };
}

const dedupCache = createFileBackedJsonCache<DedupState>(() => ({ keys: {} }));
const loadState = dedupCache.load;
const saveState = dedupCache.save;

// -----------------------------------------------------------------------------------------
// Runner container launch — COPY the workspace in/out (never bind-mount; CRITICAL #1 + fixes the
// dind CI failure where a bind-mounted host /tmp path isn't shared with the dind daemon). The ONE
// place credentials are materialized as env vars, on the CHILD `docker` invocations only.
//
// M23.1: the five-step create/copy-in/start/copy-out/remove sequence itself now lives in
// `@scp/runner-launcher`, shared with `@scp/plugin-managed-scan` and `@scp/plugin-managed-dep` —
// three hand-rolled copies of one mechanism were three places a fix had to be remembered. What
// stays HERE is everything that is this plugin's own: which operands, which env, and the
// copy-out policy (`always` + `swallow`) that no other caller shares.
// -----------------------------------------------------------------------------------------

async function resolveInfraCreds(
  ctx: PluginContext,
  config: ManagedIacConfig
): Promise<Record<string, string>> {
  const resolved: Record<string, string> = {};
  for (const [envVar, secretKey] of Object.entries(config.infraCredsSecretKeys ?? {})) {
    const value = await ctx.secrets.get(secretKey);
    if (value !== undefined) resolved[envVar] = value;
  }
  return resolved;
}

async function runRunnerContainer(
  config: ManagedIacConfig,
  resolveLauncher: ResolveRunnerLauncher,
  action: "plan" | "apply" | "rollback",
  workspaceDir: string,
  /** The dedup cache key for this run — see {@link RunnerSpec.runId} on why the CALLER supplies it. */
  cacheKey: string,
  /**
   * RESOLVED ONCE, by the caller — `trigger()` resolves these before this function is called (M23.1
   * phase 2), rather than this function resolving them itself, because `trigger()` also needs the
   * secret VALUES to build the `redact` closure {@link withRecordedOutcome} uses on the FAILURE path,
   * and resolving twice would mean the credential fetch and the credential the failure-path redactor
   * knows about could, in principle, diverge.
   */
  infraCreds: Record<string, string>,
  extraEnv: Record<string, string> = {}
): Promise<RunnerResult> {
  const secretValues = Object.values(infraCreds);

  const result = await resolveLauncher({
    dockerBinary: config.dockerBinary,
    runnerLauncher: config.runnerLauncher,
    kubernetes: config.kubernetes
  }).run({
    // DERIVED FROM THE IDEMPOTENCY KEY, so a retry of the same run addresses the same container
    // name. That is the whole reason `runId` is caller-supplied rather than adapter-minted: no
    // adapter could know that two launches are the same run, and this plugin's dedup cache is
    // exactly the thing that does. `toRunnerRunId` is injective, so two DIFFERENT keys can never
    // collapse onto one name (which would make one run tear down the other's container).
    runId: toRunnerRunId(cacheKey),
    // ATTRIBUTION FOR AN ORPHAN (M23.0 defect 1). A container the daemon made for a `create` that
    // then timed out is now findable — `docker ps -a --filter label=scp.executor=scp-managed-iac`.
    labels: { "scp.executor": "scp-managed-iac", "scp.run-id": toRunnerRunId(cacheKey) },
    image: config.runnerImage,
    // The single operand this runner takes: which tofu verb `run.sh` should perform.
    operands: [action],
    // A CONFIG READ HERE, deliberately — unlike managed-dep, whose charter clause carries no
    // operator qualifier. `networkMode` is server-injected (default "none"), never tenant.
    networkMode: config.networkMode,
    // THE NON-SECRET ENV — `PRIOR_STATE_FILE` and anything else an action appends. Still `-e`, and
    // rightly so: it is a path inside the container, and hiding it buys nothing while making the
    // command line harder to read.
    env: Object.entries(extraEnv).map(([k, v]) => `${k}=${v}`),
    // THE CREDENTIALS, AND THE ONE PLACE THEY ARE MATERIALIZED. M23.0 recorded that these rode the
    // `create` argv, readable from the host process table by any local process; they now travel as
    // `secretEnv`, which the Docker adapter delivers through a mode-0600 `--env-file` it unlinks the
    // instant `create` returns. STILL PARTIAL, and named as such at `RunnerSpec.secretEnv`: the
    // value is in `docker inspect` for the container's life and on a disk for one `create`. The
    // split's real payoff is M23.2 — Kubernetes maps `secretEnv` to a per-run Secret, where an
    // undifferentiated list would have become `env[].value` and put the credential in etcd.
    //
    // THE ORDER IS THE CONFIG'S OWN KEY ORDER, unchanged, and `extraEnv` is no longer merged in
    // ahead of it — the two lists are now disjoint by construction rather than by spelling.
    secretEnv: Object.entries(infraCreds).map(([k, v]) => `${k}=${v}`),
    secretEnvDir: secretEnvDirFor(config),
    // COPIED, never bind-mounted (CRITICAL #1 + the dind-share fix): there is no host path that
    // becomes a container mount, so a `workspaceDir: "/"`-style escape is structurally impossible.
    copyIn: [{ hostDir: workspaceDir, containerPath: "/workspace" }],
    // THE ASYMMETRY THAT IS THIS PLUGIN'S ALONE, and it is load-bearing on both axes: the evidence
    // comes back out even after a FAILED run (a failed apply may still have produced a partial
    // plan.json worth persisting), and a copy-out that itself fails is SWALLOWED (the run stays
    // succeeded). managed-scan and managed-dep do the opposite on both. Pinned by the goldens; a
    // port that normalised the three into one sequence must break them.
    copyOut: {
      containerPath: "/workspace",
      hostDir: workspaceDir,
      when: "always",
      onFailure: "swallow"
    },
    timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxBuffer: 16 * 1024 * 1024
  });

  // THE SECOND, INDEPENDENT REDACTION — this plugin's own knowledge of which values are secret,
  // applied on top of whatever the adapter already stripped (see `withRecordedOutcome`'s `redact`
  // for why the plugin may not depend on that having happened). `failure.detail` joins the set it
  // covers: it embeds `err.message`, which on a `create` failure is where an unredacted
  // `-e AWS_SECRET_ACCESS_KEY=…` would appear, and it is now the string that reaches the DURABLE
  // ledger — the highest-value channel this plugin has.
  if (result.succeeded) {
    return {
      succeeded: true,
      stdout: redactSecrets(result.stdout, secretValues),
      stderr: redactSecrets(result.stderr, secretValues)
    };
  }
  return {
    succeeded: false,
    stdout: redactSecrets(result.stdout, secretValues),
    stderr: redactSecrets(result.stderr, secretValues),
    failure: {
      ...result.failure,
      // RE-BOUND AFTER REDACTING, because redaction is not length-preserving: a secret value shorter
      // than `***` makes the string GROW. The compiler is what insists — `RunnerFailure.detail` is
      // `BoundedDetail`, so a transform that returns a plain `string` cannot be assigned back.
      detail: boundDetail(redactSecrets(result.failure.detail, secretValues))
    }
  };
}

// -----------------------------------------------------------------------------------------
// ExecutorPlugin
// -----------------------------------------------------------------------------------------

async function observe(_ctx: PluginContext, _since?: Cursor): Promise<ExecutorEvent[]> {
  return []; // no push events — this executor's only activity is driven by its own trigger().
}

/** Writes tenant-supplied source files into the (server-controlled) workspace, rejecting any
 *  filename that isn't a plain, separator-free name (path-traversal defense). */
async function writeSourceFiles(
  workspaceDir: string,
  sourceFiles: Record<string, string>
): Promise<void> {
  for (const [name, content] of Object.entries(sourceFiles)) {
    if (!SAFE_FILENAME.test(name) || name === "." || name === "..") {
      throw new Error(
        `managed-iac: illegal source filename '${name}' (must match ${SAFE_FILENAME})`
      );
    }
    await writeFile(join(workspaceDir, name), content, "utf8");
  }
}

async function trigger(
  ctx: PluginContext,
  intent: TriggerIntent,
  resolveLauncher: ResolveRunnerLauncher
): Promise<ExternalRunRef> {
  const config = asConfig(ctx.config);
  const cacheKey = intent.idempotencyKey ?? randomUUID();
  // MOVED AHEAD OF `loadState` (LOW-6) — deterministic, IO-free, so a state-load failure below still
  // has a ref to record its own refusal against, instead of nothing.
  const externalId = `managed-iac::${cacheKey}`;

  let state: DedupState;
  try {
    state = await loadState(config.statePath);
  } catch (err) {
    // LOW-6: `loadState`/`saveState` used to sit OUTSIDE `withRecordedOutcome`'s guarded region, so
    // a corrupt state file (`JSON.parse` throwing non-ENOENT) made `trigger()` reject UNRECORDED —
    // no outcome, no externalId the caller could later poll `status()` with. FAIL CLOSED rather than
    // treating the read failure as "no prior run": this cache is exactly what tells a retry apart
    // from a run that already applied, so an unreadable cache must refuse to launch, not guess.
    // Recorded as this run's own outcome — a fresh single-key state is safe to write precisely
    // because the OLD file was unreadable: nothing recoverable from it is lost by overwriting what
    // could not be read anyway.
    const refusalState: DedupState = { keys: {} };
    storeOutcome(refusalState, cacheKey, {
      externalId,
      succeeded: false,
      detail:
        `managed-iac: FAILED CLOSED — could not load dedup state at '${config.statePath}' ` +
        `(${err instanceof Error ? err.message : String(err)}). Refusing to launch: an unreadable ` +
        "dedup cache cannot tell this run apart from one that already applied."
    });
    try {
      await saveState(config.statePath, refusalState);
    } catch (saveErr) {
      // Recording the refusal itself failed too — nothing left to do but be LOUD about it, which is
      // exactly the property that keeps this LOW rather than HIGH (status()'s own loadState would
      // fail just as loudly here).
      ctx.logger.error("managed-iac: could not record the dedup-state-load failure either", {
        externalId,
        loadError: err instanceof Error ? err.message : String(err),
        saveError: saveErr instanceof Error ? saveErr.message : String(saveErr)
      });
      throw err;
    }
    ctx.logger.info("managed-iac: run complete", { externalId, succeeded: false });
    return { externalId };
  }

  const existing = state.keys[cacheKey];
  if (existing) {
    return { externalId: existing.externalId };
  }

  const workspaceDir = workspaceDirFor(config, ctx.orgId, intent.targetRef);
  let outcome: PendingOutcome = { externalId, succeeded: false, detail: "" };

  // THE REDACTION SET FOR THE FAILURE PATH (M23.1 phase 2), populated the moment credentials are
  // actually resolved inside the guarded body below. Starts empty, so a throw BEFORE that point
  // redacts against nothing (safe: no credential has been fetched yet) and a throw AFTER it redacts
  // against exactly what THIS run fetched. NOT the identity function, unlike managed-scan's: a raw
  // `docker create` rejection's message carries `-e KEY=<value>` before `RunnerLaunchError`'s own
  // redaction ever runs, and this catch must not assume that redaction already happened — an
  // injected test launcher, or a future adapter, can throw something `RunnerLaunchError` never
  // touched. THE STAKES ARE HIGHER HERE THAN IN managed-scan: this plugin's `record` writes to a
  // durable, replicated, backed-up JSON file (`saveState`), and `reconcile.ts` copies that `detail`
  // into an `insertDecision` `inputContext` from there — an identity redactor would turn one
  // ephemeral log line into a permanent database row carrying a credential.
  let secretValues: string[] = [];
  const redact = (text: string): string => redactSecrets(text, secretValues);

  // EVERY PATH OUT OF THE REST OF THIS FUNCTION RECORDS AN OUTCOME. Before this, `trigger()` had no
  // outer catch at all — a `create`/`copy-in` failure, a `writeSourceFiles` refusal, or a `mkdir`
  // error propagated straight out as a rejection, `state.keys[cacheKey]` was never written, and
  // `status()` reported `pending` forever (indistinguishable from "still running"): the SAME
  // property managed-scan had, fixed here with the SAME helper but a genuinely redacting closure.
  await withRecordedOutcome(
    {
      record: (succeeded, detail) => {
        outcome = { externalId, succeeded, detail };
      },
      redact
    },
    async () => {
      await mkdir(workspaceDir, { recursive: true });
      const infraCreds = await resolveInfraCreds(ctx, config);
      secretValues = Object.values(infraCreds);

      if (intent.kind === "rollback") {
        const priorStateFile =
          typeof intent.priorStateRef === "string" ? intent.priorStateRef : undefined;
        // Jail PRIOR_STATE_FILE to `state-history/` (MINOR) — never let a rollback ref point outside
        // the workspace's own snapshot dir (run.sh enforces the same, defence in depth).
        if (
          !priorStateFile ||
          !priorStateFile.startsWith("state-history/") ||
          priorStateFile.includes("..")
        ) {
          outcome = {
            externalId,
            succeeded: false,
            detail:
              "managed-iac rollback: FAILED CLOSED — priorStateRef missing or not a state-history/*.tfstate path"
          };
        } else {
          const result = await runRunnerContainer(
            config,
            resolveLauncher,
            "rollback",
            workspaceDir,
            cacheKey,
            infraCreds,
            {
              PRIOR_STATE_FILE: priorStateFile
            }
          );
          outcome = {
            externalId,
            succeeded: result.succeeded,
            // `runnerOutcomeDetail`, NOT `succeeded ? stdout : stderr` — that expression recorded
            // the EMPTY STRING for a budget-killed or never-spawned runner, which is exactly the
            // pair an operator most needs told apart. See `@scp/runner-launcher`'s
            // `classifyRunnerFailure`.
            detail: runnerOutcomeDetail(result),
            stateRef: priorStateFile
          };
        }
      } else {
        const sourceFiles = intent.parameters?.sourceFiles as Record<string, string> | undefined;
        if (sourceFiles) await writeSourceFiles(workspaceDir, sourceFiles);
        const iacAction = (intent.parameters?.iacAction as "plan" | "apply" | undefined) ?? "plan";
        const result = await runRunnerContainer(
          config,
          resolveLauncher,
          iacAction,
          workspaceDir,
          cacheKey,
          infraCreds
        );
        outcome = {
          externalId,
          succeeded: result.succeeded,
          // See the rollback arm above: an empty `detail` in a DURABLE, replicated ledger is how a
          // SIGTERMed `tofu apply` came to look identical to a runner that exited quietly.
          detail: runnerOutcomeDetail(result)
        };
      }
    }
  );

  storeOutcome(state, cacheKey, outcome);
  // PRUNE BEFORE THE WRITE, so the bound is a property of what reaches the disk rather than of what
  // is in memory at some later moment. See `pruneDedupState`.
  const pruned = pruneDedupState(state);
  if (pruned > 0) {
    ctx.logger.info("managed-iac: pruned the oldest dedup-cache entries", {
      pruned,
      kept: Object.keys(state.keys).length
    });
  }
  try {
    await saveState(config.statePath, state);
  } catch (err) {
    // LOW-6: THE RUN ALREADY HAPPENED (succeeded or failed) by this point — for `apply`/`rollback`
    // that may be a LIVE infrastructure mutation. Rejecting here would tell the caller "nothing
    // happened" when something did, and a caller that reacts to a rejection by retrying could
    // double-apply — the exact failure mode this cache exists to prevent. So this is BEST EFFORT and
    // LOUD, never a rejection: the caller still gets its real `externalId`, and the failure to
    // persist is logged at error level rather than swallowed silently.
    ctx.logger.error("managed-iac: run completed but the dedup state could not be saved", {
      externalId,
      succeeded: outcome.succeeded,
      error: err instanceof Error ? err.message : String(err)
    });
  }
  ctx.logger.info("managed-iac: run complete", { externalId, succeeded: outcome.succeeded });
  return { externalId };
}

async function status(ctx: PluginContext, ref: ExternalRunRef): Promise<ExecutionStatus> {
  const config = asConfig(ctx.config);
  const state = await loadState(config.statePath);
  const outcome = Object.values(state.keys).find((o) => o.externalId === ref.externalId);
  if (!outcome) {
    return {
      phase: "pending",
      detail: "managed-iac: unknown run (not found in local outcome cache)"
    };
  }
  return {
    phase: outcome.succeeded ? "succeeded" : "failed",
    // NO SLICE. The evidence is bounded WHERE IT IS COMPOSED (`@scp/runner-launcher`'s
    // `boundDetail`, enforced by `RunOutcome.detail`'s type) and it is bounded KEEPING BOTH ENDS.
    // The `.slice(0, 4000)` that used to be here was the third of three consumers each front-slicing
    // a string none of them built, and it discarded the runner's last words — the diagnosis — for
    // any run that printed more than ~1.8 KB. It also bounded nothing that mattered: the durable
    // ledger behind `loadState` had already been written unsliced.
    detail: outcome.detail,
    stateRef: outcome.stateRef,
    progress: 1
  };
}

async function abort(_ctx: PluginContext, _ref: ExternalRunRef): Promise<AbortResult> {
  // See module doc — trigger() is synchronous, so by the time any caller could hold a ref to
  // abort, the container has already exited. Honestly reported, never silently ignored.
  return {
    aborted: false,
    detail: "managed-iac: trigger() runs synchronously to completion; nothing left to abort"
  };
}

function describeCapabilities(): ExecutorCapabilities {
  return {
    supportsObserve: true,
    supportsTrigger: true,
    supportsAbort: true, // advertised for a well-formed answer; abort() always {aborted:false} (module doc)
    triggerKinds: ["sync", "rollback", "custom"]
  };
}

/**
 * THE LAUNCHER SEAM (M23.1). `resolveLauncher` defaults to the Docker adapter — the only one that
 * exists until M23.2 — and is a FACTORY PARAMETER rather than a config field on purpose: adapter
 * selection is not tenant-facing, and adding a config field would mean adding it to the
 * server-injected/never-tenant-settable class in all three enforcement layers for no behaviour a
 * caller can yet ask for. Tests pass a substitute here, which is what makes "the plugin really goes
 * through the port" falsifiable rather than a claim about the source text.
 */
export function createManagedIacExecutorPlugin(
  // THE DEFAULT IS THE SELECTING RESOLVER, NOT THE DOCKER ONE — M23.2, AND THIS LINE IS THE WIRING.
  // `subprocess-entry.ts` constructs this plugin with NO argument, so whatever stands here is what
  // every production run uses. While it was `resolveDockerRunnerLauncher`, an operator could set
  // `runnerLauncher: "kubernetes"` through every layer of the chart and every managed run would
  // still shell out to a `docker` binary the `scpd` image does not ship — a feature correctly built
  // and installed nowhere, which is this repository's dominant defect class (CLAUDE.md). Delete
  // this and `runner-launcher-selection.test.ts`'s named case for this plugin dies.
  resolveLauncher: ResolveRunnerLauncher = resolveRunnerLauncher
): ExecutorPlugin {
  return {
    observe,
    trigger: (ctx, intent) => trigger(ctx, intent, resolveLauncher),
    status,
    abort,
    describeCapabilities
  };
}

export const managedIacExecutorPlugin: ExecutorPlugin = createManagedIacExecutorPlugin();

/**
 * Manifest `configSchema` is the TENANT-facing surface only — `additionalProperties: false` so a
 * binding that tries to set the server-governed runnerImage/networkMode/workspace* fields is
 * REJECTED at create/update (routes/executors.ts's config validation). The server injects those
 * fields into this plugin's runtime config itself (executor-bindings-repo.ts).
 */
export const manifest: PluginManifest = {
  id: "managed-iac",
  kind: "executor",
  version: "0.1.0",
  configSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      infraCredsSecretKeys: { type: "object", additionalProperties: { type: "string" } },
      // BOUNDED AT BOTH ENDS (M23.1c). The `maximum` is the half that was missing: with only a
      // floor, a tenant could set 2^31 and make the runner unkillable by its own timeout AND
      // unbound the plugin-host RPC budget derived from it. Enforced at every write door by
      // `validatePluginConfig` (Ajv honours `maximum`), and clamped again host-side for rows
      // stored before the ceiling existed.
      timeoutMs: {
        type: "integer",
        minimum: MANAGED_RUN_TIMEOUT_MIN_MS,
        maximum: MANAGED_RUN_TIMEOUT_MAX_MS,
        default: DEFAULT_TIMEOUT_MS
      }
    }
  }
};

export default managedIacExecutorPlugin;
