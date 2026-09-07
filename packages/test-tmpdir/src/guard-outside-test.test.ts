import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

/** THE REFUSING HALF of `assertInsideTest` (index.ts). See docs/test-tmpdir.md §1. */
vi.mock("vitest/suite", async (importOriginal) => ({
  ...(await importOriginal<typeof import("vitest/suite")>()),
  getCurrentTest: () => undefined
}));

const PREFIX = join(tmpdir(), "scp-test-tmpdir-selftest-guard-");

/** This file sweeps its own fixture; the allocator cannot. See docs/test-tmpdir.md §2. */
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
