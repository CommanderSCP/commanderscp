/**
 * `@scp/plugin-argo-workflows` behavioral test suite — nock-fixtures every HTTP call so these tests
 * are deterministic and never touch the real network (CLAUDE.md: "Tests never touch the
 * internet").
 *
 * Every `PluginContext` here is built with a REAL `ScopedHttpClient`
 * (`./test-node-http-client.ts` — node:http/https, not `fetch`; see that file's doc comment for
 * why `fetch` doesn't work against `nock@13.5.x`, the version pinned in this package's
 * package.json). That means these tests exercise `index.ts`'s actual `apiRequest()` wire path —
 * method, URL, JSON body, `Authorization` header, JSON response parsing — not just its in-process
 * return values.
 *
 * `nock.disableNetConnect()` is on for the whole file so a request this suite forgot to fixture
 * fails loudly instead of hanging on a real DNS lookup.
 */
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import nock from "nock";
import type { PluginContext, SecretsAccessor, TriggerIntent } from "@scp/plugin-api";
import { createArgoWorkflowsExecutorPlugin } from "./index.js";
import { createNodeHttpTestClient } from "./test-node-http-client.js";

const SERVER_URL = "http://argo-workflows.test";
const NAMESPACE = "test-ns";

function testCtx(config: unknown, secrets?: SecretsAccessor): PluginContext {
  return {
    orgId: "org-1",
    scopeKey: "domain-1",
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    secrets: secrets ?? { get: async () => undefined },
    http: createNodeHttpTestClient(),
    config
  };
}

beforeAll(() => {
  nock.disableNetConnect();
});

afterEach(() => {
  nock.cleanAll();
});

afterAll(() => {
  nock.enableNetConnect();
});

describe("describeCapabilities()", () => {
  it("declares observe/trigger/abort and workflow_dispatch, and OMITS rollout entirely (D12: absent, never a claim)", () => {
    const caps = createArgoWorkflowsExecutorPlugin().describeCapabilities();
    expect(caps.supportsObserve).toBe(true);
    expect(caps.supportsTrigger).toBe(true);
    expect(caps.supportsAbort).toBe(true);
    expect(caps.triggerKinds).toContain("workflow_dispatch");
    expect(caps.rollout).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(caps, "rollout")).toBe(false);
  });
});

describe("trigger()", () => {
  it("submits a WorkflowTemplate by name and mints an ExternalRunRef as '{name}::{uid}'", async () => {
    const ctx = testCtx({ serverUrl: SERVER_URL, namespace: NAMESPACE, token: "test-token" });
    const scope = nock(SERVER_URL)
      .post(`/api/v1/workflows/${NAMESPACE}/submit`, {
        resourceKind: "WorkflowTemplate",
        resourceName: "my-template"
      })
      .reply(200, {
        metadata: { name: "my-template-abc12", uid: "uid-1" },
        status: { phase: "Pending" }
      });

    const ref = await createArgoWorkflowsExecutorPlugin().trigger(ctx, {
      kind: "workflow_dispatch",
      targetRef: "my-template"
    });

    expect(scope.isDone()).toBe(true);
    expect(ref.externalId).toBe("my-template-abc12::uid-1");
    expect(ref.url).toBe(`${SERVER_URL}/workflows/${NAMESPACE}/my-template-abc12`);
  });

  it("converts intent.parameters into submitOptions.parameters as 'key=value' strings", async () => {
    const ctx = testCtx({ serverUrl: SERVER_URL, namespace: NAMESPACE, token: "test-token" });
    const scope = nock(SERVER_URL)
      .post(`/api/v1/workflows/${NAMESPACE}/submit`, {
        resourceKind: "WorkflowTemplate",
        resourceName: "param-template",
        submitOptions: { parameters: ["revision=abc123", "count=3"] }
      })
      .reply(200, { metadata: { name: "param-template-x", uid: "uid-2" } });

    const ref = await createArgoWorkflowsExecutorPlugin().trigger(ctx, {
      kind: "workflow_dispatch",
      targetRef: "param-template",
      parameters: { revision: "abc123", count: 3 }
    });

    expect(scope.isDone()).toBe(true);
    expect(ref.externalId).toBe("param-template-x::uid-2");
  });

  it("throws when intent.targetRef is missing", async () => {
    const ctx = testCtx({ serverUrl: SERVER_URL, namespace: NAMESPACE, token: "test-token" });
    await expect(
      createArgoWorkflowsExecutorPlugin().trigger(ctx, { kind: "workflow_dispatch" })
    ).rejects.toThrow(/targetRef/);
  });

  it("throws when the submit response carries no metadata.name/uid, rather than minting a bogus ref", async () => {
    const ctx = testCtx({ serverUrl: SERVER_URL, namespace: NAMESPACE, token: "test-token" });
    nock(SERVER_URL)
      .post(`/api/v1/workflows/${NAMESPACE}/submit`)
      .reply(200, { metadata: {} });

    await expect(
      createArgoWorkflowsExecutorPlugin().trigger(ctx, {
        kind: "workflow_dispatch",
        targetRef: "broken-template"
      })
    ).rejects.toThrow(/metadata\.name/);
  });

  it("throws on a non-2xx submit response", async () => {
    const ctx = testCtx({ serverUrl: SERVER_URL, namespace: NAMESPACE, token: "test-token" });
    nock(SERVER_URL).post(`/api/v1/workflows/${NAMESPACE}/submit`).reply(500, {});

    await expect(
      createArgoWorkflowsExecutorPlugin().trigger(ctx, {
        kind: "workflow_dispatch",
        targetRef: "err-template"
      })
    ).rejects.toThrow(/HTTP 500/);
  });

  describe("idempotency dedup — in-memory mode (no statePath)", () => {
    it("two trigger() calls with the SAME idempotencyKey hit the submit endpoint only once and return the same ExternalRunRef", async () => {
      // No .persist()/.times(): a SECOND POST here would find no matching interceptor and, with
      // disableNetConnect() on, reject loudly — the real proof the dedup cache prevented a resubmit.
      nock(SERVER_URL)
        .post(`/api/v1/workflows/${NAMESPACE}/submit`)
        .reply(200, { metadata: { name: "idem-wf", uid: "uid-idem" } });
      const ctx = testCtx({ serverUrl: SERVER_URL, namespace: NAMESPACE, token: "test-token" });
      const plugin = createArgoWorkflowsExecutorPlugin();
      const intent: TriggerIntent = {
        kind: "workflow_dispatch",
        targetRef: "idem-template",
        idempotencyKey: "key-1"
      };

      const first = await plugin.trigger(ctx, intent);
      const second = await plugin.trigger(ctx, intent);

      expect(second.externalId).toBe(first.externalId);
    });

    it("a DIFFERENT idempotencyKey for the same target submits again (does NOT dedupe)", async () => {
      const scope1 = nock(SERVER_URL)
        .post(`/api/v1/workflows/${NAMESPACE}/submit`)
        .reply(200, { metadata: { name: "idem-wf-a", uid: "uid-a" } });
      const ctx = testCtx({ serverUrl: SERVER_URL, namespace: NAMESPACE, token: "test-token" });
      const plugin = createArgoWorkflowsExecutorPlugin();

      const first = await plugin.trigger(ctx, {
        kind: "workflow_dispatch",
        targetRef: "idem-diff-template",
        idempotencyKey: "key-a"
      });
      expect(scope1.isDone()).toBe(true);

      const scope2 = nock(SERVER_URL)
        .post(`/api/v1/workflows/${NAMESPACE}/submit`)
        .reply(200, { metadata: { name: "idem-wf-b", uid: "uid-b" } });
      const second = await plugin.trigger(ctx, {
        kind: "workflow_dispatch",
        targetRef: "idem-diff-template",
        idempotencyKey: "key-b"
      });
      expect(scope2.isDone()).toBe(true);
      expect(second.externalId).not.toBe(first.externalId);
    });
  });

  describe("idempotency dedup — file-backed mode (survives a simulated restart)", () => {
    it("two trigger() calls with the SAME idempotencyKey against the same statePath hit the submit endpoint only once, even read back by a fresh ctx", async () => {
      const dir = await import("node:fs/promises").then((fs) =>
        fs.mkdtemp(join(tmpdir(), "argo-workflows-test-"))
      );
      const statePath = join(dir, "state.json");
      nock(SERVER_URL)
        .post(`/api/v1/workflows/${NAMESPACE}/submit`)
        .reply(200, { metadata: { name: "restart-wf", uid: "uid-restart" } });

      const ctx1 = testCtx({
        serverUrl: SERVER_URL,
        namespace: NAMESPACE,
        token: "test-token",
        statePath
      });
      const intent: TriggerIntent = {
        kind: "workflow_dispatch",
        targetRef: "restart-template",
        idempotencyKey: "restart-key"
      };
      const first = await createArgoWorkflowsExecutorPlugin().trigger(ctx1, intent);

      // A FRESH plugin instance + ctx sharing only the on-disk statePath — simulates a subprocess
      // restart between the two trigger() calls.
      const ctx2 = testCtx({
        serverUrl: SERVER_URL,
        namespace: NAMESPACE,
        token: "test-token",
        statePath
      });
      const second = await createArgoWorkflowsExecutorPlugin().trigger(ctx2, intent);

      expect(second.externalId).toBe(first.externalId);
      await import("node:fs/promises").then((fs) => fs.rm(dir, { recursive: true, force: true }));
    });
  });
});

describe("status()", () => {
  const phaseCases: Array<{ rawPhase: string | undefined; expected: string }> = [
    { rawPhase: "Pending", expected: "pending" },
    { rawPhase: undefined, expected: "pending" },
    { rawPhase: "Running", expected: "running" },
    { rawPhase: "Succeeded", expected: "succeeded" },
    { rawPhase: "Failed", expected: "failed" },
    { rawPhase: "Error", expected: "failed" }
  ];
  for (const { rawPhase, expected } of phaseCases) {
    it(`status.phase '${rawPhase}' maps to ExecutionPhase '${expected}'`, async () => {
      const ctx = testCtx({ serverUrl: SERVER_URL, namespace: NAMESPACE, token: "test-token" });
      nock(SERVER_URL)
        .get(`/api/v1/workflows/${NAMESPACE}/phase-wf`)
        .reply(200, {
          metadata: { name: "phase-wf", uid: "uid-phase" },
          status: rawPhase ? { phase: rawPhase } : {}
        });

      const result = await createArgoWorkflowsExecutorPlugin().status(ctx, {
        externalId: "phase-wf::uid-phase"
      });
      expect(result.phase).toBe(expected);
    });
  }

  it("an UNKNOWN phase string maps to 'running' (never silently promoted to a terminal success) and logs a warning", async () => {
    const warnCalls: unknown[] = [];
    const ctx = testCtx(
      { serverUrl: SERVER_URL, namespace: NAMESPACE, token: "test-token" },
      undefined
    );
    ctx.logger.warn = (msg, meta) => {
      warnCalls.push({ msg, meta });
    };
    nock(SERVER_URL)
      .get(`/api/v1/workflows/${NAMESPACE}/weird-wf`)
      .reply(200, {
        metadata: { name: "weird-wf", uid: "uid-weird" },
        status: { phase: "SomeFutureArgoPhase" }
      });

    const result = await createArgoWorkflowsExecutorPlugin().status(ctx, {
      externalId: "weird-wf::uid-weird"
    });

    expect(result.phase).toBe("running");
    expect(warnCalls.length).toBe(1);
  });

  it("a 404 response maps to phase 'pending' rather than throwing (workflow not yet visible)", async () => {
    const ctx = testCtx({ serverUrl: SERVER_URL, namespace: NAMESPACE, token: "test-token" });
    nock(SERVER_URL).get(`/api/v1/workflows/${NAMESPACE}/missing-wf`).reply(404, {});

    const result = await createArgoWorkflowsExecutorPlugin().status(ctx, {
      externalId: "missing-wf::uid-missing"
    });
    expect(result.phase).toBe("pending");
  });

  it("a non-2xx, non-404 response (e.g. 500) throws rather than being silently swallowed", async () => {
    const ctx = testCtx({ serverUrl: SERVER_URL, namespace: NAMESPACE, token: "test-token" });
    nock(SERVER_URL).get(`/api/v1/workflows/${NAMESPACE}/err-wf`).reply(500, {});

    await expect(
      createArgoWorkflowsExecutorPlugin().status(ctx, { externalId: "err-wf::uid-err" })
    ).rejects.toThrow(/HTTP 500/);
  });

  it("parses status.progress 'N/M' into a 0..1 fraction", async () => {
    const ctx = testCtx({ serverUrl: SERVER_URL, namespace: NAMESPACE, token: "test-token" });
    nock(SERVER_URL)
      .get(`/api/v1/workflows/${NAMESPACE}/progress-wf`)
      .reply(200, {
        metadata: { name: "progress-wf", uid: "uid-progress" },
        status: { phase: "Running", progress: "3/5" }
      });

    const result = await createArgoWorkflowsExecutorPlugin().status(ctx, {
      externalId: "progress-wf::uid-progress"
    });
    expect(result.progress).toBeCloseTo(0.6);
  });

  it("falls back to a phase-based progress estimate when status.progress is absent/unparsable", async () => {
    const ctx = testCtx({ serverUrl: SERVER_URL, namespace: NAMESPACE, token: "test-token" });
    nock(SERVER_URL)
      .get(`/api/v1/workflows/${NAMESPACE}/noprogress-wf`)
      .reply(200, {
        metadata: { name: "noprogress-wf", uid: "uid-noprogress" },
        status: { phase: "Running" }
      });

    const result = await createArgoWorkflowsExecutorPlugin().status(ctx, {
      externalId: "noprogress-wf::uid-noprogress"
    });
    expect(result.progress).toBe(0.5);
  });
});

describe("abort()", () => {
  it("terminates ONLY when there is an in-flight workflow (GET check first), then {aborted: true}, and status() thereafter reports 'aborted' not 'failed'", async () => {
    const ctx = testCtx({ serverUrl: SERVER_URL, namespace: NAMESPACE, token: "test-token" });
    nock(SERVER_URL)
      .get(`/api/v1/workflows/${NAMESPACE}/running-wf`)
      .reply(200, { metadata: { name: "running-wf", uid: "uid-running" }, status: { phase: "Running" } });
    const terminateScope = nock(SERVER_URL)
      .put(`/api/v1/workflows/${NAMESPACE}/running-wf/terminate`)
      .reply(200, {});

    const plugin = createArgoWorkflowsExecutorPlugin();
    const result = await plugin.abort(ctx, { externalId: "running-wf::uid-running" });

    expect(terminateScope.isDone()).toBe(true);
    expect(result.aborted).toBe(true);

    // The real API settles a terminated workflow into Failed/Error with no distinct phase
    // (assumption #4) — this plugin's own local abort-tracking is what makes status() report
    // 'aborted' rather than 'failed' for a run THIS instance terminated.
    nock(SERVER_URL)
      .get(`/api/v1/workflows/${NAMESPACE}/running-wf`)
      .reply(200, {
        metadata: { name: "running-wf", uid: "uid-running" },
        status: { phase: "Failed", message: "terminated" }
      });
    const status = await plugin.status(ctx, { externalId: "running-wf::uid-running" });
    expect(status.phase).toBe("aborted");
  });

  it("does NOT terminate a workflow that has already settled — avoids acting on a stale ref", async () => {
    const ctx = testCtx({ serverUrl: SERVER_URL, namespace: NAMESPACE, token: "test-token" });
    nock(SERVER_URL)
      .get(`/api/v1/workflows/${NAMESPACE}/done-wf`)
      .reply(200, { metadata: { name: "done-wf", uid: "uid-done" }, status: { phase: "Succeeded" } });
    const terminateScope = nock(SERVER_URL)
      .put(`/api/v1/workflows/${NAMESPACE}/done-wf/terminate`)
      .reply(200, {});

    const result = await createArgoWorkflowsExecutorPlugin().abort(ctx, {
      externalId: "done-wf::uid-done"
    });

    expect(terminateScope.isDone()).toBe(false);
    expect(result.aborted).toBe(false);
  });

  it("a 404 GET maps to {aborted: false} rather than throwing", async () => {
    const ctx = testCtx({ serverUrl: SERVER_URL, namespace: NAMESPACE, token: "test-token" });
    nock(SERVER_URL).get(`/api/v1/workflows/${NAMESPACE}/gone-wf`).reply(404, {});

    const result = await createArgoWorkflowsExecutorPlugin().abort(ctx, {
      externalId: "gone-wf::uid-gone"
    });
    expect(result.aborted).toBe(false);
  });

  it("a terminate call that returns a non-2xx (after confirming an in-flight workflow) maps to {aborted: false}", async () => {
    const ctx = testCtx({ serverUrl: SERVER_URL, namespace: NAMESPACE, token: "test-token" });
    nock(SERVER_URL)
      .get(`/api/v1/workflows/${NAMESPACE}/fail-abort-wf`)
      .reply(200, {
        metadata: { name: "fail-abort-wf", uid: "uid-fail-abort" },
        status: { phase: "Running" }
      });
    nock(SERVER_URL)
      .put(`/api/v1/workflows/${NAMESPACE}/fail-abort-wf/terminate`)
      .reply(500, {});

    const result = await createArgoWorkflowsExecutorPlugin().abort(ctx, {
      externalId: "fail-abort-wf::uid-fail-abort"
    });
    expect(result.aborted).toBe(false);
  });
});

describe("observe()", () => {
  it("only returns events for workflows whose occurredAt (finishedAt ?? startedAt ?? creationTimestamp) is STRICTLY AFTER the supplied since cursor", async () => {
    const ctx = testCtx({ serverUrl: SERVER_URL, namespace: NAMESPACE, token: "test-token" });
    const sinceIso = "2026-01-01T00:00:00.000Z";
    nock(SERVER_URL)
      .get(`/api/v1/workflows/${NAMESPACE}`)
      .reply(200, {
        items: [
          {
            metadata: { name: "wf-before", uid: "uid-before" },
            status: { startedAt: "2025-12-31T23:59:00.000Z" }
          },
          {
            metadata: { name: "wf-after", uid: "uid-after" },
            status: { startedAt: "2026-01-01T00:05:00.000Z" }
          },
          { metadata: { name: "wf-no-timestamp", uid: "uid-none" }, status: {} }
        ]
      });

    const events = await createArgoWorkflowsExecutorPlugin().observe(ctx, { token: sinceIso });

    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe("workflow_run");
    expect(events[0]?.correlation.correlationKey).toBe("wf-after");
  });

  it("carries the WORKFLOW UID + PHASE as stateRef, so two observations of an unchanged workflow are identity-equal downstream (the dedup property @scp/plugin-argocd's syncStateRef documents)", async () => {
    const ctx = testCtx({ serverUrl: SERVER_URL, namespace: NAMESPACE, token: "test-token" });
    const unchangedItems = {
      items: [
        {
          metadata: { name: "wf-stable", uid: "uid-stable" },
          status: { phase: "Running", startedAt: "2026-01-01T00:00:00.000Z" }
        }
      ]
    };
    nock(SERVER_URL).get(`/api/v1/workflows/${NAMESPACE}`).reply(200, unchangedItems);
    nock(SERVER_URL).get(`/api/v1/workflows/${NAMESPACE}`).reply(200, unchangedItems);

    const plugin = createArgoWorkflowsExecutorPlugin();
    // Two independent polls (e.g. the engine re-lists without having advanced its cursor) of the
    // SAME unchanged workflow — the events' correlation identity must match exactly, which is what
    // lets a downstream identity-keyed store (correlationKey + stateRef) collapse them to one row
    // instead of minting a new one every poll.
    const firstPoll = await plugin.observe(ctx);
    const secondPoll = await plugin.observe(ctx);

    expect(firstPoll[0]?.correlation.stateRef).toBe("uid-stable::Running");
    expect(secondPoll[0]?.correlation.stateRef).toBe(firstPoll[0]?.correlation.stateRef);
    expect(secondPoll[0]?.correlation.correlationKey).toBe(firstPoll[0]?.correlation.correlationKey);
  });

  it("a phase transition (Running -> Succeeded, finishedAt now set) produces a DIFFERENT stateRef and a NEW occurredAt — a genuine transition is not swallowed", async () => {
    const ctx = testCtx({ serverUrl: SERVER_URL, namespace: NAMESPACE, token: "test-token" });
    nock(SERVER_URL)
      .get(`/api/v1/workflows/${NAMESPACE}`)
      .reply(200, {
        items: [
          {
            metadata: { name: "wf-transition", uid: "uid-transition" },
            status: { phase: "Running", startedAt: "2026-01-01T00:00:00.000Z" }
          }
        ]
      });
    const firstPoll = await createArgoWorkflowsExecutorPlugin().observe(ctx, {
      token: "2025-12-31T00:00:00.000Z"
    });
    expect(firstPoll[0]?.correlation.stateRef).toBe("uid-transition::Running");

    nock(SERVER_URL)
      .get(`/api/v1/workflows/${NAMESPACE}`)
      .reply(200, {
        items: [
          {
            metadata: { name: "wf-transition", uid: "uid-transition" },
            status: {
              phase: "Succeeded",
              startedAt: "2026-01-01T00:00:00.000Z",
              finishedAt: "2026-01-01T00:10:00.000Z"
            }
          }
        ]
      });
    // The engine has advanced its cursor to the first event's occurredAt (startedAt).
    const secondPoll = await createArgoWorkflowsExecutorPlugin().observe(ctx, {
      token: firstPoll[0]!.occurredAt
    });

    expect(secondPoll).toHaveLength(1);
    expect(secondPoll[0]?.correlation.stateRef).toBe("uid-transition::Succeeded");
    expect(secondPoll[0]?.correlation.stateRef).not.toBe(firstPoll[0]?.correlation.stateRef);
  });

  it("reads commitSha from the 'commanderscp.io/commit-sha' label when present, never fabricates one", async () => {
    const ctx = testCtx({ serverUrl: SERVER_URL, namespace: NAMESPACE, token: "test-token" });
    nock(SERVER_URL)
      .get(`/api/v1/workflows/${NAMESPACE}`)
      .reply(200, {
        items: [
          {
            metadata: {
              name: "wf-with-sha",
              uid: "uid-with-sha",
              labels: { "commanderscp.io/commit-sha": "deadbeef", team: "platform" }
            },
            status: { startedAt: "2026-01-01T00:00:00.000Z" }
          },
          {
            metadata: { name: "wf-no-sha", uid: "uid-no-sha" },
            status: { startedAt: "2026-01-01T00:00:00.000Z" }
          }
        ]
      });

    const events = await createArgoWorkflowsExecutorPlugin().observe(ctx);

    const withSha = events.find((e) => e.correlation.correlationKey === "wf-with-sha");
    const withoutSha = events.find((e) => e.correlation.correlationKey === "wf-no-sha");
    expect(withSha?.correlation.commitSha).toBe("deadbeef");
    expect(withSha?.correlation.labels).toEqual({
      "commanderscp.io/commit-sha": "deadbeef",
      team: "platform"
    });
    expect(withoutSha?.correlation.commitSha).toBeUndefined();
  });

  it("with no since cursor, returns events for every workflow that has a resolvable occurredAt", async () => {
    const ctx = testCtx({ serverUrl: SERVER_URL, namespace: NAMESPACE, token: "test-token" });
    nock(SERVER_URL)
      .get(`/api/v1/workflows/${NAMESPACE}`)
      .reply(200, {
        items: [
          {
            metadata: { name: "wf-a", uid: "uid-a" },
            status: { startedAt: "2020-01-01T00:00:00.000Z" }
          },
          {
            metadata: { name: "wf-b", uid: "uid-b" },
            status: { startedAt: "2021-01-01T00:00:00.000Z" }
          }
        ]
      });

    const events = await createArgoWorkflowsExecutorPlugin().observe(ctx);
    expect(events.map((e) => e.correlation.correlationKey)).toEqual(["wf-a", "wf-b"]);
  });

  it("passes listOptions.labelSelector through when config.labelSelector is set", async () => {
    const ctx = testCtx({
      serverUrl: SERVER_URL,
      namespace: NAMESPACE,
      token: "test-token",
      labelSelector: "team=platform"
    });
    const scope = nock(SERVER_URL)
      .get(`/api/v1/workflows/${NAMESPACE}`)
      .query({ "listOptions.labelSelector": "team=platform" })
      .reply(200, { items: [] });

    await createArgoWorkflowsExecutorPlugin().observe(ctx);
    expect(scope.isDone()).toBe(true);
  });

  it("a non-2xx list response throws", async () => {
    const ctx = testCtx({ serverUrl: SERVER_URL, namespace: NAMESPACE, token: "test-token" });
    nock(SERVER_URL).get(`/api/v1/workflows/${NAMESPACE}`).reply(500, {});

    await expect(createArgoWorkflowsExecutorPlugin().observe(ctx)).rejects.toThrow(/HTTP 500/);
  });
});

describe("auth", () => {
  it("every request carries 'authorization: Bearer <token>' when config.token is set", async () => {
    const ctx = testCtx({ serverUrl: SERVER_URL, namespace: NAMESPACE, token: "explicit-token" });
    const scope = nock(SERVER_URL, {
      reqheaders: { authorization: "Bearer explicit-token" }
    })
      .get(`/api/v1/workflows/${NAMESPACE}`)
      .reply(200, { items: [] });

    await createArgoWorkflowsExecutorPlugin().observe(ctx);
    expect(scope.isDone()).toBe(true);
  });

  it("config.tokenSecretKey resolves via ctx.secrets.get() and is used as the bearer token when config.token is unset", async () => {
    const ctx = testCtx(
      { serverUrl: SERVER_URL, namespace: NAMESPACE, tokenSecretKey: "argo-token" },
      { get: async (key) => (key === "argo-token" ? "resolved-secret" : undefined) }
    );
    const scope = nock(SERVER_URL, {
      reqheaders: { authorization: "Bearer resolved-secret" }
    })
      .get(`/api/v1/workflows/${NAMESPACE}`)
      .reply(200, { items: [] });

    await createArgoWorkflowsExecutorPlugin().observe(ctx);
    expect(scope.isDone()).toBe(true);
  });

  it("no authorization header is sent when neither config.token nor config.tokenSecretKey is set", async () => {
    const ctx = testCtx({ serverUrl: SERVER_URL, namespace: NAMESPACE });
    const scope = nock(SERVER_URL, {
      badheaders: ["authorization"]
    })
      .get(`/api/v1/workflows/${NAMESPACE}`)
      .reply(200, { items: [] });

    await createArgoWorkflowsExecutorPlugin().observe(ctx);
    expect(scope.isDone()).toBe(true);
  });
});

describe("config validation", () => {
  it("throws when config.serverUrl is missing", async () => {
    const ctx = testCtx({ namespace: NAMESPACE });
    await expect(
      createArgoWorkflowsExecutorPlugin().observe(ctx)
    ).rejects.toThrow(/serverUrl/);
  });

  it("throws when config.namespace is missing", async () => {
    const ctx = testCtx({ serverUrl: SERVER_URL });
    await expect(
      createArgoWorkflowsExecutorPlugin().observe(ctx)
    ).rejects.toThrow(/namespace/);
  });
});
