import { execFile } from "node:child_process";
import { promisify } from "node:util";
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

const execFileAsync = promisify(execFile);

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
 * SECURITY MODEL (mirrors managed-iac's adversarial-review CRITICAL #1): `runnerImage`/`networkMode`/
 * `workspaceRoot` decide WHAT image runs and on WHICH network — they are **operator/server-governed,
 * NEVER tenant-suppliable**. The manifest `configSchema` below is `additionalProperties: false` and
 * lists ONLY `timeoutMs`, so a binding that tries to set the server-governed fields is rejected at
 * create/update; the server injects them into this plugin's config when it provisions the instance
 * (`coordination/executor-bindings-repo.ts`'s `resolveExecutorPluginInstance`, spread LAST so they
 * win). The runner is launched with NO docker socket mount, NO bind mount (the workspace is `docker
 * cp`'d in/out, never mounted — a host-path escape is structurally impossible), and the server-fixed
 * `--network` (default `none` — the runner reaches no hosts).
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
  /** Override for tests only; default "docker". Server-injected in production. */
  dockerBinary?: string;
}

const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_NETWORK_MODE = "none";

/** The methods this runner image ships. Both `trivy` and `openscap` (M13.3b part 1 — proposal §13.3
 *  "Increment order: Trivy first, OpenSCAP second") are dispatchable now; a `trigger()` naming any
 *  other method fails closed here rather than launching a container that would `exit 2`. */
const SUPPORTED_METHODS = new Set(["trivy", "openscap"]);

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
  /** The scan METHOD (registry-selected per artifact type): `"trivy"` or `"openscap"`. */
  method: string;
  /** HOST path to the OCI image layout the SERVER pulled by digest (copied INTO the container's
   *  `/work/image`). The runner has no network and pulls nothing. */
  inputDir: string;
  /** HOST path the runner's `/work/out` evidence is copied back into (the commander reads
   *  `<outputDir>/result.json` for trivy, `<outputDir>/arf.xml` for openscap). */
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
 */
async function runScanContainer(
  config: ManagedScanConfig,
  method: string,
  inputDir: string,
  outputDir: string,
  scanArgs: string[],
  preload: { scanDbDir?: string; scanScapDir?: string }
): Promise<RunResult> {
  const docker = config.dockerBinary ?? "docker";
  const timeout = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBuffer = 32 * 1024 * 1024;

  // 1. CREATE (not run) — no `-v` host bind mount, no docker.sock, server-fixed --network. The
  //    container exists but hasn't started; `docker cp` (step 2) requires exactly that state. The
  //    method + any method-specific run.sh args (openscap: profile, datastream) are the ENTRYPOINT
  //    argv — server-resolved, never a mount or a network toggle. When the server provides a
  //    pre-loaded DB / SCAP dir (M13.3b-ii), we set the env that steers run.sh to it (still --network
  //    none, still copied IN not mounted — a host-path escape stays structurally impossible).
  const envArgs: string[] = [];
  if (preload.scanDbDir) envArgs.push("-e", "SCP_SCAN_DB_DIR=/work/db");
  if (preload.scanScapDir) envArgs.push("-e", "SCP_SCAN_SCAP_DIR=/work/scap");
  const { stdout: createOut } = await execFileAsync(
    docker,
    ["create", "--network", config.networkMode, ...envArgs, config.runnerImage, method, ...scanArgs],
    { timeout, maxBuffer }
  );
  const containerId = createOut.trim();

  try {
    // 2. COPY the SERVER-pulled OCI layout INTO the container's /work/image (not a mount).
    await execFileAsync(docker, ["cp", `${inputDir}/.`, `${containerId}:/work/image`], {
      timeout,
      maxBuffer
    });

    // 2b. COPY the SERVER-provided pre-loaded DB / SCAP content IN (M13.3b-ii). A SECOND `docker cp`
    //     of an operator-governed, server-maintained cache dir — same copy-in seam as the subject,
    //     never a mount, so the runner still reaches no host path and no network.
    if (preload.scanDbDir) {
      await execFileAsync(docker, ["cp", `${preload.scanDbDir}/.`, `${containerId}:/work/db`], {
        timeout,
        maxBuffer
      });
    }
    if (preload.scanScapDir) {
      await execFileAsync(docker, ["cp", `${preload.scanScapDir}/.`, `${containerId}:/work/scap`], {
        timeout,
        maxBuffer
      });
    }

    // 3. START attached — blocks until the container exits and propagates its exit code. A non-zero
    //    scanner run (a broken/failed scan) rejects here and is captured as succeeded:false, so a
    //    broken scan can never masquerade as a clean result (fail-closed — the commander produces NO
    //    evidence for a failed run, and E6 then refuses).
    let succeeded: boolean;
    let stdout: string;
    let stderr: string;
    try {
      const r = await execFileAsync(docker, ["start", "-a", containerId], { timeout, maxBuffer });
      succeeded = true;
      stdout = r.stdout;
      stderr = r.stderr;
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; message: string };
      succeeded = false;
      stdout = e.stdout ?? "";
      stderr = e.stderr ?? e.message;
    }

    // 4. COPY the evidence (/work/out/result.json, scanner-version.txt) back OUT — only meaningful on
    //    a succeeded run, but attempted best-effort so a partial result is available for diagnosis.
    if (succeeded) {
      await execFileAsync(docker, ["cp", `${containerId}:/work/out/.`, outputDir], {
        timeout,
        maxBuffer
      });
    }

    return { succeeded, stdout, stderr };
  } finally {
    // 5. Destroy the container unconditionally.
    await execFileAsync(docker, ["rm", "-f", containerId], { timeout: 30_000 }).catch(
      () => undefined
    );
  }
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

async function trigger(ctx: PluginContext, intent: TriggerIntent): Promise<ExternalRunRef> {
  const config = asConfig(ctx.config);
  const params = (intent.parameters ?? {}) as Partial<ManagedScanIntentParameters>;
  const method = params.method ?? "";
  const externalId = `managed-scan::${intent.idempotencyKey ?? `${method}:${Date.now()}`}`;

  if (!SUPPORTED_METHODS.has(method)) {
    const detail = `managed-scan: unsupported method '${method}' (this runner image ships 'trivy' and 'openscap')`;
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

  await mkdir(params.outputDir, { recursive: true });
  const result = await runScanContainer(config, method, params.inputDir, params.outputDir, scanArgs, {
    scanDbDir: params.scanDbDir,
    scanScapDir: params.scanScapDir
  });
  outcomes.set(externalId, {
    succeeded: result.succeeded,
    detail: result.succeeded
      ? `managed-scan: ${method} scan complete — evidence at ${params.outputDir}/result.json`
      : `managed-scan: ${method} scan FAILED — ${result.stderr.slice(0, 2000)}`
  });
  ctx.logger.info("managed-scan: run complete", { externalId, method, succeeded: result.succeeded });
  return { externalId };
}

async function status(_ctx: PluginContext, ref: ExternalRunRef): Promise<ExecutionStatus> {
  const outcome = outcomes.get(ref.externalId);
  if (!outcome) {
    return { phase: "pending", detail: "managed-scan: unknown run (not found in local outcome cache)" };
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

export const managedScanExecutorPlugin: ExecutorPlugin = {
  observe,
  trigger,
  status,
  abort,
  describeCapabilities
};

export function createManagedScanExecutorPlugin(): ExecutorPlugin {
  return managedScanExecutorPlugin;
}

/**
 * Manifest `configSchema` is the TENANT-facing surface only — `additionalProperties: false` so a
 * binding that tries to set the server-governed `runnerImage`/`networkMode` fields is REJECTED at
 * create/update. The server injects those fields into this plugin's runtime config itself
 * (executor-bindings-repo.ts's `managedScanServerSettings`).
 */
export const manifest: PluginManifest = {
  id: "managed-scan",
  kind: "executor",
  version: "0.1.0",
  configSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      timeoutMs: { type: "integer", minimum: 1000, default: DEFAULT_TIMEOUT_MS }
    }
  }
};

export default managedScanExecutorPlugin;
