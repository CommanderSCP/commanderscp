import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

/**
 * THE REFUSING HALF of `assertInsideTest` (index.ts) — the guard that turns "per-test allocator
 * used on a `beforeAll` fixture" from a green suite plus a leaked directory into a loud throw.
 *
 * WHY A WHOLE FILE. The condition being asserted is "there is no current test", which is true at
 * module top level and inside `beforeAll` — and a throw from either of those ABORTS the file
 * instead of asserting anything, so the misuse cannot be driven from where it really happens.
 * Stubbing is the only way to present that condition inside an `it()`, `vitest/suite` is a frozen
 * ESM namespace (measured: `Object.defineProperty` on it throws "Cannot redefine property"), and
 * `vi.mock` is MODULE-SCOPED — it would disable the guard for every test in whatever file it
 * appears in. Hence the split: the silent half is `index.test.ts`'s whole body, this is the loud
 * half.
 */
vi.mock("vitest/suite", async (importOriginal) => ({
  ...(await importOriginal<typeof import("vitest/suite")>()),
  getCurrentTest: () => undefined
}));

const PREFIX = join(tmpdir(), "scp-test-tmpdir-selftest-guard-");

/**
 * THIS FILE SWEEPS ITS OWN FIXTURE, and cannot delegate that to the allocator it is testing.
 *
 * `index.ts` registers its `afterEach`/`afterAll` sweeps at MODULE LOAD. Every `it()` below imports
 * it with a DYNAMIC `await import("./index.js")` — deliberately, so the `vi.mock` above is in place
 * first — which means those hooks are registered while the file is already RUNNING, after vitest
 * finished collecting this file's hooks. They therefore never fire, and the one directory the third
 * case legitimately creates survived the run: the repo's own tmpdir-leak gate caught it on CI
 * (`scp-test-tmpdir-selftest-guard-*`) while a local run missed it, because turbo replayed this
 * package from cache rather than executing it.
 *
 * That is the same shape as the defect the guard exists to catch — a cleanup that is registered and
 * does not run — one level further in: here it is the SWEEP itself that was never installed. So the
 * sweep here is explicit and local, and depends on nothing that has to be imported early.
 */
const created: string[] = [];
afterAll(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(created.map((d) => rm(d, { recursive: true, force: true })));
  created.length = 0;
});

describe("the per-test pair refuses to run outside a test", () => {
  it("mkdtempTracked throws, and names the ForFile variant to use instead", async () => {
    const { mkdtempTracked } = await import("./index.js");
    await expect(mkdtempTracked(PREFIX)).rejects.toThrow(/mkdtempTrackedForFile\(\)/);
  });

  it("mkdtempTrackedSync throws too — both halves of the pair, not just the async one", async () => {
    const { mkdtempTrackedSync } = await import("./index.js");
    expect(() => mkdtempTrackedSync(PREFIX)).toThrow(/mkdtempTrackedForFileSync\(\)/);
  });

  it("the FILE-lifetime pair is unaffected — it is the correct answer here, so it must still work", async () => {
    const { existsSync } = await import("node:fs");
    const { mkdtempTrackedForFile } = await import("./index.js");
    const dir = await mkdtempTrackedForFile(PREFIX);
    created.push(dir);
    expect(existsSync(dir)).toBe(true);
  });
});
