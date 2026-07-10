/**
 * The sandboxed CEL evaluator (DESIGN.md §10.1: "CEL via `cel-js` — sandboxed, no I/O, no
 * arbitrary code"; BUILD_AND_TEST.md §8 M4 "known-tricky": "the CEL sandbox MUST NOT allow I/O,
 * network, filesystem, process, or unbounded compute... evaluate untrusted policy expressions
 * safely — timeout + no host bindings"). SECURITY-SENSITIVE (flagged in the M4 PR body).
 *
 * Two independent layers of defense, because a synchronous single-threaded interpreter (cel-js)
 * can't be preempted by a JS timer alone:
 *
 *  1. **Static pre-validation** (`checkStaticComplexity`, cheap, no thread involved): rejects
 *     obviously pathological input — over-long expressions, or nesting deep enough to risk a
 *     parser stack overflow — before it ever reaches an evaluator. This is the fast path that
 *     handles the common adversarial case (a huge or deeply-nested expression) without spending a
 *     worker round trip on it.
 *  2. **`node:worker_threads` isolation with a hard wall-clock timeout**
 *     (`cel-worker-entry.ts`): the actual `cel-js` `evaluate()` call runs on a separate thread;
 *     this class races it against a timer and calls `worker.terminate()` if the timer wins,
 *     converting "hung forever" into a bounded failure. Because it's a SEPARATE THREAD (not just
 *     a separate call stack), terminating it doesn't just abandon a promise — it actually stops
 *     the runaway computation, which a same-thread `Promise.race` against a `setTimeout` cannot do
 *     (Node's event loop can't preempt synchronous code). Isolation also means a `cel-js` bug that
 *     crashes the worker (e.g. a genuine parser stack overflow past the static check's bound)
 *     takes down that one worker, not the request-serving process — the pool respawns it,
 *     mirroring `plugin-host/host.ts`'s crash-recovery design (same idea, far smaller surface: no
 *     JSON-RPC framing, no plugin config, just `{expression, context} -> {value | error}`).
 *
 * No host bindings are ever registered (`cel-js.evaluate`'s third "custom functions" argument is
 * never passed — see the worker entry's doc comment) — the ONLY data an expression can observe is
 * the plain-JSON `context` object `governance/evaluate.ts` passes in, and the ONLY thing an
 * expression can produce is a plain CEL value. There is no code path from a policy expression to
 * `fetch`, `fs`, `child_process`, or any other capability.
 */
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
      throw new CelSandboxError(`CEL expression exceeds max nesting depth (${CEL_MAX_NESTING_DEPTH})`);
    }
  }
}

export type CelEvalResult =
  | { ok: true; value: unknown }
  | { ok: false; error: string };

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

/**
 * Owns a small pool of persistent CEL-evaluation worker threads. `evaluate()` round-robins across
 * the pool, races the call against `timeoutMs`, and on timeout terminates+respawns that specific
 * worker (the in-flight call resolves with `{ok:false}` rather than hanging the caller forever).
 */
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
      poolSize: options.poolSize ?? 1,
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
    const entry: PoolWorker = { worker, pending: new Map(), nextId: 1, ready: false, readyWaiters: [] };

    worker.on(
      "message",
      (msg: { ready: true } | { id: number; ok: true; value: unknown } | { id: number; ok: false; error: string }) => {
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
        pending.resolve(msg.ok ? { ok: true, value: msg.value } : { ok: false, error: msg.error });
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

  /**
   * Evaluates one CEL expression against `context`. Never throws for a bad/malicious/slow
   * expression — those come back as `{ok:false, error}` (module doc comment: layer 1's static
   * check throws `CelSandboxError` synchronously for pathological SHAPE before any thread is
   * involved; that IS allowed to throw since it's a caller-input-validation failure the same as
   * a Zod parse error, not a sandboxing concern). A worker's one-time module-load cost (tsx
   * transform + `cel-js`/`chevrotain` import) is awaited via `waitForReady` and does NOT count
   * against `timeoutMs` — only the actual `evaluate()` call, once dispatched, is timed.
   */
  async evaluate(expression: string, context: Record<string, unknown>): Promise<CelEvalResult> {
    checkStaticComplexity(expression);
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
 *  no worker threads spin up for processes that never evaluate a policy (e.g. `openapi:emit`). */
export function getSharedCelSandbox(): CelSandbox {
  sharedSandbox ??= new CelSandbox();
  return sharedSandbox;
}

/** Test-only: replaces the shared sandbox (e.g. with a shorter timeout) and returns the previous
 *  one so a test can restore it. */
export function setSharedCelSandboxForTest(sandbox: CelSandbox | undefined): CelSandbox | undefined {
  const previous = sharedSandbox;
  sharedSandbox = sandbox;
  return previous;
}
