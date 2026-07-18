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
import { createArgoCdExecutorPlugin, createArgoCdDiscoveryPlugin, githubRepoSlug } from "./index.js";
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

  // ADR-0008 signal 1 (image half): the deployed image refs come near-free off `status.summary.images`
  // — the SAME Application body status() already fetches, no extra API call. status() surfaces them on
  // ExecutionStatus.observed.images (REAL — parsed from the mocked ArgoCD response, not hardcoded),
  // alongside the still-correct stateRef (revision), with no regression.
  it("populates observed.images from status.summary.images (near-free — same Application body), keeping stateRef intact", async () => {
    const ctx = testCtx({ serverUrl: SERVER_URL, token: "test-token" });
    const scope = nock(SERVER_URL)
      .get("/api/v1/applications/status-with-images")
      .reply(200, {
        metadata: { name: "status-with-images" },
        status: {
          operationState: { phase: "Succeeded" },
          sync: { status: "Synced", revision: "abc123" },
          health: { status: "Healthy" },
          summary: { images: ["ghcr.io/x/y:1.2.3", "ghcr.io/x/z@sha256:deadbeef"] }
        }
      });

    const result = await createArgoCdExecutorPlugin().status(ctx, {
      externalId: "status-with-images::run-1"
    });

    expect(scope.isDone()).toBe(true);
    expect(result.phase).toBe("succeeded");
    // The REAL images from the mocked Application body, in order.
    expect(result.observed?.images).toEqual(["ghcr.io/x/y:1.2.3", "ghcr.io/x/z@sha256:deadbeef"]);
    // No regression: the synced revision (stateRef, ADR-0008 decision 1) is still reported.
    expect(result.stateRef).toBe("abc123");
  });

  it("omits observed (undefined) when the Application body carries no summary.images — never fabricates", async () => {
    const ctx = testCtx({ serverUrl: SERVER_URL, token: "test-token" });
    nock(SERVER_URL)
      .get("/api/v1/applications/status-no-images")
      .reply(200, {
        metadata: { name: "status-no-images" },
        status: {
          operationState: { phase: "Succeeded" },
          sync: { status: "Synced", revision: "abc123" },
          health: { status: "Healthy" }
        }
      });

    const result = await createArgoCdExecutorPlugin().status(ctx, {
      externalId: "status-no-images::run-1"
    });

    expect(result.observed).toBeUndefined();
    // stateRef still captured even with no images.
    expect(result.stateRef).toBe("abc123");
  });

  // ADR-0008 P4D (rollout, OBSERVE-ONLY): when the app manages an Argo Rollout, status() surfaces the
  // rollout's phase/step/weight/message on ExecutionStatus.observed.rollout. Near-free phase/message
  // come off the Rollout node in `status.resources[]` (SAME Application body); structured
  // step/weight (+ authoritative phase/message) come from the LIVE Rollout manifest fetched via
  // GET .../resource. EVERY field here is parsed from the mocked ArgoCD responses — never hardcoded.
  it("populates observed.rollout (phase/step/weight/message) from the Rollout node + live manifest — REAL, not fabricated", async () => {
    const ctx = testCtx({ serverUrl: SERVER_URL, token: "test-token" });
    const appScope = nock(SERVER_URL)
      .get("/api/v1/applications/status-with-rollout")
      .reply(200, {
        metadata: { name: "status-with-rollout" },
        status: {
          operationState: { phase: "Succeeded" },
          sync: { status: "Synced", revision: "abc123" },
          health: { status: "Progressing" },
          resources: [
            {
              group: "argoproj.io",
              version: "v1alpha1",
              kind: "Rollout",
              namespace: "prod",
              name: "web-rollout",
              health: { status: "Progressing", message: "more replicas need to be updated" }
            }
          ]
        }
      });
    // The live Rollout manifest — GET .../resource returns a JSON STRING under `manifest`.
    const resourceScope = nock(SERVER_URL)
      .get("/api/v1/applications/status-with-rollout/resource")
      .query({
        resourceName: "web-rollout",
        namespace: "prod",
        group: "argoproj.io",
        version: "v1alpha1",
        kind: "Rollout"
      })
      .reply(200, {
        manifest: JSON.stringify({
          status: {
            phase: "Paused",
            message: "Rollout is paused",
            currentStepIndex: 2,
            canary: { weights: { canary: { weight: 40 } } }
          }
        })
      });

    const result = await createArgoCdExecutorPlugin().status(ctx, {
      externalId: "status-with-rollout::run-1"
    });

    expect(appScope.isDone()).toBe(true);
    expect(resourceScope.isDone()).toBe(true);
    // The manifest's authoritative fields win over the near-free health assessment.
    expect(result.observed?.rollout).toEqual({
      phase: "Paused",
      message: "Rollout is paused",
      step: 2,
      weight: 40
    });
    // No regression: revision still reported.
    expect(result.stateRef).toBe("abc123");
  });

  it("carries near-free rollout phase/message from resources[] even when the live manifest lacks step/weight — omits what Argo does not report", async () => {
    const ctx = testCtx({ serverUrl: SERVER_URL, token: "test-token" });
    const appScope = nock(SERVER_URL)
      .get("/api/v1/applications/status-rollout-nearfree")
      .reply(200, {
        metadata: { name: "status-rollout-nearfree" },
        status: {
          sync: { status: "Synced", revision: "def456" },
          health: { status: "Progressing" },
          resources: [
            {
              group: "argoproj.io",
              version: "v1alpha1",
              kind: "Rollout",
              name: "api-rollout",
              health: { status: "Healthy", message: "available" }
            }
          ]
        }
      });
    // Older Argo Rollouts (< v1.1) expose no canary.weights and, for a settled rollout, no
    // currentStepIndex — the manifest .status carries only a phase. step/weight must be OMITTED.
    const resourceScope = nock(SERVER_URL)
      .get("/api/v1/applications/status-rollout-nearfree/resource")
      .query(true)
      .reply(200, { manifest: JSON.stringify({ status: { phase: "Healthy" } }) });

    const result = await createArgoCdExecutorPlugin().status(ctx, {
      externalId: "status-rollout-nearfree::run-1"
    });

    expect(appScope.isDone()).toBe(true);
    expect(resourceScope.isDone()).toBe(true);
    // phase from the manifest; message survives from the near-free health assessment; NO step/weight.
    expect(result.observed?.rollout).toEqual({ phase: "Healthy", message: "available" });
    expect(result.observed?.rollout?.step).toBeUndefined();
    expect(result.observed?.rollout?.weight).toBeUndefined();
  });

  it("omits observed.rollout entirely when the app manages no Rollout — never fabricates a rollout, makes no /resource call", async () => {
    const ctx = testCtx({ serverUrl: SERVER_URL, token: "test-token" });
    // resources[] carries only non-Rollout kinds → no Rollout node, so NO /resource call is made
    // (nock.disableNetConnect would surface an unexpected call). Rollout must be absent.
    const appScope = nock(SERVER_URL)
      .get("/api/v1/applications/status-no-rollout")
      .reply(200, {
        metadata: { name: "status-no-rollout" },
        status: {
          operationState: { phase: "Succeeded" },
          sync: { status: "Synced", revision: "abc123" },
          health: { status: "Healthy" },
          summary: { images: ["ghcr.io/x/y:1.2.3"] },
          resources: [{ group: "apps", version: "v1", kind: "Deployment", name: "web" }]
        }
      });

    const result = await createArgoCdExecutorPlugin().status(ctx, {
      externalId: "status-no-rollout::run-1"
    });

    expect(appScope.isDone()).toBe(true);
    expect(result.observed?.rollout).toBeUndefined();
    // The image half of observed is unaffected.
    expect(result.observed?.images).toEqual(["ghcr.io/x/y:1.2.3"]);
  });

  it("keeps near-free rollout phase/message when the live manifest fetch fails (non-2xx) — status() never fails over enrichment", async () => {
    const ctx = testCtx({ serverUrl: SERVER_URL, token: "test-token" });
    const appScope = nock(SERVER_URL)
      .get("/api/v1/applications/status-rollout-resource-500")
      .reply(200, {
        metadata: { name: "status-rollout-resource-500" },
        status: {
          sync: { status: "Synced", revision: "abc123" },
          health: { status: "Progressing" },
          resources: [
            {
              group: "argoproj.io",
              version: "v1alpha1",
              kind: "Rollout",
              name: "web-rollout",
              health: { status: "Progressing", message: "rolling" }
            }
          ]
        }
      });
    const resourceScope = nock(SERVER_URL)
      .get("/api/v1/applications/status-rollout-resource-500/resource")
      .query(true)
      .reply(500, "boom");

    const result = await createArgoCdExecutorPlugin().status(ctx, {
      externalId: "status-rollout-resource-500::run-1"
    });

    expect(appScope.isDone()).toBe(true);
    expect(resourceScope.isDone()).toBe(true);
    // Enrichment failed → fall back to the near-free health assessment; still no fabricated step/weight.
    expect(result.observed?.rollout).toEqual({ phase: "Progressing", message: "rolling" });
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

describe("discover() (M12 P3 — import an existing Argo CD)", () => {
  it("enumerates Applications and proposes one component per app, recording the exact Application name", async () => {
    const ctx = testCtx({ serverUrl: SERVER_URL, token: "test-token" });
    const scope = nock(SERVER_URL)
      .get("/api/v1/applications")
      .reply(200, {
        items: [
          { metadata: { name: "web-prod" }, spec: { project: "default", destination: { namespace: "web" } } },
          { metadata: { name: "api-prod" }, spec: { project: "platform" } }
        ]
      });

    const proposal = await createArgoCdDiscoveryPlugin().discover(ctx);
    expect(scope.isDone()).toBe(true);
    expect(proposal.relationships).toEqual([]);
    expect(proposal.objects).toHaveLength(2);

    const web = proposal.objects.find((o) => o.name === "web-prod");
    expect(web?.typeId).toBe("component");
    // The exact app name is recorded so an execution-system binding's externalRef (M12 P1/P2)
    // addresses the right Application.
    expect(web?.properties?.argocdApplication).toBe("web-prod");
    expect(web?.properties?.namespace).toBe("web");
    expect(web?.properties?.argocdProject).toBe("default");
    expect(web?.properties?.discoveredFrom).toBe(`argocd:${SERVER_URL}`);

    const api = proposal.objects.find((o) => o.name === "api-prod");
    expect(api?.properties?.argocdApplication).toBe("api-prod");
    // No destination namespace on this app ⇒ the property is simply omitted.
    expect(api?.properties?.namespace).toBeUndefined();
    // No executionSystemId in config ⇒ no bindings proposed (discovery-only import).
    expect(proposal.bindings).toBeUndefined();
  });

  it("when config carries executionSystemId, ALSO proposes a binding per app so accept coordinates them (M12 P3b)", async () => {
    const ctx = testCtx({ serverUrl: SERVER_URL, token: "test-token", executionSystemId: "sys-123" });
    nock(SERVER_URL)
      .get("/api/v1/applications")
      .reply(200, { items: [{ metadata: { name: "web-prod" } }, { metadata: { name: "api-prod" } }] });

    const proposal = await createArgoCdDiscoveryPlugin().discover(ctx);
    expect(proposal.objects).toHaveLength(2);
    expect(proposal.bindings).toHaveLength(2);
    const web = proposal.bindings?.find((b) => b.objectName === "web-prod");
    expect(web?.executionSystemId).toBe("sys-123");
    // externalRef defaults to the exact app name so the binding coordinates the right Application.
    expect(web?.externalRef).toBe("web-prod");
  });

  it("captures each app's git source and proposes a github source_mapping from it (M12 P5, Q3)", async () => {
    const ctx = testCtx({ serverUrl: SERVER_URL, token: "test-token" });
    nock(SERVER_URL)
      .get("/api/v1/applications")
      .reply(200, {
        items: [
          // single-source
          { metadata: { name: "web-prod" }, spec: { source: { repoURL: "https://github.com/acme/web", path: "deploy" } } },
          // multi-source — the first source declaring a repoURL wins
          { metadata: { name: "api-prod" }, spec: { sources: [{ path: "chart" }, { repoURL: "https://github.com/acme/api" }] } },
          // no git source (e.g. a Helm-repo-only app) — no mapping, no sourceRepo property
          { metadata: { name: "cache" }, spec: { destination: { namespace: "cache" } } }
        ]
      });

    const proposal = await createArgoCdDiscoveryPlugin().discover(ctx);

    // The git repo is recorded on the component (raw URL, metadata) AND drives a github mapping —
    // but the mapping's repoPattern is the `owner/repo` SLUG, the form github events carry, and it
    // carries NO pathPattern (a github push has no per-app path, so a path-set mapping never matches).
    const web = proposal.objects.find((o) => o.name === "web-prod");
    expect(web?.properties?.sourceRepo).toBe("https://github.com/acme/web");
    expect(web?.properties?.sourcePath).toBe("deploy");

    expect(proposal.sourceMappings).toHaveLength(2); // web + api; cache has no source
    const webMap = proposal.sourceMappings?.find((m) => m.objectName === "web-prod");
    expect(webMap).toMatchObject({
      sourceKind: "github",
      repoPattern: "acme/web", // slug, not the full URL
      type: "configuration"
    });
    expect(webMap?.pathPattern).toBeUndefined();
    // Multi-source: the source that actually has a repoURL is used, normalized to a slug.
    expect(proposal.sourceMappings?.find((m) => m.objectName === "api-prod")?.repoPattern).toBe(
      "acme/api"
    );
    // The source-less app proposes no mapping.
    expect(proposal.sourceMappings?.some((m) => m.objectName === "cache")).toBe(false);
    expect(proposal.objects.find((o) => o.name === "cache")?.properties?.sourceRepo).toBeUndefined();
  });

  it("githubRepoSlug normalizes https/ssh/.git URLs and skips non-GitHub hosts (M12 P5)", () => {
    expect(githubRepoSlug("https://github.com/AgentKitProject/agentkit.git")).toBe("AgentKitProject/agentkit");
    expect(githubRepoSlug("git@github.com:AgentKitProject/agentkit-hosting.git")).toBe("AgentKitProject/agentkit-hosting");
    expect(githubRepoSlug("https://github.com/owner/repo")).toBe("owner/repo");
    expect(githubRepoSlug("ssh://git@github.com/owner/repo.git")).toBe("owner/repo");
    expect(githubRepoSlug("https://gitlab.com/owner/repo.git")).toBeUndefined();
  });

  it("returns an empty proposal (never throws) when Argo CD has no Applications", async () => {
    const ctx = testCtx({ serverUrl: SERVER_URL, token: "test-token" });
    nock(SERVER_URL).get("/api/v1/applications").reply(200, { items: [] });
    const proposal = await createArgoCdDiscoveryPlugin().discover(ctx);
    expect(proposal.objects).toEqual([]);
  });

  it("throws on a non-2xx list response (so the discovery run surfaces the failure, not a silent empty import)", async () => {
    const ctx = testCtx({ serverUrl: SERVER_URL, token: "test-token" });
    nock(SERVER_URL).get("/api/v1/applications").reply(403, {});
    await expect(createArgoCdDiscoveryPlugin().discover(ctx)).rejects.toThrow(/HTTP 403/);
  });
});
