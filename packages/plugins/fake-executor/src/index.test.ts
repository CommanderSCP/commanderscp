import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@scp/plugin-api";
import { createFakeExecutorPlugin, FakeExecutorPlugin } from "./index.js";

function testCtx(config?: unknown): PluginContext {
  return {
    orgId: "org-1",
    domainId: "domain-1",
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    secrets: { get: async () => undefined },
    http: {
      request: async () => {
        throw new Error("fake-executor unit tests never call ctx.http");
      }
    },
    config: config ?? {}
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("FakeExecutorPlugin (unit, in-memory state)", () => {
  it("describeCapabilities() advertises trigger/abort/observe with the closed TriggerIntent vocabulary", () => {
    const plugin = createFakeExecutorPlugin();
    const caps = plugin.describeCapabilities();
    expect(caps).toEqual({
      supportsObserve: true,
      supportsTrigger: true,
      supportsAbort: true,
      triggerKinds: ["sync", "workflow_dispatch", "rollback", "custom"]
    });
  });

  it("trigger() increments the target's version on each successive non-rollback trigger", async () => {
    const plugin = createFakeExecutorPlugin();
    const ctx = testCtx();
    const ref0 = await plugin.trigger(ctx, { kind: "sync", targetRef: "svc-a" });
    const status0 = await plugin.status(ctx, ref0);
    expect(status0.stateRef).toBe("v0");

    const ref1 = await plugin.trigger(ctx, { kind: "sync", targetRef: "svc-a" });
    const status1 = await plugin.status(ctx, ref1);
    expect(status1.stateRef).toBe("v1");

    const ref2 = await plugin.trigger(ctx, { kind: "workflow_dispatch", targetRef: "svc-a" });
    const status2 = await plugin.status(ctx, ref2);
    expect(status2.stateRef).toBe("v2");
  });

  it("rollback trigger sets the target's state ref back to priorStateRef instead of incrementing", async () => {
    const plugin = createFakeExecutorPlugin();
    const ctx = testCtx();
    await plugin.trigger(ctx, { kind: "sync", targetRef: "svc-a" }); // v0
    await plugin.trigger(ctx, { kind: "sync", targetRef: "svc-a" }); // v1
    const goodRef = await plugin.trigger(ctx, { kind: "sync", targetRef: "svc-a" }); // v2
    const goodStatus = await plugin.status(ctx, goodRef);
    expect(goodStatus.stateRef).toBe("v2");

    // A failed forward change; roll back to the last known-good state ref captured above (v1 —
    // "prior" to the bad v2 trigger), proving DESIGN §9.4's "trigger-a-rollback and trigger-a-
    // forward-change are the exact same verb with different intent data".
    const rollbackRef = await plugin.trigger(ctx, {
      kind: "rollback",
      targetRef: "svc-a",
      priorStateRef: "v1"
    });
    const rollbackStatus = await plugin.status(ctx, rollbackRef);
    expect(rollbackStatus.stateRef).toBe("v1");

    // And the NEXT forward trigger resumes counting from the rolled-back version, not from v2.
    const nextRef = await plugin.trigger(ctx, { kind: "sync", targetRef: "svc-a" });
    const nextStatus = await plugin.status(ctx, nextRef);
    expect(nextStatus.stateRef).toBe("v2");
  });

  it("status() reports running until autoSucceedAfterMs elapses, then succeeded", async () => {
    // Fake ONLY Date (not real timers) so the auto-succeed threshold is crossed deterministically
    // by advancing the clock, never by racing wall-clock elapsed against I/O latency under CI load.
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
      const plugin = createFakeExecutorPlugin();
      const ctx = testCtx({ autoSucceedAfterMs: 30 });
      const ref = await plugin.trigger(ctx, { kind: "sync", targetRef: "svc-a" });

      const immediate = await plugin.status(ctx, ref);
      expect(immediate.phase).toBe("running");
      expect(immediate.progress).toBeLessThan(1);

      vi.setSystemTime(Date.now() + 60);
      const later = await plugin.status(ctx, ref);
      expect(later.phase).toBe("succeeded");
      expect(later.progress).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("abort() permanently sets aborted, overriding the auto-succeed timer", async () => {
    const plugin = createFakeExecutorPlugin();
    const ctx = testCtx({ autoSucceedAfterMs: 10 });
    const ref = await plugin.trigger(ctx, { kind: "sync", targetRef: "svc-a" });

    const abortResult = await plugin.abort(ctx, ref);
    expect(abortResult.aborted).toBe(true);

    await sleep(30); // past autoSucceedAfterMs — should NOT flip back to succeeded
    const status = await plugin.status(ctx, ref);
    expect(status.phase).toBe("aborted");
  });

  it("forcePhase config deterministically overrides a specific target regardless of elapsed time", async () => {
    const plugin = createFakeExecutorPlugin();
    const ctx = testCtx({ autoSucceedAfterMs: 5, forcePhase: { "svc-b": "failed" } });
    const refA = await plugin.trigger(ctx, { kind: "sync", targetRef: "svc-a" });
    const refB = await plugin.trigger(ctx, { kind: "sync", targetRef: "svc-b" });

    await sleep(30);
    const statusA = await plugin.status(ctx, refA);
    const statusB = await plugin.status(ctx, refB);
    expect(statusA.phase).toBe("succeeded"); // unaffected target still auto-succeeds
    expect(statusB.phase).toBe("failed"); // forced target stays failed deterministically
  });

  it("trigger() with the same idempotencyKey dedupes: same externalId, no version bump; a different key mints a new run", async () => {
    const plugin = createFakeExecutorPlugin();
    const ctx = testCtx();

    const first = await plugin.trigger(ctx, { kind: "sync", targetRef: "svc-a", idempotencyKey: "wave-target-1" });
    const firstStatus = await plugin.status(ctx, first);
    expect(firstStatus.stateRef).toBe("v0");

    // Same key again (simulates the engine retrying after a crash between trigger() and its own
    // result-commit) — must return the IDENTICAL externalId and NOT bump the version.
    const retry = await plugin.trigger(ctx, { kind: "sync", targetRef: "svc-a", idempotencyKey: "wave-target-1" });
    expect(retry.externalId).toBe(first.externalId);
    const retryStatus = await plugin.status(ctx, retry);
    expect(retryStatus.stateRef).toBe("v0");

    // A genuinely different key (a different wave target) mints a fresh run, bumping the version.
    const second = await plugin.trigger(ctx, { kind: "sync", targetRef: "svc-a", idempotencyKey: "wave-target-2" });
    expect(second.externalId).not.toBe(first.externalId);
    const secondStatus = await plugin.status(ctx, second);
    expect(secondStatus.stateRef).toBe("v1");
  });

  it("trigger() calls with no idempotencyKey at all never dedupe against each other (pre-existing behavior preserved)", async () => {
    const plugin = createFakeExecutorPlugin();
    const ctx = testCtx();
    const ref0 = await plugin.trigger(ctx, { kind: "sync", targetRef: "svc-a" });
    const ref1 = await plugin.trigger(ctx, { kind: "sync", targetRef: "svc-a" });
    expect(ref1.externalId).not.toBe(ref0.externalId);
    const status1 = await plugin.status(ctx, ref1);
    expect(status1.stateRef).toBe("v1");
  });

  it("status() on a ref that was never triggered returns pending rather than throwing", async () => {
    const plugin = createFakeExecutorPlugin();
    const ctx = testCtx();
    const status = await plugin.status(ctx, { externalId: "svc-z::not-a-real-run" });
    expect(status.phase).toBe("pending");
  });

  it("observe() always returns an empty array (no push-based events for the fake executor)", async () => {
    const plugin = createFakeExecutorPlugin();
    const ctx = testCtx();
    await expect(plugin.observe(ctx)).resolves.toEqual([]);
  });

  it("trigger() defaults to a fixed target key when TriggerIntent.targetRef is omitted", async () => {
    const plugin = createFakeExecutorPlugin();
    const ctx = testCtx();
    const ref = await plugin.trigger(ctx, { kind: "custom" });
    const status = await plugin.status(ctx, ref);
    expect(status.phase).toBe("running");
  });
});

describe("FakeExecutorPlugin (file-backed state — restart recovery)", () => {
  let dir: string;
  let statePath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "scp-fake-executor-test-"));
    statePath = join(dir, "state.json");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("a second plugin instance sharing statePath sees state written by the first — the restart-recovery property", async () => {
    // Simulates the subprocess-host scenario: process A (plugin instance 1) triggers a run, then
    // gets killed; a freshly spawned process B (plugin instance 2, same statePath) must answer
    // status() for that exact ref correctly. Two SEPARATE `FakeExecutorPlugin` instances stand in
    // for "two separate OS processes" here — the class holds no state itself once statePath is
    // set (see module doc), so this is a faithful proxy for the real subprocess-kill scenario,
    // which is additionally exercised end-to-end in apps/server/src/plugin-host/*.integration.test.ts.
    // Deterministic clock (fake Date only): the "running" read happens at elapsed 0 and the
    // "succeeded" read after a controlled +40ms jump — no dependence on wall-clock timing, which
    // previously flaked when I/O between trigger() and status() outran the 20ms auto-succeed window.
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
      const instanceA = new FakeExecutorPlugin();
      const ctxA = testCtx({ statePath, autoSucceedAfterMs: 20 });
      const ref = await instanceA.trigger(ctxA, { kind: "sync", targetRef: "svc-a" });

      const instanceB = new FakeExecutorPlugin();
      const ctxB = testCtx({ statePath, autoSucceedAfterMs: 20 });
      const statusFromB = await instanceB.status(ctxB, ref);
      expect(statusFromB.phase).toBe("running");
      expect(statusFromB.stateRef).toBe("v0");

      vi.setSystemTime(Date.now() + 40);
      const laterFromB = await instanceB.status(ctxB, ref);
      expect(laterFromB.phase).toBe("succeeded");
    } finally {
      vi.useRealTimers();
    }
  });

  it("state persists across trigger calls made by different instances against the same statePath", async () => {
    const instanceA = new FakeExecutorPlugin();
    const ctx = testCtx({ statePath });
    await instanceA.trigger(ctx, { kind: "sync", targetRef: "svc-a" }); // v0

    const instanceB = new FakeExecutorPlugin();
    const ref1 = await instanceB.trigger(ctx, { kind: "sync", targetRef: "svc-a" }); // v1, continuing from A's v0
    const status1 = await instanceB.status(ctx, ref1);
    expect(status1.stateRef).toBe("v1");
  });
});
