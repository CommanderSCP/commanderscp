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
  githubAdapter,
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
      correlationKey: "refs/heads/main",
      ref: "refs/heads/main"
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
// Base-URL resolution (M15.3b) — apiBaseUrl → serverUrl (Mode A: import an EXISTING GitHub /
// GitHub Enterprise, injected as config.serverUrl) → the github.com default. Every request in this
// block is fixtured ONLY on the host the resolution SHOULD pick; net-connect is disabled, so a
// request that landed on the wrong host would reject with "no match" rather than pass silently.
// -------------------------------------------------------------------------------------------

describe("base URL resolution (apiBaseUrl → serverUrl → github.com default)", () => {
  it("with ONLY serverUrl set (a GitHub Enterprise host, no apiBaseUrl) every request goes to that host, not api.github.com", async () => {
    const enterprise = "https://ghe.corp.example";
    // apiBaseUrl explicitly undefined → the injected serverUrl is the sole base; apiBase() (and
    // index.ts's asConfig) must both resolve to `enterprise`. setup() fixtures the token exchange
    // at apiBase(config) = enterprise, so it also proves auth targets the enterprise host.
    const { config, ctx, authHeader } = setup({ apiBaseUrl: undefined, serverUrl: enterprise });
    expect(config.apiBaseUrl).toBeUndefined();
    const commitSha = "1a".repeat(20);
    nock(enterprise)
      .matchHeader("authorization", authHeader)
      .get(`/repos/${config.owner}/${config.repo}/commits`)
      .query(true)
      .reply(200, [{ sha: commitSha, commit: { author: { date: "2026-07-01T00:00:00Z" } } }]);
    nock(enterprise)
      .matchHeader("authorization", authHeader)
      .get(`/repos/${config.owner}/${config.repo}/actions/runs`)
      .query(true)
      .reply(200, { workflow_runs: [] });

    const events = await plugin.observe(ctx);
    expect(events.find((e) => e.kind === "push")?.correlation.commitSha).toBe(commitSha);
  });

  it("with NEITHER apiBaseUrl NOR serverUrl set, requests fall back to the api.github.com default", async () => {
    const { config, ctx, authHeader } = setup({ apiBaseUrl: undefined, serverUrl: undefined });
    expect(config.apiBaseUrl).toBeUndefined();
    expect(config.serverUrl).toBeUndefined();
    const commitSha = "2b".repeat(20);
    nock("https://api.github.com")
      .matchHeader("authorization", authHeader)
      .get(`/repos/${config.owner}/${config.repo}/commits`)
      .query(true)
      .reply(200, [{ sha: commitSha, commit: { author: { date: "2026-07-01T00:00:00Z" } } }]);
    nock("https://api.github.com")
      .matchHeader("authorization", authHeader)
      .get(`/repos/${config.owner}/${config.repo}/actions/runs`)
      .query(true)
      .reply(200, { workflow_runs: [] });

    const events = await plugin.observe(ctx);
    expect(events.find((e) => e.kind === "push")?.correlation.commitSha).toBe(commitSha);
  });

  it("an explicit apiBaseUrl WINS over an injected serverUrl (explicit override beats the fallback)", async () => {
    const explicit = "https://ghe-explicit.corp.example";
    const serverUrl = "https://ghe-injected.corp.example";
    const { config, ctx, authHeader } = setup({ apiBaseUrl: explicit, serverUrl });
    const commitSha = "3c".repeat(20);
    // Fixtures live ONLY on the explicit host; if resolution wrongly preferred serverUrl, these go
    // unconsumed (afterEach fails) AND the call rejects against the unmocked injected host.
    nock(explicit)
      .matchHeader("authorization", authHeader)
      .get(`/repos/${config.owner}/${config.repo}/commits`)
      .query(true)
      .reply(200, [{ sha: commitSha, commit: { author: { date: "2026-07-01T00:00:00Z" } } }]);
    nock(explicit)
      .matchHeader("authorization", authHeader)
      .get(`/repos/${config.owner}/${config.repo}/actions/runs`)
      .query(true)
      .reply(200, { workflow_runs: [] });

    const events = await plugin.observe(ctx);
    expect(events.find((e) => e.kind === "push")?.correlation.commitSha).toBe(commitSha);
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

  it("ENCODES the runId sliced out of externalId into the route", async () => {
    // Same census class as `postCommitStatus`'s sha (see that test) and readFileAtRef's
    // `repo`/`ref` (M21.2 review BLOCKERS 1-2): a non-literal string spliced into a REST route.
    // `externalId` is stored correlation state and numeric in practice, so this encoding is an
    // IDENTITY today and its removal would change no observed behaviour — which is exactly why it
    // is pinned. An unpinned member of a censused class is indistinguishable from an untouched one
    // on the next refactor (CLAUDE.md, "census by property, not by symptom"). Unencoded,
    // `../../../user` re-targets this GET at `https://api.github.com/user` with the binding's
    // installation token, because `new URL()` collapses literal `..` segments; encoded it is
    // `..%2F..%2F..%2Fuser`, ONE segment a URL does not normalize away. The interceptor matches
    // only the encoded form, and `disableNetConnect()` plus the file-wide pending-mocks check make
    // the unencoded form fail loudly rather than pass quietly.
    const { config, ctx, authHeader, base } = setup();
    const runId = "../../../user";
    const scope = nock(base)
      .matchHeader("authorization", authHeader)
      .get(`/repos/${config.owner}/${config.repo}/actions/runs/${encodeURIComponent(runId)}`)
      .reply(200, { id: 1, status: "completed", conclusion: "success", head_sha: "8".repeat(40) });

    const status = await plugin.status(ctx, { externalId: `workflow_run::${runId}` });
    expect(status.phase).toBe("succeeded");
    scope.done();
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

  it("ENCODES the runId sliced out of externalId into the cancel route", async () => {
    // The second of this adapter's two `externalId`-derived route splices — see the identical pin
    // in `status()` above for why an identity-today encoding is still pinned. Unencoded this POST
    // would land on `https://api.github.com/user/cancel` rather than on the run.
    const { config, ctx, authHeader, base } = setup();
    const runId = "../../../user";
    const scope = nock(base)
      .matchHeader("authorization", authHeader)
      .post(
        `/repos/${config.owner}/${config.repo}/actions/runs/${encodeURIComponent(runId)}/cancel`
      )
      .reply(202);

    expect(await plugin.abort(ctx, { externalId: `workflow_run::${runId}` })).toEqual({
      aborted: true
    });
    scope.done();
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
      .query(true)
      .reply(200, [{ sha: commitSha, commit: { author: { date: "2026-07-01T00:00:00Z" } } }]);
    const runId = 5551;
    const runSha = "b2".repeat(20);
    nock(base)
      .matchHeader("authorization", authHeader)
      .get(`/repos/${config.owner}/${config.repo}/actions/runs`)
      .query(true)
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
      .query(true)
      .reply(200, [{ sha: commitSha, commit: { author: { date: "2026-07-01T00:00:00Z" } } }]);
    nock(base)
      .matchHeader("authorization", authHeader)
      .get(`/repos/${config.owner}/${config.repo}/actions/runs`)
      .query(true)
      .reply(200, { workflow_runs: [] });

    const events = await plugin.observe(ctx);
    const polledPushEvent = events.find((e) => e.kind === "push");

    expect(polledPushEvent).toBeDefined();
    expect(polledPushEvent?.correlation.repo).toBe(webhookHint?.repo);
    expect(polledPushEvent?.correlation.commitSha).toBe(webhookHint?.commitSha);
  });
});

describe("observe() pagination", () => {
  // The polling fallback used to read GitHub's DEFAULT page (30, newest-first) and stop, on both
  // list resources. Everything older than that page was not deferred to the next tick — the cursor
  // advances past it, so those commits/runs were never correlated at all. These tests fixture a
  // multi-page window and assert the pages are actually walked, with a ceiling.
  const cursorFor = (pushIso: string, runIso: string): { token: string } => ({
    token: JSON.stringify({ push: pushIso, workflow_run: runIso })
  });
  const commitPage = (label: string, count: number, dateIso: string): unknown[] =>
    Array.from({ length: count }, (_, i) => ({
      sha: `${label}${String(i).padStart(38, "0")}`,
      commit: { author: { date: dateIso } }
    }));
  const runPage = (firstId: number, count: number, createdAt: string): unknown[] =>
    Array.from({ length: count }, (_, i) => ({
      id: firstId + i,
      status: "completed",
      conclusion: "success",
      html_url: "https://github.com/x",
      head_sha: "e".repeat(40),
      created_at: createdAt
    }));

  it("walks /commits pages until a page's OLDEST entry predates the watermark", async () => {
    const { config, ctx, authHeader, base } = setup();
    const watermark = "2026-07-01T00:00:00.000Z";
    const scope = nock(base).matchHeader("authorization", authHeader);
    // Page 1 is FULL and entirely newer than the watermark -> there is more window to read.
    scope
      .get(`/repos/${config.owner}/${config.repo}/commits`)
      .query((q) => q.page === "1" && q.per_page === "100" && q.since === watermark)
      .reply(200, commitPage("a", 100, "2026-07-02T00:00:00Z"));
    // Page 2 straddles the watermark (its oldest entry is at/behind it) -> stop after it.
    scope
      .get(`/repos/${config.owner}/${config.repo}/commits`)
      .query((q) => q.page === "2")
      .reply(200, [
        { sha: "b".repeat(40), commit: { author: { date: "2026-07-01T12:00:00Z" } } },
        { sha: "c".repeat(40), commit: { author: { date: "2026-06-30T00:00:00Z" } } }
      ]);
    scope
      .get(`/repos/${config.owner}/${config.repo}/actions/runs`)
      .query(true)
      .reply(200, { workflow_runs: [] });

    const events = await plugin.observe(ctx, cursorFor(watermark, watermark));

    // 102 = both pages. Page 3 has no interceptor: requesting it would reject, not pass silently.
    expect(events.filter((e) => e.kind === "push")).toHaveLength(102);
    expect(events.some((e) => e.correlation.commitSha === "b".repeat(40))).toBe(true);
    scope.done();
  });

  it("stops at the page BUDGET rather than following an endless backlog", async () => {
    const { config, ctx, authHeader, base } = setup();
    const watermark = "2026-07-01T00:00:00.000Z";
    const scope = nock(base).matchHeader("authorization", authHeader);
    // Six full pages of always-newer commits are available; only five may be read.
    for (const page of [1, 2, 3, 4, 5, 6]) {
      scope
        .get(`/repos/${config.owner}/${config.repo}/commits`)
        .query((q) => q.page === String(page))
        .reply(200, commitPage(String(page), 100, "2026-07-02T00:00:00Z"));
    }
    scope
      .get(`/repos/${config.owner}/${config.repo}/actions/runs`)
      .query(true)
      .reply(200, { workflow_runs: [] });

    const events = await plugin.observe(ctx, cursorFor(watermark, watermark));

    // Captured BEFORE the file's afterEach cleans up: the sixth page must be left unread.
    const unread = nock.pendingMocks();
    nock.cleanAll();
    expect(events.filter((e) => e.kind === "push")).toHaveLength(500); // 5 pages, not 6.
    expect(unread).toHaveLength(1);
  });

  it("walks /actions/runs pages too — the same window, filtered client-side", async () => {
    const { config, ctx, authHeader, base } = setup();
    const watermark = "2026-07-01T00:00:00.000Z";
    const scope = nock(base).matchHeader("authorization", authHeader);
    scope.get(`/repos/${config.owner}/${config.repo}/commits`).query(true).reply(200, []);
    scope
      .get(`/repos/${config.owner}/${config.repo}/actions/runs`)
      .query((q) => q.page === "1" && q.per_page === "100")
      .reply(200, { workflow_runs: runPage(1000, 100, "2026-07-02T00:00:00Z") });
    scope
      .get(`/repos/${config.owner}/${config.repo}/actions/runs`)
      .query((q) => q.page === "2")
      .reply(200, {
        workflow_runs: [
          ...runPage(2001, 1, "2026-07-01T12:00:00Z"),
          // Older than the watermark: read, filtered out, and it ends the walk.
          ...runPage(2002, 1, "2026-06-30T00:00:00Z")
        ]
      });

    const events = await plugin.observe(ctx, cursorFor(watermark, watermark));

    const runEvents = events.filter((e) => e.kind === "workflow_run");
    expect(runEvents).toHaveLength(101);
    expect(runEvents.some((e) => e.correlation.correlationKey === "run-2001")).toBe(true);
    expect(runEvents.some((e) => e.correlation.correlationKey === "run-2002")).toBe(false);
    scope.done();
  });

  it("a COLD START (no watermark) reads exactly one page of each resource", async () => {
    const { config, ctx, authHeader, base } = setup();
    const scope = nock(base).matchHeader("authorization", authHeader);
    scope
      .get(`/repos/${config.owner}/${config.repo}/commits`)
      .query((q) => q.page === "1")
      .reply(200, commitPage("d", 100, "2026-07-02T00:00:00Z"));
    scope
      .get(`/repos/${config.owner}/${config.repo}/actions/runs`)
      .query((q) => q.page === "1")
      .reply(200, { workflow_runs: runPage(3000, 100, "2026-07-02T00:00:00Z") });

    // Both pages are full, so only the cold-start rule stops the walk; a page-2 request has no
    // interceptor and would reject under disableNetConnect.
    const events = await plugin.observe(ctx);

    expect(events.filter((e) => e.kind === "push")).toHaveLength(100);
    expect(events.filter((e) => e.kind === "workflow_run")).toHaveLength(100);
    scope.done();
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
      .query(true)
      .reply(403, { message: "API rate limit exceeded." }, { "x-ratelimit-remaining": "0" });
    nock(base)
      .matchHeader("authorization", authHeader)
      .get(`/repos/${config.owner}/${config.repo}/actions/runs`)
      .query(true)
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

    // `contains`, SERVICE -> COMPONENT — the registered membership edge (migration 0021), NOT the
    // `part_of` this plugin used to emit: no migration registers that, so accept answered every
    // proposal carrying one with a 404 and the discovery relationship channel never worked.
    expect(proposal.relationships).toHaveLength(1);
    expect(proposal.relationships[0]).toEqual({
      typeId: "contains",
      fromUrn: `urn:scp:service:github:${config.owner}/${config.repo}`,
      toUrn: `urn:scp:component:github:${config.owner}/${config.repo}/service-a`
    });

    // The endpoints must be the ALIASES the proposed objects declare, asserted BY REFERENCE to
    // those objects rather than as a third copy of the literal. Restating the strings would let a
    // plugin change its URN scheme in one of the two places and stay green — and an endpoint that
    // names no proposed object is exactly the 404 (`object '...' not found`) that made this edge
    // unimportable even once its type was right.
    expect(proposal.relationships[0]?.fromUrn).toBe(services[0]?.urn);
    expect(proposal.relationships[0]?.toUrn).toBe(components[0]?.urn);
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

  it("ENCODES the caller-supplied sha into the route — it is the same class as readFileAtRef's `repo`/`ref`", async () => {
    // Censused out of the M21.2 review BLOCKERS 1-2 (a caller-supplied string spliced raw into a
    // REST route), not reported against this function: `postCommitStatus` is the only other place
    // in this package that did it. Unencoded, `../../..` here would have re-targeted the POST; the
    // interceptor below only matches the ENCODED single segment, and `nock.disableNetConnect()`
    // plus the file-wide pending-mocks check make the unencoded form fail rather than pass quietly.
    const { config, ctx, authHeader, base } = setup();
    const sha = "../../../user";
    const scope = nock(base)
      .matchHeader("authorization", authHeader)
      .post(`/repos/${config.owner}/${config.repo}/statuses/${encodeURIComponent(sha)}`)
      .reply(201, {});
    await postCommitStatus(ctx, { sha, state: "pending" });
    scope.done();
  });
});

/**
 * `correlation.paths` — the changed-file set, which is what lets ONE repository route to
 * per-directory components. Without it every mapping on a monorepo is necessarily repo-only, they
 * all rank equally, and the oldest wins every event forever (see `correlation.ts`).
 *
 * The webhook and poll paths obtain it very differently — the push payload carries it inline, while
 * the commits LIST response does not, so polling must fetch each commit individually — which is
 * exactly why both are pinned here.
 */
describe("correlation.paths: the changed-file set", () => {
  it("push webhook: unions added/modified/removed across EVERY commit, not just head_commit", () => {
    // A push delivers all its commits at once. A file touched by an earlier commit in the same push
    // is still a file this push changed, so reading only `head_commit` would drop it and silently
    // route the release by the repo-only fallback.
    const hint = mapGithubWebhookEventToHint("push", {
      repository: { full_name: "acme/widgets" },
      ref: "refs/heads/main",
      head_commit: { id: "d4".repeat(20), modified: ["loki/values.yaml"] },
      commits: [
        { id: "aa".repeat(20), added: ["pihole/values.yaml"], modified: ["README.md"] },
        { id: "bb".repeat(20), removed: ["tailscale/old.yaml"] }
      ]
    });

    expect(hint?.paths).toEqual([
      "README.md",
      "loki/values.yaml",
      "pihole/values.yaml",
      "tailscale/old.yaml"
    ]);
  });

  it("push webhook: a payload carrying no file arrays yields NO paths rather than an empty list", () => {
    // `undefined` means "not determined" and declines a path-scoped mapping; `[]` would be
    // indistinguishable from "changed nothing", which cannot happen for a real push.
    const hint = mapGithubWebhookEventToHint("push", {
      repository: { full_name: "acme/widgets" },
      ref: "refs/heads/main",
      head_commit: { id: "d4".repeat(20) }
    });

    expect(hint?.paths).toBeUndefined();
  });

  it("polling: fetches each commit individually to obtain files the commits LIST omits", async () => {
    const { config, ctx, authHeader, base } = setup();
    const commitSha = "e5".repeat(20);
    nock(base)
      .matchHeader("authorization", authHeader)
      .get(`/repos/${config.owner}/${config.repo}/commits`)
      .query(true)
      .reply(200, [{ sha: commitSha, commit: { author: { date: "2026-08-01T00:00:00Z" } } }]);
    nock(base)
      .matchHeader("authorization", authHeader)
      .get(`/repos/${config.owner}/${config.repo}/commits/${commitSha}`)
      .reply(200, { files: [{ filename: "loki/values.yaml" }, { filename: "README.md" }] });
    nock(base)
      .matchHeader("authorization", authHeader)
      .get(`/repos/${config.owner}/${config.repo}/actions/runs`)
      .query(true)
      .reply(200, { workflow_runs: [] });

    const events = await plugin.observe(ctx);

    const pushEvent = events.find((e) => e.kind === "push");
    expect(pushEvent?.correlation.paths).toEqual(["README.md", "loki/values.yaml"]);
  });

  it("polling: a FAILED file fetch still yields the push event, just without paths", async () => {
    // Regression. `api()` THROWS on a transport failure rather than returning a status, so an
    // unguarded fetch aborted `pollCommits` mid-loop and lost the push events entirely — turning a
    // best-effort enrichment into data loss, where the release would never be coordinated at all
    // instead of merely routing by repository. Caught by this suite's `disableNetConnect` when the
    // single-commit interceptor below was first left unregistered.
    const { config, ctx, authHeader, base } = setup();
    const commitSha = "f6".repeat(20);
    nock(base)
      .matchHeader("authorization", authHeader)
      .get(`/repos/${config.owner}/${config.repo}/commits`)
      .query(true)
      .reply(200, [{ sha: commitSha, commit: { author: { date: "2026-08-01T00:00:00Z" } } }]);
    nock(base)
      .matchHeader("authorization", authHeader)
      .get(`/repos/${config.owner}/${config.repo}/commits/${commitSha}`)
      .replyWithError("connection reset");
    nock(base)
      .matchHeader("authorization", authHeader)
      .get(`/repos/${config.owner}/${config.repo}/actions/runs`)
      .query(true)
      .reply(200, { workflow_runs: [] });

    const events = await plugin.observe(ctx);

    const pushEvent = events.find((e) => e.kind === "push");
    expect(pushEvent).toBeDefined();
    expect(pushEvent?.correlation.commitSha).toBe(commitSha);
    expect(pushEvent?.correlation.paths).toBeUndefined();
  });
});

// -------------------------------------------------------------------------------------------
// readFileAtRef (M21.2, ADR-0032 §4) — the FIRST file-body read in this package. Every fixture
// below is GitHub's real documented contents/commits response shape: the contents response for a
// blob carries `type: "file"`, `encoding: "base64"`, `size`, `content` (base64 WRAPPED AT 60 CHARS
// WITH NEWLINES — the fixtures wrap it, because that is what GitHub actually sends and an
// implementation that measured the unstripped string would mis-size every real payload) and `sha`
// (the BLOB sha); a directory comes back from the SAME route as a JSON array.
//
// Note the two-call shape being asserted: resolve `ref` -> commit sha, then read the blob AT THAT
// SHA. The second interceptor matching on `?ref=<the sha from the first response>` is what proves
// the pin actually happens — if the adapter read at the branch name instead, that interceptor never
// matches and the file-wide `afterEach` fails on the unconsumed mock.
// -------------------------------------------------------------------------------------------

describe("readFileAtRef()", () => {
  const REF_COMMIT_SHA = "9f".repeat(20);

  /** GitHub wraps contents base64 at 60 chars with `\n`. Fixtures do the same. */
  function githubBase64(text: string): string {
    const flat = Buffer.from(text, "utf8").toString("base64");
    return (flat.match(/.{1,60}/g) ?? []).join("\n");
  }

  function nockResolveRef(
    base: string,
    authHeader: string,
    config: GithubConfig,
    ref = "main",
    sha = REF_COMMIT_SHA
  ) {
    return nock(base)
      .matchHeader("authorization", authHeader)
      .get(`/repos/${config.owner}/${config.repo}/commits/${ref}`)
      .reply(200, { sha, commit: { message: "chore: bump" } });
  }

  it("reads a manifest: returns the decoded text, the byte length, the blob sha, and the commit the ref RESOLVED to", async () => {
    const { config, ctx, authHeader, base } = setup();
    const manifest = '{\n  "name": "widgets",\n  "dependencies": { "left-pad": "^1.3.0" }\n}\n';
    const refScope = nockResolveRef(base, authHeader, config);
    const contentsScope = nock(base)
      .matchHeader("authorization", authHeader)
      .get(`/repos/${config.owner}/${config.repo}/contents/package.json`)
      .query({ ref: REF_COMMIT_SHA })
      .reply(200, {
        name: "package.json",
        path: "package.json",
        sha: "blob0011",
        size: Buffer.byteLength(manifest, "utf8"),
        type: "file",
        encoding: "base64",
        content: githubBase64(manifest)
      });

    const result = await githubAdapter.readFileAtRef(ctx, { path: "package.json", ref: "main" });

    expect(result).toEqual({
      outcome: "found",
      path: "package.json",
      requestedRef: "main",
      commitSha: REF_COMMIT_SHA,
      content: manifest,
      sizeBytes: Buffer.byteLength(manifest, "utf8"),
      blobSha: "blob0011"
    });
    refScope.done();
    contentsScope.done();
  });

  it("round-trips MULTI-BYTE UTF-8 through GitHub's newline-wrapped base64 (sizeBytes counts bytes, not UTF-16 units)", async () => {
    const { config, ctx, authHeader, base } = setup();
    // Long enough that GitHub's 60-char wrapping produces several embedded newlines.
    const text =
      `# 日本語 — Dockerfile 🎉\nFROM alpine:1.0\nLABEL maintainer="Ada Lovelace ✨"\n`.repeat(4);
    nockResolveRef(base, authHeader, config);
    nock(base)
      .matchHeader("authorization", authHeader)
      .get(`/repos/${config.owner}/${config.repo}/contents/Dockerfile`)
      .query({ ref: REF_COMMIT_SHA })
      .reply(200, {
        path: "Dockerfile",
        sha: "blobdock",
        size: Buffer.byteLength(text, "utf8"),
        type: "file",
        encoding: "base64",
        content: githubBase64(text)
      });

    const result = await githubAdapter.readFileAtRef(ctx, { path: "Dockerfile", ref: "main" });

    expect(result.outcome).toBe("found");
    if (result.outcome !== "found") throw new Error("unreachable");
    expect(result.content).toBe(text);
    expect(result.sizeBytes).toBe(Buffer.byteLength(text, "utf8"));
    // NEGATIVE CONTROL for the wrapping: a decoder that did not strip the embedded newlines would
    // produce a different string, and one that used content.length as the size would report this.
    expect(result.sizeBytes).not.toBe(result.content.length);
  });

  it("reads a NESTED path with the path encoded PER SEGMENT (slashes stay literal in the route)", async () => {
    const { config, ctx, authHeader, base } = setup();
    nockResolveRef(base, authHeader, config);
    const scope = nock(base)
      .matchHeader("authorization", authHeader)
      // Literal slashes: `encodeURIComponent` over the whole path would send `services%2Fapi%2Fgo.mod`
      // and this interceptor would never match.
      .get(`/repos/${config.owner}/${config.repo}/contents/services/api/go.mod`)
      .query({ ref: REF_COMMIT_SHA })
      .reply(200, {
        path: "services/api/go.mod",
        sha: "blobgo",
        size: 21,
        type: "file",
        encoding: "base64",
        content: githubBase64("module example.com/x\n")
      });

    const result = await githubAdapter.readFileAtRef(ctx, {
      path: "services/api/go.mod",
      ref: "main"
    });
    expect(result).toMatchObject({ outcome: "found", content: "module example.com/x\n" });
    scope.done();
  });

  it("ESCAPES a '#' in both the ref and the path — unencoded it starts a URL fragment and TRUNCATES the request", async () => {
    // The nested-path test above pins per-segment vs whole encoding, but both of its strings are
    // already URL-identity, so deleting the encoding entirely leaves it green (measured). `#` is
    // the case where the encoding is load-bearing rather than decorative: `git check-ref-format`
    // permits it in a ref and it is legal in a filename, so neither `assertSafeRef` nor
    // `assertSafeRepoPath` refuses it — but unencoded it ends the URL, so step 1 would request
    // `/commits/release/` and step 2 `/contents/docs/` (each a DIRECTORY listing, i.e. a wrong
    // answer rather than an error). Both interpolations of this call are therefore pinned here.
    const { config, ctx, authHeader, base } = setup();
    const ref = "release/#42";
    const path = "docs/notes#1.md";
    const refScope = nock(base)
      .matchHeader("authorization", authHeader)
      .get(`/repos/${config.owner}/${config.repo}/commits/release/%2342`)
      .reply(200, { sha: REF_COMMIT_SHA });
    const contentsScope = nock(base)
      .matchHeader("authorization", authHeader)
      .get(`/repos/${config.owner}/${config.repo}/contents/docs/notes%231.md`)
      .query({ ref: REF_COMMIT_SHA })
      .reply(200, {
        path,
        sha: "blobhash",
        size: 3,
        type: "file",
        encoding: "base64",
        content: githubBase64("ok\n")
      });

    const result = await githubAdapter.readFileAtRef(ctx, { path, ref });
    expect(result).toMatchObject({ outcome: "found", content: "ok\n" });
    refScope.done();
    contentsScope.done();
  });

  it("a 404 on the FILE is a routine not_found (missing: 'path'), not a throw — most components declare only some manifests", async () => {
    const { config, ctx, authHeader, base } = setup();
    nockResolveRef(base, authHeader, config);
    nock(base)
      .matchHeader("authorization", authHeader)
      .get(`/repos/${config.owner}/${config.repo}/contents/pom.xml`)
      .query({ ref: REF_COMMIT_SHA })
      .reply(404, { message: "Not Found" });

    const result = await githubAdapter.readFileAtRef(ctx, { path: "pom.xml", ref: "main" });
    expect(result).toMatchObject({
      outcome: "not_found",
      missing: "path",
      path: "pom.xml",
      requestedRef: "main"
    });
  });

  it("a 404 on the REF is not_found with missing: 'ref' — and never reaches the contents call at all", async () => {
    const { config, ctx, authHeader, base } = setup();
    nock(base)
      .matchHeader("authorization", authHeader)
      .get(`/repos/${config.owner}/${config.repo}/commits/no-such-branch`)
      .reply(404, { message: "No commit found for SHA: no-such-branch" });
    // NEGATIVE CONTROL: NO contents interceptor is registered. If the adapter fell through to the
    // contents call anyway, `nock.disableNetConnect()` turns it into a rejected promise (a thrown
    // "no match"), so this test would fail rather than silently pass.

    const result = await githubAdapter.readFileAtRef(ctx, {
      path: "go.mod",
      ref: "no-such-branch"
    });
    expect(result).toMatchObject({ outcome: "not_found", missing: "ref" });
  });

  it("refuses an OVERSIZE file on GitHub's declared `size`, without decoding it", async () => {
    const { config, ctx, authHeader, base } = setup();
    nockResolveRef(base, authHeader, config);
    nock(base)
      .matchHeader("authorization", authHeader)
      .get(`/repos/${config.owner}/${config.repo}/contents/package.json`)
      .query({ ref: REF_COMMIT_SHA })
      .reply(200, {
        path: "package.json",
        sha: "blobbig",
        size: 5_000_000,
        type: "file",
        encoding: "base64",
        content: githubBase64("{}") // tiny payload: only the DECLARED size can trigger the refusal
      });

    const result = await githubAdapter.readFileAtRef(ctx, { path: "package.json", ref: "main" });
    expect(result).toMatchObject({
      outcome: "refused",
      reason: "too_large",
      sizeBytes: 5_000_000
    });
    // NEGATIVE CONTROL: it must NOT come back as a successful read of the small payload.
    expect(result.outcome).not.toBe("found");
  });

  it("refuses a file over an explicit caller `maxBytes` on the COMPUTED payload size, even when GitHub declares it small", async () => {
    const { config, ctx, authHeader, base } = setup();
    const big = "x".repeat(4096);
    nockResolveRef(base, authHeader, config);
    nock(base)
      .matchHeader("authorization", authHeader)
      .get(`/repos/${config.owner}/${config.repo}/contents/requirements.txt`)
      .query({ ref: REF_COMMIT_SHA })
      .reply(200, {
        path: "requirements.txt",
        sha: "blobreq",
        size: 12, // a size the provider ASSERTS and the payload contradicts
        type: "file",
        encoding: "base64",
        content: githubBase64(big)
      });

    const result = await githubAdapter.readFileAtRef(ctx, {
      path: "requirements.txt",
      ref: "main",
      maxBytes: 1024
    });
    expect(result).toMatchObject({ outcome: "refused", reason: "too_large", sizeBytes: 4096 });
  });

  // -----------------------------------------------------------------------------------------
  // THE TRANSPORT bound (M21.2 review MAJOR 5, closed) — a SEPARATE, larger ceiling from the
  // decode-bound `too_large` refusals above. GitHub is incidentally bounded by its OWN
  // `encoding: "none"` cutoff above 1MB (the very next test), but this adapter now sends an
  // explicit transport ceiling on every call regardless — defense in depth, not a dependency on
  // that provider behavior.
  // -----------------------------------------------------------------------------------------

  it("THROWS on a response so large it exceeds the TRANSPORT ceiling, before decodeBoundedBase64 ever runs", async () => {
    const { config, ctx, authHeader, base } = setup();
    nockResolveRef(base, authHeader, config);
    const hostileContent = "A".repeat(2_500_000);
    nock(base)
      .matchHeader("authorization", authHeader)
      .get(`/repos/${config.owner}/${config.repo}/contents/huge.bin`)
      .query({ ref: REF_COMMIT_SHA })
      .reply(200, {
        path: "huge.bin",
        sha: "blobhuge",
        type: "file",
        encoding: "base64",
        content: hostileContent
        // Deliberately NO `size` field — must be caught by the TRANSPORT bound, not gate 2.
      });

    await expect(
      githubAdapter.readFileAtRef(ctx, { path: "huge.bin", ref: "main" })
    ).rejects.toThrow(
      /github readFileAtRef: response from .* exceeded the \d+-byte transport ceiling/
    );
  });

  it('refuses GitHub\'s 1MB–100MB response shape (`content: ""`, `encoding: "none"`) as too_large, NOT as an empty file', async () => {
    const { config, ctx, authHeader, base } = setup();
    nockResolveRef(base, authHeader, config);
    nock(base)
      .matchHeader("authorization", authHeader)
      .get(`/repos/${config.owner}/${config.repo}/contents/pom.xml`)
      .query({ ref: REF_COMMIT_SHA })
      .reply(200, {
        path: "pom.xml",
        sha: "blobhuge",
        size: 8_000_000,
        type: "file",
        encoding: "none",
        content: ""
      });

    const result = await githubAdapter.readFileAtRef(ctx, { path: "pom.xml", ref: "main" });
    expect(result).toMatchObject({ outcome: "refused", reason: "too_large" });
    // The `detail` assertion is what makes this test about the ENCODING and not about the size:
    // `size: 8_000_000` alone would be refused by the size gate too, so without this the test would
    // still pass with the `encoding: "none"` handling deleted entirely (verified by mutation).
    expect((result as { detail: string }).detail).toContain('encoding "none"');
  });

  it("refuses a DIRECTORY — the same route returns a JSON array, which is the only shape difference", async () => {
    const { config, ctx, authHeader, base } = setup();
    nockResolveRef(base, authHeader, config);
    nock(base)
      .matchHeader("authorization", authHeader)
      .get(`/repos/${config.owner}/${config.repo}/contents/services`)
      .query({ ref: REF_COMMIT_SHA })
      .reply(200, [
        { name: "api", path: "services/api", type: "dir" },
        { name: "web", path: "services/web", type: "dir" }
      ]);

    const result = await githubAdapter.readFileAtRef(ctx, { path: "services", ref: "main" });
    expect(result).toMatchObject({ outcome: "refused", reason: "not_a_file" });
    // The `detail` assertion is what makes this test about the ARRAY branch. `reason` alone does
    // not: with the `Array.isArray` branch deleted the same input still yields not_a_file via the
    // type gate, because `[].type` is undefined — so both gates were individually mutation-
    // survivable and this one test covered neither (verified by mutation, M21.2 review MAJOR 4).
    // The entry COUNT is asserted for the same reason: it can only come from the array branch.
    expect((result as { detail: string }).detail).toContain(
      "is a directory (contents returned a listing of 2 entries)"
    );
  });

  it("refuses a BINARY file rather than returning replacement-character mojibake", async () => {
    const { config, ctx, authHeader, base } = setup();
    // A real PNG header — NUL bytes and invalid UTF-8, exactly what a mis-pathed read would hit.
    const png = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d
    ]);
    nockResolveRef(base, authHeader, config);
    nock(base)
      .matchHeader("authorization", authHeader)
      .get(`/repos/${config.owner}/${config.repo}/contents/logo.png`)
      .query({ ref: REF_COMMIT_SHA })
      .reply(200, {
        path: "logo.png",
        sha: "blobpng",
        size: png.byteLength,
        type: "file",
        encoding: "base64",
        content: png.toString("base64")
      });

    const result = await githubAdapter.readFileAtRef(ctx, { path: "logo.png", ref: "main" });
    expect(result).toMatchObject({ outcome: "refused", reason: "not_text" });
  });

  it("makes a REDIRECT legible instead of surfacing an anonymous HTTP 3xx", async () => {
    // Under the production plugin HTTP client a 3xx never arrives as a status (redirect:"error",
    // subprocess-entry.ts:285,295 — fetch rejects); under this suite's node:http-backed client it
    // does, since Node's core http neither follows nor errors on redirects. Both shapes must name
    // the redirect, and this covers the one that is reachable as a status.
    const { config, ctx, authHeader, base } = setup();
    nock(base)
      .matchHeader("authorization", authHeader)
      .get(`/repos/${config.owner}/${config.repo}/commits/main`)
      .reply(301, "", { location: "https://api.github.example/redirected" });

    await expect(githubAdapter.readFileAtRef(ctx, { path: "go.mod", ref: "main" })).rejects.toThrow(
      /HTTP 301.*Location: https:\/\/api\.github\.example\/redirected.*redirects are refused/s
    );
  });

  it("throws a status-bearing error for a non-2xx that is neither 404 nor a redirect (e.g. a rate limit)", async () => {
    const { config, ctx, authHeader, base } = setup();
    nock(base)
      .matchHeader("authorization", authHeader)
      .get(`/repos/${config.owner}/${config.repo}/commits/main`)
      .reply(403, { message: "API rate limit exceeded." });

    await expect(githubAdapter.readFileAtRef(ctx, { path: "go.mod", ref: "main" })).rejects.toThrow(
      /HTTP 403/
    );
  });

  it("refuses a path-traversal BEFORE any HTTP happens — a '..' segment re-targets the REST route", async () => {
    const { ctx } = setup();
    // NEGATIVE CONTROL: not even the installation-token fixture is consumed here, which the
    // file-wide afterEach checks — proving the refusal is pre-flight, not post-response.
    await expect(
      githubAdapter.readFileAtRef(ctx, { path: "../../user", ref: "main" })
    ).rejects.toThrow(
      /github readFileAtRef: path '\.\.\/\.\.\/user' contains a '\.'\/'\.\.' segment/
    );
    nock.cleanAll();
  });

  it("honors an explicit `repo` override so one binding can read manifests for sibling components", async () => {
    const { config, ctx, authHeader, base } = setup({ owner: "acme", repo: "widgets" });
    expect(`${config.owner}/${config.repo}`).toBe("acme/widgets"); // the binding's own repo
    nock(base)
      .matchHeader("authorization", authHeader)
      .get(`/repos/acme/other-service/commits/main`)
      .reply(200, { sha: REF_COMMIT_SHA });
    nock(base)
      .matchHeader("authorization", authHeader)
      .get(`/repos/acme/other-service/contents/go.mod`)
      .query({ ref: REF_COMMIT_SHA })
      .reply(200, {
        path: "go.mod",
        sha: "blobother",
        size: 21,
        type: "file",
        encoding: "base64",
        content: githubBase64("module example.com/y\n")
      });

    const result = await githubAdapter.readFileAtRef(ctx, {
      repo: "acme/other-service",
      path: "go.mod",
      ref: "main"
    });
    expect(result).toMatchObject({ outcome: "found", content: "module example.com/y\n" });
  });

  // -----------------------------------------------------------------------------------------
  // ADVERSARIAL `ref` and `repo` (M21.2 review, BLOCKERS 1 and 2). Both were REACHABLE: `ref` was
  // only percent-encoded per segment, and `encodeURIComponent("..") === ".."`; `repo` was spliced
  // in raw — neither validated nor encoded. Each test below is a NEGATIVE CONTROL in the strongest
  // available sense: `nock.disableNetConnect()` is on for the whole file and NO interceptor is
  // registered, so if the refusal ever stops happening pre-flight the adapter's request escapes as
  // a "no match for request" rejection with a URL in it — which is exactly what these assert
  // against, since the message is asserted, not merely the fact of a throw.
  // -----------------------------------------------------------------------------------------

  it("refuses a REF traversal BEFORE any HTTP — `encodeURIComponent('..')` is '..', so encoding never closed this", async () => {
    const { ctx } = setup();
    // Proven reachable before the fix: this exact call issued
    // `GET https://api.github.com/user` — a different endpoint, with the installation token.
    await expect(
      githubAdapter.readFileAtRef(ctx, { path: "package.json", ref: "../../../../user" })
    ).rejects.toThrow(/^github readFileAtRef: ref '\.\.\/\.\.\/\.\.\/\.\.\/user' contains '\.\.'/);
    nock.cleanAll();
  });

  it("refuses the other git-forbidden REF shapes before any HTTP (space, ~^:?*[\\, '@{', trailing '.')", async () => {
    const { ctx } = setup();
    for (const ref of ["main ", "ma?in", "main~1", "HEAD@{1}", "main.", "/main"]) {
      await expect(
        githubAdapter.readFileAtRef(ctx, { path: "package.json", ref }),
        ref
      ).rejects.toThrow(/^github readFileAtRef: ref /);
    }
    nock.cleanAll();
  });

  it("refuses a REPO traversal BEFORE any HTTP — a raw `repo` re-targeted the route", async () => {
    const { ctx } = setup();
    // Proven reachable before the fix: issued `GET https://api.github.com/commits/main`.
    await expect(
      githubAdapter.readFileAtRef(ctx, {
        repo: "acme/widgets/../../..",
        path: "package.json",
        ref: "main"
      })
    ).rejects.toThrow(
      /^github readFileAtRef: repo 'acme\/widgets\/\.\.\/\.\.\/\.\.' contains a '\.'\/'\.\.' segment/
    );
    nock.cleanAll();
  });

  it("refuses a REPO containing '?' — it terminated the route and folded the rest into a query string", async () => {
    const { ctx } = setup();
    // Proven reachable before the fix: issued
    // `GET https://api.github.com/repos/acme/widgets?x=/commits/main`.
    await expect(
      githubAdapter.readFileAtRef(ctx, {
        repo: "acme/widgets?x=",
        path: "package.json",
        ref: "main"
      })
    ).rejects.toThrow(/^github readFileAtRef: repo 'acme\/widgets\?x=' has a segment/);
    nock.cleanAll();
  });

  it("refuses a REPO that is not exactly `owner/repo` — github has no other shape", async () => {
    const { ctx } = setup();
    for (const repo of ["widgets", "acme/group/widgets"]) {
      await expect(
        githubAdapter.readFileAtRef(ctx, { repo, path: "package.json", ref: "main" }),
        repo
      ).rejects.toThrow(/exactly 2 '\/'-separated segments/);
    }
    nock.cleanAll();
  });

  // -----------------------------------------------------------------------------------------
  // The two `not_a_file` gates, pinned INDEPENDENTLY (M21.2 review, MAJORS 3 and 4). They are
  // separate branches over the same route: a directory arrives as an ARRAY, a symlink/submodule as
  // an OBJECT with a non-`file` `type`. Asserting only `reason: "not_a_file"` covers neither —
  // deleting the array branch still yields not_a_file via the type gate (`[].type` is undefined),
  // and deleting the type gate leaves a symlink decoding to `content: ""`, i.e. a silently EMPTY
  // manifest that downstream reads as "this component declares no dependencies". The `detail`
  // string is the only thing that separates them, so both tests assert it — the same technique the
  // `encoding: "none"` test above already uses.
  // -----------------------------------------------------------------------------------------

  it("refuses a SYMLINK as not_a_file rather than decoding it to an empty manifest", async () => {
    const { config, ctx, authHeader, base } = setup();
    nockResolveRef(base, authHeader, config);
    nock(base)
      .matchHeader("authorization", authHeader)
      .get(`/repos/${config.owner}/${config.repo}/contents/go.mod`)
      .query({ ref: REF_COMMIT_SHA })
      // GitHub's documented symlink shape: no `content`, no `encoding`, `target` instead.
      .reply(200, {
        name: "go.mod",
        path: "go.mod",
        sha: "blobsym",
        size: 0,
        type: "symlink",
        target: "../shared/go.mod"
      });

    const result = await githubAdapter.readFileAtRef(ctx, { path: "go.mod", ref: "main" });
    expect(result).toMatchObject({ outcome: "refused", reason: "not_a_file" });
    // Pins the TYPE gate specifically: without it this decodes `content ?? ""` to a found/empty
    // file, and with only the array gate left the detail would name a directory instead.
    expect((result as { detail: string }).detail).toContain("content type 'symlink'");
  });

  it("refuses a SUBMODULE as not_a_file — the other non-blob `type` github serves from this route", async () => {
    const { config, ctx, authHeader, base } = setup();
    nockResolveRef(base, authHeader, config);
    nock(base)
      .matchHeader("authorization", authHeader)
      .get(`/repos/${config.owner}/${config.repo}/contents/vendor/lib`)
      .query({ ref: REF_COMMIT_SHA })
      .reply(200, {
        path: "vendor/lib",
        sha: "submod",
        type: "submodule",
        submodule_git_url: "https://github.example/acme/lib.git"
      });

    const result = await githubAdapter.readFileAtRef(ctx, { path: "vendor/lib", ref: "main" });
    expect(result).toMatchObject({ outcome: "refused", reason: "not_a_file" });
    expect((result as { detail: string }).detail).toContain("content type 'submodule'");
  });

  // -----------------------------------------------------------------------------------------
  // Two documented promises that no test held (M21.2 review, MINOR 6).
  // -----------------------------------------------------------------------------------------

  it("NEVER fabricates `blobSha` — a response without one comes back without one", async () => {
    // read-file.ts's `ReadFileAtRefFound.blobSha` says "never fabricated when it did not"; a
    // `entry.sha ?? "unknown"` mutation survived every other test in this file.
    const { config, ctx, authHeader, base } = setup();
    const manifest = "module example.com/x\n";
    nockResolveRef(base, authHeader, config);
    nock(base)
      .matchHeader("authorization", authHeader)
      .get(`/repos/${config.owner}/${config.repo}/contents/go.mod`)
      .query({ ref: REF_COMMIT_SHA })
      .reply(200, {
        path: "go.mod",
        // no `sha` at all
        size: Buffer.byteLength(manifest, "utf8"),
        type: "file",
        encoding: "base64",
        content: githubBase64(manifest)
      });

    const result = await githubAdapter.readFileAtRef(ctx, { path: "go.mod", ref: "main" });
    expect(result).toMatchObject({ outcome: "found", content: manifest });
    expect((result as { blobSha?: string }).blobSha).toBeUndefined();
  });

  it("REFUSES to report a commit it did not resolve — a commits response with no `sha` throws, it does not read at `undefined`", async () => {
    // Without the guard the adapter reads `?ref=undefined` and returns `commitSha: undefined`,
    // which is the one field an inventory row is supposed to be able to trust (ADR-0032 §7: a
    // branch name is not an identity). No contents interceptor is registered, so the mutated code
    // fails on a nock no-match with a URL in it — the message assertion is what distinguishes them.
    const { config, ctx, authHeader, base } = setup();
    nock(base)
      .matchHeader("authorization", authHeader)
      .get(`/repos/${config.owner}/${config.repo}/commits/main`)
      .reply(200, { commit: { message: "chore: bump" } });

    await expect(githubAdapter.readFileAtRef(ctx, { path: "go.mod", ref: "main" })).rejects.toThrow(
      /carried no sha — refusing to report a resolved commit this call did not actually resolve/
    );
  });
});

// -------------------------------------------------------------------------------------------
// readFilesAtRef (team-pipeline-iac proposal §12) — bounded multi-file/tree reads. GitHub's
// recursive tree listing (`GET .../git/trees/{sha}?recursive=1`) is one response, `truncated:
// true` when it hit GitHub's own ceiling.
// -------------------------------------------------------------------------------------------

describe("readFilesAtRef()", () => {
  const TREE_COMMIT_SHA = "6f".repeat(20);

  /** GitHub wraps contents base64 at 60 chars with `\n`. Fixtures do the same (see
   *  `readFileAtRef()`'s own `githubBase64` — a separate `describe` scope, hence duplicated). */
  function githubBase64(text: string): string {
    const flat = Buffer.from(text, "utf8").toString("base64");
    return (flat.match(/.{1,60}/g) ?? []).join("\n");
  }

  function nockResolveTreeRef(base: string, authHeader: string, config: GithubConfig) {
    return nock(base)
      .matchHeader("authorization", authHeader)
      .get(`/repos/${config.owner}/${config.repo}/commits/main`)
      .reply(200, { sha: TREE_COMMIT_SHA });
  }

  it("lists the tree ONCE, matches globs, and reads every matched file at the SAME resolved commit", async () => {
    const { config, ctx, authHeader, base } = setup();
    nockResolveTreeRef(base, authHeader, config);
    nock(base)
      .matchHeader("authorization", authHeader)
      .get(`/repos/${config.owner}/${config.repo}/git/trees/${TREE_COMMIT_SHA}`)
      .query({ recursive: "1" })
      .reply(200, {
        tree: [
          { path: "service-a", type: "tree" },
          { path: "service-a/go.mod", type: "blob" },
          { path: "service-a/main.go", type: "blob" },
          { path: "service-b", type: "tree" },
          { path: "service-b/package.json", type: "blob" },
          { path: "README.md", type: "blob" }
        ],
        truncated: false
      });
    nock(base)
      .matchHeader("authorization", authHeader)
      .get(`/repos/${config.owner}/${config.repo}/contents/service-a/go.mod`)
      .query({ ref: TREE_COMMIT_SHA })
      .reply(200, {
        path: "service-a/go.mod",
        sha: "blobgomod",
        type: "file",
        size: 18,
        encoding: "base64",
        content: githubBase64("module a\n\ngo 1.22\n")
      });
    nock(base)
      .matchHeader("authorization", authHeader)
      .get(`/repos/${config.owner}/${config.repo}/contents/service-b/package.json`)
      .query({ ref: TREE_COMMIT_SHA })
      .reply(200, {
        path: "service-b/package.json",
        sha: "blobpkg",
        type: "file",
        size: 2,
        encoding: "base64",
        content: githubBase64("{}")
      });

    const result = await githubAdapter.readFilesAtRef(ctx, {
      ref: "main",
      globs: ["**/go.mod", "**/package.json"]
    });

    expect(result.outcome).toBe("found");
    if (result.outcome !== "found") throw new Error("unreachable");
    expect(result.commitSha).toBe(TREE_COMMIT_SHA);
    expect(result.files.map((f) => f.path).sort()).toEqual([
      "service-a/go.mod",
      "service-b/package.json"
    ]);
    for (const file of result.files) {
      expect(file.result.outcome).toBe("found");
      if (file.result.outcome !== "found") throw new Error("unreachable");
      expect(file.result.commitSha).toBe(TREE_COMMIT_SHA);
    }
  });

  it("refuses an EMPTY globs array before any HTTP happens", async () => {
    // Deliberately NOT `setup()`: that helper pre-registers the installation-token nock every
    // OTHER test in this file consumes via `getInstallationToken`, but this call refuses before
    // ANY HTTP (including the token exchange), so a pre-registered-but-uncalled interceptor would
    // fail the file-wide `afterEach` for the wrong reason.
    const ctx = buildTestCtx(buildGithubConfig());
    await expect(githubAdapter.readFilesAtRef(ctx, { ref: "main", globs: [] })).rejects.toThrow(
      /github readFilesAtRef: globs must be a non-empty array/
    );
  });

  it("a single OVERSIZE matched file is a routine per-file `refused` entry, not a batch failure", async () => {
    const { config, ctx, authHeader, base } = setup();
    nockResolveTreeRef(base, authHeader, config);
    nock(base)
      .matchHeader("authorization", authHeader)
      .get(`/repos/${config.owner}/${config.repo}/git/trees/${TREE_COMMIT_SHA}`)
      .query({ recursive: "1" })
      .reply(200, { tree: [{ path: "package.json", type: "blob" }], truncated: false });
    nock(base)
      .matchHeader("authorization", authHeader)
      .get(`/repos/${config.owner}/${config.repo}/contents/package.json`)
      .query({ ref: TREE_COMMIT_SHA })
      .reply(200, {
        path: "package.json",
        sha: "blobbig",
        type: "file",
        size: 9_000_000,
        encoding: "base64",
        content: githubBase64("{}")
      });

    const result = await githubAdapter.readFilesAtRef(ctx, {
      ref: "main",
      globs: ["package.json"]
    });
    expect(result.outcome).toBe("found");
    if (result.outcome !== "found") throw new Error("unreachable");
    expect(result.files).toEqual([
      {
        path: "package.json",
        result: expect.objectContaining({ outcome: "refused", reason: "too_large" })
      }
    ]);
  });

  it("THROWS a typed GitProviderTreeBoundError when matched files exceed maxFiles — loud, not a silent first-N", async () => {
    const { config, ctx, authHeader, base } = setup();
    nockResolveTreeRef(base, authHeader, config);
    nock(base)
      .matchHeader("authorization", authHeader)
      .get(`/repos/${config.owner}/${config.repo}/git/trees/${TREE_COMMIT_SHA}`)
      .query({ recursive: "1" })
      .reply(200, {
        tree: [
          { path: "a/go.mod", type: "blob" },
          { path: "b/go.mod", type: "blob" },
          { path: "c/go.mod", type: "blob" }
        ],
        truncated: false
      });
    // NEGATIVE CONTROL: no `contents` interceptor registered.

    await expect(
      githubAdapter.readFilesAtRef(ctx, { ref: "main", globs: ["**/go.mod"], maxFiles: 2 })
    ).rejects.toThrow(/github readFilesAtRef: exceeded maxFiles \(2\)/);
  });

  it("THROWS a typed GitProviderTreeBoundError when cumulative bytes exceed maxTotalBytes", async () => {
    const { config, ctx, authHeader, base } = setup();
    nockResolveTreeRef(base, authHeader, config);
    nock(base)
      .matchHeader("authorization", authHeader)
      .get(`/repos/${config.owner}/${config.repo}/git/trees/${TREE_COMMIT_SHA}`)
      .query({ recursive: "1" })
      .reply(200, {
        tree: [
          { path: "a.txt", type: "blob" },
          { path: "b.txt", type: "blob" }
        ],
        truncated: false
      });
    const chunk = "x".repeat(600);
    nock(base)
      .matchHeader("authorization", authHeader)
      .get(`/repos/${config.owner}/${config.repo}/contents/a.txt`)
      .query({ ref: TREE_COMMIT_SHA })
      .reply(200, {
        path: "a.txt",
        sha: "bloba",
        type: "file",
        size: 600,
        encoding: "base64",
        content: githubBase64(chunk)
      });
    nock(base)
      .matchHeader("authorization", authHeader)
      .get(`/repos/${config.owner}/${config.repo}/contents/b.txt`)
      .query({ ref: TREE_COMMIT_SHA })
      .reply(200, {
        path: "b.txt",
        sha: "blobb",
        type: "file",
        size: 600,
        encoding: "base64",
        content: githubBase64(chunk)
      });

    await expect(
      githubAdapter.readFilesAtRef(ctx, { ref: "main", globs: ["*.txt"], maxTotalBytes: 1000 })
    ).rejects.toThrow(/github readFilesAtRef: exceeded maxTotalBytes \(1000\)/);
  });

  it("THROWS a typed GitProviderTreeBoundError when GitHub's OWN listing reports truncated:true", async () => {
    const { config, ctx, authHeader, base } = setup();
    nockResolveTreeRef(base, authHeader, config);
    nock(base)
      .matchHeader("authorization", authHeader)
      .get(`/repos/${config.owner}/${config.repo}/git/trees/${TREE_COMMIT_SHA}`)
      .query({ recursive: "1" })
      .reply(200, { tree: [{ path: "go.mod", type: "blob" }], truncated: true });

    await expect(
      githubAdapter.readFilesAtRef(ctx, { ref: "main", globs: ["**/go.mod"] })
    ).rejects.toThrow(/github readFilesAtRef: exceeded maxEntriesScanned/);
  });

  it("an unresolvable ref is not_found, same shape as readFileAtRef's", async () => {
    const { config, ctx, authHeader, base } = setup();
    nock(base)
      .matchHeader("authorization", authHeader)
      .get(`/repos/${config.owner}/${config.repo}/commits/no-such-branch`)
      .reply(404, { message: "Not Found" });

    const result = await githubAdapter.readFilesAtRef(ctx, {
      ref: "no-such-branch",
      globs: ["**/go.mod"]
    });
    expect(result).toMatchObject({ outcome: "not_found", missing: "ref" });
  });
});

/**
 * ============================================================================================
 * THIS ADAPTER WRITES NOTHING (owner decision 2026-08-15; ADR-0032 §9)
 * ============================================================================================
 * ADR-0032 §9 admits `GitProviderAdapter` as an escape hatch on two grounds — the `ExecutorPlugin`
 * object is unchanged, and "It also only READS." M21.5 briefly grew branch/commit/pull-request
 * hooks on all three providers, which contradicts the second ground. The repository-write authority
 * now lives inside the enumerated `scp-managed-dep` class (`packages/plugins/managed-dep`), where
 * the charter's containment preconditions bind.
 *
 * `@scp/git-provider-core`'s own suite pins the INTERFACE at the type level. This pins the OBJECT,
 * here, because the interface is structural: an adapter carrying extra write methods still
 * satisfies it, so the type-level pin alone would not notice a hook re-added to this file. Asserted
 * per provider rather than once, because the hooks existed on all three — the census is the point
 * (CLAUDE.md: fix the property, then find every place with it).
 */
describe("github adapter surface — read-only", () => {
  it("carries no repository-write hook, and still carries the read hook", () => {
    for (const hook of ["createBranch", "putFileOnBranch", "openPullRequest"]) {
      expect(hook in githubAdapter, `${hook} must not be on the github adapter`).toBe(false);
    }
    expect(typeof githubAdapter.readFileAtRef).toBe("function");
    expect(typeof githubAdapter.readFilesAtRef).toBe("function");
  });
});
