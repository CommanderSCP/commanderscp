/**
 * @scp/plugin-testkit — public per-interface conformance suites (DESIGN.md §11: "`@scp/
 * plugin-testkit` ships public per-interface conformance suites, so operators can vet a
 * third-party plugin before baking it into an air-gap image — the only vetting point a
 * disconnected site gets"; BUILD_AND_TEST.md §4.2 "every shipped plugin runs the relevant
 * `@scp/plugin-testkit` suite in its own package tests").
 *
 * M3 (BUILD_AND_TEST.md §8 M3 item 7) is the first real implementation: only `ExecutorPlugin`
 * has a shipped implementation (the in-repo fake executor) to conform against, so only its suite
 * exists here. The other five `@scp/plugin-api` interfaces get their own `run*ConformanceSuite`
 * exports the same way once M4/M6/M7 ship a real implementation to test.
 *
 * Deliberately generic: every assertion checks only the SHAPE the `ExecutorPlugin` contract
 * itself promises (well-formed capabilities/refs/phases/events) — never fake-executor-specific
 * behavior (exact version numbering, file-backed state, timing). That's what lets a REAL executor
 * plugin (GitHub/ArgoCD, M7) reuse this exact suite later against a live or fixture-backed
 * instance, and what lets an operator vet an arbitrary third-party plugin with it before trusting
 * it into an air-gap image.
 */
import { describe, expect, it } from "vitest";
import type {
  ExecutorCapabilities,
  ExecutorEvent,
  ExecutorPlugin,
  PluginContext,
  TriggerIntent
} from "@scp/plugin-api";

export interface ExecutorConformanceFixture {
  plugin: ExecutorPlugin;
  ctx: PluginContext;
}

const KNOWN_TRIGGER_KINDS: TriggerIntent["kind"][] = ["sync", "workflow_dispatch", "rollback", "custom"];
const KNOWN_EVENT_KINDS: ExecutorEvent["kind"][] = [
  "push",
  "pull_request",
  "workflow_run",
  "deployment",
  "release",
  "sync",
  "custom"
];
const KNOWN_PHASES = ["pending", "running", "succeeded", "failed", "aborted"];

function assertWellFormedCapabilities(caps: ExecutorCapabilities): void {
  expect(typeof caps.supportsObserve).toBe("boolean");
  expect(typeof caps.supportsTrigger).toBe("boolean");
  expect(typeof caps.supportsAbort).toBe("boolean");
  expect(Array.isArray(caps.triggerKinds)).toBe(true);
  for (const kind of caps.triggerKinds) {
    expect(KNOWN_TRIGGER_KINDS).toContain(kind);
  }
}

/**
 * Runs the `ExecutorPlugin` conformance suite against a fresh plugin+ctx built by `factory` —
 * called once per `it()` so each assertion starts from a clean instance rather than accumulating
 * state across the suite (a shipped plugin's own package test wires this up, e.g.
 * `runExecutorConformanceSuite("fake-executor", async () => ({ plugin, ctx }))`).
 */
export function runExecutorConformanceSuite(
  name: string,
  factory: () => Promise<ExecutorConformanceFixture>
): void {
  describe(`ExecutorPlugin conformance: ${name}`, () => {
    it("describeCapabilities() returns a well-formed ExecutorCapabilities", async () => {
      const { plugin } = await factory();
      assertWellFormedCapabilities(plugin.describeCapabilities());
    });

    it("trigger() returns an ExternalRunRef with a non-empty externalId", async () => {
      const { plugin, ctx } = await factory();
      const caps = plugin.describeCapabilities();
      if (!caps.supportsTrigger) return; // capability-gated, per the contract's own vocabulary

      const kind = caps.triggerKinds[0] ?? "custom";
      const ref = await plugin.trigger(ctx, { kind, targetRef: "conformance-target" });
      expect(typeof ref.externalId).toBe("string");
      expect(ref.externalId.length).toBeGreaterThan(0);
    });

    it("status() on a triggered ref returns a valid ExecutionPhase", async () => {
      const { plugin, ctx } = await factory();
      const caps = plugin.describeCapabilities();
      if (!caps.supportsTrigger) return;

      const kind = caps.triggerKinds[0] ?? "custom";
      const ref = await plugin.trigger(ctx, { kind, targetRef: "conformance-target" });
      const status = await plugin.status(ctx, ref);
      expect(KNOWN_PHASES).toContain(status.phase);
      if (status.progress !== undefined) {
        expect(status.progress).toBeGreaterThanOrEqual(0);
        expect(status.progress).toBeLessThanOrEqual(1);
      }
    });

    it("abort() returns a well-formed AbortResult", async () => {
      const { plugin, ctx } = await factory();
      const caps = plugin.describeCapabilities();
      if (!caps.supportsTrigger || !caps.supportsAbort) return;

      const kind = caps.triggerKinds[0] ?? "custom";
      const ref = await plugin.trigger(ctx, { kind, targetRef: "conformance-target" });
      const result = await plugin.abort(ctx, ref);
      expect(typeof result.aborted).toBe("boolean");
    });

    it("observe() returns an array of well-formed ExecutorEvents (empty is fine)", async () => {
      const { plugin, ctx } = await factory();
      const caps = plugin.describeCapabilities();
      if (!caps.supportsObserve) return;

      const events = await plugin.observe(ctx);
      expect(Array.isArray(events)).toBe(true);
      for (const event of events) {
        expect(KNOWN_EVENT_KINDS).toContain(event.kind);
        expect(typeof event.occurredAt).toBe("string");
        expect(() => new Date(event.occurredAt).toISOString()).not.toThrow();
        expect(typeof event.correlation).toBe("object");
      }
    });
  });
}
