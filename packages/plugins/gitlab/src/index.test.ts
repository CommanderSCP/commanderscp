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
      correlationKey: "refs/heads/main"
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
      correlationKey: "refs/tags/v2.0.0"
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
  it("canceled -> aborted", async () => expect((await statusFor("canceled")).phase).toBe("aborted"));
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
    nock(base)
      .matchHeader("private-token", token)
      .get(`/projects/${pid}/pipelines`)
      .reply(200, []);

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
    nock(base)
      .matchHeader("private-token", token)
      .get(`/projects/${pid}/pipelines`)
      .reply(200, []);

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
    nock(base)
      .matchHeader("private-token", token)
      .get(`/projects/${pid}/pipelines`)
      .reply(200, []);

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
    nock(base)
      .matchHeader("private-token", token)
      .get(`/projects/${pid}/pipelines`)
      .reply(200, []);

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

    expect(proposal.relationships).toHaveLength(1);
    expect(proposal.relationships[0]).toEqual({
      typeId: "part_of",
      fromUrn: `urn:scp:component:gitlab:${config.projectPath}/service-a`,
      toUrn: `urn:scp:service:gitlab:${config.projectPath}`
    });
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
