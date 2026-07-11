/**
 * Behavioral test suite for `@scp/plugin-terraform` (Mode 1, pipeline-mediated — see index.ts's
 * module doc for the full DESIGN.md §12 context). Unlike most plugin unit tests in this repo
 * (webhook-control, fake-executor, federation-https), which stub `ctx.http.request` with a
 * hand-written function, these tests run the plugin against a REAL `node:http`-based
 * `ScopedHttpClient` (test-support/real-http-client.ts) fixtured with `nock` — see that file's
 * module doc for why `node:http` and not the global `fetch()` (short version: nock 13.5.6 cannot
 * intercept undici-backed `fetch`, verified empirically while building this suite). That buys
 * genuine coverage of the plugin's URL templating, header construction, and response-body
 * parsing, not just "did we call ctx.http.request with the object we expected."
 *
 * `@scp/plugin-terraform`'s trigger()-idempotency dedup cache is a MODULE-LEVEL variable (index.ts's
 * `inMemoryState`), not per plugin-instance state like fake-executor's — so every test in this
 * file that doesn't care about dedup uses a UNIQUE (or absent) `idempotencyKey` to avoid
 * cross-test contamination via that shared cache; only the tests that explicitly exercise dedup
 * reuse a key on purpose.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import nock from "nock";
import type { TriggerIntent } from "@scp/plugin-api";
import { createTerraformExecutorPlugin } from "./index.js";
import { realHttpPluginContext } from "./test-support/real-http-client.js";

const BASE_URL = "http://pipeline.test";

beforeAll(() => {
  // Any request that doesn't match a registered nock interceptor throws instead of silently
  // hitting the real network — this is what makes "no HTTP call was attempted" assertions below
  // (status()/abort() with no configured URL, observe()) actually meaningful: if the plugin code
  // regressed into calling out anyway, the test would fail loudly instead of passing by accident.
  nock.disableNetConnect();
});

afterEach(() => {
  nock.cleanAll();
});

afterAll(() => {
  nock.enableNetConnect();
});

describe("trigger()", () => {
  it("POSTs {kind, targetRef, parameters, idempotencyKey} and maps the default runIdField ('id') into ExternalRunRef", async () => {
    let capturedBody: unknown;
    let capturedHeaders: Record<string, string> | undefined;
    nock(BASE_URL)
      .post("/trigger")
      .reply(function (_uri, body) {
        capturedBody = body;
        capturedHeaders = this.req.headers;
        return [200, { id: "run-abc", url: "http://pipeline.test/runs/run-abc" }];
      });

    const plugin = createTerraformExecutorPlugin();
    const ctx = realHttpPluginContext({ triggerUrl: `${BASE_URL}/trigger` });
    const intent: TriggerIntent = {
      kind: "sync",
      targetRef: "svc-a",
      parameters: { workspace: "prod" },
      idempotencyKey: "key-body-shape"
    };
    const ref = await plugin.trigger(ctx, intent);

    expect(capturedBody).toEqual({
      kind: "sync",
      targetRef: "svc-a",
      parameters: { workspace: "prod" },
      priorStateRef: undefined,
      idempotencyKey: "key-body-shape"
    });
    expect(capturedHeaders?.["content-type"]).toBe("application/json");
    expect(ref).toEqual({ externalId: "run-abc", url: "http://pipeline.test/runs/run-abc" });
  });

  it("reads the run id from a custom runIdField when configured", async () => {
    nock(BASE_URL).post("/trigger").reply(200, { runId: "custom-run-1" });

    const plugin = createTerraformExecutorPlugin();
    const ctx = realHttpPluginContext({ triggerUrl: `${BASE_URL}/trigger`, runIdField: "runId" });
    const ref = await plugin.trigger(ctx, { kind: "sync", targetRef: "svc-a" });

    expect(ref.externalId).toBe("custom-run-1");
  });

  it("stringifies a numeric run id from the trigger response", async () => {
    nock(BASE_URL).post("/trigger").reply(200, { id: 42 });

    const plugin = createTerraformExecutorPlugin();
    const ctx = realHttpPluginContext({ triggerUrl: `${BASE_URL}/trigger` });
    const ref = await plugin.trigger(ctx, { kind: "sync", targetRef: "svc-a" });

    expect(ref.externalId).toBe("42");
    expect(typeof ref.externalId).toBe("string");
  });

  it("a rollback intent's POST body includes priorStateRef", async () => {
    let capturedBody: unknown;
    nock(BASE_URL)
      .post("/trigger")
      .reply(function (_uri, body) {
        capturedBody = body;
        return [200, { id: "run-rollback" }];
      });

    const plugin = createTerraformExecutorPlugin();
    const ctx = realHttpPluginContext({ triggerUrl: `${BASE_URL}/trigger` });
    await plugin.trigger(ctx, { kind: "rollback", targetRef: "svc-a", priorStateRef: "v3" });

    expect(capturedBody).toMatchObject({ kind: "rollback", priorStateRef: "v3" });
  });

  it("a NON-rollback intent's POST body has priorStateRef undefined even if the intent itself carries one", async () => {
    let capturedBody: Record<string, unknown> | undefined;
    nock(BASE_URL)
      .post("/trigger")
      .reply(function (_uri, body) {
        capturedBody = body as Record<string, unknown>;
        return [200, { id: "run-sync" }];
      });

    const plugin = createTerraformExecutorPlugin();
    const ctx = realHttpPluginContext({ triggerUrl: `${BASE_URL}/trigger` });
    // priorStateRef set on a "sync" intent is nonsensical input, but index.ts's
    // `intent.kind === "rollback" ? intent.priorStateRef : undefined` must still drop it —
    // proving the gate is on `kind`, not merely "was priorStateRef present."
    await plugin.trigger(ctx, {
      kind: "sync",
      targetRef: "svc-a",
      priorStateRef: "should-be-dropped"
    });

    expect(capturedBody?.priorStateRef).toBeUndefined();
    expect("priorStateRef" in (capturedBody ?? {})).toBe(false);
  });

  it("throws when the trigger endpoint returns a non-2xx status", async () => {
    nock(BASE_URL).post("/trigger").reply(502, { error: "bad gateway" });

    const plugin = createTerraformExecutorPlugin();
    const ctx = realHttpPluginContext({ triggerUrl: `${BASE_URL}/trigger` });
    await expect(plugin.trigger(ctx, { kind: "sync", targetRef: "svc-a" })).rejects.toThrow(
      /HTTP 502/
    );
  });

  describe("idempotency dedup", () => {
    it("in-memory mode: the SAME idempotencyKey triggers the pipeline endpoint exactly once", async () => {
      const scope = nock(BASE_URL).post("/trigger").reply(200, { id: "run-dedupe-mem" });

      const plugin = createTerraformExecutorPlugin();
      const ctx = realHttpPluginContext({ triggerUrl: `${BASE_URL}/trigger` });
      const intent: TriggerIntent = {
        kind: "sync",
        targetRef: "svc-dedupe-mem",
        idempotencyKey: "key-dedupe-in-memory"
      };

      const first = await plugin.trigger(ctx, intent);
      // If trigger() failed to dedupe, this second call would try to POST again; since the
      // interceptor above is single-use (not `.persist()`d) and net connect is disabled, an
      // unwanted second call throws here instead of silently succeeding.
      const second = await plugin.trigger(ctx, intent);

      expect(second).toEqual(first);
      expect(scope.isDone()).toBe(true); // the one registered interceptor WAS consumed...
      expect(nock.pendingMocks()).toEqual([]); // ...and nothing else is left outstanding
    });

    it("a DIFFERENT idempotencyKey mints a new run (does not dedupe against an unrelated key)", async () => {
      nock(BASE_URL)
        .post("/trigger")
        .times(2)
        .reply(200, (_uri, body) => {
          const key = (body as { idempotencyKey?: string }).idempotencyKey;
          return { id: `run-for-${key}` };
        });

      const plugin = createTerraformExecutorPlugin();
      const ctx = realHttpPluginContext({ triggerUrl: `${BASE_URL}/trigger` });
      const first = await plugin.trigger(ctx, {
        kind: "sync",
        targetRef: "svc-distinct-keys",
        idempotencyKey: "key-distinct-a"
      });
      const second = await plugin.trigger(ctx, {
        kind: "sync",
        targetRef: "svc-distinct-keys",
        idempotencyKey: "key-distinct-b"
      });

      expect(first.externalId).not.toBe(second.externalId);
    });

    it("file-backed mode (statePath): the SAME idempotencyKey triggers the pipeline endpoint exactly once, and a freshly-created plugin handle sharing the file sees the dedup entry without hitting the network", async () => {
      const dir = await mkdtemp(join(tmpdir(), "scp-terraform-test-"));
      try {
        const statePath = join(dir, "state.json");
        const scope = nock(BASE_URL).post("/trigger").reply(200, { id: "run-dedupe-file" });

        const instanceA = createTerraformExecutorPlugin();
        const ctxA = realHttpPluginContext({ triggerUrl: `${BASE_URL}/trigger`, statePath });
        const intent: TriggerIntent = {
          kind: "sync",
          targetRef: "svc-dedupe-file",
          idempotencyKey: "key-dedupe-file"
        };
        const first = await instanceA.trigger(ctxA, intent);

        // A second, independently-obtained plugin handle + a second PluginContext object,
        // sharing only `statePath` on disk — the same shape as a respawned subprocess plugin
        // host instance (index.ts's module doc references @scp/plugin-argocd's identical dedup
        // design). trigger() must read the dedup entry from the FILE, not from any in-process
        // cache, and therefore never re-POST.
        const instanceB = createTerraformExecutorPlugin();
        const ctxB = realHttpPluginContext({ triggerUrl: `${BASE_URL}/trigger`, statePath });
        const second = await instanceB.trigger(ctxB, intent);

        expect(second).toEqual(first);
        expect(scope.isDone()).toBe(true);
        expect(nock.pendingMocks()).toEqual([]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });
});

describe("status()", () => {
  it("with NO statusUrl configured, ALWAYS reports pending and makes no HTTP call", async () => {
    // No interceptor registered at all, and net connect is disabled file-wide (see beforeAll) —
    // if status() attempted any network call it would reject instead of resolving, so a
    // successful resolution here IS the proof no call was attempted.
    const plugin = createTerraformExecutorPlugin();
    const ctx = realHttpPluginContext({ triggerUrl: `${BASE_URL}/trigger` }); // statusUrl omitted

    const result = await plugin.status(ctx, { externalId: "run-x" });

    expect(result.phase).toBe("pending");
    expect(nock.pendingMocks()).toEqual([]);
    expect(nock.isDone()).toBe(true);
  });

  it.each([["applied"], ["planned_and_finished"]])(
    "maps default succeededValues entry %j to phase 'succeeded'",
    async (statusValue) => {
      nock(BASE_URL)
        .get(/^\/status\//)
        .reply(200, { status: statusValue });

      const plugin = createTerraformExecutorPlugin();
      const ctx = realHttpPluginContext({
        triggerUrl: `${BASE_URL}/trigger`,
        statusUrl: `${BASE_URL}/status/{externalId}`
      });
      const result = await plugin.status(ctx, { externalId: "run-x" });

      expect(result.phase).toBe("succeeded");
      expect(result.progress).toBe(1);
    }
  );

  it.each([["errored"], ["discarded"], ["canceled"], ["force_canceled"], ["policy_soft_failed"]])(
    "maps default failedValues entry %j to phase 'failed'",
    async (statusValue) => {
      nock(BASE_URL)
        .get(/^\/status\//)
        .reply(200, { status: statusValue });

      const plugin = createTerraformExecutorPlugin();
      const ctx = realHttpPluginContext({
        triggerUrl: `${BASE_URL}/trigger`,
        statusUrl: `${BASE_URL}/status/{externalId}`
      });
      const result = await plugin.status(ctx, { externalId: "run-x" });

      expect(result.phase).toBe("failed");
      expect(result.progress).toBe(1);
    }
  );

  it("an unrecognized status value maps to phase 'running' (neither succeeded nor failed)", async () => {
    nock(BASE_URL)
      .get(/^\/status\//)
      .reply(200, { status: "planning" });

    const plugin = createTerraformExecutorPlugin();
    const ctx = realHttpPluginContext({
      triggerUrl: `${BASE_URL}/trigger`,
      statusUrl: `${BASE_URL}/status/{externalId}`
    });
    const result = await plugin.status(ctx, { externalId: "run-x" });

    expect(result.phase).toBe("running");
    expect(result.progress).toBe(0.5);
  });

  it("mapping is case-insensitive against the configured succeededValues/failedValues", async () => {
    nock(BASE_URL)
      .get(/^\/status\//)
      .reply(200, { status: "APPLIED" });

    const plugin = createTerraformExecutorPlugin();
    const ctx = realHttpPluginContext({
      triggerUrl: `${BASE_URL}/trigger`,
      statusUrl: `${BASE_URL}/status/{externalId}`
    });
    const result = await plugin.status(ctx, { externalId: "run-x" });

    expect(result.phase).toBe("succeeded");
  });

  it("honors a custom statusField/succeededValues/failedValues config override", async () => {
    nock(BASE_URL)
      .get(/^\/status\//)
      .reply(200, { state: "DONE_OK" });

    const plugin = createTerraformExecutorPlugin();
    const ctx = realHttpPluginContext({
      triggerUrl: `${BASE_URL}/trigger`,
      statusUrl: `${BASE_URL}/status/{externalId}`,
      statusField: "state",
      succeededValues: ["done_ok"],
      failedValues: ["done_bad"]
    });
    const result = await plugin.status(ctx, { externalId: "run-x" });

    expect(result.phase).toBe("succeeded");
  });

  it("throws when the status endpoint returns a non-2xx status", async () => {
    nock(BASE_URL)
      .get(/^\/status\//)
      .reply(500, { error: "boom" });

    const plugin = createTerraformExecutorPlugin();
    const ctx = realHttpPluginContext({
      triggerUrl: `${BASE_URL}/trigger`,
      statusUrl: `${BASE_URL}/status/{externalId}`
    });
    await expect(plugin.status(ctx, { externalId: "run-x" })).rejects.toThrow(/HTTP 500/);
  });

  it("URL-templates {externalId} into statusUrl, URL-encoding characters that need it", async () => {
    let capturedPath: string | undefined;
    nock(BASE_URL)
      .get((uri) => {
        capturedPath = uri;
        return true;
      })
      .reply(200, { status: "applied" });

    const plugin = createTerraformExecutorPlugin();
    const ctx = realHttpPluginContext({
      triggerUrl: `${BASE_URL}/trigger`,
      statusUrl: `${BASE_URL}/status/{externalId}`
    });
    await plugin.status(ctx, { externalId: "run a/b?c" });

    expect(capturedPath).toBe(`/status/${encodeURIComponent("run a/b?c")}`);
  });
});

describe("abort()", () => {
  it("with NO abortUrl configured, returns {aborted: false} and makes no HTTP call", async () => {
    const plugin = createTerraformExecutorPlugin();
    const ctx = realHttpPluginContext({ triggerUrl: `${BASE_URL}/trigger` }); // abortUrl omitted

    const result = await plugin.abort(ctx, { externalId: "run-x" });

    expect(result.aborted).toBe(false);
    expect(nock.pendingMocks()).toEqual([]);
    expect(nock.isDone()).toBe(true);
  });

  it("with abortUrl configured and a 2xx response, returns {aborted: true}", async () => {
    nock(BASE_URL)
      .post(/^\/abort\//)
      .reply(200, {});

    const plugin = createTerraformExecutorPlugin();
    const ctx = realHttpPluginContext({
      triggerUrl: `${BASE_URL}/trigger`,
      abortUrl: `${BASE_URL}/abort/{externalId}`
    });
    const result = await plugin.abort(ctx, { externalId: "run-x" });

    expect(result).toEqual({ aborted: true });
  });

  it("with abortUrl configured and a non-2xx response, returns {aborted: false} with the status in the detail", async () => {
    nock(BASE_URL)
      .post(/^\/abort\//)
      .reply(500, { error: "nope" });

    const plugin = createTerraformExecutorPlugin();
    const ctx = realHttpPluginContext({
      triggerUrl: `${BASE_URL}/trigger`,
      abortUrl: `${BASE_URL}/abort/{externalId}`
    });
    const result = await plugin.abort(ctx, { externalId: "run-x" });

    expect(result.aborted).toBe(false);
    expect(result.detail).toContain("500");
  });

  it("URL-templates {externalId} into abortUrl, URL-encoding characters that need it", async () => {
    let capturedPath: string | undefined;
    nock(BASE_URL)
      .post((uri) => {
        capturedPath = uri;
        return true;
      })
      .reply(200, {});

    const plugin = createTerraformExecutorPlugin();
    const ctx = realHttpPluginContext({
      triggerUrl: `${BASE_URL}/trigger`,
      abortUrl: `${BASE_URL}/abort/{externalId}`
    });
    await plugin.abort(ctx, { externalId: "run a/b?c" });

    expect(capturedPath).toBe(`/abort/${encodeURIComponent("run a/b?c")}`);
  });
});

describe("observe()", () => {
  it("always returns [] and makes no HTTP call — Mode 1's observe path is inbound (webhook/CLI report), not polled", async () => {
    const plugin = createTerraformExecutorPlugin();
    const ctx = realHttpPluginContext({ triggerUrl: `${BASE_URL}/trigger` });

    const events = await plugin.observe(ctx);

    expect(events).toEqual([]);
    expect(nock.pendingMocks()).toEqual([]);
    expect(nock.isDone()).toBe(true);
  });
});

describe("auth (tokenSecretKey -> Authorization header)", () => {
  it("sends 'Authorization: Bearer <token>' on trigger() when tokenSecretKey is configured", async () => {
    let capturedHeaders: Record<string, string> | undefined;
    nock(BASE_URL)
      .post("/trigger")
      .reply(function (_uri, _body) {
        capturedHeaders = this.req.headers;
        return [200, { id: "run-auth" }];
      });

    const plugin = createTerraformExecutorPlugin();
    const ctx = realHttpPluginContext(
      { triggerUrl: `${BASE_URL}/trigger`, tokenSecretKey: "tfc-token" },
      async (key) => (key === "tfc-token" ? "secret-token-value" : undefined)
    );
    await plugin.trigger(ctx, { kind: "sync", targetRef: "svc-a" });

    expect(capturedHeaders?.authorization).toBe("Bearer secret-token-value");
  });

  it("sends 'Authorization: Bearer <token>' on status() when tokenSecretKey is configured", async () => {
    let capturedHeaders: Record<string, string> | undefined;
    nock(BASE_URL)
      .get(/^\/status\//)
      .reply(function (_uri, _body) {
        capturedHeaders = this.req.headers;
        return [200, { status: "applied" }];
      });

    const plugin = createTerraformExecutorPlugin();
    const ctx = realHttpPluginContext(
      {
        triggerUrl: `${BASE_URL}/trigger`,
        statusUrl: `${BASE_URL}/status/{externalId}`,
        tokenSecretKey: "tfc-token"
      },
      async () => "secret-token-value"
    );
    await plugin.status(ctx, { externalId: "run-x" });

    expect(capturedHeaders?.authorization).toBe("Bearer secret-token-value");
  });

  it("sends 'Authorization: Bearer <token>' on abort() when tokenSecretKey is configured", async () => {
    let capturedHeaders: Record<string, string> | undefined;
    nock(BASE_URL)
      .post(/^\/abort\//)
      .reply(function (_uri, _body) {
        capturedHeaders = this.req.headers;
        return [200, {}];
      });

    const plugin = createTerraformExecutorPlugin();
    const ctx = realHttpPluginContext(
      {
        triggerUrl: `${BASE_URL}/trigger`,
        abortUrl: `${BASE_URL}/abort/{externalId}`,
        tokenSecretKey: "tfc-token"
      },
      async () => "secret-token-value"
    );
    await plugin.abort(ctx, { externalId: "run-x" });

    expect(capturedHeaders?.authorization).toBe("Bearer secret-token-value");
  });

  it("sends NO Authorization header when tokenSecretKey is not configured", async () => {
    let capturedHeaders: Record<string, string> | undefined;
    nock(BASE_URL)
      .post("/trigger")
      .reply(function (_uri, _body) {
        capturedHeaders = this.req.headers;
        return [200, { id: "run-no-auth" }];
      });

    const plugin = createTerraformExecutorPlugin();
    const ctx = realHttpPluginContext({ triggerUrl: `${BASE_URL}/trigger` }); // no tokenSecretKey
    await plugin.trigger(ctx, { kind: "sync", targetRef: "svc-a" });

    expect(capturedHeaders?.authorization).toBeUndefined();
  });
});
