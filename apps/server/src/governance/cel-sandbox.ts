/** The sandboxed CEL evaluator. See docs/governance.md §30. */
import { Worker } from "node:worker_threads";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// Same "am I running from compiled JS or TS source" signal plugin-host/host.ts uses (see its doc
// comment) — `import.meta.url` reliably keeps the original source extension under both tsx (dev)
// and vitest's on-the-fly TS transform, unlike a "does dist/ exist" filesystem check.
const RUNNING_FROM_SOURCE = __filename.endsWith(".ts");
const DEFAULT_WORKER_ENTRY_PATH = path.resolve(
  __dirname,
  RUNNING_FROM_SOURCE ? "cel-worker-entry.ts" : "cel-worker-entry.js"
);

/** Conservative bounds — CEL policy conditions are short, human-authored boolean expressions
 *  (DESIGN.md §10.1's example is one line); nothing legitimate needs anywhere near these limits. */
export const CEL_MAX_EXPRESSION_LENGTH = 4096;
export const CEL_MAX_NESTING_DEPTH = 48;
export const CEL_DEFAULT_TIMEOUT_MS = 250;
/** The evaluation context is partly attacker-controlled. See docs/governance.md §31. */
export const CEL_MAX_CONTEXT_BYTES = 64 * 1024;
export const CEL_MAX_CONTEXT_DEPTH = 32;
/** MAJOR #3: default worker-thread pool size. >1 so gate-evaluation contention (many changes
 *  reconciling at once) can't serialize every CEL call behind one worker and push required
 *  conditions toward the timeout path. Overridable per-instance (`poolSize`) and, for the shared
 *  sandbox, via `SCP_CEL_POOL_SIZE`. */
export const CEL_DEFAULT_POOL_SIZE = 2;

export class CelSandboxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CelSandboxError";
  }
}

/** Cheap, synchronous, no-thread-required rejection of pathological input (module doc comment,
 *  layer 1). Exported standalone so unit tests can assert the boundary precisely. */
export function checkStaticComplexity(expression: string): void {
  if (typeof expression !== "string") {
    throw new CelSandboxError("CEL expression must be a string");
  }
  if (expression.length === 0) {
    throw new CelSandboxError("CEL expression must not be empty");
  }
  if (expression.length > CEL_MAX_EXPRESSION_LENGTH) {
    throw new CelSandboxError(
      `CEL expression exceeds max length (${expression.length} > ${CEL_MAX_EXPRESSION_LENGTH})`
    );
  }
  let depth = 0;
  let maxDepth = 0;
  for (const ch of expression) {
    if (ch === "(" || ch === "[" || ch === "{") {
      depth += 1;
      if (depth > maxDepth) maxDepth = depth;
    } else if (ch === ")" || ch === "]" || ch === "}") {
      depth -= 1;
    }
    if (maxDepth > CEL_MAX_NESTING_DEPTH) {
      throw new CelSandboxError(
        `CEL expression exceeds max nesting depth (${CEL_MAX_NESTING_DEPTH})`
      );
    }
  }
}

/** Depth of the deepest nested object/array in `value`, short-circuiting once `limit` is exceeded
 *  (so a maliciously deep structure can't make THIS check itself expensive). */
function exceedsDepth(value: unknown, limit: number, depth = 0): boolean {
  if (depth > limit) return true;
  if (value === null || typeof value !== "object") return false;
  for (const child of Object.values(value as Record<string, unknown>)) {
    if (exceedsDepth(child, limit, depth + 1)) return true;
  }
  return false;
}

/** Cheap rejection of a pathologically large/deep evaluation context (MAJOR #4) — returns an error
 *  string to reject, or `null` if the context is within bounds. Returns an error (rather than
 *  throwing) so an oversized attacker-controlled context flows through the normal fail-closed path
 *  (a required policy blocks; advisory annotates) instead of crashing the caller. */
export function checkContextComplexity(context: Record<string, unknown>): string | null {
  if (exceedsDepth(context, CEL_MAX_CONTEXT_DEPTH)) {
    return `CEL context exceeds max nesting depth (${CEL_MAX_CONTEXT_DEPTH})`;
  }
  let serializedLength: number;
  try {
    serializedLength = JSON.stringify(context).length;
  } catch {
    return "CEL context is not JSON-serializable"; // e.g. a cycle — reject rather than pass to the worker
  }
  if (serializedLength > CEL_MAX_CONTEXT_BYTES) {
    return `CEL context exceeds max size (${serializedLength} > ${CEL_MAX_CONTEXT_BYTES} bytes)`;
  }
  return null;
}

export type CelEvalResult = { ok: true; value: unknown } | { ok: false; error: string };

/** Upper bound on any error string this sandbox returns. Nothing this module GENERATES comes close
 *  (they are short constants); the bound exists for the one error class it FORWARDS — cel-js's own
 *  exception text, whose length is not this module's to control. Generous vs. any real diagnosis. */
export const CEL_MAX_ERROR_LENGTH = 512;

/** The library embeds the whole context in its errors. See docs/governance.md §32. */
const CEL_CONTEXT_DUMP_MARKER = " context: ";

/** KEEP THE DIAGNOSIS, DROP THE CONTEXT DUMP. See docs/governance.md §33. */
export function normalizeCelWorkerError(error: string): string {
  const at = error.indexOf(CEL_CONTEXT_DUMP_MARKER);
  // Keep the trailing "context" — "…not found in context" reads as the diagnosis it is.
  const diagnosis = at === -1 ? error : error.slice(0, at + CEL_CONTEXT_DUMP_MARKER.length - 2);
  // A SIZE bound, not a stability guarantee: the cut above is what makes the string stable, and
  // `governance/cel-sandbox.test.ts` pins cel-js's actual message so a version bump that reworded
  // it turns RED instead of silently restoring the flood. This only stops an unrecognized future
  // message from putting an unbounded blob in every Decision's reason tree.
  return diagnosis.length > CEL_MAX_ERROR_LENGTH
    ? `${diagnosis.slice(0, CEL_MAX_ERROR_LENGTH)}… (truncated)`
    : diagnosis;
}

interface PendingCall {
  resolve(result: CelEvalResult): void;
  timer: NodeJS.Timeout;
}

interface PoolWorker {
  worker: Worker;
  pending: Map<number, PendingCall>;
  nextId: number;
  ready: boolean;
  readyWaiters: Array<() => void>;
}

export interface CelSandboxOptions {
  /** Per-evaluation hard timeout (ms). Default 250ms — generous for any legitimate policy
   *  condition, tight enough that a stalled worker is reclaimed quickly. */
  timeoutMs?: number;
  /** Number of persistent worker threads. Default 1 — coordination workloads are "thousands of
   *  events per minute, not millions per second" (DESIGN §8), so a single worker with a bounded
   *  queue is sufficient; raise for higher gate-evaluation concurrency. */
  poolSize?: number;
  /** Overridable for tests only. */
  workerEntryPath?: string;
  /** How long to wait for a freshly spawned worker's module graph to finish loading before
   *  giving up on a queued call (module load, NOT per-evaluation compute — see
   *  cel-worker-entry.ts's `ready` message doc comment). Default 10s (tsx cold-transform +
   *  chevrotain's parser-table construction on a loaded CI box). */
  readyTimeoutMs?: number;
}

/** Owns a small pool of persistent evaluation workers. See docs/governance.md §34. */
export class CelSandbox {
  private readonly opts: Required<Omit<CelSandboxOptions, "workerEntryPath">> & {
    workerEntryPath: string;
  };
  private readonly workers: PoolWorker[] = [];
  private nextWorkerIndex = 0;
  private stopped = false;

  constructor(options: CelSandboxOptions = {}) {
    this.opts = {
      timeoutMs: options.timeoutMs ?? CEL_DEFAULT_TIMEOUT_MS,
      poolSize: Math.max(1, options.poolSize ?? CEL_DEFAULT_POOL_SIZE),
      workerEntryPath: options.workerEntryPath ?? DEFAULT_WORKER_ENTRY_PATH,
      readyTimeoutMs: options.readyTimeoutMs ?? 10_000
    };
    for (let i = 0; i < this.opts.poolSize; i++) {
      this.workers.push(this.spawnWorker());
    }
  }

  private spawnWorker(): PoolWorker {
    const entryIsTypeScript = this.opts.workerEntryPath.endsWith(".ts");
    const worker = new Worker(this.opts.workerEntryPath, {
      execArgv: entryIsTypeScript ? ["--import", "tsx"] : [],
      // No `env`/`argv` passed through — the worker gets Node's default inherited env, which is
      // fine here (this thread never touches secrets; the isolation goal is compute/crash
      // containment, not credential scoping the way plugin-host's subprocess env allowlist is).
      stdout: false,
      stderr: false
    });
    const entry: PoolWorker = {
      worker,
      pending: new Map(),
      nextId: 1,
      ready: false,
      readyWaiters: []
    };

    worker.on(
      "message",
      (
        msg:
          | { ready: true }
          | { id: number; ok: true; value: unknown }
          | { id: number; ok: false; error: string }
      ) => {
        if ("ready" in msg) {
          entry.ready = true;
          const waiters = entry.readyWaiters;
          entry.readyWaiters = [];
          for (const resolve of waiters) resolve();
          return;
        }
        const pending = entry.pending.get(msg.id);
        if (!pending) return; // late response to an already-timed-out call — drop it.
        entry.pending.delete(msg.id);
        clearTimeout(pending.timer);
        // THE ONE BOUNDARY THAT CARRIES TEXT THIS MODULE DID NOT WRITE — cel-js's own exception
        // message, which embeds the whole evaluation context (see `normalizeCelWorkerError`, and
        // PR #153 review Q2 for the flood it otherwise restores).
        pending.resolve(
          msg.ok
            ? { ok: true, value: msg.value }
            : { ok: false, error: normalizeCelWorkerError(msg.error) }
        );
      }
    );

    worker.on("error", (err) => {
      // A worker-thread-level crash (shouldn't happen given cel-js never throws uncaught — the
      // worker entry itself try/catches every evaluate() call — but defensive: an uncaught error
      // fails every pending call on this worker rather than hanging them, and the exit handler
      // below respawns).
      this.failAllPending(entry, `CEL sandbox worker error: ${err.message}`);
    });

    worker.on("exit", () => {
      this.failAllPending(entry, "CEL sandbox worker exited unexpectedly");
      if (this.stopped) return;
      const idx = this.workers.indexOf(entry);
      if (idx !== -1) this.workers[idx] = this.spawnWorker();
    });

    // CRITICAL, and CRITICALLY ORDERED LAST. See docs/governance.md §35.
    worker.unref();

    return entry;
  }

  private failAllPending(entry: PoolWorker, message: string): void {
    for (const [, pending] of entry.pending) {
      clearTimeout(pending.timer);
      pending.resolve({ ok: false, error: message });
    }
    entry.pending.clear();
  }

  private waitForReady(entry: PoolWorker, timeoutMs: number): Promise<void> {
    if (entry.ready) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        entry.readyWaiters = entry.readyWaiters.filter((w) => w !== onReady);
        reject(new Error(`CEL sandbox worker did not become ready within ${timeoutMs}ms`));
      }, timeoutMs);
      const onReady = (): void => {
        clearTimeout(timer);
        resolve();
      };
      entry.readyWaiters.push(onReady);
    });
  }

  /** Evaluates one CEL expression against `context`. See docs/governance.md §36. */
  async evaluate(expression: string, context: Record<string, unknown>): Promise<CelEvalResult> {
    checkStaticComplexity(expression);
    // MAJOR #4: reject a pathologically large/deep (partly attacker-controlled) context BEFORE it
    // reaches a worker, so a short expression can't exhaust the timeout budget via deep-equality
    // over huge labels. Returns `{ok:false}` (not throw) so it fails closed for required policies.
    const contextError = checkContextComplexity(context);
    if (contextError) return { ok: false, error: contextError };
    if (this.stopped) return { ok: false, error: "CEL sandbox is stopped" };

    const entry = this.workers[this.nextWorkerIndex % this.workers.length]!;
    this.nextWorkerIndex += 1;

    if (!entry.ready) {
      try {
        await this.waitForReady(entry, this.opts.readyTimeoutMs);
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    }
    if (this.stopped) return { ok: false, error: "CEL sandbox is stopped" };

    const id = entry.nextId++;
    return new Promise<CelEvalResult>((resolve) => {
      const timer = setTimeout(() => {
        entry.pending.delete(id);
        resolve({ ok: false, error: `CEL evaluation timed out after ${this.opts.timeoutMs}ms` });
        // Kill the (presumed hung) worker so it can't keep burning CPU; `exit` respawns it.
        void entry.worker.terminate();
      }, this.opts.timeoutMs);
      entry.pending.set(id, { resolve, timer });
      entry.worker.postMessage({ id, expression, context });
    });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await Promise.all(
      this.workers.map(async (entry) => {
        this.failAllPending(entry, "CEL sandbox is stopping");
        await entry.worker.terminate();
      })
    );
  }
}

let sharedSandbox: CelSandbox | undefined;

/** Process-wide default sandbox (governance/evaluate.ts's normal call path) — lazily created so
 *  no worker threads spin up for processes that never evaluate a policy (e.g. `openapi:emit`).
 *  `SCP_CEL_POOL_SIZE` (default {@link CEL_DEFAULT_POOL_SIZE}) tunes the worker pool for higher
 *  gate-evaluation concurrency (MAJOR #3). */
export function getSharedCelSandbox(): CelSandbox {
  const envPool = Number.parseInt(process.env.SCP_CEL_POOL_SIZE ?? "", 10);
  sharedSandbox ??= new CelSandbox(
    Number.isFinite(envPool) && envPool > 0 ? { poolSize: envPool } : {}
  );
  return sharedSandbox;
}

// A test-only swap stood here with zero callers. See docs/governance.md §37.
