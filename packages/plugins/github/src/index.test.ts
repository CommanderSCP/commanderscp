/**
 * `@scp/plugin-github` behavioral test suite (BUILD_AND_TEST.md §8 M7 item 1's Definition of
 * Done). Every HTTP call is fixtured deterministically with `nock` against Node's `http`/`https`
 * core modules — see `github-test-support.ts`'s module doc for why the `ScopedHttpClient` built
 * for these tests uses `node:https` directly rather than `fetch` (nock@13.5.6, the version this
 * repo pins, does not intercept the global fetch/undici client — verified empirically, not
 * asserted from memory). `nock.disableNetConnect()` is active for the whole file so any call this
 * suite didn't anticipate fails loudly (a rejected promise) instead of silently reaching the real
 * network (CLAUDE.md: "Tests never touch the internet").
 *
 * Every test that registers a nock interceptor is checked for full consumption by the file-wide
 * `afterEach` below (`nock.pendingMocks()` must be empty) — an unconsumed interceptor means the
 * plugin either didn't make a call it should have, or (for interceptors deliberately NOT
 * registered, e.g. the pagination test's absent "page 2") an accidental extra call would instead
 * surface as a thrown "no match" error from the rejected HTTP promise, not a silently-passing test.
 */
import { createHmac } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import nock from "nock";
import {
  createGithubDiscoveryPlugin,
  createGithubExecutorPlugin,
  mapGithubWebhookEventToHint,
  postCommitStatus,
  verifyGithubWebhookSignature,
  type GithubConfig
} from "./index.js";
import {
  apiBase,
  buildGithubConfig,
  buildTestCtx,
  installationTokenFor,
  nockInstallationToken
} from "./github-test-support.js";

const plugin = createGithubExecutorPlugin();
const discoveryPlugin = createGithubDiscoveryPlugin();

/** Shared per-test fixture builder — mirrors `fake-executor`'s/`webhook-control`'s file-local
 *  `testCtx()` helper, just extended with the installation-token nock (needed by EVERY test in
 *  this file, since every plugin call goes through `getInstallationToken` first) and a ready-made
 *  `Bearer <token>` string for asserting downstream API calls carry it. Fresh appId/installationId
 *  per call (via `buildGithubConfig`) so the module-level token cache in index.ts never lets one
 *  test's cached token silently skip another test's token-exchange assertion. */
function setup(overrides: Partial<GithubConfig> = {}) {
  const config = buildGithubConfig(overrides);
  const ctx = buildTestCtx(config);
  const tokenScope = nockInstallationToken(config);
  const authHeader = `Bearer ${installationTokenFor(config)}`;
  return { config, ctx, tokenScope, authHeader, base: apiBase(config) };
}

beforeAll(() => {
  nock.disableNetConnect();
});

afterAll(() => {
  nock.enableNetConnect();
});

afterEach(() => {
  const pending = nock.pendingMocks();
  nock.cleanAll();
  expect(pending, `unconsumed nock interceptors after test: ${pending.join(", ")}`).toEqual([]);
});

// -------------------------------------------------------------------------------------------
// verifyGithubWebhookSignature — pure function, no HTTP/nock involved at all.
// -------------------------------------------------------------------------------------------

describe("verifyGithubWebhookSignature", () => {
  const secret = "test-webhook-secret";
  const body = Buffer.from(JSON.stringify({ zen: "Anything added dilutes everything else." }));

  function sign(rawBody: Buffer, withSecret: string): string {
    return `sha256=${createHmac("sha256", withSecret).update(rawBody).digest("hex")}`;
  }

  it("accepts a validly-signed body (real HMAC-SHA256 computed via node:crypto, matching GitHub's X-Hub-Signature-256 scheme)", () => {
    expect(verifyGithubWebhookSignature(body, sign(body, secret), secret)).toBe(true);
  });

  it("rejects a signature computed with the WRONG secret", () => {
    expect(verifyGithubWebhookSignature(body, sign(body, "a-different-secret"), secret)).toBe(
      false
    );
  });

  it("rejects when the signature header is missing entirely", () => {
    expect(verifyGithubWebhookSignature(body, undefined, secret)).toBe(false);
  });

  it("rejects a header missing the required 'sha256=' prefix", () => {
    const bareHex = createHmac("sha256", secret).update(body).digest("hex");
    expect(verifyGithubWebhookSignature(body, bareHex, secret)).toBe(false);
  });

  it("rejects a header with non-hex characters after the prefix, without throwing", () => {
    expect(() =>
      verifyGithubWebhookSignature(body, "sha256=not-valid-hex-zzzz", secret)
    ).not.toThrow();
    expect(verifyGithubWebhookSignature(body, "sha256=not-valid-hex-zzzz", secret)).toBe(false);
  });

  it("rejects a header of the wrong length (truncated digest) — the timingSafeEqual length guard, fail-closed not thrown", () => {
    const truncated = sign(body, secret).slice(0, -4);
    expect(() => verifyGithubWebhookSignature(body, truncated, secret)).not.toThrow();
    expect(verifyGithubWebhookSignature(body, truncated, secret)).toBe(false);
  });

  it("rejects when the BODY was tampered with after signing (signature still matches the ORIGINAL body only)", () => {
    const validSignatureForOriginal = sign(body, secret);
    const tamperedBody = Buffer.from(JSON.stringify({ zen: "TAMPERED" }));
    expect(verifyGithubWebhookSignature(tamperedBody, validSignatureForOriginal, secret)).toBe(
      false
    );
  });
});

// -------------------------------------------------------------------------------------------
// mapGithubWebhookEventToHint — pure function, no HTTP/nock involved.
// -------------------------------------------------------------------------------------------

describe("mapGithubWebhookEventToHint", () => {
  it("maps a push event to repo/commitSha (from head_commit.id)/correlationKey (ref)", () => {
    const hint = mapGithubWebhookEventToHint("push", {
      ref: "refs/heads/main",
      after: "0".repeat(40),
      head_commit: { id: "1".repeat(40) },
      repository: { full_name: "acme/widgets" }
    });
    expect(hint).toEqual({
      repo: "acme/widgets",
      commitSha: "1".repeat(40),
      correlationKey: "refs/heads/main"
    });
  });

  it("push falls back to payload.after when head_commit is absent (e.g. a branch-delete push)", () => {
    const hint = mapGithubWebhookEventToHint("push", {
      ref: "refs/heads/gone",
      after: "0".repeat(40),
      repository: { full_name: "acme/widgets" }
    });
    expect(hint?.commitSha).toBe("0".repeat(40));
  });

  it("maps a pull_request event to repo/commitSha (head.sha)/correlationKey (pr-<number>)", () => {
    const hint = mapGithubWebhookEventToHint("pull_request", {
      pull_request: { number: 42, head: { sha: "2".repeat(40) } },
      repository: { full_name: "acme/widgets" }
    });
    expect(hint).toEqual({
      repo: "acme/widgets",
      commitSha: "2".repeat(40),
      correlationKey: "pr-42"
    });
  });

  it("maps a workflow_run event to repo/commitSha (head_sha)/correlationKey (run-<id>)", () => {
    const hint = mapGithubWebhookEventToHint("workflow_run", {
      workflow_run: { id: 999, head_sha: "3".repeat(40) },
      repository: { full_name: "acme/widgets" }
    });
    expect(hint).toEqual({
      repo: "acme/widgets",
      commitSha: "3".repeat(40),
      correlationKey: "run-999"
    });
  });

  it("maps a deployment event to repo/commitSha (sha)/correlationKey (environment)", () => {
    const hint = mapGithubWebhookEventToHint("deployment", {
      deployment: { sha: "4".repeat(40), environment: "production" },
      repository: { full_name: "acme/widgets" }
    });
    expect(hint).toEqual({
      repo: "acme/widgets",
      commitSha: "4".repeat(40),
      correlationKey: "production"
    });
  });

  it("maps a release event to repo/correlationKey (tag_name)/path (target_commitish) — no commitSha", () => {
    const hint = mapGithubWebhookEventToHint("release", {
      release: { tag_name: "v1.2.3", target_commitish: "main" },
      repository: { full_name: "acme/widgets" }
    });
    expect(hint).toEqual({
      repo: "acme/widgets",
      commitSha: undefined,
      correlationKey: "v1.2.3",
      path: "main"
    });
  });

  it("returns null for an unrecognized event name (ignored, not an error — GitHub sends many event types)", () => {
    expect(
      mapGithubWebhookEventToHint("star", { repository: { full_name: "acme/widgets" } })
    ).toBeNull();
    expect(mapGithubWebhookEventToHint("issues", {})).toBeNull();
  });
});

// -------------------------------------------------------------------------------------------
// trigger() — workflow_dispatch
// -------------------------------------------------------------------------------------------

describe("trigger() — workflow_dispatch", () => {
  it("dispatches the workflow, correlates the newest matching run via the runs-list poll, and returns externalId = workflow_run::<id>", async () => {
    const { config, ctx, authHeader, base } = setup();
    const dispatchScope = nock(base)
      .matchHeader("authorization", authHeader)
      .post(
        `/repos/${config.owner}/${config.repo}/actions/workflows/${config.defaultWorkflowId}/dispatches`,
        {
          ref: "main",
          inputs: {}
        }
      )
      .reply(204);
    const runId = 314_159;
    const pollScope = nock(base)
      .matchHeader("authorization", authHeader)
      .get(
        `/repos/${config.owner}/${config.repo}/actions/workflows/${config.defaultWorkflowId}/runs`
      )
      .query({ event: "workflow_dispatch", per_page: "5" })
      .reply(200, {
        workflow_runs: [
          {
            id: runId,
            status: "queued",
            conclusion: null,
            html_url: `https://github.com/${config.owner}/${config.repo}/actions/runs/${runId}`,
            head_sha: "5".repeat(40),
            created_at: new Date().toISOString()
          }
        ]
      });

    const ref = await plugin.trigger(ctx, { kind: "workflow_dispatch" });

    expect(ref.externalId).toBe(`workflow_run::${runId}`);
    expect(ref.url).toBe(`https://github.com/${config.owner}/${config.repo}/actions/runs/${runId}`);
    dispatchScope.done();
    pollScope.done();
  });

  it("uses intent.parameters.workflowId/ref/inputs over config.defaultWorkflowId/'main' when provided", async () => {
    const { config, ctx, authHeader, base } = setup();
    const dispatchScope = nock(base)
      .matchHeader("authorization", authHeader)
      .post(`/repos/${config.owner}/${config.repo}/actions/workflows/deploy.yml/dispatches`, {
        ref: "release/1.0",
        inputs: { environment: "staging" }
      })
      .reply(204);
    const runId = 271_828;
    const pollScope = nock(base)
      .matchHeader("authorization", authHeader)
      .get(`/repos/${config.owner}/${config.repo}/actions/workflows/deploy.yml/runs`)
      .query({ event: "workflow_dispatch", per_page: "5" })
      .reply(200, {
        workflow_runs: [
          {
            id: runId,
            status: "queued",
            conclusion: null,
            html_url: "https://github.com/x",
            head_sha: "9".repeat(40),
            created_at: new Date().toISOString()
          }
        ]
      });

    const ref = await plugin.trigger(ctx, {
      kind: "workflow_dispatch",
      parameters: {
        workflowId: "deploy.yml",
        ref: "release/1.0",
        inputs: { environment: "staging" }
      }
    });

    expect(ref.externalId).toBe(`workflow_run::${runId}`);
    dispatchScope.done();
    pollScope.done();
  });

  it("when no run in the poll matches after all 3 correlation attempts, trigger() still returns an uncorrelated workflow_dispatch::<key> ref rather than throwing (module doc: status() re-attempts correlation on a later poll)", async () => {
    const { config, ctx, authHeader, base } = setup();
    const dispatchScope = nock(base)
      .matchHeader("authorization", authHeader)
      .post(
        `/repos/${config.owner}/${config.repo}/actions/workflows/${config.defaultWorkflowId}/dispatches`
      )
      .reply(204);
    // correlateDispatchedRun makes up to 3 attempts with a real 500ms backoff between them when no
    // match is found — .times(3) so every attempt gets a real (empty) response instead of hitting
    // an unmocked URL. This test genuinely takes ~1s of wall-clock time (two 500ms backoffs); that
    // real-timer cost is accepted here rather than faking timers, since faking setTimeout globally
    // risks interfering with the underlying nock/https socket machinery this test also depends on.
    const pollScope = nock(base)
      .matchHeader("authorization", authHeader)
      .get(
        `/repos/${config.owner}/${config.repo}/actions/workflows/${config.defaultWorkflowId}/runs`
      )
      .query({ event: "workflow_dispatch", per_page: "5" })
      .times(3)
      .reply(200, { workflow_runs: [] });

    const ref = await plugin.trigger(ctx, { kind: "workflow_dispatch" });

    expect(ref.externalId.startsWith("workflow_dispatch::")).toBe(true);
    expect(ref.url).toBeUndefined();
    dispatchScope.done();
    pollScope.done();
  }, 10_000);

  it("throws a clear Error when no workflowId is available (no intent.parameters.workflowId and no config.defaultWorkflowId) — WITHOUT making any HTTP call at all", async () => {
    // Deliberately not using setup()'s tokenScope here: index.ts's trigger() checks `workflowId`
    // BEFORE ever calling api()/getInstallationToken, so no HTTP call (not even the token
    // exchange) should happen. Registering a token-exchange interceptor here would leave it
    // unconsumed and fail via the file-wide afterEach — which is itself a useful check: it would
    // catch a regression that started resolving a token before validating workflowId.
    const config = buildGithubConfig({ defaultWorkflowId: undefined });
    const ctx = buildTestCtx(config);
    await expect(plugin.trigger(ctx, { kind: "workflow_dispatch" })).rejects.toThrow(
      /no workflowId/
    );
  });
});

// -------------------------------------------------------------------------------------------
// trigger() — custom / repository_dispatch
// -------------------------------------------------------------------------------------------

describe("trigger() — custom (repository_dispatch)", () => {
  it("POSTs repository_dispatch and returns a repository_dispatch::* externalId (no run correlation is possible for this event type)", async () => {
    const { config, ctx, authHeader, base } = setup();
    const scope = nock(base)
      .matchHeader("authorization", authHeader)
      .post(`/repos/${config.owner}/${config.repo}/dispatches`, {
        event_type: "scp-deploy",
        client_payload: { changeId: "chg-1" }
      })
      .reply(204);

    const ref = await plugin.trigger(ctx, {
      kind: "custom",
      parameters: { eventType: "scp-deploy", clientPayload: { changeId: "chg-1" } }
    });

    expect(ref.externalId.startsWith("repository_dispatch::")).toBe(true);
    expect(ref.url).toBeUndefined();
    scope.done();

    // status() for a repository_dispatch ref is always honestly "pending" — no run-level status
    // endpoint exists for this event type (module doc). No nock needed: a real HTTP attempt here
    // would fail the test via disableNetConnect(), which is exactly the point.
    const status = await plugin.status(ctx, ref);
    expect(status.phase).toBe("pending");
  });
});

// -------------------------------------------------------------------------------------------
// trigger() idempotency — the concrete, package-level proof behind plugin-testkit's generic
// "same idempotencyKey -> same ExternalRunRef, no duplicate side effect" conformance assertion.
// -------------------------------------------------------------------------------------------

describe("trigger() idempotency — in-memory dedup cache (statePath unset)", () => {
  it("a second trigger() call with the SAME idempotencyKey returns the SAME externalId and never re-dispatches", async () => {
    const { config, ctx, authHeader, base } = setup(); // statePath omitted -> in-memory cache
    const runId = 777_001;
    const dispatchScope = nock(base)
      .matchHeader("authorization", authHeader)
      .post(
        `/repos/${config.owner}/${config.repo}/actions/workflows/${config.defaultWorkflowId}/dispatches`
      )
      .reply(204);
    const pollScope = nock(base)
      .matchHeader("authorization", authHeader)
      .get(
        `/repos/${config.owner}/${config.repo}/actions/workflows/${config.defaultWorkflowId}/runs`
      )
      .query({ event: "workflow_dispatch", per_page: "5" })
      .reply(200, {
        workflow_runs: [
          {
            id: runId,
            status: "queued",
            conclusion: null,
            html_url: `https://github.com/${config.owner}/${config.repo}/actions/runs/${runId}`,
            head_sha: "6".repeat(40),
            created_at: new Date().toISOString()
          }
        ]
      });

    const intent = { kind: "workflow_dispatch" as const, idempotencyKey: "dedup-key-in-memory" };
    const first = await plugin.trigger(ctx, intent);
    expect(first.externalId).toBe(`workflow_run::${runId}`);
    // Fully consumed after just the FIRST call — proven by the file-wide afterEach, but asserted
    // explicitly here too so a failure points straight at "the dispatch/poll never happened".
    dispatchScope.done();
    pollScope.done();

    // The SECOND call with the identical key: no interceptors remain for dispatch/poll and
    // net-connect is disabled, so if trigger() ever re-dispatched, this would reject with a
    // "Nock: No match for request" error rather than silently passing.
    const second = await plugin.trigger(ctx, intent);
    expect(second.externalId).toBe(first.externalId);
    expect(second.url).toBe(first.url);
  });

  it("a DIFFERENT idempotencyKey is free to mint an independent run (dedup is per-key, not global)", async () => {
    const { config, ctx, authHeader, base } = setup();
    // Two DISTINCT one-shot interceptors per path (not .times(2) with one shared body): each must
    // resolve on its FIRST poll attempt (a matching run in the very first response) so neither
    // call falls into correlateDispatchedRun's real 500ms-backoff retry loop, AND each must
    // correlate to a DIFFERENT run id so "first.externalId !== second.externalId" is actually
    // proving independence rather than two calls coincidentally matching the same fixture body.
    // nock matches same-path interceptors in registration order, one consumption each.
    const dispatchPath = `/repos/${config.owner}/${config.repo}/actions/workflows/${config.defaultWorkflowId}/dispatches`;
    const pollPath = `/repos/${config.owner}/${config.repo}/actions/workflows/${config.defaultWorkflowId}/runs`;
    const dispatchScopeA = nock(base)
      .matchHeader("authorization", authHeader)
      .post(dispatchPath)
      .reply(204);
    const dispatchScopeB = nock(base)
      .matchHeader("authorization", authHeader)
      .post(dispatchPath)
      .reply(204);
    const runIdA = 111_111;
    const runIdB = 222_222;
    const pollScopeA = nock(base)
      .matchHeader("authorization", authHeader)
      .get(pollPath)
      .query({ event: "workflow_dispatch", per_page: "5" })
      .reply(200, {
        workflow_runs: [
          {
            id: runIdA,
            status: "queued",
            conclusion: null,
            html_url: "https://github.com/a",
            created_at: new Date().toISOString()
          }
        ]
      });
    const pollScopeB = nock(base)
      .matchHeader("authorization", authHeader)
      .get(pollPath)
      .query({ event: "workflow_dispatch", per_page: "5" })
      .reply(200, {
        workflow_runs: [
          {
            id: runIdB,
            status: "queued",
            conclusion: null,
            html_url: "https://github.com/b",
            created_at: new Date().toISOString()
          }
        ]
      });

    const first = await plugin.trigger(ctx, { kind: "workflow_dispatch", idempotencyKey: "key-a" });
    const second = await plugin.trigger(ctx, {
      kind: "workflow_dispatch",
      idempotencyKey: "key-b"
    });

    expect(first.externalId).toBe(`workflow_run::${runIdA}`);
    expect(second.externalId).toBe(`workflow_run::${runIdB}`);
    dispatchScopeA.done();
    dispatchScopeB.done();
    pollScopeA.done();
    pollScopeB.done();
  });
});

describe("trigger() idempotency — file-backed dedup cache (statePath set)", () => {
  // @scp/plugin-github's trigger()/status()/abort() are plain functions closing over the module-
  // level `githubExecutorPlugin` object (see index.ts) — there is no per-instance class to `new`
  // up a separate "process B" from, unlike @scp/plugin-fake-executor's FakeExecutorPlugin class.
  // What actually proves restart-safety here is that trigger() calls loadState(statePath) fresh
  // from disk on EVERY invocation (never caching DedupState in memory once statePath is set — see
  // index.ts's loadState/saveState), so two trigger() calls through the SAME plugin reference
  // still faithfully exercise the write-then-re-read-from-disk path a real process restart would
  // take. This test additionally reads the state file directly to prove it's genuinely persisted.
  let dir: string;
  let statePath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "scp-github-test-"));
    statePath = join(dir, "state.json");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("a second trigger() call with the SAME idempotencyKey re-reads the on-disk cache and never re-dispatches", async () => {
    const { config, ctx, authHeader, base } = setup({ statePath });
    const runId = 777_002;
    const dispatchScope = nock(base)
      .matchHeader("authorization", authHeader)
      .post(
        `/repos/${config.owner}/${config.repo}/actions/workflows/${config.defaultWorkflowId}/dispatches`
      )
      .reply(204);
    const pollScope = nock(base)
      .matchHeader("authorization", authHeader)
      .get(
        `/repos/${config.owner}/${config.repo}/actions/workflows/${config.defaultWorkflowId}/runs`
      )
      .query({ event: "workflow_dispatch", per_page: "5" })
      .reply(200, {
        workflow_runs: [
          {
            id: runId,
            status: "queued",
            conclusion: null,
            html_url: `https://github.com/${config.owner}/${config.repo}/actions/runs/${runId}`,
            head_sha: "7".repeat(40),
            created_at: new Date().toISOString()
          }
        ]
      });

    const intent = { kind: "workflow_dispatch" as const, idempotencyKey: "dedup-key-file-backed" };
    const first = await plugin.trigger(ctx, intent);
    dispatchScope.done();
    pollScope.done();

    const persisted = JSON.parse(await readFile(statePath, "utf8")) as {
      keys: Record<string, { externalId: string }>;
    };
    expect(persisted.keys["dedup-key-file-backed"]?.externalId).toBe(first.externalId);

    const second = await plugin.trigger(ctx, intent); // no interceptors left -> would throw if it re-dispatched
    expect(second.externalId).toBe(first.externalId);
  });
});

// -------------------------------------------------------------------------------------------
// status()
// -------------------------------------------------------------------------------------------

describe("status()", () => {
  async function statusFor(runBody: { status: string; conclusion: string | null }) {
    const { config, ctx, authHeader, base } = setup();
    const runId = Math.floor(Math.random() * 1_000_000) + 1;
    nock(base)
      .matchHeader("authorization", authHeader)
      .get(`/repos/${config.owner}/${config.repo}/actions/runs/${runId}`)
      .reply(200, {
        id: runId,
        html_url: `https://github.com/${config.owner}/${config.repo}/actions/runs/${runId}`,
        head_sha: "8".repeat(40),
        ...runBody
      });
    return plugin.status(ctx, { externalId: `workflow_run::${runId}` });
  }

  it("queued -> running", async () => {
    const status = await statusFor({ status: "queued", conclusion: null });
    expect(status.phase).toBe("running");
    expect(status.progress).toBe(0.5);
  });

  it("in_progress -> running", async () => {
    const status = await statusFor({ status: "in_progress", conclusion: null });
    expect(status.phase).toBe("running");
  });

  it("completed + success -> succeeded", async () => {
    const status = await statusFor({ status: "completed", conclusion: "success" });
    expect(status.phase).toBe("succeeded");
    expect(status.progress).toBe(1);
  });

  it("completed + failure -> failed", async () => {
    const status = await statusFor({ status: "completed", conclusion: "failure" });
    expect(status.phase).toBe("failed");
  });

  it("completed + cancelled -> aborted", async () => {
    const status = await statusFor({ status: "completed", conclusion: "cancelled" });
    expect(status.phase).toBe("aborted");
  });

  it("completed + an unrecognized/neutral conclusion also maps to failed (safe default, not a crash)", async () => {
    const status = await statusFor({ status: "completed", conclusion: "neutral" });
    expect(status.phase).toBe("failed");
  });

  it("an uncorrelated ref (not workflow_run::*) reports pending WITHOUT any HTTP call at all", async () => {
    const config = buildGithubConfig();
    const ctx = buildTestCtx(config);
    // Deliberately no nockInstallationToken() here either — statusFn must short-circuit before
    // even resolving a token for an uncorrelated ref, or this call would reject (net connect
    // disabled, no interceptor registered).
    const status = await plugin.status(ctx, { externalId: "repository_dispatch::some-key" });
    expect(status.phase).toBe("pending");
  });
});

// -------------------------------------------------------------------------------------------
// abort()
// -------------------------------------------------------------------------------------------

describe("abort()", () => {
  it("cancels a correlated run", async () => {
    const { config, ctx, authHeader, base } = setup();
    const runId = 9001;
    nock(base)
      .matchHeader("authorization", authHeader)
      .post(`/repos/${config.owner}/${config.repo}/actions/runs/${runId}/cancel`)
      .reply(202);

    const result = await plugin.abort(ctx, { externalId: `workflow_run::${runId}` });
    expect(result).toEqual({ aborted: true });
  });

  it("a non-2xx cancel response maps to aborted:false with a detail message, never throws", async () => {
    const { config, ctx, authHeader, base } = setup();
    const runId = 9002;
    nock(base)
      .matchHeader("authorization", authHeader)
      .post(`/repos/${config.owner}/${config.repo}/actions/runs/${runId}/cancel`)
      .reply(409, { message: "run already completed" });

    const result = await plugin.abort(ctx, { externalId: `workflow_run::${runId}` });
    expect(result.aborted).toBe(false);
    expect(result.detail).toContain("409");
  });

  it("an uncorrelated ref reports aborted:false without any HTTP call", async () => {
    const config = buildGithubConfig();
    const ctx = buildTestCtx(config);
    const result = await plugin.abort(ctx, { externalId: "repository_dispatch::some-key" });
    expect(result).toEqual({ aborted: false, detail: "github: no correlated run to cancel" });
  });
});

// -------------------------------------------------------------------------------------------
// observe() — polling fallback, and its poll-vs-push equivalence with mapGithubWebhookEventToHint.
// -------------------------------------------------------------------------------------------

describe("observe() polling fallback", () => {
  it("maps recent commits and workflow runs to well-formed ExecutorEvents with populated correlation", async () => {
    const { config, ctx, authHeader, base } = setup();
    const commitSha = "a1".repeat(20);
    nock(base)
      .matchHeader("authorization", authHeader)
      .get(`/repos/${config.owner}/${config.repo}/commits`)
      .reply(200, [{ sha: commitSha, commit: { author: { date: "2026-07-01T00:00:00Z" } } }]);
    const runId = 5551;
    const runSha = "b2".repeat(20);
    nock(base)
      .matchHeader("authorization", authHeader)
      .get(`/repos/${config.owner}/${config.repo}/actions/runs`)
      .reply(200, {
        workflow_runs: [
          {
            id: runId,
            status: "completed",
            conclusion: "success",
            html_url: "https://github.com/x",
            head_sha: runSha,
            created_at: "2026-07-01T00:05:00Z"
          }
        ]
      });

    const events = await plugin.observe(ctx);

    expect(events).toHaveLength(2);
    const pushEvent = events.find((e) => e.kind === "push");
    expect(pushEvent).toBeDefined();
    expect(pushEvent?.occurredAt).toBe("2026-07-01T00:00:00Z");
    expect(pushEvent?.correlation).toEqual({
      repo: `${config.owner}/${config.repo}`,
      path: undefined,
      commitSha,
      correlationKey: "refs/heads/*"
    });

    const runEvent = events.find((e) => e.kind === "workflow_run");
    expect(runEvent).toBeDefined();
    expect(runEvent?.correlation).toEqual({
      repo: `${config.owner}/${config.repo}`,
      path: undefined,
      commitSha: runSha,
      correlationKey: `run-${runId}`
    });
  });

  it("poll-vs-push equivalence: observe()'s polling fallback produces the SAME repo/commitSha correlation mapGithubWebhookEventToHint produces for the equivalent push webhook (BUILD_AND_TEST.md §8 M7 DoD: 'poll-vs-push equivalence')", async () => {
    const commitSha = "c3".repeat(20);
    const pushWebhookPayload = {
      ref: "refs/heads/main",
      after: commitSha,
      head_commit: { id: commitSha },
      repository: { full_name: "acme/widgets" }
    };
    const webhookHint = mapGithubWebhookEventToHint("push", pushWebhookPayload);
    expect(webhookHint).not.toBeNull();

    const { config, ctx, authHeader, base } = setup({ owner: "acme", repo: "widgets" });
    nock(base)
      .matchHeader("authorization", authHeader)
      .get(`/repos/${config.owner}/${config.repo}/commits`)
      .reply(200, [{ sha: commitSha, commit: { author: { date: "2026-07-01T00:00:00Z" } } }]);
    nock(base)
      .matchHeader("authorization", authHeader)
      .get(`/repos/${config.owner}/${config.repo}/actions/runs`)
      .reply(200, { workflow_runs: [] });

    const events = await plugin.observe(ctx);
    const polledPushEvent = events.find((e) => e.kind === "push");

    expect(polledPushEvent).toBeDefined();
    expect(polledPushEvent?.correlation.repo).toBe(webhookHint?.repo);
    expect(polledPushEvent?.correlation.commitSha).toBe(webhookHint?.commitSha);
  });
});

describe("observe() pagination (current, documented behavior)", () => {
  // TODO(M7 follow-up): GitHub's /commits and /actions/runs list endpoints paginate via `Link`
  // response headers (rel="next") / `page` query params for large repos/histories. Reading
  // observe()'s implementation in index.ts: it issues exactly ONE GET per resource with no
  // Link-header parsing and no `page` query param — i.e. it reads page 1 only, silently. That's a
  // real gap (a busy repo's commits/runs beyond page 1 are invisible to the polling fallback) but
  // NOT something this test suite invents a fix for — see the M7 task's own guidance not to add
  // pagination unless it's a small, clearly-correct, non-trigger()/status()-touching change; basic
  // Link-header-following for two call sites plus tests is more than a trivial addition, so it's
  // flagged here as follow-up work instead. This test documents the CURRENT single-page behavior
  // precisely so a future pagination fix has a test to deliberately change, not one it silently
  // breaks.
  it('reads only page 1 of /commits even when the response advertises a Link: rel="next" page 2 (no page-2 interceptor is registered — an accidental follow-up request would fail this test via disableNetConnect)', async () => {
    const { config, ctx, authHeader, base } = setup();
    const page1Sha = "d4".repeat(20);
    nock(base)
      .matchHeader("authorization", authHeader)
      .get(`/repos/${config.owner}/${config.repo}/commits`)
      .reply(200, [{ sha: page1Sha, commit: { author: { date: "2026-07-01T00:00:00Z" } } }], {
        link: `<https://api.github.com/repos/${config.owner}/${config.repo}/commits?page=2>; rel="next", <https://api.github.com/repos/${config.owner}/${config.repo}/commits?page=5>; rel="last"`
      });
    nock(base)
      .matchHeader("authorization", authHeader)
      .get(`/repos/${config.owner}/${config.repo}/actions/runs`)
      .reply(200, { workflow_runs: [] });

    const events = await plugin.observe(ctx);
    const pushEvents = events.filter((e) => e.kind === "push");
    expect(pushEvents).toHaveLength(1);
    expect(pushEvents[0]?.correlation.commitSha).toBe(page1Sha);
  });
});

// -------------------------------------------------------------------------------------------
// Rate-limit / non-2xx handling
// -------------------------------------------------------------------------------------------

describe("rate-limit / non-2xx error handling", () => {
  // TODO(M7 follow-up): trigger()/status()/observe()/abort() in index.ts implement NO retry or
  // backoff of their own — every non-2xx response (including 403-with-rate-limit-headers and 429)
  // throws (or, for observe(), is silently skipped for that one resource — see observe()'s
  // `if (status >= 200 && status < 300)` guards, which is a DIFFERENT, more lenient behavior than
  // trigger()/status()'s hard throw). That's a defensible, documented M7 posture: index.ts's
  // module doc explains coordination/reconcile.ts's own retry loop is what re-attempts a failed
  // trigger() on a LATER reconcile tick, so a single call failing fast (rather than blocking on an
  // internal retry/backoff loop) is intentional, not an oversight. These tests assert exactly that
  // documented behavior instead of inventing retry logic index.ts doesn't have.
  it("trigger() throws a clear HTTP-status-bearing Error when GitHub responds 403 with rate-limit-exhausted headers", async () => {
    const { config, ctx, authHeader, base } = setup();
    nock(base)
      .matchHeader("authorization", authHeader)
      .post(
        `/repos/${config.owner}/${config.repo}/actions/workflows/${config.defaultWorkflowId}/dispatches`
      )
      .reply(
        403,
        { message: "API rate limit exceeded for installation ID 123." },
        {
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 60)
        }
      );

    await expect(plugin.trigger(ctx, { kind: "workflow_dispatch" })).rejects.toThrow(/HTTP 403/);
  });

  it("status() throws a clear HTTP-status-bearing Error when GitHub responds 429 (secondary rate limit)", async () => {
    const { config, ctx, authHeader, base } = setup();
    const runId = 4030;
    nock(base)
      .matchHeader("authorization", authHeader)
      .get(`/repos/${config.owner}/${config.repo}/actions/runs/${runId}`)
      .reply(
        429,
        { message: "You have exceeded a secondary rate limit." },
        { "retry-after": "30" }
      );

    await expect(plugin.status(ctx, { externalId: `workflow_run::${runId}` })).rejects.toThrow(
      /HTTP 429/
    );
  });

  it("observe() silently skips (rather than throws for) a rate-limited resource — a DIFFERENT, more lenient documented behavior than trigger()/status()'s hard throw", async () => {
    const { config, ctx, authHeader, base } = setup();
    nock(base)
      .matchHeader("authorization", authHeader)
      .get(`/repos/${config.owner}/${config.repo}/commits`)
      .reply(403, { message: "API rate limit exceeded." }, { "x-ratelimit-remaining": "0" });
    nock(base)
      .matchHeader("authorization", authHeader)
      .get(`/repos/${config.owner}/${config.repo}/actions/runs`)
      .reply(200, { workflow_runs: [] });

    await expect(plugin.observe(ctx)).resolves.toEqual([]);
  });
});

// -------------------------------------------------------------------------------------------
// discover() (DiscoveryPlugin)
// -------------------------------------------------------------------------------------------

describe("discover() (DiscoveryPlugin)", () => {
  it("proposes one Service (repo root) and one Component per marker-file-containing top-level directory; directories with no marker file and non-directory entries are skipped", async () => {
    const { config, ctx, authHeader, base } = setup({ owner: "acme", repo: "monorepo" });
    nock(base)
      .matchHeader("authorization", authHeader)
      .get(`/repos/${config.owner}/${config.repo}/contents/`)
      .reply(200, [
        { name: "service-a", path: "service-a", type: "dir" },
        { name: "docs", path: "docs", type: "dir" }, // dir, but no marker file inside -> skipped
        { name: "README.md", path: "README.md", type: "file" } // not a dir -> no contents/ call at all
      ]);
    nock(base)
      .matchHeader("authorization", authHeader)
      .get(`/repos/${config.owner}/${config.repo}/contents/service-a`)
      .reply(200, [
        { name: "package.json", path: "service-a/package.json", type: "file" },
        { name: "src", path: "service-a/src", type: "dir" }
      ]);
    nock(base)
      .matchHeader("authorization", authHeader)
      .get(`/repos/${config.owner}/${config.repo}/contents/docs`)
      .reply(200, [{ name: "README.md", path: "docs/README.md", type: "file" }]);

    const proposal = await discoveryPlugin.discover(ctx);

    const services = proposal.objects.filter((o) => o.typeId === "service");
    expect(services).toHaveLength(1);
    expect(services[0]).toMatchObject({ name: config.repo });

    const components = proposal.objects.filter((o) => o.typeId === "component");
    expect(components).toHaveLength(1);
    expect(components[0]?.name).toBe("service-a");
    expect(components[0]?.properties?.sourceMapping).toEqual({
      sourceKind: "github",
      repoPattern: `${config.owner}/${config.repo}`,
      pathPattern: "service-a/**"
    });

    expect(proposal.relationships).toHaveLength(1);
    expect(proposal.relationships[0]).toEqual({
      typeId: "part_of",
      fromUrn: `urn:scp:component:github:${config.owner}/${config.repo}/service-a`,
      toUrn: `urn:scp:service:github:${config.owner}/${config.repo}`
    });
  });

  it("proposes ONLY the Service object (no components) when the repo root listing returns no marker-containing directories", async () => {
    const { config, ctx, authHeader, base } = setup();
    nock(base)
      .matchHeader("authorization", authHeader)
      .get(`/repos/${config.owner}/${config.repo}/contents/`)
      .reply(200, [{ name: "docs", path: "docs", type: "dir" }]);
    nock(base)
      .matchHeader("authorization", authHeader)
      .get(`/repos/${config.owner}/${config.repo}/contents/docs`)
      .reply(200, [{ name: "index.md", path: "docs/index.md", type: "file" }]);

    const proposal = await discoveryPlugin.discover(ctx);
    expect(proposal.objects).toHaveLength(1);
    expect(proposal.objects[0]?.typeId).toBe("service");
    expect(proposal.relationships).toHaveLength(0);
  });
});

// -------------------------------------------------------------------------------------------
// postCommitStatus()
// -------------------------------------------------------------------------------------------

describe("postCommitStatus()", () => {
  it("POSTs the mapped commit status payload, defaulting context to 'commanderscp/coordination'", async () => {
    const { config, ctx, authHeader, base } = setup();
    const sha = "e5".repeat(20);
    const scope = nock(base)
      .matchHeader("authorization", authHeader)
      .post(`/repos/${config.owner}/${config.repo}/statuses/${sha}`, {
        state: "success",
        context: "commanderscp/coordination",
        description: "All coordination checks passed",
        target_url: "https://scp.example/changes/123"
      })
      .reply(201, { id: 1 });

    await expect(
      postCommitStatus(ctx, {
        sha,
        state: "success",
        description: "All coordination checks passed",
        targetUrl: "https://scp.example/changes/123"
      })
    ).resolves.toBeUndefined();
    scope.done();
  });

  it("honors an explicit context override instead of the default", async () => {
    const { config, ctx, authHeader, base } = setup();
    const sha = "f6".repeat(20);
    const scope = nock(base)
      .matchHeader("authorization", authHeader)
      .post(`/repos/${config.owner}/${config.repo}/statuses/${sha}`, {
        state: "pending",
        context: "scp/custom-gate"
      })
      .reply(201, {});
    await postCommitStatus(ctx, { sha, state: "pending", context: "scp/custom-gate" });
    scope.done();
  });

  it("a non-2xx response throws a clear HTTP-status-bearing Error", async () => {
    const { config, ctx, authHeader, base } = setup();
    const sha = "07".repeat(20);
    nock(base)
      .matchHeader("authorization", authHeader)
      .post(`/repos/${config.owner}/${config.repo}/statuses/${sha}`)
      .reply(422, { message: "sha not found" });

    await expect(postCommitStatus(ctx, { sha, state: "failure" })).rejects.toThrow(/HTTP 422/);
  });
});
