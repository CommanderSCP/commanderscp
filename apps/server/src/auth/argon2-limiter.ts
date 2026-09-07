import * as argon2 from "argon2";
import { tooManyRequests } from "../errors.js";

/** BOUNDED-CONCURRENCY GATE FOR argon2 VERIFICATION. See docs/auth.md §2. */
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

/** Run `fn` (an argon2 operation) through the concurrency gate. See docs/auth.md §3. */
export async function withArgon2Slot<T>(fn: () => Promise<T>): Promise<T> {
  await acquire();
  try {
    return await fn();
  } finally {
    release();
  }
}

/** Verify a password through the gate; only saturation throws. See docs/auth.md §4. */
export async function verifyPasswordHashLimited(hash: string, password: string): Promise<boolean> {
  return withArgon2Slot(() => argon2.verify(hash, password).catch(() => false));
}
