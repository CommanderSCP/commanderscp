/**
 * `@scp/git-provider-core` unit tests — the provider-neutral machinery, exercised with a FAKE
 * adapter (no HTTP, no real provider). These cover the shared logic the GitHub plugin's own `nock`
 * suite would otherwise be the only proof of, so the core is independently covered before a second
 * provider (Gitea, M15.1b) rides on it: the dedup/idempotency cache (in-memory + file-backed), the
 * dispatch-then-persist trigger dance, the observe cursor protocol + event concatenation, and
 * correlation-hint normalization.
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  AbortResult,
  ExecutionStatus,
  ExecutorCapabilities,
  ExecutorEvent,
  ExternalRunRef,
  PluginContext,
  TriggerIntent
} from "@scp/plugin-api";
import {
  __resetInMemoryDedupState,
  createExecutorPluginFromAdapter,
  normalizeCorrelation,
  type GitProviderAdapter
} from "./index.js";

// -------------------------------------------------------------------------------------------
// A fully in-memory fake adapter that RECORDS what the core asked it to do, so tests can assert the
// core called (or did NOT re-call) triggerCI, and how it passed the observe cursor through.
// -------------------------------------------------------------------------------------------

interface FakeAdapterCalls {
  triggerCI: TriggerIntent[];
  pollCommits: (string | undefined)[];
  pollRuns: (string | undefined)[];
  getStatus: ExternalRunRef[];
  abortRun: ExternalRunRef[];
}

function buildFakeAdapter(opts: { statePath?: string } = {}): {
  adapter: GitProviderAdapter;
  calls: FakeAdapterCalls;
} {
  const calls: FakeAdapterCalls = {
    triggerCI: [],
    pollCommits: [],
    pollRuns: [],
    getStatus: [],
    abortRun: []
  };
  let runSeq = 0;
  const adapter: GitProviderAdapter = {
    sourceKind: "fake",
    authorize: async () => ({ authorization: "Bearer fake" }),
    baseUrl: () => "https://fake.example",
    resolveStatePath: () => opts.statePath,
    triggerCI: async (_ctx, intent) => {
      calls.triggerCI.push(intent);
      runSeq += 1;
      // A UNIQUE externalId per call, so a test that sees the SAME id back proves the core served
      // it from the dedup cache rather than re-invoking triggerCI.
      return { externalId: `run::${runSeq}`, url: `https://fake.example/runs/${runSeq}` };
    },
    pollCommits: async (_ctx, sinceIso) => {
      calls.pollCommits.push(sinceIso);
      return [
        {
          kind: "push",
          occurredAt: "2026-07-01T00:00:00Z",
          correlation: normalizeCorrelation({ repo: "acme/widgets", commitSha: "abc" }),
          raw: { sha: "abc" }
        }
      ];
    },
    pollRuns: async (_ctx, sinceIso) => {
      calls.pollRuns.push(sinceIso);
      return [
        {
          kind: "workflow_run",
          occurredAt: "2026-07-01T00:05:00Z",
          correlation: normalizeCorrelation({ repo: "acme/widgets", correlationKey: "run-1" }),
          raw: { id: 1 }
        }
      ];
    },
    getStatus: async (_ctx, ref): Promise<ExecutionStatus> => {
      calls.getStatus.push(ref);
      return { phase: "succeeded", detail: `status-for:${ref.externalId}` };
    },
    abortRun: async (_ctx, ref): Promise<AbortResult> => {
      calls.abortRun.push(ref);
      return { aborted: true, detail: `abort-for:${ref.externalId}` };
    },
    capabilities: (): ExecutorCapabilities => ({
      supportsObserve: true,
      supportsTrigger: true,
      supportsAbort: false,
      triggerKinds: ["workflow_dispatch"]
    }),
    verifyWebhook: (_rawBody, header) => header === "valid",
    mapEvent: (name) => (name === "push" ? { repo: "acme/widgets", commitSha: "abc" } : null),
    mapStatusToPhase: (status) => (status === "completed" ? "succeeded" : "running")
  };
  return { adapter, calls };
}

function fakeCtx(): PluginContext {
  return {
    orgId: "org-1",
    domainId: "domain-1",
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    secrets: { get: async () => undefined },
    http: { request: async () => ({ status: 200, headers: {}, body: undefined }) },
    config: {}
  };
}

beforeEach(() => {
  __resetInMemoryDedupState();
});

// -------------------------------------------------------------------------------------------
// normalizeCorrelation
// -------------------------------------------------------------------------------------------

describe("normalizeCorrelation", () => {
  it("maps every hint field onto the correlation, leaving absent fields undefined", () => {
    expect(normalizeCorrelation({ repo: "a/b", commitSha: "sha1", correlationKey: "k" })).toEqual({
      repo: "a/b",
      path: undefined,
      commitSha: "sha1",
      correlationKey: "k"
    });
  });

  it("carries a path hint through", () => {
    expect(normalizeCorrelation({ repo: "a/b", path: "main" })).toEqual({
      repo: "a/b",
      path: "main",
      commitSha: undefined,
      correlationKey: undefined
    });
  });
});

// -------------------------------------------------------------------------------------------
// trigger() dedup / idempotency — in-memory
// -------------------------------------------------------------------------------------------

describe("trigger() idempotency (in-memory dedup)", () => {
  it("a second trigger() with the SAME idempotencyKey returns the SAME ref and never re-calls triggerCI", async () => {
    const { adapter, calls } = buildFakeAdapter();
    const plugin = createExecutorPluginFromAdapter(adapter);
    const ctx = fakeCtx();
    const intent: TriggerIntent = { kind: "workflow_dispatch", idempotencyKey: "key-1" };

    const first = await plugin.trigger(ctx, intent);
    const second = await plugin.trigger(ctx, intent);

    expect(second.externalId).toBe(first.externalId);
    expect(second.url).toBe(first.url);
    expect(calls.triggerCI).toHaveLength(1); // only the FIRST call fired the automation
  });

  it("a DIFFERENT idempotencyKey mints an independent run (dedup is per-key)", async () => {
    const { adapter, calls } = buildFakeAdapter();
    const plugin = createExecutorPluginFromAdapter(adapter);
    const ctx = fakeCtx();

    const a = await plugin.trigger(ctx, { kind: "workflow_dispatch", idempotencyKey: "key-a" });
    const b = await plugin.trigger(ctx, { kind: "workflow_dispatch", idempotencyKey: "key-b" });

    expect(a.externalId).not.toBe(b.externalId);
    expect(calls.triggerCI).toHaveLength(2);
  });

  it("an un-keyed intent always mints a fresh run (no cross-call collision)", async () => {
    const { adapter, calls } = buildFakeAdapter();
    const plugin = createExecutorPluginFromAdapter(adapter);
    const ctx = fakeCtx();

    const a = await plugin.trigger(ctx, { kind: "workflow_dispatch" });
    const b = await plugin.trigger(ctx, { kind: "workflow_dispatch" });

    expect(a.externalId).not.toBe(b.externalId);
    expect(calls.triggerCI).toHaveLength(2);
  });
});

// -------------------------------------------------------------------------------------------
// trigger() dedup / idempotency — file-backed (crash-safe: re-reads from disk each call)
// -------------------------------------------------------------------------------------------

describe("trigger() idempotency (file-backed dedup)", () => {
  let dir: string;
  let statePath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "git-provider-core-test-"));
    statePath = join(dir, "state.json");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("persists the ref to disk and a second call re-reads it without re-calling triggerCI", async () => {
    const { adapter, calls } = buildFakeAdapter({ statePath });
    const plugin = createExecutorPluginFromAdapter(adapter);
    const ctx = fakeCtx();
    const intent: TriggerIntent = { kind: "workflow_dispatch", idempotencyKey: "durable-key" };

    const first = await plugin.trigger(ctx, intent);

    const persisted = JSON.parse(await readFile(statePath, "utf8")) as {
      keys: Record<string, { externalId: string; url?: string }>;
    };
    expect(persisted.keys["durable-key"]?.externalId).toBe(first.externalId);
    expect(persisted.keys["durable-key"]?.url).toBe(first.url);

    const second = await plugin.trigger(ctx, intent);
    expect(second.externalId).toBe(first.externalId);
    expect(calls.triggerCI).toHaveLength(1);
  });

  it("a fresh adapter instance sharing the same statePath still dedups (durable across 'restart')", async () => {
    const intent: TriggerIntent = { kind: "workflow_dispatch", idempotencyKey: "restart-key" };
    const ctx = fakeCtx();

    const inst1 = buildFakeAdapter({ statePath });
    const first = await createExecutorPluginFromAdapter(inst1.adapter).trigger(ctx, intent);

    // A brand-new adapter object (no shared in-memory state) reads the ref back from disk.
    const inst2 = buildFakeAdapter({ statePath });
    const second = await createExecutorPluginFromAdapter(inst2.adapter).trigger(ctx, intent);

    expect(second.externalId).toBe(first.externalId);
    expect(inst2.calls.triggerCI).toHaveLength(0);
  });
});

// -------------------------------------------------------------------------------------------
// observe() cursor protocol + event concatenation
// -------------------------------------------------------------------------------------------

describe("observe() cursor + concatenation", () => {
  it("passes since.token as the ISO watermark to BOTH pollers and concatenates commits then runs", async () => {
    const { adapter, calls } = buildFakeAdapter();
    const plugin = createExecutorPluginFromAdapter(adapter);
    const ctx = fakeCtx();

    const events = await plugin.observe(ctx, { token: "2026-06-30T00:00:00Z" });

    expect(calls.pollCommits).toEqual(["2026-06-30T00:00:00Z"]);
    expect(calls.pollRuns).toEqual(["2026-06-30T00:00:00Z"]);
    expect(events.map((e: ExecutorEvent) => e.kind)).toEqual(["push", "workflow_run"]);
  });

  it("passes undefined to the pollers when no cursor is supplied", async () => {
    const { adapter, calls } = buildFakeAdapter();
    const plugin = createExecutorPluginFromAdapter(adapter);

    await plugin.observe(fakeCtx());

    expect(calls.pollCommits).toEqual([undefined]);
    expect(calls.pollRuns).toEqual([undefined]);
  });
});

// -------------------------------------------------------------------------------------------
// status/abort/describeCapabilities delegation
// -------------------------------------------------------------------------------------------

describe("verb delegation to the adapter", () => {
  it("status() delegates to adapter.getStatus with the ref", async () => {
    const { adapter, calls } = buildFakeAdapter();
    const plugin = createExecutorPluginFromAdapter(adapter);
    const status = await plugin.status(fakeCtx(), { externalId: "run::42" });
    expect(status.detail).toBe("status-for:run::42");
    expect(calls.getStatus).toEqual([{ externalId: "run::42" }]);
  });

  it("abort() delegates to adapter.abortRun with the ref", async () => {
    const { adapter, calls } = buildFakeAdapter();
    const plugin = createExecutorPluginFromAdapter(adapter);
    const result = await plugin.abort(fakeCtx(), { externalId: "run::7" });
    expect(result).toEqual({ aborted: true, detail: "abort-for:run::7" });
    expect(calls.abortRun).toEqual([{ externalId: "run::7" }]);
  });

  it("describeCapabilities() returns the adapter's capabilities verbatim", async () => {
    const { adapter } = buildFakeAdapter();
    const plugin = createExecutorPluginFromAdapter(adapter);
    expect(plugin.describeCapabilities()).toEqual({
      supportsObserve: true,
      supportsTrigger: true,
      supportsAbort: false,
      triggerKinds: ["workflow_dispatch"]
    });
  });
});
