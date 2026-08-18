import { mkdir } from "node:fs/promises";
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
  MANAGED_RUN_TIMEOUT_MIN_MS,
  resolveDockerRunnerLauncher,
  toRunnerRunId,
  withRecordedOutcome,
  type ResolveRunnerLauncher,
  type RunnerCopyIn
} from "@scp/runner-launcher";

/**
 * `@scp/plugin-managed-scan` — the `scp-managed-scan` executor, the thin orchestrator behind the
 * commander's **promotion scan step** (ADR-0020 §1, proposal §13.3, charter's Managed Execution
 * Exception 2026-07-23 amendment). It MIRRORS `@scp/plugin-managed-iac` exactly in shape: a thin
 * orchestrator that launches an ephemeral single-shot runner container from a SEPARATE image
 * (`scp-runner-scan`, `apps/runner-scan`) and copies evidence out — it contains no scanner itself
 * (the scanner exists ONLY in the runner image, exactly as `tofu` exists only in `scp-runner-iac`).
 *
 * WHAT THIS PLUGIN DOES (and does NOT): it runs one scan container per `trigger()` — `docker create
 * --network none` (server-injected, default `none`), `docker cp` the SERVER-pulled OCI image layout
 * IN, `start -a`, `docker cp` the runner's `/work/out` evidence back OUT to a server-controlled
 * directory, `rm -f`. It does NOT pull the subject's bytes (the SERVER does that, by digest, over
 * the allowlisted skopeo channel — the runner has NO network) and it does NOT parse the Trivy result
 * into `ScanEvidence` (the COMMANDER does that, where `ScanEvidenceSchema` and the M17.5 threshold
 * resolution live — same split as scp-runner-iac, where the orchestrator persists evidence the
 * ephemeral container produced). So this plugin adds NO new verb (charter principle 1): `observe()`
 * returns `[]`, `trigger()` runs the container, `status()`/`abort()` report it.
 *
 * SECURITY MODEL (mirrors managed-iac's adversarial-review CRITICAL #1): `dockerBinary` decides WHAT
 * EXECUTABLE runs, and `runnerImage`/`networkMode`/`workspaceRoot` decide what image runs and on
 * which network — they are **operator/server-governed, NEVER tenant-suppliable**. The manifest
 * `configSchema` below is `additionalProperties: false` and lists ONLY `timeoutMs`, so a binding that
 * tries to set any of them is rejected at create/update; the server injects them into this plugin's
 * config when it provisions the instance (`coordination/executor-bindings-repo.ts`'s
 * `resolveExecutorPluginInstance`, spread LAST so they win). The runner is launched with NO docker
 * socket mount, NO bind mount (the workspace is `docker cp`'d in/out, never mounted — a host-path
 * escape is structurally impossible), and the server-fixed `--network` (default `none` — the runner
 * reaches no hosts).
 *
 * THAT SCHEMA IS ONLY A GATE IF THE SERVER RUNS IT. It did not, for this module: `managed-scan` was
 * on `KNOWN_EXECUTOR_MODULES` but absent from `apps/server`'s `MANIFEST_BY_MODULE`, and
 * `validatePluginConfig` returned early for a module it had no manifest for — so a tenant binding
 * could set `dockerBinary` to any host path and this plugin would `execFile` it. The paragraph above
 * described a protection that was never wired up. Both halves are now pinned by tests
 * (`plugin-manifests-fail-closed.test.ts`): the schema refuses the governed keys, AND every
 * allowlisted executor module is asserted to HAVE a manifest.
 *
 * SYNCHRONOUS TRIGGER (deliberate v1 simplification, exactly as managed-iac): `trigger()` runs the
 * container to completion; a scan is a short, read-only analysis of an artifact already materialized
 * locally, so there is nothing to poll or abort by the time a ref exists.
 */

export interface ManagedScanConfig {
  /** SERVER-INJECTED (never tenant): the vetted, pinned `scp-runner-scan` image reference. */
  runnerImage: string;
  /** SERVER-INJECTED (never tenant): `docker create --network <value>`, default `"none"`. */
  networkMode: string;
  /** ms before the container run is killed as hung (TENANT config). Default 10 minutes. */
  timeoutMs?: number;
  /** SERVER-INJECTED (never tenant): the container CLI to exec. Refused by the manifest schema and
   *  injected by `resolveExecutorPluginInstance` from `SCP_MANAGED_RUNNER_DOCKER_BINARY`, so the
   *  `?? "docker"` below is a fallback for this package's own unit tests, not a tenant hook. */
  dockerBinary?: string;
}

const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_NETWORK_MODE = "none";

/** The methods this runner image ships — `trivy` (container images), `openscap` (compliance), and
 *  `trivy-vm` (the 13.3a MACHINE-IMAGE arm: the runner resolves the disk image carried by the pulled
 *  OCI layout and `trivy vm`s it). A `trigger()` naming any other method fails closed here rather
 *  than launching a container that would `exit 2`.
 *
 *  Deliberately mirrors — and must stay in step with — the server's `RUNNER_SUPPORTED_METHODS`
 *  (`promotion-scan-step.ts`). The duplication is structural, not laziness: this package does not
 *  depend on `@scp/schemas` (a plugin runs behind the subprocess isolation host and carries the
 *  minimum surface), so the set is exported instead and the SERVER-side test pins the containment
 *  that actually matters — every method the server dispatches must be one this plugin will run. */
export const SUPPORTED_SCAN_METHODS: readonly string[] = ["trivy", "openscap", "trivy-vm"];
const SUPPORTED_METHODS = new Set(SUPPORTED_SCAN_METHODS);

function asConfig(config: unknown): ManagedScanConfig {
  const c = config as Partial<ManagedScanConfig> | undefined;
  if (!c?.runnerImage) {
    throw new Error(
      "managed-scan: runnerImage is not configured (server-governed — is managed scanning enabled? SCP_MANAGED_SCAN_RUNNER_IMAGE)"
    );
  }
  return {
    runnerImage: c.runnerImage,
    networkMode: c.networkMode ?? DEFAULT_NETWORK_MODE,
    timeoutMs: c.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    dockerBinary: c.dockerBinary ?? "docker"
  };
}

/** What the commander's promotion scan step passes on `intent.parameters` — all SERVER-controlled:
 *  the pulled OCI layout to scan and where the runner's evidence should land. */
export interface ManagedScanIntentParameters {
  /** The scan METHOD (registry-selected per artifact type): `"trivy"`, `"trivy-vm"` or `"openscap"`. */
  method: string;
  /** HOST path to the OCI image layout the SERVER pulled by digest (copied INTO the container's
   *  `/work/image`). The runner has no network and pulls nothing. For `trivy-vm` this layout carries
   *  the MACHINE IMAGE (a disk-image layer, or a tar layer containing one — run.sh's packaging
   *  convention); the copy-in seam itself is identical, so the machine-image arm adds no new
   *  ingress and no new egress. */
  inputDir: string;
  /** HOST path the runner's `/work/out` evidence is copied back into (the commander reads
   *  `<outputDir>/result.json` for trivy AND trivy-vm — a `trivy vm` run emits the same native Trivy
   *  JSON — and `<outputDir>/arf.xml` for openscap). */
  outputDir: string;
  /** OpenSCAP only — the XCCDF profile id (`xccdf_..._profile_*`) to evaluate. Ignored by trivy.
   *  Server-resolved from the scan-requirement/registry config (never tenant-suppliable steering of
   *  the runner image/network); the profile only selects WHICH compliance baseline is asserted — the
   *  gate threshold that authorizes/refuses is operator-governed and applied to the counts regardless. */
  profile?: string;
  /** OpenSCAP only — the ABSOLUTE path (inside the runner image) of the SSG datastream to evaluate
   *  against (e.g. `/usr/share/xml/scap/ssg/content/ssg-debian11-ds.xml`). Ignored by trivy. */
  datastream?: string;
  /** M13.3b-ii — SERVER-provided HOST path to a pre-loaded Trivy DB cache dir (a Trivy `--cache-dir`
   *  layout: `<dir>/db/{trivy.db,metadata.json}`). When set, it is `docker cp`'d into the runner at
   *  `/work/db` and `SCP_SCAN_DB_DIR=/work/db` is set, so run.sh points Trivy at the pre-loaded DB
   *  INSTEAD of the image-baked default. Unset ⇒ the runner uses the baked DB (fail-closed fallback).
   *  Server-governed like inputDir; a tenant cannot supply it (the promotion scan step resolves it). */
  scanDbDir?: string;
  /** M13.3b-ii — OPTIONAL SERVER-provided HOST path to a pre-loaded SSG/SCAP content dir, copied to
   *  `/work/scap` with `SCP_SCAN_SCAP_DIR=/work/scap`. Rarely used: SSG has no OCI upstream to
   *  skopeo-refresh, so datastreams stay baked (the documented trivy-db/SSG asymmetry, §13.3b). */
  scanScapDir?: string;
}

interface RunResult {
  succeeded: boolean;
  stdout: string;
  stderr: string;
}

/**
 * Launch the single-shot scan container. COPY the pulled layout in / evidence out (never bind-mount;
 * mirrors managed-iac's CRITICAL #1 fix + the dind-share fix). The ONE place the runner image is
 * executed — with the server-fixed `--network` (default `none`), no docker.sock, no `-v`.
 *
 * M23.1: the create/copy-in/start/copy-out/remove sequence itself lives in `@scp/runner-launcher`,
 * shared with `@scp/plugin-managed-iac` and `@scp/plugin-managed-dep`. What stays HERE is what is
 * this plugin's own — the one-to-three copy-in shape, the two conditional `-e` pairs that pair with
 * them, the 32 MiB buffer, and a copy-out that is `on-success` + `propagate`.
 */
async function runScanContainer(
  config: ManagedScanConfig,
  resolveLauncher: ResolveRunnerLauncher,
  /** This run's own key — see `RunnerSpec.runId` on why the CALLER supplies the identity. */
  runKey: string,
  method: string,
  inputDir: string,
  outputDir: string,
  scanArgs: string[],
  preload: { scanDbDir?: string; scanScapDir?: string }
): Promise<RunResult> {
  // When the server provides a pre-loaded DB / SCAP dir (M13.3b-ii) we set the env that steers
  // run.sh to it — still `--network none`, still copied IN and not mounted, so a host-path escape
  // stays structurally impossible. THE `-e` PAIRS AND THE COPIES ARE INDEPENDENTLY CONDITIONAL and
  // in a FIXED order (DB then SCAP for the env, subject/DB/SCAP for the copies); the golden's
  // "middle case" exists because a launcher that emitted both whenever EITHER was present would
  // otherwise pass.
  const env: string[] = [];
  if (preload.scanDbDir) env.push("SCP_SCAN_DB_DIR=/work/db");
  if (preload.scanScapDir) env.push("SCP_SCAN_SCAP_DIR=/work/scap");

  // The SERVER-pulled OCI layout always; the operator-governed caches only when resolved.
  const copyIn: RunnerCopyIn[] = [{ hostDir: inputDir, containerPath: "/work/image" }];
  if (preload.scanDbDir) copyIn.push({ hostDir: preload.scanDbDir, containerPath: "/work/db" });
  if (preload.scanScapDir) {
    copyIn.push({ hostDir: preload.scanScapDir, containerPath: "/work/scap" });
  }

  return resolveLauncher({ dockerBinary: config.dockerBinary }).run({
    // The same key `externalId` is built from, so a container found orphaned can be matched to the
    // run the commander is waiting on.
    runId: toRunnerRunId(runKey),
    // ATTRIBUTION FOR AN ORPHAN (M23.0 defect 1): `docker ps -a --filter
    // label=scp.executor=scp-managed-scan` finds every container this executor ever left behind.
    labels: { "scp.executor": "scp-managed-scan", "scp.run-id": toRunnerRunId(runKey) },
    image: config.runnerImage,
    // The method + any method-specific run.sh args (openscap: profile, datastream) are the
    // ENTRYPOINT argv — server-resolved, never a mount and never a network toggle.
    operands: [method, ...scanArgs],
    // A CONFIG READ, unlike managed-dep: this class's charter clause is qualified ("excepting
    // operator-allowlisted registry pulls"), so the operator setting is legitimate. Server-injected
    // (default "none"), never tenant.
    networkMode: config.networkMode,
    // BOTH `SCP_SCAN_*_DIR` ARE CONTAINER PATHS, NOT SECRETS, so they stay on the command line as
    // `-e` and this plugin's five golden `create` lines do not move by a byte beyond the name and
    // labels. The secrecy split is not a "hide the environment" reflex; it is the axis the
    // Kubernetes adapter must branch on, and mislabelling a path as a secret would cost a Secret
    // object per run for nothing.
    env,
    // NO CREDENTIAL AT ALL. A scan reads bytes the server already pulled; the runner holds nothing.
    secretEnv: [],
    copyIn,
    // ONLY ON SUCCESS, AND NOT GUARDED — the opposite of managed-iac on both axes. A failed scan
    // must produce NO evidence (fail-closed: the commander writes none and E6 then refuses), and a
    // failed copy-out escapes `trigger()` rather than being swallowed. M23.0 recorded that the
    // escape leaves the run reporting `pending` forever; that defect is deliberately preserved here
    // and is the next increment's, because fixing it now would make "byte-identical" untestable.
    copyOut: {
      containerPath: "/work/out",
      hostDir: outputDir,
      when: "on-success",
      onFailure: "propagate"
    },
    timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    // 32 MiB — the largest of the three, because a Trivy report is the biggest thing any of these
    // runners writes to stdout. NOT a shared default.
    maxBuffer: 32 * 1024 * 1024
  });
}

// -----------------------------------------------------------------------------------------
// ExecutorPlugin — NO new verb (charter principle 1). observe() is inert; trigger() runs one scan.
// -----------------------------------------------------------------------------------------

// Synchronous-trigger outcome cache, keyed by externalId (in-memory — a scan is a fresh,
// stateless, read-only analysis per promotion journey; there is no cross-restart idempotency to
// preserve the way a live `apply` needs one, so no durable statePath is required here).
const outcomes = new Map<string, { succeeded: boolean; detail: string }>();

async function observe(_ctx: PluginContext, _since?: Cursor): Promise<ExecutorEvent[]> {
  return []; // no push events — this executor's only activity is its own promotion-scan trigger().
}

async function trigger(
  ctx: PluginContext,
  intent: TriggerIntent,
  resolveLauncher: ResolveRunnerLauncher
): Promise<ExternalRunRef> {
  const config = asConfig(ctx.config);
  const params = (intent.parameters ?? {}) as Partial<ManagedScanIntentParameters>;
  const method = params.method ?? "";
  // THE RUN KEY AND THE EXTERNAL ID ARE THE SAME FACT, SPELLED FOR TWO AUDIENCES. `externalId` is
  // namespaced because the server stores refs from every executor in one column; `runKey` is the
  // bare key, because it becomes a container NAME and `scp-runner-managed-scan--k1` would carry the
  // plugin twice — the `scp.executor` label already says which executor this is.
  const runKey = intent.idempotencyKey ?? `${method}:${Date.now()}`;
  const externalId = `managed-scan::${runKey}`;

  if (!SUPPORTED_METHODS.has(method)) {
    const detail = `managed-scan: unsupported method '${method}' (this runner image ships 'trivy', 'trivy-vm' and 'openscap')`;
    outcomes.set(externalId, { succeeded: false, detail });
    return { externalId };
  }
  if (!params.inputDir || !params.outputDir) {
    const detail =
      "managed-scan: FAILED CLOSED — intent.parameters.inputDir/outputDir are required (server-controlled scan-subject layout + evidence sink)";
    outcomes.set(externalId, { succeeded: false, detail });
    return { externalId };
  }

  // OpenSCAP takes two extra run.sh args (profile, datastream); trivy takes none. We pass them
  // positionally; an empty string lets run.sh apply its documented default (its `${2:-default}` form
  // treats "" as unset). Trivy ignores any trailing args.
  const scanArgs: string[] =
    method === "openscap" ? [params.profile ?? "", params.datastream ?? ""] : [];

  // EVERY PATH OUT OF THE REST OF THIS FUNCTION RECORDS AN OUTCOME (M23.1 phase 2). Before this,
  // nothing below caught a rejection: a launcher failure escaped `trigger()` as a rejection, no
  // outcome was ever cached, and `status()` reported `pending` forever — indistinguishable from
  // "still running". `redact` is the identity function because this plugin holds no credential —
  // a scan reads bytes the server already pulled, `secretEnv` is always `[]` — so there is nothing
  // for it to strip; that absence is a fact about managed-scan, not a shortcut taken here.
  await withRecordedOutcome(
    {
      record: (succeeded, detail) => {
        outcomes.set(externalId, { succeeded, detail: `managed-scan: ${detail}` });
      },
      redact: (text) => text
    },
    async () => {
      await mkdir(params.outputDir!, { recursive: true });
      const result = await runScanContainer(
        config,
        resolveLauncher,
        runKey,
        method,
        params.inputDir!,
        params.outputDir!,
        scanArgs,
        {
          scanDbDir: params.scanDbDir,
          scanScapDir: params.scanScapDir
        }
      );
      outcomes.set(externalId, {
        succeeded: result.succeeded,
        detail: result.succeeded
          ? `managed-scan: ${method} scan complete — evidence at ${params.outputDir}/result.json`
          : `managed-scan: ${method} scan FAILED — ${result.stderr.slice(0, 2000)}`
      });
      ctx.logger.info("managed-scan: run complete", {
        externalId,
        method,
        succeeded: result.succeeded
      });
    }
  );
  return { externalId };
}

async function status(_ctx: PluginContext, ref: ExternalRunRef): Promise<ExecutionStatus> {
  const outcome = outcomes.get(ref.externalId);
  if (!outcome) {
    return {
      phase: "pending",
      detail: "managed-scan: unknown run (not found in local outcome cache)"
    };
  }
  return {
    phase: outcome.succeeded ? "succeeded" : "failed",
    detail: outcome.detail.slice(0, 4000),
    progress: 1
  };
}

async function abort(_ctx: PluginContext, _ref: ExternalRunRef): Promise<AbortResult> {
  // trigger() runs synchronously to completion — by the time any caller holds a ref, the container
  // has already exited and been rm -f'd. Honestly reported, never silently ignored.
  return {
    aborted: false,
    detail: "managed-scan: trigger() runs synchronously to completion; nothing left to abort"
  };
}

function describeCapabilities(): ExecutorCapabilities {
  return {
    supportsObserve: true,
    supportsTrigger: true,
    supportsAbort: true, // advertised for a well-formed answer; abort() always {aborted:false} (module doc)
    triggerKinds: ["custom"]
  };
}

/**
 * THE LAUNCHER SEAM (M23.1). `resolveLauncher` defaults to the Docker adapter — the only one that
 * exists until M23.2 — and is a FACTORY PARAMETER rather than a config field on purpose. Adapter
 * selection is not tenant-facing, and a new config field would have to join the server-injected,
 * never-tenant-settable class in all three enforcement layers (this manifest's `configSchema`,
 * `validatePluginConfig` at the four write doors, and the LAST-wins injection sites) for behaviour
 * no caller can yet ask for. THIS PLUGIN IS THE REASON THAT RULE IS WRITTEN DOWN: it shipped a live
 * RCE by sitting on `KNOWN_EXECUTOR_MODULES` with no manifest, so `dockerBinary` was tenant-settable
 * and `execFile`d.
 */
export function createManagedScanExecutorPlugin(
  resolveLauncher: ResolveRunnerLauncher = resolveDockerRunnerLauncher
): ExecutorPlugin {
  return {
    observe,
    trigger: (ctx, intent) => trigger(ctx, intent, resolveLauncher),
    status,
    abort,
    describeCapabilities
  };
}

export const managedScanExecutorPlugin: ExecutorPlugin = createManagedScanExecutorPlugin();

/**
 * Manifest `configSchema` is the TENANT-facing surface only — `additionalProperties: false` so a
 * binding that tries to set the server-governed `dockerBinary`/`runnerImage`/`networkMode`/
 * `workspaceRoot` fields is REJECTED at create/update. The server injects those fields into this
 * plugin's runtime config itself (executor-bindings-repo.ts's `managedScanServerSettings`).
 */
export const manifest: PluginManifest = {
  id: "managed-scan",
  kind: "executor",
  version: "0.1.0",
  configSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
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

export default managedScanExecutorPlugin;
