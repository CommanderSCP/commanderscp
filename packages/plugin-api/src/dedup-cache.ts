/**
 * File-backed JSON dedup-state cache — the write-to-temp+rename persistence shape every
 * `ExecutorPlugin` uses to survive a subprocess-host restart mid-wave without losing its
 * idempotency ledger (`trigger()`'s dedup map). Extracted after this exact triad — a module- or
 * instance-scoped in-memory fallback plus a `loadState`/`saveState` pair — was found
 * character-for-character duplicated across `@scp/plugin-argocd`, `@scp/plugin-argo-workflows`,
 * `@scp/plugin-pipeline-generic`, `@scp/plugin-managed-iac`, `@scp/plugin-fake-executor` and
 * `@scp/plugin-git-provider-core`: a bug fix to the atomic-write logic needed six manual copies.
 *
 * `normalize` exists only for `argo-workflows`, whose on-disk shape predates the `abortedNames`
 * field and backfills it on load; every other caller can omit it and get a plain `as T` cast.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

export interface FileBackedJsonCache<T> {
  /** Returns the in-memory fallback when `statePath` is unset; otherwise reads and parses the
   *  file, mapping a missing file (ENOENT) to a fresh empty state and rethrowing anything else. */
  load(statePath: string | undefined): Promise<T>;
  /** Writes the in-memory fallback when `statePath` is unset; otherwise atomically replaces the
   *  file via write-to-temp+rename so a reader never observes a half-written state. */
  save(statePath: string | undefined, state: T): Promise<void>;
  /** Resets the in-memory fallback to a fresh empty state — for tests that reuse a key across
   *  cases and need the module- or instance-scoped cache cleared between them. */
  reset(): void;
}

/**
 * `emptyState` is called fresh each time an empty state is needed (ENOENT, `reset()`, initial
 * value) so callers can't accidentally share one mutable object across those occasions.
 */
export function createFileBackedJsonCache<T>(
  emptyState: () => T,
  normalize: (parsed: unknown) => T = (parsed) => parsed as T
): FileBackedJsonCache<T> {
  let inMemoryState: T = emptyState();

  async function load(statePath: string | undefined): Promise<T> {
    if (!statePath) return inMemoryState;
    try {
      return normalize(JSON.parse(await readFile(statePath, "utf8")));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return emptyState();
      throw err;
    }
  }

  async function save(statePath: string | undefined, state: T): Promise<void> {
    if (!statePath) {
      inMemoryState = state;
      return;
    }
    await mkdir(dirname(statePath), { recursive: true });
    const tmpPath = `${statePath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(tmpPath, JSON.stringify(state), "utf8");
    await rename(tmpPath, statePath);
  }

  function reset(): void {
    inMemoryState = emptyState();
  }

  return { load, save, reset };
}
