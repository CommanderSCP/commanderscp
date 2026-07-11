/**
 * `@scp/plugin-argocd` behavioral test suite — nock-fixtures every HTTP call so these tests are
 * deterministic and never touch the real network (CLAUDE.md: "Tests never touch the internet").
 *
 * Every `PluginContext` here is built with a REAL `ScopedHttpClient` (`./test-node-http-client.ts`
 * — node:http/https, not `fetch`; see that file's doc comment for why `fetch` doesn't work
 * against `nock@13.5.x`, the version pinned in this package's package.json). That means these
 * tests exercise `index.ts`'s actual `apiRequest()` wire path — method, URL, JSON body,
 * `Authorization` header, JSON response parsing — not just its in-process return values.
 *
 * `nock.disableNetConnect()` is on for the whole file (see `beforeAll` below) so a request this
 * suite forgot to fixture fails loudly (a clear "Nock: Disallowed net connect" rejection) instead
 * of hanging on a real DNS lookup. Every test that cares whether the plugin called the network
 * (or called it only once) asserts `scope.isDone()` explicitly, per this PR's constraint that a
 * test must not pass by accident from a stale/unused interceptor.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import nock from "nock";
import type { PluginContext, SecretsAccessor, TriggerIntent } from "@scp/plugin-api";
import { createArgoCdExecutorPlugin } from "./index.js";
import { createNodeHttpTestClient } from "./test-node-http-client.js";

const SERVER_URL = "http://argocd.test";

function testCtx(config: unknown, secrets?: SecretsAccessor): PluginContext {
  return {
    orgId: "org-1",
    domainId: "domain-1",
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

describe("trigger()", () => {
  it("kind 'sync' with no targetRevision POSTs an empty-object body and returns an ExternalRunRef minted as '{appName}::{uuid}'", async () => {
    const ctx = testCtx({ serverUrl: SERVER_URL, token: "test-token" });
    const scope = nock(SERVER_URL).post("/api/v1/applications/sync-app/sync", {}).reply(200, {});

    const ref = await createArgoCdExecutorPlugin().trigger(ctx, {
      kind: "sync",
      targetRef: "sync-app"
    });

    expect(scope.isDone()).toBe(true);
    expect(ref.externalId.startsWith("sync-app::")).toBe(true);
    expect(ref.url).toBe(`${SERVER_URL}/applications/sync-app`);
  });

  it("kind 'sync' with parameters.targetRevision includes {revision} in the POST body", async () => {
    const ctx = testCtx({ serverUrl: SERVER_URL, token: "test-token" });
    const scope = nock(SERVER_URL)
      .post("/api/v1/applications/sync-app-rev/sync", { revision: "abc123" })
      .reply(200, {});

    const ref = await createArgoCdExecutorPlugin().trigger(ctx, {
      kind: "sync",
      targetRef: "sync-app-rev",
      parameters: { targetRevision: "abc123" }
    });

    expect(scope.isDone()).toBe(true);
    expect(ref.externalId.startsWith("sync-app-rev::")).toBe(true);
  });

  it("kind 'rollback' with a string priorStateRef includes it as {revision} in the POST body", async () => {
    const ctx = testCtx({ serverUrl: SERVER_URL, token: "test-token" });
    const scope = nock(SERVER_URL)
      .post("/api/v1/applications/rollback-app/sync", { revision: "v7" })
      .reply(200, {});

    const ref = await createArgoCdExecutorPlugin().trigger(ctx, {
      kind: "rollback",
      targetRef: "rollback-app",
      priorStateRef: "v7"
    });

    expect(scope.isDone()).toBe(true);
    expect(ref.externalId.startsWith("rollback-app::")).toBe(true);
  });

  // CRITICAL #2 (adversarial review): a rollback with no VALID prior revision must FAIL CLOSED,
  // never send an empty-revision sync (which ArgoCD interprets as "re-sync the current revision" —
  // silently re-applying the very deploy we're trying to roll back FROM, reported as success).
  for (const priorStateRef of [{ not: "a string" }, undefined, ""] as const) {
    it(`kind 'rollback' with priorStateRef=${JSON.stringify(priorStateRef)} FAILS CLOSED — no sync call, terminal 'failed' status`, async () => {
      const ctx = testCtx({ serverUrl: SERVER_URL, token: "test-token" });
      // A sync interceptor is registered but MUST NOT be hit — nock.disableNetConnect() (beforeAll)
      // means a real (buggy) sync attempt would fail loudly, and we assert `scope.isDone()` is
      // false to prove the endpoint was never called.
      const scope = nock(SERVER_URL)
        .post(/\/sync$/)
        .reply(200, {});

      const plugin = createArgoCdExecutorPlugin();
      const ref = await plugin.trigger(ctx, {
        kind: "rollback",
        targetRef: "rollback-noprior",
        priorStateRef
      });
      expect(scope.isDone()).toBe(false); // the sync endpoint was NEVER called
      expect(ref.externalId.startsWith("argocd-rollback-unavailable::")).toBe(true);

      const status = await plugin.status(ctx, ref);
      expect(status.phase).toBe("failed");
      expect(status.detail).toContain("rollback unavailable");
      nock.cleanAll();
    });
  }

  describe("idempotency dedup — in-memory mode (no statePath)", () => {
    it("two trigger() calls with the SAME idempotencyKey hit the sync endpoint only once and return the same ExternalRunRef", async () => {
      // No .persist()/.times() on this interceptor: a SECOND POST here would find no matching
      // interceptor and, with disableNetConnect() on, reject loudly — the real assertion that the
      // dedup cache actually prevented a second real sync.
      const scope = nock(SERVER_URL)
        .post("/api/v1/applications/idem-inmemory-app/sync", {})
        .reply(200, {});
      const ctx = testCtx({ serverUrl: SERVER_URL, token: "test-token" });
      const plugin = createArgoCdExecutorPlugin();
      const intent: TriggerIntent = {
        kind: "sync",
        targetRef: "idem-inmemory-app",
        idempotencyKey: "key-1"
      };

      const first = await plugin.trigger(ctx, intent);
      const second = await plugin.trigger(ctx, intent); // simulates the engine retrying after a crash between trigger() and its own result-commit

      expect(scope.isDone()).toBe(true);
      expect(second.externalId).toBe(first.externalId);
    });

    it("a DIFFERENT idempotencyKey for the same target mints a new run (hits the sync endpoint again, does NOT dedupe)", async () => {
      const scope = nock(SERVER_URL)
        .post("/api/v1/applications/idem-inmemory-app-2/sync", {})
        .times(2)
        .reply(200, {});
      const ctx = testCtx({ serverUrl: SERVER_URL, token: "test-token" });
      const plugin = createArgoCdExecutorPlugin();

      const first = await plugin.trigger(ctx, {
        kind: "sync",
        targetRef: "idem-inmemory-app-2",
        idempotencyKey: "key-a"
      });
      const second = await plugin.trigger(ctx, {
        kind: "sync",
        targetRef: "idem-inmemory-app-2",
        idempotencyKey: "key-b"
      });

      expect(scope.isDone()).toBe(true);
      expect(second.externalId).not.toBe(first.externalId);
    });
  });

  describe("idempotency dedup — file-backed mode (statePath set) — restart recovery", () => {
    let dir: string;
    let statePath: string;

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), "scp-argocd-test-"));
      statePath = join(dir, "state.json");
    });

    afterEach(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    it("two trigger() calls with the SAME idempotencyKey against the same statePath hit the sync endpoint only once, even read back by a fresh ctx (the restart-recovery property)", async () => {
      // NOTE: unlike @scp/plugin-fake-executor's `FakeExecutorPlugin` class, this plugin exports a
      // stateless singleton object (`createArgoCdExecutorPlugin()` always returns the same
      // `argoCdExecutorPlugin` — see index.ts), so there is no separate "instance" to construct.
      // The property under test is the same one fake-executor's restart-recovery test proves —
      // that the dedup mapping lives in the state FILE, not in any in-process object — so a fresh
      // `PluginContext` (standing in for a respawned subprocess getting a fresh ctx from the host)
      // sharing the same `statePath` must still see the first call's write. Because `loadState()`
      // always re-reads the file from disk on every call regardless of object identity, reusing
      // the singleton here is actually a slightly stronger proof than a fresh object would be: it
      // shows the plugin holds no hidden in-process cache that a "new instance" might have simply
      // not populated yet.
      const scope = nock(SERVER_URL)
        .post("/api/v1/applications/idem-filebacked-app/sync", {})
        .reply(200, {});
      const plugin = createArgoCdExecutorPlugin();
      const intent: TriggerIntent = {
        kind: "sync",
        targetRef: "idem-filebacked-app",
        idempotencyKey: "fb-key-1"
      };

      const ctxA = testCtx({ serverUrl: SERVER_URL, token: "test-token", statePath });
      const first = await plugin.trigger(ctxA, intent);

      const ctxB = testCtx({ serverUrl: SERVER_URL, token: "test-token", statePath });
      const second = await plugin.trigger(ctxB, intent);

      expect(scope.isDone()).toBe(true);
      expect(second.externalId).toBe(first.externalId);
    });

    it("file-backed state written by one ctx is visible to a second ctx that never triggered anything itself (status() after a simulated restart)", async () => {
      const scope = nock(SERVER_URL)
        .post("/api/v1/applications/idem-filebacked-app-2/sync", {})
        .reply(200, {});
      const plugin = createArgoCdExecutorPlugin();
      const ctxA = testCtx({ serverUrl: SERVER_URL, token: "test-token", statePath });
      const ref = await plugin.trigger(ctxA, {
        kind: "sync",
        targetRef: "idem-filebacked-app-2",
        idempotencyKey: "fb-key-2"
      });
      expect(scope.isDone()).toBe(true);

      const statusScope = nock(SERVER_URL)
        .get("/api/v1/applications/idem-filebacked-app-2")
        .reply(200, {
          metadata: { name: "idem-filebacked-app-2" },
          status: { sync: { status: "Synced" }, health: { status: "Healthy" } }
        });
      const ctxB = testCtx({ serverUrl: SERVER_URL, token: "test-token", statePath });
      const status = await plugin.status(ctxB, ref);

      expect(statusScope.isDone()).toBe(true);
      expect(status.phase).toBe("succeeded");
    });
  });
});

describe("status()", () => {
  it("operationState.phase 'Running' maps to phase 'running'", async () => {
    const ctx = testCtx({ serverUrl: SERVER_URL, token: "test-token" });
    const scope = nock(SERVER_URL)
      .get("/api/v1/applications/status-running")
      .reply(200, {
        metadata: { name: "status-running" },
        status: {
          operationState: { phase: "Running" },
          sync: { status: "OutOfSync" },
          health: { status: "Progressing" }
        }
      });

    const result = await createArgoCdExecutorPlugin().status(ctx, {
      externalId: "status-running::run-1"
    });

    expect(scope.isDone()).toBe(true);
    expect(result.phase).toBe("running");
  });

  it("operationState.phase 'Succeeded' + health.status 'Healthy' maps to phase 'succeeded'", async () => {
    const ctx = testCtx({ serverUrl: SERVER_URL, token: "test-token" });
    nock(SERVER_URL)
      .get("/api/v1/applications/status-succeeded")
      .reply(200, {
        metadata: { name: "status-succeeded" },
        status: {
          operationState: { phase: "Succeeded" },
          sync: { status: "Synced" },
          health: { status: "Healthy" }
        }
      });

    const result = await createArgoCdExecutorPlugin().status(ctx, {
      externalId: "status-succeeded::run-1"
    });

    expect(result.phase).toBe("succeeded");
  });

  it("operationState.phase 'Succeeded' + health.status 'Progressing' maps to phase 'running' — a sync can finish before workloads finish rolling out (index.ts's own documented logic)", async () => {
    const ctx = testCtx({ serverUrl: SERVER_URL, token: "test-token" });
    nock(SERVER_URL)
      .get("/api/v1/applications/status-succeeded-progressing")
      .reply(200, {
        metadata: { name: "status-succeeded-progressing" },
        status: {
          operationState: { phase: "Succeeded" },
          sync: { status: "Synced" },
          health: { status: "Progressing" }
        }
      });

    const result = await createArgoCdExecutorPlugin().status(ctx, {
      externalId: "status-succeeded-progressing::run-1"
    });

    expect(result.phase).toBe("running");
  });

  // MAJOR #3 (adversarial review): a sync that FINISHED (operationState 'Succeeded') but left the
  // app Degraded/Missing must map to TERMINAL 'failed', not perpetual 'running' — ArgoCD never
  // clears operationState, so the old code polled a dead deployment forever.
  for (const health of ["Degraded", "Missing"] as const) {
    it(`operationState.phase 'Succeeded' + health.status '${health}' maps to TERMINAL 'failed' (not perpetual 'running')`, async () => {
      const ctx = testCtx({ serverUrl: SERVER_URL, token: "test-token" });
      nock(SERVER_URL)
        .get(`/api/v1/applications/status-succeeded-${health.toLowerCase()}`)
        .reply(200, {
          metadata: { name: `status-succeeded-${health.toLowerCase()}` },
          status: {
            operationState: { phase: "Succeeded" },
            sync: { status: "Synced" },
            health: { status: health }
          }
        });

      const result = await createArgoCdExecutorPlugin().status(ctx, {
        externalId: `status-succeeded-${health.toLowerCase()}::run-1`
      });

      expect(result.phase).toBe("failed");
      expect(result.progress).toBe(1); // terminal, not 0.5 (still-in-flight)
    });
  }

  it("operationState.phase 'Failed' maps to phase 'failed'", async () => {
    const ctx = testCtx({ serverUrl: SERVER_URL, token: "test-token" });
    nock(SERVER_URL)
      .get("/api/v1/applications/status-failed")
      .reply(200, {
        metadata: { name: "status-failed" },
        status: { operationState: { phase: "Failed" } }
      });

    const result = await createArgoCdExecutorPlugin().status(ctx, {
      externalId: "status-failed::run-1"
    });

    expect(result.phase).toBe("failed");
  });

  it("operationState.phase 'Error' maps to phase 'failed'", async () => {
    const ctx = testCtx({ serverUrl: SERVER_URL, token: "test-token" });
    nock(SERVER_URL)
      .get("/api/v1/applications/status-error")
      .reply(200, {
        metadata: { name: "status-error" },
        status: { operationState: { phase: "Error" } }
      });

    const result = await createArgoCdExecutorPlugin().status(ctx, {
      externalId: "status-error::run-1"
    });

    expect(result.phase).toBe("failed");
  });

  it("no operationState + sync.status 'Synced' + health.status 'Healthy' maps to phase 'succeeded' (no operation has ever run, or ArgoCD already forgot it)", async () => {
    const ctx = testCtx({ serverUrl: SERVER_URL, token: "test-token" });
    nock(SERVER_URL)
      .get("/api/v1/applications/status-no-op-synced")
      .reply(200, {
        metadata: { name: "status-no-op-synced" },
        status: { sync: { status: "Synced" }, health: { status: "Healthy" } }
      });

    const result = await createArgoCdExecutorPlugin().status(ctx, {
      externalId: "status-no-op-synced::run-1"
    });

    expect(result.phase).toBe("succeeded");
  });

  it("no operationState + health.status 'Degraded' maps to phase 'failed'", async () => {
    const ctx = testCtx({ serverUrl: SERVER_URL, token: "test-token" });
    nock(SERVER_URL)
      .get("/api/v1/applications/status-no-op-degraded")
      .reply(200, {
        metadata: { name: "status-no-op-degraded" },
        status: { health: { status: "Degraded" } }
      });

    const result = await createArgoCdExecutorPlugin().status(ctx, {
      externalId: "status-no-op-degraded::run-1"
    });

    expect(result.phase).toBe("failed");
  });

  it("a 404 response maps to phase 'pending' rather than throwing (application not yet visible to ArgoCD)", async () => {
    const ctx = testCtx({ serverUrl: SERVER_URL, token: "test-token" });
    const scope = nock(SERVER_URL)
      .get("/api/v1/applications/status-missing")
      .reply(404, { error: "not found" });

    const result = await createArgoCdExecutorPlugin().status(ctx, {
      externalId: "status-missing::run-1"
    });

    expect(scope.isDone()).toBe(true);
    expect(result.phase).toBe("pending");
  });

  it("a non-2xx, non-404 response (e.g. 500) throws rather than being silently swallowed", async () => {
    const ctx = testCtx({ serverUrl: SERVER_URL, token: "test-token" });
    nock(SERVER_URL)
      .get("/api/v1/applications/status-server-error")
      .reply(500, { error: "internal" });

    await expect(
      createArgoCdExecutorPlugin().status(ctx, { externalId: "status-server-error::run-1" })
    ).rejects.toThrow(/HTTP 500/);
  });
});

describe("abort()", () => {
  it("terminates ONLY when there is an in-flight operation (GET check first — MINOR), then {aborted: true}", async () => {
    const ctx = testCtx({ serverUrl: SERVER_URL, token: "test-token" });
    const getScope = nock(SERVER_URL)
      .get("/api/v1/applications/abort-app")
      .reply(200, {
        metadata: { name: "abort-app" },
        status: { operationState: { phase: "Running" } }
      });
    const delScope = nock(SERVER_URL)
      .delete("/api/v1/applications/abort-app/operation")
      .reply(200, {});

    const result = await createArgoCdExecutorPlugin().abort(ctx, {
      externalId: "abort-app::run-1"
    });

    expect(getScope.isDone()).toBe(true);
    expect(delScope.isDone()).toBe(true);
    expect(result).toEqual({ aborted: true, detail: "argocd: operation terminated" });
  });

  it("does NOT terminate when there is no in-flight operation — avoids killing a newer, unrelated sync (MINOR)", async () => {
    const ctx = testCtx({ serverUrl: SERVER_URL, token: "test-token" });
    const getScope = nock(SERVER_URL)
      .get("/api/v1/applications/abort-idle")
      .reply(200, {
        metadata: { name: "abort-idle" },
        status: { operationState: { phase: "Succeeded" } }
      });
    // NO delete interceptor — the plugin must not issue one (nock.disableNetConnect would fail a
    // stray call loudly).

    const result = await createArgoCdExecutorPlugin().abort(ctx, {
      externalId: "abort-idle::run-1"
    });

    expect(getScope.isDone()).toBe(true);
    expect(result.aborted).toBe(false);
    expect(result.detail).toContain("no in-flight operation");
  });

  it("returns {aborted:false} for a fail-closed rollback ref (nothing to abort, no HTTP call)", async () => {
    const ctx = testCtx({ serverUrl: SERVER_URL, token: "test-token" });
    const result = await createArgoCdExecutorPlugin().abort(ctx, {
      externalId: "argocd-rollback-unavailable::some-app"
    });
    expect(result.aborted).toBe(false);
  });

  it("a DELETE that returns a non-2xx (after confirming an in-flight op) maps to {aborted: false}", async () => {
    const ctx = testCtx({ serverUrl: SERVER_URL, token: "test-token" });
    nock(SERVER_URL)
      .get("/api/v1/applications/abort-app-2")
      .reply(200, {
        metadata: { name: "abort-app-2" },
        status: { operationState: { phase: "Running" } }
      });
    const delScope = nock(SERVER_URL)
      .delete("/api/v1/applications/abort-app-2/operation")
      .reply(409, { error: "conflict" });

    const result = await createArgoCdExecutorPlugin().abort(ctx, {
      externalId: "abort-app-2::run-1"
    });

    expect(delScope.isDone()).toBe(true);
    expect(result.aborted).toBe(false);
    expect(result.detail).toContain("409");
  });
});

describe("observe()", () => {
  it("only returns events for applications reconciled STRICTLY AFTER the supplied since cursor (equal-to-cursor is excluded), with correct correlation fields", async () => {
    const ctx = testCtx({ serverUrl: SERVER_URL, token: "test-token" });
    const sinceIso = "2026-01-01T00:00:00.000Z";
    nock(SERVER_URL)
      .get("/api/v1/applications")
      .reply(200, {
        items: [
          {
            metadata: { name: "app-before" },
            status: { reconciledAt: "2025-12-31T23:59:00.000Z" }
          },
          { metadata: { name: "app-exact-boundary" }, status: { reconciledAt: sinceIso } },
          { metadata: { name: "app-after" }, status: { reconciledAt: "2026-01-01T00:05:00.000Z" } },
          { metadata: { name: "app-no-reconciled" }, status: {} }
        ]
      });

    const events = await createArgoCdExecutorPlugin().observe(ctx, { token: sinceIso });

    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe("sync");
    expect(events[0]?.occurredAt).toBe("2026-01-01T00:05:00.000Z");
    expect(events[0]?.correlation).toEqual({
      correlationKey: "app-after",
      labels: { application: "app-after" }
    });
  });

  it("with no since cursor, returns events for every application that has a reconciledAt", async () => {
    const ctx = testCtx({ serverUrl: SERVER_URL, token: "test-token" });
    nock(SERVER_URL)
      .get("/api/v1/applications")
      .reply(200, {
        items: [
          { metadata: { name: "app-a" }, status: { reconciledAt: "2020-01-01T00:00:00.000Z" } },
          { metadata: { name: "app-b" }, status: { reconciledAt: "2021-01-01T00:00:00.000Z" } }
        ]
      });

    const events = await createArgoCdExecutorPlugin().observe(ctx);

    expect(events.map((e) => e.correlation.correlationKey)).toEqual(["app-a", "app-b"]);
  });

  it("is a single unpaginated GET — ArgoCD's /api/v1/applications list has no Link-header pagination convention in this plugin, so observe() makes exactly one request regardless of list size", async () => {
    // No .persist()/.times(): if observe() ever made a second request, it would find no matching
    // interceptor and (disableNetConnect() being on for this file) reject — the real proof that
    // only one call happened, not just that isDone() is true after the one we expected.
    const ctx = testCtx({ serverUrl: SERVER_URL, token: "test-token" });
    const scope = nock(SERVER_URL).get("/api/v1/applications").reply(200, { items: [] });

    await createArgoCdExecutorPlugin().observe(ctx);

    expect(scope.isDone()).toBe(true);
  });

  it("a non-2xx response (e.g. 429 rate-limited) throws — no retry/backoff exists in this plugin yet", async () => {
    const ctx = testCtx({ serverUrl: SERVER_URL, token: "test-token" });
    nock(SERVER_URL).get("/api/v1/applications").reply(429, { message: "rate limited" });

    // TODO(M7 follow-up): observe()/trigger()/status() in index.ts have no retry-with-backoff for
    // 429/503 — a single non-2xx (including a transient rate-limit) throws immediately, relying
    // entirely on whatever outer retry/backoff the coordination engine itself provides (if any).
    // This test documents that as CURRENT behavior; adding real backoff would be a behavior
    // change out of scope for this test-only PR.
    await expect(createArgoCdExecutorPlugin().observe(ctx)).rejects.toThrow(/HTTP 429/);
  });
});

describe("authorization header", () => {
  it("every request carries 'authorization: Bearer <token>' when config.token is set", async () => {
    const ctx = testCtx({ serverUrl: SERVER_URL, token: "test-token" });
    const scope = nock(SERVER_URL, { reqheaders: { authorization: "Bearer test-token" } })
      .get("/api/v1/applications/auth-app")
      .reply(200, { metadata: { name: "auth-app" }, status: {} });

    await createArgoCdExecutorPlugin().status(ctx, { externalId: "auth-app::run-1" });

    expect(scope.isDone()).toBe(true);
  });

  it("config.tokenSecretKey resolves via ctx.secrets.get() and is used as the bearer token when config.token is unset", async () => {
    let seenKey: string | undefined;
    const secrets: SecretsAccessor = {
      get: async (key) => {
        seenKey = key;
        return "secret-resolved-token";
      }
    };
    const ctx = testCtx({ serverUrl: SERVER_URL, tokenSecretKey: "argocd/prod-token" }, secrets);
    const scope = nock(SERVER_URL, {
      reqheaders: { authorization: "Bearer secret-resolved-token" }
    })
      .get("/api/v1/applications/auth-app-2")
      .reply(200, { metadata: { name: "auth-app-2" }, status: {} });

    await createArgoCdExecutorPlugin().status(ctx, { externalId: "auth-app-2::run-1" });

    expect(scope.isDone()).toBe(true);
    expect(seenKey).toBe("argocd/prod-token");
  });

  it("no authorization header is sent when neither config.token nor config.tokenSecretKey is set", async () => {
    const ctx = testCtx({ serverUrl: SERVER_URL });
    let seenAuthHeader: string | undefined;
    const scope = nock(SERVER_URL)
      .get("/api/v1/applications/auth-app-3")
      .reply(function replyFn() {
        seenAuthHeader = this.req.headers["authorization"] as string | undefined;
        return [200, { metadata: { name: "auth-app-3" }, status: {} }];
      });

    await createArgoCdExecutorPlugin().status(ctx, { externalId: "auth-app-3::run-1" });

    expect(scope.isDone()).toBe(true);
    expect(seenAuthHeader).toBeUndefined();
  });
});
