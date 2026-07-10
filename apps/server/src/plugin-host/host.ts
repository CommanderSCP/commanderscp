/**
 * The subprocess plugin host (DESIGN.md §11, BUILD_AND_TEST.md §8 M3 item 7): "one child process
 * per configured plugin instance (`scpd plugin-host`, same image), speaking JSON-RPC 2.0 over
 * stdio, with host-enforced call timeouts, restart-with-backoff, and OS-level resource limits. A
 * crashed or hung plugin cannot take down the worker."
 *
 * `contract.ts` declares the `PluginHost`/`ExecutorPluginClient` interfaces this implements —
 * written first so `coordination/reconcile.ts` depends on a narrow, stable seam rather than this
 * file's process-management internals. What this file adds on top of the wire protocol
 * (rpc-protocol.ts) and the child's own entry point (subprocess-entry.ts):
 *
 *  - **Spawn**: `node <subprocess-entry.js>` per instance, config passed via env vars (never
 *    argv — subprocess-entry.ts's module doc), stdout/stdin reserved exclusively for
 *    newline-delimited JSON-RPC (readline-framed), stderr passed through for log aggregation.
 *  - **Readiness gate**: calls queued against an instance block until its `ready` notification
 *    arrives (or the instance's overall call budget elapses) — see `call()` below.
 *  - **Host-enforced timeouts**: every RPC round trip races a timer; on timeout the (possibly
 *    hung) child is killed, which converts a "hung" plugin into the same recovery path as a
 *    "crashed" one.
 *  - **Restart-with-backoff**: an unexpected child exit (crash, killed-for-timeout, killed by an
 *    operator/test) schedules a respawn after an exponentially growing delay (reset once the
 *    instance has stayed up past a stability window) — never gives up, since a plugin instance is
 *    load-bearing infrastructure for whatever wave targets reference it.
 *  - **Transparent retry across a respawn**: `contract.ts`'s promise that "callers never see a
 *    dead subprocess, only a slower/retried call" is honored by `call()` itself: if the in-flight
 *    request's promise is rejected because ITS child exited mid-call, and time remains in the
 *    call's own timeout budget, `call()` waits for the respawned instance to become ready and
 *    retries once more — the caller (coordination/reconcile.ts) only ever sees either a
 *    successful result or a timeout, never a raw "child process died" error.
 *  - **Soft resource limit**: children are spawned with `--max-old-space-size` (Node's own heap
 *    ceiling) — a real cgroup/container memory limit is a deployment-level concern (the
 *    Kubernetes pod / compose service the whole `scpd` process runs in), out of reach from inside
 *    a plain `child_process.spawn` on every platform this needs to run on (macOS dev, Linux CI,
 *    air-gapped VMs), so this is the honest, portable subset: it bounds the ONE resource every
 *    plugin instance (a Node process) can blow up in-process, without a new dependency.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface as ReadlineInterface } from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AbortResult,
  ControlOutcome,
  ControlRequest,
  Cursor,
  ExecutionStatus,
  ExecutorCapabilities,
  ExternalRunRef,
  TriggerIntent
} from "@scp/plugin-api";
import type {
  ControlPluginClient,
  ExecutorPluginClient,
  PluginHost,
  PluginHostInstanceConfig
} from "./contract.js";
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
/**
 * When THIS module is itself executing as compiled JS (production `node dist/main.js`), the
 * compiled sibling `subprocess-entry.js` sits right next to it. But when this module is executing
 * as TS source directly — `tsx watch src/main.ts` in dev, or vitest's on-the-fly TS transform for
 * every `*.test.ts` — there is no compiled sibling to find, and the correct default is to run the
 * `.ts` entry point through the same `tsx` loader this process itself is already running under
 * (see `spawnInstance`'s `--import tsx` below). `import.meta.url` reliably keeps the ORIGINAL
 * source extension under both tsx and vite-node, so checking it is a robust signal, not a
 * heuristic — this is NOT a "which file happens to exist on disk" check (dist/ can be stale or
 * absent in dev) but a "how was I, this very module, loaded" check.
 */
const RUNNING_FROM_SOURCE = __filename.endsWith(".ts");
const DEFAULT_SUBPROCESS_ENTRY_PATH = path.resolve(
  __dirname,
  RUNNING_FROM_SOURCE ? "subprocess-entry.ts" : "subprocess-entry.js"
);

export interface PluginHostOptions {
  /** Per-call RPC budget (ms), including any wait-for-ready + one transparent retry. Default 10s. */
  callTimeoutMs?: number;
  /** First restart delay after a crash (ms), doubled per consecutive crash. Default 200ms. */
  restartBackoffBaseMs?: number;
  /** Ceiling on the restart delay (ms). Default 10s. */
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

/**
 * CRITICAL #3 (PR #7 review): the previous `{ ...process.env, SCP_PLUGIN_* }` spread handed every
 * plugin subprocess the FULL parent environment — `DATABASE_URL` (the admin/superuser connection,
 * main.ts phase 1), `SCP_COOKIE_SECRET`, `SCP_OIDC_CLIENT_SECRET`, `SCP_RUNTIME_DATABASE_URL`, all
 * of it. A plugin is untrusted, host-mediated code (DESIGN.md §11: "JSON-serializable args/results
 * only, an injected scoped context") — it should never be able to read `process.env` and connect
 * to Postgres as the admin role, bypassing RLS entirely. This allowlists only the handful of
 * variables a Node child genuinely needs to boot and run `tsx`/module resolution: `PATH` (module
 * resolution / any tool the loader shells out to), and the tmp/home dirs a couple of Node/esbuild
 * internals fall back to when unset. Every `SCP_PLUGIN_*` config var the plugin actually needs is
 * passed explicitly by the caller below — never inherited.
 */
function minimalChildEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "HOME", "TMPDIR", "TMP", "TEMP"]) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

/**
 * CRITICAL #4 (PR #7 review): `readline.createInterface` has no built-in cap on how many bytes it
 * will accumulate while waiting for the next `\n` — a plugin that streams bytes without ever
 * emitting a newline (buggy, hung, or malicious) would otherwise grow the PARENT process's memory
 * without bound, defeating DESIGN.md §11's "a crashed or hung plugin cannot take down the worker."
 *
 * A plain byte-counting tracker rather than an intermediate `Transform` piped in front of
 * readline: Node readable streams happily deliver each chunk to MULTIPLE `'data'` listeners, so
 * this taps the exact same chunks readline consumes, independently, with none of the destroy/
 * unpipe race conditions a Transform-in-the-pipe-chain approach has to fight when it needs to
 * abort mid-stream. `record()` tracks bytes seen since the last `\n` — across chunk boundaries,
 * and at every `\n` found WITHIN a single chunk (not just the chunk's tail), so one pathologically
 * oversized embedded line can't slip through just because the chunk happens to end on a newline —
 * and returns `true` the moment that count exceeds `maxBytes`. The caller (`spawnInstance`) reacts
 * by killing the child directly, routing through the exact same exit handler — and therefore the
 * same restart-with-backoff recovery — as a crash or a call timeout.
 */
function createLineLengthTracker(maxBytes: number): { record(chunk: Buffer): boolean } {
  let sinceNewline = 0;
  return {
    record(chunk: Buffer): boolean {
      let searchStart = 0;
      for (;;) {
        const idx = chunk.indexOf(0x0a, searchStart); // '\n'
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

  /**
   * Idempotent per instance id (M4 addition — DESIGN §10.2's control bindings have no
   * plugin-instance-configuration API yet, same gap `executor-config.ts` documents for
   * executors, so `governance/control-runner.ts` provisions a control's plugin instance
   * ON DEMAND from whatever `control_bindings` row it finds, calling `start()` again every time
   * it might be needed). A config whose `id` is ALREADY registered is silently skipped rather
   * than re-spawned — re-spawning would leak the previous child process (never killed) while a
   * fresh one takes its place under the same id, and would race any in-flight call against it.
   * Main.ts's own single boot-time `start()` call is unaffected (every id it passes is new).
   */
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
      instance.stopped = true;
      if (instance.restartTimer) clearTimeout(instance.restartTimer);
      this.rejectAllPending(instance, new Error("plugin host is stopping"));
      instance.child?.kill("SIGTERM");
    }
    this.instances.clear();
  }

  /** Test-only: forcibly kills the currently-running child for `instanceId`, simulating a crash
   *  (an OOM, a segfault, an operator's `kill -9`) so integration tests can exercise the
   *  plugin-host isolation DoD scenario ("kill the fake-executor SUBPROCESS mid-wave — the
   *  worker survives, the plugin restarts with backoff, the wave resumes") without needing OS
   *  access to the real PID from outside this class. No-ops if the instance isn't currently
   *  running (already mid-restart) — the point is to induce exactly one crash, not to assert one. */
  killInstanceForTest(instanceId: string): void {
    this.instances.get(instanceId)?.child?.kill("SIGKILL");
  }

  executor(instanceId: string): ExecutorPluginClient {
    const call = <T>(method: string, params?: unknown): Promise<T> =>
      this.call(instanceId, method, params) as Promise<T>;
    return {
      observe: (since?: Cursor) => call("observe", { since }),
      trigger: (intent: TriggerIntent) => call<ExternalRunRef>("trigger", { intent }),
      status: (ref: ExternalRunRef) => call<ExecutionStatus>("status", { ref }),
      abort: (ref: ExternalRunRef) => call<AbortResult>("abort", { ref }),
      describeCapabilities: () => call<ExecutorCapabilities>("describeCapabilities")
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

  // -----------------------------------------------------------------------------------------
  // Process lifecycle
  // -----------------------------------------------------------------------------------------

  private spawnInstance(instance: Instance): void {
    if (instance.stopped) return;
    const env: NodeJS.ProcessEnv = {
      ...minimalChildEnv(),
      SCP_PLUGIN_MODULE: instance.config.module,
      SCP_PLUGIN_INSTANCE_ID: instance.config.id,
      SCP_PLUGIN_ORG_ID: instance.config.orgId,
      SCP_PLUGIN_DOMAIN_ID: instance.config.domainId,
      SCP_PLUGIN_CONFIG_JSON: JSON.stringify(instance.config.config ?? {})
    };
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
      { env, stdio: ["pipe", "pipe", "pipe"] }
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
      instance.child?.kill("SIGKILL");
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

      if (instance.stopped) return; // stop() requested this exit — no restart.

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

  // -----------------------------------------------------------------------------------------
  // RPC calls
  // -----------------------------------------------------------------------------------------

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
        // A timeout means the plugin is hung, not necessarily crashed — kill it so the normal
        // exit handler reclaims it and restart-with-backoff kicks in, converting "hung forever"
        // into "will come back". `sendOnce`'s caller (`call`) still only sees a timeout error.
        instance.child?.kill("SIGKILL");
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

  /**
   * The public entry point every `ExecutorPluginClient` method funnels through: waits for the
   * instance to be ready (bounded by the remaining call budget), sends the request, and — if the
   * ONLY reason it failed was the child exiting mid-call (`PluginInstanceCrashedError`) — waits
   * for the respawned instance and retries exactly once more per crash, as long as time remains.
   * This is what makes `contract.ts`'s "callers never see a dead subprocess, only a
   * slower/retried call" true rather than aspirational.
   */
  private async call(instanceId: string, method: string, params?: unknown): Promise<unknown> {
    const instance = this.instances.get(instanceId);
    if (!instance) throw new Error(`no plugin instance configured with id '${instanceId}'`);

    const deadline = Date.now() + this.opts.callTimeoutMs;
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
        if (err instanceof PluginInstanceCrashedError && Date.now() < deadline) {
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
