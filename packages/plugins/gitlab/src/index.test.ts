/**
 * `@scp/plugin-gitlab` behavioral test suite (M15.3b). Every HTTP call is fixtured deterministically
 * with `nock` against Node's `http`/`https` core modules (see `gitlab-test-support.ts`'s module doc
 * for why the `ScopedHttpClient` uses `node:https` directly, not `fetch`). `nock.disableNetConnect()`
 * is active file-wide so any unanticipated call fails loudly rather than reaching the real network
 * (CLAUDE.md: "Tests never touch the internet"). Each test's interceptors are checked for full
 * consumption by the file-wide `afterEach` (`nock.pendingMocks()` must be empty).
 *
 * These assert REAL GitLab wire shapes, not tautologies: the auth header is `PRIVATE-TOKEN: <PAT>`
 * (NOT github's Bearer, NOT gitea's `token`), the base is `/api/v4`, the project id is the
 * URL-encoded `owner%2Frepo`, create-pipeline returns the pipeline object (with its id) SYNCHRONOUSLY
 * (no dispatch-then-poll dance), status is a single GitLab enum, and the webhook is authenticated by
 * a PLAINTEXT `X-Gitlab-Token` shared secret (NOT an HMAC signature).
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import nock from "nock";
import {
  createGitlabDiscoveryPlugin,
  createGitlabExecutorPlugin,
  gitlabAdapter,
  mapGitlabWebhookEventToHint,
  verifyGitlabWebhookToken,
  type GitlabConfig
} from "./index.js";
import {
  apiBase,
  buildGitlabConfig,
  buildTestCtx,
  projectIdOf,
  tokenHeaderFor
} from "./gitlab-test-support.js";

const plugin = createGitlabExecutorPlugin();
const discoveryPlugin = createGitlabDiscoveryPlugin();

function setup(overrides: Partial<GitlabConfig> = {}) {
  const config = buildGitlabConfig(overrides);
  const ctx = buildTestCtx(config);
  return {
    config,
    ctx,
    token: tokenHeaderFor(config),
    base: apiBase(config),
    pid: projectIdOf(config)
  };
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
// verifyGitlabWebhookToken — PLAINTEXT X-Gitlab-Token (NOT an HMAC). Pure function.
// -------------------------------------------------------------------------------------------

describe("verifyGitlabWebhookToken (plaintext X-Gitlab-Token equality)", () => {
  const secret = "gitlab-webhook-secret";
  const body = Buffer.from(JSON.stringify({ object_kind: "push" }));

  it("accepts the exact configured token (body is irrelevant — no HMAC)", () => {
    expect(verifyGitlabWebhookToken(body, secret, secret)).toBe(true);
  });

  it("accepts even when the body differs — GitLab does NOT sign the body", () => {
    const otherBody = Buffer.from(JSON.stringify({ object_kind: "merge_request" }));
    expect(verifyGitlabWebhookToken(otherBody, secret, secret)).toBe(true);
  });

  it("rejects a token that does not match the configured secret", () => {
    expect(verifyGitlabWebhookToken(body, "wrong-token", secret)).toBe(false);
  });

  it("rejects a token of a DIFFERENT length (length guard, fail-closed not thrown)", () => {
    expect(() => verifyGitlabWebhookToken(body, "short", secret)).not.toThrow();
    expect(verifyGitlabWebhookToken(body, "short", secret)).toBe(false);
  });

  it("rejects a github-style sha256=<hex> HMAC value — that is NOT a GitLab token", () => {
    expect(verifyGitlabWebhookToken(body, `sha256=${"a".repeat(64)}`, secret)).toBe(false);
  });

  it("rejects when the token header is missing entirely", () => {
    expect(verifyGitlabWebhookToken(body, undefined, secret)).toBe(false);
  });
});

// -------------------------------------------------------------------------------------------
// mapGitlabWebhookEventToHint — pure function (X-Gitlab-Event names + GitLab payload paths).
// -------------------------------------------------------------------------------------------

describe("mapGitlabWebhookEventToHint", () => {
  it("maps a Push Hook to repo (path_with_namespace) / checkout_sha / ref", () => {
    expect(
      mapGitlabWebhookEventToHint("Push Hook", {
        object_kind: "push",
        ref: "refs/heads/main",
        checkout_sha: "1".repeat(40),
        project: { path_with_namespace: "acme/widgets" }
      })
    ).toEqual({
      repo: "acme/widgets",
      commitSha: "1".repeat(40),
      correlationKey: "refs/heads/main",
      ref: "refs/heads/main"
    });
  });

  it("maps a Tag Push Hook the same way (checkout_sha + tag ref)", () => {
    expect(
      mapGitlabWebhookEventToHint("Tag Push Hook", {
        object_kind: "tag_push",
        ref: "refs/tags/v2.0.0",
        checkout_sha: "2".repeat(40),
        project: { path_with_namespace: "acme/widgets" }
      })
    ).toEqual({
      repo: "acme/widgets",
      commitSha: "2".repeat(40),
      correlationKey: "refs/tags/v2.0.0",
      ref: "refs/tags/v2.0.0"
    });
  });

  it("maps a Merge Request Hook using object_attributes.iid + last_commit.id", () => {
    expect(
      mapGitlabWebhookEventToHint("Merge Request Hook", {
        object_kind: "merge_request",
        object_attributes: { iid: 7, last_commit: { id: "3".repeat(40) } },
        project: { path_with_namespace: "acme/widgets" }
      })
    ).toEqual({ repo: "acme/widgets", commitSha: "3".repeat(40), correlationKey: "mr-7" });
  });

  it("maps a Pipeline Hook using object_attributes.id + sha", () => {
    expect(
      mapGitlabWebhookEventToHint("Pipeline Hook", {
        object_kind: "pipeline",
        object_attributes: { id: 42, sha: "4".repeat(40), ref: "main" },
        project: { path_with_namespace: "acme/widgets" }
      })
    ).toEqual({ repo: "acme/widgets", commitSha: "4".repeat(40), correlationKey: "pipeline-42" });
  });

  it("returns null for an unrecognized event name", () => {
    expect(mapGitlabWebhookEventToHint("Issue Hook", {})).toBeNull();
    expect(
      mapGitlabWebhookEventToHint("Note Hook", { project: { path_with_namespace: "a/b" } })
    ).toBeNull();
  });
});

// -------------------------------------------------------------------------------------------
// trigger() — create pipeline (GitLab returns the pipeline id SYNCHRONOUSLY; no poll-to-correlate).
// -------------------------------------------------------------------------------------------

describe("trigger() — create pipeline (synchronous id, no correlation poll)", () => {
  it("POSTs the pipeline on the URL-encoded project id, returns pipeline::<id> DIRECTLY, and carries the PRIVATE-TOKEN header", async () => {
    const { config, ctx, token, base, pid } = setup();
    const pipelineId = 5150;
    const webUrl = `${config.baseUrl}/acme/widgets/-/pipelines/${pipelineId}`;
    const scope = nock(base)
      .matchHeader("private-token", token)
      .post(`/projects/${pid}/pipeline`, { ref: "main" })
      .reply(201, { id: pipelineId, status: "created", sha: "a".repeat(40), web_url: webUrl });

    const ref = await plugin.trigger(ctx, { kind: "workflow_dispatch" });
    expect(ref.externalId).toBe(`pipeline::${pipelineId}`);
    expect(ref.url).toBe(webUrl);
    scope.done();
    // A single POST — no runs-list GET was needed (the whole point vs. github/gitea).
    expect(nock.pendingMocks()).toEqual([]);
  });

  it("uses intent.parameters.ref and sends variables as a [{key,value}] array", async () => {
    const { ctx, token, base, pid } = setup();
    const pipelineId = 909;
    const scope = nock(base)
      .matchHeader("private-token", token)
      .post(`/projects/${pid}/pipeline`, {
        ref: "release/1.0",
        variables: [{ key: "ENVIRONMENT", value: "staging" }]
      })
      .reply(201, { id: pipelineId, status: "pending" });

    const ref = await plugin.trigger(ctx, {
      kind: "workflow_dispatch",
      parameters: { ref: "release/1.0", variables: { ENVIRONMENT: "staging" } }
    });
    expect(ref.externalId).toBe(`pipeline::${pipelineId}`);
    scope.done();
  });

  it("falls back to config.defaultRef when parameters.ref is absent", async () => {
    const { ctx, token, base, pid } = setup({ defaultRef: "develop" });
    const scope = nock(base)
      .matchHeader("private-token", token)
      .post(`/projects/${pid}/pipeline`, { ref: "develop" })
      .reply(201, { id: 1, status: "created" });

    const ref = await plugin.trigger(ctx, { kind: "workflow_dispatch" });
    expect(ref.externalId).toBe("pipeline::1");
    scope.done();
  });

  it("throws a clear HTTP-status-bearing Error on a non-2xx create", async () => {
    const { ctx, token, base, pid } = setup();
    nock(base)
      .matchHeader("private-token", token)
      .post(`/projects/${pid}/pipeline`)
      .reply(400, { message: "reference not found" });
    await expect(plugin.trigger(ctx, { kind: "workflow_dispatch" })).rejects.toThrow(/HTTP 400/);
  });

  it("resolves the PAT from ctx.secrets when only tokenSecretKey is configured", async () => {
    const config = buildGitlabConfig({ tokenPlaintext: undefined, tokenSecretKey: "gitlab-pat" });
    const ctx = buildTestCtx(config, { secrets: { "gitlab-pat": "resolved-secret-pat" } });
    const scope = nock(apiBase(config))
      .matchHeader("private-token", "resolved-secret-pat")
      .post(`/projects/${projectIdOf(config)}/pipeline`, { ref: "main" })
      .reply(201, { id: 77, status: "running" });

    const ref = await plugin.trigger(ctx, { kind: "workflow_dispatch" });
    expect(ref.externalId).toBe("pipeline::77");
    scope.done();
  });

  it("addresses via owner+repo when no projectPath is set (owner%2Frepo id)", async () => {
    const config = buildGitlabConfig({ projectPath: undefined, owner: "grp", repo: "svc" });
    const ctx = buildTestCtx(config);
    expect(projectIdOf(config)).toBe("grp%2Fsvc");
    const scope = nock(apiBase(config))
      .matchHeader("private-token", tokenHeaderFor(config))
      .post(`/projects/grp%2Fsvc/pipeline`, { ref: "main" })
      .reply(201, { id: 3, status: "created" });

    const ref = await plugin.trigger(ctx, { kind: "workflow_dispatch" });
    expect(ref.externalId).toBe("pipeline::3");
    scope.done();
  });
});

// -------------------------------------------------------------------------------------------
// trigger() idempotency — the core's dedup cache still wraps GitLab's own triggerCI.
// -------------------------------------------------------------------------------------------

describe("trigger() idempotency", () => {
  it("a second trigger() with the SAME idempotencyKey returns the SAME ref and never re-creates", async () => {
    const { ctx, token, base, pid } = setup();
    const pipelineId = 7001;
    const scope = nock(base)
      .matchHeader("private-token", token)
      .post(`/projects/${pid}/pipeline`)
      .reply(201, { id: pipelineId, status: "running" });

    const intent = { kind: "workflow_dispatch" as const, idempotencyKey: `mem-${randomKey()}` };
    const first = await plugin.trigger(ctx, intent);
    expect(first.externalId).toBe(`pipeline::${pipelineId}`);
    scope.done();

    // Second call: no interceptors remain + net-connect disabled → a re-create would throw.
    const second = await plugin.trigger(ctx, intent);
    expect(second.externalId).toBe(first.externalId);
  });

  describe("file-backed dedup cache", () => {
    let dir: string;
    let statePath: string;

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), "scp-gitlab-test-"));
      statePath = join(dir, "state.json");
    });
    afterEach(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    it("a second trigger() re-reads the on-disk cache and never re-creates", async () => {
      const { ctx, token, base, pid } = setup({ statePath });
      const pipelineId = 7002;
      const scope = nock(base)
        .matchHeader("private-token", token)
        .post(`/projects/${pid}/pipeline`)
        .reply(201, { id: pipelineId, status: "running" });

      const intent = { kind: "workflow_dispatch" as const, idempotencyKey: "file-backed-key" };
      const first = await plugin.trigger(ctx, intent);
      scope.done();

      const persisted = JSON.parse(await readFile(statePath, "utf8")) as {
        keys: Record<string, { externalId: string }>;
      };
      expect(persisted.keys["file-backed-key"]?.externalId).toBe(first.externalId);

      const second = await plugin.trigger(ctx, intent);
      expect(second.externalId).toBe(first.externalId);
    });
  });
});

// -------------------------------------------------------------------------------------------
// status() — GitLab's SINGLE pipeline status enum → phase.
// -------------------------------------------------------------------------------------------

describe("status() — single GitLab pipeline status enum", () => {
  async function statusFor(pipelineStatus: string) {
    const { ctx, token, base, pid } = setup();
    const pipelineId = Math.floor(Math.random() * 1_000_000) + 1;
    nock(base)
      .matchHeader("private-token", token)
      .get(`/projects/${pid}/pipelines/${pipelineId}`)
      .reply(200, { id: pipelineId, status: pipelineStatus, sha: "8".repeat(40) });
    return plugin.status(ctx, { externalId: `pipeline::${pipelineId}` });
  }

  it("running -> running (progress 0.5)", async () => {
    const s = await statusFor("running");
    expect(s.phase).toBe("running");
    expect(s.progress).toBe(0.5);
  });
  it("pending -> pending (progress 0)", async () => {
    const s = await statusFor("pending");
    expect(s.phase).toBe("pending");
    expect(s.progress).toBe(0);
  });
  it("created -> pending", async () => expect((await statusFor("created")).phase).toBe("pending"));
  it("manual -> pending", async () => expect((await statusFor("manual")).phase).toBe("pending"));
  it("success -> succeeded (progress 1)", async () => {
    const s = await statusFor("success");
    expect(s.phase).toBe("succeeded");
    expect(s.progress).toBe(1);
  });
  it("failed -> failed", async () => expect((await statusFor("failed")).phase).toBe("failed"));
  it("skipped -> failed", async () => expect((await statusFor("skipped")).phase).toBe("failed"));
  it("canceled -> aborted", async () =>
    expect((await statusFor("canceled")).phase).toBe("aborted"));
  it("an unknown status maps to running (safe default, not a crash)", async () =>
    expect((await statusFor("some-future-status")).phase).toBe("running"));

  it("an uncorrelated ref reports pending WITHOUT any HTTP call", async () => {
    const ctx = buildTestCtx(buildGitlabConfig());
    const s = await plugin.status(ctx, { externalId: "pipeline_dispatch::key" });
    expect(s.phase).toBe("pending");
  });

  it("a non-2xx status response throws a clear HTTP-status-bearing Error", async () => {
    const { ctx, token, base, pid } = setup();
    nock(base)
      .matchHeader("private-token", token)
      .get(`/projects/${pid}/pipelines/500`)
      .reply(500, { message: "boom" });
    await expect(plugin.status(ctx, { externalId: "pipeline::500" })).rejects.toThrow(/HTTP 500/);
  });

  it("ENCODES the pipelineId sliced out of externalId into the route", async () => {
    // Same census class as readFileAtRef's `repo`/`ref` (M21.2 review BLOCKERS 1-2) and github's
    // `postCommitStatus` sha: a non-literal string spliced into a REST route. `externalId` is
    // stored correlation state and numeric in practice, so this encoding is an IDENTITY today and
    // its removal would change no observed behaviour — which is exactly why it is pinned. An
    // unpinned member of a censused class is indistinguishable from an untouched one on the next
    // refactor (CLAUDE.md, "census by property, not by symptom"). Unencoded, `../../../user`
    // re-targets this GET at `<base>/user` because `new URL()` collapses literal `..` segments;
    // encoded it is `..%2F..%2F..%2Fuser`, ONE segment a URL does not normalize away. The
    // interceptor matches only the encoded form, and `disableNetConnect()` plus the file-wide
    // pending-mocks check make the unencoded form fail loudly rather than pass quietly.
    const { ctx, token, base, pid } = setup();
    const pipelineId = "../../../user";
    const scope = nock(base)
      .matchHeader("private-token", token)
      .get(`/projects/${pid}/pipelines/${encodeURIComponent(pipelineId)}`)
      .reply(200, { id: 1, status: "success", sha: "8".repeat(40) });

    const s = await plugin.status(ctx, { externalId: `pipeline::${pipelineId}` });
    expect(s.phase).toBe("succeeded");
    scope.done();
  });
});

// -------------------------------------------------------------------------------------------
// abort()
// -------------------------------------------------------------------------------------------

describe("abort()", () => {
  it("cancels a correlated pipeline", async () => {
    const { ctx, token, base, pid } = setup();
    nock(base)
      .matchHeader("private-token", token)
      .post(`/projects/${pid}/pipelines/9001/cancel`)
      .reply(200, { id: 9001, status: "canceled" });
    expect(await plugin.abort(ctx, { externalId: "pipeline::9001" })).toEqual({ aborted: true });
  });

  it("a non-2xx cancel maps to aborted:false with detail, never throws", async () => {
    const { ctx, token, base, pid } = setup();
    nock(base)
      .matchHeader("private-token", token)
      .post(`/projects/${pid}/pipelines/9002/cancel`)
      .reply(403, { message: "forbidden" });
    const r = await plugin.abort(ctx, { externalId: "pipeline::9002" });
    expect(r.aborted).toBe(false);
    expect(r.detail).toContain("403");
  });

  it("an uncorrelated ref reports aborted:false without any HTTP call", async () => {
    const ctx = buildTestCtx(buildGitlabConfig());
    expect(await plugin.abort(ctx, { externalId: "pipeline_dispatch::key" })).toEqual({
      aborted: false,
      detail: "gitlab: no correlated pipeline to cancel"
    });
  });

  it("ENCODES the pipelineId sliced out of externalId into the cancel route", async () => {
    // The second of this adapter's two `externalId`-derived route splices — see the identical pin
    // in `status()` above for why an identity-today encoding is still pinned. Unencoded this POST
    // would land on `<base>/user/cancel` rather than on the pipeline.
    const { ctx, token, base, pid } = setup();
    const pipelineId = "../../../user";
    const scope = nock(base)
      .matchHeader("private-token", token)
      .post(`/projects/${pid}/pipelines/${encodeURIComponent(pipelineId)}/cancel`)
      .reply(200, { id: 1, status: "canceled" });

    expect(await plugin.abort(ctx, { externalId: `pipeline::${pipelineId}` })).toEqual({
      aborted: true
    });
    scope.done();
  });
});

// -------------------------------------------------------------------------------------------
// observe() — commits + pipelines, and poll-vs-push equivalence.
// -------------------------------------------------------------------------------------------

describe("observe() polling — commits and pipelines", () => {
  it("maps commits (id=sha) and pipelines to well-formed ExecutorEvents", async () => {
    const { config, ctx, token, base, pid } = setup();
    const commitSha = "a1".repeat(20);
    const pipelineSha = "b2".repeat(20);
    nock(base)
      .matchHeader("private-token", token)
      .get(`/projects/${pid}/repository/commits`)
      .reply(200, [{ id: commitSha, created_at: "2026-07-01T00:00:00Z" }]);
    nock(base)
      .matchHeader("private-token", token)
      .get(`/projects/${pid}/pipelines`)
      .reply(200, [
        { id: 55, status: "success", sha: pipelineSha, updated_at: "2026-07-01T00:05:00Z" }
      ]);

    const events = await plugin.observe(ctx);
    const push = events.find((e) => e.kind === "push");
    expect(push?.correlation).toEqual({
      repo: config.projectPath,
      path: undefined,
      commitSha,
      artifactDigest: undefined,
      correlationKey: "refs/heads/*"
    });
    const run = events.find((e) => e.kind === "workflow_run");
    expect(run?.correlation.commitSha).toBe(pipelineSha);
    expect(run?.correlation.correlationKey).toBe("pipeline-55");
  });

  it("passes the cursor watermark as ?since / ?updated_after and filters older events client-side", async () => {
    const { ctx, token, base, pid } = setup();
    const since = "2026-07-01T00:00:00Z";
    nock(base)
      .matchHeader("private-token", token)
      .get(`/projects/${pid}/repository/commits`)
      .query({ since })
      .reply(200, [
        { id: "old".padEnd(40, "0"), created_at: "2026-06-01T00:00:00Z" }, // older -> filtered
        { id: "new".padEnd(40, "0"), created_at: "2026-07-02T00:00:00Z" }
      ]);
    nock(base)
      .matchHeader("private-token", token)
      .get(`/projects/${pid}/pipelines`)
      .query({ updated_after: since })
      .reply(200, []);

    const events = await plugin.observe(ctx, { token: since });
    const pushes = events.filter((e) => e.kind === "push");
    expect(pushes).toHaveLength(1);
    expect(pushes[0]?.correlation.commitSha).toBe("new".padEnd(40, "0"));
  });

  it("poll-vs-push equivalence: observe()'s polled push carries the SAME repo/commitSha the equivalent Push Hook yields", async () => {
    const commitSha = "c3".repeat(20);
    const webhookHint = mapGitlabWebhookEventToHint("Push Hook", {
      ref: "refs/heads/main",
      checkout_sha: commitSha,
      project: { path_with_namespace: "acme/widgets" }
    });
    const { ctx, token, base, pid } = setup({ projectPath: "acme/widgets" });
    nock(base)
      .matchHeader("private-token", token)
      .get(`/projects/${pid}/repository/commits`)
      .reply(200, [{ id: commitSha, created_at: "2026-07-01T00:00:00Z" }]);
    nock(base).matchHeader("private-token", token).get(`/projects/${pid}/pipelines`).reply(200, []);

    const events = await plugin.observe(ctx);
    const polledPush = events.find((e) => e.kind === "push");
    expect(polledPush?.correlation.repo).toBe(webhookHint?.repo);
    expect(polledPush?.correlation.commitSha).toBe(webhookHint?.commitSha);
  });

  it("silently skips (does not throw for) a rate-limited/non-2xx resource — the lenient observe posture", async () => {
    const { ctx, token, base, pid } = setup();
    nock(base)
      .matchHeader("private-token", token)
      .get(`/projects/${pid}/repository/commits`)
      .reply(429, { message: "rate limited" });
    nock(base).matchHeader("private-token", token).get(`/projects/${pid}/pipelines`).reply(200, []);

    await expect(plugin.observe(ctx)).resolves.toEqual([]);
  });
});

// -------------------------------------------------------------------------------------------
// Base-URL resolution (M15.3b) — explicit `baseUrl` → injected `serverUrl` (Mode A import).
// GitLab has NO provider default, so neither being set is a hard, clear error.
// -------------------------------------------------------------------------------------------

describe("base URL resolution (baseUrl → serverUrl; required, no default)", () => {
  it("with ONLY serverUrl set (no baseUrl) every request targets <serverUrl>/api/v4", async () => {
    const serverUrl = "https://gitlab.self-hosted.example";
    const { config, ctx, token, base, pid } = setup({ baseUrl: undefined, serverUrl });
    expect(config.baseUrl).toBeUndefined();
    expect(base).toBe(`${serverUrl}/api/v4`);
    const commitSha = "e5".repeat(20);
    nock(base)
      .matchHeader("private-token", token)
      .get(`/projects/${pid}/repository/commits`)
      .reply(200, [{ id: commitSha, created_at: "2026-07-01T00:00:00Z" }]);
    nock(base).matchHeader("private-token", token).get(`/projects/${pid}/pipelines`).reply(200, []);

    const events = await plugin.observe(ctx);
    expect(events.find((e) => e.kind === "push")?.correlation.commitSha).toBe(commitSha);
  });

  it("an explicit baseUrl WINS over an injected serverUrl", async () => {
    const explicit = "https://gitlab-explicit.example";
    const serverUrl = "https://gitlab-injected.example";
    const { ctx, token, base, pid } = setup({ baseUrl: explicit, serverUrl });
    expect(base).toBe(`${explicit}/api/v4`);
    nock(base)
      .matchHeader("private-token", token)
      .get(`/projects/${pid}/repository/commits`)
      .reply(200, []);
    nock(base).matchHeader("private-token", token).get(`/projects/${pid}/pipelines`).reply(200, []);

    await expect(plugin.observe(ctx)).resolves.toEqual([]);
  });

  it("throws a clear error when NEITHER baseUrl NOR serverUrl is set — no HTTP call attempted", async () => {
    const config = buildGitlabConfig({ baseUrl: undefined, serverUrl: undefined });
    const ctx = buildTestCtx(config);
    await expect(plugin.observe(ctx)).rejects.toThrow(/no base URL configured/);
  });
});

// -------------------------------------------------------------------------------------------
// discover() (DiscoveryPlugin) — GitLab repository-tree topology walk. The `sourceKind: 'gitlab'`
// on the proposed component's sourceMapping is the load-bearing assertion (matches the executor's
// source_kind so imported components correlate observed gitlab events).
// -------------------------------------------------------------------------------------------

describe("discover() (DiscoveryPlugin)", () => {
  it("proposes one Service (repo root) + one Component per marker-file-containing top-level tree; the component's sourceMapping.sourceKind is 'gitlab'; non-marker trees and blobs are skipped", async () => {
    const { config, ctx, token, base, pid } = setup({ projectPath: "acme/monorepo" });
    nock(base)
      .matchHeader("private-token", token)
      .get(`/projects/${pid}/repository/tree`)
      .query({ per_page: "100" })
      .reply(200, [
        { name: "service-a", path: "service-a", type: "tree" },
        { name: "docs", path: "docs", type: "tree" }, // tree, but no marker inside -> skipped
        { name: "README.md", path: "README.md", type: "blob" } // not a tree -> no sub-listing
      ]);
    nock(base)
      .matchHeader("private-token", token)
      .get(`/projects/${pid}/repository/tree`)
      .query({ per_page: "100", path: "service-a" })
      .reply(200, [
        { name: "go.mod", path: "service-a/go.mod", type: "blob" },
        { name: "main.go", path: "service-a/main.go", type: "blob" }
      ]);
    nock(base)
      .matchHeader("private-token", token)
      .get(`/projects/${pid}/repository/tree`)
      .query({ per_page: "100", path: "docs" })
      .reply(200, [{ name: "index.md", path: "docs/index.md", type: "blob" }]);

    const proposal = await discoveryPlugin.discover(ctx);

    const services = proposal.objects.filter((o) => o.typeId === "service");
    expect(services).toHaveLength(1);
    expect(services[0]).toMatchObject({ name: "monorepo" });

    const components = proposal.objects.filter((o) => o.typeId === "component");
    expect(components).toHaveLength(1);
    expect(components[0]?.name).toBe("service-a");
    expect(components[0]?.properties?.sourceMapping).toEqual({
      sourceKind: "gitlab",
      repoPattern: config.projectPath,
      pathPattern: "service-a/**"
    });

    // `contains`, SERVICE -> COMPONENT — the registered membership edge (migration 0021), NOT the
    // `part_of` this plugin used to emit: no migration registers that, so accept answered every
    // proposal carrying one with a 404 and the discovery relationship channel never worked.
    expect(proposal.relationships).toHaveLength(1);
    expect(proposal.relationships[0]).toEqual({
      typeId: "contains",
      fromUrn: `urn:scp:service:gitlab:${config.projectPath}`,
      toUrn: `urn:scp:component:gitlab:${config.projectPath}/service-a`
    });

    // The endpoints must be the ALIASES the proposed objects declare, asserted BY REFERENCE to
    // those objects rather than as a third copy of the literal. Restating the strings would let a
    // plugin change its URN scheme in one of the two places and stay green — and an endpoint that
    // names no proposed object is exactly the 404 (`object '...' not found`) that made this edge
    // unimportable even once its type was right.
    expect(proposal.relationships[0]?.fromUrn).toBe(services[0]?.urn);
    expect(proposal.relationships[0]?.toUrn).toBe(components[0]?.urn);
  });

  it("proposes ONLY the Service object (no components) when no top-level tree contains a marker file", async () => {
    const { ctx, token, base, pid } = setup();
    nock(base)
      .matchHeader("private-token", token)
      .get(`/projects/${pid}/repository/tree`)
      .query({ per_page: "100" })
      .reply(200, [{ name: "docs", path: "docs", type: "tree" }]);
    nock(base)
      .matchHeader("private-token", token)
      .get(`/projects/${pid}/repository/tree`)
      .query({ per_page: "100", path: "docs" })
      .reply(200, [{ name: "index.md", path: "docs/index.md", type: "blob" }]);

    const proposal = await discoveryPlugin.discover(ctx);
    expect(proposal.objects).toHaveLength(1);
    expect(proposal.objects[0]?.typeId).toBe("service");
    expect(proposal.relationships).toHaveLength(0);
  });
});

function randomKey(): string {
  return Math.random().toString(36).slice(2);
}

// -------------------------------------------------------------------------------------------
// readFileAtRef (M21.2, ADR-0032 §4) — the first file-body read in this package, and the one place
// where GitLab is genuinely NOT github/gitea-compatible. Three differences are asserted directly:
//
//   1. a different endpoint — `GET /projects/:id/repository/files/:file_path?ref=`, not `contents/`;
//   2. WHOLE-string path encoding (`services%2Fapi%2Fgo.mod`), not per-segment — a per-segment
//      encoding produces a different (non-existent) route, so the nested-path test below is the
//      proof, not decoration;
//   3. ONE call, not two — `commit_id` in the same response IS the resolved commit, so no separate
//      ref-resolution request is made (asserted by nock consuming exactly one interceptor).
//
// Field names are GitLab's documented repository-file response.
// -------------------------------------------------------------------------------------------

describe("readFileAtRef()", () => {
  const COMMIT_ID = "3d".repeat(20);
  const LAST_COMMIT_ID = "ee".repeat(20);

  it("reads a manifest in ONE call and takes `commit_id` (not `last_commit_id`) as the resolved commit", async () => {
    const { ctx, token, base, pid } = setup();
    const manifest = '{\n  "dependencies": { "left-pad": "^1.3.0" }\n}\n';
    const scope = nock(base)
      .matchHeader("private-token", token)
      .get(`/projects/${pid}/repository/files/package.json`)
      .query({ ref: "main" })
      .reply(200, {
        file_name: "package.json",
        file_path: "package.json",
        size: Buffer.byteLength(manifest, "utf8"),
        encoding: "base64",
        content: Buffer.from(manifest, "utf8").toString("base64"),
        content_sha256: "d0".repeat(32),
        ref: "main",
        blob_id: "blob0011",
        commit_id: COMMIT_ID,
        last_commit_id: LAST_COMMIT_ID,
        execute_filemode: false
      });

    const result = await gitlabAdapter.readFileAtRef(ctx, { path: "package.json", ref: "main" });

    expect(result).toEqual({
      outcome: "found",
      path: "package.json",
      requestedRef: "main",
      commitSha: COMMIT_ID,
      content: manifest,
      sizeBytes: Buffer.byteLength(manifest, "utf8"),
      blobSha: "blob0011"
    });
    // NEGATIVE CONTROL: `last_commit_id` is present in the fixture and is a DIFFERENT fact ("last
    // commit that touched this file"); picking it would still look like a sha and still pass a
    // loose assertion.
    expect((result as { commitSha: string }).commitSha).not.toBe(LAST_COMMIT_ID);
    // ONE call: the scope is fully consumed, and the file-wide afterEach proves nothing else was
    // registered or needed — there is no separate ref-resolution request on this provider.
    scope.done();
  });

  it("encodes a NESTED path WHOLE (slashes as %2F) — the per-segment form github/gitea use would be a different route", async () => {
    const { ctx, token, base, pid } = setup();
    const scope = nock(base)
      .matchHeader("private-token", token)
      .get(`/projects/${pid}/repository/files/services%2Fapi%2Fgo.mod`)
      .query({ ref: "main" })
      .reply(200, {
        file_path: "services/api/go.mod",
        size: 21,
        encoding: "base64",
        content: Buffer.from("module example.com/x\n", "utf8").toString("base64"),
        blob_id: "blobgo",
        commit_id: COMMIT_ID
      });

    const result = await gitlabAdapter.readFileAtRef(ctx, {
      path: "services/api/go.mod",
      ref: "main"
    });
    expect(result).toMatchObject({ outcome: "found", content: "module example.com/x\n" });
    scope.done();
  });

  it("ESCAPES a '#' in the REF query value — unencoded it starts a URL fragment and TRUNCATES the request", async () => {
    // The `repo` and `path` interpolations are already pinned by the two tests above (a `%2F` in
    // either changes the route). `ref` is the third, and it needed a character where the encoding
    // is load-bearing rather than identity: `git check-ref-format` permits `#` in a ref name, so
    // `assertSafeRef` does not refuse it, but unencoded it ends the URL — `?ref=release/#42` would
    // reach GitLab as `ref=release/` and resolve a DIFFERENT commit (a wrong answer, not an error).
    const { ctx, token, base, pid } = setup();
    const ref = "release/#42";
    const scope = nock(base)
      .matchHeader("private-token", token)
      .get(`/projects/${pid}/repository/files/go.mod`)
      // nock decodes before matching, so this asserts the DECODED value round-trips; the unencoded
      // form never arrives at all, its `#` having been dropped as a fragment.
      .query({ ref })
      .reply(200, {
        file_path: "go.mod",
        size: 3,
        encoding: "base64",
        content: Buffer.from("ok\n", "utf8").toString("base64"),
        blob_id: "blobhash",
        commit_id: COMMIT_ID
      });

    const result = await gitlabAdapter.readFileAtRef(ctx, { path: "go.mod", ref });
    expect(result).toMatchObject({ outcome: "found", content: "ok\n" });
    scope.done();
  });

  it("round-trips MULTI-BYTE UTF-8 content (sizeBytes counts bytes, not UTF-16 units)", async () => {
    const { ctx, token, base, pid } = setup();
    const text = 'FROM alpine:1.0\nLABEL authors="Ada — 日本語 🎉"\n';
    nock(base)
      .matchHeader("private-token", token)
      .get(`/projects/${pid}/repository/files/Dockerfile`)
      .query({ ref: "main" })
      .reply(200, {
        file_path: "Dockerfile",
        size: Buffer.byteLength(text, "utf8"),
        encoding: "base64",
        content: Buffer.from(text, "utf8").toString("base64"),
        blob_id: "blobdock",
        commit_id: COMMIT_ID
      });

    const result = await gitlabAdapter.readFileAtRef(ctx, { path: "Dockerfile", ref: "main" });
    expect(result.outcome).toBe("found");
    if (result.outcome !== "found") throw new Error("unreachable");
    expect(result.content).toBe(text);
    expect(result.sizeBytes).toBe(Buffer.byteLength(text, "utf8"));
    expect(result.sizeBytes).not.toBe(result.content.length);
  });

  it("a 404 is a routine not_found reported as missing: 'unknown', carrying GitLab's own message rather than inferring a label from it", async () => {
    const { ctx, token, base, pid } = setup();
    nock(base)
      .matchHeader("private-token", token)
      .get(`/projects/${pid}/repository/files/pom.xml`)
      .query({ ref: "main" })
      .reply(404, { message: "404 File Not Found" });

    const result = await gitlabAdapter.readFileAtRef(ctx, { path: "pom.xml", ref: "main" });
    expect(result).toMatchObject({
      outcome: "not_found",
      // NOT "path": GitLab 404s a missing file, a missing ref and an invisible project alike and
      // separates them only in prose. Claiming "path" here would be a label derived from wording.
      missing: "unknown",
      detail: "gitlab: 404 File Not Found"
    });
  });

  it("a 404 for a missing REF is the same not_found shape — the message differs, the claim does not", async () => {
    const { ctx, token, base, pid } = setup();
    nock(base)
      .matchHeader("private-token", token)
      .get(`/projects/${pid}/repository/files/go.mod`)
      .query({ ref: "no-such-branch" })
      .reply(404, { message: "404 Commit Not Found" });

    const result = await gitlabAdapter.readFileAtRef(ctx, {
      path: "go.mod",
      ref: "no-such-branch"
    });
    expect(result).toMatchObject({ outcome: "not_found", missing: "unknown" });
    expect((result as { detail?: string }).detail).toContain("Commit Not Found");
  });

  it("refuses an OVERSIZE file on GitLab's declared `size`, without decoding it", async () => {
    const { ctx, token, base, pid } = setup();
    nock(base)
      .matchHeader("private-token", token)
      .get(`/projects/${pid}/repository/files/package.json`)
      .query({ ref: "main" })
      .reply(200, {
        file_path: "package.json",
        size: 7_000_000,
        encoding: "base64",
        content: Buffer.from("{}", "utf8").toString("base64"),
        blob_id: "blobbig",
        commit_id: COMMIT_ID
      });

    const result = await gitlabAdapter.readFileAtRef(ctx, { path: "package.json", ref: "main" });
    expect(result).toMatchObject({ outcome: "refused", reason: "too_large", sizeBytes: 7_000_000 });
    expect(result.outcome).not.toBe("found");
  });

  it("refuses on the COMPUTED payload size when the declared size understates it", async () => {
    const { ctx, token, base, pid } = setup();
    const big = "x".repeat(4096);
    nock(base)
      .matchHeader("private-token", token)
      .get(`/projects/${pid}/repository/files/requirements.txt`)
      .query({ ref: "main" })
      .reply(200, {
        file_path: "requirements.txt",
        size: 12,
        encoding: "base64",
        content: Buffer.from(big, "utf8").toString("base64"),
        blob_id: "blobreq",
        commit_id: COMMIT_ID
      });

    const result = await gitlabAdapter.readFileAtRef(ctx, {
      path: "requirements.txt",
      ref: "main",
      maxBytes: 1024
    });
    expect(result).toMatchObject({ outcome: "refused", reason: "too_large", sizeBytes: 4096 });
  });

  // -----------------------------------------------------------------------------------------
  // THE TRANSPORT bound (M21.2 review MAJOR 5, closed) — a SEPARATE, larger ceiling from the
  // decode-bound `too_large` refusals above. GitLab was the provider with the CLEAREST exposure:
  // no `encoding: "none"` cutoff of any kind, arbitrarily large blobs served inline as base64.
  // -----------------------------------------------------------------------------------------

  it("THROWS on a response so large it exceeds the TRANSPORT ceiling, before decodeBoundedBase64 ever runs", async () => {
    const { ctx, token, base, pid } = setup();
    const hostileContent = "A".repeat(2_500_000);
    nock(base)
      .matchHeader("private-token", token)
      .get(`/projects/${pid}/repository/files/huge.bin`)
      .query({ ref: "main" })
      .reply(200, {
        file_path: "huge.bin",
        encoding: "base64",
        content: hostileContent,
        blob_id: "blobhuge",
        commit_id: COMMIT_ID
        // Deliberately NO `size` field — must be caught by the TRANSPORT bound, not gate 2.
      });

    await expect(
      gitlabAdapter.readFileAtRef(ctx, { path: "huge.bin", ref: "main" })
    ).rejects.toThrow(
      /gitlab readFileAtRef: response from .* exceeded the \d+-byte transport ceiling/
    );
  });

  it("refuses a BINARY file rather than returning replacement-character mojibake", async () => {
    const { ctx, token, base, pid } = setup();
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
    nock(base)
      .matchHeader("private-token", token)
      .get(`/projects/${pid}/repository/files/logo.png`)
      .query({ ref: "main" })
      .reply(200, {
        file_path: "logo.png",
        size: png.byteLength,
        encoding: "base64",
        content: png.toString("base64"),
        blob_id: "blobpng",
        commit_id: COMMIT_ID
      });

    const result = await gitlabAdapter.readFileAtRef(ctx, { path: "logo.png", ref: "main" });
    expect(result).toMatchObject({ outcome: "refused", reason: "not_text" });
  });

  it("throws rather than reporting a commit it did not resolve, when the response carries no commit_id", async () => {
    const { ctx, token, base, pid } = setup();
    nock(base)
      .matchHeader("private-token", token)
      .get(`/projects/${pid}/repository/files/go.mod`)
      .query({ ref: "main" })
      .reply(200, {
        file_path: "go.mod",
        size: 2,
        encoding: "base64",
        content: Buffer.from("{}", "utf8").toString("base64"),
        blob_id: "blobx"
        // commit_id deliberately absent
      });

    await expect(gitlabAdapter.readFileAtRef(ctx, { path: "go.mod", ref: "main" })).rejects.toThrow(
      /carried no commit_id/
    );
  });

  it("makes a REDIRECT legible — the failure a self-hosted GitLab behind a proxy actually produces", async () => {
    const { ctx, token, base, pid } = setup();
    nock(base)
      .matchHeader("private-token", token)
      .get(`/projects/${pid}/repository/files/go.mod`)
      .query({ ref: "main" })
      .reply(307, "", { location: "https://gitlab.example.com/api/v4/" });

    await expect(gitlabAdapter.readFileAtRef(ctx, { path: "go.mod", ref: "main" })).rejects.toThrow(
      /HTTP 307.*redirects are refused/s
    );
  });

  it("throws a status-bearing error for a non-2xx that is neither 404 nor a redirect", async () => {
    const { ctx, token, base, pid } = setup();
    nock(base)
      .matchHeader("private-token", token)
      .get(`/projects/${pid}/repository/files/go.mod`)
      .query({ ref: "main" })
      .reply(401, { message: "401 Unauthorized" });

    await expect(gitlabAdapter.readFileAtRef(ctx, { path: "go.mod", ref: "main" })).rejects.toThrow(
      /HTTP 401/
    );
  });

  it("surfaces an egress-guard denial as an actionable error naming the self-hosted case (the guard is NOT relaxed)", async () => {
    const config = buildGitlabConfig();
    const ctx = {
      ...buildTestCtx(config),
      http: {
        request: async () => {
          throw Object.assign(
            new Error(
              "egress guard: host 'gitlab.internal' resolves to private 10.42.0.9 — internal egress blocked for this plugin (SSRF)"
            ),
            { egressBlocked: true as const }
          );
        }
      }
    };

    await expect(gitlabAdapter.readFileAtRef(ctx, { path: "go.mod", ref: "main" })).rejects.toThrow(
      /refused by the plugin egress guard.*10\.42\.0\.9.*self-hosted gitlab/s
    );
  });

  it("refuses a path-traversal BEFORE any HTTP happens", async () => {
    const { ctx } = setup();
    await expect(
      gitlabAdapter.readFileAtRef(ctx, { path: "../../../etc/passwd", ref: "main" })
    ).rejects.toThrow(/^gitlab readFileAtRef: path .* contains a '\.'\/'\.\.' segment/);
  });

  it("honors an explicit `repo` override, URL-encoding a full group/subgroup project path", async () => {
    const { ctx, token, base } = setup({ projectPath: "acme/widgets" });
    const otherPid = encodeURIComponent("acme/platform/base-images");
    nock(base)
      .matchHeader("private-token", token)
      .get(`/projects/${otherPid}/repository/files/Dockerfile`)
      .query({ ref: "main" })
      .reply(200, {
        file_path: "Dockerfile",
        size: 16,
        encoding: "base64",
        content: Buffer.from("FROM alpine:1.0\n", "utf8").toString("base64"),
        blob_id: "blobd",
        commit_id: COMMIT_ID
      });

    const result = await gitlabAdapter.readFileAtRef(ctx, {
      repo: "acme/platform/base-images",
      path: "Dockerfile",
      ref: "main"
    });
    expect(result).toMatchObject({ outcome: "found", content: "FROM alpine:1.0\n" });
  });

  // -----------------------------------------------------------------------------------------
  // ADVERSARIAL `ref` and `repo` (M21.2 review, BLOCKERS 1 and 2). This adapter is the one that
  // already ENCODED both — into a single whole-encoded route parameter and a query value — so
  // neither was exploitable here, which is precisely why it needs the tests: the refusal is now a
  // shared rule across all three providers, and "gitlab happened to encode" is an implementation
  // detail a later refactor (e.g. adopting the two-call resolve shape) would silently take away.
  // These pin the RULE, not the encoding.
  // -----------------------------------------------------------------------------------------

  it("refuses a REF traversal and the other git-forbidden ref shapes BEFORE any HTTP", async () => {
    const { ctx } = setup();
    await expect(
      gitlabAdapter.readFileAtRef(ctx, { path: "package.json", ref: "../../../../user" })
    ).rejects.toThrow(/^gitlab readFileAtRef: ref '.*' contains '\.\.'/);
    for (const ref of ["main ", "ma?in", "main~1", "HEAD@{1}", "main.", "/main"]) {
      await expect(
        gitlabAdapter.readFileAtRef(ctx, { path: "package.json", ref }),
        ref
      ).rejects.toThrow(/^gitlab readFileAtRef: ref /);
    }
  });

  it("refuses an adversarial REPO before any HTTP, while still allowing a NESTED project path", async () => {
    const { ctx } = setup();
    await expect(
      gitlabAdapter.readFileAtRef(ctx, {
        repo: "acme/widgets/../../..",
        path: "package.json",
        ref: "main"
      })
    ).rejects.toThrow(/^gitlab readFileAtRef: repo .* contains a '\.'\/'\.\.' segment/);
    await expect(
      gitlabAdapter.readFileAtRef(ctx, {
        repo: "acme/widgets?x=",
        path: "package.json",
        ref: "main"
      })
    ).rejects.toThrow(/has a segment 'widgets\?x=' outside/);
    // NEGATIVE CONTROL for the segment-COUNT rule: github/gitea assert exactly 2, gitlab must NOT
    // — a nested group path is a legitimate GitLab project id. A 3-segment repo is passed here
    // with a bad REF, so the only thing that may be refused is the ref.
    await expect(
      gitlabAdapter.readFileAtRef(ctx, {
        repo: "acme/platform/base-images",
        path: "package.json",
        ref: "../.."
      })
    ).rejects.toThrow(/^gitlab readFileAtRef: ref /);
  });

  it("NEVER fabricates `blobSha` — a repository-file response without `blob_id` comes back without one", async () => {
    // `ReadFileAtRefFound.blobSha` promises it is never fabricated; the equivalent
    // `file.blob_id ?? "unknown"` mutation survived this suite before this test existed.
    const { ctx, token, base, pid } = setup();
    const manifest = "module example.com/x\n";
    nock(base)
      .matchHeader("private-token", token)
      .get(`/projects/${pid}/repository/files/go.mod`)
      .query({ ref: "main" })
      .reply(200, {
        file_path: "go.mod",
        size: Buffer.byteLength(manifest, "utf8"),
        encoding: "base64",
        content: Buffer.from(manifest, "utf8").toString("base64"),
        // no `blob_id` at all
        commit_id: COMMIT_ID
      });

    const result = await gitlabAdapter.readFileAtRef(ctx, { path: "go.mod", ref: "main" });
    expect(result).toMatchObject({ outcome: "found", content: manifest });
    expect((result as { blobSha?: string }).blobSha).toBeUndefined();
  });
});

// -------------------------------------------------------------------------------------------
// readFilesAtRef (team-pipeline-iac proposal §12) — bounded multi-file/tree reads. GitLab is the
// one provider that genuinely PAGINATES its tree listing (`repository/tree?recursive=true`,
// standard `per_page`/`page`) and carries no commit identity in that listing, so this resolves
// `ref` to a commit sha FIRST via `repository/commits/:sha_or_ref`.
// -------------------------------------------------------------------------------------------

describe("readFilesAtRef()", () => {
  const TREE_COMMIT_SHA = "7a".repeat(20);

  function nockResolveTreeRef(base: string, token: string, pid: string) {
    return nock(base)
      .matchHeader("private-token", token)
      .get(`/projects/${pid}/repository/commits/main`)
      .reply(200, { id: TREE_COMMIT_SHA });
  }

  it("resolves the ref to a commit, lists the tree across PAGES, matches globs, and reads every matched file at the SAME resolved commit", async () => {
    const { ctx, token, base, pid } = setup();
    nockResolveTreeRef(base, token, pid);
    // Page 1: exactly 100 entries (a FULL page — the loop must ask for page 2 rather than
    // assuming this was the last one).
    const page1 = Array.from({ length: 100 }, (_, i) => ({
      path: `pkg${i}/file${i}.txt`,
      type: "blob"
    }));
    nock(base)
      .matchHeader("private-token", token)
      .get(`/projects/${pid}/repository/tree`)
      .query({ recursive: "true", ref: TREE_COMMIT_SHA, per_page: "100", page: "1" })
      .reply(200, page1);
    // Page 2: SHORT (2 entries) — the signal this was the last page. One of the two matches.
    nock(base)
      .matchHeader("private-token", token)
      .get(`/projects/${pid}/repository/tree`)
      .query({ recursive: "true", ref: TREE_COMMIT_SHA, per_page: "100", page: "2" })
      .reply(200, [
        { path: "service-a", type: "tree" },
        { path: "service-a/go.mod", type: "blob" }
      ]);
    nock(base)
      .matchHeader("private-token", token)
      .get(`/projects/${pid}/repository/files/service-a%2Fgo.mod`)
      .query({ ref: TREE_COMMIT_SHA })
      .reply(200, {
        file_path: "service-a/go.mod",
        size: 18,
        encoding: "base64",
        content: Buffer.from("module a\n\ngo 1.22\n", "utf8").toString("base64"),
        blob_id: "blobgomod",
        commit_id: TREE_COMMIT_SHA
      });

    const result = await gitlabAdapter.readFilesAtRef(ctx, {
      ref: "main",
      globs: ["**/go.mod"]
    });

    expect(result.outcome).toBe("found");
    if (result.outcome !== "found") throw new Error("unreachable");
    expect(result.commitSha).toBe(TREE_COMMIT_SHA);
    expect(result.files).toHaveLength(1);
    expect(result.files[0]).toMatchObject({
      path: "service-a/go.mod",
      result: { outcome: "found", commitSha: TREE_COMMIT_SHA, requestedRef: "main" }
    });
  });

  it("refuses an EMPTY globs array before any HTTP happens", async () => {
    const { ctx } = setup();
    await expect(gitlabAdapter.readFilesAtRef(ctx, { ref: "main", globs: [] })).rejects.toThrow(
      /gitlab readFilesAtRef: globs must be a non-empty array/
    );
  });

  it("a single OVERSIZE matched file is a routine per-file `refused` entry, not a batch failure", async () => {
    const { ctx, token, base, pid } = setup();
    nockResolveTreeRef(base, token, pid);
    nock(base)
      .matchHeader("private-token", token)
      .get(`/projects/${pid}/repository/tree`)
      .query({ recursive: "true", ref: TREE_COMMIT_SHA, per_page: "100", page: "1" })
      .reply(200, [{ path: "package.json", type: "blob" }]);
    nock(base)
      .matchHeader("private-token", token)
      .get(`/projects/${pid}/repository/files/package.json`)
      .query({ ref: TREE_COMMIT_SHA })
      .reply(200, {
        file_path: "package.json",
        size: 9_000_000,
        encoding: "base64",
        content: Buffer.from("{}", "utf8").toString("base64"),
        blob_id: "blobbig",
        commit_id: TREE_COMMIT_SHA
      });

    const result = await gitlabAdapter.readFilesAtRef(ctx, {
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
    const { ctx, token, base, pid } = setup();
    nockResolveTreeRef(base, token, pid);
    nock(base)
      .matchHeader("private-token", token)
      .get(`/projects/${pid}/repository/tree`)
      .query({ recursive: "true", ref: TREE_COMMIT_SHA, per_page: "100", page: "1" })
      .reply(200, [
        { path: "a/go.mod", type: "blob" },
        { path: "b/go.mod", type: "blob" },
        { path: "c/go.mod", type: "blob" }
      ]);
    // NEGATIVE CONTROL: no page-2 or `files` interceptor registered — if maxFiles were not
    // enforced DURING the scan, this test would fail on an unmatched nock interceptor instead.

    await expect(
      gitlabAdapter.readFilesAtRef(ctx, { ref: "main", globs: ["**/go.mod"], maxFiles: 2 })
    ).rejects.toThrow(/gitlab readFilesAtRef: exceeded maxFiles \(2\)/);
  });

  it("THROWS a typed GitProviderTreeBoundError when cumulative bytes exceed maxTotalBytes", async () => {
    const { ctx, token, base, pid } = setup();
    nockResolveTreeRef(base, token, pid);
    nock(base)
      .matchHeader("private-token", token)
      .get(`/projects/${pid}/repository/tree`)
      .query({ recursive: "true", ref: TREE_COMMIT_SHA, per_page: "100", page: "1" })
      .reply(200, [
        { path: "a.txt", type: "blob" },
        { path: "b.txt", type: "blob" }
      ]);
    const chunk = "x".repeat(600);
    nock(base)
      .matchHeader("private-token", token)
      .get(`/projects/${pid}/repository/files/a.txt`)
      .query({ ref: TREE_COMMIT_SHA })
      .reply(200, {
        file_path: "a.txt",
        size: 600,
        encoding: "base64",
        content: Buffer.from(chunk, "utf8").toString("base64"),
        blob_id: "bloba",
        commit_id: TREE_COMMIT_SHA
      });
    nock(base)
      .matchHeader("private-token", token)
      .get(`/projects/${pid}/repository/files/b.txt`)
      .query({ ref: TREE_COMMIT_SHA })
      .reply(200, {
        file_path: "b.txt",
        size: 600,
        encoding: "base64",
        content: Buffer.from(chunk, "utf8").toString("base64"),
        blob_id: "blobb",
        commit_id: TREE_COMMIT_SHA
      });

    await expect(
      gitlabAdapter.readFilesAtRef(ctx, { ref: "main", globs: ["*.txt"], maxTotalBytes: 1000 })
    ).rejects.toThrow(/gitlab readFilesAtRef: exceeded maxTotalBytes \(1000\)/);
  });

  it("THROWS a typed GitProviderTreeBoundError when the tree has more entries than maxEntriesScanned, across PAGES", async () => {
    const { ctx, token, base, pid } = setup();
    nockResolveTreeRef(base, token, pid);
    // Two FULL pages (100 + 100 = 200 entries) exceed a maxEntriesScanned of 150 — the bound must
    // trip DURING page 2, before a (non-existent) page 3 would ever be requested.
    const page1 = Array.from({ length: 100 }, (_, i) => ({ path: `a${i}.txt`, type: "blob" }));
    const page2 = Array.from({ length: 100 }, (_, i) => ({ path: `b${i}.txt`, type: "blob" }));
    nock(base)
      .matchHeader("private-token", token)
      .get(`/projects/${pid}/repository/tree`)
      .query({ recursive: "true", ref: TREE_COMMIT_SHA, per_page: "100", page: "1" })
      .reply(200, page1);
    nock(base)
      .matchHeader("private-token", token)
      .get(`/projects/${pid}/repository/tree`)
      .query({ recursive: "true", ref: TREE_COMMIT_SHA, per_page: "100", page: "2" })
      .reply(200, page2);
    // NEGATIVE CONTROL: no page-3 interceptor registered — if the bound were not enforced PER
    // PAGE, this test would fail on an unmatched nock interceptor instead of the bound.

    await expect(
      gitlabAdapter.readFilesAtRef(ctx, { ref: "main", globs: ["*.txt"], maxEntriesScanned: 150 })
    ).rejects.toThrow(/gitlab readFilesAtRef: exceeded maxEntriesScanned \(150\)/);
  });

  it("an unresolvable ref is not_found, same shape as readFileAtRef's", async () => {
    const { ctx, token, base, pid } = setup();
    nock(base)
      .matchHeader("private-token", token)
      .get(`/projects/${pid}/repository/commits/no-such-branch`)
      .reply(404, { message: "404 Commit Not Found" });

    const result = await gitlabAdapter.readFilesAtRef(ctx, {
      ref: "no-such-branch",
      globs: ["**/go.mod"]
    });
    expect(result).toMatchObject({ outcome: "not_found", missing: "unknown" });
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
describe("gitlab adapter surface — read-only", () => {
  it("carries no repository-write hook, and still carries the read hook", () => {
    for (const hook of ["createBranch", "putFileOnBranch", "openPullRequest"]) {
      expect(hook in gitlabAdapter, `${hook} must not be on the gitlab adapter`).toBe(false);
    }
    expect(typeof gitlabAdapter.readFileAtRef).toBe("function");
    expect(typeof gitlabAdapter.readFilesAtRef).toBe("function");
  });
});
