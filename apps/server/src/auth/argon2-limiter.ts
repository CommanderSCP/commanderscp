import * as argon2 from "argon2";
import { tooManyRequests } from "../errors.js";

/**
 * BOUNDED-CONCURRENCY GATE FOR argon2 VERIFICATION.
 *
 * `argon2.verify` is a NATIVE binding that runs on the libuv threadpool (default size 4). Every
 * login (`local-auth.ts`) and every prefixed-token check (`prefixed-token.ts` → PAT / operator
 * credential) calls it. An unauthenticated attacker who knows one valid username (or floods login
 * for the bootstrap admin) can fire these faster than they complete, saturating the threadpool —
 * which is ALSO where the rest of the process's fs/dns/zlib/crypto work runs — and starving the
 * whole server, without ever tripping a request-rate limit. This is IP-independent, so it holds
 * behind an ingress where every request shares one source IP (no `trustProxy` is configured).
 *
 * The gate caps concurrent argon2 verifications at `MAX_CONCURRENT` (default: threadpool size − 1,
 * so at least one thread is always free for everything else) and bounds the WAIT QUEUE at
 * `MAX_QUEUE`. Past the queue ceiling it fails closed with a 429 — deliberate load-shedding: under
 * an argon2 flood some legitimate logins get a retryable 429, which is strictly better than every
 * async operation in the process stalling behind a full threadpool. A genuine argon2 error (a
 * malformed stored hash) is still the caller's own `.catch(() => false)` concern; only the
 * saturation 429 propagates from here.
 *
 * Env overrides: SCP_ARGON2_MAX_CONCURRENT, SCP_ARGON2_MAX_QUEUE, and UV_THREADPOOL_SIZE feed the
 * default concurrency.
 */
const THREADPOOL_SIZE = Math.max(1, Number(process.env.UV_THREADPOOL_SIZE ?? 4));
let maxConcurrent = Math.max(
  1,
  Number(process.env.SCP_ARGON2_MAX_CONCURRENT ?? Math.max(1, THREADPOOL_SIZE - 1))
);
let maxQueue = Math.max(0, Number(process.env.SCP_ARGON2_MAX_QUEUE ?? 64));

let active = 0;
const waiters: Array<() => void> = [];

function acquire(): Promise<void> {
  if (active < maxConcurrent) {
    active += 1;
    return Promise.resolve();
  }
  if (waiters.length >= maxQueue) {
    return Promise.reject(
      tooManyRequests("authentication is temporarily overloaded — retry shortly")
    );
  }
  return new Promise<void>((resolve) => {
    waiters.push(() => {
      active += 1;
      resolve();
    });
  });
}

/** Test-only seam (argon2-limiter.test.ts): override the caps and drop all gate state so cases run
 *  deterministically without depending on env or module re-evaluation. Not for production use. */
export function __setArgon2LimiterForTest(opts: { maxConcurrent: number; maxQueue: number }): void {
  maxConcurrent = Math.max(1, opts.maxConcurrent);
  maxQueue = Math.max(0, opts.maxQueue);
  active = 0;
  waiters.length = 0;
}

function release(): void {
  active -= 1;
  const next = waiters.shift();
  if (next) next();
}

/**
 * Run `fn` (an argon2 operation) through the concurrency gate. Acquires a slot or a queue place,
 * awaits `fn`, and always releases. A saturation 429 from `acquire` rejects BEFORE `fn` runs.
 * Exported for the drift test (which drives the gate with controllable tasks); prefer
 * {@link verifyPasswordHashLimited} in production code.
 */
export async function withArgon2Slot<T>(fn: () => Promise<T>): Promise<T> {
  await acquire();
  try {
    return await fn();
  } finally {
    release();
  }
}

/**
 * Verify `password` against a stored argon2 `hash` through the concurrency gate. Returns `false` for
 * a non-matching password OR a malformed/unreadable stored hash (same as a bare
 * `argon2.verify(...).catch(() => false)`); the ONLY thing that throws is the saturation 429 from
 * the gate, which callers must let propagate to the HTTP layer.
 */
export async function verifyPasswordHashLimited(hash: string, password: string): Promise<boolean> {
  return withArgon2Slot(() => argon2.verify(hash, password).catch(() => false));
}
