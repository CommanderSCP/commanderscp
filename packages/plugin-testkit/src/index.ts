/** Public per-interface conformance suites for operators. See docs/plugin-testkit.md §1. */
import { describe, expect, it } from "vitest";

/** Re-exports the tracked tempdir allocator to every fixture. See docs/plugin-testkit.md §2. */
export {
  mkdtempTracked,
  mkdtempTrackedSync,
  mkdtempTrackedForFile,
  mkdtempTrackedForFileSync
} from "@scp/test-tmpdir";

// LEVER 1: the shared runner-image resolver (prebuilt-pull with local-build fallback), re-exported
// from the package root so both real-Docker integration suites (@scp/server promotion-scan-step,
// @scp/plugin-managed-iac) import it the same way.
export { resolveRunnerImage, type ResolveRunnerImageOptions } from "./runner-image.js";
import type {
  ControlOutcomeStatus,
  ControlPlugin,
  ControlRequest,
  DiscoveryPlugin,
  ExecutorCapabilities,
  ExecutorEvent,
  ExecutorPlugin,
  NotificationMessage,
  NotificationPlugin,
  PluginContext,
  TriggerIntent
} from "@scp/plugin-api";

export interface ExecutorConformanceFixture {
  plugin: ExecutorPlugin;
  ctx: PluginContext;
  /** MAJOR #4 (adversarial review). See docs/plugin-testkit.md §3. */
  restart?: () => Promise<{ plugin: ExecutorPlugin; ctx: PluginContext }>;
}

const KNOWN_TRIGGER_KINDS: TriggerIntent["kind"][] = [
  "sync",
  "workflow_dispatch",
  "rollback",
  "custom"
];
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

/** Runs the executor suite on a fresh instance per test. See docs/plugin-testkit.md §4. */
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
      if (!caps.supportsTrigger) return;

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

    /** Same idempotency key, same run, no duplicate effect. See docs/plugin-testkit.md §5. */
    it("trigger() honors idempotencyKey — the SAME key returns the SAME ExternalRunRef on retry (no duplicate side effect)", async () => {
      const { plugin, ctx } = await factory();
      const caps = plugin.describeCapabilities();
      if (!caps.supportsTrigger) return;

      const kind = caps.triggerKinds[0] ?? "custom";
      const intent: TriggerIntent = {
        kind,
        targetRef: "conformance-idempotency-target",
        idempotencyKey: "conformance-idempotency-key"
      };
      const first = await plugin.trigger(ctx, intent);
      const second = await plugin.trigger(ctx, intent);
      expect(second.externalId).toBe(first.externalId);
    });

    it("trigger() dedup SURVIVES a subprocess restart — same key across a fresh instance sharing durable state returns the SAME ExternalRunRef (MAJOR #4)", async () => {
      const first = await factory();
      const caps = first.plugin.describeCapabilities();
      if (!caps.supportsTrigger) return;

      const kind = caps.triggerKinds[0] ?? "custom";
      const intent: TriggerIntent = {
        kind,
        targetRef: "conformance-restart-target",
        idempotencyKey: "conformance-restart-key"
      };
      const firstRef = await first.plugin.trigger(first.ctx, intent);

      // Simulate a subprocess restart: a FRESH plugin instance + ctx that share only the durable
      // (on-disk) dedup state, never the first instance's in-process memory. A plugin whose dedup
      // is in-memory-only would re-fire here and mint a DIFFERENT ref; a durable one returns the
      // same. A fixture without `restart` reuses the same instance (same-process fallback).
      const restarted = first.restart
        ? await first.restart()
        : { plugin: first.plugin, ctx: first.ctx };
      const secondRef = await restarted.plugin.trigger(restarted.ctx, intent);
      expect(secondRef.externalId).toBe(firstRef.externalId);
    });
  });
}

// ControlPlugin conformance: contract shape only. See docs/plugin-testkit.md §6.

const KNOWN_CONTROL_STATUSES: ControlOutcomeStatus[] = [
  "pass",
  "fail",
  "warning",
  "skipped",
  "timed_out",
  "expired"
];

export interface ControlConformanceFixture {
  plugin: ControlPlugin;
  ctx: PluginContext;
  /** A representative request `evaluate()` should handle without throwing. */
  request: ControlRequest;
}

/** Runs the control suite on a fresh instance per test. See docs/plugin-testkit.md §7. */
export function runControlConformanceSuite(
  name: string,
  factory: () => Promise<ControlConformanceFixture>
): void {
  describe(`ControlPlugin conformance: ${name}`, () => {
    it("evaluate() returns a well-formed ControlOutcome — never throws", async () => {
      const { plugin, ctx, request } = await factory();
      const outcome = await plugin.evaluate(ctx, request);
      expect(KNOWN_CONTROL_STATUSES).toContain(outcome.status);
      if (outcome.evidence !== undefined) {
        expect(typeof outcome.evidence).toBe("object");
        expect(outcome.evidence).not.toBeNull();
      }
      if (outcome.detail !== undefined) {
        expect(typeof outcome.detail).toBe("string");
      }
    });

    it("evaluate() ALWAYS carries an evidence payload (DESIGN §10.2: outcomes are 'always with an evidence payload')", async () => {
      const { plugin, ctx, request } = await factory();
      const outcome = await plugin.evaluate(ctx, request);
      expect(outcome.evidence).toBeDefined();
    });
  });
}

// DiscoveryPlugin conformance: a well-formed proposal only. See docs/plugin-testkit.md §8.

export interface DiscoveryConformanceFixture {
  plugin: DiscoveryPlugin;
  ctx: PluginContext;
}

export function runDiscoveryConformanceSuite(
  name: string,
  factory: () => Promise<DiscoveryConformanceFixture>
): void {
  describe(`DiscoveryPlugin conformance: ${name}`, () => {
    it("discover() returns a well-formed DiscoveryProposal", async () => {
      const { plugin, ctx } = await factory();
      const proposal = await plugin.discover(ctx);
      expect(Array.isArray(proposal.objects)).toBe(true);
      expect(Array.isArray(proposal.relationships)).toBe(true);
      for (const object of proposal.objects) {
        expect(typeof object.typeId).toBe("string");
        expect(object.typeId.length).toBeGreaterThan(0);
        expect(typeof object.name).toBe("string");
        expect(object.name.length).toBeGreaterThan(0);
      }
      for (const relationship of proposal.relationships) {
        expect(typeof relationship.typeId).toBe("string");
        expect(typeof relationship.fromUrn).toBe("string");
        expect(typeof relationship.toUrn).toBe("string");
      }
    });
  });
}

// NotificationPlugin conformance: a failure is not a throw. See docs/plugin-testkit.md §9.

export interface NotificationConformanceFixture {
  plugin: NotificationPlugin;
  ctx: PluginContext;
  /** A representative message `send()` should handle without throwing. */
  message: NotificationMessage;
}

export function runNotificationConformanceSuite(
  name: string,
  factory: () => Promise<NotificationConformanceFixture>
): void {
  describe(`NotificationPlugin conformance: ${name}`, () => {
    it("send() returns a well-formed DeliveryResult — never throws", async () => {
      const { plugin, ctx, message } = await factory();
      const result = await plugin.send(ctx, message);
      expect(typeof result.delivered).toBe("boolean");
      if (result.detail !== undefined) {
        expect(typeof result.detail).toBe("string");
      }
    });
  });
}
