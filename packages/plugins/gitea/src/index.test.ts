/**
 * `@scp/plugin-gitea` behavioral test suite (M15.1b). Every HTTP call is fixtured deterministically
 * with `nock` against Node's `http`/`https` core modules (see `gitea-test-support.ts`'s module doc
 * for why the `ScopedHttpClient` uses `node:https` directly, not `fetch`). `nock.disableNetConnect()`
 * is active file-wide so any unanticipated call fails loudly rather than reaching the real network
 * (CLAUDE.md: "Tests never touch the internet"). Each test's interceptors are checked for full
 * consumption by the file-wide `afterEach` (`nock.pendingMocks()` must be empty).
 *
 * These assert REAL Gitea wire shapes (documented Swagger + the bare-hex X-Gitea-Signature), not
 * tautologies: the auth header is `token <PAT>` (NOT github's Bearer), the base is `/api/v1`, the
 * run status is a single Gitea enum, and the webhook signature is bare hex with NO `sha256=` prefix.
 */
import { createHmac } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import nock from "nock";
import {
  createGiteaExecutorPlugin,
  mapGiteaWebhookEventToHint,
  verifyGiteaWebhookSignature,
  type GiteaConfig
} from "./index.js";
import { apiBase, authHeaderFor, buildGiteaConfig, buildTestCtx } from "./gitea-test-support.js";

const plugin = createGiteaExecutorPlugin();

function setup(overrides: Partial<GiteaConfig> = {}) {
  const config = buildGiteaConfig(overrides);
  const ctx = buildTestCtx(config);
  return { config, ctx, authHeader: authHeaderFor(config), base: apiBase(config) };
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
// verifyGiteaWebhookSignature — bare-hex X-Gitea-Signature (NO sha256= prefix). Pure function.
// -------------------------------------------------------------------------------------------

describe("verifyGiteaWebhookSignature (bare-hex X-Gitea-Signature)", () => {
  const secret = "gitea-webhook-secret";
  const body = Buffer.from(JSON.stringify({ ref: "refs/heads/main" }));

  /** Gitea's real signing scheme: bare hex, no prefix. */
  function sign(rawBody: Buffer, withSecret: string): string {
    return createHmac("sha256", withSecret).update(rawBody).digest("hex");
  }

  it("accepts a validly-signed body (real bare-hex HMAC-SHA256, Gitea's X-Gitea-Signature scheme)", () => {
    expect(verifyGiteaWebhookSignature(body, sign(body, secret), secret)).toBe(true);
  });

  it("rejects a signature computed with the WRONG secret", () => {
    expect(verifyGiteaWebhookSignature(body, sign(body, "other-secret"), secret)).toBe(false);
  });

  it("rejects a github-style 'sha256='-PREFIXED header — that is NOT a valid Gitea signature", () => {
    // The concrete cross-provider correctness point: the exact same HMAC bytes, but with github's
    // prefix, must be rejected by the gitea verifier (and vice-versa, tested at the server layer).
    expect(verifyGiteaWebhookSignature(body, `sha256=${sign(body, secret)}`, secret)).toBe(false);
  });

  it("rejects when the signature header is missing entirely", () => {
    expect(verifyGiteaWebhookSignature(body, undefined, secret)).toBe(false);
  });

  it("rejects a non-hex header without throwing", () => {
    expect(() => verifyGiteaWebhookSignature(body, "not-hex-zzzz", secret)).not.toThrow();
    expect(verifyGiteaWebhookSignature(body, "not-hex-zzzz", secret)).toBe(false);
  });

  it("rejects a truncated digest (length guard, fail-closed not thrown)", () => {
    const truncated = sign(body, secret).slice(0, -4);
    expect(() => verifyGiteaWebhookSignature(body, truncated, secret)).not.toThrow();
    expect(verifyGiteaWebhookSignature(body, truncated, secret)).toBe(false);
  });

  it("rejects when the BODY was tampered with after signing", () => {
    const validForOriginal = sign(body, secret);
    const tampered = Buffer.from(JSON.stringify({ ref: "refs/heads/evil" }));
    expect(verifyGiteaWebhookSignature(tampered, validForOriginal, secret)).toBe(false);
  });
});

// -------------------------------------------------------------------------------------------
// mapGiteaWebhookEventToHint — pure function.
// -------------------------------------------------------------------------------------------

describe("mapGiteaWebhookEventToHint", () => {
  it("maps push to repo/commitSha/ref", () => {
    expect(
      mapGiteaWebhookEventToHint("push", {
        ref: "refs/heads/main",
        after: "0".repeat(40),
        head_commit: { id: "1".repeat(40) },
        repository: { full_name: "acme/widgets" }
      })
    ).toEqual({ repo: "acme/widgets", commitSha: "1".repeat(40), correlationKey: "refs/heads/main" });
  });

  it("maps pull_request using the top-level number Gitea nests it at", () => {
    const hint = mapGiteaWebhookEventToHint("pull_request", {
      number: 7,
      pull_request: { head: { sha: "2".repeat(40) } },
      repository: { full_name: "acme/widgets" }
    });
    expect(hint).toEqual({ repo: "acme/widgets", commitSha: "2".repeat(40), correlationKey: "pr-7" });
  });

  it("maps release to tag_name/target_commitish", () => {
    const hint = mapGiteaWebhookEventToHint("release", {
      release: { tag_name: "v2.0.0", target_commitish: "main" },
      repository: { full_name: "acme/widgets" }
    });
    expect(hint).toEqual({ repo: "acme/widgets", correlationKey: "v2.0.0", path: "main" });
  });

  it("maps a package event with a sha256: version to artifactDigest (the registry correlation key)", () => {
    const digest = "sha256:" + "ab".repeat(32);
    const hint = mapGiteaWebhookEventToHint("package", {
      repository: { full_name: "acme/widgets" },
      package: { name: "widgets", version: digest, type: "container" }
    });
    expect(hint).toEqual({
      repo: "acme/widgets",
      artifactDigest: digest,
      correlationKey: `widgets:${digest}`
    });
  });

  it("maps a package event with a TAG (non-digest) version to correlationKey only, artifactDigest undefined", () => {
    const hint = mapGiteaWebhookEventToHint("package", {
      repository: { full_name: "acme/widgets" },
      package: { name: "widgets", version: "1.2.3", type: "container" }
    });
    expect(hint?.artifactDigest).toBeUndefined();
    expect(hint?.correlationKey).toBe("widgets:1.2.3");
  });

  it("returns null for an unrecognized event name", () => {
    expect(mapGiteaWebhookEventToHint("issues", {})).toBeNull();
    expect(mapGiteaWebhookEventToHint("star", { repository: { full_name: "a/b" } })).toBeNull();
  });
});

// -------------------------------------------------------------------------------------------
// trigger() — workflow_dispatch (Gitea Actions, ASSUMED shapes; the token-auth header is real).
// -------------------------------------------------------------------------------------------

describe("trigger() — workflow_dispatch", () => {
  it("dispatches, correlates the newest run, returns action_run::<id>, and carries the token auth header", async () => {
    const { config, ctx, authHeader, base } = setup();
    const dispatchScope = nock(base)
      .matchHeader("authorization", authHeader)
      .post(
        `/repos/${config.owner}/${config.repo}/actions/workflows/${config.defaultWorkflowId}/dispatches`,
        { ref: "main", inputs: {} }
      )
      .reply(204);
    const runId = 4242;
    const pollScope = nock(base)
      .matchHeader("authorization", authHeader)
      .get(`/repos/${config.owner}/${config.repo}/actions/runs`)
      .reply(200, {
        workflow_runs: [
          {
            id: runId,
            status: "running",
            html_url: `${config.baseUrl}/${config.owner}/${config.repo}/actions/runs/${runId}`,
            head_sha: "5".repeat(40),
            created_at: new Date().toISOString()
          }
        ]
      });

    const ref = await plugin.trigger(ctx, { kind: "workflow_dispatch" });
    expect(ref.externalId).toBe(`action_run::${runId}`);
    expect(ref.url).toBe(`${config.baseUrl}/${config.owner}/${config.repo}/actions/runs/${runId}`);
    dispatchScope.done();
    pollScope.done();
  });

  it("uses intent.parameters.workflowId/ref/inputs over the config defaults", async () => {
    const { config, ctx, authHeader, base } = setup();
    const dispatchScope = nock(base)
      .matchHeader("authorization", authHeader)
      .post(`/repos/${config.owner}/${config.repo}/actions/workflows/deploy.yml/dispatches`, {
        ref: "release/1.0",
        inputs: { environment: "staging" }
      })
      .reply(204);
    const runId = 909;
    const pollScope = nock(base)
      .matchHeader("authorization", authHeader)
      .get(`/repos/${config.owner}/${config.repo}/actions/runs`)
      .reply(200, {
        workflow_runs: [{ id: runId, status: "waiting", created_at: new Date().toISOString() }]
      });

    const ref = await plugin.trigger(ctx, {
      kind: "workflow_dispatch",
      parameters: { workflowId: "deploy.yml", ref: "release/1.0", inputs: { environment: "staging" } }
    });
    expect(ref.externalId).toBe(`action_run::${runId}`);
    dispatchScope.done();
    pollScope.done();
  });

  it("returns an uncorrelated workflow_dispatch::<key> ref (not a throw) when no run correlates after 3 attempts", async () => {
    const { config, ctx, authHeader, base } = setup();
    const dispatchScope = nock(base)
      .matchHeader("authorization", authHeader)
      .post(
        `/repos/${config.owner}/${config.repo}/actions/workflows/${config.defaultWorkflowId}/dispatches`
      )
      .reply(204);
    const pollScope = nock(base)
      .matchHeader("authorization", authHeader)
      .get(`/repos/${config.owner}/${config.repo}/actions/runs`)
      .times(3)
      .reply(200, { workflow_runs: [] });

    const ref = await plugin.trigger(ctx, { kind: "workflow_dispatch" });
    expect(ref.externalId.startsWith("workflow_dispatch::")).toBe(true);
    expect(ref.url).toBeUndefined();
    dispatchScope.done();
    pollScope.done();
  }, 10_000);

  it("throws a clear Error when no workflowId is available, WITHOUT any HTTP call", async () => {
    const config = buildGiteaConfig({ defaultWorkflowId: undefined });
    const ctx = buildTestCtx(config);
    await expect(plugin.trigger(ctx, { kind: "workflow_dispatch" })).rejects.toThrow(/no workflowId/);
  });

  it("resolves the PAT from ctx.secrets when only tokenSecretKey is configured", async () => {
    const config = buildGiteaConfig({ tokenPlaintext: undefined, tokenSecretKey: "gitea-pat" });
    const ctx = buildTestCtx(config, { secrets: { "gitea-pat": "resolved-secret-pat" } });
    const dispatchScope = nock(apiBase(config))
      .matchHeader("authorization", "token resolved-secret-pat")
      .post(
        `/repos/${config.owner}/${config.repo}/actions/workflows/${config.defaultWorkflowId}/dispatches`
      )
      .reply(204);
    const pollScope = nock(apiBase(config))
      .matchHeader("authorization", "token resolved-secret-pat")
      .get(`/repos/${config.owner}/${config.repo}/actions/runs`)
      .reply(200, { workflow_runs: [{ id: 1, status: "running", created_at: new Date().toISOString() }] });

    const ref = await plugin.trigger(ctx, { kind: "workflow_dispatch" });
    expect(ref.externalId).toBe("action_run::1");
    dispatchScope.done();
    pollScope.done();
  });
});

// -------------------------------------------------------------------------------------------
// trigger() idempotency
// -------------------------------------------------------------------------------------------

describe("trigger() idempotency — in-memory dedup cache", () => {
  it("a second trigger() with the SAME idempotencyKey returns the SAME ref and never re-dispatches", async () => {
    const { config, ctx, authHeader, base } = setup();
    const runId = 7001;
    const dispatchScope = nock(base)
      .matchHeader("authorization", authHeader)
      .post(
        `/repos/${config.owner}/${config.repo}/actions/workflows/${config.defaultWorkflowId}/dispatches`
      )
      .reply(204);
    const pollScope = nock(base)
      .matchHeader("authorization", authHeader)
      .get(`/repos/${config.owner}/${config.repo}/actions/runs`)
      .reply(200, { workflow_runs: [{ id: runId, status: "running", created_at: new Date().toISOString() }] });

    const intent = { kind: "workflow_dispatch" as const, idempotencyKey: `mem-${randomKey()}` };
    const first = await plugin.trigger(ctx, intent);
    expect(first.externalId).toBe(`action_run::${runId}`);
    dispatchScope.done();
    pollScope.done();

    // Second call: no interceptors remain + net-connect disabled → a re-dispatch would throw.
    const second = await plugin.trigger(ctx, intent);
    expect(second.externalId).toBe(first.externalId);
  });
});

describe("trigger() idempotency — file-backed dedup cache", () => {
  let dir: string;
  let statePath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "scp-gitea-test-"));
    statePath = join(dir, "state.json");
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("a second trigger() re-reads the on-disk cache and never re-dispatches", async () => {
    const { config, ctx, authHeader, base } = setup({ statePath });
    const runId = 7002;
    const dispatchScope = nock(base)
      .matchHeader("authorization", authHeader)
      .post(
        `/repos/${config.owner}/${config.repo}/actions/workflows/${config.defaultWorkflowId}/dispatches`
      )
      .reply(204);
    const pollScope = nock(base)
      .matchHeader("authorization", authHeader)
      .get(`/repos/${config.owner}/${config.repo}/actions/runs`)
      .reply(200, { workflow_runs: [{ id: runId, status: "running", created_at: new Date().toISOString() }] });

    const intent = { kind: "workflow_dispatch" as const, idempotencyKey: "file-backed-key" };
    const first = await plugin.trigger(ctx, intent);
    dispatchScope.done();
    pollScope.done();

    const persisted = JSON.parse(await readFile(statePath, "utf8")) as {
      keys: Record<string, { externalId: string }>;
    };
    expect(persisted.keys["file-backed-key"]?.externalId).toBe(first.externalId);

    const second = await plugin.trigger(ctx, intent);
    expect(second.externalId).toBe(first.externalId);
  });
});

// -------------------------------------------------------------------------------------------
// status() — Gitea's SINGLE status enum → phase.
// -------------------------------------------------------------------------------------------

describe("status() — single Gitea status enum", () => {
  async function statusFor(runStatus: string) {
    const { config, ctx, authHeader, base } = setup();
    const runId = Math.floor(Math.random() * 1_000_000) + 1;
    nock(base)
      .matchHeader("authorization", authHeader)
      .get(`/repos/${config.owner}/${config.repo}/actions/runs/${runId}`)
      .reply(200, { id: runId, status: runStatus, head_sha: "8".repeat(40) });
    return plugin.status(ctx, { externalId: `action_run::${runId}` });
  }

  it("running -> running", async () => {
    const s = await statusFor("running");
    expect(s.phase).toBe("running");
    expect(s.progress).toBe(0.5);
  });
  it("waiting -> running", async () => expect((await statusFor("waiting")).phase).toBe("running"));
  it("success -> succeeded", async () => {
    const s = await statusFor("success");
    expect(s.phase).toBe("succeeded");
    expect(s.progress).toBe(1);
  });
  it("failure -> failed", async () => expect((await statusFor("failure")).phase).toBe("failed"));
  it("cancelled -> aborted", async () => expect((await statusFor("cancelled")).phase).toBe("aborted"));
  it("an unknown status maps to running (safe default, not a crash)", async () =>
    expect((await statusFor("some-future-status")).phase).toBe("running"));

  it("an uncorrelated ref reports pending WITHOUT any HTTP call", async () => {
    const config = buildGiteaConfig();
    const ctx = buildTestCtx(config);
    const s = await plugin.status(ctx, { externalId: "workflow_dispatch::key" });
    expect(s.phase).toBe("pending");
  });

  it("a non-2xx status response throws a clear HTTP-status-bearing Error", async () => {
    const { config, ctx, authHeader, base } = setup();
    nock(base)
      .matchHeader("authorization", authHeader)
      .get(`/repos/${config.owner}/${config.repo}/actions/runs/500`)
      .reply(500, { message: "boom" });
    await expect(plugin.status(ctx, { externalId: "action_run::500" })).rejects.toThrow(/HTTP 500/);
  });
});

// -------------------------------------------------------------------------------------------
// abort()
// -------------------------------------------------------------------------------------------

describe("abort()", () => {
  it("cancels a correlated run", async () => {
    const { config, ctx, authHeader, base } = setup();
    nock(base)
      .matchHeader("authorization", authHeader)
      .post(`/repos/${config.owner}/${config.repo}/actions/runs/9001/cancel`)
      .reply(200);
    expect(await plugin.abort(ctx, { externalId: "action_run::9001" })).toEqual({ aborted: true });
  });

  it("a non-2xx cancel maps to aborted:false with detail, never throws", async () => {
    const { config, ctx, authHeader, base } = setup();
    nock(base)
      .matchHeader("authorization", authHeader)
      .post(`/repos/${config.owner}/${config.repo}/actions/runs/9002/cancel`)
      .reply(409, { message: "already done" });
    const r = await plugin.abort(ctx, { externalId: "action_run::9002" });
    expect(r.aborted).toBe(false);
    expect(r.detail).toContain("409");
  });

  it("an uncorrelated ref reports aborted:false without any HTTP call", async () => {
    const config = buildGiteaConfig();
    const ctx = buildTestCtx(config);
    expect(await plugin.abort(ctx, { externalId: "workflow_dispatch::key" })).toEqual({
      aborted: false,
      detail: "gitea: no correlated run to cancel"
    });
  });
});

// -------------------------------------------------------------------------------------------
// observe() — commits + runs + PACKAGE pushes (artifactDigest), and poll-vs-push equivalence.
// -------------------------------------------------------------------------------------------

describe("observe() polling — commits, runs, and package pushes", () => {
  function nockCommitsAndRuns(
    base: string,
    authHeader: string,
    config: GiteaConfig,
    opts: { commits?: unknown[]; runs?: unknown[] }
  ) {
    nock(base)
      .matchHeader("authorization", authHeader)
      .get(`/repos/${config.owner}/${config.repo}/commits`)
      .reply(200, opts.commits ?? []);
    nock(base)
      .matchHeader("authorization", authHeader)
      .get(`/repos/${config.owner}/${config.repo}/actions/runs`)
      .reply(200, { workflow_runs: opts.runs ?? [] });
  }

  it("emits a package-push event with correlation.artifactDigest for a sha256: package version (github never populated this)", async () => {
    const { config, ctx, authHeader, base } = setup();
    const digest = "sha256:" + "cd".repeat(32);
    nockCommitsAndRuns(base, authHeader, config, {});
    nock(base)
      .matchHeader("authorization", authHeader)
      .get(`/packages/${config.owner}`)
      .reply(200, [
        {
          type: "container",
          name: "widgets",
          version: digest,
          created_at: "2026-07-02T00:00:00Z",
          repository: { full_name: `${config.owner}/${config.repo}` }
        }
      ]);

    const events = await plugin.observe(ctx);
    const pkgEvent = events.find((e) => e.correlation.artifactDigest !== undefined);
    expect(pkgEvent).toBeDefined();
    expect(pkgEvent?.kind).toBe("custom");
    expect(pkgEvent?.correlation.artifactDigest).toBe(digest);
    expect(pkgEvent?.correlation.repo).toBe(`${config.owner}/${config.repo}`);
  });

  it("a tag-versioned package emits NO artifactDigest (never fabricated) but a correlationKey", async () => {
    const { config, ctx, authHeader, base } = setup();
    nockCommitsAndRuns(base, authHeader, config, {});
    nock(base)
      .matchHeader("authorization", authHeader)
      .get(`/packages/${config.owner}`)
      .reply(200, [{ type: "container", name: "widgets", version: "1.4.0", created_at: "2026-07-02T00:00:00Z" }]);

    const events = await plugin.observe(ctx);
    const pkgEvent = events.find((e) => e.correlation.correlationKey === "widgets:1.4.0");
    expect(pkgEvent).toBeDefined();
    expect(pkgEvent?.correlation.artifactDigest).toBeUndefined();
  });

  it("maps commits and runs to well-formed ExecutorEvents", async () => {
    const { config, ctx, authHeader, base } = setup();
    const commitSha = "a1".repeat(20);
    const runSha = "b2".repeat(20);
    nock(base)
      .matchHeader("authorization", authHeader)
      .get(`/repos/${config.owner}/${config.repo}/commits`)
      .reply(200, [{ sha: commitSha, commit: { author: { date: "2026-07-01T00:00:00Z" } } }]);
    nock(base)
      .matchHeader("authorization", authHeader)
      .get(`/repos/${config.owner}/${config.repo}/actions/runs`)
      .reply(200, { workflow_runs: [{ id: 55, status: "success", head_sha: runSha, created_at: "2026-07-01T00:05:00Z" }] });
    nock(base)
      .matchHeader("authorization", authHeader)
      .get(`/packages/${config.owner}`)
      .reply(200, []);

    const events = await plugin.observe(ctx);
    const push = events.find((e) => e.kind === "push");
    expect(push?.correlation).toEqual({
      repo: `${config.owner}/${config.repo}`,
      path: undefined,
      commitSha,
      artifactDigest: undefined,
      correlationKey: "refs/heads/*"
    });
    const run = events.find((e) => e.kind === "workflow_run");
    expect(run?.correlation.commitSha).toBe(runSha);
    expect(run?.correlation.correlationKey).toBe("run-55");
  });

  it("poll-vs-push equivalence: observe()'s polled push carries the SAME repo/commitSha mapGiteaWebhookEventToHint yields for the equivalent push webhook", async () => {
    const commitSha = "c3".repeat(20);
    const webhookHint = mapGiteaWebhookEventToHint("push", {
      ref: "refs/heads/main",
      after: commitSha,
      head_commit: { id: commitSha },
      repository: { full_name: "acme/widgets" }
    });
    const { config, ctx, authHeader, base } = setup({ owner: "acme", repo: "widgets" });
    nock(base)
      .matchHeader("authorization", authHeader)
      .get(`/repos/${config.owner}/${config.repo}/commits`)
      .reply(200, [{ sha: commitSha, commit: { author: { date: "2026-07-01T00:00:00Z" } } }]);
    nock(base)
      .matchHeader("authorization", authHeader)
      .get(`/repos/${config.owner}/${config.repo}/actions/runs`)
      .reply(200, { workflow_runs: [] });
    nock(base).matchHeader("authorization", authHeader).get(`/packages/${config.owner}`).reply(200, []);

    const events = await plugin.observe(ctx);
    const polledPush = events.find((e) => e.kind === "push");
    expect(polledPush?.correlation.repo).toBe(webhookHint?.repo);
    expect(polledPush?.correlation.commitSha).toBe(webhookHint?.commitSha);
  });

  it("silently skips (does not throw for) a rate-limited/non-2xx resource — the lenient observe posture", async () => {
    const { config, ctx, authHeader, base } = setup();
    nock(base)
      .matchHeader("authorization", authHeader)
      .get(`/repos/${config.owner}/${config.repo}/commits`)
      .reply(403, { message: "rate limited" });
    nock(base)
      .matchHeader("authorization", authHeader)
      .get(`/repos/${config.owner}/${config.repo}/actions/runs`)
      .reply(200, { workflow_runs: [] });
    nock(base).matchHeader("authorization", authHeader).get(`/packages/${config.owner}`).reply(200, []);

    await expect(plugin.observe(ctx)).resolves.toEqual([]);
  });
});

function randomKey(): string {
  return Math.random().toString(36).slice(2);
}
