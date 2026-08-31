import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFileBackedJsonCache } from "./index.js";

/**
 * Six executor plugins (`argocd`, `argo-workflows`, `pipeline-generic`, `managed-iac`,
 * `fake-executor`, `git-provider-core`) each carried their own copy of this write-to-temp+rename
 * dedup-state triad; this pins the ONE shared implementation's contract so a future fix to the
 * atomic-write logic lands everywhere at once instead of needing six manual edits.
 */
describe("createFileBackedJsonCache", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "dedup-cache-test-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("with no statePath, falls back to an in-memory store that round-trips across load/save calls", async () => {
    const cache = createFileBackedJsonCache<{ keys: Record<string, string> }>(() => ({ keys: {} }));
    expect(await cache.load(undefined)).toEqual({ keys: {} });

    await cache.save(undefined, { keys: { a: "1" } });
    expect(await cache.load(undefined)).toEqual({ keys: { a: "1" } });
  });

  it("with a statePath, save() writes atomically (temp file gone, target holds the JSON) and load() reads it back", async () => {
    const statePath = join(dir, "nested", "state.json");
    const cache = createFileBackedJsonCache<{ keys: Record<string, string> }>(() => ({ keys: {} }));

    await cache.save(statePath, { keys: { a: "1" } });
    expect(JSON.parse(await readFile(statePath, "utf8"))).toEqual({ keys: { a: "1" } });

    const reloaded = await cache.load(statePath);
    expect(reloaded).toEqual({ keys: { a: "1" } });
  });

  it("load() on a statePath that does not exist yet returns a FRESH empty state (ENOENT -> emptyState())", async () => {
    const statePath = join(dir, "missing.json");
    const cache = createFileBackedJsonCache<{ keys: Record<string, string> }>(() => ({ keys: {} }));
    expect(await cache.load(statePath)).toEqual({ keys: {} });
  });

  it("load() rethrows a non-ENOENT error instead of silently returning an empty state", async () => {
    // A directory where a file is expected makes readFile fail with EISDIR, not ENOENT.
    const statePath = dir;
    const cache = createFileBackedJsonCache<{ keys: Record<string, string> }>(() => ({ keys: {} }));
    await expect(cache.load(statePath)).rejects.toThrow();
  });

  it("normalize() backfills a field missing from an on-disk file predating it (the argo-workflows case)", async () => {
    const statePath = join(dir, "state.json");
    interface State {
      targets: Record<string, string>;
      abortedNames: Record<string, boolean>;
    }
    const cache = createFileBackedJsonCache<State>(
      () => ({ targets: {}, abortedNames: {} }),
      (parsed) => {
        const p = parsed as Partial<State>;
        return { targets: p.targets ?? {}, abortedNames: p.abortedNames ?? {} };
      }
    );
    // Simulate an old on-disk file written before `abortedNames` existed.
    await cache.save(statePath, { targets: { t: "x" }, abortedNames: {} });
    const raw = JSON.parse(await readFile(statePath, "utf8"));
    delete raw.abortedNames;
    await writeFile(statePath, JSON.stringify(raw), "utf8");

    expect(await cache.load(statePath)).toEqual({ targets: { t: "x" }, abortedNames: {} });
  });

  it("reset() clears the in-memory fallback to a fresh empty state, unaffecting a statePath-backed load", async () => {
    const cache = createFileBackedJsonCache<{ keys: Record<string, string> }>(() => ({ keys: {} }));
    await cache.save(undefined, { keys: { a: "1" } });
    expect(await cache.load(undefined)).toEqual({ keys: { a: "1" } });

    cache.reset();
    expect(await cache.load(undefined)).toEqual({ keys: {} });
  });

  it("emptyState() is called fresh each time — mutating one returned empty state does not leak into the next", async () => {
    const cache = createFileBackedJsonCache<{ keys: Record<string, string> }>(() => ({ keys: {} }));
    const statePath = join(dir, "missing.json");
    const first = await cache.load(statePath);
    first.keys.mutated = "yes";
    const second = await cache.load(statePath);
    expect(second).toEqual({ keys: {} });
  });

  it("two independent cache instances do not share in-memory state", async () => {
    const cacheA = createFileBackedJsonCache<{ keys: Record<string, string> }>(() => ({ keys: {} }));
    const cacheB = createFileBackedJsonCache<{ keys: Record<string, string> }>(() => ({ keys: {} }));

    await cacheA.save(undefined, { keys: { a: "1" } });
    expect(await cacheB.load(undefined)).toEqual({ keys: {} });
  });
});
