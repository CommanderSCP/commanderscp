/** The subprocess plugin host. See docs/plugin-host.md §50. */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface as ReadlineInterface } from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ScheduleSpec,
  AbortResult,
  BundleRef,
  ControlOutcome,
  ControlRequest,
  Cursor,
  DeliveryResult,
  DependencyIndexCapabilities,
  DependencyIndexDigestResult,
  DependencyIndexEcosystem,
  DependencyIndexQuery,
  DependencyIndexResult,
  DiscoveryProposal,
  DomainCursor,
  ExecutionStatus,
  ExecutorCapabilities,
  ExportOptions,
  ExternalRunRef,
  ImportReport,
  JournalSegment,
  NotificationMessage,
  TriggerIntent
} from "@scp/plugin-api";
import type { ReadFileAtRefRequest, ReadFileAtRefResult } from "@scp/git-provider-core";
import type {
  ControlPluginClient,
  DependencyIndexPluginClient,
  DiscoveryPluginClient,
  ExecutorPluginClient,
  FederationTransportPluginClient,
  GitFileReadPluginClient,
  NotificationPluginClient,
  PluginHost,
  PluginHostInstanceConfig
} from "./contract.js";
import { resolveCallPolicy } from "./call-policy.js";
import {
  encodeMessage,
  isErrorResponse,
  isReadyNotification,
  isResponse,
  parseMessage,
  type RpcMessage
} from "./rpc-protocol.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
/** When THIS module is itself executing as compiled JS. See docs/plugin-host.md §51. */
const RUNNING_FROM_SOURCE = __filename.endsWith(".ts");
const DEFAULT_SUBPROCESS_ENTRY_PATH = path.resolve(
  __dirname,
  RUNNING_FROM_SOURCE ? "subprocess-entry.ts" : "subprocess-entry.js"
);

export interface PluginHostOptions {
  /** The HANG DETECTOR. See docs/plugin-host.md §52. */
  callTimeoutMs?: number;
  /** First restart delay after a crash (ms), doubled per consecutive crash. Default 200ms. */
  restartBackoffBaseMs?: number;
  maxRestartBackoffMs?: number;
  /** An instance that stays up this long before crashing again resets its backoff to the base
   *  delay — otherwise a plugin that crash-loops forever would (correctly) back off forever, but
   *  one that runs fine for hours between rare crashes would (incorrectly) inherit a stale, long
   *  delay from ancient history. Default 5s. */
  stabilityWindowMs?: number;
  /** Node's `--max-old-space-size` for every spawned child, in MB. Default 256. */
  maxOldSpaceMb?: number;
  /** CRITICAL #4 (PR #7 review): max bytes a single stdout "line" (bytes between two `\n`s) may
   *  accumulate to before the host treats the child as faulty and kills it — readline itself has
   *  no such cap, so an unbounded/no-newline stream would otherwise grow the PARENT's memory
   *  forever. Default 4MB (generous for any real JSON-RPC message this protocol carries). */
  maxLineBytes?: number;
  /** Overridable for tests only — defaults to the real compiled subprocess-entry.js next to this file. */
  subprocessEntryPath?: string;
  /** Overridable for tests only — defaults to `process.execPath` (the real `node` binary). */
  nodeExecutable?: string;
}

/** The previous environment passthrough was far too wide. See docs/plugin-host.md §53. */
function minimalChildEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "HOME", "TMPDIR", "TMP", "TEMP"]) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

/** The line reader has no built-in cap, so one is added. See docs/plugin-host.md §54. */
function createLineLengthTracker(maxBytes: number): { record(chunk: Buffer): boolean } {
  let sinceNewline = 0;
  return {
    record(chunk: Buffer): boolean {
      let searchStart = 0;
      for (;;) {
        const idx = chunk.indexOf(0x0a, searchStart);
        if (idx === -1) {
          sinceNewline += chunk.length - searchStart;
          return sinceNewline > maxBytes;
        }
        sinceNewline += idx - searchStart;
        if (sinceNewline > maxBytes) return true;
        sinceNewline = 0;
        searchStart = idx + 1;
      }
    }
  };
}

const DEFAULTS: Required<
  Pick<
    PluginHostOptions,
    | "callTimeoutMs"
    | "restartBackoffBaseMs"
    | "maxRestartBackoffMs"
    | "stabilityWindowMs"
    | "maxOldSpaceMb"
    | "maxLineBytes"
  >
> = {
  callTimeoutMs: 10_000,
  restartBackoffBaseMs: 200,
  maxRestartBackoffMs: 10_000,
  stabilityWindowMs: 5_000,
  maxOldSpaceMb: 256,
  maxLineBytes: 4 * 1024 * 1024
};

/** Thrown internally when a child exits while a call to it is in flight — `call()` catches this
 *  exact type to decide whether a transparent retry is still possible within budget; any other
 *  rejection (a real RPC error the plugin itself raised) propagates straight to the caller. */
class PluginInstanceCrashedError extends Error {
  constructor(instanceId: string) {
    super(`plugin instance '${instanceId}' exited while this call was in flight`);
    this.name = "PluginInstanceCrashedError";
  }
}

interface PendingCall {
  resolve(result: unknown): void;
  reject(err: Error): void;
  timer: NodeJS.Timeout;
}

interface Instance {
  config: PluginHostInstanceConfig;
  child?: ChildProcessWithoutNullStreams;
  rl?: ReadlineInterface;
  ready: boolean;
  readyWaiters: Array<() => void>;
  nextRequestId: number;
  pending: Map<number, PendingCall>;
  restartAttempts: number;
  spawnedAt: number;
  stopped: boolean;
  restartTimer?: NodeJS.Timeout;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Kills the whole process group, not just the one child. See docs/plugin-host.md §55. */
function killInstanceProcess(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
  if (typeof child.pid === "number" && process.platform !== "win32") {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ESRCH" && code !== "EPERM") throw err;
      // Already gone (ESRCH), or the pid/pgid has been reused by something we may not signal
      // (EPERM, see above) — either way the single-process kill below is a harmless no-op or
      // best-effort attempt, never a reason to crash the caller.
    }
  }
  child.kill(signal);
}

export class SubprocessPluginHost implements PluginHost {
  private readonly opts: Required<
    Pick<
      PluginHostOptions,
      | "callTimeoutMs"
      | "restartBackoffBaseMs"
      | "maxRestartBackoffMs"
      | "stabilityWindowMs"
      | "maxOldSpaceMb"
      | "maxLineBytes"
    >
  > & { subprocessEntryPath: string; nodeExecutable: string };
  private readonly instances = new Map<string, Instance>();

  constructor(options: PluginHostOptions = {}) {
    this.opts = {
      callTimeoutMs: options.callTimeoutMs ?? DEFAULTS.callTimeoutMs,
      restartBackoffBaseMs: options.restartBackoffBaseMs ?? DEFAULTS.restartBackoffBaseMs,
      maxRestartBackoffMs: options.maxRestartBackoffMs ?? DEFAULTS.maxRestartBackoffMs,
      stabilityWindowMs: options.stabilityWindowMs ?? DEFAULTS.stabilityWindowMs,
      maxOldSpaceMb: options.maxOldSpaceMb ?? DEFAULTS.maxOldSpaceMb,
      maxLineBytes: options.maxLineBytes ?? DEFAULTS.maxLineBytes,
      subprocessEntryPath: options.subprocessEntryPath ?? DEFAULT_SUBPROCESS_ENTRY_PATH,
      nodeExecutable: options.nodeExecutable ?? process.execPath
    };
  }

  /** Idempotent per instance id. See docs/plugin-host.md §56. */
  async start(configs: PluginHostInstanceConfig[]): Promise<void> {
    await Promise.all(
      configs
        .filter((config) => !this.instances.has(config.id))
        .map(async (config) => {
          const instance: Instance = {
            config,
            ready: false,
            readyWaiters: [],
            nextRequestId: 1,
            pending: new Map(),
            restartAttempts: 0,
            spawnedAt: 0,
            stopped: false
          };
          this.instances.set(config.id, instance);
          this.spawnInstance(instance);
          await this.waitForReady(instance, this.opts.callTimeoutMs);
        })
    );
  }

  async stop(): Promise<void> {
    for (const instance of this.instances.values()) {
      this.tearDown(instance, "plugin host is stopping");
    }
    this.instances.clear();
  }

  /** Stop and forget a named subset, leaving the rest. See docs/plugin-host.md §57. */
  async stopInstances(instanceIds: readonly string[]): Promise<void> {
    for (const id of instanceIds) {
      const instance = this.instances.get(id);
      if (!instance) continue;
      this.tearDown(instance, `plugin instance ${id} is being stopped`);
      this.instances.delete(id);
    }
  }

  private tearDown(instance: Instance, why: string): void {
    instance.stopped = true;
    if (instance.restartTimer) clearTimeout(instance.restartTimer);
    this.rejectAllPending(instance, new Error(why));
    if (instance.child) killInstanceProcess(instance.child, "SIGTERM");
  }

  /** Test-only: forcibly kills the running child, simulating. See docs/plugin-host.md §58. */
  killInstanceForTest(instanceId: string): void {
    const child = this.instances.get(instanceId)?.child;
    if (child) killInstanceProcess(child, "SIGKILL");
  }

  executor(instanceId: string): ExecutorPluginClient {
    const call = <T>(method: string, params?: unknown): Promise<T> =>
      this.call(instanceId, method, params) as Promise<T>;
    return {
      observe: (since?: Cursor) => call("observe", { since }),
      trigger: (intent: TriggerIntent) => call<ExternalRunRef>("trigger", { intent }),
      status: (ref: ExternalRunRef) => call<ExecutionStatus>("status", { ref }),
      abort: (ref: ExternalRunRef) => call<AbortResult>("abort", { ref }),
      describeCapabilities: () => call<ExecutorCapabilities>("describeCapabilities"),
      ensureSchedule: (spec: ScheduleSpec) => call<void>("ensureSchedule", { spec }),
      removeSchedule: (scheduleId: string) => call<void>("removeSchedule", { scheduleId })
    };
  }

  /** M4 counterpart to `executor()` — same host, same instance registry, one RPC method. */
  control(instanceId: string): ControlPluginClient {
    const call = <T>(method: string, params?: unknown): Promise<T> =>
      this.call(instanceId, method, params) as Promise<T>;
    return {
      evaluate: (req: ControlRequest) => call<ControlOutcome>("evaluate", { req })
    };
  }

  /** M7 counterpart to `executor()`/`control()` for a `DiscoveryPlugin` instance (github). */
  discovery(instanceId: string): DiscoveryPluginClient {
    const call = <T>(method: string, params?: unknown): Promise<T> =>
      this.call(instanceId, method, params) as Promise<T>;
    return {
      discover: () => call<DiscoveryProposal>("discover")
    };
  }

  /** M7 counterpart for a `NotificationPlugin` instance (smtp-notify/webhook-notify). */
  notification(instanceId: string): NotificationPluginClient {
    const call = <T>(method: string, params?: unknown): Promise<T> =>
      this.call(instanceId, method, params) as Promise<T>;
    return {
      send: (msg: NotificationMessage) => call<DeliveryResult>("send", { msg })
    };
  }

  /** M8 counterpart for a `FederationTransportPlugin` instance (federation-https) — same host,
   *  same timeout/restart-with-backoff guarantees, same egress-guarded (and, for this module,
   *  mTLS-capable — subprocess-entry.ts) `ScopedHttpClient`. */
  federationTransport(instanceId: string): FederationTransportPluginClient {
    const call = <T>(method: string, params?: unknown): Promise<T> =>
      this.call(instanceId, method, params) as Promise<T>;
    return {
      push: (segment: JournalSegment) => call<void>("push", { segment }),
      pull: (cursor: DomainCursor) => call<JournalSegment[]>("pull", { cursor }),
      exportBundle: (opts: ExportOptions) => call<BundleRef>("exportBundle", { opts }),
      importBundle: (bundle: BundleRef) => call<ImportReport>("importBundle", { bundle })
    };
  }

  /** M21.4 counterpart for a `DependencyIndexPlugin` instance (ADR-0032 §7) — same host, same
   *  timeout/restart-with-backoff guarantees, same egress-guarded `ScopedHttpClient`. */
  dependencyIndex(instanceId: string): DependencyIndexPluginClient {
    const call = <T>(method: string, params?: unknown): Promise<T> =>
      this.call(instanceId, method, params) as Promise<T>;
    return {
      listVersions: (query: DependencyIndexQuery) =>
        call<DependencyIndexResult>("listVersions", { query }),
      resolveDigest: (ref: {
        ecosystem: DependencyIndexEcosystem;
        coordinate: string;
        version: string;
      }) => call<DependencyIndexDigestResult>("resolveDigest", { ref }),
      describeIndex: () => call<DependencyIndexCapabilities>("describeIndex")
    };
  }

  /** M21.4 (ADR-0032 §7a) — the git-provider file read. See docs/plugin-host.md §59. */
  gitFileRead(instanceId: string): GitFileReadPluginClient {
    return {
      readFileAtRef: (request: ReadFileAtRefRequest) =>
        this.call(instanceId, "readFileAtRef", { request }) as Promise<ReadFileAtRefResult>
    };
  }

  private spawnInstance(instance: Instance): void {
    if (instance.stopped) return;
    const env: NodeJS.ProcessEnv = {
      ...minimalChildEnv(),
      SCP_PLUGIN_MODULE: instance.config.module,
      SCP_PLUGIN_INSTANCE_ID: instance.config.id,
      SCP_PLUGIN_ORG_ID: instance.config.orgId,
      SCP_PLUGIN_SCOPE_KEY: instance.config.scopeKey,
      SCP_PLUGIN_CONFIG_JSON: JSON.stringify(instance.config.config ?? {}),
      // M7: resolved (plaintext) secret values and the egress allowlist for this instance — see
      // contract.ts's `PluginHostInstanceConfig.secrets`/`allowedHosts` doc comments. Never
      // logged; `minimalChildEnv()` above already ensures the child inherits nothing else from
      // this process's own environment.
      SCP_PLUGIN_SECRETS_JSON: JSON.stringify(instance.config.secrets ?? {}),
      SCP_PLUGIN_ALLOWED_HOSTS_JSON: JSON.stringify(instance.config.allowedHosts ?? []),
      // SSRF internal-egress allowance for THIS instance (contract.ts's `allowInternalEgress`). Set
      // by the resolver ONLY from a persisted execution-system object's operator-set property — same
      // server-provenance discipline as the mtls paths below and never reachable from tenant config.
      // Its own env var (not `SCP_PLUGIN_CONFIG_JSON`), so a plugin's `config` can never spoof it.
      SCP_PLUGIN_ALLOW_INTERNAL_EGRESS: String(instance.config.allowInternalEgress === true)
    };
    // The federation mutual-TLS material handed to a subprocess. See docs/plugin-host.md §60.
    if (instance.config.module === "federation-https") {
      for (const key of [
        "SCP_FEDERATION_MTLS_CERT_FILE",
        "SCP_FEDERATION_MTLS_KEY_FILE",
        "SCP_FEDERATION_MTLS_CA_FILE"
      ]) {
        const value = process.env[key];
        if (value) env[key] = value;
      }
    }
    // The operator's extra certificate bundle, forwarded to all. See docs/plugin-host.md §61.
    {
      const executorCaFile = process.env.SCP_EXECUTOR_TLS_CA_FILE;
      if (executorCaFile) env.SCP_EXECUTOR_TLS_CA_FILE = executorCaFile;
    }
    // A `.ts` entry path (dev/test — see the module-level comment on `RUNNING_FROM_SOURCE`, or an
    // explicit test override) needs the `tsx` loader registered; the compiled `.js` production
    // path needs nothing extra. `tsx` resolves from node_modules exactly like any other import, so
    // this works whether the child's cwd is the repo root (tests) or apps/server (`pnpm dev`).
    const entryIsTypeScript = this.opts.subprocessEntryPath.endsWith(".ts");
    const child = spawn(
      this.opts.nodeExecutable,
      [
        `--max-old-space-size=${this.opts.maxOldSpaceMb}`,
        ...(entryIsTypeScript ? ["--import", "tsx"] : []),
        this.opts.subprocessEntryPath
      ],
      {
        env,
        stdio: ["pipe", "pipe", "pipe"],
        // Detached makes this child its own process-group leader. See docs/plugin-host.md §62.
        detached: true
      }
    ) as ChildProcessWithoutNullStreams;

    instance.child = child;
    instance.ready = false;
    instance.spawnedAt = Date.now();

    // CRITICAL #4: taps the same raw chunks readline consumes (see createLineLengthTracker's doc
    // comment) and kills the child the instant an unbounded/no-newline stream crosses maxLineBytes
    // — a plugin can't grow the PARENT's memory by simply never sending '\n'.
    const lineTracker = createLineLengthTracker(this.opts.maxLineBytes);
    let lineLimitTripped = false;
    child.stdout.on("data", (chunk: Buffer) => {
      if (lineLimitTripped || !lineTracker.record(chunk)) return;
      lineLimitTripped = true;
      process.stderr.write(
        `[plugin-host] instance '${instance.config.id}' exceeded max line size (${this.opts.maxLineBytes} bytes) without a newline on stdout — killing as faulty\n`
      );
      if (instance.child) killInstanceProcess(instance.child, "SIGKILL");
    });

    const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
    instance.rl = rl;
    rl.on("line", (line) => this.handleLine(instance, line));

    // Human-readable child logs (subprocess-entry.ts's stderrLogger) — pass through as-is rather
    // than parsing; an operator/CI log aggregator reads these, this host never does.
    child.stderr.on("data", (chunk: Buffer) => {
      process.stderr.write(`[plugin ${instance.config.id}] ${chunk.toString()}`);
    });

    child.on("exit", (code, signal) => {
      const wasReady = instance.ready;
      instance.ready = false;
      instance.rl?.close();
      instance.rl = undefined;
      instance.child = undefined;
      this.rejectAllPending(instance, new PluginInstanceCrashedError(instance.config.id));

      if (instance.stopped) return;

      if (!wasReady) {
        // Crashed before ever becoming ready (e.g. a bad config) — still worth retrying with
        // backoff rather than giving up, in case the failure is transient (resource pressure,
        // a flaky fs write for a file-backed statePath, ...).
        process.stderr.write(
          `[plugin-host] instance '${instance.config.id}' exited before ready (code=${code}, signal=${signal})\n`
        );
      } else {
        process.stderr.write(
          `[plugin-host] instance '${instance.config.id}' exited unexpectedly (code=${code}, signal=${signal}) — restarting\n`
        );
      }
      this.scheduleRestart(instance);
    });

    child.on("error", (err) => {
      process.stderr.write(
        `[plugin-host] instance '${instance.config.id}' spawn error: ${err.message}\n`
      );
    });
  }

  private scheduleRestart(instance: Instance): void {
    if (instance.stopped) return;
    // A crash after a long, stable run doesn't deserve the backoff a crash-loop does.
    if (Date.now() - instance.spawnedAt >= this.opts.stabilityWindowMs) {
      instance.restartAttempts = 0;
    }
    const delay = Math.min(
      this.opts.restartBackoffBaseMs * 2 ** instance.restartAttempts,
      this.opts.maxRestartBackoffMs
    );
    instance.restartAttempts += 1;
    instance.restartTimer = setTimeout(() => this.spawnInstance(instance), delay);
    // Node's timers keep the event loop alive by default — fine for main.ts (a long-running
    // server), but a test process that legitimately wants to exit while a backoff timer is
    // pending shouldn't be blocked by it (stop() already clears it on the happy path; this is
    // belt-and-braces for abrupt test teardown).
    instance.restartTimer.unref?.();
  }

  private handleLine(instance: Instance, line: string): void {
    if (!line.trim()) return;
    let msg: RpcMessage;
    try {
      msg = parseMessage(line);
    } catch {
      process.stderr.write(
        `[plugin-host] instance '${instance.config.id}': unparsable line on stdout, ignoring\n`
      );
      return;
    }

    if (isReadyNotification(msg)) {
      instance.ready = true;
      const waiters = instance.readyWaiters;
      instance.readyWaiters = [];
      for (const resolve of waiters) resolve();
      return;
    }

    if (isResponse(msg)) {
      const pending = instance.pending.get(msg.id);
      if (!pending) return; // late response to an already-timed-out/retried call — drop it.
      instance.pending.delete(msg.id);
      clearTimeout(pending.timer);
      if (isErrorResponse(msg)) {
        pending.reject(new Error(`plugin '${instance.config.id}' RPC error: ${msg.error.message}`));
      } else {
        pending.resolve(msg.result);
      }
    }
  }

  private rejectAllPending(instance: Instance, err: Error): void {
    for (const [, pending] of instance.pending) {
      clearTimeout(pending.timer);
      pending.reject(err);
    }
    instance.pending.clear();
  }

  private waitForReady(instance: Instance, timeoutMs: number): Promise<void> {
    if (instance.ready) return Promise.resolve();
    if (instance.stopped)
      return Promise.reject(new Error(`plugin instance '${instance.config.id}' is stopped`));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        instance.readyWaiters = instance.readyWaiters.filter((w) => w !== onReady);
        reject(
          new Error(
            `plugin instance '${instance.config.id}' did not become ready within ${timeoutMs}ms`
          )
        );
      }, timeoutMs);
      const onReady = (): void => {
        clearTimeout(timer);
        resolve();
      };
      instance.readyWaiters.push(onReady);
    });
  }

  /** One RPC attempt against whatever child is currently running for `instance` — does not wait
   *  for readiness and does not retry; `call()` composes this with `waitForReady`/retry. */
  private sendOnce(
    instance: Instance,
    method: string,
    params: unknown,
    timeoutMs: number
  ): Promise<unknown> {
    const child = instance.child;
    if (!child || !instance.ready) {
      return Promise.reject(new PluginInstanceCrashedError(instance.config.id));
    }
    const id = instance.nextRequestId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        instance.pending.delete(id);
        // A timeout means hung, not crashed, so it is killed. See docs/plugin-host.md §63.
        if (instance.child) killInstanceProcess(instance.child, "SIGKILL");
        reject(
          new Error(
            `plugin '${instance.config.id}' call '${method}' timed out after ${timeoutMs}ms`
          )
        );
      }, timeoutMs);
      instance.pending.set(id, { resolve, reject, timer });
      child.stdin.write(encodeMessage({ jsonrpc: "2.0", id, method, params }));
    });
  }

  /** The entry point every client method funnels through. See docs/plugin-host.md §64. */
  private async call(instanceId: string, method: string, params?: unknown): Promise<unknown> {
    const instance = this.instances.get(instanceId);
    if (!instance) throw new Error(`no plugin instance configured with id '${instanceId}'`);

    // PER-METHOD, NOT ONE NUMBER FOR EVERYTHING. See docs/plugin-host.md §65.
    const policy = resolveCallPolicy({
      module: instance.config.module,
      config: instance.config.config,
      method,
      hangDetectorMs: this.opts.callTimeoutMs
    });
    const deadline = Date.now() + policy.budgetMs;
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error(
          `plugin '${instanceId}' call '${method}' timed out (deadline exceeded across restarts)`
        );
      }
      if (instance.stopped) throw new Error(`plugin instance '${instanceId}' is stopped`);

      if (!instance.ready) {
        try {
          await this.waitForReady(instance, remaining);
        } catch (err) {
          throw err instanceof Error ? err : new Error(String(err));
        }
      }

      const remainingAfterReady = deadline - Date.now();
      if (remainingAfterReady <= 0) {
        throw new Error(
          `plugin '${instanceId}' call '${method}' timed out waiting for the instance to be ready`
        );
      }

      try {
        return await this.sendOnce(instance, method, params, remainingAfterReady);
      } catch (err) {
        if (
          err instanceof PluginInstanceCrashedError &&
          policy.retryOnCrash &&
          Date.now() < deadline
        ) {
          // Give the exit handler's scheduled restart a moment to actually spawn before looping
          // back to waitForReady — otherwise the loop can spin on `instance.child === undefined`.
          await sleep(Math.min(10, Math.max(0, deadline - Date.now())));
          continue;
        }
        throw err;
      }
    }
  }
}
