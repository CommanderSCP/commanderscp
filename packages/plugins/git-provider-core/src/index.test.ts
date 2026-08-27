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
    mapStatusToPhase: (status) => (status === "completed" ? "succeeded" : "running"),
    // Required by the interface since M21.2. The fake's implementation is deliberately trivial —
    // the real decode/refusal behavior is covered in `read-file.test.ts` and each provider's own
    // nock suite; what this call site proves is only that the hook is part of the contract.
    readFileAtRef: async (_ctx, request) => ({
      outcome: "found",
      path: request.path,
      requestedRef: request.ref,
      commitSha: "fake-commit-sha",
      content: "{}",
      sizeBytes: 2
    }),
    // Required by the interface (bounded tree reads). Trivial for the same reason readFileAtRef's
    // fake is trivial — the real bound/listing behavior is covered in `read-tree.test.ts` and each
    // provider's own nock suite; this call site only proves the hook is part of the contract.
    readFilesAtRef: async (_ctx, request) => ({
      outcome: "found",
      requestedRef: request.ref,
      commitSha: "fake-commit-sha",
      files: []
    })
  };
  return { adapter, calls };
}

function fakeCtx(): PluginContext {
  return {
    orgId: "org-1",
    scopeKey: "domain-1",
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

  /**
   * NEGATIVE CONTROL, and the point of the whole assertion: `readFileAtRef` must NOT appear on the
   * assembled `ExecutorPlugin`. ADR-0032 §9 and charter principle 1 hold that the four verbs ARE the
   * structural enforcement of "coordination, not execution"; a fifth key here becomes a fifth verb
   * in every consumer of an `ExecutorPlugin`. The positive half (the hook exists and is reachable on
   * the ADAPTER) is asserted alongside so this cannot pass by the hook simply not existing.
   */
  it("does NOT surface readFileAtRef as an ExecutorPlugin verb — the four-verb set is unchanged (ADR-0032 §9)", async () => {
    const { adapter } = buildFakeAdapter();
    const plugin = createExecutorPluginFromAdapter(adapter);

    expect(Object.keys(plugin).sort()).toEqual([
      "abort",
      "describeCapabilities",
      "observe",
      "status",
      "trigger"
    ]);
    expect("readFileAtRef" in plugin).toBe(false);

    // ...and it IS reachable on the adapter, so the absence above is a boundary, not a gap.
    const result = await adapter.readFileAtRef(fakeCtx(), { path: "go.mod", ref: "main" });
    expect(result.outcome).toBe("found");
  });

  /**
   * ================================================================================================
   * `GitProviderAdapter` IS READ-ONLY, AND A WRITE HOOK MAY NOT REAPPEAR ON IT (owner decision
   * 2026-08-15; ADR-0032 §9)
   * ================================================================================================
   * §9 justifies this adapter's existence as an escape hatch on TWO things: the `ExecutorPlugin`
   * object is unchanged, AND — in its own words — "It also only READS." M21.5 briefly grew
   * `createBranch`/`putFileOnBranch`/`openPullRequest` here, which contradicts the second half of
   * that argument: extending the same mechanism to writes leaves the verb set intact while moving
   * repository-write authority into a package every git-provider plugin loads and that is not one of
   * the charter's enumerated managed classes. The write authority therefore lives inside
   * `scp-managed-dep` (`packages/plugins/managed-dep`), where the charter's containment
   * preconditions actually bind, and this interface reads.
   *
   * The absence is pinned TWO ways, because they fail at different times and catch different edits:
   *
   *  - the TYPE-LEVEL pin fails `tsc` the moment a write hook is DECLARED on the interface, which is
   *    the edit that would reopen this. A runtime `in` check cannot see an interface at all;
   *  - the key-set assertion in the test above already fails if such a hook were also surfaced as a
   *    fifth verb.
   *
   * The read hook is asserted PRESENT in the same breath, so this cannot go green by the whole
   * capability quietly disappearing — the vacuous-pass shape this repository has been bitten by.
   */
  it("declares NO repository-write hook — §9's escape hatch is justified by 'It also only READS'", () => {
    // Type-level: this alias is `never` unless the interface is free of all three, so the assignment
    // below is what makes a reintroduced hook a COMPILE error rather than a comment nobody reads.
    type WriteHookName = "createBranch" | "putFileOnBranch" | "openPullRequest";
    type AdapterIsReadOnly =
      Extract<keyof GitProviderAdapter, WriteHookName> extends never ? true : never;
    const readOnly: AdapterIsReadOnly = true;
    expect(readOnly).toBe(true);

    // Runtime, over the fake that satisfies the interface: it neither has nor needs them, while the
    // read hook it DOES need is present.
    const { adapter } = buildFakeAdapter();
    for (const hook of ["createBranch", "putFileOnBranch", "openPullRequest"]) {
      expect(hook in adapter, `${hook} must not be on a GitProviderAdapter`).toBe(false);
    }
    expect(typeof adapter.readFileAtRef).toBe("function");
  });
});
